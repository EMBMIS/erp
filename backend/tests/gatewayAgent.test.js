// EMBMIS Gateway wired into Simeli and into autonomous agents.
//
//   Simeli:  deny -> the tool does not run, Simeli is told "Blocked by EMBMIS Gateway: reason"
//            escalate -> the existing approval pause, in EVERY mode
//            allow -> normal confirmation rules
//   Resume:  the person's approve/reject is reported to /decisions/:traceId/resolve
//   Agents:  the gateway is asked after the local authority rules; the stricter answer wins
//
// E2E: Simeli proposes a large payment -> escalated -> approved -> audit resolve called.
// Run on its own:  node --test tests/gatewayAgent.test.js

const { test, before, after, beforeEach } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.AI_VAULT_KEY = crypto.randomBytes(32).toString('hex');

const { pool } = require('../config/database');
const companyContext = require('../services/companyContext');
const { startStubGateway } = require('./helpers/stubGateway');

const CONFIG = require.resolve('../config/aiConfig');
const AGENT = require.resolve('../services/ai/agent');
const ENV_KEYS = ['EMBMIS_GATEWAY_URL', 'EMBMIS_GATEWAY_PLATFORM_KEY', 'EMBMIS_GATEWAY_FAIL_MODE', 'EMBMIS_GATEWAY_TIMEOUT_MS'];

let companyId, stub, gatewayClient, ran;
const USER_ID = '00000000-0000-4000-8000-0000000000aa';

// A write tool that looks like what Simeli would be asked to do. It records every real execution.
function installTools() {
  const registry = require('../services/ai/toolRegistry');
  const mk = (name, extra) => {
    if (registry.byName.has(name)) return;
    const tool = {
      name, description: `test tool ${name}`, inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      handler: async (args) => { ran.push({ name, args }); return { done: true, name }; },
      ...extra,
    };
    registry.tools.push(tool);
    registry.byName.set(name, tool);
  };
  mk('create_payment_run', { readOnly: false });
  mk('delete_invoice_test', { readOnly: false });
  mk('list_open_invoices_test', { readOnly: true });
}

function withProvider(client) {
  const real = require('../config/aiConfig');
  require.cache[CONFIG].exports = { ...real, getAIClient: () => client, getAIProvider: () => 'openai' };
  delete require.cache[AGENT];
  return require(AGENT);
}
function restoreConfig() { delete require.cache[CONFIG]; delete require.cache[AGENT]; }
function openAIStream(chunks) { return (async function* () { for (const c of chunks) yield c; })(); }
const textChunk = (content) => ({ choices: [{ delta: { content } }] });
const toolChunk = (name, args, index = 0) => ({ choices: [{ delta: { tool_calls: [{ index, id: `call_${index}`, function: { name, arguments: args } }] } }] });

/** A model that calls `name` with `args` on its first turn and answers on its next. */
function scriptedModel(name, args, answer = 'Done.') {
  const seen = [];
  let n = 0;
  return {
    seen,
    chat: { completions: { create: (body) => {
      seen.push(JSON.parse(JSON.stringify(body.messages)));
      n += 1;
      return n === 1 ? openAIStream([toolChunk(name, JSON.stringify(args))]) : openAIStream([textChunk(answer)]);
    } } },
  };
}

const ctx = () => ({ userId: USER_ID, role: 'ADMIN', companyId });
const run = (fn) => companyContext.runWithCompany(companyId, fn);

before(async () => {
  companyId = await companyContext.getDefaultCompanyId();
  installTools();
  gatewayClient = require('../services/gateway/client');
  // Resuming looks the user up nowhere; but ai_audit_log may reference users, so make sure the id exists or is null-safe.
});

beforeEach(async () => {
  ran = [];
  for (const k of ENV_KEYS) delete process.env[k];
  gatewayClient._reset();
  await pool.query('DELETE FROM gateway_decisions');
  await pool.query('DELETE FROM gateway_tenants');
  await pool.query('DELETE FROM agent_paused_runs');
});

