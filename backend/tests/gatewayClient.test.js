// EMBMIS Gateway client: off / allow / deny / escalate / unreachable, provisioning and resolve.
//
// The gateway is a separate product reached over HTTP, so it is stood in for by tests/helpers/stubGateway.js.
// Run on its own:  node --test tests/gatewayClient.test.js

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.AI_VAULT_KEY = crypto.randomBytes(32).toString('hex');

const { pool } = require('../config/database');
const companyContext = require('../services/companyContext');
const { startStubGateway } = require('./helpers/stubGateway');

const ENV_KEYS = ['EMBMIS_GATEWAY_URL', 'EMBMIS_GATEWAY_PLATFORM_KEY', 'EMBMIS_GATEWAY_FAIL_MODE', 'EMBMIS_GATEWAY_TIMEOUT_MS', 'EMBMIS_GATEWAY_CONSOLE_URL'];
let stub, companyId, client;

before(async () => {
  companyId = await companyContext.getDefaultCompanyId();
  client = require('../services/gateway/client');
});

after(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  if (stub) await stub.close();
  await pool.end();
});

async function fresh(decide, env = {}) {
  if (stub) await stub.close();
  stub = await startStubGateway({ decide });
  process.env.EMBMIS_GATEWAY_URL = stub.url;
  process.env.EMBMIS_GATEWAY_PLATFORM_KEY = 'pk_test';
  process.env.EMBMIS_GATEWAY_FAIL_MODE = 'closed';
  process.env.EMBMIS_GATEWAY_TIMEOUT_MS = '1000';
  Object.assign(process.env, env);
  client._reset();
  await pool.query('DELETE FROM gateway_decisions');
  await pool.query('DELETE FROM gateway_tenants');
}

const readCall = { companyId: null, userId: 'u1', source: 'simeli', tool: 'get_trial_balance', args: {}, readOnly: true };
const writeCall = { companyId: null, userId: 'u1', source: 'simeli', tool: 'create_purchase_requisition_draft', args: { item: 'bolts', qty: 10 }, readOnly: false };

// ---------------------------------------------------------------------------
test('off: with no URL configured nothing is called and nothing changes', async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  client._reset();
  assert.equal(client.isEnabled(), false);
  const v = await client.check({ ...writeCall, companyId });
  assert.equal(v.decision, 'allow');
  assert.equal(v.code, 'GATEWAY_OFF');
  assert.equal(v.origin, 'off');
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM gateway_decisions');
  assert.equal(rows[0].n, 0, 'an off gateway records nothing');
  const status = await client.getStatus(companyId);
  assert.equal(status.enabled, false);
});

test('allow: provisions the tenant and agent, asks, records the verdict', async () => {
  await fresh(() => ({ decision: 'allow', code: 'ALLOWED', reason: 'Allowed by policy' }));
  const v = await client.check({ ...writeCall, companyId });
  assert.equal(v.decision, 'allow');
  assert.equal(v.origin, 'gateway');

  assert.equal(stub.callsTo('PUT', '/api/v1/tenants/').length, 1, 'the company is registered as a tenant');
  assert.equal(stub.callsTo('PUT', '/api/v1/tenants/')[0].bearer, 'pk_test', 'provisioning uses the platform key');
  const agentCall = stub.callsTo('POST', '/api/v1/tenants/')[0];
  assert.equal(agentCall.body.name, 'simeli');
  const decide = stub.callsTo('POST', '/api/v1/decide')[0];
  assert.match(decide.bearer, /^sag_agent_stub_/, 'deciding uses the agent key, never the platform key');
  assert.equal(decide.body.tool, 'create_purchase_requisition_draft');
  assert.equal(decide.body.action, 'WRITE');
  assert.equal(decide.body.context.tenantId, companyId);
  assert.equal(decide.body.context.userId, 'u1');

  const { rows } = await pool.query('SELECT * FROM gateway_decisions');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, 'allow');
  assert.equal(rows[0].origin, 'gateway');
  assert.equal(rows[0].source, 'simeli');
  assert.ok(rows[0].audit_hash, 'the gateway audit hash is kept as the index into its chain');
});

