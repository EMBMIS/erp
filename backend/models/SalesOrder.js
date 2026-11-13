const db = require('../config/database');

// Canonical sales-order status vocabulary — the SINGLE source of truth shared by
// the API route allowlist and the DB CHECK constraint (migration 048). Keeping
// these in one place is what prevents the three-way drift the audit found (B4),
// where the route allowed values the DB rejected and omitted COMPLETED (the value
// required to generate a customer invoice).
// NOTE: this list must stay identical to the DB CHECK constraint. It previously
// omitted GOODS_ISSUED, WAITING_CUSTOMER_DELIVERY_CONFIRMATION and
// DELIVERY_ISSUE_REPORTED — all three of which the DB accepts and other code
// paths actively write (delivery-schedules.js and PurchaseOrder.js set
// WAITING_CUSTOMER_DELIVERY_CONFIRMATION, WarehouseTransaction.js sets
// GOODS_ISSUED, the customer portal sets DELIVERY_ISSUE_REPORTED). Because
// updateStatus writes straight to the DB, those internal transitions worked,
// but PATCH /sales-orders/:id/status validates against THIS list and rejected
// the same values with a 400 — so staff could not move an order through states
// the system had put it in. `npm run db:verify` now asserts this list against
// the live CHECK constraint so the drift cannot silently return.
const SALES_ORDER_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'SENT_TO_CUSTOMER',
  'CONFIRMED',
  'CUSTOMER_ACCEPTED',
  'CUSTOMER_REJECTED',
  'IN_PRODUCTION',
  'GOODS_ISSUED',
  'READY_FOR_DELIVERY',
  'SHIPPED',
  'DELIVERED',
  'WAITING_CUSTOMER_DELIVERY_CONFIRMATION',
  'DELIVERY_ISSUE_REPORTED',
  'COMPLETED',
  'CANCELLED',
  'REJECTED',
];

const duplicateDetection = require('../services/ai/duplicateDetection');

/**
 * Fire-and-forget duplicate check after a create commits — see
 * models/PurchaseOrder.js's scheduleDuplicateCheck for the full reasoning.
 */
function scheduleDuplicateCheck(salesOrder) {
  if (!salesOrder) return;
  duplicateDetection.checkNewRecordForDuplicate('sales_order', salesOrder.id).catch((err) => {
    console.error(`SalesOrder: duplicate check failed for ${salesOrder.id}:`, err.message);
  });
}

class SalesOrder {
  static get STATUSES() {
    return SALES_ORDER_STATUSES;
  }

  static async findAll(filters = {}) {
    try {
      let query = `
        SELECT 
          so.*,
          c.customer_name,
          c.primary_email as customer_email,
          c.phone as customer_phone,
          u.first_name || ' ' || u.last_name as created_by_name,
          COUNT(soi.id) as item_count,
          SUM(soi.quantity) as total_quantity,
          SUM(soi.quantity_delivered) as total_delivered
        FROM sales_orders so
        LEFT JOIN customers c ON so.customer_id = c.id
        LEFT JOIN users u ON so.created_by = u.id
        LEFT JOIN sales_order_items soi ON so.id = soi.sales_order_id
        WHERE so.deleted_at IS NULL
      `;
      
      const conditions = [];
      const values = [];

      // CRITICAL: B2C user isolation - only show user's own sales orders
      // Exception: AI system can access aggregate data for business analysis
      if (filters.userId && filters.userId !== 'ai-system') {
        conditions.push(`so.created_by = $${values.length + 1}`);
        values.push(filters.userId);
      }

      if (filters.search) {
        conditions.push(`(
          so.so_number ILIKE $${values.length + 1} OR
          so.customer_name ILIKE $${values.length + 1} OR
          so.reference_number ILIKE $${values.length + 1}
        )`);
        values.push(`%${filters.search}%`);
      }

      if (filters.status) {
        conditions.push(`so.status = $${values.length + 1}`);
        values.push(filters.status);
      }

      if (filters.customer_id) {
        conditions.push(`so.customer_id = $${values.length + 1}`);
        values.push(filters.customer_id);
      }

      if (filters.priority) {
        conditions.push(`so.priority = $${values.length + 1}`);
        values.push(filters.priority);
      }

      if (filters.date_from) {
        conditions.push(`so.order_date >= $${values.length + 1}`);
        values.push(filters.date_from);
      }

      if (filters.date_to) {
        conditions.push(`so.order_date <= $${values.length + 1}`);
        values.push(filters.date_to);
      }

      if (conditions.length > 0) {
        query += ' AND ' + conditions.join(' AND ');
      }

      query += `
        GROUP BY so.id, c.customer_name, c.primary_email, c.phone, u.first_name, u.last_name
        ORDER BY so.created_at DESC
      `;

      if (filters.limit) {
        query += ` LIMIT $${values.length + 1}`;
        values.push(filters.limit);
      }

      if (filters.offset) {
        query += ` OFFSET $${values.length + 1}`;
        values.push(filters.offset);
      }

      const result = await db.query(query, values);
      return result.rows;
    } catch (error) {
      console.error('Error in SalesOrder.findAll:', error);
      throw error;
    }
  }

