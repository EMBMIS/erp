/**
 * Autonomous agent runtime.
 *
 * Executes an agent unattended: monitor → decide → act, with every step written
 * durably to agent_runs / agent_run_actions so the run is answerable afterwards.
 *
 * An agent is a plain object (see services/agents/definitions/):
 *
 *   {
 *     key, displayName, description, domain,
 *     defaultMode, defaultSchedule, defaultAuthority, defaultConfig,
 *     async detect(ctx) -> [observation]      // pure reads, no side effects
 *     async act(observation, ctx) -> outcome  // performs ONE action
 *   }
 *
 * `detect` is deliberately separated from `act`. Detection must be free of side
 * effects so a dry run genuinely shows what would happen, and so the authority
 * check sits between deciding and doing rather than inside it.
 *
 * Guarantees the runtime provides, so individual agents need not re-implement:
 *   • Every action is authority-checked (services/agents/authority.js) before it
 *     runs. An agent cannot act outside its envelope even if its own code tries.
 *   • One failing observation does not abort the run — errors are recorded per
 *     action and the agent continues. A single malformed invoice should not stop
 *     the other 200 from being collected.
 *   • Concurrency: a Postgres advisory lock keyed on the agent means the same
 *     agent never runs twice at once, even across processes. This matters
 *     because these agents send email and move money.
 *   • Repeated failure disables the agent rather than letting a broken one run
 *     on a schedule forever.
 */

const { pool } = require('../../config/database');
const authority = require('./authority');

const MAX_CONSECUTIVE_FAILURES = 5;

// ---------------------------------------------------------------------------
// Registry of agent implementations, keyed by agent_key.
// ---------------------------------------------------------------------------
const implementations = new Map();

function register(agent) {
  if (!agent?.key) throw new Error('An agent must have a key.');
  if (typeof agent.detect !== 'function') throw new Error(`Agent ${agent.key} must implement detect().`);
  implementations.set(agent.key, agent);
  return agent;
}

function getImplementation(key) {
  return implementations.get(key);
}

function listImplementations() {
  return [...implementations.values()];
}

/**
 * The implementation to run for an agent key.
 *
 * Code-defined agents win: a blueprint cannot shadow one (blueprintStore
 * refuses the key at save time), so this ordering is a statement of intent
 * rather than a tie-break. If there is no code implementation, a user-authored
 * blueprint is compiled into the same `{detect, act}` shape — which is what
 * makes an agent someone described in a chat window inherit the advisory lock,
 * the authority checks, escalation and the audit trail rather than needing its
 * own runtime.
 */
async function resolveImplementation(key) {
  const code = implementations.get(key);
  if (code) return code;

  const blueprintStore = require('./blueprintStore');
  const blueprint = await blueprintStore.getBlueprint(key).catch(() => null);
  if (!blueprint) return null;

  // Two shapes, both legitimate, and forcing either into the other's form makes
  // it worse. An 'ai' agent is a model in a loop that decides its own steps —
  // right for work that cannot be enumerated in advance. A 'pipeline' agent is
  // a fixed list of tool calls — right for a report that must come out
  // identically every month, where a model deciding how to build it is a
  // liability rather than a feature.
  return blueprint.kind === 'ai'
    ? require('./aiAgentRunner').compile(blueprint)
    : require('./blueprintRunner').compile(blueprint);
}

// ---------------------------------------------------------------------------
// Definition sync — code is the source of truth for which agents exist; the DB
// owns their operational state (enabled, mode, authority, schedule).
// ---------------------------------------------------------------------------
async function syncDefinitions() {
  const results = [];
  for (const agent of implementations.values()) {
    const { rows } = await pool.query(
      `INSERT INTO agent_definitions
         (agent_key, display_name, description, domain, mode, schedule_seconds, authority, config, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)
       ON CONFLICT (company_id, agent_key) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             description  = EXCLUDED.description,
             domain       = EXCLUDED.domain,
             updated_at   = CURRENT_TIMESTAMP
       RETURNING id, agent_key, enabled, mode`,
      [
        agent.key,
        agent.displayName || agent.key,
        agent.description || null,
        agent.domain || 'DATA',
        agent.defaultMode || 'observe',
        agent.defaultSchedule || null,
        JSON.stringify(agent.defaultAuthority || {}),
        JSON.stringify(agent.defaultConfig || {}),
      ]
    );
    results.push(rows[0]);
  }
  return results;
}

