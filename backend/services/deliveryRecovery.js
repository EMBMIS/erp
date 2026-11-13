/**
 * "Simeli has the fix ready; it needs one person to approve it."
 *
 * WHAT THIS ANSWERS
 * ---------------------------------------------------------------------------
 * The delivery trace (services/deliveryRisk.js) says why an order will miss
 * its date. This says what would make it hold — and proves it before anybody
 * is asked to agree.
 *
 * For one order it builds every fix the company's own records allow:
 *
 *   Move        an operation of a work order the order depends on, not yet
 *               started, onto another active work centre that has the hours
 *               free this week.
 *   Buy         the short quantity (of the product, or of a component a work
 *               order is waiting for) from a supplier that has delivered that
 *               item before — landing after the lead time it has actually
 *               achieved on this company's orders, or its catalogue lead time
 *               when it has no history yet — at the price last paid.
 *   Transfer    stock of the item sitting at another site, free after that
 *               site's own orders, to the site the order ships from —
 *               arriving after the time transfers between them have actually
 *               taken.
 *
 * Each candidate is then MEASURED, not guessed: the whole trace is run again
 * with the fix assumed (stock is still allocated across every open order, so
 * a fix that only moves the problem to another customer shows as such), and
 * only the fixes that bring the order's date forward or take it off slipping
 * supply are kept. "Friday holds" is the trace's own verdict after the fix.
 *
 * Each plan is also priced against the slip it prevents: the customer's
 * late-delivery terms, applied by the trace before and after the fix, give the
 * penalty avoided, and a plan that holds the date is ranked by what it costs.
 *
 * WHO DECIDES
 * ---------------------------------------------------------------------------
 * Planning writes nothing. Carrying a plan out is a manager's (or an admin's)
 * decision, taken on the order screen or in Simeli's chat, where the tool
 * always stops for the person. On approval the plan is re-measured from
 * scratch and must still be one of the fixes the planner would offer now —
 * nothing the client sends is executed as given. A move happens at once
 * (the same rule as the Work Centres screen: only an operation not yet
 * started, only onto an active centre in this company). A purchase is raised
 * and submitted into the ordinary purchase approval, so spending money still
 * goes through the company's own limits and segregation of duties. A transfer
 * is dispatched from the source site's shelves through the same path as the
 * Transfers screen, and received there when it arrives.
 */

const { pool } = require('../config/database');
const companyContext = require('./companyContext');
const moduleService = require('./moduleService');
const { traceDeliveryRisk, readTransferTimes } = require('./deliveryRisk');

const APPROVERS = new Set(['ADMIN', 'MANAGER']);
const OPEN_WO_STATUSES = ['DRAFT', 'RELEASED', 'IN_PROGRESS'];
const OPEN_OP_STATUSES = ['PENDING', 'IN_PROGRESS'];
const GOOD = { uncovered: 0, late: 1, unknown_item: 2, at_risk: 3, on_track: 4, covered: 5 };
const MAX_CANDIDATES = 10;
const DAY = 86400000;

const round = (v, p = 2) => Math.round(v * 10 ** p) / 10 ** p;
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const addDays = (d, n) => new Date(d.getTime() + n * DAY);
const today = () => new Date(`${iso(new Date())}T00:00:00Z`);
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / DAY);

async function resolveCompany(companyId) {
  return companyId || companyContext.currentCompanyId() || (await companyContext.getDefaultCompanyId());
}

/* ------------------------------------------------------------ candidates */