  static async findById(id, userId = null) {
    try {
      let query = `
        SELECT 
          so.*,
          c.customer_name,
          c.primary_email as customer_email,
          c.phone as customer_phone,
          c.billing_address_line1,
          c.billing_address_line2,
          c.billing_city,
          c.billing_state,
          c.billing_country,
          c.billing_postal_code,
          c.shipping_address_line1,
          c.shipping_address_line2,
          c.shipping_city,
          c.shipping_state,
          c.shipping_country,
          c.shipping_postal_code,
          c.use_billing_as_shipping,
          u.first_name || ' ' || u.last_name as created_by_name,
          approver.first_name || ' ' || approver.last_name as approved_by_name
        FROM sales_orders so
        LEFT JOIN customers c ON so.customer_id = c.id
        LEFT JOIN users u ON so.created_by = u.id
        LEFT JOIN users approver ON so.approved_by = approver.id
        WHERE so.id = $1 AND so.deleted_at IS NULL
      `;
      
      const values = [id];
      
      // CRITICAL: B2C user isolation - only allow access to user's own sales orders
      if (userId) {
        query += ` AND so.created_by = $2`;
        values.push(userId);
      }
      
      const result = await db.query(query, values);
      
      if (result.rows.length === 0) {
        return null;
      }

      const salesOrder = result.rows[0];

      // Get order items
      const itemsQuery = `
        SELECT 
          soi.*,
          COALESCE(i.name, soi.item_name) as inventory_item_name,
          COALESCE(i.item_code, soi.item_code) as inventory_item_code
        FROM sales_order_items soi
        LEFT JOIN inventory_items ii ON soi.inventory_item_id = ii.id
        LEFT JOIN items i ON ii.item_master_id = i.id
        WHERE soi.sales_order_id = $1
        ORDER BY soi.line_number
      `;
      
      const itemsResult = await db.query(itemsQuery, [id]);
      salesOrder.items = itemsResult.rows;

      return salesOrder;
    } catch (error) {
      console.error('Error in SalesOrder.findById:', error);
      throw error;
    }
  }

  static async getItems(salesOrderId) {
    try {
      const query = `
        SELECT 
          soi.*,
          COALESCE(i.name, soi.item_name) as inventory_item_name,
          COALESCE(i.item_code, soi.item_code) as inventory_item_code
        FROM sales_order_items soi
        LEFT JOIN inventory_items ii ON soi.inventory_item_id = ii.id
        LEFT JOIN items i ON ii.item_master_id = i.id
        WHERE soi.sales_order_id = $1
        ORDER BY soi.line_number
      `;
      
      const result = await db.query(query, [salesOrderId]);
      return result.rows;
    } catch (error) {
      console.error('Error in SalesOrder.getItems:', error);
      throw error;
    }
  }

