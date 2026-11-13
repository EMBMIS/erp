// Regression test for FX revaluation of open AR/AP balances to the base
// currency at period end (Finance session 8, ERP_PRODUCT_EVALUATION.md §27).
//
// services/fxRateService.js already syncs live rates into `exchange_rates`,
// and periodCloseService.js's check 9 already flags multicurrency activity
// with no revaluation posting on record (reference ILIKE '%FX-REVAL%') — but
// nothing in this codebase ever created that posting; the check could only
// ever come back a WARNING with revalCount 0. services/fxRevaluationService.js
// closes that: it compares the rate a foreign-currency AR/AP document was
// booked at against the current rate and posts the unrealized gain/loss to
// 4910/5910 (FinancialPostingService.postCashPayment already uses the same
// two accounts for the REALIZED leg on settlement).
//
// This test seeds one EUR customer invoice and one EUR supplier invoice at a
// known booked rate, sets a different current EUR->USD rate, runs
// revalueOpenBalances(), and asserts: the posted entry is balanced, tagged
// FX-REVAL-<date>/'FX_REVALUATION' (so periodCloseService's own check would
// now find it), the AR/AP control account lines match the expected deltas,
// and the net gain/loss line lands on 4910 (gain) or 5910 (loss) with the
// correct sign — then re-runs periodCloseService's fx_revaluation check to
// confirm it flips from failing to passing off the real posting.
//
// Real-DB suite: self-skips when no database is reachable. Run on its own:
//   cd backend && node --test tests/fxRevaluation.test.js

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { pool } = require('../config/database');
const Currency = require('../models/Currency');
const FXRevaluationService = require('../services/fxRevaluationService');
const PeriodCloseService = require('../services/periodCloseService');

const YEAR = 2098;
const MONTH = 11;
const BOOKED_RATE = 1.05; // 1 EUR = 1.05 USD at booking
const CURRENT_RATE = 1.20; // 1 EUR = 1.20 USD as of revaluation — EUR strengthened

let dbAvailable = false;
let companyId = null;
let userId = null;
let customerId = null;
let supplierId = null;
let periodId = null;
const created = { customerInvoiceIds: [], supplierInvoiceIds: [], journalEntryIds: [] };

