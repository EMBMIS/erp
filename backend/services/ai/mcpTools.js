/**
 * Tools from connected MCP servers, as catalogue entries.
 *
 * The third source in services/ai/toolCatalog.js, alongside the built-in
 * registry and user-authored tools. Everything downstream — the chat loop, both
 * agent runners, the audit log — goes through the catalogue, so appearing here
 * is all it takes for a third-party tool to become callable, and it is also the
 * one place to state what such a tool is allowed to be.
 *
 * Two rules, and neither is negotiable by the server on the other end:
 *
 *   readOnly: false, highImpact: true — ALWAYS.
 *
 * MCP tools carry an optional `readOnlyHint` annotation, and it is recorded (it
 * is worth showing a person) but never acted on. A hint is the server's claim
 * about its own behaviour; this ERP cannot verify it, the server can change what
 * a tool does without telling anyone, and the cost of believing a wrong claim is
 * an unreviewed third-party write executed unattended. So every tool from every
 * connected server is treated as a real action requiring a human — that is what
 * makes "connect a server" a safe thing to click.
 *
 * Names are `mcp_<slug>_<tool>`. The slug is assigned once per connection and is
 * unique (see migration 123): agent blueprints record the tool names they may
 * call, so a name that drifted would quietly unbind them.
 */

const { pool } = require('../../config/database');
const mcpClient = require('./mcpClient');

const PREFIX = 'mcp_';
// OpenAI's function-name limit. Names are built to fit rather than truncated
// after the fact, so a long tool name loses its own tail and never the slug
// that identifies which server it belongs to.
const MAX_NAME = 64;

function isMcpToolName(name) {
  return typeof name === 'string' && name.startsWith(PREFIX);
}

/** A slug candidate from a connection's display name. */
function slugify(name) {
  const base = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24)
    .replace(/_+$/g, '');
  return base || 'server';
}

/**
 * A slug nobody else is using. Called once, when a connection is first given a
 * real endpoint — not on every listing, where a shifting slug would rename
 * tools out from under saved agent configurations.
 */
async function allocateSlug(displayName, client = pool) {
  const base = slugify(displayName);
  for (let n = 1; n <= 50; n += 1) {
    const candidate = n === 1 ? base : `${base.slice(0, 20)}_${n}`;
    const { rows } = await client.query('SELECT 1 FROM mcp_connections WHERE slug = $1', [candidate]);
    if (!rows.length) return candidate;
  }
  return `${base.slice(0, 15)}_${Date.now().toString(36).slice(-6)}`;
}

function toolName(slug, remoteName) {
  const prefix = `${PREFIX}${slug}_`;
  return `${prefix}${String(remoteName).replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, MAX_NAME);
}

/**
 * Every tool of every connected server, in built-in-tool shape.
 *
 * Reads the cached tool list rather than calling each server: this runs on
 * every catalogue read (so, every chat turn), and a slow or unreachable server
 * must not stall the assistant's tool list. The cache is refreshed by an
 * explicit sync — see routes/ai-mcp.js.
 */
async function listRuntimeTools() {
  const { rows } = await pool.query(
    `SELECT id, name, slug, endpoint_url, auth_type, credential_id, tools_cache
       FROM mcp_connections
      WHERE status = 'connected' AND slug IS NOT NULL AND endpoint_url IS NOT NULL`
  );

  const tools = [];
  for (const connection of rows) {
    const cached = Array.isArray(connection.tools_cache) ? connection.tools_cache : [];
    for (const remote of cached) {
      if (!remote?.name) continue;
      tools.push({
        name: toolName(connection.slug, remote.name),
        description: `[${connection.name}] ${remote.description || remote.name}`,
        inputSchema: remote.inputSchema || { type: 'object', properties: {} },
        readOnly: false,   // never inferred from the server's own hint — see above
        highImpact: true,  // always confirmable / always escalated
        mcp: true,
        mcpConnectionId: connection.id,
        mcpServerName: connection.name,
        mcpRemoteTool: remote.name,
        readOnlyHint: remote.readOnlyHint ?? null,
        handler: (args) => mcpClient.callTool(connection, remote.name, args),
      });
    }
  }
  return tools;
}

module.exports = {
  listRuntimeTools,
  isMcpToolName,
  allocateSlug,
  slugify,
  toolName,
};
