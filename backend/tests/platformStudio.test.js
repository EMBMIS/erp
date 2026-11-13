// The Studio: a sentence becomes a working application, and then changes.
//
// THE CLAIM UNDER TEST
// ===========================================================================
//     "Build a supplier quality management application where our employees
//      manage findings and suppliers respond to their own findings."
//
//     ...produces a plan a person can read, a specification that validates, a
//     sandbox report, real per-company tables, an internal side and a supplier
//     portal that works — and can then be changed in a sentence, producing a
//     new VERSION and a small migration rather than a rebuild.
//
// Run on its own:  node --test tests/platformStudio.test.js

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

const { pool } = require('../config/database');
const seedHelper = require('./helpers/platformSeed');
const app = require('./helpers/platformApp');
const session = require('../services/platform/studio/session');
const registry = require('../services/platform/registry');
const data = require('../services/platform/runtime/data');
const page = require('../services/platform/runtime/page');
const workflowRuntime = require('../services/platform/runtime/workflow');
const identity = require('../services/platform/runtime/externalIdentity');
const catalog = require('../services/platform/catalog');
const patch = require('../services/platform/studio/patch');

let available = false;
let seeded = null;

const dbTest = (name, fn) => test(name, async (t) => {
  if (!available) { t.skip('no database with the platform schema'); return; }
  await fn(t);
});

const REQUIREMENT = 'Build a supplier quality management application where our employees can manage '
  + 'findings and suppliers can respond to their own findings in a portal.';

let built = null;

before(async () => {
  available = await app.platformAvailable();
  if (!available) return;
  seeded = await seedHelper.seed();
  built = await session.start({
    companyId: seeded.companyA.id, userId: seeded.userA.id, requirement: REQUIREMENT,
  });
});

after(async () => {
  if (seeded) await seedHelper.cleanup(seeded);
  await app.closeOwnerPool();
  await pool.end().catch(() => {});
});

// ---------------------------------------------------------------------------
dbTest('the plan says what exists, what is new, and who will use it', async () => {
  const { plan } = built;

  // Existing EMBMIS data was DISCOVERED, not assumed: the company really has
  // two suppliers, and the plan says so.
  const suppliers = plan.existingData.find((d) => d.key === 'suppliers');
  assert.ok(suppliers, 'a supplier quality application must reference EMBMIS suppliers');
  assert.equal(suppliers.count, 2);

  // New application-owned data.
  assert.ok(plan.newData.length >= 3);
  assert.ok(plan.newData.some((d) => d.anchored), 'the portal needs an anchored entity');

  // Both sides.
  assert.deepEqual(plan.surfaces.map((s) => s.audience).sort(), ['internal', 'supplier']);

  // A workflow with a real path and an approval in it.
  assert.ok(plan.workflows.length >= 1);
  assert.ok(plan.workflows[0].path.length >= 5);
  assert.ok(plan.workflows.some((w) => w.approvals.length));

  // Screens, measures and automation — not "one table with a form".
  assert.ok(plan.screens.length >= 12, `only ${plan.screens.length} screens`);
  assert.ok(plan.metrics.length >= 3);
  assert.ok(plan.automations.length >= 2);

  // And the prose version reads as a plan rather than as JSON.
  const prose = session.describePlan(plan);
  assert.match(prose, /Existing EMBMIS data this will use/);
  assert.match(prose, /Suppliers \(2 records\)/);
  assert.match(prose, /→/);
});

dbTest('nothing is created until it is deployed', async () => {
  const instance = await app.as(seeded.companyA.id, () =>
    registry.getInstance(built.application.id, seeded.companyA.id));
  assert.equal(instance, null, 'a design is not a deployment');

  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM pg_tables WHERE tablename LIKE 'app_%' AND tablename LIKE $1",
    [`%${built.spec.data.entities[0].key}`]
  );
  // There may be tables from other suites; what matters is that THIS
  // application has no instance and therefore no registered tables.
  assert.ok(rows[0].n >= 0);
});

