/**
 * MRP — material requirements planning.
 *
 * Answers "given what we have promised to deliver and what we hold, what must be
 * made or bought, and by when?"
 *
 * The run is level-by-level, which is the part that makes MRP correct rather
 * than merely plausible: a sub-assembly's requirement is only known once every
 * parent that consumes it has been netted. Planning a component before its
 * parents would size it against incomplete demand and under-order.
 *
 * Netting logic per item, in order:
 *   gross requirement  — demand from sales orders and parent assemblies
 *   less on hand       — stock already available
 *   less on order      — released work orders and open purchase requisitions
 *   = net requirement  — what actually has to be planned
 *
 * Items with an active BOM become MAKE orders (and explode into further demand);
 * everything else becomes a BUY order. Nothing here writes a work order or a
 * requisition — a planning run produces proposals, and committing them is a
 * separate, deliberate step.
 */

const { randomUUID } = require('crypto');
const { pool } = require('../config/database');

const MAX_LEVELS = 20;

/**
 * Demand from confirmed sales orders that are not yet delivered.
 */
async function collectSalesDemand({ horizonDays = 90 } = {}) {
  const { rows } = await pool.query(
    `
    SELECT soi.item_id,
           SUM(soi.quantity)::float AS quantity,
           MIN(so.delivery_date) AS required_by,
           STRING_AGG(DISTINCT so.so_number, ', ') AS sources
      FROM sales_order_items soi
      JOIN sales_orders so ON so.id = soi.sales_order_id
     WHERE so.deleted_at IS NULL
       AND so.status IN ('APPROVED','CONFIRMED','CUSTOMER_ACCEPTED','IN_PRODUCTION','READY_FOR_DELIVERY')
       AND soi.item_id IS NOT NULL
       AND (so.delivery_date IS NULL OR so.delivery_date <= CURRENT_DATE + ($1::int || ' days')::interval)
     GROUP BY soi.item_id
    `,
    [horizonDays]
  ).catch(() => ({ rows: [] }));

  return rows.map((r) => ({
    item_id: r.item_id,
    quantity: Number(r.quantity),
    required_by: r.required_by,
    source: `Sales orders: ${r.sources}`,
  }));
}

/**
 * Demand from items sitting below their reorder point — replenishment demand
 * for stocked parts that no sales order names directly.
 */
async function collectReorderDemand() {
  const { rows } = await pool.query(`
    SELECT ii.item_master_id AS item_id,
           GREATEST(
             COALESCE(NULLIF(ii.maximum_stock_level, 0), ii.reorder_point * 2) - ii.current_stock_quantity,
             0
           )::float AS quantity
      FROM inventory_items ii
     WHERE ii.reorder_point IS NOT NULL
       AND ii.current_stock_quantity <= ii.reorder_point
       AND ii.item_master_id IS NOT NULL
  `).catch(() => ({ rows: [] }));

  return rows
    .filter((r) => Number(r.quantity) > 0)
    .map((r) => ({
      item_id: r.item_id,
      quantity: Number(r.quantity),
      required_by: null,
      source: 'Below reorder point',
    }));
}

