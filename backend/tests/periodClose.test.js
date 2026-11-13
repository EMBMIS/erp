// Task 17 tests — F2: period close with real gates (ROADMAP_TO_10).
//
// Covers:
//   - every pre-close gate reports the right severity (BLOCKING vs WARNING)
//     and a failing fixture flips its `passed` flag to false;
//   - closePeriod() refuses on BLOCKING failures and refuses an unsigned
//     sign-off checklist, then succeeds with a fully signed checklist,
//     persisting the checklist and a hash-chained audit record;
//   - reopenPeriod() requires a documented reason and writes an audit record;
//   - the HARD LOCK: raw-SQL INSERT and UPDATE into a CLOSED period are
//     refused at the DATABASE layer (trigger fn_guard_closed_period_posting),
//     not just in the service.
//
// The suite uses a far-future period (2099-12) on the existing default company
// (the guard_company_insert trigger forbids creating a second company) so it
// can never collide with period-close or posting fixtures of other suites.
// Everything it creates is deleted in teardown, and the chart_of_accounts
// control balances are restored to the db:verify invariant after the
// reconciliation true-up entry is removed.

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { pool } = require('../config/database');
const PeriodCloseService = require('../services/periodCloseService');
const { verifyAuditChain } = require('../services/auditTrailService');
const { runAsOwner } = require('./helpers/multiCompany');

const YEAR = 2099;
const MONTH = 12;
const CONTROL_ACCOUNTS = ['1200', '2110', '1130', '3200'];

let dbAvailable = false;
let companyId = null;
let userId = null;
let supplierId = null;
let customerId = null;
let periodId = null;
const chainIds = [];        // audit_chain rows appended by this suite

