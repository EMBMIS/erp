// Migrating the pre-platform generated applications.
//
// THE CLAIM UNDER TEST
// ===========================================================================
//     The old shape — one `supplier_shipments` shared by every company,
//     separated only by a company_id column — becomes one global application
//     definition and one set of tables per company, with each company's rows
//     copied into its own, and the legacy tables left alone.
//
// The legacy schema does not exist on a database built after the platform, so
// this suite BUILDS it, migrates it, and takes it down again. That is the only
// way to test a migration for a shape the current code no longer produces.
//
// Run on its own:  node --test tests/platformLegacyMigration.test.js

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

const { pool } = require('../config/database');
const seedHelper = require('./helpers/platformSeed');
const app = require('./helpers/platformApp');
const legacy = require('../services/platform/legacyMigration');
const registry = require('../services/platform/registry');
const data = require('../services/platform/runtime/data');

let available = false;
let seeded = null;
let builtLegacy = false;

const dbTest = (name, fn) => test(name, async (t) => {
  if (!available) { t.skip('no database with the platform schema'); return; }
  await fn(t);
});

/**
 * The pre-platform world, reconstructed: a company-scoped registry and ONE
 * shared table that both companies write into.
 */
async function buildLegacySchema() {
  const owner = app.ownerPool();
  await owner.query(`
    CREATE TABLE IF NOT EXISTS apps (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      app_key TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      kind TEXT NOT NULL DEFAULT 'generated',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
  await owner.query(`
    CREATE TABLE IF NOT EXISTS app_entities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      entity_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT,
      table_name TEXT,
      list_fields TEXT[] NOT NULL DEFAULT '{}',
      form_fields JSONB NOT NULL DEFAULT '[]'::jsonb
    )`);
  // The shared table: both companies, one relation.
  await owner.query(`
    CREATE TABLE IF NOT EXISTS legacy_supplier_shipments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      supplier_id UUID NOT NULL,
      reference VARCHAR(64) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
      expected_at TIMESTAMPTZ,
      quantity NUMERIC(12,2),
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
  await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON apps, app_entities, legacy_supplier_shipments TO qira_app')
    .catch(() => {});

  for (const company of [seeded.companyA, seeded.companyB]) {
    const { rows } = await owner.query(
      `INSERT INTO apps (company_id, app_key, name, description)
       VALUES ($1, 'supplier_tracking', 'Supplier Tracking', 'Tracks supplier deliveries.')
       RETURNING id`,
      [company.id]
    );
    await owner.query(
      `INSERT INTO app_entities (company_id, app_id, entity_key, display_name, description, table_name, list_fields, form_fields)
       VALUES ($1, $2, 'supplier_shipments', 'Supplier Shipments', 'One delivery from a supplier.',
               'legacy_supplier_shipments', $3, $4)`,
      [company.id, rows[0].id, ['reference', 'status', 'expected_at'],
        JSON.stringify([
          { name: 'reference', label: 'Reference', type: 'text', required: true },
          { name: 'status', label: 'Status', type: 'select', options: ['PENDING', 'IN_TRANSIT', 'DELIVERED', 'LATE'] },
          { name: 'expected_at', label: 'Expected', type: 'datetime' },
        ])]
    );
  }

  // Rows for both companies, in the same table.
  const rows = [
    [seeded.companyA.id, seeded.suppliersA[0].id, 'SHIP-A-1', 'DELIVERED', 12],
    [seeded.companyA.id, seeded.suppliersA[1].id, 'SHIP-A-2', 'LATE', 40],
    [seeded.companyA.id, seeded.suppliersA[0].id, 'SHIP-A-3', 'PENDING', 7],
    [seeded.companyB.id, seeded.suppliersB[0].id, 'SHIP-B-1', 'PENDING', 5],
  ];
  for (const [companyId, supplierId, reference, status, quantity] of rows) {
    await owner.query(
      `INSERT INTO legacy_supplier_shipments (company_id, supplier_id, reference, status, expected_at, quantity, notes)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP + INTERVAL '3 days', $5, 'migrated row')`,
      [companyId, supplierId, reference, status, quantity]
    );
  }
  builtLegacy = true;
}

async function dropLegacySchema() {
  if (!builtLegacy) return;
  const owner = app.ownerPool();
  await owner.query('DROP TABLE IF EXISTS app_entities CASCADE').catch(() => {});
  await owner.query('DROP TABLE IF EXISTS apps CASCADE').catch(() => {});
  await owner.query('DROP TABLE IF EXISTS legacy_supplier_shipments CASCADE').catch(() => {});
}