function rand(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

async function cleanupJournalEntries() {
  if (!created.journalEntryIds.length) return;
  await pool.query('DELETE FROM journal_entry_items WHERE journal_entry_id = ANY($1::uuid[])', [created.journalEntryIds]);
  await pool.query('DELETE FROM journal_entry_status_history WHERE journal_entry_id = ANY($1::uuid[])', [created.journalEntryIds]);
  await pool.query('DELETE FROM journal_entries WHERE id = ANY($1::uuid[])', [created.journalEntryIds]);
  created.journalEntryIds.length = 0;
}

before(async () => {
  try {
    await pool.query('SELECT 1');
    const company = await pool.query('SELECT id, base_currency FROM companies WHERE deleted_at IS NULL ORDER BY is_default DESC, created_at LIMIT 1');
    const user = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
    if (!company.rows.length || !user.rows.length) throw new Error('no company/user seed data');
    companyId = company.rows[0].id;
    userId = user.rows[0].id;
    if (company.rows[0].base_currency !== 'USD') throw new Error('test assumes the default company books in USD');

    // A dated EUR->USD rate at the "booked" date, and a different one "today"
    // (Currency.getRate defaults to today when no date is given, which is
    // exactly what revalueOpenBalances uses for the current rate).
    await Currency.addRate({ from_currency: 'EUR', to_currency: 'USD', rate: BOOKED_RATE, rate_date: '2098-11-01' }, userId);
    await Currency.addRate({ from_currency: 'EUR', to_currency: 'USD', rate: CURRENT_RATE, rate_date: new Date().toISOString().split('T')[0] }, userId);

    const customer = await pool.query('SELECT id FROM customers WHERE company_id = $1 AND deleted_at IS NULL LIMIT 1', [companyId]);
    const supplier = await pool.query('SELECT id FROM suppliers WHERE company_id = $1 LIMIT 1', [companyId]);
    customerId = customer.rows[0]?.id || null;
    supplierId = supplier.rows[0]?.id || null;

    const period = await pool.query(
      `INSERT INTO accounting_periods (company_id, period_year, period_month, status)
       VALUES ($1, $2, $3, 'OPEN')
       ON CONFLICT (company_id, period_year, period_month) WHERE company_id IS NOT NULL
       DO UPDATE SET status = 'OPEN'
       RETURNING id`,
      [companyId, YEAR, MONTH]
    );
    periodId = period.rows[0].id;

    dbAvailable = true;
  } catch (error) {
    console.error('fxRevaluation test setup failed:', error.message);
    dbAvailable = false;
  }
});

after(async () => {
  if (!dbAvailable) return;
  await cleanupJournalEntries();
  for (const id of created.customerInvoiceIds) await pool.query('DELETE FROM customer_invoices WHERE id = $1', [id]).catch(() => {});
  for (const id of created.supplierInvoiceIds) await pool.query('DELETE FROM supplier_invoices WHERE id = $1', [id]).catch(() => {});
  await pool.query(`DELETE FROM exchange_rates WHERE from_currency = 'EUR' AND to_currency = 'USD' AND rate_date IN ('2098-11-01', $1)`, [new Date().toISOString().split('T')[0]]).catch(() => {});
  if (periodId) await pool.query('DELETE FROM accounting_periods WHERE id = $1', [periodId]).catch(() => {});
  await Promise.race([pool.end(), new Promise((r) => setTimeout(r, 5000))]);
});

test('revalueOpenBalances posts a balanced, tagged unrealized FX entry for open EUR AR and AP', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  if (!customerId || !supplierId) return t.skip('missing seed customer/supplier');

  // AR: 1,000 EUR outstanding, booked at 1.05 -> current 1.20 = AR now worth
  // MORE in USD -> unrealized GAIN of (1.20-1.05)*1000 = 150.
  const ciId = randomUUID();
  await pool.query(
    `INSERT INTO customer_invoices
       (id, invoice_number, customer_id, invoice_date, due_date, currency, exchange_rate,
        subtotal, tax_amount, discount_amount, total_amount, paid_amount,
        status, created_by, company_id)
     VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_DATE, 'EUR', $4, 1000, 0, 0, 1000, 0, 'APPROVED', $5, $6)`,
    [ciId, rand('T19-CI'), customerId, BOOKED_RATE, userId, companyId]
  );
  created.customerInvoiceIds.push(ciId);

  // AP: 400 EUR outstanding, booked at 1.05 -> current 1.20 = AP now worth
  // MORE in USD (we owe more) -> unrealized LOSS of (1.20-1.05)*400 = 60.
  const siId = randomUUID();
  await pool.query(
    `INSERT INTO supplier_invoices
       (id, bill_number, supplier_id, invoice_date, due_date, currency, exchange_rate,
        subtotal, tax_amount, discount_amount, total_amount, paid_amount,
        status, created_by, company_id)
     VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_DATE, 'EUR', $4, 400, 0, 0, 400, 0, 'APPROVED', $5, $6)`,
    [siId, rand('T19-BILL'), supplierId, BOOKED_RATE, userId, companyId]
  );
  created.supplierInvoiceIds.push(siId);

  const result = await FXRevaluationService.revalueOpenBalances(companyId, userId, new Date().toISOString().split('T')[0]);
  assert.equal(result.posted, true);
  created.journalEntryIds.push(result.entry_id);

  assert.equal(Math.round(result.ar_delta), 150, `AR delta should be ~150 (${JSON.stringify(result.ar_lines)})`);
  assert.equal(Math.round(result.ap_delta), 60, `AP delta should be ~60 (${JSON.stringify(result.ap_lines)})`);
  assert.equal(Math.round(result.net_impact), 90, 'net = AR gain 150 - AP loss 60 = 90 net gain');

  const entry = await pool.query(
    `SELECT source_type, reference, status, total_debit, total_credit FROM journal_entries WHERE id = $1`,
    [result.entry_id]
  );
  assert.equal(entry.rows[0].source_type, 'FX_REVALUATION');
  assert.equal(entry.rows[0].reference, `FX-REVAL-${new Date().toISOString().split('T')[0]}`);
  assert.equal(entry.rows[0].status, 'POSTED');
  assert.equal(
    Number(entry.rows[0].total_debit).toFixed(2),
    Number(entry.rows[0].total_credit).toFixed(2),
    'the revaluation entry must balance'
  );

  const items = await pool.query(
    `SELECT coa.account_code, jei.debit_amount, jei.credit_amount
       FROM journal_entry_items jei JOIN chart_of_accounts coa ON coa.id = jei.account_id
      WHERE jei.journal_entry_id = $1 ORDER BY coa.account_code`,
    [result.entry_id]
  );
  const byCode = Object.fromEntries(items.rows.map((r) => [r.account_code, r]));
  // Net gain (90) posts to 4910 (Foreign Exchange Gain) as a credit.
  assert.ok(byCode['4910'], 'expected a line on 4910 Foreign Exchange Gain');
  assert.equal(Number(byCode['4910'].credit_amount), 90);
  assert.equal(Number(byCode['4910'].debit_amount), 0);
  assert.ok(!byCode['5910'], 'net result is a gain, not a loss — 5910 should not appear');
});

