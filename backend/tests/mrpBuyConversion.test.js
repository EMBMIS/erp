// Regression test for MRP BUY-order conversion
// (PHASE3_TEN_TENTHS_PROMPT.md item 4, Inventory: "Reorder-point suggestions
// feeding MRP/requisitions").
//
// services/mrpService.js's collectReorderDemand already nets reorder-point
// demand into the full MRP run (§21 of the eval), but convertPlannedOrder
// explicitly refused every BUY planned order: "A BUY order should go through
// purchasing" — with no route that actually did. MAKE orders had a real
// conversion to a work order; BUY orders dead-ended on the planning screen.
// This test exercises the real conversion this session added: a BUY planned
// order becomes a DRAFT purchase requisition, linked back via
// mrp_planned_orders.converted_to_id, cannot be converted twice, and carries
// a real supplier recommendation when one exists.
//
// It also regression-tests a bug found while adding the supplier lookup:
// findRecommendedSupplier queried supplier_items WHERE status = 'APPROVED',
// but supplier_items_status_check only permits ACTIVE / INACTIVE /
// PENDING_SUPPLIER_CONFIRMATION / SUPPLIER_REJECTED — that filter could never
// match a real row, so every reorder PR (and every BUY conversion) silently
// got no supplier recommendation regardless of what was on file. Fixed to
// 'ACTIVE' in both services/mrpService.js and services/reorderService.js.
//
// Real-DB suite: self-skips when no database is reachable. Run on its own:
//   cd backend && node --test tests/mrpBuyConversion.test.js

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { pool } = require('../config/database');
const mrpService = require('../services/mrpService');

let dbAvailable = false;
let userId = null;
let supplierId = null;

const created = { itemIds: [], inventoryItemIds: [], supplierItemIds: [], plannedOrderIds: [], requisitionIds: [] };

before(async () => {
  try {
    await pool.query('SELECT 1');
    const users = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
    const suppliers = await pool.query('SELECT id FROM suppliers LIMIT 1');
    if (users.rows.length && suppliers.rows.length) {
      userId = users.rows[0].id;
      supplierId = suppliers.rows[0].id;
      dbAvailable = true;
    }
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  if (dbAvailable) {
    for (const id of created.requisitionIds) {
      await pool.query('DELETE FROM purchase_requisitions WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.plannedOrderIds) {
      await pool.query('DELETE FROM mrp_planned_orders WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.supplierItemIds) {
      await pool.query('DELETE FROM supplier_items WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.inventoryItemIds) {
      await pool.query('DELETE FROM inventory_items WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.itemIds) {
      await pool.query('DELETE FROM items WHERE id = $1', [id]).catch(() => {});
    }
  }
  await pool.end().catch(() => {});
});

async function makeBelowReorderItem(name) {
  const { rows } = await pool.query(
    `INSERT INTO items (item_code, stock_code, name, description, status, unit_of_measure, user_id)
     VALUES ($1, 'ST2', $2, 'mrpBuyConversion test', 'APPROVED', 'EA', $3) RETURNING id`,
    [`MRPBUY${Math.random().toString(36).slice(2, 10)}`, name, userId]
  );
  const itemId = rows[0].id;
  created.itemIds.push(itemId);

  // No BOM -> BUY. Below reorder point -> reorder demand, netted by MRP.
  const inv = await pool.query(
    `INSERT INTO inventory_items
       (item_master_id, current_stock_quantity, reorder_point, maximum_stock_level, unit_price, currency, user_id, status)
     VALUES ($1, 2, 10, 30, 5, 'USD', $2, 'APPROVED') RETURNING id`,
    [itemId, userId]
  );
  const inventoryItemId = inv.rows[0].id;
  created.inventoryItemIds.push(inventoryItemId);

  return { itemId, inventoryItemId };
}

test('MRP BUY conversion: a BUY planned order becomes a real DRAFT purchase requisition with a supplier recommendation', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const { itemId, inventoryItemId } = await makeBelowReorderItem('MRP Buy Item');

  // A real, active supplier_items row, keyed on the inventory_items id —
  // supplier_items.item_id references inventory_items(id), not the item
  // master, the second bug this test covers.
  const si = await pool.query(
    `INSERT INTO supplier_items (supplier_id, item_id, unit_price, is_preferred, status)
     VALUES ($1, $2, 4.5, true, 'ACTIVE') RETURNING id`,
    [supplierId, inventoryItemId]
  );
  created.supplierItemIds.push(si.rows[0].id);

  const result = await mrpService.runMrp({ persist: true, includeReorderDemand: true });
  const plan = result.planned_orders.find((p) => p.item_id === itemId);
  assert.ok(plan, 'the below-reorder item must be planned');
  assert.equal(plan.order_type, 'BUY', 'an item with no active BOM is bought, not made');

  const { rows: planRows } = await pool.query(
    `SELECT id FROM mrp_planned_orders WHERE run_id = $1 AND item_id = $2`,
    [result.run_id, itemId]
  );
  assert.equal(planRows.length, 1, 'the persisted run must have written this planned order');
  const plannedOrderId = planRows[0].id;
  created.plannedOrderIds.push(plannedOrderId);

  const pr = await mrpService.convertPlannedOrder(plannedOrderId, userId);
  created.requisitionIds.push(pr.id);

  assert.equal(pr.status, 'DRAFT', 'MRP must never auto-approve a requisition');
  assert.equal(pr.item_id, itemId);
  assert.equal(Number(pr.quantity), Number(plan.quantity));
  assert.equal(pr.recommended_supplier_id, supplierId, 'the active preferred supplier must be recommended (the status=ACTIVE fix)');
  assert.equal(Number(pr.estimated_unit_price), 4.5);

  const updatedPlan = await pool.query('SELECT status, converted_to_id FROM mrp_planned_orders WHERE id = $1', [plannedOrderId]);
  assert.equal(updatedPlan.rows[0].status, 'CONVERTED');
  assert.equal(updatedPlan.rows[0].converted_to_id, pr.id);

  // Converting the same planned order twice is refused, not double-drafted.
  await assert.rejects(
    () => mrpService.convertPlannedOrder(plannedOrderId, userId),
    /already been converted/
  );
});

test('MRP BUY conversion: no supplier on file still converts, with no recommendation fabricated', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const { itemId } = await makeBelowReorderItem('MRP Buy Item No Supplier');

  const result = await mrpService.runMrp({ persist: true, includeReorderDemand: true });
  const { rows: planRows } = await pool.query(
    `SELECT id, quantity FROM mrp_planned_orders WHERE run_id = $1 AND item_id = $2`,
    [result.run_id, itemId]
  );
  assert.equal(planRows.length, 1);
  created.plannedOrderIds.push(planRows[0].id);

  const pr = await mrpService.convertPlannedOrder(planRows[0].id, userId);
  created.requisitionIds.push(pr.id);

  assert.equal(pr.status, 'DRAFT');
  assert.equal(pr.recommended_supplier_id, null, 'no supplier on file must not be papered over with a fabricated one');
});
