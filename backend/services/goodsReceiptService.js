const { pool } = require('../config/database');
const InventoryItem = require('../models/InventoryItem');
const PurchaseOrder = require('../models/PurchaseOrder');
const NotificationService = require('./notificationService');
const CostLayerService = require('./costLayerService');
const SerialLotService = require('./serialLotService');
const { v4: uuidv4 } = require('uuid');

// goods_receipts records condition as NEW/USED/REFURBISHED/DAMAGED, but
// inventory_items.condition_grade is VARCHAR(1) CHECK (A|B|C|D) (migrations
// 011/012: A=Excellent/New, B=Good, C=Fair, D=Poor). Translate so the value
// InventoryItem.create inserts is legal instead of failing the whole receipt
// with 22001 ('value too long for type character varying(1)').
const CONDITION_GRADE_MAP = {
  NEW: 'A',
  USED: 'B',
  REFURBISHED: 'C',
  DAMAGED: 'D'
};

class GoodsReceiptService {
  /**
   * Process goods receipt for a purchase order line item
   * This creates inventory items from received goods
   */
  static async receiveGoods(receiptData, userId) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const {
        po_id,
        line_item_id,
        quantity_received,
        condition_grade = 'NEW',
        batch_lot_number,
        serial_numbers = [],
        expiry_date,
        received_date = new Date().toISOString(),
        storage_location_id,
        bin_id,
        notes
      } = receiptData;

      // Get PO line item details
      const lineItemQuery = `
        SELECT poli.*, po.supplier_id, po.currency, po.po_number, s.legal_name as supplier_name
        FROM purchase_order_line_items poli
        JOIN purchase_orders po ON poli.po_id = po.id
        JOIN suppliers s ON po.supplier_id = s.id
        WHERE poli.po_id = $1 AND poli.id = $2
      `;
      
      const lineItemResult = await client.query(lineItemQuery, [po_id, line_item_id]);
      const lineItem = lineItemResult.rows[0];
      
      if (!lineItem) {
        throw new Error('Purchase order line item not found');
      }

      // Check if quantity being received doesn't exceed remaining quantity
      const remainingQuantity = lineItem.quantity - lineItem.quantity_received;
      if (quantity_received > remainingQuantity) {
        throw new Error(`Cannot receive ${quantity_received} units. Only ${remainingQuantity} units remaining.`);
      }

      // Create goods receipt record
      const receiptId = uuidv4();
      const receiptQuery = `
        INSERT INTO goods_receipts (
          id, po_id, po_line_item_id, quantity_received, condition_grade,
          batch_lot_number, serial_numbers, expiry_date, received_date,
          storage_location_id, bin_id, notes, received_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *
      `;
      
      await client.query(receiptQuery, [
        receiptId, po_id, line_item_id, quantity_received, condition_grade,
        batch_lot_number, JSON.stringify(serial_numbers), expiry_date, received_date,
        storage_location_id, bin_id, notes, userId
      ]);

