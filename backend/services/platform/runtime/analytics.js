/**
 * Declarative analytics: a query definition becomes an aggregate SQL statement.
 *
 * ===========================================================================
 * WHY THE SPECIFICATION CANNOT CONTAIN SQL
 * ===========================================================================
 * A dashboard needs "findings per month by severity, high severity only". The
 * obvious way to let a model express that is to let it write the SELECT. That
 * would make every dashboard an arbitrary query against the database, executed
 * under a user's session, with the tenant guard being whatever the model
 * remembered to include.
 *
 * So a query is instead five allowlisted fields — entity, aggregation, field,
 * group_by, time_grain — plus a filter in the expression language. This file
 * turns those into SQL. The result is less expressive than SQL and that is the
 * feature: everything it can express is safe, and everything it cannot express
 * is a gap someone can look at rather than a hole someone can walk through.
 *
 * Every query carries the same three guards as a record read (instance, soft
 * delete, principal scope), so a chart cannot report a number computed over
 * rows the viewer may not see. That matters more than it sounds: "247 open
 * findings" on a supplier's portal, when they have three, discloses the shape
 * of every other supplier's relationship with the company.
 */

const companyContext = require('../../companyContext');
const { quoteIdent } = require('../identifiers');
const { AGGREGATIONS, TIME_GRAINS } = require('../spec/types');
const expressions = require('../spec/expressions');
const resolver = require('./resolver');
const authz = require('./authorization');
const { buildWhere } = require('./data');

class AnalyticsError extends Error {
  constructor(message, code = 'ANALYTICS_ERROR', status = 400) {
    super(message);
    this.name = 'AnalyticsError';
    this.code = code;
    this.status = status;
  }
}

/**
 * The SQL for an aggregation. Every one of these strings is written here; the
 * specification chooses which by name and supplies only the column.
 */
function aggregateSql(aggregation, column) {
  switch (aggregation) {
    case 'count': return 'COUNT(*)::numeric';
    case 'count_distinct': return `COUNT(DISTINCT ${column})::numeric`;
    case 'sum': return `COALESCE(SUM(${column}), 0)::numeric`;
    case 'avg': return `AVG(${column})::numeric`;
    case 'min': return `MIN(${column})::numeric`;
    case 'max': return `MAX(${column})::numeric`;
    case 'median': return `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${column})::numeric`;
    case 'percent_of_total': return 'COUNT(*)::numeric';
    default:
      throw new AnalyticsError(`Aggregation "${aggregation}" is not supported.`, 'AGGREGATION_UNKNOWN');
  }
}

function grainSql(grain, column) {
  if (!TIME_GRAINS.has(grain)) throw new AnalyticsError(`Time grain "${grain}" is not supported.`, 'GRAIN_UNKNOWN');
  // The grain is looked up in a fixed set and then written as a literal here.
  // date_trunc's first argument is a string, so it could take a parameter —
  // but a parameter that must be one of five known values is a lookup wearing a
  // placeholder's clothes, and the lookup is the thing that makes it safe.
  return `DATE_TRUNC('${grain}', ${column})`;
}

/**
 * Run one declared analytics query.
 *
 * @returns {{key, label, rows: [{bucket, label, value}], total, aggregation}}
 */
async function run(context, principal, queryKey, options = {}) {
  const query = resolver.queryDefinition(context.spec, queryKey);
  if (!AGGREGATIONS.has(query.aggregation)) {
    throw new AnalyticsError(`Query "${queryKey}" uses an unsupported aggregation.`, 'AGGREGATION_UNKNOWN');
  }
  return query.source === 'canonical'
    ? runCanonical(context, principal, query, options)
    : runApplication(context, principal, query, options);
}

async function runApplication(context, principal, query, options) {
  const entity = resolver.entityDefinition(context.spec, query.entity);
  authz.assertCan(principal, query.entity, 'read');
  const table = await resolver.entityTable(context, query.entity);
  const { readable } = authz.fieldAccess(principal, query.entity, entity);

  const guard = (name) => {
    if (!readable.has(name)) {
      throw new AnalyticsError(
        `Query "${query.key}" reads "${query.entity}.${name}", which your role cannot see.`,
        'FIELD_DENIED', 403
      );
    }
    return `t.${quoteIdent(name)}`;
  };

  const where = buildWhere({
    principal, entity, entityKey: query.entity,
    instanceId: context.instance.id,
    extraExpression: combineFilters(query.filter, options.filter),
  });

  const params = [...where.params];
  const valueColumn = query.field ? guard(query.field) : null;
  const value = aggregateSql(query.aggregation, valueColumn);

  let bucket = null;
  let bucketLabel = null;
  if (query.time_grain && query.date_field) {
    bucket = grainSql(query.time_grain, guard(query.date_field));
    bucketLabel = `TO_CHAR(${bucket}, ${query.time_grain === 'year' ? "'YYYY'" : query.time_grain === 'month' ? "'YYYY-MM'" : "'YYYY-MM-DD'"})`;
  } else if (query.group_by) {
    bucket = guard(query.group_by);
    bucketLabel = `${bucket}::text`;
  }

  params.push(query.limit);
  const limitHole = `$${params.length}`;

  const sql = bucket
    ? `SELECT ${bucket} AS bucket, ${bucketLabel} AS label, ${value} AS value
         FROM ${table.qualified} t
        WHERE ${where.sql}
        GROUP BY ${bucket}
        ORDER BY ${query.time_grain ? 'bucket ASC' : `value ${query.order === 'asc' ? 'ASC' : 'DESC'}`}
        LIMIT ${limitHole}`
    : `SELECT NULL::text AS bucket, ${quoteLiteralLabel(query.label)} AS label, ${value} AS value
         FROM ${table.qualified} t
        WHERE ${where.sql}
        LIMIT ${limitHole}`;

  return execute(context, query, sql, params);
}

