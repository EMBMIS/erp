// Regression tests for the GL transaction boundary.
//
// This codebase has repeatedly produced the same bug: a document is created in
// one transaction while its journal entry is posted on a separate connection
// that commits independently. When the document's transaction then rolls back,
// the ledger keeps a POSTED entry with no document behind it — real revenue or
// cost in the accounts that no report can trace to anything.
//
// It has been fixed in SalesOrder and PurchaseOrder before; it was still live in
// CustomerInvoice.createStandalone (the path recurring invoices use). These tests
// exist so the next caller that forgets to thread the client fails loudly here
// rather than silently corrupting the general ledger.
//
// The technique is fault injection: let the real code post its journal entry,
// force a failure immediately afterwards, and assert the ledger is unchanged.
//
// Run on its own:  npm run test:gl-boundary

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');

const { pool } = require('../config/database');
const CustomerInvoice = require('../models/CustomerInvoice');
const JournalEntry = require('../models/JournalEntry');

let dbAvailable = false;
// chart_of_accounts.current_balance is maintained additively by
// JournalEntry.updateAccountBalances, so deleting a journal entry does not undo
// its effect on the cache. Any test that posts to the GL must restore the
// balances it moved, or it leaves the database failing db:verify's
// account-balance-cache invariant for every later run.
let balanceSnapshot = null;

let userId = null;
let customerId = null;
const created = { invoiceIds: [], journalEntryIds: [], customerIds: [] };

async function counts() {
  const je = await pool.query('SELECT COUNT(*)::int n FROM journal_entries WHERE deleted_at IS NULL');
  const jei = await pool.query('SELECT COUNT(*)::int n FROM journal_entry_items');
  const inv = await pool.query('SELECT COUNT(*)::int n FROM customer_invoices WHERE deleted_at IS NULL');
  return { journalEntries: je.rows[0].n, journalLines: jei.rows[0].n, invoices: inv.rows[0].n };
}

/** Remove a journal entry and reverse the balance effect it applied. */
async function purgeJournalEntry(id) {
  if (!id) return;
  const items = await pool.query(
    'SELECT account_code, debit_amount::float d, credit_amount::float c FROM journal_entry_items WHERE journal_entry_id = $1',
    [id]
  );
  for (const it of items.rows) {
    const delta = (it.d || 0) - (it.c || 0);
    await pool.query(
      `UPDATE chart_of_accounts
          SET current_balance = current_balance - ($2::numeric * CASE WHEN normal_balance = 'DEBIT' THEN 1 ELSE -1 END)
        WHERE account_code = $1`,
      [it.account_code, delta]
    ).catch(() => {});
  }
  await pool.query('DELETE FROM journal_entry_status_history WHERE journal_entry_id = $1', [id]).catch(() => {});
  await pool.query('DELETE FROM journal_entry_items WHERE journal_entry_id = $1', [id]).catch(() => {});
  await pool.query('DELETE FROM journal_entries WHERE id = $1', [id]).catch(() => {});
}

