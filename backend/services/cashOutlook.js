/**
 * "Will we have the cash?" — where cash dips in the next 13 weeks, why, and
 * what lifts it.
 *
 * WHAT THIS ANSWERS
 * ---------------------------------------------------------------------------
 * The 13-week forecast (services/cashflowForecastService.js) projects cash from
 * bank balances, open invoices and bills (each settled on the days this
 * company's customers and this company itself actually take to pay), payroll,
 * recurring invoices, loans and tax. This reads it the way a finance manager
 * would, and adds what is already on the record but not yet invoiced:
 *
 *   Commitments  purchase orders approved or on their way and not yet billed
 *                (paid after delivery, on the days this company takes to pay),
 *                and customer orders committed and not yet invoiced (collected
 *                after delivery, on the days that customer takes to pay).
 *   Holds        a bill on payment hold is not going out, so it is taken back
 *                out of the outflows.
 *   Low point    the week the expected (P50) balance is lowest, the first week
 *                it falls under the floor (default: the next payroll), and the
 *                first week the pessimistic (P10) path does.
 *   Causes       what goes out before the low point, largest first, and the
 *                customers whose payment habit moves money they owe past it —
 *                each with the invoices behind it.
 *   Proposals    each measured at the low point by moving the money it moves:
 *                remind the customers who would pay before it on their terms,
 *                pay bills on their due date instead of early, and approve or
 *                re-time purchase orders still waiting for approval.
 *
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It changes nothing. Reminders go out only when a person in finance sends
 * them (sendReminders, below — Simeli's tool for it always stops for the
 * person); paying on the due date and re-timing a purchase order are
 * proposals for the people who own them. Only finance, managers and admins
 * see cash; a sales or warehouse role is told so, not given a smaller answer.
 */

const { pool } = require('../config/database');
const companyContext = require('./companyContext');
const CashflowForecastService = require('./cashflowForecastService');
const stats = require('./ai/stats');

