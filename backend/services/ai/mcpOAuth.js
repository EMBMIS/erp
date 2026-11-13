/**
 * OAuth for connected MCP servers.
 *
 * The MCP SDK already implements the whole authorization-code + PKCE dance,
 * including discovery, dynamic client registration and refresh-on-401. It asks
 * the host application for exactly one thing: somewhere to keep the state. That
 * is what this module is — an `OAuthClientProvider` whose storage happens to be
 * Postgres. Nothing here re-implements RFC 6749; getting that wrong quietly is
 * far too easy, and the SDK's version is the one the servers are tested against.
 *
 * Where the state lives, and why:
 *
 *   mcp_oauth_grants   tokens, per connection. NOT in ai_credentials: that
 *                      table's single secret slot is built for a key a person
 *                      types and rotates, and its `hint`/`updated_at` exist to
 *                      say "a human changed this". An access token refreshed
 *                      silently every hour would make both meaningless, and
 *                      would need a two-table write with no transaction around
 *                      it. One table, one UPDATE.
 *   mcp_oauth_pending  the PKCE verifier, for the seconds between redirecting
 *                      the browser out and it coming back. The verifier must
 *                      never travel through the browser — that is the whole
 *                      point of PKCE — so it waits here, keyed by the `state`
 *                      parameter that does travel.
 *
 * Secrets are encrypted with credentialVault's AES-256-GCM helpers: same key,
 * same algorithm, same failure mode as every other secret this system holds.
 */

const crypto = require('crypto');
const { pool } = require('../../config/database');
const vault = require('./credentialVault');

// Long enough that guessing is hopeless, short enough for a URL.
const STATE_BYTES = 32;
const PENDING_TTL_MS = 10 * 60 * 1000;

// Refresh slightly before the server would reject the token. Clock skew and
// request latency both eat into a token's last seconds; a minute of margin
// turns "intermittent 401 under load" into a non-event.
const { apiBase } = require('../../config/appLinks');

const EXPIRY_MARGIN_MS = 60 * 1000;

function redirectUri() {
  return `${apiBase()}/api/mcp-oauth/callback`;
}

// --- storage helpers -------------------------------------------------------

function encryptOrNull(value) {
  if (value === undefined || value === null || value === '') return { cipher: null, iv: null, tag: null };
  const enc = vault.encrypt(String(value));
  return { cipher: enc.cipher, iv: enc.iv, tag: enc.tag };
}

function decryptOrNull(cipher, iv, tag, label) {
  if (!cipher || !iv || !tag) return undefined;
  return vault.decryptParts({ cipher, iv, tag }, label);
}

async function getGrant(connectionId) {
  const { rows } = await pool.query('SELECT * FROM mcp_oauth_grants WHERE connection_id = $1', [connectionId]);
  return rows[0] || null;
}

/**
 * Everything the SDK needs to talk to this connection's authorization server,
 * recorded before the browser is sent anywhere. Upsert, because re-authorizing
 * an existing connection is a normal thing to do (expired refresh token,
 * changed scopes) and must not collide with the row from last time.
 */
