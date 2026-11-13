// The specification vocabulary: expressions, validation, and hostile designs.
//
// THE CLAIM UNDER TEST
// ===========================================================================
//     A specification is untrusted input. Everything downstream — the schema
//     compiler, the runtime, the portal — assumes it is well-formed, coherent
//     and safe. This is where that assumption is earned, so these tests are
//     mostly about what must be REFUSED.
//
// No database. Run on its own:  node --test tests/platformSpec.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');

const expressions = require('../services/platform/spec/expressions');
const validator = require('../services/platform/spec/validator');
const canonical = require('../services/platform/spec/canonical');
const { FIELD_TYPES, AUTOMATION_ACTIONS } = require('../services/platform/spec/types');
const analyzer = require('../services/platform/studio/analyzer');
const composer = require('../services/platform/studio/composer');

const FIELDS = {
  status: 'enum', severity: 'enum', title: 'text', score: 'decimal',
  raised_on: 'date', due_date: 'date', closed: 'boolean',
};

// ===========================================================================
// Expressions
// ===========================================================================
test('a valid expression parses, type checks and compiles to parameterised SQL', () => {
  const { ast, type } = expressions.compile(
    "status in ['OPEN', 'ASSIGNED'] and days_since(raised_on) > 7", FIELDS
  );
  assert.equal(type, 'boolean');
  const params = [];
  const sql = expressions.toSql(ast, { resolveField: (n) => `t."${n}"`, params });
  // Every literal is a placeholder; nothing from the expression is in the text.
  assert.ok(sql.includes('$1') && sql.includes('$2') && sql.includes('$3'));
  assert.deepEqual(params, ['OPEN', 'ASSIGNED', 7]);
  assert.ok(!sql.includes('OPEN'), 'a literal must never appear in the SQL text');
});

test('the interpreter and the SQL backend agree on the same expression', () => {
  const { ast } = expressions.compile("severity = 'HIGH' and score > 50", FIELDS);
  assert.equal(expressions.evaluate(ast, { severity: 'HIGH', score: 80 }), true);
  assert.equal(expressions.evaluate(ast, { severity: 'HIGH', score: 20 }), false);
  assert.equal(expressions.evaluate(ast, { severity: 'LOW', score: 80 }), false);
});

test('an expression may only name fields the entity declares', () => {
  assert.throws(() => expressions.compile('secret_column = 1', FIELDS), /Unknown field/);
  assert.throws(() => expressions.compile('password = 1', FIELDS), /Unknown field/);
});

test('the tokenizer refuses anything outside its character vocabulary', () => {
  const HOSTILE = [
    "status = 'x'; DROP TABLE users",
    'status = `x`',
    'status = "x"',
    'status = 1 \\u0000',
    'process.exit(1)',
    'require("fs")',
    '${process.env.JWT_SECRET}',
    'status = 1 -- comment',
    'status = 1 /* comment */',
  ];
  HOSTILE.forEach((source) => {
    assert.throws(() => expressions.compile(source, FIELDS), expressions.ExpressionError, source);
  });
});

test('only the allowlisted functions exist', () => {
  assert.throws(() => expressions.compile('pg_sleep(10) > 0', FIELDS), /Unknown function/);
  assert.throws(() => expressions.compile('eval(title) = 1', FIELDS), /Unknown function/);
  assert.throws(() => expressions.compile('version() = 1', FIELDS), /Unknown function/);
  // And the ones that do exist are arity- and type-checked.
  assert.throws(() => expressions.compile('days_since()', FIELDS), /takes 1 argument/);
  assert.throws(() => expressions.compile('days_since(title)', FIELDS), /should be datetime/);
});

test('only the allowlisted context variables exist', () => {
  assert.doesNotThrow(() => expressions.compile('title = $user.id', FIELDS));
  assert.throws(() => expressions.compile('title = $secrets.jwt', FIELDS), /Unknown context variable/);
  assert.throws(() => expressions.compile('title = $env', FIELDS), /Unknown context variable/);
});

