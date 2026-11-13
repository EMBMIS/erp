// The AI provider key the platform owner sets in Settings → AI: checked with the provider before it is kept,
// stored encrypted, used at once, and removable. Database and provider are stubbed; no network, no PostgreSQL.
//   node --test tests/providerKey.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.AI_PROVIDER = 'openrouter';
process.env.OPENROUTER_API_KEY = 'sk-or-server-key-0000';
process.env.AI_VAULT_KEY = crypto.randomBytes(32).toString('hex');

// An in-memory system_secrets table.
const rows = new Map();
const pool = {
  async query(sql, params = []) {
    if (/^SELECT \* FROM system_secrets/.test(sql)) return { rows: rows.has(params[0]) ? [rows.get(params[0])] : [] };
    if (/^INSERT INTO system_secrets/.test(sql)) { const [name, cipher, iv, tag, key_id, updated_by] = params; rows.set(name, { name, cipher, iv, tag, key_id, updated_by, updated_at: new Date() }); return { rows: [] }; }
    if (/^DELETE FROM system_secrets/.test(sql)) { rows.delete(params[0]); return { rows: [] }; }
    throw new Error('unexpected query ' + sql);
  },
};
require.cache[path.resolve(__dirname, '../config/database.js')] = { id: 'db', filename: 'db', loaded: true, exports: { pool } };

// The provider accepts exactly one key.
const GOOD = 'sk-or-v1-good-key-1234';
const seen = [];
global.fetch = async (url, init = {}) => { seen.push(url); const ok = init.headers?.authorization === `Bearer ${GOOD}`; return { ok, status: ok ? 200 : 401 }; };

const aiConfig = require('../config/aiConfig');
const providerKey = require('../services/ai/providerKey');

test('without a stored key, the server key is used and reported by its last four characters', async () => {
  await providerKey.load();
  assert.equal(aiConfig.currentKey(), 'sk-or-server-key-0000');
  const s = await providerKey.status();
  assert.equal(s.source, 'server'); assert.equal(s.last4, '0000'); assert.equal(s.envVariable, 'OPENROUTER_API_KEY')
});

test('a key the provider rejects is not kept', async () => {
  const r = await providerKey.save('sk-or-v1-wrong-key-9999', 'u1');
  assert.equal(r.ok, false); assert.match(r.reason, /rejected/);
  assert.equal(rows.size, 0); assert.equal(aiConfig.currentKey(), 'sk-or-server-key-0000');
  assert.match(seen.at(-1), /openrouter\.ai\/api\/v1\/key$/);
});

test('something that is not a key is refused before asking the provider', async () => {
  const before = seen.length;
  assert.equal((await providerKey.save('hello world', 'u1')).ok, false);
  assert.equal(seen.length, before);
});

test('an accepted key is stored encrypted, used at once, and never reported in full', async () => {
  assert.equal((await providerKey.save(`  ${GOOD}  `, 'u1')).ok, true);
  const row = rows.get('ai_provider_key');
  assert.ok(row.cipher && !row.cipher.includes('good-key'));
  assert.equal(aiConfig.currentKey(), GOOD); assert.equal(aiConfig.isAIEnabled(), true);
  const s = await providerKey.status({ check: true });
  assert.equal(s.source, 'settings'); assert.equal(s.last4, '1234'); assert.equal(s.check.ok, true);
  assert.doesNotMatch(JSON.stringify(s), /good-key/);
});

test('another server process picks the stored key up on load', async () => {
  aiConfig.setKeyOverride(null);
  await providerKey.load();
  assert.equal(aiConfig.currentKey(), GOOD);
});

test("'Use the server's key' removes it again", async () => {
  await providerKey.clear();
  assert.equal(rows.size, 0); assert.equal(aiConfig.currentKey(), 'sk-or-server-key-0000');
});
