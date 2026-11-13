/**
 * "What is hurting our margins this month?" — answered from the company's own
 * rows, not from a story about them.
 *
 * WHAT THIS ANSWERS
 * ---------------------------------------------------------------------------
 * The ledger says gross margin moved. It cannot say why: revenue and cost of
 * goods are two lines on the income statement, and the reasons live in the
 * documents underneath them. This reads those documents and splits the move
 * into causes a person can act on, each one priced in margin points and named
 * by the records it came from:
 *
 *   • Purchase price  an item sold this period now costs more (or less) to buy
 *                     than it did in the baseline — the supplier, the change in
 *                     per cent, the purchase order where the new price started,
 *                     and the contract price if one exists.
 *   • Discounting     a product sold at a deeper average discount than its own
 *                     baseline (or than a policy, when the caller gives one).
 *   • Scrap           a work centre scrapping a larger share of what it makes
 *                     than it did in the baseline, at the cost of the units lost.
 *   • Mix             revenue shifting toward products that earn less.
 *
 * WHERE THE HEADLINE COMES FROM
 * ---------------------------------------------------------------------------
 * Gross margin is read from posted journal entries (revenue accounts against
 * cost-of-goods accounts) when the ledger has both in both windows — that is
 * the number Finance reports. When it does not, the margin is computed from the
 * sales lines and the unit costs below, and the result says which it used.
 *
 * Each driver is the money it moved divided by this period's revenue, so the
 * points add up against the headline and the share of the drop each explains
 * is stated, along with what is left unexplained.
 *
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It changes nothing. Follow-ups come back as proposals — an RFQ to draft for
 * alternative suppliers, an approval rule to set, a quality review to open —
 * and each one goes through the ordinary draft-and-approve path.
 *
 * WHO MAY ASK
 * ---------------------------------------------------------------------------
 * Margins expose costs and prices across every customer, so only roles that see
 * the ledger (finance users and managers, managers, admins) get an answer.
 */

const { pool } = require('../config/database');
const companyContext = require('./companyContext');

const SEES_MARGINS = new Set(['ADMIN', 'MANAGER', 'FINANCE_MANAGER', 'FINANCE_USER']);

/** Orders that never became a sale. Everything else counts from its order date. */
const NOT_SOLD = ['DRAFT', 'PENDING_APPROVAL', 'CUSTOMER_REJECTED', 'CANCELLED', 'REJECTED'];
/** Purchase orders that never became a commitment to a price. */
const NOT_BOUGHT = ['DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'CANCELLED'];

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86400000;
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const num = (v) => (v == null ? 0 : Number(v));
const round = (v, p = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** p) / 10 ** p);
const pct = (part, whole) => (whole ? (part / whole) * 100 : null);

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

/** Revenue and cost of goods posted in each window. */
async function readLedger(companyId, cur, base) {
  const { rows } = await pool.query(
    `WITH lines AS (
       SELECT je.entry_date, coa.account_type, coa.account_code, coa.account_name,
              COALESCE(jei.debit_amount,0) AS dr, COALESCE(jei.credit_amount,0) AS cr
         FROM journal_entry_items jei
         JOIN journal_entries je ON je.id = jei.journal_entry_id
         JOIN chart_of_accounts coa ON coa.id = jei.account_id
        WHERE je.company_id = $1 AND je.status = 'POSTED' AND je.deleted_at IS NULL
          AND (je.entry_date BETWEEN $2 AND $3 OR je.entry_date BETWEEN $4 AND $5)
     ), tagged AS (
       SELECT *, CASE WHEN entry_date BETWEEN $2 AND $3 THEN 'cur' ELSE 'base' END AS w,
              CASE
                WHEN account_type = 'REVENUE' THEN 'revenue'
                WHEN account_type = 'EXPENSE' AND (account_code LIKE '51%'
                     OR account_name ILIKE '%cost of goods%' OR account_name ILIKE '%cost of sales%'
                     OR account_name ILIKE '%COGS%') THEN 'cogs'
              END AS kind
         FROM lines
     )
     SELECT w,
            SUM(CASE WHEN kind = 'revenue' THEN cr - dr ELSE 0 END)::float8 AS revenue,
            SUM(CASE WHEN kind = 'cogs' THEN dr - cr ELSE 0 END)::float8 AS cogs
       FROM tagged WHERE kind IS NOT NULL GROUP BY w`,
    [companyId, cur.from, cur.to, base.from, base.to],
  );
  const out = { cur: { revenue: 0, cogs: 0 }, base: { revenue: 0, cogs: 0 } };
  for (const r of rows) out[r.w] = { revenue: num(r.revenue), cogs: num(r.cogs) };
  return out;
}

