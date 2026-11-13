// Regression test for the credit-note approval gap found in the CRM audit
// (PHASE3_TEN_TENTHS_PROMPT.md item 3, RMA/credit notes):
//
//   POST /credit-notes/sales/:id/post required only requireManagerOrAdmin —
//   it never checked the credit note's status, so a freshly-created DRAFT
//   could be posted directly, skipping the PENDING_APPROVAL -> APPROVED
//   steps the schema and the frontend (CreditNotesList.jsx gates its Post
//   button on status === 'APPROVED') both assume exist. There was also no
//   route to actually reach APPROVED — a dead end.
//
//   Separately, postSalesCreditNote(cnId, user) was called with `user` as a
//   plain id string but read `user.id` in four places (JournalEntry.create,
//   postAsSystem, CostLayerService.createLayer) — every journal entry and
//   cost layer this path created silently got created_by = undefined.
//
// This test exercises the real submit/approve/post lifecycle end-to-end and
// asserts: (1) posting a DRAFT or PENDING_APPROVAL note is refused, (2) SoD
// blocks the creator from approving their own note, (3) a distinct approver
// can approve it, (4) posting an APPROVED note succeeds and the resulting
// journal entry has the correct created_by (not null/undefined).
//
// Real-DB suite: self-skips when no database is reachable. Run on its own:
//   cd backend && node --test tests/creditNoteApproval.test.js

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { pool } = require('../config/database');
const creditNotes = require('../routes/credit-notes');

let dbAvailable = false;
let creatorId = null;
let approverId = null;
let customerId = null;
let invoiceId = null;
let creditNoteId = null;

const created = { customerIds: [], invoiceIds: [], creditNoteIds: [] };

before(async () => {
  try {
    await pool.query('SELECT 1');
    const users = await pool.query(
      "SELECT id FROM users WHERE deleted_at IS NULL AND COALESCE(is_active, true) = true AND role IN ('ADMIN','MANAGER') ORDER BY created_at LIMIT 2"
    );
    if (users.rows.length < 2) throw new Error('need at least 2 manager/admin users for the SoD half of this test');
    [creatorId, approverId] = users.rows.map((r) => r.id);
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }

  customerId = randomUUID();
  await pool.query(
    `INSERT INTO customers (id, customer_code, customer_name, primary_email, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [customerId, `CUST-${Date.now().toString().slice(-6)}`, 'Credit Note Approval Test Co', 'cntest@example.com', creatorId]
  );
  created.customerIds.push(customerId);

  invoiceId = randomUUID();
  await pool.query(
    `INSERT INTO customer_invoices
       (id, invoice_number, customer_id, invoice_date, due_date, currency, subtotal, tax_amount, total_amount, paid_amount, status, created_by)
     VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_DATE, 'USD', 100, 0, 100, 0, 'APPROVED', $4)`,
    [invoiceId, `CNTEST-INV-${randomUUID().slice(0, 8)}`, customerId, creatorId]
  );
  created.invoiceIds.push(invoiceId);
});

after(async () => {
  if (dbAvailable) {
    for (const id of created.creditNoteIds) {
      await pool.query('DELETE FROM journal_entry_items WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE source_id = $1)', [id]).catch(() => {});
      await pool.query('DELETE FROM journal_entry_status_history WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE source_id = $1)', [id]).catch(() => {});
      await pool.query('DELETE FROM journal_entries WHERE source_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM credit_note_status_history WHERE credit_note_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM sales_credit_note_items WHERE credit_note_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM sales_credit_notes WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.invoiceIds) {
      await pool.query('DELETE FROM customer_invoices WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.customerIds) {
      await pool.query('DELETE FROM customers WHERE id = $1', [id]).catch(() => {});
    }
  }
  await pool.end().catch(() => {});
});

test('credit note approval: post refuses DRAFT and PENDING_APPROVAL, requires APPROVED', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  creditNoteId = randomUUID();
  await pool.query(
    `INSERT INTO sales_credit_notes (id, credit_note_number, customer_invoice_id, customer_id, credit_date, reason, return_type, subtotal, tax_amount, total_amount, created_by)
     VALUES ($1, $2, $3, $4, CURRENT_DATE, 'GOODWILL', 'CREDIT_ONLY', 100, 0, 100, $5)`,
    [creditNoteId, `CNTEST-SCN-${randomUUID().slice(0, 8)}`, invoiceId, customerId, creatorId]
  );
  created.creditNoteIds.push(creditNoteId);

  // DRAFT cannot be posted.
  await assert.rejects(
    () => creditNotes.postSalesCreditNote(creditNoteId, creatorId),
    /only an APPROVED credit note can be posted/
  );

  // Submit -> PENDING_APPROVAL.
  const submitted = await creditNotes.submitCreditNoteForApproval(creditNoteId, creatorId);
  assert.equal(submitted.status, 'PENDING_APPROVAL');

  // Re-submitting a non-DRAFT note is refused.
  await assert.rejects(
    () => creditNotes.submitCreditNoteForApproval(creditNoteId, creatorId),
    /only a DRAFT can be submitted/
  );

  // PENDING_APPROVAL still cannot be posted.
  await assert.rejects(
    () => creditNotes.postSalesCreditNote(creditNoteId, creatorId),
    /only an APPROVED credit note can be posted/
  );
});

test('credit note approval: SoD blocks the creator from approving their own note; a distinct approver succeeds', async (t) => {
  if (!dbAvailable) return t.skip('no database available');
  if (!creditNoteId) return t.skip('depends on the previous test creating a PENDING_APPROVAL note');

  const { checkSoD } = require('../middleware/rbac');
  const { recordCreator } = require('../middleware/recordOwner');
  const getCreator = recordCreator('sales_credit_notes');
  const ownerId = await getCreator({ params: { id: creditNoteId } });
  assert.equal(ownerId, creatorId, 'recordCreator must resolve the note\'s actual creator, for the SoD guard to check against');

  assert.throws(() => checkSoD(ownerId, creatorId, 'credit note approval'), /Segregation of duties/);

  const approved = await creditNotes.approveCreditNote(creditNoteId, approverId);
  assert.equal(approved.status, 'APPROVED');
  assert.equal(approved.approved_by, approverId);
});

test('credit note approval: posting an APPROVED note succeeds and the journal entry has the correct created_by', async (t) => {
  if (!dbAvailable) return t.skip('no database available');
  if (!creditNoteId) return t.skip('depends on the previous tests reaching APPROVED');

  const outcome = await creditNotes.postSalesCreditNote(creditNoteId, approverId);
  assert.equal(outcome.data.status, 'POSTED');

  const { rows: [entry] } = await pool.query(
    "SELECT id, created_by, status FROM journal_entries WHERE source_type = 'SALES_CREDIT_NOTE' AND source_id = $1",
    [creditNoteId]
  );
  assert.ok(entry, 'expected a journal entry to have been created for the posted credit note');
  assert.equal(entry.created_by, approverId, 'created_by must be the actual poster, not undefined (the user.id bug)');
  assert.equal(entry.status, 'POSTED');

  // Idempotent: posting again is a no-op, not an error.
  const again = await creditNotes.postSalesCreditNote(creditNoteId, approverId);
  assert.equal(again.note, 'Already posted.');
});