function rand(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

async function tailSafeDeleteChain(ids) {
  if (!ids.length) return;
  const max = Math.max(...ids);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM audit_chain WHERE id > $1', [max]);
  if (rows[0].n === 0) {
    await pool.query('DELETE FROM audit_chain WHERE id = ANY($1::bigint[])', [ids]);
  }
}

async function deleteTestJournalEntries() {
  await pool.query(
    `DELETE FROM journal_entry_items
      WHERE journal_entry_id IN (
        SELECT id FROM journal_entries
         WHERE company_id = $1 AND period_year = $2 AND period_month = $3
           AND journal_number LIKE 'T17-%')`,
    [companyId, YEAR, MONTH]
  );
  await pool.query(
    `DELETE FROM journal_entry_status_history
      WHERE journal_entry_id IN (
        SELECT id FROM journal_entries
         WHERE company_id = $1 AND period_year = $2 AND period_month = $3
           AND journal_number LIKE 'T17-%')`,
    [companyId, YEAR, MONTH]
  );
  await pool.query(
    `DELETE FROM journal_entries
      WHERE company_id = $1 AND period_year = $2 AND period_month = $3
        AND journal_number LIKE 'T17-%'`,
    [companyId, YEAR, MONTH]
  );
}

/** Insert a minimal journal entry dated into the test period. */
async function insertJournalEntry({ status = 'DRAFT', currency = 'USD', exchangeRate = 1, description = 'T17 fixture', reference = null } = {}) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO journal_entries
       (id, journal_number, entry_date, posting_date, period_year, period_month,
        source_type, description, reference, total_debit, total_credit, status,
        currency, exchange_rate, created_by, company_id)
     VALUES ($1, $2, $3, $3, $4, $5, 'MANUAL', $6, $7, 0, 0, $8, $9, $10, $11, $12)`,
    [id, rand('T17-JE'), `${YEAR}-${String(MONTH).padStart(2, '0')}-15`, YEAR, MONTH,
      description, reference, status, currency, exchangeRate, userId, companyId]
  );
  return id;
}

/** Recomputed control-account balances per the db:verify 'account-balance-cache' invariant. */
async function recomputeControlBalances() {
  await pool.query(
    `UPDATE chart_of_accounts coa
        SET current_balance = COALESCE((
          SELECT SUM(CASE WHEN coa.normal_balance = 'DEBIT'
                          THEN jei.debit_amount - jei.credit_amount
                          ELSE jei.credit_amount - jei.debit_amount END)
            FROM journal_entry_items jei
            JOIN journal_entries je
              ON je.id = jei.journal_entry_id AND je.status = 'POSTED' AND je.deleted_at IS NULL
           WHERE jei.account_id = coa.id
        ), 0)
      WHERE coa.account_code = ANY($1::text[])`,
    [CONTROL_ACCOUNTS]
  );
}

/**
 * Post a reconciliation true-up entry so the AR/AP/inventory ties hold.
 * Accounts already in balance get no line (a zero line would violate
 * chk_journal_item_amounts_valid). Returns the entry id.
 */
async function postTrueUp() {
  // The negative-stock gate reads inventory_items directly - journal entries
  // cannot fix it. Zero the negative balances before valuing the stock.
  await pool.query('UPDATE inventory_items SET current_stock_quantity = 0 WHERE company_id = $1 AND current_stock_quantity < 0', [companyId]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const q = (sql, p) => client.query(sql, p);
    const arTotal = Number((await q(
      `SELECT COALESCE(SUM(outstanding_amount), 0)::numeric(15,2) AS t FROM customer_invoices
        WHERE company_id = $1 AND deleted_at IS NULL AND status NOT IN ('PAID','CANCELLED')`, [companyId])).rows[0].t);
    const apTotal = Number((await q(
      `SELECT COALESCE(SUM(outstanding_amount), 0)::numeric(15,2) AS t FROM supplier_invoices
        WHERE company_id = $1 AND deleted_at IS NULL AND status NOT IN ('PAID','CANCELLED')`, [companyId])).rows[0].t);
    const invTotal = Number((await q(
      `SELECT COALESCE(SUM(current_stock_quantity * COALESCE(unit_price, 0)), 0)::numeric(15,2) AS t FROM inventory_items
        WHERE company_id = $1`, [companyId])).rows[0].t);

    const accountOf = async (code) => {
      const { rows } = await q(
        `SELECT id, account_code, account_name, normal_balance, current_balance
           FROM chart_of_accounts
          WHERE company_id = $1 AND account_code = $2 AND deleted_at IS NULL LIMIT 1`, [companyId, code]);
      return rows[0];
    };

    const arAcct = await accountOf('1200');
    const apAcct = await accountOf('2110');
    const invAcct = await accountOf('1130');
    const eqAcct = await accountOf('3200');
    if (!arAcct || !apAcct || !invAcct || !eqAcct) {
      throw new Error('Control accounts (1200/2110/1130/3200) not found for the default company');
    }

    const delta = (acct, total) => total - Number(acct.current_balance);
    const arDelta = delta(arAcct, arTotal);
    const apDelta = delta(apAcct, apTotal);
    const invDelta = delta(invAcct, invTotal);
    const eqDelta = -(arDelta + apDelta + invDelta); // balancing leg

    // Skip accounts already in balance: a zero line would violate
    // chk_journal_item_amounts_valid and changes nothing anyway.
    const lines = [
      { account: arAcct, delta: arDelta },
      { account: apAcct, delta: apDelta },
      { account: invAcct, delta: invDelta },
      { account: eqAcct, delta: eqDelta },
    ].filter(({ delta: d }) => Math.abs(d) > 0.005).map(({ account, delta: d }) => ({
      account,
      debit: d > 0 ? d : 0,
      credit: d < 0 ? -d : 0,
    }));

    const totalDebits = Math.round(lines.reduce((s, l) => s + l.debit, 0) * 100) / 100;
    const totalCredits = Math.round(lines.reduce((s, l) => s + l.credit, 0) * 100) / 100;
    assert.ok(Math.abs(totalDebits - totalCredits) <= 0.01, `true-up must balance (${totalDebits} vs ${totalCredits})`);

    const jeId = randomUUID();
    await q(
      `INSERT INTO journal_entries
         (id, journal_number, entry_date, posting_date, period_year, period_month,
          source_type, description, reference, total_debit, total_credit, status,
          currency, exchange_rate, created_by, posted_by, posted_at, company_id)
       VALUES ($1, $2, $3, $3, $4, $5, 'MANUAL', 'T17 reconciliation true-up', 'T17-TRUEUP',
               $6, $7, 'POSTED', 'USD', 1, $8, $8, CURRENT_TIMESTAMP, $9)`,
      [jeId, rand('T17-JE'), `${YEAR}-${String(MONTH).padStart(2, '0')}-01`, YEAR, MONTH,
        totalDebits, totalCredits, userId, companyId]
    );

    let line = 0;
    for (const l of lines) {
      line++;
      await q(
        `INSERT INTO journal_entry_items
           (journal_entry_id, line_number, account_id, account_code, account_name, debit_amount, credit_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [jeId, line, l.account.id, l.account.account_code, l.account.account_name, l.debit, l.credit]
      );
    }
    await q(
      `INSERT INTO journal_entry_status_history (journal_entry_id, from_status, to_status, status_date, changed_by, reason)
       VALUES ($1, NULL, 'POSTED', CURRENT_TIMESTAMP, $2, 'T17 test true-up')`,
      [jeId, userId]
    );

    // Apply the same additive balance effect JournalEntry.updateAccountBalances uses.
    for (const l of lines) {
      const d = l.debit - l.credit;
      await q(
        `UPDATE chart_of_accounts
            SET current_balance = current_balance + $2,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [l.account.id, d]
      );
    }

    await client.query('COMMIT');
    return jeId;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Delete the true-up entry and recompute control balances from posted lines. */
async function undoTrueUp() {
  await pool.query(
    `DELETE FROM journal_entry_items
      WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE reference = 'T17-TRUEUP')`
  );
  await pool.query(
    `DELETE FROM journal_entry_status_history
      WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE reference = 'T17-TRUEUP')`
  );
  await pool.query(`DELETE FROM journal_entries WHERE reference = 'T17-TRUEUP'`);
  await recomputeControlBalances();
}

function signedChecklist() {
  return PeriodCloseService.buildChecklist().map((c) => ({ check_key: c.check_key, owner: c.owner, signed: true }));
}

function findCheck(checks, key) {
  const c = checks.find((x) => x.key === key);
  assert.ok(c, `expected check ${key} in results`);
  return c;
}

before(async () => {
  try {
    await pool.query('SELECT 1');
    const company = await pool.query('SELECT id FROM companies WHERE deleted_at IS NULL ORDER BY is_default DESC, created_at LIMIT 1');
    const user = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
    const supplier = await pool.query('SELECT id FROM suppliers WHERE company_id = $1 LIMIT 1', [company.rows[0].id]);
    const customer = await pool.query('SELECT id FROM customers WHERE company_id = $1 AND deleted_at IS NULL LIMIT 1', [company.rows[0].id]);
    if (!company.rows.length || !user.rows.length) return;

    companyId = company.rows[0].id;
    userId = user.rows[0].id;
    supplierId = supplier.rows[0]?.id || null;
    customerId = customer.rows[0]?.id || null;

    // Ensure the far-future test period exists and is OPEN, scoped to this
    // company. Was `ON CONFLICT (period_year, period_month)` — a target
    // migration 202608130100 removed when accounting_periods became
    // company-scoped (replaced by a partial unique index on (company_id,
    // period_year, period_month)); Postgres rejects an ON CONFLICT clause
    // naming no matching constraint/index, so this fixture's own upsert threw
    // on every run and every test in this suite silently self-skipped with
    // "no database" — the exact false-confidence bug this session's targeted
    // fix to routes/accounting-periods.js closes for the real close route.
    const period = await pool.query(
      `INSERT INTO accounting_periods (company_id, period_year, period_month, status)
       VALUES ($1, $2, $3, 'OPEN')
       ON CONFLICT (company_id, period_year, period_month) WHERE company_id IS NOT NULL
       DO UPDATE SET status = 'OPEN', closed_by = NULL, closed_at = NULL
       RETURNING id`,
      [companyId, YEAR, MONTH]
    );
    periodId = period.rows[0].id;
    dbAvailable = true;
  } catch (error) {
    console.error('periodClose test setup failed:', error.message);
  }
});

after(async () => {
  if (!dbAvailable) return;
  await deleteTestJournalEntries();
  await undoTrueUp();
  if (periodId) {
    await pool.query('DELETE FROM period_close_checklist WHERE period_id = $1', [periodId]);
    await pool.query('DELETE FROM accounting_periods WHERE id = $1', [periodId]);
  }
  // Safety net: never leave inventory_items without its non-negative constraint.
  const con = await pool.query(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = 'inventory_items'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%current_stock_quantity%'`
  );
  if (!con.rows.length) {
    await runAsOwner('ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_current_stock_quantity_check CHECK (current_stock_quantity >= 0)').catch(() => {});
  }
  await tailSafeDeleteChain(chainIds);
});