const SEES_CASH = new Set(['ADMIN', 'MANAGER', 'FINANCE_MANAGER', 'FINANCE_USER']);
const OPEN_PO = ['APPROVED', 'SENT_TO_SUPPLIER', 'CONFIRMED', 'PREPARING_DELIVERY', 'IN_TRANSIT', 'DELIVERED',
  'GOODS_READY_FOR_RECEIPT', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED'];
const WAITING_PO = ['DRAFT', 'PENDING_APPROVAL'];
const OPEN_SO = ['APPROVED', 'SENT_TO_CUSTOMER', 'CONFIRMED', 'CUSTOMER_ACCEPTED', 'IN_PRODUCTION', 'GOODS_ISSUED',
  'READY_FOR_DELIVERY', 'SHIPPED', 'DELIVERED', 'WAITING_CUSTOMER_DELIVERY_CONFIRMATION', 'DELIVERY_ISSUE_REPORTED'];
const DEFAULT_DAYS = 30;
const REMINDER_DAYS = 7; // an overdue invoice reminded today is assumed to be paid within a week — said in the answer

const DAY = 86400000;
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const r0 = (v) => Math.round(Number(v) || 0);
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const addDays = (d, n) => new Date(new Date(d).getTime() + n * DAY);
const money = (v, cur) => `${cur} ${Math.round(Number(v) || 0).toLocaleString('en-US')}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Week index (1-based) from the anchor, same rule as the forecast engine. */
function weekOf(date, anchor, horizon) {
  const diff = Math.floor((new Date(date).getTime() - new Date(anchor).getTime()) / DAY);
  if (diff <= 0) return 1;
  return Math.min(horizon, Math.ceil(diff / 7));
}

async function resolveCompany(companyId) {
  return companyId || companyContext.currentCompanyId() || (await companyContext.getDefaultCompanyId());
}

/* ------------------------------------------------------------------ reads */

async function readCurrency(companyId) {
  const { rows } = await pool.query('SELECT base_currency FROM companies WHERE id = $1', [companyId]);
  return rows[0]?.base_currency || 'USD';
}

/** Open customer invoices with who owes them, their terms and who looks after the customer. */
async function readReceivables(companyId) {
  const { rows } = await pool.query(
    `SELECT ci.id, ci.invoice_number, ci.customer_id, ci.invoice_date, ci.due_date,
            ci.outstanding_amount::float AS amount, ci.currency,
            c.customer_name, c.primary_email, c.sales_rep_id,
            GREATEST(0, CURRENT_DATE - ci.due_date)::int AS days_overdue
       FROM customer_invoices ci
       LEFT JOIN customers c ON c.id = ci.customer_id
      WHERE ci.company_id = $1 AND ci.deleted_at IS NULL
        AND ci.status IN ('APPROVED', 'SENT', 'PARTIALLY_PAID', 'OVERDUE')
        AND ci.outstanding_amount > 0 AND ci.invoice_date <= CURRENT_DATE`,
    [companyId],
  );
  return rows;
}

/** Open supplier bills, with the hold flag (a held bill is not paid). */
async function readPayables(companyId) {
  const { rows } = await pool.query(
    `SELECT si.id, si.bill_number, si.supplier_invoice_number, si.supplier_id, si.invoice_date, si.due_date,
            si.outstanding_amount::float AS amount, COALESCE(si.payment_hold, FALSE) AS payment_hold,
            COALESCE(s.trade_name, s.legal_name) AS supplier_name
       FROM supplier_invoices si
       LEFT JOIN suppliers s ON s.id = si.supplier_id
      WHERE si.company_id = $1 AND si.deleted_at IS NULL
        AND si.status IN ('APPROVED', 'PARTIALLY_PAID', 'OVERDUE')
        AND si.outstanding_amount > 0 AND si.invoice_date <= CURRENT_DATE`,
    [companyId],
  );
  return rows;
}

/** Purchase orders committed or waiting for approval, less what has already been billed against them. */
async function readPurchaseOrders(companyId) {
  const { rows } = await pool.query(
    `SELECT po.id, po.po_number, po.status, po.po_date, po.delivery_date, po.total_amount::float AS total,
            COALESCE(s.trade_name, s.legal_name) AS supplier_name,
            COALESCE(b.billed, 0)::float AS billed
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN (SELECT purchase_order_id, SUM(total_amount) AS billed
                    FROM supplier_invoices
                   WHERE company_id = $1 AND deleted_at IS NULL AND status NOT IN ('CANCELLED', 'REJECTED', 'VOID')
                   GROUP BY purchase_order_id) b ON b.purchase_order_id = po.id
      WHERE po.company_id = $1
        AND po.status = ANY($2::text[])
        AND po.total_amount > COALESCE(b.billed, 0)`,
    [companyId, [...OPEN_PO, ...WAITING_PO]],
  );
  return rows.map((r) => ({ ...r, unbilled: r2(r.total - r.billed), waiting: WAITING_PO.includes(r.status) }));
}

/** Customer orders committed and not yet invoiced. */
async function readSalesOrders(companyId) {
  const { rows } = await pool.query(
    `SELECT so.id, so.so_number, so.customer_id, COALESCE(c.customer_name, so.customer_name) AS customer_name,
            so.order_date, so.delivery_date, so.total_amount::float AS total,
            COALESCE(i.invoiced, 0)::float AS invoiced
       FROM sales_orders so
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN (SELECT sales_order_id, SUM(total_amount) AS invoiced
                    FROM customer_invoices
                   WHERE company_id = $1 AND deleted_at IS NULL AND status NOT IN ('CANCELLED', 'VOID', 'REJECTED')
                   GROUP BY sales_order_id) i ON i.sales_order_id = so.id
      WHERE so.company_id = $1 AND so.deleted_at IS NULL
        AND so.status = ANY($2::text[])
        AND so.total_amount > COALESCE(i.invoiced, 0)`,
    [companyId, OPEN_SO],
  );
  return rows.map((r) => ({ ...r, uninvoiced: r2(r.total - r.invoiced) }));
}

async function readNames(ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  const { rows } = await pool.query(
    `SELECT id, COALESCE(NULLIF(TRIM(CONCAT(first_name, ' ', last_name)), ''), email) AS name
       FROM users WHERE id = ANY($1::uuid[])`,
    [list],
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}

/* --------------------------------------------------------------- outlook */

/**
 * @param {object} opts { companyId, userId, role, floor?, today? }
 */
async function explainCashOutlook(opts = {}) {
  const role = String(opts.role || '').toUpperCase();
  if (opts.userId && role && !SEES_CASH.has(role)) {
    return { error: 'Cash is visible to finance, managers and admins only.', status: 403 };
  }
  const companyId = await resolveCompany(opts.companyId);
  if (!companyId) return { error: 'No company to read.', status: 400 };
  const today = new Date(iso(opts.today || new Date()));
  const H = 13;

  const [forecast, currency, dtp, apDtp, receivables, payables, pos, sos] = await Promise.all([
    CashflowForecastService.generate13WeekForecast(companyId),
    readCurrency(companyId),
    CashflowForecastService.learnDaysToPay(companyId, iso(today)),
    CashflowForecastService.learnApDaysToPay(companyId, iso(today)),
    readReceivables(companyId),
    readPayables(companyId),
    readPurchaseOrders(companyId),
    readSalesOrders(companyId),
  ]);
  const weeks = forecast.forecast_weeks || [];
  const startingCash = r2(forecast.starting_cash);

  // The same days-to-pay the forecast engine uses, so a date named here is the
  // date the forecast put the money in.
  const customerDays = (customerId) => {
    const d = dtp.perCustomer.get(customerId) || (dtp.company.length ? dtp.company : null);
    return d ? stats.percentile(d, 50) : null;
  };
  const companyCustomerDays = dtp.company.length ? stats.percentile(dtp.company, 50) : DEFAULT_DAYS;
  const payDays = apDtp.length ? stats.percentile(apDtp, 50) : null;
  const termsOf = (row) => (row.due_date && row.invoice_date
    ? Math.max(0, Math.round((new Date(row.due_date) - new Date(row.invoice_date)) / DAY)) : DEFAULT_DAYS);

  // Per-week adjustments on top of the engine: commitments and holds.
  const adjIn = new Array(H + 1).fill(0);
  const adjOut = new Array(H + 1).fill(0);
  const commitments = { purchase_orders: [], sales_orders: [], held_bills: [] };

  for (const po of pos.filter((p) => !p.waiting)) {
    const delivery = po.delivery_date && new Date(po.delivery_date) > today ? po.delivery_date : today;
    const pays = addDays(delivery, payDays ?? DEFAULT_DAYS);
    const w = weekOf(pays, today, H);
    if (new Date(pays) > addDays(today, H * 7)) continue;
    adjOut[w] += po.unbilled;
    commitments.purchase_orders.push({ id: po.id, number: po.po_number, supplier: po.supplier_name, amount: po.unbilled, expected_date: iso(pays), week: w, status: po.status });
  }
  for (const so of sos) {
    const delivery = so.delivery_date && new Date(so.delivery_date) > today ? so.delivery_date : today;
    const days = customerDays(so.customer_id) ?? DEFAULT_DAYS;
    const lands = addDays(delivery, days);
    if (new Date(lands) > addDays(today, H * 7)) continue;
    const w = weekOf(lands, today, H);
    adjIn[w] += so.uninvoiced;
    commitments.sales_orders.push({ id: so.id, number: so.so_number, customer: so.customer_name, amount: so.uninvoiced, expected_date: iso(lands), week: w });
  }

  // Where the engine put each bill (company pay days, else 30) — a held bill comes back out.
  const billWeek = (b) => weekOf(addDays(b.invoice_date, payDays ?? DEFAULT_DAYS), today, H);
  for (const b of payables.filter((x) => x.payment_hold)) {
    const w = billWeek(b);
    adjOut[w] -= b.amount;
    commitments.held_bills.push({ id: b.id, number: b.bill_number, supplier: b.supplier_name, amount: r2(b.amount), week: w });
  }

  // The adjusted path.
  let cum = 0;
  const path = weeks.map((wk, i) => {
    const w = i + 1;
    cum += adjIn[w] - adjOut[w];
    return {
      week: w,
      date: wk.date,
      p10: r2(wk.p10 + cum),
      p50: r2(wk.p50 + cum),
      p90: r2(wk.p90 + cum),
      inflow: r2((wk.expected_inflow || 0) + adjIn[w]),
      outflow: r2((wk.expected_outflow || 0) + adjOut[w]),
      on_books_p50: wk.p50,
    };
  });

  // The floor: what the person said, else the next payroll, else zero.
  const payrollItem = weeks.flatMap((wk) => (wk.drivers?.outflows || [])).find((d) => d.type === 'payroll');
  const floor = opts.floor != null && Number.isFinite(Number(opts.floor)) ? Number(opts.floor) : r2(payrollItem?.amount || 0);
  const floorSource = opts.floor != null ? 'given' : payrollItem ? 'next_payroll' : 'zero';

  if (!path.length) {
    return { currency, starting_cash: startingCash, weeks: [], headline: 'Nothing to project: no bank balance, open invoice, bill, order or schedule.', causes: [], proposals: [] };
  }

  const low = path.reduce((m, w) => (w.p50 < m.p50 ? w : m), path[0]);
  const firstUnder = path.find((w) => w.p50 < floor) || null;
  const firstP10Under = path.find((w) => w.p10 < floor) || null;
  const lowDate = new Date(low.date);
  const verdict = firstUnder ? (low.p50 < 0 ? 'short' : 'under_floor') : firstP10Under ? 'at_risk' : 'covered';

  /* ---------------------------------------------------------------- causes */

  // What leaves before (and in) the low week, from the engine's drivers plus commitments.
  const outs = [];
  weeks.slice(0, low.week).forEach((wk) => {
    for (const d of wk.drivers?.outflows || []) {
      outs.push({ kind: d.type === 'AP' ? 'bill' : d.type, label: d.label, amount: r2(d.amount), date: d.expected_date, week: wk.week });
    }
  });
  commitments.purchase_orders.filter((p) => p.week <= low.week)
    .forEach((p) => outs.push({ kind: 'purchase_order', label: `${p.number} · ${p.supplier || 'supplier'} (not yet billed)`, amount: p.amount, date: p.expected_date, week: p.week, id: p.id }));
  const heldIds = new Set(commitments.held_bills.map((h) => h.number));
  const outflowCauses = outs.filter((o) => !(o.kind === 'bill' && heldIds.has(String(o.label).split(' ')[0])))
    .sort((a, b) => b.amount - a.amount).slice(0, 5);

  // Customers whose habit moves money past the low point that their terms would land before it.
  const late = [];
  for (const inv of receivables) {
    const days = customerDays(inv.customer_id) ?? DEFAULT_DAYS;
    const expected = addDays(inv.invoice_date, days);
    const due = new Date(inv.due_date || addDays(inv.invoice_date, termsOf(inv)));
    const overdue = inv.days_overdue > 0;
    // On terms: by its due date — or, already overdue, within a week of a reminder.
    const onTerms = overdue ? addDays(today, REMINDER_DAYS) : due;
    if (expected > lowDate && onTerms <= lowDate) {
      late.push({ ...inv, expected_date: iso(expected), on_terms_date: iso(onTerms), days_to_pay: r0(days), terms_days: termsOf(inv), overdue });
    }
  }
  const byCustomer = new Map();
  for (const inv of late) {
    const k = inv.customer_id || inv.customer_name;
    if (!byCustomer.has(k)) byCustomer.set(k, { customer_id: inv.customer_id, customer: inv.customer_name, email: inv.primary_email, sales_rep_id: inv.sales_rep_id, invoices: [], amount: 0, days_to_pay: inv.days_to_pay, terms_days: inv.terms_days });
    const c = byCustomer.get(k);
    c.invoices.push({ id: inv.id, number: inv.invoice_number, amount: r2(inv.amount), due_date: iso(inv.due_date), days_overdue: inv.days_overdue, expected_date: inv.expected_date, on_terms_date: inv.on_terms_date });
    c.amount = r2(c.amount + inv.amount);
  }
  const lateCustomers = [...byCustomer.values()].sort((a, b) => b.amount - a.amount);
  const owners = await readNames(lateCustomers.map((c) => c.sales_rep_id));

  // Bills this company habitually pays before their due date, when the due date is after the low point.
  const early = payables.filter((b) => !b.payment_hold && b.due_date && payDays != null)
    .map((b) => ({ ...b, pays: addDays(b.invoice_date, payDays) }))
    .filter((b) => b.pays <= lowDate && new Date(b.due_date) > lowDate && b.pays >= today)
    .sort((a, b) => b.amount - a.amount);

  // Purchase orders still waiting for approval whose payment would land before the low point.
  const waitingPOs = pos.filter((p) => p.waiting).map((p) => {
    const delivery = p.delivery_date && new Date(p.delivery_date) > today ? p.delivery_date : today;
    return { ...p, pays: addDays(delivery, payDays ?? DEFAULT_DAYS) };
  }).filter((p) => p.pays <= lowDate).sort((a, b) => b.unbilled - a.unbilled);

  // Re-measure the path with money moved between weeks: an inflow brought
  // earlier or an outflow pushed later. The lifted low point is the new
  // minimum over all 13 weeks, so a move that only shifts the dip elsewhere
  // is not counted as a lift.
  const measure = (moves) => {
    const pts = path.map((w) => {
      let d = 0;
      for (const m of moves) {
        const sign = m.inflow ? 1 : -1;
        d += sign * m.amount * ((w.week >= m.to ? 1 : 0) - (w.week >= m.from ? 1 : 0));
      }
      return { week: w.week, date: w.date, p50: r2(w.p50 + d) };
    });
    const m = pts.reduce((a, b) => (b.p50 < a.p50 ? b : a), pts[0]);
    return { week: m.week, date: m.date, p50: m.p50, lift: r2(m.p50 - low.p50) };
  };

  const short = (o) => (o.kind === 'payroll' ? `payroll ${money(o.amount, currency)} on ${o.date}`
    : o.kind === 'purchase_order' ? `${o.number} to ${o.supplier || 'the supplier'} ${money(o.amount, currency)}`
      : o.kind === 'bill' ? `${o.number} ${money(o.amount, currency)}`
        : `${o.label || o.kind} ${money(o.amount, currency)}`);
  const causes = [];
  for (const o of outflowCauses) {
    const number = o.kind === 'purchase_order' ? String(o.label).split(' ')[0] : o.kind === 'bill' ? String(o.label).split(' ')[0] : null;
    const supplier = o.kind === 'purchase_order' ? String(o.label).split(' · ')[1]?.replace(' (not yet billed)', '') : null;
    const c = { ...o, number, supplier };
    causes.push({
      kind: o.kind,
      text: o.kind === 'payroll' ? `Payroll ${money(o.amount, currency)} on ${o.date}`
        : o.kind === 'purchase_order' ? `${number} to ${supplier || 'the supplier'}, not yet billed: ${money(o.amount, currency)} to pay around ${o.date}`
          : o.kind === 'bill' ? `Supplier bill ${number}: ${money(o.amount, currency)} paid around ${o.date}`
            : `${o.label || o.kind}: ${money(o.amount, currency)} on ${o.date}`,
      short: short(c),
      amount: o.amount,
      week: o.week,
      date: o.date,
      record: o.id ? { type: o.kind, id: o.id } : null,
    });
  }
  for (const c of lateCustomers.slice(0, 3)) {
    causes.push({
      kind: 'late_payer',
      text: `${c.customer} pays in ${c.days_to_pay} days on ${c.terms_days}-day terms: ${money(c.amount, currency)} on ${plural(c.invoices.length, 'invoice')} lands after the low point`,
      short: `${c.customer} paying in ${c.days_to_pay} days, not ${c.terms_days}`,
      amount: c.amount,
      customer_id: c.customer_id,
      invoices: c.invoices.map((i) => i.number),
    });
  }

  /* ------------------------------------------------------------- proposals */

  const proposals = [];
  const allMoves = [];
  for (const c of lateCustomers.slice(0, 5)) {
    const moves = c.invoices.map((i) => ({ inflow: true, amount: i.amount, from: weekOf(i.expected_date, today, H), to: weekOf(i.on_terms_date, today, H) }));
    allMoves.push(...moves);
    const m = measure(moves);
    proposals.push({
      kind: 'remind',
      label: `Remind ${c.customer} about ${c.invoices.map((i) => i.number).join(', ')} (${money(c.amount, currency)})`,
      lifts_low_point_by: Math.max(0, m.lift),
      assumption: c.invoices.some((i) => i.days_overdue > 0)
        ? `Overdue invoices paid within ${REMINDER_DAYS} days of the reminder, the rest on their due date.`
        : 'Paid on the due date instead of the customer\'s usual day.',
      owner: owners.get(c.sales_rep_id) || 'Finance',
      can_email: Boolean(c.email),
      args: { invoice_ids: c.invoices.map((i) => i.id) },
    });
  }
  if (early.length) {
    const moves = early.map((b) => ({ inflow: false, amount: b.amount, from: weekOf(b.pays, today, H), to: weekOf(b.due_date, today, H) }));
    allMoves.push(...moves);
    const m = measure(moves);
    const names = early.slice(0, 3).map((b) => b.bill_number).join(', ') + (early.length > 3 ? ` and ${early.length - 3} more` : '');
    proposals.push({
      kind: 'pay_on_due_date',
      label: early.length === 1
        ? `Pay ${names} (${early[0].supplier_name || 'supplier'}, ${money(early[0].amount, currency)}) on its due date, ${iso(early[0].due_date)}, instead of around ${iso(early[0].pays)}`
        : `Pay ${names} on their due dates instead of early`,
      lifts_low_point_by: Math.max(0, m.lift),
      assumption: `This company pays bills about ${r0(payDays)} days after the invoice date; these are due after the low point.`,
      owner: 'Payables',
      where: '/finance/supplier-invoices',
      bills: early.slice(0, 10).map((b) => ({ id: b.id, number: b.bill_number, supplier: b.supplier_name, amount: r2(b.amount), due_date: iso(b.due_date), usual_pay_date: iso(b.pays) })),
    });
  }
  for (const p of waitingPOs.slice(0, 3)) {
    proposals.push({
      kind: 'retime_purchase_order',
      label: `${p.po_number} (${p.supplier_name || 'supplier'}, ${money(p.unbilled, currency)}) awaits approval: a delivery after ${low.date} keeps its payment past the low point`,
      lifts_low_point_by: 0,
      would_lower_low_point_by: p.unbilled,
      assumption: 'Not in the projection yet: approving it as dated would take this much off the low point.',
      owner: 'The purchase approver',
      where: `/procurement/purchase-orders/${p.id}`,
    });
  }
  const after = allMoves.length ? measure(allMoves) : null;
  const totalLift = after ? Math.max(0, after.lift) : 0;
  const lifted = after ? after.p50 : null;

  /* -------------------------------------------------------------- headline */

  const floorText = floorSource === 'next_payroll' ? `the next payroll (${money(floor, currency)})` : money(floor, currency);
  const top = [...causes.filter((c) => c.kind !== 'late_payer').slice(0, 2), ...causes.filter((c) => c.kind === 'late_payer').slice(0, 1)]
    .map((c) => c.short).join(', ');
  const firstNegative = path.find((w) => w.p50 < 0) || null;
  let headline;
  if (verdict === 'covered') {
    headline = `Cash stays above ${floorText} for 13 weeks: lowest is ${money(low.p50, currency)} in week ${low.week} (${low.date}), and ${money(low.p10, currency)} on the late-paying path.`;
  } else if (verdict === 'at_risk') {
    headline = `Cash holds on the expected path (lowest ${money(low.p50, currency)} in week ${low.week}), but if customers pay late it falls under ${floorText} in week ${firstP10Under.week} (${firstP10Under.date}).`;
  } else {
    headline = (firstNegative && firstNegative.week === firstUnder.week
      ? `Cash falls below zero in week ${firstNegative.week} (${firstNegative.date})`
      : `Cash falls under ${floorText} in week ${firstUnder.week} (${firstUnder.date})`
        + (firstNegative ? ` and below zero in week ${firstNegative.week}` : ''))
      + `, bottoming at ${money(low.p50, currency)} on ${low.date}.`;
  }
  if (verdict !== 'covered' && top) headline += ` What puts it there: ${top}.`;
  if (verdict !== 'covered' && totalLift > 0) {
    headline += ` Reminders and paying on due dates lift the low point by ${money(totalLift, currency)} to ${money(lifted, currency)}${lifted >= floor ? ', back over the floor' : lifted >= 0 ? ', above zero' : ''}.`;
  }

  return {
    currency,
    verdict,
    headline,
    starting_cash: startingCash,
    floor: { amount: floor, source: floorSource },
    low_point: { week: low.week, date: low.date, p50: low.p50, p10: low.p10 },
    first_under_floor: firstUnder ? { week: firstUnder.week, date: firstUnder.date, p50: firstUnder.p50 } : null,
    first_below_zero: firstNegative ? { week: firstNegative.week, date: firstNegative.date, p50: firstNegative.p50 } : null,
    first_under_floor_if_late: firstP10Under ? { week: firstP10Under.week, date: firstP10Under.date, p10: firstP10Under.p10 } : null,
    weeks: path,
    causes,
    proposals,
    lifted_low_point: totalLift > 0 ? { p50: lifted, week: after.week, date: after.date } : null,
    commitments: {
      purchase_orders: commitments.purchase_orders.length,
      purchase_orders_value: r2(commitments.purchase_orders.reduce((s, p) => s + p.amount, 0)),
      sales_orders: commitments.sales_orders.length,
      sales_orders_value: r2(commitments.sales_orders.reduce((s, p) => s + p.amount, 0)),
      held_bills: commitments.held_bills,
    },
    method: {
      engine: '13-week behavioural forecast: open invoices and bills settled on the days actually taken to pay, payroll, recurring invoices, loans and tax.',
      added: 'Purchase orders not yet billed (paid after delivery on the days this company takes to pay), customer orders not yet invoiced (collected after delivery on the days that customer takes), held bills taken out.',
      customer_days_median: r0(companyCustomerDays),
      company_pay_days_median: payDays != null ? r0(payDays) : null,
    },
    generated_at: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------- reminders */

const ESCALATION = (days) => (days <= 0 ? 'COURTESY' : days <= 15 ? 'REMINDER' : days <= 45 ? 'OVERDUE_NOTICE' : 'FINAL_NOTICE');
const SUBJECT = { COURTESY: 'Upcoming payment', REMINDER: 'Friendly payment reminder', OVERDUE_NOTICE: 'Overdue payment notice', FINAL_NOTICE: 'Final notice: payment required' };

/**
 * Send payment reminders for the invoices a person picked (usually a "remind"
 * proposal from explainCashOutlook). Each one is emailed to the customer when
 * they have an address and mail is configured, and is always recorded on the
 * customer as an activity owned by their sales rep — as a follow-up call when
 * the email could not go.
 */
async function sendReminders(opts = {}) {
  const role = String(opts.role || '').toUpperCase();
  if (opts.userId && role && !SEES_CASH.has(role)) {
    return { error: 'Payment reminders are sent by finance, managers and admins only.', status: 403 };
  }
  const companyId = await resolveCompany(opts.companyId);
  const ids = [...new Set((opts.invoiceIds || []).map(String))].filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 50);
  if (!ids.length) return { error: 'Name at least one customer invoice (invoice_ids).', status: 400 };

  const { rows } = await pool.query(
    `SELECT ci.id, ci.invoice_number, ci.due_date, ci.outstanding_amount, ci.currency, ci.customer_id,
            c.customer_name, c.primary_email, c.secondary_email, c.sales_rep_id,
            (CURRENT_DATE - ci.due_date)::int AS days_overdue
       FROM customer_invoices ci
       LEFT JOIN customers c ON c.id = ci.customer_id
      WHERE ci.company_id = $1 AND ci.id = ANY($2::uuid[]) AND ci.deleted_at IS NULL
        AND ci.status IN ('APPROVED', 'SENT', 'PARTIALLY_PAID', 'OVERDUE') AND ci.outstanding_amount > 0`,
    [companyId, ids],
  );
  if (!rows.length) return { error: 'None of those invoices is open in this company.', status: 404 };

  const customerEmailService = require('./customerEmailService');
  const actor = opts.userId && /^[0-9a-f-]{36}$/i.test(opts.userId) ? opts.userId : null;
  const results = [];
  for (const inv of rows) {
    const level = ESCALATION(inv.days_overdue);
    const amount = `${inv.currency || ''} ${Number(inv.outstanding_amount).toFixed(2)}`.trim();
    const due = iso(inv.due_date);
    const message = level === 'COURTESY'
      ? `A courtesy note that invoice ${inv.invoice_number} for ${amount} is due on ${due}. Thank you for arranging payment by then.`
      : `Invoice ${inv.invoice_number} for ${amount} was due on ${due} and is now ${inv.days_overdue} day(s) overdue. Please arrange payment, or tell us if something is holding it up.`;
    let emailed = false;
    let note = null;
    if (inv.primary_email) {
      try {
        await customerEmailService.sendCustomerNotificationEmail(
          { customer_name: inv.customer_name, primary_email: inv.primary_email, secondary_email: inv.secondary_email },
          SUBJECT[level], message, 'warning',
        );
        emailed = true;
      } catch (e) {
        note = `Email not sent (${e.message}); a follow-up call is on the owner's list instead.`;
      }
    } else {
      note = 'No email on the customer; a follow-up call is on the owner\'s list instead.';
    }
    await pool.query(
      `INSERT INTO activities (id, activity_type, subject, notes, due_date, completed_at, customer_id, owner_id, created_by, company_id, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        emailed ? 'EMAIL' : 'CALL',
        `${emailed ? 'Payment reminder sent' : 'Call about payment'}: ${inv.invoice_number}`.slice(0, 255),
        `${message}\n\nFrom the cash outlook: this payment lifts the lowest cash point of the next 13 weeks.`,
        emailed ? null : iso(new Date()),
        emailed ? new Date() : null,
        inv.customer_id,
        inv.sales_rep_id || actor,
        actor,
        companyId,
      ],
    );
    results.push({ invoice_number: inv.invoice_number, customer: inv.customer_name, level, emailed, note });
  }
  const sent = results.filter((r) => r.emailed).length;
  return {
    sent,
    calls_listed: results.length - sent,
    reminders: results,
    message: `${plural(sent, 'reminder')} emailed${results.length - sent ? `, ${plural(results.length - sent, 'follow-up call')} put on the owner's list` : ''}.`,
  };
}

/* --------------------------------------------------------------- the watch */

/** Raise one CASH_LOW finding per company when the expected path goes under the floor; managers are told. */
async function raiseCashFinding(companyId) {
  const resolved = await resolveCompany(companyId);
  if (!resolved) return { created: 0 };
  const r = await explainCashOutlook({ companyId: resolved });
  if (r.error || !['short', 'under_floor'].includes(r.verdict)) return { created: 0 };
  const { upsertFinding } = require('./ai/findingsScan');
  const f = await upsertFinding({
    companyId: resolved,
    finding_type: 'CASH_LOW',
    severity: r.verdict === 'short' ? 'HIGH' : 'MEDIUM',
    entity_type: 'COMPANY',
    entity_id: resolved,
    title: (r.verdict === 'short' && r.first_below_zero
      ? `Cash below zero in week ${r.first_below_zero.week} (${r.first_below_zero.date})`
      : `Cash under the floor in week ${r.first_under_floor.week} (${r.first_under_floor.date})`).slice(0, 255),
    description: r.headline,
    data: { low_point: r.low_point, floor: r.floor, causes: r.causes.map((c) => c.text), proposals: r.proposals.map((p) => p.label), link: '/finance/cash-forecast' },
  });
  if (f.created) {
    const { rows } = await pool.query(
      `SELECT u.id FROM users u
         LEFT JOIN user_companies uc ON uc.user_id = u.id AND uc.company_id = $1
        WHERE COALESCE(uc.role, u.role) IN ('MANAGER', 'ADMIN', 'FINANCE_MANAGER')
          AND (uc.user_id IS NOT NULL
               OR (NOT EXISTS (SELECT 1 FROM user_companies x WHERE x.user_id = u.id)
                   AND EXISTS (SELECT 1 FROM companies c WHERE c.id = $1 AND c.is_default)))`,
      [resolved],
    );
    for (const u of rows) {
      await pool.query(
        `INSERT INTO notifications (id, type, title, message, data, user_id, company_id, created_at)
         VALUES (gen_random_uuid(), 'AI_FINDING', $1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
        ['Cash runs low'.slice(0, 255), r.headline, JSON.stringify({ finding_id: f.id, link: '/finance/cash-forecast' }), u.id, resolved],
      ).catch((e) => console.warn('Cash outlook notify failed:', e.message));
    }
  }
  return { created: f.created ? 1 : 0 };
}

module.exports = { explainCashOutlook, sendReminders, raiseCashFinding, SEES_CASH };