      // If this is an inventory item (has item_id), create inventory items
      if (lineItem.item_id) {
        // Create inventory item entries for received goods
        const inventoryItemData = {
          // InventoryItem.create consumes item_master_id (models/InventoryItem.js)
          // and verifies the item master against `items`; po_line_items.item_id
          // references items.id, so that IS the item master id.
          item_master_id: lineItem.item_id,
          supplier_id: lineItem.supplier_id,
          // The model inserts `unit_price`; `purchase_price` was silently
          // dropped, leaving inventory_items.unit_price NULL on every GR.
          unit_price: lineItem.unit_price,
          currency: lineItem.currency,
          // Translate the receipt's condition (NEW/USED/REFURBISHED/DAMAGED) to
          // inventory_items' A-D grade — see CONDITION_GRADE_MAP above.
          condition_grade: CONDITION_GRADE_MAP[condition_grade] || 'A',
          batch_lot_number: batch_lot_number,
          serial_numbers: serial_numbers,
          expiry_date: expiry_date,
          received_date: received_date,
          po_reference: `${lineItem.po_number || 'PO'} - Line ${line_item_id}`,
          notes: notes,
          status: 'APPROVED' // Auto-approve goods from POs
        };

        // Create ONE inventory item per item master. The old code looped once
        // per unit received, but inventory_items is UNIQUE (item_master_id,
        // user_id): the second unit threw "Inventory item already exists for
        // this item master" and rolled back the ENTIRE receipt, so goods could
        // never enter stock (ERP blocker #1). One row per item master, then
        // credit the received quantity into current_stock_quantity below.
        //
        // That same UNIQUE constraint still means InventoryItem.create() throws
        // on any SECOND receipt of an item master that already has a row —
        // whether a second delivery against the same PO line, a later receipt
        // against a different PO for the same item, or simply a repeat
        // purchase. Unconditionally calling create() rolled back the whole
        // receipt (no goods_receipts row, no stock movement, no GR/IR posting)
        // on every receipt after the first one ever posted for that item —
        // reproduced live against the real dev DB before this fix. Reuse the
        // existing row instead of re-creating it; the FOR UPDATE credit below
        // already does the right moving-average math for a pre-existing row.
        const existingInventoryItem = await client.query(
          'SELECT id FROM inventory_items WHERE item_master_id = $1 AND user_id = $2',
          [lineItem.item_id, userId]
        );
        const inventoryItem = existingInventoryItem.rows.length > 0
          ? existingInventoryItem.rows[0]
          : await InventoryItem.create(inventoryItemData, userId);
        const inventoryItems = [inventoryItem];

        // Credit the received quantity into stock with FOR UPDATE locking and
        // moving-average costing, inside this transaction (same math as
        // WarehouseTransaction.handleGoodsReceipt). Without this the row exists
        // but stock never moves — the "inventory never populated" symptom.
        const lockedRow = await client.query(
          'SELECT id, current_stock_quantity, unit_price FROM inventory_items WHERE id = $1 FOR UPDATE',
          [inventoryItem.id]
        );
        const current = lockedRow.rows[0];
        const oldQty = parseFloat(current.current_stock_quantity) || 0;
        const unitPriceIn = Number(lineItem.unit_price) || 0;
        const newQty = oldQty + Number(quantity_received);
        let newAvgCost = null;
        if (unitPriceIn > 0) {
          const oldAvg = parseFloat(current.unit_price) || 0;
          newAvgCost = newQty > 0 ? (oldQty * oldAvg + Number(quantity_received) * unitPriceIn) / newQty : unitPriceIn;
        }
        await client.query(`
          UPDATE inventory_items
             SET current_stock_quantity = $1,
                 unit_price = COALESCE($2, unit_price),
                 updated_at = CURRENT_TIMESTAMP
           WHERE id = $3
        `, [newQty, newAvgCost, inventoryItem.id]);

        // If storage location and bin are specified, auto-assign storage
        if (storage_location_id && bin_id) {
          await this.autoAssignStorage(inventoryItem.id, storage_location_id, bin_id, userId, client);
        }

        // Cost layer: record the receipt cost for audit trail and COGS basis.
        // One aggregated layer per receipt line item (all units share the same PO price).
        const unitPrice = Number(lineItem.unit_price) || 0;
        if (unitPrice > 0 && inventoryItems.length > 0) {
          await CostLayerService.createLayer({
            inventory_item_id: inventoryItems[0].id,
            receipt_id: receiptId,
            receipt_type: 'GOODS_RECEIPT',
            quantity: quantity_received,
            unit_cost: unitPrice,
            created_by: userId,
          }, client);
        }

        // Serial/lot traceability: one traceable unit per serial received, or
        // one lot-quantity unit when a batch/lot number (but no serials) was
        // given. A receipt with neither is untracked — this is a no-op, not
        // an error.
        if (inventoryItems.length > 0) {
          await SerialLotService.recordReceipt({
            inventory_item_id: inventoryItems[0].id,
            goods_receipt_id: receiptId,
            quantity: quantity_received,
            batch_lot_number,
            serial_numbers,
            expiry_date,
            received_date,
            created_by: userId,
          }, client);
        }
      }

