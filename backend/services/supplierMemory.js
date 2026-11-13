/**
 * "Nordbay is late again. What did we do last time?" — the company's memory
 * of its own supplier decisions.
 *
 * WHAT THIS ANSWERS
 * ---------------------------------------------------------------------------
 * Every time a supplier delivered late, something was decided — or nothing
 * was. Both are in the record, and this reads them back:
 *
 *   Episodes     purchase orders from the supplier that arrived (confirmed
 *                delivery, else first goods receipt) after their promised
 *                date, over the last two years.
 *   Response     what the company bought of the same items in the weeks after
 *                each one (from the promised date until 60 days on, or the
 *                next late delivery): a SPLIT (some to another supplier, some
 *                still to this one), a SWITCH (all elsewhere), STAYED (all
 *                with the same supplier) or NONE (nothing bought). It names
 *                the other supplier, its share, who raised and approved the
 *                order and any reason recorded on it (approval comments, the
 *                audit chain).
 *   Outcome      whether the response delivered: the other supplier's orders
 *                against their own promised date and their price against
 *                this supplier's — and, for every episode, the customer
 *                orders for those items that shipped after their promise.
 *   Today        open purchase lines from the supplier that are past their
 *                promised date, or that the delivery trace projects to land
 *                after it, and the customer orders waiting on them.
 *
 * From that it proposes what worked before: move the quantity the exposed
 * customer orders need (or the precedent's share) to the supplier that
 * delivered last time, priced from what the company last paid it, with the
 * cost impact against the late order. When nothing worked before, it says so
 * and names the alternative the catalogue offers instead.
 *
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It changes nothing. The split order comes back as a proposal carrying the
 * arguments for a DRAFT purchase order; a person drafts it, and the draft goes
 * through purchase approval (DoA, segregation of duties) like any other.
 * Customer orders are named only when the person asking may see them.
 */

const { pool } = require('../config/database');
const companyContext = require('./companyContext');
const { traceDeliveryRisk } = require('./deliveryRisk');
const { hasPermission } = require('../middleware/rbac');

const MEMORY_DAYS = 730;
const YEAR_DAYS = 365;
const WINDOW_DAYS = 60;
const PLACED_PO_EXCLUDED = ['DRAFT', 'CANCELLED', 'REJECTED'];
const OPEN_PO_STATUSES = [
  'PENDING_APPROVAL', 'APPROVED', 'SENT_TO_SUPPLIER', 'CONFIRMED', 'PREPARING_DELIVERY', 'IN_TRANSIT',
  'DELIVERED', 'GOODS_READY_FOR_RECEIPT', 'PARTIALLY_RECEIVED',
];
const SEES_ALL_ORDERS = new Set(['ADMIN', 'MANAGER', 'FINANCE_MANAGER']);
const AT_RISK = ['late', 'at_risk', 'uncovered'];
const DAY = 86400000;

const round = (v, p = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** p) / 10 ** p);
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const days = (a, b) => Math.round((new Date(a) - new Date(b)) / DAY);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const ordinal = (n) => ORDINAL[n - 1] || `${n}th`;
const shortDate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

function money(v, cur) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: cur || 'USD', maximumFractionDigits: 0 }).format(v || 0);
  } catch {
    return `${Math.round(v || 0)} ${cur || ''}`.trim();
  }
}

async function resolveCompany(companyId) {
  return companyId || companyContext.currentCompanyId() || (await companyContext.getDefaultCompanyId());
}

const ARRIVED = `COALESCE(po.delivery_confirmed_at::date,
                 (SELECT MIN(gr.received_date)::date FROM goods_receipts gr
                   WHERE gr.po_id = po.id AND gr.company_id = po.company_id))`;

/* ------------------------------------------------------------------ reads */

async function resolveSupplier(companyId, ref) {
  const text = String(ref).trim();
  const byId = /^[0-9a-f-]{36}$/i.test(text);
  const { rows } = await pool.query(
    `SELECT id, supplier_code, COALESCE(trade_name, legal_name) AS name, currency
       FROM suppliers
      WHERE company_id = $1
        AND (${byId ? 'id = $2::uuid' : 'supplier_code ILIKE $2 OR legal_name ILIKE $3 OR trade_name ILIKE $3'})
      ORDER BY ${byId ? 'id' : '(supplier_code ILIKE $2) DESC, legal_name'} LIMIT 1`,
    byId ? [companyId, text] : [companyId, text, `%${text}%`],
  );
  return rows[0] || null;
}

