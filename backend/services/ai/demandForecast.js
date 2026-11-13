/**
 * Intelligent inventory reorder predictions.
 *
 * services/reorderService.js answers "what is below its reorder point right
 * now?" — a static threshold that ignores how fast stock actually moves. An
 * item consuming 50 units a week and one consuming 1 are treated identically,
 * so the urgent case is discovered at the same moment as the trivial one, and
 * lead time is not considered at all.
 *
 * This module answers the forward-looking question instead: given observed
 * consumption and the supplier's lead time, WHEN does this item run out, and
 * when must an order be placed to avoid that? It derives:
 *
 *   • consumption rate from real goods-issue history
 *   • days of cover remaining, and a projected stockout date
 *   • a lead-time- and variability-aware reorder point (safety stock sized from
 *     demand volatility, not a flat guess)
 *   • an order-by date — the actionable output
 *
 * Statistical, not LLM-generated: this produces numbers that drive purchasing.
 * Items without enough movement history are reported as such rather than being
 * assigned an invented demand rate.
 */

const { pool } = require('../../config/database');
const stats = require('./stats');

// Default assumed supplier lead time when none is recorded.
const DEFAULT_LEAD_TIME_DAYS = 14;
// Service-factor for safety stock. 1.65 ≈ 95% service level under a normal
// demand assumption — i.e. stock out in roughly 1 replenishment cycle in 20.
const SERVICE_FACTOR = 1.65;
// Below this many distinct consumption periods, a rate is not trustworthy.
const MIN_CONSUMPTION_PERIODS = 3;

/**
 * Weekly consumption history per inventory item, from goods issues.
 * Goods issues (GI) are the real consumption signal — adjustments and transfers
 * move stock without representing demand.
 */
async function consumptionHistory({ months = 6 } = {}) {
  const { rows } = await pool.query(
    `
    SELECT wti.inventory_item_id,
           date_trunc('week', wt.transaction_date) AS week,
           SUM(COALESCE(NULLIF(wti.issued_quantity, 0), wti.quantity))::float AS qty
      FROM warehouse_transactions wt
      JOIN warehouse_transaction_items wti ON wti.warehouse_transaction_id = wt.id
     WHERE wt.transaction_type = 'GI'
       AND wt.transaction_date >= (CURRENT_DATE - ($1::int || ' months')::interval)
       AND wti.inventory_item_id IS NOT NULL
     GROUP BY 1, 2
     ORDER BY 1, 2
    `,
    [months]
  );

  const byItem = new Map();
  for (const r of rows) {
    if (!byItem.has(r.inventory_item_id)) byItem.set(r.inventory_item_id, []);
    byItem.get(r.inventory_item_id).push({ week: r.week, qty: Number(r.qty) });
  }
  return byItem;
}

/** Recorded lead time for an item's preferred supplier, else the default. */
async function leadTimes() {
  const { rows } = await pool
    .query(`
      SELECT si.item_id, MIN(NULLIF(si.lead_time_days, 0))::int AS lead_time_days
        FROM supplier_items si
       WHERE si.lead_time_days IS NOT NULL
       GROUP BY si.item_id
    `)
    .catch(() => ({ rows: [] })); // column is optional across builds
  return new Map(rows.map((r) => [r.item_id, r.lead_time_days]));
}

/**
 * Predict stockout timing and the reorder decision for every stocked item.
 */