/** What was sold, per product and window: quantity, list value, discount given, net. */
async function readSales(companyId, cur, base, itemFilter) {
  const { rows } = await pool.query(
    `SELECT CASE WHEN so.order_date BETWEEN $2 AND $3 THEN 'cur' ELSE 'base' END AS w,
            COALESCE(ii.item_master_id::text, 'code:' || COALESCE(soi.item_code, soi.item_name, '?')) AS key,
            ii.item_master_id AS item_id,
            MAX(COALESCE(i.item_code, soi.item_code)) AS item_code,
            MAX(COALESCE(i.name, soi.item_name, soi.item_description)) AS item_name,
            MAX(so.currency) AS currency,
            SUM(soi.quantity)::float8 AS qty,
            SUM(soi.quantity * soi.unit_price)::float8 AS gross,
            SUM(COALESCE(NULLIF(soi.discount_amount, 0),
                         soi.quantity * soi.unit_price * COALESCE(soi.discount_percentage, 0) / 100))::float8 AS discount,
            COUNT(*)::int AS lines,
            COUNT(DISTINCT so.id)::int AS orders
       FROM sales_order_items soi
       JOIN sales_orders so ON so.id = soi.sales_order_id
       LEFT JOIN inventory_items ii ON ii.id = soi.inventory_item_id
       LEFT JOIN items i ON i.id = ii.item_master_id
      WHERE so.company_id = $1 AND so.deleted_at IS NULL
        AND so.status <> ALL($6::text[])
        AND (so.order_date BETWEEN $2 AND $3 OR so.order_date BETWEEN $4 AND $5)
        AND ($7::text IS NULL OR i.item_code ILIKE $7 OR i.name ILIKE $7 OR soi.item_code ILIKE $7 OR soi.item_name ILIKE $7)
      GROUP BY 1, 2, 3`,
    [companyId, cur.from, cur.to, base.from, base.to, NOT_SOLD, itemFilter ? `%${itemFilter}%` : null],
  );
  return rows.map((r) => ({ ...r, qty: num(r.qty), gross: num(r.gross), discount: num(r.discount) }));
}

/** Every purchase line for the products sold, baseline start to current end — the prices actually paid. */
async function readPurchases(companyId, itemIds, from, to) {
  if (!itemIds.length) return [];
  const { rows } = await pool.query(
    `SELECT pol.item_id, po.id AS po_id, po.po_number, po.po_date, po.supplier_id,
            COALESCE(s.trade_name, s.legal_name) AS supplier_name,
            pol.quantity::float8 AS qty, pol.unit_price::float8 AS unit_price
       FROM purchase_order_line_items pol
       JOIN purchase_orders po ON po.id = pol.po_id
       LEFT JOIN suppliers s ON s.id = po.supplier_id
      WHERE po.company_id = $1 AND po.status <> ALL($2::text[])
        AND pol.item_id = ANY($3::uuid[]) AND pol.unit_price > 0 AND pol.quantity > 0
        AND po.po_date BETWEEN $4 AND $5
      ORDER BY po.po_date, po.po_number`,
    [companyId, NOT_BOUGHT, itemIds, from, to],
  );
  return rows;
}

/** Unit cost of what was produced, per product and window, from completed work orders. */
async function readProductionCost(companyId, itemIds, cur, base) {
  if (!itemIds.length) return [];
  const { rows } = await pool.query(
    `SELECT wo.item_id,
            CASE WHEN COALESCE(wo.actual_end_date, wo.updated_at::date) BETWEEN $3 AND $4 THEN 'cur' ELSE 'base' END AS w,
            SUM(wo.completed_value)::float8 AS value, SUM(wo.quantity_produced)::float8 AS qty
       FROM work_orders wo
      WHERE wo.company_id = $1 AND wo.deleted_at IS NULL AND wo.status = 'COMPLETED'
        AND wo.item_id = ANY($2::uuid[]) AND wo.quantity_produced > 0 AND wo.completed_value > 0
        AND (COALESCE(wo.actual_end_date, wo.updated_at::date) BETWEEN $3 AND $4
          OR COALESCE(wo.actual_end_date, wo.updated_at::date) BETWEEN $5 AND $6)
      GROUP BY 1, 2`,
    [companyId, itemIds, cur.from, cur.to, base.from, base.to],
  );
  return rows;
}

