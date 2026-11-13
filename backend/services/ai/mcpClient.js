/**
 * Talking to a connected MCP server.
 *
 * The counterpart to mcp/server.js: that exposes this ERP's tools to outside
 * clients, this connects outward to somebody else's server and calls theirs.
 * Remote transports only — a local/stdio server would mean launching a
 * third-party process on a shared application server, which needs OS-level
 * sandboxing that does not exist here yet, so it is refused rather than
 * half-supported.
 *
 * Every outbound URL — the MCP endpoint itself and, for OAuth connections, the
 * token endpoint — goes through credentialVault.checkEgress first. That is the
 * same gate call_external_api uses, and it exists because "let the AI connect
 * to a URL a user pasted" is otherwise a fully general way to make this server
 * fetch its own cloud metadata endpoint on request.
 *
 * Connections are made per operation and closed after. An MCP session held open
 * across requests would be faster, but a pooled long-lived session belonging to
 * no particular request is a much worse thing to get wrong — this is not a hot
 * path, and every call here is one a human just approved.
 */

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const vault = require('./credentialVault');
const mcpOAuth = require('./mcpOAuth');

const CLIENT_INFO = { name: 'qira-erp', version: '1.0.0' };
const CONNECT_TIMEOUT_MS = 20000;
const CALL_TIMEOUT_MS = 60000;

/**
 * Refuse anything checkEgress would refuse, with the connection's own name in
 * the message. `allowed_hosts` here is the endpoint's own host: a connection is
 * permitted to talk to the server it IS, and nowhere else.
 */
function assertEgressAllowed(urlString, label) {
  let host;
  try {
    host = new URL(urlString).hostname.toLowerCase();
  } catch {
    throw new Error(`${label} is not a valid URL: "${urlString}".`);
  }
  const verdict = vault.checkEgress({ name: label, allowed_hosts: [host] }, urlString);
  if (!verdict.ok) throw new Error(verdict.reason);
  return verdict.url;
}

/** The hostname an api-key credential for this endpoint should be locked to. */
function hostOf(urlString) {
  return new URL(urlString).hostname.toLowerCase();
}

async function authHeaders(connection) {
  if (connection.auth_type !== 'api_key' || !connection.credential_id) return {};
  const { secret } = await vault.getSecret(connection.credential_id);
  return { Authorization: `Bearer ${secret}` };
}

/**
 * Open a session, do one thing, close it.
 *
 * Streamable HTTP is the current transport; SSE is the older one plenty of
 * deployed servers still speak. Trying the modern one first and falling back
 * keeps "paste the URL and it works" true for both, rather than making the
 * person know which kind they are looking at.
 *
 * The fallback covers CONNECTING only, never the operation. Once a session is
 * established, a failure of `fn` is that operation's answer and is propagated
 * as-is. Retrying it on another transport would mean a tool that timed out
 * mid-write could be run a second time — the caller would see one failure and
 * the far end would have done the work twice.
 */
async function withSession(connection, fn) {
  const endpoint = connection.endpoint_url;
  if (!endpoint) {
    throw new Error(`"${connection.name}" has no endpoint URL yet, so there is nothing to connect to.`);
  }
  const url = assertEgressAllowed(endpoint, connection.name);

  const headers = await authHeaders(connection);
  const authProvider = connection.auth_type === 'oauth'
    ? mcpOAuth.providerFor(connection)
    : undefined;

  const attempts = [
    () => new StreamableHTTPClientTransport(url, {
      authProvider,
      requestInit: { headers, redirect: 'error' },
    }),
    () => new SSEClientTransport(url, {
      authProvider,
      requestInit: { headers, redirect: 'error' },
    }),
  ];

  let lastError;
  for (const makeTransport of attempts) {
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    let connected = false;
    try {
      await client.connect(makeTransport(), { timeout: CONNECT_TIMEOUT_MS });
      connected = true;
      return await fn(client);
    } catch (err) {
      lastError = err;
      // Past the handshake, this is the operation's own failure — surface it
      // rather than trying the next transport.
      if (connected) throw err;
      // An auth failure is a real answer, not a transport mismatch: retrying it
      // over a different transport produces the same 401 with a worse message.
      if (isAuthError(err)) throw authError(connection, err);
    } finally {
      await client.close().catch(() => {});
    }
  }
  throw new Error(`Could not reach "${connection.name}" at ${endpoint}: ${lastError?.message || 'unknown error'}`);
}

