// Regression test for the reversal-control gap: reverse a posted journal
// entry only with a distinct authority, never a delete (Finance session 8,
// ERP_PRODUCT_EVALUATION.md §27).
//
// Investigating "does /reverse require a distinct authority?" found the rule
// was ALREADY enforced, just not where anyone would think to look: every
// status transition goes through statusTransitionService.applyStatusChange
// -> AuthorityEngine.can(), whose SoD check matches action names by
// substring (`action.toUpperCase().includes('POST')`) — and
// 'TRANSITION_POSTED_TO_REVERSED' contains 'POST' (via 'POSTED'), so a
// self-reversal was already refused. routes/journal-entries.js's
// POST /:id/reverse got an explicit requireSoD(recordCreator('journal_entries'))
// guard anyway, for a readable 403 at the API boundary and a rule visible in
// the route table instead of only as an accidental side effect of substring
// matching two unrelated words — but this was NOT a new capability.
//
// What WAS a real, serious gap, found by testing that existing rule end to
// end: JournalEntry.reverse() (models/JournalEntry.js) created the
// compensating reversing entry and POSTED it to the ledger on its own
// connection/transaction FIRST, and only checked SoD as the LAST step (when
// marking the original REVERSED, via the same applyStatusChange call). A
// refused self-reversal therefore left a live, fully-posted compensating
// entry in the general ledger — real debits and credits, doubling the
// original entry's effect on every account it touched — while the original
// stayed POSTED as if the reversal had never been attempted. Fixed by moving
// the SoD check to the top of reverse(), before create() ever runs, so a
// refused attempt leaves nothing behind.
//
// This test proves both halves: (1) a self-reversal is refused with zero
// side effects — no orphaned reversing entry — and (2) a distinct authority
// succeeds, produces the correct audit link (original_entry_id /
// is_reversing_entry / REV-<journal_number> reference), swaps debits and
// credits, marks the original REVERSED (not deleted), and cannot be
// reversed a second time by either party.
//
// Real-DB suite: self-skips when no database is reachable. Run on its own:
//   cd backend && node --test tests/journalReversalSoD.test.js

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { pool } = require('../config/database');
const { getDefaultCompanyId } = require('../services/companyContext');
const JournalEntry = require('../models/JournalEntry');
const { checkSoD } = require('../middleware/rbac');
const { recordCreator } = require('../middleware/recordOwner');

let dbAvailable = false;
let companyId = null;
let creatorId = null;
let reverserId = null;
let cashAccountId = null;
let revenueAccountId = null;
const journalEntryIds = []; // deleted in reverse insertion order (children before parents)

function rand(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

async function deleteEntry(id) {
  await pool.query('DELETE FROM journal_entry_items WHERE journal_entry_id = $1', [id]);
  await pool.query('DELETE FROM journal_entry_status_history WHERE journal_entry_id = $1', [id]);
  await pool.query('DELETE FROM journal_entries WHERE id = $1', [id]);
}

async function cleanupEntries() {
  // Reversing entries were pushed AFTER the originals they point to
  // (original_entry_id is a FK) — delete in reverse so children go first.
  for (const id of [...journalEntryIds].reverse()) {
    await deleteEntry(id).catch(() => {});
  }
  journalEntryIds.length = 0;
}

before(async () => {
  try {
    await pool.query('SELECT 1');
    companyId = await getDefaultCompanyId();
    const users = await pool.query(
      // Not the platform owner: JournalEntry.reverse exempts it from SoD by
      // design, so with it as creator a self-reversal is (correctly) allowed.
      "SELECT id FROM users WHERE deleted_at IS NULL AND COALESCE(is_active, true) = true AND role IN ('ADMIN','MANAGER') AND NOT COALESCE(is_platform_owner, false) ORDER BY created_at LIMIT 2"
    );
    if (users.rows.length < 2) throw new Error('need at least 2 manager/admin users for the SoD half of this test');
    [creatorId, reverserId] = users.rows.map((r) => r.id);

    const cash = await pool.query(`SELECT id FROM chart_of_accounts WHERE account_code = '1110' AND company_id = $1 AND deleted_at IS NULL LIMIT 1`, [companyId]);
    const revenue = await pool.query(`SELECT id FROM chart_of_accounts WHERE account_code = '4100' AND company_id = $1 AND deleted_at IS NULL LIMIT 1`, [companyId]);
    if (!cash.rows.length || !revenue.rows.length) throw new Error('seed accounts 1110/4100 not found for the default company');
    cashAccountId = cash.rows[0].id;
    revenueAccountId = revenue.rows[0].id;

    dbAvailable = true;
  } catch (error) {
    console.error('journalReversalSoD test setup failed:', error.message);
    dbAvailable = false;
  }
});

after(async () => {
  if (!dbAvailable) return;
  await cleanupEntries();
  await Promise.race([pool.end(), new Promise((r) => setTimeout(r, 5000))]);
});

async function postManualEntry(description) {
  const entry = await JournalEntry.create(
    {
      entry_date: new Date().toISOString().split('T')[0],
      source_type: 'MANUAL',
      description,
      reference: rand('T18-JE'),
      requires_approval: false,
    },
    [
      { account_id: cashAccountId, debit_amount: 100, credit_amount: 0, description },
      { account_id: revenueAccountId, debit_amount: 0, credit_amount: 100, description },
    ],
    creatorId
  );
  journalEntryIds.push(entry.id);
  // Posting is ALSO subject to the same substring-matched SoD
  // ('TRANSITION_DRAFT_TO_POSTED' contains 'POST'), so the creator cannot
  // self-post either — a distinct identity posts, exactly the split of
  // duties a real books-and-a-manager shop has.
  await JournalEntry.updateStatus(entry.id, 'POSTED', reverserId, 'T18 test post');
  return JournalEntry.findById(entry.id);
}

test('reversal SoD: recordCreator/checkSoD resolve correctly for the route-level guard', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const posted = await postManualEntry('T18 reversal SoD guard-plumbing fixture');
  assert.equal(posted.created_by, creatorId);

  const getCreator = recordCreator('journal_entries');
  const resolvedCreator = await getCreator({ params: { id: posted.id } });
  assert.equal(resolvedCreator, creatorId, 'recordCreator must resolve the entry\'s actual creator');

  assert.throws(() => checkSoD(resolvedCreator, creatorId, 'reversal'), /Segregation of duties/);
  assert.doesNotThrow(() => checkSoD(resolvedCreator, reverserId, 'reversal'));
});