/** With no supplier named: the one whose open purchase order is most overdue. */
async function mostOverdueSupplier(companyId) {
  const { rows } = await pool.query(
    `SELECT s.id, s.supplier_code, COALESCE(s.trade_name, s.legal_name) AS name, s.currency
       FROM purchase_orders po
       JOIN purchase_order_line_items pol ON pol.po_id = po.id
       JOIN suppliers s ON s.id = po.supplier_id AND s.company_id = $1
      WHERE po.company_id = $1 AND po.status = ANY($2)
        AND pol.quantity - COALESCE(pol.quantity_received, 0) > 0
        AND COALESCE(pol.requested_delivery_date, po.delivery_date) < CURRENT_DATE
      ORDER BY COALESCE(pol.requested_delivery_date, po.delivery_date) LIMIT 1`,
    [companyId, OPEN_PO_STATUSES],
  );
  return rows[0] || null;
}

/** Orders placed with the supplier, with arrival and lines. */
async function readOrders(companyId, supplierId) {
  const { rows } = await pool.query(
    `SELECT po.id, po.po_number, po.po_date, po.delivery_date AS promised, po.currency, po.status,
            ${ARRIVED} AS arrived,
            COALESCE(json_agg(json_build_object(
              'item_id', pol.item_id, 'item_code', i.item_code, 'item_name', COALESCE(i.name, pol.item_description),
              'qty', pol.quantity::float, 'unit_price', pol.unit_price::float)) FILTER (WHERE pol.item_id IS NOT NULL), '[]') AS lines
       FROM purchase_orders po
       LEFT JOIN purchase_order_line_items pol ON pol.po_id = po.id
       LEFT JOIN items i ON i.id = pol.item_id AND i.company_id = po.company_id
      WHERE po.company_id = $1 AND po.supplier_id = $2
        AND po.po_date >= CURRENT_DATE - $3::int AND po.status <> ALL($4)
      GROUP BY po.id
      ORDER BY po.delivery_date NULLS LAST, po.po_number`,
    [companyId, supplierId, MEMORY_DAYS, PLACED_PO_EXCLUDED],
  );
  return rows;
}

/** Every placed order for these items in the span, from any supplier — the responses. */
async function readPurchasesOf(companyId, itemIds, from, to) {
  if (!itemIds.length) return [];
  const { rows } = await pool.query(
    `SELECT po.id, po.po_number, po.supplier_id, COALESCE(s.trade_name, s.legal_name) AS supplier_name,
            po.po_date, po.delivery_date AS promised, po.status, ${ARRIVED} AS arrived,
            pol.item_id, pol.quantity::float AS qty, pol.unit_price::float AS unit_price,
            NULLIF(TRIM(CONCAT(cu.first_name, ' ', cu.last_name)), '') AS raised_by,
            NULLIF(TRIM(CONCAT(au.first_name, ' ', au.last_name)), '') AS approved_by, po.approved_at
       FROM purchase_orders po
       JOIN purchase_order_line_items pol ON pol.po_id = po.id
       JOIN suppliers s ON s.id = po.supplier_id AND s.company_id = $1
       LEFT JOIN users cu ON cu.id = po.created_by
       LEFT JOIN users au ON au.id = po.approved_by
      WHERE po.company_id = $1 AND pol.item_id = ANY($2::uuid[]) AND po.status <> ALL($3)
        AND po.po_date BETWEEN $4::date AND $5::date
      ORDER BY po.po_date, po.po_number`,
    [companyId, itemIds, PLACED_PO_EXCLUDED, from, to],
  );
  return rows;
}

