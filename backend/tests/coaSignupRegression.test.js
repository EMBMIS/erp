// Regression: a newly registered company must get the standard finance master
// data — chart of accounts, cost centers, open accounting periods — or every
// GL posting fails with "Required accounts not found" for that tenant (ERP
// blocker #5: "Empty COA at signup with hardcoded posting codes and no
// template").
//
// The deployment's default company was seeded by migration 202608120500, but
// the signup path created NEW companies with an empty chart_of_accounts. This
// test drives the same code path signup uses — User.create + Companies.create
// + ChartOfAccounts.seedFinanceMasterData(), the helper routes/auth.js and
// routes/companies.js now call — against the real database, with unique UUIDs
// and full cleanup. It must be safe to run while other test files run against
// the same database, so every fixture is unique and removed afterwards.
//
// Run on its own:  node --test tests/coaSignupRegression.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { pool } = require('../config/database');
const companyContext = require('../services/companyContext');
const { Companies } = require('../models/Company');
const ChartOfAccounts = require('../models/ChartOfAccounts');
const User = require('../models/User');

const STANDARD_ACCOUNT_COUNT = 44; // migration 202608120500's 39 plus 3210/5850
// added by 202608160100_fix_revaluation_surplus_account.sql (Fixed Assets §29:
// revaluation needs its own equity/impairment accounts, not a collision with
// Retained Earnings' 3200 or a missing 5850), plus 1135/5150, which
// WorkOrder.postJournal needs (see the note on them in models/ChartOfAccounts.js),
// plus 2126, the RECON_SUSPENSE control account.
const STANDARD_COST_CENTER_COUNT = 7;

let dbAvailable = false;
let userId = null;
let companyId = null;

before(async () => {
  try {
    await pool.query('SELECT 1');
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  if (dbAvailable && companyId) {
    // Company-scoped child rows first, under the company that owns them (RLS).
    await companyContext.runWithCompany(companyId, async () => {
      await pool.query('DELETE FROM accounting_periods WHERE company_id = $1', [companyId]);
      await pool.query('DELETE FROM cost_centers WHERE company_id = $1', [companyId]);
      await pool.query('DELETE FROM chart_of_accounts WHERE company_id = $1', [companyId]);
    });
    await pool.query('DELETE FROM user_companies WHERE company_id = $1', [companyId]).catch(() => {});
    await pool.query('DELETE FROM companies WHERE id = $1', [companyId]).catch(() => {});
  }
  if (dbAvailable && userId) {
    await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
  }
  await pool.end();
});

test('a newly created company is seeded with COA, cost centers and open periods', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);

  // A brand-new founding user, exactly as POST /auth/register-company does.
  const pw = 'Reg-x9z7-Q1!';
  const user = await User.create({
    email: `coa-signup-${suffix}@example.test`,
    password: pw,
    first_name: 'COA',
    last_name: 'Regression',
    role: 'ADMIN',
  });
  userId = user.id;

  // The real company-creation code path. The database refuses a second company
  // while row-level isolation is off (migration 111's guard trigger) — that is
  // the environment's way of saying a second tenant cannot exist yet, so skip
  // loudly instead of fighting the deployment's isolation state.
  let company;
  try {
    company = await Companies.create({
      company_code: `COA${suffix}`.toUpperCase(),
      name: `COA Regression ${suffix}`,
      base_currency: 'USD',
    }, user.id);
  } catch (error) {
    if (/Refusing to create a second company/.test(error.message)) {
      return t.skip(`cannot create a second company on this database: ${error.message}`);
    }
    throw error;
  }
  companyId = company.id;

  // The seed both routes call, run the way they run it (the helper scopes
  // itself to the company under RLS).
  const seeded = await ChartOfAccounts.seedFinanceMasterData(company.id, user.id);

  await companyContext.runWithCompany(company.id, async () => {
    // (a) chart_of_accounts — spot-check the accounts the hardcoded posting
    // codes resolve: 1110 (cash), 2110 (AP), 5210 (payroll).
    const accounts = await pool.query(
      'SELECT account_code FROM chart_of_accounts WHERE company_id = $1 ORDER BY account_code',
      [company.id]
    );
    const codes = new Set(accounts.rows.map((r) => r.account_code));
    for (const expected of ['1110', '2110', '5210']) {
      assert.ok(codes.has(expected), `chart_of_accounts must contain ${expected}`);
    }
    assert.equal(accounts.rows.length, STANDARD_ACCOUNT_COUNT,
      `expected the standard ${STANDARD_ACCOUNT_COUNT}-account chart, found ${accounts.rows.length}`);

    // (b) cost_centers.
    const centers = await pool.query(
      'SELECT code FROM cost_centers WHERE company_id = $1 ORDER BY code',
      [company.id]
    );
    const centerCodes = new Set(centers.rows.map((r) => r.code));
    for (const expected of ['SALES', 'PROCUREMENT', 'OPERATIONS', 'FINANCE', 'IT', 'HR', 'WAREHOUSE']) {
      assert.ok(centerCodes.has(expected), `cost_centers must contain ${expected}`);
    }
    assert.equal(centers.rows.length, STANDARD_COST_CENTER_COUNT,
      `expected ${STANDARD_COST_CENTER_COUNT} cost centers, found ${centers.rows.length}`);

    // (c) accounting_periods — at least a year of OPEN periods, unique per
    // (year, month).
    const periods = await pool.query(
      `SELECT period_year, period_month FROM accounting_periods
        WHERE company_id = $1 AND status = 'OPEN' ORDER BY period_year, period_month`,
      [company.id]
    );
    assert.ok(periods.rows.length >= 12,
      `new company must have at least 12 open accounting periods, found ${periods.rows.length}`);
    const pairs = periods.rows.map((r) => `${r.period_year}-${r.period_month}`);
    assert.equal(new Set(pairs).size, periods.rows.length,
      'periods must be unique per (year, month)');
  });

  // Idempotency: re-running the seed (what a re-run of company creation would
  // do) must not duplicate any of the three seeds.
  await ChartOfAccounts.seedFinanceMasterData(company.id, user.id);
  await companyContext.runWithCompany(company.id, async () => {
    const accounts = await pool.query(
      'SELECT COUNT(*)::int AS n FROM chart_of_accounts WHERE company_id = $1', [company.id]);
    const centers = await pool.query(
      'SELECT COUNT(*)::int AS n FROM cost_centers WHERE company_id = $1', [company.id]);
    const periods = await pool.query(
      'SELECT COUNT(*)::int AS n FROM accounting_periods WHERE company_id = $1', [company.id]);
    assert.equal(accounts.rows[0].n, seeded.accounts,
      're-seeding must not duplicate chart_of_accounts rows');
    assert.equal(centers.rows[0].n, seeded.cost_centers,
      're-seeding must not duplicate cost_centers rows');
    assert.equal(periods.rows[0].n, seeded.periods,
      're-seeding must not duplicate accounting_periods rows');
  });
});
