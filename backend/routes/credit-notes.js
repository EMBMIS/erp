/**
 * Credit Notes & RMA — sales credit notes and supplier debit notes.
 *
 * Sales credit notes reduce AR and reverse revenue. If items are returned,
 * stock is put back into inventory and COGS is reversed through cost layers.
 * Supplier debit notes are the AP mirror.
 *
 * Both route through the existing DOA approval machinery:
 *   DRAFT → PENDING_APPROVAL → APPROVED → POSTED
 */

const express = require('express');
const router = express.Router();
const { auth, requireManagerOrAdmin } = require('../middleware/auth');
const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const CostLayerService = require('../services/costLayerService');
const { withDeadlockRetry, lockInventoryItemForWrite } = require('../services/dbRetry');
const { requireSoD } = require('../middleware/rbac');
const { recordCreator } = require('../middleware/recordOwner');

router.use(auth);

async function recordCreditNoteStatusHistory(client, { credit_note_id, from_status, to_status, changed_by, reason }) {
  await client.query(
    `INSERT INTO credit_note_status_history (credit_note_id, from_status, to_status, changed_by, reason)
     VALUES ($1,$2,$3,$4,$5)`,
    [credit_note_id, from_status, to_status, changed_by, reason || null]
  );
}

// ---------------------------------------------------------------------------
// Sales credit notes
// ---------------------------------------------------------------------------

function generateSCNNumber() {
  return `SCN-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

router.get('/sales', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM sales_credit_notes WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 100'
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/sales', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { customer_invoice_id, customer_id, reason, return_type, items, notes } = req.body;
    if (!customer_invoice_id || !customer_id || !reason) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'customer_invoice_id, customer_id, and reason are required.' });
    }

    const cnId = uuidv4();
    const cnNumber = generateSCNNumber();

    let subtotal = 0;
    if (items?.length) {
      for (const item of items) {
        subtotal += Number(item.line_total || 0) || Number(item.quantity || 0) * Number(item.unit_price || 0);
        await client.query(
          `INSERT INTO sales_credit_note_items (credit_note_id, customer_invoice_item_id, inventory_item_id,
           item_code, item_name, quantity, unit_price, line_total, return_to_stock)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [cnId, item.customer_invoice_item_id || null, item.inventory_item_id || null,
           item.item_code || null, item.item_name || '', Number(item.quantity) || 1, Number(item.unit_price) || 0,
           Number(item.line_total) || 0, !!item.return_to_stock]
        );
      }
    }

    await client.query(
      `INSERT INTO sales_credit_notes (id, credit_note_number, customer_invoice_id, customer_id, credit_date,
       reason, return_type, subtotal, tax_amount, total_amount, notes, created_by)
       VALUES ($1,$2,$3,$4,CURRENT_DATE,$5,$6,$7,$8,$9,$10,$11)`,
      [cnId, cnNumber, customer_invoice_id, customer_id, reason, return_type || 'CREDIT_ONLY',
       subtotal, 0, subtotal, notes || null, req.user.id]
    );

    await client.query('COMMIT');
    const { rows: [cn] } = await pool.query('SELECT * FROM sales_credit_notes WHERE id = $1', [cnId]);
    res.status(201).json({ success: true, data: cn });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create sales credit note error:', err);
    res.status(400).json({ success: false, error: err.message });
  } finally { client.release(); }
});

async function submitCreditNoteForApproval(cnId, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [cn] } = await client.query(
      'SELECT * FROM sales_credit_notes WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [cnId]
    );
    if (!cn) throw Object.assign(new Error('Credit note not found.'), { status: 404 });
    if (cn.status !== 'DRAFT') {
      throw Object.assign(
        new Error(`Credit note is ${cn.status}, only a DRAFT can be submitted for approval.`),
        { status: 400 }
      );
    }

    await client.query(
      "UPDATE sales_credit_notes SET status = 'PENDING_APPROVAL', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
      [cn.id]
    );
    await recordCreditNoteStatusHistory(client, {
      credit_note_id: cn.id, from_status: 'DRAFT', to_status: 'PENDING_APPROVAL',
      changed_by: userId, reason: 'Submitted for approval',
    });
    await client.query('COMMIT');

    const { rows: [updated] } = await pool.query('SELECT * FROM sales_credit_notes WHERE id = $1', [cn.id]);
    return updated;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}

