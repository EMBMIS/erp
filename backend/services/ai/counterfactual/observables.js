/**
 * The state vector of the business, measured from the ledger.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE REPORTING SERVICES
 * ---------------------------------------------------------------------------
 * Every number here could be read from an existing service — trial balance from
 * financialPostingService, cash from cashflowForecastService, aging from the
 * tool registry. They are re-expressed here for one reason: they must all run
 * on a SPECIFIC pg client, the one holding the shadow transaction, so that they
 * see the branch's uncommitted effects. The existing services take their
 * connection from the pool, which means they would read the committed state and
 * report that nothing changed — the single most dangerous possible bug in this
 * feature, because it produces a plausible number rather than an error.
 *
 * So the rule for this module: every function takes `client` as its first
 * argument, and nothing in here touches the pool. The queries are deliberately
 * the same shape as the live ones so that a baseline measured here matches what
 * the person sees on their dashboard.
 *
 * All amounts are in the company's base currency via the stored base_amount /
 * exchange_rate columns where they exist, and nominal otherwise — the same
 * compromise the live reports make. Deltas between two vectors measured the
 * same way are unaffected by it.
 */

const num = (v) => Number(v || 0);

/**
 * Cash: the current balance of the ACTIVE cash accounts.
 * Mirrors CashflowForecastService.startingCash so the baseline agrees with the
 * cash figure shown everywhere else in the app.
 */
async function cash(client, companyId) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(current_balance), 0)::float AS cash
       FROM chart_of_accounts
      WHERE company_id = $1
        AND account_type = 'ASSET'
        AND account_subtype = 'CASH'
        AND status = 'ACTIVE'
        AND deleted_at IS NULL`,
    [companyId]
  );
  return num(rows[0]?.cash);
}

/** Receivables: outstanding on open customer invoices, plus how much is late. */
async function receivables(client, companyId) {
  const { rows } = await client.query(
    `SELECT
        COALESCE(SUM(outstanding_amount), 0)::float                               AS open_total,
        COALESCE(SUM(outstanding_amount) FILTER (
          WHERE due_date < CURRENT_DATE), 0)::float                               AS overdue_total,
        COUNT(*) FILTER (WHERE due_date < CURRENT_DATE)::int                      AS overdue_count,
        COALESCE(MAX(CURRENT_DATE - due_date) FILTER (
          WHERE due_date < CURRENT_DATE), 0)::int                                 AS worst_days_late,
        COALESCE(SUM(outstanding_amount * GREATEST(0, CURRENT_DATE - due_date)), 0)::float
                                                                                  AS weighted_days_late
       FROM customer_invoices
      WHERE company_id = $1
        AND deleted_at IS NULL
        AND status IN ('APPROVED','SENT','PARTIALLY_PAID','OVERDUE')
        AND outstanding_amount > 0`,
    [companyId]
  );
  const r = rows[0] || {};
  const open = num(r.open_total);
  return {
    open_total: open,
    overdue_total: num(r.overdue_total),
    overdue_count: num(r.overdue_count),
    worst_days_late: num(r.worst_days_late),
    // Amount-weighted lateness: one big invoice a month late matters more than
    // twenty small ones a day late, and a plain count says the opposite.
    avg_days_late: open > 0 ? num(r.weighted_days_late) / open : 0,
  };
}

/** Payables: the same shape, owed the other way. */
async function payables(client, companyId) {
  const { rows } = await client.query(
    `SELECT
        COALESCE(SUM(outstanding_amount), 0)::float                               AS open_total,
        COALESCE(SUM(outstanding_amount) FILTER (
          WHERE due_date < CURRENT_DATE), 0)::float                               AS overdue_total,
        COUNT(*) FILTER (WHERE due_date < CURRENT_DATE)::int                      AS overdue_count,
        COALESCE(MAX(CURRENT_DATE - due_date) FILTER (
          WHERE due_date < CURRENT_DATE), 0)::int                                 AS worst_days_late,
        COALESCE(SUM(outstanding_amount * GREATEST(0, CURRENT_DATE - due_date)), 0)::float
                                                                                  AS weighted_days_late
       FROM supplier_invoices
      WHERE company_id = $1
        AND deleted_at IS NULL
        AND status IN ('APPROVED','PARTIALLY_PAID','OVERDUE')
        AND outstanding_amount > 0`,
    [companyId]
  );
  const r = rows[0] || {};
  const open = num(r.open_total);
  return {
    open_total: open,
    overdue_total: num(r.overdue_total),
    overdue_count: num(r.overdue_count),
    worst_days_late: num(r.worst_days_late),
    avg_days_late: open > 0 ? num(r.weighted_days_late) / open : 0,
  };
}

/**
 * Inventory: value at hand, and how many lines sit at or below their reorder
 * point. `stockouts` is the count actually at zero — the number a branch is
 * never allowed to increase, which is why it is measured separately from the
 * softer "below reorder point" signal.
 */
async function inventory(client, companyId) {
  const { rows } = await client.query(
    `SELECT
        COALESCE(SUM(current_stock_quantity * COALESCE(unit_price, 0)), 0)::float AS value,
        COUNT(*) FILTER (
          WHERE reorder_point IS NOT NULL
            AND current_stock_quantity <= reorder_point)::int                     AS below_reorder,
        COUNT(*) FILTER (WHERE current_stock_quantity <= 0)::int                  AS stockouts,
        COUNT(*)::int                                                             AS lines
       FROM inventory_items
      WHERE company_id = $1`,
    [companyId]
  );
  const r = rows[0] || {};
  return {
    value: num(r.value),
    below_reorder: num(r.below_reorder),
    stockouts: num(r.stockouts),
    lines: num(r.lines),
  };
}

/**
 * Whether the books balance, from posted journal lines only.
 *
 * This is the integrity check, not a business metric: a branch whose effects
 * left total debits and credits unequal has corrupted the ledger, and no score
 * it achieves on cash is worth looking at. Measuring it per branch is cheap and
 * catches an effect primitive that posts a one-sided entry — a class of bug
 * that would otherwise surface months later during a close.
 */
async function ledgerBalance(client, companyId) {
  const { rows } = await client.query(
    `SELECT
        COALESCE(SUM(jei.debit_amount), 0)::float  AS debits,
        COALESCE(SUM(jei.credit_amount), 0)::float AS credits
       FROM journal_entry_items jei
       JOIN journal_entries je ON je.id = jei.journal_entry_id
      WHERE je.company_id = $1
        AND je.deleted_at IS NULL
        AND je.status = 'POSTED'`,
    [companyId]
  );
  const debits = num(rows[0]?.debits);
  const credits = num(rows[0]?.credits);
  return { debits, credits, difference: Math.round((debits - credits) * 100) / 100 };
}

/** Committed spend not yet invoiced: approved POs still open. */
async function openCommitments(client, companyId) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(total_amount), 0)::float AS committed,
            COUNT(*)::int                          AS orders
       FROM purchase_orders
      WHERE company_id = $1
        AND status IN ('APPROVED','SENT_TO_SUPPLIER','CONFIRMED','PARTIALLY_RECEIVED')`,
    [companyId]
  );
  return { committed: num(rows[0]?.committed), orders: num(rows[0]?.orders) };
}