async function getDefinition(agentKey) {
  const { rows } = await pool.query('SELECT * FROM agent_definitions WHERE agent_key = $1', [agentKey]);
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Run execution
// ---------------------------------------------------------------------------

/**
 * Run one agent to completion.
 *
 * @param {string} agentKey
 * @param {object} options { trigger, triggeredBy, dryRun, modeOverride, force }
 * @returns {object} run summary
 */
async function runAgent(agentKey, options = {}) {
  const {
    trigger = 'manual',
    triggeredBy = null,
    dryRun = false,
    modeOverride = null,
    force = false,
    eventPayload = null,
  } = options;

  const impl = await resolveImplementation(agentKey);
  if (!impl) throw new Error(`No implementation registered for agent "${agentKey}".`);

  const definition = await getDefinition(agentKey);
  if (!definition) throw new Error(`Agent "${agentKey}" is not registered in the database. Run syncDefinitions() first.`);

  if (!definition.enabled && !force) {
    return { status: 'SKIPPED', agent_key: agentKey, reason: 'Agent is disabled.' };
  }

  // Serialize runs of this agent across every process. These agents send email
  // and change financial state; two concurrent runs would double-act.
  const lock = await pool.connect();
  let acquired = false;
  try {
    const { rows } = await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [`agent:${agentKey}`]);
    acquired = rows[0].ok;
    if (!acquired) {
      return { status: 'SKIPPED', agent_key: agentKey, reason: 'Another run of this agent is already in progress.' };
    }
    return await executeRun({ impl, definition, trigger, triggeredBy, dryRun, modeOverride, eventPayload });
  } finally {
    if (acquired) {
      await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [`agent:${agentKey}`]).catch(() => {});
    }
    lock.release();
  }
}

async function executeRun({ impl, definition, trigger, triggeredBy, dryRun, modeOverride, eventPayload }) {
  const mode = modeOverride || definition.mode;
  const agentAuthority = definition.authority || {};
  const config = definition.config || {};
  const startedAt = Date.now();

  const { rows: runRows } = await pool.query(
    `INSERT INTO agent_runs (agent_id, agent_key, trigger, triggered_by, status, mode, dry_run)
     VALUES ($1,$2,$3,$4,'RUNNING',$5,$6) RETURNING id`,
    [definition.id, definition.agent_key, trigger, triggeredBy, mode, dryRun]
  );
  const runId = runRows[0].id;

  const runState = { actionsTaken: 0, escalations: 0, errors: 0, observations: 0, sequence: 0 };
  const ctx = {
    runId,
    agentKey: definition.agent_key,
    mode,
    dryRun,
    config,
    authority: agentAuthority,
    userId: triggeredBy,
    // Which company this run acts for. EMBMIS Gateway tenants are companies.
    companyId: definition.company_id || null,
    eventPayload,
  };

  // Agents that direct themselves (a model in a loop) cannot be expressed as
  // detect-then-act, because the next step depends on the result of the last.
  // They get `performAction`, which is the SAME authority gate processObservation
  // applies — evaluated per action, between deciding and doing. The agent
  // chooses what to attempt; it never decides whether it is allowed to.
  ctx.performAction = (action, perform) =>
    performAction({ action, perform, ctx, runState, runId, agentAuthority, mode, dryRun });
  ctx.observe = async (observation) => {
    runState.sequence += 1;
    runState.observations += 1;
    await recordAction({
      runId,
      agentKey: ctx.agentKey,
      sequence: runState.sequence,
      actionType: observation.action_type || 'observe',
      entityType: observation.entity_type,
      entityId: observation.entity_id,
      entityLabel: observation.entity_label,
      decision: 'observed',
      rationale: observation.rationale || '',
      outcome: observation.data || null,
    });
  };

  let status = 'SUCCEEDED';
  let runError = null;
  let observations = [];
  let runResult = null;

  try {
    if (typeof impl.run === 'function') {
      // Self-directing agent: it owns its own loop and reports back.
      runResult = await impl.run(ctx);
      if (runResult?.observations != null) runState.observations = runResult.observations;
    } else {
      observations = (await impl.detect(ctx)) || [];
      runState.observations = observations.length;

      for (const observation of observations) {
        runState.sequence += 1;
        await processObservation({ impl, observation, ctx, runState, runId, agentAuthority, mode, dryRun });
      }
    }

    if (runState.errors > 0) status = 'PARTIAL';
  } catch (err) {
    // A failure in detect() (or in a self-directed run) is a failure of the
    // whole run — unlike a failure in a single action, there is nothing partial
    // to salvage.
    status = 'FAILED';
    runError = err.message;
    runState.errors += 1;
  }

  const durationMs = Date.now() - startedAt;
  const summary = runResult?.summary || buildSummary(definition.agent_key, runState, mode, dryRun, status);

  await pool.query(
    `UPDATE agent_runs
        SET status = $2, observations = $3, actions_taken = $4, escalations = $5,
            errors = $6, summary = $7, error = $8,
            finished_at = CURRENT_TIMESTAMP, duration_ms = $9,
            tokens_in = $10, tokens_out = $11, iterations = $12, model = $13
      WHERE id = $1`,
    [runId, status, runState.observations, runState.actionsTaken, runState.escalations,
     runState.errors, summary, runError, durationMs,
     runResult?.tokens_in || 0, runResult?.tokens_out || 0, runResult?.iterations || 0,
     runResult?.model || null]
  );

  await updateAgentHealth(definition, status, runError);

  return {
    run_id: runId,
    agent_key: definition.agent_key,
    status,
    mode,
    dry_run: dryRun,
    observations: runState.observations,
    actions_taken: runState.actionsTaken,
    escalations: runState.escalations,
    errors: runState.errors,
    duration_ms: durationMs,
    summary,
    error: runError,
  };
}


