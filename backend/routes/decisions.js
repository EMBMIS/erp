/**
 * Decision simulation API.
 *
 * The HTTP face of services/ai/counterfactual — one question in, a ranked table
 * of MEASURED outcomes out. Nothing here changes a business record; the whole
 * measurement happens inside a transaction that is rolled back before the
 * response is written (see counterfactual/shadowLedger.js).
 *
 * WHY POST FOR SOMETHING THAT CHANGES NOTHING
 * ---------------------------------------------------------------------------
 * A run is expensive — it holds row locks and may call a model — and it creates
 * an evidence row that is referenced by id afterwards. Making it a GET would
 * invite prefetchers, retries and caches to fire simulations nobody asked for,
 * on live rows. POST is about cost and non-idempotence here, not about writes.
 */

const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const counterfactual = require('../services/ai/counterfactual');
const companyContext = require('../services/companyContext');

async function companyFor(req) {
  return companyContext.currentCompanyId()
    || (req.user?.id ? await companyContext.primaryCompanyFor(req.user.id).catch(() => null) : null)
    || (await companyContext.getDefaultCompanyId());
}

/** What can be simulated, and what the company is optimising for. */
router.get('/capabilities', auth, async (_req, res) => {
  res.json({
    success: true,
    data: {
      scenarios: counterfactual.SCENARIOS,
      effects: counterfactual.catalogue(),
      default_objective: counterfactual.DEFAULT_OBJECTIVE,
    },
  });
});

/** The business as it stands — the vector every branch is measured against. */
router.get('/baseline', auth, async (req, res) => {
  try {
    const companyId = await companyFor(req);
    const { pool } = require('../config/database');
    const client = await pool.connect();
    try {
      res.json({ success: true, data: await counterfactual.measure(client, companyId) });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Decision baseline error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/', auth, async (req, res) => {
  try {
    const companyId = await companyFor(req);
    const runs = await counterfactual.listRuns(companyId, req.query.limit);
    res.json({ success: true, count: runs.length, data: runs });
  } catch (error) {
    console.error('List decision runs error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const companyId = await companyFor(req);
    const run = await counterfactual.getRun(req.params.id, companyId);
    if (!run) return res.status(404).json({ success: false, error: 'Decision run not found' });
    res.json({ success: true, data: run });
  } catch (error) {
    console.error('Get decision run error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Run a simulation.
 *
 * Objective weights are accepted from the client because deciding what the
 * company optimises for is the person's call, not the engine's — but they are
 * filtered to the known metric names and coerced to numbers, so a malformed or
 * hostile body cannot inject a key into the scoring loop.
 */
router.post('/simulate', auth, async (req, res) => {
  try {
    const { question, scenario, objective, horizon_days: horizonDays } = req.body || {};
    if (!question || !String(question).trim()) {
      return res.status(400).json({ success: false, error: 'A question is required' });
    }

    let weights;
    if (objective && typeof objective === 'object') {
      weights = {};
      for (const key of Object.keys(counterfactual.DEFAULT_OBJECTIVE)) {
        if (objective[key] !== undefined && Number.isFinite(Number(objective[key]))) {
          weights[key] = Number(objective[key]);
        }
      }
    }

    const companyId = await companyFor(req);
    const run = await counterfactual.decide({
      companyId,
      userId: req.user?.id && !req.user.isApiKey ? req.user.id : null,
      question: String(question).slice(0, 1000),
      scenario,
      objective: weights,
      horizonDays: Number(horizonDays) || 30,
    });

    res.json({ success: true, data: run });
  } catch (error) {
    console.error('Decision simulation error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
