// The rail each person arranges.
//
// THE CLAIM UNDER TEST
// ===========================================================================
//     Three states, all distinguishable: never decided (defaults), pinned
//     some, and pinned NOTHING on purpose. The third is the one a naive
//     design gets wrong, and getting it wrong hands somebody a rail they
//     explicitly did not ask for.
//
// Run on its own:  node --test tests/platformShellRail.test.js

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

const { pool } = require('../config/database');
const seedHelper = require('./helpers/platformSeed');
const app = require('./helpers/platformApp');
const prefs = require('../services/platform/shellPreferences');
const directory = require('../services/platform/appDirectory');

let available = false;
let seeded = null;

const SPEC = {
  key: 'rail_probe', name: 'Rail Probe', description: 'Something to pin.',
  data: {
    canonical_refs: [],
    entities: [{
      key: 'notes', label: 'Notes', singular: 'Note',
      display: { title_field: 'title' },
      fields: [{ name: 'title', label: 'Title', type: 'text', required: true }],
    }],
  },
  workflows: [],
  security: {
    roles: [{ key: 'operator', label: 'Operator', audience: 'internal',
      permissions: { notes: ['read', 'create'] }, record_scope: { notes: 'all' } }],
  },
  surfaces: [{ key: 'internal', label: 'Internal', audience: 'internal', roles: ['operator'],
    default_page: 'note_list', nav: [{ label: 'Notes', page: 'note_list' }] }],
  ui: {
    pages: [{ key: 'note_list', title: 'Notes', kind: 'list', surface: 'internal', entity: 'notes',
      layout: [{ type: 'table', entity: 'notes', fields: ['title'] }] }],
  },
  analytics: { queries: [], metrics: [] },
  automations: [],
};

before(async () => {
  available = await app.platformAvailable();
  if (!available) return;
  seeded = await seedHelper.seed();
});

after(async () => {
  if (seeded) await seedHelper.cleanup(seeded);
  await pool.end().catch(() => {});
});

const dbTest = (name, fn) => test(name, async (t) => {
  if (!available) { t.skip('no database with the platform schema'); return; }
  await fn(t);
});

dbTest('someone who has never decided gets the core applications', async () => {
  const rail = await prefs.rail(seeded.companyA.id, seeded.userA.id);
  assert.equal(rail.customised, false);
  assert.ok(rail.pinned.length > 0, 'a new person got an empty rail');
  rail.pinned.forEach((a) => assert.equal(a.kind, 'native'));
  // Applications, not keys — the shell needs a name, an icon and a route to
  // draw a plate, and a round trip per plate would be a strange way to save
  // a join.
  rail.pinned.forEach((a) => {
    assert.ok(a.name && a.route);
  });
});

dbTest('pinning NOTHING is a decision, not a blank slate', async () => {
  // The state a join table cannot express: "no rows" would mean both this and
  // "new here", and one of those two people gets the wrong rail.
  const empty = await prefs.setPins(seeded.companyA.id, seeded.userA.id, []);
  assert.equal(empty.customised, true);
  assert.deepEqual(empty.pinned, []);

  const reread = await prefs.rail(seeded.companyA.id, seeded.userA.id);
  assert.equal(reread.customised, true);
  assert.deepEqual(reread.pinned, [], 'an empty rail was quietly refilled with defaults');

  // And it is recoverable.
  const back = await prefs.reset(seeded.companyA.id, seeded.userA.id);
  assert.equal(back.customised, false);
  assert.ok(back.pinned.length > 0);
});

dbTest('anything the company runs can be pinned, in the order chosen', async () => {
  const installed = await app.deploySpec({
    companyId: seeded.companyA.id, userId: seeded.userA.id, spec: SPEC,
  });
  const built = installed.application.app_key;

  const rail = await prefs.setPins(seeded.companyA.id, seeded.userA.id, [built, 'finance']);
  assert.deepEqual(rail.pinned.map((a) => a.key), [built, 'finance'],
    'the order chosen was not the order returned');
  assert.equal(rail.pinned[0].kind, 'generated');
  assert.equal(rail.pinned[1].kind, 'native');

  // Two plates for one application is a double click, not a preference.
  const deduped = await prefs.setPins(seeded.companyA.id, seeded.userA.id, ['finance', 'finance']);
  assert.deepEqual(deduped.pinned.map((a) => a.key), ['finance']);

  await prefs.reset(seeded.companyA.id, seeded.userA.id);
});

dbTest('a pin is a shortcut to what you have, never a way to get it', async () => {
  await assert.rejects(
    prefs.setPins(seeded.companyA.id, seeded.userA.id, ['not_an_application']),
    (e) => e.code === 'UNKNOWN_APPLICATION'
  );

  // Another company's application cannot be pinned into this rail either.
  const theirs = await app.deploySpec({
    companyId: seeded.companyB.id, userId: seeded.userB.id,
    spec: { ...SPEC, key: 'rail_probe_theirs', name: 'Rail Probe Theirs' },
  });
  await assert.rejects(
    prefs.setPins(seeded.companyA.id, seeded.userA.id, [theirs.application.app_key]),
    (e) => e.code === 'UNKNOWN_APPLICATION'
  );
});

dbTest('switching an application off takes its plate but keeps the pin', async () => {
  const installed = await app.deploySpec({
    companyId: seeded.companyA.id, userId: seeded.userA.id,
    spec: { ...SPEC, key: 'rail_probe_off', name: 'Rail Probe Off' },
  });
  const key = installed.application.app_key;
  await prefs.setPins(seeded.companyA.id, seeded.userA.id, [key, 'finance']);

  await directory.setEnabled(seeded.companyA.id, key, false, { actorId: seeded.userA.id });
  const during = await prefs.rail(seeded.companyA.id, seeded.userA.id);
  assert.deepEqual(during.pinned.map((a) => a.key), ['finance'],
    'a switched-off application still had a plate');

  // The pin was not deleted — switching it back on restores the rail rather
  // than having silently forgotten what they wanted.
  await directory.setEnabled(seeded.companyA.id, key, true, { actorId: seeded.userA.id });
  const after = await prefs.rail(seeded.companyA.id, seeded.userA.id);
  assert.deepEqual(after.pinned.map((a) => a.key), [key, 'finance']);

  await prefs.reset(seeded.companyA.id, seeded.userA.id);
});

dbTest('one person\'s rail is their own', async () => {
  await prefs.setPins(seeded.companyA.id, seeded.userA.id, ['finance']);
  const others = await prefs.rail(seeded.companyA.id, seeded.contributorA.id);
  assert.equal(others.customised, false, 'one person\'s choice reached another\'s rail');
  await prefs.reset(seeded.companyA.id, seeded.userA.id);
});