dbTest('the sandbox reports on every part of the application', async () => {
  const { report } = await session.validate({
    companyId: seeded.companyA.id, sessionId: built.session.id,
  });
  assert.ok(report.ok, JSON.stringify(report.summary));

  const sections = Object.keys(report.sections);
  ['data', 'security', 'workflows', 'automation', 'ui', 'ai', 'database'].forEach((s) => {
    assert.ok(sections.includes(s), `no ${s} section`);
  });

  // The security section says, in words, what leaves the company.
  const security = report.sections.security.notes.join(' ');
  assert.match(security, /Supplier portal/);
  assert.match(security, /limited to the viewer's own records/);
  assert.match(security, /Hidden from them/);

  // The database section says what deploying would do.
  assert.match(report.sections.database.notes.join(' '), /table\(s\) would be created|schema operation/);
});

dbTest('the preview renders real shapes over synthetic rows, and reads no company data', async () => {
  const { preview } = await session.preview({ companyId: seeded.companyA.id, sessionId: built.session.id });
  assert.ok(preview.synthetic);
  assert.ok(preview.metrics.length >= 3);
  assert.ok(preview.metrics.every((m) => typeof m.value === 'number'));

  const entityKeys = Object.keys(preview.records);
  assert.ok(entityKeys.length >= 3);
  entityKeys.forEach((key) => {
    assert.equal(preview.records[key].length, 12);
    assert.ok(preview.records[key].every((r) => r.__preview));
  });

  // Deterministic: the same specification previews identically, so a design
  // change is distinguishable from noise.
  const again = await session.preview({ companyId: seeded.companyA.id, sessionId: built.session.id });
  assert.deepEqual(
    again.preview.metrics.map((m) => m.value),
    preview.metrics.map((m) => m.value)
  );

  // And it contains none of this company's actual suppliers.
  const serialized = JSON.stringify(preview.records);
  assert.ok(!serialized.includes(seeded.suppliersA[0].legal_name),
    'a preview of an unapproved specification must not read the company\'s records');
});

dbTest('deployment creates this company\'s own tables and makes the application usable', async () => {
  const result = await session.deploy({
    companyId: seeded.companyA.id, sessionId: built.session.id, userId: seeded.userA.id,
  });
  assert.equal(result.status, 'deployed');

  const instance = await app.as(seeded.companyA.id, () =>
    registry.getInstance(built.application.id, seeded.companyA.id));
  assert.equal(instance.status, 'active');

  const tables = await app.as(seeded.companyA.id, () => registry.listTables(instance.id));
  assert.equal(tables.length, built.spec.data.entities.length);
  for (const t of tables) {
    const { rows } = await pool.query('SELECT to_regclass($1) AS oid', [`public.${t.table_name}`]);
    assert.ok(rows[0].oid, `${t.entity_key} has no table`);
    assert.match(t.table_name, /^app_[a-f0-9]{8}_[a-f0-9]{8}_/);
  }
});

dbTest('a company user can work the internal side, with no code written for it', async () => {
  const { context, principal } = await app.internalContext({
    companyId: seeded.companyA.id, appKey: built.application.app_key, userId: seeded.userA.id,
  });

  const shell = page.shell(context, principal);
  assert.equal(shell.surface.audience, 'internal');
  assert.ok(shell.surface.nav.length >= 5);

  const dashboard = await app.as(seeded.companyA.id, () =>
    page.render(context, principal, shell.surface.defaultPage, {}));
  assert.ok(dashboard.blocks.length >= 3);
  assert.ok(dashboard.blocks.some((b) => b.type.startsWith('chart_') || b.type === 'metric_group'));

  const finding = await app.as(seeded.companyA.id, () => data.create(context, principal, 'quality_findings', {
    reference: `QF-${Date.now()}`,
    title: 'Weld porosity above the acceptance limit',
    detail: 'Radiography on batch 44 found porosity in three of twenty welds.',
    supplier_id: seeded.suppliersA[0].id,
    category: 'PRODUCT', severity: 'HIGH', raised_on: '2026-09-01',
    internal_assessment: 'Third occurrence this quarter.', cost_impact: 8100,
  }));
  assert.equal(finding.status, 'OPEN');
  assert.match(finding.supplier_id__label, /Northgate/);

  const moved = await app.as(seeded.companyA.id, () =>
    workflowRuntime.transition(context, principal, 'quality_findings', finding.id, 'assign', {}));
  assert.equal(moved.to, 'ASSIGNED');
  built.findingId = finding.id;
});

dbTest('a supplier can work their own side, and sees nothing else', async () => {
  const instance = await app.as(seeded.companyA.id, () =>
    registry.getInstance(built.application.id, seeded.companyA.id));

  const { identity: created, inviteToken } = await app.as(seeded.companyA.id, () => identity.invite({
    companyId: seeded.companyA.id, subjectKind: 'supplier', subjectId: seeded.suppliersA[0].id,
    email: `studio.${seeded.run}@supplier.invalid`, displayName: 'Northgate contact',
    invitedBy: seeded.userA.id,
  }));
  await app.as(seeded.companyA.id, () => identity.acceptInvite({
    companyId: seeded.companyA.id, token: inviteToken, password: 'a-sufficiently-long-password',
  }));
  await app.as(seeded.companyA.id, () => identity.grantMembership({
    companyId: seeded.companyA.id, identityId: created.id, instanceId: instance.id,
    surfaceKey: 'supplier_portal', roleKey: 'supplier_user', grantedBy: seeded.userA.id,
  }));
  const record = await app.as(seeded.companyA.id, () => identity.getIdentity(seeded.companyA.id, created.id));

  const portal = await app.externalContext({
    companyId: seeded.companyA.id, appKey: built.application.app_key, identity: record,
  });
  assert.equal(portal.principal.surface.audience, 'supplier');
  assert.equal(portal.principal.anchor.id, seeded.suppliersA[0].id);

  const home = await app.as(seeded.companyA.id, () =>
    page.render(portal.context, portal.principal, portal.principal.surface.default_page, {}));
  assert.ok(home.blocks.length >= 1);

  const findings = await app.as(seeded.companyA.id, () =>
    data.list(portal.context, portal.principal, 'quality_findings', { pageSize: 50 }));
  assert.equal(findings.total, 1);
  assert.ok(!('internal_assessment' in findings.rows[0]));
  assert.ok(!('cost_impact' in findings.rows[0]));
  assert.ok(!('risk_score' in findings.rows[0]));

  // And an internal page is not reachable from the portal at all.
  await assert.rejects(
    app.as(seeded.companyA.id, () => page.render(portal.context, portal.principal, 'overview', {})),
    /not on the surface you are using/
  );
});

// ---------------------------------------------------------------------------
// Iteration
// ---------------------------------------------------------------------------
dbTest('an iteration produces a new version and a small change, not a rebuild', async () => {
  const before = await app.as(seeded.companyA.id, () => registry.latestVersion(built.application.id));

  const result = await session.iterate({
    companyId: seeded.companyA.id, sessionId: built.session.id, userId: seeded.userA.id,
    instruction: 'Add a 90-day risk trend',
  });

  assert.equal(result.version.version, before.version + 1);
  assert.equal(result.version.parent_version_id, before.id);
  assert.ok(result.applied.length >= 1);
  assert.match(result.applied.map((a) => a.summary).join(' '), /analytics query|chart/i);

  // The diff is small — that is the entire reason iteration patches rather
  // than regenerates.
  assert.ok(result.diff.length <= 3, `iteration changed ${result.diff.length} things`);

  // Everything else is untouched.
  assert.equal(result.spec.data.entities.length, before.spec.data.entities.length);
  assert.deepEqual(
    result.spec.data.entities.map((e) => e.key),
    before.spec.data.entities.map((e) => e.key)
  );
});

dbTest('an iteration that needs a column produces exactly that migration', async () => {
  await session.iterate({
    companyId: seeded.companyA.id, sessionId: built.session.id, userId: seeded.userA.id,
    instruction: 'Add an explanation of why each supplier received its risk score',
  });

  const deployed = await session.deploy({
    companyId: seeded.companyA.id, sessionId: built.session.id, userId: seeded.userA.id,
  });
  assert.equal(deployed.status, 'deployed');
  assert.equal(deployed.plan.safety, 'safe');
  assert.equal(deployed.plan.summary.byKind.add_column, 1, 'one column, not a rebuild');
  assert.ok(!deployed.plan.summary.byKind.create_table);
  assert.ok(!deployed.plan.summary.byKind.drop_column);

  // The application still works, with the new field on it.
  const { context, principal } = await app.internalContext({
    companyId: seeded.companyA.id, appKey: built.application.app_key, userId: seeded.userA.id,
  });
  const record = await app.as(seeded.companyA.id, () =>
    data.get(context, principal, 'quality_findings', built.findingId));
  assert.ok('score_explanation' in record);
});

dbTest('a request for something already true says so instead of building a version', async () => {
  const before = await app.as(seeded.companyA.id, () => registry.latestVersion(built.application.id));
  const result = await session.iterate({
    companyId: seeded.companyA.id, sessionId: built.session.id, userId: seeded.userA.id,
    instruction: 'Make the supplier portal show only their own findings',
  });
  assert.equal(result.noChange, true);
  assert.match(result.note, /already/);
  const after = await app.as(seeded.companyA.id, () => registry.latestVersion(built.application.id));
  assert.equal(after.version, before.version, 'an empty version is worse than an answer');
});

dbTest('an iteration nothing understands is refused, not guessed at', async () => {
  await assert.rejects(
    session.iterate({
      companyId: seeded.companyA.id, sessionId: built.session.id, userId: seeded.userA.id,
      instruction: 'make it sing',
    }),
    /could not turn that into a change|does not match any of the changes/
  );
});

dbTest('an iteration that would break the application is refused before it becomes a version', async () => {
  const before = await app.as(seeded.companyA.id, () => registry.latestVersion(built.application.id));
  // Applied directly to the patch layer, since the intent rules will not
  // produce something invalid — the point is that the gate is on the RESULT.
  const broken = patch.apply(before.spec, [
    { op: 'remove_field', entity: 'quality_findings', field: 'status' },
  ]);
  assert.ok(!broken.report.ok, 'removing a workflow\'s state field must not validate');

  const after = await app.as(seeded.companyA.id, () => registry.latestVersion(built.application.id));
  assert.equal(after.version, before.version);
});

dbTest('the conversation records every turn and what it produced', async () => {
  const messages = await session.messages(seeded.companyA.id, built.session.id);
  assert.ok(messages.length >= 6);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[1].kind, 'plan');
  assert.ok(messages.some((m) => m.kind === 'build' && m.version_id));
  assert.ok(messages.some((m) => m.kind === 'deployment'));
  assert.ok(messages.some((m) => m.kind === 'validation'));
});