async function approveCreditNote(cnId, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [cn] } = await client.query(
      'SELECT * FROM sales_credit_notes WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [cnId]
    );
    if (!cn) throw Object.assign(new Error('Credit note not found.'), { status: 404 });
    if (cn.status !== 'PENDING_APPROVAL') {
      throw Object.assign(
        new Error(`Credit note is ${cn.status}, only PENDING_APPROVAL notes can be approved.`),
        { status: 400 }
      );
    }

    await client.query(
      "UPDATE sales_credit_notes SET status = 'APPROVED', approved_by = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
      [userId, cn.id]
    );
    await recordCreditNoteStatusHistory(client, {
      credit_note_id: cn.id, from_status: 'PENDING_APPROVAL', to_status: 'APPROVED',
      changed_by: userId, reason: 'Approved',
    });
    await client.query('COMMIT');

    const { rows: [updated] } = await pool.query('SELECT * FROM sales_credit_notes WHERE id = $1', [cn.id]);
    return updated;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}

// POST /sales/:id/submit-for-approval - DRAFT -> PENDING_APPROVAL. The creator submits their own note.
router.post('/sales/:id/submit-for-approval', async (req, res) => {
  try {
    const updated = await submitCreditNoteForApproval(req.params.id, req.user.id);
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(err.status || 400).json({ success: false, error: err.message });
  }
});

// POST /sales/:id/approve - PENDING_APPROVAL -> APPROVED. SoD: cannot approve your own credit note.
router.post('/sales/:id/approve', requireManagerOrAdmin, requireSoD(recordCreator('sales_credit_notes'), 'credit note approval'), async (req, res) => {
  try {
    const updated = await approveCreditNote(req.params.id, req.user.id);
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(err.status || 400).json({ success: false, error: err.message });
  }
});

router.post('/sales/:id/post', requireManagerOrAdmin, async (req, res) => {
  try {
    const outcome = await withDeadlockRetry(() => postSalesCreditNote(req.params.id, req.user.id));
    res.json(outcome);
  } catch (err) {
    console.error('Post sales credit note error:', err);
    res.status(err.status || 400).json({ success: false, error: err.message });
  }
});

