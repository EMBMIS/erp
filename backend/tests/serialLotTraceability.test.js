// Regression test for serial/lot traceability
// (PHASE3_TEN_TENTHS_PROMPT.md item 2, Inventory: "Serial/batch traceability
// end-to-end: GR capture -> issue by serial/lot -> recall report").
//
// goods_receipts already captured batch_lot_number/serial_numbers, and
// warehouse_transaction_items already had batch_number/serial_number columns
// on issue lines — but neither was ever connected to the other, and there was
// no way to ask "what happened to serial X". This test exercises the real
// chain through services/serialLotService.js: a goods receipt with two
// serials creates two traceable units; issuing one by serial consumes it and
// refuses to consume it again or an unknown serial; the recall report walks
// from the receipt (PO/supplier) to the issue.
//
// Real-DB suite: self-skips when no database is reachable. Run on its own:
//   cd backend && node --test tests/serialLotTraceability.test.js

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { pool } = require('../config/database');
const Item = require('../models/Item');
const GoodsReceiptService = require('../services/goodsReceiptService');
const WarehouseTransaction = require('../models/WarehouseTransaction');
const SerialLotService = require('../services/serialLotService');

let dbAvailable = false;
let userId = null;
let supplier = null;
let actorIsPlatformOwner = false;
let periodClosed = false;

const created = {
  itemIds: [], purchaseOrderIds: [], lineItemIds: [], receiptIds: [],
  journalEntryIds: [], warehouseTransactionIds: [], inventoryItemIds: [],
};