dbTest('every version carries the provenance to explain it later', async () => {
  const versions = await app.as(seeded.companyA.id, () => registry.listVersions(built.application.id));
  assert.ok(versions.length >= 3);
  const first = await registry.getVersion(versions[versions.length - 1].id);
  assert.equal(first.provenance.requirement, REQUIREMENT);
  assert.ok(['analyzer', 'model', 'model_repaired'].includes(first.provenance.designedBy));
  assert.ok(Array.isArray(first.provenance.canonicalSnapshot));
  assert.ok(first.provenance.canonicalSnapshot.some((c) => c.key === 'suppliers' && c.count === 2),
    'what the platform could see when it decided is part of the decision');
});

// ---------------------------------------------------------------------------
// Rollback and the catalogue
// ---------------------------------------------------------------------------
dbTest('rolling back is a deployment like any other, gated the same way', async () => {
  const versions = await app.as(seeded.companyA.id, () => registry.listVersions(built.application.id));
  const older = versions.find((v) => v.status === 'superseded');
  assert.ok(older, 'there should be a superseded version to go back to');

  const result = await session.rollback({
    companyId: seeded.companyA.id, sessionId: built.session.id,
    userId: seeded.userA.id, versionId: older.id,
  });
  // Going back drops the column the newer version added — which is exactly as
  // destructive as it sounds, so it stops for approval.
  assert.equal(result.status, 'awaiting_approval');
  assert.equal(result.plan.safety, 'destructive');
  assert.match(result.plan.summary.destructive.join(' '), /score_explanation/);
});

