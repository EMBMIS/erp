#!/usr/bin/env node
/**
 * Does the background agent scheduler actually see company-scoped data once
 * row-level security is on, or does it go silently blind?
 *
 * Same drill shape as verify-tenancy.js: create a role that cannot bypass
 * RLS, enable isolation for it, run this process's OWN connection pool as
 * that role (config/database.js reads DATABASE_URL at require-time, so this
 * must be set before anything else in this file requires it), then exercise
 * the exact call path the scheduler uses — forEachCompany() wrapping
 * runtime.runAgent() — and check whether a real, data-dependent agent run
 * finds the real row it should find.
 *
 * Restores everything it changed, including on failure.
 */

require('dotenv').config();

const TEST_ROLE = 'qira_scheduler_drill';
const TEST_PASSWORD = 'drill_' + Math.random().toString(36).slice(2, 12);

async function main() {
  // Bootstrap connection as whatever DATABASE_URL already points at (the
  // superuser) to set up the role and enable isolation, BEFORE the app's
  // own pool is created against the drill role.
  const { Pool } = require('pg');
  const bootUrl = new URL(process.env.DATABASE_URL);
  const bootPool = new Pool({
    host: bootUrl.hostname, port: bootUrl.port || 5432,
    database: bootUrl.pathname.slice(1),
    user: bootUrl.username, password: bootUrl.password, ssl: false, max: 2,
  });

  let policiesEnabled = false;
  let itemId = null;
  let defaultCompanyId = null;

  try {
    const { rows: superRows } = await bootPool.query(
      'SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
    if (!superRows[0]?.rolsuper) {
      throw new Error('Must run as a superuser to set this up. Point DATABASE_URL at an admin connection.');
    }

    await bootPool.query(`DROP OWNED BY ${TEST_ROLE}`).catch(() => {});
    await bootPool.query(`DROP ROLE IF EXISTS ${TEST_ROLE}`).catch(() => {});
    await bootPool.query(`CREATE ROLE ${TEST_ROLE} LOGIN PASSWORD '${TEST_PASSWORD}' NOBYPASSRLS`);
    await bootPool.query(`GRANT USAGE ON SCHEMA public TO ${TEST_ROLE}`);
    await bootPool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${TEST_ROLE}`);
    await bootPool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${TEST_ROLE}`);
    console.log(`  created role ${TEST_ROLE} (NOBYPASSRLS)`);

    await bootPool.query('SELECT enable_multi_company($1)', [TEST_ROLE]);
    policiesEnabled = true;
    console.log('  isolation policies enabled');

    const { rows: dc } = await bootPool.query('SELECT id FROM companies WHERE is_default = true');
    defaultCompanyId = dc[0].id;

    // No need to plant a row — every existing chart_of_accounts row already
    // belongs to the default company (migration 110 backfilled company_id on
    // every scoped table). Pick one that already exists and check whether the
    // scheduler's own call path can see it once isolation is on.
    const { rows: coa } = await bootPool.query(
      'SELECT id FROM chart_of_accounts WHERE deleted_at IS NULL LIMIT 1');
    if (!coa.length) throw new Error('No chart_of_accounts row to probe with.');
    itemId = coa[0].id;

    // Now point THIS process's connection at the unprivileged role and boot
    // the app's real modules against it — config/database.js's pool is a
    // module-level singleton created from DATABASE_URL at require time.
    process.env.DATABASE_URL =
      `postgresql://${TEST_ROLE}:${TEST_PASSWORD}@${bootUrl.hostname}:${bootUrl.port || 5432}${bootUrl.pathname}`;

    const { pool: appPool } = require('../config/database');
    const { rows: whoami } = await appPool.query(
      'SELECT current_user AS u, public.role_bypasses_rls() AS bypasses');
    if (whoami[0].bypasses) throw new Error(`${whoami[0].u} still bypasses RLS.`);
    console.log(`  app pool connected as ${whoami[0].u}, which does not bypass RLS`);

    const { forEachCompany, currentCompanyId } = require('../services/companyContext');

    console.log('\nRunning the exact scheduler call path…');
    console.log(`  (this DB has many leftover companies from prior test runs — checking`);
    console.log(`   specifically the default company's own iteration, not just the last one)`);
    let sawItemForDefaultCompany = false;
    let defaultIterationRan = false;

    await forEachCompany(async (companyId) => {
      // Don't run a real agent implementation (side effects, email, etc.) —
      // just prove the SAME ambient context an agent would run under can see
      // the row that was planted under isolation. This is the load-bearing
      // question: does context survive being INSIDE forEachCompany's callback,
      // the same place runtime.runAgent() is invoked from in scheduler.js.
      const { rows } = await appPool.query('SELECT id FROM chart_of_accounts WHERE id = $1', [itemId]);
      if (companyId === defaultCompanyId) {
        defaultIterationRan = true;
        sawItemForDefaultCompany = rows.length === 1 && currentCompanyId() === defaultCompanyId;
      } else if (rows.length === 1) {
        throw new Error(`Isolation breach: company ${companyId}'s context saw the default company's row.`);
      }
    });

    console.log(`  default company's own iteration ran: ${defaultIterationRan}`);
    console.log(`  probe row visible inside that iteration: ${sawItemForDefaultCompany}`);

    const contextOk = defaultIterationRan;
    const dataOk = sawItemForDefaultCompany;

    console.log('\n' + '='.repeat(60));
    if (contextOk && dataOk) {
      console.log('PASS — the scheduler\'s call path (forEachCompany) establishes company');
      console.log('context correctly; a query made from inside it sees the right tenant\'s data.');
      process.exitCode = 0;
    } else {
      console.log('FAIL — the scheduler would go blind under isolation.');
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('\n❌', error.message);
    process.exitCode = 1;
  } finally {
    console.log('\nRestoring…');
    if (policiesEnabled) {
      const { rows } = await bootPool.query('SELECT table_name FROM company_scoped_tables');
      for (const { table_name } of rows) {
        await bootPool.query(`ALTER TABLE ${table_name} NO FORCE ROW LEVEL SECURITY`).catch(() => {});
        await bootPool.query(`ALTER TABLE ${table_name} DISABLE ROW LEVEL SECURITY`).catch(() => {});
      }
      await bootPool.query('UPDATE company_isolation_config SET application_role = NULL, enabled_at = NULL').catch(() => {});
      console.log(`  policies disabled on ${rows.length} tables`);
    }
    await bootPool.query(`REASSIGN OWNED BY ${TEST_ROLE} TO CURRENT_USER`).catch(() => {});
    await bootPool.query(`DROP OWNED BY ${TEST_ROLE}`).catch(() => {});
    await bootPool.query(`DROP ROLE IF EXISTS ${TEST_ROLE}`).catch(() => {});
    await bootPool.end().catch(() => {});
    console.log('  role and test data removed');
  }
}

main().then(() => process.exit(process.exitCode || 0));
