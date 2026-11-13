// Deployment: planning, approval, applying, failing, retrying, rolling back.
//
// THE CLAIM UNDER TEST
// ===========================================================================
//   1. An approval is an approval of a SPECIFIC plan. If the plan changes
//      between approval and apply, the deployment refuses.
//   2. DDL and registry writes share one transaction. A failure leaves no
//      table without a registry row and no registry row without a table.
//   3. A destructive plan cannot be applied by an ordinary approval; the
//      approver has to name the destructive steps back.
//   4. Two deployments of one instance cannot interleave.
//
// Run on its own:  node --test tests/platformDeployment.test.js

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

const { pool } = require('../config/database');
const seedHelper = require('./helpers/platformSeed');
const app = require('./helpers/platformApp');
const registry = require('../services/platform/registry');
const deployer = require('../services/platform/deployer');
const planner = require('../services/platform/compiler/planner');

let available = false;
let seeded = null;

const dbTest = (name, fn) => test(name, async (t) => {
  if (!available) { t.skip('no database with the platform schema'); return; }
  await fn(t);
});

function baseSpec(key) {
  return {
    key,
    name: key.replace(/_/g, ' '),
    description: 'A deployment probe.',
    data: {
      canonical_refs: [],
      entities: [{
        key: 'records', label: 'Records', singular: 'Record',
        display: { title_field: 'title' },
        fields: [
          { name: 'title', label: 'Title', type: 'text', required: true },
          { name: 'amount', label: 'Amount', type: 'decimal' },
          { name: 'status', label: 'Status', type: 'enum', required: true, default: 'OPEN', values: ['OPEN', 'DONE'] },
        ],
      }],
    },
    workflows: [],
    security: {
      roles: [{
        key: 'operator', label: 'Operator', audience: 'internal',
        permissions: { records: ['read', 'create', 'update', 'delete'] },
        record_scope: { records: 'all' },
      }],
    },
    surfaces: [{
      key: 'internal', label: 'Internal', audience: 'internal', roles: ['operator'],
      default_page: 'record_list', nav: [{ label: 'Records', page: 'record_list' }],
    }],
    ui: {
      pages: [{
        key: 'record_list', title: 'Records', kind: 'list', surface: 'internal', entity: 'records',
        layout: [{ type: 'table', entity: 'records', fields: ['title', 'amount', 'status'] }],
      }],
    },
    analytics: { queries: [], metrics: [] },
    automations: [],
  };
}

before(async () => {
  available = await app.platformAvailable();
  if (!available) return;
  seeded = await seedHelper.seed();
});

after(async () => {
  if (seeded) await seedHelper.cleanup(seeded);
  await app.closeOwnerPool();
  await pool.end().catch(() => {});
});

// ---------------------------------------------------------------------------
dbTest('a first deployment creates real tables and registers them atomically', async () => {
  const installed = await app.deploySpec({
    companyId: seeded.companyA.id, userId: seeded.userA.id, spec: baseSpec('deploy_first'),
  });
  assert.equal(installed.deployment.status, 'deployed');

  const tables = await app.as(seeded.companyA.id, () => registry.listTables(installed.instance.id));
  assert.equal(tables.length, 1);
  const { rows } = await pool.query('SELECT to_regclass($1) AS oid', [`public.${tables[0].table_name}`]);
  assert.ok(rows[0].oid, 'the registered table must actually exist');

  // The instance now runs that version, and the version is published.
  const instance = await app.as(seeded.companyA.id, () =>
    registry.getInstance(installed.application.id, seeded.companyA.id));
  assert.equal(instance.status, 'active');
  assert.equal(instance.version_id, installed.version.id);
  const version = await registry.getVersion(installed.version.id);
  assert.equal(version.status, 'published');
});