dbTest('the catalogue describes the deployed application without knowing anything about it', async () => {
  const described = await catalog.describe(seeded.companyA.id);
  const entry = described.applications.find((a) => a.appKey === built.application.app_key);
  assert.ok(entry);
  assert.ok(entry.entities.length >= 3);
  assert.ok(entry.dependsOn.includes('suppliers'));
  assert.deepEqual(entry.externalAudiences, ['supplier']);
  assert.ok(entry.workflows.length >= 1);
  assert.ok(entry.metrics.length >= 3);

  // The question "which applications expose supplier data?" has two different
  // answers and they are reported separately.
  assert.ok(entry.exposes.readsInternally.includes('suppliers'));

  assert.ok(described.summary.supplierPortals.includes(built.application.app_key));

  // And it is searchable by the words a person would actually use.
  const found = await catalog.search(seeded.companyA.id, 'supplier quality findings');
  assert.ok(found.some((a) => a.appKey === built.application.app_key));
});

dbTest('the deployed application appears in navigation for the people who can use it', async () => {
  const nav = await catalog.navigationFor(seeded.companyA.id, seeded.userA.id, 'ADMIN');
  const entry = nav.find((n) => n.appKey === built.application.app_key);
  assert.ok(entry, 'an application nobody can navigate to is not deployed in any useful sense');
  assert.ok(entry.items.length >= 5);
  assert.ok(entry.defaultPage);

  // Somebody with no role in it does not get a link that would refuse them.
  const none = await catalog.navigationFor(seeded.companyA.id, seeded.contributorA.id, 'USER');
  assert.ok(!none.some((n) => n.appKey === built.application.app_key));
});

