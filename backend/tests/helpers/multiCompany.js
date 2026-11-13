/**
 * Test helper: enable/disable multi-company isolation for suite tests that
 * need a second company.
 *
 * Migration 111 hardened enable_multi_company(): the superuser (postgres,
 * which bypasses RLS) cannot enable isolation for itself — it must name an
 * explicit LOGIN, non-superuser role. The drill lives in
 * scripts/verify-tenancy.js; this helper is the light version for suites that
 * need TWO companies but do not need to prove isolation (the suite itself
 * keeps querying as the superuser, which bypasses the now-enabled policies —
 * per-company correctness comes from explicit company_id everywhere).
 *
 * Every operation here — creating/dropping the throwaway test role, calling
 * enable_multi_company()/disable_multi_company() (which run their ALTER TABLE
 * statements as the CALLING role — SECURITY INVOKER, not DEFINER), and the
 * cleanup DELETEs — needs table ownership. Since the application's own
 * connection (config/database.js's pool, i.e. DATABASE_URL) may now be the
 * deliberately unprivileged qira_app role (migration 111: it must NOT own the
 * tables it queries), this helper uses its own dedicated owner connection
 * (MIGRATION_DATABASE_URL, falling back to DATABASE_URL for a database that
 * hasn't split the two roles) rather than the `pool` callers pass in.
 */

const { Pool } = require('pg');

const TEST_ROLE = 'qira_round7_test';

let ddlPool = null;
function getDdlPool() {
  if (!ddlPool) {
    ddlPool = new Pool({
      connectionString: process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    });
  }
  return ddlPool;
}

