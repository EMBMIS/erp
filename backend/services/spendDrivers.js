/**
 * "Why are our costs up?" — answered from the company's own purchase orders,
 * bills, contracts and ledger, supplier by supplier, not from two totals and a
 * chart.
 *
 * WHAT THIS ANSWERS
 * ---------------------------------------------------------------------------
 * The Procurement screen shows "Committed spend by month" as a line, and the
 * ledger can say which expense account moved. Neither says why. The reason is
 * always something a person did or can change: a supplier put its price up
 * (and may now be above the contract), someone ordered more of an item than
 * usual (for a customer order, or for no order at all), bills were booked
 * without a purchase order, a new supplier appeared. This reads the records
 * underneath the number and splits the move into suppliers a person can act on:
 *
 *   • Price      the same item from the same supplier at a higher net price —
 *                (price now − price before) × units now; flagged when above a
 *                contract price in force.
 *   • Volume     more (or fewer) units than the usual pace, items added or
 *                dropped; tied to the customer orders it was bought for when
 *                the purchase order says so.
 *   • Off-PO     bills booked with no purchase order behind them: spend nobody
 *                approved as an order.
 *   • New        suppliers with nothing in the baseline.
 *
 * Each supplier comes with who raised the orders, who approved them, who asked
 * for them (requisitions), and which customer orders they serve.
 *
 * HOW THE NUMBERS ADD UP
 * ---------------------------------------------------------------------------
 * Spend is what the business committed to suppliers: purchase-order lines
 * (quantity × unit price, before tax) by order date, plus bills with no
 * purchase order (subtotal) by invoice date — never both for the same money.
 * The baseline (default: the three full months before) is put on the period's
 * pace, so every supplier's change is spend now minus their usual pace, and
 * the suppliers add up to the total. For finance roles the ledger lens is
 * added: expense accounts posted now against the same pace, with the kind of
 * posting behind each (payroll, depreciation, manual journals...).
 *
 * WHO SEES WHAT
 * ---------------------------------------------------------------------------
 * Admins, managers and finance see the company. Everyone else sees their own
 * spend: purchase orders they raised, requisitions they asked for, bills they
 * booked; the ledger lens is left out for them. Every query is company-scoped
 * and runs under RLS.
 *
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It changes nothing. Each supplier costing more comes with proposals: a DRAFT
 * re-quote to the other suppliers of an item whose price went up, the contract
 * to hold them to, and a question to the person who raised the orders or
 * booked the bills. prepareSpendFollowUps drafts those only when a person asks
 * for it; procurement sends an RFQ, and nothing reaches a supplier.
 */

const { pool } = require('../config/database');
const companyContext = require('./companyContext');
const { hasPermission } = require('../middleware/rbac');

const SEES_ALL = new Set(['ADMIN', 'MANAGER', 'FINANCE_MANAGER', 'FINANCE_USER']);
const NOT_BOUGHT = ['DRAFT', 'CANCELLED', 'REJECTED'];
const NOT_BILLED = ['DRAFT', 'CANCELLED'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86400000;

const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const num = (v) => (v == null ? 0 : Number(v));
const round = (v, p = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** p) / 10 ** p);
const days = (from, to) => Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / DAY) + 1;
const money = (v, cur) => `${cur ? `${cur} ` : ''}${Math.round(Math.abs(v)).toLocaleString('en-US')}`;
const signed = (v, cur) => `${v < 0 ? '−' : '+'}${money(v, cur)}`;
const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];
const nameOf = (r, p = '') => [r[`${p}first_name`], r[`${p}last_name`]].filter(Boolean).join(' ') || r[`${p}email`] || null;

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

/** Purchase-order lines per supplier, item and window — what was committed. */
async function readCommitted(companyId, cur, base, scopeUser, supplierFilter) {
  const { rows } = await pool.query(
    `SELECT CASE WHEN po.po_date BETWEEN $2 AND $3 THEN 'cur' ELSE 'base' END AS w,
            po.supplier_id,
            MAX(COALESCE(s.trade_name, s.legal_name)) AS supplier_name,
            COALESCE(pol.item_id::text, 'desc:' || LOWER(TRIM(pol.item_description))) AS key,
            pol.item_id,
            MAX(i.item_code) AS item_code,
            MAX(COALESCE(i.name, pol.item_description)) AS item_name,
            MAX(po.currency) AS currency,
            SUM(pol.quantity)::float8 AS qty,
            SUM(pol.quantity * pol.unit_price)::float8 AS net,
            COUNT(DISTINCT po.id)::int AS orders
       FROM purchase_order_line_items pol
       JOIN purchase_orders po ON po.id = pol.po_id
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN items i ON i.id = pol.item_id
       LEFT JOIN purchase_requisitions pr ON pr.id = po.purchase_requisition_id
      WHERE po.company_id = $1 AND po.status <> ALL($6::text[])
        AND (po.po_date BETWEEN $2 AND $3 OR po.po_date BETWEEN $4 AND $5)
        AND pol.quantity > 0
        AND ($7::uuid IS NULL OR po.created_by = $7::uuid OR pr.requested_by = $7::uuid)
        AND ($8::text IS NULL OR s.trade_name ILIKE $8 OR s.legal_name ILIKE $8 OR s.supplier_code ILIKE $8)
      GROUP BY 1, 2, 4, 5`,
    [companyId, cur.from, cur.to, base.from, base.to, NOT_BOUGHT, scopeUser, supplierFilter ? `%${supplierFilter}%` : null],
  );
  return rows.map((r) => ({ ...r, qty: num(r.qty), net: num(r.net) }));
}