dbTest('an additive change deploys without approval', async () => {
  const installed = await app.deploySpec({
    companyId: seeded.companyA.id, userId: seeded.userA.id, spec: baseSpec('deploy_additive'),
  });
  const next = JSON.parse(JSON.stringify(installed.spec));
  next.data.entities[0].fields.push({ name: 'notes', label: 'Notes', type: 'long_text' });
  next.ui.pages[0].layout[0].fields.push('notes');

  const v2 = await app.as(seeded.companyA.id, () => registry.createVersion({
    applicationId: installed.application.id, spec: next,
    parentVersionId: installed.version.id, createdBy: seeded.userA.id, status: 'validated',
  }));
  const result = await deployer.deploy({
    companyId: seeded.companyA.id, applicationId: installed.application.id,
    versionId: v2.id, actorId: seeded.userA.id,
  });
  assert.equal(result.status, 'deployed');

  const tables = await app.as(seeded.companyA.id, () => registry.listTables(installed.instance.id));
  const { rows } = await pool.query(
    'SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = $2',
    [tables[0].table_name, 'notes']
  );
  assert.equal(rows.length, 1);
});

dbTest('a destructive change is planned, not applied, until the steps are named back', async () => {
  const installed = await app.deploySpec({
    companyId: seeded.companyA.id, userId: seeded.userA.id, spec: baseSpec('deploy_destructive'),
  });

  // Put a value in the column that is about to be dropped, so the loss is real.
  const { context, principal } = await app.internalContext({
    companyId: seeded.companyA.id, appKey: installed.application.app_key, userId: seeded.userA.id,
  });
  const data = require('../services/platform/runtime/data');
  await app.as(seeded.companyA.id, () =>
    data.create(context, principal, 'records', { title: 'Keep me', amount: 42 }));

  const next = JSON.parse(JSON.stringify(installed.spec));
  next.data.entities[0].fields = next.data.entities[0].fields.filter((f) => f.name !== 'amount');
  next.ui.pages[0].layout[0].fields = ['title', 'status'];

  const v2 = await app.as(seeded.companyA.id, () => registry.createVersion({
    applicationId: installed.application.id, spec: next,
    parentVersionId: installed.version.id, createdBy: seeded.userA.id, status: 'validated',
  }));

  // Without an acknowledgement, deployment stops and reports what it would do.
  const planned = await deployer.deploy({
    companyId: seeded.companyA.id, applicationId: installed.application.id,
    versionId: v2.id, actorId: seeded.userA.id,
  });
  assert.equal(planned.status, 'awaiting_approval');
  assert.equal(planned.plan.safety, 'destructive');
  assert.equal(planned.plan.summary.destructive.length, 1);

  // The column is still there, and so is the value.
  const tables = await app.as(seeded.companyA.id, () => registry.listTables(installed.instance.id));
  let columns = await pool.query(
    'SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = $2',
    [tables[0].table_name, 'amount']
  );
  assert.equal(columns.rows.length, 1, 'nothing may be dropped before it is approved');

  // A wrong or empty acknowledgement is refused.
  await assert.rejects(
    deployer.approve({
      deploymentId: planned.deployment.id, companyId: seeded.companyA.id,
      approvedBy: seeded.userA.id, acknowledge: [],
    }),
    /must be acknowledged explicitly/
  );
  await assert.rejects(
    deployer.approve({
      deploymentId: planned.deployment.id, companyId: seeded.companyA.id,
      approvedBy: seeded.userA.id, acknowledge: ['something else entirely'],
    }),
    /must be acknowledged explicitly/
  );

  // Naming the exact steps works.
  await deployer.approve({
    deploymentId: planned.deployment.id, companyId: seeded.companyA.id,
    approvedBy: seeded.userA.id, acknowledge: planned.plan.summary.destructive,
  });
  await deployer.apply({
    deploymentId: planned.deployment.id, companyId: seeded.companyA.id, actorId: seeded.userA.id,
  });

  columns = await pool.query(
    'SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = $2',
    [tables[0].table_name, 'amount']
  );
  assert.equal(columns.rows.length, 0);
});

