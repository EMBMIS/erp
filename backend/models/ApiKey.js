const crypto = require('crypto');
const { pool } = require('../config/database');

/**
 * ApiKey — hashed, revocable, scoped credentials for external integrations
 * (ERP-Roadmap P3 #20). The plaintext key is generated once, shown to the
 * caller exactly once at creation, and never stored — only its SHA-256 hash
 * is persisted, the same principle as password hashing.
 */
class ApiKey {
  static generate() {
    const key = 'qira_' + crypto.randomBytes(32).toString('hex');
    const prefix = key.slice(0, 12);
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    return { key, prefix, hash };
  }

  static hash(key) {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  static async create({ name, scopes = ['read'], role = 'USER', expiresAt = null }, userId) {
    const { key, prefix, hash } = this.generate();
    const result = await pool.query(
      `INSERT INTO api_keys (name, key_prefix, key_hash, scopes, role, created_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, key_prefix, scopes, role, status, created_at, expires_at`,
      [name, prefix, hash, scopes, role, userId, expiresAt]
    );
    // The plaintext key is returned ONLY here, at creation — it cannot be retrieved again.
    return { ...result.rows[0], key };
  }

  static async findAll() {
    const result = await pool.query(
      `SELECT id, name, key_prefix, scopes, role, status, created_by, last_used_at, expires_at, revoked_at, created_at
       FROM api_keys ORDER BY created_at DESC`
    );
    return result.rows;
  }

  static async revoke(id) {
    const result = await pool.query(
      `UPDATE api_keys SET status = 'REVOKED', revoked_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id`,
      [id]
    );
    if (result.rows.length === 0) throw new Error('API key not found');
    return result.rows[0];
  }

  // Validate a presented key: active, unexpired, hash matches. Updates last_used_at.
  static async validate(presentedKey) {
    if (!presentedKey || !presentedKey.startsWith('qira_')) return null;
    const hash = this.hash(presentedKey);
    const result = await pool.query(
      `SELECT id, name, scopes, role, status, expires_at, company_id FROM api_keys WHERE key_hash = $1`,
      [hash]
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.status !== 'ACTIVE') return null;
    if (row.expires_at && new Date(row.expires_at) < new Date()) return null;

    pool.query('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1', [row.id]).catch(() => {});
    return row;
  }
}

module.exports = ApiKey;
