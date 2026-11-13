/**
 * Stocktake / Cycle Counting — full count-to-posting workflow.
 *
 * Create count sheets populated from current inventory, record physical counts,
 * review variances, and post validated adjustments to the GL via the existing
 * FinancialPostingService.postInventoryAdjustment.
 */

const express = require('express');
const router = express.Router();
const { auth, requireManagerOrAdmin } = require('../middleware/auth');
const { requireSoD } = require('../middleware/rbac');
const { recordCreator } = require('../middleware/recordOwner');
const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const CostLayerService = require('../services/costLayerService');
const { lockInventoryItemForWrite, withDeadlockRetry } = require('../services/dbRetry');

router.use(auth);

// GET /stocktake/sheets — list sheets
router.get('/sheets', async (req, res) => {
  try {
    const { status, location_id } = req.query;
    let query = 'SELECT * FROM stocktake_sheets WHERE deleted_at IS NULL';
    const params = [];
    if (status) { params.push(status); query += ` AND status = $${params.length}`; }
    if (location_id) { params.push(location_id); query += ` AND location_id = $${params.length}`; }
    query += ' ORDER BY created_at DESC LIMIT 100';
    const { rows } = await pool.query(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('List stocktake sheets error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /stocktake/sheets — create a new count sheet
router.post('/sheets', requireManagerOrAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { location_id, notes } = req.body;

    // Generate sheet number
    const numRes = await client.query("SELECT 'STK-' || TO_CHAR(CURRENT_DATE, 'YYYYMMDD') || '-' || LPAD(COALESCE((SELECT COUNT(*)::int + 1 FROM stocktake_sheets WHERE created_at::date = CURRENT_DATE), 1)::text, 3, '0') AS num");
    const sheetNumber = numRes.rows[0].num;

    const sheetId = uuidv4();
    await client.query(
      `INSERT INTO stocktake_sheets (id, sheet_number, status, location_id, notes, created_by)
       VALUES ($1, $2, 'DRAFT', $3, $4, $5)`,
      [sheetId, sheetNumber, location_id || null, notes || null, req.user.id]
    );

    // Populate items from current inventory at the location
    let itemQuery = `
      SELECT im.id AS inventory_item_id, im.current_stock_quantity, im.unit_price
        FROM inventory_items im
        JOIN inventory_storage_mappings ism ON ism.inventory_item_id = im.id
       WHERE im.status = 'APPROVED'`;
    const itemParams = [];
    if (location_id) {
      itemParams.push(location_id);
      itemQuery += ` AND ism.storage_location_id = $${itemParams.length}`;
    }
    itemQuery += ' GROUP BY im.id, im.current_stock_quantity, im.unit_price';

    const { rows: items } = await client.query(itemQuery, itemParams);

    if (items.length === 0) {
      await client.query('ROLLBACK');
      return res.status(422).json({ success: false, error: 'No inventory items found at this location.' });
    }

    for (const item of items) {
      await client.query(
        `INSERT INTO stocktake_sheet_items (sheet_id, inventory_item_id, book_quantity, unit_cost)
         VALUES ($1, $2, $3, $4)`,
        [sheetId, item.inventory_item_id, Number(item.current_stock_quantity), Number(item.unit_price) || 0]
      );
    }

    await client.query('COMMIT');

    const { rows: [sheet] } = await pool.query(
      `SELECT s.*, COUNT(si.id)::int AS item_count
         FROM stocktake_sheets s
         LEFT JOIN stocktake_sheet_items si ON si.sheet_id = s.id
        WHERE s.id = $1
        GROUP BY s.id`,
      [sheetId]
    );

    res.status(201).json({ success: true, data: sheet });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create stocktake sheet error:', err);
    res.status(400).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// GET /stocktake/sheets/:id — get sheet with items
router.get('/sheets/:id', async (req, res) => {
  try {
    const { rows: [sheet] } = await pool.query(
      'SELECT * FROM stocktake_sheets WHERE id = $1 AND deleted_at IS NULL', [req.params.id]
    );
    if (!sheet) return res.status(404).json({ success: false, error: 'Sheet not found' });

    const { rows: items } = await pool.query(
      `SELECT si.*, i.name AS item_name, i.item_code
         FROM stocktake_sheet_items si
         JOIN inventory_items ii ON si.inventory_item_id = ii.id
         JOIN items i ON ii.item_master_id = i.id
        WHERE si.sheet_id = $1
        ORDER BY i.name`,
      [req.params.id]
    );

    res.json({ success: true, data: { ...sheet, items } });
  } catch (err) {
    console.error('Get stocktake sheet error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /stocktake/sheets/:id/items/:itemId — record a count
router.patch('/sheets/:id/items/:itemId', async (req, res) => {
  try {
    const { counted_quantity, notes } = req.body;
    // $3 was doing double duty as both the notes value and the item id in the
    // WHERE clause — those need different types (text vs uuid), which is
    // exactly what "COALESCE types uuid and text cannot be matched" was
    // reporting. The real notes value from the request body was never bound
    // at all. Four distinct parameters, one job each.
    const { rows: [item] } = await pool.query(
      `UPDATE stocktake_sheet_items
          SET counted_quantity = $1, status = 'COUNTED', notes = COALESCE($2, notes)
        WHERE sheet_id = $3 AND id = $4
        RETURNING *`,
      [Number(counted_quantity), notes ?? null, req.params.id, req.params.itemId]
    );
    if (!item) return res.status(404).json({ success: false, error: 'Item not found on this sheet' });

    // Mark sheet as IN_PROGRESS if it was DRAFT, and record who is doing the
    // counting — this is the identity the review step's SoD check (below)
    // refuses to also accept as the reviewer.
    await pool.query(
      `UPDATE stocktake_sheets
          SET status = CASE WHEN status = 'DRAFT' THEN 'IN_PROGRESS' ELSE status END,
              counted_by = COALESCE(counted_by, $2)
        WHERE id = $1`,
      [req.params.id, req.user.id]
    );

    res.json({ success: true, data: item });
  } catch (err) {
    console.error('Record stocktake count error:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Close counting and hand the sheet to a reviewer. Refuses while any line is
// still PENDING (uncounted) so a partial count can never be submitted for
// review by accident. Exported (like submitCreditNoteForApproval in
// routes/credit-notes.js) so tests can exercise the transition directly.
async function submitStocktakeSheet(sheetId, userId) {
  const { rows: [sheet] } = await pool.query(
    `SELECT * FROM stocktake_sheets WHERE id = $1 AND deleted_at IS NULL`, [sheetId]
  );
  if (!sheet) throw Object.assign(new Error('Sheet not found'), { status: 404 });
  if (sheet.status !== 'IN_PROGRESS') {
    throw Object.assign(new Error(`Cannot submit a sheet in status ${sheet.status}; it must be IN_PROGRESS.`), { status: 422 });
  }

  const { rows: [pending] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM stocktake_sheet_items WHERE sheet_id = $1 AND status = 'PENDING'`,
    [sheetId]
  );
  if (pending.n > 0) {
    throw Object.assign(new Error(`${pending.n} item(s) on this sheet have not been counted yet.`), { status: 422 });
  }

  const { rows: [updated] } = await pool.query(
    `UPDATE stocktake_sheets
        SET status = 'COUNTED', counted_by = COALESCE(counted_by, $2), counted_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *`,
    [sheetId, userId]
  );
  return updated;
}

// A second person signs off on the count before it can post to the GL.
// SoD-guarded at the route (below) via requireSoD + recordCreator; this
// function itself performs the status transition only, so a test can call it
// directly to exercise the transition logic and check the SoD guard
// separately (matching tests/creditNoteApproval.test.js's approach).
async function reviewStocktakeSheet(sheetId, userId) {
  const { rows: [sheet] } = await pool.query(
    `SELECT * FROM stocktake_sheets WHERE id = $1 AND deleted_at IS NULL`, [sheetId]
  );
  if (!sheet) throw Object.assign(new Error('Sheet not found'), { status: 404 });
  if (sheet.status !== 'COUNTED') {
    throw Object.assign(new Error(`Cannot review a sheet in status ${sheet.status}; it must be COUNTED first (see /submit).`), { status: 422 });
  }

  const { rows: [updated] } = await pool.query(
    `UPDATE stocktake_sheets
        SET status = 'REVIEWED', reviewed_by = $2
      WHERE id = $1
      RETURNING *`,
    [sheetId, userId]
  );
  return updated;
}

// POST /stocktake/sheets/:id/submit
router.post('/sheets/:id/submit', requireManagerOrAdmin, async (req, res) => {
  try {
    const data = await submitStocktakeSheet(req.params.id, req.user.id);
    res.json({ success: true, data });
  } catch (err) {
    console.error('Submit stocktake error:', err);
    res.status(err.status || 400).json({ success: false, error: err.message });
  }
});

// POST /stocktake/sheets/:id/review — SoD-guarded: the person who counted the
// sheet cannot also review it (middleware/recordOwner.js registers
// stocktake_sheets under counted_by for exactly this check).
router.post(
  '/sheets/:id/review',
  requireManagerOrAdmin,
  requireSoD(recordCreator('stocktake_sheets'), 'stocktake review'),
  async (req, res) => {
    try {
      const data = await reviewStocktakeSheet(req.params.id, req.user.id);
      res.json({ success: true, data });
    } catch (err) {
      console.error('Review stocktake error:', err);
      res.status(err.status || 400).json({ success: false, error: err.message });
    }
  }
);

// POST /stocktake/sheets/:id/post — finalise and post variances to GL
router.post('/sheets/:id/post', requireManagerOrAdmin, async (req, res) => {
  try {
    const data = await withDeadlockRetry(() => postStocktakeSheet(req.params.id, req.user.id));
    res.json({ success: true, data });
  } catch (err) {
    console.error('Post stocktake error:', err);
    res.status(err.status || 400).json({ success: false, error: err.message });
  }
});

async function postStocktakeSheet(sheetId, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [sheet] } = await client.query(
      'SELECT * FROM stocktake_sheets WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [sheetId]
    );
    if (!sheet) throw Object.assign(new Error('Sheet not found'), { status: 404 });
    if (sheet.status === 'POSTED') throw Object.assign(new Error('Sheet already posted'), { status: 422 });
    if (sheet.status !== 'REVIEWED') {
      throw Object.assign(
        new Error(`Cannot post a sheet in status ${sheet.status}; it must be submitted (/submit) and reviewed (/review) by a second person first.`),
        { status: 422 }
      );
    }

    const { rows: items } = await client.query(
      'SELECT * FROM stocktake_sheet_items WHERE sheet_id = $1 AND status = \'COUNTED\' AND variance <> 0',
      [sheetId]
    );

    // Same per-item serialization every other stock-mutating path in the app
    // takes: sorted advisory locks on ALL affected rows up front (not one at a
    // time mid-loop), so a stocktake post racing a concurrent GI/GR/transfer on
    // any of these items queues behind it instead of contending unprotected —
    // and two sheets with overlapping items can never take those locks in
    // different orders.
    const itemIds = items.map((i) => i.inventory_item_id).filter(Boolean);
    if (itemIds.length) await lockInventoryItemForWrite(client, itemIds);

    const FinancialPostingService = require('../services/financialPostingService');
    let postedCount = 0;

    for (const item of items) {
      const adjustmentValue = Math.round(Number(item.variance) * Number(item.unit_cost) * 100) / 100;
      if (adjustmentValue === 0) continue;

      // Post GL variance — externalClient (client) keeps this atomic with the
      // stock update and cost-layer consumption below, all in one transaction.
      // userId, not a { id } object — postStocktakeSheet receives the bare id
      // (see the /post route below); an earlier version of this function read
      // `user.id` here, which was always undefined and landed every stocktake
      // variance journal entry and cost layer with a null created_by/poster.
      await FinancialPostingService.postInventoryAdjustment({
        inventory_item_id: item.inventory_item_id,
        adjustment_quantity: Number(item.variance),
        adjustment_value: Math.abs(adjustmentValue),
        reason: `Stocktake ${sheet.sheet_number}`,
        reference: sheet.id,
      }, userId, client);

      // Update cost layers
      if (Number(item.variance) > 0) {
        await CostLayerService.createLayer({
          inventory_item_id: item.inventory_item_id,
          warehouse_transaction_id: null,
          receipt_type: 'STOCK_ADJUSTMENT',
          quantity: Number(item.variance),
          unit_cost: Number(item.unit_cost),
          created_by: userId,
        }, client);
      } else {
        await CostLayerService.consumeLayers(item.inventory_item_id, Math.abs(Number(item.variance)), client);
      }

      // Update stock quantity
      await client.query(
        `UPDATE inventory_items
            SET current_stock_quantity = current_stock_quantity + $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2`,
        [Number(item.variance), item.inventory_item_id]
      );

      // Mark item as adjusted
      await client.query(
        `UPDATE stocktake_sheet_items SET status = 'ADJUSTED' WHERE id = $1`,
        [item.id]
      );
      postedCount++;
    }

    // Mark sheet as posted. reviewed_by is already set by the /review step —
    // posting itself can be done by anyone with manager authority, including
    // the reviewer, since the SoD boundary that matters (counter != reviewer)
    // was already enforced before this point.
    await client.query(
      `UPDATE stocktake_sheets SET status = 'POSTED', posted_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [sheetId]
    );

    await client.query('COMMIT');
    return { items_posted: postedCount, status: 'POSTED' };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = router;
module.exports.submitStocktakeSheet = submitStocktakeSheet;
module.exports.reviewStocktakeSheet = reviewStocktakeSheet;
module.exports.postStocktakeSheet = postStocktakeSheet;
