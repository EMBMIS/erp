// Simeli reading generated applications.
//
// THE CLAIM UNDER TEST
// ===========================================================================
//     Simeli can answer questions about an application this company built last
//     week — what it is, what it holds, how its process runs — and answers them
//     AS THE PERSON ASKING. A question is not an escalation, and there is no
//     tool here that writes or deploys anything.
//
// Run on its own:  node --test tests/platformSimeli.test.js

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

const { pool } = require('../config/database');
const seedHelper = require('./helpers/platformSeed');
const app = require('./helpers/platformApp');
const { platformTools } = require('../services/ai/platformTools');
const catalog = require('../services/platform/catalog');
const data = require('../services/platform/runtime/data');
const companyContext = require('../services/companyContext');

let available = false;
let seeded = null;
let built = null;

const dbTest = (name, fn) => test(name, async (t) => {
  if (!available) { t.skip('no database with the platform schema'); return; }
  await fn(t);
});

const tool = (name) => platformTools.find((t) => t.name === name);

/** Call a tool the way the agent does: inside the company, as a named user. */
const call = (name, args, ctx) => companyContext.runWithCompany(
  seeded.companyA.id, () => tool(name).handler(args, ctx)
);

before(async () => {
  available = await app.platformAvailable();
  if (!available) return;
  seeded = await seedHelper.seed();

  const session = require('../services/platform/studio/session');
  const started = await session.start({
    companyId: seeded.companyA.id, userId: seeded.userA.id,
    requirement: 'Build a supplier quality management application where our employees manage findings '
      + 'and suppliers can respond to their own findings in a portal.',
  });
  await session.deploy({ companyId: seeded.companyA.id, sessionId: started.session.id, userId: seeded.userA.id });
  built = started;

  const { context, principal } = await app.internalContext({
    companyId: seeded.companyA.id, appKey: built.application.app_key, userId: seeded.userA.id,
  });
  await app.as(seeded.companyA.id, () => data.create(context, principal, 'quality_findings', {
    reference: `SIM-${seeded.run}`, title: 'Surface finish out of specification',
    detail: 'Roughness measured at twice the drawing limit.',
    supplier_id: seeded.suppliersA[0].id, category: 'PRODUCT', severity: 'HIGH',
    raised_on: '2026-09-01', cost_impact: 5400, internal_assessment: 'Repeat problem.',
  }));
});

after(async () => {
  if (seeded) await seedHelper.cleanup(seeded);
  await app.closeOwnerPool();
  await pool.end().catch(() => {});
});

const AS_ADMIN = { userId: null, userRole: 'ADMIN' };

// ---------------------------------------------------------------------------
dbTest('every platform tool is read-only', () => {
  assert.ok(platformTools.length >= 5);
  platformTools.forEach((t) => {
    assert.equal(t.readOnly, true, `${t.name} must be read-only`);
  });
  // And there is no write tool hiding among them.
  const names = platformTools.map((t) => t.name);
  ['create_application', 'deploy_application', 'update_application_record', 'run_migration']
    .forEach((forbidden) => assert.ok(!names.includes(forbidden), forbidden));
});

dbTest('Simeli can list what this company had built for itself', async () => {
  const result = await call('list_applications', {});
  const entry = result.applications.find((a) => a.key === built.application.app_key);
  assert.ok(entry, 'an application deployed this morning must be findable this afternoon');
  assert.ok(entry.owns.some((e) => e.entity === 'quality_findings'));
  assert.ok(entry.owns.some((e) => e.belongs_to === 'supplier'));
  assert.ok(entry.reads_embmis_data.includes('suppliers'));
  assert.deepEqual(entry.external_portals, ['supplier']);
  assert.ok(entry.workflows.some((w) => w.includes('→')));

  const searched = await call('list_applications', { search: 'quality findings supplier' });
  assert.ok(searched.applications.some((a) => a.key === built.application.app_key));
});

dbTest('Simeli can read records from a generated application', async () => {
  const result = await call('query_application_records', {
    application: built.application.app_key, entity: 'quality_findings', limit: 10,
  }, { userId: seeded.userA.id, userRole: 'ADMIN' });

  assert.equal(result.total, 1);
  assert.match(result.records[0].title, /Surface finish/);
  assert.match(result.records[0].supplier_id__label, /Northgate/);
});

