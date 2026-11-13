/**
 * EMBMIS Gateway client.
 *
 * Business OS never executes an AI action on its own say-so alone: before a
 * tool runs, this client asks EMBMIS Gateway (a separate product, reached only
 * over its HTTP API) whether the action may happen. No gateway code lives in
 * this repository.
 *
 *   EMBMIS_GATEWAY_URL               e.g. https://embmis.com/gateway. Unset = gateway OFF and
 *                                    behaviour is exactly what it was before.
 *   EMBMIS_GATEWAY_PLATFORM_KEY      provisions tenants and agents (never used to decide)
 *   EMBMIS_GATEWAY_CONSOLE_URL       where "Open Gateway console" points
 *   EMBMIS_GATEWAY_FAIL_MODE         closed (default) | open — what writes do when the gateway is unreachable
 *   EMBMIS_GATEWAY_TIMEOUT_MS        per-request timeout, default 3000
 *
 * Each company is a gateway tenant. Its "simeli" agent key is provisioned the
 * first time it is needed and stored encrypted (AES-256-GCM, AI_VAULT_KEY) in
 * gateway_tenants. Every verdict is recorded in gateway_decisions.
 *
 * Unreachable gateway: reads continue; a write or payment waits for a person
 * (closed) or runs (open). It never throws into the caller — a verdict is
 * always returned.
 */

const { pool } = require('../../config/database');
const companyContext = require('../companyContext');
const classify = require('./classify');

const DEFAULT_TIMEOUT_MS = 3000;
const HEALTH_CACHE_MS = 10_000;

