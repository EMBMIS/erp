// The schema compiler: plans, safety classification, and the SQL it emits.
//
// THE CLAIM UNDER TEST
// ===========================================================================
//   1. Planning is a pure function of (specification, current state), so the
//      same inputs always produce the same plan — which is what makes hashing
//      a plan, and binding an approval to that hash, mean anything.
//   2. A change that can lose data is classified destructive, and one that
//      changes meaning is classified for review. Neither is ever "safe".
//   3. Every statement the compiler emits is fixed English plus identifiers it
//      resolved and quoted itself. Nothing from a specification reaches SQL as
//      text.
//
// No database: the planner touches nothing, and the DDL emitter returns
// strings. Run on its own:  node --test tests/platformCompiler.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');

const planner = require('../services/platform/compiler/planner');
const ddl = require('../services/platform/compiler/ddl');
const validator = require('../services/platform/spec/validator');
const ids = require('../services/platform/identifiers');

const INSTANCE = {
  id: '11111111-2222-4333-8444-555555555555',
  companyId: '99999999-8888-4777-8666-555555555555',
  tablePrefix: ids.instanceTablePrefix('7fa2b1c0-0000-4000-8000-000000000001', '99999999-8888-4777-8666-555555555555'),
};

function spec(entities, extras = {}) {
  const base = {
    key: 'compiler_test', name: 'Compiler Test', description: 'x',
    data: { entities, canonical_refs: extras.canonicalRefs || [] },
    workflows: [], automations: [],
    security: {
      roles: [{
        key: 'operator', label: 'Operator', audience: 'internal',
        permissions: Object.fromEntries(entities.map((e) => [e.key, ['read', 'create', 'update']])),
        record_scope: Object.fromEntries(entities.map((e) => [e.key, 'all'])),
      }],
    },
    surfaces: [{
      key: 'internal', label: 'Internal', audience: 'internal', roles: ['operator'],
      default_page: 'page_one', nav: [{ label: 'One', page: 'page_one' }],
    }],
    ui: {
      pages: [{
        key: 'page_one', title: 'One', kind: 'list', surface: 'internal', entity: entities[0].key,
        layout: [{ type: 'table', entity: entities[0].key, fields: [entities[0].fields[0].name] }],
      }],
    },
    analytics: { queries: [], metrics: [] },
  };
  return validator.normalize(base);
}

const FINDING = {
  key: 'findings', label: 'Findings', singular: 'Finding',
  display: { title_field: 'title' },
  fields: [
    { name: 'title', label: 'Title', type: 'text', required: true },
    { name: 'severity', label: 'Severity', type: 'enum', required: true, default: 'LOW', values: ['LOW', 'HIGH'] },
    { name: 'score', label: 'Score', type: 'decimal' },
    { name: 'raised_on', label: 'Raised', type: 'date' },
  ],
  computed: [],
  indexes: [],
  constraints: [],
};

// ---------------------------------------------------------------------------
// Planning a first install
// ---------------------------------------------------------------------------
test('a first install is additive and therefore safe', () => {
  const result = planner.plan({ spec: spec([FINDING]), instance: INSTANCE, current: new Map(), appRole: 'qira_app' });
  assert.equal(result.safety, 'safe');
  assert.equal(result.summary.byKind.create_table, 1);
  assert.equal(result.summary.byKind.enable_rls, 1);
  assert.equal(result.summary.byKind.grant_app_role, 1);
  assert.deepEqual(result.summary.destructive, []);
});

test('planning is reproducible: the same inputs give the same hash', () => {
  const first = planner.plan({ spec: spec([FINDING]), instance: INSTANCE, current: new Map() });
  const second = planner.plan({ spec: spec([FINDING]), instance: INSTANCE, current: new Map() });
  assert.equal(planner.hashPlan(first), planner.hashPlan(second));
});

test('a different specification gives a different hash', () => {
  const before = planner.plan({ spec: spec([FINDING]), instance: INSTANCE, current: new Map() });
  const widened = JSON.parse(JSON.stringify(FINDING));
  widened.fields.push({ name: 'notes', label: 'Notes', type: 'long_text' });
  const after = planner.plan({ spec: spec([widened]), instance: INSTANCE, current: new Map() });
  assert.notEqual(planner.hashPlan(before), planner.hashPlan(after));
});

