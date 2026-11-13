/**
 * What the business runs on — the Production and Warehouse screens' view of the
 * same answer Simeli gives (services/runsOn.js): lines, sites, systems and
 * equipment, the orders behind each, single points of failure, and what stops
 * if one of them is out for N days. Read-only; the what-if is never written.
 */

const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const { mapRunsOn, whatIfDown } = require('../services/runsOn');

const KINDS = new Set(['work_center', 'site', 'supplier', 'gateway', 'ai_provider', 'connector', 'mcp', 'webhook', 'scheduler']);

// GET /runs-on — the map, ranked by what would hurt most.
router.get('/', auth, async (req, res) => {
  try {
    const data = await mapRunsOn({ companyId: req.companyId, userId: req.user?.isApiKey ? null : req.user?.id, role: req.user?.role });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Runs-on map error:', error.message);
    res.status(500).json({ success: false, error: 'Could not map what the business runs on.' });
  }
});

// GET /runs-on/what-if?kind=work_center|site|supplier|<system>&ref=&days=
router.get('/what-if', auth, async (req, res) => {
  try {
    if (!req.query.ref && !req.query.kind) return res.status(400).json({ success: false, error: 'ref is required.' });
    if (req.query.kind && !KINDS.has(String(req.query.kind))) return res.status(400).json({ success: false, error: 'Unknown kind.' });
    const data = await whatIfDown({
      companyId: req.companyId,
      userId: req.user?.isApiKey ? null : req.user?.id,
      role: req.user?.role,
      kind: req.query.kind || null,
      ref: req.query.ref || null,
      days: req.query.days,
    });
    if (data.error) return res.status(404).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Runs-on what-if error:', error.message);
    res.status(500).json({ success: false, error: 'Could not work out what stops.' });
  }
});

module.exports = router;
