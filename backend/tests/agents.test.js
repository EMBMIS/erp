// Tests for the autonomous agent runtime.
//
// These agents send email, reconcile bank lines and repair financial records
// without a human present, so the tests focus on the boundaries rather than the
// happy path: what the authority engine refuses, what happens at the ceiling,
// that a dry run truly changes nothing, and that a failing action does not take
// the run down with it.
//
// Run on its own:  npm run test:agents

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');

const authority = require('../services/agents/authority');
const runtime = require('../services/agents/runtime');
const scheduler = require('../services/agents/scheduler');
const { pool } = require('../config/database');

// ===========================================================================
// Authority policy engine — pure, no DB
// ===========================================================================

const ACT_AUTHORITY = {
  max_amount: 1000,
  max_actions_per_run: 10,
  allowed_actions: ['send_reminder', 'reconcile'],
};

test('authority allows a permitted action within every limit', () => {
  const v = authority.evaluate(ACT_AUTHORITY, 'act',
    { type: 'send_reminder', impact: 'real', amount: 500, currency: 'USD' }, { actionsTaken: 0 });
  assert.equal(v.verdict, 'allow');
});

test('authority escalates rather than blocking when an amount exceeds the ceiling', () => {
  const v = authority.evaluate(ACT_AUTHORITY, 'act',
    { type: 'send_reminder', impact: 'real', amount: 5000, currency: 'USD' }, { actionsTaken: 0 });
  // Escalate, not deny — the work must still reach a human, not vanish.
  assert.equal(v.verdict, 'escalate');
  assert.equal(v.reason, 'AMOUNT_ABOVE_AUTHORITY');
});

test('authority denies an action that is not on the allowlist', () => {
  const v = authority.evaluate(ACT_AUTHORITY, 'act',
    { type: 'delete_everything', impact: 'real', amount: 1 }, { actionsTaken: 0 });
  assert.equal(v.verdict, 'deny');
  assert.equal(v.reason, 'ACTION_NOT_PERMITTED');
});

test('authority denies by default when no allowlist is configured', () => {
  // Adding a new action type in code must not silently grant authority.
  const v = authority.evaluate({ max_amount: 999999 }, 'act',
    { type: 'anything', impact: 'real', amount: 1 }, { actionsTaken: 0 });
  assert.equal(v.verdict, 'deny');
});

test('observe mode cannot write, propose mode cannot perform real actions', () => {
  const draft = { type: 'send_reminder', impact: 'draft', amount: 10 };
  const real = { type: 'send_reminder', impact: 'real', amount: 10 };

  assert.equal(authority.evaluate(ACT_AUTHORITY, 'observe', draft, {}).verdict, 'escalate');
  assert.equal(authority.evaluate(ACT_AUTHORITY, 'observe', real, {}).verdict, 'escalate');
  assert.equal(authority.evaluate(ACT_AUTHORITY, 'propose', draft, {}).verdict, 'allow');
  assert.equal(authority.evaluate(ACT_AUTHORITY, 'propose', real, {}).verdict, 'escalate');
  assert.equal(authority.evaluate(ACT_AUTHORITY, 'act', real, {}).verdict, 'allow');
});

test('reads are always permitted regardless of mode or allowlist', () => {
  const read = { type: 'anything_at_all', impact: 'read' };
  for (const mode of ['observe', 'propose', 'act']) {
    assert.equal(authority.evaluate({}, mode, read, {}).verdict, 'allow', `read blocked in ${mode}`);
  }
});

test('a real money action with no configured ceiling escalates instead of assuming authority', () => {
  const v = authority.evaluate({ allowed_actions: ['pay'] }, 'act',
    { type: 'pay', impact: 'real', amount: 100000 }, { actionsTaken: 0 });
  assert.equal(v.verdict, 'escalate');
  assert.equal(v.reason, 'NO_AMOUNT_LIMIT_CONFIGURED');
});

test('the per-run action budget caps the blast radius of a bad detection rule', () => {
  const v = authority.evaluate(ACT_AUTHORITY, 'act',
    { type: 'send_reminder', impact: 'real', amount: 1 }, { actionsTaken: 10 });
  assert.equal(v.verdict, 'escalate');
  assert.equal(v.reason, 'RUN_BUDGET_EXHAUSTED');
});

test('authority refuses an action in a currency it is not scoped for', () => {
  const v = authority.evaluate({ ...ACT_AUTHORITY, currency: 'USD' }, 'act',
    { type: 'send_reminder', impact: 'real', amount: 100, currency: 'EUR' }, { actionsTaken: 0 });
  assert.equal(v.verdict, 'escalate');
  assert.equal(v.reason, 'CURRENCY_NOT_PERMITTED');
});

