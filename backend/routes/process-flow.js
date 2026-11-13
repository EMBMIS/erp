/**
 * Which steps actually move — the Sales and Procurement screens' view of the
 * same measurement Simeli answers from (services/processFlow.js). Read-only.
 */

const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const { mapProcessFlow } = require('../services/processFlow');

// GET /process-flow?flow=order_to_cash|procure_to_pay|all&window_days=90
router.get('/', auth, async (req, res) => {
  try {
    const flow = ['order_to_cash', 'procure_to_pay', 'all'].includes(req.query.flow) ? req.query.flow : 'all';
    const data = await mapProcessFlow({
      companyId: req.companyId,
      userId: req.user?.isApiKey ? null : req.user?.id,
      role: req.user?.role,
      flow,
      windowDays: req.query.window_days,
    });
    if (data.error) return res.status(403).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Process flow error:', error.message);
    res.status(500).json({ success: false, error: 'Could not measure the process flow.' });
  }
});

module.exports = router;