async function saveEndpoints(connectionId, { token_endpoint, authorization_endpoint, client_id, client_secret, scope, resource }) {
  const secret = encryptOrNull(client_secret);
  const { rows } = await pool.query(
    `INSERT INTO mcp_oauth_grants
       (connection_id, token_endpoint, authorization_endpoint, client_id,
        client_secret_cipher, client_secret_iv, client_secret_tag, scope, resource)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (connection_id) DO UPDATE SET
       token_endpoint = EXCLUDED.token_endpoint,
       authorization_endpoint = EXCLUDED.authorization_endpoint,
       client_id = EXCLUDED.client_id,
       client_secret_cipher = EXCLUDED.client_secret_cipher,
       client_secret_iv = EXCLUDED.client_secret_iv,
       client_secret_tag = EXCLUDED.client_secret_tag,
       scope = EXCLUDED.scope,
       resource = EXCLUDED.resource,
       updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [
      connectionId,
      token_endpoint,
      authorization_endpoint || null,
      client_id || null,
      secret.cipher, secret.iv, secret.tag,
      scope || null,
      resource || null,
    ]
  );
  return rows[0];
}

/**
 * Store a token set. Access and refresh tokens and the expiry move together in
 * a single statement, so there is no window where the stored token and the
 * stored expiry disagree — a mismatch there surfaces later as an unexplained
 * 401 rather than as an obvious failure here.
 *
 * A refresh response that omits refresh_token means "keep using the one you
 * have" (RFC 6749 §6), so an absent value must not overwrite the stored one.
 */
async function saveTokens(connectionId, tokens) {
  const access = encryptOrNull(tokens.access_token);
  const refresh = encryptOrNull(tokens.refresh_token);
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + Number(tokens.expires_in) * 1000)
    : null;

  await pool.query(
    `UPDATE mcp_oauth_grants SET
       access_token_cipher = $2,
       access_token_iv = $3,
       access_token_tag = $4,
       refresh_token_cipher = COALESCE($5, refresh_token_cipher),
       refresh_token_iv     = COALESCE($6, refresh_token_iv),
       refresh_token_tag    = COALESCE($7, refresh_token_tag),
       access_token_expires_at = $8,
       scope = COALESCE($9, scope),
       updated_at = CURRENT_TIMESTAMP
     WHERE connection_id = $1`,
    [
      connectionId,
      access.cipher, access.iv, access.tag,
      refresh.cipher, refresh.iv, refresh.tag,
      expiresAt,
      tokens.scope || null,
    ]
  );
}

function tokensFromGrant(grant) {
  const access = decryptOrNull(grant.access_token_cipher, grant.access_token_iv, grant.access_token_tag, 'access token');
  if (!access) return undefined;
  const refresh = decryptOrNull(grant.refresh_token_cipher, grant.refresh_token_iv, grant.refresh_token_tag, 'refresh token');

  // The SDK decides whether to refresh from expires_in, which it reads as
  // "seconds from now". Deriving it back from the stored absolute expiry (and
  // clamping at zero) is what makes an already-expired token present as
  // expired rather than as fresh.
  let expiresIn;
  if (grant.access_token_expires_at) {
    const remainingMs = new Date(grant.access_token_expires_at).getTime() - Date.now() - EXPIRY_MARGIN_MS;
    expiresIn = Math.max(0, Math.floor(remainingMs / 1000));
  }

  return {
    access_token: access,
    token_type: 'Bearer',
    ...(refresh ? { refresh_token: refresh } : {}),
    ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
    ...(grant.scope ? { scope: grant.scope } : {}),
  };
}

// --- pending (PKCE) --------------------------------------------------------

async function createPending(connectionId, codeVerifier, state) {
  // Opportunistic sweep. This table sees a handful of rows a week at most, so
  // a cron job for it would be more machinery than the problem deserves.
  await pool.query('DELETE FROM mcp_oauth_pending WHERE expires_at < CURRENT_TIMESTAMP').catch(() => {});

  await pool.query(
    `INSERT INTO mcp_oauth_pending (state, connection_id, code_verifier, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (state) DO UPDATE SET code_verifier = EXCLUDED.code_verifier,
                                       expires_at = EXCLUDED.expires_at`,
    [state, connectionId, codeVerifier, new Date(Date.now() + PENDING_TTL_MS)]
  );
  return state;
}

/** Consume a pending row: valid, unexpired, and single-use. */
async function consumePending(state) {
  const { rows } = await pool.query(
    `DELETE FROM mcp_oauth_pending
      WHERE state = $1 AND expires_at > CURRENT_TIMESTAMP
      RETURNING connection_id, code_verifier`,
    [state]
  );
  return rows[0] || null;
}

// --- the provider the SDK talks to ----------------------------------------

/**
 * An OAuthClientProvider bound to one connection.
 *
 * `pendingState` carries the PKCE verifier across the browser round-trip: on
 * the outbound leg the provider generates and stores it, and on the callback
 * leg the route loads it back and hands it in, so `codeVerifier()` can answer
 * synchronously with the same value the authorization request was built from.
 */
function providerFor(connection, { codeVerifier: knownVerifier, onAuthorizationUrl } = {}) {
  let grantPromise = null;
  let issuedState = null;
  const grant = () => (grantPromise ||= getGrant(connection.id));

  return {
    get redirectUrl() {
      return redirectUri();
    },

    get clientMetadata() {
      return {
        client_name: 'Simeli ERP',
        redirect_uris: [redirectUri()],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
      };
    },

    async clientInformation() {
      const g = await grant();
      if (!g?.client_id) return undefined;
      const secret = decryptOrNull(g.client_secret_cipher, g.client_secret_iv, g.client_secret_tag, 'client secret');
      return { client_id: g.client_id, ...(secret ? { client_secret: secret } : {}) };
    },

    // Dynamic client registration: servers that support it hand back a
    // client_id we did not have. Persisting it is what stops us registering a
    // brand-new client on every single connection attempt.
    async saveClientInformation(info) {
      const secret = encryptOrNull(info.client_secret);
      await pool.query(
        `UPDATE mcp_oauth_grants SET
           client_id = $2,
           client_secret_cipher = $3, client_secret_iv = $4, client_secret_tag = $5,
           updated_at = CURRENT_TIMESTAMP
         WHERE connection_id = $1`,
        [connection.id, info.client_id, secret.cipher, secret.iv, secret.tag]
      );
      grantPromise = null;
    },

    async tokens() {
      const g = await grant();
      return g ? tokensFromGrant(g) : undefined;
    },

    async saveTokens(tokens) {
      await saveTokens(connection.id, tokens);
      grantPromise = null;
    },

    // Called BEFORE saveCodeVerifier (the SDK builds the authorization URL,
    // which embeds the state, and only then hands back the verifier). So this
    // mints the state and holds it; the pending row is written a moment later
    // when the verifier it has to store actually exists.
    async state() {
      issuedState = crypto.randomBytes(STATE_BYTES).toString('base64url');
      return issuedState;
    },

    async saveCodeVerifier(verifier) {
      knownVerifier = verifier;
      if (!issuedState) {
        throw new Error('Internal error: a PKCE verifier was produced without an authorization state.');
      }
      await createPending(connection.id, verifier, issuedState);
    },

    // The SDK calls this when it wants a human to visit the authorization
    // page. There is no browser attached to this process, so instead of
    // "redirecting" we hand the URL back to the caller, which returns it to
    // the frontend to navigate to.
    async redirectToAuthorization(authorizationUrl) {
      if (onAuthorizationUrl) await onAuthorizationUrl(authorizationUrl);
    },

    async codeVerifier() {
      if (!knownVerifier) {
        throw new Error('The authorization session has expired or was already used. Start the connection again.');
      }
      return knownVerifier;
    },
  };
}

// --- the two flows the routes drive --------------------------------------

/**
 * Begin authorization: discover where this server's authorization lives,
 * record it, and produce the URL a person should be sent to.
 *
 * Discovery is done explicitly rather than left entirely to `auth()` because
 * the token endpoint it finds has to be egress-checked and stored before any
 * token request is made to it. A server that is otherwise legitimate can still
 * name a token endpoint pointing at internal infrastructure, and that request
 * would carry a client secret.
 */
async function beginAuthorization(connection) {
  const { auth, discoverOAuthServerInfo } = require('@modelcontextprotocol/sdk/client/auth.js');
  const mcpClient = require('./mcpClient');

  const info = await discoverOAuthServerInfo(connection.endpoint_url);
  const metadata = info?.authorizationServerMetadata;
  const tokenEndpoint = metadata?.token_endpoint;
  if (!tokenEndpoint) {
    throw new Error(
      `"${connection.name}" did not advertise an OAuth token endpoint, so it cannot be connected this way. It may use an API key instead.`
    );
  }
  mcpClient.assertEgressAllowed(tokenEndpoint, `${connection.name} token endpoint`);
  if (metadata.authorization_endpoint) {
    mcpClient.assertEgressAllowed(metadata.authorization_endpoint, `${connection.name} authorization endpoint`);
  }

  await saveEndpoints(connection.id, {
    token_endpoint: tokenEndpoint,
    authorization_endpoint: metadata.authorization_endpoint || null,
    scope: info?.resourceMetadata?.scopes_supported?.join(' ') || null,
    resource: info?.resourceMetadata?.resource || null,
  });

  let authorizationUrl = null;
  const provider = providerFor(connection, {
    onAuthorizationUrl: (url) => { authorizationUrl = url.toString(); },
  });

  const result = await auth(provider, { serverUrl: connection.endpoint_url });
  if (result === 'AUTHORIZED') {
    // Already holds usable tokens — nothing for a human to do.
    return { authorized: true, authorization_url: null };
  }
  if (!authorizationUrl) {
    throw new Error(`Could not work out where to send you to authorize "${connection.name}".`);
  }
  return { authorized: false, authorization_url: authorizationUrl };
}

/**
 * Finish authorization: swap the code for tokens, using the verifier that has
 * been waiting server-side for this exact state.
 */
async function completeAuthorization(state, code) {
  const { auth } = require('@modelcontextprotocol/sdk/client/auth.js');
  const connections = require('./mcpConnections');

  const pending = await consumePending(state);
  if (!pending) {
    throw new Error('This authorization link has expired or was already used. Start the connection again.');
  }

  const connection = await connections.getOrThrow(pending.connection_id);
  const provider = providerFor(connection, { codeVerifier: pending.code_verifier });

  const result = await auth(provider, {
    serverUrl: connection.endpoint_url,
    authorizationCode: code,
  });
  if (result !== 'AUTHORIZED') {
    throw new Error(`"${connection.name}" did not complete authorization.`);
  }
  return connection;
}

module.exports = {
  providerFor,
  getGrant,
  saveEndpoints,
  saveTokens,
  consumePending,
  createPending,
  redirectUri,
  tokensFromGrant,
  beginAuthorization,
  completeAuthorization,
};
