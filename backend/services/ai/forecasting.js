/**
 * AI financial forecasting and anomaly detection.
 *
 * Every number produced here comes from a real SQL aggregate over posted
 * journal entries; the projection is an ordinary least-squares fit with a 95%
 * interval (services/ai/stats.js). No language model is involved in producing a
 * figure — an LLM is only used, optionally and separately, to narrate results it
 * is handed. This is deliberate: a model asked to forecast cash will return a
 * confident number with no basis in the ledger.
 *
 * When history is too short to support a projection the result says so
 * (`sufficient: false`) instead of extrapolating from noise. Callers should
 * surface that rather than hide it.
 */

const { pool } = require('../../config/database');
const stats = require('./stats');

// ---------------------------------------------------------------------------
// Monthly series builders (posted entries only — drafts are not financial fact)
// ---------------------------------------------------------------------------

/**
 * Monthly totals for a set of account types, signed in their natural direction
 * (revenue as a positive credit balance, expense as a positive debit balance).
 *
 * `asOf` lets a caller pretend "today" is some date in the past — that's how
 * the backtest below refits the trend using only what was known at the time,
 * instead of leaking later postings into the fit.
 */
async function monthlySeriesByAccountType(accountType, months = 24, asOf = null) {
  const isDebitNormal = accountType === 'EXPENSE' || accountType === 'ASSET';
  const params = [accountType, months];
  let anchor = 'CURRENT_DATE';
  if (asOf) {
    params.push(asOf);
    anchor = '$3::date';
  }
  const { rows } = await pool.query(
    `
    SELECT to_char(date_trunc('month', je.entry_date), 'YYYY-MM') AS period,
           ROUND(SUM(${isDebitNormal
             ? 'jei.debit_amount - jei.credit_amount'
             : 'jei.credit_amount - jei.debit_amount'}), 2)::float AS amount
      FROM journal_entries je
      JOIN journal_entry_items jei ON jei.journal_entry_id = je.id
      JOIN chart_of_accounts coa   ON coa.id = jei.account_id
     WHERE je.status = 'POSTED'
       AND je.deleted_at IS NULL
       AND coa.account_type = $1
       AND je.entry_date >= (${anchor} - ($2::int || ' months')::interval)
       AND je.entry_date <= ${anchor}
     GROUP BY 1
     ORDER BY 1
    `,
    params
  );
  return rows;
}

/**
 * Fill gaps so a month with no activity reads as 0 rather than vanishing.
 * Without this, three transactions spread over a year would look like three
 * consecutive months of trade and badly distort the slope.
 *
 * `asOf` anchors the "current" month for backtesting; defaults to the real
 * present for every existing caller.
 */
function densify(rows, months, asOf = null) {
  const byPeriod = new Map(rows.map((r) => [r.period, Number(r.amount) || 0]));
  const out = [];
  const now = asOf || new Date();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    out.push({ period, amount: byPeriod.get(period) ?? 0 });
  }
  return out;
}

/**
 * Trim leading zero-activity months. A ledger that only started being used in
 * month 18 of 24 should be forecast from its 6 real months, not from 18 zeros
 * that would drag the fitted trend toward the floor.
 */
function trimLeadingZeros(series) {
  const first = series.findIndex((p) => p.amount !== 0);
  return first <= 0 ? series : series.slice(first);
}

// ---------------------------------------------------------------------------
// Forecasts
// ---------------------------------------------------------------------------

/**
 * Forecast revenue, expense and the implied margin for the coming months.
 */
async function forecastProfitAndLoss({ months = 24, horizon = 3 } = {}) {
  const [revRows, expRows] = await Promise.all([
    monthlySeriesByAccountType('REVENUE', months),
    monthlySeriesByAccountType('EXPENSE', months),
  ]);

  const revenue = trimLeadingZeros(densify(revRows, months));
  const expense = trimLeadingZeros(densify(expRows, months));

  const revenueForecast = stats.forecast(revenue.map((p) => p.amount), horizon);
  const expenseForecast = stats.forecast(expense.map((p) => p.amount), horizon);

  const projected = revenueForecast.points.map((rp, i) => {
    const ep = expenseForecast.points[i] || { value: 0 };
    return {
      period_ahead: rp.period_ahead,
      projected_revenue: rp.value,
      projected_expense: ep.value,
      projected_profit: stats.round2(rp.value - ep.value),
      revenue_range: [rp.lower, rp.upper],
    };
  });

  return {
    history: { revenue, expense },
    revenue_forecast: revenueForecast,
    expense_forecast: expenseForecast,
    projected,
    sufficient_data: revenueForecast.sufficient && expenseForecast.sufficient,
    // Name the series that is actually weak. A blanket "this is a flat
    // carry-forward" would be untrue of the other line whenever only one of the
    // two lacks history, and a caveat that misdescribes the numbers is worse
    // than none.
    caveat: [
      revenueForecast.sufficient
        ? null
        : `Revenue: ${revenueForecast.note}`,
      expenseForecast.sufficient
        ? null
        : `Expense: ${expenseForecast.note}`,
    ].filter(Boolean).join(' ') || null,
  };
}

