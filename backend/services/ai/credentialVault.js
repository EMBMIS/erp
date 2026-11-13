/**
 * Credential vault — encrypted storage for the API keys agents use.
 *
 * An agent that runs on the user's own Claude or OpenAI key, and calls the
 * user's own Stripe or shipping API, needs somewhere to keep those secrets.
 * This is that place, and the design rules are the ones that matter for a
 * secret store rather than for a settings table:
 *
 *   • AES-256-GCM, key from AI_VAULT_KEY. GCM (not CBC) because a tampered
 *     ciphertext must fail to decrypt rather than decrypt to garbage.
 *   • A secret NEVER leaves through the API. `getSecret()` is server-side only;
 *     every route returns the row with the ciphertext columns stripped and a
 *     four-character hint. There is no "reveal" endpoint, because the moment
 *     one exists the vault is only as strong as whoever can call it.
 *   • Writing requires AI_VAULT_KEY to be configured. It is NOT derived from
 *     JWT_SECRET as a convenience fallback: that key is already used for
 *     something else, is often shared across environments, and reusing it would
 *     mean a leaked token secret also decrypts every stored API key. Refusing
 *     to store a secret is a better failure than storing it weakly, so this
 *     fails loudly with instructions instead.
 *   • Egress is host-restricted. A credential names the hosts it may be sent
 *     to; call_external_api checks that list, refuses private address ranges,
 *     and refuses plaintext HTTP. That is what stops a prompt-injected
 *     instruction from turning a stored key into an exfiltration channel.
 */

const crypto = require('crypto');
const { pool } = require('../../config/database');

const ALGORITHM = 'aes-256-gcm';
const KEY_ID = 'v1';

/**
 * Resolve the encryption key. Returns null when unconfigured — callers turn
 * that into an actionable message rather than a crash.
 */
function vaultKey() {
  const raw = process.env.AI_VAULT_KEY;
  if (!raw) return null;

  // Accept hex or base64; both are natural things to paste from a key generator.
  let key;
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'base64');
  }
  if (key.length !== 32) {
    throw new Error('AI_VAULT_KEY must be 32 bytes (64 hex characters, or base64 of 32 bytes). Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return key;
}

function vaultStatus() {
  let configured = false;
  let error = null;
  try {
    configured = !!vaultKey();
  } catch (err) {
    error = err.message;
  }
  return {
    configured,
    error,
    // The UI needs to explain the failure, not just disable a button.
    how_to_configure: configured
      ? undefined
      : 'Set AI_VAULT_KEY in the server environment to a 32-byte key. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
  };
}

function encrypt(plaintext) {
  const key = vaultKey();
  if (!key) {
    throw new Error(
      'Cannot store an API key: AI_VAULT_KEY is not configured on this server, so there is nowhere safe to encrypt it. Set AI_VAULT_KEY (32 bytes) and try again.'
    );
  }
  const iv = crypto.randomBytes(12); // 96-bit IV is the GCM standard
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return {
    cipher: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    keyId: KEY_ID,
  };
}

/**
 * Decrypt a {cipher, iv, tag} triple produced by encrypt().
 *
 * Column-name agnostic, because the ai_credentials table is not the only
 * place a secret of this shape is stored — mcp_oauth_grants keeps OAuth
 * access/refresh tokens in its own columns and decrypts them through here,
 * so there is exactly one implementation of this and one failure mode.
 * `label` only shapes the error message.
 */
function decryptParts({ cipher, iv, tag }, label = 'value') {
  const key = vaultKey();
  if (!key) throw new Error('AI_VAULT_KEY is not configured, so stored secrets cannot be decrypted.');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(cipher, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // GCM authentication failure: either the wrong key, or the row was altered.
    // Both are worth saying out loud rather than returning nonsense.
    throw new Error(
      `The stored ${label} could not be decrypted. Either AI_VAULT_KEY has changed since it was stored, or the stored value was modified. Re-enter it to fix this.`
    );
  }
}

function decrypt(row) {
  if (row.key_id !== KEY_ID) {
    throw new Error(`Credential "${row.name}" was encrypted with key "${row.key_id}", which this server does not have.`);
  }
  return decryptParts(
    { cipher: row.secret_cipher, iv: row.secret_iv, tag: row.secret_tag },
    `key for "${row.name}"`
  );
}

// ---------------------------------------------------------------------------
// Public shape — never includes the ciphertext or the secret.
// ---------------------------------------------------------------------------
function publicView(row) {
  if (!row) return null;
  const { secret_cipher, secret_iv, secret_tag, ...rest } = row;
  return { ...rest, has_secret: !!secret_cipher };
}

async function listCredentials() {
  const { rows } = await pool.query(
    `SELECT c.*, u.first_name || ' ' || u.last_name AS created_by_name,
            (SELECT COUNT(*)::int FROM agent_credentials ac WHERE ac.credential_id = c.id) AS agent_count
       FROM ai_credentials c LEFT JOIN users u ON u.id = c.created_by
      ORDER BY c.name`
  );
  return rows.map(publicView);
}

async function getCredential(idOrName) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(idOrName || ''));
  const { rows } = await pool.query(
    `SELECT * FROM ai_credentials WHERE ${isUuid ? 'id' : 'name'} = $1`,
    [idOrName]
  );
  return rows[0] || null;
}

