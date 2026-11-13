// The generic runtime: records, filters, workflow, analytics, automation.
//
// THE CLAIM UNDER TEST
// ===========================================================================
//     A deployed application works — really works, against real tables — with
//     no code written for it. Every list, form, transition, chart and
//     notification in this file is served by the same generic runtime that
//     serves every other application.
//
// Run on its own:  node --test tests/platformRuntime.test.js

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

const { pool } = require('../config/database');
const seedHelper = require('./helpers/platformSeed');
const app = require('./helpers/platformApp');
const data = require('../services/platform/runtime/data');
const workflowRuntime = require('../services/platform/runtime/workflow');
const analytics = require('../services/platform/runtime/analytics');
const automation = require('../services/platform/runtime/automation');
const collaboration = require('../services/platform/runtime/collaboration');
const page = require('../services/platform/runtime/page');
const catalog = require('../services/platform/catalog');

let available = false;
let seeded = null;
let installed = null;
let admin = null;

const dbTest = (name, fn) => test(name, async (t) => {
  if (!available) { t.skip('no database with the platform schema'); return; }
  await fn(t);
});

/**
 * One application with everything: a canonical reference, an enum, a computed
 * field, a constraint, a workflow with an approval and a four-eyes rule, a
 * child entity, analytics and an automation.
 */