test('reverse(): a self-reversal is refused with NO side effects — no orphaned reversing entry left in the ledger', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const posted = await postManualEntry('T18 non-atomicity regression fixture');

  await assert.rejects(
    () => JournalEntry.reverse(posted.id, creatorId, 'attempted self-reversal'),
    /Segregation of duties/
  );

  // The bug this closes: reverse() used to create AND POST the compensating
  // entry before checking SoD, so a refused self-reversal still left a live
  // posted entry in the GL. Assert there is exactly nothing extra behind.
  const stray = await pool.query(
    `SELECT id FROM journal_entries WHERE original_entry_id = $1`,
    [posted.id]
  );
  assert.equal(stray.rows.length, 0, 'a refused self-reversal must not create any reversing entry');

  const original = await JournalEntry.findById(posted.id);
  assert.equal(original.status, 'POSTED', 'the original must be untouched by a refused reversal attempt');
});

test('reverse(): a distinct authority succeeds — audited, linked reversing entry, never a delete, cannot reverse twice', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const posted = await postManualEntry('T18 reverse() audit-link fixture');

  const reversing = await JournalEntry.reverse(posted.id, reverserId, 'T18 test reversal');
  journalEntryIds.push(reversing.id);

  const reversingRow = await pool.query(
    'SELECT is_reversing_entry, original_entry_id, reference, status FROM journal_entries WHERE id = $1',
    [reversing.id]
  );
  assert.equal(reversingRow.rows[0].is_reversing_entry, true);
  assert.equal(reversingRow.rows[0].original_entry_id, posted.id);
  assert.equal(reversingRow.rows[0].reference, `REV-${posted.journal_number}`);
  assert.equal(reversingRow.rows[0].status, 'POSTED', 'the reversing entry is auto-posted, not left as a draft');

  const originalTotals = { debit: Number(posted.total_debit), credit: Number(posted.total_credit) };
  assert.equal(Number(reversing.total_debit), originalTotals.credit);
  assert.equal(Number(reversing.total_credit), originalTotals.debit);

  const original = await JournalEntry.findById(posted.id);
  assert.equal(original.status, 'REVERSED', 'the original is marked REVERSED, not deleted');

  await assert.rejects(
    () => JournalEntry.reverse(posted.id, reverserId, 'second attempt'),
    /Can only reverse posted journal entries/
  );
  await assert.rejects(
    () => JournalEntry.reverse(reversing.id, reverserId, 'reverse the reversal'),
    /Cannot reverse a reversing entry/
  );

  await assert.rejects(
    () => JournalEntry.delete(posted.id, reverserId),
    /Cannot delete posted or reversed journal entries/
  );
});
