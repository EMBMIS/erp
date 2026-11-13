// Regression test for the multi-receipt goods-receipt blocker:
//
//   backend/services/goodsReceiptService.js called InventoryItem.create()
//   unconditionally on every receipt. inventory_items is UNIQUE on
//   (item_master_id, user_id), and InventoryItem.create() throws 'Inventory
//   item already exists for this item master' when a row already exists —
//   which it does after the FIRST receipt of any item that has ever been
//   received before, for ANY purchase order. Every receipt after the first
//   one ever posted for an item therefore rolled back the entire
//   transaction: no goods_receipts row, no stock movement, no GR/IR journal
//   entry. This blocked partial/multi-shipment receiving (receive part of a
//   PO line, then receive the rest later) and any repeat purchase of an item
//   that already had inventory on hand — reproduced live against the real
//   dev DB before the fix (first receipt of qty 2/4 succeeded, second
//   receipt of the remaining qty 2/4 threw and rolled back).
//
// This file posts two separate receipts against the same PO line (a
// realistic partial-shipment scenario) and asserts both succeed, stock
// accumulates correctly in the single inventory_items row, and each receipt
// gets its own GR/IR journal entry. Then it posts a receipt for a SECOND,
// unrelated PO against the same item master (the repeat-purchase case) and
// asserts that succeeds too.
//
// Real-DB suite: self-skips when no database is reachable, following
// tests/grRegression.test.js. Run on its own (it opens a pg pool and must
// not race other suites):
//   cd backend && node --test tests/grMultiReceiptRegression.test.js

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { pool } = require('../config/database');
const Item = require('../models/Item');
const GoodsReceiptService = require('../services/goodsReceiptService');

let dbAvailable = false;
let userId = null;
let supplier = null;
let balanceSnapshot = null;
let periodClosed = false;
let actorIsPlatformOwner = false;

const created = { itemIds: [], purchaseOrderIds: [], lineItemIds: [], receiptIds: [], journalEntryIds: [] };

