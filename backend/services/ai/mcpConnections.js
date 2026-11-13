/**
 * Connected MCP servers — the record, and the operations on it.
 *
 * A connection goes through a small lifecycle, and the statuses are the point:
 *
 *   pending_auth  it has an endpoint but no working credentials yet. Its tools
 *                 are NOT in the catalogue.
 *   connected     a real handshake succeeded and tools_cache holds the server's
 *                 own tools/list answer. Only now is anything callable.
 *   error         it was connected and then stopped working (revoked key,
 *                 expired grant, endpoint moved). last_error says what happened,
 *                 and the tools stop being offered rather than failing mid-call.
 *   disconnected  switched off by a person.
 *
 * The distinction that matters: nothing reaches the AI until a real handshake
 * has happened. "Connected" here means connected, not "someone typed a URL" —
 * that was the phase-1 behaviour this replaces.
 */

const { pool } = require('../../config/database');
const vault = require('./credentialVault');
const mcpClient = require('./mcpClient');
const mcpTools = require('./mcpTools');

const PUBLIC_COLUMNS = `id, name, description, url_or_package, endpoint_url, category,
       slug, auth_type, credential_id, tools_cache, tools_preview, tools_synced_at,
       last_error, status, created_at`;

async function get(id) {
  const { rows } = await pool.query(`SELECT * FROM mcp_connections WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function getOrThrow(id) {
  const row = await get(id);
  if (!row) throw new Error('That connection was not found.');
  return row;
}

async function list() {
  const { rows } = await pool.query(
    `SELECT ${PUBLIC_COLUMNS} FROM mcp_connections ORDER BY created_at DESC`
  );
  return rows;
}

/**
 * Record a server someone wants to connect.
 *
 * Creates it in `pending_auth` — with an endpoint, a slug, and nothing else.
 * It deliberately does not verify reachability here: for an OAuth server the
 * handshake cannot succeed until authorization has happened, so failing at this
 * point would make the normal flow look broken. Verification is `syncTools`.
 */
async function connect({
  name, url_or_package, endpoint_url, description, category, tools_preview, auth_type, userId,
}) {
  const cleanName = String(name || '').trim().slice(0, 160);
  if (!cleanName) throw new Error('A name is required to connect a server.');

  const authType = ['none', 'api_key', 'oauth'].includes(auth_type) ? auth_type : 'none';

  // The endpoint is what will actually be connected to, so it is validated now
  // rather than at first use — a bad URL should be refused while the person is
  // still looking at the form they typed it into.
  const endpoint = String(endpoint_url || '').trim();
  if (!endpoint) {
    throw new Error('An endpoint URL is required — this is the server\'s MCP address, not its documentation page.');
  }
  mcpClient.assertEgressAllowed(endpoint, cleanName);

  const slug = await mcpTools.allocateSlug(cleanName);

  const { rows } = await pool.query(
    `INSERT INTO mcp_connections
       (name, url_or_package, endpoint_url, description, category, tools_preview,
        slug, auth_type, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'pending_auth',$9)
     RETURNING ${PUBLIC_COLUMNS}`,
    [
      cleanName,
      String(url_or_package || endpoint).slice(0, 500),
      endpoint,
      description ? String(description).slice(0, 2000) : null,
      category ? String(category).slice(0, 80) : null,
      JSON.stringify(Array.isArray(tools_preview) ? tools_preview.slice(0, 10).map(String) : []),
      slug,
      authType,
      userId || null,
    ]
  );
  return rows[0];
}

/**
 * Attach an API key to a connection.
 *
 * The vault entry's allowed_hosts is derived from the endpoint rather than
 * typed: an allowlist a person maintains by hand is one they can get wrong, and
 * a key permitted to be sent somewhere other than the server it belongs to is
 * the exact failure the allowlist exists to prevent.
 */
async function attachApiKey(id, apiKey, userId) {
  const connection = await getOrThrow(id);
  if (!connection.endpoint_url) throw new Error('Set the endpoint URL before adding a key.');
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('An API key is required.');

  const host = mcpClient.hostOf(connection.endpoint_url);
  const credential = await vault.createCredential(
    {
      name: `MCP ${connection.name}`.slice(0, 80),
      description: `Access token for the "${connection.name}" MCP server.`,
      provider: 'http',
      secret: key,
      base_url: connection.endpoint_url,
      allowed_hosts: [host],
    },
    userId
  );

  await pool.query(
    `UPDATE mcp_connections SET auth_type = 'api_key', credential_id = $2 WHERE id = $1`,
    [id, credential.id]
  );
  return credential;
}

/**
 * Do the real handshake and record what the server says it can do.
 *
 * This is the only thing that can move a connection to `connected`, and so the
 * only thing that can put a third-party tool in front of the AI. A failure is
 * stored rather than only thrown, because the person who needs to see it is
 * usually looking at the connection list, not at the response to this call.
 */
async function syncTools(id) {
  const connection = await getOrThrow(id);
  try {
    const tools = await mcpClient.listTools(connection);
    await pool.query(
      `UPDATE mcp_connections
          SET tools_cache = $2::jsonb, tools_synced_at = CURRENT_TIMESTAMP,
              status = 'connected', last_error = NULL
        WHERE id = $1`,
      [id, JSON.stringify(tools)]
    );
    return { tools_count: tools.length, tools };
  } catch (err) {
    await pool.query(
      `UPDATE mcp_connections SET status = 'error', last_error = $2 WHERE id = $1`,
      [id, String(err.message).slice(0, 2000)]
    );
    throw err;
  }
}

/**
 * Stop offering this server's tools.
 *
 * Kept as a status change rather than a delete: the tools_cache and the audit
 * trail of what was called through it stay meaningful, and reconnecting does
 * not have to re-derive a slug that agent configurations may still reference.
 */
async function disconnect(id) {
  const { rows } = await pool.query(
    `UPDATE mcp_connections SET status = 'disconnected' WHERE id = $1 RETURNING id`,
    [id]
  );
  if (!rows.length) throw new Error('That connection was not found.');
}

module.exports = {
  get,
  getOrThrow,
  list,
  connect,
  attachApiKey,
  syncTools,
  disconnect,
};