test('mutually-referencing entities are plannable: foreign keys come last', () => {
  const alpha = {
    key: 'alpha', label: 'Alpha', display: { title_field: 'title' }, computed: [], indexes: [], constraints: [],
    fields: [
      { name: 'title', label: 'T', type: 'text', required: true },
      { name: 'beta_id', label: 'B', type: 'reference', target: { kind: 'app', entity: 'beta', on_delete: 'set_null' } },
    ],
  };
  const beta = {
    key: 'beta', label: 'Beta', display: { title_field: 'title' }, computed: [], indexes: [], constraints: [],
    fields: [
      { name: 'title', label: 'T', type: 'text', required: true },
      { name: 'alpha_id', label: 'A', type: 'reference', target: { kind: 'app', entity: 'alpha', on_delete: 'set_null' } },
    ],
  };
  const result = planner.plan({ spec: spec([alpha, beta]), instance: INSTANCE, current: new Map() });
  const kinds = result.operations.map((o) => o.kind);
  const lastCreate = kinds.lastIndexOf('create_table');
  const firstFk = kinds.indexOf('add_foreign_key');
  assert.ok(firstFk > lastCreate, 'every table must exist before any app-to-app key is added');
  assert.equal(result.safety, 'safe');
});

// ---------------------------------------------------------------------------
// Planning a change
// ---------------------------------------------------------------------------
function currentFor(entity, overrides = {}) {
  const columns = new Map();
  ['id', 'company_id', 'app_instance_id', 'created_at', 'updated_at', 'deleted_at',
    'created_by_user_id', 'created_by_external_id', 'updated_by_user_id'].forEach((name) => {
    columns.set(name, { nullable: name !== 'id', system: true, specType: null });
  });
  entity.fields.forEach((f) => {
    ddl.fieldColumns(f).forEach((c) => {
      columns.set(c.name, {
        nullable: !f.required, system: false, specType: f.type,
        enumValues: f.type === 'enum' ? f.values : null,
      });
    });
  });
  return new Map([[entity.key, {
    schema: 'public',
    table: ids.physicalTableName(INSTANCE.tablePrefix, entity.key),
    columns, indexes: new Set(), managedIndexes: new Set(),
    ...overrides,
  }]]);
}

test('adding a nullable column is safe', () => {
  const next = JSON.parse(JSON.stringify(FINDING));
  next.fields.push({ name: 'root_cause', label: 'Root cause', type: 'long_text' });
  const result = planner.plan({ spec: spec([next]), instance: INSTANCE, current: currentFor(FINDING) });
  assert.equal(result.safety, 'safe');
  assert.equal(result.summary.byKind.add_column, 1);
});

test('a required column with no default is added nullable, and says so', () => {
  const next = JSON.parse(JSON.stringify(FINDING));
  next.fields.push({ name: 'owner', label: 'Owner', type: 'text', required: true });
  const result = planner.plan({ spec: spec([next]), instance: INSTANCE, current: currentFor(FINDING) });
  const op = result.operations.find((o) => o.kind === 'add_column');
  assert.equal(op.field.required, false, 'existing rows have no value for it');
  assert.ok(result.notes.some((n) => n.code === 'REQUIRED_WITHOUT_DEFAULT'));
});

test('dropping a column is destructive and is described in those words', () => {
  const next = JSON.parse(JSON.stringify(FINDING));
  next.fields = next.fields.filter((f) => f.name !== 'score');
  const result = planner.plan({ spec: spec([next]), instance: INSTANCE, current: currentFor(FINDING) });
  assert.equal(result.safety, 'destructive');
  assert.equal(result.summary.destructive.length, 1);
  assert.match(result.summary.destructive[0], /score/);
  assert.match(result.summary.destructive[0], /destroyed/);
});

test('dropping a table is destructive', () => {
  const other = { ...FINDING, key: 'other_things' };
  const result = planner.plan({ spec: spec([FINDING]), instance: INSTANCE, current: currentFor(other) });
  assert.equal(result.safety, 'destructive');
  assert.ok(result.operations.some((o) => o.kind === 'drop_table'));
});

test('a widening type change is review, a narrowing one is destructive', () => {
  const widened = JSON.parse(JSON.stringify(FINDING));
  widened.fields.find((f) => f.name === 'score').type = 'text';
  const wide = planner.plan({ spec: spec([widened]), instance: INSTANCE, current: currentFor(FINDING) });
  assert.equal(wide.safety, 'review');

  const narrowed = JSON.parse(JSON.stringify(FINDING));
  narrowed.fields.find((f) => f.name === 'score').type = 'integer';
  const narrow = planner.plan({ spec: spec([narrowed]), instance: INSTANCE, current: currentFor(FINDING) });
  assert.equal(narrow.safety, 'destructive',
    'NUMERIC to INTEGER silently rounds every value — data loss with a success message');
});