/** Reasons people recorded on these orders: approval comments and the audit chain. */
async function readNotes(companyId, poIds) {
  if (!poIds.length) return [];
  const { rows } = await pool.query(
    `SELECT ac.entity_id AS po_id, ac.reason AS text, ac.occurred_at AS at,
            NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS who
       FROM audit_chain ac LEFT JOIN users u ON u.id = ac.changed_by
      WHERE ac.company_id = $1 AND ac.entity_id = ANY($2::text[]) AND COALESCE(TRIM(ac.reason), '') <> ''
     UNION ALL
     SELECT ar.document_id::text, ars.comments, ars.decided_at,
            NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '')
       FROM approval_requests ar
       JOIN approval_request_steps ars ON ars.request_id = ar.id
       LEFT JOIN users u ON u.id = ars.decided_by
      WHERE ar.company_id = $1 AND ar.document_id::text = ANY($2::text[]) AND COALESCE(TRIM(ars.comments), '') <> ''
      ORDER BY 3`,
    [companyId, poIds],
  );
  return rows;
}

/** Customer order lines for these items promised in the span, and when they shipped. */
async function readCustomerLines(companyId, itemIds, from, to) {
  if (!itemIds.length) return [];
  const { rows } = await pool.query(
    `SELECT so.id, so.so_number, so.customer_name, so.created_by, ii.item_master_id AS item_id,
            COALESCE(soi.promised_delivery_date, soi.requested_delivery_date, so.delivery_date) AS promised,
            COALESCE((SELECT MIN(COALESCE(sh.delivery_date, sh.ship_date)) FROM shipments sh
                       WHERE sh.sales_order_id = so.id AND sh.company_id = so.company_id),
                     so.customer_delivery_confirmed_at::date) AS shipped
       FROM sales_orders so
       JOIN sales_order_items soi ON soi.sales_order_id = so.id
       JOIN inventory_items ii ON ii.id = soi.inventory_item_id AND ii.company_id = so.company_id
      WHERE so.company_id = $1 AND so.deleted_at IS NULL AND ii.item_master_id = ANY($2::uuid[])
        AND COALESCE(soi.promised_delivery_date, soi.requested_delivery_date, so.delivery_date) BETWEEN $3::date AND $4::date`,
    [companyId, itemIds, from, to],
  );
  return rows;
}

/** Open lines from the supplier: what is still to arrive and when it was promised. */
async function readOpenLines(companyId, supplierId) {
  const { rows } = await pool.query(
    `SELECT po.id AS po_id, po.po_number, po.currency, pol.item_id, i.item_code,
            COALESCE(i.name, pol.item_description) AS item_name, pol.unit_price::float AS unit_price,
            GREATEST(pol.quantity - COALESCE(pol.quantity_received, 0), 0)::float AS remaining,
            COALESCE(pol.requested_delivery_date, po.delivery_date) AS promised
       FROM purchase_orders po
       JOIN purchase_order_line_items pol ON pol.po_id = po.id
       LEFT JOIN items i ON i.id = pol.item_id AND i.company_id = po.company_id
      WHERE po.company_id = $1 AND po.supplier_id = $2 AND po.status = ANY($3)
        AND pol.quantity - COALESCE(pol.quantity_received, 0) > 0
      ORDER BY promised NULLS LAST, po.po_number`,
    [companyId, supplierId, OPEN_PO_STATUSES],
  );
  return rows;
}

/** Other active suppliers' catalogue entries for these items: price and lead time. */
async function readCatalogue(companyId, itemIds, excludeSupplierId) {
  if (!itemIds.length) return [];
  const { rows } = await pool.query(
    `SELECT ii.item_master_id AS item_id, si.supplier_id, COALESCE(s.trade_name, s.legal_name) AS supplier_name,
            si.unit_price::float AS unit_price, si.lead_time_days, si.is_preferred
       FROM supplier_items si
       JOIN inventory_items ii ON ii.id = si.item_id AND ii.company_id = $1
       JOIN suppliers s ON s.id = si.supplier_id AND s.company_id = $1
      WHERE si.company_id = $1 AND ii.item_master_id = ANY($2::uuid[]) AND si.supplier_id <> $3
        AND COALESCE(si.status, 'ACTIVE') = 'ACTIVE'
        AND COALESCE(s.status, 'ACTIVE') NOT IN ('INACTIVE', 'BLOCKED', 'REJECTED')
      ORDER BY si.is_preferred DESC NULLS LAST, si.unit_price NULLS LAST`,
    [companyId, itemIds, excludeSupplierId],
  );
  return rows;
}

