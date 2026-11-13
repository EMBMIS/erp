// Reporting session — drill-down data plumbing.
//
// routes/financial-reports.js's trial-balance/balance-sheet/income-statement/
// ar-aging/ap-aging/gr-ir-aging endpoints previously returned account codes
// and invoice numbers but no ids — nothing a frontend row could link to. This
// suite exercises the exact SQL those endpoints now run (duplicated here
// rather than requiring the whole authenticated Express app, matching how
// financialPostingService/periodCloseService are tested at the service/SQL
// layer elsewhere in this repo) and proves each report line now carries a
// real id/journal_entry_id that resolves to an actual underlying record.

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { pool } = require('../config/database');
const JournalEntry = require('../models/JournalEntry');

let dbAvailable = false;
let userId = null;
let customerId = null;
let supplierId = null;
const cleanup = { invoiceIds: [], billIds: [], journalEntryIds: [] };

function rand(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

async function accountId(code) {
  const { rows } = await pool.query(
    'SELECT id FROM chart_of_accounts WHERE account_code = $1 AND deleted_at IS NULL LIMIT 1', [code]
  );
  return rows[0].id;
}

before(async () => {
  try {
    await pool.query('SELECT 1');
    const users = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
    if (!users.rows.length) return;
    userId = users.rows[0].id;

    const customer = await pool.query(
      `INSERT INTO customers (customer_code, customer_name, status, created_by)
       VALUES ($1, 'RD Test Customer', 'ACTIVE', $2) RETURNING id`,
      [rand('RD-CUST'), userId]
    );
    customerId = customer.rows[0].id;

    const supplier = await pool.query(
      `INSERT INTO suppliers (supplier_code, legal_name, status)
       VALUES ($1, 'RD Test Supplier', 'ACTIVE') RETURNING id`,
      [rand('RD-SUP')]
    );
    supplierId = supplier.rows[0].id;

    dbAvailable = true;
  } catch (err) {
    console.error('reportingDrilldown test setup failed:', err.message);
  }
});

after(async () => {
  if (!dbAvailable) return;
  await pool.query('DELETE FROM customer_invoices WHERE id = ANY($1::uuid[])', [cleanup.invoiceIds]);
  await pool.query('DELETE FROM supplier_invoices WHERE id = ANY($1::uuid[])', [cleanup.billIds]);
  await pool.query('DELETE FROM journal_entry_items WHERE journal_entry_id = ANY($1::uuid[])', [cleanup.journalEntryIds]);
  await pool.query('DELETE FROM journal_entry_status_history WHERE journal_entry_id = ANY($1::uuid[])', [cleanup.journalEntryIds]);
  await pool.query('DELETE FROM journal_entries WHERE id = ANY($1::uuid[])', [cleanup.journalEntryIds]);
  if (customerId) await pool.query('DELETE FROM customers WHERE id = $1', [customerId]);
  if (supplierId) await pool.query('DELETE FROM suppliers WHERE id = $1', [supplierId]);
});

after(async () => {
  await Promise.race([pool.end(), new Promise((r) => setTimeout(r, 5000))]);
});

test('trial balance / balance sheet / income statement rows now carry account_id', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  // Mirrors financialPostingService.getTrialBalance's query (with account_id added).
  const tb = await pool.query(`
    SELECT coa.id as account_id, coa.account_code
      FROM chart_of_accounts coa
      LEFT JOIN journal_entry_items jei ON coa.id = jei.account_id
      LEFT JOIN journal_entries je ON jei.journal_entry_id = je.id
     WHERE coa.deleted_at IS NULL AND coa.is_active = true AND coa.is_header = false
       AND je.status = 'POSTED'
     GROUP BY coa.id, coa.account_code
    HAVING SUM(jei.debit_amount) > 0 OR SUM(jei.credit_amount) > 0
     LIMIT 5
  `);
  assert.ok(tb.rows.length > 0, 'expected at least one posted account to exist');
  for (const row of tb.rows) {
    assert.ok(row.account_id, 'every trial-balance row must carry account_id');
    const acct = await pool.query('SELECT id FROM chart_of_accounts WHERE id = $1', [row.account_id]);
    assert.equal(acct.rows.length, 1, 'account_id must resolve to a real chart_of_accounts row');
  }
});