test('pre-close checks cover all ten gates with the right severity', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const result = await PeriodCloseService.validatePreCloseChecks(periodId, companyId);

  assert.equal(result.checks.length, 10);
  const severities = Object.fromEntries(result.checks.map((c) => [c.key, c.severity]));
  assert.deepEqual(severities, {
    unposted_journal_entries: 'BLOCKING',
    bank_reconciliation: 'WARNING',
    negative_inventory: 'BLOCKING',
    grir_received_not_invoiced: 'WARNING',
    grir_invoiced_not_received: 'WARNING',
    ar_gl_tie: 'BLOCKING',
    ap_gl_tie: 'BLOCKING',
    inventory_gl_tie: 'BLOCKING',
    fx_revaluation: 'WARNING',
    depreciation_posted: 'WARNING',
  });
  for (const c of result.checks) {
    assert.equal(typeof c.passed, 'boolean');
    assert.ok(c.details && c.details.length > 0, `${c.key} must carry details`);
  }

  const checklist = PeriodCloseService.buildChecklist();
  assert.equal(checklist.length, 10);
  for (const item of checklist) {
    assert.ok(item.owner && item.owner.length > 0, 'every checklist item has a named owner');
    assert.equal(item.signed, false);
  }
});

test('closePeriod requires a signed checklist, then closes; reopenPeriod requires a reason and audits it', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  if (!supplierId || !customerId) return t.skip('missing seed supplier/customer');

  // 1. True-up the AR/AP/inventory control accounts so all BLOCKING gates pass.
  await postTrueUp();
  const clean = await PeriodCloseService.validatePreCloseChecks(periodId, companyId);
  assert.equal(clean.blocking_passed, true,
    `blocking checks must pass after true-up: ${clean.checks.filter((c) => c.severity === 'BLOCKING' && !c.passed).map((c) => c.details).join(' | ')}`);

  // 2. An unsigned checklist must refuse the close.
  await assert.rejects(
    PeriodCloseService.closePeriod(periodId, userId, companyId, { checklist: [] }),
    (err) => err.code === 'PZ-4003' && /not signed off/.test(err.message)
  );

  // 3. Signed checklist → close succeeds; warnings are acknowledged, not blocking.
  const closed = await PeriodCloseService.closePeriod(periodId, userId, companyId, {
    checklist: signedChecklist(),
    reason: 'Task 17 test close',
  });
  assert.equal(closed.success, true);
  assert.equal(closed.period.status, 'CLOSED');
  assert.equal(closed.checklist.length, 10);
  for (const item of closed.checklist) {
    assert.equal(item.signed_by, userId);
    assert.ok(item.signed_at);
    assert.ok(item.owner.length > 0);
  }

  const persisted = await pool.query(
    'SELECT check_key, signed_by FROM period_close_checklist WHERE period_id = $1 ORDER BY check_key',
    [periodId]
  );
  assert.equal(persisted.rows.length, 10);
  assert.ok(persisted.rows.every((r) => r.signed_by === userId));

  const closeAudit = await pool.query(
    `SELECT entity_type, from_status, to_status, reason FROM audit_chain
      WHERE entity_type = 'ACCOUNTING_PERIOD' AND entity_id = $1 AND to_status = 'CLOSED'
      ORDER BY id DESC LIMIT 1`,
    [periodId]
  );
  assert.equal(closeAudit.rows.length, 1);
  chainIds.push(...(await pool.query(
    `SELECT id FROM audit_chain WHERE entity_type = 'ACCOUNTING_PERIOD' AND entity_id = $1`, [periodId]
  )).rows.map((r) => Number(r.id)));

  // 4. Reopen without a reason must be refused.
  await assert.rejects(
    PeriodCloseService.reopenPeriod(periodId, '   ', userId, companyId),
    /reason is required/i
  );

  // 5. Reopen with a reason succeeds and writes an audit record carrying it.
  const reason = `Task 17 test reopen ${randomUUID().slice(0, 8)}`;
  const reopened = await PeriodCloseService.reopenPeriod(periodId, reason, userId, companyId);
  assert.equal(reopened.success, true);
  assert.equal(reopened.period.status, 'OPEN');
  assert.equal(reopened.reason, reason);

  const reopenAudit = await pool.query(
    `SELECT from_status, to_status, reason FROM audit_chain
      WHERE entity_type = 'ACCOUNTING_PERIOD' AND entity_id = $1 AND to_status = 'OPEN'
      ORDER BY id DESC LIMIT 1`,
    [periodId]
  );
  assert.equal(reopenAudit.rows.length, 1);
  assert.equal(reopenAudit.rows[0].from_status, 'CLOSED');
  assert.equal(reopenAudit.rows[0].reason, reason);

  // 6. The chain is still verifiable end to end.
  const chainOk = await verifyAuditChain();
  assert.equal(chainOk.valid, true, 'audit chain must remain valid');

  // Cleanup: remove the true-up and the persisted checklist rows.
  await pool.query('DELETE FROM period_close_checklist WHERE period_id = $1', [periodId]);
  await undoTrueUp();
});

