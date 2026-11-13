/**
 * Why a customer delivery is going to slip — traced, not guessed.
 *
 * WHAT THIS ANSWERS
 * ---------------------------------------------------------------------------
 * "Why are we going to miss Friday's delivery?" is a question no single table
 * can answer. The order says what was promised. Stock says what is on the
 * shelf, but earlier orders have first claim on it. What is not on the shelf
 * has to come from a work order or a purchase order, and each of those has its
 * own reasons to be late: a work centre running slower than it used to, an
 * operation that should have finished, a component that has not arrived, a
 * supplier that is past its promised date and usually is.
 *
 * This walks that chain for every open order line due inside a horizon, from
 * the company's own rows, and returns the path it took: the order, the cover,
 * the supply that cover depends on, and the cause behind that supply. Each step
 * names the record it came from so a person can open it and check.
 *
 * HOW THE WALK WORKS
 * ---------------------------------------------------------------------------
 *   1. Demand: open lines on orders that are committed and not yet shipped,
 *      due by the horizon. Stock is allocated in due-date order across ALL of
 *      the company's lines, including ones the caller cannot see — whether
 *      someone else's order took the stock is a fact about the business, not
 *      about the reader.
 *   2. Supply: open work orders and purchase order lines for the item,
 *      consumed in the order they are projected to land, preferring a work
 *      order raised for this very sales order.
 *   3. Projection: a purchase line lands on its promised date, or — if that has
 *      passed with nothing received — today plus the supplier's own average
 *      lateness. A work order finishes on its planned date, or later if its
 *      remaining routing hours (slowed by what its work centres have actually
 *      been achieving) or a short component push it out.
 *   4. Verdict per order: covered, on track, at risk, late, or uncovered.
 *
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It changes nothing. Proposals come back as proposals — a requisition to
 * draft, a supplier to chase, a customer to tell — and acting on any of them
 * goes through the ordinary draft-and-approve path.
 */

const { pool } = require('../config/database');
const companyContext = require('./companyContext');

/** Committed and not yet on its way — the orders whose promise can still be missed. */
const OPEN_ORDER_STATUSES = [
  'PENDING_APPROVAL', 'APPROVED', 'SENT_TO_CUSTOMER', 'CONFIRMED', 'CUSTOMER_ACCEPTED', 'IN_PRODUCTION',
];
/** Purchase orders whose goods are still to arrive. */
const OPEN_PO_STATUSES = [
  'PENDING_APPROVAL', 'APPROVED', 'SENT_TO_SUPPLIER', 'CONFIRMED', 'PREPARING_DELIVERY', 'IN_TRANSIT',
  'DELIVERED', 'GOODS_READY_FOR_RECEIPT', 'PARTIALLY_RECEIVED',
];
const OPEN_WO_STATUSES = ['DRAFT', 'RELEASED', 'IN_PROGRESS'];
const SEES_ALL_ORDERS = new Set(['ADMIN', 'MANAGER', 'FINANCE_MANAGER']);

const DAY = 86400000;
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const dateOnly = (d) => (d ? new Date(`${iso(d)}T00:00:00Z`) : null);
const addDays = (d, n) => new Date(d.getTime() + n * DAY);
const daysBetween = (a, b) => Math.round((b.getTime() - a.getTime()) / DAY);
const maxDate = (...ds) => ds.filter(Boolean).reduce((m, d) => (!m || d > m ? d : m), null);
const num = (v) => (v == null ? 0 : Number(v));
const round = (v, p = 2) => Math.round(v * 10 ** p) / 10 ** p;

async function resolveCompany(companyId) {
  return companyId || companyContext.currentCompanyId() || (await companyContext.getDefaultCompanyId());
}

/* ------------------------------------------------------------------ reads */

async function readDemand(companyId, throughDate) {
  const { rows } = await pool.query(
    `SELECT so.id AS sales_order_id, so.so_number, so.customer_id, so.customer_name, so.status AS order_status,
            so.priority, so.currency, so.created_by, so.ship_from_location_id AS site_id,
            sl.code AS site_code, sl.name AS site_name,
            c.late_delivery_penalty::float AS penalty_flat, c.late_delivery_penalty_per_day::float AS penalty_per_day,
            soi.id AS line_id, soi.line_number, soi.item_code, soi.item_name,
            COALESCE(ii.item_master_id, im.id) AS item_id,
            (soi.quantity - COALESCE(soi.quantity_delivered, 0))::float AS open_qty,
            CASE WHEN soi.quantity > 0
                 THEN (COALESCE(soi.line_total, soi.quantity * soi.unit_price) / soi.quantity)::float
                 ELSE 0 END AS unit_value,
            COALESCE(soi.promised_delivery_date, soi.requested_delivery_date, so.delivery_date) AS due_date
       FROM sales_orders so
       JOIN sales_order_items soi ON soi.sales_order_id = so.id
       LEFT JOIN customers c ON c.id = so.customer_id AND c.company_id = so.company_id
       LEFT JOIN storage_locations sl ON sl.id = so.ship_from_location_id AND sl.company_id = so.company_id
       LEFT JOIN inventory_items ii ON ii.id = soi.inventory_item_id
       LEFT JOIN LATERAL (
         SELECT i.id FROM items i
          WHERE i.company_id = so.company_id AND soi.item_code IS NOT NULL AND i.item_code = soi.item_code
          LIMIT 1
       ) im ON ii.id IS NULL
      WHERE so.company_id = $1
        AND so.deleted_at IS NULL
        AND so.status = ANY($2)
        AND soi.quantity - COALESCE(soi.quantity_delivered, 0) > 0
        AND COALESCE(soi.promised_delivery_date, soi.requested_delivery_date, so.delivery_date) <= $3::date
      ORDER BY due_date, CASE so.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 ELSE 2 END, so.so_number, soi.line_number`,
    [companyId, OPEN_ORDER_STATUSES, throughDate],
  );
  return rows;
}