  static async create(salesOrderData, userId) {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Generate SO number
      const soNumber = await this.generateSONumber(client);

      // Helper function to clean empty date fields
      const cleanDateField = (value) => {
        if (value === '' || value === null || value === undefined) return null;
        return value;
      };

      // The browser form sends '' for line items the user typed by hand
      // without picking from the inventory dropdown. Postgres refuses '' as
      // a uuid and the whole SO creation 500s. Normalize to NULL — the
      // schema allows free-text lines without an inventory reference.
      const cleanUuid = (value) => {
        if (value === null || value === undefined) return null;
        return String(value).trim() === '' ? null : value;
      };

      // Credit limit advisory check: warn at creation if the order would exceed
      // the customer's credit limit. The hard gate is at approval (approveOrder);
      // this is a soft early warning so the sales team sees it before working on
      // the order further.
      let creditHold = false;
      if (salesOrderData.customer_id && Number(salesOrderData.total_amount) > 0) {
        const custCheck = await client.query(
          'SELECT customer_name, credit_limit, current_balance FROM customers WHERE id = $1',
          [salesOrderData.customer_id]
        );
        if (custCheck.rows.length > 0) {
          const cust = custCheck.rows[0];
          const limit = Number(cust.credit_limit) || 0;
          if (limit > 0) {
            const exposure = (Number(cust.current_balance) || 0) + Number(salesOrderData.total_amount || 0);
            if (exposure > limit) {
              creditHold = true;
              salesOrderData.internal_notes = (salesOrderData.internal_notes || '')
                + ` [CREDIT WARNING: Order exceeds credit limit of ${limit.toFixed(2)}; exposure would be ${exposure.toFixed(2)}]`;
            }
          }
        }
      }

      // Stock availability advisory check: warn at creation if a line already
      // exceeds what's available (on hand minus other open orders' reservations).
      // Soft only — a draft shouldn't lock stock, and shouldn't block drafting
      // either; the hard gate that actually reserves stock is at approval
      // (approveOrder). Read-only here, so no row lock.
      if (salesOrderData.items && salesOrderData.items.length > 0) {
        const ATPService = require('../services/atpService');
        for (const item of salesOrderData.items) {
          if (!item.inventory_item_id) continue;
          const { rows } = await client.query(
            `SELECT current_stock_quantity FROM inventory_items WHERE id = $1`,
            [item.inventory_item_id]
          );
          if (!rows.length) continue;
          const { rows: reservedRows } = await client.query(
            `SELECT COALESCE(SUM(soi.quantity_reserved), 0)::float AS reserved
               FROM sales_order_items soi
               JOIN sales_orders so ON so.id = soi.sales_order_id
              WHERE soi.inventory_item_id = $1
                AND so.status NOT IN ('CANCELLED', 'REJECTED', 'CUSTOMER_REJECTED')
                AND so.deleted_at IS NULL`,
            [item.inventory_item_id]
          );
          const available = Number(rows[0].current_stock_quantity || 0) - Number(reservedRows[0].reserved || 0);
          if (available < Number(item.quantity)) {
            salesOrderData.internal_notes = (salesOrderData.internal_notes || '')
              + ` [STOCK WARNING: "${item.item_name || item.inventory_item_id}" needs ${item.quantity}, only ${available} available]`;
          }
        }
      }

      // Insert sales order
      const soQuery = `
        INSERT INTO sales_orders (
          so_number, customer_id, customer_name, order_date, delivery_date,
          reference_number, currency, subtotal, tax_amount, discount_amount,
          total_amount, status, priority, delivery_address, delivery_instructions,
          shipping_method, notes, internal_notes, payment_terms, delivery_terms,
          created_by, updated_by
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20, $21, $21
        ) RETURNING *
      `;

      const soValues = [
        soNumber,
        salesOrderData.customer_id,
        salesOrderData.customer_name,
        cleanDateField(salesOrderData.order_date) || new Date(),
        cleanDateField(salesOrderData.delivery_date),
        salesOrderData.reference_number,
        salesOrderData.currency || 'USD',
        salesOrderData.subtotal || 0,
        salesOrderData.tax_amount || 0,
        salesOrderData.discount_amount || 0,
        salesOrderData.total_amount || 0,
        'DRAFT',
        salesOrderData.priority || 'NORMAL',
        salesOrderData.delivery_address,
        salesOrderData.delivery_instructions,
        salesOrderData.shipping_method,
        salesOrderData.notes,
        salesOrderData.internal_notes,
        salesOrderData.payment_terms,
        salesOrderData.delivery_terms,
        userId
      ];

      const soResult = await client.query(soQuery, soValues);
      const salesOrder = soResult.rows[0];

      // Insert order items
      if (salesOrderData.items && salesOrderData.items.length > 0) {
        for (let i = 0; i < salesOrderData.items.length; i++) {
          const item = salesOrderData.items[i];
          
          const itemQuery = `
            INSERT INTO sales_order_items (
              sales_order_id, line_number, inventory_item_id, item_code,
              item_name, item_description, quantity, unit_of_measure,
              unit_price, discount_percentage, discount_amount, line_total,
              requested_delivery_date, notes
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
            )
          `;

          const itemValues = [
            salesOrder.id,
            i + 1,
            cleanUuid(item.inventory_item_id),
            item.item_code,
            item.item_name,
            item.item_description,
            item.quantity,
            item.unit_of_measure,
            item.unit_price,
            item.discount_percentage || 0,
            item.discount_amount || 0,
            item.line_total,
            cleanDateField(item.requested_delivery_date),
            item.notes
          ];

          await client.query(itemQuery, itemValues);
        }
      }

      // Add status history
      await this.addStatusHistory(client, salesOrder.id, null, 'DRAFT', userId, 'Sales order created');

      await client.query('COMMIT');

      // Return full sales order with items
      scheduleDuplicateCheck(salesOrder);
      return await this.findById(salesOrder.id);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesOrder.create:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async update(id, salesOrderData, userId) {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Check if sales order exists
      const existingResult = await client.query(
        'SELECT * FROM sales_orders WHERE id = $1 AND deleted_at IS NULL',
        [id]
      );

      if (existingResult.rows.length === 0) {
        throw new Error('Sales order not found');
      }

      const existing = existingResult.rows[0];

      // Helper function to clean empty date fields
      const cleanDateField = (value) => {
        if (value === '' || value === null || value === undefined) return null;
        return value;
      };

      // Same '' -> NULL normalization as create() (see cleanUuid there).
      const cleanUuid = (value) => {
        if (value === null || value === undefined) return null;
        return String(value).trim() === '' ? null : value;
      };

      // Update sales order
      const updateQuery = `
        UPDATE sales_orders SET
          customer_id = COALESCE($2, customer_id),
          customer_name = COALESCE($3, customer_name),
          order_date = COALESCE($4, order_date),
          delivery_date = COALESCE($5, delivery_date),
          reference_number = COALESCE($6, reference_number),
          currency = COALESCE($7, currency),
          subtotal = COALESCE($8, subtotal),
          tax_amount = COALESCE($9, tax_amount),
          discount_amount = COALESCE($10, discount_amount),
          total_amount = COALESCE($11, total_amount),
          priority = COALESCE($12, priority),
          delivery_address = COALESCE($13, delivery_address),
          delivery_instructions = COALESCE($14, delivery_instructions),
          shipping_method = COALESCE($15, shipping_method),
          notes = COALESCE($16, notes),
          internal_notes = COALESCE($17, internal_notes),
          payment_terms = COALESCE($18, payment_terms),
          delivery_terms = COALESCE($19, delivery_terms),
          updated_by = $20
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *
      `;

      const updateValues = [
        id,
        salesOrderData.customer_id,
        salesOrderData.customer_name,
        cleanDateField(salesOrderData.order_date),
        cleanDateField(salesOrderData.delivery_date),
        salesOrderData.reference_number,
        salesOrderData.currency,
        salesOrderData.subtotal,
        salesOrderData.tax_amount,
        salesOrderData.discount_amount,
        salesOrderData.total_amount,
        salesOrderData.priority,
        salesOrderData.delivery_address,
        salesOrderData.delivery_instructions,
        salesOrderData.shipping_method,
        salesOrderData.notes,
        salesOrderData.internal_notes,
        salesOrderData.payment_terms,
        salesOrderData.delivery_terms,
        userId
      ];

      await client.query(updateQuery, updateValues);

      // Update items if provided
      if (salesOrderData.items) {
        // Delete existing items
        await client.query('DELETE FROM sales_order_items WHERE sales_order_id = $1', [id]);

        // Insert new items
        for (let i = 0; i < salesOrderData.items.length; i++) {
          const item = salesOrderData.items[i];
          
          const itemQuery = `
            INSERT INTO sales_order_items (
              sales_order_id, line_number, inventory_item_id, item_code,
              item_name, item_description, quantity, unit_of_measure,
              unit_price, discount_percentage, discount_amount, line_total,
              requested_delivery_date, notes
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
            )
          `;

          const itemValues = [
            id,
            i + 1,
            cleanUuid(item.inventory_item_id),
            item.item_code,
            item.item_name,
            item.item_description,
            item.quantity,
            item.unit_of_measure,
            item.unit_price,
            item.discount_percentage || 0,
            item.discount_amount || 0,
            item.line_total,
            cleanDateField(item.requested_delivery_date),
            item.notes
          ];

          await client.query(itemQuery, itemValues);
        }
      }

      await client.query('COMMIT');
      
      return await this.findById(id);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesOrder.update:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async updateStatus(id, newStatus, userId, reason = '') {
    const { applyStatusChange } = require('../services/statusTransitionService');

    return await applyStatusChange({
      entityType: 'SALES_ORDER',
      entityId: id,
      newStatus,
      actor: userId,
      context: { reason },
      executeSideEffects: async (client, record) => {
        const actorId = typeof userId === 'object' && userId !== null ? userId.id : userId;
        if (newStatus === 'COMPLETED') {
          const CustomerInvoice = require('./CustomerInvoice');
          const invoice = await CustomerInvoice.createFromSalesOrder(id, actorId, client);
          console.log(`✅ Customer invoice ${invoice.invoice_number} created for sales order ${id}`);
        }
      }
    });
  }

  static async delete(id, userId) {
    try {
      const result = await db.query(
        `UPDATE sales_orders 
         SET deleted_at = CURRENT_TIMESTAMP, updated_by = $2 
         WHERE id = $1 AND deleted_at IS NULL 
         RETURNING *`,
        [id, userId]
      );

      if (result.rows.length === 0) {
        throw new Error('Sales order not found or already deleted');
      }

      return result.rows[0];
    } catch (error) {
      console.error('Error in SalesOrder.delete:', error);
      throw error;
    }
  }

  static async getStats(userId) {
    try {
      // findAll() scopes the list to the caller's own orders (B2C isolation,
      // see the userId filter above) — this must apply the same scope or the
      // "Total Orders" tile counts every user's orders while the list below
      // it shows only the caller's, e.g. "Total Orders: 2" over a 1-row list.
      const values = [];
      let userFilter = '';
      if (userId && userId !== 'ai-system') {
        values.push(userId);
        userFilter = `AND created_by = $${values.length}`;
      }

      const query = `
        SELECT
          COUNT(*) as total_orders,
          COUNT(CASE WHEN status = 'DRAFT' THEN 1 END) as draft_orders,
          COUNT(CASE WHEN status = 'CONFIRMED' THEN 1 END) as confirmed_orders,
          COUNT(CASE WHEN status = 'DELIVERED' THEN 1 END) as delivered_orders,
          COUNT(CASE WHEN priority = 'URGENT' THEN 1 END) as urgent_orders,
          SUM(total_amount) as total_value,
          AVG(total_amount) as average_order_value
        FROM sales_orders
        WHERE deleted_at IS NULL ${userFilter}
      `;

      const result = await db.query(query, values);
      return result.rows[0];
    } catch (error) {
      console.error('Error in SalesOrder.getStats:', error);
      throw error;
    }
  }

  static async generateSONumber(client = db) {
    try {
      const year = new Date().getFullYear();
      const prefix = `SO${year}`;
      
      const result = await client.query(
        `SELECT so_number FROM sales_orders 
         WHERE so_number LIKE $1 
         ORDER BY so_number DESC LIMIT 1`,
        [`${prefix}%`]
      );

      let nextNumber = 1;
      if (result.rows.length > 0) {
        const lastNumber = result.rows[0].so_number.replace(prefix, '');
        nextNumber = parseInt(lastNumber) + 1;
      }

      return `${prefix}${nextNumber.toString().padStart(6, '0')}`;
    } catch (error) {
      console.error('Error generating SO number:', error);
      throw error;
    }
  }

  static async addStatusHistory(client, salesOrderId, fromStatus, toStatus, userId, reason) {
    const query = `
      INSERT INTO sales_order_status_history 
      (sales_order_id, from_status, to_status, changed_by, reason)
      VALUES ($1, $2, $3, $4, $5)
    `;
    
    await client.query(query, [salesOrderId, fromStatus, toStatus, userId, reason]);
  }

  static async getStatusHistory(salesOrderId) {
    try {
      const query = `
        SELECT 
          ssh.*,
          u.first_name || ' ' || u.last_name as changed_by_name
        FROM sales_order_status_history ssh
        LEFT JOIN users u ON ssh.changed_by = u.id
        WHERE ssh.sales_order_id = $1
        ORDER BY ssh.status_date ASC
      `;
      
      const result = await db.query(query, [salesOrderId]);
      return result.rows;
    } catch (error) {
      console.error('Error in SalesOrder.getStatusHistory:', error);
      throw error;
    }
  }

  static async getPendingApprovals(userId) {
    try {
      const DelegationOfAuthority = require('./DelegationOfAuthority');
      
      // Get user's authority levels
      const authorities = await DelegationOfAuthority.getUserAuthority(userId, null, 'SALES_ORDER');
      
      if (!authorities.length) {
        return [];
      }
      
      // Find orders that need approval within user's authority
      const maxAuthority = Math.max(...authorities.map(a => a.max_amount || Number.MAX_SAFE_INTEGER));
      const minAuthority = Math.min(...authorities.map(a => a.min_amount || 0));
      
      const query = `
        SELECT 
          so.*,
          c.customer_name,
          u.first_name || ' ' || u.last_name as created_by_name,
          COUNT(soi.id) as item_count
        FROM sales_orders so
        LEFT JOIN customers c ON so.customer_id = c.id
        LEFT JOIN users u ON so.created_by = u.id
        LEFT JOIN sales_order_items soi ON so.id = soi.sales_order_id
        WHERE so.status = 'PENDING_APPROVAL'
          AND so.total_amount >= $1
          AND so.total_amount <= $2
          AND so.created_by != $3
          AND so.deleted_at IS NULL
        GROUP BY so.id, c.customer_name, u.first_name, u.last_name
        ORDER BY so.created_at ASC
      `;
      
      const result = await db.query(query, [minAuthority, maxAuthority, userId]);
      return result.rows;
    } catch (error) {
      console.error('Error in SalesOrder.getPendingApprovals:', error);
      throw error;
    }
  }

  static async rejectOrder(orderId, userId, rejectionReason = '') {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      
      // Get current order
      const orderResult = await client.query(
        'SELECT * FROM sales_orders WHERE id = $1 AND deleted_at IS NULL',
        [orderId]
      );
      
      if (orderResult.rows.length === 0) {
        throw new Error('Sales order not found');
      }
      
      const order = orderResult.rows[0];
      
      if (order.status !== 'PENDING_APPROVAL') {
        throw new Error('Sales order is not pending approval');
      }
      
      // Update order status
      const updateQuery = `
        UPDATE sales_orders 
        SET 
          status = 'CANCELLED',
          rejected_by = $1,
          rejected_at = NOW(),
          rejection_reason = $2,
          updated_at = NOW()
        WHERE id = $3
        RETURNING *
      `;
      
      const updateResult = await client.query(updateQuery, [userId, rejectionReason, orderId]);
      
      // Add status history
      await this.addStatusHistory(client, orderId, 'PENDING_APPROVAL', 'CANCELLED', userId, rejectionReason);
      
      await client.query('COMMIT');
      return updateResult.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesOrder.rejectOrder:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  // DOA Approval Methods
  static async requestApproval(orderId, userId, notes = '') {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      
      // Get current order
      const orderResult = await client.query(
        'SELECT * FROM sales_orders WHERE id = $1 AND deleted_at IS NULL',
        [orderId]
      );
      
      if (orderResult.rows.length === 0) {
        throw new Error('Sales order not found');
      }
      
      const order = orderResult.rows[0];
      
      if (order.status !== 'DRAFT') {
        throw new Error('Only draft orders can be submitted for approval');
      }
      
      // Update order status and approval fields
      const updateQuery = `
        UPDATE sales_orders 
        SET 
          status = 'PENDING_APPROVAL',
          approval_status = 'PENDING_APPROVAL',
          approval_requested_by = $1,
          approval_requested_at = CURRENT_TIMESTAMP,
          approval_required_amount = total_amount,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING *
      `;
      
      const updateResult = await client.query(updateQuery, [userId, orderId]);
      
      // Add status history
      await this.addStatusHistory(client, orderId, 'DRAFT', 'PENDING_APPROVAL', userId, notes);
      
      // Create notification for approvers
      const DelegationOfAuthority = require('./DelegationOfAuthority');
      const approvers = await DelegationOfAuthority.getSalesAuthorizedUsers(
        order.total_amount || 0, 
        null,
        'SALES_ORDER'
      );
      
      const Notification = require('./Notification');
      for (const approver of approvers) {
        await Notification.create({
          user_id: approver.user_id,
          type: 'SALES_ORDER_PENDING_APPROVAL',
          title: `Sales Order Approval Required: ${order.so_number}`,
          message: `Sales Order ${order.so_number} (${order.customer_name}) requires your approval - Amount: $${order.total_amount}`,
          related_type: 'SALES_ORDER',
          related_id: orderId
        });
      }
      
      await client.query('COMMIT');
      return updateResult.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesOrder.requestApproval:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async approveOrder(orderId, userId, approvalNotes = '') {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      
      // Get current order
      const orderResult = await client.query(
        'SELECT * FROM sales_orders WHERE id = $1 AND deleted_at IS NULL',
        [orderId]
      );
      
      if (orderResult.rows.length === 0) {
        throw new Error('Sales order not found');
      }
      
      const order = orderResult.rows[0];

      if (order.status !== 'PENDING_APPROVAL') {
        throw new Error('Sales order is not pending approval');
      }

      // Customer credit check: block approval when the order would push the
      // customer past their credit limit. A limit of 0/NULL means "no limit".
      // (ERP-Roadmap P1 #5 — customer credit management.)
      const custResult = await client.query(
        'SELECT customer_name, credit_limit, current_balance, credit_hold, credit_hold_reason FROM customers WHERE id = $1',
        [order.customer_id]
      );
      const cust = custResult.rows[0];
      if (cust) {
        // Credit hold is a stronger, independent signal from dunning
        // (services/dunningService.js: a customer with an invoice at
        // FINAL_NOTICE, 46+ days overdue) — it blocks regardless of whether
        // this particular order would still fit under the numeric limit.
        if (cust.credit_hold) {
          throw new Error(
            `${cust.customer_name} is on credit hold and cannot have new orders approved: ${cust.credit_hold_reason || 'credit hold'}`
          );
        }

        const creditLimit = Number(cust.credit_limit) || 0;
        if (creditLimit > 0) {
          const exposure = (Number(cust.current_balance) || 0) + (Number(order.total_amount) || 0);
          if (exposure > creditLimit) {
            throw new Error(
              `Credit limit exceeded for ${cust.customer_name}: ` +
              `outstanding ${Number(cust.current_balance || 0).toFixed(2)} + order ${Number(order.total_amount || 0).toFixed(2)} ` +
              `= ${exposure.toFixed(2)} > limit ${creditLimit.toFixed(2)}`
            );
          }
        }
      }

      // Verify user has authority to approve this amount
      const DelegationOfAuthority = require('./DelegationOfAuthority');
      const hasAuthority = await DelegationOfAuthority.canApproveSalesTransaction(
        userId,
        order.total_amount || 0,
        'SALES_ORDER'
      );

      if (!hasAuthority) {
        throw new Error('You do not have authority to approve this sales order amount');
      }

      // Discount rules (services/marginFollowUps.js): a product an ACTIVE rule
      // covers, discounted past the rule's ceiling, is approved by the rule's
      // approver or an admin — not by whoever else holds the amount authority.
      const { discountBreaches } = require('../services/marginFollowUps');
      const breaches = await discountBreaches(client, orderId);
      if (breaches.length) {
        const { rows: who } = await client.query('SELECT role FROM users WHERE id = $1', [userId]);
        const blocking = who[0]?.role === 'ADMIN' ? [] : breaches.filter((b) => b.approver_user_id && b.approver_user_id !== userId);
        if (blocking.length) {
          const b = blocking[0];
          throw new Error(
            `${b.item} is discounted ${b.discount_pct}% on line ${b.line_number}; discounts above ${b.max_pct}% `
            + `are approved by ${b.approver || 'the rule\'s approver'} (sales discount rule).`
          );
        }
        approvalNotes = [approvalNotes, `Discount rule: ${breaches.map((b) => `${b.item} at ${b.discount_pct}% (ceiling ${b.max_pct}%)`).join('; ')} approved by its approver.`]
          .filter(Boolean).join(' ');
      }

      // Stock reservation: approving an order is the point it becomes a real
      // commitment, so this is where availability is actually checked and
      // reserved — not at creation (a draft shouldn't lock stock other orders
      // could use) and not silently never (the gap this closes: previously
      // nothing in the order pipeline checked or reserved inventory at all, so
      // an order could be approved and confirmed against stock that didn't
      // exist). Line items with no inventory_item_id (services, non-stock
      // lines) are skipped. FOR UPDATE inside getAvailableToPromise holds the
      // row lock for the rest of this transaction, so two orders approving the
      // same item concurrently cannot both pass the check.
      const ATPService = require('../services/atpService');
      const { rows: stockItems } = await client.query(
        `SELECT id, inventory_item_id, item_name, quantity
           FROM sales_order_items
          WHERE sales_order_id = $1 AND inventory_item_id IS NOT NULL`,
        [orderId]
      );
      for (const line of stockItems) {
        const available = await ATPService.getAvailableToPromise(client, line.inventory_item_id, orderId);
        if (available < Number(line.quantity)) {
          throw new Error(
            `Insufficient stock to approve this order: "${line.item_name}" needs ${Number(line.quantity)}, ` +
            `only ${available} available (on hand minus what's already reserved by other open orders).`
          );
        }
      }
      for (const line of stockItems) {
        await client.query(
          `UPDATE sales_order_items SET quantity_reserved = quantity WHERE id = $1`,
          [line.id]
        );
      }

      // Generate customer response token (expiring, single-use — see portalTokens.js)
      const { generateToken, expiryDate } = require('../services/portalTokens');
      const customerResponseToken = generateToken();
      const customerResponseTokenExpiresAt = expiryDate();

      // Update order status to SENT_TO_CUSTOMER after approval
      const updateQuery = `
        UPDATE sales_orders
        SET
          status = 'SENT_TO_CUSTOMER',
          approval_status = 'APPROVED',
          approved_by = $1,
          approved_at = CURRENT_TIMESTAMP,
          approval_notes = $2,
          customer_response_token = $3,
          customer_response_token_expires_at = $5,
          customer_response_token_used_at = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $4
        RETURNING *
      `;

      const updateResult = await client.query(updateQuery, [userId, approvalNotes, customerResponseToken, orderId, customerResponseTokenExpiresAt]);
      
      // Add status history
      await this.addStatusHistory(client, orderId, 'PENDING_APPROVAL', 'SENT_TO_CUSTOMER', userId, approvalNotes);
      
      // Notify order creator
      const Notification = require('./Notification');
      await Notification.create({
        user_id: order.created_by,
        type: 'SALES_ORDER_APPROVED',
        title: `Sales Order Approved: ${order.so_number}`,
        message: `Your sales order ${order.so_number} has been approved${approvalNotes ? ': ' + approvalNotes : ''}`,
        related_type: 'SALES_ORDER',
        related_id: orderId
      });

      await client.query('COMMIT');
      
      // Get full order details with customer email for email sending
      const fullOrder = await this.findById(orderId);
      
      // Send email to customer
      await this.sendCustomerConfirmationEmail(fullOrder, customerResponseToken);
      
      return fullOrder;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesOrder.approveOrder:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async rejectOrder(orderId, userId, rejectionReason = '') {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      
      // Get current order
      const orderResult = await client.query(
        'SELECT * FROM sales_orders WHERE id = $1 AND deleted_at IS NULL',
        [orderId]
      );
      
      if (orderResult.rows.length === 0) {
        throw new Error('Sales order not found');
      }
      
      const order = orderResult.rows[0];
      
      if (order.status !== 'PENDING_APPROVAL') {
        throw new Error('Sales order is not pending approval');
      }
      
      if (!rejectionReason || !rejectionReason.trim()) {
        throw new Error('Rejection reason is required');
      }
      
      // Update order status
      const updateQuery = `
        UPDATE sales_orders 
        SET 
          status = 'REJECTED',
          approval_status = 'REJECTED',
          rejected_by = $1,
          rejected_at = CURRENT_TIMESTAMP,
          rejection_reason = $2,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $3
        RETURNING *
      `;
      
      const updateResult = await client.query(updateQuery, [userId, rejectionReason, orderId]);
      
      // Add status history
      await this.addStatusHistory(client, orderId, 'PENDING_APPROVAL', 'REJECTED', userId, rejectionReason);
      
      // Notify order creator
      const Notification = require('./Notification');
      await Notification.create({
        user_id: order.created_by,
        type: 'SALES_ORDER_REJECTED',
        title: `Sales Order Rejected: ${order.so_number}`,
        message: `Your sales order ${order.so_number} has been rejected: ${rejectionReason}`,
        related_type: 'SALES_ORDER',
        related_id: orderId
      });
      
      await client.query('COMMIT');
      return updateResult.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesOrder.rejectOrder:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async sendCustomerConfirmationEmail(order, responseToken) {
    try {
      console.log(`📧 Preparing to send order confirmation email for ${order.so_number}...`);
      console.log(`📧 Customer email: ${order.customer_email || 'NOT FOUND'}`);
      console.log(`📧 Response token: ${responseToken}`);
      
      if (!order.customer_email) {
        throw new Error(`No customer email found for order ${order.so_number}. Customer ID: ${order.customer_id}`);
      }
      
      const customerEmailService = require('../services/customerEmailService');
      const result = await customerEmailService.sendOrderConfirmationEmail(
        order.customer_email,
        order,
        responseToken
      );
      
      console.log(`✅ Order confirmation email sent successfully for ${order.so_number} to ${order.customer_email}`);
      console.log(`📧 Email result:`, result);
    } catch (error) {
      console.error(`❌ Failed to send customer confirmation email for ${order.so_number}:`, error.message);
      console.error('📧 Full error:', error);
      // Don't throw error - email failure shouldn't block approval
    }
  }

  static async getPendingApprovals(userId) {
    try {
      const DelegationOfAuthority = require('./DelegationOfAuthority');
      
      // Get user's authority levels
      const authorities = await DelegationOfAuthority.getUserAuthority(userId, null, 'SALES_ORDER');
      
      if (!authorities.length) {
        return [];
      }
      
      // Find orders that need approval within user's authority
      const maxAuthority = Math.max(...authorities.map(a => a.max_amount || Number.MAX_SAFE_INTEGER));
      const minAuthority = Math.min(...authorities.map(a => a.min_amount || 0));
      
      const query = `
        SELECT 
          so.*,
          c.customer_name,
          u.first_name || ' ' || u.last_name as created_by_name,
          COUNT(soi.id) as item_count
        FROM sales_orders so
        LEFT JOIN customers c ON so.customer_id = c.id
        LEFT JOIN users u ON so.created_by = u.id
        LEFT JOIN sales_order_items soi ON so.id = soi.sales_order_id
        WHERE so.status = 'PENDING_APPROVAL'
          AND so.approval_status = 'PENDING_APPROVAL'
          AND so.total_amount >= $1
          AND so.total_amount <= $2
          AND so.deleted_at IS NULL
        GROUP BY so.id, c.customer_name, u.first_name, u.last_name
        ORDER BY so.created_at ASC
      `;
      
      const result = await db.query(query, [minAuthority, maxAuthority]);
      return result.rows;
    } catch (error) {
      console.error('Error in SalesOrder.getPendingApprovals:', error);
      throw error;
    }
  }
}

module.exports = SalesOrder;