async function postSalesCreditNote(cnId, user) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [cn] } = await client.query(
      'SELECT * FROM sales_credit_notes WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [cnId]
    );
    if (!cn) throw Object.assign(new Error('Credit note not found.'), { status: 404 });
    if (cn.status === 'POSTED') { await client.query('ROLLBACK'); return { success: true, data: cn, note: 'Already posted.' }; }
    if (cn.status !== 'APPROVED') {
      await client.query('ROLLBACK');
      throw Object.assign(
        new Error(`Credit note is ${cn.status}, only an APPROVED credit note can be posted. Submit it for approval first.`),
        { status: 400 }
      );
    }

    const { rows: items } = await client.query(
      'SELECT * FROM sales_credit_note_items WHERE credit_note_id = $1', [cnId]
    );

    // Serialize with every other writer of the returned stock rows BEFORE the
    // loop takes any row lock: sorted advisory locks keyed exactly like the
    // rest of the app, so a concurrent GI/GR/transfer/stocktake on the same
    // items queues behind this post instead of forming a lock cycle.
    const returnItemIds = items
      .filter((i) => i.return_to_stock && i.inventory_item_id && Number(i.quantity) > 0)
      .map((i) => i.inventory_item_id);
    if (returnItemIds.length) await lockInventoryItemForWrite(client, returnItemIds);

    const JournalEntry = require('../models/JournalEntry');

    // Reverse the revenue: Dr Revenue (4100) / Cr AR (1120)
    const accs = await client.query(
      "SELECT id, account_code FROM chart_of_accounts WHERE account_code IN ('1120','4100','5100','1130') AND status = 'ACTIVE' AND deleted_at IS NULL"
    );
    const map = {};
    accs.rows.forEach((a) => { map[a.account_code] = a.id; });

    if (map['1120'] && map['4100']) {
      const lines = [
        { account_id: map['4100'], debit_amount: cn.total_amount, credit_amount: 0, description: `Reverse revenue — credit note ${cn.credit_note_number}` },
        { account_id: map['1120'], debit_amount: 0, credit_amount: cn.total_amount, description: `Reduce AR — credit note ${cn.credit_note_number}` },
      ];

      // externalClient (last arg) keeps the journal on THIS transaction, not a
      // detached one — a detached connection touching shared GL accounts while
      // this transaction holds the inventory row is exactly the lock cycle that
      // deadlocked under concurrency (same fix as the goods-issue COGS path).
      const entry = await JournalEntry.create({
        entry_date: cn.credit_date,
        source_type: 'SALES_CREDIT_NOTE',
        source_id: cn.id,
        description: `Sales credit note ${cn.credit_note_number} — ${cn.reason}`,
        reference: cn.credit_note_number,
        requires_approval: false,
      }, lines, user, client);
      await JournalEntry.postAsSystem(entry.id, user, 'Auto-posted credit note', client);
    }

    // Process stock returns — put items back and reverse COGS.
    for (const item of items) {
      if (item.return_to_stock && item.inventory_item_id && item.quantity > 0) {
        // Put stock back in inventory.
        await client.query(
          'UPDATE inventory_items SET current_stock_quantity = current_stock_quantity + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [Number(item.quantity), item.inventory_item_id]
        );

        // Reverse COGS: create a cost layer for the returned goods. The
        // reversal must be valued at the item's actual weighted-average layer
        // cost, not the sales unit price — returning stock at the selling price
        // overstates inventory and understates COGS reversal.
        const layerAvg = await CostLayerService.getWeightedAverageCost(item.inventory_item_id, client);
        const avgCost = layerAvg > 0 ? layerAvg : (Number(item.unit_price) || 0);
        if (avgCost > 0) {
          await CostLayerService.createLayer({
            inventory_item_id: item.inventory_item_id,
            receipt_type: 'STOCK_ADJUSTMENT',
            quantity: Number(item.quantity),
            unit_cost: avgCost,
            created_by: user,
          }, client);

          // Post COGS reversal: Dr Inventory (1130) / Cr COGS (5100)
          const cogValue = Math.round(avgCost * Number(item.quantity) * 100) / 100;
          if (map['1130'] && map['5100'] && cogValue > 0) {
            const cogEntry = await JournalEntry.create({
              entry_date: cn.credit_date,
              source_type: 'SALES_CREDIT_NOTE',
              source_id: cn.id,
              description: `Reverse COGS — return on ${cn.credit_note_number}`,
              reference: cn.credit_note_number,
              requires_approval: false,
            }, [
              { account_id: map['1130'], debit_amount: cogValue, credit_amount: 0, description: 'Return to inventory' },
              { account_id: map['5100'], debit_amount: 0, credit_amount: cogValue, description: 'Reverse COGS' },
            ], user, client);
            await JournalEntry.postAsSystem(cogEntry.id, user, 'Auto-posted COGS reversal', client);
          }
        }
      }
    }

    await client.query(
      "UPDATE sales_credit_notes SET status = 'POSTED', posted_by = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
      [user, cnId]
    );

    // Append transaction-atomic audit record for Credit Note
    const { auditStatusTransition } = require('../services/auditHook');
    await auditStatusTransition({
      client,
      entityType: 'CREDIT_NOTE',
      entityId: cnId,
      fromStatus: cn.status,
      toStatus: 'POSTED',
      actorId: user,
      reason: `Sales credit note ${cn.credit_note_number} posted`
    });

    // Update the customer invoice outstanding amount and reduce the customer's
    // credit exposure by the same amount — a posted credit note is a reduction
    // in what they owe, so current_balance must drop with it.
    // outstanding_amount is GENERATED ALWAYS AS (total_amount - paid_amount)
    // (migration 065), so it cannot be assigned — the old UPDATE raised 428C9
    // and rolled the posting back. Settling the credit against paid_amount is
    // the same arithmetic through the column that actually drives it, clamped
    // at the invoice total so outstanding can never go negative.
    await client.query(
      `UPDATE customer_invoices
          SET paid_amount = LEAST(total_amount, paid_amount + $1),
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $2`,
      [cn.total_amount, cn.customer_invoice_id]
    );
    await client.query(
      `UPDATE customers SET current_balance = GREATEST(0, current_balance - $1), updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [cn.total_amount, cn.customer_id]
    );

    await client.query('COMMIT');
    return { success: true, data: { ...cn, status: 'POSTED' }, message: 'Credit note posted — revenue reversed and inventory updated.' };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}

// ---------------------------------------------------------------------------
// Supplier debit notes (mirror of sales credit notes for AP side)
// ---------------------------------------------------------------------------

router.get('/supplier', requireManagerOrAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM supplier_debit_notes WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 100'
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
module.exports.postSalesCreditNote = postSalesCreditNote;
module.exports.submitCreditNoteForApproval = submitCreditNoteForApproval;
module.exports.approveCreditNote = approveCreditNote;
