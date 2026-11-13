// Isolation: between companies, between applications, and between the parties
// outside a company.
//
// THE CLAIM UNDER TEST
// ===========================================================================
//     Company A cannot reach company B's application data. Application A
//     cannot reach application B's tables. A supplier sees their own records
//     and no other supplier's, and none of the company's internal assessment
//     of them. None of that rests on a WHERE clause somebody remembered.
//
// These tests run against a database with company isolation ENABLED and the
// application connected as the unprivileged role, because that is the only
// configuration in which they mean anything. Run on its own:
//     node --test tests/platformTenancy.test.js

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

const { pool } = require('../config/database');
const companyContext = require('../services/companyContext');
const seedHelper = require('./helpers/platformSeed');
const app = require('./helpers/platformApp');
const data = require('../services/platform/runtime/data');
const analytics = require('../services/platform/runtime/analytics');
const collaboration = require('../services/platform/runtime/collaboration');
const workflowRuntime = require('../services/platform/runtime/workflow');
const registry = require('../services/platform/registry');
const identity = require('../services/platform/runtime/externalIdentity');
const resolver = require('../services/platform/runtime/resolver');

let available = false;
let isolated = false;
let seeded = null;

const dbTest = (name, fn) => test(name, async (t) => {
  if (!available) { t.skip('no database with the platform schema'); return; }
  await fn(t);
});

const PORTAL_SPEC = {
  key: 'tenancy_probe',
  name: 'Tenancy Probe',
  description: 'A supplier portal, for testing what does not cross.',
  data: {
    canonical_refs: ['suppliers'],
    entities: [{
      key: 'findings', label: 'Findings', singular: 'Finding',
      display: { title_field: 'title' },
      anchor: { field: 'supplier_id', kind: 'supplier' },
      fields: [
        { name: 'title', label: 'Title', type: 'text', required: true },
        { name: 'supplier_id', label: 'Supplier', type: 'reference', required: true, indexed: true,
          target: { kind: 'canonical', entity: 'suppliers', on_delete: 'restrict' } },
        { name: 'status', label: 'Status', type: 'enum', required: true, default: 'OPEN', values: ['OPEN', 'CLOSED'] },
        { name: 'internal_assessment', label: 'Internal assessment', type: 'long_text', sensitive: true },
        { name: 'cost_impact', label: 'Cost impact', type: 'money', sensitive: true },
      ],
    }],
  },
  workflows: [{
    key: 'finding_flow', label: 'Flow', entity: 'findings', state_field: 'status',
    states: [{ key: 'OPEN', label: 'Open', initial: true }, { key: 'CLOSED', label: 'Closed', terminal: true }],
    transitions: [{ key: 'close', label: 'Close', from: 'OPEN', to: 'CLOSED', requires: [{ type: 'role', role: 'manager' }] }],
  }],
  security: {
    roles: [
      { key: 'manager', label: 'Manager', audience: 'internal',
        permissions: { findings: ['read', 'create', 'update', 'delete'], suppliers: ['read'] },
        record_scope: { findings: 'all' } },
      { key: 'supplier_user', label: 'Supplier', audience: 'supplier',
        permissions: { findings: ['read', 'update'], suppliers: ['read'] },
        record_scope: { findings: 'anchor' },
        field_access: { findings: { internal_assessment: 'hidden', cost_impact: 'hidden', title: 'read' } } },
    ],
  },
  surfaces: [
    { key: 'internal', label: 'Internal', audience: 'internal', roles: ['manager'],
      default_page: 'findings_list', nav: [{ label: 'Findings', page: 'findings_list' }] },
    { key: 'supplier_portal', label: 'Supplier portal', audience: 'supplier', roles: ['supplier_user'],
      default_page: 'portal_list', nav: [{ label: 'Your findings', page: 'portal_list' }] },
  ],
  ui: {
    pages: [
      { key: 'findings_list', title: 'Findings', kind: 'list', surface: 'internal', entity: 'findings',
        layout: [{ type: 'table', entity: 'findings', fields: ['title', 'status', 'cost_impact'] }] },
      { key: 'portal_list', title: 'Your findings', kind: 'list', surface: 'supplier_portal', entity: 'findings',
        layout: [{ type: 'table', entity: 'findings', fields: ['title', 'status'] }] },
    ],
  },
  analytics: {
    queries: [{ key: 'finding_total', label: 'Total', entity: 'findings', source: 'app', aggregation: 'count' }],
    metrics: [{ key: 'finding_total', label: 'Total findings', query: 'finding_total' }],
  },
  automations: [],
};

