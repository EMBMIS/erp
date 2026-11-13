/**
 * Serial / Lot Traceability Service.
 *
 * Connects the two halves of serial/batch tracking that already existed but
 * were never wired together: goods_receipts captures batch_lot_number and
 * serial_numbers at receipt time, and warehouse_transaction_items captures
 * batch_number/serial_number at issue time, but nothing checked one against
 * the other or let anyone ask "what happened to serial X". This service is
 * the missing ledger: recordReceipt() creates one row per traceable unit,
 * issueUnits() consumes real units (refusing an unknown or already-issued
 * serial rather than silently accepting free text), and recallReport() walks
 * a serial or lot forward from its receipt to every issue it was ever part of.
 */

const { pool } = require('../config/database');

class SerialLotService {
  /**
   * Record the traceable units created by a goods receipt. Must be called
   * within the receipt's own transaction — pass `client`.
   *
   * Untracked items (no serials, no batch/lot number given) are a no-op:
   * traceability is opt-in per receipt, matching the columns it was already
   * optional to fill in on the GR form.
   */
  static async recordReceipt(data, client = null) {
    const db = client || pool;
    const {
      inventory_item_id,
      goods_receipt_id = null,
      quantity,
      batch_lot_number = null,
      serial_numbers = [],
      expiry_date = null,
      received_date = null,
      created_by = null,
    } = data;

    if (!inventory_item_id) throw new Error('inventory_item_id is required');

    const units = [];

    if (Array.isArray(serial_numbers) && serial_numbers.length > 0) {
      for (const serial of serial_numbers) {
        if (!serial) continue;
        const { rows } = await db.query(
          `INSERT INTO serial_lot_units
             (inventory_item_id, goods_receipt_id, serial_number, batch_lot_number,
              quantity, remaining_quantity, expiry_date, received_date, created_by)
           VALUES ($1, $2, $3, $4, 1, 1, $5, COALESCE($6, CURRENT_TIMESTAMP), $7)
           RETURNING *`,
          [inventory_item_id, goods_receipt_id, String(serial), batch_lot_number, expiry_date, received_date, created_by]
        );
        units.push(rows[0]);
      }
    } else if (batch_lot_number) {
      const qty = Number(quantity);
      if (!qty || qty <= 0) throw new Error('quantity must be > 0 for a batch/lot receipt');
      const { rows } = await db.query(
        `INSERT INTO serial_lot_units
           (inventory_item_id, goods_receipt_id, batch_lot_number,
            quantity, remaining_quantity, expiry_date, received_date, created_by)
         VALUES ($1, $2, $3, $4, $4, $5, COALESCE($6, CURRENT_TIMESTAMP), $7)
         RETURNING *`,
        [inventory_item_id, goods_receipt_id, batch_lot_number, qty, expiry_date, received_date, created_by]
      );
      units.push(rows[0]);
    }

    return units;
  }