test('types are checked, so a nonsense comparison is refused', () => {
  assert.throws(() => expressions.compile('score > raised_on', FIELDS), /Cannot compare/);
  assert.throws(() => expressions.compile('title + 1', FIELDS), /Arithmetic needs numbers/);
  assert.throws(() => expressions.compile('not score', FIELDS), /needs a boolean/);
});

test('an expression is bounded in length', () => {
  assert.throws(() => expressions.compile(`title = '${'a'.repeat(1200)}'`, FIELDS), /limited to 1000/);
});

test('division guards against zero rather than failing the query', () => {
  const { ast } = expressions.compile('score / score > 1', FIELDS);
  const params = [];
  assert.ok(expressions.toSql(ast, { resolveField: (n) => `"${n}"`, params }).includes('NULLIF'));
});

// ===========================================================================
// Validation — structure
// ===========================================================================
function minimalSpec(overrides = {}) {
  const base = {
    key: 'test_app',
    name: 'Test App',
    description: 'A test.',
    data: {
      entities: [{
        key: 'things', label: 'Things', singular: 'Thing',
        display: { title_field: 'title' },
        fields: [
          { name: 'title', label: 'Title', type: 'text', required: true },
          { name: 'status', label: 'Status', type: 'enum', required: true, default: 'OPEN', values: ['OPEN', 'DONE'] },
        ],
      }],
      canonical_refs: [],
    },
    workflows: [],
    security: {
      roles: [{
        key: 'operator', label: 'Operator', audience: 'internal',
        permissions: { things: ['read', 'create', 'update'] },
        record_scope: { things: 'all' },
      }],
    },
    surfaces: [{
      key: 'internal', label: 'Internal', audience: 'internal', roles: ['operator'],
      default_page: 'things_list',
      nav: [{ label: 'Things', page: 'things_list' }],
    }],
    ui: {
      pages: [{
        key: 'things_list', title: 'Things', kind: 'list', surface: 'internal', entity: 'things',
        layout: [{ type: 'table', entity: 'things', fields: ['title', 'status'] }],
      }],
    },
    analytics: { queries: [], metrics: [] },
    automations: [],
  };
  return { ...base, ...overrides };
}

test('a minimal well-formed specification validates', () => {
  const { report } = validator.validate(minimalSpec());
  assert.ok(report.ok, JSON.stringify(report.errors, null, 1));
});

test('the field-type vocabulary is closed', () => {
  const spec = minimalSpec();
  spec.data.entities[0].fields.push({ name: 'evil', label: 'Evil', type: 'raw_sql' });
  const { report } = validator.validate(spec);
  assert.ok(report.errors.some((e) => e.code === 'FIELD_TYPE'));
  // And every type that IS in the vocabulary has a SQL mapping or an expansion.
  Object.entries(FIELD_TYPES).forEach(([key, def]) => {
    assert.ok(def.sql || def.expands, `${key} must compile to something`);
  });
});

test('an application may not redeclare a canonical EMBMIS entity', () => {
  const spec = minimalSpec();
  spec.data.entities.push({
    key: 'suppliers', label: 'Suppliers', fields: [{ name: 'nm', label: 'Name', type: 'text' }],
  });
  const { report } = validator.validate(spec);
  assert.ok(report.errors.some((e) => e.code === 'ENTITY_SHADOWS_CANONICAL'));
});

test('a reference must land on something real', () => {
  const spec = minimalSpec();
  spec.data.entities[0].fields.push({
    name: 'other_id', label: 'Other', type: 'reference',
    target: { kind: 'app', entity: 'does_not_exist', on_delete: 'restrict' },
  });
  const { report } = validator.validate(spec);
  assert.ok(report.errors.some((e) => e.code === 'REFERENCE_TARGET'));
});

test('a canonical reference may not cascade on delete', () => {
  const spec = minimalSpec();
  spec.data.canonical_refs = ['suppliers'];
  spec.data.entities[0].fields.push({
    name: 'supplier_id', label: 'Supplier', type: 'reference',
    target: { kind: 'canonical', entity: 'suppliers', on_delete: 'cascade' },
  });
  const { report } = validator.validate(spec);
  assert.ok(report.errors.some((e) => e.code === 'REFERENCE_CASCADE'),
    'deleting a supplier must not silently destroy a company\'s findings about it');
});

