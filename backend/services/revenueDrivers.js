/**
 * "Why are sales down?" — answered from the company's own orders, customer by
 * customer, not from two totals and a guess.
 *
 * WHAT THIS ANSWERS
 * ---------------------------------------------------------------------------
 * The Sales screen says "Revenue this month: down 14% on last month" and stops
 * there. The reason is never a number on the income statement: it is that a
 * customer who ordered every three weeks has not ordered for nine, that another
 * is buying the same products at a lower price, that a quotation was turned
 * down on price, that an account was put on credit hold. This reads the orders,
 * quotations, invoices and holds underneath the number and splits the move into
 * customers a person can call:
 *
 *   • Lapsed   bought in the baseline, nothing this period, and the gap since
 *              their last order is well past their own usual interval.
 *   • Down     still buying, but below their own pace — split into volume
 *              (fewer units, products dropped) and price (same products,
 *              lower net price).
 *   • New / up the customers pulling the other way, so the net is honest.
 *
 * Each customer comes with what else the record says about them: quotations
 * open or lost (with the reason given), a credit hold, overdue invoices, a
 * delivery issue they reported. Those are the causes a salesperson would look
 * for; they are named, not inferred.
 *
 * HOW THE NUMBERS ADD UP
 * ---------------------------------------------------------------------------
 * Sales are the net value of sales-order lines booked in each window (orders
 * that never became a sale excluded). The baseline is put on the current
 * window's pace — baseline × (days now ÷ days in baseline) — so "this month to
 * date" is compared with what the three months before would have booked in the
 * same number of days. Every customer's change is its sales now minus its pace,
 * so the customer changes add up exactly to the total change, and the bridge
 * (lost customers, new customers, volume, price) adds up to it too.
 *
 * WHO SEES WHAT
 * ---------------------------------------------------------------------------
 * Admins, managers and finance managers see the whole company. Everyone else
 * sees their own book — orders they entered and customers they are the sales
 * representative for — and the answer says so. Every query is company-scoped.
 *
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It changes nothing. Each lapsed or shrinking customer comes with a proposal:
 * a follow-up call for the customer's own sales representative, carrying the
 * evidence. prepareRevenueFollowUps puts those calls on their owners' CRM
 * follow-up lists when a person asks for it; the owner makes the call.
 */

const { pool } = require('../config/database');
const companyContext = require('./companyContext');

const SEES_ALL = new Set(['ADMIN', 'MANAGER', 'FINANCE_MANAGER']);
const NOT_SOLD = ['DRAFT', 'PENDING_APPROVAL', 'CUSTOMER_REJECTED', 'CANCELLED', 'REJECTED'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86400000;

const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const num = (v) => (v == null ? 0 : Number(v));
const round = (v, p = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** p) / 10 ** p);
const days = (from, to) => Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / DAY) + 1;
const money = (v, cur) => `${cur ? `${cur} ` : ''}${Math.round(Math.abs(v)).toLocaleString('en-US')}`;
const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];

async function resolveCompany(companyId) {
  return companyId || companyContext.currentCompanyId() || (await companyContext.getDefaultCompanyId());
}

/** This month to date against the three full months before it, unless told otherwise. */
function windows({ from, to, baselineFrom, baselineTo }) {
  const today = new Date();
  const cur = {
    from: from || iso(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)),
    to: to || iso(today),
  };
  let base;
  if (baselineFrom && baselineTo) {
    base = { from: baselineFrom, to: baselineTo };
  } else {
    const start = new Date(`${cur.from}T00:00:00Z`);
    base = {
      from: iso(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 3, 1)),
      to: iso(start.getTime() - DAY),
    };
  }
  return { cur, base };
}

/* ------------------------------------------------------------------ reads */

/** The book a person may see: everything, or their own orders and customers. */
function book(alias, userParam) {
  return `($${userParam}::uuid IS NULL OR ${alias}.created_by = $${userParam}::uuid
           OR ${alias}.customer_id IN (SELECT id FROM customers WHERE sales_rep_id = $${userParam}::uuid))`;
}