dbTest('Simeli answers as the person asking, not as an administrator', async () => {
  // A user with no role in the application gets nothing, from a tool call as
  // much as from the API. A question put to a chat window is not a way to read
  // past your own permissions.
  await assert.rejects(
    call('query_application_records', {
      application: built.application.app_key, entity: 'quality_findings',
    }, { userId: seeded.contributorA.id, userRole: 'USER' }),
    /no role in this application/
  );

  // Given a restricted role, the restrictions apply.
  await catalog.assignRole({
    companyId: seeded.companyA.id, appKey: built.application.app_key,
    userId: seeded.contributorA.id, roleKey: 'contributor', grantedBy: seeded.userA.id,
  });
  const asContributor = await call('query_application_records', {
    application: built.application.app_key, entity: 'quality_findings',
  }, { userId: seeded.contributorA.id, userRole: 'USER' });
  assert.equal(asContributor.total, 1);
});

dbTest('a tool call with nobody attached is refused rather than defaulted', async () => {
  await assert.rejects(
    call('query_application_records', {
      application: built.application.app_key, entity: 'quality_findings',
    }, AS_ADMIN),
    /needs to know who that is/,
    'falling back to an administrator view would make Simeli an escalation path'
  );
});

dbTest('Simeli reads the application\'s own measures rather than counting itself', async () => {
  const result = await call('application_measures', {
    application: built.application.app_key,
  }, { userId: seeded.userA.id, userRole: 'ADMIN' });
  assert.ok(result.measures.length >= 3);
  const total = result.measures.find((m) => m.key.endsWith('_total'));
  assert.ok(total && total.value >= 1);

  const spec = built.spec;
  const grouped = spec.analytics.queries.find((q) => q.group_by);
  const breakdown = await call('application_measures', {
    application: built.application.app_key, query: grouped.key,
  }, { userId: seeded.userA.id, userRole: 'ADMIN' });
  assert.equal(breakdown.grouped, true);
  assert.ok(Array.isArray(breakdown.rows));
});

dbTest('Simeli can explain how a process actually runs', async () => {
  const result = await call('explain_application', { application: built.application.app_key });

  assert.equal(result.application.key, built.application.app_key);
  const findings = result.data.find((e) => e.entity === 'quality_findings');
  assert.match(findings.belongs_to, /belongs to one supplier/);

  // "Why can't the supplier see the cost?" is a question this answers.
  const cost = findings.fields.find((f) => f.name === 'cost_impact');
  assert.equal(cost.internal_only, true);

  // "Who has to approve closing a finding?" is another.
  const workflow = result.workflows.find((w) => w.entity === 'quality_findings');
  const close = workflow.transitions.find((t) => /clos/i.test(t.label));
  assert.ok(close.requires.some((r) => r.startsWith('approval')));

  assert.ok(result.who_uses_it.some((s) => s.audience === 'supplier'));
  assert.ok(result.permissions.some((p) => p.audience === 'supplier' && p.sees.quality_findings === 'anchor'));
  assert.ok(result.automations.length >= 1);
});

dbTest('Simeli cannot explain another company\'s application', async () => {
  const theirs = await app.deploySpec({
    companyId: seeded.companyB.id, userId: seeded.userB.id,
    spec: app.composeFromRequirement('Build a fleet maintenance application'),
  });
  await assert.rejects(
    call('explain_application', { application: theirs.application.app_key }),
    /has no application|No such application|not deployed for this company/
  );
});

dbTest('Simeli surfaces capability gaps as proposals, and says they are proposals', async () => {
  const result = await call('list_capability_opportunities', {});
  assert.ok(Array.isArray(result.opportunities));
  assert.match(result.note, /Nothing here is built or scheduled/);
});

dbTest('an unknown application or entity is refused, not guessed at', async () => {
  await assert.rejects(
    call('query_application_records', { application: 'not_an_app', entity: 'things' },
      { userId: seeded.userA.id, userRole: 'ADMIN' }),
    /has no application/
  );
  await assert.rejects(
    call('query_application_records', { application: built.application.app_key, entity: 'users' },
      { userId: seeded.userA.id, userRole: 'ADMIN' }),
    /has no entity/
  );
  await assert.rejects(
    call('query_application_records', {
      application: built.application.app_key, entity: 'quality_findings',
      filters: [{ field: 'password', operator: 'eq', value: 'x' }],
    }, { userId: seeded.userA.id, userRole: 'ADMIN' }),
    /is not a field/
  );
});