async function readStock(companyId, itemIds) {
  if (!itemIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT item_master_id AS item_id, SUM(current_stock_quantity)::float AS qty
       FROM inventory_items
      WHERE company_id = $1 AND item_master_id = ANY($2) AND COALESCE(status, 'APPROVED') <> 'DECLINED'
      GROUP BY 1`,
    [companyId, itemIds],
  );
  return new Map(rows.map((r) => [r.item_id, r.qty]));
}

/**
 * Where the stock physically is: quantity placed at each storage location
 * (inventory_storage_mappings), per item. An item with nothing placed
 * anywhere has no site picture, and orders for it stay on the pooled count.
 */
async function readSiteStock(companyId, itemIds) {
  if (!itemIds.length) return [];
  const { rows } = await pool.query(
    `SELECT ii.item_master_id AS item_id, sl.id AS location_id, sl.code, sl.name,
            SUM(ism.quantity_in_location)::float AS qty
       FROM inventory_storage_mappings ism
       JOIN inventory_items ii ON ii.id = ism.inventory_item_id
       JOIN storage_locations sl ON sl.id = ism.storage_location_id
      WHERE ii.company_id = $1 AND sl.company_id = $1 AND ii.item_master_id = ANY($2)
        AND COALESCE(ii.status, 'APPROVED') <> 'DECLINED' AND COALESCE(ism.status, 'APPROVED') <> 'DECLINED'
        AND ism.quantity_in_location > 0
      GROUP BY 1, 2, 3, 4`,
    [companyId, itemIds],
  );
  return rows;
}

/** Transfers dispatched and not yet received — stock on its way to a site. */
async function readTransfersInTransit(companyId, itemIds) {
  if (!itemIds.length) return [];
  const { rows } = await pool.query(
    `SELECT t.id, t.transfer_number, ii.item_master_id AS item_id, t.quantity::float AS qty, t.dispatched_at,
            t.source_storage_location_id AS from_id, t.destination_storage_location_id AS to_id,
            src.code AS from_code, dst.code AS to_code
       FROM inventory_transfers t
       JOIN inventory_items ii ON ii.id = t.inventory_item_id
       JOIN storage_locations src ON src.id = t.source_storage_location_id
       JOIN storage_locations dst ON dst.id = t.destination_storage_location_id
      WHERE t.company_id = $1 AND t.status = 'IN_TRANSIT' AND ii.item_master_id = ANY($2)`,
    [companyId, itemIds],
  );
  return rows;
}

/**
 * How long a transfer between two sites actually takes, from this company's
 * received transfers in the last year: the pair's own record, else every
 * transfer the company has received, else one day — and the basis says which.
 */
async function readTransferTimes(companyId) {
  const { rows } = await pool.query(
    `SELECT source_storage_location_id AS from_id, destination_storage_location_id AS to_id,
            COUNT(*)::int AS n, SUM(EXTRACT(EPOCH FROM (received_at - dispatched_at)) / 86400)::float AS days
       FROM inventory_transfers
      WHERE company_id = $1 AND status = 'RECEIVED' AND received_at >= dispatched_at
        AND received_at >= now() - interval '365 days'
      GROUP BY 1, 2`,
    [companyId],
  );
  const pairs = new Map(rows.map((r) => [`${r.from_id}|${r.to_id}`, r]));
  const all = rows.reduce((t, r) => ({ n: t.n + r.n, days: t.days + r.days }), { n: 0, days: 0 });
  return (fromId, toId) => {
    const p = pairs.get(`${fromId}|${toId}`);
    if (p) return { days: Math.ceil(p.days / p.n), basis: `${p.n} transfer${p.n === 1 ? '' : 's'} between these sites in the last year took ${round(p.days / p.n, 1)} days on average` };
    if (all.n) return { days: Math.ceil(all.days / all.n), basis: `no transfer between these sites yet; the company's ${all.n} received transfer${all.n === 1 ? '' : 's'} took ${round(all.days / all.n, 1)} days on average` };
    return { days: 1, basis: 'no transfer received in the last year to measure; assumed next day' };
  };
}

