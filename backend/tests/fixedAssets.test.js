// Fixed asset register: depreciation methods, GL posting and the transaction
// boundary around them.
//
// The bug these exist for: FixedAsset.runDepreciation read every asset's
// `depreciation_method` and then charged straight-line regardless. Nothing in
// the resulting numbers says so — a declining-balance asset simply depreciates
// on the wrong curve for its entire life, and the only way to notice is to
// recompute it by hand. So the assertions below are on the actual posted
// amounts per method, not on "some depreciation happened".
//
// The second test is the transaction-boundary regression this codebase keeps
// re-introducing: the journal entry used to be posted on the pool before the
// asset register was updated on a separate connection, so a failure in the
// update left a POSTED depreciation entry with no depreciation row behind it.
//
// Run on its own:  npm run test:fixed-assets

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');

const { pool } = require('../config/database');
const FixedAsset = require('../models/FixedAsset');

let dbAvailable = false;
let userId = null;
// Posting moves chart_of_accounts.current_balance additively, and deleting the
// journal entry does not undo it — restored wholesale in after() so the suite
// does not leave db:verify's account-balance-cache invariant failing.
let balanceSnapshot = null;
const created = { assetIds: [], journalEntryIds: [] };

async function makeAsset(overrides = {}) {
  const asset = await FixedAsset.create({
    name: 'Depreciation probe',
    category: 'TEST',
    acquisition_date: '2026-01-15',
    acquisition_cost: 10000,
    salvage_value: 1000,
    useful_life_years: 5,
    ...overrides,
  }, userId);
  created.assetIds.push(asset.id);
  return asset;
}

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
  }
  if (balanceSnapshot) {
    for (const row of balanceSnapshot) {
      await pool.query('UPDATE chart_of_accounts SET current_balance = $2 WHERE id = $1',
        [row.id, row.current_balance]).catch(() => {});
    }
  }
  await pool.end();
});

test('each method charges its own curve, not straight-line', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  // Same asset in every respect except the method, so any difference in the
  // charge is the method and nothing else. Cost 10000, salvage 1000, 5 years:
  //   straight-line     (10000-1000)/60            = 150.00
  //   declining 150%    10000 * 1.5/60             = 250.00
  //   double declining  10000 * 2/60               = 333.33
  //   sum-of-years      9000 * (5/15) / 12         = 250.00
  const expected = {
    STRAIGHT_LINE: 150,
    DECLINING_BALANCE: 250,
    DOUBLE_DECLINING: 333.33,
    SUM_OF_YEARS_DIGITS: 250,
  };

  for (const [method, amount] of Object.entries(expected)) {
    const asset = await makeAsset({ depreciation_method: method });
    const result = await FixedAsset.runDepreciation(asset.id, userId, '2026-02-15', 1);

    assert.equal(result.amount, amount, `${method} should charge ${amount}, got ${result.amount}`);
    assert.equal(result.method, method);
    assert.equal(result.accumulated_after, amount);
    assert.equal(result.book_value_after, 10000 - amount);
  }
});

test('declining balance is charged on book value and posts a balanced entry', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const asset = await makeAsset({ depreciation_method: 'DOUBLE_DECLINING' });

  const first = await FixedAsset.runDepreciation(asset.id, userId, '2026-02-15', 1);
  assert.equal(first.amount, 333.33);

  // The second month is charged on the REDUCED book value — the defining
  // property of the method, and exactly what a straight-line fallback loses.
  const second = await FixedAsset.runDepreciation(asset.id, userId, '2026-03-15', 1);
  assert.equal(second.amount, 322.22);
  assert.ok(second.amount < first.amount, 'declining balance must decline');

  // Dr 5260 Depreciation Expense / Cr 1220 Accumulated Depreciation.
  const { rows } = await pool.query(
    `SELECT coa.account_code, jei.debit_amount::float d, jei.credit_amount::float c, je.status
       FROM journal_entry_items jei
       JOIN journal_entries je ON je.id = jei.journal_entry_id
       JOIN chart_of_accounts coa ON coa.id = jei.account_id
      WHERE jei.journal_entry_id = $1
      ORDER BY coa.account_code`,
    [second.journal_entry_id]
  );
  assert.equal(rows.length, 2, 'depreciation posts exactly two lines');
  assert.equal(rows[0].status, 'POSTED');

  const debit = rows.find((r) => r.d > 0);
  const credit = rows.find((r) => r.c > 0);
  assert.equal(debit.account_code, '5260', 'depreciation expense is the debit');
  assert.equal(credit.account_code, '1220', 'accumulated depreciation is the credit');
  assert.equal(debit.d, second.amount);
  assert.equal(credit.c, second.amount);
});

test('an asset registered with an unknown method is rejected', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  await assert.rejects(
    () => makeAsset({ depreciation_method: 'MACRS' }),
    /Unknown depreciation method/,
    'an unchargeable method must fail at registration, not at the period close'
  );
});

test('a failure after posting leaves no orphaned depreciation entry', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const asset = await makeAsset({ depreciation_method: 'STRAIGHT_LINE' });

  const before = await pool.query(
    "SELECT COUNT(*)::int n FROM journal_entries WHERE source_type = 'DEPRECIATION' AND deleted_at IS NULL"
  );

  // Break the step that runs after the journal entry is posted, inside the
  // same transaction. The real posting code still executes.
  const JournalEntry = require('../models/JournalEntry');
  const original = JournalEntry.updateStatus;
  JournalEntry.updateStatus = async (...args) => {
    await original.apply(JournalEntry, args);
    throw new Error('injected failure after GL post');
  };

  let threw = false;
  try {
    await FixedAsset.runDepreciation(asset.id, userId, '2026-02-15', 1);
  } catch (err) {
    threw = true;
    assert.match(err.message, /injected failure/);
  } finally {
    JournalEntry.updateStatus = original;
  }

  assert.ok(threw, 'the injected failure should propagate');

  const after = await pool.query(
    "SELECT COUNT(*)::int n FROM journal_entries WHERE source_type = 'DEPRECIATION' AND deleted_at IS NULL"
  );
  assert.equal(after.rows[0].n, before.rows[0].n,
    'a rolled-back depreciation run must not leave a journal entry in the ledger');

  const asset2 = await pool.query('SELECT accumulated_depreciation::float a FROM fixed_assets WHERE id = $1', [asset.id]);
  assert.equal(asset2.rows[0].a, 0, 'and the asset register must be untouched');
});

test('the projected schedule matches what posting actually charges', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const asset = await makeAsset({ depreciation_method: 'DOUBLE_DECLINING' });
  const projected = await FixedAsset.schedule(asset.id);

  // A forecast that disagrees with the posting path is worse than no forecast:
  // it is used to plan, and nothing reconciles it afterwards.
  assert.ok(projected.periods.length > 0);
  assert.equal(projected.periods[0].depreciation_amount, 333.33);

  const posted = await FixedAsset.runDepreciation(asset.id, userId, projected.periods[0].period_date, 1);
  assert.equal(posted.amount, projected.periods[0].depreciation_amount);
  assert.equal(posted.accumulated_after, projected.periods[0].accumulated_after);

  // Declining balance switches to straight-line so the asset finishes: the
  // projection must land exactly on the depreciable base.
  assert.equal(projected.total_projected, 9000);
});