/** Net sales per customer, product and window. */
async function readSales(companyId, cur, base, scopeUser, customerFilter) {
  const { rows } = await pool.query(
    `SELECT CASE WHEN so.order_date BETWEEN $2 AND $3 THEN 'cur' ELSE 'base' END AS w,
            so.customer_id,
            MAX(COALESCE(c.customer_name, so.customer_name)) AS customer_name,
            MAX(c.customer_code) AS customer_code,
            COALESCE(ii.item_master_id::text, 'code:' || COALESCE(soi.item_code, soi.item_name, '?')) AS key,
            MAX(COALESCE(i.item_code, soi.item_code)) AS item_code,
            MAX(COALESCE(i.name, soi.item_name, soi.item_description)) AS item_name,
            MAX(so.currency) AS currency,
            SUM(soi.quantity)::float8 AS qty,
            SUM(soi.quantity * soi.unit_price
                - COALESCE(NULLIF(soi.discount_amount, 0), soi.quantity * soi.unit_price * COALESCE(soi.discount_percentage, 0) / 100))::float8 AS net,
            COUNT(DISTINCT so.id)::int AS orders
       FROM sales_order_items soi
       JOIN sales_orders so ON so.id = soi.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN inventory_items ii ON ii.id = soi.inventory_item_id
       LEFT JOIN items i ON i.id = ii.item_master_id
      WHERE so.company_id = $1 AND so.deleted_at IS NULL AND so.customer_id IS NOT NULL
        AND so.status <> ALL($6::text[])
        AND (so.order_date BETWEEN $2 AND $3 OR so.order_date BETWEEN $4 AND $5)
        AND ${book('so', 7)}
        AND ($8::text IS NULL OR c.customer_name ILIKE $8 OR c.customer_code ILIKE $8 OR so.customer_name ILIKE $8)
      GROUP BY 1, 2, 5`,
    [companyId, cur.from, cur.to, base.from, base.to, NOT_SOLD, scopeUser, customerFilter ? `%${customerFilter}%` : null],
  );
  return rows.map((r) => ({ ...r, qty: num(r.qty), net: num(r.net) }));
}

/** Every order date in the year to the end of the period, and the first order ever — each customer's own rhythm. */
async function readCadence(companyId, customerIds, through) {
  if (!customerIds.length) return [];
  const { rows } = await pool.query(
    `SELECT so.customer_id,
            ARRAY_AGG(DISTINCT so.order_date ORDER BY so.order_date)
              FILTER (WHERE so.order_date > $3::date - 365) AS dates,
            MIN(so.order_date) AS first_order,
            MAX(so.order_date) AS last_order,
            (ARRAY_AGG(so.id ORDER BY so.order_date DESC, so.created_at DESC))[1] AS last_order_id,
            (ARRAY_AGG(so.so_number ORDER BY so.order_date DESC, so.created_at DESC))[1] AS last_order_number
       FROM sales_orders so
      WHERE so.company_id = $1 AND so.deleted_at IS NULL AND so.customer_id = ANY($2::uuid[])
        AND so.status <> ALL($4::text[]) AND so.order_date <= $3::date
      GROUP BY so.customer_id`,
    [companyId, customerIds, through, NOT_SOLD],
  );
  return rows;
}

