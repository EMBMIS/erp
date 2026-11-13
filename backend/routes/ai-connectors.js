/**
 * Native OAuth connectors — the control plane.
 *
 * Connecting a product puts its API in front of the assistant and stores an
 * OAuth application's secret, so everything that changes a connector is
 * ADMIN/MANAGER. Reading the provider list and what is connected is not a
 * privilege and only needs auth.
 *
 * No route here ever returns a client secret or a token; connectors.publicView
 * strips them, and there is deliberately no endpoint that reads one back.
 */

const express = require('express');
const router = express.Router();
const { auth, requireManagerOrAdmin } = require('../middleware/auth');
const connectors = require('../services/ai/connectors');
const { listProviders, getProvider, CATEGORIES } = require('../services/ai/connectorProviders');

router.use(auth);

const handle = (fn) => async (req, res) => {
  try {
    const result = await fn(req, res);
    if (!res.headersSent) res.json({ success: true, ...result });
  } catch (error) {
    console.error(`Connector route error (${req.method} ${req.path}):`, error.message);
    if (!res.headersSent) res.status(400).json({ success: false, error: error.message });
  }
};

/**
 * GET /api/connectors/providers — what can be connected.
 *
 * Includes the callback URL, because it has to be pasted into the provider's
 * console verbatim and a mismatch there is the most common reason a sign-in
 * fails with an error that does not explain itself.
 */
router.get('/providers', handle(async () => ({
  data: {
    providers: listProviders(),
    categories: CATEGORIES,
    redirect_uri: connectors.redirectUri(),
  },
})));

// GET /api/connectors — what is connected now
router.get('/', handle(async () => ({ data: await connectors.list() })));

// POST /api/connectors { provider, label, client_id, client_secret, account_info }
router.post('/', requireManagerOrAdmin, handle(async (req) => {
  const created = await connectors.create({ ...(req.body || {}), userId: req.user.id });
  return { data: created };
}));

/**
 * POST /api/connectors/:id/authorize-url
 *
 * Returns the URL rather than redirecting: the caller is an XHR, and a 302 on
 * an XHR is followed by fetch instead of by the person who needs to see the
 * provider's consent screen.
 */
router.post('/:id/authorize-url', requireManagerOrAdmin, handle(async (req) => ({
  data: { authorization_url: await connectors.authorizeUrl(req.params.id) },
})));

// GET /api/connectors/:id — one connector, with its provider's details
router.get('/:id', handle(async (req) => {
  const connector = await connectors.getOrThrow(req.params.id);
  const config = getProvider(connector.provider);
  return {
    data: {
      ...connectors.publicView(connector),
      provider_name: config?.name || connector.provider,
      tools: (config?.tools || []).map((t) => ({ name: t.name, description: t.description })),
    },
  };
}));

// POST /api/connectors/:id/disconnect
router.post('/:id/disconnect', requireManagerOrAdmin, handle(async (req) => {
  await connectors.disconnect(req.params.id);
  return {};
}));

// DELETE /api/connectors/:id — removes the stored credentials entirely
router.delete('/:id', requireManagerOrAdmin, handle(async (req) => {
  await connectors.remove(req.params.id);
  return {};
}));

module.exports = router;
