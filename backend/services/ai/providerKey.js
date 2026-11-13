/**
 * The AI provider's API key, as the platform owner sets it in Settings → AI.
 *
 * Without this, the only way to replace a rejected or expired key was to edit the server's environment and
 * redeploy, and every AI feature said "Something went wrong" until someone did. A key entered here is tested
 * against the provider before it is kept, stored encrypted (system_secrets, AI_VAULT_KEY), and used at once:
 * the AI clients are rebuilt with it. "Use the server's key" removes it again.
 */
const { pool } = require('../../config/database');
const vault = require('./credentialVault');
const aiConfig = require('../../config/aiConfig');

const NAME = 'ai_provider_key';
let current = null; // { last4, setAt, setBy }
let loadedAt = 0;

function envKey() {
  const p = aiConfig.getAIProvider();
  return p === 'anthropic' ? process.env.ANTHROPIC_API_KEY : p === 'openrouter' ? process.env.OPENROUTER_API_KEY : process.env.OPENAI_API_KEY;
}
const envName = () => ({ anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY' }[aiConfig.getAIProvider()] || 'OPENAI_API_KEY');

/** Read the stored key (if any) and hand it to the AI clients. Safe to call often; a missing table is no key. */
async function load() {
  try {
    const { rows } = await pool.query('SELECT * FROM system_secrets WHERE name = $1', [NAME]);
    const row = rows[0];
    if (!row) { current = null; aiConfig.setKeyOverride(null) } else {
      const key = vault.decryptParts({ cipher: row.cipher, iv: row.iv, tag: row.tag }, 'AI provider key');
      current = { last4: key.slice(-4), setAt: row.updated_at, setBy: row.updated_by };
      aiConfig.setKeyOverride(key);
    }
  } catch (err) {
    if (!/relation .*system_secrets.* does not exist/i.test(err.message)) console.error('[ai-provider] could not load the stored key:', err.message);
  }
  loadedAt = Date.now();
}

/** Several server processes: pick up a key another one stored, within a minute. */
async function fresh() { if (Date.now() - loadedAt > 60_000) await load(); }

/** Ask the provider whether a key works, without spending anything. */
async function test(key) {
  const provider = aiConfig.getAIProvider();
  const ctl = AbortSignal.timeout(15000);
  let r;
  try {
    if (provider === 'openrouter') r = await fetch(`${process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'}/key`, { headers: { authorization: `Bearer ${key}` }, signal: ctl });
    else if (provider === 'anthropic') r = await fetch(`${process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/models`, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: ctl });
    else r = await fetch(`${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/models`, { headers: { authorization: `Bearer ${key}` }, signal: ctl });
  } catch (err) {
    return { ok: false, reason: `The AI provider could not be reached from the server (${err.message}).` };
  }
  if (r.ok) return { ok: true };
  if (r.status === 401 || r.status === 403) return { ok: false, reason: 'The AI provider rejected this key.' };
  return { ok: false, reason: `The AI provider answered ${r.status} when checking the key.` };
}

async function save(key, userId) {
  const k = String(key || '').trim();
  if (k.length < 12 || k.length > 400 || /\s/.test(k)) return { ok: false, reason: 'That does not look like an API key.' };
  const t = await test(k);
  if (!t.ok) return t;
  const e = vault.encrypt(k);
  await pool.query(
    `INSERT INTO system_secrets (name, cipher, iv, tag, key_id, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
     ON CONFLICT (name) DO UPDATE SET cipher = EXCLUDED.cipher, iv = EXCLUDED.iv, tag = EXCLUDED.tag, key_id = EXCLUDED.key_id, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
    [NAME, e.cipher, e.iv, e.tag, e.keyId, userId || null]
  );
  await load();
  return { ok: true };
}

async function clear() {
  await pool.query('DELETE FROM system_secrets WHERE name = $1', [NAME]);
  await load();
  return { ok: true };
}

/** What Settings → AI shows. Never the key itself. */
async function status({ check = false } = {}) {
  await fresh();
  const env = envKey();
  const out = { provider: aiConfig.getAIProvider(), envVariable: envName(), source: current ? 'settings' : env ? 'server' : 'none', last4: current?.last4 || (env ? String(env).slice(-4) : null), setAt: current?.setAt || null, vault: vault.vaultStatus().configured };
  if (check && (current || env)) out.check = await test(aiConfig.currentKey());
  return out;
}

module.exports = { load, fresh, test, save, clear, status };