test('a cascading reference cycle is refused', () => {
  const spec = minimalSpec();
  spec.data.entities = [
    {
      key: 'alpha', label: 'Alpha', display: { title_field: 'title' },
      fields: [
        { name: 'title', label: 'T', type: 'text', required: true },
        { name: 'beta_id', label: 'B', type: 'reference', target: { kind: 'app', entity: 'beta', on_delete: 'cascade' } },
      ],
    },
    {
      key: 'beta', label: 'Beta', display: { title_field: 'title' },
      fields: [
        { name: 'title', label: 'T', type: 'text', required: true },
        { name: 'alpha_id', label: 'A', type: 'reference', target: { kind: 'app', entity: 'alpha', on_delete: 'cascade' } },
      ],
    },
  ];
  spec.security.roles[0].permissions = { alpha: ['read'], beta: ['read'] };
  spec.security.roles[0].record_scope = { alpha: 'all', beta: 'all' };
  spec.ui.pages[0].entity = 'alpha';
  spec.ui.pages[0].layout = [{ type: 'table', entity: 'alpha', fields: ['title'] }];
  const { report } = validator.validate(spec);
  assert.ok(report.errors.some((e) => e.code === 'CASCADE_CYCLE'));
});

// ===========================================================================
// Validation — workflows
// ===========================================================================
function withWorkflow(states, transitions) {
  const spec = minimalSpec();
  spec.data.entities[0].fields[1].values = states.map((s) => s.key);
  spec.workflows = [{
    key: 'thing_flow', label: 'Flow', entity: 'things', state_field: 'status', states, transitions,
  }];
  return spec;
}

test('a workflow needs exactly one initial state', () => {
  const two = withWorkflow(
    [{ key: 'OPEN', initial: true }, { key: 'DONE', initial: true, terminal: true }],
    [{ key: 'finish', from: 'OPEN', to: 'DONE' }]
  );
  assert.ok(validator.validate(two).report.errors.some((e) => e.code === 'WORKFLOW_INITIAL'));

  const none = withWorkflow(
    [{ key: 'OPEN' }, { key: 'DONE', terminal: true }],
    [{ key: 'finish', from: 'OPEN', to: 'DONE' }]
  );
  assert.ok(validator.validate(none).report.errors.some((e) => e.code === 'WORKFLOW_INITIAL'));
});

test('an unreachable state is refused', () => {
  const spec = withWorkflow(
    [{ key: 'OPEN', initial: true }, { key: 'DONE', terminal: true }, { key: 'LIMBO' }],
    [{ key: 'finish', from: 'OPEN', to: 'DONE' }]
  );
  assert.ok(validator.validate(spec).report.errors.some((e) => e.code === 'STATE_UNREACHABLE'));
});

test('nothing may transition out of a terminal state', () => {
  const spec = withWorkflow(
    [{ key: 'OPEN', initial: true }, { key: 'DONE', terminal: true }],
    [{ key: 'finish', from: 'OPEN', to: 'DONE' }, { key: 'reopen', from: 'DONE', to: 'OPEN' }]
  );
  assert.ok(validator.validate(spec).report.errors.some((e) => e.code === 'TRANSITION_FROM_TERMINAL'));
});

test('the enum and the workflow states must agree', () => {
  const spec = withWorkflow(
    [{ key: 'OPEN', initial: true }, { key: 'DONE', terminal: true }],
    [{ key: 'finish', from: 'OPEN', to: 'DONE' }]
  );
  // Narrow the enum behind the workflow's back.
  spec.data.entities[0].fields[1].values = ['OPEN'];
  const { report } = validator.validate(spec);
  assert.ok(report.errors.some((e) => e.code === 'STATE_NOT_IN_ENUM'),
    'the database would refuse a transition the workflow considers legal');
});

test('a workflow state field must be an enum', () => {
  const spec = withWorkflow(
    [{ key: 'OPEN', initial: true }, { key: 'DONE', terminal: true }],
    [{ key: 'finish', from: 'OPEN', to: 'DONE' }]
  );
  spec.data.entities[0].fields[1].type = 'text';
  assert.ok(validator.validate(spec).report.errors.some((e) => e.code === 'WORKFLOW_STATE_TYPE'));
});

