/**
 * Which company the current request is acting for.
 *
 * ===========================================================================
 * WHY THIS IS NOT JUST `req.companyId`
 * ===========================================================================
 *
 * The database enforces company isolation through row-level security, which
 * reads the company from the `app.current_company_id` session setting. Getting
 * that setting onto the connection is the entire problem, because this
 * application shares a connection pool.
 *
 * A plain `SET app.current_company_id = ...` lasts for the life of the
 * *connection*, not the request. Set it, run a query, return the connection to
 * the pool, and the next request — possibly for a different company — inherits
 * it. That is a cross-tenant data leak caused by the very mechanism meant to
 * prevent one, and it would appear only under concurrency.
 *
 * So the setting is only ever applied with `SET LOCAL`, inside an explicit
 * transaction, on a connection held for the duration of that transaction.
 * `SET LOCAL` is rolled back at COMMIT or ROLLBACK, so a connection can never
 * carry a company back into the pool. There is no code path here that sets it
 * any other way.
 *
 * `AsyncLocalStorage` carries the company id down through the call stack so
 * models do not each need it threaded through their arguments — but it is only
 * the carrier. The enforcement is `withCompany`, and ultimately the database.
 */

const { pool, resetIsolationCache } = require('../config/database');

// The carrier lives in services/companyScope.js, with no dependencies, because
// config/database.js needs it too and requiring this module from there would
// be a cycle. Critically it must be the SAME AsyncLocalStorage instance: two
// separate ones would each look correct in isolation while the database layer
// read an empty store and applied no company at all.
const { storage } = require('./companyScope');

// Not every authenticated identity is a user row. API-key auth uses the
// synthetic id `api-key-<uuid>` and the internal-service path uses `ai-system`;
// comparing either against a uuid column throws.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The default company, cached after first lookup. Safe to cache: a default
// company is created by migration 110 and there is a unique index ensuring
// there is exactly one, so it does not change under a running process.
let defaultCompanyId = null;
let isolationActive = null;

async function getDefaultCompanyId() {
  if (defaultCompanyId) return defaultCompanyId;
  const { rows } = await pool.query(
    'SELECT id FROM companies WHERE is_default = true AND deleted_at IS NULL LIMIT 1'
  );
  if (!rows.length) throw new Error('No default company is configured.');
  defaultCompanyId = rows[0].id;
  return defaultCompanyId;
}

/**
 * Is company isolation actually in force on this connection?
 *
 * Deliberately asks the database rather than reading an environment variable.
 * A config flag says what someone intended; this says what is true, and the
 * two came apart badly enough once already (migration 111).
 */
async function isolationEnabled() {
  if (isolationActive !== null) return isolationActive;
  try {
    const { rows } = await pool.query('SELECT multi_company_enabled() AS enabled');
    isolationActive = rows[0].enabled === true;
  } catch {
    // Pre-migration databases have no such function. Single-company.
    isolationActive = false;
  }
  return isolationActive;
}

// Exposed for tests and for the admin endpoint that turns isolation on, after
// which the cached answer is stale. Clears the database layer's copy too —
// that one gates whether SET LOCAL is applied at all, so leaving it stale
// would mean isolation was "on" everywhere except where it does the work.
function resetCache() {
  defaultCompanyId = null;
  isolationActive = null;
  resetIsolationCache();
}

/** The company for the current request, or null outside one. */
function currentCompanyId() {
  return storage.getStore()?.companyId || null;
}

/** Run `fn` with `companyId` as the ambient company. */
function runWithCompany(companyId, fn) {
  return storage.run({ companyId }, fn);
}

/**
 * Run `fn` inside a transaction whose company context the database can see.
 *
 * The callback receives the client and MUST use it for every query it makes —
 * a query sent through the shared `pool` instead goes out on a different
 * connection, which has no `SET LOCAL` applied and, under isolation, will
 * quietly return nothing.
 *
 * @param {string|null} companyId  Company to act as; defaults to the ambient
 *                                 one, then to the default company.
 * @param {(client) => Promise<any>} fn
 */
async function withCompany(companyId, fn) {
  const resolved = companyId || currentCompanyId() || (await getDefaultCompanyId());

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // `true` is the is_local flag: scoped to this transaction, discarded on
    // COMMIT/ROLLBACK. This is what makes pooling safe — see the header.
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [resolved]);

    const result = await storage.run({ companyId: resolved }, () => fn(client));

    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * May this user act for this company?
 */
async function userCanAccess(userId, companyId) {
  if (!userId || !companyId) return false;

  if (!UUID_RE.test(String(userId))) {
    return companyId === (await getDefaultCompanyId());
  }

  const explicit = await pool.query(
    'SELECT 1 FROM user_companies WHERE user_id = $1 AND company_id = $2',
    [userId, companyId]
  );
  if (explicit.rows.length) return true;

  const any = await pool.query('SELECT 1 FROM user_companies WHERE user_id = $1 LIMIT 1', [userId]);
  if (any.rows.length) return false;

  return companyId === (await getDefaultCompanyId());
}

async function primaryCompanyFor(userId) {
  if (!userId) return null;
  if (!UUID_RE.test(String(userId))) return null;
  const { rows } = await pool.query(
    `SELECT company_id FROM user_companies
      WHERE user_id = $1 ORDER BY is_primary DESC, created_at LIMIT 1`,
    [userId]
  );
  return rows[0]?.company_id || null;
}

async function listCompaniesFor(userId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.company_code, c.name, c.base_currency, c.locale, c.timezone,
            c.is_default, uc.is_primary, uc.role
       FROM companies c
       LEFT JOIN user_companies uc ON uc.company_id = c.id AND uc.user_id = $1
      WHERE c.deleted_at IS NULL AND c.status = 'ACTIVE'
        AND (uc.user_id IS NOT NULL
             OR NOT EXISTS (SELECT 1 FROM user_companies WHERE user_id = $1))
      ORDER BY c.is_default DESC, c.name`,
    [userId]
  );
  return rows;
}

async function forEachCompany(fn) {
  const { rows } = await pool.query(
    "SELECT id FROM companies WHERE deleted_at IS NULL AND (status = 'ACTIVE' OR status IS NULL) ORDER BY is_default DESC, id"
  );
  const results = [];
  for (const row of rows) {
    const companyId = row.id;
    try {
      const res = await runWithCompany(companyId, () => fn(companyId));
      results.push({ companyId, status: 'fulfilled', value: res });
    } catch (err) {
      console.error(`[companyContext] forEachCompany failed for tenant ${companyId}:`, err);
      results.push({ companyId, status: 'rejected', reason: err });
    }
  }
  return results;
}

module.exports = {
  withCompany,
  runWithCompany,
  currentCompanyId,
  getDefaultCompanyId,
  isolationEnabled,
  userCanAccess,
  primaryCompanyFor,
  listCompaniesFor,
  forEachCompany,
  resetCache,
};

