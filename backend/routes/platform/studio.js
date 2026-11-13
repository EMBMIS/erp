/**
 * The Capability Studio API: describe an application, watch it get designed,
 * change it, validate it, preview it, deploy it.
 *
 * Every route here is administrator-only. Designing an application decides what
 * data exists, who can see it and what leaves the company; that is not a
 * permission a specification can grant, so it sits with the platform role.
 */

const express = require('express');
const router = express.Router();

const { auth } = require('../../middleware/auth');
const { handler, requireAdmin, companyOf, userOf } = require('./_shared');
const session = require('../../services/platform/studio/session');
const registry = require('../../services/platform/registry');
const studioContext = require('../../services/platform/studio/context');
const { isAIEnabled, getProviderInfo } = require('../../config/aiConfig');
const canonical = require('../../services/platform/spec/canonical');
const companyContext = require('../../services/companyContext');
const { supplierRiskMeasures } = require('../../services/supplierRisk');
const { warehouseTwinMeasures } = require('../../services/warehouseTwin');

router.use(auth, requireAdmin);

/** What the Studio knows before it designs anything. */
router.get('/context', handler(async (req, res) => {
  const context = await studioContext.gather(companyOf(req));
  res.json({
    success: true,
    data: {
      ...context,
      designer: {
        // Told plainly, because it changes what the user should expect: a
        // model-designed application is bespoke, a rules-designed one is a
        // sound starting point they will want to iterate on.
        modelAvailable: isAIEnabled(),
        provider: isAIEnabled() ? getProviderInfo().provider : null,
        fallback: 'Deterministic process analyser. Produces a working application; less bespoke than a model would.',
      },
    },
  });
}));

router.get('/sessions', handler(async (req, res) => {
  res.json({ success: true, data: await session.listSessions(companyOf(req), Number(req.query.limit) || 50) });
}));

/** Start a session: requirement in, plan and draft version out. Deploys nothing. */
router.post('/sessions', handler(async (req, res) => {
  const result = await session.start({
    companyId: companyOf(req),
    userId: userOf(req),
    requirement: req.body?.requirement,
    title: req.body?.title || null,
  });
  res.status(201).json({
    success: true,
    data: {
      sessionId: result.session.id,
      application: {
        id: result.application.id, appKey: result.application.app_key, name: result.application.name,
      },
      version: { id: result.version.id, number: result.version.version },
      plan: result.plan,
      spec: result.spec,
      validation: result.validation,
      source: result.source,
      modelError: result.modelError,
    },
  });
}));

/**
 * The same design, streamed.
 *
 * ===========================================================================
 * WHY A SECOND ROUTE RATHER THAN A FLAG
 * ===========================================================================
 * `POST /sessions` returns one JSON body and callers (tests, scripts, the API)
 * depend on that. This route does exactly the same work and produces exactly
 * the same final payload, but writes the build's steps out as they happen so
 * the Studio can show them. If the stream dies the build still finishes and the
 * session is still there to open — the events are commentary on work that is
 * happening anyway, not the mechanism by which it happens.
 *
 * Server-sent events over POST: the requirement is too long for a query string
 * and EventSource cannot send an Authorization header, so the browser reads
 * this with fetch() and a stream reader instead.
 */
function streamed(run) {
  return async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx buffers proxied responses by default, which would hold every
      // event until the work finished and defeat the entire point of this.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    let open = true;
    const send = (event) => {
      if (!open) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    // Proxies close a connection that has been silent for too long, and a model
    // can think for longer than that without producing a step.
    const heartbeat = setInterval(() => { if (open) res.write(': keep-alive\n\n'); }, 15000);
    req.on('close', () => { open = false; clearInterval(heartbeat); });

    try {
      send({ type: 'done', data: await run(req, (step) => send({ type: 'step', ...step })) });
    } catch (error) {
      // The stream has already committed to a 200, so a failure is an event
      // rather than a status. The client checks the event type, not the status.
      const known = KNOWN_STREAM_ERRORS.has(error?.name);
      if (!known) console.error('[platform] studio stream', req.originalUrl, error);
      send({
        type: 'error',
        error: known ? error.message : 'Something went wrong.',
        code: error?.code || 'INTERNAL_ERROR',
        detail: known ? error.detail || null : null,
      });
    } finally {
      clearInterval(heartbeat);
      if (open) res.end();
    }
  };
}

const KNOWN_STREAM_ERRORS = new Set(['SessionError', 'RegistryError', 'IterationError', 'ValidationError']);

router.post('/sessions/stream', streamed(async (req, onProgress) => {
  const result = await session.start({
    companyId: companyOf(req),
    userId: userOf(req),
    requirement: req.body?.requirement,
    title: req.body?.title || null,
    onProgress,
  });
  return {
    sessionId: result.session.id,
    application: {
      id: result.application.id, appKey: result.application.app_key, name: result.application.name,
    },
    version: { id: result.version.id, number: result.version.version },
    plan: result.plan,
    spec: result.spec,
    validation: result.validation,
    source: result.source,
    modelError: result.modelError,
  };
}));

