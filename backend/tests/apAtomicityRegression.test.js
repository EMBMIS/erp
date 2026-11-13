// Regression tests: supplier-invoice posting must be ATOMIC with its GL entry.
//
// History of the bug (ERP blocker #3):
//   SupplierInvoice.createFromPurchaseOrder opens a client + BEGIN for the bill
//   transaction, but called JournalEntry.create without the externalClient
//   argument. JournalEntry.create then pool.connect()s its OWN connection and
//   COMMITs the GL entry on an independent transaction while the bill
//   transaction is still open. A later failure inside the bill transaction
//   ROLLBACKs the bill but leaves a POSTED journal entry behind — real AP
//   liability in the ledger with no bill to trace it to.
//
// These tests post a real bill through the model (the exact path the
// POST /supplier-invoices/from-purchase-order/:id route calls) and assert:
//   (a) the bill row exists,
//   (b) the journal entry exists AND supplier_invoices.journal_entry_id points
//       at it,
//   (c) no orphaned journal entry exists without a bill linkage from this run,
// and — by fault injection right after the GL insert — that a failure inside
// the transaction rolls back BOTH the GL entry and the bill.
//
// Run on its own (from backend/):
//   node --test tests/apAtomicityRegression.test.js
// The DB is shared with other regression suites: every fixture id is a unique
// UUID and every assertion is scoped to this run, never a global count.

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');

const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const SupplierInvoice = require('../models/SupplierInvoice');
const JournalEntry = require('../models/JournalEntry');

let dbAvailable = false;
let userId = null;
// chart_of_accounts.current_balance is maintained additively by
// JournalEntry.updateAccountBalances, so deleting a journal entry does not undo
// its effect on the cache. Any test that posts to the GL must restore the
// balances it moved, or it leaves the database failing db:verify's
// account-balance-cache invariant for every later run.
let balanceSnapshot = null;

const created = { billIds: [], journalEntryIds: [], poIds: [], supplierIds: [] };

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

/** Seed a supplier + approved purchase order with unique ids for this run. */
async function seedPurchaseOrder() {
  const tag = uuidv4().slice(0, 8);
  const supplierId = uuidv4();
  const poId = uuidv4();

  await pool.query(
    `INSERT INTO suppliers (id, supplier_code, legal_name, payment_terms, currency, status, created_by)
     VALUES ($1, $2, 'AP Atomicity Test Supplier', 'Net 30', 'USD', 'ACTIVE', $3)`,
    [supplierId, `ATP-${tag}`, userId]
  );
  created.supplierIds.push(supplierId);

  await pool.query(
    `INSERT INTO purchase_orders (id, po_number, supplier_id, po_date, payment_terms, currency,
                                  subtotal, tax_amount, total_amount, status, created_by)
     VALUES ($1, $2, $3, CURRENT_DATE, 'Net 30', 'USD', 1000, 100, 1100, 'APPROVED', $4)`,
    [poId, `PO-ATP-${tag}`, supplierId, userId]
  );
  created.poIds.push(poId);
  return { poId, tag };
}

/** Journal entries created from a PO, with or without a bill linking them. */
async function entriesForPo(poId) {
  const r = await pool.query(
    `SELECT je.id, si.id AS bill_id
       FROM journal_entries je
       LEFT JOIN supplier_invoices si ON si.journal_entry_id = je.id
      WHERE je.source_type = 'PURCHASE_ORDER' AND je.source_id = $1`,
    [poId]
  );
  return r.rows;
}

