/**
 * CRM Leads — pipeline feeding into sales quotations.
 * The existing AI lead-scoring endpoint now has an entity to score.
 */

const express = require('express');
const router = express.Router();
const { auth, requireManagerOrAdmin } = require('../middleware/auth');
const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

router.use(auth);

function leadNumber() {
  return `LEAD-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

router.get('/', async (req, res) => {
  try {
    const { status, assigned_to, search } = req.query;
    let q = 'SELECT * FROM leads WHERE deleted_at IS NULL';
    const p = [];
    if (status) { p.push(status); q += ` AND status = $${p.length}`; }
    if (assigned_to) { p.push(assigned_to); q += ` AND assigned_to = $${p.length}`; }
    if (search) { p.push(`%${search}%`); q += ` AND (company_name ILIKE $${p.length} OR contact_name ILIKE $${p.length})`; }
    q += ' ORDER BY created_at DESC LIMIT 200';
    const { rows } = await pool.query(q, p);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { company_name, contact_name, email, phone, source, potential_value, notes, assigned_to } = req.body;
    if (!contact_name) return res.status(400).json({ success: false, error: 'contact_name is required.' });

    const id = uuidv4();
    await pool.query(
      `INSERT INTO leads (id, lead_number, company_name, contact_name, email, phone, source, potential_value, notes, assigned_to, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, leadNumber(), company_name || null, contact_name, email || null, phone || null,
       source || null, Number(potential_value) || null, notes || null, assigned_to || null, req.user.id]
    );
    const { rows: [lead] } = await pool.query('SELECT * FROM leads WHERE id = $1', [id]);
    res.status(201).json({ success: true, data: lead });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const allowed = ['status', 'assigned_to', 'potential_value', 'notes', 'next_follow_up', 'ai_score'];
    const sets = []; const vals = [];
    for (const k of allowed) {
      if (req.body[k] !== undefined) { vals.push(req.body[k]); sets.push(`${k} = $${vals.length}`); }
    }
    if (!sets.length) return res.status(400).json({ success: false, error: 'No valid fields to update.' });
    vals.push(req.user.id); vals.push(req.params.id);
    const { rows: [lead] } = await pool.query(
      `UPDATE leads SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP, updated_by = $${vals.length - 1} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    if (!lead) return res.status(404).json({ success: false, error: 'Lead not found.' });

    // Auto re-score on every update EXCEPT one that explicitly set ai_score
    // itself — otherwise a caller's explicit score would be silently
    // overwritten by the very next PATCH.
    if (req.body.ai_score === undefined) {
      const { scoreLead } = require('../services/crm/leadScoring');
      try {
        const rescored = await scoreLead(lead.id);
        return res.json({ success: true, data: rescored.lead });
      } catch (scoreErr) {
        console.error('Auto re-score failed for lead', lead.id, scoreErr.message);
        // The update itself succeeded — a scoring failure should not turn
        // that into an error response.
      }
    }

    res.json({ success: true, data: lead });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /leads/:id/score - Compute and persist this lead's AI score.
router.post('/:id/score', async (req, res) => {
  try {
    const { scoreLead } = require('../services/crm/leadScoring');
    const result = await scoreLead(req.params.id);
    res.json({ success: true, data: result.lead, score: result.score, breakdown: result.breakdown, activity_count: result.activity_count });
  } catch (err) {
    const status = err.message === 'Lead not found.' ? 404 : 400;
    res.status(status).json({ success: false, error: err.message });
  }
});

// Convert a lead to a customer + a linked deal (opportunity) + optionally a quotation.
//
// This is the lead -> deal -> quotation chain the CRM audit found missing:
// converting a lead used to create a customer and stop — deals.lead_id and
// deals.quotation_id (migration 202608140200) plus leads.converted_to_quotation_id
// (previously dead, per the audit) now actually get written.
router.post('/:id/convert', requireManagerOrAdmin, async (req, res) => {
  const client = await pool.connect();
  let quotationInput = null;
  try {
    await client.query('BEGIN');
    const { rows: [lead] } = await client.query('SELECT * FROM leads WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!lead) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Lead not found.' }); }

    // Create customer from lead. customer_code is NOT NULL with no default
    // (confirmed via information_schema — no trigger backfills it either),
    // so this insert 500'd on every single conversion until this generated
    // one, the same MAX+1-per-prefix approach Customer.generateCustomerCode
    // uses for the normal customer-creation path.
    const custId = uuidv4();
    const lastCode = await client.query(
      "SELECT customer_code FROM customers WHERE customer_code ~ '^CUST-[0-9]+$' ORDER BY customer_code DESC LIMIT 1"
    );
    const nextNumber = lastCode.rows.length
      ? parseInt(lastCode.rows[0].customer_code.split('-')[1], 10) + 1
      : 1;
    const customerCode = `CUST-${String(nextNumber).padStart(4, '0')}`;
    const customerName = lead.company_name || lead.contact_name;

    await client.query(
      `INSERT INTO customers (id, customer_code, customer_name, primary_email, phone, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [custId, customerCode, customerName, lead.email, lead.phone, req.user.id]
    );

    // The opportunity behind the lead becomes a real deal, already WON —
    // Deals.create defaults to NEW, so move it explicitly, which also gives
    // it a proper deal_stage_history trail and sets closed_at.
    const dealRow = await client.query(
      `INSERT INTO deals (deal_number, title, customer_id, lead_id, value, stage, probability, owner_id, source, created_by)
       VALUES (generate_deal_number(), $1, $2, $3, $4, 'NEW', 10, $5, $6, $7) RETURNING id`,
      [`${customerName} — converted from lead`, custId, lead.id, Number(lead.potential_value) || 0,
       lead.assigned_to || req.user.id, lead.source || null, req.user.id]
    );
    const dealId = dealRow.rows[0].id;
    await client.query(
      `UPDATE deals SET stage = 'WON', probability = 100, closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [dealId]
    );
    await client.query(
      `INSERT INTO deal_stage_history (deal_id, from_stage, to_stage, changed_by, reason)
       VALUES ($1, 'NEW', 'WON', $2, 'Lead converted')`,
      [dealId, req.user.id]
    );

    let quotationId = null;
    // Quotation creation goes through SalesQuotation.create, which manages its
    // own transaction — it cannot be folded into this one without changing a
    // model used across the Sales module. It runs after this transaction
    // commits; if it fails, the lead/customer/deal conversion still stands
    // (that is the real, load-bearing part of "won") and the error is
    // reported back rather than silently swallowed.
    if (req.body.create_quotation !== false) {
      quotationInput = {
        customer_id: custId,
        customer_name: customerName,
        reference_number: lead.lead_number,
        notes: `Created from converted lead ${lead.lead_number}.`,
        items: Number(lead.potential_value) > 0 ? [{
          item_name: 'Opportunity value (from lead)',
          quantity: 1,
          unit_of_measure: 'EA',
          unit_price: Number(lead.potential_value),
          line_total: Number(lead.potential_value),
        }] : [],
        subtotal: Number(lead.potential_value) || 0,
        total_amount: Number(lead.potential_value) || 0,
      };
    }

    await client.query(
      'UPDATE leads SET status = \'WON\', converted_to_customer_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [custId, req.params.id]
    );

    await client.query('COMMIT');

    if (quotationInput) {
      try {
        const SalesQuotation = require('../models/SalesQuotation');
        const quotation = await SalesQuotation.create(quotationInput, req.user.id);
        quotationId = quotation.id;
        await pool.query('UPDATE deals SET quotation_id = $1 WHERE id = $2', [quotationId, dealId]);
        await pool.query('UPDATE leads SET converted_to_quotation_id = $1 WHERE id = $2', [quotationId, req.params.id]);
      } catch (quoteErr) {
        console.error('Lead conversion: quotation creation failed (customer/deal already committed):', quoteErr.message);
        return res.json({
          success: true,
          data: { lead_id: req.params.id, customer_id: custId, deal_id: dealId, status: 'WON' },
          warning: `Customer and deal were created, but the quotation could not be: ${quoteErr.message}`,
        });
      }
    }

    res.json({ success: true, data: { lead_id: req.params.id, customer_id: custId, deal_id: dealId, quotation_id: quotationId, status: 'WON' } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ success: false, error: err.message });
  } finally { client.release(); }
});

module.exports = router;
