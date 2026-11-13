// Fixed asset disposal and revaluation — the two lifecycle paths that had
// real code (models/FixedAsset.js dispose()/revalue(), IAS 16/36 gain-loss and
// surplus/impairment splitting) but ZERO test coverage before this suite.
//
// Reading the code for the Fixed Assets §29 re-evaluation found a live bug in
// revalue(): migration 113 tried to seed a dedicated 'Revaluation Surplus'
// equity account at code 3200, but 3200 was already 'Retained Earnings' in
// every company's chart of accounts (models/ChartOfAccounts.js's
// STANDARD_ACCOUNTS), so the INSERT ... WHERE NOT EXISTS silently skipped it.
// FixedAsset.revalue() posted every upward revaluation straight into Retained
// Earnings instead — commingling an unrealized IAS 16 reserve with realized,
// distributable profit. A second, separate bug: account 5850 (Impairment Loss
// on Assets) was never added to STANDARD_ACCOUNTS, so any company created
// after the original default (i.e. every real signup) had no 5850 at all —
// any downward revaluation exceeding an asset's own prior surplus hard-failed.
//
// Fixed by migration 202608160100_fix_revaluation_surplus_account.sql (new
// code 3210 for Revaluation Surplus, backfilled to every existing company;
// 5850 backfilled too) plus models/FixedAsset.js now posting to 3210, and
// models/ChartOfAccounts.js's STANDARD_ACCOUNTS carrying both codes for every
// future signup. This suite proves both the disposal/revaluation math AND
// that the equity leg lands on the correct account, not Retained Earnings.
//
// Run on its own:  node --test tests/fixedAssetLifecycle.test.js

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');

const { pool } = require('../config/database');
const FixedAsset = require('../models/FixedAsset');

let dbAvailable = false;
let userId = null;
let balanceSnapshot = null;
const created = { assetIds: [], journalEntryIds: [] };

async function makeAsset(overrides = {}) {
  const asset = await FixedAsset.create({
    name: 'Lifecycle probe',
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
      const revals = await pool.query(
        'SELECT journal_entry_id FROM fixed_asset_revaluations WHERE asset_id = $1', [id]
      ).catch(() => ({ rows: [] }));
      revals.rows.forEach((r) => created.journalEntryIds.push(r.journal_entry_id));
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

test('upward revaluation credits the dedicated Revaluation Surplus account, not Retained Earnings', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const asset = await makeAsset();
  // Carrying amount is 10000 (no depreciation yet); revalue up by 2000.
  const result = await FixedAsset.revalue(asset.id, { revalued_amount: 12000, basis: 'market appraisal' }, userId);

  assert.equal(result.revaluation.adjustment, 2000);
  assert.equal(result.revaluation.to_equity, 2000);
  assert.equal(result.revaluation.to_profit_or_loss, 0);
  assert.equal(Number(result.acquisition_cost), 12000, 'gross carrying amount increases by the adjustment');

  const { rows } = await pool.query(
    `SELECT coa.account_code, jei.debit_amount::float d, jei.credit_amount::float c
       FROM journal_entry_items jei
       JOIN chart_of_accounts coa ON coa.id = jei.account_id
      WHERE jei.journal_entry_id = $1
      ORDER BY coa.account_code`,
    [result.revaluation.journal_entry_id]
  );
  const surplusLeg = rows.find((r) => r.account_code === '3210');
  const retainedEarningsLeg = rows.find((r) => r.account_code === '3200');
  assert.ok(surplusLeg, 'the equity leg must land on 3210 (Revaluation Surplus)');
  assert.equal(surplusLeg.c, 2000);
  assert.equal(retainedEarningsLeg, undefined, 'must NOT touch 3200 (Retained Earnings) — that was the bug');

  const dr = rows.reduce((s, r) => s + r.d, 0);
  const cr = rows.reduce((s, r) => s + r.c, 0);
  assert.equal(dr, cr, 'the revaluation entry must balance');
});

test('a decrease beyond prior surplus splits between equity reversal and impairment expense (5850)', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const asset = await makeAsset();
  await FixedAsset.revalue(asset.id, { revalued_amount: 12000, basis: 'up first' }, userId);
  const down = await FixedAsset.revalue(asset.id, { revalued_amount: 3000, basis: 'impairment' }, userId);

  // Carrying was 12000; new value 3000; adjustment -9000.
  // 2000 of it reverses the surplus just created, the remaining 7000 is impairment.
  assert.equal(down.revaluation.adjustment, -9000);
  assert.equal(down.revaluation.to_equity, -2000);
  assert.equal(down.revaluation.to_profit_or_loss, -7000);

  const { rows } = await pool.query(
    `SELECT coa.account_code, jei.debit_amount::float d, jei.credit_amount::float c
       FROM journal_entry_items jei
       JOIN chart_of_accounts coa ON coa.id = jei.account_id
      WHERE jei.journal_entry_id = $1
      ORDER BY coa.account_code`,
    [down.revaluation.journal_entry_id]
  );
  const impairment = rows.find((r) => r.account_code === '5850');
  assert.ok(impairment, 'the impairment leg must post to 5850 (Impairment Loss on Assets)');
  assert.equal(impairment.d, 7000);

  const surplusReversal = rows.find((r) => r.account_code === '3210');
  assert.ok(surplusReversal, 'the surplus reversal must post to 3210');
  assert.equal(surplusReversal.d, 2000);

  const dr = rows.reduce((s, r) => s + r.d, 0);
  const cr = rows.reduce((s, r) => s + r.c, 0);
  assert.equal(dr, cr, 'the impairment entry must balance');
});

test('revaluation history tracks net surplus/impairment across multiple entries', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const asset = await makeAsset();
  await FixedAsset.revalue(asset.id, { revalued_amount: 12000 }, userId);
  await FixedAsset.revalue(asset.id, { revalued_amount: 3000 }, userId);

  const history = await FixedAsset.revaluationHistory(asset.id);
  assert.equal(history.length, 2);
  assert.equal(history[0].method, 'IMPAIRMENT');
  assert.equal(history[1].method, 'REVALUATION');
});

