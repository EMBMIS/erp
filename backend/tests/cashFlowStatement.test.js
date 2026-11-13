// Reporting session — cash flow statement (indirect method).
//
// There is no cash-flow ledger; the statement is derived from GL account
// movements (services/cashFlowStatementService.js). This suite proves the
// derived net_change_in_cash actually equals the real change in the cash
// (1110) account balance over the same window — i.e. it ties to the trial
// balance, not just to itself.
//
// Runs on the existing default company, inside a narrow, far-future date
// window (2097-06-01..03) that no other suite touches, so pre-existing
// postings on shared accounts (1110/1120/...) outside the window cannot
// pollute the before/after balances used here.

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { pool } = require('../config/database');
const JournalEntry = require('../models/JournalEntry');
const { generateCashFlowStatement } = require('../services/cashFlowStatementService');

const WINDOW_FROM = '2097-06-01';
const WINDOW_TO = '2097-06-03';

let dbAvailable = false;
let userId = null;
const accountByCode = {};
const journalEntryIds = [];

function rand(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

async function accountId(code) {
  if (accountByCode[code]) return accountByCode[code];
  const { rows } = await pool.query(
    'SELECT id FROM chart_of_accounts WHERE account_code = $1 AND deleted_at IS NULL LIMIT 1',
    [code]
  );
  if (!rows.length) throw new Error(`account ${code} not found on default company`);
  accountByCode[code] = rows[0].id;
  return rows[0].id;
}

async function post(entryDate, description, lines) {
  const resolved = await Promise.all(lines.map(async (l) => ({
    account_id: await accountId(l.code),
    debit_amount: l.debit || 0,
    credit_amount: l.credit || 0,
    description,
  })));
  const entry = await JournalEntry.create(
    { entry_date: entryDate, description, source_type: 'MANUAL', reference: rand('CFS'), requires_approval: false },
    resolved,
    userId
  );
  await JournalEntry.postAsSystem(entry.id, userId, 'cash flow statement test fixture');
  journalEntryIds.push(entry.id);
  return entry.id;
}

before(async () => {
  try {
    await pool.query('SELECT 1');
    const users = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
    if (!users.rows.length) return;
    userId = users.rows[0].id;
    dbAvailable = true;
  } catch (err) {
    console.error('cashFlowStatement test setup failed:', err.message);
  }
});

test('indirect cash flow statement ties to the actual change in the cash account', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  // Scenario inside the window:
  //   Revenue on credit:          Dr AR 1000        / Cr Revenue 1000
  //   Partial cash collection:    Dr Cash 600        / Cr AR 600
  //   Cash expense:                Dr Expense 300      / Cr Cash 300
  //   Equipment purchased cash:    Dr PPE 200        / Cr Cash 200
  //   Loan drawn in cash:            Dr Cash 500        / Cr Short-term Debt 500
  //   Depreciation (non-cash):      Dr Depreciation Exp 50 / Cr Accum. Depreciation 50
  await post(WINDOW_FROM, 'CFS test revenue on credit', [
    { code: '1120', debit: 1000 }, { code: '4100', credit: 1000 },
  ]);
  await post(WINDOW_FROM, 'CFS test cash collection', [
    { code: '1110', debit: 600 }, { code: '1120', credit: 600 },
  ]);
  await post('2097-06-02', 'CFS test cash expense', [
    { code: '5100', debit: 300 }, { code: '1110', credit: 300 },
  ]);
  await post('2097-06-02', 'CFS test equipment purchase', [
    { code: '1210', debit: 200 }, { code: '1110', credit: 200 },
  ]);
  await post('2097-06-02', 'CFS test loan draw', [
    { code: '1110', debit: 500 }, { code: '2130', credit: 500 },
  ]);
  await post(WINDOW_TO, 'CFS test depreciation', [
    { code: '5260', debit: 50 }, { code: '1220', credit: 50 },
  ]);

  const statement = await generateCashFlowStatement({ dateFrom: WINDOW_FROM, dateTo: WINDOW_TO });

  // Net income = 1000 revenue - (300 expense + 50 depreciation) = 650
  assert.equal(statement.operating_activities.net_income, 650);
  // Cash actually moved by +600 -300 -200 +500 = +600 over the window.
  assert.equal(statement.actual_cash_change, 600);
  assert.equal(statement.net_change_in_cash, 600, 'derived net change must equal actual cash movement');
  assert.equal(statement.ties_to_trial_balance, true);

  // Sanity on the classification itself, not just the tying total.
  const arLine = statement.operating_activities.adjustments.find((l) => l.account_code === '1120');
  assert.equal(arLine.amount, -400, 'AR rose by 400 (1000 - 600), a use of cash');
  const depLine = statement.operating_activities.adjustments.find((l) => l.account_code === '1220');
  assert.equal(depLine.amount, 50, 'accumulated depreciation increase is a non-cash addback');
  const ppeLine = statement.investing_activities.lines.find((l) => l.account_code === '1210');
  assert.equal(ppeLine.amount, -200, 'PPE purchase is a use of cash in investing');
  const debtLine = statement.financing_activities.lines.find((l) => l.account_code === '2130');
  assert.equal(debtLine.amount, 500, 'loan draw is a source of cash in financing');
  assert.ok(arLine.account_id, 'drill-down: line carries the account id for a GL link');
});

after(async () => {
  if (!dbAvailable) return;
  await pool.query(
    `DELETE FROM journal_entry_items WHERE journal_entry_id = ANY($1::uuid[])`,
    [journalEntryIds]
  );
  await pool.query(
    `DELETE FROM journal_entry_status_history WHERE journal_entry_id = ANY($1::uuid[])`,
    [journalEntryIds]
  );
  await pool.query(`DELETE FROM journal_entries WHERE id = ANY($1::uuid[])`, [journalEntryIds]);
});

after(async () => {
  await Promise.race([pool.end(), new Promise((r) => setTimeout(r, 5000))]);
});