before(async () => {
  available = await app.platformAvailable();
  if (!available) return;
  // Refuse to run if a real `apps` table is present: this suite creates and
  // drops one, and doing that to somebody's actual data would be unforgivable.
  const { rows } = await pool.query("SELECT to_regclass('public.apps') AS t");
  if (rows[0].t) {
    available = false;
    return;
  }
  seeded = await seedHelper.seed();
  await buildLegacySchema();
});

after(async () => {
  await dropLegacySchema();
  if (seeded) await seedHelper.cleanup(seeded);
  await app.closeOwnerPool();
  await pool.end().catch(() => {});
});

// ---------------------------------------------------------------------------
dbTest('a dry run reports what it would do and changes nothing', async () => {
  const before = await pool.query('SELECT count(*)::int AS n FROM app_company_instances');

  const report = await legacy.migrateLegacyApplications({ apply: false });
  assert.equal(report.legacyPresent, true);
  assert.equal(report.applications.length, 1);

  const entry = report.applications[0];
  assert.equal(entry.appKey, 'supplier_tracking');
  assert.equal(entry.entities.length, 1);
  assert.equal(entry.companies.length, 2, 'both companies had it');
  const forA = entry.companies.find((c) => c.companyId === seeded.companyA.id);
  assert.equal(forA.wouldCopy.supplier_shipments, 3);
  const forB = entry.companies.find((c) => c.companyId === seeded.companyB.id);
  assert.equal(forB.wouldCopy.supplier_shipments, 1);

  const after = await pool.query('SELECT count(*)::int AS n FROM app_company_instances');
  assert.equal(after.rows[0].n, before.rows[0].n, 'a dry run must create nothing');
});

dbTest('the derived specification reads the real columns, not a guess', async () => {
  const applications = await legacy.readLegacy();
  const { spec, problems } = await legacy.specFor(applications[0]);
  assert.deepEqual(problems, []);

  const entity = spec.data.entities[0];
  const byName = Object.fromEntries(entity.fields.map((f) => [f.name, f]));

  assert.equal(byName.reference.type, 'text');
  assert.equal(byName.reference.required, true, 'NOT NULL with no default is required');
  assert.equal(byName.quantity.type, 'decimal');
  assert.equal(byName.expected_at.type, 'datetime');
  assert.equal(byName.notes.type, 'long_text');

  // The legacy form metadata said `status` was a select with four options —
  // that was an enum in all but name, and it becomes one.
  assert.equal(byName.status.type, 'enum');
  assert.deepEqual(byName.status.values, ['PENDING', 'IN_TRANSIT', 'DELIVERED', 'LATE']);

  // A uuid column the canonical catalogue recognises becomes a real reference.
  assert.equal(byName.supplier_id.type, 'reference');
  assert.equal(byName.supplier_id.target.entity, 'suppliers');
  assert.ok(spec.data.canonical_refs.includes('suppliers'));

  // The platform's own columns are not carried across as fields.
  ['id', 'company_id', 'created_at'].forEach((c) => assert.ok(!byName[c], `${c} should not be a field`));
});

dbTest('migrating gives each company its own tables and its own rows', async () => {
  const report = await legacy.migrateLegacyApplications({ apply: true });
  const entry = report.applications[0];
  assert.ok(entry.applicationId);

  // ONE global application definition, two instances.
  const application = await registry.getApplicationByKey('supplier_tracking');
  assert.ok(application);
  const instanceA = await app.as(seeded.companyA.id, () => registry.getInstance(application.id, seeded.companyA.id));
  const instanceB = await app.as(seeded.companyB.id, () => registry.getInstance(application.id, seeded.companyB.id));
  assert.ok(instanceA && instanceB);
  assert.notEqual(instanceA.id, instanceB.id);
  assert.notEqual(instanceA.table_prefix, instanceB.table_prefix);

  const tablesA = await app.as(seeded.companyA.id, () => registry.listTables(instanceA.id));
  const tablesB = await app.as(seeded.companyB.id, () => registry.listTables(instanceB.id));
  assert.notEqual(tablesA[0].table_name, tablesB[0].table_name,
    'the whole point of the migration is that they stop sharing a table');

  // Each company's rows, and only its own.
  const rowsA = await app.readPhysical(seeded.companyA.id, instanceA.id, 'supplier_shipments');
  const rowsB = await app.readPhysical(seeded.companyB.id, instanceB.id, 'supplier_shipments');
  assert.equal(rowsA.length, 3);
  assert.equal(rowsB.length, 1);
  assert.ok(rowsA.every((r) => r.reference.startsWith('SHIP-A')));
  assert.ok(rowsB.every((r) => r.reference.startsWith('SHIP-B')));

  // Ids are carried across, so anything outside the application that referred
  // to a record by id still points at the same record.
  const original = await pool.query(
    'SELECT id FROM legacy_supplier_shipments WHERE company_id = $1 ORDER BY reference', [seeded.companyA.id]
  );
  assert.deepEqual(
    rowsA.map((r) => r.id).sort(),
    original.rows.map((r) => r.id).sort()
  );
});