// ===========================================================================
// Validation — security and external exposure
// ===========================================================================
function externalSpec() {
  return {
    key: 'portal_app',
    name: 'Portal App',
    description: 'Has a supplier portal.',
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
          { name: 'cost_impact', label: 'Cost', type: 'money', sensitive: true },
        ],
      }],
    },
    workflows: [],
    security: {
      roles: [
        { key: 'operator', label: 'Operator', audience: 'internal',
          permissions: { findings: ['read', 'create', 'update'] }, record_scope: { findings: 'all' } },
        { key: 'supplier_user', label: 'Supplier', audience: 'supplier',
          permissions: { findings: ['read'] },
          record_scope: { findings: 'anchor' },
          field_access: { findings: { cost_impact: 'hidden' } } },
      ],
    },
    surfaces: [
      { key: 'internal', label: 'Internal', audience: 'internal', roles: ['operator'],
        default_page: 'findings_list', nav: [{ label: 'Findings', page: 'findings_list' }] },
      { key: 'supplier_portal', label: 'Supplier portal', audience: 'supplier', roles: ['supplier_user'],
        default_page: 'portal_list', nav: [{ label: 'Your findings', page: 'portal_list' }] },
    ],
    ui: {
      pages: [
        { key: 'findings_list', title: 'Findings', kind: 'list', surface: 'internal', entity: 'findings',
          layout: [{ type: 'table', entity: 'findings', fields: ['title', 'cost_impact'] }] },
        { key: 'portal_list', title: 'Your findings', kind: 'list', surface: 'supplier_portal', entity: 'findings',
          layout: [{ type: 'table', entity: 'findings', fields: ['title'] }] },
      ],
    },
    analytics: { queries: [], metrics: [] },
    automations: [],
  };
}

test('a correctly-scoped external surface validates', () => {
  const { report } = validator.validate(externalSpec());
  assert.ok(report.ok, JSON.stringify(report.errors, null, 1));
});

test('an external role that is not anchor-scoped is refused', () => {
  const spec = externalSpec();
  spec.security.roles[1].record_scope = { findings: 'all' };
  const { report } = validator.validate(spec);
  assert.ok(report.errors.some((e) => e.code === 'EXTERNAL_SCOPE_REQUIRED'),
    'otherwise every supplier sees every other supplier\'s findings');
});

test('an entity on an external surface must declare an anchor', () => {
  const spec = externalSpec();
  delete spec.data.entities[0].anchor;
  const { report } = validator.validate(spec);
  assert.ok(report.errors.some((e) => e.code === 'EXTERNAL_ENTITY_NO_ANCHOR'));
});

test('a sensitive field may not reach an external surface', () => {
  const spec = externalSpec();
  spec.ui.pages[1].layout[0].fields.push('cost_impact');
  const { report } = validator.validate(spec);
  assert.ok(report.errors.some((e) => e.code === 'EXTERNAL_SENSITIVE_BLOCK'));
});

test('a sensitive field not explicitly hidden from an external role is refused', () => {
  const spec = externalSpec();
  delete spec.security.roles[1].field_access;
  const { report } = validator.validate(spec);
  assert.ok(report.errors.some((e) => e.code === 'EXTERNAL_SENSITIVE_FIELD'));
});

test('an internal canonical column may not be shown on an external surface', () => {
  const spec = externalSpec();
  spec.security.roles[1].permissions.suppliers = ['read'];
  spec.ui.pages[1].layout.push({ type: 'table', entity: 'suppliers', fields: ['legal_name', 'payment_terms'] });
  const { report } = validator.validate(spec);
  assert.ok(report.errors.some((e) => e.code === 'EXTERNAL_CANONICAL_INTERNAL'),
    'payment_terms is internal EMBMIS data');
  assert.equal(canonical.column('suppliers', 'payment_terms').shared, false);
  assert.equal(canonical.column('suppliers', 'legal_name').shared, true);
});

