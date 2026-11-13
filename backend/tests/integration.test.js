// Integration tests that exercise the real DB + model layer (not just pure
// calculation helpers). These directly assert the finance regressions the
// independent audit found were live:
//   • B3 — a balanced journal entry can be created and POSTED (no "column
//          reference journal_number is ambiguous").
//   • B8 — an accounting period can be closed and reopened (no "inconsistent
//          types deduced for parameter $3").
//   • Period lock — once a period is CLOSED, a posting dated into it is blocked.
//
// They require a migrated database. If no database is reachable (e.g. CI without
// Postgres), every test self-skips rather than failing, so `npm test` stays green
// in environments without a DB while still providing real coverage where one
// exists. Run against a real DB with:  npm run db:migrate && npm run test:integration
//
// NOTE: run this file on its own (npm run test:integration) — it opens a pg pool.

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');

const { pool } = require('../config/database');
const JournalEntry = require('../models/JournalEntry');
const AccountingPeriod = require('../models/AccountingPeriod');

let dbAvailable = false;
// Posting a journal entry updates chart_of_accounts.current_balance additively,
// and deleting the entry afterwards does not undo that. Without restoring, this
// file leaves the database failing db:verify's account-balance-cache invariant
// for every subsequent run.
let balanceSnapshot = null;
let userId = null;
let accountA = null;
let accountB = null;
const createdEntryIds = [];
// A period far in the future so we never touch a real one.
const TEST_YEAR = 2099;
const TEST_MONTH = 1;

before(async () => {
  try {
    await pool.query('SELECT 1');
    const users = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
    const accounts = await pool.query(`
      SELECT id FROM chart_of_accounts
      WHERE deleted_at IS NULL AND COALESCE(is_header, false) = false
        AND (status = 'ACTIVE' OR is_active = true)
      ORDER BY account_code
      LIMIT 2
    `);
    if (users.rows.length && accounts.rows.length >= 2) {
      userId = users.rows[0].id;
      accountA = accounts.rows[0].id;
      accountB = accounts.rows[1].id;
      balanceSnapshot = (await pool.query('SELECT id, current_balance FROM chart_of_accounts')).rows;
      dbAvailable = true;
    }
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  if (dbAvailable) {
    for (const id of createdEntryIds) {
      await pool.query('DELETE FROM journal_entry_status_history WHERE journal_entry_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM journal_entry_items WHERE journal_entry_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM journal_entries WHERE id = $1', [id]).catch(() => {});
    }
    await pool.query('DELETE FROM accounting_periods WHERE period_year = $1 AND period_month = $2', [TEST_YEAR, TEST_MONTH]).catch(() => {});
    for (const row of balanceSnapshot || []) {
      await pool.query('UPDATE chart_of_accounts SET current_balance = $2 WHERE id = $1',
        [row.id, row.current_balance]).catch(() => {});
    }
  }
  await pool.end().catch(() => {});
});

test('B3: a balanced journal entry can be created and posted', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const entry = await JournalEntry.create(
    {
      entry_date: `${TEST_YEAR}-06-15`,
      description: 'INTEGRATION TEST — balanced entry',
      reference: 'ITEST',
    },
    [
      { account_id: accountA, debit_amount: 100, credit_amount: 0, description: 'test debit' },
      { account_id: accountB, debit_amount: 0, credit_amount: 100, description: 'test credit' },
    ],
    userId
  );
  createdEntryIds.push(entry.id);

  assert.match(entry.journal_number, /^JE-\d{4}-\d{6}$/, 'journal number should be generated');

  const posted = await JournalEntry.updateStatus(entry.id, 'POSTED', userId, 'integration test');
  assert.equal(posted.status, 'POSTED');
});

test('B8: an accounting period can be closed and reopened', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const closed = await AccountingPeriod.setStatus(TEST_YEAR, TEST_MONTH, 'CLOSED', userId, 'integration test');
  assert.equal(closed.status, 'CLOSED');
  assert.ok(closed.closed_at, 'closed_at should be set when closing');

  const reopened = await AccountingPeriod.setStatus(TEST_YEAR, TEST_MONTH, 'OPEN', userId, 'integration test');
  assert.equal(reopened.status, 'OPEN');
});

test('Period lock: posting into a CLOSED period is blocked', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  await AccountingPeriod.setStatus(TEST_YEAR, TEST_MONTH, 'CLOSED', userId, 'integration test');

  await assert.rejects(
    () =>
      JournalEntry.create(
        {
          entry_date: `${TEST_YEAR}-01-15`,
          description: 'INTEGRATION TEST — should be blocked by period lock',
          reference: 'ITEST',
        },
        [
          { account_id: accountA, debit_amount: 50, credit_amount: 0 },
          { account_id: accountB, debit_amount: 0, credit_amount: 50 },
        ],
        userId
      ),
    /closed/i,
    'posting into a closed period must be rejected'
  );

  await AccountingPeriod.setStatus(TEST_YEAR, TEST_MONTH, 'OPEN', userId, 'integration test');
});
