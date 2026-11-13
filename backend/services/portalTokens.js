/**
 * Shared helpers for the customer/supplier "response link" tokens sent by
 * email (no login required — the token itself is the credential). Every such
 * token gets:
 *   - a random 256-bit value (crypto.randomBytes(32).toString('hex')), as before
 *   - an expiry (default 14 days), stored in the table's `<col>_expires_at`
 *   - a single-use marker, stamped into `<col>_used_at` when consumed
 *
 * Pre-migration tokens (generated before migration 095) have a NULL expiry and
 * remain valid indefinitely — this only tightens behavior for tokens minted
 * from here on, so nothing already emailed to a customer/supplier breaks.
 */

const crypto = require('crypto');

const DEFAULT_TTL_DAYS = 14;

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function expiryDate(days = DEFAULT_TTL_DAYS) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

/**
 * SQL fragment to append to a WHERE clause validating a token is present,
 * unexpired, and unused. `alias` is the table alias (or '' for none), and the
 * three column names default to the `<base>` + suffix convention.
 */
function validClause(alias, base) {
  const p = alias ? `${alias}.` : '';
  return `${p}${base}_expires_at IS NULL OR ${p}${base}_expires_at > NOW()`;
}

module.exports = { generateToken, expiryDate, validClause, DEFAULT_TTL_DAYS };
