/**
 * A stand-in for EMBMIS Gateway's v1 API, for tests of the Business OS client.
 *
 * It implements just enough of docs/openapi.yaml in the gateway repo: tenants, agents (with rotate),
 * decide (verdict supplied by the test), resolve, health. Every request is recorded in `calls`.
 */
const http = require('http');

async function startStubGateway({ platformKey = 'pk_test', decide } = {}) {
  const state = {
    calls: [],
    tenants: new Map(), // tenantId -> { projectId, agents: Map(name -> { agentId, key }) }
    keys: new Map(),    // key -> tenantId
    seq: 0,
    down: false,        // refuse connections' worth of behaviour: respond 503
    slowMs: 0,
    resolved: new Map(),
    decide: decide || (() => ({ decision: 'allow', code: 'ALLOWED', reason: 'ok' })),
  };

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url, 'http://x');
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
    state.calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, bearer });

    const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (state.slowMs) await new Promise((r) => setTimeout(r, state.slowMs));
    if (state.down) return send(503, { error: 'down', code: 'INTERNAL_ERROR' });

    if (req.method === 'GET' && url.pathname === '/api/v1/health') return send(200, { ok: true, version: '1.0.0', mode: 'enforce' });

    let m = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)$/);
    if (m && req.method === 'PUT') {
      if (bearer !== platformKey) return send(401, { error: 'bad platform key', code: 'INVALID_PLATFORM_KEY' });
      const id = decodeURIComponent(m[1]);
      let t = state.tenants.get(id);
      const created = !t;
      if (!t) { t = { projectId: `proj_${id.slice(0, 6)}`, agents: new Map() }; state.tenants.set(id, t); }
      return send(created ? 201 : 200, { tenantId: id, projectId: t.projectId, created });
    }

    m = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/agents$/);
    if (m && req.method === 'POST') {
      if (bearer !== platformKey) return send(401, { error: 'bad platform key', code: 'INVALID_PLATFORM_KEY' });
      const id = decodeURIComponent(m[1]);
      const t = state.tenants.get(id);
      if (!t) return send(404, { error: 'no tenant', code: 'TENANT_NOT_FOUND' });
      const existing = t.agents.get(body.name);
      const rotate = url.searchParams.get('rotate') === 'true';
      if (existing && !rotate) return send(409, { error: 'exists', code: 'AGENT_EXISTS' });
      if (existing) state.keys.delete(existing.key);
      const key = `sag_agent_stub_${++state.seq}`;
      const agent = { agentId: existing?.agentId || `ag_${state.seq}`, key };
      t.agents.set(body.name, agent);
      state.keys.set(key, id);
      return send(existing ? 200 : 201, { agentId: agent.agentId, name: body.name, role: body.role, key });
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/decide') {
      const tenant = state.keys.get(bearer);
      if (!tenant) return send(401, { error: 'bad agent key', code: 'INVALID_AGENT_KEY' });
      const verdict = state.decide(body, { tenant });
      state.seq += 1;
      return send(200, {
        traceId: `trace-${state.seq}`, riskScore: 10, riskFactors: [], matchedPolicy: null,
        auditId: `audit-${state.seq}`, auditHash: `hash-${state.seq}`, latencyMs: 1.2, ...verdict,
      });
    }

    m = url.pathname.match(/^\/api\/v1\/decisions\/([^/]+)\/resolve$/);
    if (m && req.method === 'POST') {
      if (!state.keys.get(bearer)) return send(401, { error: 'bad agent key', code: 'INVALID_AGENT_KEY' });
      const traceId = decodeURIComponent(m[1]);
      if (state.resolved.has(traceId)) return send(409, { error: 'already', code: 'ALREADY_RESOLVED' });
      state.resolved.set(traceId, body);
      return send(200, { traceId, outcome: body.outcome, by: body.by, auditId: 'a', auditHash: 'h' });
    }

    send(404, { error: 'not found', code: 'NOT_FOUND' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${server.address().port}`;
  state.close = () => new Promise((resolve) => server.close(resolve));
  state.callsTo = (method, pathStart) => state.calls.filter((c) => c.method === method && c.path.startsWith(pathStart));
  return state;
}

module.exports = { startStubGateway };
