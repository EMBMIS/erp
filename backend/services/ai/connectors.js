/**
 * Native OAuth connectors — storage, the sign-in dance, and calling the API.
 *
 * The MCP client (services/ai/mcpClient.js) talks to servers that implement a
 * protocol. This talks to ordinary REST APIs behind ordinary OAuth 2.0, which
 * is how every product with a "Google Drive connector" actually does it.
 *
 * Three things here are worth knowing before changing anything:
 *
 *   1. The OAuth app belongs to the operator. Client id and secret are entered
 *      per installation because only the owner of a Google/Xero/Salesforce
 *      account can create one. The secret is encrypted at rest with the same
 *      vault helpers as everything else and is never returned by the API.
 *
 *   2. Tokens are refreshed lazily, at call time, in one statement. An access
 *      token typically lives an hour; refreshing on use (rather than on a
 *      timer) means a connection left alone for a week still works on the next
 *      call, and there is no scheduler to go wrong.
 *
 *   3. Providers disagree about almost everything after the standard part —
 *      where the tenant id lives, whether the token goes in a bearer header or
 *      a custom one, whether the API host is fixed or arrives with the token.
 *      Those differences are data in connectorProviders.js, not branches here.
 */

const crypto = require('crypto');
const { pool } = require('../../config/database');
const vault = require('./credentialVault');
const { getProvider, validateClientId, envCredentials } = require('./connectorProviders');

const STATE_BYTES = 32;
const PENDING_TTL_MS = 10 * 60 * 1000;
const EXPIRY_MARGIN_MS = 60 * 1000;
const { apiBase } = require('../../config/appLinks');

const REQUEST_TIMEOUT_MS = 30000;

function redirectUri() {
  return `${apiBase()}/api/connector-oauth/callback`;
}

// --- crypto helpers --------------------------------------------------------

function enc(value) {
  if (!value) return { cipher: null, iv: null, tag: null };
  const e = vault.encrypt(String(value));
  return { cipher: e.cipher, iv: e.iv, tag: e.tag };
}

function dec(cipher, iv, tag, label) {
  if (!cipher || !iv || !tag) return null;
  return vault.decryptParts({ cipher, iv, tag }, label);
}

// --- template resolution ---------------------------------------------------

/**
 * Fill {{placeholders}} from the connector's account info.
 *
 * Providers like Shopify and NetSuite put the account in the hostname itself,
 * so URLs cannot be constants. Values come only from account_info, which the
 * operator supplied — never from tool arguments, so a tool call cannot rewrite
 * which host it is talking to.
 */
function fill(template, values) {
  if (!template) return template;
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = values?.[key];
    if (value === undefined || value === null) throw new Error(`This connector is missing "${key}".`);
    return String(value);
  });
}

// --- storage ---------------------------------------------------------------

function publicView(row) {
  if (!row) return null;
  const {
    client_secret_cipher, client_secret_iv, client_secret_tag,
    access_token_cipher, access_token_iv, access_token_tag,
    refresh_token_cipher, refresh_token_iv, refresh_token_tag,
    ...rest
  } = row;
  return { ...rest, has_credentials: !!client_secret_cipher, has_token: !!access_token_cipher };
}

async function list() {
  const { rows } = await pool.query('SELECT * FROM connectors ORDER BY created_at DESC');
  return rows.map(publicView);
}

