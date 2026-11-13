/**
 * "Can we ship SO-24117 to Halden Marine on Thursday?" — answered from the record.
 *
 * WHAT THIS ANSWERS
 * ---------------------------------------------------------------------------
 * One promise, one date: a customer order (committed or still a draft), a
 * quotation, or a few items someone is about to promise, against the day the
 * customer wants it. For each line: how many are needed, how many are free on
 * that day, how many are short, and the first day it can go in full. For what
 * is short: free stock at another site, and the supplier who can bring it in
 * time — the lead time that supplier actually achieved on this company's
 * orders, the price last paid — with the purchase order ready to draft and who
 * it routes to.
 *
 * HOW
 * ---------------------------------------------------------------------------
 * The delivery trace (services/deliveryRisk.js) does the allocation, so the
 * answer is the same one the delivery-risk screen and Simeli give: stock in
 * promised-date order across the whole company, then open work orders and
 * purchase lines, each projected from its supplier's or work centre's own
 * record. A committed order is read where it stands. Anything not yet
 * committed — a draft, a quotation, a request — is assumed and served LAST,
 * after every order already promised in the next 60 days, so the answer never
 * takes stock another customer is holding. Suppliers come from the
 * replenishment read (services/replenishmentPlan.js).
 *
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It changes nothing. The purchase order comes back as a proposal carrying the
 * arguments for create_purchase_order_draft; a person drafts it and it goes
 * through purchase approval. Company-scoped: every read filters on the
 * company. A role that sees only its own orders is refused someone else's;
 * supplier prices and order values only reach roles that see margins.
 */

const { pool } = require('../config/database');
const companyContext = require('./companyContext');
const { traceDeliveryRisk } = require('./deliveryRisk');
const { planReplenishment, resolveItem, readRouting } = require('./replenishmentPlan');
const { SEES_MARGINS } = require('./marginDrivers');
const { hasPermission } = require('../middleware/rbac');

