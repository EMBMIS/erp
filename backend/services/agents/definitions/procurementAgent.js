/**
 * Procurement agent — replenishment without a human in the loop.
 *
 * Uses services/ai/demandForecast.js rather than the static reorder-point scan,
 * so the trigger is "this will run out before a new order can arrive" rather
 * than "this crossed a fixed line". Lead time is the whole point: an item with
 * 20 days of cover and a 30-day lead time is already late, while one with 5 days
 * of cover and a 2-day lead time is fine.
 *
 * The agent drafts a purchase requisition. It deliberately never raises a
 * purchase order directly, even in `act` mode — committing company money to a
 * supplier is the boundary this system already places behind DOA approval, and
 * an autonomous agent should not be the thing that quietly crosses it. The
 * requisition it creates flows through exactly the same approval path a human's
 * would.
 */

const { pool } = require('../../../config/database');
const demandForecast = require('../../ai/demandForecast');

module.exports = {
  key: 'procurement_replenishment',
  displayName: 'Procurement Replenishment Agent',
  description:
    'Predicts stockouts from real consumption and lead times, and drafts purchase requisitions for items that will run out before replenishment could arrive.',
  domain: 'PROCUREMENT',
  defaultMode: 'observe',
  defaultSchedule: 60 * 60 * 12, // twice daily
  defaultAuthority: {
    max_amount: 20000,
    max_actions_per_run: 25,
    allowed_actions: ['draft_purchase_requisition'],
  },
  defaultConfig: {
    // Only act on genuinely urgent cases; PLAN-level items are reported.
    act_on_urgencies: ['STOCKED_OUT', 'CRITICAL', 'ORDER_NOW'],
    require_demand_history: true,
  },

  async detect(ctx) {
    const actOn = ctx.config.act_on_urgencies || ['STOCKED_OUT', 'CRITICAL', 'ORDER_NOW'];
    const requireHistory = ctx.config.require_demand_history !== false;

    const forecast = await demandForecast.predictReorders({ months: 6 });
    const observations = [];

    for (const p of forecast.predictions) {
      if (p.urgency === 'OK') continue;

      // Without consumption history the "prediction" is just current stock, and
      // ordering against it would be guessing with company money.
      if (requireHistory && !p.sufficient_history) {
        observations.push({
          action_type: 'draft_purchase_requisition',
          impact: 'read',
          entity_type: 'inventory_item',
          entity_id: p.inventory_item_id,
          entity_label: p.item_name || p.item_number,
          rationale: `${p.item_name} is flagged ${p.urgency} but has no consumption history, so no reliable demand figure exists. Reporting rather than ordering.`,
        });
        continue;
      }

      const isActionable = actOn.includes(p.urgency);
      if (!isActionable) {
        observations.push({
          action_type: 'draft_purchase_requisition',
          impact: 'read',
          entity_type: 'inventory_item',
          entity_id: p.inventory_item_id,
          entity_label: p.item_name || p.item_number,
          rationale: `${p.item_name}: ${p.days_of_cover} days of cover, order-by ${p.order_by_date}. Not yet urgent — monitoring.`,
        });
        continue;
      }

      // Do not stack requisitions: an open PR for this item already covers it.
      const existing = await pool.query(
        `SELECT id FROM purchase_requisitions
          WHERE item_id = $1 AND status IN ('DRAFT','PENDING_APPROVAL','APPROVED')
          LIMIT 1`,
        [p.item_master_id]
      ).catch(() => ({ rows: [] }));

      if (existing.rows.length) {
        observations.push({
          action_type: 'draft_purchase_requisition',
          impact: 'read',
          entity_type: 'inventory_item',
          entity_id: p.inventory_item_id,
          entity_label: p.item_name || p.item_number,
          rationale: `${p.item_name} is ${p.urgency} but an open requisition already covers it. Not duplicating.`,
        });
        continue;
      }

      observations.push({
        action_type: 'draft_purchase_requisition',
        impact: 'draft',
        entity_type: 'inventory_item',
        entity_id: p.inventory_item_id,
        entity_label: p.item_name || p.item_number,
        amount: p.estimated_order_value,
        currency: p.currency,
        rationale: `${p.item_name} is ${p.urgency}: ${p.rationale} Drafting a requisition for ${p.suggested_order_quantity} units.`,
        data: {
          item_master_id: p.item_master_id,
          quantity: p.suggested_order_quantity,
          urgency: p.urgency,
          days_of_cover: p.days_of_cover,
          stockout_date: p.projected_stockout_date,
          lead_time_days: p.lead_time_days,
        },
      });
    }

    return observations;
  },

  async act(observation, ctx) {
    const { item_master_id, quantity, urgency, stockout_date, lead_time_days } = observation.data;

    const supplier = await pool.query(
      `SELECT supplier_id FROM supplier_items
        WHERE item_id = $1
        ORDER BY COALESCE(unit_price, 999999) ASC
        LIMIT 1`,
      [item_master_id]
    ).catch(() => ({ rows: [] }));

    const { rows } = await pool.query(
      `INSERT INTO purchase_requisitions
         (item_id, quantity, item_description, status, recommended_supplier_id, requested_by)
       VALUES ($1, $2, $3, 'DRAFT', $4, $5)
       RETURNING id, pr_number`,
      [
        item_master_id,
        quantity,
        `Auto-replenishment (${urgency}): projected stockout ${stockout_date || 'imminent'}, supplier lead time ${lead_time_days} days.`,
        supplier.rows[0]?.supplier_id || null,
        ctx.userId || null,
      ]
    );

    return {
      purchase_requisition_id: rows[0].id,
      pr_number: rows[0].pr_number,
      quantity,
      status: 'DRAFT',
      note: 'Created as a DRAFT — it still requires normal approval before any order is placed.',
    };
  },
};