dbTest('the legacy tables are left exactly as they were', async () => {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM legacy_supplier_shipments');
  assert.equal(rows[0].n, 4, 'nothing is dropped — a mis-mapped migration must be inspectable');
  const { rows: registryRows } = await pool.query('SELECT count(*)::int AS n FROM apps');
  assert.equal(registryRows[0].n, 2);
});

dbTest('the migrated application works through the generic runtime', async () => {
  const { context, principal } = await app.internalContext({
    companyId: seeded.companyA.id, appKey: 'supplier_tracking', userId: seeded.userA.id,
  });

  const list = await app.as(seeded.companyA.id, () =>
    data.list(context, principal, 'supplier_shipments', { pageSize: 20 }));
  assert.equal(list.total, 3);
  assert.ok(list.rows[0].supplier_id__label, 'the migrated reference is labelled like any other');

  // The enum the migration inferred is now enforced by the database.
  await assert.rejects(
    app.as(seeded.companyA.id, () => data.create(context, principal, 'supplier_shipments', {
      reference: 'SHIP-A-4', supplier_id: seeded.suppliersA[0].id, status: 'NOT_A_STATUS',
    })),
    /must be one of/
  );

  const created = await app.as(seeded.companyA.id, () => data.create(context, principal, 'supplier_shipments', {
    reference: 'SHIP-A-4', supplier_id: seeded.suppliersA[0].id, status: 'IN_TRANSIT', quantity: 3,
  }));
  assert.ok(created.id);
});

dbTest('running the migration twice does not duplicate anything', async () => {
  const before = await pool.query('SELECT count(*)::int AS n FROM app_company_instances');
  const report = await legacy.migrateLegacyApplications({ apply: true });
  const after = await pool.query('SELECT count(*)::int AS n FROM app_company_instances');
  assert.equal(after.rows[0].n, before.rows[0].n);
  assert.ok(report.applications[0].companies.every((c) => c.skipped === 'already installed'));

  const application = await registry.getApplicationByKey('supplier_tracking');
  const instanceA = await app.as(seeded.companyA.id, () => registry.getInstance(application.id, seeded.companyA.id));
  const rowsA = await app.readPhysical(seeded.companyA.id, instanceA.id, 'supplier_shipments');
  assert.equal(rowsA.length, 4, 'three migrated plus the one created above — not seven');
});

dbTest('a column with no equivalent type stops that application rather than being guessed at', async () => {
  const owner = app.ownerPool();
  await owner.query('ALTER TABLE legacy_supplier_shipments ADD COLUMN IF NOT EXISTS route_geometry POINT');
  try {
    const applications = await legacy.readLegacy();
    const { problems } = await legacy.specFor(applications[0]);
    assert.ok(problems.some((p) => /route_geometry/.test(p) && /no equivalent field type/.test(p)),
      'importing it as text would make it unsortable and nobody would notice for a year');
  } finally {
    await owner.query('ALTER TABLE legacy_supplier_shipments DROP COLUMN IF EXISTS route_geometry');
  }
});

dbTest('the migration is recorded as an event on each instance', async () => {
  const events = await app.as(seeded.companyA.id, () =>
    registry.listEvents({ companyId: seeded.companyA.id, limit: 200 }));
  const migrated = events.find((e) => e.event_type === 'application.migrated_from_legacy');
  assert.ok(migrated, 'a migration nobody can find afterwards is a migration nobody can audit');
  assert.equal(migrated.provenance_class, 'execution');
  assert.equal(migrated.detail.rowsCopied, 3);
  assert.deepEqual(migrated.detail.legacyTables, ['legacy_supplier_shipments']);
});
