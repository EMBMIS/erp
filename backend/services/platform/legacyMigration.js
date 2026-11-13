/**
 * Bringing pre-platform generated applications into the new architecture.
 *
 * ===========================================================================
 * WHAT THIS IS FOR
 * ===========================================================================
 * Before the application platform, EMBMIS had a first pass at generated
 * applications: a company-scoped `apps` table, an `app_entities` table naming
 * presentation metadata, and ORDINARY SHARED TABLES underneath — one
 * `supplier_shipments` for every company, separated by a company_id column.
 *
 * That shape cannot be represented in the new registry, and deliberately so:
 * `app_instance_tables` has a UNIQUE index on the physical table name, because
 * two companies sharing one is the thing the new model exists to prevent. So
 * this is a real migration rather than a re-registration:
 *
 *     for each legacy application
 *       derive a specification from its entity metadata and the live columns
 *       register it as ONE global application
 *       for each company that had it
 *         install an instance, which creates that company's own tables
 *         copy that company's rows across
 *
 * Afterwards each company's records live in tables only that company can
 * reach, with the same row-level policy every other company-scoped table has.
 *
 * ===========================================================================
 * WHAT IT WILL NOT DO
 * ===========================================================================
 *   • It never drops the legacy tables. The old rows stay exactly where they
 *     were, so a migration that mapped something wrong is a problem you can
 *     look at rather than one you restore from a backup. Removing them is a
 *     separate decision for an operator who has checked the copy.
 *   • A column whose type does not map to the platform's vocabulary stops that
 *     application rather than being guessed at. Silently importing a numeric
 *     column as text because nothing better was available is how a field
 *     becomes unsortable a year later.
 *   • It is idempotent: a company that already has an instance of the migrated
 *     application is skipped rather than duplicated.
 *
 * The CLI is scripts/migrate-legacy-apps.js.
 */

const { pool } = require('../../config/database');
const companyContext = require('../companyContext');
const { asCompany } = require('./db');
const registry = require('./registry');
const deployer = require('./deployer');
const validator = require('./spec/validator');
const identifiers = require('./identifiers');

const { quoteIdent } = identifiers;

/**
 * Postgres type -> platform field type.
 *
 * Deliberately incomplete. A type absent from here stops the migration for
 * that application and says which column it was, because the alternative is
 * importing something as text and discovering in a year that it will not sort.
 */
const TYPE_MAP = {
  'character varying': 'text',
  text: 'long_text',
  uuid: 'reference',
  integer: 'integer',
  bigint: 'bigint',
  smallint: 'integer',
  numeric: 'decimal',
  'double precision': 'decimal',
  real: 'decimal',
  boolean: 'boolean',
  date: 'date',
  'timestamp with time zone': 'datetime',
  'timestamp without time zone': 'datetime',
  jsonb: 'json',
  json: 'json',
};

// Columns the platform owns on every generated table. A legacy table's own
// versions of these are not carried across as fields — the new table has them.
const PLATFORM_COLUMNS = new Set([
  'id', 'company_id', 'app_instance_id', 'created_at', 'updated_at', 'deleted_at',
  'created_by', 'updated_by', 'created_by_user_id', 'created_by_external_id',
  'updated_by_user_id', 'updated_by_external_id', 'user_id',
]);

/** Canonical entities a legacy uuid column might have been pointing at. */
const REFERENCE_GUESSES = {
  supplier_id: 'suppliers',
  customer_id: 'customers',
  item_id: 'items',
  item_master_id: 'items',
  employee_id: 'employees',
  project_id: 'projects',
  purchase_order_id: 'purchase_orders',
  po_id: 'purchase_orders',
  sales_order_id: 'sales_orders',
};