const SEES_ALL_ORDERS = new Set(['ADMIN', 'MANAGER', 'FINANCE_MANAGER']);
const COMMITTED = new Set(['PENDING_APPROVAL', 'APPROVED', 'SENT_TO_CUSTOMER', 'CONFIRMED', 'CUSTOMER_ACCEPTED', 'IN_PRODUCTION']);
const HORIZON = 60;
const DAY = 86400000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const today = () => new Date(`${iso(new Date())}T00:00:00Z`);
const addDays = (d, n) => new Date(d.getTime() + n * DAY);
const days = (from, to) => Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / DAY);
const round = (v, p = 3) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10 ** p) / 10 ** p);
const fmtQty = (v) => new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(v || 0);
const shortDate = (d) => (d ? new Date(`${iso(d)}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : null);
function money(v, cur, digits = 0) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: cur || 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v || 0);
  } catch {
    return `${Number(v || 0).toFixed(digits)} ${cur || ''}`.trim();
  }
}

async function resolveCompany(companyId) {
  return companyId || companyContext.currentCompanyId() || (await companyContext.getDefaultCompanyId());
}

/** "2026-11-05", "thursday", "on Friday", "tomorrow", "today", "in 5 days", "next week". */
function parseDate(text) {
  if (!text) return null;
  const t = String(text).trim().toLowerCase();
  const m = t.match(/\d{4}-\d{2}-\d{2}/);
  if (m) return m[0];
  const base = today();
  if (/\btoday\b|\bnow\b/.test(t)) return iso(base);
  if (/\btomorrow\b/.test(t)) return iso(addDays(base, 1));
  const inDays = t.match(/in\s+(\d+)\s+day/);
  if (inDays) return iso(addDays(base, Number(inDays[1])));
  const inWeeks = t.match(/in\s+(\d+)\s+week/);
  if (inWeeks) return iso(addDays(base, Number(inWeeks[1]) * 7));
  if (/next week/.test(t)) return iso(addDays(base, 7));
  const wd = WEEKDAYS.findIndex((w) => t.includes(w) || t.includes(w.slice(0, 3)));
  if (wd >= 0) {
    let delta = (wd - base.getUTCDay() + 7) % 7;
    if (/next\s/.test(t) && delta < 7) delta += delta === 0 ? 7 : 0;
    return iso(addDays(base, delta));
  }
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? undefined : iso(d);
}

/* ------------------------------------------------------------------ what is being promised */

async function readSalesOrder(companyId, ref) {
  const isUuid = /^[0-9a-f-]{36}$/i.test(String(ref));
  const { rows: [so] } = await pool.query(
    `SELECT id, so_number, status, customer_id, customer_name, currency, delivery_date, created_by, ship_from_location_id
       FROM sales_orders WHERE company_id = $1 AND deleted_at IS NULL AND ${isUuid ? 'id = $2::uuid' : 'so_number ILIKE $2'} LIMIT 1`,
    [companyId, String(ref).trim()],
  );
  if (!so) return null;
  const { rows: lines } = await pool.query(
    `SELECT soi.line_number, soi.item_code, soi.item_name,
            COALESCE(ii.item_master_id, (SELECT i.id FROM items i WHERE i.company_id = $2 AND i.item_code = soi.item_code LIMIT 1)) AS item_id,
            (soi.quantity - COALESCE(soi.quantity_delivered, 0))::float AS qty,
            CASE WHEN soi.quantity > 0 THEN (COALESCE(soi.line_total, soi.quantity * soi.unit_price) / soi.quantity)::float ELSE 0 END AS unit_value,
            COALESCE(soi.promised_delivery_date, soi.requested_delivery_date, $3::date) AS due
       FROM sales_order_items soi
       LEFT JOIN inventory_items ii ON ii.id = soi.inventory_item_id AND ii.company_id = $2
      WHERE soi.sales_order_id = $1 AND soi.quantity - COALESCE(soi.quantity_delivered, 0) > 0
      ORDER BY soi.line_number`,
    [so.id, companyId, so.delivery_date],
  );
  return { kind: 'sales_order', id: so.id, number: so.so_number, status: so.status, customer_id: so.customer_id, customer_name: so.customer_name,
    currency: so.currency, created_by: so.created_by, site_id: so.ship_from_location_id, own_date: iso(so.delivery_date),
    committed: COMMITTED.has(so.status), lines: lines.map((l) => ({ ...l, due: iso(l.due) })) };
}

async function readQuotation(companyId, ref) {
  const isUuid = /^[0-9a-f-]{36}$/i.test(String(ref));
  const { rows: [q] } = await pool.query(
    `SELECT id, quotation_number, status, customer_id, customer_name, currency, created_by
       FROM sales_quotations WHERE company_id = $1 AND deleted_at IS NULL AND ${isUuid ? 'id = $2::uuid' : 'quotation_number ILIKE $2'} LIMIT 1`,
    [companyId, String(ref).trim()],
  );
  if (!q) return null;
  const { rows: lines } = await pool.query(
    `SELECT sqi.line_number, sqi.item_code, sqi.item_name,
            COALESCE(ii.item_master_id, (SELECT i.id FROM items i WHERE i.company_id = $2 AND i.item_code = sqi.item_code LIMIT 1)) AS item_id,
            sqi.quantity::float AS qty,
            CASE WHEN sqi.quantity > 0 THEN (sqi.line_total / sqi.quantity)::float ELSE 0 END AS unit_value,
            sqi.estimated_delivery_date AS due
       FROM sales_quotation_items sqi
       LEFT JOIN inventory_items ii ON ii.id = sqi.inventory_item_id AND ii.company_id = $2
      WHERE sqi.sales_quotation_id = $1
      ORDER BY sqi.line_number`,
    [q.id, companyId],
  );
  const own = lines.map((l) => iso(l.due)).filter(Boolean).sort()[0] || null;
  return { kind: 'quotation', id: q.id, number: q.quotation_number, status: q.status, customer_id: q.customer_id, customer_name: q.customer_name,
    currency: q.currency, created_by: q.created_by, site_id: null, own_date: own, committed: false,
    lines: lines.map((l) => ({ ...l, due: iso(l.due) })) };
}

async function readRequest(companyId, items, customer) {
  const lines = [];
  const unknown = [];
  for (const [i, it] of items.entries()) {
    const item = await resolveItem(companyId, it.item);
    if (!item) { unknown.push(it.item); continue; }
    lines.push({ line_number: i + 1, item_code: item.item_code, item_name: item.name, item_id: item.id, qty: Number(it.quantity) || 0, unit_value: 0, due: null });
  }
  let cust = null;
  if (customer) {
    const { rows } = await pool.query(
      `SELECT id, customer_name AS name, currency FROM customers
        WHERE company_id = $1 AND customer_name ILIKE $2 ORDER BY customer_name LIMIT 1`,
      [companyId, `%${String(customer).trim()}%`],
    );
    cust = rows[0] || null;
  }
  return { kind: 'request', id: null, number: 'the request', status: null, customer_id: cust?.id || null, customer_name: cust?.name || customer || null,
    currency: cust?.currency || null, created_by: null, site_id: null, own_date: null, committed: false, lines, unknown };
}

/* ------------------------------------------------------------------ main */

async function checkPromise(opts = {}) {
  const companyId = await resolveCompany(opts.companyId);
  const role = String(opts.role || '').toUpperCase();
  const seesMargins = !role || SEES_MARGINS.has(role);
  const seesAll = !role || !opts.userId || SEES_ALL_ORDERS.has(role);

  let subject;
  if (opts.salesOrder) subject = await readSalesOrder(companyId, opts.salesOrder);
  else if (opts.quotation) subject = await readQuotation(companyId, opts.quotation);
  else if (opts.items?.length) subject = await readRequest(companyId, opts.items, opts.customer);
  else return { error: 'Name a sales order, a quotation, or the items and quantities to promise.' };
  if (!subject) return { error: `No ${opts.salesOrder ? `sales order ${opts.salesOrder}` : `quotation ${opts.quotation}`} in this company.` };
  if (!seesAll && subject.created_by && subject.created_by !== opts.userId) {
    return { error: `${subject.number} belongs to someone else's book, and your role only sees your own orders.` };
  }
  if (subject.unknown?.length && !subject.lines.length) return { error: `No item matching ${subject.unknown.map((u) => `"${u}"`).join(', ')} in this company.` };
  if (!subject.lines.length) return { error: `${subject.number} has nothing left to ship.` };

  const parsed = parseDate(opts.date);
  if (parsed === undefined) return { error: `"${opts.date}" is not a date I can read — give YYYY-MM-DD or a weekday.` };
  const asOf = iso(today());
  const date = parsed || subject.own_date || asOf;
  if (date < asOf) return { error: `${shortDate(date)} has already passed.` };

  // The trace: a committed order where it stands; anything else assumed and served last.
  const assumedId = subject.kind === 'sales_order' ? subject.id : `assumed:${subject.kind}:${subject.id || 'request'}`;
  const trace = await traceDeliveryRisk({
    companyId,
    userId: opts.userId,
    role: opts.role,
    horizonDays: HORIZON,
    includeCovered: true,
    salesOrder: subject.committed ? subject.id : (subject.kind === 'sales_order' ? subject.id : null),
    assume: subject.committed ? undefined : {
      demand: {
        sales_order_id: assumedId, so_number: subject.number, customer_id: subject.customer_id, customer_name: subject.customer_name,
        currency: subject.currency, site_id: subject.site_id,
        lines: subject.lines.map((l) => ({ ...l, due: date })),
      },
    },
  });
  if (trace.error) return { error: trace.error };
  const order = trace.orders?.find((o) => o.sales_order_id === assumedId) || trace.orders?.[0];
  if (!order) return { error: trace.note || `${subject.number} has nothing left to ship.` };
  const currency = order.currency || subject.currency || null;

  // Per line: free on the day, short on the day, first day in full.
  const lines = order.lines.map((l) => {
    const landed = (l.depends_on || []).filter((d) => d.lands && d.lands <= date).reduce((s, d) => s + d.qty, 0);
    const ready = round(Math.min(l.open_qty, l.from_stock + landed));
    const short = round(Math.max(l.open_qty - ready, 0));
    const earliest = l.uncovered > 0 ? null : (l.from_stock >= l.open_qty ? asOf : (l.depends_on || []).reduce((m, d) => (!m || (d.lands && d.lands > m) ? d.lands : m), null));
    return {
      line_number: l.line_number, item_id: l.item_id, item: l.item, needed: l.open_qty, from_stock: l.from_stock,
      arriving_in_time: round(landed), ready_by_date: ready, short, earliest_in_full: earliest,
      ship_from: l.ship_from, elsewhere: l.elsewhere || [],
      depends_on: l.depends_on, verdict: short > 0 ? (ready > 0 ? 'partial' : 'short') : 'ready',
    };
  });
  const needed = lines.reduce((s, l) => s + l.needed, 0);
  const ready = lines.reduce((s, l) => s + l.ready_by_date, 0);
  const shortLines = lines.filter((l) => l.short > 0);
  const verdict = !shortLines.length ? 'yes' : ready > 0 ? 'partial' : 'no';
  const earliestAll = lines.some((l) => !l.earliest_in_full) ? null : lines.reduce((m, l) => (l.earliest_in_full > m ? l.earliest_in_full : m), asOf);

  // The fix for each short line: another site, then the supplier who lands in time.
  const canDraft = !role || hasPermission(role, 'PROCUREMENT_WRITE');
  const fixes = [];
  const proposals = [];
  const read = [
    { call: 'sales.order_lines', result: `${subject.number} · ${lines.length} line${lines.length === 1 ? '' : 's'} · ${fmtQty(needed)} to ship` },
    { call: 'inventory.stock_levels', result: `${fmtQty(lines.reduce((s, l) => s + l.from_stock, 0))} free after earlier orders` },
  ];
  for (const l of shortLines) {
    const fix = { line_number: l.line_number, item: l.item, short: l.short, transfer: null, supplier: null };
    const site = l.elsewhere.find((e) => e.free > 0);
    if (site) {
      fix.transfer = { from: site, qty: round(Math.min(site.free, l.short)) };
      proposals.push({
        kind: 'transfer_stock',
        label: `Move ${fmtQty(fix.transfer.qty)} × ${l.item} from ${site.name} (${site.code})${l.ship_from ? ` to ${l.ship_from.name}` : ''}`,
        tool: subject.committed ? 'plan_delivery_recovery' : null,
      });
    }
    const plan = l.item_id ? await planReplenishment({ companyId, userId: opts.userId, role: opts.role, item: l.item_id }).catch(() => null) : null;
    const suppliers = (plan?.suppliers || []).filter((s) => s.lead_days != null);
    const gap = days(asOf, date);
    const inTime = suppliers.filter((s) => s.lead_days <= gap)
      .sort((a, b) => (a.unit_price ?? Infinity) - (b.unit_price ?? Infinity) || a.lead_days - b.lead_days);
    const pick = inTime[0] || [...suppliers].sort((a, b) => a.lead_days - b.lead_days)[0] || null;
    if (pick) {
      const lands = iso(addDays(today(), pick.lead_days));
      const rec = plan?.recommendation?.supplier_id === pick.supplier_id ? plan.recommendation.quantity : 0;
      // A committed order is already in the replenishment demand; anything else comes on top of it.
      let qty = Math.ceil(subject.committed ? Math.max(l.short, rec || 0) : l.short + (rec || 0));
      if (pick.moq && qty < pick.moq) qty = pick.moq;
      const value = pick.unit_price != null ? Math.round(qty * pick.unit_price * 100) / 100 : null;
      const routing = value ? await readRouting(companyId, value, opts.userId).catch(() => null) : null;
      const routedTo = routing?.holder
        ? (routing.holder.user_name || routing.holder.user_email)
        : routing?.steps?.length ? `${routing.steps.join(' → ')} (approval chain)` : null;
      const cur = pick.currency || currency;
      fix.supplier = {
        supplier_id: pick.supplier_id, name: pick.name, lead_days: pick.lead_days, lead_basis: pick.lead_basis,
        on_time_pct: pick.on_time_pct, lands, in_time: lands <= date, quantity: qty,
        restocks: qty > l.short ? round(qty - l.short) : 0,
        unit_price: seesMargins ? pick.unit_price : undefined, value: seesMargins ? value : undefined, currency: cur,
        routed_to: routedTo,
      };
      read.push({ call: 'procurement.supplier_terms', result: [pick.name, `${pick.lead_days} days (${pick.lead_basis || 'catalogue'})`, seesMargins && pick.unit_price != null ? money(pick.unit_price, cur, 2) : null].filter(Boolean).join(' · ') });
      proposals.push({
        kind: 'purchase_order',
        label: `Prepare purchase order: ${fmtQty(qty)} × ${l.item} from ${pick.name}${seesMargins && value != null ? ` (${money(value, cur)})` : ''}, landing ${shortDate(lands)}${lands <= date ? '' : ` — after ${shortDate(date)}`}`,
        can_draft: canDraft,
        tool: 'create_purchase_order_draft',
        args: {
          supplier_id: pick.supplier_id,
          currency: cur || undefined,
          expected_delivery_date: lands,
          notes: `Covers ${fmtQty(l.short)} short on ${subject.number}${subject.customer_name ? ` for ${subject.customer_name}` : ''}, wanted ${date}`
            + `${qty > l.short ? `; the other ${fmtQty(qty - l.short)} restock` : ''}. ${pick.name} lead time ${pick.lead_days} days (${pick.lead_basis || 'catalogue'}).`
            + `${routedTo ? ` Routed to ${routedTo}.` : ''} Raised from the promise check.`,
          items: [{ item_id: l.item_id, description: l.item, quantity: qty, unit_price: seesMargins && pick.unit_price != null ? pick.unit_price : undefined }],
        },
      });
    } else {
      proposals.push({
        kind: 'raise_requisition',
        label: `No supplier has a lead time on record for ${l.item} — draft a requisition for ${fmtQty(l.short)}`,
        tool: 'create_purchase_requisition_draft',
        args: { title: `${subject.number}: ${fmtQty(l.short)} × ${l.item} by ${date}`, notes: `Wanted ${date}${subject.customer_name ? ` by ${subject.customer_name}` : ''}. Raised from the promise check.` },
      });
    }
    fixes.push(fix);
  }
  // With nothing on order to close the gap: the first day in full if the proposed orders are approved today.
  const ifOrdered = !earliestAll && shortLines.length && fixes.every((f) => f.supplier || f.transfer)
    ? fixes.reduce((m, f) => (f.supplier && f.supplier.lands > m ? f.supplier.lands : m), asOf) : null;

  if (verdict === 'partial') {
    proposals.push({ kind: 'ship_partial', label: `Ship ${fmtQty(ready)} of ${fmtQty(needed)} on ${shortDate(date)}${earliestAll || ifOrdered ? `, the rest on ${shortDate(earliestAll || ifOrdered)}` : ''}` });
  }
  if (verdict !== 'yes' && (earliestAll || ifOrdered)) {
    proposals.push({
      kind: subject.kind === 'sales_order' && subject.committed ? 'tell_customer' : 'quote_date',
      label: subject.kind === 'sales_order' && subject.committed
        ? `Tell ${subject.customer_name || 'the customer'} it can go in full on ${shortDate(earliestAll || ifOrdered)}${earliestAll ? '' : ' once the order is approved'}`
        : `Promise ${shortDate(earliestAll || ifOrdered)} instead — the first day it can go in full${earliestAll ? ' from what is in stock and on order' : ' if the order is approved today'}`,
    });
  }

  // The answer, in one line.
  const one = lines.length === 1 ? lines[0] : null;
  const firstFix = fixes.find((f) => f.supplier) || null;
  const supplierLine = firstFix
    ? ` ${String(firstFix.supplier.name)} ${firstFix.supplier.in_time ? 'can deliver in' : 'needs'} ${firstFix.supplier.lead_days} days${seesMargins && firstFix.supplier.unit_price != null ? ` at ${money(firstFix.supplier.unit_price, firstFix.supplier.currency, 2)}` : ''}${firstFix.supplier.in_time ? '' : `, landing ${shortDate(firstFix.supplier.lands)}`}.`
      + ` A purchase order for ${fmtQty(firstFix.supplier.quantity)}${seesMargins && firstFix.supplier.value != null ? ` (${money(firstFix.supplier.value, firstFix.supplier.currency)})` : ''} is ready to prepare; ${firstFix.supplier.routed_to ? `it goes to ${firstFix.supplier.routed_to} for approval` : 'it goes through purchase approval'}.`
    : '';
  const transferLine = fixes.find((f) => f.transfer) ? ` ${fmtQty(fixes.find((f) => f.transfer).transfer.qty)} are free at ${fixes.find((f) => f.transfer).transfer.from.name}.` : '';
  const when = shortDate(date);
  const withOrder = verdict !== 'yes' && !!shortLines.length && fixes.every((f) => f.supplier?.in_time);
  const headline = verdict === 'yes'
    ? `Yes — ${subject.number} can ship in full on ${when}${one ? `: ${fmtQty(one.ready_by_date)} × ${one.item} ready` : `: all ${lines.length} lines ready`}.`
    : `${withOrder ? `Only with a purchase order${verdict === 'partial' ? ' for the rest' : ''}` : verdict === 'no' ? 'No' : 'Not in full'} on ${when}: `
      + (one
        ? `${fmtQty(one.ready_by_date)} ready, ${fmtQty(one.needed)} ordered, ${fmtQty(one.short)} short.`
        : `${shortLines.length} of ${lines.length} lines short, ${fmtQty(ready)} of ${fmtQty(needed)} ready.`)
      + (earliestAll ? ` In full on ${shortDate(earliestAll)} from what is already on order.` : ifOrdered ? ` In full on ${shortDate(ifOrdered)} if the order is approved today${withOrder ? ' — in time' : ''}.` : '')
      + transferLine + supplierLine;

  return {
    as_of: asOf,
    subject: { kind: subject.kind, id: subject.id, number: subject.number, status: subject.status, customer_name: subject.customer_name, committed: subject.committed },
    date,
    date_basis: parsed ? 'asked' : subject.own_date ? 'the date on the document' : 'today',
    verdict,
    verdict_label: verdict === 'yes' ? 'Can ship' : withOrder ? 'Needs a purchase order' : verdict === 'partial' ? 'Not in full' : 'Cannot ship',
    in_time_with_order: withOrder,
    tone: verdict === 'yes' ? 'ok' : withOrder || verdict === 'partial' ? 'warn' : 'risk',
    headline,
    needed: round(needed),
    ready_by_date: round(ready),
    earliest_in_full: earliestAll,
    earliest_if_ordered_today: ifOrdered,
    currency,
    lines,
    fixes,
    proposals: [...new Map(proposals.map((p) => [p.label, p])).values()],
    unknown_items: subject.unknown || [],
    read,
    visibility: seesMargins ? 'full' : 'supplier prices and order values are hidden for your role',
    method:
      'Stock is allocated to open order lines in promised-date order across the whole company (the delivery trace), then open '
      + 'work orders and purchase lines, each landing when its work centre or supplier has actually been landing. '
      + (subject.committed
        ? 'This order is read where it already stands among them. '
        : `This ${subject.kind === 'request' ? 'request' : subject.kind === 'quotation' ? 'quotation' : 'draft'} is served last, after every order already promised in the next ${HORIZON} days, so it never takes stock another customer holds. `)
      + 'Suppliers are ranked by the lead time achieved on this company\'s orders and the price last paid. Nothing was changed.',
  };
}

module.exports = { checkPromise, parseDate };