test('the agent key is stored encrypted, never in the clear, and is reused', async () => {
  await fresh();
  await client.check({ ...readCall, companyId });
  await client.check({ ...writeCall, companyId });
  assert.equal(stub.callsTo('POST', '/api/v1/tenants/').length, 1, 'provisioned once, not per call');

  const { rows: [row] } = await pool.query('SELECT * FROM gateway_tenants');
  const issued = [...stub.keys.keys()][0];
  assert.ok(issued.startsWith('sag_agent_stub_'));
  for (const col of ['key_cipher', 'key_iv', 'key_tag']) {
    assert.ok(row[col] && !String(row[col]).includes(issued), `${col} must not contain the key`);
  }
  const vault = require('../services/ai/credentialVault');
  assert.equal(vault.decryptParts({ cipher: row.key_cipher, iv: row.key_iv, tag: row.key_tag }), issued, 'and it decrypts with AI_VAULT_KEY');
  assert.equal(row.tenant_id, companyId);
});

test('a fresh process reads the stored key instead of provisioning again', async () => {
  await fresh();
  await client.check({ ...readCall, companyId });
  client._reset(); // simulates a restart: the in-memory cache is gone, the row is not
  await client.check({ ...readCall, companyId });
  assert.equal(stub.callsTo('POST', '/api/v1/tenants/').length, 1);
});

test('deny: the verdict and its reason come back and are recorded', async () => {
  await fresh(() => ({ decision: 'deny', code: 'POLICY_DENY', reason: 'ERP: delete tools are denied', matchedPolicy: { id: 'p1', name: 'ERP: delete tools are denied' } }));
  const v = await client.check({ ...writeCall, tool: 'delete_invoice', companyId });
  assert.equal(v.decision, 'deny');
  assert.equal(v.reason, 'ERP: delete tools are denied');
  const { rows: [r] } = await pool.query('SELECT * FROM gateway_decisions');
  assert.equal(r.decision, 'deny');
  assert.equal(r.matched_policy.name, 'ERP: delete tools are denied');
});

test('escalate: the trace id is kept so the answer can be reported', async () => {
  await fresh(() => ({ decision: 'escalate', code: 'POLICY_ESCALATE', reason: 'Payments need approval' }));
  const v = await client.check({ ...writeCall, tool: 'create_payment_run', args: { amount: 25000, currency: 'eur' }, companyId });
  assert.equal(v.decision, 'escalate');
  assert.match(v.traceId, /^trace-/);
  const decide = stub.callsTo('POST', '/api/v1/decide')[0].body;
  assert.equal(decide.action, 'PAYMENT', 'a payment tool is described as a PAYMENT');
  assert.equal(decide.context.amount, 25000);
  assert.equal(decide.context.currency, 'EUR');
  assert.equal(decide.resource.module, 'finance');
  const { rows: [r] } = await pool.query('SELECT * FROM gateway_decisions');
  assert.equal(r.trace_id, v.traceId);
  assert.equal(Number(r.amount), 25000);
});

test('reads are described as READ and personal data as personal', async () => {
  await fresh();
  await client.check({ ...readCall, tool: 'list_employees', companyId });
  const body = stub.callsTo('POST', '/api/v1/decide')[0].body;
  assert.equal(body.action, 'READ');
  assert.equal(body.resource.classification, 'personal');
});

test('long arguments are bounded before they leave Business OS', async () => {
  await fresh();
  await client.check({ ...writeCall, args: { memo: 'x'.repeat(5000), lines: Array.from({ length: 100 }, (_, i) => ({ i })) }, companyId });
  const body = stub.callsTo('POST', '/api/v1/decide')[0].body;
  assert.ok(body.args.memo.length <= 201);
  assert.ok(body.args.lines.length <= 21);
});

// ---------------------------------------------------------------------------
test('unreachable: a read continues', async () => {
  await fresh();
  await client.check({ ...readCall, companyId }); // provision while up
  stub.down = true;
  const v = await client.check({ ...readCall, companyId });
  assert.equal(v.decision, 'allow');
  assert.equal(v.code, 'GATEWAY_UNREACHABLE');
  assert.equal(v.origin, 'fallback');
});

