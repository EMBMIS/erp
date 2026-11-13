/**
 * Suppliers as relationships — lead times, reliability and exposure, not a
 * contact list.
 *
 * WHAT THIS ANSWERS
 * ---------------------------------------------------------------------------
 * "Which of our suppliers is a risk right now, and why?" — from this
 * company's own purchase orders, goods receipts and supplier catalogue, and
 * from the delivery trace for what each supplier's lateness does to customer
 * orders. Every signal names the records it came from:
 *
 *   Reliability   arrival (confirmed delivery, else the first goods receipt)
 *                 against the promised date, on orders placed in the last
 *                 year: on-time rate and average days late. The last 90 days
 *                 are compared with the 275 before, so a supplier getting
 *                 worse shows before its yearly average does.
 *   Lead time     order date to arrival, achieved, against the lead time the
 *                 supplier's catalogue entries promise.
 *   Condition     share of received quantity booked in as DAMAGED.
 *   Open now      open purchase lines past their promised date with nothing
 *                 received (how many, how late, what they are worth), orders
 *                 sent but never confirmed, and the value still to arrive.
 *   Dependency    items this supplier has open supply or recent purchases of
 *                 that no other active supplier has a catalogue entry or
 *                 purchase history for — a single source.
 *   Orders        customer orders the delivery trace says are late, at risk
 *                 or uncovered, and whose supply runs through one of this
 *                 supplier's purchase orders.
 *
 * Each signal adds stated points to a score; the band (HIGH ≥ 50, MEDIUM ≥ 25)
 * is that score, and the signals are the reason for it. No model is involved.
 *
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It changes nothing. Proposals — chase a purchase order, ask for a
 * confirmation, qualify a second source, place the next order elsewhere — come
 * back as proposals; acting on them goes through the ordinary draft-and-approve
 * path. The only thing it writes is the finding (and the managers'
 * notification) that says a supplier has become a high risk.
 */

const { pool } = require('../config/database');
const companyContext = require('./companyContext');
const { traceDeliveryRisk } = require('./deliveryRisk');
const { readBuiltSignals, recordsFor, describeRecord } = require('./builtSignals');

const HISTORY_DAYS = 365;
const RECENT_DAYS = 90;
const OPEN_PO_STATUSES = [
  'PENDING_APPROVAL', 'APPROVED', 'SENT_TO_SUPPLIER', 'CONFIRMED', 'PREPARING_DELIVERY', 'IN_TRANSIT',
  'DELIVERED', 'GOODS_READY_FOR_RECEIPT', 'PARTIALLY_RECEIVED',
];
const PLACED_PO_EXCLUDED = ['DRAFT', 'CANCELLED', 'REJECTED'];
const HIGH = 50;
const MEDIUM = 25;

const round = (v, p = 2) => Math.round(v * 10 ** p) / 10 ** p;
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const possessive = (name) => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

async function resolveCompany(companyId) {
  return companyId || companyContext.currentCompanyId() || (await companyContext.getDefaultCompanyId());
}

function money(v, cur) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: cur || 'USD', maximumFractionDigits: 0 }).format(v || 0);
  } catch {
    return `${Math.round(v || 0)} ${cur || ''}`.trim();
  }
}

/* ------------------------------------------------------------------ reads */