/** The cost the books carry when nothing was bought or made in the window. */
async function readCarriedCost(companyId, itemIds, through) {
  if (!itemIds.length) return [];
  const { rows } = await pool.query(
    `SELECT ii.item_master_id AS item_id,
            COALESCE(SUM(cl.quantity * cl.unit_cost) / NULLIF(SUM(cl.quantity), 0),
                     AVG(NULLIF(ii.unit_price, 0)))::float8 AS unit_cost
       FROM inventory_items ii
       LEFT JOIN cost_layers cl ON cl.inventory_item_id = ii.id AND cl.created_at::date <= $3
      WHERE ii.company_id = $1 AND ii.item_master_id = ANY($2::uuid[])
      GROUP BY 1`,
    [companyId, itemIds, through],
  );
  return rows;
}

/** Contract prices in force for each product and supplier. */
async function readContractPrices(companyId, itemIds, onDate) {
  if (!itemIds.length) return [];
  const { rows } = await pool.query(
    `SELECT ci.item_id, c.supplier_id, c.contract_number, MIN(ci.unit_price)::float8 AS unit_price
       FROM contract_items ci
       JOIN contracts c ON c.id = ci.contract_id
      WHERE c.company_id = $1 AND ci.item_id = ANY($2::uuid[])
        AND UPPER(c.status) IN ('ACTIVE', 'APPROVED', 'SIGNED')
        AND (c.start_date IS NULL OR c.start_date <= $3) AND (c.end_date IS NULL OR c.end_date >= $3)
      GROUP BY 1, 2, 3`,
    [companyId, itemIds, onDate],
  );
  return rows;
}