async function runCanonical(context, principal, query, options) {
  const entity = resolver.canonicalEntity(query.entity);
  if (!(context.spec.data?.canonical_refs || []).includes(query.entity)) {
    throw new AnalyticsError(
      `Query "${query.key}" reads canonical entity "${query.entity}", which this application does not declare a dependency on.`,
      'CANONICAL_UNDECLARED', 403
    );
  }
  authz.assertCan(principal, query.entity, 'read');

  const readable = new Set(authz.canonicalReadableColumns(principal, query.entity));
  const guard = (name) => {
    if (!readable.has(name)) {
      throw new AnalyticsError(
        `Query "${query.key}" reads "${query.entity}.${name}", which is not visible to you.`,
        'FIELD_DENIED', 403
      );
    }
    return `t.${quoteIdent(name)}`;
  };

  const scope = authz.canonicalScopeClause(principal, query.entity, 't', 0);
  const params = [...scope.params];
  const clauses = [`(${scope.sql})`];

  const combined = combineFilters(query.filter, options.filter);
  if (combined) {
    const types = Object.fromEntries(Object.entries(entity.columns).map(([n, c]) => [n, c.type]));
    const { ast } = expressions.compile(combined, types);
    const exprParams = [];
    const fragment = expressions.toSql(ast, {
      resolveField: (name) => (readable.has(name) ? `t.${quoteIdent(name)}` : null),
      params: exprParams,
      context: { userId: principal.userId, userRole: principal.roleKeys[0] || '', surfaceKey: principal.surface?.key || '' },
    });
    const offset = params.length;
    clauses.push(`(${fragment.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`)})`);
    params.push(...exprParams);
  }

  const value = aggregateSql(query.aggregation, query.field ? guard(query.field) : null);
  let bucket = null;
  let bucketLabel = null;
  if (query.time_grain && query.date_field) {
    bucket = grainSql(query.time_grain, guard(query.date_field));
    bucketLabel = `TO_CHAR(${bucket}, 'YYYY-MM')`;
  } else if (query.group_by) {
    bucket = guard(query.group_by);
    bucketLabel = `${bucket}::text`;
  }

  params.push(query.limit);
  const limitHole = `$${params.length}`;

  const sql = bucket
    ? `SELECT ${bucket} AS bucket, ${bucketLabel} AS label, ${value} AS value
         FROM ${quoteIdent(entity.table)} t
        WHERE ${clauses.join(' AND ')}
        GROUP BY ${bucket}
        ORDER BY ${query.time_grain ? 'bucket ASC' : `value ${query.order === 'asc' ? 'ASC' : 'DESC'}`}
        LIMIT ${limitHole}`
    : `SELECT NULL::text AS bucket, ${quoteLiteralLabel(query.label)} AS label, ${value} AS value
         FROM ${quoteIdent(entity.table)} t
        WHERE ${clauses.join(' AND ')}
        LIMIT ${limitHole}`;

  return execute(context, query, sql, params);
}

async function execute(context, query, sql, params) {
  const rows = await companyContext.withCompany(context.instance.companyId, async (client) => {
    const result = await client.query(sql, params);
    return result.rows;
  });

  const numbers = rows.map((r) => ({
    bucket: r.bucket,
    label: r.label === null ? '' : String(r.label),
    value: r.value === null ? 0 : Number(r.value),
  }));

  if (query.aggregation === 'percent_of_total') {
    const total = numbers.reduce((sum, r) => sum + r.value, 0);
    numbers.forEach((r) => { r.value = total ? Math.round((r.value / total) * 10000) / 100 : 0; });
  }

  return {
    key: query.key,
    label: query.label,
    entity: query.entity,
    source: query.source,
    aggregation: query.aggregation,
    grouped: !!(query.group_by || query.time_grain),
    timeGrain: query.time_grain || null,
    rows: numbers,
    total: numbers.reduce((sum, r) => sum + r.value, 0),
  };
}

/** Two optional expressions, ANDed. Both are validated before they get here. */
function combineFilters(a, b) {
  if (a && b) return `(${a}) and (${b})`;
  return a || b || '';
}

// A label is a specification string, not user input, but it still reaches SQL
// as a literal, so it is quoted rather than interpolated.
function quoteLiteralLabel(label) {
  return `'${String(label || '').replace(/'/g, "''").slice(0, 200)}'`;
}

/**
 * Every metric on a page, in one pass.
 *
 * A dashboard with twelve tiles should not be twelve round trips from the
 * browser; it should be one request that returns twelve numbers.
 */
async function metrics(context, principal, metricKeys = []) {
  const declared = context.spec.analytics?.metrics || [];
  const wanted = metricKeys.length ? declared.filter((m) => metricKeys.includes(m.key)) : declared;

  const results = [];
  for (const metric of wanted) {
    try {
      const result = await run(context, principal, metric.query);
      results.push({
        key: metric.key,
        label: metric.label,
        format: metric.format,
        unit: metric.unit,
        target: metric.target,
        direction: metric.direction,
        value: result.total,
        series: result.grouped ? result.rows : null,
      });
    } catch (error) {
      // One metric a role cannot see must not blank the whole dashboard. The
      // tile reports why instead.
      results.push({
        key: metric.key,
        label: metric.label,
        format: metric.format,
        value: null,
        error: error.code === 'FIELD_DENIED' || error.status === 403
          ? 'Not visible with your role'
          : 'Unavailable',
      });
    }
  }
  return results;
}

module.exports = { AnalyticsError, run, metrics, aggregateSql, grainSql };