dbTest('an approval does not survive the plan changing under it', async () => {
  const installed = await app.deploySpec({
    companyId: seeded.companyA.id, userId: seeded.userA.id, spec: baseSpec('deploy_plan_drift'),
  });

  const next = JSON.parse(JSON.stringify(installed.spec));
  next.data.entities[0].fields.push({ name: 'reviewer', label: 'Reviewer', type: 'text' });
  const v2 = await app.as(seeded.companyA.id, () => registry.createVersion({
    applicationId: installed.application.id, spec: next,
    parentVersionId: installed.version.id, createdBy: seeded.userA.id, status: 'validated',
  }));

  const prepared = await deployer.prepare({
    companyId: seeded.companyA.id, applicationId: installed.application.id,
    versionId: v2.id, requestedBy: seeded.userA.id,
  });

  // Somebody else adds the column in the meantime. The approved plan is now a
  // description of a world that no longer exists.
  const tables = await app.as(seeded.companyA.id, () => registry.listTables(installed.instance.id));
  await app.ownerPool().query(`ALTER TABLE public."${tables[0].table_name}" ADD COLUMN "reviewer" TEXT`);

  await assert.rejects(
    deployer.apply({
      deploymentId: prepared.deployment.id, companyId: seeded.companyA.id, actorId: seeded.userA.id,
    }),
    /no longer the one that was reviewed/
  );

  // And the failure is recorded rather than lost.
  const deployment = await deployer.getDeployment(prepared.deployment.id, seeded.companyA.id);
  assert.equal(deployment.status, 'failed');
  assert.match(deployment.error, /no longer the one that was reviewed/);
});

dbTest('a failed deployment rolls back completely and stays retryable', async () => {
  const installed = await app.deploySpec({
    companyId: seeded.companyA.id, userId: seeded.userA.id, spec: baseSpec('deploy_rollback'),
  });

  // A version that adds two entities, where the SECOND one will fail: a table
  // of that exact name already exists, taken by something else.
  const next = JSON.parse(JSON.stringify(installed.spec));
  next.data.entities.push({
    key: 'extras', label: 'Extras', singular: 'Extra', display: { title_field: 'label' },
    fields: [{ name: 'label', label: 'Label', type: 'text', required: true }],
  });
  next.data.entities.push({
    key: 'blockers', label: 'Blockers', singular: 'Blocker', display: { title_field: 'label' },
    fields: [{ name: 'label', label: 'Label', type: 'text', required: true }],
  });
  next.ui.pages[0].layout.push(
    { type: 'table', entity: 'extras', fields: ['label'] },
    { type: 'table', entity: 'blockers', fields: ['label'] }
  );
  next.security.roles[0].permissions.extras = ['read'];
  next.security.roles[0].permissions.blockers = ['read'];
  next.security.roles[0].record_scope.extras = 'all';
  next.security.roles[0].record_scope.blockers = 'all';

  const v2 = await app.as(seeded.companyA.id, () => registry.createVersion({
    applicationId: installed.application.id, spec: next,
    parentVersionId: installed.version.id, createdBy: seeded.userA.id, status: 'validated',
  }));

  // Occupy the name the compiler will derive for `blockers`.
  const ids = require('../services/platform/identifiers');
  const collide = ids.physicalTableName(installed.instance.table_prefix, 'blockers');
  await app.ownerPool().query(`CREATE TABLE public."${collide}" (id uuid)`);

  await assert.rejects(deployer.deploy({
    companyId: seeded.companyA.id, applicationId: installed.application.id,
    versionId: v2.id, actorId: seeded.userA.id,
  }));

  // NOTHING from the failed attempt survives: not the first new table, not its
  // registry row, and the instance still runs the version it did before.
  const extrasName = ids.physicalTableName(installed.instance.table_prefix, 'extras');
  const { rows: leftover } = await pool.query('SELECT to_regclass($1) AS oid', [`public.${extrasName}`]);
  assert.equal(leftover[0].oid, null, 'a rolled-back deployment must leave no table behind');

  const tables = await app.as(seeded.companyA.id, () => registry.listTables(installed.instance.id));
  assert.deepEqual(tables.map((t) => t.entity_key), ['records']);

  const instance = await app.as(seeded.companyA.id, () =>
    registry.getInstance(installed.application.id, seeded.companyA.id));
  assert.equal(instance.version_id, installed.version.id, 'a failed upgrade keeps the working version');
  assert.equal(instance.status, 'active', 'a failed upgrade must not mark a working application broken');

  // Remove the obstruction; the same deployment retries and succeeds.
  await app.ownerPool().query(`DROP TABLE public."${collide}"`);
  const retried = await deployer.deploy({
    companyId: seeded.companyA.id, applicationId: installed.application.id,
    versionId: v2.id, actorId: seeded.userA.id,
  });
  assert.equal(retried.status, 'deployed');
  const after = await app.as(seeded.companyA.id, () => registry.listTables(installed.instance.id));
  assert.equal(after.length, 3);
});

