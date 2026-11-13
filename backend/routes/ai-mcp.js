/**
 * MCP server discovery and connections.
 *
 * Connecting a server puts third-party tools in front of the AI, so everything
 * that changes a connection is ADMIN/MANAGER — the same gate as ai-builder.js,
 * for a stronger reason. Reading the list of what is connected is not a
 * privilege and only needs auth.
 *
 * The OAuth callback is deliberately NOT here: it arrives as an unauthenticated
 * browser redirect from the provider, and this router requires a token on every
 * route. See routes/mcp-oauth-callback.js.
 */

const express = require('express');
const router = express.Router();
const { auth, requireManagerOrAdmin } = require('../middleware/auth');
const discovery = require('../services/ai/mcpDiscovery');
const connections = require('../services/ai/mcpConnections');
const mcpOAuth = require('../services/ai/mcpOAuth');

router.use(auth);

const handle = (fn) => async (req, res) => {
  try {
    const result = await fn(req, res);
    if (!res.headersSent) res.json({ success: true, ...result });
  } catch (error) {
    console.error(`MCP route error (${req.method} ${req.path}):`, error.message);
    if (!res.headersSent) res.status(400).json({ success: false, error: error.message });
  }
};

// POST /api/ai/discover-mcp { query }
router.post('/discover-mcp', requireManagerOrAdmin, handle(async (req) => ({
  data: await discovery.discover(req.body?.query),
})));

/**
 * GET /api/ai/mcp-catalog — the curated list, for browsing rather than
 * searching. No web search, no model call, no probing: this is a static file
 * (services/ai/mcpRegistry.js) whose remote endpoints have each been verified
 * by scripts/verify-mcp-registry.js, so it answers instantly and is the
 * quickest path to a working connection.
 */
router.get('/mcp-catalog', handle(async () => {
  const { REGISTRY, CATEGORIES } = require('../services/ai/mcpRegistry');
  return { data: { servers: REGISTRY, categories: CATEGORIES } };
}));

// POST /api/ai/connect-mcp { name, endpoint_url, url_or_package, description, category, tools_preview, auth_type }
router.post('/connect-mcp', requireManagerOrAdmin, handle(async (req) => {
  const connection = await connections.connect({ ...(req.body || {}), userId: req.user.id });
  return { data: connection };
}));

// GET /api/ai/mcp-connections
router.get('/mcp-connections', handle(async () => ({
  data: await connections.list(),
})));

// POST /api/ai/mcp-connections/:id/api-key { api_key }
router.post('/mcp-connections/:id/api-key', requireManagerOrAdmin, handle(async (req) => {
  await connections.attachApiKey(req.params.id, req.body?.api_key, req.user.id);
  return {};
}));

/**
 * POST /api/ai/mcp-connections/:id/oauth/authorize-url
 *
 * Returns a URL for the browser to visit, rather than redirecting: the caller
 * is an XHR from the tool library, and a 302 on an XHR would be followed by
 * fetch instead of by the person who needs to see the consent screen.
 */
router.post('/mcp-connections/:id/oauth/authorize-url', requireManagerOrAdmin, handle(async (req) => {
  const connection = await connections.getOrThrow(req.params.id);
  return { data: await mcpOAuth.beginAuthorization(connection) };
}));

// POST /api/ai/mcp-connections/:id/sync-tools
router.post('/mcp-connections/:id/sync-tools', requireManagerOrAdmin, handle(async (req) => ({
  data: await connections.syncTools(req.params.id),
})));

// DELETE /api/ai/mcp-connections/:id
router.delete('/mcp-connections/:id', requireManagerOrAdmin, handle(async (req) => {
  await connections.disconnect(req.params.id);
  return {};
}));

module.exports = router;
