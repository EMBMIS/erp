// Regression test for the goods-receipt blocker:
//
//   backend/services/goodsReceiptService.js built `inventoryItemData` with
//   `item_id`, but backend/models/InventoryItem.js consumes `item_master_id`
//   (and verifies the id against the `items` table). The item-master lookup
//   therefore found nothing, threw 'Item master not found', and the entire GR
//   transaction rolled back — no goods_receipts row, no inventory_items, no
//   GR/IR journal entry. This file posts a real receipt against a real
//   approved item master through the service and asserts all three artifacts
//   exist, then cleans up after itself (reverse FK order + GL balance restore).
//
// Real-DB suite: self-skips when no database is reachable, following
// tests/integration.test.js / tests/flows.integration.test.js. Run on its own
// (it opens a pg pool and must not race other suites):
//   cd backend && node --test tests/grRegression.test.js

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
// The GR service creates AND posts the GR/IR journal entry as the same user;
// services/authority.js SoD then only lets a platform owner self-post
// (middleware/rbac.js checkSoD + services/platformOwner.js). Resolve the
// platform owner up front (PLATFORM_OWNER_EMAIL env, else is_platform_owner
// flag) and skip the journal-critical test when this DB has none.
let actorIsPlatformOwner = false;

// Everything we create, so teardown can remove exactly it (unique UUIDs only).
const created = { itemIds: [], purchaseOrderIds: [], lineItemIds: [], receiptIds: [], journalEntryIds: [] };

before(async () => {
  try {
    await pool.query('SELECT 1');
    const suppliers = await pool.query('SELECT id FROM suppliers LIMIT 1');
    // Actor resolution. The plain "oldest user" pick is a trap: several seed
    // users in this DB are soft-deleted (deleted_at set), and resolveActor in
    // services/statusTransitionService.js filters deleted_at IS NULL — so the
    // GR/IR posting used to fail with "user record not found". Prefer the
    // platform owner (PLATFORM_OWNER_EMAIL, then is_platform_owner) and only
    // fall back to any active non-deleted user.
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
      // The GR/IR posting mutates chart_of_accounts.current_balance additively
      // and deleting the entry afterwards does not undo that; snapshot and
      // restore so this suite leaves db:verify's balance invariant intact.
      balanceSnapshot = (await pool.query('SELECT id, current_balance FROM chart_of_accounts')).rows;
      // JournalEntry.create refuses to post into a CLOSED period; skip the
      // tests in that (unusual) case instead of failing the whole suite.
      const now = new Date();
      const period = await pool.query(
        'SELECT status FROM accounting_periods WHERE period_year = $1 AND period_month = $2',
        [now.getFullYear(), now.getMonth() + 1]
      ).catch(() => ({ rows: [] }));
      periodClosed = period.rows.length > 0 && period.rows[0].status === 'CLOSED';
      dbAvailable = true;
    }
    console.log(`[grRegression] actor user=${userId || 'NONE'} platformOwner=${actorIsPlatformOwner}`);
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
    // inventory_items → cost_layers (ON DELETE CASCADE); goods_receipts first
    // so cost_layers.receipt_id (ON DELETE SET NULL) is never left dangling.
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
    // Restore GL balances exactly as found (posting the GR/IR entry moved 1130
    // and 2115; deleting the entry does not reverse that).
    if (balanceSnapshot) {
      for (const row of balanceSnapshot) {
        await pool.query('UPDATE chart_of_accounts SET current_balance = $1 WHERE id = $2',
          [row.current_balance, row.id]).catch(() => {});
      }
    }
  }
  await pool.end().catch(() => {});
});

// Seeds an approved item master + an APPROVED PO whose single line references
// it (po_line_items.item_id = items.id), all owned by `userId` — the same user
// that posts the receipt, because InventoryItem.create checks items.user_id.
async function seedApprovedItemAndPo(unitPrice = 25) {
  const item = await Item.create(
    { name: `GR regression item ${randomUUID()}`, description: 'created by grRegression.test.js', is_stock_item: true, unit_of_measure: 'pcs' },
    userId
  );
  created.itemIds.push(item.id);

  await pool.query("UPDATE items SET status = 'PENDING_REVIEW' WHERE id = $1", [item.id]);
  const approvedItem = await Item.approve(item.id, userId);
  assert.equal(approvedItem.status, 'APPROVED');

  const poId = randomUUID();
  const poNumber = `GR-REGRESSION-${randomUUID()}`;
  await pool.query(
    `INSERT INTO purchase_orders (id, po_number, supplier_id, po_date, currency, status, subtotal, tax_amount, total_amount, created_by)
     VALUES ($1, $2, $3, CURRENT_DATE, 'USD', 'APPROVED', $4, 0, $4, $5)`,
    [poId, poNumber, supplier.id, 2 * unitPrice, userId]
  );
  created.purchaseOrderIds.push(poId);

  const liRow = await pool.query(
    `INSERT INTO purchase_order_line_items (po_id, item_id, item_description, unit_of_measure, quantity, unit_price, quantity_received)
     VALUES ($1, $2, 'GR regression line', 'pcs', 2, $3, 0) RETURNING id`,
    [poId, item.id, unitPrice]
  );
  const lineItemId = liRow.rows[0].id;
  created.lineItemIds.push(lineItemId);

  return { item, poId, lineItemId, poNumber };
}

