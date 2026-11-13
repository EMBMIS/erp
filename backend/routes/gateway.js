const express = require('express');
const router = express.Router();
const { auth, requireAdmin, requireManagerOrAdmin } = require('../middleware/auth');
const gateway = require('../services/gateway/client');

/**
 * EMBMIS Gateway — what Business OS shows about it.
 *
 * Nothing here talks to the gateway on behalf of the browser: the browser sees
 * this company's own record of the verdicts (gateway_decisions) and a status
 * read. The platform key and every agent key stay on the server.
 */
router.use(auth);

// GET /api/gateway/summary — the line under Simeli: "Checked by EMBMIS Gateway: N allowed, M sent to you"
router.get('/summary', async (req, res) => {
  try {
    if (!gateway.isEnabled()) return res.json({ success: true, data: { enabled: false } });
    const counts = await gateway.getCounts(req.companyId, { days: Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365) });
    res.json({ success: true, data: { enabled: true, ...counts } });
  } catch (error) {
    console.error('Gateway summary error:', error);
    res.status(500).json({ success: false, error: 'Could not read the gateway summary.' });
  }
});

// GET /api/gateway/status — Settings → AI Gateway
router.get('/status', requireManagerOrAdmin, async (req, res) => {
  try {
    const [status, counts] = await Promise.all([
      gateway.getStatus(req.companyId),
      gateway.isEnabled() ? gateway.getCounts(req.companyId, { days: 30 }) : Promise.resolve(null),
    ]);
    res.json({ success: true, data: { status, counts } });
  } catch (error) {
    console.error('Gateway status error:', error);
    res.status(500).json({ success: false, error: 'Could not read the gateway status.' });
  }
});

// GET /api/gateway/decisions
router.get('/decisions', requireManagerOrAdmin, async (req, res) => {
  try {
    const rows = await gateway.listDecisions(req.companyId, {
      limit: req.query.limit, offset: req.query.offset, decision: req.query.decision,
    });
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Gateway decisions error:', error);
    res.status(500).json({ success: false, error: 'Could not list gateway decisions.' });
  }
});

// POST /api/gateway/test — "Test connection": reach the gateway and make sure this company is registered
router.post('/test', requireAdmin, async (req, res) => {
  try {
    if (!gateway.isEnabled()) {
      return res.json({ success: true, data: { ok: false, error: 'EMBMIS_GATEWAY_URL is not set on the server, so the gateway is off.' } });
    }
    const before = await gateway.getStatus(req.companyId);
    if (!before.reachable) {
      return res.json({ success: true, data: { ok: false, error: `The gateway could not be reached: ${before.error || 'no answer'}.`, status: before } });
    }
    try {
      await gateway.provision(req.companyId);
    } catch (e) {
      return res.json({ success: true, data: { ok: false, error: e.message, status: before } });
    }
    const status = await gateway.getStatus(req.companyId);
    res.json({ success: true, data: { ok: true, status } });
  } catch (error) {
    console.error('Gateway test error:', error);
    res.status(500).json({ success: false, error: 'The connection test failed unexpectedly.' });
  }
});

module.exports = router;