async function ensureRole() {
  const pool = getDdlPool();
  const { rows } = await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [TEST_ROLE]);
  if (!rows.length) {
    await pool.query(`CREATE ROLE ${TEST_ROLE} LOGIN NOBYPASSRLS`);
  }
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${TEST_ROLE}`).catch(() => {});
  await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${TEST_ROLE}`).catch(() => {});
  await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${TEST_ROLE}`).catch(() => {});
}

// The role isolation protected BEFORE a suite borrowed it for TEST_ROLE.
//
// CI (and any database set up like production) runs with isolation already on
// for the application role (qira_app). These suites switch the database-wide
// config to TEST_ROLE and later drop that role; without putting the original
// back, every later test file inherited a config naming a role that no longer
// existed (each db-migrate resync and enable_multi_company call then failed
// with 42704) and an app connection no policy applied to — the bulk of the
// suite failed for reasons that had nothing to do with what it tested.
let originalRole; // undefined = not captured yet; null = isolation was off

function appRoleFromEnv() {
  try {
    const user = new URL(process.env.APP_DATABASE_URL || '').username;
    return user ? decodeURIComponent(user) : null;
  } catch {
    return null;
  }
}

async function captureOriginalRole() {
  if (originalRole !== undefined) return;
  const { rows } = await getDdlPool()
    .query('SELECT application_role FROM company_isolation_config WHERE id')
    .catch(() => ({ rows: [] }));
  const role = rows[0]?.application_role || null;
  // A crashed earlier run (another test file, another process) can leave
  // TEST_ROLE behind; the role the application connects as is the original.
  originalRole = role === TEST_ROLE ? appRoleFromEnv() : role;
}

async function restoreOriginalRole() {
  if (!originalRole) return;
  await getDdlPool().query('SELECT enable_multi_company($1)', [originalRole]);
}

async function enableMultiCompany() {
  const pool = getDdlPool();
  await captureOriginalRole();
  await ensureRole();
  await pool.query(
    'UPDATE company_isolation_config SET application_role = NULL, enabled_at = NULL, enabled_by = NULL'
  ).catch(() => {});
  await pool.query('SELECT enable_multi_company($1)', [TEST_ROLE]);
}

async function disableMultiCompany() {
  const pool = getDdlPool();
  await captureOriginalRole();
  try {
    await pool.query('SELECT disable_multi_company()');
  } finally {
    // Put the original role back first: once it is the configured role again,
    // TEST_ROLE owns no policy and can be dropped.
    await restoreOriginalRole();
    await pool.query(`DROP OWNED BY ${TEST_ROLE}`).catch(() => {});
    await pool.query(`DROP ROLE IF EXISTS ${TEST_ROLE}`).catch(() => {});
  }
}

async function insertAsAppRole(_pool, sql, params) {
  await ensureRole();
  const pool = getDdlPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE ' + TEST_ROLE);
      const result = await client.query(sql, params);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } finally {
    client.release();
  }
}

/**
 * Reset any state a previous crashed run may have left behind: test companies,
 * their children, isolation, and the test role.
 * Self-healing so a suite can rerun after a mid-run failure.
 */
async function resetTestCompanies(_pool) {
  const pool = getDdlPool();
  await captureOriginalRole();
  const ids = await pool.query(
    `SELECT id FROM companies WHERE deleted_at IS NULL AND is_default = false`
  );
  if (ids.rows.length) {
    const idList = ids.rows.map(r => `'${r.id}'`).join(',');
    const order = [
      `UPDATE companies SET parent_company_id = NULL WHERE id IN (${idList})`,
      // The scheduler auto-seeds an agent_definitions row for every company
      // it sees (services/agents' scheduler tick) — without this, a leftover
      // test company that ran even one scheduler tick blocks its own delete
      // below with fk_agent_definitions_company, silently leaving it around
      // for every subsequent run to trip over (e.g. continuousClose.test.js's
      // "Cannot disable company isolation while N companies exist").
      `DELETE FROM agent_definitions WHERE company_id IN (${idList})`,
      `DELETE FROM ai_findings WHERE company_id IN (${idList})`,
      `DELETE FROM ai_finding_suppressions WHERE company_id IN (${idList})`,
      `DELETE FROM customer_invoices WHERE company_id IN (${idList})`,
      `DELETE FROM customers WHERE company_id IN (${idList})`,
      `DELETE FROM journal_entry_items WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE company_id IN (${idList}))`,
      `DELETE FROM journal_entry_items WHERE account_id IN (SELECT id FROM chart_of_accounts WHERE company_id IN (${idList}))`,
      `DELETE FROM journal_entries WHERE company_id IN (${idList})`,
      `DELETE FROM company_gl_mappings WHERE company_id IN (${idList})`,
      `DELETE FROM chart_of_accounts WHERE company_id IN (${idList})`,
      `DELETE FROM intercompany_transactions WHERE from_company_id IN (${idList}) OR to_company_id IN (${idList})`,
      `DELETE FROM user_companies WHERE company_id IN (${idList})`,
      `DELETE FROM inventory_storage_mappings WHERE inventory_item_id IN (SELECT id FROM inventory_items WHERE company_id IN (${idList}))`,
      `DELETE FROM warehouse_transactions WHERE company_id IN (${idList})`,
      `DELETE FROM inventory_transfers WHERE inventory_item_id IN (SELECT id FROM inventory_items WHERE company_id IN (${idList}))`,
      `DELETE FROM inventory_items WHERE company_id IN (${idList})`,
      `DELETE FROM storage_locations WHERE company_id IN (${idList})`,
      `DELETE FROM purchase_orders WHERE company_id IN (${idList})`,
      `DELETE FROM purchase_requisitions WHERE company_id IN (${idList})`,
      `DELETE FROM sales_orders WHERE company_id IN (${idList})`,
      `DELETE FROM sales_quotations WHERE company_id IN (${idList})`,
      `DELETE FROM contracts WHERE company_id IN (${idList})`,
      `DELETE FROM supplier_payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id IN (${idList}))`,
      `DELETE FROM supplier_payments WHERE company_id IN (${idList})`,
      `DELETE FROM supplier_invoices WHERE company_id IN (${idList})`,
      `DELETE FROM approval_chain_steps WHERE template_id IN (SELECT id FROM approval_chain_templates WHERE company_id IN (${idList}))`,
      `DELETE FROM approval_chain_templates WHERE company_id IN (${idList})`,
      `DELETE FROM suppliers WHERE company_id IN (${idList})`,
      `DELETE FROM items WHERE company_id IN (${idList})`,
      `DELETE FROM companies WHERE id IN (${idList})`,
    ];
    for (const sql of order) {
      await pool.query(sql).catch(e => console.warn('reset skip: ' + e.message.split('\n')[0]));
    }
  }
  await pool.query('SELECT disable_multi_company()').catch(() => {});
  await restoreOriginalRole().catch((e) => console.warn('reset: could not restore isolation: ' + e.message));
  await pool.query(`DROP OWNED BY ${TEST_ROLE}`).catch(() => {});
  await pool.query(`DROP ROLE IF EXISTS ${TEST_ROLE}`).catch(() => {});
}

/**
 * Run DDL that requires table ownership.
 *
 * The application pool connects as the deliberately unprivileged role
 * (migration 111: it must NOT own the tables it queries), so ALTER TABLE from
 * a test body fails with "must be owner of table". A suite that needs to lift
 * a CHECK constraint to build an intentionally-invalid fixture has to issue
 * that one statement over the owner connection while everything else stays on
 * the app pool — dropping the constraint is setup, not part of what is under
 * test.
 */
async function runAsOwner(sql, params = []) {
  return getDdlPool().query(sql, params);
}

module.exports = { enableMultiCompany, disableMultiCompany, insertAsAppRole, resetTestCompanies, runAsOwner };