after(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  restoreConfig();
  if (stub) await stub.close();
  await pool.end();
});

async function gateway(decide, env = {}) {
  if (stub) await stub.close();
  stub = await startStubGateway({ decide });
  process.env.EMBMIS_GATEWAY_URL = stub.url;
  process.env.EMBMIS_GATEWAY_PLATFORM_KEY = 'pk_test';
  process.env.EMBMIS_GATEWAY_TIMEOUT_MS = '1000';
  Object.assign(process.env, env);
  gatewayClient._reset();
}

// ---------------------------------------------------------------------------
test('E2E: Simeli proposes a large payment -> escalated -> approved -> audit resolve called', async () => {
  await gateway((req) => (req.context.amount >= 10000
    ? { decision: 'escalate', code: 'POLICY_ESCALATE', reason: 'ERP: amounts of 10,000 or more need approval' }
    : { decision: 'allow', code: 'ALLOWED', reason: 'ok' }));
  const model = scriptedModel('create_payment_run', { supplier: 'Northwind', amount: 25000, currency: 'EUR' }, 'The payment run is done.');
  const { runAgent, resumeAgent } = withProvider(model);
  const events = [];

  // `auto` is the mode with NO confirmations of its own — only the gateway can pause this.
  const first = await run(() => runAgent('Pay Northwind 25,000 EUR', ctx(), [], 'auto', (e) => events.push(e)));

  assert.equal(first.status, 'awaiting_confirmation', 'an escalation pauses the run even in auto mode');
  assert.equal(ran.length, 0, 'the payment has NOT happened');
  assert.equal(first.pending.length, 1);
  assert.equal(first.pending[0].name, 'create_payment_run');
  assert.equal(first.pending[0].gateway.decision, 'escalate');
  assert.match(first.pending[0].gateway.reason, /10,000/, 'the person is shown the gateway\'s reason');
  const traceId = first.pending[0].gateway.traceId;
  assert.match(traceId, /^trace-/);
  assert.deepEqual(first.gateway, { allowed: 0, blocked: 0, escalated: 1, unchecked: 0 });
  assert.ok(events.some((e) => e.type === 'gateway' && e.decision === 'escalate'), 'the chat is told, live');
  assert.equal(stub.callsTo('POST', '/api/v1/decisions/').length, 0, 'nothing is resolved before the person answers');

  // The person approves.
  const done = await run(() => resumeAgent(first.pauseId, [{ tool_call_id: first.pending[0].id, approve: true }], undefined, USER_ID));
  assert.equal(done.status, 'done');
  assert.equal(done.response, 'The payment run is done.');
  assert.equal(ran.length, 1, 'now, and only now, the payment ran');
  assert.equal(ran[0].args.amount, 25000);

  const resolveCalls = stub.callsTo('POST', `/api/v1/decisions/${traceId}/resolve`);
  assert.equal(resolveCalls.length, 1, 'the audit resolve was called, once');
  assert.equal(resolveCalls[0].body.outcome, 'approved');
  assert.equal(resolveCalls[0].body.by, `user:${USER_ID}`);
  assert.match(resolveCalls[0].bearer, /^sag_agent_stub_/);

  const { rows: [d] } = await pool.query('SELECT outcome, resolved_by, resolve_synced_at FROM gateway_decisions WHERE trace_id = $1', [traceId]);
  assert.equal(d.outcome, 'approved');
  assert.ok(d.resolve_synced_at);
  restoreConfig();
});