test('validation: unposted journal entries in the period are BLOCKING', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  await insertJournalEntry({ status: 'DRAFT', description: 'T17 unposted fixture' });
  try {
    const result = await PeriodCloseService.validatePreCloseChecks(periodId, companyId);
    const c = findCheck(result.checks, 'unposted_journal_entries');
    assert.equal(c.severity, 'BLOCKING');
    assert.equal(c.passed, false);
  } finally {
    await deleteTestJournalEntries();
  }
});

test('validation: unreconciled bank transactions are WARNING', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const bankAccountId = randomUUID();
  const bankTxId = randomUUID();
  await pool.query(
    `INSERT INTO bank_accounts (id, account_name, opening_balance, status, created_by, company_id)
     VALUES ($1, $2, 0, 'ACTIVE', $3, $4)`,
    [bankAccountId, rand('T17-BA'), userId, companyId]
  );
  await pool.query(
    `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, description, amount, is_reconciled, created_by, company_id)
     VALUES ($1, $2, $3, 'T17 bank fixture', 100, false, $4, $5)`,
    [bankTxId, bankAccountId, `${YEAR}-${String(MONTH).padStart(2, '0')}-15`, userId, companyId]
  );
  try {
    const result = await PeriodCloseService.validatePreCloseChecks(periodId, companyId);
    const c = findCheck(result.checks, 'bank_reconciliation');
    assert.equal(c.severity, 'WARNING');
    assert.equal(c.passed, false);
  } finally {
    await pool.query('DELETE FROM bank_transactions WHERE id = $1', [bankTxId]);
    await pool.query('DELETE FROM bank_accounts WHERE id = $1', [bankAccountId]);
  }
});

