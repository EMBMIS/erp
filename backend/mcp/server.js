#!/usr/bin/env node
/**
 * Simeli ERP — Model Context Protocol server.
 *
 * Exposes the exact same tool registry (services/ai/toolRegistry.js) used by
 * the in-app function-calling agent, over MCP stdio transport. This is what
 * lets an external AI client — Claude Desktop, another agent framework, any
 * MCP-speaking tool — read and (in a guarded, draft-only way) act on this ERP
 * directly, without going through the web UI.
 *
 * Same guardrails as the in-app agent, because it is literally the same
 * registry: read-mostly tools, one DRAFT-only write tool, every call logged to
 * ai_audit_log (actor='mcp').
 *
 * Run standalone:
 *   node mcp/server.js
 *
 * Configure in an MCP client (e.g. Claude Desktop's claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "qira-erp": {
 *         "command": "node",
 *         "args": ["<absolute-path>/backend/mcp/server.js"],
 *         "env": { "MCP_ERP_USER_ID": "<a real users.id to attribute actions to>" }
 *       }
 *     }
 *   }
 *
 * MCP_ERP_USER_ID should be a real row in `users` (ideally a dedicated
 * "AI Agent" service account) so every MCP-driven write is traceable to a real
 * identity in ai_audit_log and in *_status_history, exactly like a human user.
 */

const path = require('path');

// MCP stdio transport requires stdout to carry ONLY JSON-RPC messages. Several
// existing modules (db pool, services) call console.log for human-readable
// server logs, which would corrupt the protocol stream if left on stdout. This
// process therefore redirects console.log/info/warn to stderr, globally, before
// requiring anything else. console.error already goes to stderr.
console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);
console.warn = (...args) => console.error(...args);

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

// The catalogue, not the raw registry: an MCP client should see the tools this
// installation actually has, including ones its users built, and should respect
// the same enable/disable configuration as the in-app assistant.
const { getMcpTools, executeTool } = require('../services/ai/toolCatalog');
const { pool } = require('../config/database');

async function resolveUserId() {
  if (process.env.MCP_ERP_USER_ID) return process.env.MCP_ERP_USER_ID;
  // Fall back to the earliest admin so MCP writes are still attributable if the
  // operator hasn't configured a dedicated service account yet.
  const r = await pool.query("SELECT id FROM users WHERE role = 'ADMIN' ORDER BY created_at LIMIT 1");
  return r.rows[0]?.id || null;
}

async function main() {
  const userId = await resolveUserId();
  if (!userId) {
    console.error('[qira-erp mcp] Warning: no MCP_ERP_USER_ID set and no ADMIN user found — writes will be unattributed.');
  }

  const server = new Server(
    { name: 'qira-erp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await getMcpTools({ role: 'ADMIN' })).map((t) => ({
      name: t.name,
      description: t.description + (t.readOnly ? '' : ' (Creates a DRAFT record only — requires human approval.)'),
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await executeTool(name, args || {}, { userId, actor: 'mcp', role: 'ADMIN' });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[qira-erp mcp] server running on stdio');
}

main().catch((err) => {
  console.error('[qira-erp mcp] fatal error:', err);
  process.exit(1);
});
