// Paused agent runs must survive a restart, and be answerable exactly once.
//
// The confirmation prompt is the control standing between the model and a
// write. It was held in a process-local Map, so a deploy discarded every run
// waiting on a human — the person clicked "Approve" on a prompt still on their
// screen and got "No pending confirmation found for this session". It also
// could not work behind more than one instance, since the resume is a separate
// HTTP request that a load balancer will eventually send to a process that
// never saw the pause.
//
// A guardrail that intermittently fails is one people learn to route around,
// so these tests cover the properties that make it trustworthy rather than the
// happy path.
//
// Run on its own:  node --test tests/agentPause.test.js

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');

const { pool } = require('../config/database');

let dbAvailable = false;

before(async () => {
  try {
    await pool.query('SELECT 1 FROM agent_paused_runs LIMIT 1');
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  await pool.end();
});

const ALICE = 'user-alice';
const BOB = 'user-bob';

async function insertPause({ id = randomUUID(), userId = ALICE, ttlMs = 600000, tools = ['create_purchase_requisition_draft'] } = {}) {
  await pool.query(
    `INSERT INTO agent_paused_runs (id, user_id, state, pending_tools, expires_at)
     VALUES ($1, $2, $3::jsonb, $4, CURRENT_TIMESTAMP + ($5 || ' milliseconds')::interval)`,
    [
      id, userId,
      JSON.stringify({
        messages: [{ role: 'user', content: 'draft a PR for the low stock item' }],
        step: 2, mode: 'accept_edits', ctx: { userId }, toolsUsed: [],
        pendingConfirm: tools.map((name) => ({ id: `call_${name}`, name, args: {} })),
      }),
      tools, String(ttlMs),
    ]
  );
  return id;
}

// Mirrors agent.js#loadPause — the claim is a DELETE ... RETURNING, which is
// what makes "resume exactly once" true rather than merely likely.
async function claim(pauseId, userId) {
  const { rows } = await pool.query(
    `DELETE FROM agent_paused_runs
      WHERE id = $1 AND expires_at > CURRENT_TIMESTAMP
        AND ($2::text IS NULL OR user_id = $2)
      RETURNING state`,
    [pauseId, userId != null ? String(userId) : null]
  );
  return rows[0]?.state || null;
}

test('a paused run outlives the process that created it', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const id = await insertPause();

  // Nothing in this test holds a reference to the run — reading it back at all
  // is the property. In the Map version there would be nothing to read.
  const state = await claim(id, ALICE);
  assert.ok(state, 'the paused run should still be there');
  assert.equal(state.step, 2, 'it resumes at the step it paused on');
  assert.equal(state.pendingConfirm.length, 1);
  assert.equal(state.messages.length, 1, 'the frozen conversation comes back intact');
});

test('a run can only be resumed once', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const id = await insertPause();

  const first = await claim(id, ALICE);
  const second = await claim(id, ALICE);

  assert.ok(first, 'the first resume should succeed');
  assert.equal(second, null,
    'the second must find nothing — otherwise a double-clicked Approve runs the tool twice');
});

test('concurrent resumes cannot both execute the tool', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  // The real shape of a double-click: two requests in flight together. A
  // read-then-delete would let both read the same pending tool calls, and both
  // would go on to create a purchase requisition.
  const id = await insertPause();

  const results = await Promise.all([
    claim(id, ALICE), claim(id, ALICE), claim(id, ALICE), claim(id, ALICE), claim(id, ALICE),
  ]);

  const winners = results.filter(Boolean);
  assert.equal(winners.length, 1, 'exactly one concurrent resume may win');
});

test('one user cannot answer another user\'s confirmation', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const id = await insertPause({ userId: ALICE });

  assert.equal(await claim(id, BOB), null, 'Bob must not be able to resume Alice\'s run');
  assert.ok(await claim(id, ALICE), 'and Alice\'s own resume must still work afterwards');
});

test('an expired pause is not resumable', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const id = await insertPause({ ttlMs: -1000 });
  assert.equal(await claim(id, ALICE), null, 'an expired confirmation must not run the tool');
});

test('pending confirmations are listable per user', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const mine = await insertPause({ userId: ALICE, tools: ['auto_reconcile_bank_account'] });
  const theirs = await insertPause({ userId: BOB });

  const { rows } = await pool.query(
    `SELECT id, pending_tools FROM agent_paused_runs
      WHERE user_id = $1 AND expires_at > CURRENT_TIMESTAMP`,
    [ALICE]
  );

  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(mine));
  assert.ok(!ids.includes(theirs), 'a user must not see confirmations put to someone else');
  assert.deepEqual(
    rows.find((r) => r.id === mine).pending_tools, ['auto_reconcile_bank_account'],
    'the tool being asked about is listed without deserialising the whole run'
  );

  await pool.query('DELETE FROM agent_paused_runs WHERE id = ANY($1::uuid[])', [[mine, theirs]]);
});

test('agent.js no longer keeps pauses in a process-local Map', () => {
  // The regression that matters: someone reintroducing an in-memory cache
  // "for speed" would restore every failure above, and no other test would
  // notice, because in a single-process test run a Map behaves identically.
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../services/ai/agent.js'), 'utf8');

  assert.ok(!/const\s+paused\s*=\s*new Map\(\)/.test(source),
    'paused runs must not be held in a process-local Map');
  assert.match(source, /agent_paused_runs/,
    'agent.js should persist paused runs to the database');
});