test('unreachable, fail mode closed: a write waits for a person', async () => {
  await fresh();
  await client.check({ ...readCall, companyId });
  stub.down = true;
  const v = await client.check({ ...writeCall, companyId });
  assert.equal(v.decision, 'escalate');
  assert.equal(v.code, 'GATEWAY_UNREACHABLE');
  assert.match(v.reason, /waits for a person/);
  assert.equal(v.traceId, null, 'there is no trace to report an answer to');
  const { rows } = await pool.query("SELECT * FROM gateway_decisions WHERE origin = 'fallback'");
  assert.equal(rows.length, 1, 'the fallback is recorded as such');
});

test('unreachable, fail mode open: a write runs', async () => {
  await fresh(undefined, { EMBMIS_GATEWAY_FAIL_MODE: 'open' });
  await client.check({ ...readCall, companyId });
  stub.down = true;
  const v = await client.check({ ...writeCall, companyId });
  assert.equal(v.decision, 'allow');
  assert.equal(v.code, 'GATEWAY_UNREACHABLE_OPEN');
});

test('unreachable: a gateway that never answers is cut off at the timeout', async () => {
  await fresh(undefined, { EMBMIS_GATEWAY_TIMEOUT_MS: '300' });
  await client.check({ ...readCall, companyId });
  stub.slowMs = 1500;
  const started = Date.now();
  const v = await client.check({ ...writeCall, companyId });
  assert.ok(Date.now() - started < 1200, 'it must not wait for the slow gateway');
  assert.equal(v.decision, 'escalate');
});

test('unreachable before the company was ever registered still gives a verdict', async () => {
  await fresh();
  stub.down = true;
  const v = await client.check({ ...writeCall, companyId });
  assert.equal(v.decision, 'escalate');
  const r = await client.check({ ...readCall, companyId });
  assert.equal(r.decision, 'allow');
});

test('a gateway nobody is listening on is unreachable, not an exception', async () => {
  await fresh();
  process.env.EMBMIS_GATEWAY_URL = 'http://127.0.0.1:9';
  client._reset();
  const v = await client.check({ ...writeCall, companyId });
  assert.equal(v.decision, 'escalate');
  assert.equal(v.origin, 'fallback');
});

test('a missing platform key explains itself and fails by the fail mode', async () => {
  await fresh();
  delete process.env.EMBMIS_GATEWAY_PLATFORM_KEY;
  const v = await client.check({ ...writeCall, companyId });
  assert.equal(v.decision, 'escalate');
  assert.match(v.reason, /EMBMIS_GATEWAY_PLATFORM_KEY/);
});

test('a rotated agent key is replaced automatically', async () => {
  await fresh();
  await client.check({ ...readCall, companyId });
  stub.keys.clear(); // the gateway forgot every agent key
  const v = await client.check({ ...readCall, companyId });
  assert.equal(v.origin, 'gateway', 'it recovered rather than falling back');
  assert.ok(stub.callsTo('POST', '/api/v1/tenants/').some((c) => c.query.rotate === 'true'), 'by rotating, not by creating a second agent');
});

test('a changed gateway URL re-provisions instead of trusting the old key', async () => {
  await fresh();
  await client.check({ ...readCall, companyId });
  const second = await startStubGateway();
  try {
    process.env.EMBMIS_GATEWAY_URL = second.url;
    client._reset();
    await client.check({ ...readCall, companyId });
    assert.equal(second.callsTo('PUT', '/api/v1/tenants/').length, 1, 'the new gateway got its own tenant');
    const { rows } = await pool.query('SELECT gateway_url FROM gateway_tenants');
    assert.equal(rows[0].gateway_url, second.url);
  } finally {
    await second.close();
  }
});