/**
 * Measure everything, on this client, in this transaction.
 *
 * Derived figures (working capital, quick ratio, net cash position) are
 * computed here rather than stored so that every branch's derivation is
 * identical by construction.
 */
async function measure(client, companyId) {
  const [c, ar, ap, inv, gl, po] = await Promise.all([
    cash(client, companyId),
    receivables(client, companyId),
    payables(client, companyId),
    inventory(client, companyId),
    ledgerBalance(client, companyId),
    openCommitments(client, companyId),
  ]);

  const workingCapital = c + ar.open_total + inv.value - ap.open_total;

  return {
    cash: c,
    ar_open: ar.open_total,
    ar_overdue: ar.overdue_total,
    ar_overdue_count: ar.overdue_count,
    ar_avg_days_late: round(ar.avg_days_late),
    ap_open: ap.open_total,
    ap_overdue: ap.overdue_total,
    ap_overdue_count: ap.overdue_count,
    ap_avg_days_late: round(ap.avg_days_late),
    ap_worst_days_late: ap.worst_days_late,
    inventory_value: inv.value,
    inventory_below_reorder: inv.below_reorder,
    stockouts: inv.stockouts,
    open_commitments: po.committed,
    working_capital: round(workingCapital),
    // Cash available against what is already late — the number a treasurer
    // actually looks at before deciding a payment run.
    net_cash_after_overdue: round(c - ap.overdue_total),
    ledger_debits: gl.debits,
    ledger_credits: gl.credits,
    ledger_difference: gl.difference,
    measured_at: new Date().toISOString(),
  };
}

/** Difference between two state vectors, for the numeric fields only. */
function diff(baseline, measured) {
  const out = {};
  for (const key of Object.keys(measured)) {
    const a = baseline[key];
    const b = measured[key];
    if (typeof a === 'number' && typeof b === 'number') out[key] = round(b - a);
  }
  return out;
}

function round(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

module.exports = { measure, diff, cash, receivables, payables, inventory, ledgerBalance, openCommitments };
