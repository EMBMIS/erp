/**
 * Work orders — converting components into finished goods.
 *
 * The lifecycle and its accounting consequences:
 *
 *   DRAFT      created, components exploded from the BOM. No stock or GL effect.
 *   RELEASED   authorised to start. Still no GL effect.
 *   IN_PROGRESS materials issued: Dr Work In Progress / Cr Inventory.
 *   COMPLETED  output received: Dr Inventory (finished goods) / Cr WIP,
 *              with any residual WIP taken to manufacturing variance.
 *
 * Two rules drive the implementation:
 *
 * 1. Stock movement and its GL entry happen in ONE transaction. This codebase
 *    has a history of the opposite (SalesOrder/PurchaseOrder posting on a
 *    separate connection before COMMIT, so completed orders silently produced no
 *    journal entry). Every method here threads a single client.
 *
 * 2. Component cost is captured when materials are ISSUED, not when the order is
 *    completed. Component prices move; valuing a build at completion-date prices
 *    would restate the cost of work already performed.
 */

const { pool } = require('../config/database');
const { serializeInventoryItemWrite, withDeadlockRetry, lockInventoryItemForWrite } = require('../services/dbRetry');

const WIP_ACCOUNT = '1135';
const INVENTORY_ACCOUNT = '1130';
const VARIANCE_ACCOUNT = '5150';

class WorkOrder {
  static get STATUSES() {
    return ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
  }

