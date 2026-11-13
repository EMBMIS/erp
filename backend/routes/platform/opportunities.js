/**
 * Capability Discovery's API.
 *
 * A scan is a read over the company's own ledger plus a handful of upserts into
 * the discovery tables. It creates no application and deploys nothing, which is
 * why it is safe to expose as an endpoint at all — and why `accept` returns a
 * Studio session rather than a deployment.
 */

const express = require('express');
const router = express.Router();

const { auth } = require('../../middleware/auth');
const { handler, requireAdmin, companyOf, userOf } = require('./_shared');
const discovery = require('../../services/platform/discovery');

router.use(auth);

router.get('/', handler(async (req, res) => {
  res.json({
    success: true,
    data: await discovery.list(companyOf(req), {
      status: typeof req.query.status === 'string' ? req.query.status : null,
      limit: Number(req.query.limit) || 50,
    }),
  });
}));

router.post('/scan', requireAdmin, handler(async (req, res) => {
  res.json({ success: true, data: await discovery.scan(companyOf(req), { actorId: userOf(req) }) });
}));

router.post('/:opportunityId/dismiss', requireAdmin, handler(async (req, res) => {
  res.json({
    success: true,
    data: await discovery.setStatus({
      companyId: companyOf(req), opportunityId: req.params.opportunityId,
      status: 'dismissed', userId: userOf(req),
    }),
  });
}));

/**
 * Ask for a capability in your own words — the same path as Simeli's
 * build_in_sandbox. An administrator gets a draft design rehearsed in the
 * sandbox (deployed only from the Studio); anyone else records a request the
 * administrators are told about.
 */
router.post('/request', handler(async (req, res) => {
  const { buildInSandbox } = require('../../services/sandboxBuild');
  const result = await buildInSandbox({
    companyId: companyOf(req), userId: userOf(req), role: req.user?.role,
    requirement: req.body?.requirement, title: req.body?.title || null, channel: 'screen',
  });
  res.status(201).json({ success: true, data: result });
}));

/** Open a Studio session from an opportunity. Builds nothing by itself. */
router.post('/:opportunityId/accept', requireAdmin, handler(async (req, res) => {
  const result = await discovery.accept({
    companyId: companyOf(req), opportunityId: req.params.opportunityId, userId: userOf(req),
  });
  res.status(201).json({
    success: true,
    data: {
      opportunity: result.opportunity,
      sessionId: result.session.session.id,
      application: { appKey: result.session.application.app_key, name: result.session.application.name },
      plan: result.session.plan,
    },
  });
}));

module.exports = router;
