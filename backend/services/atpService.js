const { pool } = require('../config/database');
const { currentCompanyId } = require('./companyContext');

class ATPService {
  /**
   * Calculate time-phased Available-To-Promise (ATP) stock profile over N days horizon.
   *
   * Was broken from the day it shipped: every table/column name below except
   * `inventory_items.id` referenced schema that doesn't exist (`current_stock`
   * instead of `current_stock_quantity`, `sales_order_line_items` instead of
   * `sales_order_items`, `oli.purchase_order_id` instead of `po_id`, etc.) — it
   * threw a SQL error on every call. Corrected against the real schema.
   */
  static async calculateTimePhasedATP(itemId, horizonDays = 60, companyId = currentCompanyId()) {
    const itemParams = [itemId];
    let companyFilter = '';
    if (companyId) {
      companyFilter = 'AND ii.company_id = $2';
      itemParams.push(companyId);
    }

    const { rows: itemRows } = await pool.query(
      `SELECT ii.id, i.name AS item_name, ii.current_stock_quantity, ii.reorder_point
         FROM inventory_items ii
         JOIN items i ON i.id = ii.item_master_id
        WHERE ii.id = $1 ${companyFilter}`,
      itemParams
    );

    if (itemRows.length === 0) {
      throw new Error(`Inventory item ${itemId} not found`);
    }

    const item = itemRows[0];
    const currentStock = Number(item.current_stock_quantity || 0);
    const reorderPoint = Number(item.reorder_point || 0);

    // Incoming Purchase Orders pipeline, by requested delivery date of each line.
    // quantity_remaining (real column, maintained on receipt) is the direct
    // signal for "still owed" — more reliable than enumerating every in-flight
    // PO status by name.
    const poParams = [itemId, horizonDays];
    let poCompanyFilter = '';
    if (companyId) {
      poCompanyFilter = 'AND po.company_id = $3';
      poParams.push(companyId);
    }

    const { rows: incomingPOs } = await pool.query(
      `SELECT poli.requested_delivery_date AS date, SUM(poli.quantity_remaining)::float AS incoming_qty
         FROM purchase_order_line_items poli
         JOIN purchase_orders po ON poli.po_id = po.id
        WHERE poli.item_id = $1
          AND poli.quantity_remaining > 0
          AND po.status NOT IN ('DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'CANCELLED')
          AND (poli.requested_delivery_date IS NULL
               OR poli.requested_delivery_date <= CURRENT_DATE + ($2 || ' days')::interval)
          ${poCompanyFilter}
        GROUP BY poli.requested_delivery_date
        ORDER BY poli.requested_delivery_date ASC NULLS LAST`,
      poParams
    );

    // Outgoing Sales Order reservations, by requested delivery date of each line.
    // Excludes orders that can no longer consume stock (draft/rejected/cancelled)
    // and orders that are already fully fulfilled (completed).
    const soParams = [itemId, horizonDays];
    let soCompanyFilter = '';
    if (companyId) {
      soCompanyFilter = 'AND so.company_id = $3';
      soParams.push(companyId);
    }

    const { rows: reservedSOs } = await pool.query(
      `SELECT soi.requested_delivery_date AS date,
              SUM(soi.quantity - COALESCE(soi.quantity_delivered, 0))::float AS reserved_qty
         FROM sales_order_items soi
         JOIN sales_orders so ON soi.sales_order_id = so.id
        WHERE soi.inventory_item_id = $1
          AND (soi.quantity - COALESCE(soi.quantity_delivered, 0)) > 0
          AND so.status NOT IN ('DRAFT', 'PENDING_APPROVAL', 'CUSTOMER_REJECTED', 'CANCELLED', 'REJECTED', 'COMPLETED')
          AND so.deleted_at IS NULL
          AND (soi.requested_delivery_date IS NULL
               OR soi.requested_delivery_date <= CURRENT_DATE + ($2 || ' days')::interval)
          ${soCompanyFilter}
        GROUP BY soi.requested_delivery_date
        ORDER BY soi.requested_delivery_date ASC NULLS LAST`,
      soParams
    );

    const totalIncoming = incomingPOs.reduce((sum, r) => sum + Number(r.incoming_qty || 0), 0);
    const totalReserved = reservedSOs.reduce((sum, r) => sum + Number(r.reserved_qty || 0), 0);
    const netATP = currentStock + totalIncoming - totalReserved;

    return {
      item_id: item.id,
      item_name: item.item_name,
      current_on_hand: currentStock,
      total_incoming_pipeline: totalIncoming,
      total_reserved_orders: totalReserved,
      net_atp: Math.max(0, netATP),
      reorder_point: reorderPoint,
      status: netATP <= reorderPoint ? 'CRITICAL_DEFICIT' : netATP <= reorderPoint * 1.5 ? 'LOW_STOCK' : 'OPTIMAL',
      horizon_days: horizonDays,
      incoming_schedule: incomingPOs,
      reserved_schedule: reservedSOs,
    };
  }

  /**
   * Simple, non-time-phased available quantity: on-hand minus what's already
   * reserved by other open sales orders for this item. This is what the sales
   * order approval gate checks — it deliberately ignores the incoming PO
   * pipeline above, because promising a customer stock that depends on a
   * supplier delivery arriving on schedule is a business decision, not
   * something to grant silently at approval time.
   *
   * @param {import('pg').PoolClient} client - caller's transaction client, so
   *   this reads the same row the caller is about to reserve against, and the
   *   row lock (FOR UPDATE) holds for the rest of that transaction.
   * @param {string} inventoryItemId
   * @param {string|null} excludeOrderId - exclude this order's own existing
   *   reservation from the "already reserved" sum (used when re-checking an
   *   order that has already reserved some quantity).
   */
  static async getAvailableToPromise(client, inventoryItemId, excludeOrderId = null) {
    const { rows: stockRows } = await client.query(
      `SELECT current_stock_quantity FROM inventory_items WHERE id = $1 FOR UPDATE`,
      [inventoryItemId]
    );
    if (stockRows.length === 0) {
      throw new Error(`Inventory item ${inventoryItemId} not found`);
    }
    const onHand = Number(stockRows[0].current_stock_quantity || 0);

    const params = [inventoryItemId];
    let excludeClause = '';
    if (excludeOrderId) {
      excludeClause = 'AND so.id <> $2';
      params.push(excludeOrderId);
    }

    const { rows: reservedRows } = await client.query(
      `SELECT COALESCE(SUM(soi.quantity_reserved), 0)::float AS reserved
         FROM sales_order_items soi
         JOIN sales_orders so ON so.id = soi.sales_order_id
        WHERE soi.inventory_item_id = $1
          AND so.status NOT IN ('CANCELLED', 'REJECTED', 'CUSTOMER_REJECTED')
          AND so.deleted_at IS NULL
          ${excludeClause}`,
      params
    );
    const reserved = Number(reservedRows[0].reserved || 0);

    return onHand - reserved;
  }
}

module.exports = ATPService;
