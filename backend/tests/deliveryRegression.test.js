// Regression test for the O2C delivery blocker
// (ERP_PRODUCT_EVALUATION: "Delivery schedule creation broken — sales_order_number
// never set → no O2C delivery").
//
// DeliverySchedule.create used to store `sales_order_number` straight from the
// request body. When the client only passed `sales_order_id`, the value stayed
// NULL and downstream O2C delivery steps (which read that column to reference
// the order) broke. The fix derives the number from the linked sales order
// (sales_orders.so_number) inside the same transaction when the caller does not
// supply one, and keeps the explicit-body value when it is supplied.
//
// Run on its own:  node --test tests/deliveryRegression.test.js

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');

const { pool } = require('../config/database');
const { randomUUID } = require('node:crypto');
const DeliverySchedule = require('../models/DeliverySchedule');

let dbAvailable = false;
let userId = null;
let customer = null;

// Track everything we create so teardown can remove it.
const created = { salesOrderIds: [], scheduleIds: [] };

before(async () => {
  try {
    await pool.query('SELECT 1');
    const users = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
    const customers = await pool.query('SELECT id, customer_name FROM customers WHERE deleted_at IS NULL LIMIT 1');
    if (users.rows.length && customers.rows.length) {
      userId = users.rows[0].id;
      customer = customers.rows[0];
      dbAvailable = true;
    }
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  if (!dbAvailable) return;
  for (const id of created.scheduleIds) {
    await pool.query('DELETE FROM delivery_status_history WHERE delivery_schedule_id = $1', [id]).catch(() => {});
    await pool.query('DELETE FROM delivery_items WHERE delivery_schedule_id = $1', [id]).catch(() => {});
    await pool.query('DELETE FROM delivery_schedules WHERE id = $1', [id]).catch(() => {});
  }
  for (const id of created.salesOrderIds) {
    await pool.query('DELETE FROM sales_order_items WHERE sales_order_id = $1', [id]).catch(() => {});
    await pool.query('DELETE FROM sales_orders WHERE id = $1', [id]).catch(() => {});
  }
  // node:test cannot exit while the pg pool's sockets stay open (the local pool
  // keeps min: 2 keepalive connections alive) — close it so the process ends.
  await pool.end();
});

// Create a sales order with a known, unique human-readable number and a unique id.
async function insertSalesOrder(soNumber) {
  const id = randomUUID();
  const result = await pool.query(
    `INSERT INTO sales_orders (id, so_number, customer_id, customer_name, created_by, status, total_amount)
     VALUES ($1, $2, $3, $4, $5, 'DRAFT', 0)
     RETURNING id, so_number`,
    [id, soNumber, customer.id, customer.customer_name, userId]
  );
  created.salesOrderIds.push(id);
  return result.rows[0];
}

// Minimal payload the model accepts — items are optional at the model layer
// (the route requires them, DeliverySchedule.create() does not).
function basePayload(salesOrder, overrides = {}) {
  return {
    sales_order_id: salesOrder.id,
    customer_id: customer.id,
    customer_name: customer.customer_name,
    delivery_date: '2030-01-15',
    delivery_address: 'Regression test address ' + randomUUID(),
    ...overrides,
  };
}

test('DeliverySchedule.create derives sales_order_number from the linked sales order when not supplied', async (t) => {
  if (!dbAvailable) return t.skip('Database not available');

  const soNumber = `SO-REG-${randomUUID().slice(0, 8)}`;
  const salesOrder = await insertSalesOrder(soNumber);

  // Deliberately NO sales_order_number in the payload — this is the broken path.
  const schedule = await DeliverySchedule.create(basePayload(salesOrder), userId);

  created.scheduleIds.push(schedule.id);
  assert.equal(
    schedule.sales_order_number,
    soNumber,
    'returned schedule should carry the sales order number derived from sales_orders.so_number'
  );

  // The persisted row — not just the returned object — must have the value.
  const persisted = await pool.query(
    'SELECT sales_order_number FROM delivery_schedules WHERE id = $1',
    [schedule.id]
  );
  assert.equal(
    persisted.rows[0].sales_order_number,
    soNumber,
    'persisted delivery_schedules.sales_order_number should match the sales order so_number'
  );
});

test('explicit sales_order_number in the payload still wins over the derived value', async (t) => {
  if (!dbAvailable) return t.skip('Database not available');

  const soNumber = `SO-REG-${randomUUID().slice(0, 8)}`;
  const salesOrder = await insertSalesOrder(soNumber);
  const explicitNumber = `SO-EXPLICIT-${randomUUID().slice(0, 8)}`;

  const schedule = await DeliverySchedule.create(
    basePayload(salesOrder, { sales_order_number: explicitNumber }),
    userId
  );

  created.scheduleIds.push(schedule.id);
  assert.equal(
    schedule.sales_order_number,
    explicitNumber,
    'explicit body value must win over the number derived from the sales order'
  );

  const persisted = await pool.query(
    'SELECT sales_order_number FROM delivery_schedules WHERE id = $1',
    [schedule.id]
  );
  assert.equal(persisted.rows[0].sales_order_number, explicitNumber);
});