/** The same iteration as the route below, reported step by step. */
router.post('/sessions/:sessionId/iterate/stream', streamed(async (req, onProgress) => {
  const result = await session.iterate({
    companyId: companyOf(req),
    sessionId: req.params.sessionId,
    userId: userOf(req),
    instruction: req.body?.instruction,
    onProgress,
  });
  return result.noChange
    ? { noChange: true, note: result.note, spec: result.spec }
    : {
      version: { id: result.version.id, number: result.version.version },
      spec: result.spec,
      applied: result.applied,
      operations: result.operations,
      diff: result.diff,
      source: result.source,
    };
}));

router.get('/sessions/:sessionId', handler(async (req, res) => {
  const companyId = companyOf(req);
  const found = await session.getSession(companyId, req.params.sessionId);
  const [messages, version] = await Promise.all([
    session.messages(companyId, req.params.sessionId),
    found.application_id ? registry.latestVersion(found.application_id) : null,
  ]);
  const application = found.application_id ? await registry.getApplication(found.application_id) : null;
  const instance = application ? await registry.getInstance(application.id, companyId) : null;

  res.json({
    success: true,
    data: {
      session: found,
      messages,
      application: application ? {
        id: application.id, appKey: application.app_key, name: application.name, icon: application.icon,
      } : null,
      version: version ? { id: version.id, number: version.version, status: version.status } : null,
      spec: version?.spec || null,
      deployed: instance?.status === 'active',
      deployedVersionId: instance?.version_id || null,
    },
  });
}));

/** Change the application in natural language. Produces a new version. */
router.post('/sessions/:sessionId/iterate', handler(async (req, res) => {
  const result = await session.iterate({
    companyId: companyOf(req),
    sessionId: req.params.sessionId,
    userId: userOf(req),
    instruction: req.body?.instruction,
  });
  res.json({
    success: true,
    data: result.noChange
      ? { noChange: true, note: result.note, spec: result.spec }
      : {
        version: { id: result.version.id, number: result.version.version },
        spec: result.spec,
        applied: result.applied,
        operations: result.operations,
        diff: result.diff,
        source: result.source,
      },
  });
}));

router.post('/sessions/:sessionId/validate', handler(async (req, res) => {
  const { version, report } = await session.validate({
    companyId: companyOf(req), sessionId: req.params.sessionId,
  });
  res.json({ success: true, data: { version: { id: version.id, number: version.version }, report } });
}));

/**
 * The application rendered with synthetic data. Reads no company records —
 * except the live measures a live_monitor block shows, which are the point of
 * such a block: the person building it sees their own suppliers in it before
 * it deploys (their own suppliers, their own warehouse). Read-only, this company only, internal pages only (the validator
 * refuses a live monitor on a portal).
 */
router.get('/sessions/:sessionId/preview', handler(async (req, res) => {
  const result = await session.preview({ companyId: companyOf(req), sessionId: req.params.sessionId });
  const wanted = new Set();
  (result.spec?.ui?.pages || []).forEach((p) => (p.layout || []).forEach((b) => {
    if (b.type === 'live_monitor' && b.canonical && canonical.live(b.canonical)) wanted.add(b.canonical);
  }));
  if (wanted.size) {
    const live = {};
    const PREVIEW_PROVIDERS = { supplier_risk: supplierRiskMeasures, warehouse_twin: warehouseTwinMeasures };
    for (const key of wanted) {
      const provider = PREVIEW_PROVIDERS[canonical.live(key).provider];
      if (!provider) continue;
      try {
        const m = await companyContext.runWithCompany(companyOf(req), () => provider({
          companyId: companyOf(req), userId: userOf(req), role: req.user?.role,
        }));
        const def = canonical.live(key);
        live[key] = {
          entity: key, label: def.label,
          columns: Object.entries(def.columns).map(([name, c]) => ({ name, label: c.label, type: c.type })),
          rows: m.rows, summary: m.summary, currency: m.currency, view: def.view || null,
          ...(def.view && m[def.view] ? { [def.view]: m[def.view] } : {}),
          as_of: new Date().toISOString(),
        };
      } catch (e) {
        live[key] = null;
      }
    }
    result.live = live;
    if (result.preview && typeof result.preview === 'object') result.preview.live = live;
  }
  res.json({ success: true, data: result });
}));

/**
 * Deploy. Returns `awaiting_approval` rather than deploying when the plan is
 * not trivially safe — the caller then approves the specific plan.
 */
router.post('/sessions/:sessionId/deploy', handler(async (req, res) => {
  const result = await session.deploy({
    companyId: companyOf(req),
    sessionId: req.params.sessionId,
    userId: userOf(req),
    acknowledge: Array.isArray(req.body?.acknowledge) ? req.body.acknowledge : null,
  });
  res.json({ success: true, data: result });
}));

router.post('/sessions/:sessionId/rollback', handler(async (req, res) => {
  const result = await session.rollback({
    companyId: companyOf(req),
    sessionId: req.params.sessionId,
    userId: userOf(req),
    versionId: req.body?.versionId,
    acknowledge: Array.isArray(req.body?.acknowledge) ? req.body.acknowledge : null,
  });
  res.json({ success: true, data: result });
}));

module.exports = router;
