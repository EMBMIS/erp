// My Work: the cross-application inbox.
//
// THE CLAIM UNDER TEST
// ===========================================================================
//     A capability designed this afternoon, with an approval step in it,
//     appears in one person's inbox this afternoon — and nobody edited the
//     inbox to make that happen.
//
// That is the whole difference from the screen this replaces, which called
// eight hardcoded endpoints listed in the frontend. So the test deploys a NEW
// application with a workflow, puts a record into the state that needs
// reviewing, and asserts the work shows up attributed to that application.
//
// Run on its own:  node --test tests/platformMyWork.test.js

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

const { pool } = require('../config/database');
const seedHelper = require('./helpers/platformSeed');
const app = require('./helpers/platformApp');
const myWork = require('../services/platform/myWork');
const catalog = require('../services/platform/catalog');

let available = false;
let seeded = null;

/**
 * An application whose findings need a reviewer's approval to close.
 *
 * The approval requirement is the point: work is only "yours" if you hold the
 * role a transition asks for.
 */
const SPEC = {
  key: 'work_probe', name: 'Work Probe', description: 'Findings that need reviewing.',
  data: {
    canonical_refs: [],
    entities: [{
      key: 'findings', label: 'Findings', singular: 'Finding',
      display: { title_field: 'title' },
      fields: [
        { name: 'title', label: 'Title', type: 'text', required: true },
        { name: 'state', label: 'State', type: 'enum', required: true, default: 'OPEN',
          values: ['OPEN', 'UNDER_REVIEW', 'CLOSED'] },
      ],
    }],
  },
  workflows: [{
    key: 'finding_flow', label: 'Finding lifecycle', entity: 'findings', state_field: 'state',
    states: [
      { key: 'OPEN', label: 'Open', initial: true },
      { key: 'UNDER_REVIEW', label: 'Under review' },
      { key: 'CLOSED', label: 'Closed', terminal: true },
    ],
    transitions: [
      { key: 'submit', label: 'Submit', from: 'OPEN', to: 'UNDER_REVIEW' },
      { key: 'close', label: 'Close', from: 'UNDER_REVIEW', to: 'CLOSED',
        requires: [{ type: 'approval', role: 'reviewer' }] },
    ],
  }],
  security: {
    roles: [
      { key: 'reviewer', label: 'Reviewer', audience: 'internal',
        permissions: { findings: ['read', 'create', 'update'] }, record_scope: { findings: 'all' } },
      { key: 'raiser', label: 'Raiser', audience: 'internal',
        permissions: { findings: ['read', 'create'] }, record_scope: { findings: 'all' } },
    ],
  },
  surfaces: [{
    key: 'internal', label: 'Internal', audience: 'internal', roles: ['reviewer', 'raiser'],
    default_page: 'finding_list', nav: [{ label: 'Findings', page: 'finding_list' }],
  }],
  ui: {
    pages: [{
      key: 'finding_list', title: 'Findings', kind: 'list', surface: 'internal', entity: 'findings',
      layout: [{ type: 'table', entity: 'findings', fields: ['title', 'state'] }],
    }],
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

dbTest('an application deployed just now contributes work just now', async () => {
  const installed = await app.deploySpec({
    companyId: seeded.companyA.id, userId: seeded.userA.id, spec: SPEC,
  });
  const appKey = installed.application.app_key;

  // Two findings under review. Nobody has been given the reviewer role yet.
  const { context, principal } = await app.internalContext({
    companyId: seeded.companyA.id, appKey, userId: seeded.userA.id,
  });
  // Created, then MOVED. create() plants the workflow's initial state and
  // overrides whatever the caller supplied, deliberately — a record cannot be
  // born halfway through its own process — so reaching UNDER_REVIEW means
  // taking the transition, which is also what a person would do.
  const data = require('../services/platform/runtime/data');
  const workflow = require('../services/platform/runtime/workflow');
  for (const title of ['Torque out of spec', 'Coating thickness low']) {
    const record = await app.as(seeded.companyA.id, () =>
      data.create(context, principal, 'findings', { title }));
    assert.equal(record.state, 'OPEN', 'a new record did not start in the initial state');
    await app.as(seeded.companyA.id, () =>
      workflow.transition(context, principal, 'findings', record.id, 'submit'));
  }

  // A user with no role in this application: the findings are somebody
  // else's problem, and an inbox that shows them anyway is one people stop
  // opening.
  const none = await myWork.build(seeded.companyA.id, { userId: seeded.contributorA.id, role: 'USER' });
  assert.ok(!none.items.some((i) => i.appKey === appKey),
    'work appeared for a user with no role in the application');

  // Give them the reviewer role — the role the close transition asks for.
  await catalog.assignRole({
    companyId: seeded.companyA.id, appKey, userId: seeded.contributorA.id,
    roleKey: 'reviewer', actorId: seeded.userA.id,
  });

  const mine = await myWork.build(seeded.companyA.id, { userId: seeded.contributorA.id, role: 'USER' });
  const item = mine.items.find((i) => i.appKey === appKey);
  assert.ok(item, 'a workflow step needing this person\'s role produced no work');
  assert.equal(item.count, 2);
  assert.equal(item.kind, 'generated');
  assert.equal(item.appName, installed.application.name);
  // The row says what the work IS, in the application's own words.
  assert.match(item.title, /Findings awaiting close/i);
  assert.ok(mine.total >= 2);
});

dbTest('work in a terminal state, or with no role requirement, is not anybody\'s inbox item', async () => {
  const installed = await app.deploySpec({
    companyId: seeded.companyA.id, userId: seeded.userA.id,
    spec: { ...SPEC, key: 'work_probe_closed', name: 'Work Probe Closed' },
  });
  const appKey = installed.application.app_key;
  const { context, principal } = await app.internalContext({
    companyId: seeded.companyA.id, appKey, userId: seeded.userA.id,
  });
  const data = require('../services/platform/runtime/data');

  // OPEN has a transition out of it, but that transition requires no role —
  // anybody can submit, so it is not waiting on any particular person.
  await app.as(seeded.companyA.id, () =>
    data.create(context, principal, 'findings', { title: 'Just raised' }));

  await catalog.assignRole({
    companyId: seeded.companyA.id, appKey, userId: seeded.contributorA.id,
    roleKey: 'reviewer', actorId: seeded.userA.id,
  });

  const mine = await myWork.build(seeded.companyA.id, { userId: seeded.contributorA.id, role: 'USER' });
  assert.ok(!mine.items.some((i) => i.appKey === appKey),
    'an unactionable record was reported as work');
});

dbTest('one company\'s inbox never contains another company\'s work', async () => {
  const installed = await app.deploySpec({
    companyId: seeded.companyA.id, userId: seeded.userA.id,
    spec: { ...SPEC, key: 'work_probe_tenancy', name: 'Work Probe Tenancy' },
  });
  const { context, principal } = await app.internalContext({
    companyId: seeded.companyA.id, appKey: installed.application.app_key, userId: seeded.userA.id,
  });
  const data = require('../services/platform/runtime/data');
  await app.as(seeded.companyA.id, () =>
    data.create(context, principal, 'findings', { title: 'Theirs', state: 'UNDER_REVIEW' }));

  const theirs = await myWork.build(seeded.companyB.id, { userId: seeded.userB.id, role: 'ADMIN' });
  assert.ok(!theirs.items.some((i) => i.appKey === installed.application.app_key));
});

dbTest('an inbox with nothing in it is empty rather than wrong', async () => {
  const mine = await myWork.build(seeded.companyB.id, { userId: seeded.userB.id, role: 'ADMIN' });
  assert.ok(Array.isArray(mine.items));
  assert.equal(mine.total, mine.items.reduce((s, i) => s + i.count, 0));
});

dbTest('no user, no work — the inbox is never built for nobody', async () => {
  const anonymous = await myWork.build(seeded.companyA.id, { userId: null, role: 'ADMIN' });
  assert.deepEqual(anonymous.items, []);
  assert.equal(anonymous.total, 0);
});