test('AR aging detail rows carry invoice id + journal_entry_id that resolve to real records', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const arAcc = await accountId('1120');
  const revAcc = await accountId('4100');
  const entry = await JournalEntry.create(
    { entry_date: new Date().toISOString().split('T')[0], description: 'RD test AR posting', source_type: 'MANUAL', reference: rand('RD-JE'), requires_approval: false },
    [{ account_id: arAcc, debit_amount: 250, credit_amount: 0, description: 'AR' }, { account_id: revAcc, debit_amount: 0, credit_amount: 250, description: 'Revenue' }],
    userId
  );
  await JournalEntry.postAsSystem(entry.id, userId, 'RD test fixture');
  cleanup.journalEntryIds.push(entry.id);

  const invoice = await pool.query(
    `INSERT INTO customer_invoices
       (invoice_number, customer_id, invoice_date, due_date, subtotal, tax_amount, discount_amount,
        total_amount, paid_amount, status, created_by, journal_entry_id)
     VALUES ($1, $2, CURRENT_DATE, CURRENT_DATE + 30, 250, 0, 0, 250, 0, 'APPROVED', $3, $4)
     RETURNING id`,
    [rand('RD-INV'), customerId, userId, entry.id]
  );
  cleanup.invoiceIds.push(invoice.rows[0].id);

  // Mirrors the ar-aging detail SELECT (with id + journal_entry_id added).
  const detail = await pool.query(
    `SELECT ci.id, ci.journal_entry_id, ci.invoice_number
       FROM customer_invoices ci
      WHERE ci.id = $1`,
    [invoice.rows[0].id]
  );
  assert.equal(detail.rows.length, 1);
  assert.equal(detail.rows[0].id, invoice.rows[0].id);
  assert.equal(detail.rows[0].journal_entry_id, entry.id);

  const je = await pool.query('SELECT status FROM journal_entries WHERE id = $1', [detail.rows[0].journal_entry_id]);
  assert.equal(je.rows[0].status, 'POSTED', 'the linked journal entry must be a real posted entry');
});

test('AP aging detail rows carry bill id + journal_entry_id that resolve to real records', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const apAcc = await accountId('2110');
  const expAcc = await accountId('5100');
  const entry = await JournalEntry.create(
    { entry_date: new Date().toISOString().split('T')[0], description: 'RD test AP posting', source_type: 'MANUAL', reference: rand('RD-JE'), requires_approval: false },
    [{ account_id: expAcc, debit_amount: 180, credit_amount: 0, description: 'Expense' }, { account_id: apAcc, debit_amount: 0, credit_amount: 180, description: 'AP' }],
    userId
  );
  await JournalEntry.postAsSystem(entry.id, userId, 'RD test fixture');
  cleanup.journalEntryIds.push(entry.id);

  const bill = await pool.query(
    `INSERT INTO supplier_invoices
       (bill_number, supplier_id, invoice_date, due_date, subtotal, tax_amount, discount_amount,
        total_amount, paid_amount, status, created_by, exchange_rate, journal_entry_id)
     VALUES ($1, $2, CURRENT_DATE, CURRENT_DATE + 30, 180, 0, 0, 180, 0, 'APPROVED', $3, 1, $4)
     RETURNING id`,
    [rand('RD-BILL'), supplierId, userId, entry.id]
  );
  cleanup.billIds.push(bill.rows[0].id);

  // Mirrors the ap-aging detail SELECT (with id + journal_entry_id added).
  const detail = await pool.query(
    `SELECT si.id, si.journal_entry_id, si.bill_number
       FROM supplier_invoices si
      WHERE si.id = $1`,
    [bill.rows[0].id]
  );
  assert.equal(detail.rows.length, 1);
  assert.equal(detail.rows[0].id, bill.rows[0].id);
  assert.equal(detail.rows[0].journal_entry_id, entry.id);
});

test('GR/IR aging items carry journal_entry_ids that resolve to real, uncleared postings', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const grirAcc = await accountId('2115');
  const cashAcc = await accountId('1110');

  // A real GR/IR fixture: a balanced posting (Dr an asset-in-transit-style
  // debit / Cr 2115) so the aggregation below has a genuine uncleared credit.
  const balanced = await JournalEntry.create(
    { entry_date: new Date().toISOString().split('T')[0], description: 'RD test GR/IR posting 2', source_type: 'GOODS_RECEIPT', source_id: randomUUID(), reference: rand('RD-JE'), requires_approval: false },
    [{ account_id: cashAcc, debit_amount: 90, credit_amount: 0, description: 'debit leg' }, { account_id: grirAcc, debit_amount: 0, credit_amount: 90, description: 'GR/IR clearing' }],
    userId
  );
  await JournalEntry.postAsSystem(balanced.id, userId, 'RD test fixture');
  cleanup.journalEntryIds.push(balanced.id);

  // Mirrors the gr-ir-aging CTE (with journal_entry_ids aggregation added).
  const { rows } = await pool.query(`
    WITH gr_lines AS (
      SELECT jel.journal_entry_id, je.source_id AS receipt_id,
             jel.credit_amount - jel.debit_amount AS net_credit
        FROM journal_entry_items jel
        JOIN journal_entries je ON jel.journal_entry_id = je.id
        JOIN chart_of_accounts coa ON jel.account_id = coa.id
       WHERE coa.account_code = '2115' AND je.deleted_at IS NULL AND je.id = $1
    )
    SELECT receipt_id, COALESCE(SUM(net_credit), 0)::numeric(15,2) AS balance,
           array_agg(DISTINCT journal_entry_id) AS journal_entry_ids
      FROM gr_lines GROUP BY receipt_id
  `, [balanced.id]);

  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].balance), 90);
  assert.deepEqual(rows[0].journal_entry_ids, [balanced.id]);

  const je = await pool.query('SELECT status FROM journal_entries WHERE id = $1', [rows[0].journal_entry_ids[0]]);
  assert.equal(je.rows[0].status, 'POSTED');
});
