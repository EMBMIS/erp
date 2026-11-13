/**
 * Autonomous agent control plane.
 *
 * Everything that changes what an agent may do unattended is manager/admin
 * gated. Enabling an agent, or raising its mode from observe to act, is the
 * moment autonomy is granted — that is an administrative decision, not an
 * ordinary user action.
 *
 * Run history and escalations are readable by any authenticated user: the point
 * of the audit trail is that people can see what the agents have been doing.
 */

const express = require('express');
const router = express.Router();
const { auth, requireManagerOrAdmin } = require('../middleware/auth');
const agents = require('../services/agents');
const { agentTrackRecord, grantEarnedAuthority } = require('../services/agentTrackRecord');

const handle = (fn) => async (req, res) => {
  try {
    const result = await fn(req, res);
    if (!res.headersSent) res.json({ success: true, ...result });
  } catch (error) {
    console.error(`Agent route error (${req.method} ${req.path}):`, error.message);
    if (!res.headersSent) res.status(400).json({ success: false, error: error.message });
  }
};

// --- Inventory of agents ----------------------------------------------------

// GET /agents — every registered agent with its current authority
router.get('/', auth, handle(async () => ({ data: await agents.listAgents() })));

// POST /agents/sync — re-sync code-defined agents into the database
router.post('/sync', auth, requireManagerOrAdmin, handle(async () => ({
  data: await agents.syncDefinitions(),
})));

// --- Track record: authority granted from measured outcomes ----------------

// GET /agents/track-record?agent_key=&days=90 — what each agent's work came to and what it has earned
router.get('/track-record', auth, async (req, res) => {
  try {
    const data = await agentTrackRecord({
      companyId: req.companyId, role: req.user?.role, agentKey: req.query.agent_key || null, days: req.query.days,
    });
    if (data.error) return res.status(404).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Agent track record error:', error.message);
    res.status(500).json({ success: false, error: 'Could not measure the agents\' track record.' });
  }
});

// POST /agents/track-record/grant { proposal_id } — a manager or admin confirms one proposal.
router.post('/track-record/grant', auth, async (req, res) => {
  try {
    if (req.user?.isApiKey) return res.status(403).json({ success: false, error: 'A person confirms this.' });
    const out = await grantEarnedAuthority({
      companyId: req.companyId, userId: req.user?.id, role: req.user?.role, proposalId: req.body?.proposal_id,
    });
    if (out.error) return res.status(out.status || 400).json({ success: false, error: out.error });
    res.json({ success: true, data: out, message: out.done });
  } catch (error) {
    console.error('Agent authority grant error:', error.message);
    res.status(500).json({ success: false, error: 'Could not change the agent\'s authority.' });
  }
});

// --- Configuration (this is what grants autonomy) ---------------------------

// PUT /agents/:key/config { enabled, mode, schedule_seconds, authority, config }
router.put('/:key/config', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await agents.configureAgent(req.params.key, req.body),
  note:
    req.body.mode === 'act'
      ? 'This agent can now take real actions unattended, within its authority limits. Anything above them is escalated.'
      : undefined,
})));

// --- Execution --------------------------------------------------------------

// POST /agents/:key/run { dry_run, mode }
// dry_run defaults to TRUE: triggering a run by hand should show what would
// happen unless the caller explicitly asks for it to act.
router.post('/:key/run', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await agents.runAgent(req.params.key, {
    trigger: 'manual',
    triggeredBy: req.user.id,
    dryRun: req.body.dry_run !== false,
    modeOverride: req.body.mode || null,
    force: true,
  }),
})));

// --- History ----------------------------------------------------------------

router.get('/runs', auth, handle(async (req) => ({
  data: await agents.listRuns({ agentKey: req.query.agent_key, limit: parseInt(req.query.limit, 10) || 50 }),
})));

router.get('/runs/:id', auth, handle(async (req) => {
  const run = await agents.getRun(req.params.id);
  if (!run) throw new Error('Run not found.');
  return { data: run };
}));

// --- Escalations ------------------------------------------------------------

router.get('/escalations', auth, handle(async (req) => ({
  data: await agents.listEscalations({
    status: req.query.status || 'OPEN',
    limit: parseInt(req.query.limit, 10) || 100,
  }),
})));

// POST /agents/escalations/:id/resolve { decision: approve|reject, note }
router.post('/escalations/:id/resolve', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await agents.resolveEscalation(
    req.params.id,
    req.user.id,
    req.body.decision === 'approve' ? 'approve' : 'reject',
    req.body.note || ''
  ),
})));