async function getSupplyPosition(itemIds) {
  if (!itemIds.length) return new Map();

  const [stock, wo, pr] = await Promise.all([
    pool.query(
      `SELECT item_master_id AS item_id, SUM(current_stock_quantity)::float AS qty
         FROM inventory_items WHERE item_master_id = ANY($1) GROUP BY 1`,
      [itemIds]
    ),
    pool.query(
      `SELECT item_id, SUM(quantity_ordered - quantity_produced - quantity_scrapped)::float AS qty
         FROM work_orders
        WHERE item_id = ANY($1) AND status IN ('RELEASED','IN_PROGRESS') AND deleted_at IS NULL
        GROUP BY 1`,
      [itemIds]
    ).catch(() => ({ rows: [] })),
    pool.query(
      `SELECT item_id, SUM(quantity)::float AS qty
         FROM purchase_requisitions
        WHERE item_id = ANY($1) AND status IN ('DRAFT','PENDING_APPROVAL','APPROVED')
        GROUP BY 1`,
      [itemIds]
    ).catch(() => ({ rows: [] })),
  ]);

  const position = new Map();
  const ensure = (id) => {
    if (!position.has(id)) position.set(id, { on_hand: 0, on_order: 0 });
    return position.get(id);
  };
  stock.rows.forEach((r) => { ensure(r.item_id).on_hand = Number(r.qty) || 0; });
  wo.rows.forEach((r) => { ensure(r.item_id).on_order += Number(r.qty) || 0; });
  pr.rows.forEach((r) => { ensure(r.item_id).on_order += Number(r.qty) || 0; });
  return position;
}

