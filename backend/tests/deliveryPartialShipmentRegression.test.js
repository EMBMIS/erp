// Regression test for the O2C invoice/delivery tie-out gap found in the
// Sales/O2C re-evaluation session (ERP_PRODUCT_EVALUATION §30).
//
// Bug: DeliverySchedule.updateStatus advanced the linked sales order toward
// COMPLETED whenever no delivery schedule was left "outstanding" (status not
// in DELIVERED/CANCELLED) — but a delivery schedule can be created for FEWER
// units than the sales order line actually ordered (the UI's "deliver
// quantity" field on DeliveryScheduling.jsx allows any value up to the
// ordered quantity). Marking that single short-shipped schedule DELIVERED,
// with no second schedule ever created for the remainder, satisfied "nothing
// outstanding" and auto-advanced the order all the way to COMPLETED, which
// raises a customer invoice for the FULL sales-order total — an invoice that
// no longer ties out to what was actually shipped.
//
// A second, independent copy of the same bug lived in routes/delivery-
// schedules.js: both PUT /:id/status and PUT /:id unconditionally forced the
// sales order into WAITING_CUSTOMER_DELIVERY_CONFIRMATION on ANY delivery
// schedule marked DELIVERED, bypassing the model's "wait for every shipment"
// logic entirely — so even a correctly-guarded model could be defeated by the
// route that's actually on the wire.
//
// The fix: DeliverySchedule.isFullyShipped() sums delivery_items.ordered_quantity
// (the per-shipment quantity, despite the confusing column name) across every
// DELIVERED schedule linked to each sales_order_item and requires it to meet
// or exceed that line's ordered quantity before the sales order is allowed to
// advance; the route-level duplicate forced calls were removed.
//
// Run on its own:  node --test tests/deliveryPartialShipmentRegression.test.js

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');

const { pool } = require('../config/database');
const { randomUUID } = require('node:crypto');
const SalesOrder = require('../models/SalesOrder');
const DeliverySchedule = require('../models/DeliverySchedule');

let dbAvailable = false;
let userId = null;
let customer = null;

const created = { salesOrderIds: [], scheduleIds: [], invoiceIds: [], journalEntryIds: [] };

