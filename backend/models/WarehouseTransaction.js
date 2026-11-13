const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const CostLayerService = require('../services/costLayerService');
const { withDeadlockRetry, lockInventoryItemForWrite, serializeInventoryItemWrite } = require('../services/dbRetry');

class WarehouseTransaction {
  // Create a new warehouse transaction
  static async create(transactionData, items = []) {
    const itemIds = items.map((i) => i.inventory_item_id).filter(Boolean);
    return serializeInventoryItemWrite(itemIds, () =>
      withDeadlockRetry(() => this._createOnce(transactionData, items))
    );
  }

  static async _createOnce(transactionData, items = []) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      
      const {
        transaction_type,
        reference_document,
        reference_type,
        reference_id,
        return_type,
        transfer_type,
        adjustment_type,
        cost_center,
        job_reference,
        notes,
        created_by,
        processed_by,
        requires_approval = false
      } = transactionData;

      const transactionId = uuidv4();
      
      // Calculate totals. physical_quantity (stock adjustments / stocktakes) was
      // missing from this fallback chain, so an SA transaction's header totals
      // (and, below, each item's own `quantity` column) silently recorded 0
      // instead of the actual counted amount.
      const totalQuantity = items.reduce((sum, item) => {
        const qty = item.received_quantity || item.issued_quantity ||
                   item.return_quantity || item.transfer_quantity ||
                   item.physical_quantity ||
                   Math.abs(item.adjustment_quantity) || item.quantity || 0;
        return sum + parseFloat(qty);
      }, 0);

      const totalValue = items.reduce((sum, item) => {
        const qty = item.received_quantity || item.issued_quantity ||
                   item.return_quantity || item.transfer_quantity ||
                   item.physical_quantity ||
                   Math.abs(item.adjustment_quantity) || item.quantity || 0;
        const cost = item.unit_cost || 0;
        return sum + (parseFloat(qty) * parseFloat(cost));
      }, 0);

      // Determine status
      const status = requires_approval ? 'PENDING_APPROVAL' : 'POSTED';

      // Insert main transaction record
      const transactionQuery = `
        INSERT INTO warehouse_transactions (
          id, transaction_type, reference_document, reference_type, reference_id,
          return_type, transfer_type, adjustment_type, cost_center, job_reference,
          status, requires_approval, total_quantity, total_value, notes,
          created_by, processed_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING *
      `;

      const transactionValues = [
        transactionId, transaction_type, reference_document, reference_type, reference_id,
        return_type, transfer_type, adjustment_type, cost_center, job_reference,
        status, requires_approval, totalQuantity, totalValue, notes,
        created_by, processed_by
      ];

      const transactionResult = await client.query(transactionQuery, transactionValues);
      const transaction = transactionResult.rows[0];

      // Insert transaction items
      for (const item of items) {
        const itemId = uuidv4();
        const itemQuery = `
          INSERT INTO warehouse_transaction_items (
            id, warehouse_transaction_id, inventory_item_id, item_name, item_description,
            quantity, received_quantity, issued_quantity, return_quantity,
            transfer_quantity, physical_quantity, adjustment_quantity,
            unit_of_measure, unit_cost, total_cost,
            source_storage_location_id, source_bin_id,
            destination_storage_location_id, destination_bin_id,
            condition, reason_code, batch_number, expiry_date, serial_number, notes
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
        `;

        const qty = item.received_quantity || item.issued_quantity ||
                    item.return_quantity || item.transfer_quantity ||
                    item.physical_quantity ||
                    item.adjustment_quantity || item.quantity || 0;

        // Ensure quantity field is set for database insertion
        const itemQuantity = item.quantity || qty;
        const unitCost = parseFloat(item.unit_cost || 0);
        const totalCost = parseFloat(qty) * unitCost;

        // Handle date fields - convert empty strings to null
        const expiryDate = item.expiry_date && item.expiry_date.trim() !== '' ? item.expiry_date : null;
        
        const itemValues = [
          itemId, transactionId, item.inventory_item_id, item.item_name, item.item_description,
          itemQuantity, item.received_quantity, item.issued_quantity, item.return_quantity,
          item.transfer_quantity, item.physical_quantity, item.adjustment_quantity,
          item.unit_of_measure, unitCost, totalCost,
          item.source_storage_location_id || null, item.source_bin_id || null,
          item.destination_storage_location_id || null, item.destination_bin_id || null,
          item.condition, item.reason_code, item.batch_number, expiryDate, 
          item.serial_number, item.notes
        ];

        await client.query(itemQuery, itemValues);
      }

      // Log audit trail
      await this.logAudit(client, transactionId, 'CREATED', null, status, created_by);

