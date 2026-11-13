// Tenant isolation, checked systematically rather than where we happened to look.
//
// ===========================================================================
// WHY THIS SUITE EXISTS
// ===========================================================================
// Company isolation is enforced by row-level security: every company-scoped
// table carries `company_id = current_company_id()`, and the request sets that
// on the connection. The design is sound. What it lacked was any check that it
// was actually ON everywhere and actually applied everywhere — and the gap was
// not theoretical: fifteen public portal endpoints were silently blind to their
// own tenant, and were found one at a time by tripping over them.
//
// The failure mode of RLS is what makes this worth automating. Get it wrong in
// one direction and a screen goes quietly blank; get it wrong in the other and
// one company reads another's ledger. Neither raises an error. Neither shows up
// in a feature test that only ever uses one company.
//
// So this asserts three things that no individual feature test can:
//
//   1. Every table registered as company-scoped really has RLS enabled AND
//      forced, with the isolation policy attached. FORCE matters: without it
//      the table owner — often the application's own role — bypasses the
//      policy entirely and the boundary is decorative.
//   2. A connection carrying company A cannot see company B's rows, checked
//      against the real tables that hold money and documents.
//   3. A connection carrying NO company sees nothing. This is the property
//      that makes a missing context fail visibly instead of leaking.
//
// Run on its own:  node --test tests/tenantIsolation.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { pool } = require('../config/database');
const { runWithCompany } = require('../services/companyScope');

let dbAvailable = false;
let isolationOn = false;
let scopedTables = [];

// Kept only as a human-readable "these especially must never leak" note in
// failure output; the leak tests below iterate every registered table, not
// just this subset — a leak on a table nobody thought to name here is exactly
// the kind of hole a hand-picked list would hide.
const CRITICAL_TABLES = [
  'sales_orders',
  'customer_invoices',
  'customer_payments',
  'purchase_orders',
  'supplier_invoices',
  'journal_entries',
  'chart_of_accounts',
];

before(async () => {
  try {
    await pool.query('SELECT 1');
    dbAvailable = true;
    const enabled = await pool.query('SELECT multi_company_enabled() AS on').catch(() => ({ rows: [{ on: false }] }));
    isolationOn = enabled.rows[0].on === true;
    const t = await pool.query('SELECT table_name FROM company_scoped_tables ORDER BY table_name');
    scopedTables = t.rows.map((r) => r.table_name);
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  await pool.end().catch(() => {});
});

test('every company-scoped table has RLS enabled, FORCED, and the isolation policy', async (t) => {
  if (!dbAvailable) return t.skip('no database available');
  if (!isolationOn) return t.skip('multi-company isolation is off on this database');
  assert.ok(scopedTables.length > 0, 'company_scoped_tables must not be empty');

  const { rows } = await pool.query(
    `SELECT c.relname                                    AS table_name,
            c.relrowsecurity                             AS rls_enabled,
            c.relforcerowsecurity                        AS rls_forced,
            EXISTS (SELECT 1 FROM pg_policy p
                     WHERE p.polrelid = c.oid AND p.polname = 'company_isolation') AS has_policy
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1)`,
    [scopedTables]
  );

  const byName = new Map(rows.map((r) => [r.table_name, r]));
  const problems = [];

  for (const table of scopedTables) {
    const row = byName.get(table);
    if (!row) { problems.push(`${table}: registered as company-scoped but does not exist`); continue; }
    if (!row.rls_enabled) problems.push(`${table}: row-level security is not enabled`);
    // Without FORCE, the owner role bypasses the policy — and the owner is
    // frequently the role the application connects as.
    if (!row.rls_forced) problems.push(`${table}: RLS is not FORCED (the owner bypasses it)`);
    if (!row.has_policy) problems.push(`${table}: no company_isolation policy`);
  }

  assert.deepEqual(problems, [], `tenant boundary holes:\n  ${problems.join('\n  ')}`);
});

test('a connection carrying one company cannot read another company\'s rows', async (t) => {
  if (!dbAvailable) return t.skip('no database available');
  if (!isolationOn) return t.skip('multi-company isolation is off on this database');

  const companies = await pool.query(
    "SELECT id FROM companies WHERE deleted_at IS NULL AND (status = 'ACTIVE' OR status IS NULL) ORDER BY created_at"
  );
  if (companies.rows.length < 2) return t.skip('needs at least two companies to compare');

  for (const table of scopedTables) {
    const exists = await pool.query('SELECT to_regclass($1) IS NOT NULL AS ok', [`public.${table}`]);
    if (!exists.rows[0].ok) continue;

    // ctid identifies a row regardless of the table's primary key shape — a
    // handful of scoped tables (company_modules, usage_counters, …) have a
    // composite key and no "id" column at all.
    let owner = null;
    let sampleCtid = null;
    for (const c of companies.rows) {
      const r = await runWithCompany(c.id, () => pool.query(`SELECT ctid FROM ${table} LIMIT 1`));
      if (r.rows.length) { owner = c.id; sampleCtid = r.rows[0].ctid; break; }
    }
    if (!owner) continue; // nothing stored in this table anywhere yet

    const other = companies.rows.find((c) => c.id !== owner);
    const leaked = await runWithCompany(other.id, () =>
      pool.query(`SELECT ctid FROM ${table} WHERE ctid = $1`, [sampleCtid])
    );

    assert.equal(
      leaked.rows.length, 0,
      `${table}: a row owned by company ${owner} was readable while acting as company ${other.id}`
    );
  }
});

test('a connection with no company context reads nothing from scoped tables', async (t) => {
  if (!dbAvailable) return t.skip('no database available');
  if (!isolationOn) return t.skip('multi-company isolation is off on this database');

  // This is the property that turns "somebody forgot to set the company" into
  // a visibly empty screen instead of a cross-tenant read. It is also exactly
  // what the public portal endpoints were tripping over — the fix there was to
  // give them a company, never to weaken this.
  for (const table of scopedTables) {
    const exists = await pool.query('SELECT to_regclass($1) IS NOT NULL AS ok', [`public.${table}`]);
    if (!exists.rows[0].ok) continue;

    const unscoped = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
    assert.equal(
      unscoped.rows[0].n, 0,
      `${table}: readable with no company context — the isolation policy is not being applied`
    );
  }
});

test('the domain-event catalogue is a real contract, not a wish list', async (t) => {
  // Not tenancy, but the same class of promise: the /webhooks/event-types
  // endpoint used to advertise three events of which one was emitted, so a
  // subscriber could register for something no code path would ever send.
  const domainEvents = require('../services/domainEvents');
  const catalogue = domainEvents.catalogue();

  assert.ok(catalogue.length > 0, 'the catalogue must not be empty');

  // Every named status event must correspond to a status the state machine can
  // actually reach — otherwise it is advertised and undeliverable.
  const { TRANSITION_MAPS } = require('../services/stateMachine');
  const problems = [];

  for (const [entityType, prefix] of Object.entries(domainEvents.ENTITY_EVENT_PREFIX)) {
    const map = TRANSITION_MAPS[entityType];
    if (!map) { problems.push(`${entityType}: has events but no transition map`); continue; }

    const reachable = new Set(Object.values(map).flat());
    for (const status of domainEvents.NAMED_STATUSES[prefix] || []) {
      if (!reachable.has(status)) {
        problems.push(`${prefix}.${status.toLowerCase()}: ${entityType} can never reach ${status}`);
      }
    }
  }

  assert.deepEqual(problems, [], `undeliverable events promised to subscribers:\n  ${problems.join('\n  ')}`);
});