async function readItemNames(companyId, itemIds) {
  if (!itemIds.length) return new Map();
  const { rows } = await pool.query(
    'SELECT id, item_code, name FROM items WHERE company_id = $1 AND id = ANY($2)',
    [companyId, itemIds],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

async function readWorkOrders(companyId, itemIds) {
  if (!itemIds.length) return [];
  const { rows } = await pool.query(
    `SELECT wo.id, wo.wo_number, wo.item_id, wo.status, wo.sales_order_id,
            GREATEST(wo.quantity_ordered - COALESCE(wo.quantity_produced, 0) - COALESCE(wo.quantity_scrapped, 0), 0)::float AS remaining,
            wo.planned_start_date, wo.planned_end_date, wo.actual_start_date
       FROM work_orders wo
      WHERE wo.company_id = $1 AND wo.deleted_at IS NULL AND wo.status = ANY($2) AND wo.item_id = ANY($3)
        AND wo.quantity_ordered - COALESCE(wo.quantity_produced, 0) - COALESCE(wo.quantity_scrapped, 0) > 0
      ORDER BY wo.planned_end_date NULLS LAST, wo.wo_number`,
    [companyId, OPEN_WO_STATUSES, itemIds],
  );
  return rows;
}

async function readPurchaseLines(companyId, itemIds) {
  if (!itemIds.length) return [];
  const { rows } = await pool.query(
    `SELECT po.id AS po_id, po.po_number, po.status, po.supplier_id, po.supplier_confirmed_at,
            COALESCE(s.trade_name, s.legal_name) AS supplier_name,
            pol.id AS line_id, pol.item_id,
            GREATEST(pol.quantity - COALESCE(pol.quantity_received, 0), 0)::float AS remaining,
            COALESCE(pol.requested_delivery_date, po.delivery_date, po.supplier_delivery_due::date) AS expected_date
       FROM purchase_orders po
       JOIN purchase_order_line_items pol ON pol.po_id = po.id
       LEFT JOIN suppliers s ON s.id = po.supplier_id
      WHERE po.company_id = $1 AND po.status = ANY($2) AND pol.item_id = ANY($3)
        AND pol.quantity - COALESCE(pol.quantity_received, 0) > 0
      ORDER BY expected_date NULLS LAST, po.po_number`,
    [companyId, OPEN_PO_STATUSES, itemIds],
  );
  return rows;
}

/**
 * How late each supplier actually delivers, from the purchase orders it has
 * already delivered in the last year: arrival (confirmed delivery, else the
 * first goods receipt) against the date it promised.
 */
async function readSupplierRecord(companyId, supplierIds) {
  if (!supplierIds.length) return new Map();
  const { rows } = await pool.query(
    `WITH arrivals AS (
       SELECT po.supplier_id, po.delivery_date,
              COALESCE(po.delivery_confirmed_at::date,
                       (SELECT MIN(gr.received_date)::date FROM goods_receipts gr WHERE gr.po_id = po.id)) AS arrived
         FROM purchase_orders po
        WHERE po.company_id = $1 AND po.supplier_id = ANY($2) AND po.delivery_date IS NOT NULL
          AND po.po_date >= CURRENT_DATE - 365
     )
     SELECT supplier_id,
            COUNT(*)::int AS deliveries,
            COUNT(*) FILTER (WHERE arrived <= delivery_date)::int AS on_time,
            COALESCE(AVG(GREATEST(arrived - delivery_date, 0)), 0)::float AS avg_days_late
       FROM arrivals
      WHERE arrived IS NOT NULL
      GROUP BY supplier_id`,
    [companyId, supplierIds],
  );
  return new Map(rows.map((r) => [r.supplier_id, r]));
}

async function readOperations(workOrderIds) {
  if (!workOrderIds.length) return [];
  const { rows } = await pool.query(
    `SELECT woo.id AS operation_id, woo.work_order_id, woo.operation_number, woo.description, woo.status,
            COALESCE(woo.planned_hours, 0)::float AS planned_hours, COALESCE(woo.actual_hours, 0)::float AS actual_hours,
            woo.scheduled_start, woo.scheduled_end,
            wc.id AS work_center_id, wc.code AS work_center_code, wc.name AS work_center_name,
            wc.status AS work_center_status, wc.efficiency_pct::float AS rated_efficiency,
            NULLIF(wc.daily_capacity_hours, 0)::float AS daily_capacity_hours
       FROM work_order_operations woo
       JOIN work_centers wc ON wc.id = woo.work_center_id
      WHERE woo.work_order_id = ANY($1)
      ORDER BY woo.work_order_id, woo.operation_number`,
    [workOrderIds],
  );
  return rows;
}

/**
 * What each work centre has actually achieved: routing hours planned against
 * hours taken, on operations finished in the last 14 days, and the same over
 * the 90 days before that. The drop between them is the "line slowed down"
 * signal, measured rather than configured.
 */
async function readWorkCenterPerformance(companyId, workCenterIds) {
  if (!workCenterIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT wc.id AS work_center_id,
            SUM(woo.planned_hours) FILTER (WHERE woo.actual_end >= now() - interval '14 days')::float AS recent_planned,
            SUM(woo.actual_hours)  FILTER (WHERE woo.actual_end >= now() - interval '14 days')::float AS recent_actual,
            SUM(woo.planned_hours) FILTER (WHERE woo.actual_end <  now() - interval '14 days')::float AS base_planned,
            SUM(woo.actual_hours)  FILTER (WHERE woo.actual_end <  now() - interval '14 days')::float AS base_actual
       FROM work_centers wc
       JOIN work_order_operations woo ON woo.work_center_id = wc.id
      WHERE wc.company_id = $1 AND wc.id = ANY($2)
        AND woo.status = 'COMPLETED' AND woo.actual_end >= now() - interval '104 days'
        AND woo.actual_hours > 0 AND woo.planned_hours > 0
      GROUP BY wc.id`,
    [companyId, workCenterIds],
  );
  const out = new Map();
  for (const r of rows) {
    const recent = r.recent_actual ? r.recent_planned / r.recent_actual : null;
    const base = r.base_actual ? r.base_planned / r.base_actual : null;
    out.set(r.work_center_id, {
      recent_performance: recent == null ? null : round(recent * 100, 1),
      baseline_performance: base == null ? null : round(base * 100, 1),
      change_pct: recent != null && base ? round(((recent - base) / base) * 100, 1) : null,
      // What the remaining routing hours get divided by. Capped so one good
      // fortnight never makes the projection promise more than the plan.
      factor: recent != null ? Math.min(recent, 1) : null,
    });
  }
  return out;
}

async function readComponents(workOrderIds) {
  if (!workOrderIds.length) return [];
  const { rows } = await pool.query(
    `SELECT woc.work_order_id, woc.component_item_id AS item_id, i.item_code, i.name AS item_name,
            GREATEST(woc.quantity_required - COALESCE(woc.quantity_issued, 0), 0)::float AS outstanding
       FROM work_order_components woc
       JOIN items i ON i.id = woc.component_item_id
      WHERE woc.work_order_id = ANY($1)
        AND woc.quantity_required - COALESCE(woc.quantity_issued, 0) > 0`,
    [workOrderIds],
  );
  return rows;
}

/**
 * What-if: the same operations, with some of them sitting on another centre.
 * Used by the recovery planner (services/deliveryRecovery.js) to measure a
 * move before anybody makes it. Only this company's active centres qualify.
 */
async function applyMoves(companyId, ops, moves) {
  if (!moves?.length) return ops;
  const { rows } = await pool.query(
    `SELECT id, code, name, status, efficiency_pct::float AS rated_efficiency,
            NULLIF(daily_capacity_hours, 0)::float AS daily_capacity_hours
       FROM work_centers WHERE company_id = $1 AND deleted_at IS NULL AND status = 'ACTIVE' AND id = ANY($2)`,
    [companyId, moves.map((m) => m.work_center_id)],
  );
  const centres = new Map(rows.map((r) => [r.id, r]));
  return ops.map((op) => {
    const move = moves.find((m) => m.operation_id === op.operation_id);
    const wc = move && centres.get(move.work_center_id);
    if (!wc) return op;
    return {
      ...op, work_center_id: wc.id, work_center_code: wc.code, work_center_name: wc.name,
      work_center_status: wc.status, rated_efficiency: wc.rated_efficiency, daily_capacity_hours: wc.daily_capacity_hours,
      // A moved operation gets a new slot; the old centre's missed schedule no longer describes it.
      scheduled_end: null,
    };
  });
}

/* ------------------------------------------------------------ projection */

function projectPurchaseLine(line, record, today) {
  const expected = dateOnly(line.expected_date);
  const causes = [];
  let projected = expected;
  const typical = record && record.deliveries >= 2 ? record.avg_days_late : 0;
  const trackRecord = record && record.deliveries
    ? `${record.on_time} of ${record.deliveries} deliveries on time in the last year, ${round(record.avg_days_late, 1)} days late on average`
    : null;

  if (!expected) {
    causes.push({ kind: 'no_promised_date', text: `${line.po_number} has no delivery date from ${line.supplier_name || 'the supplier'}` });
  } else if (expected < today) {
    const overdue = daysBetween(expected, today);
    projected = addDays(today, Math.max(1, Math.ceil(typical)));
    causes.push({
      kind: 'supplier_overdue',
      text: `${line.supplier_name || 'The supplier'} is ${overdue} day${overdue === 1 ? '' : 's'} late on ${line.po_number} (due ${iso(expected)}, nothing received)`,
      days_late: overdue,
    });
  } else if (typical >= 1) {
    projected = addDays(expected, Math.round(typical));
    causes.push({
      kind: 'supplier_habitually_late',
      text: `${line.supplier_name || 'The supplier'} usually delivers ${round(typical, 1)} days after its promised date`,
    });
  }
  if (line.status === 'PENDING_APPROVAL') {
    causes.push({ kind: 'po_not_approved', text: `${line.po_number} is still waiting for approval` });
  } else if (line.status === 'SENT_TO_SUPPLIER' && !line.supplier_confirmed_at) {
    causes.push({ kind: 'po_not_confirmed', text: `${line.supplier_name || 'The supplier'} has not confirmed ${line.po_number}` });
  }
  return { projected, causes, track_record: trackRecord };
}

/**
 * When a work order will really finish, and why that is later than planned.
 * `componentSupply` resolves a short component to the date it can arrive.
 */
function projectWorkOrder(wo, ops, perf, componentShortfalls, today, outages = null) {
  const plannedEnd = dateOnly(wo.planned_end_date);
  const plannedStart = dateOnly(wo.planned_start_date);
  const causes = [];
  const now = new Date();

  let remainingHours = 0;
  let dailyCapacity = null;
  for (const op of ops) {
    if (op.status === 'COMPLETED' || op.status === 'SKIPPED') continue;
    const p = perf.get(op.work_center_id);
    const factor = p?.factor || (op.rated_efficiency ? Math.min(op.rated_efficiency / 100, 1) : 1);
    remainingHours += Math.max(op.planned_hours - op.actual_hours, 0) / Math.max(factor, 0.1);
    if (op.daily_capacity_hours) dailyCapacity = Math.min(dailyCapacity ?? Infinity, op.daily_capacity_hours);

    const where = `${op.work_center_code || op.work_center_name}`;
    if (op.work_center_status && op.work_center_status !== 'ACTIVE') {
      causes.push({ kind: 'work_center_down', layer: 'operations', text: `Work centre ${where} is ${op.work_center_status.toLowerCase()}`, work_center_id: op.work_center_id });
    }
    if (p && p.change_pct != null && p.change_pct <= -5) {
      causes.push({
        kind: 'work_center_slowdown',
        layer: 'operations',
        text: `${where} is running ${Math.abs(p.change_pct)}% slower than its 90-day norm (${p.recent_performance}% of routing time vs ${p.baseline_performance}%)`,
        work_center_id: op.work_center_id,
        change_pct: p.change_pct,
      });
    }
    if (op.scheduled_end && new Date(op.scheduled_end) < now) {
      const behind = Math.max(1, daysBetween(dateOnly(op.scheduled_end), today));
      causes.push({
        kind: 'operation_behind',
        layer: 'operations',
        text: `Operation ${op.operation_number}${op.description ? ` (${op.description})` : ''} on ${where} was scheduled to finish ${behind} day${behind === 1 ? '' : 's'} ago and is still ${op.status.toLowerCase().replace('_', ' ')}`,
        work_center_id: op.work_center_id,
      });
    } else if (op.actual_hours > op.planned_hours && op.planned_hours > 0) {
      causes.push({
        kind: 'operation_overrun',
        layer: 'operations',
        text: `Operation ${op.operation_number} on ${where} has taken ${round(op.actual_hours, 1)} h against ${round(op.planned_hours, 1)} h planned`,
        work_center_id: op.work_center_id,
      });
    }
  }

  const start = maxDate(today, wo.actual_start_date ? null : plannedStart);
  const daysOfWork = remainingHours > 0 ? Math.ceil(remainingHours / (dailyCapacity || 8)) : 0;
  let projected = maxDate(plannedEnd, daysOfWork ? addDays(start, daysOfWork) : null);
  if (!projected && !ops.length) projected = plannedEnd;

  // What-if: a centre this work still has to pass through is out for N days.
  // Nothing on it moves until it is back; the remaining routing runs after.
  for (const op of ops) {
    const out = outages?.work_center?.get(op.work_center_id);
    if (!out || op.status === 'COMPLETED' || op.status === 'SKIPPED') continue;
    projected = maxDate(projected, addDays(today, out.days + Math.max(daysOfWork, 1)));
    causes.push({
      kind: 'work_center_outage', layer: 'operations', work_center_id: op.work_center_id,
      text: `If ${op.work_center_code || op.work_center_name} is out for ${out.days} day${out.days === 1 ? '' : 's'}, operation ${op.operation_number} of ${wo.wo_number} cannot run until ${iso(addDays(today, out.days))}`,
    });
    break;
  }

  let blocked = false;
  for (const c of componentShortfalls) {
    if (!c.arrives) {
      blocked = true;
      causes.push({ kind: 'component_uncovered', layer: 'inventory', text: `${c.outstanding_short} × ${c.item_name} needed for ${wo.wo_number} are not in stock and nothing is on order`, item_id: c.item_id });
      continue;
    }
    // Once the component lands, the remaining routing still has to run.
    projected = maxDate(projected, addDays(c.arrives, Math.max(daysOfWork, 1)));
    causes.push(...c.causes.map((x) => ({ ...x, layer: 'suppliers', po_id: c.po_id, po_number: c.po_number, supplier_id: c.supplier_id, supplier_name: c.supplier_name })));
    causes.push({ kind: 'component_short', layer: 'inventory', text: `${wo.wo_number} is short ${c.outstanding_short} × ${c.item_name} until ${c.po_number} arrives (${iso(c.arrives)})`, item_id: c.item_id });
  }

  if (wo.status === 'DRAFT' && plannedStart && plannedStart <= today) {
    causes.push({ kind: 'work_order_not_released', layer: 'production', text: `${wo.wo_number} was planned to start ${iso(plannedStart)} and has not been released` });
  }
  if (plannedEnd && plannedEnd < today) {
    causes.push({ kind: 'work_order_overdue', layer: 'production', text: `${wo.wo_number} was planned to finish ${iso(plannedEnd)} and is still ${wo.status.toLowerCase().replace('_', ' ')}` });
  }
  return { projected: blocked ? null : projected, blocked, causes, remaining_hours: round(remainingHours, 1) };
}

/* ------------------------------------------------------------------- walk */

/**
 * @param {object} opts
 *   companyId, userId, role     who is asking (role decides whose orders are visible)
 *   horizonDays                 how far ahead to look (default 14, max 120)
 *   salesOrder                  one order, by id or SO number
 *   customer                    part of a customer name
 *   dueFrom, dueTo              YYYY-MM-DD window on the promised date (e.g. "Friday")
 *   includeCovered              also return orders that are fine
 *   assume                      what-if, never written: { moves: [{operation_id, work_center_id}],
 *                               supplies: [{item_id, qty, lands, supplier_id, supplier_name, label}],
 *                               transfers: [{item_id, qty, from_id, to_id, lands, label}],
 *                               demand: { sales_order_id, so_number, customer_id, customer_name, currency, site_id,
 *                                         lines: [{item_id, item_code, item_name, qty, due, unit_value, line_number}] } }
 *                               outages: [{ kind: 'work_center'|'site'|'supplier', id, days, label }] — that centre runs
                               nothing, that site ships nothing, that supplier delivers nothing until today + days.
                               An assumed order (a quotation, a draft, a request) is served LAST, after every
 *                               committed line read, so the answer never takes stock another promise holds. It
 *                               becomes the target when no salesOrder is named.
 */
async function traceDeliveryRisk(opts = {}) {
  const companyId = await resolveCompany(opts.companyId);
  const today = dateOnly(new Date());
  const horizon = Math.min(Math.max(parseInt(opts.horizonDays, 10) || 14, 1), 120);
  let through = iso(addDays(today, horizon));
  const outages = { work_center: new Map(), site: new Map(), supplier: new Map() };
  for (const o of opts.assume?.outages || []) {
    if (outages[o.kind] && o.id) outages[o.kind].set(o.id, { days: Math.max(parseInt(o.days, 10) || 1, 1), label: o.label || null });
  }
  const back = (out) => addDays(today, out.days);
  if (opts.dueTo && opts.dueTo > through) through = opts.dueTo;

  let target = null;
  if (opts.salesOrder) {
    const isUuid = /^[0-9a-f-]{36}$/i.test(String(opts.salesOrder));
    const { rows } = await pool.query(
      `SELECT id, so_number, status, delivery_date, created_by FROM sales_orders
        WHERE company_id = $1 AND deleted_at IS NULL AND ${isUuid ? 'id = $2::uuid' : 'so_number ILIKE $2'}
        LIMIT 1`,
      [companyId, String(opts.salesOrder).trim()],
    );
    target = rows[0];
    if (!target) return { error: `No sales order ${opts.salesOrder} in this company.` };
    if (!SEES_ALL_ORDERS.has(opts.role) && opts.userId && target.created_by && target.created_by !== opts.userId) {
      return { error: `Sales order ${target.so_number} belongs to someone else's book, and your role only sees your own orders.` };
    }
    // The order's own lines may be promised further out than the horizon.
    const { rows: [far] } = await pool.query(
      `SELECT MAX(COALESCE(soi.promised_delivery_date, soi.requested_delivery_date, so.delivery_date)) AS d
         FROM sales_orders so JOIN sales_order_items soi ON soi.sales_order_id = so.id WHERE so.id = $1`,
      [target.id],
    );
    if (far?.d && iso(far.d) > through) through = iso(far.d);
  }

  const ad = opts.assume?.demand;
  if (ad?.lines?.length) {
    for (const l of ad.lines) if (l.due && l.due > through) through = l.due;
    if (!target) target = { id: ad.sales_order_id, so_number: ad.so_number, assumed: true };
  }

  // 1. Demand — every committed line due by `through`, so stock is allocated
  //    exactly as it will actually be consumed.
  const demand = (await readDemand(companyId, through)).filter((d) => !ad?.lines?.length || d.sales_order_id !== ad.sales_order_id);
  if (ad?.lines?.length) {
    const site = ad.site_id ? (await pool.query(
      'SELECT id, code, name FROM storage_locations WHERE id = $1 AND company_id = $2', [ad.site_id, companyId],
    )).rows[0] : null;
    ad.lines.forEach((l, i) => demand.push({
      sales_order_id: ad.sales_order_id, so_number: ad.so_number, customer_id: ad.customer_id || null,
      customer_name: ad.customer_name || null, order_status: 'ASSUMED', priority: null, currency: ad.currency || null,
      created_by: opts.userId || null, site_id: site?.id || null, site_code: site?.code || null, site_name: site?.name || null,
      penalty_flat: null, penalty_per_day: null, line_id: null, line_number: l.line_number || i + 1,
      item_code: l.item_code || null, item_name: l.item_name || null, item_id: l.item_id || null,
      open_qty: Number(l.qty), unit_value: Number(l.unit_value) || 0, due_date: l.due,
    }));
  }
  const itemIds = [...new Set(demand.map((d) => d.item_id).filter(Boolean))];

  // 2. Supply for those items.
  const [stock, names, workOrders, purchaseLines, siteRows, inTransit, transferTime] = await Promise.all([
    readStock(companyId, itemIds),
    readItemNames(companyId, itemIds),
    readWorkOrders(companyId, itemIds),
    readPurchaseLines(companyId, itemIds),
    readSiteStock(companyId, itemIds),
    readTransfersInTransit(companyId, itemIds),
    readTransferTimes(companyId),
  ]);

  // 2b. Sites. An order that ships from a site draws only on stock placed there
  //     and on transfers on their way there; what sits at another site is a
  //     transfer away, and is offered as one once that site's own orders are
  //     served. A transfer assumed by the recovery planner leaves its source now.
  const siteLeft = new Map(siteRows.map((r) => [`${r.item_id}|${r.location_id}`, r.qty]));
  // An item on its way between sites still has a site picture, even with every shelf emptied.
  const placed = new Set([...siteRows, ...inTransit].map((r) => r.item_id));
  const assumedTransfers = opts.assume?.transfers || [];
  for (const t of assumedTransfers) {
    const k = `${t.item_id}|${t.from_id}`;
    siteLeft.set(k, Math.max((siteLeft.get(k) || 0) - Number(t.qty), 0));
  }
  // What-if: a site that is out ships nothing until it is back. Its stock is
  // held, comes back on the day the site does, and is offered to no one before.
  const held = [];
  for (const r of siteRows) {
    const out = outages.site.get(r.location_id);
    if (!out) continue;
    const k = `${r.item_id}|${r.location_id}`;
    const q = siteLeft.get(k) || 0;
    if (q <= 0) continue;
    siteLeft.set(k, 0);
    held.push({ item_id: r.item_id, qty: q, site_id: r.location_id, code: r.code, name: r.name, out });
  }
  const siteStart = new Map(siteLeft);
  const siteOf = (d) => (d.site_id && d.item_id && placed.has(d.item_id) ? d.site_id : null);
  const siteDemand = new Map();
  for (const d of demand) {
    const site = siteOf(d);
    if (site) siteDemand.set(`${d.item_id}|${site}`, (siteDemand.get(`${d.item_id}|${site}`) || 0) + d.open_qty);
  }
  const freeElsewhere = (d, site) => siteRows
    .filter((r) => r.item_id === d.item_id && r.location_id !== site)
    .map((r) => {
      const k = `${r.item_id}|${r.location_id}`;
      const own = siteDemand.get(k) || 0;
      return { location_id: r.location_id, code: r.code, name: r.name, free: round(Math.max((siteStart.get(k) || 0) - own, 0), 3) };
    })
    .filter((e) => e.free > 0)
    .sort((a, b) => b.free - a.free);

  const woIds = workOrders.map((w) => w.id);
  const [readOps, components] = await Promise.all([readOperations(woIds), readComponents(woIds)]);
  const ops = await applyMoves(companyId, readOps, opts.assume?.moves);
  const assumed = (opts.assume?.supplies || []).map((a) => ({
    po_id: null, po_number: a.label, status: 'PROPOSED', supplier_id: a.supplier_id, supplier_name: a.supplier_name,
    item_id: a.item_id, remaining: Number(a.qty), left: Number(a.qty),
    proj: { projected: dateOnly(a.lands), causes: [], track_record: null },
  }));
  const assumedFor = (ids) => assumed.filter((a) => ids.includes(a.item_id));
  const compIds = [...new Set(components.map((c) => c.item_id))];
  const [compStock, compPurchases] = await Promise.all([
    readStock(companyId, compIds),
    readPurchaseLines(companyId, compIds),
  ]);
  const allPurchases = [...purchaseLines, ...compPurchases];
  const [supplierRecord, perf] = await Promise.all([
    readSupplierRecord(companyId, [...new Set(allPurchases.map((p) => p.supplier_id).filter(Boolean))]),
    readWorkCenterPerformance(companyId, [...new Set(ops.map((o) => o.work_center_id))]),
  ]);

  // 3a. Components: allocate component stock, then component purchases, to
  //     work orders in the order they are due to finish.
  const compLeft = new Map(compStock);
  const supplierOut = (line, proj) => {
    const out = outages.supplier.get(line.supplier_id);
    if (!out) return proj;
    return {
      ...proj,
      projected: maxDate(proj.projected, back(out)),
      causes: [...proj.causes, {
        kind: 'supplier_outage',
        text: `If ${line.supplier_name || 'the supplier'} delivers nothing for ${out.days} day${out.days === 1 ? '' : 's'}, ${line.po_number} lands ${iso(maxDate(proj.projected, back(out)))} at the earliest`,
      }],
    };
  };
  const compPoPool = compPurchases.map((p) => ({ ...p, left: p.remaining, proj: supplierOut(p, projectPurchaseLine(p, supplierRecord.get(p.supplier_id), today)) }))
    .concat(assumedFor(compIds.filter((id) => !itemIds.includes(id))))
    .sort((a, b) => (a.proj.projected?.getTime() ?? Infinity) - (b.proj.projected?.getTime() ?? Infinity));
  const shortByWo = new Map();
  for (const wo of workOrders) {
    for (const c of components.filter((x) => x.work_order_id === wo.id)) {
      const have = compLeft.get(c.item_id) || 0;
      const fromStock = Math.min(have, c.outstanding);
      compLeft.set(c.item_id, have - fromStock);
      let short = c.outstanding - fromStock;
      if (short <= 0) continue;
      const entry = { item_id: c.item_id, item_name: c.item_name, outstanding_short: round(short, 3), arrives: null, causes: [] };
      for (const p of compPoPool) {
        if (short <= 0) break;
        if (p.item_id !== c.item_id || p.left <= 0) continue;
        const take = Math.min(p.left, short);
        p.left -= take;
        short -= take;
        entry.arrives = p.proj.projected ? maxDate(entry.arrives, p.proj.projected) : entry.arrives;
        entry.po_id = p.po_id;
        entry.po_number = p.po_number;
        entry.supplier_id = p.supplier_id;
        entry.supplier_name = p.supplier_name;
        entry.causes.push(...p.proj.causes);
        entry.track_record = p.proj.track_record;
      }
      if (short > 0) entry.arrives = null;
      if (!shortByWo.has(wo.id)) shortByWo.set(wo.id, []);
      shortByWo.get(wo.id).push(entry);
    }
  }

  // 3b. Project every supply source once.
  const supplies = [];
  for (const wo of workOrders) {
    const p = projectWorkOrder(wo, ops.filter((o) => o.work_order_id === wo.id), perf, shortByWo.get(wo.id) || [], today, outages);
    supplies.push({
      kind: 'work_order', id: wo.id, number: wo.wo_number, item_id: wo.item_id, left: wo.remaining,
      sales_order_id: wo.sales_order_id, planned: dateOnly(wo.planned_end_date), status: wo.status, ...p,
      // An unfinished work order cannot land in the past, whatever its plan said.
      projected: p.projected ? maxDate(p.projected, today) : null,
    });
  }
  for (const pl of purchaseLines) {
    const p = supplierOut(pl, projectPurchaseLine(pl, supplierRecord.get(pl.supplier_id), today));
    supplies.push({
      kind: 'purchase_order', id: pl.po_id, number: pl.po_number, item_id: pl.item_id, left: pl.remaining,
      sales_order_id: null, planned: dateOnly(pl.expected_date), status: pl.status,
      supplier_id: pl.supplier_id, supplier_name: pl.supplier_name, blocked: false,
      projected: p.projected, track_record: p.track_record,
      causes: p.causes.map((c) => ({ ...c, layer: 'suppliers', po_id: pl.po_id, po_number: pl.po_number, supplier_id: pl.supplier_id, supplier_name: pl.supplier_name })),
    });
  }
  for (const t of inTransit) {
    const typical = transferTime(t.from_id, t.to_id);
    const due = addDays(dateOnly(t.dispatched_at), typical.days);
    const overdue = due < today;
    const intoOut = outages.site.get(t.to_id);
    const lands = overdue ? addDays(today, 1) : due;
    supplies.push({
      kind: 'transfer', id: t.id, number: t.transfer_number, item_id: t.item_id, left: t.qty, site_id: t.to_id,
      from_code: t.from_code, sales_order_id: null, planned: due, status: 'IN_TRANSIT', blocked: false,
      projected: intoOut ? maxDate(lands, back(intoOut)) : lands, track_record: null,
      causes: [
        ...(overdue ? [{
          kind: 'transfer_overdue', layer: 'inventory',
          text: `Transfer ${t.transfer_number} from ${t.from_code} to ${t.to_code} was due ${iso(due)} (${typical.basis}) and has not been received`,
        }] : []),
        ...(intoOut ? [{
          kind: 'site_outage', layer: 'inventory',
          text: `If ${t.to_code} is out for ${intoOut.days} day${intoOut.days === 1 ? '' : 's'}, transfer ${t.transfer_number} cannot be received before ${iso(back(intoOut))}`,
        }] : []),
      ],
    });
  }
  for (const t of assumedTransfers) {
    supplies.push({
      kind: 'transfer', id: null, number: t.label, item_id: t.item_id, left: Number(t.qty), site_id: t.to_id,
      sales_order_id: null, planned: dateOnly(t.lands), status: 'PROPOSED', blocked: false,
      projected: dateOnly(t.lands), track_record: null, causes: [],
    });
  }
  for (const a of assumedFor(itemIds)) {
    supplies.push({
      kind: 'purchase_order', id: null, number: a.po_number, item_id: a.item_id, left: a.left,
      sales_order_id: null, planned: a.proj.projected, status: a.status, supplier_id: a.supplier_id,
      supplier_name: a.supplier_name, blocked: false, projected: a.proj.projected, track_record: null, causes: [],
    });
  }
  for (const h of held) {
    supplies.push({
      kind: 'site_return', id: h.site_id, number: h.code, item_id: h.item_id, left: h.qty, site_id: h.site_id,
      sales_order_id: null, planned: back(h.out), status: 'HELD', blocked: false, projected: back(h.out), track_record: null,
      causes: [{
        kind: 'site_outage', layer: 'inventory', site_id: h.site_id,
        text: `If ${h.name} (${h.code}) is out for ${h.out.days} day${h.out.days === 1 ? '' : 's'}, its ${round(h.qty, 3)} × ${names.get(h.item_id)?.name || 'units'} cannot ship before ${iso(back(h.out))}`,
      }],
    });
  }
  const byLanding = (a, b) => (a.projected?.getTime() ?? Infinity) - (b.projected?.getTime() ?? Infinity);
  supplies.sort(byLanding);

  // 4. Allocate stock then supply to each line, in due-date order.
  const stockLeft = new Map(stock);
  for (const h of held) stockLeft.set(h.item_id, Math.max((stockLeft.get(h.item_id) || 0) - h.qty, 0));
  const lines = [];
  for (const d of demand) {
    const due = dateOnly(d.due_date);
    const site = siteOf(d);
    const siteKey = site ? `${d.item_id}|${site}` : null;
    const pooled = d.item_id ? (stockLeft.get(d.item_id) || 0) : 0;
    const onHandBefore = siteKey ? Math.min(pooled, siteLeft.get(siteKey) || 0) : pooled;
    const fromStock = Math.min(onHandBefore, d.open_qty);
    if (d.item_id) stockLeft.set(d.item_id, pooled - fromStock);
    if (siteKey) siteLeft.set(siteKey, (siteLeft.get(siteKey) || 0) - fromStock);
    let short = d.open_qty - fromStock;
    const elsewhere = site && short > 0 ? freeElsewhere(d, site) : [];
    const covering = [];
    if (d.item_id && short > 0) {
      // A transfer serves only orders shipping from where it is going.
      const candidates = supplies.filter((s) => s.item_id === d.item_id && s.left > 0 && (s.kind !== 'transfer' || s.site_id === site)
        && (s.kind !== 'site_return' || !site || s.site_id === site))
        .sort((a, b) => (b.sales_order_id === d.sales_order_id) - (a.sales_order_id === d.sales_order_id) || byLanding(a, b));
      for (const s of candidates) {
        if (short <= 0) break;
        const take = Math.min(s.left, short);
        s.left -= take;
        short -= take;
        // Units on a transfer are already in the company's count; they are now spoken for.
        if (s.kind === 'transfer') stockLeft.set(d.item_id, Math.max((stockLeft.get(d.item_id) || 0) - take, 0));
        covering.push({ supply: s, qty: take });
      }
    }
    const uncovered = round(short, 3);
    const projected = covering.length && uncovered <= 0
      ? (covering.some((c) => !c.supply.projected) ? null : maxDate(...covering.map((c) => c.supply.projected)))
      : null;

    let verdict;
    if (!d.item_id && d.open_qty > 0) verdict = 'unknown_item';
    else if (fromStock >= d.open_qty) verdict = due < today ? 'late' : 'covered';
    else if (uncovered > 0 || covering.some((c) => c.supply.blocked)) verdict = 'uncovered';
    else if (!projected || projected > due) verdict = 'late';
    else if (due < today) verdict = 'late';
    else if (covering.some((c) => c.supply.causes.length)) verdict = 'at_risk';
    else verdict = 'on_track';

    lines.push({ d, due, site, elsewhere, onHandBefore, fromStock, uncovered, covering, projected, verdict });
  }

  // 5. Group by order, keep what the caller may see and asked about.
  const seesAll = SEES_ALL_ORDERS.has(opts.role) || !opts.userId;
  const lastDay = iso(addDays(today, horizon));
  const orders = new Map();
  for (const l of lines) {
    const d = l.d;
    if (target && d.sales_order_id !== target.id) continue;
    if (!target && iso(l.due) > (opts.dueTo || lastDay)) continue;
    if (opts.dueFrom && iso(l.due) < opts.dueFrom) continue;
    if (opts.customer && !String(d.customer_name || '').toLowerCase().includes(String(opts.customer).toLowerCase())) continue;
    if (!seesAll && d.created_by && d.created_by !== opts.userId) continue;
    if (!orders.has(d.sales_order_id)) {
      orders.set(d.sales_order_id, {
        sales_order_id: d.sales_order_id, so_number: d.so_number, customer_id: d.customer_id, customer_name: d.customer_name,
        order_status: d.order_status, priority: d.priority, currency: d.currency, lines: [],
        ship_from: d.site_id ? { id: d.site_id, code: d.site_code, name: d.site_name } : null,
        terms: d.penalty_flat || d.penalty_per_day ? { flat: d.penalty_flat || 0, per_day: d.penalty_per_day || 0 } : null,
      });
    }
    orders.get(d.sales_order_id).lines.push(l);
  }

  const RANK = { uncovered: 0, late: 1, unknown_item: 2, at_risk: 3, on_track: 4, covered: 5 };
  const result = [];
  for (const o of orders.values()) {
    const worst = o.lines.reduce((w, l) => (RANK[l.verdict] < RANK[w] ? l.verdict : w), 'covered');
    const due = o.lines.reduce((m, l) => (!m || l.due < m ? l.due : m), null);
    const projected = o.lines.some((l) => l.verdict === 'uncovered' || l.verdict === 'unknown_item')
      ? null
      : maxDate(...o.lines.map((l) => (l.fromStock >= l.d.open_qty ? maxDate(today, l.due) : l.projected)));
    const exposed = o.lines.filter((l) => ['uncovered', 'late', 'at_risk'].includes(l.verdict));
    const valueAtRisk = exposed.reduce((s, l) => s + (l.d.open_qty - l.fromStock) * l.d.unit_value, 0);

    const chain = [];
    const proposals = [];
    const seen = new Set();
    const push = (step) => { const k = `${step.layer}|${step.text}`; if (!seen.has(k)) { seen.add(k); chain.push(step); } };

    for (const l of exposed) {
      const item = names.get(l.d.item_id);
      const itemLabel = item?.name || l.d.item_name || l.d.item_code;
      for (const c of l.covering) {
        const s = c.supply;
        const order = { operations: 0, suppliers: 1, inventory: 2, production: 3 };
        [...s.causes].sort((a, b) => (order[a.layer] ?? 9) - (order[b.layer] ?? 9)).forEach((cause) => push({
          layer: cause.layer, text: cause.text, kind: cause.kind,
          record: cause.po_id ? { type: 'purchase_order', id: cause.po_id, number: cause.po_number }
            : cause.work_center_id ? { type: 'work_center', id: cause.work_center_id }
              : cause.site_id ? { type: 'storage_location', id: cause.site_id }
              : { type: s.kind, id: s.id, number: s.number },
        }));
        if (s.kind === 'transfer') {
          push({
            layer: 'inventory',
            text: s.id
              ? `${round(c.qty, 3)} × ${itemLabel} on transfer ${s.number} from ${s.from_code}, arriving ${iso(s.projected)}`
              : `${round(c.qty, 3)} × ${itemLabel} arrive on ${s.number} on ${iso(s.projected)}`,
            record: s.id ? { type: 'inventory_transfer', id: s.id, number: s.number } : null,
          });
        } else if (s.kind === 'work_order') {
          push({
            layer: 'production',
            text: s.projected
              ? `${s.number} (${round(c.qty, 3)} × ${itemLabel}) now lands ${iso(s.projected)}${s.planned ? `, planned ${iso(s.planned)}` : ''}`
              : `${s.number} (${round(c.qty, 3)} × ${itemLabel}) cannot finish until its missing components are sourced`,
            record: { type: 'work_order', id: s.id, number: s.number },
          });
        } else if (!s.causes.length) {
          push({
            layer: 'suppliers',
            text: `${round(c.qty, 3)} × ${itemLabel} arrive on ${s.number} from ${s.supplier_name || 'the supplier'} on ${iso(s.projected)}`,
            record: { type: 'purchase_order', id: s.id, number: s.number },
          });
        }
      }
      const taken = l.onHandBefore;
      const siteName = l.site ? (l.d.site_name || l.d.site_code) : null;
      push({
        layer: 'inventory',
        text: (l.site
          ? `${round(l.d.open_qty, 3)} × ${itemLabel} still to ship from ${siteName}; ${round(taken, 3)} free there after earlier orders take theirs`
          : `${round(l.d.open_qty, 3)} × ${itemLabel} still to ship; ${round(taken, 3)} free in stock after earlier orders take theirs`)
          + (l.elsewhere.length ? `; ${l.elsewhere.map((e) => `${e.free} free at ${e.name} (${e.code})`).join(', ')}` : '')
          + (l.uncovered > 0 ? `, ${l.uncovered} with no stock ${l.site ? 'there' : ''} and nothing on order`.replace('  ', ' ') : ''),
        record: l.d.item_id ? { type: 'item', id: l.d.item_id, number: item?.item_code || l.d.item_code } : null,
      });
      const short = round(l.d.open_qty - l.fromStock, 3);
      for (const e of l.elsewhere.slice(0, 1)) {
        proposals.push({
          kind: 'transfer_stock',
          label: `Transfer ${round(Math.min(short, e.free), 3)} × ${itemLabel} from ${e.name} (${e.code}) to ${siteName}`,
          record: { type: 'item', id: l.d.item_id, number: item?.item_code || l.d.item_code },
        });
      }

      if (l.uncovered > 0) {
        proposals.push({
          kind: 'raise_requisition',
          label: `Draft a purchase requisition for ${l.uncovered} × ${itemLabel}, needed by ${iso(l.due)}`,
          tool: 'create_purchase_requisition_draft',
          args: { title: `Cover ${o.so_number}: ${l.uncovered} × ${itemLabel}`, notes: `Needed by ${iso(l.due)} for ${o.customer_name} (${o.so_number}). Raised from the delivery-risk trace.` },
        });
      }
      for (const c of l.covering) {
        const late = c.supply.causes.find((x) => x.kind === 'supplier_overdue' || x.kind === 'po_not_confirmed');
        if (late) {
          proposals.push({
            kind: 'chase_supplier',
            label: `Chase ${late.supplier_name || c.supply.supplier_name || 'the supplier'} on ${late.po_number || c.supply.number} for a firm date`,
            record: { type: 'purchase_order', id: late.po_id || c.supply.id, number: late.po_number || c.supply.number },
          });
        }
        if (c.supply.causes.some((x) => x.kind === 'work_center_slowdown' || x.kind === 'operation_behind' || x.kind === 'work_center_down' || x.kind === 'work_center_outage')) {
          proposals.push({
            kind: 'reschedule_production',
            label: `Re-plan ${c.supply.number}: move the late operation to another work centre or add a shift`,
            record: { type: 'work_order', id: c.supply.id, number: c.supply.number },
          });
        }
      }
    }

    const daysLate = projected && due ? Math.max(daysBetween(due, projected), 0) : null;

    // What a slip costs under the customer's own terms: certain once the order
    // is late or has no supply; for an order still at risk, what it would cost.
    let penalty = null;
    if (o.terms) {
      const slipping = worst === 'late' || worst === 'uncovered';
      const ifLate = o.terms.flat + o.terms.per_day * Math.max(slipping && daysLate ? daysLate : 1, 1);
      penalty = {
        flat: o.terms.flat,
        per_day: o.terms.per_day,
        amount: slipping ? round(ifLate) : 0,
        if_late: round(ifLate),
        terms: [o.terms.flat ? `${round(o.terms.flat)} ${o.currency || ''} per late order` : null, o.terms.per_day ? `${round(o.terms.per_day)} ${o.currency || ''} per day late` : null]
          .filter(Boolean).join(' + ').replace(/ +/g, ' '),
      };
      if (exposed.length) {
        push({
          layer: 'finance',
          text: worst === 'late'
            ? `Shipping ${daysLate} day${daysLate === 1 ? '' : 's'} late costs ${penalty.amount} ${o.currency || ''} under ${o.customer_name}'s terms (${penalty.terms})`
            : worst === 'uncovered'
              ? `Missing the date costs at least ${penalty.amount} ${o.currency || ''} under ${o.customer_name}'s terms (${penalty.terms})`
              : `If it slips, ${o.customer_name}'s terms charge ${penalty.if_late} ${o.currency || ''} (${penalty.terms})`,
          record: o.customer_id ? { type: 'customer', id: o.customer_id, number: o.customer_name } : null,
        });
      }
    }

    if (exposed.length) {
      push({
        layer: 'decisions',
        text: worst === 'uncovered'
          ? `${o.so_number} for ${o.customer_name} (due ${iso(due)}) cannot be fulfilled from what is in stock or on order`
          : worst === 'at_risk'
            ? `${o.so_number} for ${o.customer_name} (due ${iso(due)}) still makes it, but depends on supply that is already slipping`
            : `${o.so_number} for ${o.customer_name} will ship around ${iso(projected)}, ${daysLate} day${daysLate === 1 ? '' : 's'} after the ${iso(due)} promise`,
        record: { type: 'sales_order', id: o.sales_order_id, number: o.so_number },
      });
      if (worst === 'late' || worst === 'uncovered') {
        proposals.push({
          kind: 'tell_customer',
          label: projected
            ? `Tell ${o.customer_name} ${o.so_number} will arrive around ${iso(projected)}`
            : `Tell ${o.customer_name} ${o.so_number} is at risk before the ${iso(due)} date passes`,
          record: { type: 'sales_order', id: o.sales_order_id, number: o.so_number },
        });
      }
    }

    if (!exposed.length && !opts.includeCovered && !target) continue;
    const uniqueProposals = [...new Map(proposals.map((p) => [p.label, p])).values()];
    result.push({
      sales_order_id: o.sales_order_id,
      so_number: o.so_number,
      customer_id: o.customer_id || null,
      customer_name: o.customer_name,
      order_status: o.order_status,
      priority: o.priority,
      due_date: iso(due),
      projected_date: iso(projected),
      days_late: daysLate,
      verdict: worst,
      value_at_risk: round(valueAtRisk),
      value_open: round(o.lines.reduce((v, l) => v + l.d.open_qty * l.d.unit_value, 0)),
      currency: o.currency,
      ship_from: o.ship_from,
      penalty,
      cause: chain.find((s) => s.layer !== 'decisions')?.text || null,
      chain,
      proposals: uniqueProposals,
      lines: o.lines.map((l) => ({
        line_number: l.d.line_number,
        item_id: l.d.item_id,
        item: names.get(l.d.item_id)?.name || l.d.item_name || l.d.item_code,
        open_qty: round(l.d.open_qty, 3),
        from_stock: round(l.fromStock, 3),
        uncovered: l.uncovered,
        due_date: iso(l.due),
        projected_date: iso(l.fromStock >= l.d.open_qty ? maxDate(today, l.due) : l.projected),
        verdict: l.verdict,
        ship_from: l.site ? { id: l.site, code: l.d.site_code, name: l.d.site_name } : null,
        elsewhere: l.elsewhere,
        depends_on: l.covering.map((c) => ({ type: c.supply.kind, id: c.supply.id, number: c.supply.number, qty: round(c.qty, 3), lands: iso(c.supply.projected) })),
      })),
    });
  }
  if (target && !result.length) {
    return {
      as_of: iso(today),
      orders: [],
      note: `${target.so_number} is ${String(target.status).toLowerCase().replace(/_/g, ' ')} with nothing left open to ship, so there is no delivery to put at risk.`,
    };
  }
  result.sort((a, b) => RANK[a.verdict] - RANK[b.verdict] || String(a.due_date).localeCompare(String(b.due_date)));

  const count = (v) => result.filter((r) => r.verdict === v).length;
  return {
    as_of: iso(today),
    horizon_days: horizon,
    window: { from: opts.dueFrom || null, to: target ? null : (opts.dueTo || lastDay) },
    scope: seesAll ? 'all company orders' : 'orders you created',
    summary: {
      orders_checked: orders.size,
      uncovered: count('uncovered'),
      late: count('late'),
      at_risk: count('at_risk'),
      value_at_risk: round(result.reduce((s, r) => s + r.value_at_risk, 0)),
      penalty_exposure: round(result.reduce((s, r) => s + (r.penalty?.amount || 0), 0)),
    },
    orders: result,
    method:
      'Stock is allocated to open order lines in promised-date order across the whole company — for an order with a '
      + 'ship-from site, only stock placed at that site and transfers on their way there; what stock cannot cover is '
      + 'matched to open work orders (projected from remaining routing hours at each work centre\'s measured pace, and '
      + 'from component arrivals) and open purchase lines (projected from the promised date and the supplier\'s own '
      + 'delivery record). A late order is priced with the customer\'s late-delivery terms where they are on record. '
      + 'Nothing was changed.',
  };
}

module.exports = { traceDeliveryRisk, readTransferTimes };