function isAuthError(err) {
  const message = String(err?.message || '');
  return err?.name === 'UnauthorizedError' || /\b401\b|unauthorized|invalid_token/i.test(message);
}

function authError(connection, err) {
  return new Error(
    connection.auth_type === 'oauth'
      ? `"${connection.name}" rejected the stored authorization (${err.message}). Reconnect it to authorize again.`
      : `"${connection.name}" rejected the API key (${err.message}). Check the key and reconnect.`
  );
}

/**
 * The server's own tool list. This is what a real connection replaces the
 * discovery-time `tools_preview` guess with.
 */
async function listTools(connection) {
  return withSession(connection, async (client) => {
    const result = await client.listTools();
    return (result?.tools || []).map((t) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
      // Advisory only. It is recorded because it is useful to show a person,
      // and deliberately NOT used to decide whether approval is needed — a
      // third-party server asserting its own tool is harmless is not something
      // this ERP can verify. See mcpTools.js.
      readOnlyHint: t.annotations?.readOnlyHint ?? null,
      title: t.annotations?.title || t.title || null,
    }));
  });
}

/** Call one tool, for real. */
async function callTool(connection, toolName, args) {
  return withSession(connection, async (client) => {
    const result = await client.callTool(
      { name: toolName, arguments: args || {} },
      undefined,
      { timeout: CALL_TIMEOUT_MS }
    );

    // MCP returns content blocks; the model wants something it can read. Text
    // is passed through, and anything else is described rather than dropped
    // silently, so "it returned an image" is visible instead of looking empty.
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content
      .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
      .join('\n')
      .trim();

    if (result?.isError) {
      throw new Error(text || `"${toolName}" reported an error.`);
    }
    return {
      ok: true,
      output: text || null,
      ...(result?.structuredContent ? { structured: result.structuredContent } : {}),
    };
  });
}

/** Reachability + auth check, used by the connect flow before saving. */
async function ping(connection) {
  const tools = await listTools(connection);
  return { ok: true, tools_count: tools.length, tools };
}

/**
 * Is this URL actually an MCP server?
 *
 * Used by discovery to tell a real endpoint from the documentation page that
 * describes it — the only conclusive test is whether it completes a handshake,
 * so that is the test. Never throws: a probe is a question, and "no" is a
 * perfectly good answer for the many URLs that are simply web pages.
 *
 * Short timeouts and no auth: several of these run concurrently while somebody
 * waits on a search, and an endpoint that needs credentials is still usefully
 * identified as an endpoint by the 401 it returns.
 */
async function probe(endpointUrl, { timeoutMs = 7000 } = {}) {
  try {
    assertEgressAllowed(endpointUrl, 'endpoint');
  } catch {
    return null; // not probeable — private, plaintext, or malformed
  }

  const connection = { id: 'probe', name: 'probe', endpoint_url: endpointUrl, auth_type: 'none' };
  try {
    const tools = await withTimeout(listTools(connection), timeoutMs);
    return { endpoint_url: endpointUrl, reachable: true, needs_auth: false, tools };
  } catch (err) {
    // A server demanding credentials has still proven it is a server.
    if (isAuthError(err)) {
      return { endpoint_url: endpointUrl, reachable: true, needs_auth: true, tools: [] };
    }
    return null;
  }
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('probe timed out')), ms); }),
  ]);
}

module.exports = {
  listTools,
  callTool,
  ping,
  probe,
  assertEgressAllowed,
  hostOf,
};
