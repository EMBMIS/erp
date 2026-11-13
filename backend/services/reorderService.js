/**
 * MRP-lite: reorder-point replenishment.
 *
 * Scans inventory_items for anything at or below its reorder_point and drafts a
 * purchase requisition for it — one PR per item, quantity sized to bring stock
 * back up to maximum_stock_level (falling back to a sane multiple of the reorder
 * point when no max is set). The recommended supplier is the item's preferred
 * supplier_items row if one exists, otherwise the cheapest active one.
 *
 * This NEVER creates a purchase order — only a DRAFT purchase requisition, which
 * still has to go through the normal DOA approval workflow like any other PR
 * (ERP-Roadmap P2 #6: "AI proposes, humans approve"). It also skips any item
 * that already has an open (non-DECLINED/CANCELLED) PR, so re-running this on a
 * schedule is safe and won't pile up duplicate drafts.
 */

const { pool } = require('../config/database');
const { currentCompanyId } = require('./companyContext');
const PurchaseRequisition = require('../models/PurchaseRequisition');

const OPEN_PR_STATUSES = ['DRAFT', 'SUBMITTED', 'PENDING_APPROVAL', 'APPROVED'];

async function findRecommendedSupplier(itemId) {
  // status = 'ACTIVE', not 'APPROVED' — supplier_items_status_check only ever
  // permits ACTIVE/INACTIVE/PENDING_SUPPLIER_CONFIRMATION/SUPPLIER_REJECTED,
  // so a filter on 'APPROVED' could never match a real row and silently
  // returned no supplier recommendation on every single call.
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
 * @param {string} userId  attributed as requested_by on created PRs
 * @param {{dryRun?: boolean}} opts
 * @param {string|null} companyId
 */
async function runReorderCheck(userId, opts = {}, companyId = currentCompanyId()) {
  const dryRun = !!opts.dryRun;
  const params = [];
  let companyClause = '';
  if (companyId) {
    companyClause = 'AND ii.company_id = $1';
    params.push(companyId);
  }

  const lowStock = await pool.query(`
    SELECT ii.id AS inventory_item_id, ii.item_master_id, ii.current_stock_quantity,
           ii.reorder_point, ii.minimum_stock_level, ii.maximum_stock_level, ii.unit_price, ii.currency,
           i.name AS item_name, i.item_code, i.unit_of_measure
    FROM inventory_items ii
    JOIN items i ON ii.item_master_id = i.id
    WHERE ii.reorder_point IS NOT NULL AND ii.current_stock_quantity <= ii.reorder_point
    ${companyClause}
    ORDER BY (ii.reorder_point - ii.current_stock_quantity) DESC
  `, params);


  const created = [];
  const skipped = [];

  for (const row of lowStock.rows) {
    const existing = await pool.query(
      `SELECT id, pr_number FROM purchase_requisitions WHERE item_id = $1 AND status = ANY($2)`,
      [row.item_master_id, OPEN_PR_STATUSES]
    );
    if (existing.rows.length > 0) {
      skipped.push({ item_code: row.item_code, item_name: row.item_name, reason: `open PR already exists (${existing.rows[0].pr_number})` });
      continue;
    }

    const target = Number(row.maximum_stock_level) > 0
      ? Number(row.maximum_stock_level)
      : Number(row.reorder_point) * 2;
    const quantity = Math.max(1, Math.ceil(target - Number(row.current_stock_quantity)));

    // supplier_items.item_id references inventory_items(id), not the item
    // master (items.id) — see supplier_items_item_id_fkey, and the same note
    // in routes/contract-items.js. Passing item_master_id here always missed.
    const supplier = await findRecommendedSupplier(row.inventory_item_id);

    if (dryRun) {
      created.push({
        item_code: row.item_code, item_name: row.item_name, quantity,
        current_stock: Number(row.current_stock_quantity), reorder_point: Number(row.reorder_point),
        recommended_supplier_id: supplier?.supplier_id || null, dry_run: true,
      });
      continue;
    }

    const pr = await PurchaseRequisition.create({
      item_id: row.item_master_id,
      item_description: `Reorder — ${row.item_name} (auto-generated: stock ${row.current_stock_quantity} <= reorder point ${row.reorder_point})`,
      unit_of_measure: row.unit_of_measure || 'PCS',
      quantity,
      estimated_unit_price: supplier?.unit_price ?? row.unit_price ?? null,
      currency: row.currency || 'USD',
      recommended_supplier_id: supplier?.supplier_id || null,
      supplier_recommendation_text: supplier ? 'Preferred/cheapest active supplier for this item.' : null,
      status: 'DRAFT',
    }, userId);

    created.push({
      pr_id: pr.id, pr_number: pr.pr_number, item_code: row.item_code, item_name: row.item_name,
      quantity, current_stock: Number(row.current_stock_quantity), reorder_point: Number(row.reorder_point),
    });
  }

  return { checked: lowStock.rows.length, created, skipped, dry_run: dryRun };
}

module.exports = { runReorderCheck };
