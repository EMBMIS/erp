// Regression test for a real, live-reported production bug: a company-scoped
// table added by a migration AFTER company isolation was first turned on
// (enable_multi_company(role), migrations 110/112) never got its RLS policy
// applied, because that function only protects whatever is in
// company_scoped_tables at the moment it runs — it does not retroactively
// cover tables a later migration registers.
//
// migrations/202608071500_modules_and_business_types.sql registered
// company_modules into company_scoped_tables but — unlike a later migration
// (202608141000_hr_payroll_leave_org.sql) that correctly re-applied RLS to
// its own new tables via a DO $$ ... $$ block — never re-synced the policy.
// On any database where isolation was already enabled before that migration
// ran, every write to company_modules (specifically PUT /company-modules/:key,
// the "Modules" admin settings page's toggle) failed with Postgres's own
// "new row violates row-level security policy for table company_modules" —
// reported live from a real deployed instance, reproduced by asking why the
// admin "Modules" screen couldn't turn on Procurement/Sales/Inventory/etc.
//
// The fix: scripts/db-migrate.js now re-runs enable_multi_company(role) once
// at the end of every --apply pass (idempotent — DROP POLICY IF EXISTS then
// CREATE, per migration 112), covering ANY table in company_scoped_tables,
// not just company_modules — so this bug class cannot recur for any future
// migration that adds a new company-scoped table and forgets the same
// self-healing block. This test proves that resync step actually reaches and
// repairs a table with a broken/missing policy, using company_modules itself
// as the real-world case, then proves a genuine write succeeds afterward.
//
// Real-DB suite: self-skips when no database is reachable, or when this
// database has never had isolation enabled (nothing to resync). Run on its
// own (it opens a pg pool and must not race other suites):
//   cd backend && node --test tests/companyIsolationResyncRegression.test.js

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const { pool } = require('../config/database'); // the app's own restricted (qira_app) connection
const companyContext = require('../services/companyContext');
const moduleService = require('../services/moduleService');
const { resyncCompanyIsolation } = require('../scripts/db-migrate');

// DROP POLICY requires table ownership, which the app's restricted runtime
// role deliberately does not have (that's the whole point of the role split
// — see config/database.js's header). Simulating "a table registered without
// its policy yet" needs the SAME owner-level connection real migrations run
// under (scripts/db-migrate.js's MIGRATION_DATABASE_URL || DATABASE_URL).
const ownerPool = new Pool({
  connectionString: process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

let dbAvailable = false;
let isolationEnabled = false;
let appRole = null;
let companyId = null;

before(async () => {
  try {
    await pool.query('SELECT 1');
    dbAvailable = true;
    const cfg = await pool.query(
      'SELECT application_role FROM company_isolation_config WHERE id AND application_role IS NOT NULL'
    ).catch(() => ({ rows: [] }));
    appRole = cfg.rows[0]?.application_role || null;
    isolationEnabled = Boolean(appRole);
    companyId = await companyContext.getDefaultCompanyId();
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  await pool.end().catch(() => {});
  await ownerPool.end().catch(() => {});
});

test('company_modules has a real, working isolation policy after a resync (the actual table this bug broke)', async (t) => {
  if (!dbAvailable) return t.skip('no database available');
  if (!isolationEnabled) return t.skip('company isolation is not enabled on this database — nothing to resync');
  if (!companyId) return t.skip('no default company on this database');

  // Deliberately drop company_modules' policy first, simulating exactly the
  // state a database is left in when a migration registers a new
  // company-scoped table without re-applying RLS to it (what
  // 202608071500_modules_and_business_types.sql actually did). Needs the
  // owner connection — DROP POLICY requires table ownership.
  await ownerPool.query('DROP POLICY IF EXISTS company_isolation ON company_modules');

  // Reproduce the bug: a write through the real service (the same code path
  // PUT /company-modules/:key uses) now fails exactly the way the live
  // deployment reported.
  await assert.rejects(
    () => companyContext.runWithCompany(companyId, () =>
      moduleService.setModuleEnabled(companyId, 'crm', true)),
    /row-level security/i,
    'with the policy dropped, a company_modules write must fail with the real Postgres RLS error'
  );

  // The fix: run the same resync step scripts/db-migrate.js now runs at the
  // end of every migration pass.
  await resyncCompanyIsolation();

  // The identical write now succeeds.
  await companyContext.runWithCompany(companyId, () =>
    moduleService.setModuleEnabled(companyId, 'crm', true));

  const status = await companyContext.runWithCompany(companyId, () =>
    moduleService.getModulesWithStatus(companyId));
  const crm = status.find((m) => m.key === 'crm');
  assert.equal(crm.enabled, true, 'the module toggle must have actually taken effect, not just avoided throwing');

  // Leave company_modules exactly as found: disabled again, policy back in place.
  await companyContext.runWithCompany(companyId, () =>
    moduleService.setModuleEnabled(companyId, 'crm', false));
});

test('resyncCompanyIsolation is a safe no-op when isolation was never enabled', async (t) => {
  if (!dbAvailable) return t.skip('no database available');
  if (isolationEnabled) return t.skip('isolation IS enabled on this database — this scenario is covered by the other test');

  // Must resolve cleanly (not throw) and must not itself enable isolation —
  // this step must never be what silently turns isolation on for a
  // deployment that has not opted in.
  await resyncCompanyIsolation();
  const status = await pool.query('SELECT multi_company_enabled() AS enabled');
  assert.equal(status.rows[0].enabled, false, 'a resync must never be the thing that turns isolation on');
});
