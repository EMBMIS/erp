const { pool } = require('../config/database');

/**
 * The HR overview, in one round trip.
 *
 * WHAT THIS SCHEMA DOES NOT HOLD
 * ---------------------------------------------------------------------------
 * Three things a workforce screen conventionally shows are not recorded
 * anywhere in this database, and are therefore not returned here:
 *
 *   Employment type   There is no full-time/part-time/contract/intern column.
 *                     `status` records ACTIVE / ON_LEAVE / TERMINATED, which is
 *                     a different question, and answering the first with the
 *                     second would be a fabrication in a chart's clothing.
 *   Gender            Not collected. A diversity split cannot be computed from
 *                     names, and inferring one would be both wrong and worse
 *                     than wrong.
 *   Open positions    There is no requisition or vacancy table. A headcount
 *                     gap cannot be derived from the employee master.
 *
 * In their place this returns things the schema does hold and a manager can act
 * on: the workforce by status, tenure bands from hire dates, and leave requests
 * waiting on an approval.
 *
 * ATTENDANCE RATE COUNTS DAYS THAT WERE RECORDED
 * ---------------------------------------------------------------------------
 * The denominator is attendance rows in the period, not employees times working
 * days. A company that clocks half its staff would otherwise show a 50%
 * attendance rate and look like an absence crisis, when the truth is that half
 * the staff do not clock in. Null when nothing was recorded at all.
 */
