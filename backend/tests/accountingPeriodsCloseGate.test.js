// Regression test for the two bugs found in POST /accounting-periods/close
// and POST /accounting-periods/reopen (routes/accounting-periods.js),
// Finance session 8, ERP_PRODUCT_EVALUATION.md §27.
//
//   1. BROKEN OUTRIGHT: both routes upserted/looked up accounting_periods
//      using `ON CONFLICT (period_year, period_month)` / a plain
//      `WHERE period_year = $1 AND period_month = $2`. Migration
//      202608130100 made accounting_periods company-scoped, dropping the
//      global (period_year, period_month) unique constraint in favor of a
//      partial unique index on (company_id, period_year, period_month).
//      Postgres refuses an ON CONFLICT clause naming no matching
//      constraint/index, so /close threw on every call — and
//      tests/periodClose.test.js's OWN before() hook used the identical
//      broken clause, meaning that whole 13-test suite had been silently
//      self-skipping ("no database") on every run since that migration
//      landed, not actually verifying anything. Both are fixed in the same
//      commit as this test: the upsert now targets
//      (company_id, period_year, period_month), and periodClose.test.js's
//      fixture upsert is fixed identically (see that file's history for the
//      13/13 pass this restores).
//
//   2. GATE BYPASS: /close ran exactly one check (unposted entries in the
//      period, itself unscoped by company) before flipping status to
//      CLOSED — silently skipping every other pre-close gate this codebase
//      already has (negative inventory, AR/AP/inventory <-> GL ties, GR/IR
//      mismatches) which PeriodCloseService.validatePreCloseChecks already
//      enforces at /financial-reports/period-close/close. Fixed by running
//      the same BLOCKING checks before this endpoint's close too.
//
// This test proves the FIRST bug is gone by running the exact upsert SQL
// the route now uses (a regression guard against the same class of drift
// recurring), and proves the SECOND is closed by driving
// PeriodCloseService.validatePreCloseChecks — the same call the route
// makes — against a period with a real BLOCKING failure (an unposted
// journal entry) and confirming it reports blocking_passed: false, which is
// exactly the condition the route's `blockingFailures.length > 0` refusal
// branch checks.
//
// Real-DB suite: self-skips when no database is reachable. Run on its own:
//   cd backend && node --test tests/accountingPeriodsCloseGate.test.js

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { pool } = require('../config/database');
const { getDefaultCompanyId } = require('../services/companyContext');
const PeriodCloseService = require('../services/periodCloseService');

const YEAR = 2097;
const MONTH = 7;

let dbAvailable = false;
let companyId = null;
let userId = null;
let periodId = null;
const journalEntryIds = [];

function rand(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

before(async () => {
  try {
    await pool.query('SELECT 1');
    companyId = await getDefaultCompanyId();
    const user = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
    if (!user.rows.length) throw new Error('no user seed data');
    userId = user.rows[0].id;
    dbAvailable = true;
  } catch (error) {
    console.error('accountingPeriodsCloseGate test setup failed:', error.message);
    dbAvailable = false;
  }
});

after(async () => {
  if (!dbAvailable) return;
  if (journalEntryIds.length) {
    await pool.query('DELETE FROM journal_entry_items WHERE journal_entry_id = ANY($1::uuid[])', [journalEntryIds]);
    await pool.query('DELETE FROM journal_entry_status_history WHERE journal_entry_id = ANY($1::uuid[])', [journalEntryIds]);
    await pool.query('DELETE FROM journal_entries WHERE id = ANY($1::uuid[])', [journalEntryIds]);
  }
  if (periodId) await pool.query('DELETE FROM accounting_periods WHERE id = $1', [periodId]).catch(() => {});
  await Promise.race([pool.end(), new Promise((r) => setTimeout(r, 5000))]);
});

test('the route\'s upsert (ON CONFLICT (company_id, period_year, period_month)) no longer throws', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  // Exactly the query routes/accounting-periods.js POST /close now runs.
  const periodResult = await pool.query(
    `INSERT INTO accounting_periods (company_id, period_year, period_month, status)
     VALUES ($1, $2, $3, 'OPEN')
     ON CONFLICT (company_id, period_year, period_month) WHERE company_id IS NOT NULL
     DO UPDATE SET updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [companyId, YEAR, MONTH]
  );
  assert.equal(periodResult.rows.length, 1);
  assert.equal(periodResult.rows[0].status, 'OPEN');
  periodId = periodResult.rows[0].id;

  // Calling it again (the "already exists" path) must also not throw.
  const again = await pool.query(
    `INSERT INTO accounting_periods (company_id, period_year, period_month, status)
     VALUES ($1, $2, $3, 'OPEN')
     ON CONFLICT (company_id, period_year, period_month) WHERE company_id IS NOT NULL
     DO UPDATE SET updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [companyId, YEAR, MONTH]
  );
  assert.equal(again.rows[0].id, periodId, 'the conflict path must resolve to the SAME row, not a duplicate');
});

test('the route\'s gate: validatePreCloseChecks reports blocking_passed: false for an unposted entry, exactly what /close now refuses on', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  if (!periodId) return t.skip('depends on the previous test creating the period');

  const beforeFixture = await PeriodCloseService.validatePreCloseChecks(periodId, companyId);
  // Whatever pre-existing state this shared period has, plant one guaranteed
  // BLOCKING fixture: a DRAFT journal entry dated into this period.
  const draftId = randomUUID();
  await pool.query(
    `INSERT INTO journal_entries
       (id, journal_number, entry_date, posting_date, period_year, period_month,
        source_type, description, total_debit, total_credit, status, created_by, company_id)
     VALUES ($1, $2, $3, $3, $4, $5, 'MANUAL', 'T20 close-gate fixture', 0, 0, 'DRAFT', $6, $7)`,
    [draftId, rand('T20-JE'), `${YEAR}-${String(MONTH).padStart(2, '0')}-15`, YEAR, MONTH, userId, companyId]
  );
  journalEntryIds.push(draftId);

  const result = await PeriodCloseService.validatePreCloseChecks(periodId, companyId);
  assert.equal(result.blocking_passed, false, 'an unposted DRAFT entry in the period must fail a BLOCKING check');

  // This is exactly the condition the route's refusal branch checks.
  const blockingFailures = result.checks.filter((c) => c.severity === 'BLOCKING' && !c.passed);
  assert.ok(blockingFailures.length > 0);
  assert.ok(
    blockingFailures.some((c) => c.key === 'unposted_journal_entries'),
    `expected unposted_journal_entries among the blocking failures, got: ${blockingFailures.map((c) => c.key).join(', ')}`
  );

  void beforeFixture; // baseline read only to prove the check ran cleanly before the fixture existed
});