test('validation: negative inventory on hand is BLOCKING', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const itemId = randomUUID();
  const invId = randomUUID();
  await pool.query(
    `INSERT INTO items (id, item_code, name, is_stock_item, planned_stock, stock_code, status, criticality, unit_of_measure, company_id)
     VALUES ($1, $2, 'T17 negative stock item', true, false, 'ST1', 'APPROVED', 'LOW', 'pcs', $3)`,
    [itemId, rand('T17-ITM'), companyId]
  );

  // The schema forbids negative stock (CHECK current_stock_quantity >= 0), so
  // the failing fixture needs the constraint temporarily lifted. It is
  // re-added in `finally` (and again in the suite teardown as a safety net).
  const con = await pool.query(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = 'inventory_items'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%current_stock_quantity%'`
  );
  // ALTER TABLE needs table ownership, which the application role deliberately
  // does not have (migration 111). Lifting the constraint is fixture setup, so
  // it goes over the owner connection; everything under test stays on `pool`.
  const conName = con.rows[0]?.conname || null;
  if (conName) await runAsOwner(`ALTER TABLE inventory_items DROP CONSTRAINT ${conName}`);
  try {
    await pool.query(
      `INSERT INTO inventory_items (id, item_master_id, current_stock_quantity, unit_price, user_id, status, company_id)
       VALUES ($1, $2, -5, 10, $3, 'APPROVED', $4)`,
      [invId, itemId, userId, companyId]
    );
    const result = await PeriodCloseService.validatePreCloseChecks(periodId, companyId);
    const c = findCheck(result.checks, 'negative_inventory');
    assert.equal(c.severity, 'BLOCKING');
    assert.equal(c.passed, false);
  } finally {
    if (conName) {
      // Leftover negative rows (e.g. from a crashed run) would fail the re-add.
      await pool.query('UPDATE inventory_items SET current_stock_quantity = 0 WHERE current_stock_quantity < 0').catch(() => {});
      await runAsOwner(`ALTER TABLE inventory_items ADD CONSTRAINT ${conName} CHECK (current_stock_quantity >= 0)`);
    }
    await pool.query('DELETE FROM inventory_items WHERE id = $1', [invId]);
    await pool.query('DELETE FROM items WHERE id = $1', [itemId]);
  }
});