async function get(id) {
  const { rows } = await pool.query('SELECT * FROM connectors WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getOrThrow(id) {
  const row = await get(id);
  if (!row) throw new Error('That connector was not found.');
  return row;
}

async function listConnected() {
  const { rows } = await pool.query("SELECT * FROM connectors WHERE status = 'connected'");
  return rows;
}

/**
 * Record an OAuth application for a provider.
 *
 * Nothing is contacted here — this only stores the credentials the operator
 * created in the vendor's console. Signing in is a separate, deliberate step.
 */
async function create({ provider, label, client_id, client_secret, account_info, userId }) {
  const config = getProvider(provider);
  if (!config) throw new Error(`"${provider}" is not a provider this system knows about.`);
  // The server's own OAuth app, when the operator configured one. This is the
  // normal path on a shared deployment: nobody connecting Google Drive should
  // need to visit a developer console, any more than they do in a hosted AI
  // product. Anything passed in explicitly still wins, so one admin can connect
  // a different app than the server default.
  const shared = envCredentials(provider);
  const effectiveId = client_id || shared?.client_id;
  const effectiveSecret = client_secret || shared?.client_secret;

  if (!effectiveId || !effectiveSecret) {
    throw new Error(
      `${config.name} needs an OAuth application. Either set ${`CONNECTOR_${provider.toUpperCase()}`}_CLIENT_ID and _CLIENT_SECRET on this server so everyone can just sign in, or paste them for this connection.`
    );
  }
  // Refuse here rather than let the provider refuse three redirects away, where
  // the error names nothing the person can act on.
  const idProblem = validateClientId(provider, effectiveId);
  if (idProblem) throw new Error(idProblem);
  // Providers whose URLs embed the account need it before anything can be built.
  if (config.account_param && !account_info?.[config.account_param.key]) {
    throw new Error(`${config.name} also needs ${config.account_param.label.toLowerCase()}.`);
  }

  const secret = enc(effectiveSecret);
  const { rows } = await pool.query(
    `INSERT INTO connectors (provider, label, client_id, client_secret_cipher, client_secret_iv,
                             client_secret_tag, account_info, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'pending_auth',$8)
     RETURNING *`,
    [
      provider,
      (label || config.name).slice(0, 160),
      String(effectiveId).trim(),
      secret.cipher, secret.iv, secret.tag,
      JSON.stringify(account_info || {}),
      userId || null,
    ]
  );
  return publicView(rows[0]);
}

async function disconnect(id) {
  const { rows } = await pool.query(
    `UPDATE connectors SET status = 'disconnected', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 RETURNING id`,
    [id]
  );
  if (!rows.length) throw new Error('That connector was not found.');
}

async function remove(id) {
  await pool.query('DELETE FROM connectors WHERE id = $1', [id]);
}

// --- the sign-in dance -----------------------------------------------------

/** Where to send the person to approve access. */
async function authorizeUrl(id) {
  const connector = await getOrThrow(id);
  const config = getProvider(connector.provider);
  if (!config) throw new Error(`"${connector.provider}" is no longer a known provider.`);
  if (!config.authorize_url) {
    throw new Error(`${config.name} does not use a sign-in flow — enter its API keys instead.`);
  }

  const account = connector.account_info || {};
  const state = crypto.randomBytes(STATE_BYTES).toString('base64url');

  // PKCE where the provider supports it. Harmless where it does not, but only
  // sent when declared, because a few providers reject unknown parameters.
  let verifier = null;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: connector.client_id,
    redirect_uri: redirectUri(),
    state,
  });
  if (config.scopes?.length) params.set('scope', config.scopes.join(' '));
  for (const [key, value] of Object.entries(config.authorize_params || {})) {
    params.set(key, fill(value, account));
  }
  if (config.pkce) {
    verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    params.set('code_challenge', challenge);
    params.set('code_challenge_method', 'S256');
  }

  await pool.query('DELETE FROM connector_oauth_pending WHERE expires_at < CURRENT_TIMESTAMP').catch(() => {});
  await pool.query(
    `INSERT INTO connector_oauth_pending (state, connector_id, code_verifier, expires_at)
     VALUES ($1,$2,$3,$4)`,
    [state, connector.id, verifier, new Date(Date.now() + PENDING_TTL_MS)]
  );

  return `${fill(config.authorize_url, account)}?${params.toString()}`;
}

