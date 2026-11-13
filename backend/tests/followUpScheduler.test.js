// Regression test for stage-timer follow-up auto-scheduling
// (PHASE3_TEN_TENTHS_PROMPT.md CRM item 3, "Follow-ups: task/activity
// auto-scheduling from ... stage timers"):
//
//   Deals.findAll already computed last_activity_at, so staleness was
//   visible on the pipeline board, but nothing ever acted on it — no
//   cron/scheduled-task/agent created a follow-up when a deal went quiet.
//   services/crm/followUpScheduler.js closes that: a deal past the
//   stale-days threshold with no open auto-scheduled task gets one.
//
// Run on its own:  node --test --test-concurrency=1 tests/followUpScheduler.test.js

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { pool } = require('../config/database');
const companyContext = require('../services/companyContext');
const { Deals } = require('../models/Crm');
const { scheduleStaleDealFollowUps, AUTO_FOLLOW_UP_MARKER } = require('../services/crm/followUpScheduler');

let dbAvailable = false;
let userId = null;
let companyId = null;
const created = { dealIds: [] };

before(async () => {
  try {
    await pool.query('SELECT 1');
    const users = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
    if (!users.rows.length) throw new Error('no users');
    userId = users.rows[0].id;
    companyId = await companyContext.getDefaultCompanyId();
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  if (dbAvailable) {
    for (const id of created.dealIds) {
      await pool.query('DELETE FROM activities WHERE deal_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM deal_stage_history WHERE deal_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM deals WHERE id = $1', [id]).catch(() => {});
    }
  }
  await pool.end().catch(() => {});
});

async function backdateDeal(dealId, daysAgo) {
  await pool.query(`UPDATE deals SET created_at = CURRENT_TIMESTAMP - ($1 || ' days')::interval WHERE id = $2`, [daysAgo, dealId]);
}

test('a deal with no activity past the stale threshold gets an auto-scheduled follow-up task', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const deal = await Deals.create({ title: 'Stale deal — no follow up', value: 3000, owner_id: userId }, userId);
  created.dealIds.push(deal.id);
  await backdateDeal(deal.id, 10);

  const result = await scheduleStaleDealFollowUps({ staleDays: 7 }, companyId);
  const match = result.scheduled.find((s) => s.deal_id === deal.id);
  assert.ok(match, 'expected the stale deal to get a scheduled follow-up');
  assert.equal(match.days_stale >= 9, true);

  const { rows: tasks } = await pool.query(
    "SELECT * FROM activities WHERE deal_id = $1 AND activity_type = 'TASK'", [deal.id]
  );
  assert.equal(tasks.length, 1);
  assert.ok(tasks[0].subject.startsWith(AUTO_FOLLOW_UP_MARKER));
  assert.equal(tasks[0].completed_at, null);
  assert.equal(tasks[0].owner_id, userId);
});

test('running the scheduler again does not create a duplicate task for the same deal', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const deal = await Deals.create({ title: 'Stale deal — no duplicate', value: 1000, owner_id: userId }, userId);
  created.dealIds.push(deal.id);
  await backdateDeal(deal.id, 10);

  await scheduleStaleDealFollowUps({ staleDays: 7 }, companyId);
  const second = await scheduleStaleDealFollowUps({ staleDays: 7 }, companyId);
  assert.equal(second.scheduled.some((s) => s.deal_id === deal.id), false);

  const { rows: tasks } = await pool.query(
    "SELECT * FROM activities WHERE deal_id = $1 AND activity_type = 'TASK'", [deal.id]
  );
  assert.equal(tasks.length, 1);
});

test('a deal with recent activity is not considered stale', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const deal = await Deals.create({ title: 'Fresh deal', value: 2000, owner_id: userId }, userId);
  created.dealIds.push(deal.id);
  await backdateDeal(deal.id, 20);
  // A NOTE logged today counts as the most recent activity.
  await pool.query(
    `INSERT INTO activities (activity_type, subject, deal_id, owner_id, created_by, completed_at)
     VALUES ('NOTE', 'Talked to the customer today', $1, $2, $2, CURRENT_TIMESTAMP)`,
    [deal.id, userId]
  );

  const result = await scheduleStaleDealFollowUps({ staleDays: 7 }, companyId);
  assert.equal(result.scheduled.some((s) => s.deal_id === deal.id), false);
});

test('a WON deal is never scheduled a follow-up regardless of staleness', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const deal = await Deals.create({ title: 'Old won deal', value: 4000, owner_id: userId }, userId);
  created.dealIds.push(deal.id);
  await Deals.moveStage(deal.id, 'WON', {}, userId);
  await backdateDeal(deal.id, 30);

  const result = await scheduleStaleDealFollowUps({ staleDays: 7 }, companyId);
  assert.equal(result.scheduled.some((s) => s.deal_id === deal.id), false);
});