/** Not-yet-started operations of the work orders this order waits on, and centres that could take each one. */
async function moveCandidates(companyId, workOrderIds) {
  if (!workOrderIds.length) return [];
  const { rows: ops } = await pool.query(
    `SELECT op.id, op.operation_number, op.description, COALESCE(op.planned_hours, 0)::float AS planned_hours,
            op.hourly_rate::float AS hourly_rate, wo.wo_number, wc.id AS work_center_id, wc.code AS work_center_code
       FROM work_order_operations op
       JOIN work_orders wo ON wo.id = op.work_order_id
       JOIN work_centers wc ON wc.id = op.work_center_id
      WHERE wo.company_id = $1 AND wo.deleted_at IS NULL AND wo.id = ANY($2)
        AND op.status = 'PENDING' AND COALESCE(op.actual_hours, 0) = 0 AND op.planned_hours > 0
      ORDER BY wo.wo_number, op.operation_number`,
    [companyId, workOrderIds],
  );
  if (!ops.length) return [];
  const { rows: centres } = await pool.query(
    `SELECT wc.id, wc.code, wc.name, wc.hourly_rate::float AS hourly_rate,
            (wc.daily_capacity_hours * wc.efficiency_pct / 100 * 5)::float AS week_hours,
            COALESCE(SUM(GREATEST(op.planned_hours - op.actual_hours, 0)) FILTER (WHERE wo.id IS NOT NULL), 0)::float AS queued_hours
       FROM work_centers wc
       LEFT JOIN work_order_operations op ON op.work_center_id = wc.id AND op.status = ANY($2)
       LEFT JOIN work_orders wo ON wo.id = op.work_order_id AND wo.status = ANY($3) AND wo.deleted_at IS NULL
      WHERE wc.company_id = $1 AND wc.deleted_at IS NULL AND wc.status = 'ACTIVE'
      GROUP BY wc.id`,
    [companyId, OPEN_OP_STATUSES, OPEN_WO_STATUSES],
  );
  const out = [];
  for (const op of ops) {
    const targets = centres
      .filter((c) => c.id !== op.work_center_id)
      .map((c) => ({ ...c, free_hours: Math.max(c.week_hours - c.queued_hours, 0) }))
      .filter((c) => c.free_hours >= op.planned_hours)
      .sort((a, b) => b.free_hours - a.free_hours)
      .slice(0, 2);
    for (const t of targets) {
      const rateFrom = op.hourly_rate || 0;
      const rateTo = t.hourly_rate || rateFrom;
      out.push({
        id: `move:${op.id}:${t.id}`,
        kind: 'move_operation',
        label: `Move operation ${op.operation_number}${op.description ? ` (${op.description})` : ''} of ${op.wo_number} from ${op.work_center_code} to ${t.code}`,
        evidence: `${t.code} has ${round(t.free_hours, 1)} h free this week; the operation needs ${round(op.planned_hours, 1)} h.`,
        cost: round(op.planned_hours * (rateTo - rateFrom)),
        cost_note: rateTo === rateFrom ? 'Same hourly rate.' : `${round(op.planned_hours, 1)} h at ${t.code}'s rate instead of ${op.work_center_code}'s.`,
        module: 'manufacturing',
        actions: [{ type: 'move_operation', operation_id: op.id, work_center_id: t.id, work_center_code: t.code, from_code: op.work_center_code }],
        assume: { moves: [{ operation_id: op.id, work_center_id: t.id }] },
      });
    }
  }
  return out;
}

/** Components the order's work orders still need beyond what is on the shelf. */
async function componentNeeds(companyId, workOrderIds) {
  if (!workOrderIds.length) return [];
  const { rows } = await pool.query(
    `WITH need AS (
       SELECT woc.component_item_id AS item_id,
              SUM(GREATEST(woc.quantity_required - COALESCE(woc.quantity_issued, 0), 0))::float AS qty
         FROM work_order_components woc
         JOIN work_orders wo ON wo.id = woc.work_order_id
        WHERE wo.company_id = $1 AND wo.id = ANY($2)
        GROUP BY 1
     ), stock AS (
       SELECT item_master_id AS item_id, SUM(current_stock_quantity)::float AS qty
         FROM inventory_items
        WHERE company_id = $1 AND COALESCE(status, 'APPROVED') <> 'DECLINED'
        GROUP BY 1
     )
     SELECT n.item_id, i.item_code, i.name, i.unit_of_measure, (n.qty - COALESCE(s.qty, 0))::float AS short
       FROM need n
       JOIN items i ON i.id = n.item_id
       LEFT JOIN stock s ON s.item_id = n.item_id
      WHERE n.qty - COALESCE(s.qty, 0) > 0`,
    [companyId, workOrderIds],
  );
  return rows;
}

