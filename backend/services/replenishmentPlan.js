/**
 * "We're going to run low on 6204 bearings next week. What should I do?"
 *
 * WHAT THIS ANSWERS
 * ---------------------------------------------------------------------------
 * One item, one decision: when does it run out, who can bring more before it
 * does, how much to order, can we afford it, and who signs. Each of those is
 * already somewhere in the record; this reads them together, from the
 * company's own rows, and names what it read.
 *
 *   Stock        on hand across every inventory record of the item, and the
 *                bay that holds most of it (where the delivery goes).
 *   Demand       goods issued over the last twelve weeks, and the committed
 *                customer order lines still to ship. Cumulative demand by any
 *                day is the larger of the two — the orders are a floor, the
 *                issue rate the steady pull — so nothing is counted twice.
 *   Inbound      open purchase lines for the item, landing on their promised
 *                date, or — if that has passed — today plus the supplier's
 *                own average lateness (the same rule as the delivery trace).
 *   Run-out      the first moment stock plus what has landed falls below
 *                cumulative demand.
 *   Suppliers    everyone who has supplied the item or lists it in their
 *                catalogue: the lead time actually achieved on this company's
 *                orders (order date to arrival), else the catalogue lead time;
 *                the price last paid, else the catalogue price; on-time record.
 *                The cheapest one that lands before the run-out is chosen,
 *                else the fastest.
 *   Quantity     demand through the lead time and one more replenishment
 *                cycle, plus safety stock from the weekly spread of issues,
 *                less stock and inbound; never below the supplier's minimum.
 *   Budget       the approved budget for this year on the account stock
 *                receipts post to (1130 Inventory): received so far, still on
 *                open purchase orders, what is left, and what is left after
 *                this order. Figures only for roles that read finance; others
 *                see whether it fits.
 *   Authority    who the company's delegation of authority routes an order of
 *                this value to — never the person drafting it.
 *
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It changes nothing. The purchase order comes back as a proposal carrying the
 * arguments for a DRAFT purchase order; a person drafts it, and the draft goes
 * through purchase approval (DoA, segregation of duties) like any other.
 * Customer orders are named only when the person asking may see them.
 */

const { pool } = require('../config/database');
const companyContext = require('./companyContext');
const ApprovalRulesEngine = require('./approvalRulesEngine');
const { hasPermission } = require('../middleware/rbac');

const USAGE_DAYS = 84;
const ORDERS_DAYS = 42;
const MAX_DAYS = 120;
const STEP = 0.1;
const SERVICE_FACTOR = 1.65;
const MIN_WEEKS = 3;
const INVENTORY_ACCOUNT = '1130';
const ISSUE_STATUSES = ['POSTED', 'APPROVED'];
const OPEN_ORDER_STATUSES = [
  'PENDING_APPROVAL', 'APPROVED', 'SENT_TO_CUSTOMER', 'CONFIRMED', 'CUSTOMER_ACCEPTED', 'IN_PRODUCTION',
];
const OPEN_PO_STATUSES = [
  'PENDING_APPROVAL', 'APPROVED', 'SENT_TO_SUPPLIER', 'CONFIRMED', 'PREPARING_DELIVERY', 'IN_TRANSIT',
  'DELIVERED', 'GOODS_READY_FOR_RECEIPT', 'PARTIALLY_RECEIVED',
];
const COMMITTED_PO_STATUSES = OPEN_PO_STATUSES.filter((s) => s !== 'PENDING_APPROVAL');
const PLACED_PO_EXCLUDED = ['DRAFT', 'CANCELLED', 'REJECTED'];
const SEES_ALL_ORDERS = new Set(['ADMIN', 'MANAGER', 'FINANCE_MANAGER']);
const DAY = 86400000;

const round = (v, p = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** p) / 10 ** p);
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const today = () => new Date(`${iso(new Date())}T00:00:00Z`);
const addDays = (d, n) => new Date(d.getTime() + n * DAY);
const daysFromToday = (d) => (new Date(`${iso(d)}T00:00:00Z`) - today()) / DAY;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const shortDate = (d) => new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtQty = (v) => new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(v || 0);

function money(v, cur, digits = 0) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: cur || 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v || 0);
  } catch {
    return `${(v || 0).toFixed(digits)} ${cur || ''}`.trim();
  }
}

async function resolveCompany(companyId) {
  return companyId || companyContext.currentCompanyId() || (await companyContext.getDefaultCompanyId());
}

/* ------------------------------------------------------------------ reads */