let appA = null;   // company A's instance of the portal application
let appB = null;   // company B's own, separate application
let otherA = null; // a SECOND application inside company A
let managerA = null;
let supplierOne = null;
let supplierTwo = null;

before(async () => {
  available = await app.platformAvailable();
  if (!available) return;
  const { rows } = await pool.query('SELECT public.company_policies_active() AS active');
  isolated = rows[0].active === true;

  seeded = await seedHelper.seed();

  appA = await app.deploySpec({ companyId: seeded.companyA.id, userId: seeded.userA.id, spec: PORTAL_SPEC });
  appB = await app.deploySpec({ companyId: seeded.companyB.id, userId: seeded.userB.id, spec: PORTAL_SPEC });
  otherA = await app.deploySpec({
    companyId: seeded.companyA.id, userId: seeded.userA.id,
    spec: { ...PORTAL_SPEC, key: 'tenancy_probe_other', name: 'Tenancy Probe Other' },
  });

  managerA = await app.internalContext({
    companyId: seeded.companyA.id, appKey: appA.application.app_key, userId: seeded.userA.id,
  });

  // Two findings for company A, one per supplier.
  await app.as(seeded.companyA.id, () => data.create(managerA.context, managerA.principal, 'findings', {
    title: 'Supplier one problem', supplier_id: seeded.suppliersA[0].id,
    internal_assessment: 'They have been unreliable all quarter.', cost_impact: 9100,
  }));
  await app.as(seeded.companyA.id, () => data.create(managerA.context, managerA.principal, 'findings', {
    title: 'Supplier two problem', supplier_id: seeded.suppliersA[1].id,
    internal_assessment: 'Isolated incident.', cost_impact: 300,
  }));

  // A finding in company B, which nobody in company A should ever see.
  const managerB = await app.internalContext({
    companyId: seeded.companyB.id, appKey: appB.application.app_key, userId: seeded.userB.id,
  });
  await app.as(seeded.companyB.id, () => data.create(managerB.context, managerB.principal, 'findings', {
    title: 'COMPANY B CONFIDENTIAL', supplier_id: seeded.suppliersB[0].id,
  }));

  // Two portal identities in company A, one per supplier.
  const instanceA = appA.instance;
  const makeIdentity = async (supplier, email) => {
    const { identity: created, inviteToken } = await app.as(seeded.companyA.id, () => identity.invite({
      companyId: seeded.companyA.id, subjectKind: 'supplier', subjectId: supplier.id,
      email, displayName: supplier.legal_name, invitedBy: seeded.userA.id,
    }));
    await app.as(seeded.companyA.id, () => identity.acceptInvite({
      companyId: seeded.companyA.id, token: inviteToken, password: 'a-sufficiently-long-password',
    }));
    await app.as(seeded.companyA.id, () => identity.grantMembership({
      companyId: seeded.companyA.id, identityId: created.id, instanceId: instanceA.id,
      surfaceKey: 'supplier_portal', roleKey: 'supplier_user', grantedBy: seeded.userA.id,
    }));
    return app.as(seeded.companyA.id, () => identity.getIdentity(seeded.companyA.id, created.id));
  };
  supplierOne = await makeIdentity(seeded.suppliersA[0], `tenancy.one.${seeded.run}@supplier.invalid`);
  supplierTwo = await makeIdentity(seeded.suppliersA[1], `tenancy.two.${seeded.run}@supplier.invalid`);
});

after(async () => {
  if (seeded) await seedHelper.cleanup(seeded);
  await app.closeOwnerPool();
  await pool.end().catch(() => {});
});