/** Bills with no purchase order behind them, per supplier and window, with the bills themselves. */
async function readOffPo(companyId, cur, base, scopeUser, supplierFilter) {
  const { rows } = await pool.query(
    `SELECT CASE WHEN si.invoice_date BETWEEN $2 AND $3 THEN 'cur' ELSE 'base' END AS w,
            si.id, si.bill_number, si.supplier_invoice_number, si.invoice_date, si.supplier_id,
            COALESCE(s.trade_name, s.legal_name) AS supplier_name, si.currency,
            si.subtotal::float8 AS net, si.description, si.status,
            si.created_by, u.first_name, u.last_name, u.email, u.is_active
       FROM supplier_invoices si
       LEFT JOIN suppliers s ON s.id = si.supplier_id
       LEFT JOIN users u ON u.id = si.created_by
      WHERE si.company_id = $1 AND si.deleted_at IS NULL AND si.purchase_order_id IS NULL
        AND si.status <> ALL($6::text[])
        AND (si.invoice_date BETWEEN $2 AND $3 OR si.invoice_date BETWEEN $4 AND $5)
        AND ($7::uuid IS NULL OR si.created_by = $7::uuid)
        AND ($8::text IS NULL OR s.trade_name ILIKE $8 OR s.legal_name ILIKE $8 OR s.supplier_code ILIKE $8)
      ORDER BY si.subtotal DESC`,
    [companyId, cur.from, cur.to, base.from, base.to, NOT_BILLED, scopeUser, supplierFilter ? `%${supplierFilter}%` : null],
  );
  return rows.map((r) => ({ ...r, net: num(r.net) }));
}

/** The purchase orders of the period for these suppliers: who raised, approved and asked for them, and what they were for. */
async function readOrders(companyId, supplierIds, cur, scopeUser) {
  if (!supplierIds.length) return [];
  const { rows } = await pool.query(
    `SELECT po.id, po.po_number, po.po_date, po.status, po.supplier_id, po.subtotal::float8 AS value,
            po.created_by, cu.first_name AS c_first_name, cu.last_name AS c_last_name, cu.email AS c_email, cu.is_active AS c_active,
            po.approved_by, au.first_name AS a_first_name, au.last_name AS a_last_name, au.email AS a_email,
            pr.id AS pr_id, pr.pr_number, pr.cost_center,
            pr.requested_by, ru.first_name AS r_first_name, ru.last_name AS r_last_name, ru.email AS r_email,
            so.id AS so_id, so.so_number
       FROM purchase_orders po
       LEFT JOIN users cu ON cu.id = po.created_by
       LEFT JOIN users au ON au.id = po.approved_by
       LEFT JOIN purchase_requisitions pr ON pr.id = po.purchase_requisition_id
       LEFT JOIN users ru ON ru.id = pr.requested_by
       LEFT JOIN sales_orders so ON so.id = po.sales_order_id
      WHERE po.company_id = $1 AND po.supplier_id = ANY($2::uuid[]) AND po.status <> ALL($5::text[])
        AND po.po_date BETWEEN $3 AND $4
        AND ($6::uuid IS NULL OR po.created_by = $6::uuid OR pr.requested_by = $6::uuid)
      ORDER BY po.subtotal DESC NULLS LAST`,
    [companyId, supplierIds, cur.from, cur.to, NOT_BOUGHT, scopeUser],
  );
  return rows;
}

/** Each supplier's first purchase order or bill ever — whether they are new. */
async function readFirstActivity(companyId, supplierIds) {
  if (!supplierIds.length) return [];
  const { rows } = await pool.query(
    `SELECT supplier_id, MIN(d) AS first_at FROM (
       SELECT supplier_id, po_date AS d FROM purchase_orders
        WHERE company_id = $1 AND supplier_id = ANY($2::uuid[]) AND status <> ALL($3::text[])
       UNION ALL
       SELECT supplier_id, invoice_date FROM supplier_invoices
        WHERE company_id = $1 AND supplier_id = ANY($2::uuid[]) AND deleted_at IS NULL AND status <> ALL($4::text[])
     ) x GROUP BY supplier_id`,
    [companyId, supplierIds, NOT_BOUGHT, NOT_BILLED],
  );
  return rows;
}

/** Contract prices in force at the end of the period, per item and supplier. */
async function readContractPrices(companyId, itemIds, onDate) {
  if (!itemIds.length) return [];
  const { rows } = await pool.query(
    `SELECT ci.item_id, c.supplier_id, c.id AS contract_id, c.contract_number, MIN(ci.unit_price)::float8 AS unit_price
       FROM contract_items ci
       JOIN contracts c ON c.id = ci.contract_id
      WHERE c.company_id = $1 AND ci.item_id = ANY($2::uuid[]) AND ci.unit_price > 0
        AND UPPER(c.status) IN ('ACTIVE', 'APPROVED', 'SIGNED')
        AND (c.start_date IS NULL OR c.start_date <= $3) AND (c.end_date IS NULL OR c.end_date >= $3)
      GROUP BY 1, 2, 3, 4`,
    [companyId, itemIds, onDate],
  );
  return rows;
}

