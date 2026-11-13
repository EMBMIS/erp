// Work centres, routing and capacity — the part of manufacturing that
// tests/manufacturing.test.js does not touch (it proves the material/cost
// flow; this proves that operations actually run against a work centre and
// that capacity reporting reflects the load a released work order creates).
//
// Self-cleaning: everything seeded is tracked and removed.

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');

const { pool } = require('../config/database');
const BillOfMaterial = require('../models/BillOfMaterial');
const WorkOrder = require('../models/WorkOrder');
const WorkCenter = require('../models/WorkCenter');

let dbAvailable = false;
let userId = null;
const created = { itemIds: [], inventoryItemIds: [], bomIds: [], workOrderIds: [], workCenterIds: [] };

async function makeItem(name) {
  const { rows } = await pool.query(
    `INSERT INTO items (item_code, stock_code, name, description, status, unit_of_measure, user_id)
     VALUES ($1, 'ST2', $2, 'work centre test', 'APPROVED', 'EA', $3) RETURNING id`,
    [`WC${Math.random().toString(36).slice(2, 10)}`, name, userId]
  );
  created.itemIds.push(rows[0].id);
  return rows[0].id;
}

async function stockItem(itemId, qty, unitCost) {
  const { rows } = await pool.query(
    `INSERT INTO inventory_items
       (item_master_id, current_stock_quantity, unit_price, currency, user_id, status)
     VALUES ($1,$2,$3,'USD',$4,'APPROVED') RETURNING id`,
    [itemId, qty, unitCost, userId]
  );
  created.inventoryItemIds.push(rows[0].id);
  return rows[0].id;
}

before(async () => {
  try {
    await pool.query('SELECT 1');
    const users = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
    if (users.rows.length) {
      userId = users.rows[0].id;
      dbAvailable = true;
    }
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  if (dbAvailable) {
    for (const id of created.workOrderIds) {
      await pool.query('DELETE FROM work_order_time_entries WHERE work_order_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM work_order_operations WHERE work_order_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM work_order_components WHERE work_order_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM work_orders WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.bomIds) {
      await pool.query('DELETE FROM bom_operations WHERE bom_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM bom_components WHERE bom_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM bills_of_material WHERE id = $1', [id]).catch(() => {});
    }
    await pool.query(
      `DELETE FROM journal_entry_items WHERE journal_entry_id IN (
         SELECT id FROM journal_entries WHERE source_type LIKE 'WORK_ORDER%' AND source_id = ANY($1))`,
      [created.workOrderIds]
    ).catch(() => {});
    await pool.query(`DELETE FROM journal_entries WHERE source_type LIKE 'WORK_ORDER%' AND source_id = ANY($1)`,
      [created.workOrderIds]).catch(() => {});
    for (const id of created.inventoryItemIds) {
      await pool.query('DELETE FROM inventory_items WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.itemIds) {
      await pool.query('DELETE FROM items WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.workCenterIds) {
      await pool.query('DELETE FROM work_centers WHERE id = $1', [id]).catch(() => {});
    }
  }
  await pool.end();
});

test('a BOM routing is copied onto the work order, time can be booked, and capacity reflects the load', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const wc = await WorkCenter.create({
    code: `WC${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    name: 'Test Assembly Line',
    daily_capacity_hours: 8,
    efficiency_pct: 100,
    hourly_rate: 25,
  }, userId);
  created.workCenterIds.push(wc.id);

  const item = await makeItem('Routed Item');
  const part = await makeItem('Routed Part');
  await stockItem(part, 1000, 5);

  const bom = await BillOfMaterial.create({
    item_id: item, output_quantity: 1,
    components: [{ component_item_id: part, quantity_per: 1 }],
  }, userId);
  created.bomIds.push(bom.id);

  // 0.5h setup + 0.25h per unit run time.
  await WorkCenter.addBomOperation(bom.id, {
    work_center_id: wc.id,
    description: 'Assemble',
    setup_hours: 0.5,
    run_hours_per_unit: 0.25,
  });
  await BillOfMaterial.activate(bom.id);

  const wo = await WorkOrder.create({ item_id: item, quantity: 10 }, userId);
  created.workOrderIds.push(wo.id);

  // The routing must have been copied onto the work order, scaled to its
  // quantity: 0.5 setup + 0.25*10 run = 3.0 planned hours.
  const opsBeforeRelease = await WorkCenter.listWorkOrderOperations(wo.id);
  assert.equal(opsBeforeRelease.length, 1);
  assert.equal(Number(opsBeforeRelease[0].planned_hours), 3);
  assert.equal(opsBeforeRelease[0].status, 'PENDING');

  await WorkOrder.release(wo.id, userId);

  // A DRAFT order's operations do not consume capacity; a RELEASED one does.
  const capacityAfterRelease = await WorkCenter.capacity({ horizonDays: 7 });
  const wcLoad = capacityAfterRelease.find((c) => c.id === wc.id);
  assert.ok(wcLoad, 'the work centre must appear in the capacity report');
  assert.equal(wcLoad.remaining_hours, 3, 'the released order\'s planned hours are outstanding load');
  assert.equal(wcLoad.active_work_orders, 1);

  // Book 2 of the 3 planned hours.
  const operation = opsBeforeRelease[0];
  const booked = await WorkCenter.bookTime(operation.id, { hours: 2 }, userId);
  assert.equal(Number(booked.actual_hours), 2);
  assert.equal(booked.status, 'IN_PROGRESS', 'booking time moves a PENDING operation to IN_PROGRESS');

  // Remaining load in the capacity report should drop by what was booked.
  const capacityAfterBooking = await WorkCenter.capacity({ horizonDays: 7 });
  const wcLoadAfterBooking = capacityAfterBooking.find((c) => c.id === wc.id);
  assert.equal(wcLoadAfterBooking.remaining_hours, 1, 'planned 3 - actual 2 = 1 hour remaining');

  const completed = await WorkCenter.completeOperation(operation.id);
  assert.equal(completed.status, 'COMPLETED');

  // A completed operation no longer counts as open load.
  const capacityAfterComplete = await WorkCenter.capacity({ horizonDays: 7 });
  const wcLoadAfterComplete = capacityAfterComplete.find((c) => c.id === wc.id);
  assert.equal(wcLoadAfterComplete?.remaining_hours ?? 0, 0, 'a completed operation must not still show as outstanding load');
});

test('a work centre with open operations on a released order cannot be deleted', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const wc = await WorkCenter.create({
    code: `WC${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    name: 'Test Paint Booth',
  }, userId);
  created.workCenterIds.push(wc.id);

  const item = await makeItem('Painted Item');
  const part = await makeItem('Paint');
  await stockItem(part, 100, 1);

  const bom = await BillOfMaterial.create({
    item_id: item, output_quantity: 1,
    components: [{ component_item_id: part, quantity_per: 1 }],
  }, userId);
  created.bomIds.push(bom.id);
  await WorkCenter.addBomOperation(bom.id, { work_center_id: wc.id, description: 'Paint', setup_hours: 0, run_hours_per_unit: 0.1 });
  await BillOfMaterial.activate(bom.id);

  const wo = await WorkOrder.create({ item_id: item, quantity: 5 }, userId);
  created.workOrderIds.push(wo.id);
  await WorkOrder.release(wo.id, userId);

  await assert.rejects(
    () => WorkCenter.remove(wc.id),
    /open operation/i,
    'retiring a loaded work centre would orphan the operations pointing at it'
  );
});