// ---------------------------------------------------------------------------
// Configuration (read on every call so tests and operators can change it live)
// ---------------------------------------------------------------------------
function config() {
  const url = (process.env.EMBMIS_GATEWAY_URL || '').trim().replace(/\/+$/, '');
  const failMode = String(process.env.EMBMIS_GATEWAY_FAIL_MODE || 'closed').toLowerCase() === 'open' ? 'open' : 'closed';
  const timeoutMs = Math.max(200, Number(process.env.EMBMIS_GATEWAY_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  return {
    url,
    platformKey: (process.env.EMBMIS_GATEWAY_PLATFORM_KEY || '').trim(),
    consoleUrl: (process.env.EMBMIS_GATEWAY_CONSOLE_URL || '').trim() || url,
    failMode,
    timeoutMs,
  };
}

function isEnabled() {
  return !!config().url;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
class GatewayUnreachable extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'GatewayUnreachable';
    this.cause = cause;
  }
}

/** Resolves with { status, body }. Rejects with GatewayUnreachable on network error, timeout or a 5xx. */
async function request(method, path, { key, body } = {}) {
  const cfg = config();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let res;
  try {
    res = await fetch(cfg.url + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        Accept: 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    throw new GatewayUnreachable(
      err.name === 'AbortError' ? `no answer within ${cfg.timeoutMs} ms` : (err.cause?.code || err.message),
      err
    );
  } finally {
    clearTimeout(timer);
  }
  let parsed = null;
  try { parsed = await res.json(); } catch { /* non-JSON body */ }
  if (res.status >= 500) {
    throw new GatewayUnreachable(`gateway answered ${res.status}${parsed?.code ? ` ${parsed.code}` : ''}`);
  }
  return { status: res.status, body: parsed };
}

// ---------------------------------------------------------------------------
// Company scope
// ---------------------------------------------------------------------------
async function resolveCompany(companyId) {
  return companyId || companyContext.currentCompanyId() || companyContext.getDefaultCompanyId();
}

/** Run `fn` with the company as the ambient scope so pool.query is isolated to it. */
async function inCompany(companyId, fn) {
  const id = await resolveCompany(companyId);
  return companyContext.runWithCompany(id, () => fn(id));
}

// ---------------------------------------------------------------------------
// Tenant + agent key provisioning
// ---------------------------------------------------------------------------
const keyCache = new Map(); // companyId -> { key, url, at }
const KEY_CACHE_MS = 5 * 60_000;

function vault() {
  return require('../ai/credentialVault');
}

function storeKey(client, companyId, link, key) {
  const enc = vault().encrypt(key);
  return client.query(
    `INSERT INTO gateway_tenants (company_id, gateway_url, tenant_id, project_id, agent_id, agent_name, key_cipher, key_iv, key_tag, key_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (company_id) DO UPDATE
       SET gateway_url = EXCLUDED.gateway_url, tenant_id = EXCLUDED.tenant_id, project_id = EXCLUDED.project_id,
           agent_id = EXCLUDED.agent_id, agent_name = EXCLUDED.agent_name,
           key_cipher = EXCLUDED.key_cipher, key_iv = EXCLUDED.key_iv, key_tag = EXCLUDED.key_tag, key_id = EXCLUDED.key_id,
           updated_at = CURRENT_TIMESTAMP`,
    [companyId, config().url, link.tenantId, link.projectId, link.agentId, link.agentName, enc.cipher, enc.iv, enc.tag, enc.keyId]
  );
}

function readKey(row) {
  return vault().decryptParts({ cipher: row.key_cipher, iv: row.key_iv, tag: row.key_tag }, 'EMBMIS Gateway agent key');
}

class ProvisionError extends Error {
  constructor(message) { super(message); this.name = 'ProvisionError'; }
}

/** Create (or re-create) the company's tenant and agent. Serialised per company across processes. */
async function provision(companyId, { rotate = false } = {}) {
  const cfg = config();
  if (!cfg.platformKey) {
    throw new ProvisionError('EMBMIS_GATEWAY_PLATFORM_KEY is not set, so this company cannot be registered with the gateway.');
  }
  if (!vault().vaultStatus().configured) {
    throw new ProvisionError('AI_VAULT_KEY is not set, so there is nowhere safe to store the gateway agent key.');
  }

  return companyContext.withCompany(companyId, async (client) => {
    // Held until COMMIT: a second process provisioning the same company waits
    // here, then finds the row the first one wrote and uses it.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-tenant:${companyId}`]);

    if (!rotate) {
      const { rows } = await client.query('SELECT * FROM gateway_tenants WHERE company_id = $1', [companyId]);
      if (rows[0] && rows[0].gateway_url === cfg.url) return { key: readKey(rows[0]), link: rows[0] };
    }

    const { rows: [company] } = await client.query('SELECT name FROM companies WHERE id = $1', [companyId]);
    const name = company?.name || companyId;

    const t = await request('PUT', `/api/v1/tenants/${encodeURIComponent(companyId)}`, { key: cfg.platformKey, body: { name } });
    if (t.status === 401) throw new ProvisionError('The gateway rejected EMBMIS_GATEWAY_PLATFORM_KEY. Check it against SAG_PLATFORM_KEY_HASHES on the gateway.');
    if (t.status >= 400) throw new ProvisionError(`The gateway could not register this company: ${t.body?.error || t.status}`);

    const agentName = 'simeli';
    let a = await request('POST', `/api/v1/tenants/${encodeURIComponent(companyId)}/agents`, {
      key: cfg.platformKey, body: { name: agentName, role: 'erp-operator' },
    });
    if (a.status === 409 && a.body?.code === 'AGENT_EXISTS') {
      // The gateway has an agent whose key we no longer hold (lost row, new database). Replace the key.
      a = await request('POST', `/api/v1/tenants/${encodeURIComponent(companyId)}/agents?rotate=true`, {
        key: cfg.platformKey, body: { name: agentName, role: 'erp-operator' },
      });
    }
    if (a.status >= 400 || !a.body?.key) throw new ProvisionError(`The gateway could not create the ${agentName} agent: ${a.body?.error || a.status}`);

    const link = { tenantId: t.body.tenantId, projectId: t.body.projectId, agentId: a.body.agentId, agentName };
    await storeKey(client, companyId, link, a.body.key);
    return { key: a.body.key, link };
  });
}

const inflight = new Map(); // companyId -> Promise (one provisioning at a time per process)

async function agentKey(companyId, { forceRefresh = false, rotate = false } = {}) {
  const cfg = config();
  const cached = keyCache.get(companyId);
  if (!forceRefresh && !rotate && cached && cached.url === cfg.url && Date.now() - cached.at < KEY_CACHE_MS) return cached.key;

  const flightKey = `${companyId}:${rotate ? 'rotate' : 'get'}`;
  if (inflight.has(flightKey)) return inflight.get(flightKey);
  const p = (async () => {
    const { key } = await provision(companyId, { rotate });
    keyCache.set(companyId, { key, url: cfg.url, at: Date.now() });
    return key;
  })().finally(() => inflight.delete(flightKey));
  inflight.set(flightKey, p);
  return p;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------
async function record(companyId, d) {
  try {
    const { rows } = await inCompany(companyId, (id) => pool.query(
      `INSERT INTO gateway_decisions
         (company_id, source, user_id, tool_name, action, amount, currency, decision, code, reason, origin,
          trace_id, risk_score, risk_factors, matched_policy, audit_id, audit_hash, latency_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,$18)
       RETURNING id`,
      [id, d.source, d.userId ? String(d.userId) : null, d.tool, d.action, d.amount ?? null, d.currency ?? null,
        d.decision, d.code, d.reason ? String(d.reason).slice(0, 1000) : null, d.origin,
        d.traceId || null, Number.isFinite(d.riskScore) ? Math.round(d.riskScore) : null,
        JSON.stringify(d.riskFactors || []), d.matchedPolicy ? JSON.stringify(d.matchedPolicy) : null,
        d.auditId || null, d.auditHash || null, Number.isFinite(d.latencyMs) ? d.latencyMs : null]
    ));
    return rows[0]?.id || null;
  } catch (err) {
    // A bookkeeping failure must not turn a verdict into an outage.
    console.error('[gateway] could not record decision:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// check — the one call the rest of the ERP makes
// ---------------------------------------------------------------------------
/**
 * Ask the gateway whether an action may run.
 *
 * @param {object} p
 * @param {string} [p.companyId]
 * @param {string} [p.userId]
 * @param {string} p.source        'simeli' | 'agent:<key>'
 * @param {string} p.tool          tool name or agent action type
 * @param {object} [p.args]
 * @param {boolean} [p.readOnly]
 * @param {number} [p.amount]
 * @param {string} [p.currency]
 * @returns {Promise<{decision:'allow'|'deny'|'escalate', code:string, reason:string, traceId:string|null,
 *                    origin:'gateway'|'fallback'|'off', riskScore?:number, riskFactors?:object[], matchedPolicy?:object|null,
 *                    auditHash?:string|null, recordId?:string|null}>}  never rejects
 */
async function check(p) {
  if (!isEnabled()) return { decision: 'allow', code: 'GATEWAY_OFF', reason: 'EMBMIS Gateway is not configured.', traceId: null, origin: 'off' };

  let companyId;
  try { companyId = await resolveCompany(p.companyId); } catch { companyId = null; }

  const d = classify.describe({ name: p.tool, args: p.args || {}, readOnly: !!p.readOnly, amount: p.amount, currency: p.currency });
  const base = { source: p.source || 'simeli', userId: p.userId, tool: d.tool, action: d.action, amount: d.amount, currency: d.currency };

  let verdict;
  try {
    if (!companyId) throw new ProvisionError('No company is in scope for this request.');
    flushPendingResolves(companyId).catch(() => {});
    verdict = await decideOnce(companyId, d, p);
  } catch (err) {
    verdict = fallback(d, err);
  }

  const out = { ...verdict };
  out.recordId = await record(companyId, { ...base, ...out });
  return out;
}

async function decideOnce(companyId, d, p, attempt = 0) {
  let key = await agentKey(companyId);
  const body = {
    agentName: p.source || 'simeli',
    tool: d.tool,
    action: d.action,
    args: d.args,
    resource: d.resource,
    context: { tenantId: companyId, userId: p.userId ? String(p.userId) : undefined, amount: d.amount, currency: d.currency },
  };
  const r = await request('POST', '/api/v1/decide', { key, body });

  if (r.status === 401 && r.body?.code === 'INVALID_AGENT_KEY' && attempt === 0) {
    // The key was rotated elsewhere (or the gateway database was replaced). Mint a fresh one once.
    keyCache.delete(companyId);
    await agentKey(companyId, { rotate: true });
    return decideOnce(companyId, d, p, 1);
  }
  if (r.status !== 200 || !r.body || !['allow', 'deny', 'escalate'].includes(r.body.decision)) {
    throw new GatewayUnreachable(`gateway answered ${r.status}${r.body?.code ? ` ${r.body.code}` : ''}${r.body?.error ? `: ${r.body.error}` : ''}`);
  }
  const b = r.body;
  return {
    decision: b.decision, code: b.code, reason: b.reason, traceId: b.traceId || null, origin: 'gateway',
    riskScore: b.riskScore, riskFactors: b.riskFactors || [], matchedPolicy: b.matchedPolicy || null,
    auditId: b.auditId || null, auditHash: b.auditHash || null, latencyMs: b.latencyMs,
  };
}

/** The gateway could not give a verdict. Reads continue; writes wait for a person (closed) or run (open). */
function fallback(d, err) {
  const cfg = config();
  const why = err && err.message ? err.message : 'unknown error';
  noteError(why);
  if (d.action === 'READ') {
    return { decision: 'allow', code: 'GATEWAY_UNREACHABLE', reason: `EMBMIS Gateway could not be reached (${why}); reads continue.`, traceId: null, origin: 'fallback' };
  }
  if (cfg.failMode === 'open') {
    return { decision: 'allow', code: 'GATEWAY_UNREACHABLE_OPEN', reason: `EMBMIS Gateway could not be reached (${why}); fail mode is open, so this ran without a check.`, traceId: null, origin: 'fallback' };
  }
  return { decision: 'escalate', code: 'GATEWAY_UNREACHABLE', reason: `EMBMIS Gateway could not be reached (${why}), so this ${d.action === 'PAYMENT' ? 'payment' : 'change'} waits for a person.`, traceId: null, origin: 'fallback' };
}

// ---------------------------------------------------------------------------
// resolve — report a person's answer to an escalation
// ---------------------------------------------------------------------------
async function resolve({ companyId, traceId, outcome, by, reason }) {
  if (!isEnabled() || !traceId) return { synced: false, skipped: true };
  const id = await resolveCompany(companyId).catch(() => null);
  if (!id) return { synced: false, skipped: true };

  await inCompany(id, () => pool.query(
    `UPDATE gateway_decisions
        SET outcome = $2, resolved_by = $3, resolved_at = COALESCE(resolved_at, CURRENT_TIMESTAMP)
      WHERE trace_id = $1 AND resolve_synced_at IS NULL`,
    [traceId, outcome, String(by || 'unknown')]
  )).catch((err) => console.error('[gateway] could not store resolution:', err.message));

  return deliverResolve(id, { traceId, outcome, by: String(by || 'unknown'), reason });
}

async function deliverResolve(companyId, { traceId, outcome, by, reason }) {
  try {
    const key = await agentKey(companyId);
    const r = await request('POST', `/api/v1/decisions/${encodeURIComponent(traceId)}/resolve`, { key, body: { outcome, by, reason: reason || null } });
    // 409 ALREADY_RESOLVED means the gateway has it; that is success for our purposes.
    const ok = r.status === 200 || (r.status === 409 && r.body?.code === 'ALREADY_RESOLVED');
    await inCompany(companyId, () => pool.query(
      `UPDATE gateway_decisions SET resolve_synced_at = CASE WHEN $2 THEN CURRENT_TIMESTAMP ELSE NULL END, resolve_error = $3
        WHERE trace_id = $1`,
      [traceId, ok, ok ? null : (r.body?.error || `gateway answered ${r.status}`).slice(0, 500)]
    ));
    return { synced: ok, status: r.status, code: r.body?.code, auditHash: r.body?.auditHash };
  } catch (err) {
    await inCompany(companyId, () => pool.query(
      'UPDATE gateway_decisions SET resolve_error = $2 WHERE trace_id = $1', [traceId, String(err.message).slice(0, 500)]
    )).catch(() => {});
    return { synced: false, error: err.message };
  }
}

let flushing = false;
/** Deliver answers that could not be delivered when they were given. */
async function flushPendingResolves(companyId) {
  if (flushing || !isEnabled()) return 0;
  flushing = true;
  try {
    const { rows } = await inCompany(companyId, () => pool.query(
      `SELECT trace_id, outcome, resolved_by FROM gateway_decisions
        WHERE outcome IS NOT NULL AND resolve_synced_at IS NULL AND trace_id IS NOT NULL
        ORDER BY resolved_at ASC LIMIT 10`
    ));
    let done = 0;
    for (const row of rows) {
      const r = await deliverResolve(companyId, { traceId: row.trace_id, outcome: row.outcome, by: row.resolved_by || 'unknown' });
      if (r.synced) done += 1;
      else if (r.error) break; // gateway still down; try again next time
    }
    return done;
  } finally {
    flushing = false;
  }
}

// ---------------------------------------------------------------------------
// Status and summaries (Settings → AI Gateway, the Simeli panel)
// ---------------------------------------------------------------------------
let lastError = null;
let health = { at: 0, value: null };
function noteError(message) { lastError = { message, at: new Date().toISOString() }; }

async function probe() {
  const cfg = config();
  if (!cfg.url) return null;
  if (Date.now() - health.at < HEALTH_CACHE_MS && health.value) return health.value;
  let value;
  try {
    const r = await request('GET', '/api/v1/health');
    value = r.status === 200 && r.body?.ok ? { reachable: true, version: r.body.version, mode: r.body.mode } : { reachable: false, error: `health answered ${r.status}` };
  } catch (err) {
    value = { reachable: false, error: err.message };
  }
  health = { at: Date.now(), value };
  return value;
}

async function getStatus(companyId) {
  const cfg = config();
  const id = await resolveCompany(companyId).catch(() => null);
  const status = {
    enabled: !!cfg.url,
    gatewayUrl: cfg.url || null,
    consoleUrl: cfg.url ? cfg.consoleUrl : null,
    failMode: cfg.failMode,
    timeoutMs: cfg.timeoutMs,
    platformKeyConfigured: !!cfg.platformKey,
    vaultConfigured: vault().vaultStatus().configured,
    reachable: null, version: null, gatewayMode: null, error: null,
    tenant: null,
    lastError,
  };
  if (!cfg.url) return status;

  const h = await probe();
  status.reachable = h.reachable;
  status.version = h.version || null;
  status.gatewayMode = h.mode || null;
  status.error = h.error || null;

  if (id) {
    const { rows } = await inCompany(id, () => pool.query(
      'SELECT tenant_id, project_id, agent_name, gateway_url, created_at FROM gateway_tenants WHERE company_id = $1', [id]
    )).catch(() => ({ rows: [] }));
    status.tenant = rows[0]
      ? { tenantId: rows[0].tenant_id, projectId: rows[0].project_id, agentName: rows[0].agent_name, current: rows[0].gateway_url === cfg.url, since: rows[0].created_at }
      : null;
  }
  return status;
}

async function getCounts(companyId, { days = 30 } = {}) {
  const id = await resolveCompany(companyId);
  const { rows } = await inCompany(id, () => pool.query(
    `SELECT decision, origin, COUNT(*)::int AS n
       FROM gateway_decisions
      WHERE company_id = $1 AND created_at >= CURRENT_TIMESTAMP - ($2 || ' days')::interval
      GROUP BY decision, origin`, [id, String(days)]
  ));
  const out = { allowed: 0, blocked: 0, waiting: 0, unchecked: 0, total: 0, days };
  for (const r of rows) {
    out.total += r.n;
    if (r.origin === 'fallback') out.unchecked += r.n;
    if (r.decision === 'allow') out.allowed += r.n;
    else if (r.decision === 'deny') out.blocked += r.n;
    else out.waiting += r.n;
  }
  // "Waiting" is escalations nobody has answered yet.
  const { rows: [w] } = await inCompany(id, () => pool.query(
    `SELECT COUNT(*)::int AS n FROM gateway_decisions WHERE company_id = $1 AND decision = 'escalate' AND outcome IS NULL`, [id]
  ));
  out.waiting = w.n;
  return out;
}

async function listDecisions(companyId, { limit = 50, offset = 0, decision } = {}) {
  const id = await resolveCompany(companyId);
  const params = [id];
  let where = 'WHERE company_id = $1';
  if (['allow', 'deny', 'escalate'].includes(decision)) { params.push(decision); where += ` AND decision = $${params.length}`; }
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 200), Math.max(Number(offset) || 0, 0));
  const { rows } = await inCompany(id, () => pool.query(
    `SELECT id, source, user_id, tool_name, action, amount, currency, decision, code, reason, origin, trace_id,
            risk_score, risk_factors, matched_policy, audit_hash, latency_ms, outcome, resolved_by, resolved_at,
            resolve_synced_at, resolve_error, created_at
       FROM gateway_decisions ${where}
      ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params
  ));
  return rows;
}

/** Test seam: forget cached keys, health and errors. */
function _reset() { keyCache.clear(); inflight.clear(); health = { at: 0, value: null }; lastError = null; flushing = false; }

module.exports = {
  isEnabled, config, check, resolve, flushPendingResolves,
  getStatus, getCounts, listDecisions, provision,
  describe: classify.describe,
  GatewayUnreachable, ProvisionError, _reset,
};