// ---------------------------------------------------------------------------
// Company against company
// ---------------------------------------------------------------------------
dbTest('this database is actually isolated, or these tests prove nothing', async (t) => {
  if (!isolated) {
    // Said out loud rather than silently passing: on a database where
    // company_policies_active() is false, the assertions below would hold for
    // the wrong reason.
    t.diagnostic('company isolation is NOT enabled on this database — row-level assertions are weaker than they look');
  }
  const { rows } = await pool.query('SELECT current_user AS role');
  t.diagnostic(`application connected as ${rows[0].role}`);
});

dbTest('company A cannot resolve company B\'s application', async () => {
  await assert.rejects(
    app.as(seeded.companyA.id, () => resolver.resolveApplication(seeded.companyA.id, appB.application.app_key)),
    /has no application/
  );
  await assert.rejects(
    app.as(seeded.companyA.id, () => registry.assertVisible(appB.application.id, seeded.companyA.id)),
    /No such application/
  );
});

dbTest('company B\'s rows are invisible to company A, in lists and in aggregates', async () => {
  const list = await app.as(seeded.companyA.id, () =>
    data.list(managerA.context, managerA.principal, 'findings', { pageSize: 100 }));
  assert.equal(list.total, 2);
  assert.ok(!list.rows.some((r) => r.title.includes('COMPANY B')));

  // The count matters as much as the list: a leak that only shows up in a
  // total is still a leak, and is the one people do not notice.
  const metric = await app.as(seeded.companyA.id, () =>
    analytics.run(managerA.context, managerA.principal, 'finding_total'));
  assert.equal(metric.total, 2);
});

dbTest('the two companies\' tables are physically different objects', async () => {
  const tablesA = await app.as(seeded.companyA.id, () => registry.listTables(appA.instance.id));
  const tablesB = await app.as(seeded.companyB.id, () => registry.listTables(appB.instance.id));
  assert.notEqual(tablesA[0].table_name, tablesB[0].table_name);

  // Company A's connection, pointed at company B's table by name, sees nothing:
  // the row-level policy applies to the table, not to the query that found it.
  const rows = await app.as(seeded.companyA.id, () =>
    companyContext.withCompany(seeded.companyA.id, async (client) => {
      const { rows: found } = await client.query(`SELECT * FROM public."${tablesB[0].table_name}"`);
      return found;
    })).catch((error) => {
    // A permission error is an equally good outcome — better, even.
    assert.match(error.message, /permission denied/i);
    return [];
  });
  assert.equal(rows.length, 0, 'company A must not read company B\'s table even when it knows its name');
});

dbTest('a caller cannot supply a table name, only a logical entity key', async () => {
  // There is no code path that takes one. The runtime's entry points take an
  // application key and an entity key, and both are resolved.
  await assert.rejects(
    app.as(seeded.companyA.id, () => data.list(managerA.context, managerA.principal, 'users', {})),
    /has no entity "users"/
  );
  const tablesB = await app.as(seeded.companyB.id, () => registry.listTables(appB.instance.id));
  await assert.rejects(
    app.as(seeded.companyA.id, () => data.list(managerA.context, managerA.principal, tablesB[0].table_name, {})),
    /has no entity/
  );
  for (const hostile of ["findings'; DROP TABLE users; --", 'public.findings', '"findings"']) {
    await assert.rejects(
      app.as(seeded.companyA.id, () => data.list(managerA.context, managerA.principal, hostile, {})),
      /has no entity/,
      hostile
    );
  }
});

dbTest('one application cannot read another application\'s tables in the same company', async () => {
  const other = await app.internalContext({
    companyId: seeded.companyA.id, appKey: otherA.application.app_key, userId: seeded.userA.id,
  });
  // Same company, same user, same entity key, same schema — and a different
  // instance, so a different table with nothing in it.
  const rows = await app.as(seeded.companyA.id, () =>
    data.list(other.context, other.principal, 'findings', { pageSize: 100 }));
  assert.equal(rows.total, 0, 'the two applications share a company, not a table');

  const tablesA = await app.as(seeded.companyA.id, () => registry.listTables(appA.instance.id));
  const tablesOther = await app.as(seeded.companyA.id, () => registry.listTables(otherA.instance.id));
  assert.notEqual(tablesA[0].table_name, tablesOther[0].table_name);
});