const SPEC = {
  key: 'runtime_probe',
  name: 'Runtime Probe',
  description: 'Exercises every part of the runtime.',
  data: {
    canonical_refs: ['suppliers'],
    entities: [
      {
        key: 'issues', label: 'Issues', singular: 'Issue',
        display: { title_field: 'title' },
        anchor: { field: 'supplier_id', kind: 'supplier' },
        fields: [
          { name: 'title', label: 'Title', type: 'text', required: true },
          { name: 'supplier_id', label: 'Supplier', type: 'reference', required: true, indexed: true,
            target: { kind: 'canonical', entity: 'suppliers', on_delete: 'restrict' } },
          { name: 'severity', label: 'Severity', type: 'enum', required: true, default: 'LOW',
            values: ['LOW', 'MEDIUM', 'HIGH'] },
          { name: 'status', label: 'Status', type: 'enum', required: true, default: 'OPEN',
            values: ['OPEN', 'REVIEW', 'CLOSED'] },
          { name: 'cost', label: 'Cost', type: 'money', sensitive: true },
          { name: 'raised_on', label: 'Raised on', type: 'date', required: true, default: 'now' },
          { name: 'closed_on', label: 'Closed on', type: 'date' },
          { name: 'site', label: 'Site', type: 'geo_point' },
        ],
        computed: [{ name: 'days_open', label: 'Days open', expression: 'days_since(raised_on)', result_type: 'integer' }],
        indexes: [{ fields: ['supplier_id', 'status'] }],
        constraints: [{ key: 'closed_after_raised', expression: 'closed_on = null or closed_on >= raised_on', message: 'x' }],
      },
      {
        key: 'issue_notes', label: 'Issue Notes', singular: 'Issue Note',
        display: { title_field: 'body' },
        fields: [
          { name: 'body', label: 'Body', type: 'text', required: true },
          { name: 'issue_id', label: 'Issue', type: 'reference', required: true,
            target: { kind: 'app', entity: 'issues', on_delete: 'cascade' } },
        ],
      },
    ],
  },
  workflows: [{
    key: 'issue_flow', label: 'Issue lifecycle', entity: 'issues', state_field: 'status',
    states: [
      { key: 'OPEN', label: 'Open', initial: true },
      { key: 'REVIEW', label: 'In review' },
      { key: 'CLOSED', label: 'Closed', terminal: true },
    ],
    transitions: [
      { key: 'review', label: 'Send for review', from: 'OPEN', to: 'REVIEW' },
      { key: 'close', label: 'Close', from: 'REVIEW', to: 'CLOSED',
        requires: [{ type: 'approval', role: 'manager' }, { type: 'comment' }] },
      { key: 'reopen_from_review', label: 'Send back', from: 'REVIEW', to: 'OPEN',
        condition: "severity = 'HIGH'" },
    ],
    slas: [{ state: 'OPEN', hours: 1, escalate_to_role: 'manager', label: 'Open more than an hour' }],
  }],
  security: {
    roles: [
      { key: 'manager', label: 'Manager', audience: 'internal',
        permissions: { issues: ['read', 'create', 'update', 'delete', 'export', 'approve'], issue_notes: ['read', 'create'], suppliers: ['read'] },
        record_scope: { issues: 'all', issue_notes: 'all' },
        approval_authority: ['issue_flow.close'] },
      { key: 'contributor', label: 'Contributor', audience: 'internal',
        permissions: { issues: ['read', 'create', 'update'], issue_notes: ['read', 'create'], suppliers: ['read'] },
        record_scope: { issues: 'all', issue_notes: 'all' },
        field_access: { issues: { cost: 'hidden' } } },
    ],
  },
  surfaces: [{
    key: 'internal', label: 'Internal', audience: 'internal', roles: ['manager', 'contributor'],
    default_page: 'overview',
    nav: [{ label: 'Overview', page: 'overview' }, { label: 'Issues', page: 'issue_list' },
      { label: 'Issue', page: 'issue_detail' }, { label: 'New', page: 'issue_new' }],
  }],
  ui: {
    pages: [
      { key: 'overview', title: 'Overview', kind: 'dashboard', surface: 'internal',
        layout: [
          { type: 'metric_group', title: 'Figures', metrics: ['issue_total', 'issue_avg_cost'] },
          { type: 'chart_bar', title: 'By severity', query: 'issues_by_severity' },
          { type: 'chart_line', title: 'Over time', query: 'issues_over_time' },
          { type: 'stat_ranking', title: 'By supplier', query: 'issues_by_supplier' },
        ] },
      { key: 'issue_list', title: 'Issues', kind: 'list', surface: 'internal', entity: 'issues',
        filters: [{ field: 'severity', operator: 'eq', label: 'Severity' }],
        layout: [{ type: 'table', entity: 'issues', fields: ['title', 'severity', 'status', 'supplier_id', 'days_open'] }] },
      { key: 'issue_detail', title: 'Issue', kind: 'detail', surface: 'internal', entity: 'issues',
        layout: [
          { type: 'detail_header', entity: 'issues' },
          { type: 'workflow_bar', entity: 'issues', workflow: 'issue_flow' },
          { type: 'field_group', title: 'Details', entity: 'issues', fields: ['title', 'severity', 'cost', 'raised_on', 'days_open'] },
          { type: 'related_list', title: 'Notes', entity: 'issue_notes', relationship: 'issue_id', fields: ['body'] },
          { type: 'activity_feed', entity: 'issues' },
          { type: 'comments', entity: 'issues', visibility: 'internal' },
        ] },
      { key: 'issue_new', title: 'New issue', kind: 'form', surface: 'internal', entity: 'issues',
        layout: [{ type: 'form', entity: 'issues', fields: ['title', 'supplier_id', 'severity', 'cost', 'raised_on'] }] },
    ],
  },
  analytics: {
    queries: [
      { key: 'issue_total', label: 'Total issues', entity: 'issues', source: 'app', aggregation: 'count' },
      { key: 'issue_avg_cost', label: 'Average cost', entity: 'issues', source: 'app', aggregation: 'avg', field: 'cost' },
      { key: 'issues_by_severity', label: 'By severity', entity: 'issues', source: 'app', aggregation: 'count', group_by: 'severity' },
      { key: 'issues_over_time', label: 'Over time', entity: 'issues', source: 'app', aggregation: 'count',
        date_field: 'raised_on', time_grain: 'month', order: 'asc' },
      { key: 'issues_by_supplier', label: 'By supplier', entity: 'issues', source: 'app', aggregation: 'count', group_by: 'supplier_id', limit: 10 },
      { key: 'high_only', label: 'High severity', entity: 'issues', source: 'app', aggregation: 'count',
        filter: "severity = 'HIGH'" },
    ],
    metrics: [
      { key: 'issue_total', label: 'Total issues', query: 'issue_total' },
      { key: 'issue_avg_cost', label: 'Average cost', query: 'issue_avg_cost', format: 'currency' },
      { key: 'high_only', label: 'High severity', query: 'high_only' },
    ],
  },
  automations: [{
    key: 'issue_raised', label: 'Tell the manager', enabled: true,
    trigger: { kind: 'record_created', entity: 'issues' },
    condition: "severity = 'HIGH'",
    actions: [{ kind: 'notify_role', role: 'manager', subject: 'High severity issue', body: 'A {{severity}} issue was raised: {{title}}' }],
  }],
};

before(async () => {
  available = await app.platformAvailable();
  if (!available) return;
  seeded = await seedHelper.seed();
  installed = await app.deploySpec({ companyId: seeded.companyA.id, userId: seeded.userA.id, spec: SPEC });
  admin = await app.internalContext({
    companyId: seeded.companyA.id, appKey: installed.application.app_key, userId: seeded.userA.id,
  });
});

after(async () => {
  if (seeded) await seedHelper.cleanup(seeded);
  await app.closeOwnerPool();
  await pool.end().catch(() => {});
});

const create = (values) => app.as(seeded.companyA.id, () =>
  data.create(admin.context, admin.principal, 'issues', values));

