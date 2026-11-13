/**
 * Point at an order. See the whole business behind it.
 *
 * WHAT THIS ANSWERS
 * ---------------------------------------------------------------------------
 * In most systems an order is a row in a sales tool. Here it is the visible end
 * of a chain that runs through the customer's credit, the stock it draws on,
 * the supplier who refills that stock, the purchase or work order on its way,
 * the invoice that will collect for it, and the margin it actually makes. This
 * reads that chain for one order from the company's own rows:
 *
 *   Customer        credit exposure (receivables still open plus committed
 *                   orders not yet invoiced) against the credit limit, and how
 *                   many days the customer actually takes to pay, from payment
 *                   allocations over the last year.
 *   Product         the lead line: quantity × net price, and its discount
 *                   against the ACTIVE discount rule for the product, if any.
 *   Stock           the delivery trace's own allocation (services/deliveryRisk):
 *                   what is free after earlier orders take theirs, what is
 *                   short, and which locations hold the item.
 *   Supplier        the supplier on the purchase order covering the line, else
 *                   the preferred or most used one: lead time actually achieved,
 *                   last price paid, on-time record (services/replenishmentPlan).
 *   Supply          the purchase or work order the line depends on and when it
 *                   really lands — or that none is needed, or that nothing is
 *                   on order.
 *   Invoice         the customer invoice raised for the order, its state and
 *                   due date, or the terms it will be issued on.
 *   Margin          net revenue against the cost of each line (the covering
 *                   purchase price, else the last price paid, else production
 *                   or carried cost), and why it is where it is: a supplier
 *                   price that rose, a discount past policy, a purchase order
 *                   still waiting for approval.
 *
 * WHO SEES WHAT
 * ---------------------------------------------------------------------------
 * The order is visible on the same terms as everywhere else: roles that do not
 * see all orders see only the ones they raised. Costs, supplier prices and the
 * margin are only returned to roles that see margins (marginDrivers).
 *
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It changes nothing. What it suggests comes back as proposals naming the tool
 * that would draft them, and every draft goes through the ordinary approval.
 */

const { pool } = require('../config/database');
const companyContext = require('./companyContext');
const { traceDeliveryRisk } = require('./deliveryRisk');
const { readSuppliers } = require('./replenishmentPlan');
const { SEES_MARGINS } = require('./marginDrivers');

const SEES_ALL_ORDERS = new Set(['ADMIN', 'MANAGER', 'FINANCE_MANAGER']);
/** Orders that hold credit until they are invoiced. */
const NOT_COMMITTED = ['DRAFT', 'CANCELLED', 'REJECTED', 'CUSTOMER_REJECTED', 'COMPLETED'];
const TERMINAL = new Set(['GOODS_ISSUED', 'READY_FOR_DELIVERY', 'SHIPPED', 'DELIVERED', 'WAITING_CUSTOMER_DELIVERY_CONFIRMATION', 'DELIVERY_ISSUE_REPORTED', 'COMPLETED', 'CANCELLED', 'REJECTED', 'CUSTOMER_REJECTED']);
const NOT_BOUGHT = ['DRAFT', 'CANCELLED', 'REJECTED'];
const OPEN_RECEIVABLE = ['DRAFT', 'CANCELLED', 'PAID'];