// ---------------------------------------------------------------------------
// EMBMIS Gateway — the second opinion on every action an agent takes.
//
// Runs AFTER the local authority rules, and the stricter answer wins: the
// gateway can turn an action the agent was authorised for into an escalation
// or a refusal, never the other way round. With no EMBMIS_GATEWAY_URL it is a
// no-op. An unreachable gateway lets reads continue and makes a write wait for
// a person (EMBMIS_GATEWAY_FAIL_MODE=closed) or run (open).
// ---------------------------------------------------------------------------
async function gatewayVerdict(ctx, action, impact) {
  if (action.type === 'ask_a_human') return null; // already a request for a person
  const gateway = require('../gateway/client');
  if (!gateway.isEnabled()) return null;
  return gateway.check({
    companyId: ctx.companyId,
    userId: ctx.userId,
    source: `agent:${ctx.agentKey}`,
    tool: action.type,
    args: { ...(action.args || {}), entity_type: action.entity_type, entity_id: action.entity_id, entity_label: action.entity_label },
    readOnly: impact === 'read',
    amount: action.amount,
    currency: action.currency,
  });
}

/**
 * Decide and (maybe) act on one observation. This is where authority is
 * enforced — between the agent deciding something should happen and it
 * happening.
 */
async function processObservation({ impl, observation, ctx, runState, runId, agentAuthority, mode, dryRun }) {
  const action = {
    type: observation.action_type,
    impact: observation.impact || 'real',
    amount: observation.amount,
    currency: observation.currency,
  };

  const base = {
    runId,
    agentKey: ctx.agentKey,
    sequence: runState.sequence,
    actionType: observation.action_type,
    entityType: observation.entity_type,
    entityId: observation.entity_id,
    entityLabel: observation.entity_label,
    amount: observation.amount,
    currency: observation.currency,
  };

  // Observation-only agents record what they saw and stop there.
  if (action.impact === 'read') {
    await recordAction({ ...base, decision: 'observed', rationale: observation.rationale, outcome: observation.data || null });
    return;
  }

  const verdict = authority.evaluate(agentAuthority, mode, action, runState);

  if (verdict.verdict === 'deny') {
    await recordAction({
      ...base,
      decision: 'skipped',
      rationale: `Not permitted: ${verdict.detail}`,
    });
    return;
  }

  if (verdict.verdict === 'escalate') {
    const escalationId = await raiseEscalation({
      runId,
      agentKey: ctx.agentKey,
      reason: verdict.reason,
      title: observation.entity_label || observation.action_type,
      detail: `${observation.rationale} — ${verdict.detail}`,
      proposedAction: observation.action_type,
      entityType: observation.entity_type,
      entityId: observation.entity_id,
      amount: observation.amount,
      currency: observation.currency,
    });
    runState.escalations += 1;
    await recordAction({
      ...base,
      decision: 'escalated',
      rationale: `${observation.rationale} — ${verdict.detail}`,
      outcome: { escalation_id: escalationId, reason: verdict.reason },
    });
    return;
  }

  // Authorised. In a dry run, stop here and report what would have happened —
  // this is why detect() must be side-effect free.
  if (dryRun) {
    await recordAction({
      ...base,
      decision: 'proposed',
      rationale: `[dry run] Would ${observation.action_type}: ${observation.rationale}`,
      outcome: observation.data || null,
    });
    return;
  }

  if (typeof impl.act !== 'function') {
    await recordAction({ ...base, decision: 'skipped', rationale: 'This agent has no act() implementation; detection only.' });
    return;
  }

  const gw = await gatewayVerdict(ctx, action, action.impact);
  if (gw && gw.decision === 'deny') {
    await recordAction({ ...base, decision: 'skipped', rationale: `Blocked by EMBMIS Gateway: ${gw.reason}`, outcome: { gateway: gw.code, trace_id: gw.traceId } });
    return;
  }
  if (gw && gw.decision === 'escalate') {
    const escalationId = await raiseEscalation({
      runId, agentKey: ctx.agentKey, reason: 'GATEWAY_ESCALATED',
      title: observation.entity_label || observation.action_type,
      detail: `${observation.rationale} — EMBMIS Gateway sent this to a person: ${gw.reason}`,
      proposedAction: observation.action_type, entityType: observation.entity_type, entityId: observation.entity_id,
      amount: observation.amount, currency: observation.currency, gatewayTraceId: gw.traceId,
    });
    runState.escalations += 1;
    await recordAction({
      ...base, decision: 'escalated',
      rationale: `${observation.rationale} — EMBMIS Gateway: ${gw.reason}`,
      outcome: { escalation_id: escalationId, reason: 'GATEWAY_ESCALATED', trace_id: gw.traceId },
    });
    return;
  }

  try {
    const outcome = await impl.act(observation, ctx);
    runState.actionsTaken += 1;
    await recordAction({
      ...base,
      decision: action.impact === 'draft' ? 'proposed' : 'acted',
      rationale: observation.rationale,
      outcome: outcome || null,
    });
  } catch (err) {
    runState.errors += 1;
    await recordAction({
      ...base,
      decision: 'failed',
      rationale: observation.rationale,
      error: err.message,
    });
  }
}

