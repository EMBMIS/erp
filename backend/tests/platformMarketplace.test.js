// The marketplace.
//
// THE CLAIM UNDER TEST
// ===========================================================================
//     One company installs another company's application and gets the DESIGN.
//     Its own tables, its own row-level security, and not one row of the
//     publisher's data — nor the publisher a row of theirs.
//
// This is where the architecture's central promise stops being theoretical.
// Everything else here — pinned versions, withdrawal, the refusal to install
// something with a price attached — is guardrails around that.
//
// Run on its own:  node --test tests/platformMarketplace.test.js

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

const { pool } = require('../config/database');
const seedHelper = require('./helpers/platformSeed');
const app = require('./helpers/platformApp');
const marketplace = require('../services/platform/marketplace');
const registry = require('../services/platform/registry');

let available = false;
let seeded = null;

const SPEC = {
  key: 'market_probe', name: 'Market Probe',
  description: 'Findings against suppliers, for anybody who buys things.',
  data: {
    canonical_refs: ['suppliers'],
    entities: [{
      key: 'findings', label: 'Findings', singular: 'Finding',
      display: { title_field: 'title' },
      anchor: { field: 'supplier_id', kind: 'supplier' },
      fields: [
        { name: 'title', label: 'Title', type: 'text', required: true },
        { name: 'supplier_id', label: 'Supplier', type: 'reference', required: true,
          target: { kind: 'canonical', entity: 'suppliers', on_delete: 'restrict' } },
      ],
    }],
  },
  workflows: [],
  security: {
    roles: [{ key: 'operator', label: 'Operator', audience: 'internal',
      permissions: { findings: ['read', 'create', 'update'] }, record_scope: { findings: 'all' } }],
  },
  surfaces: [{ key: 'internal', label: 'Internal', audience: 'internal', roles: ['operator'],
    default_page: 'finding_list', nav: [{ label: 'Findings', page: 'finding_list' }] }],
  ui: {
    pages: [{ key: 'finding_list', title: 'Findings', kind: 'list', surface: 'internal', entity: 'findings',
      layout: [{ type: 'table', entity: 'findings', fields: ['title'] }] }],
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

/** Company A builds and lists something. */
async function listSomething(key = 'market_probe', priceCents = 0) {
  const installed = await app.deploySpec({
    companyId: seeded.companyA.id, userId: seeded.userA.id,
    spec: { ...SPEC, key, name: `Market Probe ${key}` },
  });
  await marketplace.publish({
    companyId: seeded.companyA.id,
    appKey: installed.application.app_key,
    summary: 'Track quality findings against the suppliers you already have.',
    priceCents,
    actorId: seeded.userA.id,
  });
  return installed;
}

dbTest('a buyer gets the design and none of the seller\'s data', async () => {
  const built = await listSomething('market_design');
  const appKey = built.application.app_key;

  // The publisher puts a record in. This must never reach anybody else.
  const { context, principal } = await app.internalContext({
    companyId: seeded.companyA.id, appKey, userId: seeded.userA.id,
  });
  const data = require('../services/platform/runtime/data');
  await app.as(seeded.companyA.id, () => data.create(context, principal, 'findings', {
    title: 'Commercially sensitive', supplier_id: seeded.suppliersA[0].id,
  }));

  // Company B installs it.
  await marketplace.install({ companyId: seeded.companyB.id, appKey, actorId: seeded.userB.id });

  const theirInstance = await app.as(seeded.companyB.id, () =>
    registry.getInstance(built.application.id, seeded.companyB.id));
  assert.ok(theirInstance, 'the install produced no instance');
  assert.notEqual(theirInstance.id, built.instance.id);

  // Different physical tables. This is the whole promise.
  const oursTables = await app.as(seeded.companyA.id, () => registry.listTables(built.instance.id));
  const theirsTables = await app.as(seeded.companyB.id, () => registry.listTables(theirInstance.id));
  const ourNames = oursTables.map((t) => t.table_name);
  theirsTables.forEach((t) => assert.ok(!ourNames.includes(t.table_name),
    `${t.table_name} is shared between publisher and buyer`));

  // And the buyer's copy is empty. Not filtered — empty.
  const theirRows = await app.readPhysical(seeded.companyB.id, theirInstance.id, 'findings');
  assert.equal(theirRows.length, 0, 'the publisher\'s records travelled with the design');

  // The publisher's row is untouched.
  const ourRows = await app.readPhysical(seeded.companyA.id, built.instance.id, 'findings');
  assert.equal(ourRows.length, 1);
});

dbTest('the version strangers get is pinned at publication', async () => {
  const built = await listSomething('market_pinned');
  const appKey = built.application.app_key;

  // The publisher keeps working after listing.
  const next = JSON.parse(JSON.stringify(built.spec));
  next.data.entities[0].fields.push({ name: 'root_cause', label: 'Root cause', type: 'long_text' });
  const v2 = await app.as(seeded.companyA.id, () => registry.createVersion({
    applicationId: built.application.id, spec: next, parentVersionId: built.version.id,
    changeSummary: 'Added root cause.', createdBy: seeded.userA.id, status: 'validated',
  }));
  assert.equal(v2.version, built.version.version + 1);

  await marketplace.install({ companyId: seeded.companyB.id, appKey, actorId: seeded.userB.id });
  const theirs = await app.as(seeded.companyB.id, () =>
    registry.getInstance(built.application.id, seeded.companyB.id));

  // They got version 1 — what was on the shelf — not the publisher's
  // work in progress.
  assert.equal(theirs.version_id, built.version.id,
    'the publisher\'s next iteration silently became what a stranger installed');
});

dbTest('a price is recorded and displayed, and refuses to install', async () => {
  const built = await listSomething('market_paid', 4900);
  const listing = (await marketplace.browse(seeded.companyB.id))
    .find((l) => l.appKey === built.application.app_key);

  assert.equal(listing.price.cents, 4900);
  assert.equal(listing.price.free, false);
  assert.equal(listing.price.currency, 'USD');

  await assert.rejects(
    marketplace.install({ companyId: seeded.companyB.id, appKey: built.application.app_key, actorId: seeded.userB.id }),
    (e) => e.code === 'PAYMENT_REQUIRED' && e.status === 402
  );

  // And nothing was half-created on the way to that refusal.
  const instance = await app.as(seeded.companyB.id, () =>
    registry.getInstance(built.application.id, seeded.companyB.id));
  assert.equal(instance, null, 'a refused purchase left an instance behind');
});

dbTest('only the company that built it can list it, and only a real version', async () => {
  const built = await listSomething('market_owner');

  await assert.rejects(
    marketplace.publish({
      companyId: seeded.companyB.id, appKey: built.application.app_key,
      summary: 'Trying to sell somebody else\'s work.', actorId: seeded.userB.id,
    }),
    (e) => e.code === 'NOT_THE_PUBLISHER' && e.status === 403
  );

  // A summary nobody could act on is refused rather than listed.
  await assert.rejects(
    marketplace.publish({
      companyId: seeded.companyA.id, appKey: built.application.app_key,
      summary: 'good', actorId: seeded.userA.id,
    }),
    (e) => e.code === 'SUMMARY_LENGTH'
  );

  // Core applications are not somebody's to sell.
  await assert.rejects(
    marketplace.publish({
      companyId: seeded.companyA.id, appKey: 'finance',
      summary: 'The whole general ledger, going cheap.', actorId: seeded.userA.id,
    }),
    (e) => ['NATIVE_NOT_LISTABLE', 'APPLICATION_NOT_FOUND'].includes(e.code)
  );
});

dbTest('withdrawing closes the shop window and takes nothing back', async () => {
  const built = await listSomething('market_withdraw');
  const appKey = built.application.app_key;
  await marketplace.install({ companyId: seeded.companyB.id, appKey, actorId: seeded.userB.id });

  await marketplace.withdraw({ companyId: seeded.companyA.id, appKey, actorId: seeded.userA.id });

  const onOffer = await marketplace.browse(seeded.companyB.id);
  assert.ok(!onOffer.some((l) => l.appKey === appKey), 'a withdrawn application is still on offer');

  // The company already running it keeps it, and keeps its data. Withdrawal is
  // about the shop window, not about reaching into somebody else's business.
  const theirs = await app.as(seeded.companyB.id, () =>
    registry.getInstance(built.application.id, seeded.companyB.id));
  assert.ok(theirs);
  assert.equal(theirs.status, 'active');

  await assert.rejects(
    marketplace.install({ companyId: seeded.companyB.id, appKey, actorId: seeded.userB.id }),
    (e) => e.code === 'NOT_LISTED'
  );
});

dbTest('a suggestion is a reason somebody can check, not an opinion', () => {
  const row = { spec: { data: { canonical_refs: ['suppliers', 'purchase_orders'] } } };

  assert.equal(marketplace.suggest(row, new Set()), null,
    'something was suggested to a company holding none of the data it needs');

  const suggestion = marketplace.suggest(row, new Set(['suppliers']));
  assert.match(suggestion.reason, /Suppliers/);
  assert.deepEqual(suggestion.matched, ['suppliers']);
  assert.equal(suggestion.strength, 0.5);

  const both = marketplace.suggest(row, new Set(['suppliers', 'purchase_orders']));
  assert.equal(both.strength, 1);
});

dbTest('browsing says what you already have and what is yours', async () => {
  const built = await listSomething('market_flags');
  const appKey = built.application.app_key;

  const asPublisher = (await marketplace.browse(seeded.companyA.id)).find((l) => l.appKey === appKey);
  assert.equal(asPublisher.mine, true);
  assert.equal(asPublisher.installed, true);

  const asStranger = (await marketplace.browse(seeded.companyB.id)).find((l) => l.appKey === appKey);
  assert.equal(asStranger.mine, false);
  assert.equal(asStranger.installed, false);
  // What it will build, and what of yours it will read — the question anybody
  // sensible asks before installing a stranger's software.
  assert.deepEqual(asStranger.owns, ['Findings']);
  assert.deepEqual(asStranger.reads, ['suppliers']);
});
