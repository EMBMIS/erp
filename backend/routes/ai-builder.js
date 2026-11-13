/**
 * Drafting endpoints for the agent and tool builders.
 *
 * These turn a sentence into a draft configuration. They create nothing and
 * grant nothing — the draft comes back to the browser, a person reads it, and
 * the existing POST /agents/blueprints or POST /ai-tools does the actual save
 * with its own validation and its own permission check.
 *
 * Gated to manager/admin all the same. Not because a draft is dangerous, but
 * because generating one costs a model call and reads the database schema, and
 * there is no reason to offer either to someone who could not save the result.
 */

const express = require('express');
const router = express.Router();
const { auth, requireManagerOrAdmin } = require('../middleware/auth');
const builder = require('../services/ai/builderGeneration');

router.use(auth);

const handle = (fn) => async (req, res) => {
  try {
    const result = await fn(req, res);
    if (!res.headersSent) res.json({ success: true, ...result });
  } catch (error) {
    console.error(`AI builder route error (${req.method} ${req.path}):`, error.message);
    if (!res.headersSent) res.status(400).json({ success: false, error: error.message });
  }
};

// POST /api/ai/generate-agent { description }
router.post('/generate-agent', requireManagerOrAdmin, handle(async (req) => ({
  data: await builder.generateAgent({
    description: req.body?.description,
    role: req.user.role,
  }),
})));

// POST /api/ai/generate-tool { description }
router.post('/generate-tool', requireManagerOrAdmin, handle(async (req) => ({
  data: await builder.generateTool({
    description: req.body?.description,
    userId: req.user.id,
    role: req.user.role,
  }),
})));

module.exports = router;