// ---------------------------------------------------------------------------
dbTest('a record round-trips through real columns, with references labelled', async () => {
  const created = await create({
    title: 'Bearing out of tolerance', supplier_id: seeded.suppliersA[0].id,
    severity: 'HIGH', cost: 1250.5, raised_on: '2026-08-01',
    site: { lat: 51.5, lng: -0.12 },
  });

  assert.ok(created.id);
  assert.equal(created.status, 'OPEN', 'a new record enters its workflow at the initial state');
  assert.equal(Number(created.cost), 1250.5);
  assert.equal(created.supplier_id, seeded.suppliersA[0].id);
  assert.match(created.supplier_id__label, /Northgate/, 'a reference is useless on screen as a UUID');
  assert.equal(Number(created.site_lat), 51.5);
  assert.ok(created.days_open >= 0, 'the computed field is evaluated in SQL');

  // The row is really there, in the instance's own table.
  const physical = await app.readPhysical(seeded.companyA.id, installed.instance.id, 'issues');
  assert.ok(physical.some((r) => r.id === created.id));
  assert.equal(physical.find((r) => r.id === created.id).app_instance_id, installed.instance.id);
});

dbTest('the database enforces what the specification declared', async () => {
  // An enum value the specification does not allow.
  await assert.rejects(
    create({ title: 'x', supplier_id: seeded.suppliersA[0].id, severity: 'CATASTROPHIC' }),
    /must be one of/
  );
  // A required field.
  await assert.rejects(
    create({ supplier_id: seeded.suppliersA[0].id, severity: 'LOW' }),
    /is required/
  );
  // A reference that does not exist.
  await assert.rejects(
    create({ title: 'x', supplier_id: '00000000-0000-4000-8000-000000000000', severity: 'LOW' }),
    /does not exist|points at something/
  );
  // An entity-level constraint, enforced by the database rather than by a
  // renderer somebody might not have run.
  await assert.rejects(
    create({
      title: 'x', supplier_id: seeded.suppliersA[0].id, severity: 'LOW',
      raised_on: '2026-08-10', closed_on: '2026-08-01',
    }),
    /breaks one of the rules/
  );
});

dbTest('listing supports filters, search, sorting and paging', async () => {
  await create({ title: 'Alpha finding', supplier_id: seeded.suppliersA[0].id, severity: 'LOW', raised_on: '2026-07-01' });
  await create({ title: 'Beta finding', supplier_id: seeded.suppliersA[1].id, severity: 'MEDIUM', raised_on: '2026-07-15' });

  const all = await app.as(seeded.companyA.id, () => data.list(admin.context, admin.principal, 'issues', {}));
  assert.ok(all.total >= 3);

  const high = await app.as(seeded.companyA.id, () => data.list(admin.context, admin.principal, 'issues', {
    filters: [{ field: 'severity', operator: 'eq', value: 'HIGH' }],
  }));
  assert.ok(high.rows.every((r) => r.severity === 'HIGH'));

  const searched = await app.as(seeded.companyA.id, () => data.list(admin.context, admin.principal, 'issues', {
    search: 'Alpha',
  }));
  assert.ok(searched.rows.every((r) => /Alpha/i.test(r.title)));

  const sorted = await app.as(seeded.companyA.id, () => data.list(admin.context, admin.principal, 'issues', {
    sort: 'raised_on', direction: 'asc',
  }));
  // Compared as instants, not as the strings a Date prints — "Sat" sorts
  // before "Wed" and would make a correct ordering look wrong.
  const dates = sorted.rows.map((r) => new Date(r.raised_on).getTime());
  assert.deepEqual(dates, [...dates].sort((a, b) => a - b));

  const paged = await app.as(seeded.companyA.id, () => data.list(admin.context, admin.principal, 'issues', {
    pageSize: 1, page: 1,
  }));
  assert.equal(paged.rows.length, 1);
  assert.equal(paged.pageSize, 1);
  assert.ok(paged.pageCount >= 3);
});

dbTest('a filter can only name a field of that entity, and only one you can see', async () => {
  await assert.rejects(
    app.as(seeded.companyA.id, () => data.list(admin.context, admin.principal, 'issues', {
      filters: [{ field: 'password', operator: 'eq', value: 'x' }],
    })),
    /is not a field of issues/
  );
  await assert.rejects(
    app.as(seeded.companyA.id, () => data.list(admin.context, admin.principal, 'issues', {
      filters: [{ field: 'title', operator: 'regex', value: '.*' }],
    })),
    /is not a filter operator/
  );
  await assert.rejects(
    app.as(seeded.companyA.id, () => data.list(admin.context, admin.principal, 'issues', { sort: 'id; DROP TABLE x' })),
    /Cannot sort/
  );
});

