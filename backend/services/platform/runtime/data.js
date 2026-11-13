/**
 * The generic record runtime: list, read, create, update and delete for any
 * entity of any application, with no per-application code.
 *
 * ===========================================================================
 * HOW A QUERY IS BUILT
 * ===========================================================================
 * Every statement in this file is assembled from four kinds of piece:
 *
 *   1. Fixed SQL written here.
 *   2. Identifiers resolved from the SPECIFICATION and the REGISTRY, quoted by
 *      identifiers.quoteIdent(), which refuses anything unexpected.
 *   3. Compiled expression fragments, which are themselves only (1) + (2) +
 *      placeholders.
 *   4. `$n` placeholders, with every value in the params array.
 *
 * A request supplies: an application key, an entity key, field names, operator
 * names, and values. The first four are looked up — a field name that is not a
 * declared field of that entity is refused, never quoted. Values are always
 * bound.
 *
 * ===========================================================================
 * THE THREE GUARDS ON EVERY READ
 * ===========================================================================
 *   company    row-level security, from the session's company context. Not
 *              written here at all, which is the point: it cannot be forgotten.
 *   instance    `t.app_instance_id = $1`. Belt to RLS's braces — one company
 *              running two applications must not have one read the other's
 *              table even if a registry bug pointed it there.
 *   principal   the record scope clause. For an external caller on an anchored
 *               entity this is their own anchor id and nothing else.
 *
 * All three are ANDed in ONE place, `buildWhere()`, so there is no query in
 * this file that can be written without them.
 */

const companyContext = require('../../companyContext');
const { quoteIdent } = require('../identifiers');
const { FIELD_TYPES, FILTER_OPERATORS } = require('../spec/types');
const expressions = require('../spec/expressions');
const canonical = require('../spec/canonical');
const resolver = require('./resolver');
const authz = require('./authorization');

class DataError extends Error {
  constructor(message, code = 'BAD_REQUEST', status = 400, detail = null) {
    super(message);
    this.name = 'DataError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

const MAX_PAGE_SIZE = 200;

// ---------------------------------------------------------------------------
// Value coercion. A value arrives as JSON; the column has a type.
// ---------------------------------------------------------------------------
function coerce(field, value) {
  if (value === null || value === undefined || value === '') {
    if (field.required && field.default === undefined) {
      throw new DataError(`"${field.label || field.name}" is required.`, 'FIELD_REQUIRED');
    }
    return null;
  }
  switch (field.type) {
    case 'integer':
    case 'bigint': {
      const n = Number(value);
      if (!Number.isInteger(n)) throw new DataError(`"${field.label}" must be a whole number.`, 'FIELD_TYPE');
      return n;
    }
    case 'decimal':
    case 'money':
    case 'percent':
    case 'duration_hours': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new DataError(`"${field.label}" must be a number.`, 'FIELD_TYPE');
      return n;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      throw new DataError(`"${field.label}" must be true or false.`, 'FIELD_TYPE');
    case 'date':
    case 'datetime': {
      const t = Date.parse(value);
      if (Number.isNaN(t)) throw new DataError(`"${field.label}" must be a date.`, 'FIELD_TYPE');
      return field.type === 'date' ? new Date(t).toISOString().slice(0, 10) : new Date(t).toISOString();
    }
    case 'enum':
      if (!field.values?.includes(String(value))) {
        throw new DataError(`"${field.label}" must be one of: ${(field.values || []).join(', ')}.`, 'FIELD_ENUM');
      }
      return String(value);
    case 'reference': {
      const s = String(value);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
        throw new DataError(`"${field.label}" must reference an existing record.`, 'FIELD_REFERENCE');
      }
      return s;
    }
    case 'json':
      if (typeof value === 'string') {
        try { return JSON.stringify(JSON.parse(value)); } catch { throw new DataError(`"${field.label}" must be valid JSON.`, 'FIELD_TYPE'); }
      }
      return JSON.stringify(value);
    case 'geo_point': {
      const lat = Number(value.lat ?? value.latitude);
      const lng = Number(value.lng ?? value.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new DataError(`"${field.label}" needs a latitude and a longitude.`, 'FIELD_TYPE');
      }
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        throw new DataError(`"${field.label}" is not a point on Earth.`, 'FIELD_RANGE');
      }
      return { lat, lng };
    }
    default: {
      const s = String(value);
      // TEXT has no length limit in Postgres, but an unbounded string in a
      // business field is almost always a paste accident or an attack, and the
      // difference between 100kB and 1MB in a "notes" column is not worth the
      // storage or the render.
      const max = field.type === 'long_text' ? 20000 : 1000;
      if (s.length > max) throw new DataError(`"${field.label}" is longer than ${max} characters.`, 'FIELD_LENGTH');
      return s;
    }
  }
}