/** What else the record says about these customers: quotations, holds, overdue invoices, reported delivery issues. */
async function readContext(companyId, customerIds, since, through) {
  if (!customerIds.length) return { quotes: [], customers: [], overdue: [], issues: [] };
  const [quotes, customers, overdue, issues] = await Promise.all([
    pool.query(
      `SELECT q.id, q.customer_id, q.quotation_number, q.status, q.total_amount::float8 AS total, q.currency,
              q.quotation_date, q.valid_until, q.rejection_reason, q.customer_response_notes,
              CASE
                WHEN q.status IN ('REJECTED', 'CUSTOMER_REJECTED') THEN 'lost'
                WHEN q.status = 'EXPIRED' OR (q.status = 'SENT' AND q.valid_until < CURRENT_DATE) THEN 'expired'
                WHEN q.status IN ('SENT', 'APPROVED', 'PENDING_APPROVAL', 'DRAFT') AND COALESCE(q.converted_to_so, false) = false THEN 'open'
              END AS state
         FROM sales_quotations q
        WHERE q.company_id = $1 AND q.deleted_at IS NULL AND q.customer_id = ANY($2::uuid[])
          AND q.quotation_date BETWEEN $3 AND $4
        ORDER BY q.quotation_date DESC`,
      [companyId, customerIds, since, through],
    ).then((r) => r.rows.filter((q) => q.state)),
    pool.query(
      `SELECT c.id, c.customer_name, c.customer_code, c.credit_hold, c.credit_hold_reason, c.credit_hold_set_at,
              c.sales_rep_id, u.first_name, u.last_name, u.email, u.is_active
         FROM customers c LEFT JOIN users u ON u.id = c.sales_rep_id
        WHERE c.company_id = $1 AND c.id = ANY($2::uuid[])`,
      [companyId, customerIds],
    ).then((r) => r.rows),
    pool.query(
      `SELECT ci.customer_id, SUM(ci.outstanding_amount)::float8 AS amount, COUNT(*)::int AS invoices,
              MIN(ci.due_date) AS oldest_due
         FROM customer_invoices ci
        WHERE ci.company_id = $1 AND ci.deleted_at IS NULL AND ci.customer_id = ANY($2::uuid[])
          AND ci.due_date < CURRENT_DATE AND COALESCE(ci.outstanding_amount, 0) > 0
          AND UPPER(ci.status) NOT IN ('PAID', 'CANCELLED', 'VOID', 'DRAFT', 'WRITTEN_OFF')
        GROUP BY ci.customer_id`,
      [companyId, customerIds],
    ).then((r) => r.rows),
    pool.query(
      `SELECT so.customer_id, so.id, so.so_number, so.customer_delivery_issue_reported_at AS reported_at, so.customer_delivery_notes AS notes
         FROM sales_orders so
        WHERE so.company_id = $1 AND so.deleted_at IS NULL AND so.customer_id = ANY($2::uuid[])
          AND so.customer_delivery_issue_reported_at::date BETWEEN $3 AND $4
        ORDER BY so.customer_delivery_issue_reported_at DESC`,
      [companyId, customerIds, since, through],
    ).then((r) => r.rows),
  ]);
  return { quotes, customers, overdue, issues };
}

