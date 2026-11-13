/**
 * Where a provider sends the browser back after someone approves access.
 *
 * Unauthenticated by necessity and by design, for the same reason as
 * routes/mcp-oauth-callback.js: this hop comes from Google or Xero, not from
 * the app, and carries no token of ours. The `state` parameter is what stands
 * in — 32 random bytes, minted server-side, single-use, ten-minute expiry, and
 * the only thing that maps back to the connector and its PKCE verifier.
 */

const express = require('express');
const router = express.Router();
const connectors = require('../services/ai/connectors');
const { appBase } = require('../config/appLinks');

function appUrl(params) {
  return `${appBase()}/ai/tools?${new URLSearchParams(params).toString()}`;
}

router.get('/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  // Declining is a normal outcome, not a failure to obscure.
  if (error) {
    return res.redirect(appUrl({ connector: 'error', message: errorDescription || error }));
  }
  if (!code || !state) {
    return res.redirect(appUrl({ connector: 'error', message: 'The provider’s response was incomplete.' }));
  }

  try {
    const connector = await connectors.completeAuthorization(String(state), String(code), req.query);
    return res.redirect(appUrl({ connector: 'connected', name: connector.label }));
  } catch (err) {
    console.error('Connector OAuth callback failed:', err.message);
    return res.redirect(appUrl({ connector: 'error', message: err.message }));
  }
});

module.exports = router;