dbTest('field access hides a column from a role, in the query and not in the renderer', async () => {
  // A person with no assignment and no ADMIN standing has no role at all —
  // which is itself the right answer, and is checked here before the field
  // rules are.
  await assert.rejects(
    app.internalContext({
      companyId: seeded.companyA.id, appKey: installed.application.app_key,
      userId: seeded.contributorA.id, platformRole: 'USER',
    }),
    /no role in this application/
  );

  await catalog.assignRole({
    companyId: seeded.companyA.id, appKey: installed.application.app_key,
    userId: seeded.contributorA.id, roleKey: 'contributor', grantedBy: seeded.userA.id,
  });
  const scoped = await app.internalContext({
    companyId: seeded.companyA.id, appKey: installed.application.app_key,
    userId: seeded.contributorA.id, platformRole: 'USER',
  });
  assert.deepEqual(scoped.principal.roleKeys, ['contributor']);

  const rows = await app.as(seeded.companyA.id, () =>
    data.list(scoped.context, scoped.principal, 'issues', { pageSize: 5 }));
  assert.ok(rows.rows.length > 0);
  rows.rows.forEach((r) => {
    assert.ok(!('cost' in r), 'a hidden field must be absent from the payload, not merely unrendered');
  });

  // And it cannot be reached sideways, one bit at a time, through a filter.
  await assert.rejects(
    app.as(seeded.companyA.id, () => data.list(scoped.context, scoped.principal, 'issues', {
      filters: [{ field: 'cost', operator: 'gt', value: 0 }],
    })),
    /cannot filter/
  );
});

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------
dbTest('state changes only through a declared transition', async () => {
  const issue = await create({ title: 'Workflow probe', supplier_id: seeded.suppliersA[0].id, severity: 'MEDIUM' });

  // The state field is not editable, so every condition, role and approval on
  // the transition is enforcement rather than suggestion.
  await assert.rejects(
    app.as(seeded.companyA.id, () => data.update(admin.context, admin.principal, 'issues', issue.id, { status: 'CLOSED' })),
    /driven by the .* workflow/
  );

  const available1 = workflowRuntime.availableTransitions(
    admin.context.spec, admin.context.spec.workflows[0], issue, admin.principal
  );
  assert.deepEqual(available1.map((t) => t.key).sort(), ['review']);

  const moved = await app.as(seeded.companyA.id, () =>
    workflowRuntime.transition(admin.context, admin.principal, 'issues', issue.id, 'review', {}));
  assert.equal(moved.to, 'REVIEW');

  // A transition from the wrong state is refused.
  await assert.rejects(
    app.as(seeded.companyA.id, () =>
      workflowRuntime.transition(admin.context, admin.principal, 'issues', issue.id, 'review', {})),
    /moves a record from "OPEN"/
  );

  // A transition whose condition the record does not meet is refused.
  await assert.rejects(
    app.as(seeded.companyA.id, () =>
      workflowRuntime.transition(admin.context, admin.principal, 'issues', issue.id, 'reopen_from_review', {})),
    /does not meet the condition/
  );

  // `close` requires a reason.
  await assert.rejects(
    app.as(seeded.companyA.id, () =>
      workflowRuntime.transition(admin.context, admin.principal, 'issues', issue.id, 'close', {})),
    /needs a reason/
  );

  const closed = await app.as(seeded.companyA.id, () =>
    workflowRuntime.transition(admin.context, admin.principal, 'issues', issue.id, 'close', { reason: 'Verified on site.' }));
  assert.equal(closed.to, 'CLOSED');

  // The history is written in the same transaction as the state change.
  const history = await app.as(seeded.companyA.id, () =>
    workflowRuntime.history(admin.context, admin.principal, 'issues', issue.id));
  assert.equal(history.length, 2);
  assert.equal(history[0].to, 'CLOSED');
  assert.equal(history[0].reason, 'Verified on site.');
});

dbTest('a role without approval authority cannot take an approval transition', async () => {
  await catalog.assignRole({
    companyId: seeded.companyA.id, appKey: installed.application.app_key,
    userId: seeded.contributorA.id, roleKey: 'contributor', grantedBy: seeded.userA.id,
  });
  const contributor = await app.internalContext({
    companyId: seeded.companyA.id, appKey: installed.application.app_key,
    userId: seeded.contributorA.id, platformRole: 'USER',
  });

  const issue = await create({ title: 'Approval probe', supplier_id: seeded.suppliersA[0].id, severity: 'LOW' });
  await app.as(seeded.companyA.id, () =>
    workflowRuntime.transition(contributor.context, contributor.principal, 'issues', issue.id, 'review', {}));

  await assert.rejects(
    app.as(seeded.companyA.id, () => workflowRuntime.transition(
      contributor.context, contributor.principal, 'issues', issue.id, 'close', { reason: 'Looks fine to me.' }
    )),
    /needs approval from "manager"/
  );
});

