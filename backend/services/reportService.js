/**
 * Saved reports: definition, execution, export and scheduled distribution.
 *
 * SECURITY POSTURE
 * ================
 * A saved report can hold SQL, which makes this a query surface. It reuses
 * `nlQuery.validateSql` and `nlQuery.runReadOnly` rather than growing its own
 * checks — two query surfaces with slightly different rules is how one of them
 * ends up weaker, and the weaker one is the one that gets found.
 *
 * Two consequences worth stating plainly:
 *
 *   1. SQL is validated on save AND again on every run. The second is not
 *      redundant: a row can reach `report_definitions` without passing through
 *      the save path — a migration, a restore, a fixture, anyone with table
 *      access — and a stored query that is executed on a schedule with its
 *      results emailed out is a bad thing to run unchecked.
 *
 *   2. Parameters are bound, never interpolated. A report's declared parameters
 *      are passed to the driver as bind values, so a date range typed by a user
 *      cannot change the shape of the query. Reports are shared and re-run by
 *      people who did not write them, which is precisely when an injection
 *      point does the most damage.
 */

const { pool } = require('../config/database');
const nlQuery = require('./ai/nlQuery');

const MAX_INTERVAL_LABEL = 'five minutes';

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const Reports = {
  async create(data, userId) {
    const { name, description, category, report_type, sql_text, builtin_key,
            parameters, visualization, is_shared } = data;

    if (!name || !String(name).trim()) throw new Error('A report needs a name.');
    const type = report_type || 'QUERY';

    if (type === 'QUERY') {
      if (!sql_text) throw new Error('A query report needs SQL.');
      const check = nlQuery.validateSql(sql_text);
      if (!check.ok) throw new Error(`This query cannot be saved: ${check.reason}`);
    } else if (!builtin_key) {
      throw new Error('A built-in report needs a builtin_key.');
    }

    const declared = normaliseParameters(parameters);

    const { rows } = await pool.query(
      `INSERT INTO report_definitions
         (name, description, category, report_type, sql_text, builtin_key,
          parameters, visualization, owner_id, is_shared, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9) RETURNING *`,
      [String(name).trim(), description || null, category || 'GENERAL', type,
       type === 'QUERY' ? sql_text : null, type === 'BUILTIN' ? builtin_key : null,
       JSON.stringify(declared),
       JSON.stringify(visualization || { type: 'table' }),
       userId, is_shared === true]
    );
    return rows[0];
  },

  async update(id, fields, userId) {
    if (fields.sql_text !== undefined) {
      const check = nlQuery.validateSql(fields.sql_text);
      if (!check.ok) throw new Error(`This query cannot be saved: ${check.reason}`);
    }

    const allowed = ['name', 'description', 'category', 'sql_text', 'builtin_key',
                     'is_shared', 'parameters', 'visualization'];
    const sets = [];
    const params = [id];
    for (const key of allowed) {
      if (fields[key] === undefined) continue;
      const value = key === 'parameters' ? JSON.stringify(normaliseParameters(fields[key]))
        : key === 'visualization' ? JSON.stringify(fields[key])
        : fields[key];
      params.push(value);
      sets.push(`${key} = $${params.length}`);
    }
    if (!sets.length) throw new Error('Nothing to update.');
    sets.push('updated_at = CURRENT_TIMESTAMP');

    const { rows } = await pool.query(
      `UPDATE report_definitions SET ${sets.join(', ')}
        WHERE id = $1 AND deleted_at IS NULL AND is_system = false RETURNING *`,
      params
    );
    if (!rows.length) throw new Error('Report not found, or it is a system report and cannot be changed.');
    return rows[0];
  },

  /**
   * Reports this user can see: their own, plus anything shared.
   *
   * Filtered in SQL rather than after fetching. A private report is usually
   * private because of what its results contain, and its name and SQL often
   * give that away too.
   */
  async findAll({ userId, category, search } = {}) {
    const params = [userId];
    let where = 'WHERE d.deleted_at IS NULL AND (d.is_shared = true OR d.owner_id = $1)';

    if (category) { params.push(category); where += ` AND d.category = $${params.length}`; }
    if (search) { params.push(`%${search}%`); where += ` AND d.name ILIKE $${params.length}`; }

    const { rows } = await pool.query(
      `SELECT d.id, d.name, d.description, d.category, d.report_type, d.builtin_key,
              d.parameters, d.visualization, d.owner_id, d.is_shared, d.is_system,
              d.created_at, d.updated_at,
              u.first_name AS owner_first_name, u.last_name AS owner_last_name,
              (SELECT MAX(run_at) FROM report_runs r WHERE r.report_id = d.id) AS last_run_at
         FROM report_definitions d
         LEFT JOIN users u ON u.id = d.owner_id
         ${where}
         ORDER BY d.category, d.name`,
      params
    );
    return rows;
  },

  async findById(id, userId) {
    const { rows } = await pool.query(
      `SELECT * FROM report_definitions
        WHERE id = $1 AND deleted_at IS NULL AND (is_shared = true OR owner_id = $2)`,
      [id, userId]
    );
    return rows[0] || null;
  },

  async remove(id, userId) {
    const { rows } = await pool.query(
      `UPDATE report_definitions SET deleted_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND deleted_at IS NULL AND is_system = false AND owner_id = $2
        RETURNING id`,
      [id, userId]
    );
    if (!rows.length) throw new Error('Report not found, or you do not own it.');
    return { deleted: true };
  },

  /**
   * Run a report and return its rows.
   *
   * @param {object} opts.parameter_values  Values keyed by declared parameter name.
   * @param {boolean} opts.record           Write a report_runs row (default true).
   */
  async run(id, { parameter_values = {}, record = true } = {}, userId) {
    const report = await this.findById(id, userId);
    if (!report) throw new Error('Report not found.');

    const started = Date.now();
    try {
      let result;

      if (report.report_type === 'BUILTIN') {
        result = await runBuiltin(report.builtin_key, parameter_values);
      } else {
        // Re-validated every run — see the header for why this is not
        // redundant with the check performed on save.
        const check = nlQuery.validateSql(report.sql_text);
        if (!check.ok) {
          throw new Error(`This report's query is no longer permitted: ${check.reason}`);
        }
        const { sql, values } = bindParameters(check.sql, report.parameters, parameter_values);
        result = await nlQuery.runReadOnly(sql, values);
      }

      const duration = Date.now() - started;

      if (record) {
        await pool.query(
          `INSERT INTO report_runs (report_id, status, row_count, duration_ms, parameter_values, run_by)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, result.truncated ? 'TRUNCATED' : 'SUCCESS', result.rows.length,
           duration, JSON.stringify(parameter_values), userId]
        );
      }

      return {
        report: { id: report.id, name: report.name, visualization: report.visualization },
        columns: result.columns,
        rows: result.rows,
        row_count: result.rows.length,
        truncated: result.truncated || false,
        redacted_columns: result.redacted_columns || [],
        duration_ms: duration,
      };
    } catch (error) {
      if (record) {
        await pool.query(
          `INSERT INTO report_runs (report_id, status, duration_ms, error, parameter_values, run_by)
           VALUES ($1,'FAILED',$2,$3,$4,$5)`,
          [id, Date.now() - started, error.message, JSON.stringify(parameter_values), userId]
        ).catch(() => {});
      }
      throw error;
    }
  },

  async runHistory(id, limit = 50) {
    const { rows } = await pool.query(
      `SELECT r.*, u.first_name, u.last_name
         FROM report_runs r LEFT JOIN users u ON u.id = r.run_by
        WHERE r.report_id = $1 ORDER BY r.run_at DESC LIMIT $2`,
      [id, Math.min(Number(limit) || 50, 200)]
    );
    return rows;
  },
};

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

function normaliseParameters(parameters) {
  if (!parameters) return [];
  const list = Array.isArray(parameters) ? parameters : [];
  return list
    .filter((p) => p && p.name)
    .map((p) => ({
      name: String(p.name),
      label: p.label || String(p.name),
      type: ['text', 'number', 'date', 'boolean'].includes(p.type) ? p.type : 'text',
      default: p.default !== undefined ? p.default : null,
      required: p.required === true,
    }));
}

/**
 * Replace `:name` placeholders with positional binds.
 *
 * The SQL text keeps named placeholders because they are what a human writing
 * a report will type, but what reaches the driver is `$1, $2, …` with the
 * values passed separately. Nothing from `values` is ever concatenated into the
 * query string.
 *
 * A `:name` with no declared parameter is an error rather than being left
 * as-is: leaving it would produce a confusing Postgres syntax error at run
 * time, and silently dropping it could change what the query means.
 */
function bindParameters(sql, declared, values) {
  const params = normaliseParameters(declared);
  if (!params.length) return { sql, values: [] };

  const byName = new Map(params.map((p) => [p.name, p]));
  const bound = [];
  const seen = new Map();

  // Skip `::type` casts — those colons are not placeholders.
  const replaced = sql.replace(/::|:([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, name) => {
    if (match === '::') return match;

    const declaration = byName.get(name);
    if (!declaration) {
      throw new Error(`This report uses :${name}, which is not one of its declared parameters.`);
    }

    if (seen.has(name)) return `$${seen.get(name)}`;

    let value = values[name] !== undefined && values[name] !== null && values[name] !== ''
      ? values[name]
      : declaration.default;

    if ((value === null || value === undefined) && declaration.required) {
      throw new Error(`${declaration.label} is required to run this report.`);
    }

    value = coerce(value, declaration.type);
    bound.push(value);
    seen.set(name, bound.length);
    return `$${bound.length}`;
  });

  return { sql: replaced, values: bound };
}

function coerce(value, type) {
  if (value === null || value === undefined) return null;
  if (type === 'number') {
    const n = Number(value);
    if (Number.isNaN(n)) throw new Error(`"${value}" is not a number.`);
    return n;
  }
  if (type === 'boolean') return value === true || value === 'true';
  if (type === 'date') {
    const s = String(value);
    // Rejected rather than passed through: an unparseable date reaching
    // Postgres produces an error naming the query, not the parameter.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`"${value}" is not a date (expected YYYY-MM-DD).`);
    return s;
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Built-in reports
// ---------------------------------------------------------------------------
//
// Packaged reports whose SQL lives here rather than in the database, so it
// cannot be edited into something else. Each returns the same shape as a query
// report.

const BUILTINS = {
  async trial_balance({ as_of }) {
    return simpleQuery(
      `SELECT coa.account_code, coa.account_name, coa.account_type,
              ROUND(SUM(jei.debit_amount), 2)::float  AS total_debit,
              ROUND(SUM(jei.credit_amount), 2)::float AS total_credit,
              ROUND(SUM(jei.debit_amount - jei.credit_amount), 2)::float AS balance
         FROM journal_entry_items jei
         JOIN journal_entries je    ON je.id = jei.journal_entry_id
         JOIN chart_of_accounts coa ON coa.id = jei.account_id
        WHERE je.status = 'POSTED' AND je.deleted_at IS NULL
          AND ($1::date IS NULL OR je.entry_date <= $1)
        GROUP BY coa.account_code, coa.account_name, coa.account_type
       HAVING SUM(jei.debit_amount - jei.credit_amount) <> 0
        ORDER BY coa.account_code`,
      [as_of || null]
    );
  },

  async aged_receivables({ as_of }) {
    return simpleQuery(
      `SELECT c.customer_name,
              ci.invoice_number, ci.invoice_date, ci.due_date,
              ci.total_amount::float, ci.outstanding_amount::float,
              GREATEST(0, COALESCE($1::date, CURRENT_DATE) - ci.due_date) AS days_overdue,
              CASE
                WHEN COALESCE($1::date, CURRENT_DATE) <= ci.due_date THEN 'Current'
                WHEN COALESCE($1::date, CURRENT_DATE) - ci.due_date <= 30 THEN '1-30 days'
                WHEN COALESCE($1::date, CURRENT_DATE) - ci.due_date <= 60 THEN '31-60 days'
                WHEN COALESCE($1::date, CURRENT_DATE) - ci.due_date <= 90 THEN '61-90 days'
                ELSE 'Over 90 days'
              END AS ageing_bucket
         FROM customer_invoices ci
         JOIN customers c ON c.id = ci.customer_id
        WHERE ci.deleted_at IS NULL
          AND ci.status NOT IN ('CANCELLED','PAID')
          AND ci.outstanding_amount > 0
        ORDER BY days_overdue DESC, ci.outstanding_amount DESC`,
      [as_of || null]
    );
  },

  async aged_payables({ as_of }) {
    return simpleQuery(
      // Suppliers carry a legal_name and an optional trade_name — the trading
      // name is what staff recognise, so it leads where one exists.
      `SELECT COALESCE(s.trade_name, s.legal_name) AS supplier_name,
              si.bill_number, si.supplier_invoice_number, si.invoice_date, si.due_date,
              si.total_amount::float, si.outstanding_amount::float,
              GREATEST(0, COALESCE($1::date, CURRENT_DATE) - si.due_date) AS days_overdue
         FROM supplier_invoices si
         JOIN suppliers s ON s.id = si.supplier_id
        WHERE si.deleted_at IS NULL
          AND si.status NOT IN ('CANCELLED','PAID')
          AND si.outstanding_amount > 0
        ORDER BY days_overdue DESC, si.outstanding_amount DESC`,
      [as_of || null]
    );
  },

  async sales_by_customer({ from_date, to_date }) {
    return simpleQuery(
      `SELECT c.customer_name,
              COUNT(DISTINCT ci.id)::int AS invoice_count,
              ROUND(SUM(ci.total_amount - ci.tax_amount), 2)::float AS net_revenue,
              ROUND(SUM(ci.total_amount), 2)::float AS gross_revenue
         FROM customer_invoices ci
         JOIN customers c ON c.id = ci.customer_id
        WHERE ci.deleted_at IS NULL AND ci.status <> 'CANCELLED'
          AND ($1::date IS NULL OR ci.invoice_date >= $1)
          AND ($2::date IS NULL OR ci.invoice_date <= $2)
        GROUP BY c.customer_name
        ORDER BY net_revenue DESC`,
      [from_date || null, to_date || null]
    );
  },

  async inventory_valuation() {
    return simpleQuery(
      `SELECT i.item_code, i.name AS description,
              SUM(ii.current_stock_quantity)::float AS quantity,
              ROUND(AVG(ii.unit_price), 2)::float AS unit_cost,
              ROUND(SUM(ii.current_stock_quantity * COALESCE(ii.unit_price, 0)), 2)::float AS value
         FROM inventory_items ii
         JOIN items i ON i.id = ii.item_master_id
        WHERE ii.current_stock_quantity > 0
        GROUP BY i.item_code, i.name
        ORDER BY value DESC`,
      []
    );
  },

  async project_profitability() {
    return simpleQuery(
      `SELECT p.project_code, p.name, p.status, p.billing_type,
              COALESCE(SUM(te.hours), 0)::float AS hours_logged,
              COALESCE(SUM(te.hours) FILTER (WHERE te.billable AND te.invoice_id IS NULL), 0)::float AS hours_unbilled,
              COALESCE(SUM(te.hours * COALESCE(e.hourly_cost_rate, 0)), 0)::float AS labour_cost,
              COALESCE(SUM(te.hours * COALESCE(te.hourly_rate, 0)) FILTER (WHERE te.billable), 0)::float AS billable_value
         FROM projects p
         LEFT JOIN time_entries te ON te.project_id = p.id
         LEFT JOIN employees e     ON e.id = te.employee_id
        WHERE p.deleted_at IS NULL
        GROUP BY p.id, p.project_code, p.name, p.status, p.billing_type
        ORDER BY billable_value DESC`,
      []
    );
  },

  async sales_pipeline() {
    return simpleQuery(
      `SELECT d.stage, COUNT(*)::int AS deal_count,
              ROUND(SUM(d.value), 2)::float AS total_value,
              ROUND(SUM(d.value * d.probability / 100.0), 2)::float AS weighted_value
         FROM deals d
        WHERE d.deleted_at IS NULL AND d.stage NOT IN ('WON','LOST')
        GROUP BY d.stage
        ORDER BY total_value DESC`,
      []
    );
  },
};

async function runBuiltin(key, parameterValues) {
  const fn = BUILTINS[key];
  if (!fn) {
    throw new Error(`Unknown built-in report "${key}". Available: ${Object.keys(BUILTINS).join(', ')}.`);
  }
  return fn(parameterValues || {});
}

async function simpleQuery(sql, values) {
  const result = await pool.query(sql, values);
  return {
    rows: result.rows,
    columns: result.fields?.map((f) => f.name) || Object.keys(result.rows[0] || {}),
    truncated: false,
    redacted_columns: [],
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Render rows as CSV.
 *
 * Values beginning with =, +, - or @ are prefixed with a single quote. Excel
 * and Sheets treat those as formulas, so a customer named `=cmd|...` in an
 * exported report becomes a live formula on the machine of whoever opens it —
 * CSV injection. Quoting is the standard mitigation and costs nothing.
 */
function toCsv(columns, rows) {
  const escape = (value) => {
    if (value === null || value === undefined) return '';
    let s = String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const header = columns.map(escape).join(',');
  const body = rows.map((r) => columns.map((c) => escape(r[c])).join(',')).join('\n');
  return rows.length ? `${header}\n${body}` : header;
}

function toHtml(name, columns, rows) {
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  return `<!doctype html><meta charset="utf-8"><title>${esc(name)}</title>
<style>body{font:14px system-ui,sans-serif;padding:24px}h1{font-size:18px}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px 10px;text-align:left}
th{background:#f4f4f5}tr:nth-child(even){background:#fafafa}</style>
<h1>${esc(name)}</h1>
<table><thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
<tbody>${rows.map((r) => `<tr>${columns.map((c) => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table>
<p>${rows.length} row${rows.length === 1 ? '' : 's'} — generated ${new Date().toISOString()}</p>`;
}

module.exports = {
  Reports,
  BUILTINS,
  toCsv,
  toHtml,
  bindParameters,
  normaliseParameters,
  MAX_INTERVAL_LABEL,
};