/**
 * Who could supply an item, how fast they have really been, and at what price.
 * Lead time is measured from this company's own orders (order date to arrival)
 * over the last year; a supplier with no history falls back to its catalogue.
 */
async function supplierOptions(companyId, itemId) {
  const { rows } = await pool.query(
    `WITH hist AS (
       SELECT po.supplier_id, pol.unit_price, po.po_date, po.currency,
              COALESCE(po.delivery_confirmed_at::date,
                       (SELECT MIN(gr.received_date)::date FROM goods_receipts gr WHERE gr.po_id = po.id)) AS arrived
         FROM purchase_orders po
         JOIN purchase_order_line_items pol ON pol.po_id = po.id
        WHERE po.company_id = $1 AND pol.item_id = $2 AND po.po_date >= CURRENT_DATE - 365
          AND po.status NOT IN ('DRAFT', 'CANCELLED', 'REJECTED')
     ), measured AS (
       SELECT supplier_id,
              COUNT(*) FILTER (WHERE arrived IS NOT NULL AND arrived >= po_date)::int AS deliveries,
              AVG(arrived - po_date) FILTER (WHERE arrived IS NOT NULL AND arrived >= po_date)::float AS lead_days,
              (ARRAY_AGG(unit_price ORDER BY po_date DESC))[1]::float AS last_price,
              (ARRAY_AGG(currency ORDER BY po_date DESC))[1] AS last_currency
         FROM hist GROUP BY supplier_id
     )
     SELECT s.id, COALESCE(s.trade_name, s.legal_name) AS name, s.currency AS supplier_currency,
            si.lead_time_days, si.unit_price::float AS catalogue_price, si.currency AS catalogue_currency,
            COALESCE(si.minimum_order_quantity, 1) AS moq,
            m.deliveries, m.lead_days, m.last_price, m.last_currency
       FROM suppliers s
       -- supplier_items.item_id is the inventory record; match on its item master.
       LEFT JOIN LATERAL (
         SELECT x.* FROM supplier_items x JOIN inventory_items ii ON ii.id = x.item_id
          WHERE x.supplier_id = s.id AND ii.item_master_id = $2 AND x.company_id = $1
            AND COALESCE(x.status, 'ACTIVE') = 'ACTIVE'
          ORDER BY x.is_preferred DESC NULLS LAST LIMIT 1
       ) si ON true
       LEFT JOIN measured m ON m.supplier_id = s.id
      WHERE s.company_id = $1 AND COALESCE(s.status, 'ACTIVE') = 'ACTIVE'
        AND (si.id IS NOT NULL OR m.deliveries > 0)`,
    [companyId, itemId],
  );
  return rows
    .map((r) => {
      const lead = r.deliveries > 0 ? r.lead_days : r.lead_time_days;
      const price = r.last_price || r.catalogue_price;
      if (lead == null || !price) return null;
      return {
        supplier_id: r.id,
        supplier_name: r.name,
        lead_days: Math.max(1, Math.ceil(lead)),
        lead_basis: r.deliveries > 0
          ? `${r.deliveries} deliver${r.deliveries === 1 ? 'y' : 'ies'} in the last year took ${round(r.lead_days, 1)} days on average from order to arrival`
          : `catalogue lead time ${r.lead_time_days} days (no deliveries of this item yet)`,
        unit_price: price,
        currency: r.last_price ? r.last_currency : (r.catalogue_currency || r.supplier_currency),
        moq: Number(r.moq) || 1,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.lead_days - b.lead_days)
    .slice(0, 2);
}

async function buyCandidates(companyId, order, workOrderIds) {
  const needs = [];
  for (const l of order.lines) {
    if (!l.item_id || !['uncovered', 'late', 'at_risk'].includes(l.verdict)) continue;
    const short = round(l.open_qty - l.from_stock, 3);
    if (short > 0) needs.push({ item_id: l.item_id, name: l.item, qty: short, why: `for ${order.so_number}` });
  }
  for (const c of await componentNeeds(companyId, workOrderIds)) {
    needs.push({ item_id: c.item_id, name: c.name || c.item_code, qty: round(c.short, 3), uom: c.unit_of_measure, why: `component for ${order.so_number}` });
  }
  const now = today();
  const out = [];
  for (const n of needs) {
    for (const s of await supplierOptions(companyId, n.item_id)) {
      const qty = Math.max(n.qty, s.moq);
      const lands = iso(addDays(now, s.lead_days));
      out.push({
        id: `buy:${s.supplier_id}:${n.item_id}:${qty}`,
        kind: 'buy_from_supplier',
        label: `Buy ${qty} × ${n.name} from ${s.supplier_name}, landing ${lands}`,
        evidence: `${s.supplier_name}: ${s.lead_basis}; last price ${round(s.unit_price, 2)} ${s.currency || ''}.`.replace(' .', '.'),
        cost: round(qty * s.unit_price),
        currency: s.currency,
        cost_note: 'New spend; the purchase order still goes through purchase approval.',
        module: 'procurement',
        actions: [{
          type: 'purchase_order', supplier_id: s.supplier_id, supplier_name: s.supplier_name, item_id: n.item_id,
          item_name: n.name, uom: n.uom || null, quantity: qty, unit_price: s.unit_price, currency: s.currency, lands, why: n.why,
        }],
        assume: { supplies: [{ item_id: n.item_id, qty, lands, supplier_id: s.supplier_id, supplier_name: s.supplier_name, label: `a new order to ${s.supplier_name}` }] },
      });
    }
  }
  return out;
}

/** The short quantity of each line that ships from a site, from where it is free elsewhere. */
async function transferCandidates(companyId, order) {
  const lines = order.lines.filter((l) => l.ship_from && l.elsewhere?.length && ['uncovered', 'late', 'at_risk'].includes(l.verdict));
  if (!lines.length) return [];
  const transferTime = await readTransferTimes(companyId);
  const now = today();
  const out = [];
  for (const l of lines) {
    const short = round(l.open_qty - l.from_stock, 3);
    for (const e of l.elsewhere.slice(0, 2)) {
      const qty = round(Math.min(short, e.free), 3);
      if (qty <= 0) continue;
      const time = transferTime(e.location_id, l.ship_from.id);
      const lands = iso(addDays(now, time.days));
      const to = l.ship_from.name || l.ship_from.code;
      out.push({
        id: `transfer:${e.location_id}:${l.item_id}:${qty}`,
        kind: 'transfer_stock',
        label: `Transfer ${qty} × ${l.item} from ${e.name} (${e.code}) to ${to}, arriving ${lands}`,
        evidence: `${e.free} free at ${e.code} after its own orders; ${time.basis}.`,
        cost: 0,
        cost_note: 'No new spend: the company\'s own stock moves between sites; freight is not on record.',
        module: 'inventory',
        actions: [{
          type: 'transfer_stock', item_id: l.item_id, item_name: l.item, quantity: qty,
          from_id: e.location_id, from_code: e.code, to_id: l.ship_from.id, to_code: l.ship_from.code, lands,
        }],
        assume: { transfers: [{ item_id: l.item_id, qty, from_id: e.location_id, to_id: l.ship_from.id, lands, label: `a transfer from ${e.code}` }] },
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ plan */

/**
 * @param {object} opts  companyId, userId, role, salesOrder (id or SO number)
 */
async function planRecovery(opts = {}) {
  const companyId = await resolveCompany(opts.companyId);
  const who = { companyId, userId: opts.userId, role: opts.role };
  const base = await traceDeliveryRisk({ ...who, salesOrder: opts.salesOrder, includeCovered: true });
  if (base.error) return base;
  const order = base.orders?.[0];
  if (!order) return { as_of: base.as_of, plans: [], note: base.note || 'Nothing open on this order.' };

  const summary = {
    sales_order_id: order.sales_order_id, so_number: order.so_number, customer_name: order.customer_name,
    due_date: order.due_date, projected_date: order.projected_date, verdict: order.verdict,
    value_at_risk: order.value_at_risk, currency: order.currency, cause: order.cause,
    ship_from: order.ship_from, penalty: order.penalty,
  };
  if (GOOD[order.verdict] >= GOOD.on_track) {
    return { as_of: base.as_of, order: summary, plans: [], note: `${order.so_number} is ${order.verdict === 'covered' ? 'covered from stock' : 'on track'}; there is nothing to recover.` };
  }

  const enabled = await moduleService.getEnabledModuleKeys(companyId).catch(() => null);
  const allowed = (m) => !enabled || enabled.has(m);
  const woIds = [...new Set(order.lines.flatMap((l) => l.depends_on).filter((d) => d.type === 'work_order').map((d) => d.id))];

  const candidates = [
    ...(allowed('inventory') ? await transferCandidates(companyId, order) : []),
    ...(allowed('manufacturing') ? await moveCandidates(companyId, woIds) : []),
    ...(allowed('procurement') ? await buyCandidates(companyId, order, woIds) : []),
  ].slice(0, MAX_CANDIDATES);

  const plans = [];
  const measure = async (c) => {
    const after = await traceDeliveryRisk({ ...who, salesOrder: order.sales_order_id, includeCovered: true, assume: c.assume });
    const o = after.orders?.[0];
    if (!o) return;
    const better = GOOD[o.verdict] > GOOD[order.verdict]
      || (o.projected_date && (!order.projected_date || o.projected_date < order.projected_date));
    if (!better) return;
    const holds = GOOD[o.verdict] >= GOOD.at_risk;
    const { assume, module, ...plan } = c;
    const avoided = order.penalty ? round((order.penalty.amount || 0) - (o.penalty?.amount || 0)) : null;
    const cur = plan.currency || order.currency || '';
    plans.push({
      ...plan,
      currency: plan.currency || order.currency,
      effect: {
        holds,
        verdict_before: order.verdict,
        verdict_after: o.verdict,
        projected_before: order.projected_date,
        projected_after: o.projected_date,
        days_saved: order.projected_date && o.projected_date ? daysBetween(o.projected_date, order.projected_date) : null,
        remaining_cause: o.cause,
        penalty_avoided: avoided,
        net_benefit: avoided != null ? round(avoided - (plan.cost || 0)) : null,
        summary: (holds
          ? `${order.so_number} ${o.projected_date ? `ships ${o.projected_date}` : 'is covered'}, within the ${order.due_date} promise${o.verdict === 'at_risk' && o.cause ? `; it still depends on this: ${o.cause}` : ''}.`
          : `${order.so_number} moves to ${o.projected_date || 'no date yet'}; still after the ${order.due_date} promise.`)
          + (avoided > 0 ? ` Avoids ${avoided} ${cur} of late-delivery penalty${plan.cost ? ` for ${plan.cost} ${cur}` : ' at no new spend'}.`.replace(/ +/g, ' ') : ''),
      },
    });
  };
  for (const c of candidates) await measure(c);

  // Two causes rarely yield to one fix. When nothing holds alone — or only with
  // no margin, still on slipping supply — measure the best move and the best
  // purchase together; the trace decides whether that holds.
  if (!plans.some((p) => GOOD[p.effect.verdict_after] >= GOOD.on_track)) {
    const best = (kind) => plans.filter((p) => p.kind === kind)
      .sort((a, b) => String(a.effect.projected_after || '9999').localeCompare(String(b.effect.projected_after || '9999')))[0];
    const parts = ['transfer_stock', 'move_operation', 'buy_from_supplier'].map(best).filter(Boolean);
    if (parts.length >= 2) {
      const src = parts.map((p) => candidates.find((c) => c.id === p.id));
      await measure({
        id: `both:${src.map((c) => c.id).join('|')}`,
        kind: 'combined',
        label: src.map((c, i) => (i ? c.label[0].toLowerCase() + c.label.slice(1) : c.label)).join(', and '),
        evidence: src.map((c) => c.evidence).join(' '),
        cost: round(src.reduce((t, c) => t + c.cost, 0)),
        currency: src.find((c) => c.currency)?.currency,
        cost_note: src.map((c) => c.cost_note).join(' '),
        actions: src.flatMap((c) => c.actions),
        assume: {
          moves: src.flatMap((c) => c.assume.moves || []),
          supplies: src.flatMap((c) => c.assume.supplies || []),
          transfers: src.flatMap((c) => c.assume.transfers || []),
        },
      });
    }
  }
  // Among plans that hold the date equally well, the cheaper one first; among
  // those that do not, the one that gets closest.
  plans.sort((a, b) => (b.effect.holds - a.effect.holds)
    || (GOOD[b.effect.verdict_after] - GOOD[a.effect.verdict_after])
    || (a.effect.holds ? (a.cost - b.cost) : 0)
    || String(a.effect.projected_after || '9999').localeCompare(String(b.effect.projected_after || '9999'))
    || (a.cost - b.cost));

  const canApprove = APPROVERS.has(opts.role);
  return {
    as_of: base.as_of,
    order: summary,
    plans,
    candidates_measured: candidates.length,
    approval: canApprove
      ? 'You can approve a plan. A move or a transfer happens at once; a purchase is raised and submitted into purchase approval.'
      : 'A manager or an admin approves these plans — on the sales order screen, or by asking Simeli to carry one out.',
    can_approve: canApprove,
    note: plans.length ? null : candidates.length
      ? `Measured ${candidates.length} possible fix${candidates.length === 1 ? '' : 'es'}; none brings ${order.so_number} forward.`
      : `No fix is available from this company's records: no stock free at another site, no not-yet-started operation to move, and no supplier with a delivery record or catalogue entry for what is short.`,
    method: 'Each plan was measured by re-running the delivery trace with the fix assumed, stock still allocated across every open order. Nothing was changed.',
  };
}

/* --------------------------------------------------------------- approve */

async function approveRecovery({ companyId: given, userId, role, salesOrder, planId }) {
  if (!APPROVERS.has(role)) return { error: 'Only a manager or an admin can approve a recovery plan.', status: 403 };
  if (!planId || !salesOrder) return { error: 'sales_order and plan_id are required.', status: 400 };
  const companyId = await resolveCompany(given);
  const fresh = await planRecovery({ companyId, userId, role, salesOrder });
  if (fresh.error) return { error: fresh.error, status: 404 };
  const plan = fresh.plans.find((p) => p.id === planId);
  if (!plan) {
    return { error: 'That plan no longer brings the order forward — stock, supply or the shop floor have changed since it was offered. Re-open the order to see what holds now.', status: 409 };
  }
  return companyContext.runWithCompany(companyId, async () => {
    const done = [];
    const records = [];
    const steps = [];
    for (const a of plan.actions) {
      if (a.type === 'move_operation') {
        const { rows } = await pool.query(
          `UPDATE work_order_operations op
              SET work_center_id = wc.id,
                  hourly_rate = CASE WHEN wc.hourly_rate > 0 THEN wc.hourly_rate ELSE op.hourly_rate END,
                  updated_at = CURRENT_TIMESTAMP
             FROM work_orders wo, work_centers wc
            WHERE op.id = $1 AND wo.id = op.work_order_id AND wo.company_id = $3
              AND wc.id = $2 AND wc.company_id = $3 AND wc.status = 'ACTIVE' AND wc.deleted_at IS NULL
              AND op.status = 'PENDING' AND COALESCE(op.actual_hours, 0) = 0
            RETURNING op.id`,
          [a.operation_id, a.work_center_id, companyId],
        );
        if (!rows.length) {
          return { error: `${done.length ? `${done.join(' ')} But the` : 'The'} operation has started or ${a.work_center_code} is no longer active; it was not moved.`, status: 409 };
        }
        done.push(`Operation moved from ${a.from_code} to ${a.work_center_code}.`);
        steps.push('The shop floor sees the operation on its new centre now.');
        continue;
      }

      if (a.type === 'transfer_stock') {
        const InventoryTransfer = require('../models/InventoryTransfer');
        const { rows: shelves } = await pool.query(
          `SELECT ism.inventory_item_id, ism.bin_id, ism.quantity_in_location::float AS qty
             FROM inventory_storage_mappings ism
             JOIN inventory_items ii ON ii.id = ism.inventory_item_id
             JOIN storage_locations sl ON sl.id = ism.storage_location_id
            WHERE ii.company_id = $1 AND sl.company_id = $1 AND ii.item_master_id = $2 AND ism.storage_location_id = $3
              AND ism.quantity_in_location > 0
              AND COALESCE(ii.status, 'APPROVED') <> 'DECLINED' AND COALESCE(ism.status, 'APPROVED') <> 'DECLINED'
            ORDER BY ism.quantity_in_location DESC`,
          [companyId, a.item_id, a.from_id],
        );
        let left = a.quantity;
        const numbers = [];
        for (const sh of shelves) {
          if (left <= 0) break;
          const take = round(Math.min(sh.qty, left), 4);
          const t = await InventoryTransfer.dispatch({
            inventory_item_id: sh.inventory_item_id, quantity: take,
            source_storage_location_id: a.from_id, source_bin_id: sh.bin_id,
            destination_storage_location_id: a.to_id,
            notes: `Delivery recovery for ${fresh.order.so_number} (${fresh.order.customer_name}), approved from the delivery outlook.`,
          }, userId);
          left = round(left - take, 4);
          numbers.push(t.transfer_number);
          records.push({ type: 'inventory_transfer', id: t.id, number: t.transfer_number });
        }
        if (left > 0) {
          return { error: `${[...done, numbers.length ? `${numbers.join(', ')} dispatched.` : ''].join(' ')} Only ${round(a.quantity - left, 3)} of ${a.quantity} × ${a.item_name} were still at ${a.from_code}; the rest was not moved.`.trim(), status: 409 };
        }
        done.push(`${a.quantity} × ${a.item_name} dispatched from ${a.from_code} to ${a.to_code} on ${numbers.join(', ')}.`);
        steps.push(`${a.to_code} receives it on Warehouse → Transfers when it arrives (expected ${a.lands}); until then the order counts it as on its way.`);
        continue;
      }

      const PurchaseOrder = require('../models/PurchaseOrder');
      const po = await PurchaseOrder.create({
        supplier_id: a.supplier_id,
        currency: a.currency || fresh.order.currency || 'USD',
        delivery_date: a.lands,
        status: 'DRAFT',
        line_items: [{
          item_id: a.item_id,
          item_description: `${a.item_name} — ${a.why} (delivery recovery)`,
          unit_of_measure: a.uom,
          quantity: a.quantity,
          unit_price: a.unit_price,
          requested_delivery_date: a.lands,
        }],
      }, userId);
      const submitted = await PurchaseOrder.submitForApproval(po.id, userId).catch(() => null);
      done.push(`${po.po_number} raised with ${a.supplier_name}${submitted ? ' and submitted for purchase approval' : ' as a draft'}.`);
      records.push({ type: 'purchase_order', id: po.id, number: po.po_number });
      steps.push(submitted
        ? `${po.po_number} follows the company's purchase approval; someone other than you approves the spend.`
        : `${po.po_number} is a draft; submit it for approval from Purchase Orders.`);
    }
    return { done: done.join(' '), plan: plan.label, effect: plan.effect, records, next_step: steps.join(' ') };
  });
}

module.exports = { planRecovery, approveRecovery, APPROVERS };
