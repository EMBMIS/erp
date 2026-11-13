const { pool } = require('../config/database');
const { withDeadlockRetry, lockInventoryItemForWrite, serializeInventoryItemWrite } = require('../services/dbRetry');

/**
 * InventoryTransfer — a two-phase inter-warehouse (storage_location) transfer
 * with genuine in-transit tracking (ERP-Roadmap P3 #13). Unlike the existing
 * Goods Transfer (GT) warehouse-transaction, which moves stock atomically,
 * this models the physical reality of a truck on the road:
 *
 *   dispatch()  -> stock leaves the source location NOW (no longer available
 *                  to issue/sell there), but does not yet exist anywhere else.
 *                  Status: IN_TRANSIT.
 *   receive()   -> stock lands at the destination location. Status: RECEIVED.
 *   cancel()    -> only while IN_TRANSIT — returns the quantity to the source.
 *
 * The item's total current_stock_quantity is unaffected by a transfer (the
 * same units, same company) — only the storage_location mapping changes. This
 * only touches inventory_storage_mappings, not inventory_items.current_stock_quantity.
 */
// A transfer's own columns are all foreign keys, so a bare row describes it
// poorly to a user. All queries JOIN out to current names so API consumers can
// render transfer lists without N+1 fetches per row.
const TRANSFER_SELECT = `
  SELECT t.*,
         i.item_master_id,
         im.name as item_name,
         sl_src.name as source_storage_location_name,
         sl_dst.name as destination_storage_location_name,
         bin_src.code as source_bin_code,
         bin_dst.code as destination_bin_code,
         u_disp.first_name || ' ' || u_disp.last_name as dispatched_by_name,
         u_recv.first_name || ' ' || u_recv.last_name as received_by_name,
         u_canc.first_name || ' ' || u_canc.last_name as cancelled_by_name
    FROM inventory_transfers t
    LEFT JOIN inventory_items i ON t.inventory_item_id = i.id
    LEFT JOIN items im ON i.item_master_id = im.id
    LEFT JOIN storage_locations sl_src ON t.source_storage_location_id = sl_src.id
    LEFT JOIN storage_locations sl_dst ON t.destination_storage_location_id = sl_dst.id
    LEFT JOIN bins bin_src ON t.source_bin_id = bin_src.id
    LEFT JOIN bins bin_dst ON t.destination_bin_id = bin_dst.id
    LEFT JOIN users u_disp ON t.dispatched_by = u_disp.id
    LEFT JOIN users u_recv ON t.received_by = u_recv.id
    LEFT JOIN users u_canc ON t.cancelled_by = u_canc.id
`;