/** Who usually enters this customer's orders — the owner when no sales representative is set. */
async function usualOrderTaker(companyId, customerIds) {
  if (!customerIds.length) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (so.customer_id) so.customer_id, u.id, u.first_name, u.last_name, u.email
       FROM sales_orders so JOIN users u ON u.id = so.created_by
      WHERE so.company_id = $1 AND so.deleted_at IS NULL AND so.customer_id = ANY($2::uuid[])
        AND u.is_active IS NOT FALSE
      GROUP BY so.customer_id, u.id
      ORDER BY so.customer_id, COUNT(*) DESC`,
    [companyId, customerIds],
  );
  return rows;
}

/* ---------------------------------------------------------------- compute */

const nameOf = (r) => [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || null;

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * @param {object} opts
 *   companyId, userId, role       who is asking
 *   from, to                      the period to explain (default: this month to date)
 *   baselineFrom, baselineTo      what to compare it with (default: the three full months before)
 *   customer                      only customers whose name or code contains this
 *   limit                         how many customers to return per side (default 5)
 */
async function explainRevenue(opts = {}) {
  for (const k of ['from', 'to', 'baselineFrom', 'baselineTo']) {
    if (opts[k] && !ISO.test(String(opts[k]))) return { error: `${k} must be YYYY-MM-DD.` };
  }
  const companyId = await resolveCompany(opts.companyId);
  const { cur, base } = windows(opts);
  if (cur.from > cur.to) return { error: 'The period starts after it ends.' };
  if (base.from > base.to) return { error: 'The baseline starts after it ends.' };
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 5, 1), 20);
  const role = opts.role ? String(opts.role).toUpperCase() : null;
  const whole = !role || SEES_ALL.has(role) || !opts.userId || !UUID.test(String(opts.userId));
  const scopeUser = whole ? null : opts.userId;

  const pace = days(cur.from, cur.to) / days(base.from, base.to);
  const sales = await readSales(companyId, cur, base, scopeUser, opts.customer || null);

  // Customer → product → window.
  const customers = new Map();
  for (const r of sales) {
    const c = customers.get(r.customer_id) || { id: r.customer_id, name: r.customer_name, code: r.customer_code, currency: r.currency, products: new Map(), cur: 0, base: 0, orders_cur: 0, orders_base: 0 };
    const p = c.products.get(r.key) || { key: r.key, code: r.item_code, name: r.item_name };
    p[r.w] = { qty: r.qty, net: r.net };
    c.products.set(r.key, p);
    c[r.w] += r.net;
    c[`orders_${r.w}`] = Math.max(c[`orders_${r.w}`], r.orders);
    customers.set(r.customer_id, c);
  }
  const ids = [...customers.keys()];
  const [cadence, ctx, takers] = await Promise.all([
    readCadence(companyId, ids, cur.to),
    readContext(companyId, ids, base.from, cur.to),
    usualOrderTaker(companyId, ids),
  ]);
  const cadenceBy = new Map(cadence.map((r) => [r.customer_id, r]));
  const custBy = new Map(ctx.customers.map((r) => [r.id, r]));
  const overdueBy = new Map(ctx.overdue.map((r) => [r.customer_id, r]));
  const takerBy = new Map(takers.map((r) => [r.customer_id, r]));
  const group = (rows) => rows.reduce((m, r) => m.set(r.customer_id, [...(m.get(r.customer_id) || []), r]), new Map());
  const quotesBy = group(ctx.quotes);
  const issuesBy = group(ctx.issues);

  const currency = (() => {
    const t = new Map();
    for (const r of sales) t.set(r.currency || 'USD', (t.get(r.currency || 'USD') || 0) + Math.abs(r.net));
    return [...t.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'USD';
  })();

  const bridge = { no_order_now: 0, new_customers: 0, volume: 0, price: 0 };
  const movers = [];
  for (const c of customers.values()) {
    const expected = c.base * pace;
    const delta = c.cur - expected;
    const cad = cadenceBy.get(c.id);
    const firstOrder = iso(cad?.first_order);
    const isNew = c.base <= 0 && c.cur > 0 && firstOrder >= base.from;

    // Volume and price, product by product.
    const effects = [];
    let vol = 0; let price = 0;
    for (const p of c.products.values()) {
      const b = p.base; const n = p.cur;
      if (b && b.qty > 0 && n && n.qty > 0) {
        const bp = b.net / b.qty; const np = n.net / n.qty;
        const v = (n.qty - b.qty * pace) * bp;
        const pr = (np - bp) * n.qty;
        vol += v; price += pr;
        effects.push({ product: p.code || p.name, name: p.name, volume: v, price: pr, qty_now: n.qty, qty_pace: b.qty * pace, price_now: np, price_before: bp });
      } else if (b) {
        vol -= b.net * pace;
        effects.push({ product: p.code || p.name, name: p.name, volume: -b.net * pace, price: 0, dropped: true, qty_pace: b.qty * pace });
      } else if (n) {
        vol += n.net;
        effects.push({ product: p.code || p.name, name: p.name, volume: n.net, price: 0, added: true, qty_now: n.qty });
      }
    }
    if (c.cur <= 0 && c.base > 0) bridge.no_order_now += delta;
    else if (isNew) bridge.new_customers += delta;
    else { bridge.volume += vol; bridge.price += price; }

    // Their own rhythm: the usual gap between orders and how long it has been.
    const dates = (cad?.dates || []).map((d) => new Date(d).getTime());
    const gaps = dates.slice(1).map((d, i) => (d - dates[i]) / DAY).filter((g) => g > 0);
    const usualGap = median(gaps);
    const lastOrder = iso(cad?.last_order);
    const sinceLast = lastOrder ? Math.round((new Date(`${cur.to}T00:00:00Z`) - new Date(`${lastOrder}T00:00:00Z`)) / DAY) : null;
    const overdueOrder = usualGap != null && sinceLast != null && sinceLast > Math.max(usualGap * 1.5, usualGap + 7);

    const kind = c.cur <= 0 && c.base > 0 ? (overdueOrder || usualGap == null ? 'lapsed' : 'down')
      : isNew ? 'new' : delta < 0 ? 'down' : 'up';

    movers.push({ c, expected, delta, vol, price, effects, usualGap, lastOrder, sinceLast, overdueOrder, kind, cad });
  }

  const total = { now: movers.reduce((t, m) => t + m.c.cur, 0), pace: movers.reduce((t, m) => t + m.expected, 0) };
  total.change = total.now - total.pace;
  total.change_pct = total.pace > 0 ? (total.change / total.pace) * 100 : null;

  /** One customer as a driver: what moved, why the record says it moved, and the follow-up it proposes. */
  function driver(m) {
    const { c } = m;
    const info = custBy.get(c.id) || {};
    const quotes = quotesBy.get(c.id) || [];
    const lost = quotes.filter((q) => q.state === 'lost' || q.state === 'expired');
    const open = quotes.filter((q) => q.state === 'open');
    const overdue = overdueBy.get(c.id);
    const issues = issuesBy.get(c.id) || [];
    const rep = info.sales_rep_id && info.is_active !== false ? { id: info.sales_rep_id, name: nameOf(info), source: 'sales representative' } : null;
    const taker = takerBy.get(c.id);
    const owner = rep || (taker ? { id: taker.id, name: nameOf(taker), source: 'enters most of their orders' } : null);

    const parts = [];
    if (m.kind === 'lapsed') {
      parts.push(`No order since ${m.lastOrder} (${m.sinceLast} days)${m.usualGap != null ? `; they used to order every ${Math.round(m.usualGap)} days` : ''}`);
    } else if (m.kind === 'new') {
      parts.push(`First order ${iso(m.cad?.first_order)}, ${money(c.cur, currency)} booked`);
    } else {
      parts.push(`${money(c.cur, currency)} booked against ${money(m.expected, currency)} at their usual pace`);
    }
    const top = [...m.effects]
      .flatMap((e) => [
        Math.abs(e.volume) > 0 ? { e, what: 'volume', v: e.volume } : null,
        Math.abs(e.price) > 0 ? { e, what: 'price', v: e.price } : null,
      ].filter(Boolean))
      .filter((x) => (m.delta < 0 ? x.v < 0 : x.v > 0))
      .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
      .slice(0, 2);
    if (m.kind !== 'lapsed' && m.kind !== 'new') {
      for (const { e, what, v } of top) {
        if (what === 'price') parts.push(`${e.product} price ${e.price_now >= e.price_before ? '+' : ''}${round(((e.price_now - e.price_before) / e.price_before) * 100, 1)}% (${v < 0 ? '−' : '+'}${money(v, currency)})`);
        else if (e.dropped) parts.push(`stopped buying ${e.product} (−${money(v, currency)})`);
        else if (e.added) parts.push(`started buying ${e.product} (+${money(v, currency)})`);
        else parts.push(`${e.product} ${round(e.qty_now, 0)} units against ${round(e.qty_pace, 0)} at pace (${v < 0 ? '−' : '+'}${money(v, currency)})`);
      }
    }
    if (info.credit_hold) parts.push(`on credit hold since ${iso(info.credit_hold_set_at) || 'an earlier date'}${info.credit_hold_reason ? ` — ${info.credit_hold_reason}` : ''}`);
    if (lost.length) {
      const reason = lost.find((q) => q.rejection_reason || q.customer_response_notes);
      parts.push(`${lost.length} quotation${lost.length === 1 ? '' : 's'} lost or expired (${money(lost.reduce((t, q) => t + num(q.total), 0), currency)})${reason ? `: "${String(reason.rejection_reason || reason.customer_response_notes).slice(0, 80)}"` : ''}`);
    }
    if (open.length) parts.push(`${open.length} quotation${open.length === 1 ? '' : 's'} still open (${money(open.reduce((t, q) => t + num(q.total), 0), currency)})`);
    if (overdue) parts.push(`${money(overdue.amount, currency)} overdue on ${overdue.invoices} invoice${overdue.invoices === 1 ? '' : 's'}`);
    if (issues.length) parts.push(`reported a delivery issue on ${issues[0].so_number}`);

    const records = [
      { type: 'customer', id: c.id, number: c.code || c.name },
      m.cad?.last_order_id ? { type: 'sales_order', id: m.cad.last_order_id, number: m.cad.last_order_number } : null,
      ...lost.slice(0, 2).map((q) => ({ type: 'sales_quotation', id: q.id, number: q.quotation_number })),
      ...open.slice(0, 2).map((q) => ({ type: 'sales_quotation', id: q.id, number: q.quotation_number })),
    ].filter(Boolean);

    const proposals = [];
    if (m.delta < 0) {
      const why = m.kind === 'lapsed'
        ? `no order in ${m.sinceLast} days${m.usualGap != null ? ` (usually every ${Math.round(m.usualGap)})` : ''}`
        : `orders ${round(Math.abs(m.delta / (m.expected || 1)) * 100, 0)}% below their usual pace`;
      proposals.push({
        kind: 'follow_up',
        label: `${owner ? `${owner.name}` : 'Their account owner'} calls ${c.name}: ${why}`,
        tool: 'prepare_revenue_follow_ups',
        args: { customer_id: c.id },
        owner,
      });
      if (info.credit_hold) proposals.push({ kind: 'credit_review', label: `Finance reviews the credit hold on ${c.name}`, where: `/sales/customers/${c.id}` });
    }

    return {
      kind: m.kind,
      customer: { id: c.id, name: c.name, code: c.code },
      name: c.name,
      detail: parts.join('; '),
      money: round(m.delta),
      sales_now: round(c.cur),
      sales_at_pace: round(m.expected),
      change_pct: m.expected > 0 ? round((m.delta / m.expected) * 100, 1) : null,
      split: { volume: round(m.vol), price: round(m.price) },
      evidence: {
        last_order: m.lastOrder ? { date: m.lastOrder, id: m.cad?.last_order_id, number: m.cad?.last_order_number } : null,
        days_since_last_order: m.sinceLast,
        usual_days_between_orders: m.usualGap != null ? round(m.usualGap, 0) : null,
        products: m.effects
          .sort((a, b) => Math.abs(b.volume + b.price) - Math.abs(a.volume + a.price))
          .slice(0, 5)
          .map((e) => ({ product: e.product, name: e.name, volume: round(e.volume), price: round(e.price), dropped: !!e.dropped, added: !!e.added })),
        credit_hold: info.credit_hold ? { since: iso(info.credit_hold_set_at), reason: info.credit_hold_reason || null } : null,
        quotations_lost: lost.map((q) => ({ id: q.id, number: q.quotation_number, total: round(num(q.total)), state: q.state, reason: q.rejection_reason || q.customer_response_notes || null })),
        quotations_open: open.map((q) => ({ id: q.id, number: q.quotation_number, total: round(num(q.total)), status: q.status, valid_until: iso(q.valid_until) })),
        overdue: overdue ? { amount: round(overdue.amount), invoices: overdue.invoices, oldest_due: iso(overdue.oldest_due) } : null,
        delivery_issues: issues.map((i) => ({ id: i.id, number: i.so_number, reported_at: iso(i.reported_at), notes: i.notes || null })),
      },
      owner,
      records,
      proposals,
    };
  }

  const falling = movers.filter((m) => m.delta < -0.005).sort((a, b) => a.delta - b.delta);
  const rising = movers.filter((m) => m.delta > 0.005).sort((a, b) => b.delta - a.delta);
  const drivers = falling.slice(0, limit).map(driver);
  const helping = rising.slice(0, Math.min(limit, 3)).map(driver);
  const drop = falling.reduce((t, m) => t + m.delta, 0);
  // Shares are of what fell: customers growing elsewhere offset the net, not the drop a person has to explain.
  for (const d of drivers) d.share_pct = drop < 0 ? round((d.money / drop) * 100, 0) : null;
  const explained = drivers.reduce((t, d) => t + d.money, 0);
  const explainedShare = drop < 0 ? round(Math.min(100, (explained / drop) * 100), 0) : null;

  let headline;
  if (!sales.length) {
    headline = whole ? 'No sales orders in this period or the baseline, so there is nothing to explain.' : 'No sales orders in your book in this period or the baseline.';
  } else if (total.pace <= 0) {
    headline = `${money(total.now, currency)} booked; there is nothing in the baseline to compare it with.`;
  } else if (total.change_pct < -0.5) {
    const n = drivers.length;
    headline = `Sales are down ${round(-total.change_pct, 1)}% to ${money(total.now, currency)} against the usual pace of ${money(total.pace, currency)}.`
      + (n ? ` ${n === 1 ? 'One customer accounts' : `${WORDS[n] || n} customers account`} for ${explainedShare}% of what fell${helping.length ? `; ${money(rising.reduce((t, m) => t + m.delta, 0), currency)} came back from customers buying more` : ''}.` : '');
  } else if (total.change_pct > 0.5) {
    headline = `Sales are up ${round(total.change_pct, 1)}% to ${money(total.now, currency)} against the usual pace of ${money(total.pace, currency)}.`
      + (drivers.length ? ` ${drivers.length === 1 ? 'One customer is' : `${WORDS[drivers.length] || drivers.length} customers are`} buying less than usual.` : '');
  } else {
    headline = `Sales are on their usual pace at ${money(total.now, currency)}.`
      + (drivers.length ? ` ${drivers.length === 1 ? 'One customer is' : `${WORDS[drivers.length] || drivers.length} customers are`} buying less than usual.` : '');
  }

  return {
    headline,
    scope: whole ? 'company' : 'your book: orders you entered and customers you represent',
    period: cur,
    baseline: base,
    pace_factor: round(pace, 4),
    currency,
    sales: { now: round(total.now), at_pace: round(total.pace), change: round(total.change), change_pct: round(total.change_pct, 1) },
    bridge: {
      no_order_now: round(bridge.no_order_now),
      new_customers: round(bridge.new_customers),
      volume: round(bridge.volume),
      price: round(bridge.price),
    },
    drivers,
    helping,
    explained_share_pct: explainedShare,
    falling_total: round(drop),
    coverage: {
      customers: customers.size,
      customers_falling: falling.length,
      customers_rising: rising.length,
      order_lines_read: sales.length,
      quotations_read: ctx.quotes.length,
    },
    method: 'Sales are the net value of sales-order lines booked (orders that never became a sale excluded). The baseline is '
      + 'scaled to the period\'s length (baseline × days now ÷ days in baseline), so each customer\'s change is sales now minus '
      + 'their usual pace, and the customer changes add up to the total. Within a customer: volume = (units now − units at pace) '
      + '× baseline net price, plus products dropped or added; price = (net price now − baseline net price) × units now. A customer '
      + 'is lapsed when they bought in the baseline, nothing now, and the days since their last order are past 1.5× their usual gap.',
    proposals_note: 'Proposals are suggestions. Putting a call on an owner\'s follow-up list is a separate step a person confirms; nothing here changed anything.',
  };
}

/* ------------------------------------------------- follow-ups for owners */

/**
 * Put a follow-up call on each owner's CRM list for the customers the analysis
 * names now (or only the customers asked for). Runs the analysis again rather
 * than trusting what a client sends; reuses an open Simeli follow-up for the
 * same customer rather than making a second.
 */
async function prepareRevenueFollowUps(opts = {}) {
  const companyId = await resolveCompany(opts.companyId);
  const only = Array.isArray(opts.customerIds) && opts.customerIds.length ? new Set(opts.customerIds.map(String)) : null;
  const analysis = await explainRevenue({ ...opts, companyId, limit: opts.limit || (only ? 20 : 5) });
  if (analysis.error) return analysis;

  const creator = opts.userId && UUID.test(String(opts.userId)) ? opts.userId : null;
  const due = iso(Date.now() + 2 * DAY);
  const prepared = [];
  for (const d of analysis.drivers) {
    if (only && !only.has(d.customer.id)) continue;
    const p = d.proposals.find((x) => x.kind === 'follow_up');
    if (!p) continue;
    const { rows: open } = await pool.query(
      `SELECT a.id, a.subject, a.due_date, a.owner_id FROM activities a
        WHERE a.company_id = $1 AND a.customer_id = $2 AND a.completed_at IS NULL
          AND a.notes LIKE 'Simeli · sales analysis%'
        ORDER BY a.created_at DESC LIMIT 1`,
      [companyId, d.customer.id],
    );
    if (open.length) {
      prepared.push({ customer: d.name, customer_id: d.customer.id, id: open[0].id, reference: open[0].subject, due_date: iso(open[0].due_date), owner: d.owner?.name || null, state: 'OPEN', already: true, open_at: '/crm/activities' });
      continue;
    }
    const ownerId = d.owner?.id || creator;
    const subject = `Call ${d.name}: ${d.kind === 'lapsed' ? `no order in ${d.evidence.days_since_last_order} days` : `orders ${Math.round(Math.abs(d.change_pct || 0))}% below usual`}`.slice(0, 250);
    const notes = [
      `Simeli · sales analysis ${analysis.period.from} – ${analysis.period.to} against ${analysis.baseline.from} – ${analysis.baseline.to}.`,
      `${d.name}: ${money(d.sales_now, analysis.currency)} booked against ${money(d.sales_at_pace, analysis.currency)} at their usual pace (${money(d.money, analysis.currency)} ${d.money < 0 ? 'short' : 'ahead'}).`,
      d.detail,
      d.evidence.quotations_open.length ? `Open quotations: ${d.evidence.quotations_open.map((q) => q.number).join(', ')}.` : null,
      'Ask what changed for them and what would bring the orders back. Record what you hear here.',
    ].filter(Boolean).join('\n');
    const { rows } = await pool.query(
      `INSERT INTO activities (company_id, activity_type, subject, notes, due_date, customer_id, owner_id, created_by)
       VALUES ($1, 'CALL', $2, $3, $4, $5, $6, $7) RETURNING id`,
      [companyId, subject, notes, due, d.customer.id, ownerId, creator],
    );
    prepared.push({ customer: d.name, customer_id: d.customer.id, id: rows[0].id, reference: subject, due_date: due, owner: d.owner?.name || 'you', owner_source: d.owner?.source || null, state: 'OPEN', open_at: '/crm/activities' });
  }
  const fresh = prepared.filter((r) => !r.already);
  return {
    headline: analysis.headline,
    prepared,
    summary: prepared.length
      ? `${fresh.length} call${fresh.length === 1 ? '' : 's'} put on ${fresh.length === 1 ? 'its owner\'s' : 'their owners\''} follow-up list${prepared.length > fresh.length ? `, ${prepared.length - fresh.length} already waiting` : ''}. Each owner makes the call and records what they hear; nothing was sent to a customer.`
      : 'No customer is below their usual pace, so there is no call to prepare.',
  };
}

module.exports = { explainRevenue, prepareRevenueFollowUps, SEES_ALL };