const DAY = 86400000;
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const num = (v) => (v == null ? 0 : Number(v));
const round = (v, p = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** p) / 10 ** p);
const shortDate = (d) => new Date(`${iso(d)}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtQty = (v) => new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(v || 0);
const humanize = (s) => String(s || '').toLowerCase().replace(/_/g, ' ');

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

async function readOrder(companyId, ref) {
  const isUuid = /^[0-9a-f-]{36}$/i.test(String(ref));
  const { rows } = await pool.query(
    `SELECT so.id, so.so_number, so.status, so.order_date, so.delivery_date, so.currency, so.total_amount, so.subtotal,
            so.payment_terms, so.created_by, so.customer_id, so.customer_name,
            c.credit_limit::float8 AS credit_limit, c.current_balance::float8 AS current_balance, c.credit_days,
            c.payment_terms AS customer_terms, c.currency AS customer_currency, c.credit_risk_level
       FROM sales_orders so
       LEFT JOIN customers c ON c.id = so.customer_id AND c.company_id = so.company_id
      WHERE so.company_id = $1 AND so.deleted_at IS NULL AND ${isUuid ? 'so.id = $2::uuid' : 'so.so_number ILIKE $2'}
      LIMIT 1`,
    [companyId, String(ref).trim()],
  );
  return rows[0] || null;
}

async function readLines(companyId, orderId) {
  const { rows } = await pool.query(
    `SELECT soi.id, soi.line_number, soi.item_code, soi.item_name, soi.unit_of_measure,
            soi.quantity::float8 AS qty, soi.unit_price::float8 AS unit_price,
            COALESCE(NULLIF(soi.discount_percentage, 0),
                     CASE WHEN soi.quantity * soi.unit_price > 0
                          THEN soi.discount_amount * 100 / (soi.quantity * soi.unit_price) END, 0)::float8 AS discount_pct,
            COALESCE(soi.line_total, soi.quantity * soi.unit_price - COALESCE(soi.discount_amount, 0))::float8 AS net,
            COALESCE(soi.quantity_delivered, 0)::float8 AS delivered,
            COALESCE(ii.item_master_id, im.id) AS item_id,
            COALESCE(i.item_code, soi.item_code) AS code, COALESCE(i.name, soi.item_name) AS name,
            r.max_discount_pct::float8 AS policy_pct
       FROM sales_order_items soi
       LEFT JOIN inventory_items ii ON ii.id = soi.inventory_item_id AND ii.company_id = $1
       LEFT JOIN LATERAL (
         SELECT x.id FROM items x WHERE x.company_id = $1 AND soi.item_code IS NOT NULL AND x.item_code = soi.item_code LIMIT 1
       ) im ON ii.id IS NULL
       LEFT JOIN items i ON i.id = COALESCE(ii.item_master_id, im.id)
       LEFT JOIN sales_discount_rules r ON r.company_id = $1 AND r.item_id = COALESCE(ii.item_master_id, im.id) AND r.status = 'ACTIVE'
      WHERE soi.sales_order_id = $2
      ORDER BY soi.line_number`,
    [companyId, orderId],
  );
  return rows;
}

/** Open receivables plus committed orders not yet invoiced, and the days this customer actually takes to pay. */
async function readCredit(companyId, customerId) {
  if (!customerId) return null;
  const [{ rows: [ar] }, { rows: [open] }, { rows: [paid] }] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(outstanding_amount), 0)::float8 AS outstanding,
              COALESCE(SUM(outstanding_amount) FILTER (WHERE due_date < CURRENT_DATE), 0)::float8 AS overdue
         FROM customer_invoices
        WHERE company_id = $1 AND customer_id = $2 AND deleted_at IS NULL AND status <> ALL($3::text[])`,
      [companyId, customerId, OPEN_RECEIVABLE],
    ),
    pool.query(
      `SELECT COALESCE(SUM(GREATEST(so.total_amount - COALESCE(inv.invoiced, 0), 0)), 0)::float8 AS uninvoiced,
              COUNT(*)::int AS orders
         FROM sales_orders so
         LEFT JOIN LATERAL (
           SELECT SUM(ci.total_amount) AS invoiced FROM customer_invoices ci
            WHERE ci.sales_order_id = so.id AND ci.company_id = so.company_id AND ci.deleted_at IS NULL AND ci.status <> 'CANCELLED'
         ) inv ON true
        WHERE so.company_id = $1 AND so.customer_id = $2 AND so.deleted_at IS NULL AND so.status <> ALL($3::text[])`,
      [companyId, customerId, NOT_COMMITTED],
    ),
    pool.query(
      `SELECT (SUM((p.payment_date - ci.invoice_date) * a.allocation_amount) / NULLIF(SUM(a.allocation_amount), 0))::float8 AS days,
              COUNT(DISTINCT ci.id)::int AS invoices
         FROM customer_payment_allocations a
         JOIN customer_payments p ON p.id = a.payment_id AND p.company_id = $1 AND p.deleted_at IS NULL
         JOIN customer_invoices ci ON ci.id = a.invoice_id AND ci.company_id = $1
        WHERE ci.customer_id = $2 AND p.payment_date >= CURRENT_DATE - 365 AND p.payment_date >= ci.invoice_date
          AND COALESCE(UPPER(p.status), 'POSTED') NOT IN ('CANCELLED', 'BOUNCED', 'VOID', 'REVERSED', 'DRAFT')`,
      [companyId, customerId],
    ),
  ]);
  return {
    receivables: num(ar.outstanding),
    overdue: num(ar.overdue),
    uninvoiced_orders: num(open.uninvoiced),
    open_orders: open.orders,
    pay_days: paid.invoices ? round(paid.days, 0) : null,
    paid_invoices: paid.invoices,
  };
}

