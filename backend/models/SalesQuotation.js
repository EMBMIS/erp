const db = require('../config/database');

class SalesQuotation {
  static async findAll(filters = {}) {
    try {
      let query = `
        SELECT 
          sq.*,
          c.customer_name,
          c.primary_email as customer_email,
          c.phone as customer_phone,
          u.first_name || ' ' || u.last_name as created_by_name,
          COUNT(sqi.id) as item_count,
          SUM(sqi.quantity) as total_quantity,
          CASE 
            WHEN sq.valid_until < CURRENT_DATE AND sq.status NOT IN ('ACCEPTED', 'REJECTED', 'CANCELLED') 
            THEN TRUE 
            ELSE FALSE 
          END as is_expired
        FROM sales_quotations sq
        LEFT JOIN customers c ON sq.customer_id = c.id
        LEFT JOIN users u ON sq.created_by = u.id
        LEFT JOIN sales_quotation_items sqi ON sq.id = sqi.sales_quotation_id
        WHERE sq.deleted_at IS NULL
      `;
      
      const conditions = [];
      const values = [];

      if (filters.search) {
        conditions.push(`(
          sq.quotation_number ILIKE $${values.length + 1} OR
          sq.customer_name ILIKE $${values.length + 1} OR
          sq.reference_number ILIKE $${values.length + 1}
        )`);
        values.push(`%${filters.search}%`);
      }

      if (filters.status) {
        conditions.push(`sq.status = $${values.length + 1}`);
        values.push(filters.status);
      }

      if (filters.customer_id) {
        conditions.push(`sq.customer_id = $${values.length + 1}`);
        values.push(filters.customer_id);
      }

      if (filters.priority) {
        conditions.push(`sq.priority = $${values.length + 1}`);
        values.push(filters.priority);
      }

      if (filters.date_from) {
        conditions.push(`sq.quotation_date >= $${values.length + 1}`);
        values.push(filters.date_from);
      }

      if (filters.date_to) {
        conditions.push(`sq.quotation_date <= $${values.length + 1}`);
        values.push(filters.date_to);
      }

      if (filters.expired === 'true') {
        conditions.push(`sq.valid_until < CURRENT_DATE AND sq.status NOT IN ('ACCEPTED', 'REJECTED', 'CANCELLED')`);
      } else if (filters.expired === 'false') {
        conditions.push(`(sq.valid_until >= CURRENT_DATE OR sq.status IN ('ACCEPTED', 'REJECTED', 'CANCELLED'))`);
      }

      if (conditions.length > 0) {
        query += ' AND ' + conditions.join(' AND ');
      }

      query += `
        GROUP BY sq.id, c.customer_name, c.primary_email, c.phone, u.first_name, u.last_name
        ORDER BY sq.created_at DESC
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
      console.error('Error in SalesQuotation.findAll:', error);
      throw error;
    }
  }

  static async findById(id) {
    try {
      const query = `
        SELECT 
          sq.*,
          c.customer_name,
          c.primary_email as customer_email,
          c.phone as customer_phone,
          c.billing_address_line1,
          c.billing_city,
          c.billing_country,
          u.first_name || ' ' || u.last_name as created_by_name,
          converter.first_name || ' ' || converter.last_name as converted_by_name,
          CASE 
            WHEN sq.valid_until < CURRENT_DATE AND sq.status NOT IN ('ACCEPTED', 'REJECTED', 'CANCELLED') 
            THEN TRUE 
            ELSE FALSE 
          END as is_expired
        FROM sales_quotations sq
        LEFT JOIN customers c ON sq.customer_id = c.id
        LEFT JOIN users u ON sq.created_by = u.id
        LEFT JOIN users converter ON sq.converted_by = converter.id
        WHERE sq.id = $1 AND sq.deleted_at IS NULL
      `;
      
      const result = await db.query(query, [id]);
      
      if (result.rows.length === 0) {
        return null;
      }

      const quotation = result.rows[0];

      // Get quotation items
      const itemsQuery = `
        SELECT 
          sqi.*,
          COALESCE(i.name, sqi.item_name) as inventory_item_name,
          COALESCE(i.approved_item_code, sqi.item_code) as inventory_item_code
        FROM sales_quotation_items sqi
        LEFT JOIN inventory_items ii ON sqi.inventory_item_id = ii.id
        LEFT JOIN items i ON ii.item_master_id = i.id
        WHERE sqi.sales_quotation_id = $1
        ORDER BY sqi.line_number
      `;
      
      const itemsResult = await db.query(itemsQuery, [id]);
      quotation.items = itemsResult.rows;

      return quotation;
    } catch (error) {
      console.error('Error in SalesQuotation.findById:', error);
      throw error;
    }
  }

  static async create(quotationData, userId) {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Generate quotation number
      const quotationNumber = await this.generateQuotationNumber(client);

      // Calculate valid_until if not provided (default 30 days)
      let validUntil = quotationData.valid_until;
      if (!validUntil) {
        const quotationDate = new Date(quotationData.quotation_date || new Date());
        validUntil = new Date(quotationDate);
        validUntil.setDate(validUntil.getDate() + 30); // 30 days validity
      }

      // Insert sales quotation
      const sqQuery = `
        INSERT INTO sales_quotations (
          quotation_number, customer_id, customer_name, quotation_date, valid_until,
          reference_number, currency, subtotal, tax_amount, discount_amount,
          total_amount, status, priority, delivery_address, delivery_terms,
          estimated_delivery_days, notes, internal_notes, terms_and_conditions,
          payment_terms, created_by, updated_by
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20, $21, $21
        ) RETURNING *
      `;

      const sqValues = [
        quotationNumber,
        quotationData.customer_id,
        quotationData.customer_name,
        quotationData.quotation_date || new Date(),
        validUntil,
        quotationData.reference_number,
        quotationData.currency || 'USD',
        quotationData.subtotal || 0,
        quotationData.tax_amount || 0,
        quotationData.discount_amount || 0,
        quotationData.total_amount || 0,
        'DRAFT',
        quotationData.priority || 'NORMAL',
        quotationData.delivery_address,
        quotationData.delivery_terms,
        quotationData.estimated_delivery_days,
        quotationData.notes,
        quotationData.internal_notes,
        quotationData.terms_and_conditions,
        quotationData.payment_terms,
        userId
      ];

      const sqResult = await client.query(sqQuery, sqValues);
      const quotation = sqResult.rows[0];

      // Insert quotation items
      if (quotationData.items && quotationData.items.length > 0) {
        for (let i = 0; i < quotationData.items.length; i++) {
          const item = quotationData.items[i];
          
          const itemQuery = `
            INSERT INTO sales_quotation_items (
              sales_quotation_id, line_number, inventory_item_id, item_code,
              item_name, item_description, quantity, unit_of_measure,
              unit_price, discount_percentage, discount_amount, line_total,
              estimated_delivery_date, notes, sourcing_type, source_bin_id,
              linked_sales_rfq_id, supplier_id, supplier_name, estimated_supplier_cost,
              margin_percentage, margin_amount
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
            )
          `;

          const itemValues = [
            quotation.id,
            i + 1,
            item.inventory_item_id,
            item.item_code,
            item.item_name,
            item.item_description,
            item.quantity,
            item.unit_of_measure,
            item.unit_price,
            item.discount_percentage || 0,
            item.discount_amount || 0,
            item.line_total,
            item.estimated_delivery_date,
            item.notes,
            item.sourcing_type || 'STOCK',
            item.source_bin_id || null,
            item.linked_sales_rfq_id || null,
            item.supplier_id || null,
            item.supplier_name || null,
            item.estimated_supplier_cost || null,
            item.margin_percentage || null,
            item.margin_amount || null
          ];

          await client.query(itemQuery, itemValues);
        }
      }

      // Add status history
      await this.addStatusHistory(client, quotation.id, null, 'DRAFT', userId, 'Quotation created');

      await client.query('COMMIT');
      
      // Return full quotation with items
      return await this.findById(quotation.id);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesQuotation.create:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async update(id, quotationData, userId) {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Check if quotation exists and can be updated
      const existingResult = await client.query(
        'SELECT status FROM sales_quotations WHERE id = $1 AND deleted_at IS NULL',
        [id]
      );

      if (existingResult.rows.length === 0) {
        throw new Error('Quotation not found');
      }

      const currentStatus = existingResult.rows[0].status;
      if (['ACCEPTED', 'REJECTED', 'CANCELLED'].includes(currentStatus)) {
        throw new Error('Cannot update quotation that is already accepted, rejected, or cancelled');
      }

      // Update quotation
      const updateQuery = `
        UPDATE sales_quotations SET
          customer_id = COALESCE($2, customer_id),
          customer_name = COALESCE($3, customer_name),
          quotation_date = COALESCE($4, quotation_date),
          valid_until = COALESCE($5, valid_until),
          reference_number = COALESCE($6, reference_number),
          currency = COALESCE($7, currency),
          subtotal = COALESCE($8, subtotal),
          tax_amount = COALESCE($9, tax_amount),
          discount_amount = COALESCE($10, discount_amount),
          total_amount = COALESCE($11, total_amount),
          priority = COALESCE($12, priority),
          delivery_address = COALESCE($13, delivery_address),
          delivery_terms = COALESCE($14, delivery_terms),
          estimated_delivery_days = COALESCE($15, estimated_delivery_days),
          notes = COALESCE($16, notes),
          internal_notes = COALESCE($17, internal_notes),
          terms_and_conditions = COALESCE($18, terms_and_conditions),
          payment_terms = COALESCE($19, payment_terms),
          updated_by = $20
        WHERE id = $1 AND deleted_at IS NULL
      `;

      const updateValues = [
        id,
        quotationData.customer_id,
        quotationData.customer_name,
        quotationData.quotation_date,
        quotationData.valid_until,
        quotationData.reference_number,
        quotationData.currency,
        quotationData.subtotal,
        quotationData.tax_amount,
        quotationData.discount_amount,
        quotationData.total_amount,
        quotationData.priority,
        quotationData.delivery_address,
        quotationData.delivery_terms,
        quotationData.estimated_delivery_days,
        quotationData.notes,
        quotationData.internal_notes,
        quotationData.terms_and_conditions,
        quotationData.payment_terms,
        userId
      ];

      await client.query(updateQuery, updateValues);

      // Update items if provided
      if (quotationData.items) {
        // Delete existing items
        await client.query('DELETE FROM sales_quotation_items WHERE sales_quotation_id = $1', [id]);

        // Insert new items
        for (let i = 0; i < quotationData.items.length; i++) {
          const item = quotationData.items[i];
          
          const itemQuery = `
            INSERT INTO sales_quotation_items (
              sales_quotation_id, line_number, inventory_item_id, item_code,
              item_name, item_description, quantity, unit_of_measure,
              unit_price, discount_percentage, discount_amount, line_total,
              estimated_delivery_date, notes, sourcing_type, source_bin_id,
              linked_sales_rfq_id, supplier_id, supplier_name, estimated_supplier_cost,
              margin_percentage, margin_amount
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
            )
          `;

          const itemValues = [
            id,
            i + 1,
            item.inventory_item_id,
            item.item_code,
            item.item_name,
            item.item_description,
            item.quantity,
            item.unit_of_measure,
            item.unit_price,
            item.discount_percentage || 0,
            item.discount_amount || 0,
            item.line_total,
            item.estimated_delivery_date,
            item.notes,
            item.sourcing_type || 'STOCK',
            item.source_bin_id || null,
            item.linked_sales_rfq_id || null,
            item.supplier_id || null,
            item.supplier_name || null,
            item.estimated_supplier_cost || null,
            item.margin_percentage || null,
            item.margin_amount || null
          ];

          await client.query(itemQuery, itemValues);
        }
      }

      await client.query('COMMIT');
      
      return await this.findById(id);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesQuotation.update:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async updateStatus(id, newStatus, userId, reason = '') {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Get current status
      const currentResult = await client.query(
        'SELECT status FROM sales_quotations WHERE id = $1 AND deleted_at IS NULL',
        [id]
      );

      if (currentResult.rows.length === 0) {
        throw new Error('Quotation not found');
      }

      const currentStatus = currentResult.rows[0].status;

      // Update status
      await client.query(
        'UPDATE sales_quotations SET status = $2, updated_by = $3 WHERE id = $1',
        [id, newStatus, userId]
      );

      // Add status history
      await this.addStatusHistory(client, id, currentStatus, newStatus, userId, reason);

      await client.query('COMMIT');
      
      return await this.findById(id);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesQuotation.updateStatus:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async convertToSalesOrder(quotationId, userId) {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Get quotation details
      const quotation = await this.findById(quotationId);
      if (!quotation) {
        throw new Error('Quotation not found');
      }

      if (quotation.status !== 'ACCEPTED') {
        throw new Error('Only accepted quotations can be converted to sales orders');
      }

      if (quotation.converted_to_so) {
        throw new Error('Quotation already converted to sales order');
      }

      // Create sales order from quotation
      const SalesOrder = require('./SalesOrder');
      const salesOrderData = {
        customer_id: quotation.customer_id,
        customer_name: quotation.customer_name,
        order_date: new Date(),
        delivery_date: quotation.estimated_delivery_date,
        reference_number: `FROM-QT-${quotation.quotation_number}`,
        currency: quotation.currency,
        subtotal: quotation.subtotal,
        tax_amount: quotation.tax_amount,
        discount_amount: quotation.discount_amount,
        total_amount: quotation.total_amount,
        priority: quotation.priority,
        delivery_address: quotation.delivery_address,
        delivery_terms: quotation.delivery_terms,
        notes: quotation.notes,
        internal_notes: quotation.internal_notes,
        payment_terms: quotation.payment_terms,
        items: quotation.items.map(item => ({
          inventory_item_id: item.inventory_item_id,
          item_code: item.item_code,
          item_name: item.item_name,
          item_description: item.item_description,
          quantity: item.quantity,
          unit_of_measure: item.unit_of_measure,
          unit_price: item.unit_price,
          discount_percentage: item.discount_percentage,
          discount_amount: item.discount_amount,
          line_total: item.line_total,
          requested_delivery_date: item.estimated_delivery_date,
          notes: item.notes
        }))
      };

      const salesOrder = await SalesOrder.create(salesOrderData, userId);

      // Update quotation to mark as converted
      await client.query(
        `UPDATE sales_quotations 
         SET converted_to_so = TRUE, sales_order_id = $2, converted_at = CURRENT_TIMESTAMP, converted_by = $3
         WHERE id = $1`,
        [quotationId, salesOrder.id, userId]
      );

      // Add status history
      await this.addStatusHistory(client, quotationId, 'ACCEPTED', 'ACCEPTED', userId, 
        `Converted to Sales Order ${salesOrder.so_number}`);

      await client.query('COMMIT');
      
      return salesOrder;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesQuotation.convertToSalesOrder:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async delete(id, userId) {
    try {
      const result = await db.query(
        `UPDATE sales_quotations 
         SET deleted_at = CURRENT_TIMESTAMP, updated_by = $2 
         WHERE id = $1 AND deleted_at IS NULL 
         RETURNING *`,
        [id, userId]
      );

      if (result.rows.length === 0) {
        throw new Error('Quotation not found or already deleted');
      }

      return result.rows[0];
    } catch (error) {
      console.error('Error in SalesQuotation.delete:', error);
      throw error;
    }
  }

  static async getStats() {
    try {
      const query = `
        SELECT 
          COUNT(*) as total_quotations,
          COUNT(CASE WHEN status = 'DRAFT' THEN 1 END) as draft_quotations,
          COUNT(CASE WHEN status = 'SENT' THEN 1 END) as sent_quotations,
          COUNT(CASE WHEN status = 'ACCEPTED' THEN 1 END) as accepted_quotations,
          COUNT(CASE WHEN status = 'REJECTED' THEN 1 END) as rejected_quotations,
          COUNT(CASE WHEN valid_until < CURRENT_DATE AND status NOT IN ('ACCEPTED', 'REJECTED', 'CANCELLED') THEN 1 END) as expired_quotations,
          COUNT(CASE WHEN converted_to_so = TRUE THEN 1 END) as converted_quotations,
          SUM(total_amount) as total_value,
          SUM(CASE WHEN status = 'ACCEPTED' THEN total_amount ELSE 0 END) as accepted_value,
          AVG(total_amount) as average_quotation_value,
          ROUND(
            COUNT(CASE WHEN status = 'ACCEPTED' THEN 1 END) * 100.0 / 
            NULLIF(COUNT(CASE WHEN status IN ('ACCEPTED', 'REJECTED') THEN 1 END), 0), 2
          ) as acceptance_rate
        FROM sales_quotations 
        WHERE deleted_at IS NULL
      `;
      
      const result = await db.query(query);
      return result.rows[0];
    } catch (error) {
      console.error('Error in SalesQuotation.getStats:', error);
      throw error;
    }
  }

  static async generateQuotationNumber(client = db.pool) {
    try {
      const year = new Date().getFullYear();
      const prefix = `QT${year}`;
      
      const result = await client.query(
        `SELECT quotation_number FROM sales_quotations 
         WHERE quotation_number LIKE $1 
         ORDER BY quotation_number DESC LIMIT 1`,
        [`${prefix}%`]
      );

      let nextNumber = 1;
      if (result.rows.length > 0) {
        const lastNumber = result.rows[0].quotation_number.replace(prefix, '');
        nextNumber = parseInt(lastNumber) + 1;
      }

      return `${prefix}${nextNumber.toString().padStart(6, '0')}`;
    } catch (error) {
      console.error('Error generating quotation number:', error);
      throw error;
    }
  }

  static async addStatusHistory(client, quotationId, fromStatus, toStatus, userId, reason) {
    const query = `
      INSERT INTO sales_quotation_status_history 
      (sales_quotation_id, from_status, to_status, changed_by, reason)
      VALUES ($1, $2, $3, $4, $5)
    `;
    
    await client.query(query, [quotationId, fromStatus, toStatus, userId, reason]);
  }

  static async getStatusHistory(quotationId) {
    try {
      const query = `
        SELECT 
          sqsh.*,
          u.first_name || ' ' || u.last_name as changed_by_name
        FROM sales_quotation_status_history sqsh
        LEFT JOIN users u ON sqsh.changed_by = u.id
        WHERE sqsh.sales_quotation_id = $1
        ORDER BY sqsh.status_date ASC
      `;
      
      const result = await db.query(query, [quotationId]);
      return result.rows;
    } catch (error) {
      console.error('Error in SalesQuotation.getStatusHistory:', error);
      throw error;
    }
  }

  // Auto-expire quotations (should be run as a scheduled job)
  static async expireQuotations() {
    try {
      const result = await db.query(
        `UPDATE sales_quotations 
         SET status = 'EXPIRED', updated_at = CURRENT_TIMESTAMP
         WHERE valid_until < CURRENT_DATE 
         AND status NOT IN ('ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED')
         AND deleted_at IS NULL
         RETURNING id, quotation_number`
      );

      return result.rows;
    } catch (error) {
      console.error('Error in SalesQuotation.expireQuotations:', error);
      throw error;
    }
  }

  // Approval and email integration methods
  static async requestSendApproval(quotationId, userId) {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Get quotation details
      const quotation = await this.findById(quotationId);
      if (!quotation) {
        throw new Error('Quotation not found');
      }
      
      // Check if quotation is in correct status
      if (!['APPROVED', 'DRAFT'].includes(quotation.status)) {
        throw new Error('Quotation must be approved or draft to request send approval');
      }
      
      // Check DOA authority for sending
      const DelegationOfAuthority = require('./DelegationOfAuthority');
      const hasAuthority = await DelegationOfAuthority.checkSalesQuotationAuthority(
        userId, 
        quotation.total_amount,
        quotation.cost_center
      );
      
      if (hasAuthority.canApprove) {
        // User has authority, can send directly
        return await this.sendToCustomer(quotationId, userId);
      } else {
        // Need approval - update status to PENDING_SEND_APPROVAL
        await client.query(
          'UPDATE sales_quotations SET status = $2, send_requested_by = $3, send_requested_at = NOW(), updated_at = NOW() WHERE id = $1',
          [quotationId, 'PENDING_SEND_APPROVAL', userId]
        );
        
        // Add status history
        await this.addStatusHistory(client, quotationId, quotation.status, 'PENDING_SEND_APPROVAL', userId, 
          'Requested approval to send quotation to customer');
        
        await client.query('COMMIT');
        
        return {
          success: true,
          message: 'Send approval requested. Waiting for manager approval.',
          requiresApproval: true,
          approver: hasAuthority.approver
        };
      }
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesQuotation.requestSendApproval:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async approveSendToCustomer(quotationId, userId, approvalNotes = '') {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Get quotation details
      const quotation = await this.findById(quotationId);
      if (!quotation) {
        throw new Error('Quotation not found');
      }
      
      if (quotation.status !== 'PENDING_SEND_APPROVAL') {
        throw new Error('Quotation is not pending send approval');
      }
      
      // Update status to approved for sending
      await client.query(
        'UPDATE sales_quotations SET status = $2, send_approved_by = $3, send_approved_at = NOW(), send_approval_notes = $4, updated_at = NOW() WHERE id = $1',
        [quotationId, 'APPROVED_FOR_SEND', userId, approvalNotes]
      );
      
      // Add status history
      await this.addStatusHistory(client, quotationId, 'PENDING_SEND_APPROVAL', 'APPROVED_FOR_SEND', userId, 
        `Send approval granted: ${approvalNotes}`);
      
      await client.query('COMMIT');
      
      return {
        success: true,
        message: 'Quotation approved for sending to customer',
        data: await this.findById(quotationId)
      };
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesQuotation.approveSendToCustomer:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async sendToCustomer(quotationId, userId) {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Get quotation with customer details
      const quotation = await this.findById(quotationId);
      if (!quotation) {
        throw new Error('Quotation not found');
      }
      
      // Check if quotation can be sent (must be approved or approved for send)
      if (!['APPROVED', 'APPROVED_FOR_SEND'].includes(quotation.status)) {
        throw new Error('Quotation must be approved before sending to customer');
      }
      
      // Get customer details
      const Customer = require('./Customer');
      const customer = await Customer.findById(quotation.customer_id);
      if (!customer) {
        throw new Error('Customer not found');
      }
      
      // Generate unique response token for customer (expiring, single-use)
      const { generateToken, expiryDate } = require('../services/portalTokens');
      const responseToken = generateToken();

      // Send email to customer
      const customerEmailService = require('../services/customerEmailService');
      const emailResult = await customerEmailService.sendQuotationEmail(quotation, customer, responseToken);

      if (emailResult.success) {
        // Update quotation status to SENT
        await client.query(
          'UPDATE sales_quotations SET status = $2, updated_by = $3, sent_at = NOW(), customer_response_token = $4, customer_response_token_expires_at = $5, customer_response_token_used_at = NULL, updated_at = NOW() WHERE id = $1',
          [quotationId, 'SENT', userId, responseToken, expiryDate()]
        );
        
        // Add status history
        await this.addStatusHistory(client, quotationId, quotation.status, 'SENT', userId, 
          `Quotation sent to customer (${customer.primary_email})`);
        
        await client.query('COMMIT');
        
        return {
          success: true,
          message: 'Quotation sent to customer successfully',
          emailResult: emailResult,
          responseToken: responseToken
        };
      } else {
        throw new Error('Failed to send quotation email');
      }
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesQuotation.sendToCustomer:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async customerResponse(token, action, customerNotes = '') {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Find quotation by response token (must be unexpired and unused)
      const quotationResult = await client.query(
        `SELECT * FROM sales_quotations WHERE customer_response_token = $1 AND deleted_at IS NULL
         AND (customer_response_token_expires_at IS NULL OR customer_response_token_expires_at > NOW())
         AND customer_response_token_used_at IS NULL`,
        [token]
      );
      
      if (quotationResult.rows.length === 0) {
        throw new Error('Invalid or expired quotation link');
      }
      
      const quotation = quotationResult.rows[0];
      
      if (quotation.status !== 'SENT') {
        throw new Error('Quotation is no longer available for response');
      }
      
      const newStatus = action === 'accept' ? 'ACCEPTED' : 'REJECTED';
      const responseField = action === 'accept' ? 'accepted_at' : 'rejected_at';
      
      // Update quotation status
      await client.query(
        `UPDATE sales_quotations 
         SET status = $1, ${responseField} = NOW(), customer_response_notes = $2, customer_response_token = NULL, updated_at = NOW() 
         WHERE id = $3`,
        [newStatus, customerNotes, quotation.id]
      );
      
      // Add status history
      await this.addStatusHistory(client, quotation.id, 'SENT', newStatus, null, 
        `Customer ${action}ed quotation: ${customerNotes}`);
      
      await client.query('COMMIT');
      
      return {
        success: true,
        message: `Quotation ${action}ed successfully`,
        quotation: await this.findById(quotation.id)
      };
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesQuotation.customerResponse:', error);
      throw error;
    } finally {
      client.release();
    }
  }
  
  static async requestApproval(quotationId, userId, notes = '') {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const quotation = await this.findById(quotationId);
      
      if (!quotation) {
        throw new Error('Quotation not found');
      }
      
      if (quotation.status !== 'DRAFT') {
        throw new Error('Can only request approval for DRAFT quotations');
      }
      
      // Update quotation status to PENDING_APPROVAL
      await client.query(
        'UPDATE sales_quotations SET status = $2, updated_by = $3 WHERE id = $1',
        [quotationId, 'PENDING_APPROVAL', userId]
      );
      
      // Add status history
      await this.addStatusHistory(client, quotationId, quotation.status, 'PENDING_APPROVAL', userId, 
        `Approval requested: ${notes}`);
      
      // Create notification for managers who can approve
      const DelegationOfAuthority = require('./DelegationOfAuthority');
      const Notification = require('./Notification');
      
      // Get users who can approve this quotation
      const authorities = await DelegationOfAuthority.getAuthorizedUsers(
        quotation.total_amount, 
        quotation.cost_center || 'ALL',
        'SALES_QUOTATION'
      );
      
      // Create notifications for each user with approval authority
      for (const authority of authorities) {
        if (authority.user_id !== userId) { // Don't notify the requester
          await Notification.create({
            type: 'sales_quotation_submitted',
            title: 'Sales Quotation Pending Approval',
            message: `Quotation ${quotation.quotation_number} (${quotation.currency} ${quotation.total_amount}) is pending your approval`,
            data: {
              quotationId: quotationId,
              quotationNumber: quotation.quotation_number,
              totalAmount: quotation.total_amount,
              currency: quotation.currency,
              requestedBy: userId,
              type: 'sales_quotation',
              action: 'submitted'
            }
          }, authority.user_id);
        }
      }
      
      await client.query('COMMIT');
      
      return await this.findById(quotationId);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesQuotation.requestApproval:', error);
      throw error;
    } finally {
      client.release();
    }
  }
  
  static async approveQuotation(quotationId, userId, approvalNotes = '') {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Check if user has approval authority
      const DelegationOfAuthority = require('./DelegationOfAuthority');
      const quotation = await this.findById(quotationId);
      
      if (!quotation) {
        throw new Error('Quotation not found');
      }
      
      const canApprove = await DelegationOfAuthority.canApproveSalesTransaction(
        userId, 
        quotation.total_amount, 
        'SALES_QUOTATION'
      );
      
      if (!canApprove) {
        throw new Error('You do not have authority to approve this quotation');
      }
      
      // Update quotation status and send to customer
      let newStatus = 'SENT';
      
      // Generate customer response token (expiring, single-use)
      const { generateToken, expiryDate } = require('../services/portalTokens');
      const customerResponseToken = generateToken();

      await client.query(
        'UPDATE sales_quotations SET status = $2, approved_by = $3, approved_at = CURRENT_TIMESTAMP, sent_to_customer_at = CURRENT_TIMESTAMP, sent_by = $3, customer_response_token = $4, customer_response_token_expires_at = $5, customer_response_token_used_at = NULL, updated_by = $3 WHERE id = $1',
        [quotationId, newStatus, userId, customerResponseToken, expiryDate()]
      );
      
      // Add status history for approval
      await this.addStatusHistory(client, quotationId, quotation.status, 'APPROVED', userId, 
        `Quotation approved: ${approvalNotes}`);
      
      // Add status history for sending to customer
      await this.addStatusHistory(client, quotationId, 'APPROVED', newStatus, userId, 
        `Quotation sent to customer after approval`);
      
      // Get customer details
      const customerResult = await client.query('SELECT * FROM customers WHERE id = $1', [quotation.customer_id]);
      const customer = customerResult.rows[0];
      
      // Commit the database transaction first
      await client.query('COMMIT');
      
      // Send email to customer after transaction is committed (don't fail approval if email fails)
      if (customer) {
        try {
          const customerEmailService = require('../services/customerEmailService');
          const customerEmail = customer.primary_email || customer.secondary_email || customer.email;
          
          if (customerEmail) {
            await customerEmailService.sendQuotationEmail(quotation, customer, customerResponseToken);
            console.log(`✅ Quotation email sent to customer: ${customerEmail}`);
          } else {
            console.log(`⚠️  Customer ${customer.customer_name} has no email address`);
          }
        } catch (emailError) {
          console.error('Failed to send email to customer:', emailError);
          console.log('✅ Approval completed successfully despite email failure');
        }
      }
      
      // Create notification for original creator (after commit)
      try {
        const Notification = require('./Notification');
        await Notification.create({
          type: 'sales_quotation_approved',
          title: 'Sales Quotation Approved and Sent to Customer',
          message: `Your quotation ${quotation.quotation_number} has been approved and sent to customer ${customer?.customer_name || 'Unknown'}`,
          data: {
            quotationId: quotationId,
            quotationNumber: quotation.quotation_number,
            approvedBy: userId,
            customerName: customer?.customer_name,
            type: 'sales_quotation',
            action: 'approved_and_sent'
          }
        }, quotation.created_by);
      } catch (notificationError) {
        console.error('Failed to create notification:', notificationError);
      }
      
      return await this.findById(quotationId);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesQuotation.approveQuotation:', error);
      throw error;
    } finally {
      client.release();
    }
  }
  
  static async rejectQuotation(quotationId, userId, rejectionReason = '') {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Check if user has approval authority
      const DelegationOfAuthority = require('./DelegationOfAuthority');
      const quotation = await this.findById(quotationId);
      
      if (!quotation) {
        throw new Error('Quotation not found');
      }
      
      const canApprove = await DelegationOfAuthority.canApproveSalesTransaction(
        userId, 
        quotation.total_amount, 
        'SALES_QUOTATION'
      );
      
      if (!canApprove) {
        throw new Error('You do not have authority to reject this quotation');
      }
      
      // Update quotation status
      await client.query(
        'UPDATE sales_quotations SET status = $2, updated_by = $3 WHERE id = $1',
        [quotationId, 'REJECTED', userId]
      );
      
      // Add status history
      await this.addStatusHistory(client, quotationId, quotation.status, 'REJECTED', userId, 
        `Quotation rejected: ${rejectionReason}`);
      
      // Create notification for original creator
      const Notification = require('./Notification');
      await Notification.create({
        type: 'sales_quotation_rejected',
        title: 'Sales Quotation Rejected',
        message: `Your quotation ${quotation.quotation_number} has been rejected: ${rejectionReason}`,
        data: {
          quotationId: quotationId,
          quotationNumber: quotation.quotation_number,
          rejectedBy: userId,
          rejectionReason: rejectionReason,
          type: 'sales_quotation',
          action: 'rejected'
        }
      }, quotation.created_by);
      
      await client.query('COMMIT');
      
      return await this.findById(quotationId);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesQuotation.rejectQuotation:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  // Get quotations pending approval for a specific user
  static async getPendingApprovals(userId) {
    try {
      const DelegationOfAuthority = require('./DelegationOfAuthority');
      
      // Get user's authority levels
      const authorities = await DelegationOfAuthority.getUserAuthority(userId, null, 'SALES_QUOTATION');
      
      if (!authorities.length) {
        return [];
      }
      
      // Find quotations that need approval within user's authority
      const maxAuthority = Math.max(...authorities.map(a => a.max_amount || Number.MAX_SAFE_INTEGER));
      const minAuthority = Math.min(...authorities.map(a => a.min_amount || 0));
      
      const query = `
        SELECT 
          sq.*,
          c.customer_name,
          u.first_name || ' ' || u.last_name as created_by_name,
          COUNT(sqi.id) as item_count
        FROM sales_quotations sq
        LEFT JOIN customers c ON sq.customer_id = c.id
        LEFT JOIN users u ON sq.created_by = u.id
        LEFT JOIN sales_quotation_items sqi ON sq.id = sqi.sales_quotation_id
        WHERE sq.status = 'PENDING_APPROVAL'
          AND sq.total_amount >= $1
          AND sq.total_amount <= $2
          AND sq.deleted_at IS NULL
        GROUP BY sq.id, c.customer_name, u.first_name, u.last_name
        ORDER BY sq.created_at ASC
      `;
      
      const result = await db.query(query, [minAuthority, maxAuthority]);
      return result.rows;
    } catch (error) {
      console.error('Error in SalesQuotation.getPendingApprovals:', error);
      throw error;
    }
  }
}

module.exports = SalesQuotation;