dbTest('an SLA breach is computed from the transition history', async () => {
  const issue = await create({ title: 'SLA probe', supplier_id: seeded.suppliersA[0].id, severity: 'LOW' });
  // Backdate the record so the one-hour SLA on OPEN is breached.
  const registry = require('../services/platform/registry');
  const table = await app.as(seeded.companyA.id, () => registry.resolveTable(installed.instance.id, 'issues'));
  await app.ownerPool().query(
    `UPDATE ${table.qualified} SET created_at = CURRENT_TIMESTAMP - INTERVAL '5 hours' WHERE id = $1`, [issue.id]
  );

  const breaches = await app.as(seeded.companyA.id, () =>
    workflowRuntime.slaBreaches(admin.context, admin.principal, 'issue_flow'));
  const found = breaches.find((b) => b.recordId === issue.id);
  assert.ok(found, 'an issue open for five hours breaches a one-hour SLA');
  assert.equal(found.limitHours, 1);
  assert.ok(found.hoursInState >= 4);
});

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------
dbTest('declared analytics compile to real aggregate queries', async () => {
  const total = await app.as(seeded.companyA.id, () => analytics.run(admin.context, admin.principal, 'issue_total'));
  assert.ok(total.total > 0);

  const bySeverity = await app.as(seeded.companyA.id, () =>
    analytics.run(admin.context, admin.principal, 'issues_by_severity'));
  assert.ok(bySeverity.grouped);
  assert.ok(bySeverity.rows.every((r) => ['LOW', 'MEDIUM', 'HIGH'].includes(r.label)));

  const overTime = await app.as(seeded.companyA.id, () =>
    analytics.run(admin.context, admin.principal, 'issues_over_time'));
  assert.equal(overTime.timeGrain, 'month');
  assert.ok(overTime.rows.every((r) => /^\d{4}-\d{2}$/.test(r.label)));

  const filtered = await app.as(seeded.companyA.id, () => analytics.run(admin.context, admin.principal, 'high_only'));
  assert.ok(filtered.total < total.total, 'the declared filter narrowed it');

  const tiles = await app.as(seeded.companyA.id, () => analytics.metrics(admin.context, admin.principal, []));
  assert.equal(tiles.length, 3);
  assert.ok(tiles.every((m) => typeof m.value === 'number' || m.error));
});

dbTest('a metric over a field a role cannot see reports why, and does not blank the page', async () => {
  await catalog.assignRole({
    companyId: seeded.companyA.id, appKey: installed.application.app_key,
    userId: seeded.contributorA.id, roleKey: 'contributor', grantedBy: seeded.userA.id,
  });
  const contributor = await app.internalContext({
    companyId: seeded.companyA.id, appKey: installed.application.app_key,
    userId: seeded.contributorA.id, platformRole: 'USER',
  });
  const tiles = await app.as(seeded.companyA.id, () =>
    analytics.metrics(contributor.context, contributor.principal, []));
  const cost = tiles.find((m) => m.key === 'issue_avg_cost');
  assert.equal(cost.value, null);
  assert.match(cost.error, /Not visible/);
  assert.ok(tiles.some((m) => typeof m.value === 'number'), 'the rest of the dashboard still works');
});

// ---------------------------------------------------------------------------
// Automation
// ---------------------------------------------------------------------------
dbTest('an automation fires on its trigger, respects its condition, and is recorded', async () => {
  const high = await create({ title: 'Automation probe HIGH', supplier_id: seeded.suppliersA[0].id, severity: 'HIGH' });
  await app.as(seeded.companyA.id, () => automation.dispatch(admin.context, {
    kind: 'record_created', entityKey: 'issues', recordId: high.id, record: high,
  }));

  const low = await create({ title: 'Automation probe LOW', supplier_id: seeded.suppliersA[0].id, severity: 'LOW' });
  const skipped = await app.as(seeded.companyA.id, () => automation.dispatch(admin.context, {
    kind: 'record_created', entityKey: 'issues', recordId: low.id, record: low,
  }));
  assert.equal(skipped[0].status, 'skipped', 'the condition kept it from running');

  const companyContext = require('../services/companyContext');
  const notifications = await app.as(seeded.companyA.id, () =>
    companyContext.withCompany(seeded.companyA.id, async (client) => {
      const { rows } = await client.query(
        `SELECT subject, body FROM app_notifications
          WHERE app_instance_id = $1 AND recipient_role = 'manager' ORDER BY created_at DESC LIMIT 5`,
        [installed.instance.id]
      );
      return rows;
    }));
  assert.ok(notifications.length >= 1);
  assert.match(notifications[0].body, /A HIGH issue was raised: Automation probe HIGH/,
    'the template reads fields off the triggering record');

  const runs = await app.as(seeded.companyA.id, () =>
    companyContext.withCompany(seeded.companyA.id, async (client) => {
      const { rows } = await client.query(
        'SELECT status, depth FROM app_automation_runs WHERE app_instance_id = $1', [installed.instance.id]
      );
      return rows;
    }));
  assert.ok(runs.some((r) => r.status === 'succeeded'));
  assert.ok(runs.every((r) => r.depth < automation.MAX_DEPTH));
});

