/**
 * 13-Week Cash Flow Forecasting Engine with P10/P50/P90 Confidence Bands.
 *
 * Round 7, Task 21-A3: the forecast is learned from BEHAVIOUR, not terms.
 *
 *   • AR: each customer's actual days-to-pay distribution (observed on cleared
 *     payments vs their invoices) is applied to that customer's open invoices.
 *     Customers without history fall back to the company-wide distribution,
 *     then to their own payment terms.
 *   • AP: the company's own payment behaviour (its cleared supplier payments
 *     vs the bills they paid) is applied to open payables.
 *   • Payroll, recurring invoices, loan schedules and tax payments are
 *     scheduled at their real next dates, from history and standing schedules.
 *   • P10/P50/P90 come from the empirical percentiles of those distributions,
 *     never from arbitrary ± percentages: the pessimistic path pays AR late
 *     and AP early, the optimistic path pays AR early and AP late.
 *
 * Every number comes from a real SQL aggregate; no LLM invents a figure.
 * Backtest support (asOf) lets tests refit the forecast using only what was
 * known at the time.
 */

const { pool } = require('../config/database');
const { currentCompanyId } = require('./companyContext');
const stats = require('./ai/stats');

const FREQUENCY_DAYS = { WEEKLY: 7, BIWEEKLY: 14, MONTHLY: 30, QUARTERLY: 91, ANNUALLY: 365 };
// When a customer/company has no payment history at all, assume the invoice's
// own terms — this is a documented fallback, not an invented distribution.
const DEFAULT_DTP_DAYS = 30;

// Standard-normal z for the 10th/90th percentile. Used to turn the measured
// weekly cash-flow standard deviation into the P10/P90 band.
const Z_P10_P90 = 1.2816;

// Fallback dispersion for an install with under four weeks of cash history:
// a tenth of the average weekly gross flow the forecast itself projects. It
// is a stated floor on uncertainty, not a measurement — a brand-new company
// has no volatility history, and reporting a zero-width band for it would be
// a stronger claim than the data supports, not a weaker one.
const NO_HISTORY_SIGMA_FRACTION = 0.10;