/** Other suppliers who can supply an item: in the supplier catalogue, or bought from before. */
async function readAlternatives(companyId, itemIds) {
  if (!itemIds.length) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (x.item_id, x.supplier_id) x.item_id, x.supplier_id,
            COALESCE(s.trade_name, s.legal_name) AS supplier_name, x.unit_price, x.source
       FROM (
         SELECT ii.item_master_id AS item_id, si.supplier_id, si.unit_price::float8 AS unit_price, 'catalogue' AS source, 0 AS rank
           FROM supplier_items si JOIN inventory_items ii ON ii.id = si.item_id
          WHERE si.company_id = $1 AND ii.item_master_id = ANY($2::uuid[])
            AND COALESCE(UPPER(si.status), 'ACTIVE') NOT IN ('INACTIVE', 'REJECTED', 'DECLINED')
         UNION ALL
         SELECT pol.item_id, po.supplier_id, pol.unit_price::float8, 'purchase history', 1
           FROM purchase_order_line_items pol JOIN purchase_orders po ON po.id = pol.po_id
          WHERE po.company_id = $1 AND pol.item_id = ANY($2::uuid[]) AND po.supplier_id IS NOT NULL
            AND po.status <> ALL($3::text[])
       ) x
       JOIN suppliers s ON s.id = x.supplier_id
      WHERE COALESCE(UPPER(s.status), 'ACTIVE') NOT IN ('INACTIVE', 'BLOCKED', 'REJECTED', 'DECLINED', 'SUSPENDED')
      ORDER BY x.item_id, x.supplier_id, x.rank`,
    [companyId, itemIds, NOT_BOUGHT],
  );
  return rows;
}

/** Expense accounts posted in each window, by the kind of posting behind them. */
async function readLedgerCosts(companyId, cur, base) {
  const { rows } = await pool.query(
    `SELECT CASE WHEN je.entry_date BETWEEN $2 AND $3 THEN 'cur' ELSE 'base' END AS w,
            coa.id AS account_id, coa.account_code, coa.account_name, je.source_type,
            SUM(COALESCE(jei.debit_amount, 0) - COALESCE(jei.credit_amount, 0))::float8 AS amount,
            COUNT(DISTINCT je.id)::int AS entries,
            COUNT(DISTINCT (je.period_year, je.period_month))::int AS months,
            (ARRAY_AGG(je.id ORDER BY COALESCE(jei.debit_amount, 0) DESC))[1] AS largest_entry_id,
            (ARRAY_AGG(je.journal_number ORDER BY COALESCE(jei.debit_amount, 0) DESC))[1] AS largest_entry_number
       FROM journal_entry_items jei
       JOIN journal_entries je ON je.id = jei.journal_entry_id
       JOIN chart_of_accounts coa ON coa.id = jei.account_id
      WHERE je.company_id = $1 AND je.status = 'POSTED' AND je.deleted_at IS NULL
        AND coa.account_type = 'EXPENSE'
        AND (je.entry_date BETWEEN $2 AND $3 OR je.entry_date BETWEEN $4 AND $5)
      GROUP BY 1, 2, 3, 4, 5`,
    [companyId, cur.from, cur.to, base.from, base.to],
  );
  return rows.map((r) => ({ ...r, amount: num(r.amount) }));
}

/* ---------------------------------------------------------------- compute */

const SOURCE_LABEL = {
  PAYROLL: 'payroll', DEPRECIATION: 'depreciation', MANUAL: 'manual journals', PURCHASE_ORDER: 'supplier bills',
  GOODS_ISSUE: 'stock issued', GOODS_RECEIPT: 'goods received', BANK_TRANSACTION: 'bank transactions',
  INVENTORY_ADJUSTMENT: 'stock adjustments', LANDED_COST: 'landed costs', SALES_ORDER: 'cost of what was sold',
  FX_REVALUATION: 'currency revaluation', AI_CONTINUOUS_CLOSE: 'close accruals', FIXED_ASSET: 'fixed assets',
};

// Posted once a month: compared run for run (the usual monthly amount × the months posted now), not on a daily pace —
// otherwise payroll looks 90% up the day it posts and 100% down the day before.
const MONTHLY = new Set(['PAYROLL', 'DEPRECIATION', 'AI_CONTINUOUS_CLOSE', 'REVENUE_SCHEDULE', 'FX_REVALUATION']);

function ledgerLens(rows, pace, currency) {
  const accounts = new Map();
  for (const r of rows) {
    const a = accounts.get(r.account_id) || { id: r.account_id, code: r.account_code, name: r.account_name, cur: 0, base: 0, expected: 0, sources: new Map(), largest: null };
    a[r.w] += r.amount;
    const s = a.sources.get(r.source_type) || { cur: 0, base: 0, entries: 0, months_cur: 0, months_base: 0 };
    s[r.w] += r.amount;
    s[`months_${r.w}`] += r.months;
    if (r.w === 'cur') s.entries += r.entries;
    a.sources.set(r.source_type, s);
    if (r.w === 'cur' && r.largest_entry_id && (!a.largest || r.amount > a.largest.amount)) {
      a.largest = { id: r.largest_entry_id, number: r.largest_entry_number, amount: r.amount };
    }
    accounts.set(r.account_id, a);
  }
  const expectedOf = (type, s) => (MONTHLY.has(type)
    ? (s.months_base > 0 ? (s.base / s.months_base) * s.months_cur : 0)
    : s.base * pace);
  const list = [...accounts.values()].map((a) => {
    const expected = [...a.sources.entries()].reduce((t, [type, s]) => t + expectedOf(type, s), 0);
    const delta = a.cur - expected;
    const sources = [...a.sources.entries()]
      .map(([type, s]) => ({ type, label: SOURCE_LABEL[type] || String(type || 'other').toLowerCase().replace(/_/g, ' '), change: s.cur - expectedOf(type, s), now: s.cur, entries: s.entries, monthly: MONTHLY.has(type) }))
      .filter((s) => Math.abs(s.change) > 0.005)
      .sort((x, y) => Math.abs(y.change) - Math.abs(x.change));
    return { a, expected, delta, sources };
  });
  const now = list.reduce((t, x) => t + x.a.cur, 0);
  const atPace = list.reduce((t, x) => t + x.expected, 0);
  const movers = list.filter((x) => Math.abs(x.delta) > 0.005).sort((x, y) => y.delta - x.delta);
  return {
    costs_now: round(now),
    costs_at_pace: round(atPace),
    change: round(now - atPace),
    change_pct: atPace > 0 ? round(((now - atPace) / atPace) * 100, 1) : null,
    accounts_up: movers.filter((x) => x.delta > 0).slice(0, 5).map((x) => ({
      account: { id: x.a.id, code: x.a.code, name: x.a.name },
      now: round(x.a.cur),
      at_pace: round(x.expected),
      change: round(x.delta),
      detail: `${x.a.code} ${x.a.name}: ${money(x.a.cur, currency)} against ${money(x.expected, currency)} at pace (${signed(x.delta, currency)})`
        + (x.sources.length ? ` — mostly ${x.sources.slice(0, 2).map((s) => `${s.label} ${signed(s.change, currency)}`).join(', ')}` : ''),
      sources: x.sources.slice(0, 3).map((s) => ({ type: s.type, label: s.label, change: round(s.change), entries: s.entries })),
      largest_entry: x.a.largest ? { id: x.a.largest.id, number: x.a.largest.number } : null,
    })),
    accounts_down: movers.filter((x) => x.delta < 0).reverse().slice(0, 3).map((x) => ({
      account: { id: x.a.id, code: x.a.code, name: x.a.name }, now: round(x.a.cur), at_pace: round(x.expected), change: round(x.delta),
    })),
  };
}

/** Most frequent person in a list of { id, name }. */
function usual(people) {
  const t = new Map();
  for (const p of people) if (p?.id) t.set(p.id, { ...p, n: (t.get(p.id)?.n || 0) + 1 });
  return [...t.values()].sort((a, b) => b.n - a.n)[0] || null;
}

/**
 * @param {object} opts
 *   companyId, userId, role       who is asking
 *   from, to                      the period to explain (default: this month to date)
 *   baselineFrom, baselineTo      what to compare it with (default: the three full months before)
 *   supplier                      only suppliers whose name or code contains this
 *   limit                         how many suppliers to return per side (default 5)
 */
async function explainSpend(opts = {}) {
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

  const [committed, offPo, ledgerRows] = await Promise.all([
    readCommitted(companyId, cur, base, scopeUser, opts.supplier || null),
    readOffPo(companyId, cur, base, scopeUser, opts.supplier || null),
    whole && !opts.supplier ? readLedgerCosts(companyId, cur, base) : Promise.resolve(null),
  ]);

  const currency = (() => {
    const t = new Map();
    for (const r of [...committed, ...offPo]) t.set(r.currency || 'USD', (t.get(r.currency || 'USD') || 0) + Math.abs(r.net));
    return [...t.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'USD';
  })();

  // Supplier → item → window, plus the bills with no order behind them.
  const suppliers = new Map();
  const sup = (id, name) => {
    if (!suppliers.has(id)) suppliers.set(id, { id, name, items: new Map(), cur: 0, base: 0, po_cur: 0, po_base: 0, off_cur: 0, off_base: 0, off_bills: [], off_bookers: [] });
    return suppliers.get(id);
  };
  for (const r of committed) {
    const s = sup(r.supplier_id, r.supplier_name);
    const it = s.items.get(r.key) || { key: r.key, item_id: r.item_id, code: r.item_code, name: r.item_name };
    it[r.w] = { qty: r.qty, net: r.net };
    s.items.set(r.key, it);
    s[r.w] += r.net;
    s[`po_${r.w}`] += r.net;
  }
  for (const r of offPo) {
    const s = sup(r.supplier_id, r.supplier_name);
    s[r.w] += r.net;
    s[`off_${r.w}`] += r.net;
    if (r.w === 'cur') {
      s.off_bills.push(r);
      if (r.created_by && r.is_active !== false) s.off_bookers.push({ id: r.created_by, name: nameOf(r) });
    }
  }

  const ids = [...suppliers.keys()].filter(Boolean);
  const itemIds = [...new Set(committed.filter((r) => r.item_id).map((r) => r.item_id))];
  const [orders, firsts, contracts, alternatives] = await Promise.all([
    readOrders(companyId, ids, cur, scopeUser),
    readFirstActivity(companyId, ids),
    readContractPrices(companyId, itemIds, cur.to),
    readAlternatives(companyId, itemIds),
  ]);
  const ordersBy = orders.reduce((m, o) => m.set(o.supplier_id, [...(m.get(o.supplier_id) || []), o]), new Map());
  const firstBy = new Map(firsts.map((r) => [r.supplier_id, iso(r.first_at)]));

  const bridge = { price: 0, volume: 0, off_po: 0, new_suppliers: 0, stopped: 0 };
  const movers = [];
  for (const s of suppliers.values()) {
    const expected = s.base * pace;
    const delta = s.cur - expected;
    const first = firstBy.get(s.id);
    const kind = s.base <= 0 && s.cur > 0 ? 'new' : s.cur <= 0 && s.base > 0 ? 'stopped' : delta >= 0 ? 'up' : 'down';

    const effects = [];
    let vol = 0; let price = 0;
    for (const it of s.items.values()) {
      const b = it.base; const n = it.cur;
      if (b && b.qty > 0 && n && n.qty > 0) {
        const bp = b.net / b.qty; const np = n.net / n.qty;
        const v = (n.qty - b.qty * pace) * bp;
        const pr = (np - bp) * n.qty;
        vol += v; price += pr;
        effects.push({ it, volume: v, price: pr, qty_now: n.qty, qty_pace: b.qty * pace, price_now: np, price_before: bp });
      } else if (b) {
        vol -= b.net * pace;
        effects.push({ it, volume: -b.net * pace, price: 0, dropped: true, qty_pace: b.qty * pace });
      } else if (n) {
        vol += n.net;
        effects.push({ it, volume: n.net, price: 0, added: true, qty_now: n.qty, price_now: n.net / n.qty });
      }
    }
    const offDelta = s.off_cur - s.off_base * pace;
    if (kind === 'new') bridge.new_suppliers += delta;
    else if (kind === 'stopped') bridge.stopped += delta;
    else { bridge.volume += vol; bridge.price += price; bridge.off_po += offDelta; }

    movers.push({ s, expected, delta, vol, price, offDelta, effects, kind, first });
  }

  const total = { now: movers.reduce((t, m) => t + m.s.cur, 0), pace: movers.reduce((t, m) => t + m.expected, 0) };
  total.change = total.now - total.pace;
  total.change_pct = total.pace > 0 ? (total.change / total.pace) * 100 : null;

  const altBy = (itemId, exclude) => alternatives.filter((a) => a.item_id === itemId && !exclude.has(a.supplier_id));
  const canDraftRfq = !role || hasPermission(role, 'PROCUREMENT_WRITE');

  /** One supplier as a driver: what moved, what the record says caused it, who owns it, and what to do. */
  function driver(m) {
    const { s } = m;
    const pos = ordersBy.get(s.id) || [];
    const raiser = usual(pos.map((o) => (o.created_by && o.c_active !== false ? { id: o.created_by, name: nameOf(o, 'c_') } : null)));
    const approver = usual(pos.map((o) => (o.approved_by ? { id: o.approved_by, name: nameOf(o, 'a_') } : null)));
    const requesters = [...new Map(pos.filter((o) => o.requested_by).map((o) => [o.requested_by, nameOf(o, 'r_')])).values()];
    const costCentres = [...new Set(pos.map((o) => o.cost_center).filter(Boolean))];
    const forOrders = [...new Map(pos.filter((o) => o.so_id).map((o) => [o.so_id, { id: o.so_id, number: o.so_number }])).values()];
    const booker = usual(s.off_bookers);
    const owner = raiser || booker || null;

    const rising = m.delta >= 0;
    const parts = [];
    if (m.kind === 'new') parts.push(`New supplier${m.first ? `, first order or bill ${m.first}` : ''}: ${money(s.cur, currency)} committed`);
    else if (m.kind === 'stopped') parts.push(`Nothing committed now against ${money(m.expected, currency)} at their usual pace`);
    else parts.push(`${money(s.cur, currency)} committed against ${money(m.expected, currency)} at their usual pace`);

    // Contract breaches on what was ordered now.
    const aboveContract = [];
    for (const e of m.effects) {
      if (!e.it.item_id || !(e.qty_now > 0)) continue;
      const c = contracts.find((x) => x.item_id === e.it.item_id && x.supplier_id === s.id);
      if (c && e.price_now > num(c.unit_price) * 1.005) {
        aboveContract.push({ e, contract: c, extra: (e.price_now - num(c.unit_price)) * e.qty_now });
      }
    }

    const top = m.effects
      .flatMap((e) => [
        Math.abs(e.volume) > 0.005 ? { e, what: 'volume', v: e.volume } : null,
        Math.abs(e.price) > 0.005 ? { e, what: 'price', v: e.price } : null,
      ].filter(Boolean))
      .filter((x) => (rising ? x.v > 0 : x.v < 0))
      .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
      .slice(0, 3);
    if (m.kind !== 'stopped') {
      for (const { e, what, v } of top) {
        const label = e.it.code || e.it.name;
        if (what === 'price') parts.push(`${label} price ${e.price_now >= e.price_before ? '+' : ''}${round(((e.price_now - e.price_before) / e.price_before) * 100, 1)}% (${round(e.price_before)} → ${round(e.price_now)}, ${signed(v, currency)})`);
        else if (e.dropped) parts.push(`stopped ordering ${label} (${signed(v, currency)})`);
        else if (e.added) parts.push(`started ordering ${label} (${signed(v, currency)})`);
        else parts.push(`${label} ${round(e.qty_now, 0)} units against ${round(e.qty_pace, 0)} at pace (${signed(v, currency)})`);
      }
    }
    for (const a of aboveContract.slice(0, 2)) {
      parts.push(`${a.e.it.code || a.e.it.name} at ${round(a.e.price_now)} is above the ${a.contract.contract_number} price of ${round(num(a.contract.unit_price))} (${money(a.extra, currency)} over contract)`);
    }
    if (s.off_cur > 0.005) {
      parts.push(`${money(s.off_cur, currency)} billed with no purchase order (${s.off_bills.slice(0, 3).map((b) => b.bill_number).join(', ')}${s.off_bills.length > 3 ? '…' : ''})${booker ? `, booked by ${booker.name}` : ''}`);
    }
    if (rising && m.vol > 0.005 && pos.length) {
      parts.push(forOrders.length ? `bought for customer orders ${forOrders.slice(0, 3).map((o) => o.number).join(', ')}` : 'no customer order behind these purchase orders');
    }
    if (raiser) parts.push(`orders raised by ${raiser.name}${approver ? `, approved by ${approver.name}` : ''}`);
    if (requesters.length) parts.push(`asked for by ${requesters.slice(0, 2).join(', ')}${costCentres.length ? ` (${costCentres.slice(0, 2).join(', ')})` : ''}`);

    const proposals = [];
    if (rising) {
      for (const { e, what, v } of top.filter((x) => x.what === 'price' && x.e.it.item_id)) {
        const pct = ((e.price_now - e.price_before) / e.price_before) * 100;
        if (pct < 1) continue;
        const alts = altBy(e.it.item_id, new Set([s.id]));
        proposals.push(alts.length ? {
          kind: 'rfq',
          label: `Re-quote ${e.it.code || e.it.name} (up ${round(pct, 1)}% at ${s.name}) with ${alts.length === 1 ? alts[0].supplier_name : `${Math.min(alts.length, 5)} other suppliers`}`,
          tool: 'create_rfq_draft',
          args: {
            item_id: e.it.item_id,
            quantity: round(e.qty_now, 3),
            supplier_ids: alts.slice(0, 5).map((a) => a.supplier_id),
            title: `Re-quote ${e.it.code || e.it.name} — price up ${round(pct, 1)}% at ${s.name}`,
          },
          owner: canDraftRfq ? null : 'Procurement',
          money: round(v),
          alternatives: alts.slice(0, 5).map((a) => ({ id: a.supplier_id, name: a.supplier_name, unit_price: round(num(a.unit_price), 4), source: a.source })),
        } : { kind: 'find_supplier', label: `Find a second source for ${e.it.code || e.it.name}: only ${s.name} has supplied it`, where: '/procurement/suppliers', money: round(v) });
      }
      for (const a of aboveContract.slice(0, 2)) {
        proposals.push({ kind: 'contract', label: `Hold ${s.name} to the ${a.contract.contract_number} price on ${a.e.it.code || a.e.it.name} (${money(a.extra, currency)} over contract)`, where: `/procurement/contracts/${a.contract.contract_id}`, money: round(a.extra) });
      }
      if (s.off_cur > 0.005) {
        proposals.push({
          kind: 'ask_owner',
          reason: 'off_po',
          label: `${booker ? booker.name : 'Whoever booked them'} explains ${money(s.off_cur, currency)} of ${s.name} bills with no purchase order, and raises one for what continues`,
          tool: 'prepare_spend_follow_ups',
          args: { supplier_ids: [s.id] },
          owner: booker,
          money: round(s.off_cur),
        });
      }
      if (m.vol > 0.005 && m.kind !== 'new' && pos.length && !forOrders.length && raiser) {
        proposals.push({
          kind: 'ask_owner',
          reason: 'volume',
          label: `${raiser.name} confirms what the extra ${money(m.vol, currency)} ordered from ${s.name} is for: no customer order is behind it`,
          tool: 'prepare_spend_follow_ups',
          args: { supplier_ids: [s.id] },
          owner: raiser,
          money: round(m.vol),
        });
      }
    }

    const records = [
      s.id ? { type: 'supplier', id: s.id, number: s.name } : null,
      ...pos.slice(0, 2).map((o) => ({ type: 'purchase_order', id: o.id, number: o.po_number })),
      ...s.off_bills.slice(0, 2).map((b) => ({ type: 'supplier_invoice', id: b.id, number: b.bill_number })),
      ...aboveContract.slice(0, 1).map((a) => ({ type: 'contract', id: a.contract.contract_id, number: a.contract.contract_number })),
      ...forOrders.slice(0, 2).map((o) => ({ type: 'sales_order', id: o.id, number: o.number })),
    ].filter(Boolean);

    return {
      kind: m.kind,
      supplier: { id: s.id, name: s.name },
      name: s.name,
      detail: parts.join('; '),
      money: round(m.delta),
      spend_now: round(s.cur),
      spend_at_pace: round(m.expected),
      change_pct: m.expected > 0 ? round((m.delta / m.expected) * 100, 1) : null,
      split: { volume: round(m.vol), price: round(m.price), off_po: round(m.offDelta) },
      evidence: {
        items: m.effects
          .sort((a, b) => Math.abs(b.volume + b.price) - Math.abs(a.volume + a.price))
          .slice(0, 5)
          .map((e) => ({
            item: e.it.code || e.it.name, item_id: e.it.item_id || null, volume: round(e.volume), price: round(e.price),
            unit_price_before: round(e.price_before, 4), unit_price_now: round(e.price_now, 4),
            qty_now: round(e.qty_now, 3), qty_at_pace: round(e.qty_pace, 3), dropped: !!e.dropped, added: !!e.added,
          })),
        above_contract: aboveContract.map((a) => ({ item: a.e.it.code || a.e.it.name, contract: a.contract.contract_number, contract_price: round(num(a.contract.unit_price), 4), price_now: round(a.e.price_now, 4), over_contract: round(a.extra) })),
        off_po_bills: s.off_bills.slice(0, 5).map((b) => ({ id: b.id, number: b.bill_number, supplier_reference: b.supplier_invoice_number, date: iso(b.invoice_date), amount: round(b.net), description: b.description || null })),
        purchase_orders: pos.slice(0, 5).map((o) => ({ id: o.id, number: o.po_number, date: iso(o.po_date), value: round(num(o.value)), status: o.status, requisition: o.pr_number || null, for_sales_order: o.so_number || null })),
        for_customer_orders: forOrders.slice(0, 5),
        raised_by: raiser ? { id: raiser.id, name: raiser.name } : null,
        approved_by: approver ? { id: approver.id, name: approver.name } : null,
        requested_by: requesters.slice(0, 3),
        cost_centres: costCentres.slice(0, 3),
        first_activity: m.first,
      },
      owner,
      records,
      proposals,
    };
  }

  const risingAll = movers.filter((m) => m.delta > 0.005).sort((a, b) => b.delta - a.delta);
  const fallingAll = movers.filter((m) => m.delta < -0.005).sort((a, b) => a.delta - b.delta);
  const drivers = risingAll.slice(0, limit).map(driver);
  const helping = fallingAll.slice(0, Math.min(limit, 3)).map(driver);
  const rise = risingAll.reduce((t, m) => t + m.delta, 0);
  for (const d of drivers) d.share_pct = rise > 0 ? round((d.money / rise) * 100, 0) : null;
  const explained = drivers.reduce((t, d) => t + d.money, 0);
  const explainedShare = rise > 0 ? round(Math.min(100, (explained / rise) * 100), 0) : null;

  const ledger = ledgerRows ? ledgerLens(ledgerRows, pace, currency) : null;

  let headline;
  const who = (n) => (n === 1 ? 'One supplier accounts' : `${WORDS[n] || n} suppliers account`);
  if (!committed.length && !offPo.length) {
    headline = whole ? 'No purchase orders or bills in this period or the baseline, so there is no spend to explain.' : 'No purchase orders or bills of yours in this period or the baseline.';
  } else if (total.pace <= 0) {
    headline = `${money(total.now, currency)} committed to suppliers; there is nothing in the baseline to compare it with.`;
  } else if (total.change_pct > 0.5) {
    const n = drivers.length;
    headline = `Spending is up ${round(total.change_pct, 1)}% to ${money(total.now, currency)} against the usual pace of ${money(total.pace, currency)}.`
      + (n ? ` ${who(n)} for ${explainedShare}% of the rise: ${drivers.slice(0, 3).map((d) => `${d.name} ${signed(d.money, currency)}`).join(', ')}.` : '');
  } else if (total.change_pct < -0.5) {
    headline = `Spending is down ${round(-total.change_pct, 1)}% to ${money(total.now, currency)} against the usual pace of ${money(total.pace, currency)}.`
      + (drivers.length ? ` ${drivers.length === 1 ? 'One supplier is' : `${WORDS[drivers.length] || drivers.length} suppliers are`} still costing more than usual.` : '');
  } else {
    headline = `Spending is on its usual pace at ${money(total.now, currency)}.`
      + (drivers.length ? ` ${drivers.length === 1 ? 'One supplier is' : `${WORDS[drivers.length] || drivers.length} suppliers are`} costing more than usual.` : '');
  }
  if (ledger && ledger.costs_at_pace > 0 && ledger.change_pct != null && Math.abs(ledger.change_pct) > 0.5) {
    const top = ledger.accounts_up[0];
    headline += ` In the ledger, costs are ${ledger.change_pct > 0 ? 'up' : 'down'} ${Math.abs(ledger.change_pct)}%`
      + (top ? (ledger.change > 0 ? `, most in ${top.account.name} (${signed(top.change, currency)})` : `, though ${top.account.name} is up ${signed(top.change, currency)}`) : '') + '.';
  }

  return {
    headline,
    scope: whole ? 'company' : 'your spend: purchase orders you raised or asked for, bills you booked',
    period: cur,
    baseline: base,
    pace_factor: round(pace, 4),
    currency,
    spend: { now: round(total.now), at_pace: round(total.pace), change: round(total.change), change_pct: round(total.change_pct, 1) },
    bridge: {
      price: round(bridge.price),
      volume: round(bridge.volume),
      off_po: round(bridge.off_po),
      new_suppliers: round(bridge.new_suppliers),
      stopped: round(bridge.stopped),
    },
    drivers,
    helping,
    explained_share_pct: explainedShare,
    rising_total: round(rise),
    ledger,
    coverage: {
      suppliers: suppliers.size,
      suppliers_rising: risingAll.length,
      suppliers_falling: fallingAll.length,
      order_lines_read: committed.length,
      bills_without_order_read: offPo.length,
      contracts_checked: contracts.length,
    },
    method: 'Spend is what was committed to suppliers: purchase-order lines (quantity × unit price, before tax) by order date, '
      + 'plus bills with no purchase order (subtotal) by invoice date. The baseline is scaled to the period\'s length '
      + '(baseline × days now ÷ days in baseline), so each supplier\'s change is spend now minus their usual pace, and the '
      + 'supplier changes add up to the total. Within a supplier: price = (unit price now − baseline unit price) × units now; '
      + 'volume = (units now − units at pace) × baseline unit price, plus items added or dropped; off-PO = bills without an '
      + 'order now minus their pace. Contract prices are those in force at the end of the period. The ledger lens is posted '
      + 'expense accounts on the same pace, by the kind of posting behind them; postings made once a month (payroll, depreciation, '
      + 'accruals) are compared run for run — the usual monthly amount times the months posted now.',
    proposals_note: 'Proposals are suggestions. Drafting a re-quote or asking an owner is a separate step a person confirms; nothing here changed anything.',
  };
}

/* ------------------------------------------------- follow-ups for owners */

async function draftRequote(companyId, userId, args) {
  const { rows: open } = await pool.query(
    `SELECT r.id, r.rfq_number FROM request_for_quotations r
       JOIN rfq_line_items l ON l.rfq_id = r.id
      WHERE r.company_id = $1 AND r.status = 'DRAFT' AND l.item_id = $2
        AND r.description LIKE 'Drafted by Simeli%'
      ORDER BY r.created_at DESC LIMIT 1`,
    [companyId, args.item_id],
  );
  if (open.length) return { id: open[0].id, reference: open[0].rfq_number, already: true, open_at: `/procurement/rfqs/${open[0].id}` };
  const { rows: items } = await pool.query('SELECT id, item_code, name, unit_of_measure FROM items WHERE id = $1', [args.item_id]);
  if (!items.length) return { error: 'The item is no longer in this company.' };
  const { rows: sups } = await pool.query('SELECT id FROM suppliers WHERE company_id = $1 AND id = ANY($2::uuid[])', [companyId, args.supplier_ids]);
  if (!sups.length) return { error: 'None of the alternative suppliers is in this company.' };
  const RequestForQuotation = require('../models/RequestForQuotation');
  const item = items[0];
  const deadline = iso(Date.now() + 7 * DAY);
  const rfq = await RequestForQuotation.create({
    title: String(args.title || `Re-quote ${item.item_code || item.name}`).slice(0, 250),
    description: 'Drafted by Simeli from the spend analysis. Review and send from the RFQ screen.',
    response_deadline: deadline,
    line_items: [{ item_id: item.id, item_description: item.name || item.item_code, unit_of_measure: item.unit_of_measure || 'EA', quantity: args.quantity }],
    suppliers: sups.map((s) => s.id),
    status: 'DRAFT',
  }, userId);
  return { id: rfq.id, reference: rfq.rfq_number, open_at: `/procurement/rfqs/${rfq.id}` };
}

async function askOwner(companyId, analysis, d, p) {
  if (!p.owner?.id) return { state: 'needs_owner', note: 'Nobody active is on record for these orders or bills.' };
  const key = `${d.supplier.id}:${p.reason}`;
  const { rows: open } = await pool.query(
    `SELECT id, created_at FROM notifications
      WHERE company_id = $1 AND user_id = $2 AND type = 'AI_FINDING' AND data->>'spend_key' = $3
        AND created_at > CURRENT_TIMESTAMP - INTERVAL '7 days'
      ORDER BY created_at DESC LIMIT 1`,
    [companyId, p.owner.id, key],
  );
  if (open.length) return { state: 'ASKED', id: open[0].id, already: true, owner: p.owner.name };
  const title = (p.reason === 'off_po'
    ? `${d.name}: ${money(d.evidence.off_po_bills.reduce((t, b) => t + num(b.amount), 0), analysis.currency)} billed with no purchase order`
    : `${d.name}: what is the extra ordering for?`).slice(0, 255);
  const message = [
    `Simeli · spend analysis ${analysis.period.from} – ${analysis.period.to} against the pace of ${analysis.baseline.from} – ${analysis.baseline.to}.`,
    `${d.name}: ${money(d.spend_now, analysis.currency)} committed against ${money(d.spend_at_pace, analysis.currency)} at the usual pace (${signed(d.money, analysis.currency)}).`,
    d.detail,
    p.reason === 'off_po'
      ? `Bills: ${d.evidence.off_po_bills.map((b) => b.number).join(', ')}. Say what they were for, and raise a purchase order for anything that continues.`
      : `Orders: ${d.evidence.purchase_orders.map((o) => o.number).join(', ')}. No customer order is behind them — say what they are for.`,
  ].filter(Boolean).join('\n');
  const link = p.reason === 'off_po' && d.evidence.off_po_bills[0]
    ? `/finance/supplier-invoices?invoice=${d.evidence.off_po_bills[0].id}`
    : d.evidence.purchase_orders[0] ? `/procurement/purchase-orders/${d.evidence.purchase_orders[0].id}` : `/procurement/suppliers/${d.supplier.id}`;
  const { rows } = await pool.query(
    `INSERT INTO notifications (id, type, title, message, data, user_id, company_id, created_at)
     VALUES (gen_random_uuid(), 'AI_FINDING', $1, $2, $3, $4, $5, CURRENT_TIMESTAMP) RETURNING id`,
    [title, message, JSON.stringify({ spend_key: key, supplier_id: d.supplier.id, link, source: 'spend_analysis' }), p.owner.id, companyId],
  );
  return { state: 'ASKED', id: rows[0].id, owner: p.owner.name };
}

/**
 * Draft what the analysis proposes now (or only for the suppliers asked for):
 * a DRAFT re-quote per item whose price went up (procurement sends it), and a
 * question to the person who booked bills without an order or raised orders
 * with no customer order behind them. Runs the analysis again rather than
 * trusting what a client sends; never drafts the same thing twice.
 */
async function prepareSpendFollowUps(opts = {}) {
  const companyId = await resolveCompany(opts.companyId);
  const only = Array.isArray(opts.supplierIds) && opts.supplierIds.length ? new Set(opts.supplierIds.map(String)) : null;
  const analysis = await explainSpend({ ...opts, companyId, limit: opts.limit || (only ? 20 : 5) });
  if (analysis.error) return analysis;
  const role = opts.role ? String(opts.role).toUpperCase() : null;
  const userId = opts.userId && UUID.test(String(opts.userId)) ? opts.userId : null;
  const canRfq = !role || hasPermission(role, 'PROCUREMENT_WRITE');

  const prepared = [];
  for (const d of analysis.drivers) {
    if (only && !only.has(String(d.supplier.id))) continue;
    for (const p of d.proposals) {
      if (p.kind === 'rfq') {
        if (!canRfq) { prepared.push({ supplier: d.name, supplier_id: d.supplier.id, kind: 'rfq', label: p.label, state: 'needs_owner', note: 'Procurement drafts the re-quote; your role does not.' }); continue; }
        const r = await draftRequote(companyId, userId, p.args);
        prepared.push({ supplier: d.name, supplier_id: d.supplier.id, kind: 'rfq', label: p.label, ...(r.error ? { state: 'failed', note: r.error } : { state: 'DRAFT', ...r, owner: 'Procurement' }) });
      } else if (p.kind === 'ask_owner') {
        const r = await askOwner(companyId, analysis, d, p);
        prepared.push({ supplier: d.name, supplier_id: d.supplier.id, kind: 'ask_owner', reason: p.reason, label: p.label, ...r });
      }
    }
  }
  const fresh = prepared.filter((r) => !r.already && (r.state === 'DRAFT' || r.state === 'ASKED'));
  const waiting = prepared.filter((r) => r.already);
  return {
    headline: analysis.headline,
    prepared,
    summary: prepared.length
      ? `${fresh.filter((r) => r.kind === 'rfq').length} re-quote${fresh.filter((r) => r.kind === 'rfq').length === 1 ? '' : 's'} drafted for procurement, ${fresh.filter((r) => r.kind === 'ask_owner').length} owner${fresh.filter((r) => r.kind === 'ask_owner').length === 1 ? '' : 's'} asked${waiting.length ? `, ${waiting.length} already waiting` : ''}. Nothing was sent to a supplier; procurement sends a re-quote, and an award still goes through purchase approval.`
      : 'No supplier is costing more than usual with something to act on, so there is nothing to prepare.',
  };
}

module.exports = { explainSpend, prepareSpendFollowUps, SEES_ALL };