// --- User-built agents (blueprints) -----------------------------------------
//
// Authoring an agent is manager/admin, like configuring one: a blueprint is a
// standing instruction that will later run without a person present. Note that
// creating one grants nothing — the definition it syncs is created disabled, in
// observe mode. Autonomy is still granted by the config endpoint above.

router.get('/blueprints', auth, handle(async () => ({
  data: await agents.blueprints.listBlueprints(),
})));

router.get('/blueprints/:key', auth, handle(async (req) => {
  const blueprint = await agents.blueprints.getBlueprint(req.params.key);
  if (!blueprint) throw new Error('Agent not found.');
  return { data: blueprint, gaps: await agents.blueprints.authorityGaps(blueprint) };
}));

router.post('/blueprints', auth, requireManagerOrAdmin, handle(async (req) => {
  const created = await agents.blueprints.createBlueprint(req.body, req.user.id);
  return {
    data: created,
    note: 'Created disabled, in observe mode. Enable it and choose a mode to let it run.',
  };
}));

router.put('/blueprints/:key', auth, requireManagerOrAdmin, handle(async (req) => {
  const updated = await agents.blueprints.updateBlueprint(req.params.key, req.body, req.user.id);
  return {
    data: updated.blueprint,
    gaps: updated.gaps,
    // Adding a step that acts does not widen an existing agent's authority —
    // saying so here is what keeps that from looking like a bug later.
    note: updated.gaps.missing_actions.length
      ? `This agent is not yet authorised to perform: ${updated.gaps.missing_actions.join(', ')}. Grant those actions in its authority settings, or it will escalate them instead.`
      : undefined,
  };
}));

router.put('/blueprints/:key/config', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await agents.blueprints.updateConfig(req.params.key, req.body.config || req.body, req.user.id),
})));

router.delete('/blueprints/:key', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await agents.blueprints.deleteBlueprint(req.params.key),
})));

router.get('/blueprints/:key/versions', auth, handle(async (req) => ({
  data: await agents.blueprints.listVersions(req.params.key),
})));

router.post('/blueprints/:key/rollback', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await agents.blueprints.rollbackBlueprint(req.params.key, req.body.version, req.user.id),
})));

router.get('/blueprints/:key/export', auth, handle(async (req) => {
  const blueprint = await agents.blueprints.getBlueprint(req.params.key);
  if (!blueprint) throw new Error('Agent not found.');
  return { data: agents.blueprints.exportBlueprint(blueprint) };
}));

router.post('/blueprints/import', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await agents.blueprints.importBlueprint(req.body, req.user.id),
  note: 'Imported disabled, in observe mode. Review its steps before enabling it.',
})));

// --- Reasoning transcript ---------------------------------------------------
//
// What the agent thought, as opposed to what it did (which is /runs/:id).
// Readable by any authenticated user for the same reason the action trail is:
// an autonomous agent that sends email and drafts credit notes has to be
// answerable, and an audit trail only management can read is a weaker one.

router.get('/runs/:id/transcript', auth, handle(async (req) => ({
  data: await require('../services/agents/aiAgentRunner').runTranscript(req.params.id),
})));

// --- Agent memory -----------------------------------------------------------
//
// What an agent has learned between runs. Editable by managers because a wrong
// memory is a wrong belief the agent will keep acting on until someone removes
// it — that has to be fixable without a database console.

router.get('/blueprints/:key/memory', auth, handle(async (req) => ({
  data: await require('../services/agents/aiAgentRunner').listMemory(req.params.key),
})));

router.delete('/blueprints/:key/memory/:memoryKey', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await require('../services/agents/aiAgentRunner').deleteMemory(req.params.key, req.params.memoryKey),
})));

// --- Event triggers ---------------------------------------------------------

// POST /agents/events/:key { payload, dry_run }
// Fires every enabled agent listening for this event.
router.post('/events/:key', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await agents.emitAgentEvent(req.params.key, req.body.payload || {}, {
    triggeredBy: req.user.id,
    dryRun: req.body.dry_run === true,
  }),
})));

router.get('/events/:key/listeners', auth, handle(async (req) => ({
  data: await agents.listeners(req.params.key),
})));

// --- Scheduler --------------------------------------------------------------

router.get('/scheduler/status', auth, handle(async () => ({ data: agents.schedulerStatus() })));

// POST /agents/scheduler/tick — run one dispatch cycle now
router.post('/scheduler/tick', auth, requireManagerOrAdmin, handle(async () => ({
  data: await agents.tick(),
})));

module.exports = router;