  /**
   * Consume real traceable units for an issue. Refuses (rather than silently
   * accepting) a serial number that was never received for this item, or one
   * that has already been fully issued — that refusal is the actual
   * traceability guarantee; without it "serial number" on an issue is just a
   * free-text note nobody can trust.
   *
   * Untracked issues (no serial_numbers and no batch_lot_number given) are a
   * no-op — not every issue of a tracked item needs to specify which unit,
   * and plenty of items are not lot-tracked at all.
   *
   * @returns {Array} the serial_lot_movements rows created
   */
  static async issueUnits(data, client = null) {
    const db = client || pool;
    const {
      inventory_item_id,
      quantity,
      serial_numbers = [],
      batch_lot_number = null,
      warehouse_transaction_id = null,
      reference_type = null,
      reference_id = null,
      created_by = null,
    } = data;

    if (!inventory_item_id) throw new Error('inventory_item_id is required');
    const movements = [];

    if (Array.isArray(serial_numbers) && serial_numbers.length > 0) {
      for (const serial of serial_numbers) {
        const { rows } = await db.query(
          `SELECT id, remaining_quantity FROM serial_lot_units
            WHERE inventory_item_id = $1 AND serial_number = $2 AND remaining_quantity > 0
            FOR UPDATE`,
          [inventory_item_id, String(serial)]
        );
        if (rows.length === 0) {
          throw new Error(`Serial number ${serial} was not received for this item, or has already been issued.`);
        }
        const unit = rows[0];
        await db.query(
          `UPDATE serial_lot_units SET remaining_quantity = 0, status = 'ISSUED' WHERE id = $1`,
          [unit.id]
        );
        const mv = await db.query(
          `INSERT INTO serial_lot_movements
             (unit_id, warehouse_transaction_id, quantity, reference_type, reference_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [unit.id, warehouse_transaction_id, unit.remaining_quantity, reference_type, reference_id, created_by]
        );
        movements.push(mv.rows[0]);
      }
      return movements;
    }

    if (batch_lot_number) {
      let remaining = Number(quantity);
      if (!remaining || remaining <= 0) throw new Error('quantity must be > 0 to issue against a batch/lot');

      const { rows: units } = await db.query(
        `SELECT id, remaining_quantity FROM serial_lot_units
          WHERE inventory_item_id = $1 AND batch_lot_number = $2 AND remaining_quantity > 0
          ORDER BY received_date ASC
          FOR UPDATE`,
        [inventory_item_id, batch_lot_number]
      );
      const available = units.reduce((sum, u) => sum + Number(u.remaining_quantity), 0);
      if (available < remaining) {
        throw new Error(`Lot ${batch_lot_number} has only ${available} traceable units remaining; cannot issue ${remaining}.`);
      }
      for (const unit of units) {
        if (remaining <= 0) break;
        const consume = Math.min(Number(unit.remaining_quantity), remaining);
        const newRemaining = Number(unit.remaining_quantity) - consume;
        await db.query(
          `UPDATE serial_lot_units
              SET remaining_quantity = $2,
                  status = CASE WHEN $2 <= 0 THEN 'ISSUED' ELSE 'PARTIALLY_ISSUED' END
            WHERE id = $1`,
          [unit.id, newRemaining]
        );
        const mv = await db.query(
          `INSERT INTO serial_lot_movements
             (unit_id, warehouse_transaction_id, quantity, reference_type, reference_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [unit.id, warehouse_transaction_id, consume, reference_type, reference_id, created_by]
        );
        movements.push(mv.rows[0]);
        remaining -= consume;
      }
      return movements;
    }

    return movements;
  }

  /**
   * Recall trail for a serial or lot: where it was received from, and every
   * issue that ever drew from it. Exactly one of serialNumber/batchLotNumber
   * should be given.
   */
  static async recallReport({ inventoryItemId = null, serialNumber = null, batchLotNumber = null } = {}) {
    if (!serialNumber && !batchLotNumber) {
      throw new Error('serialNumber or batchLotNumber is required');
    }

    const conditions = [];
    const params = [];
    if (inventoryItemId) { params.push(inventoryItemId); conditions.push(`slu.inventory_item_id = $${params.length}`); }
    if (serialNumber) { params.push(serialNumber); conditions.push(`slu.serial_number = $${params.length}`); }
    if (batchLotNumber) { params.push(batchLotNumber); conditions.push(`slu.batch_lot_number = $${params.length}`); }

    const { rows: units } = await pool.query(
      `SELECT slu.*, ii.item_master_id, i.name AS item_name, i.item_code,
              gr.po_id, gr.received_date AS receipt_date, po.po_number,
              s.legal_name AS supplier_name
         FROM serial_lot_units slu
         JOIN inventory_items ii ON ii.id = slu.inventory_item_id
         JOIN items i ON i.id = ii.item_master_id
         LEFT JOIN goods_receipts gr ON gr.id = slu.goods_receipt_id
         LEFT JOIN purchase_orders po ON po.id = gr.po_id
         LEFT JOIN suppliers s ON s.id = po.supplier_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY slu.received_date ASC`,
      params
    );

    if (units.length === 0) return { found: false, units: [] };

    const unitIds = units.map((u) => u.id);
    const { rows: movements } = await pool.query(
      `SELECT slm.*, wt.transaction_type, wt.reference_type AS txn_reference_type,
              wt.reference_id AS txn_reference_id, so.so_number, c.customer_name
         FROM serial_lot_movements slm
         LEFT JOIN warehouse_transactions wt ON wt.id = slm.warehouse_transaction_id
         LEFT JOIN sales_orders so ON so.id = COALESCE(slm.reference_id, wt.reference_id) AND (slm.reference_type = 'SO' OR wt.reference_type = 'SO')
         LEFT JOIN customers c ON c.id = so.customer_id
        WHERE slm.unit_id = ANY($1)
        ORDER BY slm.issued_date ASC`,
      [unitIds]
    );

    const movementsByUnit = new Map();
    for (const m of movements) {
      if (!movementsByUnit.has(m.unit_id)) movementsByUnit.set(m.unit_id, []);
      movementsByUnit.get(m.unit_id).push(m);
    }

    return {
      found: true,
      units: units.map((u) => ({
        ...u,
        movements: movementsByUnit.get(u.id) || [],
      })),
    };
  }
}

module.exports = SerialLotService;