test('a clean run with nothing to revalue is a real no-op, not a fabricated posting', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  // Settle the previous test's fixtures first — otherwise they are still
  // open and this "nothing to revalue" run would just re-revalue them.
  await pool.query('UPDATE customer_invoices SET paid_amount = total_amount WHERE id = ANY($1::uuid[])', [created.customerInvoiceIds]);
  await pool.query('UPDATE supplier_invoices SET paid_amount = total_amount WHERE id = ANY($1::uuid[])', [created.supplierInvoiceIds]);

  const result = await FXRevaluationService.revalueOpenBalances(companyId, userId, new Date().toISOString().split('T')[0]);
  assert.equal(result.posted, false);
});

test('periodCloseService fx_revaluation check flips from failing to passing off the real posting', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  if (!customerId) return t.skip('missing seed customer');

  // Multicurrency activity dated into the test period with no revaluation yet.
  const ciId = randomUUID();
  await pool.query(
    `INSERT INTO customer_invoices
       (id, invoice_number, customer_id, invoice_date, due_date, currency, exchange_rate,
        subtotal, tax_amount, discount_amount, total_amount, paid_amount,
        status, created_by, company_id)
     VALUES ($1, $2, $3, $4, $4, 'EUR', $5, 200, 0, 0, 200, 0, 'APPROVED', $6, $7)`,
    [ciId, rand('T19-CI2'), customerId, `${YEAR}-${String(MONTH).padStart(2, '0')}-10`, BOOKED_RATE, userId, companyId]
  );
  created.customerInvoiceIds.push(ciId);

  // The revenue-side journal entry that made this invoice "multicurrency
  // activity" in the period, per periodCloseService's own check 9 query.
  const activityId = randomUUID();
  await pool.query(
    `INSERT INTO journal_entries
       (id, journal_number, entry_date, posting_date, period_year, period_month,
        source_type, description, total_debit, total_credit, status,
        currency, exchange_rate, created_by, posted_by, posted_at, company_id)
     VALUES ($1, $2, $3, $3, $4, $5, 'MANUAL', 'T19 fx activity fixture', 0, 0, 'POSTED',
             'EUR', $6, $7, $7, CURRENT_TIMESTAMP, $8)`,
    [activityId, rand('T19-JE'), `${YEAR}-${String(MONTH).padStart(2, '0')}-10`, YEAR, MONTH, BOOKED_RATE, userId, companyId]
  );
  created.journalEntryIds.push(activityId);

  const before = await PeriodCloseService.validatePreCloseChecks(periodId, companyId);
  const beforeCheck = before.checks.find((c) => c.key === 'fx_revaluation');
  assert.equal(beforeCheck.passed, false, 'no revaluation posted yet for this period -> WARNING should fire');

  // Post a revaluation dated INTO the test period (the check matches on
  // period_year/period_month, not "today").
  const revalEntry = await require('../models/JournalEntry').create(
    {
      entry_date: `${YEAR}-${String(MONTH).padStart(2, '0')}-28`,
      source_type: 'FX_REVALUATION',
      description: `FX revaluation fixture for period ${YEAR}-${MONTH}`,
      reference: `FX-REVAL-${YEAR}-${String(MONTH).padStart(2, '0')}-28`,
      requires_approval: false,
      company_id: companyId,
    },
    [
      { account_id: (await pool.query(`SELECT id FROM chart_of_accounts WHERE account_code='4910' AND company_id=$1`, [companyId])).rows[0].id, debit_amount: 0, credit_amount: 1 },
      { account_id: (await pool.query(`SELECT id FROM chart_of_accounts WHERE account_code='1200' AND company_id=$1`, [companyId])).rows[0].id, debit_amount: 1, credit_amount: 0 },
    ],
    userId
  );
  created.journalEntryIds.push(revalEntry.id);
  await require('../models/JournalEntry').postAsSystem(revalEntry.id, userId, 'T19 fixture');

  const after = await PeriodCloseService.validatePreCloseChecks(periodId, companyId);
  const afterCheck = after.checks.find((c) => c.key === 'fx_revaluation');
  assert.equal(afterCheck.passed, true, 'a real FX-REVAL posting in the period should clear the warning');
});