/** By item id, inventory record id, code, or the words of its name ("6204 bearings"). */
async function resolveItem(companyId, ref) {
  const text = String(ref).trim();
  if (/^[0-9a-f-]{36}$/i.test(text)) {
    const { rows } = await pool.query(
      `SELECT i.id, i.item_code, i.name, i.unit_of_measure FROM items i
        WHERE i.company_id = $1
          AND (i.id = $2::uuid OR i.id = (SELECT item_master_id FROM inventory_items WHERE id = $2::uuid AND company_id = $1))
        LIMIT 1`,
      [companyId, text],
    );
    return rows[0] || null;
  }
  // Every word must appear in the code or the name; a plural is matched by its stem.
  const words = text.toLowerCase().split(/[\s,]+/).filter((w) => w.length > 1 && !['the', 'of', 'our', 'we', 'on', 'low'].includes(w))
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
  if (!words.length) return null;
  const conds = words.map((_, i) => `(i.item_code ILIKE $${i + 2} OR i.name ILIKE $${i + 2})`).join(' AND ');
  const { rows } = await pool.query(
    `SELECT i.id, i.item_code, i.name, i.unit_of_measure,
            (SELECT COALESCE(SUM(ii.current_stock_quantity), 0) FROM inventory_items ii
              WHERE ii.item_master_id = i.id AND ii.company_id = $1) AS stocked
       FROM items i
      WHERE i.company_id = $1 AND ${conds}
      ORDER BY EXISTS (SELECT 1 FROM inventory_items ii WHERE ii.item_master_id = i.id AND ii.company_id = $1) DESC,
               stocked DESC, i.item_code
      LIMIT 1`,
    [companyId, ...words.map((w) => `%${w}%`)],
  );
  return rows[0] || null;
}

/** With no item named: the stocked item whose stock lasts the fewest days at its issue rate. */
async function shortestCoverItem(companyId) {
  const { rows } = await pool.query(
    `WITH issued AS (
       SELECT ii.item_master_id AS item_id, SUM(COALESCE(NULLIF(wti.issued_quantity, 0), wti.quantity))::float AS qty
         FROM warehouse_transactions wt
         JOIN warehouse_transaction_items wti ON wti.warehouse_transaction_id = wt.id
         JOIN inventory_items ii ON ii.id = wti.inventory_item_id AND ii.company_id = $1
        WHERE wt.company_id = $1 AND wt.transaction_type = 'GI' AND wt.status = ANY($2)
          AND wt.transaction_date >= CURRENT_DATE - $3::int
        GROUP BY 1
     ), stock AS (
       SELECT item_master_id AS item_id, SUM(current_stock_quantity)::float AS qty
         FROM inventory_items WHERE company_id = $1 AND COALESCE(status, 'APPROVED') <> 'DECLINED' GROUP BY 1
     )
     SELECT i.id, i.item_code, i.name, i.unit_of_measure
       FROM issued u JOIN stock s ON s.item_id = u.item_id JOIN items i ON i.id = u.item_id AND i.company_id = $1
      WHERE u.qty > 0
      ORDER BY s.qty / (u.qty / $3::float) ASC LIMIT 1`,
    [companyId, ISSUE_STATUSES, USAGE_DAYS],
  );
  return rows[0] || null;
}

