#!/usr/bin/env node
/**
 * The multi-tenancy drill: turn isolation on for real, and try to break it.
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST
 * ---------------------------------------------------------------------------
 * Row-level security cannot be verified from the connection this project
 * normally uses. Development connects as `postgres` — a superuser, for which
 * Postgres skips RLS unconditionally, no matter how the policies are written.
 * Migration 111 exists precisely because that was once mistaken for isolation
 * working.
 *
 * So a real check has to (a) create a role that does NOT bypass RLS, (b) enable
 * the policies across every scoped table, and (c) connect as that role. All
 * three reconfigure the database, which is not something a `npm test` run
 * should do behind someone's back. Hence: an explicit command.
 *
 *     node scripts/verify-tenancy.js
 *
 * It restores everything it changed, including on failure. The cheap schema
 * invariants — defaults, NOT NULL, per-company unique keys — live in
 * tests/tenancy.test.js and run in CI.
 *
 * WHAT IT PROVES
 * ---------------------------------------------------------------------------
 *   1. A second tenant can be created at all (migration 110's guard refuses
 *      this until policies are genuinely active — so reaching step 2 is itself
 *      a result).
 *   2. An INSERT that never mentions company_id lands in the right tenant.
 *   3. Each tenant reads only its own rows.
 *   4. A tenant cannot write a row owned by another tenant.
 *   5. Two tenants may use the same natural key.
 *   6. No company context yields no rows — failing closed, not open.
 */

const { pool } = require('../config/database');

const TEST_ROLE = 'qira_tenancy_drill';
const TEST_PASSWORD = 'drill_' + Math.random().toString(36).slice(2, 12);