/** One row per supplier: delivery record, lead time, condition, spend. */
async function readRecord(companyId, supplierId) {
  const { rows } = await pool.query(
    `WITH placed AS (
       SELECT po.id, po.supplier_id, po.po_date, po.delivery_date, po.total_amount,
              COALESCE(po.delivery_confirmed_at::date,
                       (SELECT MIN(gr.received_date)::date FROM goods_receipts gr
                         WHERE gr.po_id = po.id AND gr.company_id = po.company_id)) AS arrived
         FROM purchase_orders po
        WHERE po.company_id = $1
          AND ($2::uuid IS NULL OR po.supplier_id = $2::uuid)
          AND po.po_date >= CURRENT_DATE - $3::int
          AND po.status <> ALL($5)
     ),
     record AS (
       SELECT supplier_id,
              COUNT(*) FILTER (WHERE arrived IS NOT NULL AND delivery_date IS NOT NULL)::int AS deliveries,
              COUNT(*) FILTER (WHERE arrived IS NOT NULL AND arrived <= delivery_date)::int AS on_time,
              AVG(GREATEST(arrived - delivery_date, 0))
                FILTER (WHERE arrived IS NOT NULL AND delivery_date IS NOT NULL)::float AS avg_days_late,
              COUNT(*) FILTER (WHERE arrived IS NOT NULL AND delivery_date IS NOT NULL
                                 AND arrived >= CURRENT_DATE - $4::int)::int AS recent_deliveries,
              COUNT(*) FILTER (WHERE arrived IS NOT NULL AND arrived <= delivery_date
                                 AND arrived >= CURRENT_DATE - $4::int)::int AS recent_on_time,
              AVG(arrived - po_date) FILTER (WHERE arrived IS NOT NULL AND arrived >= po_date)::float AS lead_days,
              SUM(total_amount)::float AS spend
         FROM placed GROUP BY supplier_id
     ),
     condition AS (
       SELECT po.supplier_id,
              SUM(gr.quantity_received)::float AS received_qty,
              SUM(gr.quantity_received) FILTER (WHERE gr.condition_grade = 'DAMAGED')::float AS damaged_qty
         FROM goods_receipts gr
         JOIN purchase_orders po ON po.id = gr.po_id AND po.company_id = $1
        WHERE gr.company_id = $1 AND gr.received_date >= CURRENT_DATE - $3::int
          AND ($2::uuid IS NULL OR po.supplier_id = $2::uuid)
        GROUP BY po.supplier_id
     ),
     catalogue AS (
       SELECT supplier_id, AVG(lead_time_days)::float AS catalogue_lead_days, COUNT(*)::int AS catalogue_items
         FROM supplier_items
        WHERE company_id = $1 AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
        GROUP BY supplier_id
     )
     SELECT s.id, s.supplier_code, COALESCE(s.trade_name, s.legal_name) AS name, s.status, s.country,
            s.currency AS supplier_currency,
            COALESCE(r.deliveries, 0) AS deliveries, COALESCE(r.on_time, 0) AS on_time,
            r.avg_days_late, COALESCE(r.recent_deliveries, 0) AS recent_deliveries,
            COALESCE(r.recent_on_time, 0) AS recent_on_time, r.lead_days, COALESCE(r.spend, 0)::float AS spend,
            c.received_qty, c.damaged_qty, cat.catalogue_lead_days, COALESCE(cat.catalogue_items, 0) AS catalogue_items
       FROM suppliers s
       LEFT JOIN record r ON r.supplier_id = s.id
       LEFT JOIN condition c ON c.supplier_id = s.id
       LEFT JOIN catalogue cat ON cat.supplier_id = s.id
      WHERE s.company_id = $1
        AND ($2::uuid IS NULL OR s.id = $2::uuid)
        AND COALESCE(s.status, 'ACTIVE') NOT IN ('INACTIVE', 'BLOCKED', 'REJECTED')
      ORDER BY name`,
    [companyId, supplierId || null, HISTORY_DAYS, RECENT_DAYS, PLACED_PO_EXCLUDED],
  );
  return rows;
}

/** Open purchase lines: what is still to arrive from whom, and what is late. */
async function readOpenLines(companyId, supplierId) {
  const { rows } = await pool.query(
    `SELECT po.id AS po_id, po.po_number, po.status, po.supplier_id, po.currency,
            po.po_date, po.supplier_confirmed_at,
            pol.id AS line_id, pol.item_id, COALESCE(i.name, pol.item_description) AS item_name, i.item_code,
            GREATEST(pol.quantity - COALESCE(pol.quantity_received, 0), 0)::float AS remaining,
            (GREATEST(pol.quantity - COALESCE(pol.quantity_received, 0), 0) * pol.unit_price)::float AS remaining_value,
            COALESCE(pol.requested_delivery_date, po.delivery_date, po.supplier_delivery_due::date) AS expected_date
       FROM purchase_orders po
       JOIN purchase_order_line_items pol ON pol.po_id = po.id
       LEFT JOIN items i ON i.id = pol.item_id AND i.company_id = po.company_id
      WHERE po.company_id = $1 AND po.status = ANY($2)
        AND ($3::uuid IS NULL OR po.supplier_id = $3::uuid)
        AND pol.quantity - COALESCE(pol.quantity_received, 0) > 0
      ORDER BY expected_date NULLS LAST, po.po_number`,
    [companyId, OPEN_PO_STATUSES, supplierId || null],
  );
  return rows;
}