test('a rejected escalation does not run the tool, and the rejection is reported', async () => {
  await gateway(() => ({ decision: 'escalate', code: 'POLICY_ESCALATE', reason: 'needs a person' }));
  const model = scriptedModel('create_payment_run', { amount: 50000 }, 'Understood, not paying.');
  const { runAgent, resumeAgent } = withProvider(model);
  const first = await run(() => runAgent('pay', ctx(), [], 'bypass'));
  assert.equal(first.status, 'awaiting_confirmation', 'bypass is the "no guardrails" tier and still pauses');
  const done = await run(() => resumeAgent(first.pauseId, [{ tool_call_id: first.pending[0].id, approve: false }], undefined, USER_ID));
  assert.equal(done.status, 'done');
  assert.equal(ran.length, 0, 'a rejected payment never runs');
  const call = stub.callsTo('POST', '/api/v1/decisions/')[0];
  assert.equal(call.body.outcome, 'rejected');
  restoreConfig();
});

test('deny: the tool does not run and Simeli is told "Blocked by EMBMIS Gateway: reason"', async () => {
  await gateway(() => ({ decision: 'deny', code: 'POLICY_DENY', reason: 'ERP: delete tools are denied' }));
  const model = scriptedModel('delete_invoice_test', { id: 7 }, 'That was blocked.');
  const { runAgent } = withProvider(model);
  const events = [];
  const out = await run(() => runAgent('delete invoice 7', ctx(), [], 'auto', (e) => events.push(e)));

  assert.equal(out.status, 'done');
  assert.equal(ran.length, 0, 'a denied tool never runs, in any mode');
  const blocked = events.find((e) => e.type === 'tool_blocked');
  assert.ok(blocked, 'the chat shows it was blocked');
  assert.equal(blocked.reason, 'ERP: delete tools are denied');
  // What the model saw on its second turn.
  const toolMsg = model.seen[1].find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /Blocked by EMBMIS Gateway: ERP: delete tools are denied/);
  assert.equal(out.gateway.blocked, 1);
  restoreConfig();
});

test('allow: a gateway-approved read runs; with the gateway on, normal rules still apply', async () => {
  await gateway(() => ({ decision: 'allow', code: 'ALLOWED', reason: 'reads are allowed' }));
  const { runAgent } = withProvider(scriptedModel('list_open_invoices_test', {}));
  const out = await run(() => runAgent('list invoices', ctx(), [], 'auto'));
  assert.equal(out.status, 'done');
  assert.equal(ran.length, 1);
  assert.equal(out.gateway.allowed, 1);
  assert.equal(stub.callsTo('POST', '/api/v1/decide')[0].body.action, 'READ');
  restoreConfig();

  // manual mode still asks for every call: an "allow" never skips a person's own confirmation setting
  ran.length = 0;
  const m = withProvider(scriptedModel('list_open_invoices_test', {}));
  const paused = await run(() => m.runAgent('list invoices', ctx(), [], 'manual'));
  assert.equal(paused.status, 'awaiting_confirmation');
  assert.equal(paused.pending[0].gateway, undefined, 'and it is the mode that asked, not the gateway');
  restoreConfig();
});

test('off: with no gateway configured nothing changes', async () => {
  const { runAgent } = withProvider(scriptedModel('create_payment_run', { amount: 99999 }));
  const out = await run(() => runAgent('pay', ctx(), [], 'auto'));
  assert.equal(out.status, 'done');
  assert.equal(ran.length, 1, 'auto mode runs it, as before');
  assert.deepEqual(out.gateway, { allowed: 0, blocked: 0, escalated: 0, unchecked: 0 });
  assert.equal(stub === undefined ? 0 : stub.calls.length, stub ? stub.calls.length : 0);
  restoreConfig();
});

test('unreachable gateway: reads continue, a write waits for a person', async () => {
  await gateway(() => ({ decision: 'allow', code: 'ALLOWED', reason: 'ok' }));
  stub.down = true;

  const r = withProvider(scriptedModel('list_open_invoices_test', {}));
  const read = await run(() => r.runAgent('list invoices', ctx(), [], 'auto'));
  assert.equal(read.status, 'done');
  assert.equal(ran.length, 1, 'the read ran');
  assert.equal(read.gateway.unchecked, 1, 'and it is counted as not checked');
  restoreConfig();

  ran.length = 0;
  const w = withProvider(scriptedModel('create_payment_run', { amount: 5 }));
  const write = await run(() => w.runAgent('pay', ctx(), [], 'auto'));
  assert.equal(write.status, 'awaiting_confirmation');
  assert.equal(ran.length, 0);
  assert.match(write.pending[0].gateway.reason, /could not be reached/);
  assert.equal(write.pending[0].gateway.traceId, null);
  restoreConfig();
});