let appPool = null;
const results = [];
let policiesEnabled = false;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function asTenant(companyId, fn) {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function setup() {
  console.log('\nSetting up…');

  const { rows: superRows } = await pool.query(
    'SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
  if (!superRows[0]?.rolsuper) {
    throw new Error(
      'This drill has to create a role and enable policies, so it must be run as a superuser. '
      + 'Point DATABASE_URL at an admin connection.');
  }

  // A role that is emphatically NOT exempt from RLS — the whole point.
  await pool.query(`DROP OWNED BY ${TEST_ROLE}`).catch(() => {});
  await pool.query(`DROP ROLE IF EXISTS ${TEST_ROLE}`).catch(() => {});
  await pool.query(`CREATE ROLE ${TEST_ROLE} LOGIN PASSWORD '${TEST_PASSWORD}' NOBYPASSRLS`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${TEST_ROLE}`);
  await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${TEST_ROLE}`);
  await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${TEST_ROLE}`);
  console.log(`  created role ${TEST_ROLE} (NOBYPASSRLS)`);

  await pool.query('SELECT enable_multi_company($1)', [TEST_ROLE]);
  policiesEnabled = true;
  console.log('  isolation policies enabled');

  const { Pool } = require('pg');
  const url = new URL(process.env.DATABASE_URL);
  appPool = new Pool({
    host: url.hostname,
    port: url.port || 5432,
    database: url.pathname.slice(1),
    user: TEST_ROLE,
    password: TEST_PASSWORD,
    ssl: false,
    max: 4,
  });

  const { rows } = await appPool.query(
    'SELECT current_user AS u, public.role_bypasses_rls() AS bypasses');
  if (rows[0].bypasses) {
    throw new Error(`${rows[0].u} still bypasses RLS — the drill would prove nothing.`);
  }
  console.log(`  connected as ${rows[0].u}, which does not bypass RLS`);
}

async function teardown() {
  console.log('\nRestoring…');
  if (appPool) await appPool.end().catch(() => {});

  if (policiesEnabled) {
    // Undo the policies so the development database is left as it was found.
    const { rows } = await pool.query('SELECT table_name FROM company_scoped_tables');
    for (const { table_name } of rows) {
      await pool.query(`ALTER TABLE ${table_name} NO FORCE ROW LEVEL SECURITY`).catch(() => {});
      await pool.query(`ALTER TABLE ${table_name} DISABLE ROW LEVEL SECURITY`).catch(() => {});
    }
    await pool.query('UPDATE company_isolation_config SET application_role = NULL, enabled_at = NULL')
      .catch(() => {});
    console.log(`  policies disabled on ${rows.length} tables`);
  }

  await pool.query(`DELETE FROM customers WHERE customer_code LIKE 'DRILL-%'`).catch(() => {});
  await pool.query(`DELETE FROM pdf_templates WHERE key = 'drill_shared_key'`).catch(() => {});
  await pool.query(`DELETE FROM ai_settings WHERE company_id IN
                      (SELECT id FROM companies WHERE company_code LIKE 'DRILL-%')`).catch(() => {});
  await pool.query(`DELETE FROM companies WHERE company_code LIKE 'DRILL-%'`).catch(() => {});
  await pool.query(`REASSIGN OWNED BY ${TEST_ROLE} TO CURRENT_USER`).catch(() => {});
  await pool.query(`DROP OWNED BY ${TEST_ROLE}`).catch(() => {});
  await pool.query(`DROP ROLE IF EXISTS ${TEST_ROLE}`).catch(() => {});
  console.log('  test data and role removed');
}

async function drill() {
  console.log('\nRunning the drill…');

  const defaultCompany = (
    await pool.query('SELECT id FROM companies WHERE is_default = true')
  ).rows[0].id;

  // 1 — creating a second tenant. Migration 110's trigger refuses this unless
  // policies are genuinely active AND the creating role is subject to them, so
  // getting a row back is itself a meaningful result.
  let acme, globex;
  try {
    const mk = async (code, name) => {
      const r = await asTenant(defaultCompany, (c) => c.query(
        `INSERT INTO companies (company_code, name, base_currency) VALUES ($1,$2,'USD') RETURNING id`,
        [code, name]));
      return r.rows[0].id;
    };
    acme = await mk('DRILL-ACME', 'Acme Drill Ltd');
    globex = await mk('DRILL-GLOBEX', 'Globex Drill Ltd');
    record('a second tenant can be created', true, 'the isolation guard is satisfied');
  } catch (error) {
    record('a second tenant can be created', false, error.message);
    return;
  }

  // 2 — an insert that never names company_id.
  try {
    await asTenant(acme, (c) => c.query(
      `INSERT INTO customers (customer_name, customer_code) VALUES ($1,$2)`,
      ['Acme Customer', 'DRILL-ACME-1']));
    await asTenant(globex, (c) => c.query(
      `INSERT INTO customers (customer_name, customer_code) VALUES ($1,$2)`,
      ['Globex Customer', 'DRILL-GLOBEX-1']));

    const { rows } = await pool.query(
      `SELECT customer_code, company_id FROM customers WHERE customer_code LIKE 'DRILL-%'`);
    const owner = Object.fromEntries(rows.map((r) => [r.customer_code, r.company_id]));

    const ok = owner['DRILL-ACME-1'] === acme && owner['DRILL-GLOBEX-1'] === globex;
    record('an insert with no company_id lands in the right tenant', ok,
      ok ? 'resolved from the session' : 'company_id was defaulted to the wrong tenant');
  } catch (error) {
    record('an insert with no company_id lands in the right tenant', false, error.message);
  }

  // 3 — reads are confined.
  try {
    const seen = await asTenant(acme, async (c) => {
      const { rows } = await c.query(
        `SELECT customer_code FROM customers WHERE customer_code LIKE 'DRILL-%'`);
      return rows.map((r) => r.customer_code);
    });
    const ok = seen.length === 1 && seen[0] === 'DRILL-ACME-1';
    record('a tenant reads only its own rows', ok, `saw ${JSON.stringify(seen)}`);
  } catch (error) {
    record('a tenant reads only its own rows', false, error.message);
  }

  // 4 — writes are confined. The WITH CHECK half of the policy, which can be
  // missing independently of the USING half.
  try {
    await asTenant(acme, (c) => c.query(
      `INSERT INTO customers (customer_name, customer_code, company_id) VALUES ($1,$2,$3)`,
      ['Smuggled', 'DRILL-SMUGGLE', globex]));
    record('a tenant cannot write into another tenant', false,
      'the insert SUCCEEDED — WITH CHECK is not enforcing');
  } catch (error) {
    const ok = /row-level security|violates/i.test(error.message);
    record('a tenant cannot write into another tenant', ok, ok ? 'refused' : error.message);
  }

  // 5 — natural keys are per tenant.
  try {
    for (const company of [acme, globex]) {
      await asTenant(company, (c) => c.query(
        `INSERT INTO pdf_templates (key, name) VALUES ($1,$2)`,
        ['drill_shared_key', 'Quotation template']));
    }
    const { rows } = await pool.query(
      `SELECT company_id FROM pdf_templates WHERE key = 'drill_shared_key'`);
    record('two tenants may use the same natural key', rows.length === 2,
      `${rows.length} template(s) with that key`);
  } catch (error) {
    record('two tenants may use the same natural key', false, error.message);
  }

  // 6 — no context, no rows. The property that makes a forgotten middleware
  // survivable instead of a breach.
  try {
    const { rows } = await appPool.query(
      `SELECT customer_code FROM customers WHERE customer_code LIKE 'DRILL-%'`);
    record('no company context yields no rows', rows.length === 0,
      rows.length === 0 ? 'fails closed' : `LEAKED ${rows.length} row(s)`);
  } catch (error) {
    record('no company context yields no rows', false, error.message);
  }
}

(async () => {
  console.log('Multi-tenancy drill');
  console.log('='.repeat(60));

  let failed = false;
  try {
    await setup();
    await drill();
  } catch (error) {
    console.error(`\n❌ ${error.message}`);
    failed = true;
  } finally {
    await teardown().catch((e) => console.error('  cleanup problem:', e.message));
    await pool.end().catch(() => {});
  }

  const passed = results.filter((r) => r.ok).length;
  console.log('\n' + '='.repeat(60));
  console.log(`${passed}/${results.length} checks passed`);

  if (failed || passed !== results.length || results.length === 0) {
    console.log('\nIsolation is NOT proven. Do not enable multi-company until these pass.\n');
    process.exit(1);
  }
  console.log('\nIsolation holds under a role that cannot bypass it.\n');
})();