// ---------------------------------------------------------------------------
// SELECT construction
// ---------------------------------------------------------------------------

/**
 * The columns to select, the joins needed to label references, and the
 * expression fragments for computed fields.
 */
function buildProjection({ entity, readable, tables, alias = 't', includeComputed = true }) {
  const columns = [`${alias}.${quoteIdent('id')} AS "id"`];
  const joins = [];
  const labelled = [];
  let joinIndex = 0;

  const resolveField = (name) => {
    const f = (entity.fields || []).find((x) => x.name === name);
    if (!f) return null;
    if (f.type === 'geo_point') return null;
    return `${alias}.${quoteIdent(name)}`;
  };

  (entity.fields || []).forEach((field) => {
    if (!readable.has(field.name)) return;
    if (field.type === 'geo_point') {
      columns.push(`${alias}.${quoteIdent(`${field.name}_lat`)} AS "${field.name}_lat"`);
      columns.push(`${alias}.${quoteIdent(`${field.name}_lng`)} AS "${field.name}_lng"`);
      return;
    }
    columns.push(`${alias}.${quoteIdent(field.name)} AS "${field.name}"`);

    // A reference is useless on screen as a UUID. Join through it for a label —
    // through the canonical catalogue's declared display columns, or through
    // the target entity's own title field. Both are resolved from the
    // specification; neither comes from the request.
    if (field.type === 'reference' && field.target) {
      joinIndex += 1;
      const ref = `r${joinIndex}`;
      if (field.target.kind === 'canonical') {
        const target = canonical.entity(field.target.entity);
        if (!target) return;
        const display = target.display.filter((c) => target.columns[c]);
        if (!display.length) return;
        joins.push(`LEFT JOIN ${quoteIdent(target.table)} ${ref} ON ${ref}.${quoteIdent('id')} = ${alias}.${quoteIdent(field.name)}`);
        const parts = display.map((c) => `COALESCE(${ref}.${quoteIdent(c)}::text, '')`).join(` || ' · ' || `);
        columns.push(`NULLIF(TRIM(BOTH ' ·' FROM (${parts})), '') AS "${field.name}__label"`);
        labelled.push(field.name);
      } else {
        const targetTable = tables.get(field.target.entity);
        if (!targetTable) return;
        const targetEntity = null; // resolved by caller through targetTitles
        void targetEntity;
        const titleField = tables.titles?.get(field.target.entity);
        if (!titleField) return;
        joins.push(`LEFT JOIN ${targetTable.qualified} ${ref} ON ${ref}.${quoteIdent('id')} = ${alias}.${quoteIdent(field.name)}`);
        columns.push(`${ref}.${quoteIdent(titleField)}::text AS "${field.name}__label"`);
        labelled.push(field.name);
      }
    }
  });

  if (includeComputed) {
    (entity.computed || []).forEach((c) => {
      if (!readable.has(c.name)) return;
      try {
        const { ast } = expressions.compile(c.expression, fieldTypesOf(entity));
        const params = [];
        const sql = expressions.toSql(ast, { resolveField, params });
        if (params.length) {
          // A computed field whose expression carried a literal would need
          // parameters interleaved with the projection's own. Rather than
          // thread them through, the compiler inlines nothing and the field is
          // skipped — a computed field with a literal is rare and the honest
          // outcome is to leave it out of the projection rather than emit a
          // query whose parameter numbering is a guess.
          columns.push(`NULL AS "${c.name}"`);
          return;
        }
        columns.push(`(${sql}) AS "${c.name}"`);
      } catch {
        columns.push(`NULL AS "${c.name}"`);
      }
    });
  }

  columns.push(
    `${alias}.${quoteIdent('created_at')} AS "created_at"`,
    `${alias}.${quoteIdent('updated_at')} AS "updated_at"`,
    `${alias}.${quoteIdent('created_by_user_id')} AS "created_by_user_id"`,
    `${alias}.${quoteIdent('created_by_external_id')} AS "created_by_external_id"`
  );

  return { columns, joins, labelled };
}