async function readLocations(companyId, itemId) {
  const { rows } = await pool.query(
    `SELECT sl.id, sl.code, sl.name, SUM(m.quantity_in_location)::float8 AS qty
       FROM inventory_storage_mappings m
       JOIN inventory_items ii ON ii.id = m.inventory_item_id AND ii.company_id = $1
       JOIN storage_locations sl ON sl.id = m.storage_location_id AND sl.company_id = $1
      WHERE ii.item_master_id = $2 AND COALESCE(m.status, 'APPROVED') <> 'DECLINED' AND m.quantity_in_location > 0
      GROUP BY 1, 2, 3 ORDER BY qty DESC LIMIT 4`,
    [companyId, itemId],
  );
  return rows;
}

async function readOnHand(companyId, itemId) {
  const { rows: [r] } = await pool.query(
    `SELECT COALESCE(SUM(current_stock_quantity), 0)::float8 AS qty FROM inventory_items
      WHERE company_id = $1 AND item_master_id = $2 AND COALESCE(status, 'APPROVED') <> 'DECLINED'`,
    [companyId, itemId],
  );
  return num(r.qty);
}

async function readPurchaseOrders(companyId, ids, orderId) {
  const { rows } = await pool.query(
    `SELECT po.id, po.po_number, po.status, po.po_date, po.delivery_date, po.supplier_id, po.currency,
            po.total_amount::float8 AS total, po.sales_order_id,
            COALESCE(s.trade_name, s.legal_name) AS supplier_name
       FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
      WHERE po.company_id = $1 AND (po.id = ANY($2::uuid[]) OR po.sales_order_id = $3)
      ORDER BY po.po_date DESC`,
    [companyId, ids, orderId],
  );
  return rows;
}

async function readWorkOrders(companyId, ids) {
  if (!ids.length) return [];
  const { rows } = await pool.query(
    `SELECT id, wo_number, status, planned_end_date FROM work_orders WHERE company_id = $1 AND id = ANY($2::uuid[])`,
    [companyId, ids],
  );
  return rows;
}

async function readInvoices(companyId, orderId) {
  const { rows } = await pool.query(
    `SELECT id, invoice_number, status, invoice_date, due_date, currency,
            total_amount::float8 AS total, paid_amount::float8 AS paid, outstanding_amount::float8 AS outstanding
       FROM customer_invoices
      WHERE company_id = $1 AND sales_order_id = $2 AND deleted_at IS NULL AND status <> 'CANCELLED'
      ORDER BY invoice_date DESC, created_at DESC`,
    [companyId, orderId],
  );
  return rows;
}

/**
 * What each item costs: the price on a given purchase order, else the last
 * price paid, and what it cost before (purchases 90 to 365 days back) so a
 * rise shows; production or carried cost when nothing was bought.
 */
async function readCosts(companyId, itemIds, poIds) {
  if (!itemIds.length) return new Map();
  const [{ rows: bought }, { rows: made }, { rows: carried }] = await Promise.all([
    pool.query(
      `SELECT pol.item_id, po.id AS po_id, po.po_number, po.po_date, pol.unit_price::float8 AS price, pol.quantity::float8 AS qty,
              COALESCE(s.trade_name, s.legal_name) AS supplier_name
         FROM purchase_order_line_items pol
         JOIN purchase_orders po ON po.id = pol.po_id
         LEFT JOIN suppliers s ON s.id = po.supplier_id
        WHERE po.company_id = $1 AND pol.item_id = ANY($2::uuid[]) AND pol.unit_price > 0 AND pol.quantity > 0
          AND (po.status <> ALL($3::text[]) OR po.id = ANY($4::uuid[]))
          AND po.po_date >= CURRENT_DATE - 730
        ORDER BY po.po_date DESC, po.po_number DESC`,
      [companyId, itemIds, NOT_BOUGHT, poIds],
    ),
    pool.query(
      `SELECT DISTINCT ON (item_id) item_id, (completed_value / quantity_produced)::float8 AS unit_cost
         FROM work_orders
        WHERE company_id = $1 AND item_id = ANY($2::uuid[]) AND status = 'COMPLETED' AND deleted_at IS NULL
          AND quantity_produced > 0 AND completed_value > 0
        ORDER BY item_id, COALESCE(actual_end_date, updated_at::date) DESC`,
      [companyId, itemIds],
    ),
    pool.query(
      `SELECT ii.item_master_id AS item_id,
              COALESCE(SUM(cl.quantity * cl.unit_cost) / NULLIF(SUM(cl.quantity), 0), AVG(NULLIF(ii.unit_price, 0)))::float8 AS unit_cost
         FROM inventory_items ii
         LEFT JOIN cost_layers cl ON cl.inventory_item_id = ii.id
        WHERE ii.company_id = $1 AND ii.item_master_id = ANY($2::uuid[])
        GROUP BY 1`,
      [companyId, itemIds],
    ),
  ]);
  const out = new Map();
  const cutoff = Date.now() - 90 * DAY;
  const floor = Date.now() - 365 * DAY;
  for (const id of itemIds) {
    const mine = bought.filter((b) => b.item_id === id);
    const onPo = mine.find((b) => poIds.includes(b.po_id));
    const last = onPo || mine[0] || null;
    const before = mine.filter((b) => new Date(b.po_date).getTime() < cutoff && new Date(b.po_date).getTime() >= floor);
    const beforeQty = before.reduce((s, b) => s + b.qty, 0);
    const beforePrice = beforeQty ? before.reduce((s, b) => s + b.qty * b.price, 0) / beforeQty : null;
    // Where the price moved: the oldest purchase in the last 90 days at the new level.
    const since = last && beforePrice && last.price > beforePrice
      ? [...mine].reverse().find((b) => new Date(b.po_date).getTime() >= cutoff && b.price >= last.price * 0.995) || last
      : null;
    const madeCost = made.find((m) => m.item_id === id)?.unit_cost;
    const carriedCost = carried.find((c) => c.item_id === id)?.unit_cost;
    out.set(id, last
      ? { unit_cost: last.price, basis: onPo ? `on ${last.po_number}` : `last paid on ${last.po_number}`, po_number: last.po_number, supplier_name: last.supplier_name, before: beforePrice, since }
      : madeCost ? { unit_cost: madeCost, basis: 'production cost of the last completed work order' }
        : carriedCost ? { unit_cost: carriedCost, basis: 'carried cost' } : null);
  }
  return out;
}

