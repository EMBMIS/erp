const { pool } = require('../config/database');

/**
 * The manufacturing overview, in one round trip.
 *
 * OEE IS COMPUTED, NOT STORED
 * ---------------------------------------------------------------------------
 * Nothing in this schema records an OEE figure, and the three factors behind it
 * come from different places, so it is worth naming what each one is actually
 * measuring here:
 *
 *   Availability  booked hours against the capacity of the work centres that
 *                 booked them. work_centers.daily_capacity_hours x days in the
 *                 window is the denominator.
 *   Performance   planned hours against actual hours. Under 100% means the
 *                 floor took longer than the routing said it would.
 *   Quality       good units against units produced, from quantity_scrapped.
 *
 * Overall OEE is their product, which is the standard definition and is always
 * lower than any single factor. Each returns null rather than a number when its
 * inputs are missing — an OEE of 100% because nothing was booked is worse than
 * no OEE at all, and a null propagates to the overall figure instead of
 * quietly inflating it.
 */
async function getManufacturingAnalytics(months = 12) {
  const days = Math.max(1, months) * 30;

  const [production, statuses, oee, centres, products, materials, shortages, wip, series] =
    await Promise.all([
      pool.query(
        `SELECT
           COALESCE(SUM(wo.quantity_produced), 0)::float8 AS produced,
           COALESCE(SUM(wo.quantity_scrapped), 0)::float8 AS scrapped,
           COALESCE(SUM(wo.quantity_ordered), 0)::float8 AS ordered,
           COALESCE(SUM(wo.completed_value), 0)::float8 AS completed_value,
           COALESCE(SUM(wo.wip_value), 0)::float8 AS wip_value,
           COUNT(*) FILTER (WHERE wo.status IN ('RELEASED', 'IN_PROGRESS'))::int AS open_orders,
           COUNT(*) FILTER (WHERE wo.status = 'COMPLETED'
                              AND wo.actual_end_date IS NOT NULL
                              AND wo.planned_end_date IS NOT NULL
                              AND wo.actual_end_date <= wo.planned_end_date)::int AS on_time,
           COUNT(*) FILTER (WHERE wo.status = 'COMPLETED'
                              AND wo.actual_end_date IS NOT NULL
                              AND wo.planned_end_date IS NOT NULL)::int AS finished
         FROM work_orders wo
        WHERE wo.deleted_at IS NULL
          AND wo.created_at >= date_trunc('year', CURRENT_DATE)`
      ),
      pool.query(
        `SELECT status, COUNT(*)::int AS n
           FROM work_orders
          WHERE deleted_at IS NULL
          GROUP BY status`
      ),
      pool.query(
        `SELECT
           COALESCE(SUM(op.planned_hours), 0)::float8 AS planned_hours,
           COALESCE(SUM(op.actual_hours), 0)::float8 AS actual_hours,
           COALESCE(SUM(DISTINCT wc.daily_capacity_hours), 0)::float8 AS daily_capacity
         FROM work_order_operations op
         JOIN work_centers wc ON wc.id = op.work_center_id
        WHERE op.actual_hours > 0
          AND op.updated_at >= CURRENT_DATE - ($1::int || ' days')::interval`,
        [days]
      ),
      pool.query(
        `SELECT wc.name AS work_center,
                COALESCE(SUM(op.planned_hours), 0)::float8 AS planned_hours,
                COALESCE(SUM(op.actual_hours), 0)::float8 AS actual_hours,
                COUNT(*)::int AS operations
           FROM work_order_operations op
           JOIN work_centers wc ON wc.id = op.work_center_id
          WHERE wc.deleted_at IS NULL
          GROUP BY wc.name
         HAVING SUM(op.actual_hours) > 0
          ORDER BY 4 DESC
          LIMIT 6`
      ),
      pool.query(
        `SELECT i.name AS product,
                COALESCE(SUM(wo.quantity_produced), 0)::float8 AS produced,
                COALESCE(SUM(wo.completed_value), 0)::float8 AS value
           FROM work_orders wo
           JOIN items i ON i.id = wo.item_id
          WHERE wo.deleted_at IS NULL AND wo.quantity_produced > 0
          GROUP BY i.name
          ORDER BY 2 DESC
          LIMIT 6`
      ),
      // What the floor consumed: goods issues raised against a work order,
      // grouped by the category of the item consumed.
      pool.query(
        `SELECT COALESCE(NULLIF(i.category, ''), NULLIF(i.item_category, ''), 'Uncategorised') AS category,
                COALESCE(SUM(wti.total_cost), 0)::float8 AS value
           FROM warehouse_transaction_items wti
           JOIN warehouse_transactions wt ON wt.id = wti.warehouse_transaction_id
           LEFT JOIN inventory_items ii ON ii.id = wti.inventory_item_id
           LEFT JOIN items i ON i.id = ii.item_master_id
          WHERE wt.transaction_type = 'GI'
            AND wt.status = 'POSTED'
            AND wt.reference_type = 'WORK_ORDER'
            AND wt.transaction_date >= date_trunc('year', CURRENT_DATE)
          GROUP BY 1
         HAVING SUM(wti.total_cost) > 0
          ORDER BY 2 DESC
          LIMIT 6`
      ),
      // A shortage is what MRP already worked out: net requirement above zero
      // on the most recent run.
      pool.query(
        `SELECT i.name AS item, i.item_code,
                po.gross_requirement::float8 AS required,
                po.on_hand::float8 AS available,
                po.net_requirement::float8 AS shortage,
                po.required_by
           FROM mrp_planned_orders po
           JOIN items i ON i.id = po.item_id
          WHERE po.net_requirement > 0
            AND po.run_id = (SELECT run_id FROM mrp_planned_orders ORDER BY id DESC LIMIT 1)
          ORDER BY po.net_requirement DESC
          LIMIT 6`
      ),
      pool.query(
        `SELECT wo.wo_number, i.name AS product, wc.name AS work_center,
                wo.quantity_ordered::float8 AS quantity,
                wo.quantity_produced::float8 AS produced,
                wo.planned_end_date, wo.status
           FROM work_orders wo
           JOIN items i ON i.id = wo.item_id
           LEFT JOIN LATERAL (
             SELECT work_center_id FROM work_order_operations
              WHERE work_order_id = wo.id ORDER BY operation_number LIMIT 1
           ) op ON TRUE
           LEFT JOIN work_centers wc ON wc.id = op.work_center_id
          WHERE wo.deleted_at IS NULL
            AND wo.status IN ('RELEASED', 'IN_PROGRESS', 'DRAFT')
          ORDER BY wo.planned_end_date NULLS LAST
          LIMIT 6`
      ),
      pool.query(
        `WITH span AS (
           SELECT generate_series(
             date_trunc('month', CURRENT_DATE) - make_interval(months => $1::int - 1),
             date_trunc('month', CURRENT_DATE),
             interval '1 month')::date AS m
         ),
         agg AS (
           SELECT date_trunc('month', wo.created_at)::date AS m,
                  COALESCE(SUM(wo.quantity_produced), 0)::float8 AS produced,
                  COALESCE(SUM(wo.completed_value), 0)::float8 AS value,
                  COUNT(*)::int AS orders
             FROM work_orders wo
            WHERE wo.deleted_at IS NULL
              AND wo.created_at >= date_trunc('month', CURRENT_DATE) - make_interval(months => $1::int - 1)
            GROUP BY 1
         )
         SELECT to_char(span.m, 'YYYY-MM') AS month,
                COALESCE(agg.produced, 0)::float8 AS produced,
                COALESCE(agg.value, 0)::float8 AS value,
                COALESCE(agg.orders, 0)::int AS orders
           FROM span LEFT JOIN agg ON agg.m = span.m
          ORDER BY span.m`,
        [months]
      ),
    ]);

  const p = production.rows[0] || {};
  const produced = Number(p.produced) || 0;
  const scrapped = Number(p.scrapped) || 0;
  const o = oee.rows[0] || {};
  const plannedHours = Number(o.planned_hours) || 0;
  const actualHours = Number(o.actual_hours) || 0;
  const capacityHours = (Number(o.daily_capacity) || 0) * days;

  const quality = produced + scrapped > 0 ? produced / (produced + scrapped) : null;
  const performance = actualHours > 0 && plannedHours > 0 ? plannedHours / actualHours : null;
  const availability = capacityHours > 0 && actualHours > 0
    ? Math.min(1, actualHours / capacityHours)
    : null;
  const overall = [availability, performance, quality].every((v) => v != null)
    ? availability * performance * quality
    : null;

  const byStatus = Object.fromEntries(statuses.rows.map((r) => [r.status, r.n]));

  return {
    production: {
      produced,
      scrapped,
      ordered: Number(p.ordered) || 0,
      completed_value: Number(p.completed_value) || 0,
      wip_value: Number(p.wip_value) || 0,
      open_orders: Number(p.open_orders) || 0,
      // Null rather than zero when nothing has finished: an on-time rate with
      // no completions behind it is not a measurement.
      on_time_rate: Number(p.finished) > 0 ? Number(p.on_time) / Number(p.finished) : null,
      finished: Number(p.finished) || 0,
      scrap_rate: produced + scrapped > 0 ? scrapped / (produced + scrapped) : null,
      completion_rate: Number(p.ordered) > 0 ? produced / Number(p.ordered) : null,
    },
    by_status: byStatus,
    oee: { availability, performance, quality, overall, planned_hours: plannedHours, actual_hours: actualHours },
    work_centers: centres.rows,
    top_products: products.rows,
    material_consumption: materials.rows,
    shortages: shortages.rows,
    open_work_orders: wip.rows,
    series: series.rows,
  };
}

module.exports = { getManufacturingAnalytics };
