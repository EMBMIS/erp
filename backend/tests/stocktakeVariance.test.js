// Regression test for the stocktake variance-posting gate
// (PHASE3_TEN_TENTHS_PROMPT.md item 1, Inventory: "Stocktake with counted-vs-
// system variance posting: count -> approval -> GL variance").
//
// backend/database/migrations/132_stocktake.sql defines the intended
// workflow in its own CHECK constraint: DRAFT -> IN_PROGRESS -> COUNTED ->
// REVIEWED -> POSTED. But routes/stocktake.js's POST /sheets/:id/post only
// required requireManagerOrAdmin and "not already POSTED" — any manager could
// count a sheet and post its own count straight to the GL in one step, with
// no second person ever reviewing the variance before it moved stock and
// money. This test exercises the real submit -> review -> post lifecycle and
// asserts: (1) posting before REVIEWED is refused, (2) SoD blocks the person
// who did the count from also reviewing it, (3) a distinct reviewer can, and
// (4) posting a REVIEWED sheet moves stock, consumes/creates cost layers, and
// posts a balanced GL entry.
//
// It also regression-tests a real bug found while reading this file:
// postStocktakeSheet(sheetId, user) was called with `user` = req.user.id (a
// plain string), but the function body read `user.id` in the journal-entry
// and cost-layer calls — always undefined, so every stocktake variance
// posting silently recorded a null poster/created_by.
//
// Real-DB suite: self-skips when no database is reachable. Run on its own:
//   cd backend && node --test tests/stocktakeVariance.test.js

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { pool } = require('../config/database');
const Item = require('../models/Item');
const stocktake = require('../routes/stocktake');

let dbAvailable = false;
let counterId = null;
let reviewerId = null;
let sheetId = null;
let inventoryItemId = null;

const created = { itemIds: [], inventoryItemIds: [], sheetIds: [], journalEntryIds: [], costLayerIds: [] };