/* ------------------------------------------------------------------ chain */

const VERDICT = {
  uncovered: { label: 'Short', tone: 'risk' },
  late: { label: 'Late', tone: 'risk' },
  at_risk: { label: 'At risk', tone: 'risk' },
  unknown_item: { label: 'Unknown item', tone: 'warn' },
  on_track: { label: 'On track', tone: 'ok' },
  covered: { label: 'Covered', tone: 'ok' },
};

/**
 * @param {object} opts  companyId, userId, role, salesOrder (id or SO number)
 */
async function traceOrderChain(opts = {}) {
  const companyId = await resolveCompany(opts.companyId);
  const role = opts.role ? String(opts.role).toUpperCase() : null;
  const seesMargins = !role || SEES_MARGINS.has(role);
  if (!opts.salesOrder) return { error: 'Which sales order? Give its SO number or id.' };

  const so = await readOrder(companyId, opts.salesOrder);
  if (!so) return { error: `No sales order ${opts.salesOrder} in this company.` };
  if (role && !SEES_ALL_ORDERS.has(role) && opts.userId && so.created_by && so.created_by !== opts.userId) {
    return { error: `Sales order ${so.so_number} belongs to someone else's book, and your role only sees your own orders.` };
  }
  const cur = so.currency || so.customer_currency || 'USD';

  const [lines, credit, invoices, trace] = await Promise.all([
    readLines(companyId, so.id),
    readCredit(companyId, so.customer_id),
    readInvoices(companyId, so.id),
    traceDeliveryRisk({ companyId, userId: opts.userId, role: opts.role, salesOrder: so.id, includeCovered: true }),
  ]);
  if (!lines.length) return { error: `${so.so_number} has no lines yet.` };
  const t = trace?.orders?.[0] || null;
  const traceLine = (l) => t?.lines?.find((x) => x.line_number === l.line_number) || null;

  // The lead line: the most exposed one, then the most valuable.
  const RANK = { uncovered: 0, late: 1, at_risk: 2, unknown_item: 3, on_track: 4, covered: 5 };
  const lead = [...lines].sort((a, b) => (RANK[traceLine(a)?.verdict] ?? 6) - (RANK[traceLine(b)?.verdict] ?? 6) || b.net - a.net)[0];
  const leadTrace = traceLine(lead);

  const deps = (t?.lines || []).flatMap((l) => l.depends_on || []);
  const poIds = [...new Set(deps.filter((d) => d.type === 'purchase_order').map((d) => d.id))];
  const woIds = [...new Set(deps.filter((d) => d.type === 'work_order').map((d) => d.id))];
  const itemIds = [...new Set(lines.map((l) => l.item_id).filter(Boolean))];

  const [pos, wos, costs, suppliers, locations, onHand] = await Promise.all([
    readPurchaseOrders(companyId, poIds, so.id),
    readWorkOrders(companyId, woIds),
    seesMargins ? readCosts(companyId, itemIds, poIds) : Promise.resolve(new Map()),
    lead.item_id ? readSuppliers(companyId, lead.item_id) : Promise.resolve([]),
    lead.item_id ? readLocations(companyId, lead.item_id) : Promise.resolve([]),
    lead.item_id ? readOnHand(companyId, lead.item_id) : Promise.resolve(null),
  ]);

  const chain = [];
  const proposals = [...(t?.proposals || [])];
  const sources = [];

  /* Customer */
  const limit = num(so.credit_limit);
  const exposure = credit ? credit.receivables + credit.uninvoiced_orders : null;
  const usedPct = limit > 0 && exposure != null ? round((exposure / limit) * 100, 0) : null;
  const terms = so.payment_terms || so.customer_terms || (so.credit_days ? `Net ${so.credit_days}` : null);
  let customerDetail;
  let customerTone;
  if (usedPct != null) {
    customerDetail = `Credit used ${usedPct}% of ${money(limit, so.customer_currency || cur)}`;
    customerTone = usedPct > 100 ? 'risk' : usedPct >= 85 ? 'warn' : undefined;
  } else if (credit?.pay_days != null) {
    customerDetail = `Pays in ${credit.pay_days} days on average`;
  } else {
    customerDetail = limit > 0 ? `Credit limit ${money(limit, cur)}` : 'No credit limit set';
  }
  if (credit?.overdue > 0) { customerDetail += ` · ${money(credit.overdue, cur)} overdue`; customerTone = 'risk'; }
  const customerFacts = [];
  if (credit?.pay_days != null) customerFacts.push(`pays in ${credit.pay_days} days on average over ${credit.paid_invoices} invoice${credit.paid_invoices === 1 ? '' : 's'}${terms ? ` (terms: ${terms})` : ''}`);
  if (credit) customerFacts.push(`${money(credit.receivables, cur)} open receivables and ${money(credit.uninvoiced_orders, cur)} on committed orders not yet invoiced`);
  chain.push({
    kind: 'Customer', module: 'CRM', title: so.customer_name, detail: customerDetail, tone: customerTone,
    facts: customerFacts, record: so.customer_id ? { type: 'customer', id: so.customer_id } : null,
  });
  sources.push({ call: 'crm.customer_credit', result: usedPct != null ? `${usedPct}% of ${money(limit, cur)} used` : customerDetail });
  if (usedPct != null && usedPct > 100) {
    proposals.push({ kind: 'credit_review', label: `${so.customer_name} is at ${usedPct}% of its credit limit — ask finance to review the exposure before ${so.so_number} ships` });
  }

  /* Product */
  const discountOver = lines.filter((l) => l.policy_pct != null && l.discount_pct > l.policy_pct + 0.01);
  chain.push({
    kind: 'Product', module: 'Inventory', title: lead.name || lead.code || `Line ${lead.line_number}`,
    detail: `${fmtQty(lead.qty)} × ${money(lead.qty ? lead.net / lead.qty : lead.unit_price, cur, 2)}`
      + (lead.discount_pct >= 0.5 ? ` · ${round(lead.discount_pct, 1)}% discount` : '')
      + (lines.length > 1 ? ` · +${lines.length - 1} more line${lines.length === 2 ? '' : 's'}` : ''),
    tone: discountOver.includes(lead) ? 'warn' : undefined,
    record: lead.item_id ? { type: 'item', id: lead.item_id, number: lead.code } : null,
  });

  /* Stock */
  const leadOpen = Math.max(lead.qty - lead.delivered, 0);
  let stock;
  if (leadTrace) {
    const short = round(leadTrace.open_qty - leadTrace.from_stock, 3);
    const elsewhere = locations.length
      ? ` · ${locations.map((l) => `${fmtQty(l.qty)} at ${l.code || l.name}`).join(', ')}`
      : '';
    stock = {
      title: onHand != null ? `${fmtQty(onHand)} on hand` : `${fmtQty(leadTrace.from_stock)} free`,
      detail: short > 0
        ? `${fmtQty(leadTrace.from_stock)} free for this order after earlier orders · ${fmtQty(short)} short${elsewhere}`
        : `${fmtQty(leadTrace.open_qty)} reserved for this order${elsewhere}`,
      tone: short > 0 ? (leadTrace.verdict === 'covered' || leadTrace.verdict === 'on_track' ? 'warn' : 'risk') : 'ok',
    };
  } else if (leadOpen <= 0) {
    stock = { title: 'Shipped', detail: `${fmtQty(lead.delivered)} of ${fmtQty(lead.qty)} delivered`, tone: 'ok' };
  } else {
    stock = { title: onHand != null ? `${fmtQty(onHand)} on hand` : 'Not tracked', detail: `${fmtQty(leadOpen)} still to ship` };
  }
  chain.push({ kind: 'Stock', module: 'Warehouse', ...stock, record: lead.item_id ? { type: 'item', id: lead.item_id, number: lead.code } : null });
  sources.push({ call: 'inventory.stock_level', result: `${lead.code || lead.name} · ${stock.title}` });

  /* Supplier — the one on the covering purchase order, else preferred, else most used. */
  const leadPoIds = (leadTrace?.depends_on || []).filter((d) => d.type === 'purchase_order').map((d) => d.id);
  const leadPo = pos.find((p) => leadPoIds.includes(p.id)) || pos.find((p) => p.sales_order_id === so.id) || null;
  const supplier = (leadPo && suppliers.find((s) => s.supplier_id === leadPo.supplier_id))
    || suppliers.find((s) => s.preferred) || [...suppliers].sort((a, b) => b.orders - a.orders)[0] || null;
  if (supplier || leadPo) {
    const name = supplier?.name || leadPo.supplier_name;
    const parts = [];
    if (supplier?.lead_days) parts.push(`${supplier.lead_days}-day lead`);
    if (seesMargins && supplier?.unit_price) parts.push(`${money(supplier.unit_price, supplier.currency || cur, 2)} / unit`);
    const cost = costs.get(lead.item_id);
    const rise = cost?.before && cost.unit_cost > cost.before * 1.02 ? (cost.unit_cost / cost.before - 1) * 100 : null;
    let tone;
    if (seesMargins && rise != null && (!supplier || cost.supplier_name === name)) {
      parts.length = 0;
      parts.push(`Price up ${round(rise, 1)}%${cost.since ? ` since ${shortDate(cost.since.po_date)}` : ''}`);
      tone = 'risk';
    } else if (supplier?.on_time_pct != null && supplier.on_time_pct < 70) {
      parts.push(`${supplier.on_time_pct}% on time`);
      tone = 'warn';
    }
    chain.push({
      kind: 'Supplier', module: 'Procurement', title: name, detail: parts.join(' · ') || 'No delivery record yet', tone,
      record: { type: 'supplier', id: supplier?.supplier_id || leadPo.supplier_id },
    });
    sources.push({ call: 'procurement.supplier_terms', result: [name, supplier?.lead_days ? `${supplier.lead_days} days` : null, seesMargins && supplier?.unit_price ? money(supplier.unit_price, supplier.currency || cur, 2) : null].filter(Boolean).join(' · ') });
  } else {
    chain.push({ kind: 'Supplier', module: 'Procurement', title: 'No supplier on record', detail: 'Nobody has supplied this item yet', tone: lead.item_id ? 'warn' : undefined, record: null });
  }

  /* Supply — the purchase or work order the lead line depends on. */
  const leadDep = (leadTrace?.depends_on || [])[0];
  const due = leadTrace?.due_date || t?.due_date || iso(so.delivery_date);
  if (leadDep?.type === 'purchase_order') {
    const po = pos.find((p) => p.id === leadDep.id) || {};
    const late = leadDep.lands && due && leadDep.lands > due;
    const waiting = po.status === 'PENDING_APPROVAL' || po.status === 'DRAFT';
    chain.push({
      kind: 'Purchase order', module: 'Procurement',
      title: waiting ? `${po.po_number || leadDep.number} · ${humanize(po.status)}` : (po.po_number || leadDep.number),
      detail: late
        ? `Arrives ${shortDate(leadDep.lands)}, not ${shortDate(due)}`
        : `${fmtQty(leadDep.qty)} land ${leadDep.lands ? shortDate(leadDep.lands) : 'on the promised date'}${seesMargins && po.total ? ` · ${money(po.total, po.currency || cur)}` : ''}`,
      tone: late ? 'risk' : waiting ? 'warn' : 'ok',
      record: { type: 'purchase_order', id: leadDep.id, number: po.po_number || leadDep.number },
    });
    sources.push({ call: 'procurement.purchase_order', result: `${po.po_number || leadDep.number} · ${humanize(po.status)}${leadDep.lands ? ` · lands ${leadDep.lands}` : ''}` });
  } else if (leadDep?.type === 'work_order') {
    const wo = wos.find((w) => w.id === leadDep.id) || {};
    const late = leadDep.lands && due && leadDep.lands > due;
    chain.push({
      kind: 'Work order', module: 'Manufacturing', title: wo.wo_number || leadDep.number,
      detail: late ? `Finishes ${shortDate(leadDep.lands)}, not ${shortDate(due)}` : `${fmtQty(leadDep.qty)} finish ${leadDep.lands ? shortDate(leadDep.lands) : 'on plan'}`,
      tone: late ? 'risk' : 'ok',
      record: { type: 'work_order', id: leadDep.id, number: wo.wo_number || leadDep.number },
    });
    sources.push({ call: 'manufacturing.work_order', result: `${wo.wo_number || leadDep.number} · ${humanize(wo.status)}` });
  } else if (leadTrace && leadTrace.uncovered > 0) {
    chain.push({ kind: 'Purchase order', module: 'Procurement', title: 'Nothing on order', detail: `${fmtQty(leadTrace.uncovered)} short with no supply coming`, tone: 'risk', record: null });
    if (lead.item_id) {
      proposals.push({
        kind: 'plan_replenishment',
        label: `Plan the replenishment of ${lead.name || lead.code}: who can land ${fmtQty(leadTrace.uncovered)} before ${due}, and at what price`,
        tool: 'plan_replenishment', args: { item: lead.code || lead.item_id },
      });
    }
  } else if (leadPo) {
    chain.push({
      kind: 'Purchase order', module: 'Procurement', title: leadPo.po_number,
      detail: `${humanize(leadPo.status)}${leadPo.delivery_date ? ` · due ${shortDate(leadPo.delivery_date)}` : ''}`,
      tone: ['FULLY_RECEIVED', 'COMPLETED'].includes(leadPo.status) ? 'ok' : undefined,
      record: { type: 'purchase_order', id: leadPo.id, number: leadPo.po_number },
    });
  } else {
    chain.push({ kind: 'Purchase order', module: 'Procurement', title: 'None needed', detail: leadTrace || leadOpen <= 0 ? 'Stock covered the order' : 'Nothing on order for this line', tone: leadTrace || leadOpen <= 0 ? 'ok' : undefined, record: null });
  }

  /* Invoice */
  const inv = invoices[0];
  if (inv) {
    const overdue = num(inv.outstanding) > 0 && inv.due_date && iso(inv.due_date) < iso(new Date());
    chain.push({
      kind: 'Invoice', module: 'Finance', title: inv.invoice_number,
      detail: inv.status === 'PAID' || (num(inv.total) > 0 && num(inv.outstanding) <= 0)
        ? 'Paid in full'
        : overdue ? `${money(inv.outstanding, inv.currency || cur)} overdue since ${shortDate(inv.due_date)}`
          : `${humanize(inv.status)}${inv.due_date ? ` · due ${shortDate(inv.due_date)}` : ''}`,
      tone: inv.status === 'PAID' || num(inv.outstanding) <= 0 ? 'ok' : overdue ? 'risk' : undefined,
      record: { type: 'customer_invoice', id: inv.id, number: inv.invoice_number },
    });
    sources.push({ call: 'finance.receivables', result: `${inv.invoice_number} · ${humanize(inv.status)}` });
  } else {
    chain.push({
      kind: 'Invoice', module: 'Finance', title: TERMINAL.has(so.status) ? 'Not invoiced yet' : 'Issued on delivery',
      detail: `${terms || 'Standard terms'} · posts to receivables`,
      tone: ['DELIVERED', 'COMPLETED'].includes(so.status) ? 'warn' : undefined,
      record: null,
    });
  }

  /* Margin — only for roles that see costs. */
  let margin = null;
  if (seesMargins) {
    let revenue = 0;
    let cost = 0;
    let costAtBefore = 0;
    let revenueAtPolicy = 0;
    const uncosted = [];
    for (const l of lines) {
      const c = costs.get(l.item_id);
      revenue += l.net;
      const gross = l.qty * l.unit_price;
      revenueAtPolicy += l.policy_pct != null && l.discount_pct > l.policy_pct ? gross * (1 - l.policy_pct / 100) : l.net;
      if (!c) { uncosted.push(l.name || l.code || `line ${l.line_number}`); continue; }
      cost += l.qty * c.unit_cost;
      costAtBefore += l.qty * (c.before && c.unit_cost > c.before * 1.02 ? c.before : c.unit_cost);
    }
    if (revenue > 0 && uncosted.length < lines.length) {
      const pct = ((revenue - cost) / revenue) * 100;
      const pctBefore = ((revenue - costAtBefore) / revenue) * 100;
      const pctPolicy = ((revenueAtPolicy - cost) / revenueAtPolicy) * 100;
      const riser = lines.map((l) => ({ l, c: costs.get(l.item_id) })).find(({ c }) => c?.before && c.unit_cost > c.before * 1.02);
      const waitingPo = pos.find((p) => poIds.includes(p.id) && ['DRAFT', 'PENDING_APPROVAL'].includes(p.status));
      let note;
      let tone = 'ok';
      if (riser && pctBefore - pct >= 0.5) {
        note = `Down from ${round(pctBefore, 1)}% — the supplier price, not the sale (${riser.c.supplier_name || 'supplier'} up ${round((riser.c.unit_cost / riser.c.before - 1) * 100, 1)}% on ${riser.l.name || riser.l.code})`;
        tone = pctBefore - pct >= 3 ? 'risk' : 'warn';
      } else if (discountOver.length && pctPolicy - pct >= 0.5) {
        const d = discountOver[0];
        note = `Would be ${round(pctPolicy, 1)}% at the ${round(d.policy_pct, 1)}% discount policy (${round(d.discount_pct, 1)}% given on ${d.name || d.code})`;
        tone = 'warn';
      } else if (waitingPo) {
        note = `Holds once ${waitingPo.po_number} is approved`;
      } else if (t && ['late', 'at_risk', 'uncovered'].includes(t.verdict)) {
        note = `${money(t.value_at_risk, cur)} of it is on lines that will not ship on time`;
        tone = 'warn';
      } else {
        note = 'At what each line actually costs to buy or make';
      }
      if (uncosted.length) note += ` · no cost on record for ${uncosted.join(', ')}`;
      margin = {
        pct: round(pct, 1), revenue: round(revenue), cost: round(cost), currency: cur, note, tone,
        basis: lines.filter((l) => costs.get(l.item_id)).map((l) => `${l.code || l.name}: ${money(costs.get(l.item_id).unit_cost, cur, 2)} (${costs.get(l.item_id).basis})`),
      };
      sources.push({ call: 'finance.order_margin', result: `${round(pct, 1)}% on ${money(revenue, cur)}` });
    } else {
      margin = { pct: null, note: 'No cost on record for the items on this order', tone: 'warn', currency: cur };
    }
  }

  /* Headline */
  const v = t ? VERDICT[t.verdict] : null;
  let headline;
  if (!t) {
    headline = trace?.note || `${so.so_number} is ${humanize(so.status)}.`;
  } else if (t.verdict === 'late') {
    headline = `${so.so_number} ships around ${shortDate(t.projected_date)}, ${t.days_late} day${t.days_late === 1 ? '' : 's'} after the ${shortDate(t.due_date)} promise. ${t.cause ? `Root cause: ${t.cause}.` : ''}`.trim();
  } else if (t.verdict === 'uncovered') {
    headline = `${so.so_number} cannot be filled from stock or anything on order. ${t.cause ? `${t.cause}.` : ''}`.trim();
  } else if (t.verdict === 'at_risk') {
    headline = `${so.so_number} still makes ${shortDate(t.due_date)}, but depends on supply that is already slipping. ${t.cause ? `${t.cause}.` : ''}`.trim();
  } else {
    headline = `${so.so_number} is ${t.verdict === 'covered' ? 'covered from stock' : 'on track'} for ${shortDate(t.due_date)}.`;
  }
  if (margin?.pct != null) headline += ` Margin ${margin.pct}%.`;
  if ((t && ['late', 'at_risk'].includes(t.verdict))) {
    proposals.push({ kind: 'plan_recovery', label: `See what would make ${so.so_number} hold its date, measured before anyone approves it`, tool: 'plan_delivery_recovery', args: { sales_order: so.so_number } });
  }

  return {
    sales_order: { id: so.id, so_number: so.so_number, status: so.status, customer_name: so.customer_name, total: num(so.total_amount), currency: cur, due_date: due },
    verdict: t?.verdict || null,
    verdict_label: v?.label || humanize(so.status),
    tone: v?.tone || 'ok',
    headline,
    chain,
    margin,
    lines: lines.map((l) => {
      const tl = traceLine(l);
      return {
        line_number: l.line_number, item: l.name || l.code, qty: l.qty, net: round(l.net), discount_pct: round(l.discount_pct, 1),
        policy_pct: l.policy_pct, verdict: tl?.verdict || null, projected_date: tl?.projected_date || null,
        unit_cost: seesMargins ? round(costs.get(l.item_id)?.unit_cost, 2) : undefined,
      };
    }),
    delivery: t ? { verdict: t.verdict, due_date: t.due_date, projected_date: t.projected_date, days_late: t.days_late, value_at_risk: t.value_at_risk, cause: t.cause, chain: t.chain } : null,
    proposals: [...new Map(proposals.map((p) => [p.label, p])).values()],
    sources,
    visibility: seesMargins ? 'full' : 'costs, supplier prices and margin are hidden for your role',
    method:
      'Customer credit is open receivables plus committed orders not yet invoiced, against the credit limit; payment days '
      + 'are weighted by allocated amount over the last year. Stock, supply and dates come from the delivery trace, which '
      + 'allocates stock across every open order in promised-date order. Cost is the covering purchase order\'s price, else '
      + 'the last price paid, else production or carried cost; a price counts as risen when it is over 2% above what was '
      + 'paid 90–365 days ago. Nothing was changed.',
  };
}

module.exports = { traceOrderChain };
