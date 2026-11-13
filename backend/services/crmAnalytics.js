const { pool } = require('../config/database');

/**
 * The CRM overview, in one round trip.
 *
 * LEADS AND DEALS ARE TWO DIFFERENT THINGS, AND THE SCREEN SAYS SO
 * ---------------------------------------------------------------------------
 * A lead is somebody who might buy; a deal is a live opportunity with a value
 * and a stage. They live in separate tables with separate lifecycles, and only
 * some leads ever become deals.
 *
 * That matters for the conversion figure. "Leads converted" counts leads that
 * reached WON or were turned into a customer or quotation — a state on the lead
 * itself — rather than dividing deals by leads, which would compare two
 * populations that only partly overlap and produce a rate that can exceed 100%
 * for no reason a salesperson could explain.
 *
 * WEIGHTED VALUE IS RETURNED ALONGSIDE RAW, NEVER INSTEAD OF IT
 * ---------------------------------------------------------------------------
 * Every deal carries a probability, defaulted per stage rather than typed by
 * hand. Weighting by it gives a forecast; not weighting gives the pipeline. A
 * screen that shows only the weighted number invites "we have $2.4M in the
 * pipeline" to mean something it does not, and one that shows only the raw
 * number invites the same mistake in the other direction.
 */
async function getCrmAnalytics(months = 12) {
  const span = Math.max(1, Math.min(36, Number(months) || 12));

  const [leadTotals, leadStages, sources, topLeads, recentLeads,
    dealTotals, stages, closing, activities, upcoming, series] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'NEW')::int AS new_leads,
         COUNT(*) FILTER (
           WHERE status = 'WON'
              OR converted_to_customer_id IS NOT NULL
              OR converted_to_quotation_id IS NOT NULL
         )::int AS converted,
         COUNT(*) FILTER (WHERE status = 'LOST')::int AS lost,
         COALESCE(SUM(potential_value), 0)::float8 AS potential,
         COUNT(*) FILTER (
           WHERE status NOT IN ('WON', 'LOST')
             AND (next_follow_up IS NULL OR next_follow_up < CURRENT_DATE)
             AND updated_at < CURRENT_DATE - INTERVAL '7 days'
         )::int AS idle
       FROM leads
      WHERE deleted_at IS NULL`
    ),

    pool.query(
      `SELECT status, COUNT(*)::int AS n,
              COALESCE(SUM(potential_value), 0)::float8 AS value
         FROM leads
        WHERE deleted_at IS NULL
        GROUP BY status`
    ),

    pool.query(
      `SELECT COALESCE(NULLIF(TRIM(source), ''), 'Unknown') AS source,
              COUNT(*)::int AS n
         FROM leads
        WHERE deleted_at IS NULL
        GROUP BY 1
        ORDER BY n DESC
        LIMIT 6`
    ),

    // Scored leads only. A list ordered by a score most rows do not have puts
    // whoever happens to sort first at the top and calls them the best lead in
    // the book, which is worse than showing nothing.
    pool.query(
      `SELECT id, lead_number, company_name, contact_name, source, status,
              ai_score, potential_value::float8 AS potential_value
         FROM leads
        WHERE deleted_at IS NULL AND ai_score IS NOT NULL
        ORDER BY ai_score DESC
        LIMIT 5`
    ),

    pool.query(
      `SELECT id, lead_number, company_name, contact_name, source, status,
              ai_score, created_at
         FROM leads
        WHERE deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT 5`
    ),

    pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE stage NOT IN ('WON', 'LOST'))::int AS open_deals,
         COUNT(*) FILTER (WHERE stage = 'WON')::int AS won,
         COUNT(*) FILTER (WHERE stage = 'LOST')::int AS lost,
         COALESCE(SUM(value), 0)::float8 AS total_value,
         COALESCE(SUM(value) FILTER (WHERE stage NOT IN ('WON', 'LOST')), 0)::float8 AS open_value,
         COALESCE(SUM(value * probability / 100.0) FILTER (WHERE stage NOT IN ('WON', 'LOST')), 0)::float8 AS weighted_value,
         COALESCE(SUM(value) FILTER (WHERE stage = 'WON'), 0)::float8 AS won_value
       FROM deals
      WHERE deleted_at IS NULL`
    ),

    pool.query(
      `SELECT stage, COUNT(*)::int AS n,
              COALESCE(SUM(value), 0)::float8 AS value,
              COALESCE(SUM(value * probability / 100.0), 0)::float8 AS weighted
         FROM deals
        WHERE deleted_at IS NULL
        GROUP BY stage`
    ),

    pool.query(
      `SELECT d.id, d.deal_number, d.title, d.stage, d.probability,
              d.value::float8 AS value, d.expected_close_date,
              COALESCE(NULLIF(TRIM(c.customer_name), ''), c.legal_entity_name, d.title) AS customer
         FROM deals d
         LEFT JOIN customers c ON c.id = d.customer_id
        WHERE d.deleted_at IS NULL
          AND d.stage NOT IN ('WON', 'LOST')
          AND d.expected_close_date IS NOT NULL
        ORDER BY d.expected_close_date
        LIMIT 6`
    ),

    pool.query(
      `SELECT a.id, a.activity_type, a.subject, a.due_date, a.completed_at, a.created_at,
              COALESCE(d.title, CONCAT_WS(' ', ct.first_name, ct.last_name)) AS context,
              COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), 'System') AS owner
         FROM activities a
         LEFT JOIN deals d ON d.id = a.deal_id
         LEFT JOIN contacts ct ON ct.id = a.contact_id
         LEFT JOIN users u ON u.id = a.owner_id
        ORDER BY COALESCE(a.completed_at, a.created_at) DESC
        LIMIT 6`
    ),

    pool.query(
      `SELECT a.id, a.activity_type, a.subject, a.due_date,
              COALESCE(d.title, CONCAT_WS(' ', ct.first_name, ct.last_name)) AS context
         FROM activities a
         LEFT JOIN deals d ON d.id = a.deal_id
         LEFT JOIN contacts ct ON ct.id = a.contact_id
        WHERE a.completed_at IS NULL AND a.due_date IS NOT NULL
        ORDER BY a.due_date
        LIMIT 6`
    ),

    // Pipeline value month by month, gap-free. Value is what was open at the
    // end of each month, not what was created in it: a pipeline chart answers
    // "how much is in play", and new-deals-per-month answers a different
    // question that a bar chart would be better at anyway.
    pool.query(
      `WITH span AS (
         SELECT generate_series(
           date_trunc('month', CURRENT_DATE) - make_interval(months => $1::int - 1),
           date_trunc('month', CURRENT_DATE),
           '1 month'
         ) AS month
       )
       SELECT
         to_char(s.month, 'YYYY-MM') AS month,
         COALESCE((
           SELECT SUM(d.value) FROM deals d
            WHERE d.deleted_at IS NULL
              AND date_trunc('month', d.created_at) <= s.month
              AND (d.closed_at IS NULL OR date_trunc('month', d.closed_at) > s.month)
         ), 0)::float8 AS open_value,
         COALESCE((
           SELECT SUM(d.value) FROM deals d
            WHERE d.deleted_at IS NULL
              AND d.stage = 'WON'
              AND date_trunc('month', d.closed_at) = s.month
         ), 0)::float8 AS won_value,
         (SELECT COUNT(*) FROM leads l
           WHERE l.deleted_at IS NULL
             AND date_trunc('month', l.created_at) = s.month)::int AS new_leads
       FROM span s
       ORDER BY s.month`,
      [span]
    ),
  ]);

  const num = (v) => Number(v) || 0;
  const lt = leadTotals.rows[0] || {};
  const dt = dealTotals.rows[0] || {};

  const leadsByStatus = {};
  const leadValueByStatus = {};
  for (const row of leadStages.rows) {
    leadsByStatus[row.status] = num(row.n);
    leadValueByStatus[row.status] = num(row.value);
  }

  const byStage = {};
  for (const row of stages.rows) {
    byStage[row.stage] = { n: num(row.n), value: num(row.value), weighted: num(row.weighted) };
  }

  const closedDeals = num(dt.won) + num(dt.lost);

  return {
    leads: {
      total: num(lt.total),
      new_leads: num(lt.new_leads),
      converted: num(lt.converted),
      lost: num(lt.lost),
      potential: num(lt.potential),
      idle: num(lt.idle),
      // Against every lead ever raised, including ones still in flight. Null
      // when there are none, because a conversion rate over an empty book is
      // not zero conversion.
      conversion_rate: num(lt.total) > 0 ? num(lt.converted) / num(lt.total) : null,
      by_status: leadsByStatus,
      value_by_status: leadValueByStatus,
    },
    deals: {
      total: num(dt.total),
      open: num(dt.open_deals),
      won: num(dt.won),
      lost: num(dt.lost),
      total_value: num(dt.total_value),
      open_value: num(dt.open_value),
      // The forecast, kept beside the raw pipeline rather than replacing it.
      weighted_value: num(dt.weighted_value),
      won_value: num(dt.won_value),
      // Won against everything that actually closed. Open deals are not
      // failures yet and do not belong in the denominator.
      win_rate: closedDeals > 0 ? num(dt.won) / closedDeals : null,
      avg_size: num(dt.won) > 0 ? num(dt.won_value) / num(dt.won) : null,
      by_stage: byStage,
    },
    sources: sources.rows,
    top_leads: topLeads.rows,
    recent_leads: recentLeads.rows,
    closing_soon: closing.rows,
    activities: activities.rows,
    upcoming: upcoming.rows,
    series: series.rows,
  };
}

module.exports = { getCrmAnalytics };
