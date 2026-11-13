const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { auth } = require('../middleware/auth');

/**
 * Monthly series for the KPI cards.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Every module overview leads with a row of readings, and a reading without a
 * shape beside it is half a fact: "52 orders" does not say whether that is a
 * good month. The counts themselves come from each module's own /stats, which
 * are point-in-time by design — so the shape has to come from somewhere, and
 * the honest somewhere is the created_at every one of these tables already
 * carries. This walks it once, per entity, in one round trip.
 *
 * WHY ONE ENDPOINT RATHER THAN A QUERY PER MODULE
 * ---------------------------------------------------------------------------
 * The question is identical in every case — how many of these per month, and
 * how much were they worth — and it was going to be written five times with
 * five slightly different opinions about empty months and date columns. The
 * whitelist below is the only place a table name can enter a query here; there
 * is no path from a request parameter to SQL except through it.
 *
 * Months with nothing in them come back as zeros rather than missing. A gap in
 * a series is a drawing artefact, not a fact about the business.
 */

// entity -> how to count it.
//   scope  the per-user column where the module isolates records that way, so a
//          series agrees with the counter above it.
//   soft   whether the table has deleted_at. Five of these do not, and asking
//          for a column that is not there throws — which the per-entity catch
//          below would swallow into a silently missing card. Stated per entity
//          so the absence is a fact in the table rather than a runtime surprise.
const ENTITIES = {
  sales_orders:           { table: 'sales_orders',           date: 'created_at', value: 'total_amount',          scope: 'created_by',   soft: true },
  sales_quotations:       { table: 'sales_quotations',       date: 'created_at', value: 'total_amount',          scope: null,           soft: true },
  sales_contracts:        { table: 'sales_contracts',        date: 'created_at', value: 'contract_value',        scope: null,           soft: true },
  sales_rfqs:             { table: 'sales_rfqs',             date: 'created_at', value: 'supplier_total_amount', scope: null,           soft: true },
  delivery_schedules:     { table: 'delivery_schedules',     date: 'created_at', value: null,                    scope: null,           soft: true },
  customer_invoices:      { table: 'customer_invoices',      date: 'created_at', value: 'total_amount',          scope: null,           soft: true },
  supplier_invoices:      { table: 'supplier_invoices',      date: 'created_at', value: 'total_amount',          scope: null,           soft: true },
  work_orders:            { table: 'work_orders',            date: 'created_at', value: null,                    scope: null,           soft: true },
  purchase_orders:        { table: 'purchase_orders',        date: 'created_at', value: 'total_amount',          scope: 'created_by',   soft: false },
  purchase_requisitions:  { table: 'purchase_requisitions',  date: 'created_at', value: null,                    scope: 'requested_by', soft: false },
  procurement_rfqs:       { table: 'request_for_quotations', date: 'created_at', value: null,                    scope: 'created_by',   soft: false },
  suppliers:              { table: 'suppliers',              date: 'created_at', value: null,                    scope: null,           soft: false },
  inventory_items:        { table: 'inventory_items',        date: 'created_at', value: null,                    scope: 'user_id',      soft: false },
  projects:               { table: 'projects',               date: 'created_at', value: 'budget_amount',         scope: 'created_by',   soft: true },
  employees:              { table: 'employees',              date: 'created_at', value: null,                    scope: null,           soft: true  },
  deals:                  { table: 'deals',                  date: 'created_at', value: 'value',                 scope: null,           soft: true  },
  contacts:               { table: 'contacts',               date: 'created_at', value: null,                    scope: null,           soft: true  },
};

// GET /kpi-series?entities=sales_orders,sales_quotations&months=12
router.get('/', auth, async (req, res) => {
  const requested = String(req.query.entities || '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => Object.prototype.hasOwnProperty.call(ENTITIES, v));

  if (!requested.length) {
    return res.status(400).json({
      success: false,
      error: 'entities must name at least one known series',
      available: Object.keys(ENTITIES),
    });
  }

  const m = parseInt(req.query.months, 10);
  const months = Number.isInteger(m) ? Math.min(Math.max(m, 2), 36) : 12;

  try {
    const out = {};
    await Promise.all(requested.map(async (name) => {
      const e = ENTITIES[name];
      const values = [months];
      let scope = '';
      if (e.scope && req.user?.id) {
        values.push(req.user.id);
        scope = `AND t.${e.scope} = $${values.length}`;
      }
      const valueExpr = e.value ? `COALESCE(SUM(t.${e.value}), 0)` : '0';

      try {
        const { rows } = await pool.query(
          `WITH span AS (
             SELECT generate_series(
               date_trunc('month', CURRENT_DATE) - make_interval(months => $1::int - 1),
               date_trunc('month', CURRENT_DATE),
               interval '1 month')::date AS m
           ),
           agg AS (
             SELECT date_trunc('month', t.${e.date})::date AS m,
                    COUNT(*)::int AS n,
                    ${valueExpr}::float8 AS v
               FROM ${e.table} t
              WHERE t.${e.date} >= date_trunc('month', CURRENT_DATE) - make_interval(months => $1::int - 1)
                ${e.soft ? 'AND t.deleted_at IS NULL' : ''}
                ${scope}
              GROUP BY 1
           )
           SELECT to_char(span.m, 'YYYY-MM') AS month,
                  COALESCE(agg.n, 0)::int AS count,
                  COALESCE(agg.v, 0)::float8 AS value
             FROM span LEFT JOIN agg ON agg.m = span.m
            ORDER BY span.m`,
          values
        );
        out[name] = rows;
      } catch (error) {
        // One entity failing must not take the row of cards with it: a table
        // this deployment does not have, or a column an older migration never
        // added, is a missing series and not a broken page.
        console.error(`kpi-series: ${name} unavailable —`, error.message);
        out[name] = null;
      }
    }));

    res.json({ success: true, months, data: out });
  } catch (error) {
    console.error('kpi-series error:', error);
    res.status(500).json({ success: false, error: 'Failed to build KPI series' });
  }
});

module.exports = router;