dbTest('an automation chain is bounded, and the suppression is recorded rather than silent', async () => {
  // A specification the validator would reject (it is a loop) — constructed
  // here to prove the RUNTIME bound is real and not merely a design rule.
  const looping = JSON.parse(JSON.stringify(admin.context.spec));
  looping.automations = [{
    key: 'looper', label: 'Looper', enabled: true,
    trigger: { kind: 'record_created', entity: 'issue_notes' },
    condition: '',
    actions: [{ kind: 'create_record', entity: 'issue_notes', values: { body: 'again', issue_id: '{{issue_id}}' } }],
  }];
  const context = { ...admin.context, spec: looping };

  const issue = await create({ title: 'Loop probe', supplier_id: seeded.suppliersA[0].id, severity: 'LOW' });
  const note = await app.as(seeded.companyA.id, () =>
    data.create(admin.context, admin.principal, 'issue_notes', { body: 'seed', issue_id: issue.id }));

  await app.as(seeded.companyA.id, () => automation.dispatch(context, {
    kind: 'record_created', entityKey: 'issue_notes', recordId: note.id, record: note,
  }));

  const companyContext = require('../services/companyContext');
  const runs = await app.as(seeded.companyA.id, () =>
    companyContext.withCompany(seeded.companyA.id, async (client) => {
      const { rows } = await client.query(
        `SELECT status, depth FROM app_automation_runs
          WHERE app_instance_id = $1 AND automation_key = 'looper' ORDER BY depth`,
        [installed.instance.id]
      );
      return rows;
    }));
  assert.ok(runs.length > 0);
  assert.ok(runs.every((r) => r.depth <= automation.MAX_DEPTH));
  assert.ok(runs.some((r) => r.status === 'suppressed'), 'the bound must be visible, not silent');
});