test('validation: GR/IR — goods received not invoiced is WARNING', async (t) => {
  if (!dbAvailable || !supplierId) return t.skip('no database or supplier');
  const poId = randomUUID();
  const lineId = randomUUID();
  const grId = randomUUID();
  await pool.query(
    `INSERT INTO purchase_orders (id, po_number, supplier_id, po_date, status, created_by, company_id)
     VALUES ($1, $2, $3, $4, 'APPROVED', $5, $6)`,
    [poId, rand('T17-PO'), supplierId, `${YEAR}-${String(MONTH).padStart(2, '0')}-01`, userId, companyId]
  );
  await pool.query(
    `INSERT INTO purchase_order_line_items (id, po_id, item_description, quantity, unit_price)
     VALUES ($1, $2, 'T17 GR/IR line', 10, 5)`,
    [lineId, poId]
  );
  await pool.query(
    `INSERT INTO goods_receipts (id, po_id, po_line_item_id, quantity_received, received_date, company_id)
     VALUES ($1, $2, $3, 10, $4, $5)`,
    [grId, poId, lineId, `${YEAR}-${String(MONTH).padStart(2, '0')}-15`, companyId]
  );
  try {
    const result = await PeriodCloseService.validatePreCloseChecks(periodId, companyId);
    const c = findCheck(result.checks, 'grir_received_not_invoiced');
    assert.equal(c.severity, 'WARNING');
    assert.equal(c.passed, false);
  } finally {
    await pool.query('DELETE FROM goods_receipts WHERE id = $1', [grId]);
    await pool.query('DELETE FROM purchase_order_line_items WHERE id = $1', [lineId]);
    await pool.query('DELETE FROM purchase_orders WHERE id = $1', [poId]);
  }
});

test('validation: GR/IR — invoiced not received is WARNING', async (t) => {
  if (!dbAvailable || !supplierId) return t.skip('no database or supplier');
  const poId = randomUUID();
  const billId = randomUUID();
  await pool.query(
    `INSERT INTO purchase_orders (id, po_number, supplier_id, po_date, status, created_by, company_id)
     VALUES ($1, $2, $3, $4, 'APPROVED', $5, $6)`,
    [poId, rand('T17-PO'), supplierId, `${YEAR}-${String(MONTH).padStart(2, '0')}-01`, userId, companyId]
  );
  await pool.query(
    `INSERT INTO supplier_invoices
       (id, bill_number, supplier_id, purchase_order_id, invoice_date, due_date,
        subtotal, tax_amount, discount_amount, total_amount, paid_amount,
        status, created_by, exchange_rate, company_id)
     VALUES ($1, $2, $3, $4, $5, $6, 50, 0, 0, 50, 0, 'APPROVED', $7, 1, $8)`,
    [billId, rand('T17-BILL'), supplierId, poId,
      `${YEAR}-${String(MONTH).padStart(2, '0')}-20`, `${YEAR}-${String(MONTH).padStart(2, '0')}-25`,
      userId, companyId]
  );
  await pool.query(
    `INSERT INTO supplier_invoice_items (bill_id, line_number, item_description, quantity, unit_of_measure, unit_price, line_total)
     VALUES ($1, 1, 'T17 GR/IR line', 10, 'pcs', 5, 50)`,
    [billId]
  );
  try {
    const result = await PeriodCloseService.validatePreCloseChecks(periodId, companyId);
    const c = findCheck(result.checks, 'grir_invoiced_not_received');
    assert.equal(c.severity, 'WARNING');
    assert.equal(c.passed, false);
  } finally {
    await pool.query('DELETE FROM supplier_invoice_items WHERE bill_id = $1', [billId]);
    await pool.query('DELETE FROM supplier_invoices WHERE id = $1', [billId]);
    await pool.query('DELETE FROM purchase_orders WHERE id = $1', [poId]);
  }
});