      // Update stock levels if transaction is posted
      if (status === 'POSTED') {
        await this.updateStockLevels(client, transactionId, transaction_type, items, created_by, reference_type, reference_id);
        
        // Update related sales order status if this is a goods issue
        if (transaction_type === 'GI' && reference_type === 'SO' && reference_id) {
          // The goods-issue posting is what drives "Goods Issued" — record it as
          // its own milestone in the status history (previously this jumped
          // straight to READY_FOR_DELIVERY, so GOODS_ISSUED never appeared even
          // though it's a real status in the state machine) before advancing to
          // READY_FOR_DELIVERY, which the same physical event also satisfies.
          const { rows: soRows } = await client.query(
            'SELECT status FROM sales_orders WHERE id = $1 FOR UPDATE',
            [reference_id]
          );
          const soStatusBeforeIssue = soRows[0]?.status || null;

          await client.query(
            'UPDATE sales_orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            ['GOODS_ISSUED', reference_id]
          );
          if (soStatusBeforeIssue) {
            await client.query(
              `INSERT INTO sales_order_status_history (sales_order_id, from_status, to_status, changed_by, reason)
               VALUES ($1, $2, 'GOODS_ISSUED', $3, $4)`,
              [reference_id, soStatusBeforeIssue, created_by, 'Goods issued from inventory']
            );
          }

          await client.query(
            'UPDATE sales_orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            ['READY_FOR_DELIVERY', reference_id]
          );
          await client.query(
            `INSERT INTO sales_order_status_history (sales_order_id, from_status, to_status, changed_by, reason)
             VALUES ($1, 'GOODS_ISSUED', 'READY_FOR_DELIVERY', $2, $3)`,
            [reference_id, created_by, 'Goods issue posted; order ready for delivery']
          );

          // Also update delivery schedule status if exists
          await client.query(
            'UPDATE delivery_schedules SET status = $1, workflow_status = $2, updated_at = CURRENT_TIMESTAMP WHERE sales_order_id = $3 AND fulfillment_type = $4',
            ['READY_TO_SHIP', 'GOODS_ISSUED', reference_id, 'INVENTORY']
          );

          // Release the reservation this GI just fulfilled. approveOrder() (see
          // SalesOrder.js) sets quantity_reserved when an order is approved so
          // ATPService.getAvailableToPromise() can see it as spoken-for stock.
          // Without this, current_stock_quantity drops here but the line still
          // reads as reserved — the reservation is never freed, so "available"
          // permanently undercounts every item that ever ships, drifting further
          // wrong with every completed order. One matching sales_order_items row
          // per (order, item) is the normal case; if an order genuinely has more
          // than one line for the same item, each matching row is reduced by the
          // full issued quantity rather than split between them — a known
          // simplification, not a data-loss risk (GREATEST(0, ...) floors it).
          for (const item of items) {
            if (!item.inventory_item_id) continue;
            const issuedQty = parseFloat(item.issued_quantity || item.quantity || 0);
            if (!issuedQty) continue;
            await client.query(
              `UPDATE sales_order_items
                  SET quantity_reserved = GREATEST(0, quantity_reserved - $1),
                      quantity_delivered = LEAST(quantity, COALESCE(quantity_delivered, 0) + $1),
                      updated_at = CURRENT_TIMESTAMP
                WHERE sales_order_id = $2 AND inventory_item_id = $3`,
              [issuedQty, reference_id, item.inventory_item_id]
            );
          }
        }
      }

      await client.query('COMMIT');
      
      // Return transaction with items
      return await this.getById(transactionId);
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Get transaction by ID
  static async getById(id) {
    const query = `
      SELECT 
        wt.*,
        u1.first_name || ' ' || u1.last_name as created_by_name,
        u2.first_name || ' ' || u2.last_name as processed_by_name,
        u3.first_name || ' ' || u3.last_name as approved_by_name
      FROM warehouse_transactions wt
      LEFT JOIN users u1 ON wt.created_by = u1.id
      LEFT JOIN users u2 ON wt.processed_by = u2.id
      LEFT JOIN users u3 ON wt.approved_by = u3.id
      WHERE wt.id = $1
    `;
    
    const result = await pool.query(query, [id]);
    if (result.rows.length === 0) return null;
    
    const transaction = result.rows[0];
    
    // Get transaction items
    const itemsQuery = `
      SELECT 
        wti.*,
        sl1.name as source_location_name,
        sl1.code as source_location_code,
        b1.code as source_bin_code,
        sl2.name as destination_location_name,
        sl2.code as destination_location_code,
        b2.code as destination_bin_code,
        ii.item_master_id,
        i.name as item_master_name
      FROM warehouse_transaction_items wti
      LEFT JOIN storage_locations sl1 ON wti.source_storage_location_id = sl1.id
      LEFT JOIN bins b1 ON wti.source_bin_id = b1.id
      LEFT JOIN storage_locations sl2 ON wti.destination_storage_location_id = sl2.id
      LEFT JOIN bins b2 ON wti.destination_bin_id = b2.id
      LEFT JOIN inventory_items ii ON wti.inventory_item_id = ii.id
      LEFT JOIN items i ON ii.item_master_id = i.id
      WHERE wti.warehouse_transaction_id = $1
      ORDER BY wti.created_at
    `;
    
    const itemsResult = await pool.query(itemsQuery, [id]);
    transaction.items = itemsResult.rows;
    
    return transaction;
  }