/**
 * Items each supplier is the only source for: it has open supply or bought
 * history of the item, and no other active supplier has either a catalogue
 * entry or a purchase of it in the last year.
 */
async function readSingleSource(companyId, supplierId) {
  const { rows } = await pool.query(
    `WITH catalogue AS (
       -- supplier_items point at a stock position; the item is its master.
       SELECT si.supplier_id, ii.item_master_id AS item_id, si.status
         FROM supplier_items si
         JOIN inventory_items ii ON ii.id = si.item_id AND ii.company_id = $1
        WHERE si.company_id = $1 AND ii.item_master_id IS NOT NULL
     ),
     sources AS (
       SELECT supplier_id, item_id FROM catalogue WHERE COALESCE(status, 'ACTIVE') = 'ACTIVE'
       UNION
       SELECT po.supplier_id, pol.item_id
         FROM purchase_orders po JOIN purchase_order_line_items pol ON pol.po_id = po.id
        WHERE po.company_id = $1 AND pol.item_id IS NOT NULL
          AND po.po_date >= CURRENT_DATE - $2::int AND po.status <> ALL($3)
     ),
     active AS (
       SELECT src.* FROM sources src
         JOIN suppliers s ON s.id = src.supplier_id AND s.company_id = $1
        WHERE COALESCE(s.status, 'ACTIVE') NOT IN ('INACTIVE', 'BLOCKED', 'REJECTED')
     ),
     counted AS (
       SELECT item_id, COUNT(DISTINCT supplier_id)::int AS sources FROM active GROUP BY item_id
     ),
     alternatives AS (
       -- The best other supplier a person could qualify: anyone with a
       -- catalogue entry, even an inactive one, is a starting point.
       SELECT DISTINCT ON (cat.item_id, a.supplier_id) cat.item_id, a.supplier_id AS for_supplier,
              COALESCE(s.trade_name, s.legal_name) AS alt_name
         FROM catalogue cat
         JOIN active a ON a.item_id = cat.item_id AND a.supplier_id <> cat.supplier_id
         JOIN suppliers s ON s.id = cat.supplier_id AND s.company_id = $1
     )
     SELECT a.supplier_id, a.item_id, i.item_code, i.name AS item_name, alt.alt_name
       FROM active a
       JOIN counted c ON c.item_id = a.item_id AND c.sources = 1
       JOIN items i ON i.id = a.item_id AND i.company_id = $1
       LEFT JOIN alternatives alt ON alt.item_id = a.item_id AND alt.for_supplier = a.supplier_id
      WHERE ($4::uuid IS NULL OR a.supplier_id = $4::uuid)
      ORDER BY i.item_code`,
    [companyId, HISTORY_DAYS, PLACED_PO_EXCLUDED, supplierId || null],
  );
  return rows;
}

async function readCurrency(companyId) {
  const { rows } = await pool.query('SELECT base_currency FROM companies WHERE id = $1', [companyId]);
  return rows[0]?.base_currency || 'USD';
}

async function resolveSupplier(companyId, ref) {
  const text = String(ref).trim();
  if (/^[0-9a-f-]{36}$/i.test(text)) {
    const { rows } = await pool.query('SELECT id FROM suppliers WHERE company_id = $1 AND id = $2::uuid', [companyId, text]);
    return rows[0]?.id || null;
  }
  const { rows } = await pool.query(
    `SELECT id FROM suppliers WHERE company_id = $1
        AND (supplier_code ILIKE $2 OR legal_name ILIKE $3 OR trade_name ILIKE $3)
      ORDER BY (supplier_code ILIKE $2) DESC, legal_name LIMIT 1`,
    [companyId, text, `%${text}%`],
  );
  return rows[0]?.id || null;
}

/* ------------------------------------------------------------ assessment */

/**
 * @param {object} opts
 *   companyId, userId, role   who is asking (role decides which customer orders are shown)
 *   supplier                  one supplier, by id, code or name
 *   includeLow                also return suppliers with no risk signal
 *   withOrders                read the delivery trace (default true)
 */
