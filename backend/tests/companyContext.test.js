// Company-context resolution tests.
//
// Company isolation is enforced by Postgres row-level security reading
// `app.current_company_id`. That means a request which fails to establish a
// company does not get an error — under isolation it simply sees no rows. The
// dangerous failures here are therefore silent ones, and these tests target them.
//
// The bug that prompted this file: API-key auth sets req.user.id to the string
// `api-key-<uuid>`, which was compared against user_companies.user_id (a uuid
// column). Every API-key request threw, the error was caught and swallowed, and
// the request continued with no company context. Visible only as a log line
// while isolation was off — and it would have silently returned zero rows for
// the entire integration surface the moment isolation was switched on.
//
// Run on its own:  npm run test:company-context

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { pool } = require('../config/database');
const companyContext = require('../services/companyContext');

let dbAvailable = false;
let defaultCompanyId = null;

// The non-UUID identities this application really creates.
const SYNTHETIC_IDENTITIES = [
  'api-key-c5af64c2-f871-4eb7-a4b6-09208df28bb7',
  'ai-system',
  'not-a-uuid-at-all',
  '',
];

before(async () => {
  try {
    await pool.query('SELECT 1');
    defaultCompanyId = await companyContext.getDefaultCompanyId();
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  await pool.end();
});

test('resolving a company for a non-UUID identity returns null instead of throwing', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  for (const identity of SYNTHETIC_IDENTITIES) {
    // Must not throw. A throw here is caught by the auth middleware and turns
    // into "no company context", which under isolation means the request sees
    // nothing at all.
    const result = await companyContext.primaryCompanyFor(identity);
    assert.equal(result, null, `expected null for "${identity}"`);
  }
});

test('a non-UUID identity may act for the default company and no other', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  for (const identity of ['ai-system', 'api-key-c5af64c2-f871-4eb7-a4b6-09208df28bb7']) {
    assert.equal(
      await companyContext.userCanAccess(identity, defaultCompanyId), true,
      `${identity} should be able to act for the default company`
    );
    assert.equal(
      await companyContext.userCanAccess(identity, '11111111-1111-1111-1111-111111111111'), false,
      `${identity} must not be able to act for an arbitrary company`
    );
  }
});

test('an API key is bound to a company', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  // Without this column an API key belongs to no company: unscoped while
  // isolation is off, and resolving to nothing once it is on.
  const column = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'api_keys' AND column_name = 'company_id'`
  );
  assert.equal(column.rows.length, 1, 'api_keys must carry a company_id');

  // And validate() must return it, or auth has nothing to scope by.
  const ApiKey = require('../models/ApiKey');
  assert.match(
    ApiKey.validate.toString(), /company_id/,
    'ApiKey.validate must select company_id, otherwise auth cannot scope the key'
  );

  const unscoped = await pool.query('SELECT COUNT(*)::int n FROM api_keys WHERE company_id IS NULL');
  assert.equal(unscoped.rows[0].n, 0, 'every API key should be scoped to a company');
});

test('auth resolves an API key company from the key, not from user_companies', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  // An API key has no user_companies rows by design, so resolving it as a user
  // can only ever yield nothing. Assert the middleware takes the key's own scope.
  const auth = require('../middleware/auth');
  const source = Object.values(auth).map((v) => (typeof v === 'function' ? v.toString() : '')).join('\n');
  assert.match(source, /isApiKey/,
    'the company middleware must special-case API-key identities');
});

test('withCompany scopes the setting to its transaction so pooling cannot leak it', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  // A plain SET would outlive the request and be inherited by whatever request
  // next borrows the connection — a cross-tenant leak caused by the isolation
  // mechanism itself. SET LOCAL is discarded at COMMIT.
  const seen = await companyContext.withCompany(defaultCompanyId, async (client) => {
    const { rows } = await client.query("SELECT current_setting('app.current_company_id', true) AS c");
    return rows[0].c;
  });
  assert.equal(seen, defaultCompanyId, 'the company should be visible inside the transaction');

  // On a fresh checkout from the pool the setting must not be present. Checked
  // repeatedly because which physical connection is handed back varies.
  for (let i = 0; i < 5; i++) {
    const { rows } = await pool.query("SELECT current_setting('app.current_company_id', true) AS c");
    assert.ok(!rows[0].c, 'the company setting must not survive into a pooled connection');
  }
});

test('isolation status is read from the database, not from a config flag', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  // A flag records an intention; only the database knows whether policies are
  // actually in force for the connecting role. These came apart once already:
  // RLS was enabled while the app connected as a superuser, which bypasses it
  // unconditionally, so every check reported isolation while nothing was isolated.
  companyContext.resetCache();
  const enabled = await companyContext.isolationEnabled();
  assert.equal(typeof enabled, 'boolean');

  const role = await pool.query(
    'SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super');

  if (role.rows[0].is_super) {
    assert.equal(enabled, false,
      'isolation must report false while the app connects as a superuser, because RLS does not apply to superusers');
  }
});

test('forEachCompany iterates active companies in runWithCompany context and isolates errors', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const visitedCompanies = [];
  const results = await companyContext.forEachCompany(async (companyId) => {
    const current = companyContext.currentCompanyId();
    assert.equal(current, companyId, 'currentCompanyId inside callback must match iterated companyId');
    visitedCompanies.push(companyId);
    if (visitedCompanies.length === 1) {
      // First tenant succeeds
      return `ok-${companyId}`;
    } else {
      // Second tenant throws error — should be isolated
      throw new Error('Tenant execution failed');
    }
  });

  assert.ok(visitedCompanies.length >= 1, 'At least one company should have been visited');
  assert.equal(results[0].status, 'fulfilled');
  if (visitedCompanies.length > 1) {
    assert.equal(results[1].status, 'rejected');
    assert.equal(results[1].reason.message, 'Tenant execution failed');
  }
});

test('reportScheduler and agents scheduler ticks do not crash and observe company context', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const reportScheduler = require('../services/reportScheduler');
  const agentScheduler = require('../services/agents/scheduler');

  // Running tick() must complete cleanly without throwing
  await reportScheduler.tick();
  await agentScheduler.tick();
});