test('validation: AR aging vs AR control tie is BLOCKING and moves with the fixture', async (t) => {
  if (!dbAvailable || !customerId) return t.skip('no database or customer');
  const baseline = await PeriodCloseService.validatePreCloseChecks(periodId, companyId);
  const before = Number(findCheck(baseline.checks, 'ar_gl_tie').details.match(/AR aging \$([\d.]+)/)[1]);

  const invId = randomUUID();
  await pool.query(
    `INSERT INTO customer_invoices
       (id, invoice_number, customer_id, invoice_date, due_date,
        subtotal, tax_amount, discount_amount, total_amount, paid_amount,
        status, created_by, exchange_rate, company_id)
     VALUES ($1, $2, $3, $4, $5, 500, 0, 0, 500, 0, 'APPROVED', $6, 1, $7)`,
    [invId, rand('T17-CI'), customerId,
      `${YEAR}-${String(MONTH).padStart(2, '0')}-10`, `${YEAR}-${String(MONTH).padStart(2, '0')}-20`,
      userId, companyId]
  );
  try {
    const result = await PeriodCloseService.validatePreCloseChecks(periodId, companyId);
    const c = findCheck(result.checks, 'ar_gl_tie');
    assert.equal(c.severity, 'BLOCKING');
    assert.equal(c.passed, false);
    const after = Number(c.details.match(/AR aging \$([\d.]+)/)[1]);
    assert.equal(Math.round(after - before), 500, 'fixture invoice must move the AR aging by 500');
  } finally {
    await pool.query('DELETE FROM customer_invoices WHERE id = $1', [invId]);
  }
});

test('validation: AP aging vs AP control tie is BLOCKING and moves with the fixture', async (t) => {
  if (!dbAvailable || !supplierId) return t.skip('no database or supplier');
  const baseline = await PeriodCloseService.validatePreCloseChecks(periodId, companyId);
  const before = Number(findCheck(baseline.checks, 'ap_gl_tie').details.match(/AP aging \$([\d.]+)/)[1]);

  const billId = randomUUID();
  await pool.query(
    `INSERT INTO supplier_invoices
       (id, bill_number, supplier_id, invoice_date, due_date,
        subtotal, tax_amount, discount_amount, total_amount, paid_amount,
        status, created_by, exchange_rate, company_id)
     VALUES ($1, $2, $3, $4, $5, 300, 0, 0, 300, 0, 'APPROVED', $6, 1, $7)`,
    [billId, rand('T17-BILL'), supplierId,
      `${YEAR}-${String(MONTH).padStart(2, '0')}-10`, `${YEAR}-${String(MONTH).padStart(2, '0')}-20`,
      userId, companyId]
  );
  try {
    const result = await PeriodCloseService.validatePreCloseChecks(periodId, companyId);
    const c = findCheck(result.checks, 'ap_gl_tie');
    assert.equal(c.severity, 'BLOCKING');
    assert.equal(c.passed, false);
    const after = Number(c.details.match(/AP aging \$([\d.]+)/)[1]);
    assert.equal(Math.round(after - before), 300, 'fixture bill must move the AP aging by 300');
  } finally {
    await pool.query('DELETE FROM supplier_invoices WHERE id = $1', [billId]);
  }
});

test('validation: inventory valuation vs inventory control tie is BLOCKING and moves with the fixture', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const baseline = await PeriodCloseService.validatePreCloseChecks(periodId, companyId);
  const before = Number(findCheck(baseline.checks, 'inventory_gl_tie').details.match(/Inventory valuation \$([\d.]+)/)[1]);

  const itemId = randomUUID();
  const invId = randomUUID();
  await pool.query(
    `INSERT INTO items (id, item_code, name, is_stock_item, planned_stock, stock_code, status, criticality, unit_of_measure, company_id)
     VALUES ($1, $2, 'T17 valuation item', true, false, 'ST1', 'APPROVED', 'LOW', 'pcs', $3)`,
    [itemId, rand('T17-ITM'), companyId]
  );
  await pool.query(
    `INSERT INTO inventory_items (id, item_master_id, current_stock_quantity, unit_price, user_id, status, company_id)
     VALUES ($1, $2, 100, 7, $3, 'APPROVED', $4)`,
    [invId, itemId, userId, companyId]
  );
  try {
    const result = await PeriodCloseService.validatePreCloseChecks(periodId, companyId);
    const c = findCheck(result.checks, 'inventory_gl_tie');
    assert.equal(c.severity, 'BLOCKING');
    assert.equal(c.passed, false);
    const after = Number(c.details.match(/Inventory valuation \$([\d.]+)/)[1]);
    assert.equal(Math.round(after - before), 700, 'fixture item must move the inventory valuation by 700');
  } finally {
    await pool.query('DELETE FROM inventory_items WHERE id = $1', [invId]);
    await pool.query('DELETE FROM items WHERE id = $1', [itemId]);
  }
});