async function readStock(companyId, itemId) {
  const [{ rows: [stock] }, { rows: bays }] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(current_stock_quantity), 0)::float AS on_hand,
              MAX(reorder_point)::float AS reorder_point, MAX(unit_price)::float AS unit_price, MAX(currency) AS currency,
              (ARRAY_AGG(id ORDER BY current_stock_quantity DESC))[1] AS inventory_item_id
         FROM inventory_items
        WHERE company_id = $1 AND item_master_id = $2 AND COALESCE(status, 'APPROVED') <> 'DECLINED'`,
      [companyId, itemId],
    ),
    pool.query(
      `SELECT b.code AS bin, sl.code AS location, sl.name AS location_name, SUM(m.quantity_in_location)::float AS qty
         FROM inventory_storage_mappings m
         JOIN inventory_items ii ON ii.id = m.inventory_item_id AND ii.company_id = $1
         LEFT JOIN bins b ON b.id = m.bin_id
         LEFT JOIN storage_locations sl ON sl.id = m.storage_location_id
        WHERE ii.item_master_id = $2 AND COALESCE(m.status, 'APPROVED') <> 'DECLINED'
        GROUP BY 1, 2, 3 ORDER BY qty DESC NULLS LAST LIMIT 1`,
      [companyId, itemId],
    ),
  ]);
  return { ...stock, bay: bays[0] || null };
}

/** Goods issued per week over the window, weeks without issues included as zero. */
async function readIssues(companyId, itemId) {
  const { rows } = await pool.query(
    `SELECT FLOOR((CURRENT_DATE - wt.transaction_date::date) / 7)::int AS wk,
            SUM(COALESCE(NULLIF(wti.issued_quantity, 0), wti.quantity))::float AS qty
       FROM warehouse_transactions wt
       JOIN warehouse_transaction_items wti ON wti.warehouse_transaction_id = wt.id
       JOIN inventory_items ii ON ii.id = wti.inventory_item_id AND ii.company_id = $1
      WHERE wt.company_id = $1 AND wt.transaction_type = 'GI' AND wt.status = ANY($2)
        AND wt.transaction_date >= CURRENT_DATE - $3::int AND ii.item_master_id = $4
      GROUP BY 1`,
    [companyId, ISSUE_STATUSES, USAGE_DAYS, itemId],
  );
  const weeks = Array.from({ length: USAGE_DAYS / 7 }, () => 0);
  for (const r of rows) if (r.wk >= 0 && r.wk < weeks.length) weeks[r.wk] += r.qty;
  return { weeks, active: rows.filter((r) => r.qty > 0).length };
}

async function readOrders(companyId, item) {
  const { rows } = await pool.query(
    `SELECT so.id AS sales_order_id, so.so_number, so.customer_name, so.created_by,
            (soi.quantity - COALESCE(soi.quantity_delivered, 0))::float AS open_qty,
            COALESCE(soi.promised_delivery_date, soi.requested_delivery_date, so.delivery_date) AS due_date
       FROM sales_orders so
       JOIN sales_order_items soi ON soi.sales_order_id = so.id
       LEFT JOIN inventory_items ii ON ii.id = soi.inventory_item_id
      WHERE so.company_id = $1 AND so.deleted_at IS NULL AND so.status = ANY($2)
        AND soi.quantity - COALESCE(soi.quantity_delivered, 0) > 0
        AND (ii.item_master_id = $3 OR (ii.id IS NULL AND soi.item_code = $4))
        AND COALESCE(soi.promised_delivery_date, soi.requested_delivery_date, so.delivery_date) <= CURRENT_DATE + $5::int
      ORDER BY due_date, so.so_number`,
    [companyId, OPEN_ORDER_STATUSES, item.id, item.item_code, ORDERS_DAYS],
  );
  return rows;
}

async function readInbound(companyId, itemId) {
  const { rows } = await pool.query(
    `SELECT po.id AS po_id, po.po_number, po.status, po.supplier_id, COALESCE(s.trade_name, s.legal_name) AS supplier_name,
            GREATEST(pol.quantity - COALESCE(pol.quantity_received, 0), 0)::float AS remaining,
            COALESCE(pol.requested_delivery_date, po.delivery_date, po.supplier_delivery_due::date) AS expected_date
       FROM purchase_orders po
       JOIN purchase_order_line_items pol ON pol.po_id = po.id
       LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.company_id = po.company_id
      WHERE po.company_id = $1 AND po.status = ANY($2) AND pol.item_id = $3
        AND pol.quantity - COALESCE(pol.quantity_received, 0) > 0
      ORDER BY expected_date NULLS LAST, po.po_number`,
    [companyId, OPEN_PO_STATUSES, itemId],
  );
  return rows;
}

/**
 * Everyone who can supply the item: its catalogue entries and the suppliers it
 * has actually been bought from in two years, with what they achieved.
 */
async function readSuppliers(companyId, itemId) {
  const { rows } = await pool.query(
    `WITH placed AS (
       SELECT po.supplier_id, po.po_date, po.delivery_date AS promised, pol.unit_price::float AS unit_price, po.currency,
              COALESCE(po.delivery_confirmed_at::date,
                       (SELECT MIN(gr.received_date)::date FROM goods_receipts gr
                         WHERE gr.po_id = po.id AND gr.company_id = po.company_id)) AS arrived
         FROM purchase_orders po
         JOIN purchase_order_line_items pol ON pol.po_id = po.id
        WHERE po.company_id = $1 AND pol.item_id = $2 AND po.status <> ALL($3)
          AND po.po_date >= CURRENT_DATE - 730
     ), history AS (
       SELECT supplier_id,
              COUNT(*)::int AS orders,
              COUNT(arrived)::int AS delivered,
              COUNT(*) FILTER (WHERE arrived IS NOT NULL AND promised IS NOT NULL AND arrived <= promised)::int AS on_time,
              AVG(arrived - po_date) FILTER (WHERE arrived IS NOT NULL AND arrived >= po_date)::float AS achieved_lead,
              AVG(GREATEST(arrived - promised, 0)) FILTER (WHERE arrived IS NOT NULL AND promised IS NOT NULL)::float AS avg_days_late,
              (ARRAY_AGG(unit_price ORDER BY po_date DESC))[1] AS last_price,
              (ARRAY_AGG(currency ORDER BY po_date DESC))[1] AS last_currency,
              MAX(po_date) AS last_ordered
         FROM placed GROUP BY supplier_id
     )
     SELECT DISTINCT ON (s.id) s.id AS supplier_id, COALESCE(s.trade_name, s.legal_name) AS name, s.supplier_code, s.currency AS supplier_currency,
            si.lead_time_days AS catalogue_lead, si.unit_price::float AS catalogue_price, si.currency AS catalogue_currency,
            si.minimum_order_quantity AS moq, COALESCE(si.is_preferred, false) AS preferred,
            h.orders, h.delivered, h.on_time, h.achieved_lead, h.avg_days_late, h.last_price, h.last_currency, h.last_ordered
       FROM suppliers s
       -- A catalogue entry names the inventory record, not the item master.
       LEFT JOIN supplier_items si ON si.supplier_id = s.id AND si.company_id = $1
            AND si.item_id IN (SELECT id FROM inventory_items WHERE item_master_id = $2 AND company_id = $1)
       LEFT JOIN history h ON h.supplier_id = s.id
      WHERE s.company_id = $1 AND COALESCE(s.status, 'ACTIVE') = 'ACTIVE'
        AND (si.id IS NOT NULL OR h.supplier_id IS NOT NULL)
      ORDER BY s.id, si.is_preferred DESC NULLS LAST`,
    [companyId, itemId, PLACED_PO_EXCLUDED],
  );
  return rows.map((r) => {
    const achieved = r.delivered > 0 && r.achieved_lead != null ? Math.max(1, Math.ceil(r.achieved_lead)) : null;
    return {
      supplier_id: r.supplier_id,
      name: r.name,
      code: r.supplier_code,
      lead_days: achieved ?? (r.catalogue_lead > 0 ? r.catalogue_lead : null),
      lead_basis: achieved != null ? `achieved on ${plural(r.delivered, 'delivery', 'deliveries')}` : r.catalogue_lead > 0 ? 'catalogue' : null,
      catalogue_lead_days: r.catalogue_lead || null,
      unit_price: r.last_price ?? r.catalogue_price ?? null,
      price_basis: r.last_price != null ? 'last paid' : r.catalogue_price != null ? 'catalogue' : null,
      currency: (r.last_price != null ? r.last_currency : r.catalogue_currency) || r.supplier_currency || null,
      moq: r.moq || null,
      preferred: r.preferred,
      orders: r.orders || 0,
      on_time_pct: r.delivered ? Math.round((r.on_time / r.delivered) * 100) : null,
      avg_days_late: r.delivered ? round(r.avg_days_late, 1) : null,
    };
  });
}

/**
 * This year's approved budget on the inventory account, what receipts have
 * used, and what open purchase orders already hold.
 */
async function readBudget(companyId) {
  const year = new Date().getUTCFullYear();
  const { rows: lines } = await pool.query(
    `SELECT b.name AS budget, cc.name AS cost_center, bl.annual_amount::float AS amount
       FROM budgets b
       JOIN budget_lines bl ON bl.budget_id = b.id
       JOIN chart_of_accounts coa ON coa.id = bl.account_id AND coa.company_id = b.company_id
       LEFT JOIN cost_centers cc ON cc.id = bl.cost_center_id
      WHERE b.company_id = $1 AND b.deleted_at IS NULL AND b.status = 'APPROVED'
        AND b.fiscal_year = $2 AND coa.account_code = $3`,
    [companyId, year, INVENTORY_ACCOUNT],
  );
  if (!lines.length) return { year, set: false };
  const [{ rows: [used] }, { rows: [held] }] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(jei.debit_amount), 0)::float AS received
         FROM journal_entry_items jei
         JOIN journal_entries je ON je.id = jei.journal_entry_id
         JOIN chart_of_accounts coa ON coa.id = jei.account_id
        WHERE je.company_id = $1 AND je.status = 'POSTED' AND je.deleted_at IS NULL
          AND je.source_type IN ('GOODS_RECEIPT', 'LANDED_COST')
          AND coa.account_code = $2 AND EXTRACT(YEAR FROM je.entry_date) = $3`,
      [companyId, INVENTORY_ACCOUNT, year],
    ),
    pool.query(
      `SELECT COALESCE(SUM(GREATEST(pol.quantity - COALESCE(pol.quantity_received, 0), 0) * pol.unit_price), 0)::float AS open
         FROM purchase_orders po
         JOIN purchase_order_line_items pol ON pol.po_id = po.id
        WHERE po.company_id = $1 AND po.status = ANY($2) AND EXTRACT(YEAR FROM po.po_date) = $3`,
      [companyId, COMMITTED_PO_STATUSES, year],
    ),
  ]);
  const budgeted = lines.reduce((s, l) => s + l.amount, 0);
  const name = lines.length === 1
    ? [lines[0].budget, lines[0].cost_center].filter(Boolean).join(' · ')
    : lines[0].budget;
  return {
    year,
    set: true,
    name,
    budgeted: round(budgeted),
    received: round(used.received),
    on_open_orders: round(held.open),
    remaining: round(budgeted - used.received - held.open),
  };
}

