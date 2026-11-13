/**
 * The OAuth redirect target for connecting an MCP server.
 *
 * Its own file, mounted WITHOUT the auth middleware, because of what it is: a
 * browser arriving from someone else's authorization server. That hop carries
 * no Authorization header — putting this on the authenticated router would 401
 * every consent flow before the handler ever ran.
 *
 * What stands in for authentication is the `state` parameter. It was minted
 * server-side, is 32 random bytes, is single-use (the row is deleted as it is
 * read), expires in ten minutes, and is the only thing that maps back to the
 * PKCE verifier needed to redeem the code. A caller without a valid state can
 * do nothing here.
 *
 * Both outcomes end in a redirect back into the app rather than a JSON body —
 * a person is looking at this response in their browser, not a script.
 */

const express = require('express');
const router = express.Router();
const mcpOAuth = require('../services/ai/mcpOAuth');
const connections = require('../services/ai/mcpConnections');
const { appBase } = require('../config/appLinks');

function appUrl(params) {
  const query = new URLSearchParams(params).toString();
  return `${appBase()}/ai/tools?${query}`;
}

router.get('/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  // The provider can refuse before we ever get a code — a person clicking
  // "Deny" is a normal outcome, not a failure to hide.
  if (error) {
    return res.redirect(appUrl({ mcp_oauth: 'error', message: errorDescription || error }));
  }
  if (!code || !state) {
    return res.redirect(appUrl({ mcp_oauth: 'error', message: 'The authorization response was incomplete.' }));
  }

  try {
    const connection = await mcpOAuth.completeAuthorization(String(state), String(code));

    // Authorization only proves we can get a token. Whether the server will
    // actually talk to us is a separate question, and syncing now is what turns
    // the connection `connected` — so the person lands on a screen showing real
    // tools rather than one saying "authorized" next to an empty list.
    let toolsCount = 0;
    try {
      ({ tools_count: toolsCount } = await connections.syncTools(connection.id));
    } catch (syncError) {
      return res.redirect(appUrl({
        mcp_oauth: 'error',
        name: connection.name,
        message: `Authorized, but listing tools failed: ${syncError.message}`,
      }));
    }

    return res.redirect(appUrl({ mcp_oauth: 'connected', name: connection.name, tools: String(toolsCount) }));
  } catch (err) {
    console.error('MCP OAuth callback failed:', err.message);
    return res.redirect(appUrl({ mcp_oauth: 'error', message: err.message }));
  }
});

module.exports = router;