before(async () => {
  try {
    await pool.query('SELECT 1');
    // The posting actor must satisfy statusTransitionService.resolveActor:
    // not soft-deleted (deleted_at IS NULL) and is_active = TRUE — the shared
    // dev DB's OLDEST user is soft-deleted, so "ORDER BY created_at LIMIT 1"
    // alone picks an actor every status change would reject.
    // It must ALSO satisfy the Authority Engine's segregation-of-duties rule:
    // createFromPurchaseOrder creates the journal entry AND posts it with the
    // same actor, and authority.js refuses same-user POSTs unless the actor is
    // the platform owner (identity check on PLATFORM_OWNER_EMAIL). Prefer that
    // owner; fall back to an active ADMIN for environments without one.
    const ownerEmail = String(process.env.PLATFORM_OWNER_EMAIL || '').trim().toLowerCase();
    const users = await pool.query(
      `SELECT id FROM users
        WHERE deleted_at IS NULL AND is_active = TRUE
        ORDER BY (LOWER(email) = $1) DESC, (role = 'ADMIN') DESC, created_at
        LIMIT 1`,
      [ownerEmail]
    );
    if (!users.rows.length) return; // no usable actor to post as -> suite skips
    userId = users.rows[0].id;
    balanceSnapshot = (await pool.query('SELECT id, current_balance FROM chart_of_accounts')).rows;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  if (dbAvailable) {
    for (const id of created.billIds) {
      await pool.query('DELETE FROM supplier_invoice_status_history WHERE bill_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM supplier_invoices WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.journalEntryIds) await purgeJournalEntry(id);
    for (const id of created.poIds) {
      await pool.query('DELETE FROM purchase_orders WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.supplierIds) {
      await pool.query('DELETE FROM suppliers WHERE id = $1', [id]).catch(() => {});
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

test('posting a supplier invoice commits bill + GL entry with a working journal_entry_id link', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const { poId, tag } = await seedPurchaseOrder();
  const bill = await SupplierInvoice.createFromPurchaseOrder(
    poId,
    { supplier_invoice_number: `VEND-${tag}` },
    userId
  );
  created.billIds.push(bill.id);
  created.journalEntryIds.push(bill.journal_entry_id);

  // (a) the bill row exists in the database
  const billRow = await pool.query('SELECT * FROM supplier_invoices WHERE id = $1', [bill.id]);
  assert.equal(billRow.rows.length, 1, 'the bill row must exist after posting');
  assert.equal(billRow.rows[0].status, 'APPROVED');

  // (b) the journal entry exists and supplier_invoices.journal_entry_id points at it
  assert.ok(bill.journal_entry_id, 'createFromPurchaseOrder must return the journal_entry_id it linked');
  const je = await pool.query('SELECT * FROM journal_entries WHERE id = $1', [bill.journal_entry_id]);
  assert.equal(je.rows.length, 1, 'the journal entry must exist');
  assert.equal(je.rows[0].status, 'POSTED', 'the linked entry must be posted');
  assert.equal(je.rows[0].source_type, 'PURCHASE_ORDER');
  assert.equal(je.rows[0].source_id, poId);

  const dbLink = await pool.query(
    'SELECT journal_entry_id FROM supplier_invoices WHERE id = $1', [bill.id]);
  assert.equal(dbLink.rows[0].journal_entry_id, bill.journal_entry_id,
    'the id written to supplier_invoices must match the returned id');

  // the GL entry must balance: Dr Inventory/VAT = Cr AP = gross (1000 + 100 tax)
  const bal = await pool.query(
    `SELECT ROUND(SUM(jei.debit_amount), 2)::float AS d, ROUND(SUM(jei.credit_amount), 2)::float AS c
       FROM journal_entry_items jei WHERE jei.journal_entry_id = $1`,
    [bill.journal_entry_id]
  );
  assert.equal(bal.rows[0].d, bal.rows[0].c, 'the posted entry must balance');
  assert.equal(bal.rows[0].d, 1100, 'debits should equal the PO gross total including tax');

  // (c) no orphaned journal entry exists without a bill linkage from this run
  const orphans = (await entriesForPo(poId)).filter((row) => row.bill_id === null);
  assert.deepEqual(orphans, [], 'every journal entry from this run must be linked to a bill');
});

test('a failure after the GL insert rolls back BOTH the bill and the journal entry', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const { poId } = await seedPurchaseOrder();

  // Break the very next step after JournalEntry.create posts the GL entry
  // inside the bill transaction (this is the fault-injection pattern proven in
  // glTransactionBoundary.test.js). The real posting code still executes; only
  // the tail of the method fails.
  const original = JournalEntry.updateStatus;
  JournalEntry.updateStatus = async () => { throw new Error('injected failure after GL post'); };

  let threw = false;
  try {
    await SupplierInvoice.createFromPurchaseOrder(poId, {}, userId);
  } catch (err) {
    threw = true;
    assert.match(err.message, /injected failure/);
  } finally {
    JournalEntry.updateStatus = original;
  }
  assert.ok(threw, 'the injected failure must propagate out of the posting');

  // The bill must be gone — the whole transaction rolled back.
  const bills = await pool.query(
    'SELECT id FROM supplier_invoices WHERE purchase_order_id = $1', [poId]);
  assert.equal(bills.rows.length, 0,
    'a rolled-back posting must not leave the bill behind');

  // The GL entry created on the same transaction must be gone too — under the
  // old bug it committed on its own connection and survived as an orphan.
  const entries = await entriesForPo(poId);
  assert.equal(entries.length, 0,
    'no journal entry may survive a rollback of the bill that triggered it');
});
