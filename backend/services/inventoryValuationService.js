/**
 * Inventory valuation report — per item, per costing method, tied to the GL.
 *
 * Two valuation bases already exist in this codebase but were never surfaced
 * as a report:
 *   - MOVING_AVERAGE: inventory_items.current_stock_quantity * unit_price,
 *     the moving-average cost every goods receipt/issue already maintains.
 *   - FIFO: SUM(cost_layers.remaining_quantity * unit_cost) per item — the
 *     per-receipt layer trail services/costLayerService.js already keeps for
 *     COGS, which this report re-purposes as an independent valuation.
 *
 * Both are compared against the real 1130 (Inventory) GL balance, computed
 * the same way services/cashFlowStatementService.js computes any account
 * balance — summed directly from posted journal_entry_items, not read from
 * the mutable current_balance cache — so "ties to the GL" is an honest,
 * recomputed check rather than a claim.
 */

const { pool } = require('../config/database');

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

async function inventoryGlBalance(asOfDate) {
  const { rows } = await pool.query(
    `SELECT coa.id, coa.account_code,
            COALESCE(SUM(CASE WHEN coa.normal_balance = 'DEBIT'
                          THEN jei.debit_amount - jei.credit_amount
                          ELSE jei.credit_amount - jei.debit_amount END), 0) AS balance
       FROM chart_of_accounts coa
       LEFT JOIN journal_entry_items jei ON jei.account_id = coa.id
       LEFT JOIN journal_entries je ON je.id = jei.journal_entry_id
      WHERE coa.account_code = '1130' AND coa.deleted_at IS NULL
        AND (je.id IS NULL OR (je.status = 'POSTED' AND je.deleted_at IS NULL AND je.entry_date <= $1::date))
      GROUP BY coa.id, coa.account_code`,
    [asOfDate]
  );
  return rows[0] || null;
}

/**
 * @param {object} [options]
 * @param {string} [options.asOfDate] defaults to today
 */
async function valuationReport({ asOfDate = null } = {}) {
  const asOf = asOfDate || new Date().toISOString().split('T')[0];

  const { rows: items } = await pool.query(
    `SELECT ii.id AS inventory_item_id, ii.current_stock_quantity, ii.unit_price,
            i.name AS item_name, i.item_code
       FROM inventory_items ii
       JOIN items i ON i.id = ii.item_master_id
      WHERE ii.status = 'APPROVED' AND ii.current_stock_quantity > 0
      ORDER BY i.name`
  );

  const { rows: layerRows } = await pool.query(
    `SELECT inventory_item_id,
            COALESCE(SUM(remaining_quantity), 0) AS layer_quantity,
            COALESCE(SUM(remaining_quantity * unit_cost), 0) AS layer_value
       FROM cost_layers
      WHERE remaining_quantity > 0
      GROUP BY inventory_item_id`
  );
  const layerByItem = new Map(layerRows.map((r) => [r.inventory_item_id, r]));

  let movingAverageTotal = 0;
  let fifoTotal = 0;

  const lines = items.map((item) => {
    const qty = Number(item.current_stock_quantity);
    const movingAvgUnitCost = Number(item.unit_price) || 0;
    const movingAvgValue = round2(qty * movingAvgUnitCost);

    const layer = layerByItem.get(item.inventory_item_id);
    const fifoQty = layer ? Number(layer.layer_quantity) : 0;
    const fifoValue = layer ? round2(Number(layer.layer_value)) : null;

    movingAverageTotal += movingAvgValue;
    if (fifoValue !== null) fifoTotal += fifoValue;

    return {
      inventory_item_id: item.inventory_item_id,
      item_name: item.item_name,
      item_code: item.item_code,
      quantity_on_hand: qty,
      moving_average_unit_cost: movingAvgUnitCost,
      moving_average_value: movingAvgValue,
      fifo_layer_quantity: fifoQty,
      fifo_value: fifoValue,
      // A real, visible gap rather than a silently wrong number: an item can
      // have moving-average stock but no cost layers (e.g. stock predating
      // migration 130, or a manufacturing completion that did not lay down a
      // layer) — FIFO valuation for it is honestly "not available", not 0.
      fifo_coverage_gap: fifoValue === null || Math.abs(fifoQty - qty) > 0.0001,
    };
  });

  const gl = await inventoryGlBalance(asOf);
  const glBalance = gl ? round2(Number(gl.balance)) : null;

  return {
    as_of: asOf,
    lines,
    totals: {
      moving_average_value: round2(movingAverageTotal),
      fifo_value: round2(fifoTotal),
    },
    gl: {
      account_code: '1130',
      balance: glBalance,
    },
    ties_to_gl: {
      moving_average: glBalance !== null && Math.abs(round2(movingAverageTotal) - glBalance) < 0.01,
      fifo: glBalance !== null && Math.abs(round2(fifoTotal) - glBalance) < 0.01,
    },
  };
}

module.exports = { valuationReport, inventoryGlBalance };