test('validation: FX revaluation warning fires for multicurrency activity', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  await insertJournalEntry({ status: 'POSTED', currency: 'EUR', exchangeRate: 1.2, description: 'T17 fx fixture' });
  try {
    const result = await PeriodCloseService.validatePreCloseChecks(periodId, companyId);
    const c = findCheck(result.checks, 'fx_revaluation');
    assert.equal(c.severity, 'WARNING');
    assert.equal(c.passed, false);
  } finally {
    await deleteTestJournalEntries();
  }
});

test('validation: depreciation warning fires when assets are not depreciated', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const assetId = randomUUID();
  await pool.query(
    `INSERT INTO fixed_assets
       (id, asset_number, name, acquisition_date, acquisition_cost, salvage_value,
        useful_life_years, depreciation_method, accumulated_depreciation, status, created_by, company_id)
     VALUES ($1, $2, 'T17 depreciation fixture', '2099-01-01', 1000, 0, 5, 'STRAIGHT_LINE', 0, 'ACTIVE', $3, $4)`,
    [assetId, rand('T17-FA'), userId, companyId]
  );
  try {
    const result = await PeriodCloseService.validatePreCloseChecks(periodId, companyId);
    const c = findCheck(result.checks, 'depreciation_posted');
    assert.equal(c.severity, 'WARNING');
    assert.equal(c.passed, false);
  } finally {
    await pool.query('DELETE FROM fixed_assets WHERE id = $1', [assetId]);
  }
});

test('DB-layer hard lock refuses raw SQL postings into a CLOSED period', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  // A draft entry exists in the period while it is still OPEN.
  const draftId = await insertJournalEntry({ description: 'T17 lock-test draft' });

  // Close the period directly at the database layer (bypassing the service).
  await pool.query(
    `UPDATE accounting_periods SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [periodId]
  );
  const period = await pool.query('SELECT status FROM accounting_periods WHERE id = $1', [periodId]);
  assert.equal(period.rows[0].status, 'CLOSED');

  try {
    // (a) raw INSERT dated into the closed period must be refused by the trigger.
    await assert.rejects(
      pool.query(
        `INSERT INTO journal_entries
           (id, journal_number, entry_date, posting_date, period_year, period_month,
            source_type, description, total_debit, total_credit, status, created_by, company_id)
         VALUES ($1, $2, '2099-12-20', '2099-12-20', 2099, 12, 'MANUAL',
                 'T17 locked insert', 0, 0, 'DRAFT', $3, $4)`,
        [randomUUID(), rand('T17-LOCK'), userId, companyId]
      ),
      /CLOSED accounting period 2099-12/i
    );

    // (b) raw UPDATE of a row dated into the closed period must be refused too.
    await assert.rejects(
      pool.query('UPDATE journal_entries SET status = $1 WHERE id = $2', ['POSTED', draftId]),
      /CLOSED accounting period 2099-12/i
    );

    // The failed statements must not have left anything behind.
    const leftover = await pool.query(
      `SELECT COUNT(*)::int AS n FROM journal_entries
        WHERE company_id = $1 AND period_year = 2099 AND period_month = 12 AND journal_number LIKE 'T17-%'`,
      [companyId]
    );
    assert.equal(leftover.rows[0].n, 1, 'only the pre-existing draft may remain');
  } finally {
    // Reopen at the database layer and clean up.
    await pool.query(
      `UPDATE accounting_periods SET status = 'OPEN', closed_at = NULL, closed_by = NULL WHERE id = $1`,
      [periodId]
    );
    await deleteTestJournalEntries();
  }

  // Sanity: with the period OPEN again the same raw INSERT succeeds.
  const sanityId = await insertJournalEntry({ status: 'POSTED', description: 'T17 after reopen' });
  await pool.query('DELETE FROM journal_entries WHERE id = $1', [sanityId]);
});


after(async () => {
  // node:test cannot exit while the pg pool's sockets stay open; bound the close.
  await Promise.race([pool.end(), new Promise((r) => setTimeout(r, 5000))]);
});
