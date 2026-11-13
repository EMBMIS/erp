/**
 * Turning a native application's tile declarations into numbers.
 *
 * ===========================================================================
 * THE RULE THIS FILE KEEPS
 * ===========================================================================
 * Every identifier that reaches SQL is checked against the canonical
 * catalogue FIRST. Not escaped — checked. A tile naming an entity that does
 * not exist, or a column that entity does not have, throws before a query is
 * built.
 *
 * The declarations live in a reviewed file and no user supplies them, so this
 * is not defending against an attacker. It is defending against the far more
 * likely thing: someone adds a tile with a plausible column name that this
 * schema does not have, and it either returns silent nulls forever or fails at
 * 9am on a Monday on the home page. Failing in the test run is better.
 *
 * Values are bound parameters regardless, and the shape of every aggregate is
 * a fixed string chosen from a closed set. Nothing here interpolates.
 */

const canonical = require('../spec/canonical');
const companyContext = require('../../companyContext');
const manifests = require('./manifests');

class SummaryError extends Error {
  constructor(message, code = 'SUMMARY_ERROR') {
    super(message);
    this.name = 'SummaryError';
    this.code = code;
  }
}

// Closed set. A tile cannot introduce a new aggregate by declaring one.
const AGGREGATES = {
  count: () => 'count(*)',
  sum:   (col) => `coalesce(sum(${col}), 0)`,
  avg:   (col) => `avg(${col})`,
  max:   (col) => `max(${col})`,
  min:   (col) => `min(${col})`,
};

// Likewise for comparisons.
const OPERATORS = {
  eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=', in: 'IN', 'not-in': 'NOT IN',
};

/**
 * Check one tile against the catalogue.
 *
 * Exported because the test runs it over every declared tile: the point is to
 * catch a bad manifest at build time, and a validator nobody calls until
 * runtime does not do that.
 */
function validateTile(tile) {
  const where = `tile "${tile.key}"${tile.appKey ? ` of ${tile.appKey}` : ''}`;
  if (!canonical.entity(tile.entity)) {
    throw new SummaryError(`${where} names unknown entity "${tile.entity}".`, 'UNKNOWN_ENTITY');
  }

  if (!AGGREGATES[tile.aggregate]) {
    throw new SummaryError(`${where} uses unknown aggregate "${tile.aggregate}".`, 'UNKNOWN_AGGREGATE');
  }
  if (tile.aggregate !== 'count') {
    if (!tile.field) throw new SummaryError(`${where} is a ${tile.aggregate} with no field.`, 'MISSING_FIELD');
    if (!canonical.column(tile.entity, tile.field)) {
      throw new SummaryError(`${where} names column "${tile.field}", which ${tile.entity} does not have.`, 'UNKNOWN_COLUMN');
    }
  }
  for (const [column, op, value] of tile.where || []) {
    if (!canonical.column(tile.entity, column)) {
      throw new SummaryError(`${where} filters on "${column}", which ${tile.entity} does not have.`, 'UNKNOWN_COLUMN');
    }
    if (!OPERATORS[op]) throw new SummaryError(`${where} uses unknown operator "${op}".`, 'UNKNOWN_OPERATOR');
    if ((op === 'in' || op === 'not-in') && !Array.isArray(value)) {
      throw new SummaryError(`${where} uses "${op}" with a value that is not a list.`, 'BAD_FILTER');
    }
    if (value === 'TODAY' && !['date', 'datetime'].includes(canonical.column(tile.entity, column).type)) {
      throw new SummaryError(`${where} compares "${column}" to TODAY, but it is not a date.`, 'BAD_FILTER');
    }
  }
  return true;
}

/** Build the statement for one validated tile. */
function tileSql(tile) {
  validateTile(tile);
  const entity = canonical.entity(tile.entity);
  const expr = AGGREGATES[tile.aggregate](tile.field);

  const clauses = [];
  const params = [];
  for (const [column, op, value] of tile.where || []) {
    if (value === 'TODAY') {
      // Resolved here rather than written into the declaration: a date baked
      // into a manifest is correct for exactly one day.
      clauses.push(`${column} ${OPERATORS[op]} CURRENT_DATE`);
    } else if (op === 'in' || op === 'not-in') {
      params.push(value);
      clauses.push(`${column} ${OPERATORS[op]} (SELECT unnest($${params.length}::text[]))`);
    } else {
      params.push(value);
      clauses.push(`${column} ${OPERATORS[op]} $${params.length}`);
    }
  }
  // Soft-deleted rows are not part of any figure. Only where the column
  // exists — the canonical entities are not uniform about it.
  if (canonical.column(tile.entity, 'deleted_at')) clauses.push('deleted_at IS NULL');

  return {
    // Row-level security supplies the company predicate; adding a second one
    // here would be a copy of the rule that can fall out of step with it.
    text: `SELECT ${expr} AS value FROM ${entity.table}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}`,
    params,
  };
}

/**
 * Compute one native application's tiles for a company.
 *
 * A tile that fails is reported as a tile with no value rather than taking the
 * home page down with it — the same posture the generated applications'
 * analytics takes for a metric the caller may not read. A home page missing
 * one number is a smaller problem than a home page missing.
 */
async function summarize(companyId, appKey) {
  const manifest = manifests.get(appKey);
  if (!manifest) throw new SummaryError(`No native application "${appKey}".`, 'UNKNOWN_APPLICATION');
  const declared = manifest.home?.tiles || [];
  if (!declared.length) return [];

  return companyContext.withCompany(companyId, async (client) => {
    const out = [];
    for (const tile of declared) {
      try {
        const { text, params } = tileSql({ ...tile, appKey });
        const { rows } = await client.query(text, params);
        const raw = rows[0]?.value;
        out.push({
          key: tile.key,
          label: tile.label,
          hint: tile.hint || null,
          format: tile.format || 'number',
          value: raw === null || raw === undefined ? null : Number(raw),
        });
      } catch (error) {
        // A module whose tables this deployment does not have is a smaller
        // installation, not a broken one.
        console.warn(`[platform] native tile ${appKey}.${tile.key} failed:`, error.message);
        out.push({ key: tile.key, label: tile.label, hint: tile.hint || null,
          format: tile.format || 'number', value: null, unavailable: true });
      }
    }
    return out;
  });
}

module.exports = { summarize, validateTile, tileSql, SummaryError, AGGREGATES, OPERATORS };