/* ---------------------------------------------------------------- recall */

/**
 * @param {object} opts
 *   companyId, userId, role   who is asking (role decides which customer orders are named
 *                             and whether they can draft the split order)
 *   supplier                  by id, code or name; default: the one most overdue now
 */
async function recallSupplierPrecedent(opts = {}) {
  const companyId = await resolveCompany(opts.companyId);
  const supplier = opts.supplier ? await resolveSupplier(companyId, opts.supplier) : await mostOverdueSupplier(companyId);
  if (!supplier) {
    return { error: opts.supplier ? `No supplier ${opts.supplier} in this company.` : 'No supplier has a purchase order past its promised date. Name the supplier to read its history.' };
  }
  const seesAll = SEES_ALL_ORDERS.has(String(opts.role || '').toUpperCase()) || !opts.userId;
  const canSee = (o) => seesAll || !o.created_by || o.created_by === opts.userId;
  const where = supplier.name;
  const today = new Date(`${iso(new Date())}T00:00:00Z`);

  const [{ rows: [company] }, orders, openLines] = await Promise.all([
    pool.query('SELECT base_currency FROM companies WHERE id = $1', [companyId]),
    readOrders(companyId, supplier.id),
    readOpenLines(companyId, supplier.id),
  ]);
  const currency = supplier.currency || company?.base_currency || 'USD';

  // --- today: what from this supplier is late, or will land late ----------
  let trace = null;
  if (openLines.length) {
    trace = await traceDeliveryRisk({ companyId, userId: opts.userId, role: opts.role, horizonDays: 45, includeCovered: true });
  }
  const lands = new Map(); // po_id -> latest projected landing the trace gives it
  const waiting = new Map(); // po_id -> [{ order, qty, item_id }]
  for (const o of trace?.orders || []) {
    for (const l of o.lines || []) {
      for (const d of l.depends_on || []) {
        if (d.type !== 'purchase_order') continue;
        if (d.lands && (!lands.get(d.id) || d.lands > lands.get(d.id))) lands.set(d.id, d.lands);
        if (AT_RISK.includes(o.verdict)) waiting.set(d.id, [...(waiting.get(d.id) || []), { order: o, qty: d.qty, item_id: l.item_id }]);
      }
    }
  }
  const lateNow = [];
  for (const [poId, lines] of openLines.reduce((m, l) => m.set(l.po_id, [...(m.get(l.po_id) || []), l]), new Map())) {
    const promised = lines.reduce((m, l) => (l.promised && (!m || l.promised < m) ? l.promised : m), null);
    const projected = lands.get(poId) || null;
    const overdue = promised && new Date(promised) < today ? days(today, promised) : 0;
    const projectedLate = promised && projected ? Math.max(days(projected, promised), 0) : 0;
    if (!overdue && !projectedLate) continue;
    const exposed = [...new Map((waiting.get(poId) || []).map((w) => [w.order.sales_order_id, w.order])).values()];
    lateNow.push({
      po_id: poId,
      po_number: lines[0].po_number,
      currency: lines[0].currency || currency,
      promised: iso(promised),
      projected: projected || null,
      days_late: Math.max(overdue, projectedLate),
      days_overdue: overdue,
      state: overdue ? 'overdue' : 'projected_late',
      lines,
      waiting: waiting.get(poId) || [],
      orders_exposed: exposed.map((o) => ({
        sales_order_id: o.sales_order_id, so_number: o.so_number, customer_name: o.customer_name,
        due_date: o.due_date, projected_date: o.projected_date, verdict: o.verdict, value_at_risk: o.value_at_risk,
      })),
      value_at_risk: round(exposed.reduce((s, o) => s + (o.value_at_risk || 0), 0)),
    });
  }
  lateNow.sort((a, b) => b.value_at_risk - a.value_at_risk || b.days_late - a.days_late);
  const current = lateNow[0] || null;

  // --- episodes: every late delivery in memory ----------------------------
  const episodes = orders
    .filter((o) => o.arrived && o.promised && new Date(o.arrived) > new Date(o.promised))
    .map((o) => ({ ...o, days_late: days(o.arrived, o.promised) }));
  const delivered = orders.filter((o) => o.arrived && o.promised);
  const yearAgo = new Date(today - YEAR_DAYS * DAY);
  const ordersLastYear = orders.filter((o) => new Date(o.po_date) >= yearAgo).length;
  const lateLastYear = episodes.filter((e) => new Date(e.promised) >= yearAgo).length;

  const itemIds = [...new Set([
    ...episodes.flatMap((e) => e.lines.map((l) => l.item_id)),
    ...(current ? current.lines.map((l) => l.item_id) : []),
  ].filter(Boolean))];
  const first = episodes[0]?.promised || iso(today);
  const span = [iso(first), iso(new Date(today.getTime() + WINDOW_DAYS * DAY))];
  const [purchases, customerLines, catalogue] = await Promise.all([
    readPurchasesOf(companyId, itemIds, span[0], span[1]),
    readCustomerLines(companyId, itemIds, span[0], span[1]),
    readCatalogue(companyId, itemIds, supplier.id),
  ]);
  const episodeIds = new Set(orders.map((o) => o.id));

  const memory = episodes.map((e, idx) => {
    const items = new Set(e.lines.map((l) => l.item_id));
    const start = new Date(e.promised);
    const nextLate = episodes[idx + 1] ? new Date(episodes[idx + 1].promised) : null;
    const end = new Date(Math.min(start.getTime() + WINDOW_DAYS * DAY, nextLate ? nextLate.getTime() - DAY : Infinity));
    const inWindow = purchases.filter((p) => items.has(p.item_id) && p.id !== e.id
      && new Date(p.po_date) >= start && new Date(p.po_date) <= end);
    const same = inWindow.filter((p) => p.supplier_id === supplier.id);
    const alt = inWindow.filter((p) => p.supplier_id !== supplier.id);
    const altQty = alt.reduce((s, p) => s + p.qty, 0);
    const sameQty = same.reduce((s, p) => s + p.qty, 0);
    const kind = alt.length && same.length ? 'split' : alt.length ? 'switched' : same.length ? 'stayed' : 'none';

    // The other supplier this episode leaned on most, and how it did.
    const altBy = alt.reduce((m, p) => m.set(p.supplier_id, [...(m.get(p.supplier_id) || []), p]), new Map());
    const [altId, altLines] = [...altBy.entries()].sort((a, b) => b[1].reduce((s, p) => s + p.qty, 0) - a[1].reduce((s, p) => s + p.qty, 0))[0] || [];
    const altPos = [...new Map((altLines || []).map((p) => [p.id, p])).values()].map((p) => {
      const ref = e.lines.find((l) => l.item_id === p.item_id);
      return {
        po_id: p.id,
        po_number: p.po_number,
        item_id: p.item_id,
        qty: p.qty,
        unit_price: p.unit_price,
        premium_pct: ref?.unit_price ? round(((p.unit_price - ref.unit_price) / ref.unit_price) * 100, 1) : null,
        promised: iso(p.promised),
        arrived: iso(p.arrived),
        lead_days: p.arrived ? days(p.arrived, p.po_date) : null,
        days_late: p.arrived && p.promised ? Math.max(days(p.arrived, p.promised), 0) : null,
        raised_by: p.raised_by,
        approved_by: p.approved_by,
      };
    });
    const arrivedAlt = altPos.filter((p) => p.arrived);
    const altOnTime = arrivedAlt.length ? arrivedAlt.every((p) => p.days_late === 0) : null;

    // Customer orders for these items, promised while the goods were late, that shipped after the promise.
    const slipEnd = new Date(new Date(e.arrived).getTime() + 7 * DAY);
    const slipped = [...new Map(customerLines
      .filter((c) => items.has(c.item_id) && new Date(c.promised) >= start && new Date(c.promised) <= slipEnd
        && c.shipped && new Date(c.shipped) > new Date(c.promised))
      .map((c) => [c.id, c])).values()];
    const named = slipped.filter(canSee).map((c) => ({ sales_order_id: c.id, so_number: c.so_number, customer_name: c.customer_name, days_late: days(c.shipped, c.promised) }));

    const worked = kind === 'split' || kind === 'switched' ? altOnTime : slipped.length ? false : null;
    const who = altPos[0]?.raised_by || altPos[0]?.approved_by;
    const premium = altPos.find((p) => p.premium_pct != null)?.premium_pct;
    const altName = altLines?.[0]?.supplier_name;
    const share = altQty + sameQty ? round((altQty / (altQty + sameQty)) * 100, 0) : null;
    const lead = arrivedAlt[0]?.lead_days;
    let did;
    if (kind === 'split') did = `${who || 'The team'} split the next order ${share}% to ${altName} (${altPos.map((p) => p.po_number).join(', ')})`;
    else if (kind === 'switched') did = `${who || 'The team'} moved the next order to ${altName} (${altPos.map((p) => p.po_number).join(', ')})`;
    else if (kind === 'stayed') did = `No change — the next order went to ${where} again (${[...new Set(same.map((p) => p.po_number))].join(', ')})`;
    else did = 'No action taken';
    const outcome = kind === 'split' || kind === 'switched'
      ? (altOnTime == null ? `${altName} has not delivered yet`
        : `${altOnTime ? 'delivered' : 'also late,'}${lead != null ? ` in ${plural(lead, 'day')}` : ''}${premium != null ? ` at ${premium >= 0 ? '+' : ''}${premium}%` : ''}`)
      : slipped.length ? `${plural(slipped.length, 'customer order')} shipped late${named.length ? ` (${named.slice(0, 3).map((n) => n.so_number).join(', ')})` : ''}`
        : 'no customer order shipped late';

    return {
      po_id: e.id,
      po_number: e.po_number,
      promised: iso(e.promised),
      arrived: iso(e.arrived),
      days_late: e.days_late,
      items: e.lines.map((l) => ({ item_id: l.item_id, item_code: l.item_code, name: l.item_name, qty: l.qty, unit_price: l.unit_price })),
      response: {
        kind,
        alternative_supplier_id: altId || null,
        alternative_supplier: altName || null,
        alternative_share_pct: kind === 'split' || kind === 'switched' ? share : null,
        alternative_orders: altPos,
      },
      customer_orders_late: slipped.length,
      customer_orders_named: named,
      worked,
      tone: worked === true ? 'ok' : worked === false ? 'warn' : 'ink',
      text: `${e.po_number} arrived ${plural(e.days_late, 'day')} late. ${did}${kind === 'none' || kind === 'stayed' ? ';' : ' —'} ${outcome}.`,
      when: iso(e.arrived),
      record: { type: 'purchase_order', id: e.id, number: e.po_number },
    };
  });

  const notes = await readNotes(companyId, [...new Set([
    ...memory.map((m) => m.po_id),
    ...memory.flatMap((m) => m.response.alternative_orders.map((p) => p.po_id)),
  ])]);
  for (const m of memory) {
    const ids = new Set([m.po_id, ...m.response.alternative_orders.map((p) => p.po_id)]);
    m.decisions = notes.filter((n) => ids.has(n.po_id)).map((n) => ({ text: n.text, who: n.who, at: n.at }));
  }

  // --- what to do now -----------------------------------------------------
  const precedent = [...memory].reverse().find((m) => m.worked === true && m.response.alternative_supplier_id) || null;
  const unanswered = [...memory].reverse().find((m) => m.worked === false && ['none', 'stayed'].includes(m.response.kind)) || null;
  const canDraft = !opts.role || hasPermission(String(opts.role).toUpperCase(), 'PROCUREMENT_WRITE');
  const proposals = [];
  let recommendation = null;

  if (current) {
    // The line to move: one the precedent's supplier has delivered before, else the most exposed.
    const precedentItems = new Set(precedent ? precedent.response.alternative_orders.map((p) => p.item_id) : []);
    const line = current.lines.find((l) => precedentItems.has(l.item_id))
      || [...current.lines].sort((a, b) => current.waiting.filter((w) => w.item_id === b.item_id).length - current.waiting.filter((w) => w.item_id === a.item_id).length)[0];
    const needed = current.waiting.filter((w) => w.item_id === line.item_id).reduce((s, w) => s + (w.qty || 0), 0);

    let alt = null;
    if (precedent) {
      const last = [...purchases].reverse().find((p) => p.supplier_id === precedent.response.alternative_supplier_id && p.item_id === line.item_id);
      const cat = catalogue.find((c) => c.supplier_id === precedent.response.alternative_supplier_id && c.item_id === line.item_id);
      const prior = precedent.response.alternative_orders.find((p) => p.lead_days != null);
      alt = {
        supplier_id: precedent.response.alternative_supplier_id,
        name: precedent.response.alternative_supplier,
        unit_price: last?.unit_price ?? cat?.unit_price ?? null,
        lead_days: cat?.lead_time_days ?? prior?.lead_days ?? null,
        why: `as on ${precedent.po_number}, ${shortDate(precedent.arrived)}`,
      };
    } else {
      const cat = catalogue.find((c) => c.item_id === line.item_id);
      if (cat) alt = { supplier_id: cat.supplier_id, name: cat.supplier_name, unit_price: cat.unit_price, lead_days: cat.lead_time_days, why: 'no precedent; from the supplier catalogue' };
    }

    const share = precedent?.response.alternative_share_pct || 50;
    const qty = Math.min(line.remaining, Math.ceil(needed > 0 ? needed : line.remaining * (share / 100)));
    if (alt && qty > 0) {
      const price = alt.unit_price ?? line.unit_price;
      const impact = round(qty * (price - line.unit_price));
      const arrives = alt.lead_days != null ? iso(new Date(today.getTime() + alt.lead_days * DAY)) : null;
      const saves = current.orders_exposed.filter((o) => !arrives || !o.due_date || arrives <= o.due_date);
      recommendation = {
        kind: 'split_order',
        text: `${precedent ? `Repeat what worked ${precedent.response.kind === 'split' ? 'last time' : 'before'}: move` : 'Nothing worked before to repeat. Move'} `
          + `${qty} × ${line.item_code || line.item_name} to ${alt.name}. Cost impact ${impact >= 0 ? '+' : '−'}${money(Math.abs(impact), current.currency)}`
          + `${saves.length ? `; ${saves.slice(0, 2).map((o) => o.so_number).join(', ')} ${saves.length === 1 ? 'ships' : 'ship'} on time` : ''}`
          + `${arrives ? ` (arrives around ${arrives})` : ''}.`,
        supplier_id: alt.supplier_id,
        supplier: alt.name,
        item_id: line.item_id,
        item: line.item_code || line.item_name,
        quantity: qty,
        unit_price: price,
        current_unit_price: line.unit_price,
        cost_impact: impact,
        expected_delivery_date: arrives,
        against: { type: 'purchase_order', id: current.po_id, number: current.po_number },
        precedent: precedent ? { type: 'purchase_order', id: precedent.po_id, number: precedent.po_number, date: precedent.arrived } : null,
        orders_kept: saves.map((o) => o.so_number),
      };
      proposals.push({
        kind: 'split_order',
        label: `Draft the split order: ${qty} × ${line.item_code || line.item_name} from ${alt.name} (${alt.why})`,
        can_draft: canDraft,
        tool: 'create_purchase_order_draft',
        args: {
          supplier_id: alt.supplier_id,
          currency: current.currency,
          expected_delivery_date: arrives,
          notes: `Split from ${current.po_number} (${where}, ${current.state === 'overdue' ? `${plural(current.days_overdue, 'day')} overdue` : `projected ${plural(current.days_late, 'day')} late`})${precedent ? `; precedent ${precedent.po_number}, ${precedent.arrived}` : ''}. Reduce ${current.po_number} by ${qty} once approved.`,
          items: [{ item_id: line.item_id, description: line.item_name || line.item_code, quantity: qty, unit_price: price }],
        },
      });
    }
    proposals.push({ kind: 'chase_supplier', label: `Chase ${where} on ${current.po_number} for a firm delivery date`, record: { type: 'purchase_order', id: current.po_id, number: current.po_number } });
    for (const o of current.orders_exposed.filter(canSee).filter((x) => !recommendation?.orders_kept.includes(x.so_number)).slice(0, 2)) {
      proposals.push({ kind: 'tell_customer', label: `Tell ${o.customer_name} ${o.so_number} is at risk before ${o.due_date}`, record: { type: 'sales_order', id: o.sales_order_id, number: o.so_number } });
    }
  }

  const n = lateLastYear + (current && !episodes.some((e) => e.id === current.po_id) ? 1 : 0);
  const lesson = precedent
    ? ` Last time, ${precedent.response.kind === 'split' ? 'splitting the order' : `moving it to ${precedent.response.alternative_supplier}`} worked.`
    : unanswered ? ` Last time nothing changed and ${plural(unanswered.customer_orders_late, 'customer order')} shipped late.`
      : memory.length ? ' Nothing on record has fixed it yet.' : '';
  const headline = current
    ? `${current.po_number} from ${where} is ${current.state === 'overdue' ? `${plural(current.days_overdue, 'day')} overdue` : `projected ${plural(current.days_late, 'day')} late`}: the ${ordinal(Math.max(n, 1))} late delivery in twelve months.${lesson}`
    : memory.length
      ? `Nothing from ${where} is late right now. ${plural(lateLastYear, 'late delivery', 'late deliveries')} in twelve months.${lesson}`
      : `${where} has no late delivery on record${delivered.length ? ` across ${plural(delivered.length, 'delivered order')}` : ''}.`;

  const timeline = memory.slice(-5).map((m) => ({ when: m.when, text: m.text, tone: m.tone, record: m.record }));
  if (current) {
    const kept = current.orders_exposed.filter(canSee);
    timeline.push({
      when: iso(today),
      text: `${current.po_number} is ${current.state === 'overdue' ? `${plural(current.days_overdue, 'day')} past its promised ${current.promised}${current.projected && current.days_late > current.days_overdue ? `, projected to land ${current.projected}` : ''}` : `projected to land ${current.projected}, ${plural(current.days_late, 'day')} after its promised ${current.promised}`}.`
        + `${current.orders_exposed.length ? ` ${kept.length ? kept.slice(0, 2).map((o) => o.so_number).join(', ') : plural(current.orders_exposed.length, 'customer order')} ${current.orders_exposed.length === 1 ? 'is' : 'are'} exposed.` : ''}`,
      tone: 'risk',
      record: { type: 'purchase_order', id: current.po_id, number: current.po_number },
    });
  }

  return {
    as_of: new Date().toISOString(),
    supplier: { id: supplier.id, code: supplier.supplier_code, name: where },
    currency,
    scope: seesAll ? 'all company orders' : 'orders you created',
    headline,
    record: {
      orders_last_year: ordersLastYear,
      late_last_year: lateLastYear,
      delivered: delivered.length,
      late_on_record: episodes.length,
    },
    current: current ? {
      po_id: current.po_id, po_number: current.po_number, promised: current.promised, projected: current.projected,
      days_late: current.days_late, days_overdue: current.days_overdue, state: current.state, value_at_risk: current.value_at_risk,
      orders_exposed: current.orders_exposed.filter(canSee),
      orders_exposed_count: current.orders_exposed.length,
    } : null,
    also_late: lateNow.slice(1).map((l) => ({ po_id: l.po_id, po_number: l.po_number, days_late: l.days_late, state: l.state })),
    memory,
    timeline,
    precedent: precedent ? { po_number: precedent.po_number, date: precedent.arrived, kind: precedent.response.kind, supplier: precedent.response.alternative_supplier } : null,
    recommendation,
    proposals,
    can_draft: canDraft,
    method:
      `Late deliveries are orders from ${where} placed in the last ${MEMORY_DAYS} days that arrived (confirmed delivery, else first goods receipt) after the promised date. `
      + `A response is what was bought of the same items from the promised date until ${WINDOW_DAYS} days on or the next late delivery: split, switched, stayed or none. `
      + 'It worked when the other supplier delivered on its own promised date; doing nothing failed when customer orders for those items shipped after their promise. '
      + 'Today\'s lateness is open lines past their promised date or projected past it by the delivery trace. The split quantity is what the exposed customer orders need '
      + 'from that purchase order (else the precedent\'s share), priced at what the company last paid the other supplier. Nothing was changed.',
  };
}

module.exports = { recallSupplierPrecedent };
