// Depreciation posting authority regression (ERP_PRODUCT_EVALUATION.md blocker #4).
//
// The bug: FixedAsset.runDepreciation created the journal entry with the
// triggering user as creator AND posted it with the SAME user id. The unified
// status-transition path (statusTransitionService -> authority.js) enforces
// segregation of duties — checkSoD refuses creator == poster — so any run by a
// non-platform-owner user always rolled back: depreciation could never reach
// POSTED.
//
// The fix under test: the run resolves a distinct posting authority — the
// platform owner (PLATFORM_OWNER_EMAIL, else the claimed is_platform_owner
// account; the same precedence services/platformOwner.js honors) — and records
// that identity as posted_by, while the triggering user stays recorded as
// creator/initiator in the audit trail. A normal manager therefore can never
// self-post their own depreciation run, and the entry actually reaches POSTED.
//
// Run on its own:  node --test tests/depreciationRegression.test.js
// (do NOT run the full suite concurrently with other workers in the same DB)

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');

const { pool } = require('../config/database');
const FixedAsset = require('../models/FixedAsset');
const JournalEntry = require('../models/JournalEntry');

let dbAvailable = false;
let owner = null;   // designated platform owner — the system posting identity
let runner = null;  // a normal MANAGER who triggers the run — must NOT self-post
let savedOwnerEmail = undefined;
let balanceSnapshot = null;

const created = { assetIds: [], journalEntryIds: [] };
const cleanupUserIds = [];

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

    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const ownerRes = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role, is_active)
       VALUES ($1, $2, 'Depr', 'Owner', 'ADMIN', true) RETURNING id, email`,
      [`depr-owner-${stamp}@qira.test`, 'not-a-real-password']
    );
    owner = ownerRes.rows[0];
    cleanupUserIds.push(owner.id);

    const runnerRes = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role, is_active)
       VALUES ($1, $2, 'Depr', 'Manager', 'MANAGER', true) RETURNING id`,
      [`depr-runner-${stamp}@qira.test`, 'not-a-real-password']
    );
    runner = runnerRes.rows[0];
    cleanupUserIds.push(runner.id);

    // Designate `owner` as the platform owner via the environment override —
    // same precedence middleware/auth.js and services/platformOwner.js honor.
    savedOwnerEmail = process.env.PLATFORM_OWNER_EMAIL;
    process.env.PLATFORM_OWNER_EMAIL = owner.email;

    balanceSnapshot = (await pool.query('SELECT id, current_balance FROM chart_of_accounts')).rows;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  if (dbAvailable) {
    for (const id of created.assetIds) {
      const entries = await pool.query(
        'SELECT journal_entry_id FROM fixed_asset_depreciation WHERE asset_id = $1', [id]
      ).catch(() => ({ rows: [] }));
      entries.rows.forEach((r) => created.journalEntryIds.push(r.journal_entry_id));
      await pool.query('DELETE FROM fixed_asset_depreciation WHERE asset_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM fixed_asset_revaluations WHERE asset_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM fixed_assets WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.journalEntryIds) await purgeJournalEntry(id);
    for (const id of cleanupUserIds) await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {});
  }
  if (savedOwnerEmail !== undefined) process.env.PLATFORM_OWNER_EMAIL = savedOwnerEmail;
  else delete process.env.PLATFORM_OWNER_EMAIL;
  if (balanceSnapshot) {
    for (const row of balanceSnapshot) {
      await pool.query('UPDATE chart_of_accounts SET current_balance = $2 WHERE id = $1',
        [row.id, row.current_balance]).catch(() => {});
    }
  }
  await pool.end();
});

test('non-owner run: depreciation reaches POSTED, runner is creator, platform owner is poster', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  // The same MANAGER registers the asset and triggers the run — they must end
  // up as creator/initiator but never as the poster.
  const asset = await FixedAsset.create({
    name: 'SoD depreciation probe',
    category: 'TEST',
    acquisition_date: '2026-01-15',
    acquisition_cost: 10000,
    salvage_value: 1000,
    useful_life_years: 5,
    depreciation_method: 'STRAIGHT_LINE',
  }, runner.id);
  created.assetIds.push(asset.id);

  const result = await FixedAsset.runDepreciation(asset.id, runner.id, '2026-02-15', 1);
  assert.equal(result.amount, 150, 'straight-line: 9000 base over 60 months = 150');
  created.journalEntryIds.push(result.journal_entry_id);

  // (c) The entry must actually reach POSTED — that is the blocker.
  const { rows } = await pool.query(
    `SELECT id, status, requires_approval, created_by, posted_by
       FROM journal_entries WHERE id = $1`,
    [result.journal_entry_id]
  );
  assert.equal(rows.length, 1, 'exactly one journal entry for the run');
  const entry = rows[0];
  assert.equal(entry.status, 'POSTED', 'the depreciation entry must actually reach POSTED');

  // (a) The runner is recorded as creator.
  assert.equal(String(entry.created_by), String(runner.id), 'runner must be the creator');

  // (b) The poster is the platform-owner system identity, distinct from the runner.
  assert.equal(String(entry.posted_by), String(owner.id), 'poster must be the platform owner');
  assert.notEqual(String(entry.posted_by), String(runner.id), 'poster must be distinct from the runner');

  // The subsidiary ledger row records the same initiator.
  const dep = await pool.query(
    'SELECT created_by FROM fixed_asset_depreciation WHERE asset_id = $1', [asset.id]
  );
  assert.ok(dep.rows.length > 0, 'a fixed_asset_depreciation row must exist');
  assert.equal(String(dep.rows[0].created_by), String(runner.id), 'initiator is recorded in the subsidiary ledger');

  // Status history: creation attributed to the runner, posting to the owner.
  const history = await pool.query(
    `SELECT to_status, changed_by FROM journal_entry_status_history
      WHERE journal_entry_id = $1`, [result.journal_entry_id]
  );
  const draftRow = history.rows.find((r) => r.to_status === 'DRAFT');
  const postedRow = history.rows.find((r) => r.to_status === 'POSTED');
  assert.ok(draftRow && postedRow, 'history must contain DRAFT and POSTED transitions');
  assert.equal(String(draftRow.changed_by), String(runner.id), 'creation is attributed to the runner');
  assert.equal(String(postedRow.changed_by), String(owner.id), 'posting is attributed to the owner');
});

test('a normal manager cannot self-post an entry they created (SoD still enforced)', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const accs = await pool.query(
    `SELECT id, account_code FROM chart_of_accounts
      WHERE account_code IN ('5260','1220') AND status = 'ACTIVE' AND deleted_at IS NULL`
  );
  const map = {};
  accs.rows.forEach((a) => { map[a.account_code] = a.id; });
  if (!map['5260'] || !map['1220']) return t.skip('GL accounts 5260/1220 unavailable');

  const entry = await JournalEntry.create({
    entry_date: '2026-02-15',
    source_type: 'MANUAL',
    description: 'SoD negative control',
    requires_approval: false,
  }, [
    { account_id: map['5260'], debit_amount: 10, credit_amount: 0, description: 'control debit' },
    { account_id: map['1220'], debit_amount: 0, credit_amount: 10, description: 'control credit' },
  ], runner.id);
  created.journalEntryIds.push(entry.id);

  await assert.rejects(
    () => JournalEntry.updateStatus(entry.id, 'POSTED', runner.id, 'self-posting attempt'),
    /Segregation of duties/,
    'a non-owner user must not be able to post their own journal entry'
  );
});