before(async () => {
  try {
    await pool.query('SELECT 1');
    const ownerEmail = (process.env.PLATFORM_OWNER_EMAIL || '').trim().toLowerCase();
    const liveUser = `SELECT id FROM users WHERE deleted_at IS NULL AND COALESCE(is_active, true) = true`;
    let users = ownerEmail
      ? await pool.query(`${liveUser} AND lower(email) = $1 LIMIT 1`, [ownerEmail])
      : { rows: [] };
    if (!users.rows.length) users = await pool.query(`${liveUser} AND is_platform_owner = true LIMIT 1`);
    if (!users.rows.length) users = await pool.query(`${liveUser} ORDER BY created_at LIMIT 1`);
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

async function cleanupSalesOrder(soId) {
  await pool.query('DELETE FROM customer_invoice_status_history WHERE invoice_id = ANY(SELECT id FROM customer_invoices WHERE sales_order_id = $1)', [soId]).catch(() => {});
  await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id = ANY(SELECT id FROM customer_invoices WHERE sales_order_id = $1)', [soId]).catch(() => {});
  const jes = await pool.query('SELECT journal_entry_id FROM customer_invoices WHERE sales_order_id = $1 AND journal_entry_id IS NOT NULL', [soId]).catch(() => ({ rows: [] }));
  await pool.query('DELETE FROM customer_invoices WHERE sales_order_id = $1', [soId]).catch(() => {});
  for (const row of jes.rows) {
    await pool.query('DELETE FROM journal_entry_status_history WHERE journal_entry_id = $1', [row.journal_entry_id]).catch(() => {});
    await pool.query('DELETE FROM journal_entry_items WHERE journal_entry_id = $1', [row.journal_entry_id]).catch(() => {});
    await pool.query('DELETE FROM journal_entries WHERE id = $1', [row.journal_entry_id]).catch(() => {});
  }
  await pool.query('DELETE FROM sales_order_status_history WHERE sales_order_id = $1', [soId]).catch(() => {});
  await pool.query('DELETE FROM sales_order_items WHERE sales_order_id = $1', [soId]).catch(() => {});
  await pool.query('DELETE FROM sales_orders WHERE id = $1', [soId]).catch(() => {});
}

after(async () => {
  if (dbAvailable) {
    for (const id of created.scheduleIds) {
      await pool.query('DELETE FROM delivery_status_history WHERE delivery_schedule_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM delivery_items WHERE delivery_schedule_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM delivery_schedules WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.salesOrderIds) {
      await cleanupSalesOrder(id);
    }
  }
  await pool.end().catch(() => {});
});

test('a short-shipped delivery schedule does not auto-advance the sales order or invoice the full order', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const so = await SalesOrder.create(
    {
      customer_id: customer.id,
      customer_name: customer.customer_name,
      subtotal: 1000,
      tax_amount: 0,
      total_amount: 1000,
      reference_number: 'ITEST-SHORT-SHIP',
      items: [{ item_name: 'Widget', quantity: 10, unit_of_measure: 'EA', unit_price: 100, line_total: 1000 }],
    },
    userId
  );
  created.salesOrderIds.push(so.id);
  await SalesOrder.updateStatus(so.id, 'CONFIRMED', userId, 'regression test');

  const soItem = so.items[0];

  // Only 5 of the 10 ordered units are scheduled for delivery — reproduces the
  // "deliver quantity" field on the frontend's DeliveryScheduling.jsx.
  const ds = await DeliverySchedule.create(
    {
      sales_order_id: so.id,
      sales_order_number: so.so_number,
      customer_id: customer.id,
      customer_name: customer.customer_name,
      delivery_date: '2030-01-15',
      delivery_address: 'Regression test address ' + randomUUID(),
      items: [{
        sales_order_item_id: soItem.id,
        item_code: soItem.item_code,
        item_name: soItem.item_name,
        ordered_quantity: 5,
        unit_of_measure: 'EA',
      }],
    },
    userId
  );
  created.scheduleIds.push(ds.id);

  await DeliverySchedule.updateStatus(ds.id, 'DELIVERED', userId, 'regression test - short shipment');

  const soAfter = await pool.query('SELECT status FROM sales_orders WHERE id = $1', [so.id]);
  // Scheduling the delivery moves the order CONFIRMED -> READY_FOR_DELIVERY
  // (DeliverySchedule.advanceSalesOrderOnScheduling, added after this test);
  // what must not happen is the step past it, toward customer confirmation.
  assert.equal(
    soAfter.rows[0].status,
    'READY_FOR_DELIVERY',
    'the order must NOT advance toward customer confirmation while 5 of 10 units are still unshipped'
  );

  const invCount = await pool.query('SELECT COUNT(*)::int AS n FROM customer_invoices WHERE sales_order_id = $1', [so.id]);
  assert.equal(invCount.rows[0].n, 0, 'no invoice may be raised for an order that was only partially shipped');
});

test('shipping the remainder in a second delivery schedule now completes the order and invoices the full total', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const so = await SalesOrder.create(
    {
      customer_id: customer.id,
      customer_name: customer.customer_name,
      subtotal: 1000,
      tax_amount: 0,
      total_amount: 1000,
      reference_number: 'ITEST-TWO-SHIPMENTS',
      items: [{ item_name: 'Widget', quantity: 10, unit_of_measure: 'EA', unit_price: 100, line_total: 1000 }],
    },
    userId
  );
  created.salesOrderIds.push(so.id);
  await SalesOrder.updateStatus(so.id, 'CONFIRMED', userId, 'regression test');

  const soItem = so.items[0];

  const ds1 = await DeliverySchedule.create(
    {
      sales_order_id: so.id, sales_order_number: so.so_number, customer_id: customer.id,
      customer_name: customer.customer_name, delivery_date: '2030-01-15',
      delivery_address: 'Regression test address ' + randomUUID(),
      items: [{ sales_order_item_id: soItem.id, item_code: soItem.item_code, item_name: soItem.item_name, ordered_quantity: 5, unit_of_measure: 'EA' }],
    },
    userId
  );
  created.scheduleIds.push(ds1.id);
  await DeliverySchedule.updateStatus(ds1.id, 'DELIVERED', userId, 'regression test - first shipment');

  const mid = await pool.query('SELECT status FROM sales_orders WHERE id = $1', [so.id]);
  assert.equal(mid.rows[0].status, 'READY_FOR_DELIVERY', 'still not fully shipped after the first shipment alone');

  const ds2 = await DeliverySchedule.create(
    {
      sales_order_id: so.id, sales_order_number: so.so_number, customer_id: customer.id,
      customer_name: customer.customer_name, delivery_date: '2030-01-16',
      delivery_address: 'Regression test address ' + randomUUID(),
      items: [{ sales_order_item_id: soItem.id, item_code: soItem.item_code, item_name: soItem.item_name, ordered_quantity: 5, unit_of_measure: 'EA' }],
    },
    userId
  );
  created.scheduleIds.push(ds2.id);
  await DeliverySchedule.updateStatus(ds2.id, 'DELIVERED', userId, 'regression test - second shipment');

  const waiting = await pool.query('SELECT status FROM sales_orders WHERE id = $1', [so.id]);
  assert.equal(
    waiting.rows[0].status,
    'WAITING_CUSTOMER_DELIVERY_CONFIRMATION',
    'once the full ordered quantity has shipped across both schedules, the order must advance'
  );

  await SalesOrder.updateStatus(so.id, 'COMPLETED', userId, 'regression test - customer confirmed');

  const inv = await pool.query('SELECT total_amount FROM customer_invoices WHERE sales_order_id = $1', [so.id]);
  assert.equal(inv.rows.length, 1, 'exactly one invoice should be raised once the order is fully shipped and confirmed');
  created.invoiceIds.push(inv.rows[0].id);
  // The SO carried tax_amount: 0, so CustomerInvoice.createFromSalesOrder computes
  // VAT itself from DEFAULT_VAT_RATE (services/taxService.js; 0 when unset).
  // This used to expect 1180, which held only with a local backend/.env setting
  // DEFAULT_VAT_RATE=18.
  const vatRate = Number(process.env.DEFAULT_VAT_RATE);
  const expected = 1000 * (1 + (Number.isFinite(vatRate) && vatRate >= 0 ? vatRate : 0) / 100);
  assert.equal(Number(inv.rows[0].total_amount), expected, 'invoice total should match the fully-shipped order total plus VAT');
});