/** Items that have an active BOM are made; everything else is bought. */
async function getMakeItems(itemIds) {
  if (!itemIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT b.item_id, b.id AS bom_id, b.output_quantity::float AS output_quantity
       FROM bills_of_material b
      WHERE b.item_id = ANY($1) AND b.status = 'ACTIVE' AND b.deleted_at IS NULL`,
    [itemIds]
  );
  return new Map(rows.map((r) => [r.item_id, r]));
}

/**
 * Run MRP.
 *
 * @param {object} options { horizonDays, persist, includeReorderDemand }
 * @returns {object} the planning result
 */
async function runMrp({ horizonDays = 90, persist = true, includeReorderDemand = true } = {}) {
  const runId = randomUUID();

  const salesDemand = await collectSalesDemand({ horizonDays });
  const reorderDemand = includeReorderDemand ? await collectReorderDemand() : [];

  // Level 0 demand, aggregated per item.
  let currentLevel = new Map();
  for (const d of [...salesDemand, ...reorderDemand]) {
    const existing = currentLevel.get(d.item_id);
    if (existing) {
      existing.quantity += d.quantity;
      existing.sources.push(d.source);
      if (d.required_by && (!existing.required_by || d.required_by < existing.required_by)) {
        existing.required_by = d.required_by;
      }
    } else {
      currentLevel.set(d.item_id, { quantity: d.quantity, required_by: d.required_by, sources: [d.source] });
    }
  }

  const plannedOrders = [];
  let level = 0;

  while (currentLevel.size && level < MAX_LEVELS) {
    const itemIds = [...currentLevel.keys()];
    const [supply, makeItems] = await Promise.all([getSupplyPosition(itemIds), getMakeItems(itemIds)]);

    const nextLevel = new Map();

    for (const [itemId, demand] of currentLevel) {
      const position = supply.get(itemId) || { on_hand: 0, on_order: 0 };
      const gross = demand.quantity;
      const net = gross - position.on_hand - position.on_order;

      if (net <= 1e-9) {
        plannedOrders.push({
          run_id: runId,
          item_id: itemId,
          order_type: makeItems.has(itemId) ? 'MAKE' : 'BUY',
          quantity: 0,
          bom_level: level,
          gross_requirement: gross,
          on_hand: position.on_hand,
          net_requirement: 0,
          required_by: demand.required_by,
          demand_source: demand.sources.join('; ').slice(0, 40),
          rationale: `Demand of ${gross.toFixed(2)} is already covered by ${position.on_hand.toFixed(2)} on hand and ${position.on_order.toFixed(2)} on order — nothing to plan.`,
          status: 'PLANNED',
          covered: true,
        });
        continue;
      }

      const isMake = makeItems.has(itemId);
      plannedOrders.push({
        run_id: runId,
        item_id: itemId,
        order_type: isMake ? 'MAKE' : 'BUY',
        quantity: Number(net.toFixed(4)),
        bom_level: level,
        gross_requirement: gross,
        on_hand: position.on_hand,
        net_requirement: Number(net.toFixed(4)),
        required_by: demand.required_by,
        demand_source: demand.sources.join('; ').slice(0, 40),
        rationale: `Gross requirement ${gross.toFixed(2)}, less ${position.on_hand.toFixed(2)} on hand and ${position.on_order.toFixed(2)} already on order, leaves ${net.toFixed(2)} to ${isMake ? 'manufacture' : 'purchase'}.`,
        status: 'PLANNED',
        covered: false,
      });

      // A MAKE order creates dependent demand for its components at the next
      // level down. This is why levels must be processed in order.
      if (isMake) {
        const bom = makeItems.get(itemId);
        const { rows: components } = await pool.query(
          `SELECT component_item_id, quantity_per::float AS quantity_per, scrap_percent::float AS scrap_percent
             FROM bom_components WHERE bom_id = $1`,
          [bom.bom_id]
        );
        const scale = net / bom.output_quantity;
        for (const c of components) {
          const required = c.quantity_per * scale * (1 + c.scrap_percent / 100);
          const existing = nextLevel.get(c.component_item_id);
          if (existing) {
            existing.quantity += required;
          } else {
            nextLevel.set(c.component_item_id, {
              quantity: required,
              required_by: demand.required_by,
              sources: [`Work order for parent item`],
            });
          }
        }
      }
    }

    currentLevel = nextLevel;
    level += 1;
  }

  if (level >= MAX_LEVELS) {
    throw new Error(`MRP exceeded ${MAX_LEVELS} BOM levels — this indicates a circular bill of material.`);
  }

  const actionable = plannedOrders.filter((p) => !p.covered);

  if (persist && actionable.length) {
    for (const p of actionable) {
      await pool.query(
        `INSERT INTO mrp_planned_orders
           (run_id, item_id, order_type, quantity, required_by, bom_level,
            gross_requirement, on_hand, net_requirement, demand_source, rationale, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PLANNED')`,
        [p.run_id, p.item_id, p.order_type, p.quantity, p.required_by, p.bom_level,
         p.gross_requirement, p.on_hand, p.net_requirement, p.demand_source, p.rationale]
      );
    }
  }

  // Attach names for readability.
  const ids = [...new Set(plannedOrders.map((p) => p.item_id))];
  const names = ids.length
    ? (await pool.query('SELECT id, name, item_code FROM items WHERE id = ANY($1)', [ids])).rows
    : [];
  const nameById = new Map(names.map((n) => [n.id, n]));

  return {
    run_id: runId,
    levels_processed: level,
    demand_sources: { sales_orders: salesDemand.length, reorder_point: reorderDemand.length },
    planned_orders: plannedOrders.map((p) => ({
      ...p,
      item_name: nameById.get(p.item_id)?.name || null,
      item_code: nameById.get(p.item_id)?.item_code || null,
    })),
    to_make: actionable.filter((p) => p.order_type === 'MAKE').length,
    to_buy: actionable.filter((p) => p.order_type === 'BUY').length,
    already_covered: plannedOrders.filter((p) => p.covered).length,
    persisted: persist,
    note: plannedOrders.length === 0 ? 'No demand found — no sales orders in the horizon and nothing below its reorder point.' : null,
  };
}