test('describeAuthority explains the envelope in plain language', () => {
  const d = authority.describeAuthority(ACT_AUTHORITY, 'act');
  assert.equal(d.can_perform, 'real');
  assert.equal(d.max_amount, 1000);
  assert.match(d.explanation, /escalated to a human/);
});

test('every registered agent can actually perform the actions it declares', () => {
  // An agent whose act() handles an action type missing from its
  // defaultAuthority allowlist is silently inert: the authority engine denies
  // the action and the run reports "0 actioned" with no error. That is exactly
  // how the data-integrity agent shipped unable to perform its main repair —
  // the action was renamed in detect()/act() but not in the allowlist.
  //
  // Deny-by-default is the right behaviour; this test is what stops it becoming
  // a silent misconfiguration.
  const agents = require('../services/agents').AGENTS;
  assert.ok(agents.length > 0, 'agents should be registered');

  for (const agent of agents) {
    const allowed = agent.defaultAuthority?.allowed_actions || [];
    const source = agent.act ? agent.act.toString() : '';

    // Action types an agent handles appear as string literals in its act()
    // switch/comparisons. Compare against what the allowlist grants.
    const handled = [...source.matchAll(/case\s+'([a-z_]+)'/g)].map((m) => m[1]);

    for (const action of handled) {
      assert.ok(
        allowed.includes(action),
        `${agent.key} handles "${action}" in act() but it is not in allowed_actions ` +
        `(${allowed.join(', ') || 'none'}) — the authority engine will deny it and the ` +
        `agent will silently do nothing`
      );
    }
  }
});

// ===========================================================================
// Runtime — DB-backed
// ===========================================================================

let dbAvailable = false;
let userId = null;
const created = { agentKeys: [], runIds: [], invoiceIds: [], customerIds: [] };

// A disposable agent whose behaviour each test controls, so runtime semantics
// are tested without depending on real business data.
function makeProbeAgent(key, { observations = [], actFn } = {}) {
  return {
    key,
    displayName: `Probe ${key}`,
    description: 'test agent',
    domain: 'DATA',
    defaultMode: 'act',
    defaultAuthority: { max_amount: 1000, max_actions_per_run: 10, allowed_actions: ['probe_action'] },
    async detect() { return observations; },
    act: actFn || (async () => ({ ok: true })),
  };
}

before(async () => {
  try {
    await pool.query('SELECT 1');
    const users = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
    if (users.rows.length) {
      userId = users.rows[0].id;
      dbAvailable = true;
    }
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  if (dbAvailable) {
    for (const id of created.invoiceIds) {
      await pool.query('DELETE FROM customer_invoices WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.customerIds) {
      await pool.query('DELETE FROM customers WHERE id = $1', [id]).catch(() => {});
    }
    for (const key of created.agentKeys) {
      await pool.query('DELETE FROM agent_definitions WHERE agent_key = $1', [key]).catch(() => {});
    }
  }
  await pool.end();
});

async function registerProbe(agent) {
  runtime.register(agent);
  created.agentKeys.push(agent.key);
  const companyScope = require('../services/companyScope');
  let companyId = companyScope.currentCompanyId();
  if (!companyId) {
    const { rows } = await pool.query("SELECT id FROM companies ORDER BY created_at ASC LIMIT 1");
    companyId = rows[0]?.id;
  }
  await pool.query(
    `INSERT INTO agent_definitions (company_id, agent_key, display_name, description, domain, mode, authority, config, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,true)
     ON CONFLICT (company_id, agent_key) DO UPDATE SET enabled = true, mode = EXCLUDED.mode, authority = EXCLUDED.authority`,
    [companyId, agent.key, agent.displayName, agent.description, agent.domain, agent.defaultMode,
     JSON.stringify(agent.defaultAuthority)]
  );
}

test('a run records every observation with its decision and rationale', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const key = `probe_basic_${Date.now()}`;
  await registerProbe(makeProbeAgent(key, {
    observations: [
      { action_type: 'probe_action', impact: 'real', amount: 100, currency: 'USD',
        entity_type: 'test', entity_label: 'within limit', rationale: 'small enough to act on' },
      { action_type: 'probe_action', impact: 'real', amount: 99999, currency: 'USD',
        entity_type: 'test', entity_label: 'over limit', rationale: 'too large to act on' },
    ],
  }));

  const run = await runtime.runAgent(key, { trigger: 'manual' });
  created.runIds.push(run.run_id);

  assert.equal(run.status, 'SUCCEEDED');
  assert.equal(run.observations, 2);
  assert.equal(run.actions_taken, 1, 'only the within-limit action should run');
  assert.equal(run.escalations, 1, 'the over-limit action should escalate');

  const detail = await runtime.getRun(run.run_id);
  assert.equal(detail.actions.length, 2);
  const acted = detail.actions.find((a) => a.decision === 'acted');
  const escalated = detail.actions.find((a) => a.decision === 'escalated');
  assert.ok(acted && escalated);
  // Every recorded action must explain itself.
  detail.actions.forEach((a) => assert.ok(a.rationale && a.rationale.length > 0));
  assert.match(escalated.rationale, /exceeds this agent's limit/);
});

test('a dry run performs no actions at all', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  let sideEffects = 0;
  const key = `probe_dry_${Date.now()}`;
  await registerProbe(makeProbeAgent(key, {
    observations: [
      { action_type: 'probe_action', impact: 'real', amount: 10, entity_type: 'test',
        entity_label: 'x', rationale: 'would act' },
    ],
    actFn: async () => { sideEffects += 1; return {}; },
  }));

  const run = await runtime.runAgent(key, { trigger: 'manual', dryRun: true });
  created.runIds.push(run.run_id);

  assert.equal(sideEffects, 0, 'act() must never be called during a dry run');
  assert.equal(run.actions_taken, 0);

  const detail = await runtime.getRun(run.run_id);
  assert.equal(detail.actions[0].decision, 'proposed');
  assert.match(detail.actions[0].rationale, /\[dry run\]/);
});

test('one failing action does not abort the rest of the run', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const key = `probe_partial_${Date.now()}`;
  await registerProbe(makeProbeAgent(key, {
    observations: [
      { action_type: 'probe_action', impact: 'real', amount: 1, entity_type: 'test', entity_label: 'ok-1', rationale: 'first' },
      { action_type: 'probe_action', impact: 'real', amount: 2, entity_type: 'test', entity_label: 'boom', rationale: 'second' },
      { action_type: 'probe_action', impact: 'real', amount: 3, entity_type: 'test', entity_label: 'ok-2', rationale: 'third' },
    ],
    actFn: async (obs) => {
      if (obs.entity_label === 'boom') throw new Error('simulated failure');
      return { ok: true };
    },
  }));

  const run = await runtime.runAgent(key, { trigger: 'manual' });
  created.runIds.push(run.run_id);

  assert.equal(run.status, 'PARTIAL');
  assert.equal(run.actions_taken, 2, 'the two healthy actions must still complete');
  assert.equal(run.errors, 1);

  const detail = await runtime.getRun(run.run_id);
  const failed = detail.actions.find((a) => a.decision === 'failed');
  assert.match(failed.error, /simulated failure/);
});