dbTest('the instance pin means even a corrupted registry cannot cross applications', async () => {
  const tablesA = await app.as(seeded.companyA.id, () => registry.listTables(appA.instance.id));
  // Write directly into application A's table claiming to be application B's
  // instance — the CHECK constraint refuses it, which is the defence that
  // survives a bug in the registry itself.
  await assert.rejects(
    app.ownerPool().query(
      `INSERT INTO public."${tablesA[0].table_name}" (company_id, app_instance_id, title, supplier_id, status)
       VALUES ($1, $2, 'smuggled', $3, 'OPEN')`,
      [seeded.companyA.id, otherA.instance.id, seeded.suppliersA[0].id]
    ),
    /violates check constraint/
  );
});

// ---------------------------------------------------------------------------
// External identities
// ---------------------------------------------------------------------------
async function portalContext(anIdentity) {
  return app.externalContext({
    companyId: seeded.companyA.id, appKey: appA.application.app_key, identity: anIdentity,
  });
}

dbTest('a supplier sees their own findings and no other supplier\'s', async () => {
  const one = await portalContext(supplierOne);
  const rows = await app.as(seeded.companyA.id, () =>
    data.list(one.context, one.principal, 'findings', { pageSize: 100 }));
  assert.equal(rows.total, 1);
  assert.equal(rows.rows[0].title, 'Supplier one problem');

  const two = await portalContext(supplierTwo);
  const rowsTwo = await app.as(seeded.companyA.id, () =>
    data.list(two.context, two.principal, 'findings', { pageSize: 100 }));
  assert.equal(rowsTwo.total, 1);
  assert.equal(rowsTwo.rows[0].title, 'Supplier two problem');
});

dbTest('a supplier\'s aggregates are computed over their own rows only', async () => {
  const one = await portalContext(supplierOne);
  const metric = await app.as(seeded.companyA.id, () =>
    analytics.run(one.context, one.principal, 'finding_total'));
  assert.equal(metric.total, 1, '"247 open findings" on a portal discloses every other relationship');
});

dbTest('internal fields are absent from a portal payload, not merely unrendered', async () => {
  const one = await portalContext(supplierOne);
  const rows = await app.as(seeded.companyA.id, () =>
    data.list(one.context, one.principal, 'findings', { pageSize: 10 }));
  const row = rows.rows[0];
  assert.ok(!('internal_assessment' in row));
  assert.ok(!('cost_impact' in row));
  assert.ok('title' in row);
});

dbTest('a supplier cannot fetch another supplier\'s record by id', async () => {
  const two = await portalContext(supplierTwo);
  const theirs = await app.as(seeded.companyA.id, () =>
    data.list(two.context, two.principal, 'findings', {}));
  const one = await portalContext(supplierOne);

  await assert.rejects(
    app.as(seeded.companyA.id, () => data.get(one.context, one.principal, 'findings', theirs.rows[0].id)),
    /No such record/,
    'and the answer is the same as for a record that does not exist — a distinguishable "forbidden" enumerates ids'
  );
});

dbTest('a supplier cannot reassign a record to themselves, or to anyone', async () => {
  const one = await portalContext(supplierOne);
  const mine = await app.as(seeded.companyA.id, () => data.list(one.context, one.principal, 'findings', {}));

  await assert.rejects(
    app.as(seeded.companyA.id, () => data.update(one.context, one.principal, 'findings', mine.rows[0].id, {
      supplier_id: seeded.suppliersA[1].id,
    })),
    /cannot reassign|cannot set/
  );
});