before(async () => {
  try {
    await pool.query('SELECT 1');
    const suppliers = await pool.query('SELECT id FROM suppliers LIMIT 1');
    const ownerEmail = (process.env.PLATFORM_OWNER_EMAIL || '').trim().toLowerCase();
    let actorRow = null;
    if (ownerEmail) {
      const r = await pool.query(
        'SELECT id, email, is_platform_owner FROM users WHERE lower(email) = $1 AND deleted_at IS NULL AND COALESCE(is_active, true) = true LIMIT 1',
        [ownerEmail]
      );
      actorRow = r.rows[0] || null;
      if (actorRow) actorIsPlatformOwner = true;
    }
    if (!actorRow) {
      const r = await pool.query(
        'SELECT id, email, is_platform_owner FROM users WHERE deleted_at IS NULL AND COALESCE(is_active, true) = true AND is_platform_owner = true LIMIT 1'
      );
      actorRow = r.rows[0] || null;
      if (actorRow) actorIsPlatformOwner = true;
    }
    if (!actorRow) {
      const r = await pool.query(
        'SELECT id, email, is_platform_owner FROM users WHERE deleted_at IS NULL AND COALESCE(is_active, true) = true ORDER BY created_at LIMIT 1'
      );
      actorRow = r.rows[0] || null;
    }
    if (actorRow && suppliers.rows.length) {
      userId = actorRow.id;
      supplier = suppliers.rows[0];
      balanceSnapshot = (await pool.query('SELECT id, current_balance FROM chart_of_accounts')).rows;
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
    for (const id of created.journalEntryIds) {
      await pool.query('DELETE FROM journal_entry_status_history WHERE journal_entry_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM journal_entry_items WHERE journal_entry_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM journal_entries WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.receiptIds) {
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
    if (balanceSnapshot) {
      for (const row of balanceSnapshot) {
        await pool.query('UPDATE chart_of_accounts SET current_balance = $1 WHERE id = $2',
          [row.current_balance, row.id]).catch(() => {});
      }
    }
  }
  await pool.end().catch(() => {});
});

async function seedApprovedItem() {
  const item = await Item.create(
    { name: `GR multi-receipt regression item ${randomUUID()}`, description: 'created by grMultiReceiptRegression.test.js', is_stock_item: true, unit_of_measure: 'pcs' },
    userId
  );
  created.itemIds.push(item.id);
  await pool.query("UPDATE items SET status = 'PENDING_REVIEW' WHERE id = $1", [item.id]);
  const approvedItem = await Item.approve(item.id, userId);
  assert.equal(approvedItem.status, 'APPROVED');
  return item;
}

async function seedApprovedPo(item, quantity, unitPrice) {
  const poId = randomUUID();
  const poNumber = `GRM-${randomUUID()}`;
  await pool.query(
    `INSERT INTO purchase_orders (id, po_number, supplier_id, po_date, currency, status, subtotal, tax_amount, total_amount, created_by)
     VALUES ($1, $2, $3, CURRENT_DATE, 'USD', 'APPROVED', $4, 0, $4, $5)`,
    [poId, poNumber, supplier.id, quantity * unitPrice, userId]
  );
  created.purchaseOrderIds.push(poId);

  const liRow = await pool.query(
    `INSERT INTO purchase_order_line_items (po_id, item_id, item_description, unit_of_measure, quantity, unit_price, quantity_received)
     VALUES ($1, $2, 'GR multi-receipt regression line', 'pcs', $3, $4, 0) RETURNING id`,
    [poId, item.id, quantity, unitPrice]
  );
  const lineItemId = liRow.rows[0].id;
  created.lineItemIds.push(lineItemId);
  return { poId, lineItemId, poNumber };
}

test('GR multi-receipt regression: a second receipt of an item already received once (partial shipment) no longer rolls back', async (t) => {
  if (!dbAvailable) return t.skip('no database available');
  if (!supplier) return t.skip('no supplier in this database');
  if (periodClosed) return t.skip('current accounting period is CLOSED');
  if (!actorIsPlatformOwner) {
    return t.skip('no platform-owner user in this DB (PLATFORM_OWNER_EMAIL has no matching active user): the GR service self-posts the GR/IR entry, which Segregation-of-Duties blocks for non-owner actors');
  }

  const item = await seedApprovedItem();
  const { poId, lineItemId } = await seedApprovedPo(item, 4, 25);

  // First receipt: 2 of 4 units.
  const r1 = await GoodsReceiptService.receiveGoods(
    { po_id: poId, line_item_id: lineItemId, quantity_received: 2, condition_grade: 'NEW' },
    userId
  );
  created.receiptIds.push(r1.receipt_id);
  // A single-line PO's status logic (PurchaseOrder.receiveItems) only flags
  // PARTIALLY_RECEIVED once at least one line is fully received but not all
  // lines are (a multi-line scenario) — a lone line that is itself partially
  // received just stays CONFIRMED. Not the bug under test; documented so the
  // assertion below isn't mistaken for a regression later.
  assert.equal(r1.po_status, 'CONFIRMED');

  // Second receipt: the remaining 2 of 4 units. Before the fix, this threw
  // 'Inventory item already exists for this item master' because the first
  // receipt had already created the inventory_items row, and rolled back —
  // no second goods_receipts row, no stock credited, no GR/IR entry.
  const r2 = await GoodsReceiptService.receiveGoods(
    { po_id: poId, line_item_id: lineItemId, quantity_received: 2, condition_grade: 'NEW' },
    userId
  );
  created.receiptIds.push(r2.receipt_id);
  assert.equal(r2.po_status, 'FULLY_RECEIVED', 'the PO must advance to fully received once both receipts land');
  assert.notEqual(r2.receipt_id, r1.receipt_id);

  // Exactly ONE inventory_items row exists, carrying the full accumulated quantity.
  const inv = await pool.query(
    'SELECT id, current_stock_quantity, unit_price FROM inventory_items WHERE item_master_id = $1 AND user_id = $2',
    [item.id, userId]
  );
  assert.equal(inv.rows.length, 1, 'both receipts of the same item master must share a single inventory_items row');
  assert.equal(Number(inv.rows[0].current_stock_quantity), 4, 'stock must accumulate across both receipts (2 + 2)');

  // Both goods_receipts rows exist.
  const grs = await pool.query('SELECT id, quantity_received FROM goods_receipts WHERE po_id = $1 ORDER BY received_date', [poId]);
  assert.equal(grs.rows.length, 2, 'both receipts must have persisted their own goods_receipts row');

  // Both GR/IR journal entries were posted (one per receipt — not silently skipped on the second).
  const jes = await pool.query(
    "SELECT id FROM journal_entries WHERE source_type = 'GOODS_RECEIPT' AND source_id = ANY($1) AND deleted_at IS NULL",
    [[r1.receipt_id, r2.receipt_id]]
  );
  assert.equal(jes.rows.length, 2, 'each receipt must post its own GR/IR journal entry');
  jes.rows.forEach((je) => created.journalEntryIds.push(je.id));
});

test('GR multi-receipt regression: receiving the same item master again on a later, unrelated PO (repeat purchase) succeeds', async (t) => {
  if (!dbAvailable) return t.skip('no database available');
  if (!supplier) return t.skip('no supplier in this database');
  if (periodClosed) return t.skip('current accounting period is CLOSED');
  if (!actorIsPlatformOwner) {
    return t.skip('no platform-owner user in this DB (PLATFORM_OWNER_EMAIL has no matching active user): the GR service self-posts the GR/IR entry, which Segregation-of-Duties blocks for non-owner actors');
  }

  const item = await seedApprovedItem();
  const firstPo = await seedApprovedPo(item, 1, 15);
  const r1 = await GoodsReceiptService.receiveGoods(
    { po_id: firstPo.poId, line_item_id: firstPo.lineItemId, quantity_received: 1, condition_grade: 'NEW' },
    userId
  );
  created.receiptIds.push(r1.receipt_id);
  assert.equal(r1.po_status, 'FULLY_RECEIVED');

  // A second, entirely separate PO for the same item master — the ordinary
  // repeat-purchase case, previously impossible for any item ever received before.
  const secondPo = await seedApprovedPo(item, 3, 15);
  const r2 = await GoodsReceiptService.receiveGoods(
    { po_id: secondPo.poId, line_item_id: secondPo.lineItemId, quantity_received: 3, condition_grade: 'NEW' },
    userId
  );
  created.receiptIds.push(r2.receipt_id);
  assert.equal(r2.po_status, 'FULLY_RECEIVED');

  const inv = await pool.query(
    'SELECT current_stock_quantity FROM inventory_items WHERE item_master_id = $1 AND user_id = $2',
    [item.id, userId]
  );
  assert.equal(inv.rows.length, 1);
  assert.equal(Number(inv.rows[0].current_stock_quantity), 4, 'stock across two unrelated POs for the same item must accumulate (1 + 3)');

  const jes = await pool.query(
    "SELECT id FROM journal_entries WHERE source_type = 'GOODS_RECEIPT' AND source_id = ANY($1) AND deleted_at IS NULL",
    [[r1.receipt_id, r2.receipt_id]]
  );
  assert.equal(jes.rows.length, 2);
  jes.rows.forEach((je) => created.journalEntryIds.push(je.id));
});