test('unreachable gateway with fail mode open: a write runs', async () => {
  await gateway(() => ({ decision: 'allow', code: 'ALLOWED', reason: 'ok' }), { EMBMIS_GATEWAY_FAIL_MODE: 'open' });
  stub.down = true;
  const { runAgent } = withProvider(scriptedModel('create_payment_run', { amount: 5 }));
  const out = await run(() => runAgent('pay', ctx(), [], 'auto'));
  assert.equal(out.status, 'done');
  assert.equal(ran.length, 1);
  restoreConfig();
});

// ---------------------------------------------------------------------------
// Autonomous agents: runtime.performAction
// ---------------------------------------------------------------------------
async function agentRun() {
  const key = `gw-test-${crypto.randomBytes(3).toString('hex')}`;
  const { rows: [def] } = await pool.query(
    `INSERT INTO agent_definitions (agent_key, display_name, domain, mode, authority)
     VALUES ($1, 'Gateway test agent', 'FINANCE', 'act', '{}'::jsonb) RETURNING id`, [key]);
  const { rows: [runRow] } = await pool.query(
    `INSERT INTO agent_runs (agent_id, agent_key, trigger, status, mode) VALUES ($1, $2, 'manual', 'RUNNING', 'act') RETURNING id`, [def.id, key]);
  return { key, runId: runRow.id, defId: def.id };
}

async function act(runtime, { key, runId }, action, authority) {
  const performed = [];
  const runState = { actionsTaken: 0, escalations: 0, errors: 0, observations: 0, sequence: 0 };
  const result = await runtime.performAction({
    action, perform: async () => { performed.push(action.type); return { ok: true }; },
    ctx: { agentKey: key, companyId, userId: null }, runState, runId,
    agentAuthority: authority, mode: 'act', dryRun: false,
  });
  return { result, performed, runState };
}

test('agents: local authority allows, the gateway escalates -> the stricter answer wins', async () => {
  await gateway((req) => (req.tool === 'send_payment'
    ? { decision: 'escalate', code: 'POLICY_ESCALATE', reason: 'payments need approval' }
    : { decision: 'allow', code: 'ALLOWED', reason: 'ok' }));
  const runtime = require('../services/agents/runtime');
  const r = await agentRun();
  const authority = { allowed_actions: ['send_payment', 'send_reminder'], max_amount: 1000, currency: 'EUR' };

  const pay = await act(runtime, r, { type: 'send_payment', impact: 'real', amount: 100, currency: 'EUR', entity_label: 'INV-9', rationale: 'overdue' }, authority);
  assert.equal(pay.result.verdict, 'escalate');
  assert.equal(pay.result.reason, 'GATEWAY_ESCALATED');
  assert.equal(pay.performed.length, 0, 'the action did not run');
  assert.equal(pay.runState.escalations, 1);
  const { rows: [esc] } = await pool.query('SELECT * FROM agent_escalations WHERE run_id = $1', [r.runId]);
  assert.equal(esc.reason, 'GATEWAY_ESCALATED');
  assert.match(esc.detail, /payments need approval/);
  assert.match(esc.gateway_trace_id, /^trace-/);
  const decide = stub.callsTo('POST', '/api/v1/decide')[0].body;
  assert.equal(decide.agentName, `agent:${r.key}`);
  assert.equal(decide.action, 'PAYMENT');

  const remind = await act(runtime, r, { type: 'send_reminder', impact: 'real', entity_label: 'INV-9', rationale: 'overdue' }, authority);
  assert.equal(remind.result.verdict, 'allow');
  assert.equal(remind.performed.length, 1, 'an allowed action still runs');
  restoreConfig();
});