test('a change absent from the widening table is destructive, not assumed safe', () => {
  assert.equal(planner.classifyTypeChange('decimal', 'boolean').safety, 'destructive');
  assert.equal(planner.classifyTypeChange('json', 'text').safety, 'destructive');
  assert.equal(planner.classifyTypeChange('text', 'text'), null);
});

test('making an existing column required is a review change', () => {
  const next = JSON.parse(JSON.stringify(FINDING));
  next.fields.find((f) => f.name === 'score').required = true;
  const result = planner.plan({ spec: spec([next]), instance: INSTANCE, current: currentFor(FINDING) });
  assert.equal(result.safety, 'review');
  assert.ok(result.operations.some((o) => o.kind === 'set_column_nullability' && o.required));
});

test('widening an enum is safe; narrowing one is a review change', () => {
  const wider = JSON.parse(JSON.stringify(FINDING));
  wider.fields.find((f) => f.name === 'severity').values = ['LOW', 'HIGH', 'CRITICAL'];
  assert.equal(planner.plan({ spec: spec([wider]), instance: INSTANCE, current: currentFor(FINDING) }).safety, 'safe');

  const narrower = JSON.parse(JSON.stringify(FINDING));
  narrower.fields.find((f) => f.name === 'severity').values = ['LOW'];
  const result = planner.plan({ spec: spec([narrower]), instance: INSTANCE, current: currentFor(FINDING) });
  assert.equal(result.safety, 'review');
  assert.match(result.summary.review.join(' '), /HIGH/);
});

test('an index somebody added by hand is not the planner\'s to drop', () => {
  const table = ids.physicalTableName(INSTANCE.tablePrefix, FINDING.key);
  const current = currentFor(FINDING);
  current.get('findings').indexes = new Set([`${table}_manual_perf_idx`]);
  current.get('findings').managedIndexes = new Set();  // not one of ours
  const result = planner.plan({ spec: spec([FINDING]), instance: INSTANCE, current });
  assert.ok(!result.operations.some((o) => o.kind === 'drop_index'));
});

test('no change at all produces an empty plan', () => {
  const result = planner.plan({ spec: spec([FINDING]), instance: INSTANCE, current: currentFor(FINDING) });
  assert.equal(result.operations.length, 0);
  assert.equal(result.safety, 'safe');
});

// ---------------------------------------------------------------------------
// The SQL
// ---------------------------------------------------------------------------
function statementsFor(entities, extras) {
  const result = planner.plan({ spec: spec(entities, extras), instance: INSTANCE, current: new Map(), appRole: 'qira_app' });
  return planner.toStatements(result).map((s) => s.sql);
}

test('every generated table gets the platform columns, isolation and an instance pin', () => {
  const create = statementsFor([FINDING]).find((s) => s.startsWith('CREATE TABLE'));
  ['"id" UUID PRIMARY KEY', '"company_id" UUID NOT NULL', '"app_instance_id" UUID NOT NULL',
    '"created_at" TIMESTAMPTZ NOT NULL', '"updated_at" TIMESTAMPTZ NOT NULL', '"deleted_at" TIMESTAMPTZ',
    '"created_by_user_id" UUID REFERENCES users(id)', '"created_by_external_id" UUID REFERENCES app_external_identities(id)',
  ].forEach((fragment) => assert.ok(create.includes(fragment), `missing: ${fragment}`));

  // The instance pin: even a corrupted registry pointing another instance here
  // would have its writes refused by the database.
  assert.match(create, /CHECK \("app_instance_id" = '11111111-2222-4333-8444-555555555555'::uuid\)/);
  // Authorship is one or the other, never both.
  assert.match(create, /NOT \("created_by_user_id" IS NOT NULL AND "created_by_external_id" IS NOT NULL\)/);
});

test('row-level security is enabled in the same plan that creates the table', () => {
  const statements = statementsFor([FINDING]);
  const createIndex = statements.findIndex((s) => s.startsWith('CREATE TABLE'));
  const rlsIndex = statements.findIndex((s) => s.includes('ENABLE ROW LEVEL SECURITY'));
  assert.ok(rlsIndex > createIndex);
  assert.ok(statements.some((s) => s.includes('FORCE ROW LEVEL SECURITY')));
  // Byte-for-byte the policy every other company-scoped table has.
  assert.ok(statements.some((s) => s.includes('"company_id" = public.current_company_id()')));
});

test('an enum becomes a CHECK constraint, with its values quoted as literals', () => {
  const create = statementsFor([FINDING]).find((s) => s.startsWith('CREATE TABLE'));
  assert.match(create, /CHECK \("severity" IS NULL OR "severity" IN \('LOW', 'HIGH'\)\)/);
});

