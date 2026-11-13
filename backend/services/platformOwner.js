/**
 * Platform-owner identification for code paths that hold only a user id.
 *
 * middleware/auth.js's `isPlatformOwner(user)` answers the question from a
 * user object (email, is_platform_owner, synthetic-principal flags). Several
 * services receive an actor as `{ id, role }` only — the Authority Engine,
 * the Approval Rules Engine, approval-chain decisions, the PurchaseOrder
 * model — and need the same answer from a database lookup. This is that
 * lookup, and it honors the same precedence as middleware/auth.js:
 *
 *   • PLATFORM_OWNER_EMAIL (server environment) wins when set — it is the
 *     recovery path if the one-time claim landed on the wrong account, and it
 *     cannot be changed from inside the product.
 *   • Otherwise the claimed owner (migration 202608100100), guaranteed
 *     single by a partial unique index on users.is_platform_owner.
 *
 * The users table is deliberately NOT company-scoped (login must work before
 * any company context exists), so this lookup is safe under row-level
 * isolation without an ambient company.
 */

const { pool } = require('../config/database');

/**
 * @param {string|number} userId - id of the actor to test
 * @param {object} [client] - optional pg client to run the lookup on
 *   (e.g. inside an existing transaction, so the answer is consistent with
 *   the rows the transaction is about to write)
 * @returns {Promise<boolean>}
 */
async function isPlatformOwnerId(userId, client = null) {
  if (!userId) return false;

  const db = client || pool;
  const { rows } = await db.query(
    'SELECT email, is_platform_owner FROM users WHERE id::text = $1::text',
    [String(userId)]
  );
  if (rows.length === 0) return false;

  const configured = (process.env.PLATFORM_OWNER_EMAIL || '').trim().toLowerCase();
  if (configured) {
    return String(rows[0].email || '').trim().toLowerCase() === configured;
  }
  return rows[0].is_platform_owner === true;
}

/**
 * The identity a system/automated posting (depreciation run, goods receipt,
 * and similar mechanical month-end charges) records as the POSTER of its GL
 * entry. The user who triggers the run must NOT also be the user who posts it
 * — checkSoD refuses creator == poster — so a self-posting flow can never
 * reach POSTED (ERP blocker #4 for depreciation, and the same refusal blocked
 * goods receipts for any non-owner user). The platform owner is the
 * deployment's designated system posting identity, distinct from the runner,
 * who stays recorded as creator. Fails closed when no authority is configured.
 *
 * @param {string} userId - the user who triggered the run (stays the creator)
 * @param {object} [client] - optional pg client to run the lookup on
 * @returns {Promise<string>} the identity to record as the poster
 */
async function resolvePostingAuthority(userId, client = null) {
  const db = client || pool;
  if (await isPlatformOwnerId(userId, db)) return userId;
  const configured = (process.env.PLATFORM_OWNER_EMAIL || '').trim().toLowerCase();
  const { rows } = configured
    ? await db.query('SELECT id FROM users WHERE lower(email) = $1 AND deleted_at IS NULL LIMIT 1', [configured])
    : await db.query('SELECT id FROM users WHERE is_platform_owner = true AND deleted_at IS NULL LIMIT 1');
  if (rows.length === 0) {
    throw new Error('Cannot post: no posting authority is configured. Set PLATFORM_OWNER_EMAIL (or claim the platform-owner account) so automated postings can run under a distinct identity.');
  }
  return rows[0].id;
}

module.exports = { isPlatformOwnerId, resolvePostingAuthority };
