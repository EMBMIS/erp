const { pool } = require('../config/database');

/**
 * The analytics module's own overview, in one round trip.
 *
 * "VIEWS" ARE RUNS, AND THE SCREEN SAYS RUNS
 * ---------------------------------------------------------------------------
 * Nothing here records that somebody looked at a report. What is recorded is
 * that a report was executed — manually or by a schedule — with its row count,
 * duration and outcome. Those are different events: a dashboard someone leaves
 * open all day produces no runs, and a schedule nobody reads produces hundreds.
 *
 * Calling runs "views" would be the easy substitution and it would make the
 * most-viewed list wrong in exactly the way that matters: it would rank
 * automated schedules above the reports people actually open.
 *
 * FAILURES ARE A FIRST-CLASS FIGURE
 * ---------------------------------------------------------------------------
 * A reporting module whose overview counts only successes is the one place a
 * broken nightly report can hide indefinitely. Failed runs are counted, and the
 * reports that produced them are named.
 */
async function getReportingAnalytics(months = 12) {
  const span = Math.max(1, Math.min(36, Number(months) || 12));

  const [totals, categories, types, popular, recent, schedules, failures, series] =
    await Promise.all([
      pool.query(
        `SELECT
           (SELECT COUNT(*) FROM report_definitions WHERE deleted_at IS NULL)::int AS reports,
           (SELECT COUNT(*) FROM report_definitions WHERE deleted_at IS NULL AND is_shared)::int AS shared,
           (SELECT COUNT(*) FROM dashboards WHERE deleted_at IS NULL)::int AS dashboards,
           (SELECT COUNT(*) FROM report_schedules WHERE enabled)::int AS schedules,
           (SELECT COUNT(*) FROM report_runs
             WHERE run_at >= date_trunc('month', CURRENT_DATE))::int AS runs_mtd,
           (SELECT COUNT(*) FROM report_runs
             WHERE run_at >= date_trunc('month', CURRENT_DATE)
               AND status = 'FAILED')::int AS failed_mtd,
           (SELECT COUNT(DISTINCT run_by) FROM report_runs
             WHERE run_at >= date_trunc('month', CURRENT_DATE)
               AND run_by IS NOT NULL)::int AS people_mtd,
           (SELECT AVG(duration_ms) FROM report_runs
             WHERE run_at >= date_trunc('month', CURRENT_DATE)
               AND duration_ms IS NOT NULL)::float8 AS avg_duration_ms`
      ),

      pool.query(
        `SELECT x.category,
                COUNT(*)::int AS n,
                COALESCE((
                  SELECT COUNT(*) FROM report_runs r
                    JOIN report_definitions d2 ON d2.id = r.report_id
                   WHERE d2.deleted_at IS NULL
                     AND COALESCE(NULLIF(TRIM(d2.category), ''), 'GENERAL') = x.category
                     AND r.run_at >= date_trunc('month', CURRENT_DATE)
                ), 0)::int AS runs
           FROM (SELECT COALESCE(NULLIF(TRIM(category), ''), 'GENERAL') AS category
                   FROM report_definitions WHERE deleted_at IS NULL) x
          GROUP BY x.category
          ORDER BY n DESC
          LIMIT 8`
      ),

      pool.query(
        `SELECT report_type, COUNT(*)::int AS n
           FROM report_definitions
          WHERE deleted_at IS NULL
          GROUP BY report_type`
      ),

      // Dashboards, with what is actually on them. A dashboard with no widgets
      // is a name, and ranking it alongside a real one by age would be
      // meaningless — so widget count rides along and the list is ordered by it.
      pool.query(
        `SELECT d.id, d.name, d.is_shared, d.is_default, d.updated_at,
                (SELECT COUNT(*) FROM dashboard_widgets w WHERE w.dashboard_id = d.id)::int AS widgets,
                COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), 'Unassigned') AS owner
           FROM dashboards d
           LEFT JOIN users u ON u.id = d.owner_id
          WHERE d.deleted_at IS NULL
          ORDER BY widgets DESC, d.updated_at DESC
          LIMIT 6`
      ),

      pool.query(
        `SELECT d.id, d.name, d.category, d.report_type, d.is_shared,
                COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), 'System') AS owner,
                r.run_at AS last_run,
                r.status AS last_status,
                r.row_count,
                (SELECT COUNT(*) FROM report_runs rr WHERE rr.report_id = d.id)::int AS runs
           FROM report_definitions d
           LEFT JOIN users u ON u.id = d.owner_id
           LEFT JOIN LATERAL (
             SELECT run_at, status, row_count FROM report_runs
              WHERE report_id = d.id ORDER BY run_at DESC LIMIT 1
           ) r ON true
          WHERE d.deleted_at IS NULL
          ORDER BY r.run_at DESC NULLS LAST, d.updated_at DESC
          LIMIT 6`
      ),

      pool.query(
        `SELECT s.id, s.name, s.interval_seconds, s.next_run_at, s.last_run_at,
                s.format, s.enabled, cardinality(s.recipients)::int AS recipients,
                d.name AS report
           FROM report_schedules s
           JOIN report_definitions d ON d.id = s.report_id AND d.deleted_at IS NULL
          ORDER BY s.enabled DESC, s.next_run_at
          LIMIT 6`
      ),

      // The reports that broke, most recent first. A reporting overview that
      // counts only successes is the one place a broken nightly job can hide.
      pool.query(
        `SELECT r.id, r.run_at, r.error, d.name AS report
           FROM report_runs r
           JOIN report_definitions d ON d.id = r.report_id
          WHERE r.status = 'FAILED'
          ORDER BY r.run_at DESC
          LIMIT 5`
      ),

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
           COUNT(r.id)::int AS runs,
           COUNT(r.id) FILTER (WHERE r.status = 'FAILED')::int AS failed,
           COUNT(DISTINCT r.run_by)::int AS people
         FROM span s
         LEFT JOIN report_runs r ON date_trunc('month', r.run_at) = s.month
         GROUP BY s.month
         ORDER BY s.month`,
        [span]
      ),
    ]);

  const num = (v) => Number(v) || 0;
  const t = totals.rows[0] || {};

  const byType = {};
  for (const row of types.rows) byType[row.report_type] = num(row.n);

  const runsMtd = num(t.runs_mtd);

  return {
    totals: {
      reports: num(t.reports),
      shared: num(t.shared),
      dashboards: num(t.dashboards),
      schedules: num(t.schedules),
      runs_mtd: runsMtd,
      failed_mtd: num(t.failed_mtd),
      people_mtd: num(t.people_mtd),
      // Null rather than zero when nothing ran: a success rate over an empty
      // month is not a hundred percent, it is unmeasured.
      success_rate: runsMtd > 0 ? (runsMtd - num(t.failed_mtd)) / runsMtd : null,
      avg_duration_ms: t.avg_duration_ms == null ? null : num(t.avg_duration_ms),
    },
    categories: categories.rows,
    by_type: byType,
    dashboards: popular.rows,
    recent: recent.rows,
    schedules: schedules.rows,
    failures: failures.rows,
    series: series.rows,
  };
}

module.exports = { getReportingAnalytics };