async function assessSupplierRisk(opts = {}) {
  const companyId = await resolveCompany(opts.companyId);
  let supplierId = null;
  if (opts.supplier) {
    supplierId = await resolveSupplier(companyId, opts.supplier);
    if (!supplierId) return { error: `No supplier ${opts.supplier} in this company.` };
  }

  const [record, openLines, singles, currency, built] = await Promise.all([
    readRecord(companyId, supplierId),
    readOpenLines(companyId, supplierId),
    readSingleSource(companyId, supplierId),
    readCurrency(companyId),
    // What the company built in Sandbox about its suppliers (quality findings, audits, claims), read as the
    // person asking — so it counts here only when they could open it themselves.
    opts.userId ? readBuiltSignals({ companyId, userId: opts.userId, role: opts.role }).catch(() => null) : null,
  ]);

  // The delivery trace is the expensive part: read it once, and only if some
  // supplier has something open that a customer order could be waiting on.
  let trace = null;
  if (opts.withOrders !== false && openLines.length) {
    trace = await traceDeliveryRisk({
      companyId, userId: opts.userId, role: opts.role, horizonDays: 45, includeCovered: true,
    });
  }

  const today = new Date(`${iso(new Date())}T00:00:00Z`);
  const bySupplier = (rows) => rows.reduce((m, r) => m.set(r.supplier_id, [...(m.get(r.supplier_id) || []), r]), new Map());
  const linesOf = bySupplier(openLines);
  const singlesOf = bySupplier(singles);

  const suppliers = [];
  for (const s of record) {
    const lines = linesOf.get(s.id) || [];
    const single = singlesOf.get(s.id) || [];
    const where = s.name;
    const signals = [];
    const chain = [];
    const proposals = [];
    let score = 0;
    const add = (points, signal) => { score += points; signals.push({ ...signal, points }); };

    // --- reliability ----------------------------------------------------
    const onTimeRate = s.deliveries ? (s.on_time / s.deliveries) * 100 : null;
    const recentRate = s.recent_deliveries ? (s.recent_on_time / s.recent_deliveries) * 100 : null;
    const olderDeliveries = s.deliveries - s.recent_deliveries;
    const olderRate = olderDeliveries > 0 ? ((s.on_time - s.recent_on_time) / olderDeliveries) * 100 : null;
    const trend = recentRate != null && olderRate != null && s.recent_deliveries >= 2 ? recentRate - olderRate : null;

    if (onTimeRate != null && s.deliveries >= 2) {
      if (onTimeRate < 60) add(30, { kind: 'unreliable', layer: 'suppliers', text: `${where} delivered ${s.on_time} of ${s.deliveries} orders on time in the last year (${round(onTimeRate, 0)}%), ${round(s.avg_days_late || 0, 1)} days late on average` });
      else if (onTimeRate < 80) add(20, { kind: 'unreliable', layer: 'suppliers', text: `${where} delivered ${round(onTimeRate, 0)}% of ${s.deliveries} orders on time in the last year` });
      if ((s.avg_days_late || 0) >= 3 && onTimeRate < 80) add(10, { kind: 'habitually_late', layer: 'suppliers', text: `When late, ${where} runs ${round(s.avg_days_late, 1)} days past its promised date on average` });
    }
    if (trend != null && trend <= -15) {
      add(15, { kind: 'deteriorating', layer: 'suppliers', text: `${possessive(where)} on-time rate fell to ${round(recentRate, 0)}% over the last ${RECENT_DAYS} days from ${round(olderRate, 0)}% before` });
    }

    // --- lead time ------------------------------------------------------
    const leadGap = s.lead_days != null && s.catalogue_lead_days ? s.lead_days - s.catalogue_lead_days : null;
    if (leadGap != null && leadGap >= 3 && leadGap / s.catalogue_lead_days >= 0.2) {
      add(10, { kind: 'lead_time_drift', layer: 'suppliers', text: `${where} takes ${round(s.lead_days, 1)} days from order to arrival against the ${round(s.catalogue_lead_days, 0)} its catalogue promises` });
    }

    // --- condition ------------------------------------------------------
    const damagedPct = s.received_qty ? ((s.damaged_qty || 0) / s.received_qty) * 100 : null;
    if (damagedPct != null && damagedPct >= 5) {
      add(10, { kind: 'damaged_goods', layer: 'inventory', text: `${round(damagedPct, 1)}% of what ${where} delivered in the last year was booked in damaged` });
    }

    // --- open now -------------------------------------------------------
    const overdue = lines.filter((l) => l.expected_date && new Date(l.expected_date) < today);
    const overdueValue = overdue.reduce((sum, l) => sum + (l.remaining_value || 0), 0);
    const maxOverdue = overdue.reduce((m, l) => Math.max(m, Math.round((today - new Date(l.expected_date)) / 86400000)), 0);
    const overduePos = [...new Map(overdue.map((l) => [l.po_id, l])).values()];
    if (overdue.length) {
      add(maxOverdue > 14 ? 40 : 30, {
        kind: 'overdue',
        layer: 'suppliers',
        text: `${plural(overduePos.length, 'purchase order')} from ${where} ${overduePos.length === 1 ? 'is' : 'are'} past the promised date with nothing received — `
          + `${overduePos.slice(0, 3).map((l) => `${l.po_number} (due ${iso(l.expected_date)})`).join(', ')}`
          + `${overduePos.length > 3 ? ` and ${overduePos.length - 3} more` : ''}; up to ${plural(maxOverdue, 'day')} late, ${money(overdueValue, currency)} outstanding`,
        record: { type: 'purchase_order', id: overduePos[0].po_id, number: overduePos[0].po_number },
      });
    }
    const unconfirmed = [...new Map(lines
      .filter((l) => l.status === 'SENT_TO_SUPPLIER' && !l.supplier_confirmed_at && l.po_date && (today - new Date(l.po_date)) / 86400000 >= 3)
      .map((l) => [l.po_id, l])).values()];
    if (unconfirmed.length) {
      add(5, {
        kind: 'unconfirmed',
        layer: 'suppliers',
        text: `${where} has not confirmed ${unconfirmed.slice(0, 3).map((l) => l.po_number).join(', ')}${unconfirmed.length > 3 ? ` and ${unconfirmed.length - 3} more` : ''}`,
        record: { type: 'purchase_order', id: unconfirmed[0].po_id, number: unconfirmed[0].po_number },
      });
    }
    const exposure = lines.reduce((sum, l) => sum + (l.remaining_value || 0), 0);

    // --- dependency -----------------------------------------------------
    const openItems = new Set(lines.map((l) => l.item_id).filter(Boolean));
    const singleOpen = single.filter((x) => openItems.has(x.item_id));
    if (singleOpen.length) {
      add(15, {
        kind: 'single_source',
        layer: 'data',
        text: `${where} is the only source for ${singleOpen.slice(0, 3).map((x) => x.item_code || x.item_name).join(', ')}${singleOpen.length > 3 ? ` and ${singleOpen.length - 3} more` : ''}, with supply still open`,
        record: { type: 'item', id: singleOpen[0].item_id, number: singleOpen[0].item_code },
      });
    }

    // --- customer orders ------------------------------------------------
    const poIds = new Set(lines.map((l) => l.po_id));
    const touches = (o) => o.chain.some((st) => st.record?.type === 'purchase_order' && poIds.has(st.record.id))
      || o.lines.some((l) => l.depends_on.some((d) => d.type === 'purchase_order' && poIds.has(d.id)));
    const depending = poIds.size ? (trace?.orders || []).filter(touches) : [];
    const atRisk = depending.filter((o) => ['late', 'at_risk', 'uncovered'].includes(o.verdict));
    const valueAtRisk = atRisk.reduce((sum, o) => sum + (o.value_at_risk || 0), 0);
    if (atRisk.length) {
      add(25, {
        kind: 'orders_at_risk',
        layer: 'decisions',
        text: `${plural(atRisk.length, 'customer order')} waiting on ${where} ${atRisk.length === 1 ? 'is' : 'are'} at risk — ${money(valueAtRisk, currency)}`,
        record: { type: 'sales_order', id: atRisk[0].sales_order_id, number: atRisk[0].so_number },
      });
    }

    // --- what the company built ----------------------------------------
    const builtHere = recordsFor(built, 'supplier', s.id);
    if (builtHere.length) {
      const top = builtHere[0];
      const severe = builtHere.filter((r) => r.critical || r.signals.some((x) => x.kind === 'severe'));
      const late = builtHere.filter((r) => r.overdue_days || r.signals.some((x) => x.kind === 'stuck'));
      const apps = [...new Set(builtHere.map((r) => r.application.name))];
      const points = builtHere.some((r) => r.critical) ? 25 : severe.some((r) => late.includes(r)) ? 20 : 10;
      add(points, {
        kind: 'built_application',
        layer: 'suppliers',
        text: `${where} has ${plural(builtHere.length, `open ${top.entity_label.toLowerCase()}`)} in ${apps.join(' and ')}`
          + `${severe.length ? `, ${severe.length} severe` : ''}${late.length ? `, ${late.length} past due` : ''} — ${describeRecord(top)}`,
        record: { type: 'app_record', id: top.id, number: top.number || top.title, link: top.link, application: top.application.key },
      });
      proposals.push({
        kind: 'built_follow_up',
        label: `Chase ${where} on ${top.number || top.entity_label.toLowerCase()} in ${top.application.name}`,
        record: { type: 'app_record', id: top.id, number: top.number || top.title, link: top.link },
      });
    }

    const band = score >= HIGH ? 'HIGH' : score >= MEDIUM ? 'MEDIUM' : score > 0 ? 'LOW' : 'NONE';
    if (band === 'NONE' && !opts.includeLow && !supplierId) continue;

    // The chain, in the order the website draws it: supplier → stock → production → order.
    signals.filter((x) => x.layer === 'suppliers').forEach((x) => chain.push({ layer: x.layer, text: x.text, record: x.record || { type: 'supplier', id: s.id, number: s.supplier_code } }));
    signals.filter((x) => x.layer === 'data' || x.layer === 'inventory').forEach((x) => chain.push({ layer: x.layer, text: x.text, record: x.record || null }));
    for (const o of atRisk.slice(0, 5)) {
      chain.push({
        layer: 'decisions',
        text: o.projected_date && o.days_late
          ? `${o.so_number} for ${o.customer_name} (due ${o.due_date}) now ships around ${o.projected_date}, ${plural(o.days_late, 'day')} late — ${money(o.value_at_risk, o.currency || currency)} at risk`
          : o.verdict === 'at_risk'
            ? `${o.so_number} for ${o.customer_name} (due ${o.due_date}) still makes it only if ${where} delivers on time — ${money(o.value_at_risk, o.currency || currency)} exposed`
            : `${o.so_number} for ${o.customer_name} (due ${o.due_date}) cannot be covered from stock or supply — ${money(o.value_at_risk, o.currency || currency)} at risk`,
        record: { type: 'sales_order', id: o.sales_order_id, number: o.so_number },
      });
    }

    // Proposals: suggestions for a person. Nothing here is executed.
    for (const l of overduePos.slice(0, 3)) {
      proposals.push({ kind: 'chase_supplier', label: `Chase ${where} on ${l.po_number} for a firm delivery date`, record: { type: 'purchase_order', id: l.po_id, number: l.po_number } });
    }
    for (const l of unconfirmed.slice(0, 2)) {
      proposals.push({ kind: 'request_confirmation', label: `Ask ${where} to confirm ${l.po_number}`, record: { type: 'purchase_order', id: l.po_id, number: l.po_number } });
    }
    for (const x of singleOpen.slice(0, 2)) {
      proposals.push({
        kind: 'second_source',
        label: x.alt_name
          ? `Qualify ${x.alt_name} as a second source for ${x.item_code || x.item_name}`
          : `Find a second source for ${x.item_code || x.item_name}`,
        record: { type: 'item', id: x.item_id, number: x.item_code },
      });
    }
    if (band === 'HIGH' && onTimeRate != null && onTimeRate < 80) {
      proposals.push({ kind: 'supplier_review', label: `Hold a performance review with ${where} and agree a recovery plan`, record: { type: 'supplier', id: s.id, number: s.supplier_code } });
    }
    for (const o of atRisk.filter((x) => x.verdict === 'late' || x.verdict === 'uncovered').slice(0, 2)) {
      proposals.push({
        kind: 'tell_customer',
        label: o.projected_date ? `Tell ${o.customer_name} ${o.so_number} will arrive around ${o.projected_date}` : `Tell ${o.customer_name} ${o.so_number} is at risk before ${o.due_date}`,
        record: { type: 'sales_order', id: o.sales_order_id, number: o.so_number },
      });
    }

    const top = [...signals].sort((a, b) => b.points - a.points)[0];
    suppliers.push({
      supplier_id: s.id,
      supplier_code: s.supplier_code,
      name: where,
      country: s.country,
      band,
      score,
      deliveries: s.deliveries,
      on_time_rate: onTimeRate == null ? null : round(onTimeRate, 1),
      recent_on_time_rate: recentRate == null ? null : round(recentRate, 1),
      avg_days_late: s.avg_days_late == null ? null : round(s.avg_days_late, 1),
      lead_time_days: s.lead_days == null ? null : round(s.lead_days, 1),
      catalogue_lead_time_days: s.catalogue_lead_days == null ? null : round(s.catalogue_lead_days, 1),
      damaged_pct: damagedPct == null ? null : round(damagedPct, 1),
      spend_last_year: round(s.spend || 0),
      open_lines: lines.length,
      open_exposure: round(exposure),
      overdue_lines: overdue.length,
      overdue_value: round(overdueValue),
      max_days_overdue: maxOverdue,
      single_source_items: singleOpen.map((x) => ({ item_id: x.item_id, item_code: x.item_code, name: x.item_name, alternative: x.alt_name || null })),
      orders_depending: depending.length,
      orders_at_risk: atRisk.map((o) => ({
        sales_order_id: o.sales_order_id, so_number: o.so_number, customer_name: o.customer_name,
        due_date: o.due_date, projected_date: o.projected_date, days_late: o.days_late,
        verdict: o.verdict, value_at_risk: o.value_at_risk,
      })),
      value_at_risk: round(valueAtRisk),
      built_records: builtHere.slice(0, 5).map((r) => ({
        id: r.id, application: r.application, entity: r.entity_label, number: r.number, title: r.title,
        state: r.state_label, critical: r.critical, overdue_days: r.overdue_days, why: r.signals.map((x) => x.text), link: r.link,
      })),
      currency,
      headline: signals.length
        ? `${where}: ${band.toLowerCase()} risk — ${top.text.replace(`${where} `, '').replace(`${possessive(where)} `, '')}`
        : `${where}: no risk signal`,
      signals,
      chain,
      proposals,
    });
  }

  const order = { HIGH: 0, MEDIUM: 1, LOW: 2, NONE: 3 };
  suppliers.sort((a, b) => order[a.band] - order[b.band] || b.score - a.score || b.value_at_risk - a.value_at_risk || b.open_exposure - a.open_exposure);

  return {
    as_of: new Date().toISOString(),
    currency,
    scope: trace?.scope || null,
    summary: {
      suppliers_watched: record.length,
      high: suppliers.filter((s) => s.band === 'HIGH').length,
      medium: suppliers.filter((s) => s.band === 'MEDIUM').length,
      delayed: suppliers.filter((s) => s.overdue_lines > 0).length,
      open_exposure: round(openLines.reduce((sum, l) => sum + (l.remaining_value || 0), 0)),
      exposure_at_risk: round(suppliers.filter((s) => s.band === 'HIGH').reduce((sum, s) => sum + s.open_exposure, 0)),
      value_at_risk: round(suppliers.reduce((sum, s) => sum + s.value_at_risk, 0)),
    },
    suppliers,
    method:
      `Reliability is arrival (confirmed delivery, else first goods receipt) against the promised date on orders placed in the last ${HISTORY_DAYS} days, `
      + `with the last ${RECENT_DAYS} days compared to the rest. Lead time is order date to arrival against the catalogue. `
      + 'Open exposure is the value still to arrive on open purchase lines; overdue lines are past their promised date with quantity outstanding. '
      + 'A single source is an item no other active supplier has a catalogue entry or a purchase for. Orders at risk come from the delivery trace. '
      + `Points: overdue 30 (40 past two weeks), on-time under 60% 30 / under 80% 20, habitually late 10, worsening 15, lead-time drift 10, damaged goods 10, `
      + `single source 15, orders at risk 25, unconfirmed 5; open records about the supplier in applications the company built in Sandbox `
      + `(read as you) 10, 20 when severe and past due, 25 when critical. HIGH at ${HIGH}, MEDIUM at ${MEDIUM}. Nothing was changed.`,
  };
}