/**
 * Authority-gated execution of one action, for agents that direct themselves.
 *
 * This is processObservation's decision logic, reached from the other
 * direction: instead of the runtime iterating a list the agent produced, the
 * agent asks permission for each thing it wants to do and is told allow /
 * escalate / deny. The verdict is computed by the same pure, synchronous
 * authority engine — so a model cannot argue its way past a limit, and a
 * prompt-injected instruction inside a customer's name cannot widen one.
 *
 * Always RESOLVES, never rejects on refusal: the refusal is a result the agent
 * has to read and reason about ("that was escalated, so tell the human why"),
 * not an exception that ends its run.
 *
 * @param {object} action  { type, impact, amount, currency, entity_type, entity_id, entity_label, rationale }
 * @param {Function} perform  called only when the action is authorised
 */
async function performAction({ action, perform, ctx, runState, runId, agentAuthority, mode, dryRun }) {
  runState.sequence += 1;
  const impact = action.impact || 'real';

  const base = {
    runId,
    agentKey: ctx.agentKey,
    sequence: runState.sequence,
    actionType: action.type,
    entityType: action.entity_type,
    entityId: action.entity_id,
    entityLabel: action.entity_label,
    amount: action.amount,
    currency: action.currency,
  };

  if (impact === 'read') {
    const gw = await gatewayVerdict(ctx, action, 'read');
    if (gw && gw.decision === 'deny') {
      await recordAction({ ...base, decision: 'skipped', rationale: `Blocked by EMBMIS Gateway: ${gw.reason}`, outcome: { gateway: gw.code, trace_id: gw.traceId } });
      return { ok: false, verdict: 'deny', reason: 'GATEWAY_DENIED', detail: `Blocked by EMBMIS Gateway: ${gw.reason}` };
    }
    const result = await perform();
    await recordAction({ ...base, decision: 'observed', rationale: action.rationale || `Read ${action.type}.`, outcome: null });
    return { ok: true, verdict: 'allow', result };
  }

  const verdict = authority.evaluate(agentAuthority, mode, { ...action, impact }, runState);

  if (verdict.verdict === 'deny') {
    await recordAction({ ...base, decision: 'skipped', rationale: `Not permitted: ${verdict.detail}` });
    return { ok: false, verdict: 'deny', reason: verdict.reason, detail: verdict.detail };
  }

  if (verdict.verdict === 'escalate') {
    const escalationId = await raiseEscalation({
      runId,
      agentKey: ctx.agentKey,
      reason: verdict.reason,
      title: action.entity_label || action.type,
      detail: `${action.rationale || action.type} — ${verdict.detail}`,
      proposedAction: action.type,
      entityType: action.entity_type,
      entityId: action.entity_id,
      amount: action.amount,
      currency: action.currency,
    });
    runState.escalations += 1;
    await recordAction({
      ...base,
      decision: 'escalated',
      rationale: `${action.rationale || action.type} — ${verdict.detail}`,
      outcome: { escalation_id: escalationId, reason: verdict.reason },
    });
    return { ok: false, verdict: 'escalate', reason: verdict.reason, detail: verdict.detail, escalation_id: escalationId };
  }

  if (dryRun) {
    await recordAction({
      ...base,
      decision: 'proposed',
      rationale: `[dry run] Would ${action.type}: ${action.rationale || ''}`,
    });
    return { ok: false, verdict: 'dry_run', detail: 'This is a preview run, so the action was not performed.' };
  }

  const gw = await gatewayVerdict(ctx, action, impact);
  if (gw && gw.decision === 'deny') {
    await recordAction({ ...base, decision: 'skipped', rationale: `Blocked by EMBMIS Gateway: ${gw.reason}`, outcome: { gateway: gw.code, trace_id: gw.traceId } });
    return { ok: false, verdict: 'deny', reason: 'GATEWAY_DENIED', detail: `Blocked by EMBMIS Gateway: ${gw.reason}` };
  }
  if (gw && gw.decision === 'escalate') {
    const escalationId = await raiseEscalation({
      runId, agentKey: ctx.agentKey, reason: 'GATEWAY_ESCALATED',
      title: action.entity_label || action.type,
      detail: `${action.rationale || action.type} — EMBMIS Gateway sent this to a person: ${gw.reason}`,
      proposedAction: action.type, entityType: action.entity_type, entityId: action.entity_id,
      amount: action.amount, currency: action.currency, gatewayTraceId: gw.traceId,
    });
    runState.escalations += 1;
    await recordAction({
      ...base, decision: 'escalated',
      rationale: `${action.rationale || action.type} — EMBMIS Gateway: ${gw.reason}`,
      outcome: { escalation_id: escalationId, reason: 'GATEWAY_ESCALATED', trace_id: gw.traceId },
    });
    return { ok: false, verdict: 'escalate', reason: 'GATEWAY_ESCALATED', detail: `EMBMIS Gateway sent this to a person: ${gw.reason}`, escalation_id: escalationId };
  }

  try {
    const result = await perform();
    runState.actionsTaken += 1;
    await recordAction({
      ...base,
      decision: impact === 'draft' ? 'proposed' : 'acted',
      rationale: action.rationale || action.type,
      outcome: result && typeof result === 'object' ? result : { result },
    });
    return { ok: true, verdict: 'allow', result };
  } catch (err) {
    runState.errors += 1;
    await recordAction({ ...base, decision: 'failed', rationale: action.rationale || action.type, error: err.message });
    return { ok: false, verdict: 'error', detail: err.message };
  }
}