test('agents: a person resolving the escalation reports it to the gateway', async () => {
  await gateway(() => ({ decision: 'escalate', code: 'POLICY_ESCALATE', reason: 'needs a person' }));
  const runtime = require('../services/agents/runtime');
  const r = await agentRun();
  await act(runtime, r, { type: 'send_payment', impact: 'real', amount: 5, rationale: 'x' }, { allowed_actions: ['send_payment'], max_amount: 100 });
  const { rows: [esc] } = await pool.query('SELECT id, gateway_trace_id FROM agent_escalations WHERE run_id = $1', [r.runId]);
  await runtime.resolveEscalation(esc.id, null, 'approve', 'looks fine');
  await new Promise((resolve) => setTimeout(resolve, 150)); // reporting is fire-and-forget
  const call = stub.callsTo('POST', `/api/v1/decisions/${esc.gateway_trace_id}/resolve`)[0];
  assert.ok(call, 'the gateway was told');
  assert.equal(call.body.outcome, 'approved');
});

test('agents: the gateway denies -> the action does not run', async () => {
  await gateway(() => ({ decision: 'deny', code: 'POLICY_DENY', reason: 'no deletes' }));
  const runtime = require('../services/agents/runtime');
  const r = await agentRun();
  const out = await act(runtime, r, { type: 'delete_record', impact: 'real', rationale: 'x' }, { allowed_actions: ['delete_record'] });
  assert.equal(out.result.verdict, 'deny');
  assert.equal(out.result.reason, 'GATEWAY_DENIED');
  assert.match(out.result.detail, /Blocked by EMBMIS Gateway: no deletes/);
  assert.equal(out.performed.length, 0);
  const { rows: [a] } = await pool.query("SELECT decision, rationale FROM agent_run_actions WHERE run_id = $1 AND action_type = 'delete_record'", [r.runId]);
  assert.equal(a.decision, 'skipped');
  restoreConfig();
});

test('agents: when local authority already refuses, the gateway is not even asked', async () => {
  await gateway(() => ({ decision: 'allow', code: 'ALLOWED', reason: 'ok' }));
  const runtime = require('../services/agents/runtime');
  const r = await agentRun();
  const out = await act(runtime, r, { type: 'send_payment', impact: 'real', amount: 5000, rationale: 'x' }, { allowed_actions: ['send_payment'], max_amount: 100 });
  assert.equal(out.result.verdict, 'escalate');
  assert.equal(out.result.reason, 'AMOUNT_ABOVE_AUTHORITY');
  assert.equal(stub.callsTo('POST', '/api/v1/decide').length, 0);
  restoreConfig();
});

test('agents: reads go through the gateway too, and a gateway that is down does not stop them', async () => {
  await gateway(() => ({ decision: 'allow', code: 'ALLOWED', reason: 'ok' }));
  const runtime = require('../services/agents/runtime');
  const r = await agentRun();
  const ok = await act(runtime, r, { type: 'read_ledger', impact: 'read' }, {});
  assert.equal(ok.performed.length, 1);
  assert.equal(stub.callsTo('POST', '/api/v1/decide')[0].body.action, 'READ');
  stub.down = true;
  const down = await act(runtime, r, { type: 'read_ledger', impact: 'read' }, {});
  assert.equal(down.performed.length, 1, 'reads continue');
  restoreConfig();
});

test('agents: with the gateway off, behaviour is unchanged', async () => {
  const runtime = require('../services/agents/runtime');
  const r = await agentRun();
  const out = await act(runtime, r, { type: 'send_reminder', impact: 'real', rationale: 'x' }, { allowed_actions: ['send_reminder'] });
  assert.equal(out.result.verdict, 'allow');
  assert.equal(out.performed.length, 1);
});