/* --------------------------------------------------------------- finding */

/**
 * Raise (or refresh) a finding for every HIGH-risk supplier and tell this
 * company's managers about new ones. Run by the scheduler and the findings
 * scan. Deduplicated per supplier while open; a dismissal suppresses
 * re-raising for its window (both handled by upsertFinding).
 */
async function raiseSupplierFindings(companyId) {
  const { upsertFinding } = require('./ai/findingsScan');
  const resolved = await resolveCompany(companyId);
  const result = await assessSupplierRisk({ companyId: resolved, role: 'ADMIN' });
  if (result.error) return { created: [] };

  const created = [];
  for (const s of result.suppliers.filter((x) => x.band === 'HIGH')) {
    const r = await upsertFinding({
      companyId: resolved,
      finding_type: 'SUPPLIER_RISK',
      severity: 'HIGH',
      entity_type: 'SUPPLIER',
      entity_id: s.supplier_id,
      title: s.headline.slice(0, 255),
      description: s.chain.map((x) => x.text).join(' → '),
      data: {
        supplier_code: s.supplier_code, score: s.score, on_time_rate: s.on_time_rate, open_exposure: s.open_exposure,
        overdue_value: s.overdue_value, value_at_risk: s.value_at_risk, currency: s.currency,
        orders_at_risk: s.orders_at_risk.map((o) => o.so_number), proposals: s.proposals.map((p) => p.label),
      },
    });
    if (r.created) {
      created.push(r.id);
      await notifyManagers(resolved, s, r.id).catch((e) => console.warn('Supplier risk notify failed:', e.message));
    }
  }
  return { created, suppliers: result.suppliers.length };
}