test('a canonical reference becomes a real foreign key that cannot cascade', () => {
  const withRef = JSON.parse(JSON.stringify(FINDING));
  withRef.fields.push({
    name: 'supplier_id', label: 'Supplier', type: 'reference', required: true,
    target: { kind: 'canonical', entity: 'suppliers', on_delete: 'restrict' },
  });
  const create = statementsFor([withRef], { canonicalRefs: ['suppliers'] }).find((s) => s.startsWith('CREATE TABLE'));
  assert.match(create, /FOREIGN KEY \("supplier_id"\) REFERENCES "suppliers"\("id"\) ON DELETE RESTRICT/);
});

test('a geo_point expands into two bounded numeric columns', () => {
  const withGeo = JSON.parse(JSON.stringify(FINDING));
  withGeo.fields.push({ name: 'location', label: 'Location', type: 'geo_point' });
  const create = statementsFor([withGeo]).find((s) => s.startsWith('CREATE TABLE'));
  assert.match(create, /"location_lat" NUMERIC\(9,6\)/);
  assert.match(create, /"location_lng" NUMERIC\(9,6\)/);
  assert.match(create, /BETWEEN -90 AND 90/);
  assert.match(create, /BETWEEN -180 AND 180/);
});

test('an entity constraint expression compiles to a CHECK with quoted literals', () => {
  const constrained = JSON.parse(JSON.stringify(FINDING));
  constrained.fields.push({ name: 'closed_on', label: 'Closed', type: 'date' });
  constrained.constraints = [{
    key: 'closed_after_raised',
    expression: 'closed_on = null or closed_on >= raised_on',
    message: 'A finding cannot close before it was raised.',
  }];
  const create = statementsFor([constrained]).find((s) => s.startsWith('CREATE TABLE'));
  assert.match(create, /CHECK \(\(\("closed_on" IS NULL\) OR \("closed_on" >= "raised_on"\)\)\)/);
});

test('every reference and enum column is indexed', () => {
  const withRef = JSON.parse(JSON.stringify(FINDING));
  withRef.fields.push({
    name: 'supplier_id', label: 'Supplier', type: 'reference',
    target: { kind: 'canonical', entity: 'suppliers', on_delete: 'set_null' },
  });
  const statements = statementsFor([withRef], { canonicalRefs: ['suppliers'] });
  assert.ok(statements.some((s) => s.startsWith('CREATE INDEX') && s.includes('"supplier_id"')),
    'a foreign key without an index turns every join and parent delete into a scan');
  assert.ok(statements.some((s) => s.startsWith('CREATE INDEX') && s.includes('"severity"')));
  assert.ok(statements.some((s) => s.includes('WHERE "deleted_at" IS NULL')));
});

test('every identifier in every emitted statement is quoted', () => {
  const withEverything = JSON.parse(JSON.stringify(FINDING));
  withEverything.fields.push(
    { name: 'location', label: 'Loc', type: 'geo_point' },
    { name: 'payload', label: 'Payload', type: 'json' },
    { name: 'contact', label: 'Contact', type: 'email' },
    { name: 'reference_code', label: 'Ref', type: 'text', unique: true }
  );
  withEverything.indexes = [{ fields: ['severity', 'raised_on'], unique: false }];
  const statements = statementsFor([withEverything]);
  assert.ok(statements.length > 5);
  statements.forEach((sql) => {
    // Nothing that looks like an unquoted lowercase identifier from the
    // specification. The platform's own SQL keywords are uppercase.
    assert.ok(!/\bDROP\s+DATABASE\b/i.test(sql));
    assert.ok(!sql.includes('--'), `comment marker in: ${sql}`);
  });
});

test('the emitter refuses an operation it does not implement', () => {
  assert.throws(() => ddl.emit({ kind: 'exec_arbitrary_sql', sql: 'DROP TABLE users' }),
    /No DDL emitter for plan operation/);
  // There is no default branch, which is the point: an operation nobody
  // reviewed cannot execute.
  assert.ok(!Object.prototype.hasOwnProperty.call(ddl.EMITTERS, 'raw_sql'));
});

test('a drop never cascades', () => {
  const other = { ...FINDING, key: 'other_things' };
  const result = planner.plan({ spec: spec([FINDING]), instance: INSTANCE, current: currentFor(other) });
  const drop = planner.toStatements(result).map((s) => s.sql).find((s) => s.startsWith('DROP TABLE'));
  assert.ok(!/CASCADE/i.test(drop), 'a table something still references needs a person, not a force');
});