      // Update PO line item received quantity
      await PurchaseOrder.receiveItems(po_id, line_item_id, quantity_received);

      // GR/IR accrual: recognize the received (not-yet-invoiced) goods now —
      // Dr Inventory (1130) / Cr GR/IR clearing (2115) at the PO line's net unit
      // price. The supplier invoice later clears GR/IR into AP. Posting is
      // mandatory (a receipt with no GL entry misstates inventory + accruals).
      const receiptValue = Math.round(Number(lineItem.unit_price || 0) * Number(quantity_received) * 100) / 100;
      if (receiptValue > 0) {
        const JournalEntry = require('../models/JournalEntry');
        const accs = await client.query(`
          SELECT id, account_code FROM chart_of_accounts
          WHERE account_code IN ('1130','2115') AND status = 'ACTIVE' AND deleted_at IS NULL
        `);
        const map = {};
        accs.rows.forEach((a) => { map[a.account_code] = a.id; });
        if (!map['1130'] || !map['2115']) {
          throw new Error('Cannot post goods receipt: account 1130 (Inventory) and/or 2115 (GR/IR Clearing) missing or inactive');
        }
        const entry = await JournalEntry.create({
          entry_date: new Date().toISOString().split('T')[0],
          source_type: 'GOODS_RECEIPT',
          source_id: receiptId,
          description: `Goods receipt - ${lineItem.supplier_name} (${quantity_received} @ ${lineItem.unit_price})`,
          reference: lineItem.po_number || po_id,
          requires_approval: false,
        }, [
          { account_id: map['1130'], debit_amount: receiptValue, credit_amount: 0, description: 'Inventory received' },
          { account_id: map['2115'], debit_amount: 0, credit_amount: receiptValue, description: 'GR/IR clearing (received not invoiced)' },
        ], userId, client);
        // Who signs the GL posting. The runner stays recorded as creator of the
        // entry; the POSTED transition must carry a DIFFERENT identity, or
        // checkSoD refuses the self-posting and goods can never reach the ledger
        // (the same refusal that blocked depreciation, blocker #4). Shared
        // resolver in services/platformOwner.js returns the platform owner
        // unless the runner IS the owner (deliberate SoD exception).
        await JournalEntry.postAsSystem(entry.id, userId, 'Auto-posted goods receipt', client);
      }

      // Get updated PO for notifications
      const updatedPO = await PurchaseOrder.findById(po_id);
      
      // Create notification about goods receipt
      if (updatedPO) {
        await NotificationService.createPOItemsReceivedNotification(
          updatedPO, 
          lineItem, 
          quantity_received
        );
      }

      await client.query('COMMIT');

      return {
        receipt_id: receiptId,
        quantity_received: quantity_received,
        po_status: updatedPO?.status,
        message: 'Goods received successfully'
      };

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Auto-assign storage for received inventory items
   */
  static async autoAssignStorage(inventoryItemId, storageLocationId, binId, userId, client = null) {
    const db = client || pool;
    
    try {
      const assignmentId = uuidv4();
      const assignmentQuery = `
        INSERT INTO inventory_storage_mappings (
          id, inventory_item_id, storage_location_id, bin_id,
          user_id, status
        )
        VALUES ($1, $2, $3, $4, $5, 'APPROVED')
        RETURNING *
      `;
      
      const result = await db.query(assignmentQuery, [
        assignmentId, inventoryItemId, storageLocationId, binId, userId
      ]);

      return result.rows[0];
    } catch (error) {
      console.error('Error auto-assigning storage:', error);
      // Don't throw error - storage assignment failure shouldn't fail goods receipt
      return null;
    }
  }

