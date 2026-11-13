// The built-in modules, as applications.
//
// THE CLAIM UNDER TEST
// ===========================================================================
//     Finance and a capability someone designed this morning are the same
//     KIND of thing. One list, one switch, one home page. What differs —
//     Finance's screens are React routes, the capability's are compiled from
//     a specification — is invisible to everything above them.
//
// Run on its own:  node --test tests/platformNativeApps.test.js

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

const { pool } = require('../config/database');
const seedHelper = require('./helpers/platformSeed');
const app = require('./helpers/platformApp');
const manifests = require('../services/platform/native/manifests');
const summary = require('../services/platform/native/summary');
const directory = require('../services/platform/appDirectory');
const canonical = require('../services/platform/spec/canonical');

let available = false;
let seeded = null;

const SPEC = {
  key: 'native_probe', name: 'Native Probe', description: 'A generated application, for contrast.',
  data: {
    canonical_refs: ['suppliers'],
    entities: [{
      key: 'checks', label: 'Checks', singular: 'Check',
      display: { title_field: 'title' },
      fields: [
        { name: 'title', label: 'Title', type: 'text', required: true },
        { name: 'score', label: 'Score', type: 'decimal' },
      ],
    }],
  },
  workflows: [],
  security: {
    roles: [{
      key: 'operator', label: 'Operator', audience: 'internal',
      permissions: { checks: ['read', 'create', 'update'] },
      record_scope: { checks: 'all' },
    }],
  },
  surfaces: [{
    key: 'internal', label: 'Internal', audience: 'internal', roles: ['operator'],
    default_page: 'check_list', nav: [{ label: 'Checks', page: 'check_list' }],
  }],
  ui: {
    pages: [{
      key: 'check_list', title: 'Checks', kind: 'list', surface: 'internal', entity: 'checks',
      layout: [{ type: 'table', entity: 'checks', fields: ['title', 'score'] }],
    }],
  },
  analytics: {
    queries: [{ key: 'total_checks', label: 'Total checks', entity: 'checks', aggregate: 'count' }],
    metrics: [{ key: 'total_checks', label: 'Total checks', query: 'total_checks', format: 'number' }],
  },
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

// --- the manifests themselves, no database needed ---------------------------
test('every declared tile checks out against the canonical catalogue', () => {
  // The point of this test is to fail HERE rather than on someone's home page:
  // a tile naming a column the schema does not have is a typo, and a typo that
  // only shows up at 9am on a Monday is the expensive kind.
  const tiles = manifests.tiles();
  assert.ok(tiles.length > 0);
  for (const tile of tiles) {
    assert.doesNotThrow(() => summary.validateTile(tile), `${tile.appKey}.${tile.key}`);
  }
});

test('a tile naming a column that does not exist is refused', () => {
  assert.throws(
    () => summary.validateTile({ key: 'x', entity: 'suppliers', aggregate: 'sum', field: 'profit' }),
    /suppliers does not have/
  );
  assert.throws(
    () => summary.validateTile({ key: 'x', entity: 'not_a_thing', aggregate: 'count' }),
    /unknown entity/
  );
  assert.throws(
    () => summary.validateTile({ key: 'x', entity: 'suppliers', aggregate: 'median', field: 'id' }),
    /unknown aggregate/
  );
});

test('a native application references canonical entities and never owns tables', () => {
  for (const manifest of manifests.list()) {
    // An application may legitimately reference NOTHING in the catalogue — but
    // only by saying so. Mail is the case: its mailboxes and messages are real
    // company data deliberately kept out of spec/canonical.js, because that
    // catalogue is exactly the set of record types a generated application may
    // reference, and a capability designed in a sentence must not be able to
    // read the company's correspondence. Silence here would be a manifest
    // somebody forgot to finish; `catalogued: false` is a decision.
    if (manifest.catalogued === false) {
      assert.deepEqual(manifest.references, [],
        `${manifest.key} says its data is uncatalogued but references canonical entities`);
      assert.deepEqual(manifest.writes, []);
    } else {
      assert.ok(manifest.references.length > 0, `${manifest.key} references nothing and does not say why`);
    }
    for (const key of manifest.references) {
      assert.ok(canonical.entity(key), `${manifest.key} references unknown entity ${key}`);
    }
    // Anything it writes, it must also read. And nothing it writes may be
    // outside the canonical set — a native application has no private tables
    // and this is the assertion that keeps it that way.
    for (const key of manifest.writes || []) {
      assert.ok(manifest.references.includes(key), `${manifest.key} writes ${key} without referencing it`);
      assert.ok(canonical.entity(key), `${manifest.key} writes unknown entity ${key}`);
    }
    assert.equal(manifest.owns, undefined, `${manifest.key} declares ownership; native applications own nothing`);
  }
});

test('no tile builds SQL by interpolation', () => {
  const { text, params } = summary.tileSql({
    key: 'x', appKey: 'test', entity: 'purchase_orders', aggregate: 'count',
    where: [['status', 'in', ["'; DROP TABLE users; --", 'APPROVED']]],
  });
  assert.ok(!text.includes('DROP'), 'a filter value reached the statement text');
  assert.deepEqual(params[0], ["'; DROP TABLE users; --", 'APPROVED']);
});

// --- the directory ----------------------------------------------------------
dbTest('the directory lists built-in and built-here applications as one kind of thing', async () => {
  const installed = await app.deploySpec({
    companyId: seeded.companyA.id, userId: seeded.userA.id, spec: SPEC,
  });

  const all = await directory.list(seeded.companyA.id);
  const native = all.filter((a) => a.kind === 'native');
  const generated = all.filter((a) => a.kind === 'generated');

  assert.ok(native.length > 0, 'no built-in applications listed');
  assert.ok(generated.some((a) => a.key === installed.application.app_key));

  // Every entry answers the same questions, whichever store it came from.
  for (const entry of all) {
    assert.equal(typeof entry.key, 'string');
    assert.equal(typeof entry.name, 'string');
    assert.equal(typeof entry.enabled, 'boolean');
    assert.ok(Array.isArray(entry.reads));
    assert.ok(Array.isArray(entry.owns));
    assert.ok(entry.route);
  }

  // "Reads nothing" and "holds data nothing else can reach" are different
  // facts, and the directory has to be able to say which one it means.
  const mail = native.find((a) => a.key === 'mail');
  if (mail) {
    assert.deepEqual(mail.reads, []);
    assert.equal(mail.catalogued, false);
  }
  assert.equal(generated.find((a) => a.key === installed.application.app_key)?.catalogued, true);

  // But they are honest about the difference that matters: only a generated
  // application owns tables of its own.
  assert.deepEqual(native.find((a) => a.key === 'finance')?.owns, []);
  assert.deepEqual(generated.find((a) => a.key === installed.application.app_key)?.owns, ['checks']);
});

dbTest('one switch turns either kind off, and neither is ever removed', async () => {
  const installed = await app.deploySpec({
    companyId: seeded.companyA.id, userId: seeded.userA.id,
    spec: { ...SPEC, key: 'native_switch', name: 'Native Switch' },
  });
  const appKey = installed.application.app_key;

  // A generated one.
  await directory.setEnabled(seeded.companyA.id, appKey, false, { actorId: seeded.userA.id, reason: 'Testing.' });
  let entry = (await directory.list(seeded.companyA.id)).find((a) => a.key === appKey);
  assert.equal(entry.enabled, false);
  assert.equal(entry.disabledReason, 'Testing.');
  // Still listed. An App Library that hides what you switched off gives you no
  // way to switch it back on.
  assert.ok(entry, 'a disabled application vanished from the directory');

  await directory.setEnabled(seeded.companyA.id, appKey, true, { actorId: seeded.userA.id });
  entry = (await directory.list(seeded.companyA.id)).find((a) => a.key === appKey);
  assert.equal(entry.enabled, true);

  // A native one, through the identical call.
  const toggleable = (await directory.list(seeded.companyA.id))
    .find((a) => a.kind === 'native' && a.removable);
  if (toggleable) {
    await directory.setEnabled(seeded.companyA.id, toggleable.key, false, { actorId: seeded.userA.id });
    const off = (await directory.list(seeded.companyA.id)).find((a) => a.key === toggleable.key);
    assert.equal(off.enabled, false);
    await directory.setEnabled(seeded.companyA.id, toggleable.key, true, { actorId: seeded.userA.id });
  }
});

dbTest('a core module cannot be switched off, and says so rather than throwing a stack', async () => {
  const core = (await directory.list(seeded.companyA.id)).find((a) => a.kind === 'native' && a.core);
  if (!core) return;                                  // this deployment has none
  await assert.rejects(
    directory.setEnabled(seeded.companyA.id, core.key, false, { actorId: seeded.userA.id }),
    (error) => error.code === 'MODULE_NOT_TOGGLEABLE' && /core module/.test(error.message)
  );
});

dbTest('the home page is composed of whatever the enabled applications contribute', async () => {
  const installed = await app.deploySpec({
    companyId: seeded.companyA.id, userId: seeded.userA.id,
    spec: { ...SPEC, key: 'native_home', name: 'Native Home' },
  });
  const { context, principal } = await app.internalContext({
    companyId: seeded.companyA.id, appKey: installed.application.app_key, userId: seeded.userA.id,
  });
  const data = require('../services/platform/runtime/data');
  await app.as(seeded.companyA.id, () => data.create(context, principal, 'checks', { title: 'One' }));

  const sections = await directory.home(seeded.companyA.id, { userId: seeded.userA.id, role: 'ADMIN' });
  assert.ok(sections.length > 0);

  // The capability built moments ago is on the home page, and nobody deployed
  // a frontend to put it there.
  const mine = sections.find((s) => s.appKey === installed.application.app_key);
  assert.ok(mine, 'a deployed application contributed no home section');
  assert.equal(mine.kind, 'generated');
  assert.equal(mine.tiles.find((t) => t.key === 'total_checks').value, 1);

  // And a built-in module is a section of exactly the same shape.
  const finance = sections.find((s) => s.appKey === 'finance');
  if (finance) {
    assert.equal(finance.kind, 'native');
    finance.tiles.forEach((t) => {
      assert.equal(typeof t.label, 'string');
      assert.ok('value' in t);
    });
  }

  // Switching it off takes its section with it, without touching its rows.
  await directory.setEnabled(seeded.companyA.id, installed.application.app_key, false, { actorId: seeded.userA.id });
  const after = await directory.home(seeded.companyA.id, { userId: seeded.userA.id, role: 'ADMIN' });
  assert.ok(!after.some((s) => s.appKey === installed.application.app_key));
  const rows = await app.readPhysical(seeded.companyA.id, installed.instance.id, 'checks');
  assert.equal(rows.length, 1, 'switching an application off destroyed its records');
});

dbTest('one company\'s home never contains another company\'s applications', async () => {
  const mine = await app.deploySpec({
    companyId: seeded.companyA.id, userId: seeded.userA.id,
    spec: { ...SPEC, key: 'native_tenancy', name: 'Native Tenancy' },
  });
  const sections = await directory.home(seeded.companyB.id, { userId: seeded.userB.id, role: 'ADMIN' });
  assert.ok(!sections.some((s) => s.appKey === mine.application.app_key));

  const listB = await directory.list(seeded.companyB.id);
  assert.ok(!listB.some((a) => a.key === mine.application.app_key));
});