/**
 * The plaintext secret, for server-side use only.
 *
 * Every call bumps the usage counters, so a key that is being used by something
 * unexpected is visible on the credentials screen rather than only in a log.
 */
async function getSecret(idOrName) {
  const row = await getCredential(idOrName);
  if (!row) throw new Error(`No credential named "${idOrName}".`);
  if (!row.enabled) throw new Error(`Credential "${row.name}" is disabled.`);
  const secret = decrypt(row);
  pool
    .query('UPDATE ai_credentials SET last_used_at = CURRENT_TIMESTAMP, use_count = use_count + 1 WHERE id = $1', [row.id])
    .catch(() => {});
  return { secret, provider: row.provider, base_url: row.base_url, allowed_hosts: row.allowed_hosts, name: row.name };
}

async function createCredential({ name, description, provider, secret, base_url, allowed_hosts }, userId) {
  if (!name || !/^[a-zA-Z][a-zA-Z0-9_ -]{1,79}$/.test(name)) {
    throw new Error('A credential name must start with a letter and be 2-80 characters of letters, digits, spaces, hyphens or underscores.');
  }
  if (!secret || String(secret).length < 8) throw new Error('That does not look like an API key.');

  const enc = encrypt(secret);
  const { rows } = await pool.query(
    `INSERT INTO ai_credentials
       (name, description, provider, secret_cipher, secret_iv, secret_tag, key_id, hint, base_url, allowed_hosts, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      name,
      description || null,
      provider || 'http',
      enc.cipher,
      enc.iv,
      enc.tag,
      enc.keyId,
      String(secret).slice(-4),
      base_url || null,
      Array.isArray(allowed_hosts) ? allowed_hosts.map((h) => String(h).toLowerCase()) : [],
      userId || null,
    ]
  );
  return publicView(rows[0]);
}

async function updateCredential(idOrName, changes, userId) {
  const existing = await getCredential(idOrName);
  if (!existing) throw new Error('Credential not found.');

  const sets = [];
  const params = [existing.id];
  const add = (col, value) => { params.push(value); sets.push(`${col} = $${params.length}`); };

  if (changes.description !== undefined) add('description', changes.description || null);
  if (changes.base_url !== undefined) add('base_url', changes.base_url || null);
  if (changes.enabled !== undefined) add('enabled', !!changes.enabled);
  if (changes.allowed_hosts !== undefined) {
    add('allowed_hosts', Array.isArray(changes.allowed_hosts) ? changes.allowed_hosts.map((h) => String(h).toLowerCase()) : []);
  }
  // Rotating the secret re-encrypts; the old ciphertext is overwritten, not kept.
  if (changes.secret) {
    const enc = encrypt(changes.secret);
    add('secret_cipher', enc.cipher);
    add('secret_iv', enc.iv);
    add('secret_tag', enc.tag);
    add('key_id', enc.keyId);
    add('hint', String(changes.secret).slice(-4));
  }
  if (!sets.length) throw new Error('Nothing to update.');
  sets.push('updated_at = CURRENT_TIMESTAMP');

  const { rows } = await pool.query(
    `UPDATE ai_credentials SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    params
  );
  return publicView(rows[0]);
}