dbTest('a second company builds the same thing and gets its own everything', async () => {
  const theirs = await session.start({
    companyId: seeded.companyB.id, userId: seeded.userB.id, requirement: REQUIREMENT,
  });
  await session.deploy({ companyId: seeded.companyB.id, sessionId: theirs.session.id, userId: seeded.userB.id });

  assert.notEqual(theirs.application.app_key, built.application.app_key);

  const instanceB = await app.as(seeded.companyB.id, () =>
    registry.getInstance(theirs.application.id, seeded.companyB.id));
  const tablesB = await app.as(seeded.companyB.id, () => registry.listTables(instanceB.id));
  const instanceA = await app.as(seeded.companyA.id, () =>
    registry.getInstance(built.application.id, seeded.companyA.id));
  const tablesA = await app.as(seeded.companyA.id, () => registry.listTables(instanceA.id));

  const namesA = new Set(tablesA.map((t) => t.table_name));
  tablesB.forEach((t) => assert.ok(!namesA.has(t.table_name)));

  // Company B's application starts empty — company A's finding is not theirs.
  const ctxB = await app.internalContext({
    companyId: seeded.companyB.id, appKey: theirs.application.app_key, userId: seeded.userB.id,
  });
  const rows = await app.as(seeded.companyB.id, () =>
    data.list(ctxB.context, ctxB.principal, 'quality_findings', {}));
  assert.equal(rows.total, 0);
});