  // Get transactions with filters
  static async getAll(filters = {}) {
    let whereConditions = [];
    let values = [];
    let paramCount = 0;

    // Build WHERE conditions
    if (filters.transaction_type) {
      whereConditions.push(`wt.transaction_type = $${++paramCount}`);
      values.push(filters.transaction_type);
    }

    if (filters.status) {
      whereConditions.push(`wt.status = $${++paramCount}`);
      values.push(filters.status);
    }

    if (filters.date_from) {
      whereConditions.push(`wt.transaction_date >= $${++paramCount}`);
      values.push(filters.date_from);
    }

    if (filters.date_to) {
      whereConditions.push(`wt.transaction_date <= $${++paramCount}`);
      values.push(filters.date_to);
    }

    if (filters.created_by) {
      whereConditions.push(`wt.created_by = $${++paramCount}`);
      values.push(filters.created_by);
    }

    if (filters.reference_document) {
      whereConditions.push(`wt.reference_document ILIKE $${++paramCount}`);
      values.push(`%${filters.reference_document}%`);
    }

    const whereClause = whereConditions.length > 0 ? 
      `WHERE ${whereConditions.join(' AND ')}` : '';

    const query = `
      SELECT 
        wt.*,
        u1.first_name || ' ' || u1.last_name as created_by_name,
        u2.first_name || ' ' || u2.last_name as processed_by_name
      FROM warehouse_transactions wt
      LEFT JOIN users u1 ON wt.created_by = u1.id
      LEFT JOIN users u2 ON wt.processed_by = u2.id
      ${whereClause}
      ORDER BY wt.created_at DESC
      LIMIT ${Number.parseInt(filters.limit, 10) || 50} OFFSET ${Number.parseInt(filters.offset, 10) || 0}
    `;

    const result = await pool.query(query, values);
    return result.rows;
  }

  // Approve transaction
  static async approve(id, approvedBy, notes = null) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Get transaction
      const transaction = await this.getById(id);
      if (!transaction) {
        throw new Error('Transaction not found');
      }

      if (transaction.status !== 'PENDING_APPROVAL') {
        throw new Error('Transaction is not pending approval');
      }

      // Update status to approved and posted
      const query = `
        UPDATE warehouse_transactions 
        SET status = 'POSTED', approved_by = $1, approved_at = CURRENT_TIMESTAMP,
            notes = CASE WHEN $2 IS NOT NULL THEN COALESCE(notes, '') || '\nApproval Notes: ' || $2 ELSE notes END
        WHERE id = $3
      `;
      
      await client.query(query, [approvedBy, notes, id]);

      // Log audit trail
      await this.logAudit(client, id, 'APPROVED', 'PENDING_APPROVAL', 'POSTED', approvedBy);

      // Update stock levels
      await this.updateStockLevels(client, id, transaction.transaction_type, transaction.items, approvedBy, transaction.reference_type, transaction.reference_id);

      await client.query('COMMIT');
      
      return await this.getById(id);
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Reject transaction
  static async reject(id, rejectedBy, reason) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      const query = `
        UPDATE warehouse_transactions 
        SET status = 'REJECTED', approved_by = $1, approved_at = CURRENT_TIMESTAMP,
            notes = COALESCE(notes, '') || '\nRejection Reason: ' || $2
        WHERE id = $3 AND status = 'PENDING_APPROVAL'
      `;
      
      const result = await client.query(query, [rejectedBy, reason, id]);
      
      if (result.rowCount === 0) {
        throw new Error('Transaction not found or not pending approval');
      }

      // Log audit trail
      await this.logAudit(client, id, 'REJECTED', 'PENDING_APPROVAL', 'REJECTED', rejectedBy);

      await client.query('COMMIT');
      