before(async () => {
  try {
    await pool.query('SELECT 1');
    const users = await pool.query(
      "SELECT id FROM users WHERE deleted_at IS NULL AND COALESCE(is_active, true) = true AND role IN ('ADMIN','MANAGER') ORDER BY created_at LIMIT 2"
    );
    if (users.rows.length < 2) throw new Error('need at least 2 manager/admin users for the SoD half of this test');
    [counterId, reviewerId] = users.rows.map((r) => r.id);
    dbAvailable = true;
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
    for (const id of created.sheetIds) {
      await pool.query('DELETE FROM stocktake_sheet_items WHERE sheet_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM stocktake_sheets WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.inventoryItemIds) {
      await pool.query('DELETE FROM cost_layers WHERE inventory_item_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM inventory_items WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.itemIds) {
      await pool.query('DELETE FROM items WHERE id = $1', [id]).catch(() => {});
    }
  }
  await pool.end().catch(() => {});
});

// Seeds an approved item master, an inventory_items row with known stock/cost,
// one opening cost layer matching that stock, and a COUNTED stocktake sheet
// with a single line whose count is 2 units short (shrinkage).
async function seedCountedSheet(qtyOnHand = 10, unitCost = 25, countedQty = 8) {
  const item = await Item.create(
    { name: `Stocktake regression item ${randomUUID()}`, description: 'created by stocktakeVariance.test.js', is_stock_item: true, unit_of_measure: 'pcs' },
    counterId
  );
  created.itemIds.push(item.id);
  await pool.query("UPDATE items SET status = 'PENDING_REVIEW' WHERE id = $1", [item.id]);
  await Item.approve(item.id, counterId);

  const invId = randomUUID();
  await pool.query(
    `INSERT INTO inventory_items (id, item_master_id, current_stock_quantity, unit_price, currency, user_id, status)
     VALUES ($1, $2, $3, $4, 'USD', $5, 'APPROVED')`,
    [invId, item.id, qtyOnHand, unitCost, counterId]
  );
  created.inventoryItemIds.push(invId);
  inventoryItemId = invId;

  const layer = await pool.query(
    `INSERT INTO cost_layers (inventory_item_id, receipt_type, quantity, unit_cost, remaining_quantity, created_by)
     VALUES ($1, 'INITIAL', $2, $3, $2, $4) RETURNING id`,
    [invId, qtyOnHand, unitCost, counterId]
  );
  created.costLayerIds.push(layer.rows[0].id);

  const sId = randomUUID();
  await pool.query(
    `INSERT INTO stocktake_sheets (id, sheet_number, status, created_by, counted_by, counted_at)
     VALUES ($1, $2, 'COUNTED', $3, $3, CURRENT_TIMESTAMP)`,
    [sId, `STK-REGRESSION-${randomUUID().slice(0, 8)}`, counterId]
  );
  created.sheetIds.push(sId);
  sheetId = sId;

  await pool.query(
    `INSERT INTO stocktake_sheet_items (sheet_id, inventory_item_id, book_quantity, counted_quantity, unit_cost, status)
     VALUES ($1, $2, $3, $4, $5, 'COUNTED')`,
    [sId, invId, qtyOnHand, countedQty, unitCost]
  );

  return { item, invId, sId };
}

test('stocktake variance: posting is refused before the sheet is REVIEWED', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  await seedCountedSheet();

  // COUNTED (not yet REVIEWED) must refuse /post.
  await assert.rejects(
    () => stocktake.postStocktakeSheet(sheetId, counterId),
    /must be submitted .* and reviewed/i
  );

  // Trying to /review a sheet that has already been posted, or /submit one
  // that is not IN_PROGRESS, are both refused by the same guard shape.
  await assert.rejects(
    () => stocktake.submitStocktakeSheet(sheetId, counterId),
    /must be IN_PROGRESS/
  );
});

test('stocktake variance: SoD blocks the counter from reviewing their own count; a distinct reviewer succeeds', async (t) => {
  if (!dbAvailable) return t.skip('no database available');
  if (!sheetId) return t.skip('depends on the previous test creating a COUNTED sheet');

  const { checkSoD } = require('../middleware/rbac');
  const { recordCreator } = require('../middleware/recordOwner');
  const getCounter = recordCreator('stocktake_sheets');
  const owner = await getCounter({ params: { id: sheetId } });
  assert.equal(owner, counterId, "recordCreator must resolve the sheet's counted_by, for the SoD guard to check against");

  assert.throws(() => checkSoD(owner, counterId, 'stocktake review'), /Segregation of duties/);

  const reviewed = await stocktake.reviewStocktakeSheet(sheetId, reviewerId);
  assert.equal(reviewed.status, 'REVIEWED');
  assert.equal(reviewed.reviewed_by, reviewerId);
});

test('stocktake variance: posting a REVIEWED sheet moves stock, consumes cost layers, and posts a balanced GL entry with a real poster', async (t) => {
  if (!dbAvailable) return t.skip('no database available');
  if (!sheetId) return t.skip('depends on the previous tests reaching REVIEWED');

  const before = await pool.query('SELECT current_stock_quantity FROM inventory_items WHERE id = $1', [inventoryItemId]);
  assert.equal(Number(before.rows[0].current_stock_quantity), 10);

  const result = await stocktake.postStocktakeSheet(sheetId, reviewerId);
  assert.equal(result.status, 'POSTED');
  assert.equal(result.items_posted, 1);

  // Stock dropped by the variance (8 counted - 10 book = -2).
  const after = await pool.query('SELECT current_stock_quantity FROM inventory_items WHERE id = $1', [inventoryItemId]);
  assert.equal(Number(after.rows[0].current_stock_quantity), 8, 'shrinkage of 2 units must be credited into current_stock_quantity');

  // The opening cost layer was consumed by 2 units (10 -> 8 remaining).
  const layer = await pool.query('SELECT remaining_quantity FROM cost_layers WHERE inventory_item_id = $1', [inventoryItemId]);
  assert.equal(Number(layer.rows[0].remaining_quantity), 8, 'shrinkage must consume 2 units from the opening cost layer');

  // Sheet + item reached their terminal statuses.
  const sheet = await pool.query('SELECT status FROM stocktake_sheets WHERE id = $1', [sheetId]);
  assert.equal(sheet.rows[0].status, 'POSTED');
  const item = await pool.query('SELECT status FROM stocktake_sheet_items WHERE sheet_id = $1', [sheetId]);
  assert.equal(item.rows[0].status, 'ADJUSTED');

  // A balanced INVENTORY_ADJUSTMENT journal entry was posted with a real
  // (non-null) poster — the user.id-on-a-string-id bug this test also covers.
  const je = await pool.query(
    "SELECT id, status, total_debit, total_credit, posted_by FROM journal_entries WHERE source_type = 'INVENTORY_ADJUSTMENT' AND source_id = $1 AND deleted_at IS NULL",
    [inventoryItemId]
  );
  assert.equal(je.rows.length, 1, 'expected one GL entry for the stocktake variance');
  created.journalEntryIds.push(je.rows[0].id);
  assert.equal(je.rows[0].status, 'POSTED');
  assert.equal(Number(je.rows[0].total_debit), Number(je.rows[0].total_credit), 'journal entry must balance');
  assert.equal(Number(je.rows[0].total_debit), 50, '2 units * $25 shrinkage = $50');
  assert.ok(je.rows[0].posted_by, 'posted_by must not be null/undefined (the user.id-on-a-string bug)');

  // Posting again is refused, not silently re-applied.
  await assert.rejects(() => stocktake.postStocktakeSheet(sheetId, reviewerId), /already posted/i);
});