  /**
   * Get goods receipts for a purchase order
   */
  static async getPOReceipts(poId) {
    const query = `
      SELECT gr.*,
             poli.item_description,
             poli.unit_price,
             i.name as item_name,
             i.approved_item_code,
             sl.name as storage_location_name,
             b.code as bin_code,
             u.first_name || ' ' || u.last_name as received_by_name
      FROM goods_receipts gr
      LEFT JOIN purchase_order_line_items poli ON gr.po_line_item_id = poli.id
      LEFT JOIN items i ON poli.item_id = i.id
      LEFT JOIN storage_locations sl ON gr.storage_location_id = sl.id
      LEFT JOIN bins b ON gr.bin_id = b.id
      LEFT JOIN users u ON gr.received_by = u.id
      WHERE gr.po_id = $1
      ORDER BY gr.received_date DESC
    `;

    try {
      const result = await pool.query(query, [poId]);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Get receipts summary for dashboard
   */
  static async getReceiptsSummary(filters = {}) {
    let query = `
      SELECT 
        COUNT(*) as total_receipts,
        SUM(gr.quantity_received) as total_quantity_received,
        COUNT(DISTINCT gr.po_id) as pos_with_receipts,
        DATE_TRUNC('month', gr.received_date) as receipt_month,
        SUM(gr.quantity_received * poli.unit_price) as total_value_received
      FROM goods_receipts gr
      JOIN purchase_order_line_items poli ON gr.po_line_item_id = poli.id
    `;

    const conditions = [];
    const values = [];
    let paramIndex = 1;

    if (filters.from_date) {
      conditions.push(`gr.received_date >= $${paramIndex}`);
      values.push(filters.from_date);
      paramIndex++;
    }

    if (filters.to_date) {
      conditions.push(`gr.received_date <= $${paramIndex}`);
      values.push(filters.to_date);
      paramIndex++;
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' GROUP BY DATE_TRUNC(\'month\', gr.received_date) ORDER BY receipt_month DESC';

    try {
      const result = await pool.query(query, values);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Create goods receipt table if it doesn't exist
   * This should be added to a migration file
   */
  static async createGoodsReceiptsTable() {
    const query = `
      CREATE TABLE IF NOT EXISTS goods_receipts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        po_id UUID REFERENCES purchase_orders(id) ON DELETE CASCADE,
        po_line_item_id UUID REFERENCES purchase_order_line_items(id) ON DELETE CASCADE,
        
        -- Receipt details
        quantity_received DECIMAL(12,4) NOT NULL,
        condition_grade VARCHAR(50) DEFAULT 'NEW',
        batch_lot_number VARCHAR(100),
        serial_numbers JSONB DEFAULT '[]',
        expiry_date DATE,
        received_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        
        -- Storage assignment
        storage_location_id UUID REFERENCES storage_locations(id),
        bin_id UUID REFERENCES bins(id),
        
        -- Additional info
        notes TEXT,
        received_by UUID REFERENCES users(id),
        
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Create indexes
      CREATE INDEX IF NOT EXISTS idx_goods_receipts_po_id ON goods_receipts(po_id);
      CREATE INDEX IF NOT EXISTS idx_goods_receipts_received_date ON goods_receipts(received_date);
      CREATE INDEX IF NOT EXISTS idx_goods_receipts_storage_location ON goods_receipts(storage_location_id);
      
      -- Comments
      COMMENT ON TABLE goods_receipts IS 'Records of goods received against purchase orders';
    `;

    try {
      await pool.query(query);
      console.log('✅ Goods receipts table created/verified');
    } catch (error) {
      console.error('❌ Error creating goods receipts table:', error);
      throw error;
    }
  }
}

module.exports = GoodsReceiptService;