test('an external role may never delete, export or administer', () => {
  const spec = externalSpec();
  spec.security.roles[1].permissions.findings = ['read', 'delete'];
  const { report } = validator.validate(spec);
  assert.ok(report.errors.some((e) => e.code === 'ROLE_EXTERNAL_PERMISSION'));
});

test('an application may only READ canonical EMBMIS data', () => {
  const spec = externalSpec();
  spec.security.roles[0].permissions.suppliers = ['read', 'update'];
  const { report } = validator.validate(spec);
  assert.ok(report.errors.some((e) => e.code === 'ROLE_CANONICAL_WRITE'),
    'writing a supplier goes through the ERP\'s own rules, not a generic runtime');
});

test('an internal role may not be granted on an external surface', () => {
  const spec = externalSpec();
  spec.surfaces[1].roles = ['operator'];
  const { report } = validator.validate(spec);
  assert.ok(report.errors.some((e) => e.code === 'SURFACE_ROLE_AUDIENCE'));
});

test('a comments block on an external page must be shared-visibility', () => {
  const spec = externalSpec();
  spec.ui.pages[1].kind = 'detail';
  spec.ui.pages[1].layout.push({ type: 'comments', entity: 'findings', visibility: 'internal' });
  const { report } = validator.validate(spec);
  assert.ok(report.errors.some((e) => e.code === 'EXTERNAL_COMMENTS_VISIBILITY'));
});

// ===========================================================================
// Validation — automation and AI
// ===========================================================================
test('the automation action vocabulary is closed', () => {
  const spec = minimalSpec();
  spec.automations = [{
    key: 'evil', label: 'Evil', trigger: { kind: 'record_created', entity: 'things' },
    actions: [{ kind: 'run_shell_command', command: 'rm -rf /' }],
  }];
  const { report } = validator.validate(spec);
  assert.ok(report.errors.some((e) => e.code === 'AUTOMATION_ACTION'));

  // There is deliberately no action that runs code or calls an arbitrary URL.
  ['run_code', 'http_request', 'send_email', 'eval', 'exec'].forEach((forbidden) => {
    assert.ok(!Object.prototype.hasOwnProperty.call(AUTOMATION_ACTIONS, forbidden), forbidden);
  });
});

test('an automation trigger loop is refused', () => {
  const spec = minimalSpec();
  spec.automations = [
    { key: 'a', label: 'A', trigger: { kind: 'record_created', entity: 'things' },
      actions: [{ kind: 'create_record', entity: 'things', values: { title: 'x' } }] },
  ];
  const { report } = validator.validate(spec);
  assert.ok(report.errors.some((e) => e.code === 'AUTOMATION_LOOP'));
});

test('an AI agent may not act autonomously on an external surface', () => {
  const spec = externalSpec();
  spec.ai = {
    agents: [{
      key: 'helper', label: 'Helper', purpose: 'x', safety_class: 'act_with_approval',
      entities: ['findings'], tools: [{ kind: 'query_entity', entity: 'findings' }],
      surfaces: ['supplier_portal'],
    }],
  };
  const { report } = validator.validate(spec);
  assert.ok(report.errors.some((e) => e.code === 'AGENT_EXTERNAL_AUTONOMY'));
});

test('an agent tool cannot widen the agent\'s entity list', () => {
  const spec = minimalSpec();
  spec.ai = {
    agents: [{
      key: 'helper', label: 'Helper', purpose: 'x', safety_class: 'read_only',
      entities: ['things'],
      tools: [{ kind: 'query_entity', entity: 'suppliers' }],
      surfaces: ['internal'],
    }],
  };
  const { report } = validator.validate(spec);
  assert.ok(report.errors.some((e) => e.code === 'AGENT_TOOL_SCOPE'));
});

// ===========================================================================
// Validation — UI coherence
// ===========================================================================
test('a page cannot reference a component type that does not exist', () => {
  const spec = minimalSpec();
  spec.ui.pages[0].layout.push({ type: 'iframe', url: 'https://evil.invalid' });
  const { report } = validator.validate(spec);
  assert.ok(report.errors.some((e) => e.code === 'BLOCK_TYPE'));
});