async function recordAction({ runId, agentKey, sequence, actionType, entityType, entityId, entityLabel, amount, currency, decision, rationale, outcome, error }) {
  await pool.query(
    `INSERT INTO agent_run_actions
       (run_id, agent_key, sequence, action_type, entity_type, entity_id, entity_label,
        amount, currency, decision, rationale, outcome, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [runId, agentKey, sequence, actionType, entityType || null, entityId || null,
     entityLabel ? String(entityLabel).slice(0, 200) : null,
     Number.isFinite(Number(amount)) ? Number(amount) : null, currency || null,
     decision, String(rationale || '').slice(0, 4000),
     outcome ? JSON.stringify(outcome) : null, error ? String(error).slice(0, 2000) : null]
  );
}

/**
 * Raise a human-actionable escalation. Deduped by the partial unique index on
 * (agent_key, entity, action) WHERE status='OPEN', so a scheduled agent that
 * keeps seeing the same too-large invoice raises it once, not hourly.
 */
async function raiseEscalation({ runId, agentKey, reason, title, detail, proposedAction, entityType, entityId, amount, currency, gatewayTraceId }) {
  const { rows } = await pool.query(
    `INSERT INTO agent_escalations
       (run_id, agent_key, reason, title, detail, proposed_action, entity_type, entity_id, amount, currency, gateway_trace_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [runId, agentKey, reason, String(title).slice(0, 200), detail, proposedAction || null,
     entityType || null, entityId || null,
     Number.isFinite(Number(amount)) ? Number(amount) : null, currency || null, gatewayTraceId || null]
  );
  return rows[0]?.id || null;
}

function buildSummary(agentKey, runState, mode, dryRun, status) {
  if (status === 'FAILED') return `${agentKey} failed before completing.`;
  const parts = [`Reviewed ${runState.observations} item(s)`];
  if (dryRun) {
    parts.push(`${runState.actionsTaken} would have been actioned (dry run — nothing changed)`);
  } else if (mode === 'observe') {
    parts.push('observation mode — no changes made');
  } else {
    parts.push(`${runState.actionsTaken} actioned`);
  }
  if (runState.escalations) parts.push(`${runState.escalations} escalated for human approval`);
  if (runState.errors) parts.push(`${runState.errors} failed`);
  return `${parts.join(', ')}.`;
}

/**
 * Track consecutive failures and disable an agent that keeps failing, so a
 * broken agent cannot run on a schedule indefinitely.
 */
async function updateAgentHealth(definition, status, error) {
  if (status === 'FAILED') {
    const failures = (definition.failure_count || 0) + 1;
    const shouldDisable = failures >= MAX_CONSECUTIVE_FAILURES;
    await pool.query(
      `UPDATE agent_definitions
          SET failure_count = $2, last_error = $3, last_run_at = CURRENT_TIMESTAMP,
              enabled = CASE WHEN $4 THEN false ELSE enabled END,
              next_run_at = CASE WHEN schedule_seconds IS NULL THEN NULL
                                 ELSE CURRENT_TIMESTAMP + (schedule_seconds || ' seconds')::interval END,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [definition.id, failures, error, shouldDisable]
    );
    if (shouldDisable) {
      console.error(`⚠️  Agent ${definition.agent_key} disabled after ${failures} consecutive failures: ${error}`);
    }
  } else {
    await pool.query(
      `UPDATE agent_definitions
          SET failure_count = 0, last_error = NULL, last_run_at = CURRENT_TIMESTAMP,
              next_run_at = CASE WHEN schedule_seconds IS NULL THEN NULL
                                 ELSE CURRENT_TIMESTAMP + (schedule_seconds || ' seconds')::interval END,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [definition.id]
    );
  }
}

// ---------------------------------------------------------------------------
// Queries for the API / AI tools
// ---------------------------------------------------------------------------

async function getRun(runId) {
  const { rows } = await pool.query('SELECT * FROM agent_runs WHERE id = $1', [runId]);
  if (!rows.length) return null;
  const actions = await pool.query(
    'SELECT * FROM agent_run_actions WHERE run_id = $1 ORDER BY sequence',
    [runId]
  );
  return { ...rows[0], actions: actions.rows };
}

async function listRuns({ agentKey, limit = 50 } = {}) {
  const params = [];
  let where = '';
  if (agentKey) { params.push(agentKey); where = `WHERE agent_key = $${params.length}`; }
  params.push(Math.min(limit, 200));
  const { rows } = await pool.query(
    `SELECT * FROM agent_runs ${where} ORDER BY started_at DESC LIMIT $${params.length}`,
    params
  );
  return rows;
}

async function listEscalations({ status = 'OPEN', limit = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM agent_escalations WHERE status = $1 ORDER BY created_at DESC LIMIT $2`,
    [status, Math.min(limit, 200)]
  );
  return rows;
}

async function resolveEscalation(id, userId, decision, note = '') {
  const status = decision === 'approve' ? 'APPROVED' : 'REJECTED';
  const { rows } = await pool.query(
    `UPDATE agent_escalations
        SET status = $2, resolved_by = $3, resolved_at = CURRENT_TIMESTAMP, resolution_note = $4
      WHERE id = $1 AND status = 'OPEN'
      RETURNING *`,
    [id, status, userId, note]
  );
  if (!rows.length) throw new Error('Escalation not found or already resolved.');
  // An escalation EMBMIS Gateway raised: tell it what the person decided, for its audit chain.
  if (rows[0].gateway_trace_id) {
    require('../gateway/client').resolve({
      companyId: rows[0].company_id, traceId: rows[0].gateway_trace_id,
      outcome: decision === 'approve' ? 'approved' : 'rejected',
      by: userId ? `user:${userId}` : 'unknown', reason: note || null,
    }).catch((err) => console.error('[gateway] could not report the escalation answer:', err.message));
  }
  return rows[0];
}

async function listAgents() {
  const { rows } = await pool.query(`
    SELECT d.*,
           (SELECT status     FROM agent_runs r WHERE r.agent_id = d.id ORDER BY started_at DESC LIMIT 1) AS last_status,
           (SELECT summary    FROM agent_runs r WHERE r.agent_id = d.id ORDER BY started_at DESC LIMIT 1) AS last_summary,
           (SELECT error      FROM agent_runs r WHERE r.agent_id = d.id ORDER BY started_at DESC LIMIT 1) AS last_error
      FROM agent_definitions d
     ORDER BY d.domain, d.display_name
  `);

  // A blueprint-backed agent is just as implemented as a code-backed one. Not
  // counting them here would label every user-built agent "Not implemented" —
  // the screen's warning that a definition can never do anything.
  const keys = await require('./blueprintStore').blueprintKeys().catch(() => new Set());

  return rows.map((r) => ({
    ...r,
    authority_description: authority.describeAuthority(r.authority || {}, r.mode),
    implemented: implementations.has(r.agent_key) || keys.has(r.agent_key),
    built_by_user: keys.has(r.agent_key),
  }));
}

/**
 * Change an agent's operational settings. Enabling an agent, or raising its
 * mode, is the act that grants autonomy — so it is a deliberate API call rather
 * than a code default.
 */
async function configureAgent(agentKey, { enabled, mode, schedule_seconds, authority: newAuthority, config } = {}) {
  const sets = [];
  const params = [agentKey];
  const add = (sql, value) => { params.push(value); sets.push(`${sql} = $${params.length}`); };

  if (enabled !== undefined) add('enabled', !!enabled);
  if (mode !== undefined) {
    if (!['observe', 'propose', 'act'].includes(mode)) throw new Error(`Invalid mode "${mode}".`);
    add('mode', mode);
  }
  if (schedule_seconds !== undefined) add('schedule_seconds', schedule_seconds === null ? null : Number(schedule_seconds));
  if (newAuthority !== undefined) add('authority', JSON.stringify(newAuthority));
  if (config !== undefined) add('config', JSON.stringify(config));
  if (!sets.length) throw new Error('Nothing to update.');

  // Re-arm the schedule immediately when enabling, so a newly enabled agent runs
  // on the next scheduler tick instead of waiting for a stale next_run_at.
  if (enabled) sets.push('next_run_at = CURRENT_TIMESTAMP');
  sets.push('failure_count = 0', 'updated_at = CURRENT_TIMESTAMP');

  const { rows } = await pool.query(
    `UPDATE agent_definitions SET ${sets.join(', ')} WHERE agent_key = $1 RETURNING *`,
    params
  );
  if (!rows.length) throw new Error(`Agent "${agentKey}" not found.`);
  return rows[0];
}

module.exports = {
  register,
  getImplementation,
  resolveImplementation,
  listImplementations,
  performAction,
  syncDefinitions,
  getDefinition,
  runAgent,
  getRun,
  listRuns,
  listEscalations,
  resolveEscalation,
  listAgents,
  configureAgent,
  MAX_CONSECUTIVE_FAILURES,
};
