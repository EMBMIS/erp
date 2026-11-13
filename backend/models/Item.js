const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const Notification = require('./Notification');
const NotificationService = require('../services/notificationService');

class Item {
  static generateItemCode() {
    const date = new Date();
    const dateStr = date.getFullYear() + 
                   String(date.getMonth() + 1).padStart(2, '0') + 
                   String(date.getDate()).padStart(2, '0');
    const random = String(Math.floor(Math.random() * 999) + 1).padStart(3, '0');
    return `TEMP-${dateStr}-${random}`;
  }

  static generateStockCode(isStockItem, plannedStock) {
    if (!isStockItem) {
      return 'NS3'; // Non-stock item
    } else if (plannedStock) {
      return 'ST2'; // Planned stock - require min/max levels
    } else {
      return 'ST1'; // No planned stock - critical requirements/long lead time
    }
  }

  static async create(itemData, userId) {
    const {
      name,
      description,
      is_stock_item = true,
      planned_stock = false,
      status = 'DRAFT',
      criticality = 'LOW',
      unit_of_measure = 'pcs',
      unspsc_code,
      manufacturer,
      manufacturer_part_number,
      item_category,
      serial_number,
      equipment_tag,
      has_contract = false,
      contract_number,
      has_barcode = false,
      barcode,
      mass_per_uom,
      volume_per_uom
    } = itemData;

    const id = uuidv4();
    const item_code = this.generateItemCode();
    const stock_code = this.generateStockCode(is_stock_item, planned_stock);

    // Convert empty strings to null for numeric fields to prevent PostgreSQL errors
    const sanitizedMassPerUom = mass_per_uom === '' ? null : mass_per_uom;
    const sanitizedVolumePerUom = volume_per_uom === '' ? null : volume_per_uom;

    const query = `
      INSERT INTO items (id, item_code, name, description, is_stock_item, planned_stock, stock_code, status, criticality, unit_of_measure, unspsc_code, manufacturer, manufacturer_part_number, item_category, serial_number, equipment_tag, has_contract, contract_number, has_barcode, barcode, mass_per_uom, volume_per_uom, user_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
      RETURNING *
    `;

    const values = [id, item_code, name, description, is_stock_item, planned_stock, stock_code, status, criticality, unit_of_measure, unspsc_code, manufacturer, manufacturer_part_number, item_category, serial_number, equipment_tag, has_contract, contract_number, has_barcode, barcode, sanitizedMassPerUom, sanitizedVolumePerUom, userId];

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  /**
   * Item masters awaiting review, across every creator.
   *
   * findAll() below scopes to `user_id` whenever a userId is passed, and
   * routes/items.js always passes one — so GET /items returns only what the
   * caller created. That is the right default for "my items" and exactly wrong
   * for an approval queue: the approver is by definition not the submitter, so
   * the Item Masters tab of the approval portal was filtering a list that could
   * never contain anyone else's work, and sat permanently empty while items
   * genuinely waited in PENDING_REVIEW.
   *
   * Deliberately does NOT take a userId. Company scoping still applies through
   * row-level security; who created the record is not a visibility question at
   * this point, it is a segregation-of-duties question, and that is enforced at
   * approval time in approve() rather than by hiding the work.
   */
  static async getPendingApprovals() {
    const { rows } = await pool.query(
      `SELECT i.*,
              u.first_name || ' ' || u.last_name AS created_by_name,
              u.email AS created_by_email
         FROM items i
         LEFT JOIN users u ON i.user_id = u.id
        WHERE i.status = 'PENDING_REVIEW'
        ORDER BY i.created_at ASC`
    );
    return rows;
  }

  /**
   * Find all items with filters, server-side pagination and whitelisted sorting.
   *
   * Returns `{ rows, total }` (total = full count BEFORE paging), matching the
   * contract CustomerInvoice.findAll uses for the reference list endpoint, so a
   * page of 50 rows can still say "showing 1–50 of 812". Callers that do not
   * pass limit/offset get every matching row back (the pre-pagination contract
   * of GET /items), with `total` still correct.
   */
  static async findAll(filters = {}, userId = null) {
    let query = 'SELECT * FROM items';
    let countQuery = 'SELECT COUNT(*)::int AS n FROM items';
    const conditions = [];
    const values = [];
    let paramIndex = 1;

    // Always filter by user_id if provided
    if (userId) {
      conditions.push(`user_id = $${paramIndex}`);
      values.push(userId);
      paramIndex++;
    }

    if (filters.status) {
      conditions.push(`status = $${paramIndex}`);
      values.push(filters.status);
      paramIndex++;
    }

    if (filters.stock_code) {
      conditions.push(`stock_code = $${paramIndex}`);
      values.push(filters.stock_code);
      paramIndex++;
    }

    if (filters.is_stock_item !== undefined) {
      conditions.push(`is_stock_item = $${paramIndex}`);
      values.push(filters.is_stock_item);
      paramIndex++;
    }

    if (filters.planned_stock !== undefined) {
      conditions.push(`planned_stock = $${paramIndex}`);
      values.push(filters.planned_stock);
      paramIndex++;
    }

    if (filters.criticality) {
      conditions.push(`criticality = $${paramIndex}`);
      values.push(filters.criticality);
      paramIndex++;
    }

    if (filters.search) {
      conditions.push(`(name ILIKE $${paramIndex} OR description ILIKE $${paramIndex} OR item_code ILIKE $${paramIndex})`);
      values.push(`%${filters.search}%`);
      paramIndex++;
    }

    if (conditions.length > 0) {
      const where = ' WHERE ' + conditions.join(' AND ');
      query += where;
      countQuery += where;
    }

    // Total BEFORE paging — the count query only carries the filter values, so
    // it runs before the limit/offset parameters are appended below.
    const countResult = await pool.query(countQuery, values);

    // Sorting is whitelisted, never interpolated from the request — the one
    // place in a list endpoint where a client string becomes SQL text. The
    // client's value is only used to LOOK UP a fixed column expression.
    const SORTABLE = {
      created_at: 'created_at',
      updated_at: 'updated_at',
      name: 'name',
      item_code: 'item_code',
      status: 'status',
      criticality: 'criticality',
      stock_code: 'stock_code',
    };
    const sortColumn = SORTABLE[filters.sort_by] || 'created_at';
    const sortDirection = String(filters.sort_dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    // Tie-break on id: without it, rows sharing a sort value can swap places
    // between pages (same row on page 1 and page 2, another never shown).
    query += ` ORDER BY ${sortColumn} ${sortDirection} NULLS LAST, id`;

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
      return { rows: result.rows, total: countResult.rows[0].n };
    } catch (error) {
      throw error;
    }
  }

  static async findById(id, userId = null) {
    let query = 'SELECT * FROM items WHERE id = $1';
    let values = [id];
    
    if (userId) {
      query += ' AND user_id = $2';
      values.push(userId);
    }
    
    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async approve(id, userId = null) {
    try {
      const client = await pool.connect();
      
      try {
        await client.query('BEGIN');
        
        // Get current item
        const currentItem = await this.findById(id);
        if (!currentItem) {
          throw new Error('Item not found');
        }
        
        if (currentItem.status !== 'PENDING_REVIEW') {
          throw new Error('Item must be in PENDING_REVIEW status to approve');
        }
        
        // Generate inventory code using database function
        const inventoryCodeResult = await client.query('SELECT generate_inventory_code() as code');
        const inventoryCode = inventoryCodeResult.rows[0].code;
        
        // Update item with approval and replace item_code with inventory code
        const query = `
          UPDATE items 
          SET status = 'APPROVED', 
              item_code = $1,
              approved_item_code = $1,
              decline_reason = NULL
          WHERE id = $2
          RETURNING *
        `;
        
        const result = await client.query(query, [inventoryCode, id]);
        const approvedItem = result.rows[0];
        
        // Create notification for the original user
        await NotificationService.createItemMasterApprovedNotification(
          approvedItem, 
          userId, // approvedBy 
          currentItem.user_id // originalUserId
        );
        
        await client.query('COMMIT');
        
        return result.rows[0];
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      throw error;
    }
  }

  static async decline(id, reason, userId = null) {
    if (!reason || reason.trim().length === 0) {
      throw new Error('Decline reason is required');
    }

    try {
      // First get the item details before deleting
      const item = await this.findById(id);
      if (!item) {
        throw new Error('Item not found');
      }

      if (item.status !== 'PENDING_REVIEW') {
        throw new Error('Item must be in PENDING_REVIEW status to decline');
      }

      // Delete the item
      const deleteQuery = 'DELETE FROM items WHERE id = $1 RETURNING *';
      const result = await pool.query(deleteQuery, [id]);

      if (result.rows.length === 0) {
        throw new Error('Failed to delete item');
      }

      // Create notification for the original user
      await NotificationService.createItemMasterDeclinedNotification(
        item,
        userId, // declinedBy
        item.user_id, // originalUserId
        reason.trim()
      );

      return { ...item, decline_reason: reason.trim() };
    } catch (error) {
      throw error;
    }
  }

  static async update(id, itemData, userId = null) {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    const allowedFields = ['name', 'description', 'is_stock_item', 'planned_stock', 'status', 'criticality', 'unit_of_measure', 'unspsc_code', 'manufacturer', 'manufacturer_part_number', 'item_category', 'serial_number', 'equipment_tag', 'has_contract', 'contract_number', 'has_barcode', 'barcode', 'decline_reason', 'mass_per_uom', 'volume_per_uom'];
    
    // Check if stock-related fields are being updated to auto-generate stock_code
    if (itemData.hasOwnProperty('is_stock_item') || itemData.hasOwnProperty('planned_stock')) {
      // Get current values if only one field is being updated
      const currentItem = await this.findById(id, userId);
      if (!currentItem) {
        throw new Error('Item not found');
      }
      
      const isStockItem = itemData.hasOwnProperty('is_stock_item') ? itemData.is_stock_item : currentItem.is_stock_item;
      const plannedStock = itemData.hasOwnProperty('planned_stock') ? itemData.planned_stock : currentItem.planned_stock;
      
      // Auto-generate stock_code based on the new values
      const newStockCode = this.generateStockCode(isStockItem, plannedStock);
      fields.push(`stock_code = $${paramIndex}`);
      values.push(newStockCode);
      paramIndex++;
    }

    allowedFields.forEach(field => {
      if (itemData.hasOwnProperty(field)) {
        fields.push(`${field} = $${paramIndex}`);
        
        // Convert empty strings to null for numeric fields
        let value = itemData[field];
        if ((field === 'mass_per_uom' || field === 'volume_per_uom') && value === '') {
          value = null;
        }
        
        values.push(value);
        paramIndex++;
      }
    });

    if (fields.length === 0) {
      throw new Error('No valid fields to update');
    }

    values.push(id);
    let query = `
      UPDATE items 
      SET ${fields.join(', ')} 
      WHERE id = $${paramIndex}
    `;
    
    if (userId) {
      paramIndex++;
      values.push(userId);
      query += ` AND user_id = $${paramIndex}`;
    }
    
    query += ' RETURNING *';

    try {
      // Get current item to check status change
      const currentItem = await this.findById(id, userId);
      if (!currentItem) {
        throw new Error('Item not found');
      }
      
      const result = await pool.query(query, values);
      const updatedItem = result.rows[0];
      
      // Check if status changed to PENDING_REVIEW (submitted for approval)
      if (currentItem.status !== 'PENDING_REVIEW' && updatedItem.status === 'PENDING_REVIEW') {
        await NotificationService.createItemMasterSubmittedNotification(
          updatedItem,
          userId || updatedItem.user_id
        );
      }
      
      return updatedItem;
    } catch (error) {
      throw error;
    }
  }

  static async delete(id, userId = null) {
    let query = 'DELETE FROM items WHERE id = $1';
    let values = [id];
    
    if (userId) {
      query += ' AND user_id = $2';
      values.push(userId);
    }
    
    query += ' RETURNING *';
    
    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }


  static async getStats(userId = null) {
    let query = `
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'APPROVED' THEN 1 END) as approved,
        COUNT(CASE WHEN status = 'DRAFT' THEN 1 END) as draft,
        COUNT(CASE WHEN status = 'PENDING_REVIEW' THEN 1 END) as pending_review,
        COUNT(CASE WHEN stock_code = 'ST1' THEN 1 END) as standard_stock,
        COUNT(CASE WHEN stock_code = 'ST2' THEN 1 END) as secondary_stock,
        COUNT(CASE WHEN stock_code = 'NS3' THEN 1 END) as non_stock,
        COUNT(CASE WHEN criticality = 'HIGH' THEN 1 END) as high_criticality
      FROM items
    `;
    
    const values = [];
    if (userId) {
      query += ' WHERE user_id = $1';
      values.push(userId);
    }

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }
}

module.exports = Item;