/**
 * Cash-flow outlook: current cash, plus the receivables due in and payables due
 * out over the horizon. This is a commitment-based projection from real due
 * dates — far more defensible than trending historical cash, because AR/AP due
 * dates are already known facts rather than guesses.
 */
async function forecastCashFlow({ horizonDays = 90 } = {}) {
  const [cash, receivables, payables] = await Promise.all([
    pool.query(`
      SELECT COALESCE(SUM(jei.debit_amount - jei.credit_amount), 0)::float AS balance
        FROM journal_entry_items jei
        JOIN journal_entries je   ON je.id = jei.journal_entry_id
        JOIN chart_of_accounts coa ON coa.id = jei.account_id
       WHERE je.status = 'POSTED' AND je.deleted_at IS NULL
         AND coa.account_type = 'ASSET'
         AND (coa.account_code LIKE '11%' AND coa.account_name ILIKE '%cash%'
              OR coa.account_name ILIKE '%bank%')
    `),
    pool.query(
      `
      SELECT COALESCE(SUM(outstanding_amount), 0)::float AS amount,
             CASE WHEN due_date < CURRENT_DATE THEN 'overdue'
                  WHEN due_date <= CURRENT_DATE + ($1::int || ' days')::interval THEN 'within_horizon'
                  ELSE 'later' END AS bucket
        FROM customer_invoices
       WHERE deleted_at IS NULL AND outstanding_amount > 0
         AND status IN ('APPROVED','SENT','PARTIALLY_PAID','OVERDUE')
       GROUP BY 2
      `,
      [horizonDays]
    ),
    pool
      .query(
        `
      SELECT COALESCE(SUM(outstanding_amount), 0)::float AS amount,
             CASE WHEN due_date < CURRENT_DATE THEN 'overdue'
                  WHEN due_date <= CURRENT_DATE + ($1::int || ' days')::interval THEN 'within_horizon'
                  ELSE 'later' END AS bucket
        FROM supplier_invoices
       WHERE deleted_at IS NULL AND outstanding_amount > 0
         AND status IN ('APPROVED','PARTIALLY_PAID','OVERDUE')
       GROUP BY 2
      `,
        [horizonDays]
      )
      .catch(() => ({ rows: [] })),
  ]);

  const bucketise = (rows) => {
    const b = { overdue: 0, within_horizon: 0, later: 0 };
    rows.forEach((r) => { b[r.bucket] = Number(r.amount) || 0; });
    return b;
  };

  const inflow = bucketise(receivables.rows);
  const outflow = bucketise(payables.rows);
  const opening = Number(cash.rows[0]?.balance || 0);

  // Overdue receivables are counted as expected inflow but flagged: treating
  // them as certain is how cash forecasts overstate.
  const expectedIn = inflow.within_horizon + inflow.overdue;
  const expectedOut = outflow.within_horizon + outflow.overdue;
  const projectedClosing = opening + expectedIn - expectedOut;

  return {
    horizon_days: horizonDays,
    opening_cash: stats.round2(opening),
    expected_inflow: stats.round2(expectedIn),
    expected_outflow: stats.round2(expectedOut),
    projected_closing_cash: stats.round2(projectedClosing),
    receivables: inflow,
    payables: outflow,
    risk:
      projectedClosing < 0
        ? 'NEGATIVE_CASH_PROJECTED'
        : inflow.overdue > expectedIn * 0.5 && expectedIn > 0
          ? 'DEPENDENT_ON_OVERDUE_COLLECTIONS'
          : 'OK',
    caveats: [
      inflow.overdue > 0
        ? `${stats.round2(inflow.overdue)} of expected inflow is already overdue and may not arrive.`
        : null,
      'Assumes invoices settle on their due date; does not model payroll, tax or unbilled commitments.',
    ].filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// Anomaly detection
// ---------------------------------------------------------------------------

/**
 * Flag unusual postings using robust statistics per GL account: an amount is
 * only "large" relative to the account it lands in. Uses median/MAD rather than
 * mean/stdDev because a single large anomaly inflates the standard deviation
 * enough to hide itself.
 */
async function detectAmountAnomalies({ months = 12, threshold = 4, limit = 25 } = {}) {
  const { rows } = await pool.query(
    `
    SELECT jei.id, je.journal_number, je.entry_date, je.description,
           coa.account_code, coa.account_name,
           (jei.debit_amount + jei.credit_amount)::float AS amount
      FROM journal_entry_items jei
      JOIN journal_entries je    ON je.id = jei.journal_entry_id
      JOIN chart_of_accounts coa ON coa.id = jei.account_id
     WHERE je.status = 'POSTED' AND je.deleted_at IS NULL
       AND je.entry_date >= (CURRENT_DATE - ($1::int || ' months')::interval)
       AND (jei.debit_amount + jei.credit_amount) > 0
    `,
    [months]
  );

  // Group by account, score within each group.
  const byAccount = new Map();
  for (const r of rows) {
    if (!byAccount.has(r.account_code)) byAccount.set(r.account_code, []);
    byAccount.get(r.account_code).push(r);
  }

  const anomalies = [];
  for (const [accountCode, entries] of byAccount) {
    // Fewer than 5 postings gives no meaningful baseline to be unusual against.
    if (entries.length < 5) continue;
    const amounts = entries.map((e) => e.amount);
    const scores = stats.outlierScores(amounts);
    entries.forEach((e, i) => {
      if (Math.abs(scores[i]) >= threshold) {
        anomalies.push({
          journal_number: e.journal_number,
          entry_date: e.entry_date,
          description: e.description,
          account_code: accountCode,
          account_name: e.account_name,
          amount: stats.round2(e.amount),
          deviation_sigmas: stats.round2(scores[i]),
          typical_amount: stats.round2(stats.median(amounts)),
          reason: `${stats.round2(Math.abs(scores[i]))}x the typical deviation for account ${accountCode} (median ${stats.round2(stats.median(amounts))}).`,
        });
      }
    });
  }

  anomalies.sort((a, b) => Math.abs(b.deviation_sigmas) - Math.abs(a.deviation_sigmas));
  const withBaseline = [...byAccount.values()].filter((e) => e.length >= 5).length;

  // "Found nothing" and "could not look" are different answers. If no account
  // cleared the 5-posting baseline, the scan did not actually test anything and
  // must not report a clean bill of health.
  let note = null;
  if (byAccount.size === 0) {
    note = 'No posted journal activity in the window — nothing to analyse.';
  } else if (withBaseline === 0) {
    note = `No account has the 5+ postings needed for a baseline (${byAccount.size} account(s) seen), so no anomaly test could run. This is not a clean result.`;
  } else if (anomalies.length === 0) {
    note = `No amounts deviate beyond ${threshold} sigma across the ${withBaseline} account(s) with enough history.`;
  }

  return {
    window_months: months,
    threshold_sigmas: threshold,
    accounts_analysed: byAccount.size,
    accounts_with_baseline: withBaseline,
    analysis_ran: withBaseline > 0,
    anomalies: anomalies.slice(0, limit),
    note,
  };
}

// ---------------------------------------------------------------------------
// Backtesting
// ---------------------------------------------------------------------------

// Buffer beyond `horizon` required of `months_back`: the last projected month
// must have fully elapsed by the real present, or its "actual" would just be
// a partial, still-accumulating figure.
const MIN_BACKTEST_LEAD_MONTHS = 1;

function shiftMonths(date, delta) {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d;
}

// Percentage error against actual; undefined (not 0) when actual is 0, since
// dividing by zero would either throw or manufacture a fake "infinite" error.
function pctError(actual, predicted) {
  if (actual === 0) return null;
  return stats.round2(((actual - predicted) / Math.abs(actual)) * 100);
}

/**
 * Backtest forecastProfitAndLoss against reality. Refits the exact same
 * revenue/expense trend, but as of `months_back` months ago using only
 * postings that existed by then, then compares that projection to what the
 * ledger actually recorded in the months since. This is what turns "95%
 * confidence interval" from an assumption into a measured error rate.
 */
async function backtestProfitAndLossForecast({ months_back = 6, horizon = 3, months_history = 24 } = {}) {
  const monthsBack = Math.max(1, Math.min(Number(months_back) || 6, 24));
  const proj = Math.max(1, Math.min(Number(horizon) || 3, 12));
  const historyMonths = Math.max(1, Math.min(Number(months_history) || 24, 60));

  const cutoffDate = shiftMonths(new Date(), -monthsBack);
  const cutoffLabel = cutoffDate.toISOString().slice(0, 10);

  if (monthsBack < proj + MIN_BACKTEST_LEAD_MONTHS) {
    return {
      cutoff_date: cutoffLabel,
      horizon: proj,
      sufficient_data: false,
      months: [],
      overall_mape: null,
      note: `months_back (${monthsBack}) must exceed horizon (${proj}) by at least ${MIN_BACKTEST_LEAD_MONTHS} month(s) so every projected month has actually completed by now — otherwise the "actual" for the newest month(s) would be partial. Increase months_back or reduce horizon.`,
    };
  }

  // Refit exactly what forecastProfitAndLoss would have fit, but bounded to
  // history that existed as of the cutoff.
  const [revRows, expRows] = await Promise.all([
    monthlySeriesByAccountType('REVENUE', historyMonths, cutoffDate),
    monthlySeriesByAccountType('EXPENSE', historyMonths, cutoffDate),
  ]);
  const revenueHistory = trimLeadingZeros(densify(revRows, historyMonths, cutoffDate));
  const expenseHistory = trimLeadingZeros(densify(expRows, historyMonths, cutoffDate));

  const revenueForecast = stats.forecast(revenueHistory.map((p) => p.amount), proj);
  const expenseForecast = stats.forecast(expenseHistory.map((p) => p.amount), proj);

  if (!revenueForecast.sufficient || !expenseForecast.sufficient) {
    return {
      cutoff_date: cutoffLabel,
      horizon: proj,
      sufficient_data: false,
      months: [],
      overall_mape: null,
      note: [
        `Not enough posted history existed before ${cutoffLabel} to reproduce a real forecast from that point — a backtest here would just be testing noise.`,
        !revenueForecast.sufficient ? `Revenue: ${revenueForecast.note}` : null,
        !expenseForecast.sufficient ? `Expense: ${expenseForecast.note}` : null,
      ].filter(Boolean).join(' '),
    };
  }

  // Actuals for the projected months: the `monthsBack` months between the
  // cutoff and real "today", read with the live (unbounded) series builder.
  const [revActualRows, expActualRows] = await Promise.all([
    monthlySeriesByAccountType('REVENUE', monthsBack),
    monthlySeriesByAccountType('EXPENSE', monthsBack),
  ]);
  const revenueActual = densify(revActualRows, monthsBack);
  const expenseActual = densify(expActualRows, monthsBack);

  const months = revenueForecast.points.map((rp, i) => {
    const ep = expenseForecast.points[i] || { value: 0 };
    const actualRev = revenueActual[i]?.amount ?? 0;
    const actualExp = expenseActual[i]?.amount ?? 0;
    const predictedProfit = stats.round2(rp.value - ep.value);
    const actualProfit = stats.round2(actualRev - actualExp);

    return {
      period: revenueActual[i]?.period ?? null,
      period_ahead: rp.period_ahead,
      revenue: {
        predicted: rp.value,
        actual: stats.round2(actualRev),
        error: stats.round2(actualRev - rp.value),
        pct_error: pctError(actualRev, rp.value),
      },
      expense: {
        predicted: ep.value,
        actual: stats.round2(actualExp),
        error: stats.round2(actualExp - ep.value),
        pct_error: pctError(actualExp, ep.value),
      },
      profit: {
        predicted: predictedProfit,
        actual: actualProfit,
        error: stats.round2(actualProfit - predictedProfit),
        pct_error: pctError(actualProfit, predictedProfit),
      },
    };
  });

  // MAPE across every revenue/expense figure that had a real (non-zero)
  // actual to measure against. Profit is excluded here: it can sit near zero,
  // where its percentage error explodes and would swamp the average.
  const errors = months.flatMap((m) => [m.revenue.pct_error, m.expense.pct_error])
    .filter((v) => v !== null && Number.isFinite(v));
  const overallMape = errors.length
    ? stats.round2(errors.reduce((s, v) => s + Math.abs(v), 0) / errors.length)
    : null;

  return {
    cutoff_date: cutoffLabel,
    horizon: proj,
    sufficient_data: true,
    months,
    overall_mape: overallMape,
    note:
      overallMape === null
        ? `Refit as of ${cutoffLabel} and compared to actuals, but every projected month had zero actual revenue and expense, so no percentage error could be computed.`
        : `Refitting the forecast as of ${cutoffLabel} and comparing its ${proj}-month projection to what actually posted since then gives a mean absolute percentage error of ${overallMape}% across revenue and expense.`,
  };
}

module.exports = {
  forecastProfitAndLoss,
  forecastCashFlow,
  detectAmountAnomalies,
  backtestProfitAndLossForecast,
  monthlySeriesByAccountType,
  densify,
  trimLeadingZeros,
};