before(async () => {
  try {
    await pool.query('SELECT 1');
    const suppliers = await pool.query('SELECT id FROM suppliers LIMIT 1');
    const ownerEmail = (process.env.PLATFORM_OWNER_EMAIL || '').trim().toLowerCase();
    let actorRow = null;
    if (ownerEmail) {
      const r = await pool.query(
        'SELECT id FROM users WHERE lower(email) = $1 AND deleted_at IS NULL AND COALESCE(is_active, true) = true LIMIT 1',
        [ownerEmail]
      );
      actorRow = r.rows[0] || null;
      if (actorRow) actorIsPlatformOwner = true;
    }
    if (!actorRow) {
      const r = await pool.query(
        "SELECT id FROM users WHERE deleted_at IS NULL AND COALESCE(is_active, true) = true AND is_platform_owner = true LIMIT 1"
      );
      actorRow = r.rows[0] || null;
      if (actorRow) actorIsPlatformOwner = true;
    }
    if (actorRow && suppliers.rows.length) {
      userId = actorRow.id;
      supplier = suppliers.rows[0];
      const now = new Date();
      const period = await pool.query(
        'SELECT status FROM accounting_periods WHERE period_year = $1 AND period_month = $2',
        [now.getFullYear(), now.getMonth() + 1]
      ).catch(() => ({ rows: [] }));
      periodClosed = period.rows.length > 0 && period.rows[0].status === 'CLOSED';
      dbAvailable = true;
    }
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  if (dbAvailable) {
    for (const id of created.warehouseTransactionIds) {
      await pool.query('DELETE FROM journal_entry_status_history WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE source_id = $1)', [id]).catch(() => {});
      await pool.query('DELETE FROM journal_entry_items WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE source_id = $1)', [id]).catch(() => {});
      await pool.query('DELETE FROM journal_entries WHERE source_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM warehouse_transaction_items WHERE warehouse_transaction_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM warehouse_transaction_audit WHERE warehouse_transaction_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM warehouse_transactions WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.journalEntryIds) {
      await pool.query('DELETE FROM journal_entry_status_history WHERE journal_entry_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM journal_entry_items WHERE journal_entry_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM journal_entries WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.receiptIds) {
      await pool.query('DELETE FROM serial_lot_movements WHERE unit_id IN (SELECT id FROM serial_lot_units WHERE goods_receipt_id = $1)', [id]).catch(() => {});
      await pool.query('DELETE FROM serial_lot_units WHERE goods_receipt_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM inventory_items WHERE id IN (SELECT inventory_item_id FROM cost_layers WHERE receipt_id = $1)', [id]).catch(() => {});
      await pool.query('DELETE FROM goods_receipts WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.lineItemIds) {
      await pool.query('DELETE FROM purchase_order_line_items WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.purchaseOrderIds) {
      await pool.query('DELETE FROM purchase_orders WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.itemIds) {
      await pool.query('DELETE FROM inventory_items WHERE item_master_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM items WHERE id = $1', [id]).catch(() => {});
    }
  }
  await pool.end().catch(() => {});
});

async function seedApprovedItemAndPo(unitPrice = 40, qty = 2) {
  const item = await Item.create(
    { name: `Serial regression item ${randomUUID()}`, description: 'created by serialLotTraceability.test.js', is_stock_item: true, unit_of_measure: 'pcs' },
    userId
  );
  created.itemIds.push(item.id);
  await pool.query("UPDATE items SET status = 'PENDING_REVIEW' WHERE id = $1", [item.id]);
  await Item.approve(item.id, userId);

  const poId = randomUUID();
  await pool.query(
    `INSERT INTO purchase_orders (id, po_number, supplier_id, po_date, currency, status, subtotal, tax_amount, total_amount, created_by)
     VALUES ($1, $2, $3, CURRENT_DATE, 'USD', 'APPROVED', $4, 0, $4, $5)`,
    [poId, `SLT-REG-${randomUUID().slice(0, 8)}`, supplier.id, qty * unitPrice, userId]
  );
  created.purchaseOrderIds.push(poId);

  const liRow = await pool.query(
    `INSERT INTO purchase_order_line_items (po_id, item_id, item_description, unit_of_measure, quantity, unit_price, quantity_received)
     VALUES ($1, $2, 'Serial regression line', 'pcs', $3, $4, 0) RETURNING id`,
    [poId, item.id, qty, unitPrice]
  );
  created.lineItemIds.push(liRow.rows[0].id);

  return { item, poId, lineItemId: liRow.rows[0].id };
}

let inventoryItemId = null;

test('serial traceability: a goods receipt with serial numbers creates one traceable unit per serial', async (t) => {
  if (!dbAvailable) return t.skip('no database available');
  if (!supplier) return t.skip('no supplier in this database');
  if (periodClosed) return t.skip('current accounting period is CLOSED');
  if (!actorIsPlatformOwner) return t.skip('no platform-owner user in this DB');

  const { item, poId, lineItemId } = await seedApprovedItemAndPo(40, 2);

  const receipt = await GoodsReceiptService.receiveGoods(
    { po_id: poId, line_item_id: lineItemId, quantity_received: 2, condition_grade: 'NEW', serial_numbers: ['SLT-SN-A', 'SLT-SN-B'] },
    userId
  );
  created.receiptIds.push(receipt.receipt_id);

  const inv = await pool.query('SELECT id FROM inventory_items WHERE item_master_id = $1 AND user_id = $2', [item.id, userId]);
  inventoryItemId = inv.rows[0].id;

  const units = await pool.query(
    'SELECT serial_number, remaining_quantity, status, goods_receipt_id FROM serial_lot_units WHERE inventory_item_id = $1 ORDER BY serial_number',
    [inventoryItemId]
  );
  assert.equal(units.rows.length, 2, 'one traceable unit per serial received');
  assert.deepEqual(units.rows.map((r) => r.serial_number), ['SLT-SN-A', 'SLT-SN-B']);
  assert.ok(units.rows.every((r) => r.status === 'IN_STOCK' && Number(r.remaining_quantity) === 1));
  assert.ok(units.rows.every((r) => r.goods_receipt_id === receipt.receipt_id));
});

test('serial traceability: issuing by serial consumes the real unit and refuses an unknown or already-issued serial', async (t) => {
  if (!dbAvailable) return t.skip('no database available');
  if (!inventoryItemId) return t.skip('depends on the previous test receiving serialized stock');

  // Unknown serial: refused, not silently accepted as free text.
  await assert.rejects(
    () => WarehouseTransaction.create(
      { transaction_type: 'GI', reference_type: 'MANUAL', created_by: userId },
      [{ inventory_item_id: inventoryItemId, item_name: 'Serial regression item', unit_of_measure: 'pcs', reason_code: 'ISSUE', issued_quantity: 1, unit_cost: 40, serial_number: 'SLT-SN-DOES-NOT-EXIST' }]
    ),
    /was not received for this item|already been issued/
  );

  // Real serial: succeeds, consumes the unit, posts COGS.
  const txn = await WarehouseTransaction.create(
    { transaction_type: 'GI', reference_type: 'MANUAL', created_by: userId },
    [{ inventory_item_id: inventoryItemId, item_name: 'Serial regression item', unit_of_measure: 'pcs', reason_code: 'ISSUE', issued_quantity: 1, unit_cost: 40, serial_number: 'SLT-SN-A' }]
  );
  created.warehouseTransactionIds.push(txn.id);
  assert.equal(txn.status, 'POSTED');

  const unitA = await pool.query(
    "SELECT status, remaining_quantity FROM serial_lot_units WHERE inventory_item_id = $1 AND serial_number = 'SLT-SN-A'",
    [inventoryItemId]
  );
  assert.equal(unitA.rows[0].status, 'ISSUED');
  assert.equal(Number(unitA.rows[0].remaining_quantity), 0);

  const unitB = await pool.query(
    "SELECT status, remaining_quantity FROM serial_lot_units WHERE inventory_item_id = $1 AND serial_number = 'SLT-SN-B'",
    [inventoryItemId]
  );
  assert.equal(unitB.rows[0].status, 'IN_STOCK', 'the untouched serial must not be affected');
  assert.equal(Number(unitB.rows[0].remaining_quantity), 1);

  const movement = await pool.query(
    `SELECT slm.* FROM serial_lot_movements slm
       JOIN serial_lot_units slu ON slu.id = slm.unit_id
      WHERE slu.serial_number = 'SLT-SN-A'`
  );
  assert.equal(movement.rows.length, 1);
  assert.equal(movement.rows[0].warehouse_transaction_id, txn.id);

  // Issuing the same serial again is refused — it has nothing left to give.
  await assert.rejects(
    () => WarehouseTransaction.create(
      { transaction_type: 'GI', reference_type: 'MANUAL', created_by: userId },
      [{ inventory_item_id: inventoryItemId, item_name: 'Serial regression item', unit_of_measure: 'pcs', reason_code: 'ISSUE', issued_quantity: 1, unit_cost: 40, serial_number: 'SLT-SN-A' }]
    ),
    /was not received for this item|already been issued/
  );
});

test('serial traceability: the recall report walks from the receipt (PO/supplier) to the issue', async (t) => {
  if (!dbAvailable) return t.skip('no database available');
  if (!inventoryItemId) return t.skip('depends on the previous tests');

  const report = await SerialLotService.recallReport({ serialNumber: 'SLT-SN-A' });
  assert.equal(report.found, true);
  assert.equal(report.units.length, 1);
  const unit = report.units[0];
  assert.equal(unit.serial_number, 'SLT-SN-A');
  assert.ok(unit.po_number, 'recall must resolve back to the purchase order that brought this serial in');
  assert.ok(unit.supplier_name, 'recall must resolve back to the supplier');
  assert.equal(unit.movements.length, 1, 'the one issue this serial was part of must appear in its recall trail');

  // The untouched serial has no movements — it is still sitting in stock.
  const reportB = await SerialLotService.recallReport({ serialNumber: 'SLT-SN-B' });
  assert.equal(reportB.units[0].movements.length, 0);

  // A serial that was never received resolves to "not found", not an error.
  const notFound = await SerialLotService.recallReport({ serialNumber: 'SLT-SN-NEVER-EXISTED' });
  assert.equal(notFound.found, false);
});