async function deleteCredential(idOrName) {
  const existing = await getCredential(idOrName);
  if (!existing) throw new Error('Credential not found.');
  const { rows } = await pool.query(
    `SELECT b.display_name FROM agent_blueprints b WHERE b.credential_id = $1`,
    [existing.id]
  );
  if (rows.length) {
    throw new Error(
      `This credential is the model key for ${rows.length} agent(s): ${rows.map((r) => r.display_name).join(', ')}. Point them at another credential first — deleting it would break their next run.`
    );
  }
  await pool.query('DELETE FROM ai_credentials WHERE id = $1', [existing.id]);
  return { deleted: existing.name };
}

// ---------------------------------------------------------------------------
// Per-agent grants
// ---------------------------------------------------------------------------

async function grantToAgent(agentKey, credentialId, userId) {
  await pool.query(
    `INSERT INTO agent_credentials (agent_key, credential_id, granted_by)
     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [agentKey, credentialId, userId || null]
  );
  return { granted: true };
}

async function revokeFromAgent(agentKey, credentialId) {
  await pool.query('DELETE FROM agent_credentials WHERE agent_key = $1 AND credential_id = $2', [agentKey, credentialId]);
  return { revoked: true };
}

async function agentCredentials(agentKey) {
  const { rows } = await pool.query(
    `SELECT c.* FROM ai_credentials c
       JOIN agent_credentials ac ON ac.credential_id = c.id
      WHERE ac.agent_key = $1 AND c.enabled = true
      ORDER BY c.name`,
    [agentKey]
  );
  return rows.map(publicView);
}

/**
 * Is this credential allowed to be sent to this URL?
 *
 * Deny-by-default host allowlist plus the checks that make an allowlist
 * meaningful: HTTPS only (a key sent over plaintext HTTP is a leaked key), and
 * no private/loopback/link-local addresses (which is how an outbound-request
 * feature becomes an internal-network scanner).
 */
function checkEgress(credential, urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return { ok: false, reason: `"${urlString}" is not a valid URL.` };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'Only https:// URLs are allowed — an API key sent over plain HTTP is a leaked API key.' };
  }

  const host = url.hostname.toLowerCase();

  if (isPrivateHost(host)) {
    return { ok: false, reason: `"${host}" is a private or loopback address. Agents may only call external services.` };
  }

  const allowed = Array.isArray(credential.allowed_hosts) ? credential.allowed_hosts : [];
  if (!allowed.length) {
    return { ok: false, reason: `Credential "${credential.name}" has no allowed hosts configured, so it cannot be sent anywhere. Add the API's hostname to it first.` };
  }

  // Exact host, or a *.example.com wildcard. Deliberately not a substring test:
  // "api.example.com.evil.net" must not match "api.example.com".
  const permitted = allowed.some((entry) => {
    const pattern = String(entry).toLowerCase().trim();
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // ".example.com"
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === pattern;
  });

  if (!permitted) {
    return { ok: false, reason: `Credential "${credential.name}" is not permitted to be sent to "${host}". Allowed: ${allowed.join(', ')}.` };
  }
  return { ok: true, url };
}

function isPrivateHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return true;
  // IPv6 loopback / unique-local / link-local
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local — includes cloud metadata endpoints
  return false;
}

module.exports = {
  vaultStatus,
  listCredentials,
  getCredential,
  getSecret,
  createCredential,
  updateCredential,
  deleteCredential,
  grantToAgent,
  revokeFromAgent,
  agentCredentials,
  checkEgress,
  isPrivateHost,
  publicView,
  // The raw AES-256-GCM primitives, for the one other place in this codebase
  // that needs to encrypt a secret outside the ai_credentials table itself:
  // mcp_oauth_grants (services/ai/mcpOAuth.js). Reusing these keeps it the
  // same crypto, the same key, the same failure mode — not a second
  // implementation of the same thing.
  encrypt,
  decrypt,
  decryptParts,
  vaultKey,
  KEY_ID,
};