// ---------------------------------------------------------------------------
test('resolve: a person\'s answer reaches the gateway', async () => {
  await fresh(() => ({ decision: 'escalate', code: 'POLICY_ESCALATE', reason: 'needs a person' }));
  const v = await client.check({ ...writeCall, companyId });
  const r = await client.resolve({ companyId, traceId: v.traceId, outcome: 'approved', by: 'user:u1', reason: 'Checked' });
  assert.equal(r.synced, true);
  const call = stub.callsTo('POST', `/api/v1/decisions/${v.traceId}/resolve`)[0];
  assert.deepEqual({ outcome: call.body.outcome, by: call.body.by }, { outcome: 'approved', by: 'user:u1' });
  const { rows: [row] } = await pool.query('SELECT outcome, resolved_by, resolve_synced_at FROM gateway_decisions WHERE trace_id = $1', [v.traceId]);
  assert.equal(row.outcome, 'approved');
  assert.ok(row.resolve_synced_at);
});

test('resolve: an answer given while the gateway is down is delivered later', async () => {
  await fresh(() => ({ decision: 'escalate', code: 'POLICY_ESCALATE', reason: 'needs a person' }));
  const v = await client.check({ ...writeCall, companyId });
  stub.down = true;
  const r = await client.resolve({ companyId, traceId: v.traceId, outcome: 'rejected', by: 'user:u1' });
  assert.equal(r.synced, false, 'not delivered yet');
  let { rows: [row] } = await pool.query('SELECT outcome, resolve_synced_at, resolve_error FROM gateway_decisions WHERE trace_id = $1', [v.traceId]);
  assert.equal(row.outcome, 'rejected', 'but the answer itself is kept');
  assert.equal(row.resolve_synced_at, null);
  assert.ok(row.resolve_error);

  stub.down = false;
  const delivered = await client.flushPendingResolves(companyId);
  assert.equal(delivered, 1);
  ({ rows: [row] } = await pool.query('SELECT resolve_synced_at, resolve_error FROM gateway_decisions WHERE trace_id = $1', [v.traceId]));
  assert.ok(row.resolve_synced_at);
  assert.equal(row.resolve_error, null);
  assert.equal(stub.resolved.get(v.traceId).outcome, 'rejected');
});

test('resolve: with no gateway or no trace it does nothing', async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  client._reset();
  assert.equal((await client.resolve({ companyId, traceId: 'x', outcome: 'approved', by: 'u' })).skipped, true);
  await fresh();
  assert.equal((await client.resolve({ companyId, traceId: null, outcome: 'approved', by: 'u' })).skipped, true);
});

// ---------------------------------------------------------------------------
test('counts: allowed, blocked and waiting, and waiting clears when answered', async () => {
  let n = 0;
  await fresh(() => {
    n += 1;
    if (n <= 3) return { decision: 'allow', code: 'ALLOWED', reason: 'ok' };
    if (n === 4) return { decision: 'deny', code: 'POLICY_DENY', reason: 'no' };
    return { decision: 'escalate', code: 'POLICY_ESCALATE', reason: 'ask' };
  });
  for (let i = 0; i < 6; i++) await client.check({ ...writeCall, companyId });
  let c = await client.getCounts(companyId);
  assert.deepEqual({ allowed: c.allowed, blocked: c.blocked, waiting: c.waiting, total: c.total }, { allowed: 3, blocked: 1, waiting: 2, total: 6 });
  const { rows } = await pool.query("SELECT trace_id FROM gateway_decisions WHERE decision = 'escalate' LIMIT 1");
  await client.resolve({ companyId, traceId: rows[0].trace_id, outcome: 'approved', by: 'u' });
  c = await client.getCounts(companyId);
  assert.equal(c.waiting, 1);
  const list = await client.listDecisions(companyId, { decision: 'escalate' });
  assert.equal(list.length, 2);
});

test('status reports reachability, fail mode and the tenant link', async () => {
  await fresh();
  await client.check({ ...readCall, companyId });
  let s = await client.getStatus(companyId);
  assert.equal(s.enabled, true);
  assert.equal(s.reachable, true);
  assert.equal(s.failMode, 'closed');
  assert.equal(s.tenant.tenantId, companyId);
  assert.equal(s.tenant.current, true);
  assert.equal(JSON.stringify(s).includes('sag_agent_'), false, 'no key ever appears in a status');
  assert.equal(JSON.stringify(s).includes('pk_test'), false);

  stub.down = true;
  client._reset();
  s = await client.getStatus(companyId);
  assert.equal(s.reachable, false);
});