before(async () => {
  try {
    await pool.query('SELECT 1');
    const users = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
    if (!users.rows.length) return;
    userId = users.rows[0].id;

    const cust = await pool.query(
      `INSERT INTO customers (customer_code, customer_name, status, credit_days, created_by)
       VALUES ($1, 'GL Boundary Test Co', 'ACTIVE', 30, $2) RETURNING id`,
      [`GLB${String(Date.now()).slice(-9)}`, userId]
    );
    customerId = cust.rows[0].id;
    created.customerIds.push(customerId);
    balanceSnapshot = (await pool.query('SELECT id, current_balance FROM chart_of_accounts')).rows;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  if (dbAvailable) {
    for (const id of created.invoiceIds) {
      await pool.query('DELETE FROM customer_invoice_status_history WHERE invoice_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM customer_invoices WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.journalEntryIds) await purgeJournalEntry(id);
    for (const id of created.customerIds) {
      await pool.query('DELETE FROM customers WHERE id = $1', [id]).catch(() => {});
    }
  }
  if (balanceSnapshot) {
    for (const row of balanceSnapshot) {
      await pool.query('UPDATE chart_of_accounts SET current_balance = $2 WHERE id = $1',
        [row.id, row.current_balance]).catch(() => {});
    }
  }
  await pool.end();
});

test('a failure after posting leaves no orphaned journal entry behind', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const before = await counts();

  // Break the step that runs AFTER the journal entry is posted. The real
  // posting code still executes; only the tail of the method fails.
  const original = CustomerInvoice.addStatusHistory;
  CustomerInvoice.addStatusHistory = async () => { throw new Error('injected failure after GL post'); };

  let threw = false;
  try {
    await CustomerInvoice.createStandalone(
      { customer_id: customerId, amount: 4242.42, description: 'orphan regression probe' },
      userId
    );
  } catch (err) {
    threw = true;
    assert.match(err.message, /injected failure/);
  } finally {
    CustomerInvoice.addStatusHistory = original;
  }

  assert.ok(threw, 'the injected failure should propagate');

  const after = await counts();
  assert.equal(after.journalEntries, before.journalEntries,
    'a rolled-back invoice must not leave a journal entry in the ledger');
  assert.equal(after.journalLines, before.journalLines,
    'no journal lines should survive either');
  assert.equal(after.invoices, before.invoices,
    'the invoice itself must be gone');
});

test('the successful path still posts and links a balanced entry', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const invoice = await CustomerInvoice.createStandalone(
    { customer_id: customerId, amount: 1000, tax_amount: 100, description: 'happy path probe' },
    userId
  );
  created.invoiceIds.push(invoice.id);
  created.journalEntryIds.push(invoice.journal_entry_id);

  // The returned object must carry the link, not just the database row.
  assert.ok(invoice.journal_entry_id, 'createStandalone should return the journal_entry_id it linked');

  const linked = await pool.query(
    'SELECT journal_entry_id FROM customer_invoices WHERE id = $1', [invoice.id]);
  assert.equal(linked.rows[0].journal_entry_id, invoice.journal_entry_id,
    'the returned id should match what was written');

  const je = await pool.query(
    `SELECT je.status,
            ROUND(SUM(jei.debit_amount), 2)::float  AS debits,
            ROUND(SUM(jei.credit_amount), 2)::float AS credits
       FROM journal_entries je
       JOIN journal_entry_items jei ON jei.journal_entry_id = je.id
      WHERE je.id = $1
      GROUP BY je.id, je.status`,
    [invoice.journal_entry_id]
  );
  assert.equal(je.rows[0].status, 'POSTED');
  assert.equal(je.rows[0].debits, je.rows[0].credits, 'the posted entry must balance');
  assert.equal(je.rows[0].debits, 1100, 'debits should equal the invoice total including tax');
});

test('JournalEntry.create on a caller transaction is invisible until that transaction commits', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const accounts = await pool.query(
    `SELECT id, account_code FROM chart_of_accounts
      WHERE account_code IN ('1120','4100') AND deleted_at IS NULL`);
  if (accounts.rows.length < 2) return t.skip('required GL accounts missing');
  const byCode = new Map(accounts.rows.map((a) => [a.account_code, a.id]));

  const before = await counts();
  const client = await pool.connect();
  let entryId = null;

  try {
    await client.query('BEGIN');
    const entry = await JournalEntry.create(
      {
        entry_date: new Date().toISOString().split('T')[0],
        source_type: 'MANUAL',
        description: 'transaction visibility probe',
        requires_approval: false,
      },
      [
        { account_id: byCode.get('1120'), debit_amount: 50, credit_amount: 0, description: 'probe dr' },
        { account_id: byCode.get('4100'), debit_amount: 0, credit_amount: 50, description: 'probe cr' },
      ],
      userId,
      client
    );
    entryId = entry.id;

    // create() must return a usable object even though nothing is committed —
    // it has to read back on the caller's client, not the pool.
    assert.ok(entry.id, 'create should return the entry when given an external client');
    assert.equal(entry.items.length, 2, 'and its lines, read back on the same transaction');

    // Another connection must not see it yet.
    const mid = await counts();
    assert.equal(mid.journalEntries, before.journalEntries,
      'an uncommitted entry must not be visible outside its transaction');

    await client.query('ROLLBACK');
  } finally {
    client.release();
  }

  const after = await counts();
  assert.equal(after.journalEntries, before.journalEntries,
    'after rollback the entry should not exist at all');

  const gone = await pool.query('SELECT 1 FROM journal_entries WHERE id = $1', [entryId]);
  assert.equal(gone.rows.length, 0);
});