      return await this.getById(id);
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Update stock levels based on transaction type
  static async updateStockLevels(client, transactionId, transactionType, items, userId = null, referenceType = null, referenceId = null) {
    const sortedItems = [...items].sort((a, b) => {
      const keyA = String(a.inventory_item_id || a.item_name || '');
      const keyB = String(b.inventory_item_id || b.item_name || '');
      return keyA.localeCompare(keyB);
    });

    for (const item of sortedItems) {
      switch (transactionType) {
        case 'GR': // Goods Receipt - Create new inventory items or increase existing stock
          await this.handleGoodsReceipt(client, item, userId);
          break;

        case 'GT': // Goods Transfer - Move stock between locations
          await this.handleGoodsTransfer(client, item, userId);
          break;
        case 'GI': // Goods Issue - Decrease stock
        case 'GE': // Goods Return
        case 'SA': // Stock Adjustment
          await this.handleExistingInventory(client, item, transactionType, transactionId, userId, referenceType, referenceId);
          break;
      }
    }
  }

  // Handle goods receipt: replenish an existing inventory item, or create one.
  static async handleGoodsReceipt(client, item, userId = null) {
    try {
      const receivedQuantity = parseFloat(item.received_quantity || item.quantity || 0);
      const unitCost = parseFloat(item.unit_cost || 0);

      // Handle unit price - database constraint requires positive prices or null
      const unitPrice = unitCost > 0 ? unitCost : null;

      // Serialize concurrent receipts against the same item before anything
      // else touches it — see lockInventoryItemForWrite for why this exists
      // alongside, not instead of, the FOR UPDATE below.
      if (item.inventory_item_id) {
        await lockInventoryItemForWrite(client, item.inventory_item_id);
      }

      // The caller (routes/warehouse-transactions.js, or anything replenishing
      // a specific item) can name the inventory item directly. That case used
      // to be silently ignored below — resolution went through item-master
      // name-matching regardless, so a receipt against a real, known
      // inventory_item_id would still create a brand-new item master the
      // moment its name didn't happen to match one already in `items` by exact
      // string, and a receipt with an invented name always did. Checking for
      // an explicit inventory_item_id first means "replenish this item" means
      // exactly that, and the name-matching path below is now only reached for
      // an actual first-time receipt with no inventory item to point at.
      let existingInventoryResult = { rows: [] };
      let itemMasterId = null;

      if (item.inventory_item_id) {
        // FOR UPDATE: this read feeds the current_stock_quantity/unit_price
        // UPDATE below. Without the lock, two concurrent receipts against the
        // same item both read the same starting quantity and one write is
        // silently lost — the classic read-then-write race, closed here the
        // same way it's closed on every other stock mutation in this file.
        existingInventoryResult = await client.query(
          'SELECT id, item_master_id, current_stock_quantity, unit_price FROM inventory_items WHERE id = $1 FOR UPDATE',
          [item.inventory_item_id]
        );
        if (existingInventoryResult.rows.length === 0) {
          throw new Error(`Inventory item ${item.inventory_item_id} not found`);
        }
        itemMasterId = existingInventoryResult.rows[0].item_master_id;
      } else {
        // Try to find existing item by name or create a new one
        const existingItemResult = await client.query(
          'SELECT id FROM items WHERE name = $1 OR approved_item_code = $1',
          [item.item_name]
        );

        if (existingItemResult.rows.length > 0) {
          itemMasterId = existingItemResult.rows[0].id;
        } else {
          // Create new item master if it doesn't exist
          const Item = require('./Item');
          const newItemId = uuidv4();
          await client.query(`
            INSERT INTO items (id, item_code, name, description, unit_of_measure, status)
            VALUES ($1, $2, $3, $4, $5, 'active')
          `, [newItemId, Item.generateItemCode(), item.item_name, item.item_description || item.item_name, item.unit_of_measure || 'PCS']);
          itemMasterId = newItemId;
        }

        // Check if inventory item already exists for this item master and user
        existingInventoryResult = await client.query(
          'SELECT id, current_stock_quantity, unit_price FROM inventory_items WHERE item_master_id = $1 AND user_id = $2 FOR UPDATE',
          [itemMasterId, userId || 1]
        );
      }

      let inventoryItemId;

      if (existingInventoryResult.rows.length > 0) {
        // Update existing inventory item - add to current stock
        const existingItem = existingInventoryResult.rows[0];
        inventoryItemId = existingItem.id;
        const oldQty = parseFloat(existingItem.current_stock_quantity) || 0;
        const newTotalQuantity = oldQty + receivedQuantity;

        // Weighted-average (moving-average) costing: recompute the unit cost as
        // the value-weighted blend of the existing stock and the newly received
        // stock. Only when a real receipt cost is provided; otherwise keep the
        // prior average. unit_price on inventory_items is the moving-average cost.
        let newAvgCost = null; // null => COALESCE keeps existing unit_price
        if (unitPrice != null && unitPrice > 0) {
          const oldAvg = parseFloat(existingItem.unit_price) || 0;
          const blended = newTotalQuantity > 0
            ? (oldQty * oldAvg + receivedQuantity * unitPrice) / newTotalQuantity
            : unitPrice;
          newAvgCost = Math.round(blended * 10000) / 10000; // 4dp cost precision
        }

        await client.query(`
          UPDATE inventory_items
          SET current_stock_quantity = $1,
              unit_price = COALESCE($2, unit_price),
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $3
        `, [newTotalQuantity, newAvgCost, inventoryItemId]);

        console.log(`Updated inventory item ${inventoryItemId}: +${receivedQuantity} units (total ${newTotalQuantity}), avg cost ${newAvgCost ?? 'unchanged'}`);
      } else {
        // Create new inventory item
        inventoryItemId = uuidv4();
        
        // Map condition to single character grade
        const conditionGradeMap = {
          'GOOD': 'A',
          'FAIR': 'B', 
          'POOR': 'C',
          'DAMAGED': 'D',
          'EXCELLENT': 'A',
          'NEW': 'A'
        };
        
        const conditionGrade = conditionGradeMap[item.condition] || 'A';
        
        await client.query(`
          INSERT INTO inventory_items (
            id, item_master_id, current_stock_quantity, unit_price, currency,
            condition_grade, status, user_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          inventoryItemId, 
          itemMasterId, 
          receivedQuantity, 
          unitPrice, 
          'USD',
          conditionGrade,
          'APPROVED',
          userId || 1
        ]);
        
        console.log(`Created new inventory item ${inventoryItemId} with ${receivedQuantity} units`);
      }

      // Record a cost layer for this receipt — creates an auditable per-receipt
      // cost record that feeds into COGS on issue.
      if (receivedQuantity > 0 && unitPrice != null && unitPrice > 0) {
        await CostLayerService.createLayer({
          inventory_item_id: inventoryItemId,
          warehouse_transaction_id: null,
          receipt_type: 'GOODS_RECEIPT',
          quantity: receivedQuantity,
          unit_cost: unitPrice,
          created_by: userId,
        }, client);
      }

      // Create or update inventory storage mapping to show where items are stored
      if (item.destination_storage_location_id) {
        // Check if mapping already exists for this location/bin combination
        const existingMappingResult = await client.query(`
          SELECT id, quantity_in_location FROM inventory_storage_mappings
          WHERE inventory_item_id = $1 AND storage_location_id = $2 AND
                (bin_id = $3 OR (bin_id IS NULL AND $3 IS NULL))
          FOR UPDATE
        `, [inventoryItemId, item.destination_storage_location_id, item.destination_bin_id || null]);

        if (existingMappingResult.rows.length > 0) {
          // Update existing storage mapping - add to current quantity
          const existingMapping = existingMappingResult.rows[0];
          const newMappingQuantity = parseFloat(existingMapping.quantity_in_location) + receivedQuantity;
          
          await client.query(`
            UPDATE inventory_storage_mappings 
            SET quantity_in_location = $1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
          `, [newMappingQuantity, existingMapping.id]);
          
          console.log(`Updated storage mapping with ${receivedQuantity} units (new total: ${newMappingQuantity})`);
        } else {
          // Create new storage mapping
          const mappingId = uuidv4();
          await client.query(`
            INSERT INTO inventory_storage_mappings (
              id, inventory_item_id, storage_location_id, bin_id,
              quantity_in_location, user_id
            ) VALUES ($1, $2, $3, $4, $5, $6)
          `, [
            mappingId,
            inventoryItemId,
            item.destination_storage_location_id,
            item.destination_bin_id || null,
            receivedQuantity,
            userId || 1
          ]);
          
          console.log(`Created new storage mapping with ${receivedQuantity} units`);
        }
      }

    } catch (error) {
      console.error('Error handling goods receipt:', error);
      throw error;
    }
  }

  // Handle goods transfer by updating storage mappings
  static async handleGoodsTransfer(client, item, userId = null) {
    try {
      const transferQuantity = parseFloat(item.transfer_quantity || item.quantity || 0);

      if (!item.inventory_item_id) {
        throw new Error('Inventory item ID is required for goods transfer');
      }

      await lockInventoryItemForWrite(client, item.inventory_item_id);

      console.log(`Processing goods transfer: ${transferQuantity} units from ${item.source_storage_location_id} to ${item.destination_storage_location_id}`);

      // Step 1: Reduce quantity from source location
      if (item.source_storage_location_id) {
        const sourceMapping = await client.query(`
          SELECT id, quantity_in_location FROM inventory_storage_mappings
          WHERE inventory_item_id = $1 AND storage_location_id = $2 AND
                (bin_id = $3 OR (bin_id IS NULL AND $3 IS NULL))
          FOR UPDATE
        `, [item.inventory_item_id, item.source_storage_location_id, item.source_bin_id || null]);

        if (sourceMapping.rows.length === 0) {
          throw new Error('No inventory found at source location');
        }

        const sourceData = sourceMapping.rows[0];
        const sourceQuantity = parseFloat(sourceData.quantity_in_location);
        
        if (sourceQuantity < transferQuantity) {
          throw new Error(`Insufficient quantity at source location. Available: ${sourceQuantity}, Requested: ${transferQuantity}`);
        }

        const newSourceQuantity = sourceQuantity - transferQuantity;
        
        if (newSourceQuantity === 0) {
          // Remove mapping if quantity becomes 0
          await client.query(`
            DELETE FROM inventory_storage_mappings WHERE id = $1
          `, [sourceData.id]);
          console.log(`Removed empty source mapping`);
        } else {
          // Update source mapping with reduced quantity
          await client.query(`
            UPDATE inventory_storage_mappings 
            SET quantity_in_location = $1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
          `, [newSourceQuantity, sourceData.id]);
          console.log(`Updated source mapping: ${newSourceQuantity} remaining`);
        }
      }

      // Step 2: Add quantity to destination location
      if (item.destination_storage_location_id) {
        // Check if destination mapping already exists
        const destMappingResult = await client.query(`
          SELECT id, quantity_in_location FROM inventory_storage_mappings
          WHERE inventory_item_id = $1 AND storage_location_id = $2 AND
                (bin_id = $3 OR (bin_id IS NULL AND $3 IS NULL))
          FOR UPDATE
        `, [item.inventory_item_id, item.destination_storage_location_id, item.destination_bin_id || null]);

        if (destMappingResult.rows.length > 0) {
          // Update existing destination mapping
          const destData = destMappingResult.rows[0];
          const destQuantity = parseFloat(destData.quantity_in_location);
          const newDestQuantity = destQuantity + transferQuantity;
          
          await client.query(`
            UPDATE inventory_storage_mappings 
            SET quantity_in_location = $1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
          `, [newDestQuantity, destData.id]);
          
          console.log(`Updated destination mapping: ${newDestQuantity} total`);
        } else {
          // Create new destination mapping
          const mappingId = uuidv4();
          await client.query(`
            INSERT INTO inventory_storage_mappings (
              id, inventory_item_id, storage_location_id, bin_id,
              quantity_in_location, user_id
            ) VALUES ($1, $2, $3, $4, $5, $6)
          `, [
            mappingId,
            item.inventory_item_id,
            item.destination_storage_location_id,
            item.destination_bin_id || null,
            transferQuantity,
            userId || 1
          ]);
          
          console.log(`Created new destination mapping with ${transferQuantity} units`);
        }
      }

    } catch (error) {
      console.error('Error handling goods transfer:', error);
      throw error;
    }
  }

  // Handle other transaction types that work with existing inventory
  static async handleExistingInventory(client, item, transactionType, transactionId = null, userId = null, referenceType = null, referenceId = null) {
    if (!item.inventory_item_id) return; // Skip manual items without inventory tracking

    await lockInventoryItemForWrite(client, item.inventory_item_id);

    // FOR UPDATE: GI/GE/SA all read current_stock_quantity here and write a
    // computed new value back below. Every stock-mutating path in this file
    // now takes this lock on its opening read — the one that matters most,
    // since GI (the highest-frequency stock movement) runs through here.
    const inventoryItem = await client.query(
      'SELECT * FROM inventory_items WHERE id = $1 FOR UPDATE',
      [item.inventory_item_id]
    );

    if (inventoryItem.rows.length === 0) return;

    const currentItem = inventoryItem.rows[0];
    let newQuantity = currentItem.current_stock_quantity;
    let issuedQty = 0;
    let varianceQty = 0;

    switch (transactionType) {
      case 'GI': // Goods Issue - Decrease stock
        issuedQty = parseFloat(item.issued_quantity || item.quantity || 0);
        newQuantity -= issuedQty;
        break;

      case 'GE': // Goods Return
        if (item.return_type === 'supplier') {
          newQuantity -= parseFloat(item.return_quantity || item.quantity || 0);
        } else {
          newQuantity += parseFloat(item.return_quantity || item.quantity || 0);
        }
        break;

      case 'SA': { // Stock Adjustment (stocktake / cycle count)
        const physical = parseFloat(item.physical_quantity || 0);
        varianceQty = physical - parseFloat(currentItem.current_stock_quantity || 0);
        newQuantity = physical;
        break;
      }
    }

    // Ensure quantity doesn't go negative
    newQuantity = Math.max(0, newQuantity);

    // Update inventory item quantity
    await client.query(`
      UPDATE inventory_items
      SET current_stock_quantity = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [newQuantity, item.inventory_item_id]);

    // Recognize Cost of Goods Sold on goods issue, valued at the moving-average
    // unit cost (weighted-average costing). Dr COGS (5100) / Cr Inventory (1130).
    if (transactionType === 'GI' && issuedQty > 0) {
      // Consume cost layers (FIFO) to keep the audit trail in sync with stock
      await CostLayerService.consumeLayers(item.inventory_item_id, issuedQty, client);
      await this.postCogsForIssue(client, currentItem, issuedQty, transactionId, userId);

      // Serial/lot traceability: if this issue line names a serial or a
      // batch/lot, resolve it against real received units rather than
      // accepting the free-text value at face value — an unknown or
      // already-issued serial refuses the whole transaction (thrown from
      // here, inside the same DB transaction, so nothing partially commits).
      if (item.serial_number || item.batch_number) {
        const SerialLotService = require('../services/serialLotService');
        await SerialLotService.issueUnits({
          inventory_item_id: item.inventory_item_id,
          quantity: issuedQty,
          serial_numbers: item.serial_number ? [item.serial_number] : [],
          batch_lot_number: item.batch_number || null,
          warehouse_transaction_id: transactionId,
          reference_type: referenceType,
          reference_id: referenceId,
          created_by: userId,
        }, client);
      }
    }

    // Post a stocktake/cycle-count variance to the GL, valued at the item's
    // moving-average cost (ERP-Roadmap P3 #12). A found-more-than-expected count
    // debits Inventory / credits COGS; a shrinkage debits COGS / credits Inventory.
    if (transactionType === 'SA' && varianceQty !== 0) {
      // Adjust cost layers to match the physical count
      if (varianceQty > 0) {
        // Found more: add a layer at current weighted-average cost
        const avgCost = parseFloat(currentItem.unit_price) || 0;
        await CostLayerService.createLayer({
          inventory_item_id: item.inventory_item_id,
          warehouse_transaction_id: null,
          receipt_type: 'STOCK_ADJUSTMENT',
          quantity: varianceQty,
          unit_cost: avgCost,
          created_by: userId,
        }, client);
      } else {
        // Shrinkage: consume from oldest layers
        await CostLayerService.consumeLayers(item.inventory_item_id, Math.abs(varianceQty), client);
      }
      await this.postStocktakeVariance(client, currentItem, varianceQty, transactionId, userId, item.reason_code);
    }
  }

  // Post the GL entry for a stocktake variance found via a Stock Adjustment.
  static async postStocktakeVariance(client, inventoryItem, varianceQty, transactionId, userId, reasonCode) {
    const avgCost = parseFloat(inventoryItem.unit_price) || 0;
    const adjustmentValue = Math.round(varianceQty * avgCost * 100) / 100;
    if (adjustmentValue === 0) return null; // no cost basis or exactly offsetting — nothing to post

    const FinancialPostingService = require('../services/financialPostingService');
    return FinancialPostingService.postInventoryAdjustment({
      inventory_item_id: inventoryItem.id,
      adjustment_quantity: varianceQty,
      adjustment_value: adjustmentValue,
      reason: reasonCode || 'Stocktake / cycle count variance',
      reference: transactionId,
    }, userId, client);
  }

  // Post the COGS journal entry for a goods issue at weighted-average cost.
  static async postCogsForIssue(client, inventoryItem, issuedQty, transactionId, userId) {
    const avgCost = parseFloat(inventoryItem.unit_price) || 0;
    const cogs = Math.round(avgCost * issuedQty * 100) / 100;
    if (cogs <= 0) return null; // no cost basis recorded — nothing to expense

    const accs = await client.query(`
      SELECT id, account_code FROM chart_of_accounts
      WHERE account_code IN ('5100','1130') AND status = 'ACTIVE' AND deleted_at IS NULL
    `);
    const map = {};
    accs.rows.forEach((a) => { map[a.account_code] = a.id; });
    if (!map['5100'] || !map['1130']) {
      throw new Error('Cannot post COGS: account 5100 (Cost of Goods Sold) and/or 1130 (Inventory) missing or inactive');
    }

    // externalClient (5th/4th arg below) keeps this on the SAME connection and
    // transaction as the stock update above, not a separate one. Without it,
    // this posting was running as its own independent transaction — able to
    // commit even if the outer goods-issue transaction later rolled back
    // (an orphaned COGS entry with no matching stock change), and, found
    // while chasing a live concurrency test: a detached connection touching
    // shared GL accounts (5100/1130, used by every item's COGS, not just
    // this one) outside the lock discipline the rest of this transaction
    // observes — the actual cause of deadlocks under concurrent goods issues
    // that the item-level advisory lock alone could not explain.
    const JournalEntry = require('./JournalEntry');
    const entry = await JournalEntry.create({
      entry_date: new Date().toISOString().split('T')[0],
      source_type: 'GOODS_ISSUE',
      source_id: transactionId,
      description: `COGS - goods issue (${issuedQty} @ ${avgCost})`,
      reference: transactionId || undefined,
      requires_approval: false,
    }, [
      { account_id: map['5100'], debit_amount: cogs, credit_amount: 0, description: 'Cost of goods sold' },
      { account_id: map['1130'], debit_amount: 0, credit_amount: cogs, description: 'Inventory relief' },
    ], userId, client);
    await JournalEntry.postAsSystem(entry.id, userId, 'Auto-posted COGS on goods issue', client);
    return entry;
  }

  // Log audit trail
  static async logAudit(client, transactionId, action, previousStatus, newStatus, userId, additionalData = {}) {
    const query = `
      INSERT INTO warehouse_transaction_audit_log (
        warehouse_transaction_id, action, previous_status, new_status, user_id,
        field_changed, old_value, new_value
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `;

    await client.query(query, [
      transactionId, action, previousStatus, newStatus, userId,
      additionalData.field_changed || null,
      additionalData.old_value || null,
      additionalData.new_value || null
    ]);
  }

  // Get transaction statistics
  static async getStats(filters = {}) {
    const whereConditions = [];
    const values = [];
    let paramCount = 0;

    // Default to current year if no date filters
    if (!filters.date_from && !filters.date_to) {
      whereConditions.push(`EXTRACT(YEAR FROM transaction_date) = EXTRACT(YEAR FROM CURRENT_DATE)`);
    }

    if (filters.date_from) {
      whereConditions.push(`transaction_date >= $${++paramCount}`);
      values.push(filters.date_from);
    }

    if (filters.date_to) {
      whereConditions.push(`transaction_date <= $${++paramCount}`);
      values.push(filters.date_to);
    }

    const whereClause = whereConditions.length > 0 ? 
      `WHERE ${whereConditions.join(' AND ')}` : '';

    const query = `
      SELECT 
        COUNT(*) as total_transactions,
        COUNT(CASE WHEN transaction_date = CURRENT_DATE THEN 1 END) as today_transactions,
        COUNT(CASE WHEN transaction_date >= CURRENT_DATE - INTERVAL '7 days' THEN 1 END) as week_transactions,
        COUNT(CASE WHEN status = 'PENDING_APPROVAL' THEN 1 END) as pending_approvals,
        SUM(total_value) as total_value,
        COUNT(CASE WHEN transaction_type = 'GR' THEN 1 END) as goods_receipts,
        COUNT(CASE WHEN transaction_type = 'GI' THEN 1 END) as goods_issues,
        COUNT(CASE WHEN transaction_type = 'GE' THEN 1 END) as goods_returns,
        COUNT(CASE WHEN transaction_type = 'GT' THEN 1 END) as goods_transfers,
        COUNT(CASE WHEN transaction_type = 'SA' THEN 1 END) as stock_adjustments
      FROM warehouse_transactions 
      ${whereClause}
    `;

    const result = await pool.query(query, values);
    return result.rows[0];
  }

  // Get audit trail for a transaction
  static async getAuditTrail(transactionId) {
    const query = `
      SELECT 
        al.*,
        u.first_name || ' ' || u.last_name as user_name,
        u.email as user_email
      FROM warehouse_transaction_audit_log al
      LEFT JOIN users u ON al.user_id = u.id
      WHERE al.warehouse_transaction_id = $1
      ORDER BY al.created_at DESC
    `;

    const result = await pool.query(query, [transactionId]);
    return result.rows;
  }

  // Cancel transaction (if allowed)
  static async cancel(id, cancelledBy, reason) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Get transaction
      const transaction = await this.getById(id);
      if (!transaction) {
        throw new Error('Transaction not found');
      }

      if (!['DRAFT', 'PENDING_APPROVAL'].includes(transaction.status)) {
        throw new Error('Cannot cancel a posted transaction');
      }

      const query = `
        UPDATE warehouse_transactions 
        SET status = 'CANCELLED',
            notes = COALESCE(notes, '') || '\nCancellation Reason: ' || $1
        WHERE id = $2
      `;
      
      await client.query(query, [reason, id]);

      // Log audit trail
      await this.logAudit(client, id, 'CANCELLED', transaction.status, 'CANCELLED', cancelledBy);

      await client.query('COMMIT');
      
      return await this.getById(id);
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = WarehouseTransaction;