/** Swap the code for tokens. Called by the callback route. */
async function completeAuthorization(state, code, callbackQuery = {}) {
  const { rows } = await pool.query(
    `DELETE FROM connector_oauth_pending
      WHERE state = $1 AND expires_at > CURRENT_TIMESTAMP
      RETURNING connector_id, code_verifier`,
    [state]
  );
  const pending = rows[0];
  if (!pending) throw new Error('This sign-in link has expired or was already used. Start again.');

  const connector = await getOrThrow(pending.connector_id);
  const config = getProvider(connector.provider);
  const account = { ...(connector.account_info || {}) };

  // Some providers hand back essential context on the redirect rather than in
  // the token response — QuickBooks' realmId is the company id every later URL
  // needs, and losing it would leave a connection that authenticates but cannot
  // address anything.
  for (const key of config.callback_params || []) {
    if (callbackQuery[key]) account[key] = callbackQuery[key];
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    client_id: connector.client_id,
    client_secret: dec(connector.client_secret_cipher, connector.client_secret_iv, connector.client_secret_tag, 'client secret'),
  });
  if (pending.code_verifier) body.set('code_verifier', pending.code_verifier);

  const tokens = await postForm(fill(config.token_url, account), body, config);
  if (!tokens.access_token) {
    throw new Error(tokens.error_description || tokens.error || 'The provider did not return an access token.');
  }

  // Salesforce (and others) report the real API host with the token.
  if (config.instance_url_field && tokens[config.instance_url_field]) {
    account.instance_url = tokens[config.instance_url_field];
  }

  await saveTokens(connector.id, tokens, account);

  // A few providers need one more call before they are usable — Xero's tenant
  // id is not in the token response, and every subsequent request requires it.
  if (config.tenant_lookup) {
    try {
      const res = await apiFetch(config.tenant_lookup.path, {
        connector: await get(connector.id), config, account, method: 'GET',
      });
      const tenant = Array.isArray(res.body) ? res.body[0]?.[config.tenant_lookup.field] : null;
      if (tenant) {
        account.tenant_id = tenant;
        await pool.query('UPDATE connectors SET account_info = $2::jsonb WHERE id = $1', [connector.id, JSON.stringify(account)]);
      }
    } catch (err) {
      console.error(`Could not read the ${config.name} tenant id:`, err.message);
    }
  }

  return await get(connector.id);
}