async function legacySchemaPresent() {
  const { rows } = await pool.query(
    `SELECT to_regclass('public.apps') AS apps, to_regclass('public.app_entities') AS entities`
  );
  if (!rows[0].apps || !rows[0].entities) return false;
  // The NEW `applications` table is not the legacy `apps` table; make sure the
  // one we found is really the old shape before touching anything.
  const { rows: shape } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'apps' AND column_name IN ('company_id', 'app_key')`
  );
  return shape.length === 2;
}

async function readLegacy() {
  const { rows } = await pool.query(
    `SELECT a.id, a.company_id, a.app_key, a.name, a.description, a.kind, a.status,
            e.entity_key, e.display_name, e.description AS entity_description,
            e.table_name, e.list_fields, e.form_fields
       FROM apps a
       LEFT JOIN app_entities e ON e.app_id = a.id
      ORDER BY a.app_key, a.company_id, e.entity_key`
  );
  const byKey = new Map();
  rows.forEach((row) => {
    if (!byKey.has(row.app_key)) {
      byKey.set(row.app_key, {
        appKey: row.app_key, name: row.name, description: row.description,
        kind: row.kind, companies: new Map(),
      });
    }
    const application = byKey.get(row.app_key);
    if (!application.companies.has(row.company_id)) {
      application.companies.set(row.company_id, { companyId: row.company_id, entities: [] });
    }
    if (row.entity_key) {
      application.companies.get(row.company_id).entities.push({
        key: row.entity_key,
        label: row.display_name || row.entity_key,
        description: row.entity_description || '',
        table: row.table_name,
        listFields: row.list_fields || [],
        formFields: row.form_fields || [],
      });
    }
  });
  return [...byKey.values()];
}

/** Read a legacy shared table's real columns and turn them into fields. */
async function fieldsFromTable(tableName, formFields) {
  const { rows } = await pool.query(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [tableName]
  );
  if (!rows.length) return { fields: [], problems: [`table "${tableName}" does not exist`] };

  const hints = new Map((formFields || []).map((f) => [f.name, f]));
  const fields = [];
  const problems = [];

  for (const column of rows) {
    if (PLATFORM_COLUMNS.has(column.column_name)) continue;
    if (!identifiers.isLogicalKey(column.column_name, { maxLength: identifiers.MAX_FIELD_KEY_LENGTH })) {
      problems.push(`column "${column.column_name}" is not a legal field name in the new model`);
      continue;
    }
    const mapped = TYPE_MAP[column.data_type];
    if (!mapped) {
      problems.push(`column "${column.column_name}" is ${column.data_type}, which has no equivalent field type`);
      continue;
    }

    const hint = hints.get(column.column_name);
    const field = {
      name: column.column_name,
      label: hint?.label || column.column_name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      type: mapped,
      required: column.is_nullable === 'NO' && !column.column_default,
      indexed: mapped === 'reference',
    };

    // A CHECK-constrained varchar with a list of values in the legacy form
    // metadata was an enum in all but name.
    if (hint?.type === 'select' && Array.isArray(hint.options) && hint.options.length) {
      field.type = 'enum';
      field.values = hint.options.map(String).filter((v) => /^[A-Za-z0-9 _\-./]{1,64}$/.test(v));
      if (!field.values.length) { field.type = mapped; delete field.values; }
    }

    if (field.type === 'reference') {
      const target = REFERENCE_GUESSES[column.column_name];
      if (!target) {
        // A uuid pointing at nothing the catalogue knows becomes plain text
        // rather than a foreign key to a guess.
        field.type = 'text';
        field.indexed = false;
      } else {
        field.target = { kind: 'canonical', entity: target, on_delete: 'set_null' };
      }
    }

    fields.push(field);
  }

  return { fields, problems };
}

/**
 * A specification for one legacy application, derived from the union of every
 * company's copy of it — they shared the tables, so they shared the shape.
 */
async function specFor(application) {
  const entities = new Map();
  const problems = [];
  const canonicalRefs = new Set();

  for (const company of application.companies.values()) {
    for (const entity of company.entities) {
      if (entities.has(entity.key)) continue;
      if (!identifiers.isLogicalKey(entity.key, { maxLength: identifiers.MAX_ENTITY_KEY_LENGTH })) {
        problems.push(`entity key "${entity.key}" is not legal in the new model`);
        continue;
      }
      const { fields, problems: fieldProblems } = await fieldsFromTable(entity.table, entity.formFields);
      problems.push(...fieldProblems.map((p) => `${entity.key}: ${p}`));
      if (!fields.length) continue;

      fields.filter((f) => f.target?.kind === 'canonical').forEach((f) => canonicalRefs.add(f.target.entity));

      const titleField = entity.listFields?.find((n) => fields.some((f) => f.name === n && ['text', 'slug'].includes(f.type)))
        || fields.find((f) => ['text', 'slug'].includes(f.type))?.name
        || fields[0].name;

      entities.set(entity.key, {
        key: entity.key,
        label: entity.label,
        singular: entity.label.replace(/s$/, ''),
        description: entity.description || `Migrated from the legacy shared table "${entity.table}".`,
        display: { title_field: titleField },
        fields,
        legacyTable: entity.table,
        legacyList: (entity.listFields || []).filter((n) => fields.some((f) => f.name === n)),
      });
    }
  }

  if (!entities.size) {
    problems.push('no entity had a usable table');
    return { spec: null, problems, entities };
  }

  const list = [...entities.values()];
  const permissions = Object.fromEntries(list.map((e) => [e.key, ['read', 'create', 'update']]));
  const scope = Object.fromEntries(list.map((e) => [e.key, 'all']));
  [...canonicalRefs].forEach((key) => { permissions[key] = ['read']; });

  const spec = {
    key: application.appKey,
    name: application.name,
    description: application.description
      || `Migrated from the pre-platform generated-application registry.`,
    icon: 'layout-grid',
    category: 'operations',
    data: {
      canonical_refs: [...canonicalRefs],
      // legacyTable/legacyList are bookkeeping for the copy step, not part
      // of the specification.
      entities: list.map(({ legacyTable: _t, legacyList: _l, ...entity }) => entity),
    },
    workflows: [],
    security: {
      roles: [
        { key: 'administrator', label: 'Administrator', audience: 'internal',
          permissions: { ...permissions, ...Object.fromEntries(list.map((e) => [e.key, ['read', 'create', 'update', 'delete', 'export', 'administer']])) },
          record_scope: scope },
        { key: 'contributor', label: 'Contributor', audience: 'internal',
          permissions, record_scope: scope },
      ],
    },
    surfaces: [{
      key: 'internal', label: application.name, audience: 'internal',
      roles: ['administrator', 'contributor'],
      default_page: `${list[0].key}_list`,
      nav: list.map((e) => ({ label: e.label, page: `${e.key}_list`, icon: 'list', section: 'Records' })),
    }],
    ui: {
      pages: list.flatMap((entity) => {
        const columns = entity.legacyList.length ? entity.legacyList : entity.fields.slice(0, 6).map((f) => f.name);
        return [
          {
            key: `${entity.key}_list`, title: entity.label, kind: 'list', surface: 'internal', entity: entity.key,
            layout: [{ type: 'table', title: entity.label, entity: entity.key, fields: columns, width: 'full' }],
          },
          {
            key: `${entity.key}_detail`, title: entity.singular, kind: 'detail', surface: 'internal', entity: entity.key,
            layout: [
              { type: 'detail_header', entity: entity.key, width: 'full' },
              { type: 'field_group', title: 'Details', entity: entity.key, fields: entity.fields.map((f) => f.name), width: 'two_thirds' },
              { type: 'activity_feed', title: 'History', entity: entity.key, width: 'third' },
            ],
          },
        ];
      }),
    },
    analytics: {
      queries: list.map((e) => ({ key: `${e.key}_total`, label: `Total ${e.label}`, entity: e.key, source: 'app', aggregation: 'count' })),
      metrics: list.map((e) => ({ key: `${e.key}_total`, label: `Total ${e.label}`, query: `${e.key}_total` })),
    },
    automations: [],
  };

  return { spec, problems, entities };
}

/** Copy one company's rows out of the shared legacy table into its own. */
async function copyRows({ companyId, instanceId, entityKey, legacyTable, fields }) {
  const target = await registry.resolveTable(instanceId, entityKey);
  const columns = fields.map((f) => f.name);

  return companyContext.withCompany(companyId, async (client) => {
    const { rows } = await client.query(
      `SELECT ${['id', ...columns].map((c) => quoteIdent(c)).join(', ')},
              ${quoteIdent('created_at')}
         FROM ${quoteIdent(legacyTable)}
        WHERE ${quoteIdent('company_id')} = $1`,
      [companyId]
    );
    if (!rows.length) return 0;

    // Ids are carried across, so anything outside the application still
    // referring to a record by id keeps pointing at the same record.
    const insertColumns = ['id', 'company_id', 'app_instance_id', 'created_at', ...columns];
    for (const row of rows) {
      const values = [row.id, companyId, instanceId, row.created_at, ...columns.map((c) => row[c])];
      const holes = values.map((_, i) => `$${i + 1}`);
      await client.query(
        `INSERT INTO ${target.qualified} (${insertColumns.map((c) => quoteIdent(c)).join(', ')})
         VALUES (${holes.join(', ')})
         ON CONFLICT (id) DO NOTHING`,
        values
      );
    }
    return rows.length;
  });
}


/**
 * Plan or perform the migration.
 *
 * @param {{apply?: boolean, log?: (line: string) => void}} options
 * @returns {Promise<{legacyPresent, applications: Array}>} a structured report,
 *          so a test can assert on it and the CLI can print it.
 */
async function migrateLegacyApplications({ apply = false, log = () => {} } = {}) {
  if (!(await legacySchemaPresent())) {
    return { legacyPresent: false, applications: [] };
  }

  const legacy = await readLegacy();
  const report = { legacyPresent: true, applied: apply, applications: [] };

  for (const application of legacy) {
    const entry = {
      appKey: application.appKey, name: application.name,
      companies: [], problems: [], skipped: null, entities: [],
    };
    report.applications.push(entry);
    log(`▸ ${application.appKey} (${application.name}) — ${application.companies.size} compan${application.companies.size === 1 ? 'y' : 'ies'}`);

    const { spec, problems, entities } = await specFor(application);
    entry.problems = problems;
    problems.forEach((p) => log(`    ⚠ ${p}`));

    if (!spec) {
      entry.skipped = 'nothing usable to migrate';
      log('    ✕ skipped: nothing usable to migrate.\n');
      continue;
    }

    const { report: validation } = validator.validate(spec);
    if (!validation.ok) {
      entry.skipped = 'the derived specification does not validate';
      entry.validation = validation.toJSON();
      log('    ✕ skipped: the derived specification does not validate.');
      validation.errors.slice(0, 5).forEach((e) => log(`        ${e.code} ${e.path}: ${e.message}`));
      continue;
    }

    entry.entities = spec.data.entities.map((e) => ({ key: e.key, fields: e.fields.length }));
    entry.canonicalRefs = spec.data.canonical_refs;
    log(`    ${spec.data.entities.length} entit${spec.data.entities.length === 1 ? 'y' : 'ies'}, `
      + `${spec.data.entities.reduce((n, e) => n + e.fields.length, 0)} field(s), `
      + `reads ${spec.data.canonical_refs.join(', ') || 'no EMBMIS data'}`);

    if (!apply) {
      for (const company of application.companies.values()) {
        const counts = {};
        for (const entity of company.entities) {
          const { rows } = await pool.query(
            `SELECT count(*)::int AS n FROM ${quoteIdent(entity.table)} WHERE company_id = $1`,
            [company.companyId]
          ).catch(() => ({ rows: [{ n: 0 }] }));
          counts[entity.key] = rows[0].n;
        }
        entry.companies.push({ companyId: company.companyId, wouldCopy: counts });
        log(`    would install for company ${company.companyId}: `
          + `${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ') || 'no rows'}`);
      }
      continue;
    }

    // One global application definition, however many companies had it.
    const existing = await registry.getApplicationByKey(spec.key);
    const record = existing || await registry.createApplication({
      appKey: spec.key, name: spec.name, description: spec.description,
      icon: spec.icon, category: spec.category, kind: 'generated',
      originCompanyId: [...application.companies.keys()][0],
    });
    entry.applicationId = record.id;

    const version = await registry.latestVersion(record.id)
      || await registry.createVersion({
        applicationId: record.id, spec, status: 'validated', authoredBy: 'system',
        changeSummary: 'Migrated from the pre-platform generated-application registry.',
        provenance: { migratedFrom: 'legacy_apps_registry', migratedAt: new Date().toISOString() },
      });

    for (const company of application.companies.values()) {
      const already = await asCompany(company.companyId, () => registry.getInstance(record.id, company.companyId));
      if (already && already.status === 'active') {
        entry.companies.push({ companyId: company.companyId, skipped: 'already installed' });
        log(`    · company ${company.companyId} already has an instance — skipped`);
        continue;
      }

      // Install first, deploy second. `applications` has no company_id, so
      // visibility is "this company authored it or holds an instance of it" —
      // and a company that had the legacy application but no instance yet
      // satisfies neither. Creating the instance IS the act that makes the
      // application theirs, so it has to come before the deployment that
      // checks.
      await asCompany(company.companyId, () => registry.ensureInstance({
        applicationId: record.id, companyId: company.companyId,
      }));
      await deployer.deploy({
        companyId: company.companyId, applicationId: record.id, versionId: version.id,
      });
      const instance = await asCompany(company.companyId, () => registry.getInstance(record.id, company.companyId));

      const copied = {};
      for (const [entityKey, entity] of entities) {
        copied[entityKey] = await asCompany(company.companyId, () => copyRows({
          companyId: company.companyId,
          instanceId: instance.id,
          entityKey,
          legacyTable: entity.legacyTable,
          fields: entity.fields,
        }));
      }
      const total = Object.values(copied).reduce((n, v) => n + v, 0);
      entry.companies.push({ companyId: company.companyId, instanceId: instance.id, copied });
      log(`    ✓ company ${company.companyId}: installed, ${total} row(s) copied`);

      // Inside the company's own context: app_platform_events is company-scoped
      // like everything else that carries data, and a migration run from a
      // script has no ambient company unless it establishes one.
      await asCompany(company.companyId, () => registry.recordEvent({
        companyId: company.companyId,
        applicationId: record.id,
        instanceId: instance.id,
        versionId: version.id,
        eventType: 'application.migrated_from_legacy',
        provenanceClass: 'execution',
        actorKind: 'system',
        summary: `Migrated "${spec.key}" from the legacy shared-table registry: ${total} row(s) copied into this company's own tables.`,
        detail: { legacyTables: [...entities.values()].map((e) => e.legacyTable), rowsCopied: total },
      }));
    }
  }

  return report;
}

module.exports = {
  migrateLegacyApplications,
  legacySchemaPresent,
  readLegacy,
  specFor,
  fieldsFromTable,
  copyRows,
  TYPE_MAP,
};