/** Managers and admins of THIS company only — never another tenant's. */
async function notifyManagers(companyId, s, findingId) {
  const { rows } = await pool.query(
    `SELECT u.id FROM users u
       LEFT JOIN user_companies uc ON uc.user_id = u.id AND uc.company_id = $1
      WHERE COALESCE(uc.role, u.role) IN ('MANAGER', 'ADMIN')
        AND (uc.user_id IS NOT NULL
             OR (NOT EXISTS (SELECT 1 FROM user_companies x WHERE x.user_id = u.id)
                 AND EXISTS (SELECT 1 FROM companies c WHERE c.id = $1 AND c.is_default)))`,
    [companyId],
  );
  for (const u of rows) {
    await pool.query(
      `INSERT INTO notifications (id, type, title, message, data, user_id, company_id, created_at)
       VALUES (gen_random_uuid(), 'AI_FINDING', $1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
      [
        `Supplier risk: ${s.headline}`.slice(0, 255),
        s.chain.map((x) => x.text).join(' → '),
        JSON.stringify({ finding_id: findingId, supplier_id: s.supplier_id, link: `/procurement/suppliers/${s.supplier_id}` }),
        u.id,
        companyId,
      ],
    );
  }
}

/**
 * The measures a Sandbox-built application may show next to a supplier —
 * the same assessment, flattened to one row per supplier. Internal surfaces
 * only; the platform never sends these to a portal.
 */
async function supplierRiskMeasures({ companyId, userId, role }) {
  const result = await assessSupplierRisk({ companyId, userId, role, includeLow: true });
  if (result.error) return { rows: [], summary: null, currency: null };
  return {
    currency: result.currency,
    summary: result.summary,
    rows: result.suppliers.map((s) => ({
      id: s.supplier_id,
      supplier_code: s.supplier_code,
      name: s.name,
      risk_band: s.band,
      risk_score: s.score,
      on_time_rate: s.on_time_rate,
      avg_days_late: s.avg_days_late,
      lead_time_days: s.lead_time_days,
      open_exposure: s.open_exposure,
      overdue_lines: s.overdue_lines,
      single_source_items: s.single_source_items.length,
      orders_at_risk: s.orders_at_risk.length,
      value_at_risk: s.value_at_risk,
      top_signal: [...s.signals].sort((a, b) => b.points - a.points)[0]?.text || null,
      signals: s.signals.map((x) => x.text),
      proposals: s.proposals.map((p) => p.label),
    })),
  };
}

module.exports = { assessSupplierRisk, raiseSupplierFindings, supplierRiskMeasures };