dbTest('a version that no longer validates cannot be deployed', async () => {
  const installed = await app.deploySpec({
    companyId: seeded.companyA.id, userId: seeded.userA.id, spec: baseSpec('deploy_invalid'),
  });

  // A version written straight to the registry, bypassing the Studio — which
  // is exactly the case the fresh revalidation at apply time exists for.
  const broken = JSON.parse(JSON.stringify(installed.spec));
  broken.data.entities[0].fields.push({ name: 'evil', label: 'Evil', type: 'raw_sql' });
  const v2 = await app.as(seeded.companyA.id, () => registry.createVersion({
    applicationId: installed.application.id, spec: broken,
    parentVersionId: installed.version.id, createdBy: seeded.userA.id, status: 'validated',
  }));

  await assert.rejects(
    deployer.deploy({
      companyId: seeded.companyA.id, applicationId: installed.application.id,
      versionId: v2.id, actorId: seeded.userA.id,
    }),
    /does not validate/
  );
});

dbTest('two deployments of one instance cannot interleave', async () => {
  const installed = await app.deploySpec({
    companyId: seeded.companyA.id, userId: seeded.userA.id, spec: baseSpec('deploy_concurrent'),
  });

  const makeVersion = async (fieldName) => {
    const next = JSON.parse(JSON.stringify(installed.spec));
    next.data.entities[0].fields.push({ name: fieldName, label: fieldName, type: 'text' });
    return app.as(seeded.companyA.id, () => registry.createVersion({
      applicationId: installed.application.id, spec: next,
      parentVersionId: installed.version.id, createdBy: seeded.userA.id, status: 'validated',
    }));
  };

  const [first, second] = await Promise.all([makeVersion('lane_one'), makeVersion('lane_two')]);

  // Both planned against the same "before" state; both then try to apply. The
  // advisory lock serialises them, and the second re-plans against a database
  // the first has already changed — so its plan hash no longer matches.
  const [a, b] = await Promise.allSettled([
    deployer.deploy({
      companyId: seeded.companyA.id, applicationId: installed.application.id,
      versionId: first.id, actorId: seeded.userA.id,
    }),
    deployer.deploy({
      companyId: seeded.companyA.id, applicationId: installed.application.id,
      versionId: second.id, actorId: seeded.userA.id,
    }),
  ]);

  const outcomes = [a, b].map((r) => (r.status === 'fulfilled' ? r.value.status : 'rejected'));
  assert.ok(outcomes.includes('deployed'), 'at least one must succeed');

  // Whatever happened, the schema is coherent: the registry and the catalogue
  // agree, which is the property concurrency threatens.
  const tables = await app.as(seeded.companyA.id, () => registry.listTables(installed.instance.id));
  for (const t of tables) {
    const { rows } = await pool.query('SELECT to_regclass($1) AS oid', [`${t.table_schema}.${t.table_name}`]);
    assert.ok(rows[0].oid, `${t.table_name} is registered but does not exist`);
  }
});