// ---------------------------------------------------------------------------
// Collaboration and page rendering
// ---------------------------------------------------------------------------
dbTest('comments carry a visibility, and the activity feed interleaves both', async () => {
  const issue = await create({ title: 'Comment probe', supplier_id: seeded.suppliersA[0].id, severity: 'LOW' });
  await app.as(seeded.companyA.id, () =>
    collaboration.addComment(admin.context, admin.principal, 'issues', issue.id, { body: 'Internal note.' }));
  await app.as(seeded.companyA.id, () =>
    collaboration.addComment(admin.context, admin.principal, 'issues', issue.id, { body: 'Shared with them.', visibility: 'shared' }));
  await app.as(seeded.companyA.id, () =>
    workflowRuntime.transition(admin.context, admin.principal, 'issues', issue.id, 'review', {}));

  const comments = await app.as(seeded.companyA.id, () =>
    collaboration.listComments(admin.context, admin.principal, 'issues', issue.id));
  assert.equal(comments.length, 2);

  const feed = await app.as(seeded.companyA.id, () =>
    collaboration.activity(admin.context, admin.principal, 'issues', issue.id));
  assert.ok(feed.some((e) => e.kind === 'transition'));
  assert.ok(feed.some((e) => e.kind === 'comment'));
  // Newest first.
  const times = feed.map((e) => new Date(e.at).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
});

dbTest('a whole page renders in one request, blocks and all', async () => {
  const dashboard = await app.as(seeded.companyA.id, () =>
    page.render(admin.context, admin.principal, 'overview', {}));
  assert.equal(dashboard.blocks.length, 4);
  assert.ok(dashboard.blocks[0].metrics.length === 2);
  assert.ok(dashboard.blocks[1].data.rows.length >= 1);

  const issue = await create({ title: 'Page probe', supplier_id: seeded.suppliersA[0].id, severity: 'LOW' });
  await app.as(seeded.companyA.id, () =>
    data.create(admin.context, admin.principal, 'issue_notes', { body: 'A note', issue_id: issue.id }));

  const detail = await app.as(seeded.companyA.id, () =>
    page.render(admin.context, admin.principal, 'issue_detail', { recordId: issue.id }));
  assert.equal(detail.record.id, issue.id);
  const byType = Object.fromEntries(detail.blocks.map((b) => [b.type, b]));
  assert.equal(byType.workflow_bar.current, 'OPEN');
  assert.ok(byType.workflow_bar.transitions.some((t) => t.key === 'review' && t.allowed));
  assert.equal(byType.related_list.rows.length, 1);
  assert.ok(byType.field_group.fields.some((f) => f.name === 'days_open' && f.computed));

  const form = await app.as(seeded.companyA.id, () => page.render(admin.context, admin.principal, 'issue_new', {}));
  const formBlock = form.blocks.find((b) => b.type === 'form');
  assert.ok(formBlock.fields.every((f) => !f.computed), 'a computed field is derived, not filled in');
  assert.ok(formBlock.fields.some((f) => f.name === 'supplier_id' && f.reference));
});

dbTest('the shell describes only the surface this principal reaches', async () => {
  const shell = page.shell(admin.context, admin.principal);
  assert.equal(shell.surface.key, 'internal');
  assert.equal(shell.surface.external, false);
  assert.equal(shell.pages.length, 4);
  assert.deepEqual(shell.principal.roles.sort(), ['contributor', 'manager']);
});

dbTest('canonical EMBMIS data is readable and never writable', async () => {
  const suppliers = await app.as(seeded.companyA.id, () =>
    data.listCanonical(admin.context, admin.principal, 'suppliers', {}));
  assert.ok(suppliers.rows.length >= 2);
  assert.ok(suppliers.rows.every((r) => r.legal_name));

  // There is no canonical write path in the runtime at all.
  assert.equal(typeof data.createCanonical, 'undefined');

  // And an undeclared dependency is refused even for a read.
  await assert.rejects(
    app.as(seeded.companyA.id, () => data.listCanonical(admin.context, admin.principal, 'employees', {})),
    /does not declare a dependency/
  );
});

dbTest('delete is soft: the record leaves every read and stays for the audit', async () => {
  const issue = await create({ title: 'Delete probe', supplier_id: seeded.suppliersA[0].id, severity: 'LOW' });
  await app.as(seeded.companyA.id, () => data.remove(admin.context, admin.principal, 'issues', issue.id));

  await assert.rejects(
    app.as(seeded.companyA.id, () => data.get(admin.context, admin.principal, 'issues', issue.id)),
    /No such record/
  );
  const physical = await app.readPhysical(seeded.companyA.id, installed.instance.id, 'issues');
  const row = physical.find((r) => r.id === issue.id);
  assert.ok(row, 'the row is still there');
  assert.ok(row.deleted_at, 'and it is marked');
});

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------
dbTest('an attachment is visible exactly as far as the record it hangs off', async () => {
  const issue = await create({ title: 'Attachment probe', supplier_id: seeded.suppliersA[0].id, severity: 'LOW' });

  const internal = await app.as(seeded.companyA.id, () => collaboration.addAttachment(
    admin.context, admin.principal, 'issues', issue.id,
    { fileName: 'internal-assessment.pdf', contentType: 'application/pdf', byteSize: 1024, storageKey: 'probe/internal.pdf' }
  ));
  const shared = await app.as(seeded.companyA.id, () => collaboration.addAttachment(
    admin.context, admin.principal, 'issues', issue.id,
    { fileName: 'sent-to-them.pdf', contentType: 'application/pdf', byteSize: 2048, storageKey: 'probe/shared.pdf', visibility: 'shared' }
  ));
  assert.equal(internal.visibility, 'internal');
  assert.equal(shared.visibility, 'shared');

  const listed = await app.as(seeded.companyA.id, () =>
    collaboration.listAttachments(admin.context, admin.principal, 'issues', issue.id));
  assert.equal(listed.length, 2);
  // The storage key is never in a listing payload — a filesystem path is not
  // something to hand to a browser, least of all a portal's.
  assert.ok(listed.every((a) => !('storage_key' in a)));

  const stored = await app.as(seeded.companyA.id, () =>
    collaboration.storagePathFor(admin.context, shared.id));
  assert.equal(stored, 'probe/shared.pdf');
});

dbTest('an attachment cannot be added to a record you cannot see', async () => {
  await catalog.assignRole({
    companyId: seeded.companyA.id, appKey: installed.application.app_key,
    userId: seeded.contributorA.id, roleKey: 'contributor', grantedBy: seeded.userA.id,
  });
  const contributor = await app.internalContext({
    companyId: seeded.companyA.id, appKey: installed.application.app_key,
    userId: seeded.contributorA.id, platformRole: 'USER',
  });
  await assert.rejects(
    app.as(seeded.companyA.id, () => collaboration.addAttachment(
      contributor.context, contributor.principal, 'issues', '00000000-0000-4000-8000-000000000000',
      { fileName: 'x.pdf', storageKey: 'x' }
    )),
    /No such record/
  );
});

// ---------------------------------------------------------------------------
// Scheduled automations
// ---------------------------------------------------------------------------
dbTest('the scheduler is off unless somebody turns it on', () => {
  const scheduler = require('../services/platform/scheduler');
  const previous = process.env.PLATFORM_SCHEDULER_ENABLED;
  delete process.env.PLATFORM_SCHEDULER_ENABLED;
  try {
    const result = scheduler.startScheduler();
    assert.equal(result.started, false, 'starting a server must not begin notifying people');
    assert.match(result.reason, /PLATFORM_SCHEDULER_ENABLED/);
  } finally {
    if (previous !== undefined) process.env.PLATFORM_SCHEDULER_ENABLED = previous;
    scheduler.stopScheduler();
  }
});

dbTest('cadences are due by the clock, and a missed tick is skipped rather than doubled', () => {
  const scheduler = require('../services/platform/scheduler');
  const hour = Number(process.env.PLATFORM_SCHEDULER_DAILY_HOUR || 8);

  const midMorning = new Date(Date.UTC(2026, 8, 2, hour + 3, 0, 0)); // a Wednesday
  assert.deepEqual(scheduler.dueCadences(midMorning), ['hourly']);

  const dailyHour = new Date(Date.UTC(2026, 8, 2, hour, 0, 0));
  assert.deepEqual(scheduler.dueCadences(dailyHour).sort(), ['daily', 'hourly']);

  const monday = new Date(Date.UTC(2026, 8, 7, hour, 0, 0));
  assert.ok(scheduler.dueCadences(monday).includes('weekly'));

  const firstOfMonth = new Date(Date.UTC(2026, 9, 1, hour, 0, 0));
  assert.ok(scheduler.dueCadences(firstOfMonth).includes('monthly'));
});

dbTest('a scheduled automation sweeps the records its condition selects', async () => {
  // An application with a daily chase-up, deployed for real.
  const chaseSpec = JSON.parse(JSON.stringify(SPEC));
  chaseSpec.key = 'scheduler_probe';
  chaseSpec.name = 'Scheduler Probe';
  chaseSpec.data.entities[0].fields.push({ name: 'due_date', label: 'Due date', type: 'date' });
  chaseSpec.automations = [{
    key: 'chase_overdue', label: 'Chase overdue issues', enabled: true,
    trigger: { kind: 'schedule', entity: 'issues', cadence: 'daily', hour: 8 },
    condition: "due_date < $today and status in ['OPEN']",
    actions: [{ kind: 'notify_role', role: 'manager', subject: 'Overdue', body: 'Overdue: {{title}}' }],
  }];
  const chase = await app.deploySpec({
    companyId: seeded.companyA.id, userId: seeded.userA.id, spec: chaseSpec,
  });
  const ctx = await app.internalContext({
    companyId: seeded.companyA.id, appKey: chase.application.app_key, userId: seeded.userA.id,
  });

  await app.as(seeded.companyA.id, () => data.create(ctx.context, ctx.principal, 'issues', {
    title: 'Overdue one', supplier_id: seeded.suppliersA[0].id, severity: 'HIGH', due_date: '2020-01-01',
  }));
  await app.as(seeded.companyA.id, () => data.create(ctx.context, ctx.principal, 'issues', {
    title: 'Not due yet', supplier_id: seeded.suppliersA[0].id, severity: 'LOW', due_date: '2099-01-01',
  }));

  const scheduler = require('../services/platform/scheduler');
  const results = await app.as(seeded.companyA.id, () => scheduler.runCompany(seeded.companyA.id, ['daily']));
  const forThis = results.find((r) => r.application === chase.application.app_key);
  assert.ok(forThis && !forThis.error, JSON.stringify(forThis));

  const companyContext = require('../services/companyContext');
  const notified = await app.as(seeded.companyA.id, () =>
    companyContext.withCompany(seeded.companyA.id, async (client) => {
      const { rows } = await client.query(
        `SELECT subject, body FROM app_notifications WHERE app_instance_id = $1`,
        [chase.instance.id]
      );
      return rows;
    }));
  assert.equal(notified.length, 1, 'the condition selected one record, not both');
  assert.match(notified[0].body, /Overdue one/);
});

dbTest('attachment bytes go to shared storage when it is configured, and say where they went', async () => {
  const storage = require('../services/platform/runtime/attachmentStorage');
  const wasConfigured = storage.remoteConfigured();

  // On a deployment with no object storage, files land on local disk — and the
  // key SAYS so, because a key that did not would have to be guessed at after
  // a deployment moved.
  const key = await storage.put({
    instanceId: installed.instance.id,
    entityKey: 'issues',
    originalName: 'evidence.pdf',
    buffer: Buffer.from('%PDF-1.4 not really a pdf'),
    contentType: 'application/pdf',
  });
  assert.match(key, wasConfigured ? /^r2:/ : /^disk:/);
  assert.match(key, /applications\//);
  // The stored name is generated, never the client's.
  assert.ok(!key.includes('evidence'));

  const stream = await storage.open(key);
  assert.ok(stream, 'what was stored can be read back');
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.match(Buffer.concat(chunks).toString(), /not really a pdf/);

  await storage.remove(key);
  assert.equal(await storage.open(key), null, 'and removal really removes it');
});

dbTest('a storage key that tries to escape its directory is refused, not followed', async () => {
  const storage = require('../services/platform/runtime/attachmentStorage');
  for (const hostile of ['disk:../../../etc/passwd', '../../.env', 'disk:/etc/passwd']) {
    assert.equal(await storage.open(hostile), null, hostile);
  }
});
