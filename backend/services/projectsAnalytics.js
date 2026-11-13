const { pool } = require('../config/database');

/**
 * The projects overview, in one round trip.
 *
 * WHAT "BUDGET" MEANS HERE, AND WHY THERE ARE TWO OF THEM
 * ---------------------------------------------------------------------------
 * A project carries both budget_hours and budget_amount, and they answer
 * different questions. Hours tell you whether the team is going to run out of
 * time; the amount tells you whether the project is going to lose money. The
 * screen leads with the amount, because that is the one a portfolio is managed
 * against, and falls back to nothing rather than to hours when it is unset —
 * a utilisation figure computed against a budget nobody entered is a made-up
 * number wearing a percent sign.
 *
 * Actual spend is time booked at its rate plus purchase orders raised against
 * the project. The PO half matters: a project's true exposure exists from the
 * moment the order is placed, not from the moment an invoice posts, and a
 * budget view that waits for the invoice reports a project as healthy right up
 * until the month it isn't.
 *
 * EVERY RATE IS NULL WHEN ITS DENOMINATOR IS EMPTY
 * ---------------------------------------------------------------------------
 * On-time completion with nothing completed, utilisation with no budget,
 * progress with no tasks — each returns null rather than 0 or 100. The screen
 * renders those as an em dash and says what is missing, which is honest; a zero
 * would read as a measurement and is not one.
 */