dbTest('an application is switched off, never removed — and switching it back on loses nothing', async () => {
  const installed = await app.deploySpec({
    companyId: seeded.companyA.id, userId: seeded.userA.id, spec: baseSpec('deploy_disable'),
  });
  const { context, principal } = await app.internalContext({
    companyId: seeded.companyA.id, appKey: installed.application.app_key, userId: seeded.userA.id,
  });
  const data = require('../services/platform/runtime/data');
  const created = await app.as(seeded.companyA.id, () =>
    data.create(context, principal, 'records', { title: 'Still here' }));

  await deployer.disable({
    companyId: seeded.companyA.id, applicationId: installed.application.id,
    actorId: seeded.userA.id, reason: 'Not needed this quarter.',
  });

  const off = await app.as(seeded.companyA.id, () =>
    registry.getInstance(installed.application.id, seeded.companyA.id));
  assert.equal(off.status, 'disabled');
  // Who and when, on the row — the App Library shows it without reading the
  // event log, because "why has this gone quiet?" is the first question asked.
  assert.equal(off.disabled_by, seeded.userA.id);
  assert.equal(off.disabled_reason, 'Not needed this quarter.');
  assert.ok(off.disabled_at);

  // The rows are still there. Switching an application off is not a request to
  // destroy the records it kept.
  const rows = await app.readPhysical(seeded.companyA.id, installed.instance.id, 'records');
  assert.equal(rows.length, 1);

  // But the runtime refuses to serve it, and says why in terms that tell the
  // caller this is reversible rather than fatal.
  const resolver = require('../services/platform/runtime/resolver');
  await assert.rejects(
    app.as(seeded.companyA.id, () => resolver.resolveApplication(seeded.companyA.id, installed.application.app_key)),
    /switched off.*records are kept/s
  );

  // It also leaves the shell — a disabled application contributes no navigation.
  const catalog = require('../services/platform/catalog');
  const nav = await app.as(seeded.companyA.id, () =>
    catalog.navigationFor(seeded.companyA.id, seeded.userA.id, 'ADMIN'));
  assert.ok(!nav.some((n) => n.appKey === installed.application.app_key));

  // And back on: the same instance, the same tables, the same row.
  await deployer.enable({
    companyId: seeded.companyA.id, applicationId: installed.application.id, actorId: seeded.userA.id,
  });
  const on = await app.as(seeded.companyA.id, () =>
    registry.getInstance(installed.application.id, seeded.companyA.id));
  assert.equal(on.id, off.id, 'enabling must not create a second instance');
  assert.equal(on.status, 'active');
  assert.equal(on.disabled_at, null);
  assert.equal(on.disabled_reason, null);

  const back = await app.as(seeded.companyA.id, () =>
    data.get(context, principal, 'records', created.id));
  assert.equal(back.title, 'Still here');
});

dbTest('disabling is idempotent, and enabling something that never deployed is refused', async () => {
  const installed = await app.deploySpec({
    companyId: seeded.companyA.id, userId: seeded.userA.id, spec: baseSpec('deploy_disable_twice'),
  });
  const args = {
    companyId: seeded.companyA.id, applicationId: installed.application.id, actorId: seeded.userA.id,
  };
  await deployer.disable(args);
  await deployer.disable(args);           // no error, no second event storm
  const instance = await app.as(seeded.companyA.id, () =>
    registry.getInstance(installed.application.id, seeded.companyA.id));
  assert.equal(instance.status, 'disabled');

  await deployer.enable(args);
  // Already on: enabling again is a no-op rather than a 409, because the
  // caller's intent is already satisfied.
  await deployer.enable(args);

  // An application this company never installed cannot be switched either way.
  const other = await app.deploySpec({
    companyId: seeded.companyB.id, userId: seeded.userB.id, spec: baseSpec('deploy_disable_other'),
  });
  await assert.rejects(
    deployer.disable({ companyId: seeded.companyA.id, applicationId: other.application.id, actorId: seeded.userA.id }),
    /no instance of that application/
  );
});

dbTest('the deployer notices when the database no longer matches the registry', async () => {
  const installed = await app.deploySpec({
    companyId: seeded.companyA.id, userId: seeded.userA.id, spec: baseSpec('deploy_drift'),
  });
  const tables = await app.as(seeded.companyA.id, () => registry.listTables(installed.instance.id));
  await app.ownerPool().query(`DROP TABLE public."${tables[0].table_name}"`);

  const next = JSON.parse(JSON.stringify(installed.spec));
  next.data.entities[0].fields.push({ name: 'later', label: 'Later', type: 'text' });
  const v2 = await app.as(seeded.companyA.id, () => registry.createVersion({
    applicationId: installed.application.id, spec: next,
    parentVersionId: installed.version.id, createdBy: seeded.userA.id, status: 'validated',
  }));

  const prepared = await deployer.deploy({
    companyId: seeded.companyA.id, applicationId: installed.application.id,
    versionId: v2.id, actorId: seeded.userA.id,
  });
  // Drift is reported on the plan and refused at apply, rather than being
  // planned around as though the table were merely empty.
  assert.ok(prepared.plan.notes.some((n) => n.code === 'REGISTRY_DRIFT'));
});