function fieldTypesOf(entity) {
  const types = {};
  (entity.fields || []).forEach((f) => { types[f.name] = f.type; });
  (entity.computed || []).forEach((c) => { types[c.name] = c.result_type; });
  return types;
}

/**
 * The WHERE clause. The only place the three guards are applied, so there is no
 * query in this module without all three.
 */
function buildWhere({ principal, entity, entityKey, instanceId, filters = [], search = '', extraExpression = '', alias = 't' }) {
  const params = [instanceId];
  const clauses = [
    `${alias}.${quoteIdent('app_instance_id')} = $1::uuid`,
    `${alias}.${quoteIdent('deleted_at')} IS NULL`,
  ];

  const scope = authz.recordScopeClause(principal, entityKey, entity, params.length, alias);
  clauses.push(`(${scope.sql})`);
  params.push(...scope.params);

  const types = fieldTypesOf(entity);
  const { readable } = authz.fieldAccess(principal, entityKey, entity);

  filters.forEach((filter) => {
    const field = (entity.fields || []).find((f) => f.name === filter.field);
    if (!field) {
      throw new DataError(`"${filter.field}" is not a field of ${entityKey}.`, 'FILTER_FIELD');
    }
    if (!readable.has(field.name)) {
      // Filtering on a field you cannot see is a way to read it one bit at a
      // time. Refused for the same reason it is not projected.
      throw new DataError(`You cannot filter ${entityKey} by "${filter.field}".`, 'FILTER_DENIED', 403);
    }
    if (!FILTER_OPERATORS.has(filter.operator)) {
      throw new DataError(`"${filter.operator}" is not a filter operator.`, 'FILTER_OPERATOR');
    }
    const col = `${alias}.${quoteIdent(field.name)}`;
    switch (filter.operator) {
      case 'is_null': clauses.push(`${col} IS NULL`); break;
      case 'is_not_null': clauses.push(`${col} IS NOT NULL`); break;
      case 'contains':
        params.push(`%${String(filter.value)}%`);
        clauses.push(`${col}::text ILIKE $${params.length}`);
        break;
      case 'starts_with':
        params.push(`${String(filter.value)}%`);
        clauses.push(`${col}::text ILIKE $${params.length}`);
        break;
      case 'in':
      case 'not_in': {
        const values = Array.isArray(filter.value) ? filter.value : [filter.value];
        if (!values.length) { clauses.push(filter.operator === 'in' ? 'FALSE' : 'TRUE'); break; }
        if (values.length > 200) throw new DataError('Too many values in an "in" filter.', 'FILTER_SIZE');
        const holes = values.map((v) => { params.push(coerce(field, v)); return `$${params.length}`; });
        clauses.push(`${col} ${filter.operator === 'in' ? 'IN' : 'NOT IN'} (${holes.join(', ')})`);
        break;
      }
      case 'between': {
        const [from, to] = Array.isArray(filter.value) ? filter.value : [null, null];
        if (from === null || to === null) throw new DataError('A "between" filter needs two values.', 'FILTER_VALUE');
        params.push(coerce(field, from)); const a = `$${params.length}`;
        params.push(coerce(field, to)); const b = `$${params.length}`;
        clauses.push(`${col} BETWEEN ${a} AND ${b}`);
        break;
      }
      default: {
        const ops = { eq: '=', neq: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' };
        params.push(coerce(field, filter.value));
        clauses.push(`${col} ${ops[filter.operator]} $${params.length}`);
      }
    }
  });

  if (search) {
    const searchable = (entity.fields || [])
      .filter((f) => readable.has(f.name) && ['text', 'long_text', 'email', 'slug', 'phone', 'url', 'enum'].includes(f.type));
    if (searchable.length) {
      params.push(`%${String(search).slice(0, 200)}%`);
      const hole = `$${params.length}`;
      clauses.push(`(${searchable.map((f) => `${alias}.${quoteIdent(f.name)}::text ILIKE ${hole}`).join(' OR ')})`);
    } else {
      clauses.push('FALSE');
    }
  }

  // A page- or block-level filter from the SPECIFICATION (not the request).
  // Compiled through the expression language, so it is subject to the same
  // rules as everything else.
  if (extraExpression) {
    const { ast } = expressions.compile(extraExpression, types);
    const exprParams = [];
    const sql = expressions.toSql(ast, {
      resolveField: (name) => (types[name] ? `${alias}.${quoteIdent(name)}` : null),
      params: exprParams,
      context: {
        userId: principal.userId,
        userRole: principal.roleKeys[0] || '',
        surfaceKey: principal.surface?.key || '',
      },
    });
    // Renumber the expression's placeholders onto the end of the shared params.
    const offset = params.length;
    const renumbered = sql.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`);
    params.push(...exprParams);
    clauses.push(`(${renumbered})`);
  }

  return { sql: clauses.join(' AND '), params };
}

function buildOrder(entity, sort, direction, readable, alias = 't') {
  const dir = String(direction).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  if (sort) {
    const field = (entity.fields || []).find((f) => f.name === sort);
    if (!field) throw new DataError(`Cannot sort ${entity.key} by "${sort}".`, 'SORT_FIELD');
    if (!readable.has(field.name)) throw new DataError(`Cannot sort ${entity.key} by "${sort}".`, 'SORT_DENIED', 403);
    if (!FIELD_TYPES[field.type]?.sortable) throw new DataError(`"${sort}" is not a sortable kind of field.`, 'SORT_TYPE');
    return `ORDER BY ${alias}.${quoteIdent(field.name)} ${dir} NULLS LAST, ${alias}.${quoteIdent('id')} DESC`;
  }
  return `ORDER BY ${alias}.${quoteIdent('created_at')} ${dir}, ${alias}.${quoteIdent('id')} DESC`;
}

/** Title fields for every entity, so references can be labelled. */
function titleMap(spec) {
  const map = new Map();
  (spec.data?.entities || []).forEach((e) => {
    const title = e.display?.title_field
      || (e.fields || []).find((f) => ['text', 'slug', 'email'].includes(f.type))?.name;
    if (title) map.set(e.key, title);
  });
  return map;
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

async function list(context, principal, entityKey, options = {}) {
  const entity = resolver.entityDefinition(context.spec, entityKey);
  authz.assertCan(principal, entityKey, 'read');
  const table = await resolver.entityTable(context, entityKey);
  const { readable } = authz.fieldAccess(principal, entityKey, entity);

  const tables = context.tables;
  tables.titles = titleMap(context.spec);

  const { columns, joins } = buildProjection({ entity, readable, tables });
  const where = buildWhere({
    principal, entity, entityKey,
    instanceId: context.instance.id,
    filters: options.filters || [],
    search: options.search || '',
    extraExpression: options.expression || '',
  });

  const pageSize = Math.min(Math.max(1, Number(options.pageSize) || 25), MAX_PAGE_SIZE);
  const page = Math.max(1, Number(options.page) || 1);
  const order = buildOrder(entity, options.sort, options.direction, readable);

  const params = [...where.params];
  params.push(pageSize); const limitHole = `$${params.length}`;
  params.push((page - 1) * pageSize); const offsetHole = `$${params.length}`;

  const sql = `
    SELECT ${columns.join(', ')}
      FROM ${table.qualified} t
      ${joins.join('\n      ')}
     WHERE ${where.sql}
     ${order}
     LIMIT ${limitHole} OFFSET ${offsetHole}`;

  const countSql = `SELECT count(*)::int AS total FROM ${table.qualified} t WHERE ${where.sql}`;

  return companyContext.withCompany(context.instance.companyId, async (client) => {
    const [rows, counted] = await Promise.all([
      client.query(sql, params),
      client.query(countSql, where.params),
    ]);
    return {
      rows: rows.rows,
      total: counted.rows[0].total,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(counted.rows[0].total / pageSize)),
    };
  });
}

async function get(context, principal, entityKey, id) {
  const entity = resolver.entityDefinition(context.spec, entityKey);
  authz.assertCan(principal, entityKey, 'read');
  const table = await resolver.entityTable(context, entityKey);
  const { readable } = authz.fieldAccess(principal, entityKey, entity);

  const tables = context.tables;
  tables.titles = titleMap(context.spec);
  const { columns, joins } = buildProjection({ entity, readable, tables });
  const where = buildWhere({ principal, entity, entityKey, instanceId: context.instance.id });

  const params = [...where.params, id];
  const sql = `
    SELECT ${columns.join(', ')}
      FROM ${table.qualified} t
      ${joins.join('\n      ')}
     WHERE ${where.sql} AND t.${quoteIdent('id')} = $${params.length}::uuid
     LIMIT 1`;

  return companyContext.withCompany(context.instance.companyId, async (client) => {
    const { rows } = await client.query(sql, params);
    if (!rows.length) {
      // Deliberately the same answer whether the record does not exist or is
      // not this principal's: a distinguishable "forbidden" tells an external
      // user which ids exist.
      throw new DataError('No such record.', 'RECORD_NOT_FOUND', 404);
    }
    return rows[0];
  });
}

async function create(context, principal, entityKey, values = {}) {
  const entity = resolver.entityDefinition(context.spec, entityKey);
  authz.assertCan(principal, entityKey, 'create');
  const table = await resolver.entityTable(context, entityKey);

  // An external caller supplying the anchor field is not an error — it is
  // simply ignored, and their own anchor written instead (see rule 2 below).
  // Refusing it would mean a client that echoes a record back on create gets a
  // baffling permission error for a value the server was going to overwrite
  // anyway; every OTHER field they may not write is still refused.
  const anchorField = principal.kind === 'external' ? entity.anchor?.field : null;
  const supplied = Object.keys(values)
    .filter((k) => values[k] !== undefined)
    .filter((k) => k !== anchorField);
  authz.assertFieldWritable(principal, entityKey, entity, supplied);

  const workflow = resolver.workflowForEntity(context.spec, entityKey);

  // Build the row as a name -> {value, cast} map first, then emit SQL from it.
  // Two rules below OVERRIDE whatever the request said, and doing that against
  // a map rather than against a half-built parameter list is what keeps the
  // override from depending on the order the columns happened to be added in.
  const row = new Map();
  row.set('app_instance_id', { value: context.instance.id, cast: '::uuid' });
  row.set('company_id', { value: context.instance.companyId, cast: '::uuid' });

  (entity.fields || []).forEach((field) => {
    let raw = values[field.name];

    // Rule 1: a new record enters its workflow at the initial state, whatever
    // the request asked for. Choosing your own starting state is skipping the
    // workflow on the way in.
    if (workflow && field.name === workflow.state_field) {
      const initial = (workflow.states || []).find((s) => s.initial);
      if (initial) raw = initial.key;
    }

    if (raw === undefined) {
      if (field.required && field.default === undefined) {
        throw new DataError(`"${field.label || field.name}" is required.`, 'FIELD_REQUIRED');
      }
      return;
    }
    const coerced = coerce(field, raw);
    if (field.type === 'geo_point') {
      if (coerced === null) return;
      row.set(`${field.name}_lat`, { value: coerced.lat });
      row.set(`${field.name}_lng`, { value: coerced.lng });
      return;
    }
    row.set(field.name, { value: coerced, cast: field.type === 'json' ? '::jsonb' : '' });
  });

  if (principal.kind === 'external') {
    row.set('created_by_external_id', { value: principal.externalIdentityId, cast: '::uuid' });
    // Rule 2: an external caller does not choose whose record this is. Their
    // own anchor is written over anything they supplied — which is why this
    // happens after the field loop, not inside it.
    if (entity.anchor?.field) {
      row.set(entity.anchor.field, { value: principal.anchor.id, cast: '::uuid' });
    }
  } else {
    row.set('created_by_user_id', { value: principal.userId, cast: '::uuid' });
  }

  const columns = [];
  const holes = [];
  const params = [];
  row.forEach((entry, name) => {
    columns.push(quoteIdent(name));
    params.push(entry.value);
    holes.push(`$${params.length}${entry.cast || ''}`);
  });

  const sql = `INSERT INTO ${table.qualified} (${columns.join(', ')}) VALUES (${holes.join(', ')}) RETURNING ${quoteIdent('id')}`;

  const id = await companyContext.withCompany(context.instance.companyId, async (client) => {
    const { rows } = await client.query(sql, params).catch(translatePgError(entity));
    return rows[0].id;
  });

  return get(context, principal, entityKey, id);
}

async function update(context, principal, entityKey, id, values = {}) {
  const entity = resolver.entityDefinition(context.spec, entityKey);
  authz.assertCan(principal, entityKey, 'update');
  const table = await resolver.entityTable(context, entityKey);

  const supplied = Object.keys(values).filter((k) => values[k] !== undefined);
  if (!supplied.length) return get(context, principal, entityKey, id);
  authz.assertFieldWritable(principal, entityKey, entity, supplied);

  const workflow = resolver.workflowForEntity(context.spec, entityKey);
  if (workflow && supplied.includes(workflow.state_field)) {
    throw new DataError(
      `"${workflow.state_field}" is driven by the "${workflow.label || workflow.key}" workflow. Use a transition rather than editing the field, so its conditions and approvals are applied.`,
      'WORKFLOW_FIELD', 409
    );
  }

  const where = buildWhere({ principal, entity, entityKey, instanceId: context.instance.id });
  const params = [...where.params];
  const assignments = [];

  supplied.forEach((name) => {
    const field = (entity.fields || []).find((f) => f.name === name);
    if (!field) throw new DataError(`"${name}" is not a field of ${entityKey}.`, 'FIELD_UNKNOWN');
    const coerced = coerce(field, values[name]);
    if (field.type === 'geo_point') {
      if (coerced === null) {
        assignments.push(`${quoteIdent(`${name}_lat`)} = NULL`, `${quoteIdent(`${name}_lng`)} = NULL`);
        return;
      }
      params.push(coerced.lat); assignments.push(`${quoteIdent(`${name}_lat`)} = $${params.length}`);
      params.push(coerced.lng); assignments.push(`${quoteIdent(`${name}_lng`)} = $${params.length}`);
      return;
    }
    params.push(coerced);
    assignments.push(`${quoteIdent(name)} = $${params.length}${field.type === 'json' ? '::jsonb' : ''}`);
  });

  // An external caller cannot move a record to a different anchor — that is
  // handing their own record to someone else, or taking someone else's.
  if (principal.kind === 'external' && entity.anchor?.field && supplied.includes(entity.anchor.field)) {
    throw new DataError('You cannot reassign this record to a different account.', 'ANCHOR_IMMUTABLE', 403);
  }

  assignments.push(`${quoteIdent('updated_at')} = CURRENT_TIMESTAMP`);
  if (principal.kind === 'internal') {
    params.push(principal.userId);
    assignments.push(`${quoteIdent('updated_by_user_id')} = $${params.length}::uuid`);
  }

  params.push(id);
  const sql = `UPDATE ${table.qualified} t SET ${assignments.join(', ')}
                WHERE ${where.sql} AND t.${quoteIdent('id')} = $${params.length}::uuid
             RETURNING t.${quoteIdent('id')}`;

  await companyContext.withCompany(context.instance.companyId, async (client) => {
    const { rows } = await client.query(sql, params).catch(translatePgError(entity));
    if (!rows.length) throw new DataError('No such record.', 'RECORD_NOT_FOUND', 404);
  });

  return get(context, principal, entityKey, id);
}

/**
 * Soft delete. The row stays; `deleted_at` is set and every read excludes it.
 *
 * A generated application deleting business records irrecoverably, on a
 * permission a specification granted, is not a power worth having. The row is
 * still there for an audit, and a hard delete is a deliberate operation
 * elsewhere.
 */
async function remove(context, principal, entityKey, id) {
  const entity = resolver.entityDefinition(context.spec, entityKey);
  authz.assertCan(principal, entityKey, 'delete');
  const table = await resolver.entityTable(context, entityKey);
  const where = buildWhere({ principal, entity, entityKey, instanceId: context.instance.id });
  const params = [...where.params, id];

  return companyContext.withCompany(context.instance.companyId, async (client) => {
    const { rows } = await client.query(
      `UPDATE ${table.qualified} t SET ${quoteIdent('deleted_at')} = CURRENT_TIMESTAMP
        WHERE ${where.sql} AND t.${quoteIdent('id')} = $${params.length}::uuid
     RETURNING t.${quoteIdent('id')}`,
      params
    );
    if (!rows.length) throw new DataError('No such record.', 'RECORD_NOT_FOUND', 404);
    return { id, deleted: true };
  });
}

/**
 * Records of one entity that point at a record of another — the "related list".
 */
async function related(context, principal, entityKey, relationshipField, parentId, options = {}) {
  const entity = resolver.entityDefinition(context.spec, entityKey);
  const field = (entity.fields || []).find((f) => f.name === relationshipField && f.type === 'reference');
  if (!field) {
    throw new DataError(`"${relationshipField}" is not a reference field of ${entityKey}.`, 'RELATIONSHIP_UNKNOWN');
  }
  return list(context, principal, entityKey, {
    ...options,
    filters: [...(options.filters || []), { field: relationshipField, operator: 'eq', value: parentId }],
  });
}

/**
 * Read canonical EMBMIS records for a picker or a page block.
 *
 * Read-only by construction — there is no canonical write path in this module,
 * and the validator refuses to grant one.
 */
async function listCanonical(context, principal, entityKey, options = {}) {
  const entity = resolver.canonicalEntity(entityKey);
  if (!(context.spec.data?.canonical_refs || []).includes(entityKey)) {
    throw new DataError(
      `This application does not declare a dependency on canonical entity "${entityKey}".`,
      'CANONICAL_UNDECLARED', 403
    );
  }
  authz.assertCan(principal, entityKey, 'read');

  const readable = authz.canonicalReadableColumns(principal, entityKey);
  const columns = readable.map((c) => `t.${quoteIdent(c)} AS "${c}"`);
  const scope = authz.canonicalScopeClause(principal, entityKey, 't', 0);
  const params = [...scope.params];
  const clauses = [`(${scope.sql})`];

  if (options.search) {
    const searchable = entity.search.filter((c) => readable.includes(c));
    if (searchable.length) {
      params.push(`%${String(options.search).slice(0, 200)}%`);
      clauses.push(`(${searchable.map((c) => `t.${quoteIdent(c)}::text ILIKE $${params.length}`).join(' OR ')})`);
    }
  }
  (options.filters || []).forEach((filter) => {
    const col = canonical.column(entityKey, filter.field);
    if (!col || !readable.includes(filter.field)) {
      throw new DataError(`"${filter.field}" is not a readable column of ${entityKey}.`, 'FILTER_FIELD');
    }
    if (!FILTER_OPERATORS.has(filter.operator)) throw new DataError(`"${filter.operator}" is not a filter operator.`, 'FILTER_OPERATOR');
    const ops = { eq: '=', neq: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' };
    if (ops[filter.operator]) {
      params.push(filter.value);
      clauses.push(`t.${quoteIdent(filter.field)} ${ops[filter.operator]} $${params.length}`);
    } else if (filter.operator === 'contains') {
      params.push(`%${String(filter.value)}%`);
      clauses.push(`t.${quoteIdent(filter.field)}::text ILIKE $${params.length}`);
    }
  });

  const pageSize = Math.min(Math.max(1, Number(options.pageSize) || 50), MAX_PAGE_SIZE);
  params.push(pageSize);
  const sortColumn = readable.includes(entity.defaultSort) ? entity.defaultSort : 'id';

  const sql = `SELECT ${columns.join(', ')} FROM ${quoteIdent(entity.table)} t
                WHERE ${clauses.join(' AND ')}
                ORDER BY t.${quoteIdent(sortColumn)} ASC
                LIMIT $${params.length}`;

  return companyContext.withCompany(context.instance.companyId, async (client) => {
    const { rows } = await client.query(sql, params);
    return { rows, total: rows.length, entity: entityKey };
  });
}

/**
 * Live measures of a canonical entity, for a live_monitor block.
 *
 * The measures are computed by the provider the canonical catalogue names,
 * from this instance's company only, and only for an internal principal who
 * may read the entity: the same checks as listCanonical, plus the one a portal
 * can never pass. There is no table name or column name from the caller here —
 * the provider returns what it computes and the catalogue says what may be
 * shown.
 */
const LIVE_PROVIDERS = {
  supplier_risk: (args) => require('../../supplierRisk').supplierRiskMeasures(args),
  warehouse_twin: (args) => require('../../warehouseTwin').warehouseTwinMeasures(args),
};

async function liveCanonical(context, principal, entityKey) {
  resolver.canonicalEntity(entityKey);
  const live = canonical.live(entityKey);
  if (!live || !LIVE_PROVIDERS[live.provider]) {
    throw new DataError(`"${entityKey}" has no live measures.`, 'LIVE_UNKNOWN', 404);
  }
  if (!(context.spec.data?.canonical_refs || []).includes(entityKey)) {
    throw new DataError(
      `This application does not declare a dependency on canonical entity "${entityKey}".`,
      'CANONICAL_UNDECLARED', 403
    );
  }
  if (principal.kind !== 'internal') {
    throw new DataError('Live measures are not available on this surface.', 'PERMISSION_DENIED', 403);
  }
  authz.assertCan(principal, entityKey, 'read');

  const result = await companyContext.runWithCompany(context.instance.companyId, () => LIVE_PROVIDERS[live.provider]({
    companyId: context.instance.companyId,
    userId: principal.userId,
    role: principal.platformRole || null,
  }));
  const allowed = new Set(['id', 'name', 'supplier_code', 'code', 'risk_band', 'signals', 'proposals', ...Object.keys(live.columns)]);
  return {
    entity: entityKey,
    label: live.label,
    columns: Object.entries(live.columns).map(([name, c]) => ({ name, label: c.label, type: c.type })),
    rows: (result.rows || []).map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => allowed.has(k)))),
    summary: result.summary || null,
    currency: result.currency || null,
    view: live.view || null,
    // A spatial view's model (the twin's bays), computed by the same provider
    // for the same company and principal as the rows.
    ...(live.view && result[live.view] ? { [live.view]: result[live.view] } : {}),
    as_of: new Date().toISOString(),
  };
}

/**
 * Turn a Postgres constraint violation into something a person can act on.
 *
 * Without this the user sees `new row for relation "app_7fa2_c81d_findings"
 * violates check constraint "app_7fa2_c81d_findings_chk_severity"`, which
 * names a table they have never heard of and a constraint the platform
 * generated.
 */
function translatePgError(entity) {
  return (err) => {
    if (err.code === '23514') {
      const field = (entity.fields || []).find((f) => err.constraint?.includes(`_chk_${f.name}`));
      if (field) {
        throw new DataError(
          field.type === 'enum'
            ? `"${field.label}" must be one of: ${(field.values || []).join(', ')}.`
            : `"${field.label}" is not in an accepted format.`,
          'CONSTRAINT_VIOLATION'
        );
      }
      throw new DataError('This record breaks one of the rules this application declares.', 'CONSTRAINT_VIOLATION');
    }
    if (err.code === '23505') {
      const field = (entity.fields || []).find((f) => err.constraint?.includes(`_uq_${f.name}`));
      throw new DataError(
        field ? `Another record already has that "${field.label}".` : 'That value is already taken.',
        'DUPLICATE'
      );
    }
    if (err.code === '23503') {
      throw new DataError('This record points at something that does not exist, or is still referenced by something else.', 'REFERENCE_VIOLATION');
    }
    if (err.code === '23502') {
      throw new DataError('A required value is missing.', 'FIELD_REQUIRED');
    }
    throw err;
  };
}

module.exports = {
  DataError,
  list,
  get,
  create,
  update,
  remove,
  related,
  listCanonical,
  liveCanonical,
  coerce,
  buildWhere,
  buildProjection,
  titleMap,
  MAX_PAGE_SIZE,
};