  // -------------------------------------------------------------------------
  // Creation — explodes the BOM into concrete component requirements
  // -------------------------------------------------------------------------
  static async create({ item_id, quantity, bom_id, planned_start_date, planned_end_date, storage_location_id, sales_order_id, source = 'MANUAL', notes }, userId) {
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error('Work order quantity must be a positive number.');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Resolve the BOM: the one given, else the active one for this item.
      const bomResult = await client.query(
        bom_id
          ? `SELECT * FROM bills_of_material WHERE id = $1 AND deleted_at IS NULL`
          : `SELECT * FROM bills_of_material WHERE item_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL`,
        [bom_id || item_id]
      );
      if (!bomResult.rows.length) {
        throw new Error(
          bom_id ? 'Bill of material not found.' : 'No active bill of material exists for this item.'
        );
      }
      const bom = bomResult.rows[0];

      if (!bom_id && bom.item_id !== item_id) {
        throw new Error('The resolved bill of material does not produce this item.');
      }

      const numResult = await client.query('SELECT generate_work_order_number() AS n');
      const woNumber = numResult.rows[0].n;

      const { rows } = await client.query(
        `INSERT INTO work_orders
           (wo_number, item_id, bom_id, quantity_ordered, status, planned_start_date, planned_end_date,
            storage_location_id, sales_order_id, source, notes, created_by)
         VALUES ($1,$2,$3,$4,'DRAFT',$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [woNumber, item_id, bom.id, qty, planned_start_date || null, planned_end_date || null,
         storage_location_id || null, sales_order_id || null, source, notes || null, userId]
      );
      const workOrder = rows[0];

      // Explode components. Requirements scale by the BOM's output quantity and
      // are grossed up for expected scrap.
      const components = await client.query(
        `SELECT * FROM bom_components WHERE bom_id = $1 ORDER BY line_number`,
        [bom.id]
      );

      const scale = qty / Number(bom.output_quantity);
      for (const c of components.rows) {
        const required = Number(c.quantity_per) * scale * (1 + Number(c.scrap_percent) / 100);
        await client.query(
          `INSERT INTO work_order_components
             (work_order_id, component_item_id, line_number, quantity_required, unit_of_measure)
           VALUES ($1,$2,$3,$4,$5)`,
          [workOrder.id, c.component_item_id, c.line_number, required.toFixed(4), c.unit_of_measure]
        );
      }

      // Copy the BOM's standard routing onto this order, scaled to its
      // quantity. A snapshot, not a reference — see migration 137 for why the
      // planned standard must not move under a released order. A BOM without a
      // routing simply produces no operations.
      await require('./WorkCenter').copyRoutingToWorkOrder(client, {
        workOrderId: workOrder.id,
        bomId: bom.id,
        quantity: qty,
      });

      await client.query('COMMIT');
      return this.findById(workOrder.id);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  static async findById(id) {
    const { rows } = await pool.query(
      `SELECT wo.*, i.name AS item_name, i.item_code, b.bom_number
         FROM work_orders wo
         LEFT JOIN items i ON i.id = wo.item_id
         LEFT JOIN bills_of_material b ON b.id = wo.bom_id
        WHERE wo.id = $1 AND wo.deleted_at IS NULL`,
      [id]
    );
    if (!rows.length) return null;

    const components = await pool.query(
      `SELECT c.*, i.name AS component_name, i.item_code AS component_code
         FROM work_order_components c
         LEFT JOIN items i ON i.id = c.component_item_id
        WHERE c.work_order_id = $1 ORDER BY c.line_number`,
      [id]
    );
    return { ...rows[0], components: components.rows };
  }

  static async findAll({ status, limit = 100 } = {}) {
    const params = [];
    let where = 'WHERE wo.deleted_at IS NULL';
    if (status) { params.push(status); where += ` AND wo.status = $${params.length}`; }
    params.push(Math.min(Number(limit) || 100, 500));
    const { rows } = await pool.query(
      `SELECT wo.*, i.name AS item_name, i.item_code
         FROM work_orders wo
         LEFT JOIN items i ON i.id = wo.item_id
         ${where}
         ORDER BY wo.created_at DESC
         LIMIT $${params.length}`,
      params
    );
    return rows;
  }

  static async release(id, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: currentRows } = await client.query(
        'SELECT status FROM work_orders WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
        [id]
      );
      if (!currentRows.length) throw new Error('Work order not found.');
      const currentStatus = currentRows[0].status;

      const { assertTransition } = require('../services/stateMachine');
      assertTransition('WORK_ORDER', currentStatus, 'RELEASED');

      const { rows } = await client.query(
        `UPDATE work_orders
            SET status = 'RELEASED', actual_start_date = COALESCE(actual_start_date, CURRENT_DATE),
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING *`,
        [id]
      );

      const { auditStatusTransition } = require('../services/auditHook');
      await auditStatusTransition({
        client,
        entityType: 'WORK_ORDER',
        entityId: id,
        fromStatus: currentStatus,
        toStatus: 'RELEASED',
        actorId: userId,
        reason: 'Work order released'
      });

      // A work order starting IS the "In Production" event for its linked sales
      // order — this replaces what used to be a manual status-panel click.
      // Guarded to the states the state machine actually allows into
      // IN_PRODUCTION (stateMachine.js SALES_ORDER map) so releasing a work
      // order against, say, an already-shipped order is a safe no-op rather
      // than a crash.
      const releasedWorkOrder = rows[0];
      if (releasedWorkOrder.sales_order_id) {
        const { rows: soRows } = await client.query(
          'SELECT status FROM sales_orders WHERE id = $1 FOR UPDATE',
          [releasedWorkOrder.sales_order_id]
        );
        const soStatus = soRows[0]?.status;
        if (soStatus && ['CONFIRMED', 'CUSTOMER_ACCEPTED', 'IN_PROGRESS'].includes(soStatus)) {
          await client.query(
            `UPDATE sales_orders SET status = 'IN_PRODUCTION', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [releasedWorkOrder.sales_order_id]
          );
          await client.query(
            `INSERT INTO sales_order_status_history (sales_order_id, from_status, to_status, changed_by, reason)
             VALUES ($1, $2, 'IN_PRODUCTION', $3, $4)`,
            [releasedWorkOrder.sales_order_id, soStatus, userId, `Work order ${releasedWorkOrder.wo_number} released into production`]
          );
        }
      }

      await client.query('COMMIT');
      return this.findById(id);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Material issue — Dr WIP / Cr Inventory, atomic with the stock movement
  // -------------------------------------------------------------------------
  /**
   * @param {Array<{component_item_id, quantity}>} issues  defaults to the full outstanding requirement
   */
  static async issueMaterials(id, issues, userId) {
    // Pre-resolve the physical inventory rows this issue will touch (same
    // max-stock-per-component selection the transaction itself uses) so the
    // per-item queue and advisory locks key on the SAME ids every other stock
    // writer uses, and are acquired BEFORE the transaction takes any row lock.
    const { rows: components } = await pool.query(
      'SELECT component_item_id FROM work_order_components WHERE work_order_id = $1',
      [id]
    );
    const masterIds = components.map((c) => c.component_item_id);
    // A component's stock is not necessarily a single inventory_items row —
    // the same item_master_id can have one row per owning user (see
    // inventory_items_unique_item_per_user). Lock and later sum ALL of them,
    // not just the single largest row, or a component whose real total stock
    // is sufficient but is split across several smaller rows fails issuance
    // with a false "insufficient stock" even though the on-hand total covers
    // the requirement.
    const physicalIds = masterIds.length
      ? (await pool.query(
          `SELECT id
             FROM inventory_items
            WHERE item_master_id = ANY($1)
            ORDER BY item_master_id, current_stock_quantity DESC`,
          [masterIds]
        )).rows.map((r) => r.id)
      : [];

    return serializeInventoryItemWrite(physicalIds, () =>
      withDeadlockRetry(() => this._issueMaterialsOnce(id, issues, userId, physicalIds))
    );
  }

  static async _issueMaterialsOnce(id, issues, userId, physicalIds = []) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Advisory locks on the affected inventory rows BEFORE any FOR UPDATE row
      // lock, so a concurrent warehouse transaction / transfer touching the
      // same rows cannot form a lock cycle with this transaction.
      if (physicalIds.length) await lockInventoryItemForWrite(client, physicalIds);

      const woResult = await client.query(
        `SELECT * FROM work_orders WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [id]
      );
      if (!woResult.rows.length) throw new Error('Work order not found.');
      const wo = woResult.rows[0];
      if (!['RELEASED', 'IN_PROGRESS'].includes(wo.status)) {
        throw new Error(`Materials can only be issued to a RELEASED or IN_PROGRESS work order (this one is ${wo.status}).`);
      }

      const compResult = await client.query(
        `SELECT * FROM work_order_components WHERE work_order_id = $1 ORDER BY line_number`,
        [id]
      );

      // Default: issue everything still outstanding.
      const requested = issues && issues.length
        ? issues
        : compResult.rows
            .map((c) => ({
              component_item_id: c.component_item_id,
              quantity: Number(c.quantity_required) - Number(c.quantity_issued),
            }))
            .filter((c) => c.quantity > 0);

      if (!requested.length) throw new Error('There is nothing left to issue on this work order.');

      let totalValue = 0;
      const issued = [];

      for (const req of requested) {
        const qty = Number(req.quantity);
        if (!Number.isFinite(qty) || qty <= 0) continue;

        const component = compResult.rows.find((c) => c.component_item_id === req.component_item_id);
        if (!component) throw new Error('A requested component is not part of this work order.');

        const outstanding = Number(component.quantity_required) - Number(component.quantity_issued);
        if (qty > outstanding + 1e-9) {
          throw new Error(
            `Cannot issue ${qty} of this component: only ${outstanding.toFixed(4)} remains required on the work order.`
          );
        }

        // Take stock at its current moving-average cost, locking every physical
        // row for this component (stock can be split across several rows — one
        // per owning user, see inventory_items_unique_item_per_user) so two
        // concurrent issues cannot both read the same balance.
        const invResult = await client.query(
          `SELECT id, current_stock_quantity::float AS stock, unit_price::float AS unit_cost
             FROM inventory_items
            WHERE item_master_id = $1 AND current_stock_quantity > 0
            ORDER BY current_stock_quantity DESC
            FOR UPDATE`,
          [req.component_item_id]
        );
        if (!invResult.rows.length) throw new Error('No inventory record exists for a required component.');

        const totalStock = invResult.rows.reduce((sum, r) => sum + Number(r.stock), 0);
        if (totalStock < qty) {
          throw new Error(
            `Insufficient stock to issue: ${qty} required but only ${totalStock} on hand. Issue is blocked rather than driving stock negative.`
          );
        }

        // Draw from rows largest-first until the requirement is covered,
        // tracking cost per row so the journal value reflects what was
        // actually consumed rather than a single row's unit cost.
        let remaining = qty;
        let unitCost = 0;
        let value = 0;
        for (const inv of invResult.rows) {
          if (remaining <= 1e-9) break;
          const take = Math.min(Number(inv.stock), remaining);
          if (take <= 0) continue;
          const rowUnitCost = Number(inv.unit_cost) || 0;
          value += Number((take * rowUnitCost).toFixed(2));
          remaining -= take;

          await client.query(
            `UPDATE inventory_items
                SET current_stock_quantity = current_stock_quantity - $2, updated_at = CURRENT_TIMESTAMP
              WHERE id = $1`,
            [inv.id, take]
          );
        }
        unitCost = qty > 0 ? Number((value / qty).toFixed(4)) : 0;
        totalValue += value;

        await client.query(
          `UPDATE work_order_components
              SET quantity_issued = quantity_issued + $2,
                  unit_cost = $3,
                  issued_value = issued_value + $4,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
          [component.id, qty, unitCost, value]
        );

        issued.push({ component_item_id: req.component_item_id, quantity: qty, unit_cost: unitCost, value });
      }

      if (totalValue > 0) {
        await this.postJournal(client, {
          description: `Material issue to work order ${wo.wo_number}`,
          sourceId: wo.id,
          sourceType: 'WORK_ORDER_ISSUE',
          debitAccount: WIP_ACCOUNT,
          creditAccount: INVENTORY_ACCOUNT,
          amount: totalValue,
          userId,
        });
      }

      await client.query(
        `UPDATE work_orders
            SET status = 'IN_PROGRESS', wip_value = wip_value + $2, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [id, totalValue]
      );

      await client.query('COMMIT');
      return { work_order_id: id, issued, total_value: Number(totalValue.toFixed(2)) };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Production confirmation — Dr Inventory (FG) / Cr WIP
  // -------------------------------------------------------------------------
  static async confirmProduction(id, { quantity_produced, quantity_scrapped = 0 }, userId) {
    const produced = Number(quantity_produced);
    const scrapped = Number(quantity_scrapped) || 0;
    if (!Number.isFinite(produced) || produced <= 0) throw new Error('Produced quantity must be positive.');

    // Pre-resolve the finished good's physical inventory row so we queue and
    // advisory-lock on the same id the transaction's FOR UPDATE will hit. When
    // no row exists yet (first confirmation) the insert still serializes with
    // other confirmations of the same item via the item-master key.
    const { rows: woRows } = await pool.query('SELECT item_id FROM work_orders WHERE id = $1', [id]);
    const masterId = woRows[0]?.item_id;
    let physicalId = null;
    if (masterId) {
      const { rows } = await pool.query(
        'SELECT id FROM inventory_items WHERE item_master_id = $1 ORDER BY current_stock_quantity DESC LIMIT 1',
        [masterId]
      );
      physicalId = rows[0]?.id || null;
    }
    const queueKeys = physicalId ? [physicalId] : (masterId ? [masterId] : []);

    return serializeInventoryItemWrite(queueKeys, () =>
      withDeadlockRetry(() => this._confirmProductionOnce(id, produced, scrapped, userId, physicalId))
    );
  }

  static async _confirmProductionOnce(id, produced, scrapped, userId, physicalId = null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (physicalId) await lockInventoryItemForWrite(client, [physicalId]);

      const woResult = await client.query(
        `SELECT * FROM work_orders WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id]
      );
      if (!woResult.rows.length) throw new Error('Work order not found.');
      const wo = woResult.rows[0];
      if (wo.status !== 'IN_PROGRESS') {
        throw new Error(`Production can only be confirmed on an IN_PROGRESS work order (this one is ${wo.status}). Issue materials first.`);
      }

      const alreadyProduced = Number(wo.quantity_produced);
      const totalAfter = alreadyProduced + produced + scrapped;
      if (totalAfter > Number(wo.quantity_ordered) + 1e-9) {
        throw new Error(
          `Confirming ${produced} produced (plus ${scrapped} scrapped) would exceed the ordered quantity of ${wo.quantity_ordered}.`
        );
      }

      // Value the output from the WIP actually accumulated, apportioned by how
      // much of the order this confirmation represents. Scrapped units consumed
      // material too, so they carry cost — that cost stays in WIP and lands in
      // variance rather than being capitalised into good stock.
      const wipValue = Number(wo.wip_value);
      const remainingToConfirm = Number(wo.quantity_ordered) - alreadyProduced - Number(wo.quantity_scrapped);
      const shareOfRemaining = remainingToConfirm > 0 ? (produced + scrapped) / remainingToConfirm : 1;
      const costReleased = Number((wipValue * shareOfRemaining).toFixed(2));
      const goodShare = produced + scrapped > 0 ? produced / (produced + scrapped) : 1;
      const capitalised = Number((costReleased * goodShare).toFixed(2));
      const variance = Number((costReleased - capitalised).toFixed(2));

      // Land the finished goods in stock.
      const invResult = await client.query(
        `SELECT id, current_stock_quantity::float AS stock, unit_price::float AS unit_cost
           FROM inventory_items WHERE item_master_id = $1 ORDER BY current_stock_quantity DESC LIMIT 1 FOR UPDATE`,
        [wo.item_id]
      );

      if (invResult.rows.length) {
        // Moving-average: blend the new production cost into existing stock.
        const inv = invResult.rows[0];
        const newQty = Number(inv.stock) + produced;
        const newUnitCost = newQty > 0
          ? (Number(inv.stock) * Number(inv.unit_cost) + capitalised) / newQty
          : Number(inv.unit_cost);
        await client.query(
          `UPDATE inventory_items
              SET current_stock_quantity = $2, unit_price = $3, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
          [inv.id, newQty, newUnitCost.toFixed(4)]
        );
      } else {
        await client.query(
          `INSERT INTO inventory_items (item_master_id, current_stock_quantity, unit_price, currency, user_id, status)
           VALUES ($1, $2, $3, 'USD', $4, 'APPROVED')`,
          [wo.item_id, produced, produced > 0 ? (capitalised / produced).toFixed(4) : 0, userId]
        );
      }

      if (capitalised > 0) {
        await this.postJournal(client, {
          description: `Production confirmation ${wo.wo_number} — ${produced} unit(s) received into stock`,
          sourceId: wo.id,
          sourceType: 'WORK_ORDER_COMPLETION',
          debitAccount: INVENTORY_ACCOUNT,
          creditAccount: WIP_ACCOUNT,
          amount: capitalised,
          userId,
        });
      }
      if (variance > 0) {
        await this.postJournal(client, {
          description: `Scrap variance on ${wo.wo_number} — ${scrapped} unit(s) scrapped`,
          sourceId: wo.id,
          sourceType: 'WORK_ORDER_VARIANCE',
          debitAccount: VARIANCE_ACCOUNT,
          creditAccount: WIP_ACCOUNT,
          amount: variance,
          userId,
        });
      }

      const newProduced = alreadyProduced + produced;
      const newScrapped = Number(wo.quantity_scrapped) + scrapped;
      const isComplete = newProduced + newScrapped >= Number(wo.quantity_ordered) - 1e-9;

      await client.query(
        `UPDATE work_orders
            SET quantity_produced = $2,
                quantity_scrapped = $3,
                wip_value = GREATEST(wip_value - $4, 0),
                completed_value = completed_value + $5,
                status = CASE WHEN $6 THEN 'COMPLETED' ELSE status END,
                actual_end_date = CASE WHEN $6 THEN CURRENT_DATE ELSE actual_end_date END,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [id, newProduced, newScrapped, costReleased, capitalised, isComplete]
      );

      await client.query('COMMIT');
      return {
        work_order_id: id,
        quantity_produced: produced,
        quantity_scrapped: scrapped,
        value_capitalised: capitalised,
        scrap_variance: variance,
        status: isComplete ? 'COMPLETED' : 'IN_PROGRESS',
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  static async cancel(id, reason, userId) {
    const { rows } = await pool.query(
      `UPDATE work_orders
          SET status = 'CANCELLED', notes = COALESCE(notes,'') || $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status IN ('DRAFT','RELEASED') AND deleted_at IS NULL
        RETURNING *`,
      [id, `\nCancelled: ${reason || 'no reason given'}`]
    );
    if (!rows.length) {
      throw new Error('Only a DRAFT or RELEASED work order can be cancelled — once materials are issued the cost must be resolved through completion or a write-off.');
    }
    return rows[0];
  }

  /**
   * Post a two-line balanced journal entry on the caller's transaction.
   * Threading the client is essential: posting on a separate connection is
   * exactly how this codebase previously produced completed orders with no GL
   * entry at all.
   */
  static async postJournal(client, { description, sourceId, sourceType, debitAccount, creditAccount, amount, userId }) {
    let accounts = await client.query(
      `SELECT id, account_code, account_name FROM chart_of_accounts
        WHERE account_code = ANY($1) AND deleted_at IS NULL`,
      [[debitAccount, creditAccount]]
    );
    let byCode = new Map(accounts.rows.map((a) => [a.account_code, a]));

    // These two accounts (1135 Work In Progress, 5150 Manufacturing Variance)
    // were missing from the standard chart template for a long stretch of this
    // codebase's history (see migration 202608200100) — a company created or
    // backfilled during that window can still be missing them even after that
    // migration ships, if the migration itself hasn't been run against this
    // database yet. Rather than leave every material issue permanently 400ing
    // until someone notices and runs a migration, self-heal: seed whichever of
    // the two manufacturing accounts every company is missing, then retry the
    // lookup once. Idempotent (ON CONFLICT DO NOTHING) and cheap — this only
    // does real work the first time it's hit per company.
    if (!byCode.has(debitAccount) || !byCode.has(creditAccount)) {
      await client.query(
        `INSERT INTO chart_of_accounts
           (company_id, account_code, account_name, account_type, account_subtype,
            account_level, is_header, normal_balance, status, created_by,
            allow_manual_posting, balance_sheet_section, current_balance)
         SELECT c.id, v.account_code, v.account_name, v.account_type, v.account_subtype,
                3, false, v.normal_balance, 'ACTIVE', $1, true, v.balance_sheet_section, 0
           FROM companies c
          CROSS JOIN (VALUES
             ('1135', 'Work In Progress', 'ASSET', 'CURRENT_ASSET', 'DEBIT', 'CURRENT_ASSETS'),
             ('5150', 'Manufacturing Variance', 'EXPENSE', 'COST_OF_SALES', 'DEBIT', 'EXPENSES')
          ) AS v(account_code, account_name, account_type, account_subtype, normal_balance, balance_sheet_section)
          WHERE c.deleted_at IS NULL
         ON CONFLICT (company_id, account_code) DO NOTHING`,
        [userId]
      );

      accounts = await client.query(
        `SELECT id, account_code, account_name FROM chart_of_accounts
          WHERE account_code = ANY($1) AND deleted_at IS NULL`,
        [[debitAccount, creditAccount]]
      );
      byCode = new Map(accounts.rows.map((a) => [a.account_code, a]));
    }

    if (!byCode.has(debitAccount) || !byCode.has(creditAccount)) {
      throw new Error(`Manufacturing GL accounts missing (need ${debitAccount} and ${creditAccount}).`);
    }

    const numResult = await client.query('SELECT generate_journal_entry_number() AS n');
    const { rows } = await client.query(
      `INSERT INTO journal_entries
         (journal_number, entry_date, posting_date, period_year, period_month, source_type, source_id,
          description, total_debit, total_credit, status, created_by, posted_by, posted_at)
       VALUES ($1, CURRENT_DATE, CURRENT_DATE,
               EXTRACT(YEAR FROM CURRENT_DATE), EXTRACT(MONTH FROM CURRENT_DATE),
               $2, $3, $4, $5, $5, 'POSTED', $6, $6, CURRENT_TIMESTAMP)
       RETURNING id`,
      [numResult.rows[0].n, sourceType, sourceId, description, amount, userId]
    );
    const entryId = rows[0].id;

    for (const [code, debit, credit, line] of [
      [debitAccount, amount, 0, 1],
      [creditAccount, 0, amount, 2],
    ]) {
      await client.query(
        `INSERT INTO journal_entry_items
           (journal_entry_id, line_number, account_id, account_code, account_name,
            debit_amount, credit_amount, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [entryId, line, byCode.get(code).id, code, byCode.get(code).account_name, debit, credit, description]
      );
    }

    // Keep the denormalised balance cache in step with what we just posted.
    // A debit increases a debit-normal account and decreases a credit-normal
    // one; a credit does the reverse.
    for (const { code, debit } of [{ code: debitAccount, debit: true }, { code: creditAccount, debit: false }]) {
      await client.query(
        `UPDATE chart_of_accounts
            SET current_balance = current_balance +
                  ($2 * CASE WHEN (normal_balance = 'DEBIT') = $3 THEN 1 ELSE -1 END),
                updated_at = CURRENT_TIMESTAMP
          WHERE account_code = $1`,
        [code, amount, debit]
      );
    }

    return entryId;
  }
}

module.exports = WorkOrder;
module.exports.WIP_ACCOUNT = WIP_ACCOUNT;
module.exports.INVENTORY_ACCOUNT = INVENTORY_ACCOUNT;
module.exports.VARIANCE_ACCOUNT = VARIANCE_ACCOUNT;