/** Who the delegation of authority routes an order of this value to — not its drafter. */
async function readRouting(companyId, amount, userId) {
  const [users, rules] = await Promise.all([
    ApprovalRulesEngine.getAuthorizedUsers(amount, null, 'PURCHASE_ORDER', companyId).catch(() => []),
    ApprovalRulesEngine.evaluateRules({ documentType: 'PURCHASE_ORDER', amount, companyId, requesterId: userId }).catch(() => null),
  ]);
  const holder = users.find((u) => !userId || String(u.user_id) !== String(userId)) || null;
  const steps = (rules?.approvers || []).map((a) => a.role).filter(Boolean);
  return { holder, steps, needs_approval: !!rules?.requires_approval || !!holder };
}

/* ------------------------------------------------------------ projection */

/**
 * Demand by day t (days from now): the larger of the steady issue rate and the
 * committed order lines due by then. Stock runs out the first moment on hand
 * plus what has landed falls below it.
 */
function project({ onHand, dailyRate, orders, inbound }) {
  const due = orders.map((o) => ({ t: Math.max(daysFromToday(o.due_date), 0), qty: o.open_qty })).sort((a, b) => a.t - b.t);
  const lands = inbound.map((p) => ({ t: Math.max(p.lands_in, 0), qty: p.remaining })).sort((a, b) => a.t - b.t);
  const demandBy = (t) => Math.max(dailyRate * t, due.filter((d) => d.t <= t).reduce((s, d) => s + d.qty, 0));
  const landedBy = (t) => lands.filter((l) => l.t <= t).reduce((s, l) => s + l.qty, 0);
  if (onHand - demandBy(0) < 0) return { runout: 0, demandBy, landedBy };
  for (let t = STEP; t <= MAX_DAYS; t = round(t + STEP, 1)) {
    if (onHand + landedBy(t) - demandBy(t) < 0) return { runout: round(t - STEP / 2, 1), demandBy, landedBy };
  }
  return { runout: null, demandBy, landedBy };
}

