/**
 * Decisions held open — the Approval Inbox's and My Work's view of the same
 * answer Simeli gives to "what is waiting on me, and what is it holding up?"
 * (services/decisionsHeldOpen.js). Read-only: each decision is made on its own
 * approve endpoint.
 */

const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const { decisionsHeldOpen } = require('../services/decisionsHeldOpen');

const KINDS = new Set(['purchase_order', 'sales_order', 'purchase_requisition', 'contract', 'escalation']);

// GET /decisions-held-open?mine=1&kind=&document=&limit=
router.get('/', auth, async (req, res) => {
  try {
    if (req.query.kind && !KINDS.has(String(req.query.kind))) {
      return res.status(400).json({ success: false, error: `kind must be one of ${[...KINDS].join(', ')}.` });
    }
    const data = await decisionsHeldOpen({
      companyId: req.companyId,
      userId: req.user?.isApiKey ? null : req.user?.id,
      role: req.user?.role,
      mine: req.query.mine === '1' || req.query.mine === 'true',
      kind: req.query.kind || null,
      document: req.query.document || null,
      limit: req.query.limit,
    });
    if (data.error) return res.status(404).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Decisions held open error:', error.message);
    res.status(500).json({ success: false, error: 'Could not read what is waiting on a decision.' });
  }
});

module.exports = router;