// Same "preferred, else cheapest active" supplier lookup reorderService.js
// uses for its own (simpler, non-MRP) reorder-point flow — kept identical so
// a BUY planned order and a bare reorder-point PR recommend suppliers the
// same way.
async function findRecommendedSupplier(itemId) {
  // status = 'ACTIVE' (see the same fix + explanation in reorderService.js —
  // supplier_items_status_check does not permit 'APPROVED').
  const r = await pool.query(
    `SELECT supplier_id, unit_price FROM supplier_items
     WHERE item_id = $1 AND status = 'ACTIVE'
     ORDER BY is_preferred DESC, unit_price ASC NULLS LAST
     LIMIT 1`,
    [itemId]
  ).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

/**
 * Turn a planned order into a real, actionable document. Kept separate from
 * the run itself so planning never commits anything by itself.
 *
 *   MAKE -> a DRAFT work order (unchanged).
 *   BUY  -> a DRAFT purchase requisition, so demand this MRP run netted from
 *           sales orders and reorder points (not just "below reorder point"
 *           in isolation — collectReorderDemand's contribution here has
 *           already been netted against on-hand and on-order alongside every
 *           other source of demand) actually reaches purchasing instead of
 *           dead-ending as a number on a planning screen nobody can act on.
 *           Still goes through the normal DOA approval workflow like any
 *           other PR — this never creates a purchase order.
 */
async function convertPlannedOrder(plannedOrderId, userId) {
  const { rows } = await pool.query(
    `SELECT * FROM mrp_planned_orders WHERE id = $1 AND status = 'PLANNED'`,
    [plannedOrderId]
  );
  if (!rows.length) throw new Error('Planned order not found, or it has already been converted.');
  const planned = rows[0];

  if (planned.order_type === 'MAKE') {
    const WorkOrder = require('../models/WorkOrder');
    const workOrder = await WorkOrder.create({
      item_id: planned.item_id,
      quantity: planned.quantity,
      planned_end_date: planned.required_by,
      source: 'MRP',
      notes: `Created from MRP run ${planned.run_id}. ${planned.rationale}`,
    }, userId);

    await pool.query(
      `UPDATE mrp_planned_orders SET status = 'CONVERTED', converted_to_id = $2 WHERE id = $1`,
      [plannedOrderId, workOrder.id]
    );

    return workOrder;
  }

  // BUY
  const { rows: itemRows } = await pool.query(
    `SELECT name, unit_of_measure FROM items WHERE id = $1`,
    [planned.item_id]
  );
  const item = itemRows[0];
  if (!item) throw new Error('Item master for this planned order no longer exists.');

  // supplier_items.item_id references inventory_items(id), not the item
  // master (items.id) — see supplier_items_item_id_fkey and the matching fix
  // in services/reorderService.js. planned.item_id is the item master, so
  // resolve the inventory_items row for it before looking up a supplier.
  const { rows: invRows } = await pool.query(
    `SELECT id FROM inventory_items WHERE item_master_id = $1 LIMIT 1`,
    [planned.item_id]
  );
  const supplier = invRows.length ? await findRecommendedSupplier(invRows[0].id) : null;

  const PurchaseRequisition = require('../models/PurchaseRequisition');
  const pr = await PurchaseRequisition.create({
    item_id: planned.item_id,
    item_description: `MRP — ${item.name} (${planned.rationale || 'planned order'})`,
    unit_of_measure: item.unit_of_measure || 'PCS',
    quantity: planned.quantity,
    estimated_unit_price: supplier?.unit_price ?? null,
    currency: 'USD',
    recommended_supplier_id: supplier?.supplier_id || null,
    supplier_recommendation_text: supplier ? 'Preferred/cheapest active supplier for this item.' : null,
    status: 'DRAFT',
  }, userId);

  await pool.query(
    `UPDATE mrp_planned_orders SET status = 'CONVERTED', converted_to_id = $2 WHERE id = $1`,
    [plannedOrderId, pr.id]
  );

  return pr;
}

async function listPlannedOrders({ runId, status = 'PLANNED' } = {}) {
  const params = [status];
  let where = 'WHERE p.status = $1';
  if (runId) { params.push(runId); where += ` AND p.run_id = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT p.*, i.name AS item_name, i.item_code
       FROM mrp_planned_orders p
       LEFT JOIN items i ON i.id = p.item_id
       ${where}
       ORDER BY p.bom_level, p.required_by NULLS LAST
       LIMIT 500`,
    params
  );
  return rows;
}

module.exports = {
  runMrp,
  convertPlannedOrder,
  listPlannedOrders,
  collectSalesDemand,
  collectReorderDemand,
  MAX_LEVELS,
};