async function getHrAnalytics(months = 12) {
  const span = Math.max(1, Math.min(36, Number(months) || 12));

  const [head, departments, tenure, balances, attendance, calendar, absence,
    hires, upcoming, payroll, series] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
         COUNT(*) FILTER (WHERE status = 'ON_LEAVE')::int AS on_leave,
         COUNT(*) FILTER (WHERE status = 'TERMINATED')::int AS terminated,
         COUNT(*) FILTER (WHERE hire_date >= date_trunc('month', CURRENT_DATE))::int AS new_hires,
         COALESCE(AVG(base_salary) FILTER (WHERE status <> 'TERMINATED' AND base_salary > 0), 0)::float8 AS avg_salary,
         COALESCE(SUM(base_salary + housing_allowance + transport_allowance + other_allowance)
                  FILTER (WHERE status <> 'TERMINATED'), 0)::float8 AS monthly_cost
       FROM employees
      WHERE deleted_at IS NULL`
    ),

    pool.query(
      `SELECT COALESCE(NULLIF(TRIM(department), ''), 'Unassigned') AS department,
              COUNT(*)::int AS n
         FROM employees
        WHERE deleted_at IS NULL AND status <> 'TERMINATED'
        GROUP BY 1
        ORDER BY n DESC
        LIMIT 8`
    ),

    // Tenure, in place of the employment-type split this schema cannot answer.
    // It is derivable, it is honest, and it is the thing a headcount chart is
    // usually being read for anyway: who is new and who is not.
    pool.query(
      `SELECT
         CASE
           WHEN hire_date IS NULL THEN 'UNKNOWN'
           WHEN hire_date > CURRENT_DATE - INTERVAL '1 year'  THEN 'UNDER_1'
           WHEN hire_date > CURRENT_DATE - INTERVAL '3 years' THEN 'Y1_3'
           WHEN hire_date > CURRENT_DATE - INTERVAL '5 years' THEN 'Y3_5'
           ELSE 'Y5_PLUS'
         END AS band,
         COUNT(*)::int AS n
       FROM employees
      WHERE deleted_at IS NULL AND status <> 'TERMINATED'
      GROUP BY 1`
    ),

    pool.query(
      `SELECT leave_type, COALESCE(SUM(balance_days), 0)::float8 AS days
         FROM leave_balances
        GROUP BY leave_type
        ORDER BY days DESC`
    ),

    pool.query(
      `SELECT
         COUNT(*)::int AS recorded,
         COUNT(*) FILTER (WHERE status = 'PRESENT')::int AS present,
         COUNT(*) FILTER (WHERE status = 'LATE')::int AS late,
         COUNT(*) FILTER (WHERE status = 'ABSENT')::int AS absent,
         COUNT(*) FILTER (WHERE status = 'HALF_DAY')::int AS half_day
       FROM attendance_records
      WHERE record_date >= date_trunc('month', CURRENT_DATE)`
    ),

    // A day-by-day grid for the month to date. Gap-free, so a day nobody
    // clocked draws as a recorded absence of data rather than being skipped and
    // silently shortening the month.
    pool.query(
      `WITH days AS (
         SELECT generate_series(
           date_trunc('month', CURRENT_DATE)::date,
           CURRENT_DATE,
           '1 day'
         )::date AS day
       )
       SELECT
         d.day,
         COUNT(a.id) FILTER (WHERE a.status = 'PRESENT')::int  AS present,
         COUNT(a.id) FILTER (WHERE a.status = 'LATE')::int     AS late,
         COUNT(a.id) FILTER (WHERE a.status = 'ABSENT')::int   AS absent,
         COUNT(a.id) FILTER (WHERE a.status = 'HALF_DAY')::int AS half_day,
         COUNT(a.id)::int AS recorded
       FROM days d
       LEFT JOIN attendance_records a ON a.record_date = d.day
       GROUP BY d.day
       ORDER BY d.day`
    ),

    // Why people were away this month. Leave that straddles the month boundary
    // counts, because a week off starting on the 29th is this month's absence
    // too — clipping to whole requests inside the window would lose it.
    pool.query(
      `SELECT leave_type, COUNT(*)::int AS n, COALESCE(SUM(total_days), 0)::float8 AS days
         FROM leave_requests
        WHERE deleted_at IS NULL
          AND status = 'APPROVED'
          AND start_date <= CURRENT_DATE
          AND end_date >= date_trunc('month', CURRENT_DATE)
        GROUP BY leave_type
        ORDER BY days DESC`
    ),

    pool.query(
      `SELECT id, employee_number, first_name, last_name, department, position,
              hire_date, status
         FROM employees
        WHERE deleted_at IS NULL AND hire_date IS NOT NULL
        ORDER BY hire_date DESC
        LIMIT 5`
    ),

    pool.query(
      `SELECT l.id, l.leave_type, l.start_date, l.end_date, l.total_days::float8 AS total_days,
              l.status,
              CONCAT_WS(' ', e.first_name, e.last_name) AS employee
         FROM leave_requests l
         JOIN employees e ON e.id = l.employee_id AND e.deleted_at IS NULL
        WHERE l.deleted_at IS NULL
          AND l.status IN ('PENDING', 'APPROVED')
          AND l.end_date >= CURRENT_DATE
        ORDER BY l.start_date
        LIMIT 6`
    ),

    pool.query(
      `SELECT period_year, period_month, status,
              total_gross::float8 AS gross,
              total_net::float8 AS net,
              total_deductions::float8 AS deductions
         FROM payroll_runs
        WHERE deleted_at IS NULL
        ORDER BY period_year DESC, period_month DESC
        LIMIT 1`
    ),

    // Headcount month by month. Cumulative rather than per-month joiners: the
    // question a headcount line answers is "how big is the company", and a bar
    // of five new starters answers a different one.
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
         (SELECT COUNT(*) FROM employees e
           WHERE e.deleted_at IS NULL
             AND e.hire_date IS NOT NULL
             AND date_trunc('month', e.hire_date) <= s.month)::int AS headcount,
         (SELECT COUNT(*) FROM employees e
           WHERE e.deleted_at IS NULL
             AND date_trunc('month', e.hire_date) = s.month)::int AS joiners
       FROM span s
       ORDER BY s.month`,
      [span]
    ),
  ]);

  const num = (v) => Number(v) || 0;
  const h = head.rows[0] || {};
  const att = attendance.rows[0] || {};
  const recorded = num(att.recorded);

  const tenureBands = {};
  for (const row of tenure.rows) tenureBands[row.band] = num(row.n);

  const pay = payroll.rows[0] || null;

  return {
    totals: {
      total: num(h.total),
      active: num(h.active),
      on_leave: num(h.on_leave),
      terminated: num(h.terminated),
      new_hires: num(h.new_hires),
      avg_salary: num(h.avg_salary) || null,
      monthly_cost: num(h.monthly_cost) || null,
      // Present or late still counts as attending — a late arrival is a person
      // who came to work. Null when nothing was clocked at all, because a rate
      // over an empty denominator is not a measurement.
      attendance_rate: recorded > 0
        ? (num(att.present) + num(att.late) + num(att.half_day) * 0.5) / recorded
        : null,
      attendance_recorded: recorded,
      pending_leave: upcoming.rows.filter((r) => r.status === 'PENDING').length,
    },
    by_status: {
      ACTIVE: num(h.active),
      ON_LEAVE: num(h.on_leave),
      TERMINATED: num(h.terminated),
    },
    departments: departments.rows,
    tenure: tenureBands,
    leave_balances: balances.rows,
    attendance: {
      recorded,
      present: num(att.present),
      late: num(att.late),
      absent: num(att.absent),
      half_day: num(att.half_day),
    },
    calendar: calendar.rows,
    absence: absence.rows,
    recent_hires: hires.rows,
    upcoming_leave: upcoming.rows,
    payroll: pay
      ? {
        period_year: pay.period_year,
        period_month: pay.period_month,
        status: pay.status,
        gross: num(pay.gross),
        net: num(pay.net),
        deductions: num(pay.deductions),
      }
      : null,
    series: series.rows,
  };
}

module.exports = { getHrAnalytics };
