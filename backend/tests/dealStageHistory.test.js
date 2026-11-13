// Regression test for the CRM pipeline gap found in the audit
// (PHASE3_TEN_TENTHS_PROMPT.md item 3: "stage history"):
//
//   Every other stateful entity in this codebase (PO, PR, credit notes, work
//   orders...) has a *_status_history table. deals.stage changed with no
//   record of when or by whom — there was no way to answer "how long did
//   this deal sit in PROPOSAL" or "who moved it." deal_stage_history
//   (migration 202608140100) plus Deals.create/moveStage now write one row
//   per transition, and Deals.findById returns the full trail.
//
// Run on its own:  cd backend && node --test tests/dealStageHistory.test.js

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');

const { pool } = require('../config/database');
const { Deals } = require('../models/Crm');

let dbAvailable = false;
let userId = null;
const created = { dealIds: [] };

before(async () => {
  try {
    await pool.query('SELECT 1');
    const users = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
    if (!users.rows.length) throw new Error('no users');
    userId = users.rows[0].id;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  if (dbAvailable) {
    for (const id of created.dealIds) {
      await pool.query('DELETE FROM deal_stage_history WHERE deal_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM deals WHERE id = $1', [id]).catch(() => {});
    }
  }
  await pool.end().catch(() => {});
});

test('deal creation writes an initial stage-history row', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const deal = await Deals.create({ title: 'Stage history test deal', value: 5000 }, userId);
  created.dealIds.push(deal.id);

  const history = await Deals.stageHistory(deal.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].from_stage, null);
  assert.equal(history[0].to_stage, 'NEW');
  assert.equal(history[0].changed_by, userId);
});

test('moving a deal through stages accumulates a full, ordered trail, and findById returns it', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const deal = await Deals.create({ title: 'Stage history trail test', value: 8000 }, userId);
  created.dealIds.push(deal.id);

  await Deals.moveStage(deal.id, 'QUALIFIED', {}, userId);
  await Deals.moveStage(deal.id, 'PROPOSAL', {}, userId);
  await Deals.moveStage(deal.id, 'NEGOTIATION', {}, userId);
  await Deals.moveStage(deal.id, 'LOST', { lost_reason: 'Went with a competitor' }, userId);

  const history = await Deals.stageHistory(deal.id);
  assert.deepEqual(history.map((h) => h.to_stage), ['NEW', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'LOST']);
  assert.deepEqual(history.map((h) => h.from_stage), [null, 'NEW', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION']);
  // Ordered oldest-first, so "how long did it sit in PROPOSAL" is a diff of adjacent rows.
  for (let i = 1; i < history.length; i++) {
    assert.ok(new Date(history[i].changed_at) >= new Date(history[i - 1].changed_at));
  }
  const lostRow = history[history.length - 1];
  assert.equal(lostRow.reason, 'Went with a competitor');

  const found = await Deals.findById(deal.id);
  assert.ok(Array.isArray(found.stage_history));
  assert.equal(found.stage_history.length, 5);
  assert.equal(found.stage_history[found.stage_history.length - 1].to_stage, 'LOST');
});
