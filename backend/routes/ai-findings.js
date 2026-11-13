const express = require('express');
const router = express.Router();
const { auth, requireManagerOrAdmin } = require('../middleware/auth');
const { pool } = require('../config/database');

// GET /ai-findings - list findings (default: open only)
router.get('/', auth, async (req, res) => {
  try {
    const status = req.query.status || 'OPEN';
    const params = [status];
    let where = 'WHERE status = $1';
    if (req.query.severity) { params.push(req.query.severity); where += ` AND severity = $${params.length}`; }
    if (req.query.finding_type) { params.push(req.query.finding_type); where += ` AND finding_type = $${params.length}`; }
    // One or more entity types, comma separated. Without this every module
    // overview shows every finding in the business — a stock screen listing
    // duplicate purchase orders is noise on that screen, however true it is.
    if (req.query.entity_type) {
      const types = String(req.query.entity_type).split(',').map((v) => v.trim()).filter(Boolean);
      if (types.length) {
        params.push(types);
        where += ` AND entity_type = ANY($${params.length}::text[])`;
      }
    }
    const r = await pool.query(
      `SELECT * FROM ai_findings ${where} ORDER BY severity = 'HIGH' DESC, created_at DESC LIMIT 200`,
      params
    );
    res.json({ success: true, count: r.rows.length, data: r.rows });
  } catch (error) {
    console.error('List AI findings error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /ai-findings/scan - run the scan now (manager/admin; safe to re-run, dedupes)
router.post('/scan', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const { runFindingsScan } = require('../services/ai/findingsScan');
    const result = await runFindingsScan();
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Run AI findings scan error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /ai-findings/:id - acknowledge or dismiss
router.patch('/:id', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['ACKNOWLEDGED', 'DISMISSED'].includes(status)) {
      return res.status(400).json({ success: false, error: 'status must be ACKNOWLEDGED or DISMISSED' });
    }
    if (status === 'DISMISSED') {
      // Route dismissals through the action service so the suppression window
      // is always recorded (Round 7: dismiss → records why → not re-raised).
      const { dismissFinding } = require('../services/ai/findingsActions');
      const result = await dismissFinding(req.params.id, req.user.id, req.body.reason);
      return res.json({ success: true, data: result.finding, suppression_days: result.suppression_days });
    }
    const r = await pool.query(
      `UPDATE ai_findings SET status = $1, acknowledged_by = $2, acknowledged_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *`,
      [status, req.user.id, req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, error: 'Finding not found' });
    res.json({ success: true, data: r.rows[0] });
  } catch (error) {
    console.error('Update AI finding error:', error);
    res.status(error.status || 400).json({ success: false, error: error.message });
  }
});

// POST /ai-findings/:id/approve - approve the finding's proposed DRAFT journal
// entry: posts it (the "AI proposes, humans approve" rule — the agent never
// posts; a manager's explicit approval does) and resolves the finding.
router.post('/:id/approve', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const { approveFinding } = require('../services/ai/findingsActions');
    const result = await approveFinding(req.params.id, req.user.id);
    res.json({
      success: true,
      data: result.finding,
      journal_entry: result.journal_entry,
      already_resolved: result.already_resolved,
    });
  } catch (error) {
    console.error('Approve AI finding error:', error);
    res.status(error.status || 400).json({ success: false, error: error.message });
  }
});

// POST /ai-findings/:id/dismiss - dismiss with a recorded reason, and suppress
// re-raising on the next sweep for the suppression window.
router.post('/:id/dismiss', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const { dismissFinding } = require('../services/ai/findingsActions');
    const result = await dismissFinding(req.params.id, req.user.id, req.body.reason);
    res.json({ success: true, data: result.finding, suppression_days: result.suppression_days });
  } catch (error) {
    console.error('Dismiss AI finding error:', error);
    res.status(error.status || 400).json({ success: false, error: error.message });
  }
});

module.exports = router;