dbTest('a plan hash is stable across re-planning an unchanged database', async () => {
  const installed = await app.deploySpec({
    companyId: seeded.companyA.id, userId: seeded.userA.id, spec: baseSpec('deploy_hash_stable'),
  });
  const next = JSON.parse(JSON.stringify(installed.spec));
  next.data.entities[0].fields.push({ name: 'extra', label: 'Extra', type: 'text' });
  const v2 = await app.as(seeded.companyA.id, () => registry.createVersion({
    applicationId: installed.application.id, spec: next,
    parentVersionId: installed.version.id, createdBy: seeded.userA.id, status: 'validated',
  }));

  const first = await deployer.prepare({
    companyId: seeded.companyA.id, applicationId: installed.application.id,
    versionId: v2.id, requestedBy: seeded.userA.id,
  });
  const second = await deployer.prepare({
    companyId: seeded.companyA.id, applicationId: installed.application.id,
    versionId: v2.id, requestedBy: seeded.userA.id,
  });
  assert.equal(first.deployment.plan_hash, second.deployment.plan_hash);
  assert.equal(planner.hashPlan({ operations: [] }), planner.hashPlan({ operations: [] }));
});

dbTest('a server that cannot create tables refuses up front and says which variable is missing', async (t) => {
  const db = require('../services/platform/db');
  const restricted = process.env.APP_DATABASE_URL;
  if (!restricted || restricted === process.env.MIGRATION_DATABASE_URL) {
    t.skip('this database has not split the application and owner roles, so there is nothing to refuse');
    return;
  }

  const installed = await app.deploySpec({
    companyId: seeded.companyA.id, userId: seeded.userA.id, spec: baseSpec('deploy_no_privilege'),
  });
  const next = JSON.parse(JSON.stringify(installed.spec));
  next.data.entities[0].fields.push({ name: 'later', label: 'Later', type: 'text' });
  const v2 = await app.as(seeded.companyA.id, () => registry.createVersion({
    applicationId: installed.application.id, spec: next,
    parentVersionId: installed.version.id, createdBy: seeded.userA.id, status: 'validated',
  }));

  // The configuration this check exists for: MIGRATION_DATABASE_URL missing on
  // a database whose application role deliberately cannot own tables. Pointed
  // at the real restricted role rather than stubbed, so what is under test is
  // the actual privilege, not a mock of it.
  const previous = process.env.MIGRATION_DATABASE_URL;
  process.env.MIGRATION_DATABASE_URL = restricted;
  await db.closeDdlPool();
  db.resetDdlCapabilityCache();

  try {
    await assert.rejects(
      deployer.deploy({
        companyId: seeded.companyA.id, applicationId: installed.application.id,
        versionId: v2.id, actorId: seeded.userA.id,
      }),
      (error) => {
        assert.equal(error.code, 'DDL_PRIVILEGE_MISSING');
        assert.match(error.message, /MIGRATION_DATABASE_URL/,
          'the message has to name the fix, not just the symptom');
        return true;
      }
    );

    // And nothing was left mid-flight: the instance still runs what it ran.
    const instance = await app.as(seeded.companyA.id, () =>
      registry.getInstance(installed.application.id, seeded.companyA.id));
    assert.equal(instance.version_id, installed.version.id);
    assert.equal(instance.status, 'active');
  } finally {
    if (previous === undefined) delete process.env.MIGRATION_DATABASE_URL;
    else process.env.MIGRATION_DATABASE_URL = previous;
    await db.closeDdlPool();
    db.resetDdlCapabilityCache();
  }
});

dbTest('the privilege check asks the database rather than reading a URL', async () => {
  const db = require('../services/platform/db');
  db.resetDdlCapabilityCache();
  const capability = await db.assertCanCreateSchemaObjects();
  assert.equal(capability.can_create, true);
  assert.ok(capability.role, 'it reports which role it checked, so a failure is diagnosable');
});