/** Other suppliers who can supply a product: in the supplier catalogue, or bought from before. */
async function readAlternatives(companyId, itemIds) {
  if (!itemIds.length) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (x.item_id, x.supplier_id) x.item_id, x.supplier_id,
            COALESCE(s.trade_name, s.legal_name) AS supplier_name, x.unit_price, x.lead_time_days, x.source
       FROM (
         SELECT ii.item_master_id AS item_id, si.supplier_id, si.unit_price::float8 AS unit_price,
                si.lead_time_days, 'catalogue' AS source, 0 AS rank
           FROM supplier_items si JOIN inventory_items ii ON ii.id = si.item_id
          WHERE si.company_id = $1 AND ii.item_master_id = ANY($2::uuid[])
            AND COALESCE(UPPER(si.status), 'ACTIVE') NOT IN ('INACTIVE', 'REJECTED', 'DECLINED')
         UNION ALL
         SELECT pol.item_id, po.supplier_id, pol.unit_price::float8, NULL, 'purchase history', 1
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

/** Scrap per work centre and window. A work order belongs to the centre carrying most of its hours. */
async function readScrap(companyId, cur, base) {
  const { rows } = await pool.query(
    `WITH wo AS (
       SELECT wo.id, wo.item_id, wo.quantity_produced::float8 AS produced, wo.quantity_scrapped::float8 AS scrapped,
              wo.completed_value::float8 AS completed_value,
              CASE WHEN COALESCE(wo.actual_end_date, wo.updated_at::date) BETWEEN $2 AND $3 THEN 'cur' ELSE 'base' END AS w
         FROM work_orders wo
        WHERE wo.company_id = $1 AND wo.deleted_at IS NULL AND wo.status IN ('COMPLETED', 'IN_PROGRESS')
          AND (COALESCE(wo.actual_end_date, wo.updated_at::date) BETWEEN $2 AND $3
            OR COALESCE(wo.actual_end_date, wo.updated_at::date) BETWEEN $4 AND $5)
          AND COALESCE(wo.quantity_produced, 0) + COALESCE(wo.quantity_scrapped, 0) > 0
     ), main_centre AS (
       SELECT DISTINCT ON (op.work_order_id) op.work_order_id, op.work_center_id
         FROM work_order_operations op JOIN wo ON wo.id = op.work_order_id
        ORDER BY op.work_order_id, COALESCE(op.actual_hours, op.planned_hours, 0) DESC, op.operation_number
     )
     SELECT wo.w, wc.id AS work_center_id, wc.code, wc.name,
            SUM(COALESCE(wo.produced, 0))::float8 AS produced, SUM(COALESCE(wo.scrapped, 0))::float8 AS scrapped,
            SUM(COALESCE(wo.completed_value, 0))::float8 AS completed_value,
            COUNT(*)::int AS work_orders,
            (ARRAY_AGG(wo.item_id ORDER BY wo.scrapped DESC NULLS LAST))[1] AS worst_item_id
       FROM wo
       JOIN main_centre mc ON mc.work_order_id = wo.id
       JOIN work_centers wc ON wc.id = mc.work_center_id
      GROUP BY 1, 2, 3, 4`,
    [companyId, cur.from, cur.to, base.from, base.to],
  );
  return rows;
}

/* ---------------------------------------------------------------- compute */

function weighted(rows) {
  const q = rows.reduce((s, r) => s + num(r.qty), 0);
  return q > 0 ? rows.reduce((s, r) => s + num(r.qty) * num(r.unit_price), 0) / q : null;
}

/**
 * @param {object} opts
 *   companyId, userId, role       who is asking
 *   from, to                      the period to explain (default: this month to date)
 *   baselineFrom, baselineTo      what to compare it with (default: the three full months before)
 *   discountPolicyPct             a discount ceiling to judge against; without one, each product's own baseline
 *   item                          only products whose code or name contains this
 *   limit                         how many drivers to return (default 5)
 */
async function explainMargin(opts = {}) {
  if (opts.role && !SEES_MARGINS.has(String(opts.role).toUpperCase())) {
    return { error: 'Margins expose costs and prices across every customer; your role does not see them. Ask a finance user or a manager.' };
  }
  for (const k of ['from', 'to', 'baselineFrom', 'baselineTo']) {
    if (opts[k] && !ISO.test(String(opts[k]))) return { error: `${k} must be YYYY-MM-DD.` };
  }
  const companyId = await resolveCompany(opts.companyId);
  const { cur, base } = windows(opts);
  if (cur.from > cur.to) return { error: 'The period starts after it ends.' };
  if (base.from > base.to) return { error: 'The baseline starts after it ends.' };
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 5, 1), 20);
  const policy = opts.discountPolicyPct != null && opts.discountPolicyPct !== '' ? Number(opts.discountPolicyPct) : null;

  const sales = await readSales(companyId, cur, base, opts.item || null);
  const products = new Map();
  for (const r of sales) {
    const p = products.get(r.key) || { key: r.key, item_id: r.item_id, item_code: r.item_code, item_name: r.item_name, currency: r.currency };
    p[r.w] = r;
    products.set(r.key, p);
  }
  const itemIds = [...new Set([...products.values()].map((p) => p.item_id).filter(Boolean))];
  const lastDay = cur.to > base.to ? cur.to : base.to;

  const [ledger, purchases, production, carriedCur, carriedBase, contracts, alternatives, scrap] = await Promise.all([
    readLedger(companyId, cur, base),
    readPurchases(companyId, itemIds, base.from, cur.to),
    readProductionCost(companyId, itemIds, cur, base),
    readCarriedCost(companyId, itemIds, cur.to),
    readCarriedCost(companyId, itemIds, base.to),
    readContractPrices(companyId, itemIds, cur.to),
    readAlternatives(companyId, itemIds),
    opts.item ? Promise.resolve([]) : readScrap(companyId, cur, base),
  ]);

  const inWin = (d, w) => { const s = iso(d); return s >= w.from && s <= w.to; };
  const buysBy = new Map();
  for (const b of purchases) {
    if (!buysBy.has(b.item_id)) buysBy.set(b.item_id, []);
    buysBy.get(b.item_id).push(b);
  }
  const madeBy = new Map();
  for (const m of production) {
    const e = madeBy.get(m.item_id) || {};
    e[m.w] = num(m.qty) > 0 ? num(m.value) / num(m.qty) : null;
    madeBy.set(m.item_id, e);
  }
  const carried = (rows, id) => num(rows.find((r) => r.item_id === id)?.unit_cost) || null;

  /** Unit cost in a window, and where it came from. */
  function unitCost(itemId, w, wName) {
    if (!itemId) return { cost: null, source: null };
    const buys = (buysBy.get(itemId) || []).filter((b) => inWin(b.po_date, w));
    const bought = weighted(buys);
    if (bought != null) return { cost: bought, source: 'purchase price' };
    const made = madeBy.get(itemId)?.[wName];
    if (made != null) return { cost: made, source: 'production cost' };
    // Nothing bought or made in the window: the last price paid before it ended, else the cost the books carry.
    const before = (buysBy.get(itemId) || []).filter((b) => iso(b.po_date) <= w.to);
    if (before.length) return { cost: num(before[before.length - 1].unit_price), source: 'last purchase price' };
    const c = carried(wName === 'cur' ? carriedCur : carriedBase, itemId);
    return { cost: c, source: c != null ? 'inventory cost' : null };
  }

  // Margin per product in each window.
  let opRevCur = 0; let opCostCur = 0; let opRevBase = 0; let opCostBase = 0;
  let costedRevCur = 0;
  for (const p of products.values()) {
    for (const [wName, w] of [['cur', cur], ['base', base]]) {
      const s = p[wName];
      if (!s) continue;
      s.net = s.gross - s.discount;
      const uc = unitCost(p.item_id, w, wName);
      s.unit_cost = uc.cost;
      s.cost_source = uc.source;
      s.cost = uc.cost != null ? uc.cost * s.qty : null;
      s.margin_pct = s.cost != null && s.net > 0 ? pct(s.net - s.cost, s.net) : null;
      if (s.cost != null) {
        if (wName === 'cur') { opRevCur += s.net; opCostCur += s.cost; } else { opRevBase += s.net; opCostBase += s.cost; }
      }
      if (wName === 'cur' && s.cost != null) costedRevCur += s.net;
    }
  }
  const salesRevCur = [...products.values()].reduce((t, p) => t + (p.cur ? p.cur.net : 0), 0);

  // The headline.
  const ledgerUsable = !opts.item && ledger.cur.revenue > 0 && ledger.base.revenue > 0 && ledger.cur.cogs > 0 && ledger.base.cogs > 0;
  const head = ledgerUsable
    ? {
      source: 'ledger',
      revenue: ledger.cur.revenue,
      current_pct: pct(ledger.cur.revenue - ledger.cur.cogs, ledger.cur.revenue),
      baseline_pct: pct(ledger.base.revenue - ledger.base.cogs, ledger.base.revenue),
    }
    : {
      source: 'sales lines',
      revenue: opRevCur,
      current_pct: opRevCur > 0 ? pct(opRevCur - opCostCur, opRevCur) : null,
      baseline_pct: opRevBase > 0 ? pct(opRevBase - opCostBase, opRevBase) : null,
    };
  const revenue = head.revenue;
  const change = head.current_pct != null && head.baseline_pct != null ? head.current_pct - head.baseline_pct : null;
  const toPts = (money) => (revenue > 0 ? (money / revenue) * 100 : null);

  const drivers = [];
  const altBy = (itemId, exclude) => alternatives.filter((a) => a.item_id === itemId && !exclude.has(a.supplier_id));

  // 1. Purchase price: the cost of what was sold this period, at this period's price against the baseline's.
  for (const p of products.values()) {
    if (!p.cur || !p.item_id) continue;
    const buys = buysBy.get(p.item_id) || [];
    const baseBuys = buys.filter((b) => inWin(b.po_date, base));
    const curBuys = buys.filter((b) => inWin(b.po_date, cur));
    const basePrice = weighted(baseBuys);
    // This period's price is what was paid this period; if nothing was bought, the latest price in force.
    const latest = buys.filter((b) => iso(b.po_date) <= cur.to);
    const curPrice = weighted(curBuys) ?? (latest.length ? num(latest[latest.length - 1].unit_price) : null);
    if (basePrice == null || curPrice == null || basePrice <= 0) continue;
    const delta = curPrice - basePrice;
    if (Math.abs(delta / basePrice) < 0.01) continue;
    const money = -delta * p.cur.qty;
    // Who is charging it, and since when: the first order at or above the new price after the baseline average.
    const raised = buys.find((b) => num(b.unit_price) >= basePrice * 1.01 && iso(b.po_date) >= base.from && delta > 0);
    const lowered = buys.find((b) => num(b.unit_price) <= basePrice * 0.99 && delta < 0);
    const first = raised || lowered || latest[latest.length - 1];
    const supplierBuys = buys.filter((b) => b.supplier_id === first?.supplier_id);
    // The supplier's own price before the change, so "+x% since <date>" is the step they took, not a blend.
    const supplierBase = weighted(supplierBuys.filter((b) => iso(b.po_date) < iso(first?.po_date))) ?? basePrice;
    const supplierCur = weighted(supplierBuys.filter((b) => iso(b.po_date) >= iso(first?.po_date))) ?? curPrice;
    const contract = contracts.find((c) => c.item_id === p.item_id && c.supplier_id === first?.supplier_id);
    const aboveContract = contract && supplierCur > num(contract.unit_price) * 1.005;
    const supplierPct = supplierBase > 0 ? ((supplierCur - supplierBase) / supplierBase) * 100 : null;
    const alts = delta > 0 ? altBy(p.item_id, new Set([first?.supplier_id])) : [];
    drivers.push({
      kind: 'purchase_price',
      name: `${p.item_name || p.item_code} cost`,
      detail: `${first?.supplier_name || 'Supplier'} ${supplierPct >= 0 ? '+' : ''}${round(supplierPct, 1)}% since ${iso(first?.po_date)}`
        + (aboveContract ? ` — above the ${contract.contract_number} contract price of ${round(num(contract.unit_price))}` : ''),
      money: round(money),
      evidence: {
        item: { id: p.item_id, code: p.item_code, name: p.item_name },
        supplier: first ? { id: first.supplier_id, name: first.supplier_name } : null,
        unit_price_baseline: round(basePrice, 4),
        unit_price_now: round(curPrice, 4),
        quantity_sold: round(p.cur.qty, 3),
        first_order_at_new_price: first ? { id: first.po_id, number: first.po_number, date: iso(first.po_date), unit_price: round(num(first.unit_price), 4) } : null,
        contract: contract ? { number: contract.contract_number, unit_price: round(num(contract.unit_price), 4), above: !!aboveContract } : null,
      },
      records: [first && { type: 'purchase_order', id: first.po_id, number: first.po_number }, first?.supplier_id && { type: 'supplier', id: first.supplier_id, number: first.supplier_name }].filter(Boolean),
      proposals: delta > 0 ? [
        alts.length
          ? {
            kind: 'rfq',
            label: `Re-quote ${p.item_code || p.item_name} with ${alts.length === 1 ? alts[0].supplier_name : `${alts.length} alternative suppliers`}`,
            tool: 'create_rfq_draft',
            args: {
              item_id: p.item_id,
              quantity: round(p.cur.qty, 3),
              supplier_ids: alts.slice(0, 5).map((a) => a.supplier_id),
              title: `Re-quote ${p.item_code || p.item_name} — price up ${round(supplierPct, 1)}% at ${first?.supplier_name}`,
            },
            alternatives: alts.slice(0, 5).map((a) => ({ id: a.supplier_id, name: a.supplier_name, unit_price: round(num(a.unit_price), 4), source: a.source })),
          }
          : { kind: 'find_supplier', label: `Find a second source for ${p.item_code || p.item_name}: no other supplier has supplied it`, where: '/procurement/suppliers' },
        aboveContract ? { kind: 'contract', label: `Hold ${first.supplier_name} to the ${contract.contract_number} price`, where: '/procurement/contracts' } : null,
      ].filter(Boolean) : [],
    });
  }

  // 2. Discounting: a product sold at a deeper discount than its own baseline, or than the policy.
  const companyBaseRate = (() => {
    const g = [...products.values()].reduce((t, p) => t + (p.base ? p.base.gross : 0), 0);
    const d = [...products.values()].reduce((t, p) => t + (p.base ? p.base.discount : 0), 0);
    return g > 0 ? d / g : null;
  })();
  for (const p of products.values()) {
    if (!p.cur || p.cur.gross <= 0) continue;
    const rateNow = p.cur.discount / p.cur.gross;
    const ref = policy != null ? policy / 100
      : p.base && p.base.gross > 0 ? p.base.discount / p.base.gross
        : companyBaseRate;
    if (ref == null) continue;
    const excess = rateNow - ref;
    if (Math.abs(excess) < 0.005) continue;
    if (policy != null && excess < 0) continue; // under the policy is not a cause
    const money = -excess * p.cur.gross;
    const against = policy != null ? `a ${round(policy, 1)}% policy`
      : p.base && p.base.gross > 0 ? `${round(ref * 100, 1)}% in the baseline` : `the company's usual ${round(ref * 100, 1)}%`;
    drivers.push({
      kind: 'discount',
      name: `Discounting on ${p.item_code || p.item_name}`,
      detail: `Average ${round(rateNow * 100, 1)}% against ${against}, across ${p.cur.orders} order${p.cur.orders === 1 ? '' : 's'}`,
      money: round(money),
      evidence: {
        item: { id: p.item_id, code: p.item_code, name: p.item_name },
        discount_pct_now: round(rateNow * 100, 2),
        discount_pct_reference: round(ref * 100, 2),
        reference: policy != null ? 'policy' : 'baseline',
        list_value_sold: round(p.cur.gross),
        discount_given: round(p.cur.discount),
        orders: p.cur.orders,
      },
      records: [],
      proposals: excess > 0 ? [{
        kind: 'approval_rule',
        label: `Require a manager's approval for ${p.item_code || p.item_name} discounts above ${round(ref * 100, 1)}%`,
        tool: 'prepare_margin_follow_ups',
        args: { item_id: p.item_id, item_code: p.item_code, max_discount_pct: round(ref * 100, 1) },
        where: '/finance',
      }] : [],
    });
  }

  // 3. Scrap: a work centre losing a larger share of what it makes than it used to.
  const scrapBy = new Map();
  for (const s of scrap) {
    const e = scrapBy.get(s.work_center_id) || { work_center_id: s.work_center_id, code: s.code, name: s.name };
    e[s.w] = s;
    scrapBy.set(s.work_center_id, e);
  }
  for (const wc of scrapBy.values()) {
    if (!wc.cur) continue;
    const made = (x) => num(x.produced) + num(x.scrapped);
    const rateNow = made(wc.cur) > 0 ? num(wc.cur.scrapped) / made(wc.cur) : null;
    const rateBase = wc.base && made(wc.base) > 0 ? num(wc.base.scrapped) / made(wc.base) : null;
    if (rateNow == null || rateBase == null || rateNow - rateBase < 0.002) continue;
    const unit = num(wc.cur.produced) > 0 && num(wc.cur.completed_value) > 0
      ? num(wc.cur.completed_value) / num(wc.cur.produced)
      : (madeBy.get(wc.cur.worst_item_id)?.cur ?? carried(carriedCur, wc.cur.worst_item_id));
    if (!unit) continue;
    const extraUnits = (rateNow - rateBase) * made(wc.cur);
    drivers.push({
      kind: 'scrap',
      name: `Scrap on ${wc.code}${wc.name && wc.name !== wc.code ? ` · ${wc.name}` : ''}`,
      detail: `${round(rateNow * 100, 1)}% against a ${round(rateBase * 100, 1)}% baseline, ${round(extraUnits, 0)} more units lost`,
      money: round(-extraUnits * unit),
      evidence: {
        work_center: { id: wc.work_center_id, code: wc.code, name: wc.name },
        scrap_pct_now: round(rateNow * 100, 2),
        scrap_pct_baseline: round(rateBase * 100, 2),
        units_scrapped_now: round(num(wc.cur.scrapped), 3),
        extra_units: round(extraUnits, 3),
        unit_cost: round(unit, 4),
        work_orders: wc.cur.work_orders,
      },
      records: [{ type: 'work_center', id: wc.work_center_id, number: wc.code }],
      proposals: [{
        kind: 'quality_review',
        label: `Open a quality review on ${wc.code} scrap`,
        tool: 'prepare_margin_follow_ups',
        args: { work_center_id: wc.work_center_id, title: `Scrap on ${wc.code}: ${round(rateNow * 100, 1)}% against ${round(rateBase * 100, 1)}%` },
        where: '/manufacturing/work-centers',
      }],
    });
  }

  // 4. Mix: revenue moving between products that earn different margins, at baseline margins.
  {
    const both = [...products.values()].filter((p) => p.cur && p.base && p.base.margin_pct != null && p.cur.net > 0 && p.base.net > 0);
    const curT = both.reduce((t, p) => t + p.cur.net, 0);
    const baseT = both.reduce((t, p) => t + p.base.net, 0);
    if (both.length > 1 && curT > 0 && baseT > 0) {
      const avgBase = both.reduce((t, p) => t + (p.base.net / baseT) * p.base.margin_pct, 0);
      const mixPts = both.reduce((t, p) => t + ((p.cur.net / curT) - (p.base.net / baseT)) * (p.base.margin_pct - avgBase), 0);
      const money = (mixPts / 100) * (revenue > 0 ? revenue : curT);
      if (Math.abs(mixPts) >= 0.05) {
        const movers = both
          .map((p) => ({ p, shift: (p.cur.net / curT) - (p.base.net / baseT) }))
          .sort((a, b) => Math.abs(b.shift) - Math.abs(a.shift))
          .slice(0, 2);
        drivers.push({
          kind: 'mix',
          name: 'Product mix',
          detail: movers.map(({ p, shift }) => `${p.item_code || p.item_name} ${shift >= 0 ? '+' : ''}${round(shift * 100, 1)} pts of sales at ${round(p.base.margin_pct, 1)}% margin`).join('; '),
          money: round(money),
          evidence: { products: movers.map(({ p, shift }) => ({ code: p.item_code, name: p.item_name, share_shift_pts: round(shift * 100, 2), baseline_margin_pct: round(p.base.margin_pct, 2) })) },
          records: [],
          proposals: [],
        });
      }
    }
  }

  for (const d of drivers) {
    d.points = round(toPts(d.money), 2);
    d.share_pct = change != null && change < 0 && d.points != null && d.points < 0 ? round((d.points / change) * 100, 0) : null;
  }
  const hurting = drivers.filter((d) => d.money < 0).sort((a, b) => a.money - b.money);
  const helping = drivers.filter((d) => d.money > 0).sort((a, b) => b.money - a.money);
  const shown = hurting.slice(0, limit);
  const explainedPts = shown.reduce((t, d) => t + (d.points || 0), 0);
  const explainedShare = change != null && change < 0 ? round(Math.min(100, (explainedPts / change) * 100), 0) : null;

  const currency = [...products.values()].find((p) => p.cur?.currency)?.currency || 'USD';
  const byProduct = [...products.values()]
    .filter((p) => p.cur)
    .sort((a, b) => b.cur.net - a.cur.net)
    .slice(0, 15)
    .map((p) => ({
      item_id: p.item_id, code: p.item_code, name: p.item_name,
      revenue: round(p.cur.net), margin_pct: round(p.cur.margin_pct, 1), baseline_margin_pct: round(p.base?.margin_pct, 1),
      discount_pct: p.cur.gross > 0 ? round((p.cur.discount / p.cur.gross) * 100, 1) : null,
      unit_cost: round(p.cur.unit_cost, 4), cost_source: p.cur.cost_source,
    }));

  let headline;
  if (head.current_pct == null) {
    headline = sales.length
      ? 'There is not enough cost data in this period to state a gross margin.'
      : 'No sales in this period, so there is no margin to explain.';
  } else if (change == null) {
    headline = `Gross margin is ${round(head.current_pct, 1)}%; there is nothing in the baseline to compare it with.`;
  } else if (change < -0.05) {
    headline = `Gross margin is down ${round(-change, 1)} points to ${round(head.current_pct, 1)}%.`
      + (shown.length ? ` ${shown.length === 1 ? 'One cause explains' : `${['', '', 'Two', 'Three', 'Four', 'Five'][shown.length] || shown.length} causes explain`} ${explainedShare}% of it.` : ' No single cause in sales, purchasing or production explains it.');
  } else if (change > 0.05) {
    headline = `Gross margin is up ${round(change, 1)} points to ${round(head.current_pct, 1)}%.`
      + (shown.length ? ` ${shown.length === 1 ? 'One thing is' : `${shown.length} things are`} still holding it back.` : '');
  } else {
    headline = `Gross margin is flat at ${round(head.current_pct, 1)}%.`
      + (shown.length ? ` ${shown.length === 1 ? 'One thing is' : `${shown.length} things are`} pulling against it.` : '');
  }

  return {
    headline,
    period: cur,
    baseline: base,
    currency,
    gross_margin: {
      source: head.source,
      current_pct: round(head.current_pct, 2),
      baseline_pct: round(head.baseline_pct, 2),
      change_pts: round(change, 2),
      revenue: round(revenue),
      ...(ledgerUsable ? { ledger: { revenue: round(ledger.cur.revenue), cogs: round(ledger.cur.cogs), baseline_revenue: round(ledger.base.revenue), baseline_cogs: round(ledger.base.cogs) } } : {}),
    },
    drivers: shown,
    helping: helping.slice(0, 3),
    explained_share_pct: explainedShare,
    unexplained_pts: change != null && change < 0 ? round(change - explainedPts, 2) : null,
    by_product: byProduct,
    coverage: {
      order_lines: sales.filter((r) => r.w === 'cur').reduce((t, r) => t + r.lines, 0),
      products: products.size,
      revenue_with_cost_pct: salesRevCur > 0 ? round((costedRevCur / salesRevCur) * 100, 0) : null,
      purchase_lines_read: purchases.length,
      work_centres_read: scrapBy.size,
    },
    method: 'Gross margin from posted revenue and cost-of-goods accounts when both windows have them, otherwise from sales lines at '
      + 'their unit cost. Each driver is the money it moved this period divided by this period\'s revenue: purchase price = '
      + '(price paid now − baseline price) × quantity sold now; discounting = (discount rate now − reference) × list value sold now; '
      + 'scrap = extra share scrapped × units made × unit cost; mix = shift in sales share × baseline margin difference.',
    proposals_note: 'Proposals are suggestions. Drafting one is a separate step a person confirms; nothing here changed anything.',
  };
}

module.exports = { explainMargin, SEES_MARGINS };