test('a failure inside detect() fails the whole run and is recorded', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const key = `probe_detectfail_${Date.now()}`;
  const agent = makeProbeAgent(key);
  agent.detect = async () => { throw new Error('detection exploded'); };
  await registerProbe(agent);

  const run = await runtime.runAgent(key, { trigger: 'manual' });
  created.runIds.push(run.run_id);

  assert.equal(run.status, 'FAILED');
  assert.match(run.error, /detection exploded/);
});

test('a disabled agent does not run', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const key = `probe_disabled_${Date.now()}`;
  await registerProbe(makeProbeAgent(key));
  await pool.query('UPDATE agent_definitions SET enabled = false WHERE agent_key = $1', [key]);

  const run = await runtime.runAgent(key, { trigger: 'schedule' });
  assert.equal(run.status, 'SKIPPED');
  assert.match(run.reason, /disabled/);
});

test('escalations are deduped so a scheduled agent does not re-raise the same issue', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const entityId = (await pool.query('SELECT uuid_generate_v4() AS id')).rows[0].id;
  const key = `probe_dedupe_${Date.now()}`;
  await registerProbe(makeProbeAgent(key, {
    observations: [
      { action_type: 'probe_action', impact: 'real', amount: 99999, currency: 'USD',
        entity_type: 'test_entity', entity_id: entityId, entity_label: 'recurring problem',
        rationale: 'always too big' },
    ],
  }));

  const first = await runtime.runAgent(key, { trigger: 'manual' });
  const second = await runtime.runAgent(key, { trigger: 'manual' });
  created.runIds.push(first.run_id, second.run_id);

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM agent_escalations
      WHERE agent_key = $1 AND entity_id = $2 AND status = 'OPEN'`,
    [key, entityId]
  );
  assert.equal(rows[0].n, 1, 'the same unresolved escalation must be raised once, not once per run');
});

test('configureAgent is what grants autonomy, and validates the mode', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const key = `probe_config_${Date.now()}`;
  await registerProbe(makeProbeAgent(key));

  const updated = await runtime.configureAgent(key, { mode: 'act', enabled: true, schedule_seconds: 3600 });
  assert.equal(updated.mode, 'act');
  assert.equal(updated.enabled, true);
  assert.ok(updated.next_run_at, 'enabling should arm the schedule immediately');

  await assert.rejects(() => runtime.configureAgent(key, { mode: 'god_mode' }), /Invalid mode/);
});

test('the data integrity agent repairs a drifted account balance from the journal lines', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const dataIntegrity = require('../services/agents/definitions/dataIntegrityAgent');

  // Deliberately corrupt a cached account balance, then confirm the agent both
  // notices and repairs it from the posted journal lines.
  const acct = await pool.query(
    `SELECT id, account_code, current_balance FROM chart_of_accounts
      WHERE deleted_at IS NULL AND is_header = false AND current_balance IS NOT NULL
      ORDER BY account_code LIMIT 1`
  );
  if (!acct.rows.length) return t.skip('no chart of accounts');
  const original = acct.rows[0].current_balance;

  await pool.query('UPDATE chart_of_accounts SET current_balance = current_balance + 12345.67 WHERE id = $1',
    [acct.rows[0].id]);

  try {
    const observations = await dataIntegrity.detect({ config: {} });
    const mine = observations.find(
      (o) => o.entity_id === acct.rows[0].id && o.action_type === 'recompute_account_balance');
    assert.ok(mine, 'the corrupted balance should be detected');
    assert.match(mine.rationale, /source of truth/);

    await dataIntegrity.act(mine);

    const after = await pool.query(
      'SELECT current_balance::float AS b FROM chart_of_accounts WHERE id = $1', [acct.rows[0].id]);
    assert.equal(after.rows[0].b, mine.data.derived,
      'the balance should be recomputed to the journal-line total');
  } finally {
    await pool.query('UPDATE chart_of_accounts SET current_balance = $2 WHERE id = $1',
      [acct.rows[0].id, original]);
  }
});

test('the data integrity agent refuses to auto-correct an unbalanced journal entry', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const dataIntegrity = require('../services/agents/definitions/dataIntegrityAgent');

  // Which side of an unbalanced entry is wrong is an accounting judgement, and
  // "fixing" it would destroy the evidence of whatever caused it.
  await assert.rejects(
    () => dataIntegrity.act({ action_type: 'report_unbalanced_journal_entry', entity_id: null }),
    /report-only/
  );
  await assert.rejects(
    () => dataIntegrity.act({ action_type: 'report_orphaned_journal_lines', entity_id: null }),
    /report-only/
  );
});

test('the scheduler only claims agents that are enabled and due', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const dueKey = `probe_due_${Date.now()}`;
  const notDueKey = `probe_notdue_${Date.now()}`;
  await registerProbe(makeProbeAgent(dueKey));
  await registerProbe(makeProbeAgent(notDueKey));

  await pool.query(
    `UPDATE agent_definitions SET schedule_seconds = 3600, next_run_at = CURRENT_TIMESTAMP - interval '1 hour'
      WHERE agent_key = $1`, [dueKey]);
  await pool.query(
    `UPDATE agent_definitions SET schedule_seconds = 3600, next_run_at = CURRENT_TIMESTAMP + interval '1 hour'
      WHERE agent_key = $1`, [notDueKey]);

  const claimed = await scheduler.claimDueAgents(50);
  assert.ok(claimed.includes(dueKey), 'a due agent should be claimed');
  assert.ok(!claimed.includes(notDueKey), 'an agent not yet due must not be claimed');

  // Claiming re-arms next_run_at, so a second immediate claim must not re-take it.
  const secondClaim = await scheduler.claimDueAgents(50);
  assert.ok(!secondClaim.includes(dueKey), 'claiming must be atomic — no double-dispatch');
});

test('the scheduler does not start unless explicitly enabled', () => {
  const prior = process.env.AGENT_SCHEDULER_ENABLED;
  delete process.env.AGENT_SCHEDULER_ENABLED;
  const result = scheduler.startScheduler();
  assert.equal(result.started, false, 'importing the app must never start autonomous execution');
  if (prior !== undefined) process.env.AGENT_SCHEDULER_ENABLED = prior;
});

test('repeated failures disable an agent instead of letting it run forever', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const key = `probe_health_${Date.now()}`;
  const agent = makeProbeAgent(key);
  agent.detect = async () => { throw new Error('always broken'); };
  await registerProbe(agent);
  await pool.query('UPDATE agent_definitions SET schedule_seconds = 3600 WHERE agent_key = $1', [key]);

  for (let i = 0; i < runtime.MAX_CONSECUTIVE_FAILURES; i++) {
    const r = await runtime.runAgent(key, { trigger: 'schedule', force: true });
    created.runIds.push(r.run_id);
  }

  const { rows } = await pool.query('SELECT enabled, failure_count FROM agent_definitions WHERE agent_key = $1', [key]);
  assert.equal(rows[0].enabled, false, 'a persistently failing agent should be disabled');
  assert.ok(rows[0].failure_count >= runtime.MAX_CONSECUTIVE_FAILURES);
});
