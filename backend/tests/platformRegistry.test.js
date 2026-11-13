// The application registry, against a real database.
//
// THE CLAIM UNDER TEST
// ===========================================================================
//     An application is a GLOBAL definition. Its data is not. Two companies
//     installing the same application share the design and share nothing else
//     — not a table, not a row, not a name.
//
// Needs a database with the platform migrations applied; skips cleanly without
// one. Run on its own:  node --test tests/platformRegistry.test.js

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

const { pool } = require('../config/database');
const seedHelper = require('./helpers/platformSeed');
const app = require('./helpers/platformApp');
const registry = require('../services/platform/registry');
const ids = require('../services/platform/identifiers');

let available = false;
let seeded = null;

const SPEC = {
  key: 'registry_probe',
  name: 'Registry Probe',
  description: 'Two entities, installed by two companies.',
  data: {
    canonical_refs: [],
    entities: [
      {
        key: 'probes', label: 'Probes', singular: 'Probe',
        display: { title_field: 'title' },
        fields: [
          { name: 'title', label: 'Title', type: 'text', required: true },
          { name: 'reading', label: 'Reading', type: 'decimal' },
        ],
      },
      {
        key: 'probe_notes', label: 'Probe Notes', singular: 'Probe Note',
        display: { title_field: 'note' },
        fields: [
          { name: 'note', label: 'Note', type: 'text', required: true },
          { name: 'probe_id', label: 'Probe', type: 'reference', required: true,
            target: { kind: 'app', entity: 'probes', on_delete: 'cascade' } },
        ],
      },
    ],
  },
  workflows: [],
  security: {
    roles: [{
      key: 'operator', label: 'Operator', audience: 'internal',
      permissions: { probes: ['read', 'create', 'update'], probe_notes: ['read', 'create'] },
      record_scope: { probes: 'all', probe_notes: 'all' },
    }],
  },
  surfaces: [{
    key: 'internal', label: 'Internal', audience: 'internal', roles: ['operator'],
    default_page: 'probe_list', nav: [{ label: 'Probes', page: 'probe_list' }],
  }],
  ui: {
    pages: [{
      key: 'probe_list', title: 'Probes', kind: 'list', surface: 'internal', entity: 'probes',
      layout: [
        { type: 'table', entity: 'probes', fields: ['title', 'reading'] },
        { type: 'table', entity: 'probe_notes', fields: ['note'] },
      ],
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

/**
 * A test that needs the database.
 *
 * The skip decision has to be made INSIDE the test, not in its options: node's
 * runner evaluates options when the file is loaded, which is before `before()`
 * has had a chance to find out whether a database is there.
 */
const dbTest = (name, fn) => test(name, async (t) => {
  if (!available) {
    t.skip('no database with the platform schema');
    return;
  }
  await fn(t);
});

dbTest('an application definition is global and its key is unique platform-wide', async () => {
  const a = await app.deploySpec({ companyId: seeded.companyA.id, userId: seeded.userA.id, spec: SPEC });
  // The second company asking for the same key gets its own derived key rather
  // than a collision, because a key names a design and this is a new one.
  const b = await app.deploySpec({ companyId: seeded.companyB.id, userId: seeded.userB.id, spec: SPEC });
  assert.notEqual(a.application.app_key, b.application.app_key);
  assert.match(b.application.app_key, /^registry_probe_/);

  // The derivation is deterministic — B's alternative is derived from B's id,
  // not from a counter — so B's key is the one a second company would predict.
  assert.equal(b.application.app_key, `registry_probe_${ids.shortHash(`company:${seeded.companyB.id}`, 6)}`);

  // But a key that is TAKEN is never handed out again, not even to the company
  // that took it. Company B designing a second application the analyser names
  // the same thing gets a third key; returning B's own key here is what used to
  // kill the build at the last step with a unique-constraint violation.
  const again = await app.as(seeded.companyB.id, () =>
    registry.availableApplicationKey('registry_probe', seeded.companyB.id));
  assert.notEqual(again, b.application.app_key);
  assert.equal(again, `${b.application.app_key}_2`);

  // Neither row carries a company_id — `applications` is not company-scoped.
  const { rows } = await pool.query('SELECT * FROM applications WHERE id = $1', [a.application.id]);
  assert.ok(!('company_id' in rows[0]));
  assert.equal(rows[0].origin_company_id, seeded.companyA.id);
});

dbTest('a company can design the same kind of application twice', async () => {
  // The case that used to fail: everything succeeded — context, design,
  // composition, validation — and then the INSERT hit uq_applications_key,
  // because the key handed back was one the company already owned.
  const spec = { ...SPEC, key: 'twice_probe', name: 'Twice Probe' };
  const first = await app.deploySpec({ companyId: seeded.companyA.id, userId: seeded.userA.id, spec });
  const second = await app.deploySpec({ companyId: seeded.companyA.id, userId: seeded.userA.id, spec });

  assert.notEqual(first.application.id, second.application.id);
  assert.notEqual(first.application.app_key, second.application.app_key);

  // Two designs, two instances, two sets of tables — nothing shared.
  const tablesA = await app.as(seeded.companyA.id, () => registry.listTables(first.instance.id));
  const tablesB = await app.as(seeded.companyA.id, () => registry.listTables(second.instance.id));
  const namesA = tablesA.map((t) => t.table_name);
  const namesB = tablesB.map((t) => t.table_name);
  namesA.forEach((n) => assert.ok(!namesB.includes(n), `${n} is shared between two applications`));
});

dbTest('one application installed by two companies gets two instances and two sets of tables', async () => {
    const shared = { ...SPEC, key: 'shared_design', name: 'Shared Design' };
    const a = await app.deploySpec({ companyId: seeded.companyA.id, userId: seeded.userA.id, spec: shared });

    // Company B installs A's application — the same definition, not a copy.
    const instanceB = await app.as(seeded.companyB.id, () => registry.ensureInstance({
      applicationId: a.application.id, companyId: seeded.companyB.id, installedBy: seeded.userB.id,
    }));
    const deployer = require('../services/platform/deployer');
    await deployer.deploy({
      companyId: seeded.companyB.id, applicationId: a.application.id,
      versionId: a.version.id, actorId: seeded.userB.id,
    });

    const tablesA = await app.as(seeded.companyA.id, () => registry.listTables(a.instance.id));
    const tablesB = await app.as(seeded.companyB.id, () => registry.listTables(instanceB.id));

    assert.equal(tablesA.length, 2);
    assert.equal(tablesB.length, 2);

    const namesA = tablesA.map((t) => t.table_name).sort();
    const namesB = tablesB.map((t) => t.table_name).sort();
    assert.notDeepEqual(namesA, namesB, 'two companies must not share a physical table');
    namesA.forEach((n) => assert.ok(!namesB.includes(n)));

    // Both are real tables in the catalogue.
    const { rows } = await pool.query(
      'SELECT tablename FROM pg_tables WHERE tablename = ANY($1)', [[...namesA, ...namesB]]
    );
    assert.equal(rows.length, 4);

    // Both carry the standard isolation policy.
    const { rows: rls } = await pool.query(
      'SELECT tablename, rowsecurity FROM pg_tables WHERE tablename = ANY($1)', [[...namesA, ...namesB]]
    );
    rls.forEach((r) => assert.equal(r.rowsecurity, true, `${r.tablename} has no row-level security`));

    // And the same design, running in both.
    assert.equal(instanceB.application_id, a.application.id);
  });

dbTest('the physical name is derived from the application and the company, and is reproducible', async () => {
    const spec = { ...SPEC, key: 'derived_names', name: 'Derived Names' };
    const installed = await app.deploySpec({ companyId: seeded.companyA.id, userId: seeded.userA.id, spec });
    const expectedPrefix = ids.instanceTablePrefix(installed.application.id, seeded.companyA.id);
    assert.equal(installed.instance.table_prefix, expectedPrefix);

    const tables = await app.as(seeded.companyA.id, () => registry.listTables(installed.instance.id));
    tables.forEach((t) => {
      assert.equal(t.table_name, ids.physicalTableName(expectedPrefix, t.entity_key));
      assert.equal(t.physical_table_identifier, `"public"."${t.table_name}"`);
    });
  });

dbTest('the registry is the only way to get a physical table name', async () => {
  const spec = { ...SPEC, key: 'resolution_probe', name: 'Resolution Probe' };
  const installed = await app.deploySpec({ companyId: seeded.companyA.id, userId: seeded.userA.id, spec });

  const resolved = await app.as(seeded.companyA.id, () =>
    registry.resolveTable(installed.instance.id, 'probes'));
  assert.match(resolved.table, /^app_[a-f0-9]{8}_[a-f0-9]{8}_probes$/);

  // An entity this instance does not have.
  await assert.rejects(
    app.as(seeded.companyA.id, () => registry.resolveTable(installed.instance.id, 'users')),
    /has no entity "users"/
  );

  // A hostile "entity key" never reaches a lookup at all.
  for (const hostile of ['users; DROP TABLE users', '"users"', 'public.users', 'SELECT']) {
    await assert.rejects(
      app.as(seeded.companyA.id, () => registry.resolveTable(installed.instance.id, hostile)),
      /not a legal entity key/,
      hostile
    );
  }
});

dbTest('the database itself refuses two instances claiming one physical table', async () => {
  const spec = { ...SPEC, key: 'unique_probe', name: 'Unique Probe' };
  const first = await app.deploySpec({ companyId: seeded.companyA.id, userId: seeded.userA.id, spec });
  const tables = await app.as(seeded.companyA.id, () => registry.listTables(first.instance.id));

  const other = await app.deploySpec({
    companyId: seeded.companyA.id, userId: seeded.userA.id,
    spec: { ...SPEC, key: 'unique_probe_two', name: 'Unique Probe Two' },
  });

  // Even with a bug upstream computing the same name, the UNIQUE index is the
  // backstop that cannot be reasoned past.
  await assert.rejects(
    app.as(seeded.companyA.id, () => registry.registerTable({
      instanceId: other.instance.id, companyId: seeded.companyA.id,
      entityKey: 'probes', schema: 'public', table: tables[0].table_name,
    })),
    /duplicate key|unique/i
  );
});

dbTest('versions accumulate, and publishing supersedes the previous one', async () => {
  const spec = { ...SPEC, key: 'versioned_probe', name: 'Versioned Probe' };
  const installed = await app.deploySpec({ companyId: seeded.companyA.id, userId: seeded.userA.id, spec });

  const next = JSON.parse(JSON.stringify(installed.spec));
  next.data.entities[0].fields.push({ name: 'notes', label: 'Notes', type: 'long_text' });

  const v2 = await app.as(seeded.companyA.id, () => registry.createVersion({
    applicationId: installed.application.id, spec: next, parentVersionId: installed.version.id,
    changeSummary: 'Added notes.', createdBy: seeded.userA.id,
  }));
  assert.equal(v2.version, installed.version.version + 1);
  assert.equal(v2.parent_version_id, installed.version.id);
  assert.notEqual(v2.spec_hash, installed.version.spec_hash);

  await app.as(seeded.companyA.id, () => registry.publishVersion(v2.id));
  const versions = await app.as(seeded.companyA.id, () => registry.listVersions(installed.application.id));
  assert.equal(versions.find((v) => v.id === v2.id).status, 'published');
  assert.equal(versions.find((v) => v.id === installed.version.id).status, 'superseded');
});

dbTest('a specification hash ignores key order — it is a value, not a serialization', () => {
    const a = { key: 'x', name: 'X', data: { entities: [] } };
    const b = { data: { entities: [] }, name: 'X', key: 'x' };
    assert.equal(registry.hashSpec(a), registry.hashSpec(b));
    assert.notEqual(registry.hashSpec(a), registry.hashSpec({ ...a, name: 'Y' }));
  });

dbTest('a company cannot see another company\'s private application definition', async () => {
    const spec = { ...SPEC, key: 'private_probe', name: 'Private Probe' };
    const installed = await app.deploySpec({ companyId: seeded.companyA.id, userId: seeded.userA.id, spec });

    await assert.rejects(
      app.as(seeded.companyB.id, () => registry.assertVisible(installed.application.id, seeded.companyB.id)),
      /No such application/
    );
    await app.as(seeded.companyA.id, () => registry.assertVisible(installed.application.id, seeded.companyA.id));

    const listB = await app.as(seeded.companyB.id, () => registry.listForCompany(seeded.companyB.id));
    assert.ok(!listB.some((a) => a.id === installed.application.id));
  });

dbTest('every platform event is recorded with its provenance class', async () => {
  const spec = { ...SPEC, key: 'provenance_probe', name: 'Provenance Probe' };
  const installed = await app.deploySpec({ companyId: seeded.companyA.id, userId: seeded.userA.id, spec });
  const events = await app.as(seeded.companyA.id, () => registry.listEvents({
    companyId: seeded.companyA.id, applicationId: installed.application.id,
  }));
  const types = events.map((e) => e.event_type);
  assert.ok(types.includes('deployment.planned'));
  assert.ok(types.includes('deployment.deployed'));
  // The plan is a decision; applying it is an execution. Keeping them apart is
  // what stops a proposal reading later like something that happened.
  assert.equal(events.find((e) => e.event_type === 'deployment.planned').provenance_class, 'decision');
  assert.equal(events.find((e) => e.event_type === 'deployment.deployed').provenance_class, 'execution');
});
