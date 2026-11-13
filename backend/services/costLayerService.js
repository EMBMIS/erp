/**
 * Cost Layer Service — per-receipt audit trail for inventory valuation.
 *
 * Each goods receipt or stock-addition transaction creates cost_layer rows
 * recording the quantity and unit cost at receipt time. When goods are issued,
 * remaining_quantity is decremented (FIFO: oldest layers consumed first).
 *
 * The weighted-average cost at any moment can be verified as:
 *   SUM(remaining_quantity * unit_cost) / SUM(remaining_quantity)
 *
 * This gives Finance a verifiable cost basis for every unit in stock,
 * independent of the moving-average unit_price stored on inventory_items.
 */

const { pool } = require('../config/database');

class CostLayerService {
  /**
   * Record a new cost layer from a receipt or stock addition.
   * Must be called within an existing transaction — pass `client`.
   */
  static async createLayer(data, client = null) {
    const db = client || pool;
    const {
      inventory_item_id,
      receipt_id = null,
      warehouse_transaction_id = null,
      receipt_type = 'GOODS_RECEIPT',
      quantity,
      unit_cost,
      created_by = null,
    } = data;

    if (!inventory_item_id) throw new Error('inventory_item_id is required');
    if (!quantity || Number(quantity) <= 0) throw new Error('quantity must be > 0');

    const { rows } = await db.query(
      `INSERT INTO cost_layers
         (inventory_item_id, receipt_id, warehouse_transaction_id, receipt_type,
          quantity, unit_cost, remaining_quantity, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        inventory_item_id,
        receipt_id,
        warehouse_transaction_id,
        receipt_type,
        Number(quantity),
        Number(unit_cost) || 0,
        Number(quantity), // remaining starts equal to quantity
        created_by,
      ]
    );
    return rows[0];
  }

  /**
   * Consume stock from active layers according to the configured costing method.
   *
   * FIFO: oldest layers consumed first (default).
   * WEIGHTED_AVERAGE: all layers consumed proportionally at the average cost.
   * STANDARD: consumes at the provided standardCost (layer-costs ignored).
   *
   * Returns the total cost of consumed quantity (COGS basis).
   * Throws if there isn't enough stock in layers to satisfy the request.
   *
   * @param {'FIFO'|'WEIGHTED_AVERAGE'|'STANDARD'} [method='FIFO']
   * @param {number} [standardCost] — required when method is STANDARD
   */
  static async consumeLayers(inventoryItemId, quantity, client = null, method = 'FIFO', standardCost = 0) {
    const db = client || pool;
    let remaining = Number(quantity);

    if (method === 'WEIGHTED_AVERAGE') {
      // Consume proportionally from all layers at the average cost.
      const avgCost = await this.getWeightedAverageCost(inventoryItemId, db);
      const { rows: layers } = await db.query(
        `SELECT id, remaining_quantity FROM cost_layers
          WHERE inventory_item_id = $1 AND remaining_quantity > 0
          ORDER BY created_at ASC FOR UPDATE`,
        [inventoryItemId]
      );
      const totalAvailable = layers.reduce((sum, l) => sum + Number(l.remaining_quantity), 0);
      if (totalAvailable < remaining) {
        throw new Error(`Insufficient cost layers: need ${remaining}, have ${totalAvailable}`);
      }
      for (const layer of layers) {
        if (remaining <= 0) break;
        const avail = Number(layer.remaining_quantity);
        const consume = Math.min(avail, remaining);
        await db.query('UPDATE cost_layers SET remaining_quantity = remaining_quantity - $1 WHERE id = $2', [consume, layer.id]);
        remaining -= consume;
      }
      return Number(quantity) * avgCost;
    }

    if (method === 'STANDARD') {
      // Consume at the fixed standard cost — layers are decremented but cost is fixed.
      const { rows: layers } = await db.query(
        `SELECT id, remaining_quantity FROM cost_layers
          WHERE inventory_item_id = $1 AND remaining_quantity > 0
          ORDER BY created_at ASC FOR UPDATE`,
        [inventoryItemId]
      );
      const totalAvailable = layers.reduce((sum, l) => sum + Number(l.remaining_quantity), 0);
      if (totalAvailable < remaining) {
        throw new Error(`Insufficient stock: need ${remaining}, have ${totalAvailable}`);
      }
      for (const layer of layers) {
        if (remaining <= 0) break;
        const avail = Number(layer.remaining_quantity);
        const consume = Math.min(avail, remaining);
        await db.query('UPDATE cost_layers SET remaining_quantity = remaining_quantity - $1 WHERE id = $2', [consume, layer.id]);
        remaining -= consume;
      }
      return Number(quantity) * (Number(standardCost) || 0);
    }

    // FIFO (default): consume oldest layers first at their actual costs.
    const { rows: layers } = await db.query(
      `SELECT id, remaining_quantity, unit_cost
         FROM cost_layers
        WHERE inventory_item_id = $1 AND remaining_quantity > 0
        ORDER BY created_at ASC
        FOR UPDATE`,
      [inventoryItemId]
    );

    const totalAvailable = layers.reduce((sum, l) => sum + Number(l.remaining_quantity), 0);
    if (totalAvailable < remaining) {
      throw new Error(
        `Insufficient cost layers: need ${remaining}, have ${totalAvailable} for item ${inventoryItemId}`
      );
    }

    let totalCost = 0;
    for (const layer of layers) {
      if (remaining <= 0) break;
      const avail = Number(layer.remaining_quantity);
      const consume = Math.min(avail, remaining);
      await db.query(
        `UPDATE cost_layers SET remaining_quantity = remaining_quantity - $1 WHERE id = $2`,
        [consume, layer.id]
      );
      totalCost += consume * Number(layer.unit_cost);
      remaining -= consume;
    }

    return totalCost;
  }

  /**
   * Weighted-average cost computed from actual layer data.
   * Falls back to 0 when no active layers exist.
   */
  static async getWeightedAverageCost(inventoryItemId, client = null) {
    const db = client || pool;
    const { rows } = await db.query(
      `SELECT COALESCE(
         SUM(remaining_quantity * unit_cost) / NULLIF(SUM(remaining_quantity), 0), 0
       )::numeric(15,4) AS avg_cost
         FROM cost_layers
        WHERE inventory_item_id = $1 AND remaining_quantity > 0`,
      [inventoryItemId]
    );
    return Number(rows[0]?.avg_cost) || 0;
  }

  /**
   * All active layers for an item, oldest first.
   */
  static async getLayersForItem(inventoryItemId, client = null) {
    const db = client || pool;
    const { rows } = await db.query(
      `SELECT id, receipt_type, quantity, unit_cost, remaining_quantity, created_at
         FROM cost_layers
        WHERE inventory_item_id = $1 AND remaining_quantity > 0
        ORDER BY created_at ASC`,
      [inventoryItemId]
    );
    return rows;
  }

  /**
   * Compact summary for API display.
   */
  static async getLayerSummary(inventoryItemId, client = null) {
    const db = client || pool;
    const { rows } = await db.query(
      `SELECT COUNT(*)::int                        AS total_layers,
              COALESCE(SUM(remaining_quantity), 0) AS total_quantity,
              COALESCE(
                SUM(remaining_quantity * unit_cost) / NULLIF(SUM(remaining_quantity), 0), 0
              )::numeric(15,4)                     AS weighted_average_cost
         FROM cost_layers
        WHERE inventory_item_id = $1 AND remaining_quantity > 0`,
      [inventoryItemId]
    );
    const summary = rows[0] || { total_layers: 0, total_quantity: 0, weighted_average_cost: 0 };
    return {
      total_layers: Number(summary.total_layers),
      total_quantity: Number(summary.total_quantity),
      weighted_average_cost: Number(summary.weighted_average_cost),
    };
  }
}

module.exports = CostLayerService;