async function getProjectsAnalytics(months = 12) {
  const span = Math.max(1, Math.min(36, Number(months) || 12));

  const [totals, statuses, health, tasks, hours, budget, active, milestones, spendSeries, activity] =
    await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
           COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
           COUNT(*) FILTER (WHERE status = 'ON_HOLD')::int AS on_hold,
           COUNT(*) FILTER (WHERE status = 'PLANNED')::int AS planned,
           COALESCE(SUM(COALESCE(budget_amount, fixed_price)), 0)::float8 AS portfolio_value,
           COUNT(*) FILTER (
             WHERE status = 'COMPLETED' AND end_date IS NOT NULL
               AND updated_at::date <= end_date
           )::int AS on_time,
           COUNT(*) FILTER (WHERE status = 'COMPLETED' AND end_date IS NOT NULL)::int AS finished
         FROM projects
        WHERE deleted_at IS NULL`
      ),

      // Portfolio value by status. Value is the managed budget, falling back to
      // the fixed price for fixed-price work — for time-and-materials with no
      // budget set there is nothing honest to show, so it contributes zero
      // value while still being counted.
      pool.query(
        `SELECT
           status,
           COUNT(*)::int AS n,
           COALESCE(SUM(COALESCE(budget_amount, fixed_price, 0)), 0)::float8 AS value
         FROM projects
        WHERE deleted_at IS NULL
        GROUP BY status`
      ),

      // Health is derived, not stored: how much of the budget is consumed
      // against how far through the schedule the project is. A project 90%
      // through its money and 30% through its calendar is the one you want to
      // see, and no column records that.
      pool.query(
        `WITH spend AS (
           SELECT p.id,
                  p.status,
                  p.start_date,
                  p.end_date,
                  COALESCE(p.budget_amount, p.fixed_price) AS budget,
                  COALESCE((
                    SELECT SUM(te.hours * COALESCE(te.hourly_rate, p.default_hourly_rate, 0))
                      FROM time_entries te WHERE te.project_id = p.id
                  ), 0) AS labour,
                  COALESCE((
                    SELECT SUM(po.total_amount) FROM purchase_orders po
                     WHERE po.project_id = p.id AND po.deleted_at IS NULL
                  ), 0) AS committed
             FROM projects p
            WHERE p.deleted_at IS NULL AND p.status NOT IN ('CANCELLED')
         )
         SELECT
           CASE
             WHEN status = 'PLANNED' THEN 'NOT_STARTED'
             WHEN budget IS NULL OR budget = 0 THEN 'UNTRACKED'
             WHEN (labour + committed) / budget > 1 THEN 'CRITICAL'
             WHEN (labour + committed) / budget > 0.85 THEN 'AT_RISK'
             ELSE 'HEALTHY'
           END AS band,
           COUNT(*)::int AS n
         FROM spend
        GROUP BY 1`
      ),

      // Overdue is counted here rather than folded into the status breakdown,
      // because a task is overdue *and* in progress — the two are different
      // axes and adding a sixth slice to the status donut would double-count.
      pool.query(
        `SELECT
           t.status,
           COUNT(*)::int AS n,
           COUNT(*) FILTER (
             WHERE t.due_date IS NOT NULL
               AND t.due_date < CURRENT_DATE
               AND t.status NOT IN ('DONE', 'CANCELLED')
           )::int AS overdue
           FROM project_tasks t
           JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL
          GROUP BY t.status`
      ),

      // Hours booked per month, gap-free: a month nobody logged against is a
      // real zero in this series and has to draw as one, not be skipped.
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
           COALESCE(SUM(te.hours), 0)::float8 AS hours,
           COALESCE(SUM(te.hours) FILTER (WHERE te.billable), 0)::float8 AS billable_hours
         FROM span s
         LEFT JOIN time_entries te
           ON date_trunc('month', te.entry_date) = s.month
         GROUP BY s.month
         ORDER BY s.month`,
        [span]
      ),

      pool.query(
        `SELECT
           COALESCE(SUM(COALESCE(p.budget_amount, p.fixed_price)), 0)::float8 AS budget,
           COALESCE(SUM((
             SELECT SUM(te.hours * COALESCE(te.hourly_rate, p.default_hourly_rate, 0))
               FROM time_entries te WHERE te.project_id = p.id
           )), 0)::float8 AS labour,
           COALESCE(SUM((
             SELECT SUM(po.total_amount) FROM purchase_orders po
              WHERE po.project_id = p.id AND po.deleted_at IS NULL
           )), 0)::float8 AS committed
         FROM projects p
        WHERE p.deleted_at IS NULL AND p.status <> 'CANCELLED'`
      ),

      // The active portfolio, with enough on each row to judge it: what it is
      // worth, how far through it is, and who owns it.
      pool.query(
        `SELECT
           p.id,
           p.project_code,
           p.name,
           p.status,
           p.start_date,
           p.end_date,
           COALESCE(p.budget_amount, p.fixed_price) AS budget,
           COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), 'Unassigned') AS manager,
           COALESCE((
             SELECT SUM(te.hours * COALESCE(te.hourly_rate, p.default_hourly_rate, 0))
               FROM time_entries te WHERE te.project_id = p.id
           ), 0)::float8 AS spent,
           COALESCE((
             SELECT COUNT(*) FROM project_tasks t WHERE t.project_id = p.id
           ), 0)::int AS tasks,
           COALESCE((
             SELECT COUNT(*) FROM project_tasks t
              WHERE t.project_id = p.id AND t.status = 'DONE'
           ), 0)::int AS tasks_done
         FROM projects p
         LEFT JOIN users u ON u.id = p.manager_id
        WHERE p.deleted_at IS NULL AND p.status IN ('ACTIVE', 'PLANNED', 'ON_HOLD')
        ORDER BY COALESCE(p.budget_amount, p.fixed_price, 0) DESC NULLS LAST, p.created_at DESC
        LIMIT 6`
      ),

      pool.query(
        `SELECT
           m.id, m.name, m.amount::float8 AS amount, m.target_date, m.status,
           p.name AS project
         FROM project_milestones m
         JOIN projects p ON p.id = m.project_id AND p.deleted_at IS NULL
        WHERE m.status IN ('PENDING', 'ACHIEVED')
        ORDER BY m.target_date NULLS LAST
        LIMIT 6`
      ),

      // Budget against actual, cumulative, month by month. Budget is spread
      // evenly across each project's own span rather than dropped in on day
      // one — a budget line that starts at full height makes every project look
      // under budget until the day it isn't.
      pool.query(
        `WITH span AS (
           SELECT generate_series(
             date_trunc('month', CURRENT_DATE) - make_interval(months => $1::int - 1),
             date_trunc('month', CURRENT_DATE),
             '1 month'
           ) AS month
         ),
         planned AS (
           SELECT s.month,
                  SUM(
                    COALESCE(p.budget_amount, p.fixed_price, 0)
                    / GREATEST(1, (
                        EXTRACT(YEAR FROM age(COALESCE(p.end_date, CURRENT_DATE), p.start_date)) * 12
                        + EXTRACT(MONTH FROM age(COALESCE(p.end_date, CURRENT_DATE), p.start_date)) + 1
                      ))
                  )::float8 AS budget
             FROM span s
             JOIN projects p
               ON p.deleted_at IS NULL
              AND p.start_date IS NOT NULL
              AND date_trunc('month', p.start_date) <= s.month
              AND date_trunc('month', COALESCE(p.end_date, CURRENT_DATE)) >= s.month
            GROUP BY s.month
         ),
         actual AS (
           SELECT date_trunc('month', te.entry_date) AS month,
                  SUM(te.hours * COALESCE(te.hourly_rate, p.default_hourly_rate, 0))::float8 AS spent
             FROM time_entries te
             JOIN projects p ON p.id = te.project_id AND p.deleted_at IS NULL
            GROUP BY 1
         )
         SELECT
           to_char(s.month, 'YYYY-MM') AS month,
           COALESCE(pl.budget, 0)::float8 AS budget,
           COALESCE(ac.spent, 0)::float8 AS actual
         FROM span s
         LEFT JOIN planned pl ON pl.month = s.month
         LEFT JOIN actual  ac ON ac.month = s.month
        ORDER BY s.month`,
        [span]
      ),
      // The module's own feed. There is no project_status_history table, so
      // the audit trail has nothing to say about this module — and rather than
      // show a neighbouring module's transitions, this reads the records
      // themselves: a task finishing, a milestone landing, time being booked.
      // Those are what actually happens on a project.
      pool.query(
        `(
           SELECT 'TASK'::text AS kind,
                  t.name AS subject,
                  p.name AS context,
                  t.status AS state,
                  t.completed_at AS occurred_at
             FROM project_tasks t
             JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL
            WHERE t.completed_at IS NOT NULL
         )
         UNION ALL
         (
           SELECT 'MILESTONE'::text, m.name, p.name, m.status,
                  COALESCE(m.billed_at, m.achieved_at)
             FROM project_milestones m
             JOIN projects p ON p.id = m.project_id AND p.deleted_at IS NULL
            WHERE COALESCE(m.billed_at, m.achieved_at) IS NOT NULL
         )
         UNION ALL
         (
           SELECT 'TIME'::text,
                  CONCAT(te.hours::text, ' h logged'),
                  p.name,
                  te.approval_status,
                  te.created_at
             FROM time_entries te
             JOIN projects p ON p.id = te.project_id AND p.deleted_at IS NULL
         )
         ORDER BY occurred_at DESC
         LIMIT 6`
      ),
    ]);

  const t = totals.rows[0] || {};
  const num = (v) => Number(v) || 0;

  const byStatus = {};
  const valueByStatus = {};
  for (const row of statuses.rows) {
    byStatus[row.status] = num(row.n);
    valueByStatus[row.status] = num(row.value);
  }

  const healthBands = {};
  for (const row of health.rows) healthBands[row.band] = num(row.n);

  const taskCounts = {};
  let overdueTasks = 0;
  for (const row of tasks.rows) {
    taskCounts[row.status] = num(row.n);
    overdueTasks += num(row.overdue);
  }
  const taskTotal = Object.values(taskCounts).reduce((n, v) => n + v, 0);

  const b = budget.rows[0] || {};
  const budgetTotal = num(b.budget);
  const spend = num(b.labour) + num(b.committed);

  // Cumulative, because the question a budget line answers is "are we over
  // yet", and that is a running total. Per-month bars answer a different one.
  let budgetRun = 0;
  let actualRun = 0;
  const series = spendSeries.rows.map((r) => {
    budgetRun += num(r.budget);
    actualRun += num(r.actual);
    return { month: r.month, budget: budgetRun, actual: actualRun };
  });

  const hoursRows = hours.rows.map((r) => ({
    month: r.month,
    hours: num(r.hours),
    billable_hours: num(r.billable_hours),
  }));
  const hoursTotal = hoursRows.reduce((n, r) => n + r.hours, 0);

  return {
    totals: {
      total: num(t.total),
      active: num(t.active),
      completed: num(t.completed),
      on_hold: num(t.on_hold),
      planned: num(t.planned),
      portfolio_value: num(t.portfolio_value),
      // Null rather than zero: an on-time rate with nothing finished behind it
      // is not a measurement of anything.
      on_time_rate: num(t.finished) > 0 ? num(t.on_time) / num(t.finished) : null,
      finished: num(t.finished),
      hours_logged: hoursTotal,
      // Utilisation against a budget nobody set would be a number with no
      // meaning, so it is null until there is a budget to measure against.
      budget_utilisation: budgetTotal > 0 ? spend / budgetTotal : null,
      budget_total: budgetTotal,
      budget_spent: spend,
      overdue_tasks: overdueTasks,
    },
    by_status: byStatus,
    value_by_status: valueByStatus,
    health: healthBands,
    tasks: {
      by_status: taskCounts,
      total: taskTotal,
      overdue: overdueTasks,
    },
    hours: hoursRows,
    series,
    active_projects: active.rows.map((r) => ({
      ...r,
      budget: r.budget == null ? null : Number(r.budget),
      progress: num(r.tasks) > 0 ? num(r.tasks_done) / num(r.tasks) : null,
    })),
    milestones: milestones.rows,
    activity: activity.rows,
  };
}

module.exports = { getProjectsAnalytics };