async function predictReorders({ months = 6, horizonDays = 90 } = {}) {
  const [history, leadTimeByItem, { rows: items }] = await Promise.all([
    consumptionHistory({ months }),
    leadTimes(),
    pool.query(`
      SELECT ii.id, ii.item_master_id, ii.current_stock_quantity::float AS stock,
             ii.reorder_point::float AS reorder_point,
             ii.minimum_stock_level::float AS minimum_stock_level,
             ii.maximum_stock_level::float AS maximum_stock_level,
             ii.unit_price::float AS unit_price, ii.currency,
             i.name AS item_name, i.item_code AS item_number
        FROM inventory_items ii
        LEFT JOIN items i ON i.id = ii.item_master_id
       WHERE ii.status IS DISTINCT FROM 'DELETED'
    `),
  ]);

  const weeksInWindow = Math.max(Math.round((months * 30.44) / 7), 1);
  const predictions = [];

  for (const item of items) {
    const weeks = history.get(item.id) || [];
    const observedPeriods = weeks.length;
    const totalConsumed = weeks.reduce((s, w) => s + w.qty, 0);

    // Average over the WHOLE window, not just weeks with activity: an item used
    // in 2 of 26 weeks has low demand, and averaging only active weeks would
    // overstate it by an order of magnitude.
    const weeklyRate = totalConsumed / weeksInWindow;
    const dailyRate = weeklyRate / 7;

    // Volatility drives safety stock. Sparse history means unknown volatility.
    const weeklyQuantities = weeks.map((w) => w.qty);
    const volatility = observedPeriods >= MIN_CONSUMPTION_PERIODS ? stats.stdDev(weeklyQuantities) : null;

    const leadTime = leadTimeByItem.get(item.item_master_id) || DEFAULT_LEAD_TIME_DAYS;
    const stock = Number(item.stock) || 0;

    const sufficientHistory = observedPeriods >= MIN_CONSUMPTION_PERIODS && totalConsumed > 0;

    // Days of cover and projected stockout.
    let daysOfCover = null;
    let stockoutDate = null;
    if (dailyRate > 0) {
      daysOfCover = Math.floor(stock / dailyRate);
      const d = new Date();
      d.setDate(d.getDate() + daysOfCover);
      stockoutDate = d.toISOString().split('T')[0];
    }

    // Demand over lead time + safety stock sized from observed volatility.
    const leadTimeDemand = dailyRate * leadTime;
    const safetyStock = volatility != null
      ? SERVICE_FACTOR * volatility * Math.sqrt(leadTime / 7)
      : leadTimeDemand * 0.5; // fall back to a half-lead-time buffer
    const suggestedReorderPoint = stats.round2(leadTimeDemand + safetyStock);

    // Order-by date: when stock will hit the reorder point.
    let orderByDate = null;
    let daysUntilOrder = null;
    if (dailyRate > 0) {
      daysUntilOrder = Math.floor((stock - suggestedReorderPoint) / dailyRate);
      const d = new Date();
      d.setDate(d.getDate() + Math.max(daysUntilOrder, 0));
      orderByDate = d.toISOString().split('T')[0];
    }

    let urgency = 'OK';
    if (dailyRate > 0) {
      if (stock <= 0) urgency = 'STOCKED_OUT';
      else if (daysOfCover !== null && daysOfCover <= leadTime) urgency = 'CRITICAL';
      else if (daysUntilOrder !== null && daysUntilOrder <= 0) urgency = 'ORDER_NOW';
      else if (daysOfCover !== null && daysOfCover <= horizonDays) urgency = 'PLAN';
    } else if (stock <= 0) {
      urgency = 'STOCKED_OUT';
    }

    // Suggested order quantity: back up to max, else cover lead time + horizon.
    const target = Number(item.maximum_stock_level) > 0
      ? Number(item.maximum_stock_level)
      : stats.round2(suggestedReorderPoint + dailyRate * 30);
    const suggestedQty = Math.max(stats.round2(target - stock), 0);

    predictions.push({
      inventory_item_id: item.id,
      item_master_id: item.item_master_id,
      item_number: item.item_number,
      item_name: item.item_name,
      current_stock: stock,
      urgency,
      // Demand
      weekly_consumption_rate: stats.round2(weeklyRate),
      daily_consumption_rate: stats.round2(dailyRate),
      demand_volatility: volatility != null ? stats.round2(volatility) : null,
      observed_consumption_weeks: observedPeriods,
      sufficient_history: sufficientHistory,
      // Timing
      days_of_cover: daysOfCover,
      projected_stockout_date: stockoutDate,
      lead_time_days: leadTime,
      order_by_date: orderByDate,
      days_until_order_needed: daysUntilOrder,
      // Recommendation
      existing_reorder_point: item.reorder_point,
      suggested_reorder_point: suggestedReorderPoint,
      suggested_order_quantity: suggestedQty,
      estimated_order_value: stats.round2(suggestedQty * (Number(item.unit_price) || 0)),
      currency: item.currency,
      rationale: buildRationale({
        sufficientHistory, observedPeriods, weeklyRate, daysOfCover, leadTime, urgency,
        existingReorderPoint: item.reorder_point, suggestedReorderPoint, stockoutDate,
      }),
    });
  }

  const rank = { STOCKED_OUT: 0, CRITICAL: 1, ORDER_NOW: 2, PLAN: 3, OK: 4 };
  predictions.sort((a, b) => rank[a.urgency] - rank[b.urgency] || (a.days_of_cover ?? 9e9) - (b.days_of_cover ?? 9e9));

  const actionable = predictions.filter((p) => p.urgency !== 'OK');
  return {
    analysed_at: new Date().toISOString(),
    window_months: months,
    items_analysed: predictions.length,
    items_with_demand_history: predictions.filter((p) => p.sufficient_history).length,
    actionable_count: actionable.length,
    by_urgency: {
      STOCKED_OUT: predictions.filter((p) => p.urgency === 'STOCKED_OUT').length,
      CRITICAL: predictions.filter((p) => p.urgency === 'CRITICAL').length,
      ORDER_NOW: predictions.filter((p) => p.urgency === 'ORDER_NOW').length,
      PLAN: predictions.filter((p) => p.urgency === 'PLAN').length,
    },
    predictions: actionable.length ? actionable : predictions.slice(0, 20),
    note:
      predictions.length === 0
        ? 'No stocked inventory items to analyse.'
        : predictions.every((p) => !p.sufficient_history)
          ? `No item has ${MIN_CONSUMPTION_PERIODS}+ weeks of goods-issue history, so consumption rates could not be established. Predictions fall back to current stock levels only — record goods issues to enable real demand forecasting.`
          : null,
    method:
      'Consumption from goods-issue history; safety stock = 1.65σ (95% service level) scaled to lead time; reorder point = lead-time demand + safety stock.',
  };
}