class InventoryTransfer {
  static async findAll(filters = {}) {
    const conditions = [];
    const values = [];
    if (filters.status) {
      values.push(filters.status);
      conditions.push(`t.status = $${values.length}`);
    }
    if (filters.inventory_item_id) {
      values.push(filters.inventory_item_id);
      conditions.push(`t.inventory_item_id = $${values.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(`${TRANSFER_SELECT} ${where} ORDER BY t.created_at DESC`, values);
    return result.rows;
  }

  static async findById(id) {
    const result = await pool.query(`${TRANSFER_SELECT} WHERE t.id = $1`, [id]);
    return result.rows[0] || null;
  }

  static async dispatch(data, userId) {
    return serializeInventoryItemWrite(data?.inventory_item_id, () =>
      withDeadlockRetry(() => this._dispatchOnce(data, userId))
    );
  }

  static async _dispatchOnce(data, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { inventory_item_id, quantity, source_storage_location_id, source_bin_id,
        destination_storage_location_id, destination_bin_id, notes } = data;

      if (!inventory_item_id || !quantity || quantity <= 0) {
        throw new Error('inventory_item_id and a positive quantity are required');
      }
      if (!source_storage_location_id || !destination_storage_location_id) {
        throw new Error('source and destination storage locations are required');
      }
      if (source_storage_location_id === destination_storage_location_id &&
          (source_bin_id || null) === (destination_bin_id || null)) {
        throw new Error('source and destination must differ');
      }

      await lockInventoryItemForWrite(client, inventory_item_id);

      // Remove quantity from the source location NOW — it is physically gone
      // from that shelf the moment it's dispatched.
      const sourceMapping = await client.query(
        `SELECT id, quantity_in_location FROM inventory_storage_mappings
         WHERE inventory_item_id = $1 AND storage_location_id = $2
           AND (bin_id = $3 OR (bin_id IS NULL AND $3 IS NULL))
         FOR UPDATE`,
        [inventory_item_id, source_storage_location_id, source_bin_id || null]
      );
      if (sourceMapping.rows.length === 0) {
        throw new Error('No inventory found at the source location/bin');
      }
      const available = Number(sourceMapping.rows[0].quantity_in_location);
      if (available < Number(quantity)) {
        throw new Error(`Insufficient quantity at source: available ${available}, requested ${quantity}`);
      }
      const remaining = available - Number(quantity);
      if (remaining <= 0) {
        await client.query('DELETE FROM inventory_storage_mappings WHERE id = $1', [sourceMapping.rows[0].id]);
      } else {
        await client.query('UPDATE inventory_storage_mappings SET quantity_in_location = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [remaining, sourceMapping.rows[0].id]);
      }

      const numberResult = await client.query('SELECT generate_transfer_number() AS number');
      const transfer_number = numberResult.rows[0].number;

      const result = await client.query(
        `INSERT INTO inventory_transfers (
          transfer_number, inventory_item_id, quantity,
          source_storage_location_id, source_bin_id,
          destination_storage_location_id, destination_bin_id,
          status, notes, dispatched_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,'IN_TRANSIT',$8,$9)
        RETURNING *`,
        [transfer_number, inventory_item_id, quantity, source_storage_location_id, source_bin_id || null,
         destination_storage_location_id, destination_bin_id || null, notes || null, userId]
      );

      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async receive(id, userId) {
    const t = await pool.query('SELECT inventory_item_id FROM inventory_transfers WHERE id = $1', [id]);
    const itemId = t.rows[0]?.inventory_item_id;
    return serializeInventoryItemWrite(itemId, () =>
      withDeadlockRetry(() => this._receiveOnce(id, userId))
    );
  }

  static async _receiveOnce(id, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const t = await client.query('SELECT * FROM inventory_transfers WHERE id = $1 FOR UPDATE', [id]);
      if (t.rows.length === 0) throw new Error('Transfer not found');
      const transfer = t.rows[0];
      if (transfer.status !== 'IN_TRANSIT') throw new Error(`Cannot receive a transfer with status ${transfer.status}`);

      await lockInventoryItemForWrite(client, transfer.inventory_item_id);

      const destMapping = await client.query(
        `SELECT id, quantity_in_location FROM inventory_storage_mappings
         WHERE inventory_item_id = $1 AND storage_location_id = $2
           AND (bin_id = $3 OR (bin_id IS NULL AND $3 IS NULL))
         FOR UPDATE`,
        [transfer.inventory_item_id, transfer.destination_storage_location_id, transfer.destination_bin_id]
      );
      if (destMapping.rows.length > 0) {
        const newQty = Number(destMapping.rows[0].quantity_in_location) + Number(transfer.quantity);
        await client.query('UPDATE inventory_storage_mappings SET quantity_in_location = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [newQty, destMapping.rows[0].id]);
      } else {
        await client.query(
          `INSERT INTO inventory_storage_mappings (inventory_item_id, storage_location_id, bin_id, quantity_in_location, user_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [transfer.inventory_item_id, transfer.destination_storage_location_id, transfer.destination_bin_id, transfer.quantity, userId]
        );
      }

      const result = await client.query(
        `UPDATE inventory_transfers SET status = 'RECEIVED', received_by = $1, received_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 RETURNING *`,
        [userId, id]
      );

      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async cancel(id, userId) {
    const t = await pool.query('SELECT inventory_item_id FROM inventory_transfers WHERE id = $1', [id]);
    const itemId = t.rows[0]?.inventory_item_id;
    return serializeInventoryItemWrite(itemId, () =>
      withDeadlockRetry(() => this._cancelOnce(id, userId))
    );
  }

  static async _cancelOnce(id, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const t = await client.query('SELECT * FROM inventory_transfers WHERE id = $1 FOR UPDATE', [id]);
      if (t.rows.length === 0) throw new Error('Transfer not found');
      const transfer = t.rows[0];
      if (transfer.status !== 'IN_TRANSIT') throw new Error(`Cannot cancel a transfer with status ${transfer.status}`);

      await lockInventoryItemForWrite(client, transfer.inventory_item_id);

      // Return the quantity to the source location.
      const sourceMapping = await client.query(
        `SELECT id, quantity_in_location FROM inventory_storage_mappings
         WHERE inventory_item_id = $1 AND storage_location_id = $2
           AND (bin_id = $3 OR (bin_id IS NULL AND $3 IS NULL))
         FOR UPDATE`,
        [transfer.inventory_item_id, transfer.source_storage_location_id, transfer.source_bin_id]
      );
      if (sourceMapping.rows.length > 0) {
        const newQty = Number(sourceMapping.rows[0].quantity_in_location) + Number(transfer.quantity);
        await client.query('UPDATE inventory_storage_mappings SET quantity_in_location = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [newQty, sourceMapping.rows[0].id]);
      } else {
        await client.query(
          `INSERT INTO inventory_storage_mappings (inventory_item_id, storage_location_id, bin_id, quantity_in_location, user_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [transfer.inventory_item_id, transfer.source_storage_location_id, transfer.source_bin_id, transfer.quantity, userId]
        );
      }

      const result = await client.query(
        `UPDATE inventory_transfers SET status = 'CANCELLED', cancelled_by = $1, cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 RETURNING *`,
        [userId, id]
      );

      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = InventoryTransfer;