test('disposal at a gain posts proceeds, removes cost/accumulated depreciation, and credits Gain on Disposal (4900)', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const asset = await makeAsset({ depreciation_method: 'STRAIGHT_LINE' });
  const dep = await FixedAsset.runDepreciation(asset.id, userId, '2026-02-15', 1);
  assert.equal(dep.amount, 150);

  // Book value after one month: 10000 - 150 = 9850. Sell for 11000 -> gain 1150.
  const disposed = await FixedAsset.dispose(asset.id, userId, 'sold to third party', 11000, '1110');

  assert.equal(disposed.status, 'DISPOSED');
  assert.equal(disposed.disposal.book_value, 9850);
  assert.equal(disposed.disposal.proceeds, 11000);
  assert.equal(disposed.disposal.gain, 1150);
  assert.equal(disposed.disposal.loss, 0);

  const { rows } = await pool.query(
    `SELECT coa.account_code, jei.debit_amount::float d, jei.credit_amount::float c
       FROM journal_entry_items jei
       JOIN chart_of_accounts coa ON coa.id = jei.account_id
      WHERE jei.journal_entry_id = $1
      ORDER BY coa.account_code`,
    [disposed.disposal.journal_entry_id]
  );
  const cash = rows.find((r) => r.account_code === '1110');
  const accum = rows.find((r) => r.account_code === '1220');
  const cost = rows.find((r) => r.account_code === '1210');
  const gain = rows.find((r) => r.account_code === '4900');
  assert.equal(cash.d, 11000, 'proceeds debit cash');
  assert.equal(accum.d, 150, 'accumulated depreciation is removed');
  assert.equal(cost.c, 10000, 'the full original cost is removed from PP&E');
  assert.equal(gain.c, 1150, 'the gain credits Gain on Disposal');

  const dr = rows.reduce((s, r) => s + r.d, 0);
  const cr = rows.reduce((s, r) => s + r.c, 0);
  assert.equal(dr, cr, 'the disposal entry must balance');
});

test('disposal at a loss (no proceeds) credits PP&E for the full cost and debits Loss on Disposal (5900)', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const asset = await makeAsset({ depreciation_method: 'STRAIGHT_LINE' });
  await FixedAsset.runDepreciation(asset.id, userId, '2026-02-15', 1);

  // Book value 9850, scrapped for nothing -> full book value is a loss.
  const disposed = await FixedAsset.dispose(asset.id, userId, 'scrapped', 0, '1110');

  assert.equal(disposed.disposal.proceeds, 0);
  assert.equal(disposed.disposal.loss, 9850);
  assert.equal(disposed.disposal.gain, 0);

  const { rows } = await pool.query(
    `SELECT coa.account_code, jei.debit_amount::float d, jei.credit_amount::float c
       FROM journal_entry_items jei
       JOIN chart_of_accounts coa ON coa.id = jei.account_id
      WHERE jei.journal_entry_id = $1
      ORDER BY coa.account_code`,
    [disposed.disposal.journal_entry_id]
  );
  const loss = rows.find((r) => r.account_code === '5900');
  const cash = rows.find((r) => r.account_code === '1110');
  assert.ok(loss, 'a scrapped asset must post a loss line');
  assert.equal(loss.d, 9850);
  assert.equal(cash, undefined, 'no proceeds means no cash leg at all');

  const dr = rows.reduce((s, r) => s + r.d, 0);
  const cr = rows.reduce((s, r) => s + r.c, 0);
  assert.equal(dr, cr, 'the disposal entry must balance');
});

test('a disposed asset cannot be disposed again or revalued', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const asset = await makeAsset();
  await FixedAsset.dispose(asset.id, userId, 'scrapped', 0, '1110');

  await assert.rejects(
    () => FixedAsset.dispose(asset.id, userId, 'again', 0, '1110'),
    /already disposed/,
  );
  await assert.rejects(
    () => FixedAsset.revalue(asset.id, { revalued_amount: 5000 }, userId),
    /disposed asset cannot be revalued/,
  );
});