function pickSupplier(suppliers, runout) {
  const known = suppliers.filter((s) => s.lead_days != null && s.unit_price != null);
  const candidates = known.length ? known : suppliers.filter((s) => s.lead_days != null);
  if (!candidates.length) return suppliers[0] || null;
  const inTime = runout == null ? candidates : candidates.filter((s) => s.lead_days <= runout);
  const byPrice = (a, b) => (a.unit_price ?? Infinity) - (b.unit_price ?? Infinity) || (b.preferred - a.preferred) || a.lead_days - b.lead_days;
  if (inTime.length) return [...inTime].sort(byPrice)[0];
  return [...candidates].sort((a, b) => a.lead_days - b.lead_days || byPrice(a, b))[0];
}

/* ------------------------------------------------------------------ main */

async function planReplenishment(opts = {}) {
  const companyId = await resolveCompany(opts.companyId);
  const role = String(opts.role || '').toUpperCase();
  const item = opts.item ? await resolveItem(companyId, opts.item) : await shortestCoverItem(companyId);
  if (!item) {
    return { error: opts.item ? `No item matching "${opts.item}" in this company.` : 'No stocked item has been issued in the last twelve weeks, so there is nothing to run low on yet.' };
  }

  const [stock, issues, orders, inboundRaw, suppliers, budget] = await Promise.all([
    readStock(companyId, item.id),
    readIssues(companyId, item.id),
    readOrders(companyId, item),
    readInbound(companyId, item.id),
    readSuppliers(companyId, item.id),
    readBudget(companyId),
  ]);
  const unit = item.unit_of_measure || 'units';
  const code = item.item_code || item.name;

  // Demand.
  const issued = issues.weeks.reduce((s, w) => s + w, 0);
  const issueDaily = issued / USAGE_DAYS;
  const ordersNext14 = orders.filter((o) => daysFromToday(o.due_date) <= 14).reduce((s, o) => s + o.open_qty, 0);
  const dailyRate = Math.max(issueDaily, ordersNext14 / 14);
  const weekly = dailyRate * 7;
  const mean = issued / issues.weeks.length;
  const sigma = issues.active >= MIN_WEEKS
    ? Math.sqrt(issues.weeks.reduce((s, w) => s + (w - mean) ** 2, 0) / (issues.weeks.length - 1))
    : null;
  const demandBasis = issueDaily >= ordersNext14 / 14
    ? `goods issued over the last ${USAGE_DAYS / 7} weeks`
    : `customer orders due in the next 14 days (issues ran at ${fmtQty(issueDaily * 7)} a week)`;

  // Inbound, landing when its supplier usually lands.
  const lateBy = new Map(suppliers.map((s) => [s.supplier_id, s.avg_days_late || 0]));
  const inbound = inboundRaw.map((p) => {
    const expected = p.expected_date ? daysFromToday(p.expected_date) : null;
    const overdue = expected != null && expected < 0;
    const lands_in = expected == null ? Math.ceil(lateBy.get(p.supplier_id) || 0) + 7
      : overdue ? Math.max(1, Math.ceil(lateBy.get(p.supplier_id) || 1)) : expected;
    return { ...p, expected_date: iso(p.expected_date), overdue, lands_in, lands: iso(addDays(today(), lands_in)) };
  });

  const { runout, demandBy } = project({ onHand: stock.on_hand, dailyRate, orders, inbound });
  const runoutDate = runout != null ? iso(addDays(today(), Math.floor(runout))) : null;

  // Who, how much, at what price.
  const supplier = pickSupplier(suppliers, runout);
  const lead = supplier?.lead_days ?? null;
  const cycle = Math.max(7, lead || 7);
  const safety = sigma != null && lead ? SERVICE_FACTOR * sigma * Math.sqrt(lead / 7) : dailyRate * (lead || 7) * 0.5;
  // Only what lands inside the window the order has to cover counts against it.
  const window = (lead || 0) + cycle;
  const inboundInWindow = inbound.filter((p) => p.lands_in <= window).reduce((s, p) => s + p.remaining, 0);
  const need = demandBy(window) + safety - stock.on_hand - inboundInWindow;
  let quantity = need > 0 ? Math.ceil(need) : 0;
  if (quantity >= 50) quantity = Math.ceil(quantity / 10) * 10;
  if (quantity > 0 && supplier?.moq && quantity < supplier.moq) quantity = supplier.moq;
  const unitPrice = supplier?.unit_price ?? stock.unit_price ?? null;
  const currency = supplier?.currency || stock.currency || 'USD';
  const value = unitPrice != null ? round(quantity * unitPrice) : null;
  const arrives = lead ? iso(addDays(today(), lead)) : null;
  const slack = runout != null && lead != null ? round(runout - lead, 1) : null;
  const orderBy = slack != null && slack >= 1 ? iso(addDays(today(), Math.floor(slack))) : null;

  // Decision.
  let action;
  let tone;
  if (!dailyRate && !orders.length) {
    action = 'Nothing has been issued or ordered for twelve weeks; there is nothing to reorder against.';
    tone = 'ok';
  } else if (runout == null) {
    action = `Stock and open orders cover the next ${MAX_DAYS} days.`;
    tone = 'ok';
  } else if (!supplier || lead == null) {
    action = 'No supplier has a lead time on record for it — ask procurement for a source today.';
    tone = 'risk';
  } else if (slack < 0) {
    action = `Order today — even so, there is a gap of about ${plural(Math.ceil(-slack), 'day')}.`;
    tone = 'risk';
  } else if (slack < 1) {
    action = 'Order today.';
    tone = 'risk';
  } else if (slack <= 3) {
    action = `Order by ${shortDate(orderBy)}.`;
    tone = 'warn';
  } else {
    action = `No need to order before ${shortDate(orderBy)}.`;
    tone = 'ok';
  }
  const supplierShort = supplier ? String(supplier.name).split(/\s+/)[0] : null;
  const headline = runout == null
    ? `${code}: ${fmtQty(stock.on_hand)} on hand lasts beyond ${MAX_DAYS} days at ${fmtQty(weekly)} a week. ${action}`
    : `${runout === 0 ? `Open orders already need more than the ${fmtQty(stock.on_hand)} on hand` : `You run out in about ${fmtQty(runout)} days`}`
      + `${lead != null ? `. ${supplierShort} needs ${lead}` : ''}. ${action}`;

  // Budget and authority.
  const seesFinance = !role || hasPermission(role, 'FINANCE_READ');
  const after = budget.set && value != null ? round(budget.remaining - value) : null;
  const fits = budget.set && value != null ? after >= 0 : null;
  const routing = value ? await readRouting(companyId, value, opts.userId) : { holder: null, steps: [], needs_approval: false };
  const routedTo = routing.holder
    ? `${routing.holder.user_name || routing.holder.user_email}${routing.holder.max_amount != null ? ` · within ${money(routing.holder.max_amount, currency)} authority` : ' · unlimited authority'}`
    : routing.steps.length ? `${routing.steps.join(' → ')} (approval chain)` : 'An administrator — no delegation of authority covers this value';

  // Customer orders waiting on the item — named only for those who may see them.
  const canSee = (o) => SEES_ALL_ORDERS.has(role) || !role || (opts.userId && o.created_by === opts.userId);
  const waiting = orders.map((o) => ({
    sales_order_id: o.sales_order_id, so_number: o.so_number, customer_name: o.customer_name,
    quantity: o.open_qty, due_date: iso(o.due_date),
    short: runout != null && daysFromToday(o.due_date) >= runout,
  }));
  const visible = waiting.filter((o, i) => canSee(orders[i]));

  const read = [
    { call: 'inventory.stock_level', result: `${code} · ${fmtQty(stock.on_hand)} on hand${stock.bay?.bin ? ` · bay ${stock.bay.bin}` : ''}` },
    { call: 'inventory.demand', result: `${fmtQty(weekly)} / week · ${demandBasis}${orders.length ? ` · ${plural(orders.length, 'open order line')}` : ''}` },
    supplier ? { call: 'procurement.supplier_terms', result: `${supplier.name} · ${lead != null ? `${lead} days` : 'no lead time'}${unitPrice != null ? ` · ${money(unitPrice, currency, 2)}` : ''}` } : null,
    inbound.length ? { call: 'procurement.open_orders', result: inbound.map((p) => `${p.po_number} · ${fmtQty(p.remaining)} ${p.overdue ? 'overdue' : `due ${p.expected_date}`}`).join('; ') } : null,
    { call: 'finance.budget_remaining', result: !budget.set ? `No approved ${budget.year} budget on ${INVENTORY_ACCOUNT} Inventory` : seesFinance ? `${budget.name} · ${money(budget.remaining, currency)} left` : `${budget.name} · ${fits == null ? 'no order to check' : fits ? 'this order fits' : 'this order does not fit'}` },
  ].filter(Boolean);

  const facts = [
    { label: 'On hand', value: `${fmtQty(stock.on_hand)} ${unit}` },
    { label: 'Average weekly demand', value: `${fmtQty(weekly)} ${unit}` },
    { label: 'Runs out', value: runout == null ? `Not within ${MAX_DAYS} days` : `${shortDate(runoutDate)} (≈${fmtQty(runout)} days)`, tone: runout != null && slack != null && slack < 1 ? 'risk' : undefined },
    { label: 'Supplier lead time', value: lead != null ? `${lead} days${supplier.lead_basis ? ` (${supplier.lead_basis})` : ''}` : 'Unknown', tone: slack != null && slack < 1 ? 'warn' : undefined },
    { label: 'Recommended order', value: quantity ? `${fmtQty(quantity)} ${unit}` : 'None' },
  ];

  const canDraft = !role || hasPermission(role, 'PROCUREMENT_WRITE');
  const proposals = [];
  let recommendation = null;
  if (quantity > 0 && supplier) {
    const budgetNote = !budget.set ? 'No inventory budget is set for this year.'
      : fits ? (seesFinance ? `Stays inside ${budget.name} (${money(after, currency)} left after it).` : `Stays inside ${budget.name}.`)
        : fits === false ? (seesFinance ? `Exceeds ${budget.name} by ${money(-after, currency)} — finance has to release budget.` : `Does not fit ${budget.name} — finance has to release budget.`) : '';
    recommendation = {
      text: `Order ${fmtQty(quantity)} ${unit} of ${code} from ${supplier.name}. That covers demand through ${lead ? `the ${lead}-day lead time and ` : ''}the following ${cycle}-day cycle with a safety buffer${inboundInWindow ? `, on top of ${fmtQty(inboundInWindow)} already on order that lands in time` : ''}. ${budgetNote}`.trim(),
      supplier_id: supplier.supplier_id,
      supplier: supplier.name,
      item_id: item.id,
      quantity,
      unit_price: unitPrice,
      value,
      currency,
      expected_delivery_date: arrives,
      deliver_to: stock.bay ? [stock.bay.bin && `bay ${stock.bay.bin}`, stock.bay.location_name].filter(Boolean).join(' · ') : null,
      routed_to: routedTo,
      fits_budget: fits,
    };
    proposals.push({
      kind: 'purchase_order',
      label: `Prepare purchase order: ${fmtQty(quantity)} × ${code} from ${supplier.name}${value != null ? ` (${money(value, currency)})` : ''}`,
      can_draft: canDraft,
      tool: 'create_purchase_order_draft',
      args: {
        supplier_id: supplier.supplier_id,
        currency,
        expected_delivery_date: arrives,
        notes: `Replenishment of ${code}: ${fmtQty(stock.on_hand)} on hand, ${fmtQty(weekly)}/week, runs out ${runoutDate || `after ${MAX_DAYS} days`}. `
          + `${supplier.name} lead time ${lead ?? '?'} days.${stock.bay?.bin ? ` Deliver to bay ${stock.bay.bin}.` : ''} Routed to ${routedTo}.`,
        items: [{ item_id: item.id, description: item.name || code, quantity, unit_price: unitPrice ?? undefined }],
      },
    });
  }
  for (const p of inbound.filter((x) => x.overdue).slice(0, 2)) {
    proposals.push({ kind: 'chase_supplier', label: `Chase ${p.supplier_name} on ${p.po_number}: ${fmtQty(p.remaining)} ${unit} overdue since ${p.expected_date}`, record: { type: 'purchase_order', id: p.po_id, number: p.po_number } });
  }
  if (fits === false) {
    proposals.push({ kind: 'release_budget', label: `Ask finance to release budget for ${code}${seesFinance ? ` (${money(-after, currency)} over ${budget.name})` : ''}` });
  }

  return {
    item: { id: item.id, inventory_item_id: stock.inventory_item_id, code, name: item.name, unit },
    headline,
    tone,
    currency,
    stock: { on_hand: stock.on_hand, reorder_point: stock.reorder_point, bay: stock.bay },
    demand: {
      weekly: round(weekly, 1),
      daily: round(dailyRate, 2),
      basis: demandBasis,
      weeks_with_issues: issues.active,
      weekly_spread: sigma != null ? round(sigma, 1) : null,
    },
    runout_days: runout,
    runout_date: runoutDate,
    order_by: orderBy,
    slack_days: slack,
    inbound,
    suppliers: suppliers
      .sort((a, b) => (a.supplier_id === supplier?.supplier_id ? -1 : b.supplier_id === supplier?.supplier_id ? 1 : (a.lead_days ?? 999) - (b.lead_days ?? 999)))
      .slice(0, 5),
    budget: !budget.set ? { set: false, year: budget.year, account: INVENTORY_ACCOUNT }
      : seesFinance ? { ...budget, account: INVENTORY_ACCOUNT, after_this_order: after, fits }
        : { set: true, year: budget.year, name: budget.name, account: INVENTORY_ACCOUNT, fits },
    routing: { routed_to: routedTo, needs_approval: routing.needs_approval },
    orders_waiting: visible,
    orders_hidden: waiting.length - visible.length,
    facts,
    read,
    recommendation,
    proposals,
    method:
      `Demand is the larger of goods issued over ${USAGE_DAYS / 7} weeks and committed customer order lines; inbound lands on its promised date, `
      + `or today plus the supplier's average lateness once that has passed. Lead time is what each supplier achieved on this company's orders `
      + `(catalogue when there is no history). Quantity covers lead time plus one cycle plus ${SERVICE_FACTOR}σ safety stock. `
      + `Budget is the approved ${budget.year} line on ${INVENTORY_ACCOUNT} Inventory less receipts posted and open purchase orders.`,
  };
}

module.exports = { planReplenishment, readSuppliers, resolveItem, readRouting };