class CashflowForecastService {
  /** Starting cash: current balance of all cash accounts. */
  static async startingCash(companyId) {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(current_balance), 0)::float AS cash
         FROM chart_of_accounts
        WHERE company_id = $1 AND account_type = 'ASSET' AND account_subtype = 'CASH' AND status = 'ACTIVE' AND deleted_at IS NULL`,
      [companyId]
    );
    return Number(rows[0]?.cash || 0);
  }

  /**
   * Learn days-to-pay distributions:
   *   perCustomer: customer_id -> [days between invoice date and payment date]
   *   company:     all observed days (fallback for customers without history)
   */
  static async learnDaysToPay(companyId, asOf) {
    const { rows } = await pool.query(
      `SELECT ci.customer_id, cp.payment_date, ci.invoice_date,
              (cp.payment_date - ci.invoice_date) AS days_to_pay
         FROM customer_payments cp
         JOIN customer_payment_allocations cpa ON cpa.payment_id = cp.id
         JOIN customer_invoices ci ON ci.id = cpa.invoice_id
        WHERE cp.company_id = $1 AND cp.status = 'CLEARED' AND cp.deleted_at IS NULL
          AND cp.payment_date <= $2
          AND cp.payment_date >= $2 - INTERVAL '730 days'`,
      [companyId, asOf]
    );

    const perCustomer = new Map();
    const company = [];
    for (const r of rows) {
      const d = Number(r.days_to_pay);
      if (!Number.isFinite(d) || d < 0 || d > 365) continue;
      company.push(d);
      if (!perCustomer.has(r.customer_id)) perCustomer.set(r.customer_id, []);
      perCustomer.get(r.customer_id).push(d);
    }
    return { perCustomer, company };
  }

  /** Company-level days-to-pay for payables (its own payment behaviour). */
  static async learnApDaysToPay(companyId, asOf) {
    const { rows } = await pool.query(
      `SELECT (sp.payment_date - si.invoice_date) AS days_to_pay
         FROM supplier_payments sp
         JOIN supplier_payment_allocations spa ON spa.payment_id = sp.id
         JOIN supplier_invoices si ON si.id = spa.bill_id
        WHERE sp.company_id = $1 AND sp.status = 'CLEARED' AND sp.deleted_at IS NULL
          AND sp.payment_date <= $2
          AND sp.payment_date >= $2 - INTERVAL '730 days'`,
      [companyId, asOf]
    );
    const dist = [];
    for (const r of rows) {
      const d = Number(r.days_to_pay);
      if (!Number.isFinite(d) || d < 0 || d > 365) continue;
      dist.push(d);
    }
    return dist;
  }

  /** Open AR: what each customer owes, with the invoice date to anchor DTP. */
  static async openReceivables(companyId, asOf) {
    const { rows } = await pool.query(
      `SELECT id, customer_id, invoice_number, invoice_date, outstanding_amount::float AS amount
         FROM customer_invoices
        WHERE company_id = $1 AND deleted_at IS NULL
          AND status IN ('APPROVED', 'SENT', 'PARTIALLY_PAID', 'OVERDUE')
          AND outstanding_amount > 0 AND invoice_date <= $2`,
      [companyId, asOf]
    );
    return rows;
  }

  /** Open AP: what the company owes. */
  static async openPayables(companyId, asOf) {
    const { rows } = await pool.query(
      `SELECT id, bill_number, invoice_date, outstanding_amount::float AS amount
         FROM supplier_invoices
        WHERE company_id = $1 AND deleted_at IS NULL
          AND status IN ('APPROVED', 'PARTIALLY_PAID', 'OVERDUE')
          AND outstanding_amount > 0 AND invoice_date <= $2`,
      [companyId, asOf]
    );
    return rows;
  }

  /** Next payroll expectation from posted runs (amount + next date). */
  static async payrollExpectation(companyId, asOf) {
    const { rows } = await pool.query(
      `SELECT period_year, period_month, total_net::float AS total_net, created_at
         FROM payroll_runs
        WHERE company_id = $1 AND status = 'POSTED' AND deleted_at IS NULL
          AND created_at <= $2
        ORDER BY created_at DESC
        LIMIT 6`,
      [companyId, asOf]
    );
    if (!rows.length) return [];
    const average = rows.reduce((s, r) => s + Number(r.total_net || 0), 0) / rows.length;
    const last = rows[0];
    const lastDate = new Date(last.created_at);
    const payDay = lastDate.getDate();

    // Next run: same day-of-month as the most recent run, next month (or this
    // month if the day has not passed yet).
    const now = new Date(asOf);
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), Math.min(payDay, 28)));
    if (next <= now) next.setUTCMonth(next.getUTCMonth() + 1);
    // `date` (not `next_date`) — addFixed buckets fixed items by item.date,
    // matching the recurring/loan/tax item shapes.
    return [{ type: 'payroll', amount: average, date: next.toISOString().split('T')[0] }];
  }

  /** Recurring invoice schedules (inflows). */
  static async recurringInvoices(companyId, asOf, horizonWeeks) {
    const horizonEnd = addDays(asOf, horizonWeeks * 7);
    const { rows } = await pool.query(
      `SELECT id, description, amount::float AS amount, tax_amount::float AS tax_amount,
              frequency, next_run_date
         FROM recurring_invoice_schedules
        WHERE company_id = $1 AND status = 'ACTIVE'
          AND next_run_date <= $2`,
      [companyId, horizonEnd]
    );
    const out = [];
    for (const r of rows) {
      let date = new Date(r.next_run_date);
      const every = FREQUENCY_DAYS[r.frequency] || FREQUENCY_DAYS.MONTHLY;
      for (let guard = 0; guard < 64 && date <= horizonEnd; guard++) {
        out.push({ type: 'recurring_invoice', id: r.id, label: r.description, amount: Number(r.amount) + Number(r.tax_amount || 0), date: iso(date) });
        date = addDays(date, every);
      }
    }
    return out;
  }

  /** Loan payment schedules (outflows). */
  static async loanPayments(companyId, asOf, horizonWeeks) {
    const horizonEnd = addDays(asOf, horizonWeeks * 7);
    const { rows } = await pool.query(
      `SELECT id, loan_name, payment_amount::float AS payment_amount, frequency, next_payment_date
         FROM loan_schedules
        WHERE company_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL
          AND next_payment_date <= $2`,
      [companyId, horizonEnd]
    );
    const out = [];
    for (const r of rows) {
      let date = new Date(r.next_payment_date);
      const every = FREQUENCY_DAYS[r.frequency] || FREQUENCY_DAYS.MONTHLY;
      for (let guard = 0; guard < 64 && date <= horizonEnd; guard++) {
        out.push({ type: 'loan', id: r.id, label: r.loan_name, amount: Number(r.payment_amount), date: iso(date) });
        date = addDays(date, every);
      }
    }
    return out;
  }

  /** Tax payment schedules (outflows). */
  static async taxPayments(companyId, asOf, horizonWeeks) {
    const horizonEnd = addDays(asOf, horizonWeeks * 7);
    const { rows } = await pool.query(
      `SELECT id, tax_type, amount::float AS amount, frequency, next_due_date
         FROM tax_payment_schedules
        WHERE company_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL
          AND next_due_date <= $2`,
      [companyId, horizonEnd]
    );
    const out = [];
    for (const r of rows) {
      let date = new Date(r.next_due_date);
      const every = FREQUENCY_DAYS[r.frequency] || FREQUENCY_DAYS.MONTHLY;
      for (let guard = 0; guard < 64 && date <= horizonEnd; guard++) {
        out.push({ type: 'tax', id: r.id, label: r.tax_type, amount: Number(r.amount), date: iso(date) });
        date = addDays(date, every);
      }
    }
    return out;
  }

  /**
   * Standard deviation of past WEEKLY net cash movement.
   *
   * Why this is needed: every other input to this forecast models uncertainty
   * in TIMING only — when open AR/AP lands. That has a fatal property. Once
   * the horizon passes the point where all currently-open AR/AP has been
   * collected on every path, the three paths converge and the band closes to
   * zero width; scheduled payroll/loan/tax items are placed on the same date
   * on all three paths by construction and contribute no spread at all. The
   * engine was therefore reporting a POINT estimate labelled as a P10/P90
   * confidence band from roughly week two onward, and getting narrower the
   * further out it looked — the opposite of how forecast uncertainty behaves.
   *
   * What is missing from a timing-only model is everything not yet on the
   * books at the anchor date: invoices raised after it, bills that arrive,
   * collections that come in short, spend nobody scheduled. That is not
   * knowable item-by-item, but its aggregate size is measurable — it is the
   * dispersion of this company's own historical weekly net cash movement.
   *
   * Returns 0 only when there is genuinely no history to measure, in which
   * case the caller falls back to a fraction of forecast flow volume rather
   * than claiming certainty.
   */
  static async learnWeeklyFlowVolatility(companyId, asOf, lookbackWeeks = 52) {
    const { rows } = await pool.query(
      `SELECT date_trunc('week', je.entry_date)::date AS wk,
              SUM(jei.debit_amount - jei.credit_amount)::float AS net
         FROM journal_entries je
         JOIN journal_entry_items jei ON jei.journal_entry_id = je.id
         JOIN chart_of_accounts coa ON coa.id = jei.account_id
        WHERE je.company_id = $1 AND je.status = 'POSTED' AND je.deleted_at IS NULL
          AND coa.account_type = 'ASSET' AND coa.account_subtype = 'CASH'
          AND je.entry_date::date <= $2::date
          AND je.entry_date::date > ($2::date - ($3::int || ' weeks')::interval)
        GROUP BY 1`,
      [companyId, asOf, lookbackWeeks]
    );
    // Fewer than four observed weeks is not a distribution, it is anecdote.
    if (rows.length < 4) return 0;
    return stats.stdDev(rows.map((r) => Number(r.net || 0)));
  }

  /**
   * Generate the 13-week cash projection.
   *
   * @param {string|null} companyId
   * @param {object} [options] { asOf, horizonWeeks } — asOf lets a backtest
   *   pretend "today" is a date in the past using only data known then.
   */
  static async generate13WeekForecast(companyId = currentCompanyId(), options = {}) {
    const { asOf = null, horizonWeeks = 13 } = options;
    const anchor = asOf ? new Date(asOf) : new Date();
    const anchorDate = iso(anchor);
    const company = companyId || (await defaultCompanyId());

    const [startingCash, dtp, apDtp, receivables, payables, payroll, recurring, loans, tax, weeklySigma] = await Promise.all([
      this.startingCash(company),
      this.learnDaysToPay(company, anchorDate),
      this.learnApDaysToPay(company, anchorDate),
      this.openReceivables(company, anchorDate),
      this.openPayables(company, anchorDate),
      this.payrollExpectation(company, anchorDate),
      this.recurringInvoices(company, anchorDate, horizonWeeks),
      this.loanPayments(company, anchorDate, horizonWeeks),
      this.taxPayments(company, anchorDate, horizonWeeks),
      this.learnWeeklyFlowVolatility(company, anchorDate),
    ]);

    const companyDist = dtp.company.length ? dtp.company : null;
    const apDist = apDtp.length ? apDtp : null;

    // -----------------------------------------------------------------------
    // Build the three cash paths from the empirical distributions.
    //   P10 (pessimistic): AR pays late (p90), AP pays early (p10)
    //   P50:                p50 both
    //   P90 (optimistic):  AR pays early (p10), AP pays late (p90)
    // -----------------------------------------------------------------------
    const inflow = { p10: new Array(horizonWeeks + 1).fill(0), p50: new Array(horizonWeeks + 1).fill(0), p90: new Array(horizonWeeks + 1).fill(0) };
    const outflow = { p10: new Array(horizonWeeks + 1).fill(0), p50: new Array(horizonWeeks + 1).fill(0), p90: new Array(horizonWeeks + 1).fill(0) };
    const drivers = Array.from({ length: horizonWeeks + 1 }, () => ({ inflows: [], outflows: [] }));

    for (const inv of receivables) {
      const dist = dtp.perCustomer.get(inv.customer_id) || companyDist || [termsDays(inv)];
      const d10 = stats.percentile(dist, 10);
      const d50 = stats.percentile(dist, 50);
      const d90 = stats.percentile(dist, 90);
      const base = new Date(inv.invoice_date).getTime();
      // Inflows: pessimistic (P10) receives LATE (p90); optimistic (P90) EARLY (p10).
      addBucketed(inflow, drivers, 'inflows', 'AR', `${inv.invoice_number} (${fmt(inv.amount)})`, inv.amount, base, d90, d50, d10, anchor.getTime(), horizonWeeks);
    }

    for (const bill of payables) {
      const dist = apDist || [termsDays(bill)];
      const d10 = stats.percentile(dist, 10);
      const d50 = stats.percentile(dist, 50);
      const d90 = stats.percentile(dist, 90);
      const base = new Date(bill.invoice_date).getTime();
      // Outflows: pessimistic (P10) pays EARLY (p10); optimistic (P90) LATE (p90).
      addBucketed(outflow, drivers, 'outflows', 'AP', `${bill.bill_number} (${fmt(bill.amount)})`, bill.amount, base, d10, d50, d90, anchor.getTime(), horizonWeeks);
    }

    // Fixed schedule items land in the same week on every path.
    for (const item of payroll) addFixed(drivers, outflow, item, anchor.getTime(), horizonWeeks);
    for (const item of recurring) addFixed(drivers, inflow, item, anchor.getTime(), horizonWeeks);
    for (const item of loans) addFixed(drivers, outflow, item, anchor.getTime(), horizonWeeks);
    for (const item of tax) addFixed(drivers, outflow, item, anchor.getTime(), horizonWeeks);

    // -----------------------------------------------------------------------
    // Weekly closing cash per path.
    // -----------------------------------------------------------------------
    // Uncertainty that timing alone cannot express (see
    // learnWeeklyFlowVolatility). Cash position is a running sum of weekly
    // movements, so if each week's surprise is independent with standard
    // deviation sigma, the uncertainty in the CUMULATIVE position at week w
    // is sigma * sqrt(w) — it widens with the horizon, which is the property
    // the timing-only band was missing.
    let sigma = weeklySigma;
    if (!(sigma > 0)) {
      let gross = 0;
      for (let w = 1; w <= horizonWeeks; w++) gross += (inflow.p50[w] || 0) + (outflow.p50[w] || 0);
      sigma = (gross / horizonWeeks) * NO_HISTORY_SIGMA_FRACTION;
    }

    const weeks = [];
    let running = { p10: startingCash, p50: startingCash, p90: startingCash };
    for (let w = 1; w <= horizonWeeks; w++) {
      running.p10 += inflow.p10[w] - outflow.p10[w];
      running.p50 += inflow.p50[w] - outflow.p50[w];
      running.p90 += inflow.p90[w] - outflow.p90[w];

      const spread = Z_P10_P90 * sigma * Math.sqrt(w);
      // The timing paths can cross the p50 in either direction, so widen from
      // whichever bound is actually the low/high one rather than assuming
      // running.p10 < running.p90.
      const lo = Math.min(running.p10, running.p50, running.p90) - spread;
      const hi = Math.max(running.p10, running.p50, running.p90) + spread;

      const weekDate = addDays(anchor, w * 7);
      weeks.push({
        week: w,
        date: iso(weekDate),
        p10: Number(lo.toFixed(2)),
        p50: Number(running.p50.toFixed(2)),
        p90: Number(hi.toFixed(2)),
        expected_inflow: Number((inflow.p50[w] || 0).toFixed(2)),
        expected_outflow: Number((outflow.p50[w] || 0).toFixed(2)),
        drivers: drivers[w],
      });
    }

    return {
      success: true,
      company_id: company,
      starting_cash: startingCash,
      forecast_weeks: weeks,
      method: 'behavioural',
      notes: [
        'P10/P50/P90 are the empirical percentiles of each customer/vendor\'s observed days-to-pay applied to open AR/AP.',
        'P10 (pessimistic) pays receivables late and payables early; P90 (optimistic) is the reverse.',
        'Customers without payment history fall back to the company distribution, then to their own payment terms.',
        'The band also carries the measured volatility of this company\'s past weekly net cash movement, widened by sqrt(weeks) — without it the band closes to zero once all open AR/AP has landed on every path.',
      ],
      weekly_flow_sigma: Number(sigma.toFixed(2)),
      sigma_source: weeklySigma > 0 ? 'measured' : 'no-history-floor',
      generated_at: new Date().toISOString(),
    };
  }

  /**
   * Backtest: refit the forecast as of a past date using only data known then,
   * then check whether the P10/P90 bands bracket the actual cash movements
   * that followed (measured on posted journal lines against cash accounts).
   */
  static async backtest({ companyId = currentCompanyId(), asOf, horizonWeeks = 8 } = {}) {
    const anchor = new Date(asOf);
    const forecast = await this.generate13WeekForecast(companyId, { asOf: iso(anchor), horizonWeeks });
    const company = companyId || forecast.company_id;

    const { rows } = await pool.query(
      `SELECT je.entry_date::date AS entry_date, SUM(jei.debit_amount - jei.credit_amount)::float AS net
         FROM journal_entries je
         JOIN journal_entry_items jei ON jei.journal_entry_id = je.id
         JOIN chart_of_accounts coa ON coa.id = jei.account_id
        WHERE je.company_id = $1 AND je.status = 'POSTED' AND je.deleted_at IS NULL
          AND coa.account_type = 'ASSET' AND coa.account_subtype = 'CASH'
          AND je.entry_date::date > $2::date
          AND je.entry_date::date <= ($2::date + ($3::int || ' weeks')::interval)
        GROUP BY je.entry_date::date
        ORDER BY je.entry_date::date`,
      [company, iso(anchor), horizonWeeks]
    );

    const weeklyNet = new Array(horizonWeeks + 1).fill(0);
    for (const r of rows) {
      // The ::date value arrives as a JS Date at the session's local midnight
      // (e.g. 2026-08-02 local = 2026-08-01T20:00Z at UTC+4). Bucket by the
      // row's LOCAL calendar date, mapped to a UTC-midnight anchor like every
      // other date in the forecast — otherwise entries posted today fall into
      // week 0 and the actuals silently lose them.
      const raw = r.entry_date;
      const dateStr = raw instanceof Date
        ? `${raw.getFullYear()}-${String(raw.getMonth() + 1).padStart(2, '0')}-${String(raw.getDate()).padStart(2, '0')}`
        : String(raw).slice(0, 10);
      const w = weekIndex(new Date(dateStr), anchor, horizonWeeks);
      if (w > 0) weeklyNet[w] += Number(r.net || 0);
    }

    const starting = forecast.starting_cash;
    let actual = starting;
    const weeks = forecast.forecast_weeks.map((fw, i) => {
      const w = i + 1;
      actual += weeklyNet[w];
      const bracketed = actual >= fw.p10 && actual <= fw.p90;
      return {
        week: w,
        date: fw.date,
        forecast_p10: fw.p10,
        forecast_p50: fw.p50,
        forecast_p90: fw.p90,
        actual_closing_cash: Number(actual.toFixed(2)),
        bracketed,
      };
    });

    const bracketedCount = weeks.filter((w) => w.bracketed).length;
    return {
      success: true,
      company_id: company,
      as_of: iso(anchor),
      horizon_weeks: horizonWeeks,
      starting_cash: starting,
      weeks,
      bracketed: bracketedCount,
      total: weeks.length,
      bracket_rate: weeks.length ? Number((bracketedCount / weeks.length).toFixed(3)) : 0,
    };
  }
}

// --- helpers ---------------------------------------------------------------

async function defaultCompanyId() {
  const { rows } = await pool.query('SELECT id FROM companies ORDER BY created_at LIMIT 1');
  return rows[0]?.id || null;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function iso(date) {
  return new Date(date).toISOString().split('T')[0];
}

/** Days-to-pay fallback from the invoice's own terms when no history exists. */
function termsDays(row) {
  const days = row && row.due_date ? Math.max(0, Math.round((new Date(row.due_date) - new Date(row.invoice_date)) / 86400000)) : DEFAULT_DTP_DAYS;
  return Number.isFinite(days) ? days : DEFAULT_DTP_DAYS;
}

/** Week index (1-based) of a date relative to the anchor; 0 = before/on anchor. */
function weekIndex(date, anchor, horizonWeeks) {
  const diff = Math.floor((new Date(date).getTime() - new Date(anchor).getTime()) / 86400000);
  if (diff <= 0) return 0;
  return Math.min(horizonWeeks, Math.ceil(diff / 7));
}

/**
 * Bucket an item into weeks for the three paths. `order` maps path→days-to-pay:
 * for inflows the pessimistic path uses the largest DTP, for outflows it uses
 * the smallest.
 */
function addBucketed(bucket, drivers, side, sourceType, label, amount, baseMs, dPessimistic, dMiddle, dOptimistic, anchorMs, horizonWeeks) {
  const paths = [
    ['p10', dPessimistic],
    ['p50', dMiddle],
    ['p90', dOptimistic],
  ];
  for (const [path, days] of paths) {
    const date = new Date(baseMs + days * 86400000);
    let w = weekIndex(date, new Date(anchorMs), horizonWeeks);
    // An expected receipt/payment dated before the horizon (week 0) must land
    // in the first week, not vanish: dropping it would let the optimistic
    // path receive less than the middle one and invert the P10/P50/P90 order.
    w = Math.max(1, w);
    bucket[path][w] += Number(amount);
  }
  // Drivers reflect the middle (p50) expectation.
  const date = new Date(baseMs + dMiddle * 86400000);
  let w = weekIndex(date, new Date(anchorMs), horizonWeeks);
  w = Math.max(1, w);
  drivers[w][side].push({ type: sourceType, label, amount: Number(amount), expected_date: iso(date) });
}

/** Fixed-date schedule items: same week on every path. */
function addFixed(drivers, bucket, item, anchorMs, horizonWeeks) {
  const w = weekIndex(new Date(item.date), new Date(anchorMs), horizonWeeks);
  if (w <= 0) return;
  bucket.p10[w] += Number(item.amount);
  bucket.p50[w] += Number(item.amount);
  bucket.p90[w] += Number(item.amount);
  const side = item.type === 'recurring_invoice' ? 'inflows' : 'outflows';
  drivers[w][side].push({ type: item.type, label: item.label, amount: Number(item.amount), expected_date: item.date });
}

function fmt(n) {
  return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

module.exports = CashflowForecastService;