async function saveTokens(id, tokens, account) {
  const access = enc(tokens.access_token);
  const refresh = enc(tokens.refresh_token);
  const expiresAt = tokens.expires_in ? new Date(Date.now() + Number(tokens.expires_in) * 1000) : null;

  await pool.query(
    `UPDATE connectors SET
       access_token_cipher = $2, access_token_iv = $3, access_token_tag = $4,
       refresh_token_cipher = COALESCE($5, refresh_token_cipher),
       refresh_token_iv     = COALESCE($6, refresh_token_iv),
       refresh_token_tag    = COALESCE($7, refresh_token_tag),
       access_token_expires_at = $8,
       scope = COALESCE($9, scope),
       account_info = COALESCE($10::jsonb, account_info),
       status = 'connected', last_error = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [
      id,
      access.cipher, access.iv, access.tag,
      refresh.cipher, refresh.iv, refresh.tag,
      expiresAt,
      tokens.scope || null,
      account ? JSON.stringify(account) : null,
    ]
  );
}

async function postForm(url, body, config) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...(config?.extra_headers || {}) },
      body,
      redirect: 'error',
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = Object.fromEntries(new URLSearchParams(text)); }
    if (!res.ok) {
      throw new Error(parsed.error_description || parsed.error || `${res.status} ${text.slice(0, 200)}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A usable access token, refreshed first if it is about to expire.
 *
 * The margin matters: a token that expires in three seconds passes a naive
 * "is it expired" check and then fails mid-request.
 */
async function freshAccessToken(connector, config) {
  const account = connector.account_info || {};
  const expiresAt = connector.access_token_expires_at ? new Date(connector.access_token_expires_at).getTime() : null;
  const stillGood = !expiresAt || expiresAt - Date.now() > EXPIRY_MARGIN_MS;
  const current = dec(connector.access_token_cipher, connector.access_token_iv, connector.access_token_tag, 'access token');

  if (stillGood && current) return current;

  const refresh = dec(connector.refresh_token_cipher, connector.refresh_token_iv, connector.refresh_token_tag, 'refresh token');
  if (!refresh) {
    if (current) return current; // no refresh token: use it until the provider refuses
    throw new Error(`"${connector.label}" is not signed in. Connect it again.`);
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refresh,
    client_id: connector.client_id,
    client_secret: dec(connector.client_secret_cipher, connector.client_secret_iv, connector.client_secret_tag, 'client secret'),
  });
  const tokens = await postForm(fill(config.token_url, account), body, config);
  if (!tokens.access_token) throw new Error(`Could not refresh access for "${connector.label}". Connect it again.`);
  await saveTokens(connector.id, tokens, null);
  return tokens.access_token;
}

// --- calling the provider's API -------------------------------------------

/**
 * Auth headers and a resolved URL for a call against a connected provider.
 * Shared by apiFetch (JSON) and apiFetchRaw (binary/multipart) so both build
 * requests the same way instead of two implementations that could drift.
 *
 * `path` may be a full URL or a path against the provider's API base. Only
 * hosts belonging to the provider's own configuration are reachable — the
 * base URL comes from connectorProviders.js and the account values the
 * operator entered, never from tool arguments, so this cannot be pointed at an
 * arbitrary host by anything the model decides to pass in.
 */
async function prepareRequest(path, { connector, config, account, query, headers, apiBase }) {
  const token = await freshAccessToken(connector, config);
  const base = (account?.instance_url || fill(apiBase || config.api_base, account)).replace(/\/+$/, '');

  const url = new URL(/^https?:\/\//i.test(path) ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`);
  if (!url.protocol.startsWith('https')) throw new Error('Connectors only call https endpoints.');
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }

  const finalHeaders = {
    Accept: 'application/json',
    ...(config.extra_headers || {}),
    ...(headers || {}),
  };
  // Most providers take a bearer token; a few insist on their own header.
  if (config.token_header) finalHeaders[config.token_header] = token;
  else finalHeaders.Authorization = `Bearer ${token}`;
  if (config.tenant_lookup?.header && account?.tenant_id) {
    finalHeaders[config.tenant_lookup.header] = account.tenant_id;
  }
  return { url, headers: finalHeaders };
}

async function sendRequest(url, { method, headers, body, config }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, headers, body, redirect: 'error', signal: controller.signal });
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!res.ok) {
      const detail = typeof parsed === 'string' ? parsed.slice(0, 300) : JSON.stringify(parsed).slice(0, 300);
      throw new Error(`${config.name} returned ${res.status}: ${detail}`);
    }
    return { status: res.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

/** One authenticated JSON request against a connected provider. */
async function apiFetch(path, { connector, config, account, method = 'GET', query, body, headers, apiBase }) {
  const prepared = await prepareRequest(path, { connector, config, account, query, headers, apiBase });
  if (body) prepared.headers['Content-Type'] = 'application/json';
  return sendRequest(prepared.url, {
    method,
    headers: prepared.headers,
    body: body ? JSON.stringify(body) : undefined,
    config,
  });
}

/**
 * One authenticated request with a body the caller has already built — a
 * multipart/related upload, raw bytes, anything that is not "serialize this
 * object as JSON". apiFetch cannot express this: it always JSON-encodes,
 * which is exactly how a Google Drive upload silently becomes a metadata-only
 * request that creates a real file with no content in it.
 */
async function apiFetchRaw(path, { connector, config, account, method = 'POST', query, headers, body, apiBase }) {
  const prepared = await prepareRequest(path, { connector, config, account, query, headers, apiBase });
  return sendRequest(prepared.url, { method, headers: prepared.headers, body, config });
}

module.exports = {
  list,
  listConnected,
  get,
  getOrThrow,
  create,
  disconnect,
  remove,
  authorizeUrl,
  completeAuthorization,
  apiFetch,
  apiFetchRaw,
  freshAccessToken,
  redirectUri,
  publicView,
  fill,
};
