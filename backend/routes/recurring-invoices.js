const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { auth, requireManagerOrAdmin } = require('../middleware/auth');

// GET /recurring-invoices - list schedules
router.get('/', auth, async (req, res) => {
  try {
    const params = [];
    let where = '';
    if (req.query.status) { params.push(req.query.status); where = `WHERE ris.status = $${params.length}`; }
    const r = await pool.query(
      `SELECT ris.*, c.customer_name
       FROM recurring_invoice_schedules ris
       JOIN customers c ON ris.customer_id = c.id
       ${where} ORDER BY ris.next_run_date ASC`,
      params
    );
    res.json({ success: true, data: r.rows });
  } catch (error) {
    console.error('List recurring invoice schedules error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /recurring-invoices - create a schedule
router.post('/', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const { customer_id, sales_contract_id, description, amount, tax_amount, currency, frequency, next_run_date, max_occurrences, notes } = req.body;
    if (!customer_id || !description || !amount || !frequency || !next_run_date) {
      return res.status(400).json({ success: false, error: 'customer_id, description, amount, frequency and next_run_date are required' });
    }
    const r = await pool.query(
      `INSERT INTO recurring_invoice_schedules (customer_id, sales_contract_id, description, amount, tax_amount, currency, frequency, next_run_date, max_occurrences, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [customer_id, sales_contract_id || null, description, amount, tax_amount || 0, currency || 'USD', frequency, next_run_date, max_occurrences || null, notes || null, req.user.id]
    );
    res.status(201).json({ success: true, data: r.rows[0] });
  } catch (error) {
    console.error('Create recurring invoice schedule error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// PATCH /recurring-invoices/:id - pause/resume/cancel
router.patch('/:id', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['ACTIVE', 'PAUSED', 'CANCELLED'].includes(status)) {
      return res.status(400).json({ success: false, error: 'status must be ACTIVE, PAUSED or CANCELLED' });
    }
    const r = await pool.query(
      'UPDATE recurring_invoice_schedules SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, error: 'Schedule not found' });
    res.json({ success: true, data: r.rows[0] });
  } catch (error) {
    console.error('Update recurring invoice schedule error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /recurring-invoices/run - generate invoices for all due schedules
router.post('/run', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const { runDueSchedules } = require('../services/recurringInvoiceService');
    const result = await runDueSchedules(req.user.id, { dryRun: req.body?.dry_run === true });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Run recurring invoices error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