test('GR regression: goods receipt for an approved item master persists inventory_items, goods_receipts and the GR/IR journal entry', async (t) => {
  if (!dbAvailable) return t.skip('no database available');
  if (!supplier) return t.skip('no supplier in this database');
  if (periodClosed) return t.skip('current accounting period is CLOSED');
  if (!actorIsPlatformOwner) {
    return t.skip('no platform-owner user in this DB (PLATFORM_OWNER_EMAIL has no matching active user): the GR service self-posts the GR/IR entry, which Segregation-of-Duties blocks for non-owner actors');
  }

  const { item, poId, lineItemId } = await seedApprovedItemAndPo(25);

  // Post the goods receipt through the real service path (qty 1 of 2).
  const receipt = await GoodsReceiptService.receiveGoods(
    { po_id: poId, line_item_id: lineItemId, quantity_received: 1, condition_grade: 'NEW', notes: 'grRegression.test.js' },
    userId
  );
  created.receiptIds.push(receipt.receipt_id);

  // (a) An inventory_items row exists for the item master, carrying the PO
  //     line's unit price (the unit_price field the model actually inserts).
  const inv = await pool.query(
    'SELECT id, item_master_id, unit_price, condition_grade, user_id FROM inventory_items WHERE item_master_id = $1 AND user_id = $2',
    [item.id, userId]
  );
  assert.equal(inv.rows.length, 1, 'a goods receipt must create an inventory_items row for the received item master');
  assert.equal(Number(inv.rows[0].unit_price), 25, 'inventory_items.unit_price must come from the PO line unit price');
  assert.equal(inv.rows[0].condition_grade, 'A', "a 'NEW' receipt must map to inventory_items condition grade 'A'");

  // (b) A goods_receipts row exists and survived the transaction commit.
  const gr = await pool.query(
    'SELECT id, po_id, po_line_item_id, quantity_received FROM goods_receipts WHERE id = $1',
    [receipt.receipt_id]
  );
  assert.equal(gr.rows.length, 1, 'a goods_receipts row must exist after the receipt');
  assert.equal(gr.rows[0].po_id, poId);
  assert.equal(gr.rows[0].po_line_item_id, lineItemId);
  assert.equal(Number(gr.rows[0].quantity_received), 1);

  // (c) The GR/IR journal entry was created, balanced, and auto-posted.
  const je = await pool.query(
    "SELECT id, status, total_debit, total_credit FROM journal_entries WHERE source_type = 'GOODS_RECEIPT' AND source_id = $1 AND deleted_at IS NULL",
    [receipt.receipt_id]
  );
  assert.equal(je.rows.length, 1, 'a goods receipt must post one GR/IR journal entry');
  created.journalEntryIds.push(je.rows[0].id);
  assert.equal(je.rows[0].status, 'POSTED');
  assert.equal(Number(je.rows[0].total_debit), 25, 'Dr Inventory (1130) = qty * unit price');
  assert.equal(Number(je.rows[0].total_credit), 25, 'Cr GR/IR clearing (2115) = qty * unit price');

  // The rest of the write path completed too: the PO line shows the received qty.
  const line = await pool.query('SELECT quantity_received FROM purchase_order_line_items WHERE id = $1', [lineItemId]);
  assert.equal(Number(line.rows[0].quantity_received), 1, 'PurchaseOrder.receiveItems must have updated the PO line');
});

test('GR regression: receiving several units of one item master lands as a single inventory row carrying the whole quantity', async (t) => {
  if (!dbAvailable) return t.skip('no database available');
  if (!supplier) return t.skip('no supplier in this database');
  if (periodClosed) return t.skip('current accounting period is CLOSED');
  if (!actorIsPlatformOwner) {
    return t.skip('no platform-owner user in this DB (PLATFORM_OWNER_EMAIL has no matching active user): the GR service posts the GR/IR entry, which Segregation-of-Duties blocks for non-owner actors');
  }

  const { item, poId, lineItemId } = await seedApprovedItemAndPo(10);

  // This is the case that used to be impossible. inventory_items is UNIQUE on
  // (item_master_id, user_id), and the service looped InventoryItem.create once
  // per unit — so the second unit threw 'Inventory item already exists for this
  // item master' and rolled the whole receipt back. Any multi-unit delivery
  // therefore left no stock, no receipt and no GL entry. One row per item
  // master, quantity credited into current_stock_quantity, is the fix.
  const receipt = await GoodsReceiptService.receiveGoods(
    { po_id: poId, line_item_id: lineItemId, quantity_received: 2, condition_grade: 'NEW' },
    userId
  );
  created.receiptIds.push(receipt.receipt_id);

  const inv = await pool.query(
    'SELECT id, current_stock_quantity, unit_price FROM inventory_items WHERE item_master_id = $1 AND user_id = $2',
    [item.id, userId]
  );
  assert.equal(inv.rows.length, 1, 'a multi-unit receipt must create exactly ONE inventory_items row');
  assert.equal(Number(inv.rows[0].current_stock_quantity), 2, 'both received units must be in stock');
  assert.equal(Number(inv.rows[0].unit_price), 10, 'moving-average cost of a first receipt is the PO price');

  const gr = await pool.query('SELECT quantity_received FROM goods_receipts WHERE id = $1', [receipt.receipt_id]);
  assert.equal(Number(gr.rows[0].quantity_received), 2, 'the goods_receipts row must record the full quantity');

  const je = await pool.query(
    "SELECT id, status, total_debit, total_credit FROM journal_entries WHERE source_type = 'GOODS_RECEIPT' AND source_id = $1 AND deleted_at IS NULL",
    [receipt.receipt_id]
  );
  assert.equal(je.rows.length, 1, 'a multi-unit receipt must post one GR/IR journal entry');
  created.journalEntryIds.push(je.rows[0].id);
  assert.equal(je.rows[0].status, 'POSTED');
  assert.equal(Number(je.rows[0].total_debit), 20, 'Dr Inventory (1130) = 2 units * 10');
  assert.equal(Number(je.rows[0].total_credit), 20, 'Cr GR/IR clearing (2115) = 2 units * 10');
});