dbTest('an external role writes only what it is explicitly allowed to write', async () => {
  // The default for an external role is READ. Being able to see your own claim
  // does not imply being able to change its status, so a portal role that can
  // "create" still cannot fill in a field unless a rule says `write`.
  const one = await portalContext(supplierOne);
  const permissive = JSON.parse(JSON.stringify(appA.spec));
  permissive.security.roles[1].permissions.findings = ['read', 'create', 'update'];
  await assert.rejects(
    app.as(seeded.companyA.id, () => data.create(
      { ...one.context, spec: permissive },
      { ...one.principal, roles: [permissive.security.roles[1]] },
      'findings', { title: 'x', supplier_id: seeded.suppliersA[0].id }
    )),
    /cannot set "title"/
  );
});

dbTest('a record a supplier creates is anchored to them, whatever they claim', async () => {
  // The portal role can create and has been granted `write` on the fields it
  // fills in; the anchor is written by the server from the identity, overriding
  // anything in the request.
  const spec = JSON.parse(JSON.stringify(appA.spec));
  spec.security.roles[1].permissions.findings = ['read', 'create', 'update'];
  spec.security.roles[1].field_access.findings.title = 'write';
  const one = await portalContext(supplierOne);
  const context = { ...one.context, spec };
  const principal = { ...one.principal, roles: [spec.security.roles[1]] };

  // Sending somebody else's supplier id, and an internal field they may not
  // even read. The first is overridden; the second is refused.
  await assert.rejects(
    app.as(seeded.companyA.id, () => data.create(context, principal, 'findings', {
      title: 'Raised by the supplier', internal_assessment: 'trying to write an internal field',
    })),
    /cannot set "internal_assessment"/
  );

  const created = await app.as(seeded.companyA.id, () => data.create(context, principal, 'findings', {
    title: 'Raised by the supplier',
    supplier_id: seeded.suppliersA[1].id,   // somebody else's id
  }));
  const physical = await app.readPhysical(seeded.companyA.id, appA.instance.id, 'findings');
  const row = physical.find((r) => r.id === created.id);
  assert.equal(row.supplier_id, seeded.suppliersA[0].id, 'the anchor is theirs, not the one they sent');
  assert.equal(row.created_by_external_id, supplierOne.id);
  assert.equal(row.created_by_user_id, null);
});

dbTest('a portal identity cannot be granted an internal role or an internal surface', async () => {
  await assert.rejects(
    app.as(seeded.companyA.id, () => identity.grantMembership({
      companyId: seeded.companyA.id, identityId: supplierOne.id, instanceId: appA.instance.id,
      surfaceKey: 'internal', roleKey: 'manager', grantedBy: seeded.userA.id,
    })),
    /cannot be given an internal surface/
  );
  await assert.rejects(
    app.as(seeded.companyA.id, () => identity.grantMembership({
      companyId: seeded.companyA.id, identityId: supplierOne.id, instanceId: appA.instance.id,
      surfaceKey: 'supplier_portal', roleKey: 'manager', grantedBy: seeded.userA.id,
    })),
    /is not granted by surface/
  );
});

dbTest('an identity cannot be anchored to a record from another company', async () => {
  await assert.rejects(
    app.as(seeded.companyA.id, () => identity.invite({
      companyId: seeded.companyA.id, subjectKind: 'supplier',
      subjectId: seeded.suppliersB[0].id,   // company B's supplier
      email: `cross.${seeded.run}@supplier.invalid`, invitedBy: seeded.userA.id,
    })),
    /No supplier with that id exists in your company/
  );
});

dbTest('revoking an identity ends its access and its live sessions at once', async () => {
  const { identity: created, inviteToken } = await app.as(seeded.companyA.id, () => identity.invite({
    companyId: seeded.companyA.id, subjectKind: 'supplier', subjectId: seeded.suppliersA[0].id,
    email: `revoke.${seeded.run}@supplier.invalid`, invitedBy: seeded.userA.id,
  }));
  await app.as(seeded.companyA.id, () => identity.acceptInvite({
    companyId: seeded.companyA.id, token: inviteToken, password: 'a-sufficiently-long-password',
  }));
  await app.as(seeded.companyA.id, () => identity.grantMembership({
    companyId: seeded.companyA.id, identityId: created.id, instanceId: appA.instance.id,
    surfaceKey: 'supplier_portal', roleKey: 'supplier_user', grantedBy: seeded.userA.id,
  }));
  const session = await app.as(seeded.companyA.id, () => identity.authenticate({
    companyId: seeded.companyA.id, email: created.email, password: 'a-sufficiently-long-password',
  }));
  assert.ok(await identity.resolveSession(session.token));

  await app.as(seeded.companyA.id, () => identity.revokeIdentity({
    companyId: seeded.companyA.id, identityId: created.id, revokedBy: seeded.userA.id,
  }));

  assert.equal(await identity.resolveSession(session.token), null,
    'revocation that leaves a live session behind is not revocation');
});