/**
 * Items whose configured reorder point disagrees materially with observed
 * demand — either starving the business or tying up cash in dead stock.
 */
async function reorderPointRecommendations({ months = 6 } = {}) {
  const { predictions } = await predictReorders({ months });
  const recommendations = predictions
    .filter((p) => p.sufficient_history && p.existing_reorder_point != null)
    .map((p) => {
      const existing = Number(p.existing_reorder_point);
      const suggested = p.suggested_reorder_point;
      const delta = suggested - existing;
      if (Math.abs(delta) < Math.max(existing * 0.25, 1)) return null;
      return {
        inventory_item_id: p.inventory_item_id,
        item_name: p.item_name,
        existing_reorder_point: existing,
        suggested_reorder_point: suggested,
        change: stats.round2(delta),
        direction: delta > 0 ? 'INCREASE' : 'DECREASE',
        reason: delta > 0
          ? `Consumption of ${p.weekly_consumption_rate}/week over a ${p.lead_time_days}-day lead time needs about ${suggested} on hand to reorder safely; the current point of ${existing} risks running out before replenishment arrives.`
          : `Consumption of only ${p.weekly_consumption_rate}/week does not justify holding to ${existing}; about ${suggested} covers the lead time and frees working capital.`,
      };
    })
    .filter(Boolean);

  return {
    total: recommendations.length,
    recommendations,
    note: recommendations.length ? null : 'No reorder point differs materially from observed demand.',
  };
}

module.exports = {
  predictReorders,
  reorderPointRecommendations,
  consumptionHistory,
  DEFAULT_LEAD_TIME_DAYS,
  MIN_CONSUMPTION_PERIODS,
};

// ---------------------------------------------------------------------------

function buildRationale({ sufficientHistory, observedPeriods, weeklyRate, daysOfCover, leadTime, urgency, existingReorderPoint, suggestedReorderPoint, stockoutDate }) {
  if (!sufficientHistory) {
    return `Only ${observedPeriods} week(s) of goods-issue history — not enough to establish a consumption rate. Figures below are indicative only.`;
  }
  const parts = [
    `Consuming about ${stats.round2(weeklyRate)}/week.`,
    daysOfCover != null ? `${daysOfCover} days of cover remaining (projected stockout ${stockoutDate}).` : null,
    `Supplier lead time is ${leadTime} days.`,
  ].filter(Boolean);

  if (urgency === 'CRITICAL') {
    parts.push('Cover is already shorter than the lead time — an order placed today may arrive after stock runs out.');
  } else if (urgency === 'ORDER_NOW') {
    parts.push('Stock has reached the demand-based reorder point; order now to avoid a stockout.');
  }
  if (existingReorderPoint != null && suggestedReorderPoint > Number(existingReorderPoint) * 1.25) {
    parts.push(`The configured reorder point (${existingReorderPoint}) is below what this demand and lead time require (${suggestedReorderPoint}).`);
  }
  return parts.join(' ');
}
