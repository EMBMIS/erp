/**
 * Tools that reach outside the ERP: authenticated external API calls, and
 * ad-hoc sandboxed computation.
 *
 * These are the two capabilities that make an agent feel like a coworker rather
 * than a report generator — it can look something up in another system, and it
 * can compute something nobody wrote a tool for. They are also the two with the
 * largest blast radius, so both are narrowed deliberately:
 *
 * call_external_api
 *   The credential decides where it may go, not the model. Every request passes
 *   credentialVault.checkEgress(): HTTPS only, host allowlist, and private /
 *   loopback / link-local addresses refused (that last one is what stops an
 *   outbound-request tool from becoming an internal port scanner or a cloud
 *   metadata reader). For agent runs the credential must ALSO have been granted
 *   to that agent. The secret is injected server-side and is never visible to
 *   the model — it cannot leak the key by quoting its own arguments.
 *
 * execute_sandboxed_code
 *   The same vm sandbox custom tools run in (services/ai/sandbox.js): no
 *   require, no process, no filesystem, no network, read-only SQL through the
 *   nlQuery allowlist, a timeout and an output cap. It computes; it cannot act.
 */

const { runSandboxed } = require('./sandbox');
const vault = require('./credentialVault');

const MAX_RESPONSE_BYTES = 200_000;
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Where the credential's secret goes. Different services want it in different
 * places, and guessing wrong produces a 401 the model will misread as "no data".
 */
function applyAuth(headers, secret, style) {
  const copy = { ...headers };
  switch (style) {
    case 'x-api-key':
      copy['x-api-key'] = secret;
      break;
    case 'basic':
      copy.Authorization = `Basic ${Buffer.from(secret).toString('base64')}`;
      break;
    case 'none':
      break;
    case 'bearer':
    default:
      copy.Authorization = `Bearer ${secret}`;
  }
  return copy;
}

const externalTools = [
  {
    name: 'call_external_api',
    description:
      'Call an external HTTPS API using a credential stored in the ERP vault. The API key is injected server-side — you never see it and must not ask for it. The credential decides which hosts it may be sent to; a URL outside that list is refused. Use for looking things up in systems outside the ERP (payment providers, carriers, data services).',
    readOnly: false,
    // Leaves the building with a real credential. Confirmed in chat; in an agent
    // it also needs call_external_api in allowed_actions and `act` mode.
    highImpact: true,
    min_role: 'MANAGER',
    inputSchema: {
      type: 'object',
      properties: {
        credential: { type: 'string', description: 'Name of the stored credential to authenticate with' },
        url: { type: 'string', description: 'Full https:// URL. Must be on the credential\'s allowed hosts.' },
        method: { type: 'string', description: 'GET (default), POST, PUT, PATCH or DELETE' },
        body: { type: 'object', description: 'JSON request body, for methods that take one' },
        headers: { type: 'object', description: 'Extra request headers. The Authorization header is set from the credential and cannot be overridden.' },
        auth_style: { type: 'string', description: 'bearer (default) | x-api-key | basic | none' },
      },
      required: ['credential', 'url'],
    },
    handler: async (args, ctx = {}) => {
      const credential = await vault.getCredential(args.credential);
      if (!credential) throw new Error(`No credential named "${args.credential}". Ask an administrator to add it in AI Settings → Credentials.`);
      if (!credential.enabled) throw new Error(`Credential "${credential.name}" is disabled.`);

      // An agent may only use credentials explicitly granted to it. Chat runs
      // under a human who is present; an unattended agent is not, so its access
      // is enumerated rather than inherited.
      if (ctx.agentKey) {
        const granted = await vault.agentCredentials(ctx.agentKey);
        if (!granted.some((c) => c.id === credential.id)) {
          throw new Error(
            `Agent "${ctx.agentKey}" has not been granted the credential "${credential.name}". Grant it on the agent's configuration screen first.`
          );
        }
      }

      const egress = vault.checkEgress(credential, args.url);
      if (!egress.ok) throw new Error(egress.reason);

      const method = String(args.method || 'GET').toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        throw new Error(`Unsupported HTTP method "${method}".`);
      }

      const { secret } = await vault.getSecret(credential.id);

      // Caller-supplied headers first, so the auth header applied afterwards
      // cannot be overwritten by a model-chosen header of the same name.
      const headers = applyAuth(
        { Accept: 'application/json', ...(args.headers || {}) },
        secret,
        args.auth_style
      );
      if (args.body && method !== 'GET') headers['Content-Type'] = 'application/json';

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(egress.url.toString(), {
          method,
          headers,
          body: args.body && method !== 'GET' ? JSON.stringify(args.body) : undefined,
          signal: controller.signal,
          // Do not follow redirects: a 302 to an internal address would bypass
          // the egress check that was performed on the original URL.
          redirect: 'manual',
        });
      } catch (err) {
        throw new Error(err.name === 'AbortError' ? `The request to ${egress.url.host} timed out.` : `Request failed: ${err.message}`);
      } finally {
        clearTimeout(timer);
      }

      if (response.status >= 300 && response.status < 400) {
        throw new Error(
          `${egress.url.host} responded with a redirect (${response.status}) to "${response.headers.get('location') || 'an unknown location'}". Redirects are not followed, because the destination has not been checked against this credential's allowed hosts. Call the final URL directly.`
        );
      }

      const text = (await response.text()).slice(0, MAX_RESPONSE_BYTES);
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }

      return {
        status: response.status,
        ok: response.ok,
        host: egress.url.host,
        body,
        truncated: text.length >= MAX_RESPONSE_BYTES,
      };
    },
  },

  {
    name: 'execute_sandboxed_code',
    description:
      'Run a short piece of JavaScript in a sandbox to compute something no existing tool covers — reshaping data, arithmetic across results, filtering a large list down. The code has no filesystem, network or process access. It receives `input` and may call `await erp.sql(text, params)` for read-only SELECT queries. Return the result. Use this instead of doing long arithmetic yourself.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Function body. Receives `input` and `erp`; use `return` to produce the result.' },
        input: { type: 'object', description: 'Values available to the code as `input`' },
      },
      required: ['code'],
    },
    handler: async (args) => {
      const { validateSql, runReadOnly } = require('./nlQuery');
      const outcome = await runSandboxed({
        code: args.code,
        input: args.input || {},
        timeoutMs: 8000,
        capabilities: {
          sql: async (text, params) => {
            const validation = validateSql(String(text || ''));
            if (!validation.ok) throw new Error(`Query rejected: ${validation.reason}`);
            return runReadOnly(validation.sql, Array.isArray(params) ? params.slice(0, 32) : []);
          },
        },
      });
      if (!outcome.ok) throw new Error(outcome.error);
      return { result: outcome.result, logs: outcome.logs, duration_ms: outcome.duration_ms };
    },
  },
];

module.exports = { externalTools };