dbTest('portal authentication answers the same way for every kind of failure', async () => {
  const wrong = [
    { email: `does.not.exist.${seeded.run}@supplier.invalid`, password: 'a-sufficiently-long-password' },
    { email: supplierOne.email, password: 'the-wrong-password-entirely' },
  ];
  const messages = [];
  for (const attempt of wrong) {
    await app.as(seeded.companyA.id, () => identity.authenticate({ companyId: seeded.companyA.id, ...attempt }))
      .catch((error) => messages.push(error.message));
  }
  assert.equal(messages.length, 2);
  assert.equal(messages[0], messages[1],
    'a distinguishable answer turns a login form into a way to enumerate suppliers');
});

dbTest('a supplier cannot see internal comments on their own record', async () => {
  const mine = await app.as(seeded.companyA.id, () =>
    data.list(managerA.context, managerA.principal, 'findings', {
      filters: [{ field: 'supplier_id', operator: 'eq', value: seeded.suppliersA[0].id }],
    }));
  const recordId = mine.rows[0].id;

  await app.as(seeded.companyA.id, () => collaboration.addComment(
    managerA.context, managerA.principal, 'findings', recordId,
    { body: 'INTERNAL: we are considering dropping them.' }
  ));
  await app.as(seeded.companyA.id, () => collaboration.addComment(
    managerA.context, managerA.principal, 'findings', recordId,
    { body: 'Please send your corrective action.', visibility: 'shared' }
  ));

  const one = await portalContext(supplierOne);
  const visible = await app.as(seeded.companyA.id, () =>
    collaboration.listComments(one.context, one.principal, 'findings', recordId));
  assert.equal(visible.length, 1);
  assert.match(visible[0].body, /corrective action/);
  assert.ok(!visible.some((c) => /INTERNAL/.test(c.body)));

  // And a comment they write is shared, whatever they ask for.
  const written = await app.as(seeded.companyA.id, () => collaboration.addComment(
    one.context, one.principal, 'findings', recordId, { body: 'Understood.', visibility: 'internal' }
  ));
  assert.equal(written.visibility, 'shared');
});

dbTest('a supplier cannot take a transition their role does not allow', async () => {
  const mine = await app.as(seeded.companyA.id, () =>
    data.list(managerA.context, managerA.principal, 'findings', {
      filters: [{ field: 'supplier_id', operator: 'eq', value: seeded.suppliersA[0].id }],
    }));
  const one = await portalContext(supplierOne);
  await assert.rejects(
    app.as(seeded.companyA.id, () => workflowRuntime.transition(
      one.context, one.principal, 'findings', mine.rows[0].id, 'close', {}
    )),
    /needs the "manager" role/
  );
});

dbTest('canonical data on a portal is limited to the viewer\'s own record and its shareable columns', async () => {
  const one = await portalContext(supplierOne);
  const suppliers = await app.as(seeded.companyA.id, () =>
    data.listCanonical(one.context, one.principal, 'suppliers', {}));
  assert.equal(suppliers.rows.length, 1, 'a supplier reading `suppliers` sees exactly one row: their own');
  assert.equal(suppliers.rows[0].id, seeded.suppliersA[0].id);
  assert.ok(!('payment_terms' in suppliers.rows[0]), 'internal columns are not selected at all');
  assert.ok('legal_name' in suppliers.rows[0]);
});
