const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const NotificationService = require('../services/notificationService');

class InventoryItem {
  static async create(inventoryData, userId) {
    const {
      item_master_id,
      minimum_stock_level,
      maximum_stock_level,
      reorder_point,
      unit_price,
      currency = 'USD',
      condition_grade,
      condition_notes,
      status = 'PENDING_APPROVAL'
    } = inventoryData;

    // First, verify that the item master is approved (ACTIVE status)
    const itemCheck = await pool.query(
      'SELECT status, name FROM items WHERE id = $1 AND user_id = $2',
      [item_master_id, userId]
    );

    if (itemCheck.rows.length === 0) {
      throw new Error('Item master not found');
    }

    if (itemCheck.rows[0].status !== 'APPROVED') {
      throw new Error('Only approved item masters can be converted to inventory items');
    }

    // Check if inventory item already exists for this item master and user
    const existingCheck = await pool.query(
      'SELECT id FROM inventory_items WHERE item_master_id = $1 AND user_id = $2',
      [item_master_id, userId]
    );

    if (existingCheck.rows.length > 0) {
      throw new Error('Inventory item already exists for this item master');
    }

    const id = uuidv4();

    // status was a hardcoded 'PENDING_APPROVAL' literal here — every caller's
    // `status` field (e.g. goodsReceiptService.js explicitly setting
    // 'APPROVED' with the comment "Auto-approve goods from POs") was silently
    // ignored, so every goods receipt left its inventory_items row stuck in
    // PENDING_APPROVAL. That is invisible to anything that filters on
    // status = 'APPROVED' — stocktake sheet creation, the valuation report,
    // and (per InventoryItem.findAll/getStats) inventory listings scoped to
    // approved stock — even though current_stock_quantity was correctly
    // credited. The stock moved; the record just never looked approved.
    const query = `
      INSERT INTO inventory_items (
        id, item_master_id, unit_price, currency, user_id, status,
        condition_grade, condition_notes
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;

    const values = [
      id, item_master_id, unit_price, currency, userId, status,
      condition_grade || 'A', condition_notes || null
    ];

    try {
      const result = await pool.query(query, values);
      const inventoryItem = result.rows[0];
      
      // Get item details for notification
      const itemQuery = `SELECT name, approved_item_code, description FROM items WHERE id = $1`;
      const itemResult = await pool.query(itemQuery, [item_master_id]);
      const itemDetails = itemResult.rows[0];
      
      // Create notification for managers about new inventory item submission
      await NotificationService.createInventoryItemSubmittedNotification(
        inventoryItem,
        itemDetails,
        userId
      );
      
      return inventoryItem;
    } catch (error) {
      throw error;
    }
  }

  static async findAll(filters = {}, userId = null) {
    let query = `
      SELECT 
        ii.*,
        i.name as item_name,
        i.item_code,
        i.approved_item_code,
        i.description,
        i.unit_of_measure,
        i.criticality,
        i.manufacturer,
        i.manufacturer_part_number,
        i.mass_per_uom,
        i.volume_per_uom,
        i.is_stock_item,
        i.planned_stock,
        i.stock_code,
        i.unspsc_code,
        i.item_category,
        i.serial_number,
        i.equipment_tag,
        i.has_contract,
        i.contract_number,
        i.has_barcode,
        i.barcode,
        i.volume,
        i.mass,
        COALESCE(sm.storage_count, 0) as storage_locations_count,
        ii.current_stock_quantity,
        sm.storage_location_name,
        sm.bin_code
      FROM inventory_items ii
      JOIN items i ON ii.item_master_id = i.id
      LEFT JOIN (
        SELECT 
          ism.inventory_item_id,
          COUNT(*) as storage_count,
          SUM(ism.quantity_in_location) as total_quantity,
          sl.name as storage_location_name,
          b.code as bin_code
        FROM inventory_storage_mappings ism
        LEFT JOIN storage_locations sl ON ism.storage_location_id = sl.id
        LEFT JOIN bins b ON ism.bin_id = b.id
        GROUP BY ism.inventory_item_id, sl.name, b.code
      ) sm ON ii.id = sm.inventory_item_id
    `;
    
    let conditions = [];
    let values = [];
    let paramIndex = 1;

    // Always filter by user_id if provided
    if (userId) {
      conditions.push(`ii.user_id = $${paramIndex}`);
      values.push(userId);
      paramIndex++;
    }

    if (filters.search) {
      conditions.push(`(i.name ILIKE $${paramIndex} OR i.description ILIKE $${paramIndex} OR i.item_code ILIKE $${paramIndex} OR i.approved_item_code ILIKE $${paramIndex})`);
      values.push(`%${filters.search}%`);
      paramIndex++;
    }

    if (filters.criticality) {
      conditions.push(`i.criticality = $${paramIndex}`);
      values.push(filters.criticality);
      paramIndex++;
    }

    if (filters.low_stock === 'true') {
      conditions.push(`ii.current_stock_quantity <= COALESCE(ii.reorder_point, 0)`);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY i.name ASC';

    if (filters.limit) {
      query += ` LIMIT $${paramIndex}`;
      values.push(filters.limit);
      paramIndex++;
    }

    if (filters.offset) {
      query += ` OFFSET $${paramIndex}`;
      values.push(filters.offset);
    }

    try {
      const result = await pool.query(query, values);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  static async findById(id, userId = null) {
    let query = `
      SELECT 
        ii.*,
        i.name as item_name,
        i.item_code,
        i.approved_item_code,
        i.description,
        i.unit_of_measure,
        i.criticality,
        i.manufacturer,
        i.manufacturer_part_number,
        i.mass_per_uom,
        i.volume_per_uom,
        i.is_stock_item,
        i.planned_stock,
        i.stock_code,
        i.unspsc_code,
        i.item_category,
        i.serial_number,
        i.equipment_tag,
        i.has_contract,
        i.contract_number,
        i.has_barcode,
        i.barcode,
        i.volume,
        i.mass,
        ii.current_stock_quantity
      FROM inventory_items ii
      JOIN items i ON ii.item_master_id = i.id
      LEFT JOIN (
        SELECT 
          inventory_item_id,
          SUM(quantity_in_location) as total_quantity
        FROM inventory_storage_mappings
        WHERE inventory_item_id = $1
        GROUP BY inventory_item_id
      ) sm ON ii.id = sm.inventory_item_id
      WHERE ii.id = $1
    `;
    
    let values = [id];
    
    if (userId) {
      query += ' AND ii.user_id = $2';
      values.push(userId);
    }
    
    try {
      const result = await pool.query(query, values);
      return result.rows[0] || null;
    } catch (error) {
      throw error;
    }
  }

  static async update(id, inventoryData, userId = null) {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    const allowedFields = [
      'minimum_stock_level', 'maximum_stock_level', 'reorder_point', 
      'unit_price', 'currency', 'status', 'decline_reason',
      'condition_grade', 'condition_notes'
    ];
    
    allowedFields.forEach(field => {
      if (inventoryData.hasOwnProperty(field)) {
        fields.push(`${field} = $${paramIndex}`);
        values.push(inventoryData[field]);
        paramIndex++;
      }
    });

    if (fields.length === 0) {
      throw new Error('No valid fields to update');
    }

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    let query = `
      UPDATE inventory_items 
      SET ${fields.join(', ')}
      WHERE id = $${paramIndex}
    `;

    if (userId) {
      paramIndex++;
      query += ` AND user_id = $${paramIndex}`;
      values.push(userId);
    }

    query += ' RETURNING *';

    try {
      const result = await pool.query(query, values);
      return result.rows[0] || null;
    } catch (error) {
      throw error;
    }
  }

  static async delete(id, userId = null) {
    let query = 'DELETE FROM inventory_items WHERE id = $1';
    let values = [id];
    
    if (userId) {
      query += ' AND user_id = $2';
      values.push(userId);
    }
    
    query += ' RETURNING *';
    
    try {
      const result = await pool.query(query, values);
      return result.rows[0] || null;
    } catch (error) {
      throw error;
    }
  }

  static async getAvailableItemMasters(userId) {
    // Get approved item masters that don't have inventory items yet
    const query = `
      SELECT 
        i.id,
        i.name,
        i.item_code,
        i.approved_item_code,
        i.description,
        i.unit_of_measure,
        i.criticality,
        i.manufacturer,
        i.manufacturer_part_number,
        i.mass_per_uom,
        i.volume_per_uom,
        i.is_stock_item,
        i.planned_stock,
        i.stock_code,
        i.unspsc_code,
        i.item_category,
        i.serial_number,
        i.equipment_tag,
        i.has_contract,
        i.contract_number,
        i.has_barcode,
        i.barcode,
        i.volume,
        i.mass
      FROM items i
      LEFT JOIN inventory_items ii ON i.id = ii.item_master_id AND ii.user_id = $1
      WHERE i.status = 'APPROVED' 
        AND i.user_id = $1 
        AND ii.id IS NULL
      ORDER BY i.name ASC
    `;

    try {
      const result = await pool.query(query, [userId]);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Everything the inventory overview reads, in one round trip.
   *
   * Scope note: inventory_items carries user_id and getStats filters on it, so
   * these do too — a warehouse network drawn company-wide beside a user-scoped
   * item count would not add up.
   *
   * Value is quantity x unit_price throughout. This ledger keeps no separate
   * valuation, so that IS the valuation, and using anything else on one panel
   * would make it disagree with the others.
   */
  static async getAnalytics(userId = null, months = 12, slowDays = 90) {
    const scope = userId ? 'AND ii.user_id = $1' : '';
    const values = userId ? [userId] : [];
    const p = (n) => `$${values.length + n}`;

    const [byWarehouse, flows, status, byCategory, ranked, slow, accuracy, issued, movement, lowStock] =
      await Promise.all([
        // Where the stock physically is. inventory_storage_mappings is the only
        // per-location quantity in this schema, so a warehouse's holding is the
        // sum of its mapped lines valued at the item's unit price.
        pool.query(
          `SELECT sl.name AS warehouse, sl.code,
                  SUM(m.quantity_in_location * COALESCE(ii.unit_price, 0))::float8 AS value,
                  SUM(m.quantity_in_location)::float8 AS quantity
             FROM inventory_storage_mappings m
             JOIN inventory_items ii ON ii.id = m.inventory_item_id
             JOIN storage_locations sl ON sl.id = m.storage_location_id
            WHERE m.quantity_in_location > 0 ${scope}
            GROUP BY sl.name, sl.code
           HAVING SUM(m.quantity_in_location * COALESCE(ii.unit_price, 0)) > 0
            ORDER BY 3 DESC
            LIMIT 8`,
          values
        ),
        // The movement between and through those locations. Transaction lines
        // carry their own source and destination, so a transfer is a real edge
        // rather than an inference: a line with both is a transfer, one with
        // only a destination is stock arriving, one with only a source is stock
        // leaving.
        pool.query(
          `SELECT wt.transaction_type,
                  src.name AS from_warehouse,
                  dst.name AS to_warehouse,
                  SUM(COALESCE(wti.total_cost, 0))::float8 AS value,
                  COUNT(*)::int AS lines
             FROM warehouse_transaction_items wti
             JOIN warehouse_transactions wt ON wt.id = wti.warehouse_transaction_id
             LEFT JOIN storage_locations src ON src.id = wti.source_storage_location_id
             LEFT JOIN storage_locations dst ON dst.id = wti.destination_storage_location_id
             LEFT JOIN inventory_items ii ON ii.id = wti.inventory_item_id
            WHERE wt.status = 'POSTED'
              AND wt.transaction_date >= CURRENT_DATE - (${p(1)}::int || ' days')::interval
              ${scope}
            GROUP BY 1, 2, 3
           HAVING SUM(COALESCE(wti.total_cost, 0)) > 0
            ORDER BY 4 DESC
            LIMIT 24`,
          [...values, months * 30]
        ),
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE ii.status = 'APPROVED' AND ii.current_stock_quantity > COALESCE(ii.reorder_point, 0))::int AS in_stock,
             COUNT(*) FILTER (WHERE ii.status = 'APPROVED' AND ii.current_stock_quantity > 0 AND ii.current_stock_quantity <= COALESCE(ii.reorder_point, 0))::int AS low_stock,
             COUNT(*) FILTER (WHERE ii.status = 'APPROVED' AND ii.current_stock_quantity = 0)::int AS out_of_stock,
             COUNT(*) FILTER (WHERE ii.status <> 'APPROVED')::int AS inactive,
             COUNT(*)::int AS total,
             COALESCE(SUM(ii.current_stock_quantity * COALESCE(ii.unit_price, 0)), 0)::float8 AS total_value
           FROM inventory_items ii
          WHERE 1=1 ${scope}`,
          values
        ),
        pool.query(
          `SELECT COALESCE(NULLIF(i.category, ''), NULLIF(i.item_category, ''), 'Uncategorised') AS category,
                  SUM(ii.current_stock_quantity * COALESCE(ii.unit_price, 0))::float8 AS value,
                  COUNT(*)::int AS items
             FROM inventory_items ii
             JOIN items i ON i.id = ii.item_master_id
            WHERE 1=1 ${scope}
            GROUP BY 1
           HAVING SUM(ii.current_stock_quantity * COALESCE(ii.unit_price, 0)) > 0
            ORDER BY 2 DESC
            LIMIT 7`,
          values
        ),
        // Every item's value, biggest first. The A/B/C split is computed in JS
        // below rather than in SQL: the classes are defined by a running share
        // of total value, which is a cumulative decision per row and reads far
        // more clearly as a loop than as a window function nobody will revisit.
        pool.query(
          `SELECT (ii.current_stock_quantity * COALESCE(ii.unit_price, 0))::float8 AS value
             FROM inventory_items ii
            WHERE ii.current_stock_quantity > 0 AND ii.unit_price > 0 ${scope}
            ORDER BY 1 DESC`,
          values
        ),
        // Slow moving: holding stock, but nothing issued against it in the
        // window. "Not issued" is the honest definition — a receipt or a
        // transfer moves an item without any of it being consumed.
        pool.query(
          `SELECT COUNT(*)::int AS slow, COUNT(*) FILTER (WHERE TRUE)::int AS considered
             FROM inventory_items ii
            WHERE ii.current_stock_quantity > 0 ${scope}
              AND NOT EXISTS (
                SELECT 1 FROM warehouse_transaction_items wti
                  JOIN warehouse_transactions wt ON wt.id = wti.warehouse_transaction_id
                 WHERE wti.inventory_item_id = ii.id
                   AND wt.transaction_type = 'GI'
                   AND wt.status = 'POSTED'
                   AND wt.transaction_date >= CURRENT_DATE - (${p(1)}::int || ' days')::interval
              )`,
          [...values, slowDays]
        ),
        // Accuracy is what the counts found, not what the system asserts: the
        // share of counted lines where the count matched the book. Lines still
        // pending a count are excluded — an uncounted line is not evidence of
        // accuracy in either direction.
        pool.query(
          `SELECT COUNT(*)::int AS counted,
                  COUNT(*) FILTER (WHERE si.variance = 0)::int AS exact,
                  COALESCE(SUM(ABS(si.variance_value)), 0)::float8 AS variance_value
             FROM stocktake_sheet_items si
             JOIN inventory_items ii ON ii.id = si.inventory_item_id
            WHERE si.counted_quantity IS NOT NULL ${scope}`,
          values
        ),
        pool.query(
          `SELECT COALESCE(SUM(wti.total_cost), 0)::float8 AS issued_value
             FROM warehouse_transaction_items wti
             JOIN warehouse_transactions wt ON wt.id = wti.warehouse_transaction_id
             LEFT JOIN inventory_items ii ON ii.id = wti.inventory_item_id
            WHERE wt.transaction_type = 'GI' AND wt.status = 'POSTED'
              AND wt.transaction_date >= date_trunc('year', CURRENT_DATE) ${scope}`,
          values
        ),
        // Net value movement per month, used to walk the current valuation
        // backwards. This ledger keeps no historical stock snapshot, so a value
        // series can only be reconstructed, and only as far back as the
        // transactions go.
        pool.query(
          `SELECT to_char(date_trunc('month', wt.transaction_date), 'YYYY-MM') AS month,
                  COALESCE(SUM(
                    CASE WHEN wt.transaction_type IN ('GR') THEN wti.total_cost
                         WHEN wt.transaction_type IN ('GI', 'GE') THEN -wti.total_cost
                         WHEN wt.transaction_type = 'SA' THEN COALESCE(wti.adjustment_quantity, 0) * COALESCE(wti.unit_cost, 0)
                         ELSE 0 END), 0)::float8 AS net
             FROM warehouse_transaction_items wti
             JOIN warehouse_transactions wt ON wt.id = wti.warehouse_transaction_id
             LEFT JOIN inventory_items ii ON ii.id = wti.inventory_item_id
            WHERE wt.status = 'POSTED'
              AND wt.transaction_date >= date_trunc('month', CURRENT_DATE) - (${p(1)}::int || ' months')::interval
              ${scope}
            GROUP BY 1
            ORDER BY 1`,
          [...values, months * 2]
        ),
        // The items actually at or below their reorder point, named. Their
        // location comes from the storage mapping holding the most of them —
        // an item split across warehouses has no single location, and the one
        // holding the bulk of it is the one worth naming.
        pool.query(
          `SELECT i.item_code, i.name AS item_name,
                  ii.current_stock_quantity::float8 AS on_hand,
                  COALESCE(ii.reorder_point, 0)::float8 AS reorder_point,
                  (SELECT sl.name
                     FROM inventory_storage_mappings m
                     JOIN storage_locations sl ON sl.id = m.storage_location_id
                    WHERE m.inventory_item_id = ii.id
                    ORDER BY m.quantity_in_location DESC
                    LIMIT 1) AS warehouse
             FROM inventory_items ii
             JOIN items i ON i.id = ii.item_master_id
            WHERE ii.status = 'APPROVED'
              AND ii.current_stock_quantity <= COALESCE(ii.reorder_point, 0) ${scope}
            ORDER BY (ii.current_stock_quantity - COALESCE(ii.reorder_point, 0)) ASC
            LIMIT 6`,
          values
        ),
      ]);

    const st = status.rows[0] || {};
    const currentValue = Number(st.total_value) || 0;

    // A / B / C by running share of value: A carries the first 80%, B the next
    // 15%, C the tail. The thresholds are the conventional ones.
    const abc = { a: { items: 0, value: 0 }, b: { items: 0, value: 0 }, c: { items: 0, value: 0 } };
    const rankedTotal = ranked.rows.reduce((n, r) => n + Number(r.value), 0);
    let running = 0;
    for (const row of ranked.rows) {
      const v = Number(row.value);
      const shareBefore = rankedTotal > 0 ? running / rankedTotal : 0;
      const band = shareBefore < 0.8 ? 'a' : shareBefore < 0.95 ? 'b' : 'c';
      abc[band].items += 1;
      abc[band].value += v;
      running += v;
    }

    // Walk backwards from today's valuation: the value at the end of a month is
    // the value at the end of the next one minus that month's net movement.
    const netByMonth = new Map(movement.rows.map((r) => [r.month, Number(r.net) || 0]));
    const series = [];
    const cursor = new Date();
    cursor.setDate(1);
    let value = currentValue;
    for (let i = 0; i < months; i++) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
      series.unshift({ month: key, value: Math.max(0, value) });
      value -= netByMonth.get(key) || 0;
      cursor.setMonth(cursor.getMonth() - 1);
    }

    const counted = Number(accuracy.rows[0]?.counted) || 0;
    const exact = Number(accuracy.rows[0]?.exact) || 0;
    const issuedValue = Number(issued.rows[0]?.issued_value) || 0;

    return {
      total_value: currentValue,
      by_warehouse: byWarehouse.rows,
      flows: flows.rows,
      stock_status: {
        in_stock: Number(st.in_stock) || 0,
        low_stock: Number(st.low_stock) || 0,
        out_of_stock: Number(st.out_of_stock) || 0,
        inactive: Number(st.inactive) || 0,
        total: Number(st.total) || 0,
      },
      by_category: byCategory.rows,
      abc,
      slow_moving: {
        count: Number(slow.rows[0]?.slow) || 0,
        window_days: slowDays,
      },
      accuracy: {
        counted_lines: counted,
        exact_lines: exact,
        variance_value: Number(accuracy.rows[0]?.variance_value) || 0,
        // Null, not 100%, when nothing has been counted: an uncounted ledger is
        // not an accurate one, it is an unmeasured one.
        rate: counted > 0 ? exact / counted : null,
      },
      turnover: {
        issued_value: issuedValue,
        average_value: currentValue,
        turns: currentValue > 0 ? issuedValue / currentValue : null,
      },
      value_over_time: series,
      low_stock_items: lowStock.rows,
    };
  }

  static async getStats(userId = null) {
    let query = `
      SELECT 
        COUNT(*) as total_items,
        COUNT(CASE WHEN ii.current_stock_quantity = 0 THEN 1 END) as out_of_stock,
        COUNT(CASE WHEN ii.current_stock_quantity <= COALESCE(ii.reorder_point, 0) AND ii.current_stock_quantity > 0 THEN 1 END) as low_stock,
        COALESCE(SUM(ii.current_stock_quantity * ii.unit_price), 0) as total_value,
        ii.currency
      FROM inventory_items ii
      JOIN items i ON ii.item_master_id = i.id
      LEFT JOIN (
        SELECT 
          inventory_item_id,
          SUM(quantity_in_location) as total_quantity
        FROM inventory_storage_mappings
        GROUP BY inventory_item_id
      ) sm ON ii.id = sm.inventory_item_id
    `;
    
    let values = [];
    
    if (userId) {
      query += ' WHERE ii.user_id = $1';
      values.push(userId);
    }
    
    query += ' GROUP BY ii.currency';

    try {
      const result = await pool.query(query, values);
      
      if (result.rows.length === 0) {
        return {
          total_items: 0,
          out_of_stock: 0,
          low_stock: 0,
          total_value: 0,
          currency: 'USD'
        };
      }
      
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Approval workflow methods
  static async getPendingApprovals(userId = null) {
    let query = `
      SELECT 
        ii.*,
        i.name as item_name,
        i.item_code,
        i.approved_item_code,
        i.description,
        i.unit_of_measure,
        i.criticality,
        u.first_name,
        u.last_name,
        u.email
      FROM inventory_items ii
      JOIN items i ON ii.item_master_id = i.id
      JOIN users u ON ii.user_id = u.id
      WHERE ii.status = 'PENDING_APPROVAL'
    `;
    
    let values = [];
    
    if (userId) {
      query += ' AND ii.user_id = $1';
      values.push(userId);
    }
    
    query += ' ORDER BY ii.created_at ASC';

    try {
      const result = await pool.query(query, values);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  static async approve(id, approvalData, approvedBy) {
    const {
      minimum_stock_level,
      maximum_stock_level,
      reorder_point
    } = approvalData;

    const fields = ['status = $2', 'approved_by = $3', 'approved_at = CURRENT_TIMESTAMP'];
    const values = [id, 'APPROVED', approvedBy];
    let paramIndex = 4;

    if (minimum_stock_level !== undefined && minimum_stock_level !== '') {
      fields.push(`minimum_stock_level = $${paramIndex}`);
      values.push(minimum_stock_level);
      paramIndex++;
    }

    if (maximum_stock_level !== undefined && maximum_stock_level !== '') {
      fields.push(`maximum_stock_level = $${paramIndex}`);
      values.push(maximum_stock_level);
      paramIndex++;
    }

    if (reorder_point !== undefined && reorder_point !== '') {
      fields.push(`reorder_point = $${paramIndex}`);
      values.push(reorder_point);
      paramIndex++;
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');

    const query = `
      UPDATE inventory_items 
      SET ${fields.join(', ')}
      WHERE id = $1 AND status = 'PENDING_APPROVAL'
      RETURNING *
    `;

    try {
      const result = await pool.query(query, values);
      const approvedItem = result.rows[0];
      
      if (approvedItem) {
        // Get item details and original user for notification
        const itemQuery = `
          SELECT i.name, i.approved_item_code, i.description, ii.user_id
          FROM inventory_items ii
          JOIN items i ON ii.item_master_id = i.id
          WHERE ii.id = $1
        `;
        const itemResult = await pool.query(itemQuery, [id]);
        const itemDetails = itemResult.rows[0];
        
        // Create notification for the original user
        await NotificationService.createInventoryItemApprovedNotification(
          approvedItem,
          itemDetails,
          approvedBy,
          itemDetails.user_id
        );
      }
      
      return approvedItem;
    } catch (error) {
      throw error;
    }
  }

  static async decline(id, declineReason, declinedBy) {
    const query = `
      UPDATE inventory_items 
      SET status = 'DECLINED', 
          decline_reason = $2, 
          approved_by = $3, 
          approved_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'PENDING_APPROVAL'
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id, declineReason, declinedBy]);
      const declinedItem = result.rows[0];
      
      if (declinedItem) {
        // Get item details and original user for notification
        const itemQuery = `
          SELECT i.name, i.approved_item_code, i.description, ii.user_id
          FROM inventory_items ii
          JOIN items i ON ii.item_master_id = i.id
          WHERE ii.id = $1
        `;
        const itemResult = await pool.query(itemQuery, [id]);
        const itemDetails = itemResult.rows[0];
        
        // Create notification for the original user
        await NotificationService.createInventoryItemDeclinedNotification(
          declinedItem,
          itemDetails,
          declinedBy,
          itemDetails.user_id,
          declineReason
        );
      }
      
      return declinedItem;
    } catch (error) {
      throw error;
    }
  }

  // General update method for editable fields
  static async update(id, updateData, userId) {
    const { 
      unit_price, 
      currency, 
      condition_grade, 
      condition_notes,
      minimum_stock_level,
      maximum_stock_level,
      reorder_point
    } = updateData;

    const fields = [];
    const values = [id];
    let paramIndex = 2;

    // Only allow updates to certain fields and only if item is not declined
    if (unit_price !== undefined) {
      fields.push(`unit_price = $${paramIndex}`);
      values.push(unit_price);
      paramIndex++;
    }

    if (currency !== undefined) {
      fields.push(`currency = $${paramIndex}`);
      values.push(currency);
      paramIndex++;
    }

    if (condition_grade !== undefined) {
      fields.push(`condition_grade = $${paramIndex}`);
      values.push(condition_grade);
      paramIndex++;
    }

    if (condition_notes !== undefined) {
      fields.push(`condition_notes = $${paramIndex}`);
      values.push(condition_notes);
      paramIndex++;
    }

    // Allow stock control parameters to be updated for approved items
    if (minimum_stock_level !== undefined) {
      fields.push(`minimum_stock_level = $${paramIndex}`);
      values.push(minimum_stock_level);
      paramIndex++;
    }

    if (maximum_stock_level !== undefined) {
      fields.push(`maximum_stock_level = $${paramIndex}`);
      values.push(maximum_stock_level);
      paramIndex++;
    }

    if (reorder_point !== undefined) {
      fields.push(`reorder_point = $${paramIndex}`);
      values.push(reorder_point);
      paramIndex++;
    }

    if (fields.length === 0) {
      throw new Error('No valid fields to update');
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');

    const query = `
      UPDATE inventory_items 
      SET ${fields.join(', ')}
      WHERE id = $1 AND user_id = $${paramIndex} AND status != 'DECLINED'
      RETURNING *
    `;

    values.push(userId);

    try {
      const result = await pool.query(query, values);
      
      if (result.rows.length === 0) {
        throw new Error('Inventory item not found or cannot be updated');
      }
      
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Storage mapping methods
  static async addStorageMapping(inventoryItemId, storageLocationId, binId = null, quantityInLocation = 0, userId, status = 'PENDING_APPROVAL') {
    const id = uuidv4();
    
    const query = `
      INSERT INTO inventory_storage_mappings (
        id, inventory_item_id, storage_location_id, bin_id, quantity_in_location, user_id, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `;

    const values = [id, inventoryItemId, storageLocationId, binId, quantityInLocation, userId, status];

    try {
      const result = await pool.query(query, values);
      const assignment = result.rows[0];
      
      // If status is PENDING_APPROVAL, create notification for managers
      if (status === 'PENDING_APPROVAL') {
        // Get assignment details for notification
        const detailsQuery = `
          SELECT 
            i.name as item_name,
            i.approved_item_code,
            sl.name as storage_name,
            sl.code as storage_code,
            b.code as bin_code,
            b.description as bin_description
          FROM inventory_items ii
          JOIN items i ON ii.item_master_id = i.id
          JOIN storage_locations sl ON $2 = sl.id
          LEFT JOIN bins b ON $3 = b.id
          WHERE ii.id = $1
        `;
        const detailsResult = await pool.query(detailsQuery, [inventoryItemId, storageLocationId, binId]);
        const assignmentDetails = detailsResult.rows[0];
        
        // Create notification for managers
        await NotificationService.createStorageAssignmentSubmittedNotification(
          assignment,
          assignmentDetails,
          userId
        );
      }
      
      return assignment;
    } catch (error) {
      throw error;
    }
  }

  static async getStorageMappings(inventoryItemId, userId = null) {
    let query = `
      SELECT 
        ism.*,
        sl.code as storage_code,
        sl.name as storage_name,
        sl.country,
        sl.city,
        sl.address,
        b.code as bin_code,
        b.description as bin_description
      FROM inventory_storage_mappings ism
      JOIN storage_locations sl ON ism.storage_location_id = sl.id
      LEFT JOIN bins b ON ism.bin_id = b.id
      WHERE ism.inventory_item_id = $1
    `;
    
    let values = [inventoryItemId];
    
    if (userId) {
      query += ' AND ism.user_id = $2';
      values.push(userId);
    }
    
    query += ' ORDER BY sl.name, b.code';

    try {
      const result = await pool.query(query, values);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  static async removeStorageMapping(inventoryItemId, mappingId, userId) {
    const query = `
      DELETE FROM inventory_storage_mappings 
      WHERE id = $1 AND inventory_item_id = $2 AND user_id = $3
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [mappingId, inventoryItemId, userId]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Storage assignment approval methods
  static async getPendingStorageAssignments(userId = null) {
    let query = `
      SELECT 
        ism.*,
        ii.id as inventory_item_id,
        i.name as item_name,
        i.item_code,
        i.approved_item_code,
        i.description,
        i.unit_of_measure,
        sl.code as storage_code,
        sl.name as storage_name,
        sl.country,
        sl.city,
        sl.address,
        b.code as bin_code,
        b.description as bin_description,
        u.first_name,
        u.last_name,
        u.email
      FROM inventory_storage_mappings ism
      JOIN inventory_items ii ON ism.inventory_item_id = ii.id
      JOIN items i ON ii.item_master_id = i.id
      JOIN storage_locations sl ON ism.storage_location_id = sl.id
      LEFT JOIN bins b ON ism.bin_id = b.id
      JOIN users u ON ism.user_id = u.id
      WHERE ism.status = 'PENDING_APPROVAL'
    `;
    
    let values = [];
    
    if (userId) {
      query += ' AND ism.user_id = $1';
      values.push(userId);
    }
    
    query += ' ORDER BY ism.created_at ASC';

    try {
      const result = await pool.query(query, values);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  static async approveStorageAssignment(mappingId, approvedBy) {
    const query = `
      UPDATE inventory_storage_mappings 
      SET status = 'APPROVED',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'PENDING_APPROVAL'
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [mappingId]);
      const approvedAssignment = result.rows[0];
      
      if (approvedAssignment) {
        // Get assignment details for notification
        const detailsQuery = `
          SELECT 
            ism.*,
            ii.user_id,
            i.name as item_name,
            i.approved_item_code,
            sl.name as storage_name,
            sl.code as storage_code,
            b.code as bin_code,
            b.description as bin_description
          FROM inventory_storage_mappings ism
          JOIN inventory_items ii ON ism.inventory_item_id = ii.id
          JOIN items i ON ii.item_master_id = i.id
          JOIN storage_locations sl ON ism.storage_location_id = sl.id
          LEFT JOIN bins b ON ism.bin_id = b.id
          WHERE ism.id = $1
        `;
        const detailsResult = await pool.query(detailsQuery, [mappingId]);
        const assignmentDetails = detailsResult.rows[0];
        
        // Create notification for the original user
        await NotificationService.createStorageAssignmentApprovedNotification(
          approvedAssignment,
          assignmentDetails,
          approvedBy,
          assignmentDetails.user_id
        );
      }
      
      return approvedAssignment;
    } catch (error) {
      throw error;
    }
  }

  static async declineStorageAssignment(mappingId, declinedBy) {
    const query = `
      UPDATE inventory_storage_mappings 
      SET status = 'DECLINED',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'PENDING_APPROVAL'
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [mappingId]);
      const declinedAssignment = result.rows[0];
      
      if (declinedAssignment) {
        // Get assignment details for notification
        const detailsQuery = `
          SELECT 
            ism.*,
            ii.user_id,
            i.name as item_name,
            i.approved_item_code,
            sl.name as storage_name,
            sl.code as storage_code,
            b.code as bin_code,
            b.description as bin_description
          FROM inventory_storage_mappings ism
          JOIN inventory_items ii ON ism.inventory_item_id = ii.id
          JOIN items i ON ii.item_master_id = i.id
          JOIN storage_locations sl ON ism.storage_location_id = sl.id
          LEFT JOIN bins b ON ism.bin_id = b.id
          WHERE ism.id = $1
        `;
        const detailsResult = await pool.query(detailsQuery, [mappingId]);
        const assignmentDetails = detailsResult.rows[0];
        
        // Create notification for the original user
        await NotificationService.createStorageAssignmentDeclinedNotification(
          declinedAssignment,
          assignmentDetails,
          declinedBy,
          assignmentDetails.user_id
        );
      }
      
      return declinedAssignment;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = InventoryItem;