test('a block cannot show a field the entity does not have', () => {
  const spec = minimalSpec();
  spec.ui.pages[0].layout[0].fields.push('password');
  const { report } = validator.validate(spec);
  assert.ok(report.errors.some((e) => e.code === 'BLOCK_FIELD'));
});

test('a form that omits a required field with no default is refused', () => {
  const spec = minimalSpec();
  spec.ui.pages.push({
    key: 'things_new', title: 'New', kind: 'form', surface: 'internal', entity: 'things',
    layout: [{ type: 'form', entity: 'things', fields: ['status'] }],
  });
  spec.surfaces[0].nav.push({ label: 'New', page: 'things_new' });
  const { report } = validator.validate(spec);
  assert.ok(report.errors.some((e) => e.code === 'FORM_MISSING_REQUIRED'),
    'every submission would be rejected by the database');
});

test('navigation cannot cross a surface boundary', () => {
  const spec = externalSpec();
  spec.surfaces[1].nav.push({ label: 'Internal', page: 'findings_list' });
  const { report } = validator.validate(spec);
  assert.ok(report.errors.some((e) => e.code === 'NAV_PAGE_SURFACE'));
});

test('a metric must read a declared query', () => {
  const spec = minimalSpec();
  spec.analytics.metrics = [{ key: 'open_things', label: 'Open things', query: 'no_such_query' }];
  const { report } = validator.validate(spec);
  assert.ok(report.errors.some((e) => e.code === 'METRIC_QUERY'));
});

test('an aggregation over a non-numeric field is refused', () => {
  const spec = minimalSpec();
  spec.analytics.queries = [{
    key: 'total_titles', label: 'Total', entity: 'things', source: 'app', aggregation: 'sum', field: 'title',
  }];
  const { report } = validator.validate(spec);
  assert.ok(report.errors.some((e) => e.code === 'QUERY_FIELD_TYPE'));
});

// ===========================================================================
// Whole applications, from a requirement
// ===========================================================================
const REQUIREMENTS = [
  ['supplier quality with a portal',
    'Build a supplier quality management system where our employees manage findings and suppliers can respond to their own findings in a portal'],
  ['customer warranty portal',
    'Create a customer warranty portal where customers can submit claims and track their status'],
  ['construction inspections',
    'Build a construction site inspection application'],
  ['fleet maintenance',
    'Create a fleet maintenance application'],
  ['something EMBMIS has never seen',
    'Build an application for managing a specialised laboratory certification process'],
];

REQUIREMENTS.forEach(([label, requirement]) => {
  test(`a designed application validates: ${label}`, () => {
    const { brief } = analyzer.analyze(requirement);
    const spec = composer.compose(brief);
    const { report } = validator.validate(spec);
    assert.ok(report.ok, `${label}: ${JSON.stringify(report.errors, null, 1)}`);
    // Not "one table with a form".
    assert.ok(spec.ui.pages.length >= 5, `${label} produced only ${spec.ui.pages.length} screens`);
    assert.ok(spec.analytics.metrics.length >= 1, `${label} has no measures`);
    assert.ok(spec.security.roles.length >= 3, `${label} has no role structure`);
  });
});

test('a portal is only built when the requirement asks for one', () => {
  const withPortal = composer.compose(analyzer.analyze(
    'supplier quality where suppliers respond to their findings in a portal'
  ).brief);
  const withoutPortal = composer.compose(analyzer.analyze(
    'track supplier quality findings internally'
  ).brief);
  assert.ok(withPortal.surfaces.some((s) => s.audience === 'supplier'));
  assert.ok(!withoutPortal.surfaces.some((s) => s.audience !== 'internal'),
    'inferring an external surface from the word "supplier" would create a portal nobody asked for');
});

test('an application designed for an unfamiliar process still gets real structure', () => {
  const { brief, generic } = analyzer.analyze('Build an application for managing a specialised laboratory certification process');
  assert.equal(generic, true, 'this is the fallback path, and it should say so');
  const spec = composer.compose(brief);
  const { report } = validator.validate(spec);
  assert.ok(report.ok);
  assert.ok(spec.workflows.length >= 1, 'even the generic case gets a workflow');
  assert.ok(spec.data.entities[0].fields.length >= 5);
});
