const db = require('../config/database');

class SalesRfq {
  static async findAll(filters = {}) {
    try {
      let query = `
        SELECT 
          sr.*,
          s.legal_name as supplier_company_name,
          s.trade_name as supplier_contact_person,
          s.email as supplier_email_address,
          s.phone as supplier_phone_number,
          c.customer_name as customer_company_name,
          u_created.first_name || ' ' || u_created.last_name as created_by_name,
          u_updated.first_name || ' ' || u_updated.last_name as updated_by_name,
          COUNT(sri.id) as item_count,
          CASE 
            WHEN sr.response_deadline < CURRENT_DATE AND sr.status IN ('SENT', 'PARTIALLY_RESPONDED') 
            THEN true 
            ELSE false 
          END as is_overdue
        FROM sales_rfqs sr
        LEFT JOIN suppliers s ON sr.supplier_id = s.id
        LEFT JOIN customers c ON sr.linked_customer_id = c.id
        LEFT JOIN users u_created ON sr.created_by = u_created.id
        LEFT JOIN users u_updated ON sr.updated_by = u_updated.id
        LEFT JOIN sales_rfq_items sri ON sr.id = sri.sales_rfq_id
        WHERE sr.deleted_at IS NULL
      `;

      const conditions = [];
      const params = [];

      if (filters.search) {
        conditions.push(`(
          sr.rfq_number ILIKE $${params.length + 1} OR
          sr.rfq_title ILIKE $${params.length + 1} OR
          sr.supplier_name ILIKE $${params.length + 1} OR
          s.legal_name ILIKE $${params.length + 1} OR
          s.trade_name ILIKE $${params.length + 1}
        )`);
        params.push(`%${filters.search}%`);
      }

      if (filters.status) {
        conditions.push(`sr.status = $${params.length + 1}`);
        params.push(filters.status);
      }

      if (filters.supplier_id) {
        conditions.push(`sr.supplier_id = $${params.length + 1}`);
        params.push(filters.supplier_id);
      }

      if (filters.customer_id) {
        conditions.push(`sr.linked_customer_id = $${params.length + 1}`);
        params.push(filters.customer_id);
      }

      if (filters.priority) {
        conditions.push(`sr.priority = $${params.length + 1}`);
        params.push(filters.priority);
      }

      if (filters.request_type) {
        conditions.push(`sr.request_type = $${params.length + 1}`);
        params.push(filters.request_type);
      }

      if (filters.overdue === 'true') {
        conditions.push(`sr.response_deadline < CURRENT_DATE AND sr.status IN ('SENT', 'PARTIALLY_RESPONDED')`);
      } else if (filters.overdue === 'false') {
        conditions.push(`NOT (sr.response_deadline < CURRENT_DATE AND sr.status IN ('SENT', 'PARTIALLY_RESPONDED'))`);
      }

      if (filters.date_from) {
        conditions.push(`sr.created_at >= $${params.length + 1}`);
        params.push(filters.date_from);
      }

      if (filters.date_to) {
        conditions.push(`sr.created_at <= $${params.length + 1}`);
        params.push(filters.date_to);
      }

      if (conditions.length > 0) {
        query += ' AND ' + conditions.join(' AND ');
      }

      query += `
        GROUP BY sr.id, s.legal_name, s.trade_name, s.email, s.phone, 
                 c.customer_name, u_created.first_name, u_created.last_name, 
                 u_updated.first_name, u_updated.last_name
        ORDER BY sr.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `;

      params.push(filters.limit || 50);
      params.push(filters.offset || 0);

      const result = await db.query(query, params);
      return result.rows;
    } catch (error) {
      console.error('Error in SalesRfq.findAll:', error);
      throw error;
    }
  }

  static async findById(id) {
    try {
      const query = `
        SELECT 
          sr.*,
          s.legal_name as supplier_company_name,
          s.trade_name as supplier_contact_person,
          s.email as supplier_email_address,
          s.phone as supplier_phone_number,
          c.customer_name as customer_company_name,
          u_created.first_name || ' ' || u_created.last_name as created_by_name,
          u_updated.first_name || ' ' || u_updated.last_name as updated_by_name,
          CASE 
            WHEN sr.response_deadline < CURRENT_DATE AND sr.status IN ('SENT', 'PARTIALLY_RESPONDED') 
            THEN true 
            ELSE false 
          END as is_overdue
        FROM sales_rfqs sr
        LEFT JOIN suppliers s ON sr.supplier_id = s.id
        LEFT JOIN customers c ON sr.linked_customer_id = c.id
        LEFT JOIN users u_created ON sr.created_by = u_created.id
        LEFT JOIN users u_updated ON sr.updated_by = u_updated.id
        WHERE sr.id = $1 AND sr.deleted_at IS NULL
      `;

      const result = await db.query(query, [id]);
      
      if (result.rows.length === 0) {
        return null;
      }

      const rfq = result.rows[0];

      // Get RFQ items
      const itemsQuery = `
        SELECT 
          sri.*,
          i.name as master_item_name,
          i.description as master_item_description
        FROM sales_rfq_items sri
        LEFT JOIN items i ON sri.item_id = i.id
        WHERE sri.sales_rfq_id = $1
        ORDER BY sri.line_number
      `;

      const itemsResult = await db.query(itemsQuery, [id]);
      rfq.items = itemsResult.rows;

      return rfq;
    } catch (error) {
      console.error('Error in SalesRfq.findById:', error);
      throw error;
    }
  }

  static async create(rfqData, createdBy) {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Generate RFQ number
      const numberResult = await client.query('SELECT generate_sales_rfq_number() as rfq_number');
      const rfqNumber = numberResult.rows[0].rfq_number;

      // Insert RFQ
      const rfqQuery = `
        INSERT INTO sales_rfqs (
          rfq_number, rfq_title, supplier_id, supplier_name, supplier_email, 
          supplier_contact_person, supplier_phone, request_type, required_delivery_date,
          delivery_location, delivery_terms, payment_terms, priority, response_deadline,
          special_requirements, terms_and_conditions, internal_notes, attachment_urls,
          linked_customer_id, source_document_type, source_document_id, created_by
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
        ) RETURNING *
      `;

      const rfqValues = [
        rfqNumber,
        rfqData.rfq_title,
        rfqData.supplier_id || null,
        rfqData.supplier_name,
        rfqData.supplier_email,
        rfqData.supplier_contact_person,
        rfqData.supplier_phone,
        rfqData.request_type || 'TRADING',
        rfqData.required_delivery_date,
        rfqData.delivery_location,
        rfqData.delivery_terms,
        rfqData.payment_terms,
        rfqData.priority || 'MEDIUM',
        rfqData.response_deadline,
        rfqData.special_requirements,
        rfqData.terms_and_conditions,
        rfqData.internal_notes,
        rfqData.attachment_urls || null,
        rfqData.linked_customer_id || null,
        rfqData.source_document_type,
        rfqData.source_document_id || null,
        createdBy
      ];

      const rfqResult = await client.query(rfqQuery, rfqValues);
      const rfqId = rfqResult.rows[0].id;

      // Insert RFQ items
      if (rfqData.items && rfqData.items.length > 0) {
        for (let i = 0; i < rfqData.items.length; i++) {
          const item = rfqData.items[i];
          
          const itemQuery = `
            INSERT INTO sales_rfq_items (
              sales_rfq_id, line_number, item_id, item_name, item_description,
              item_specification, requested_quantity, unit_of_measure, estimated_unit_price
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `;

          const itemValues = [
            rfqId,
            i + 1,
            item.item_id || null,
            item.item_name,
            item.item_description,
            item.item_specification,
            item.requested_quantity,
            item.unit_of_measure,
            item.estimated_unit_price || null
          ];

          await client.query(itemQuery, itemValues);
        }
      }

      // Insert status history
      await client.query(
        `INSERT INTO sales_rfq_status_history (sales_rfq_id, status, changed_by) VALUES ($1, $2, $3)`,
        [rfqId, 'DRAFT', createdBy]
      );

      await client.query('COMMIT');

      return await this.findById(rfqId);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesRfq.create:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async update(id, rfqData, updatedBy) {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Update RFQ
      const rfqQuery = `
        UPDATE sales_rfqs SET
          rfq_title = $2, supplier_id = $3, supplier_name = $4, supplier_email = $5,
          supplier_contact_person = $6, supplier_phone = $7, request_type = $8,
          required_delivery_date = $9, delivery_location = $10, delivery_terms = $11,
          payment_terms = $12, priority = $13, response_deadline = $14,
          special_requirements = $15, terms_and_conditions = $16, internal_notes = $17,
          attachment_urls = $18, linked_customer_id = $19, updated_by = $20
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *
      `;

      const rfqValues = [
        id,
        rfqData.rfq_title,
        rfqData.supplier_id || null,
        rfqData.supplier_name,
        rfqData.supplier_email,
        rfqData.supplier_contact_person,
        rfqData.supplier_phone,
        rfqData.request_type,
        rfqData.required_delivery_date,
        rfqData.delivery_location,
        rfqData.delivery_terms,
        rfqData.payment_terms,
        rfqData.priority,
        rfqData.response_deadline,
        rfqData.special_requirements,
        rfqData.terms_and_conditions,
        rfqData.internal_notes,
        rfqData.attachment_urls || null,
        rfqData.linked_customer_id || null,
        updatedBy
      ];

      const rfqResult = await client.query(rfqQuery, rfqValues);
      
      if (rfqResult.rows.length === 0) {
        throw new Error('Sales RFQ not found');
      }

      // Update RFQ items if provided
      if (rfqData.items) {
        // Delete existing items
        await client.query('DELETE FROM sales_rfq_items WHERE sales_rfq_id = $1', [id]);
        
        // Insert new items
        for (let i = 0; i < rfqData.items.length; i++) {
          const item = rfqData.items[i];
          
          const itemQuery = `
            INSERT INTO sales_rfq_items (
              sales_rfq_id, line_number, item_id, item_name, item_description,
              item_specification, requested_quantity, unit_of_measure, estimated_unit_price
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `;

          const itemValues = [
            id,
            i + 1,
            item.item_id || null,
            item.item_name,
            item.item_description,
            item.item_specification,
            item.requested_quantity,
            item.unit_of_measure,
            item.estimated_unit_price || null
          ];

          await client.query(itemQuery, itemValues);
        }
      }

      await client.query('COMMIT');

      return await this.findById(id);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesRfq.update:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async updateStatus(id, status, updatedBy, reason = '') {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Get current status
      const currentResult = await client.query(
        'SELECT status FROM sales_rfqs WHERE id = $1 AND deleted_at IS NULL',
        [id]
      );

      if (currentResult.rows.length === 0) {
        throw new Error('Sales RFQ not found');
      }

      const currentStatus = currentResult.rows[0].status;

      // Update status
      const updateResult = await client.query(
        'UPDATE sales_rfqs SET status = $2, updated_by = $3 WHERE id = $1 RETURNING *',
        [id, status, updatedBy]
      );

      // Insert status history
      await client.query(
        `INSERT INTO sales_rfq_status_history (sales_rfq_id, status, previous_status, changed_by, change_reason) 
         VALUES ($1, $2, $3, $4, $5)`,
        [id, status, currentStatus, updatedBy, reason]
      );

      await client.query('COMMIT');

      return await this.findById(id);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesRfq.updateStatus:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async updateSupplierResponse(id, responseData, updatedBy) {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Update RFQ with supplier response
      const rfqQuery = `
        UPDATE sales_rfqs SET
          response_received_at = CURRENT_TIMESTAMP,
          supplier_response_method = $2,
          supplier_total_amount = $3,
          supplier_currency = $4,
          supplier_validity_days = $5,
          supplier_comments = $6,
          supplier_alternative_items = $7,
          status = $8,
          updated_by = $9
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *
      `;

      const rfqValues = [
        id,
        responseData.supplier_response_method || 'SYSTEM',
        responseData.supplier_total_amount,
        responseData.supplier_currency || 'USD',
        responseData.supplier_validity_days,
        responseData.supplier_comments,
        responseData.supplier_alternative_items,
        responseData.items && responseData.items.length > 0 ? 'RESPONDED' : 'PARTIALLY_RESPONDED',
        updatedBy
      ];

      const rfqResult = await client.query(rfqQuery, rfqValues);

      if (rfqResult.rows.length === 0) {
        throw new Error('Sales RFQ not found');
      }

      // Update item responses if provided
      if (responseData.items) {
        for (const itemResponse of responseData.items) {
          const itemUpdateQuery = `
            UPDATE sales_rfq_items SET
              quoted_unit_price = $2,
              quoted_total_price = $3,
              supplier_lead_time_days = $4,
              supplier_minimum_order_quantity = $5,
              supplier_item_code = $6,
              supplier_brand = $7,
              supplier_availability_status = $8,
              supplier_item_notes = $9,
              supplier_alternative_item_name = $10,
              supplier_alternative_unit_price = $11,
              supplier_alternative_description = $12
            WHERE id = $1
          `;

          const itemValues = [
            itemResponse.item_id,
            itemResponse.quoted_unit_price,
            itemResponse.quoted_total_price,
            itemResponse.supplier_lead_time_days,
            itemResponse.supplier_minimum_order_quantity,
            itemResponse.supplier_item_code,
            itemResponse.supplier_brand,
            itemResponse.supplier_availability_status,
            itemResponse.supplier_item_notes,
            itemResponse.supplier_alternative_item_name,
            itemResponse.supplier_alternative_unit_price,
            itemResponse.supplier_alternative_description
          ];

          await client.query(itemUpdateQuery, itemValues);
        }
      }

      // Update status in history
      await client.query(
        `INSERT INTO sales_rfq_status_history (sales_rfq_id, status, changed_by, change_reason) 
         VALUES ($1, $2, $3, $4)`,
        [id, rfqResult.rows[0].status, updatedBy, 'Supplier response received']
      );

      await client.query('COMMIT');

      return await this.findById(id);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesRfq.updateSupplierResponse:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async getStatusHistory(id) {
    try {
      const query = `
        SELECT 
          sh.*,
          u.first_name || ' ' || u.last_name as changed_by_name
        FROM sales_rfq_status_history sh
        LEFT JOIN users u ON sh.changed_by = u.id
        WHERE sh.sales_rfq_id = $1
        ORDER BY sh.changed_at DESC
      `;

      const result = await db.query(query, [id]);
      return result.rows;
    } catch (error) {
      console.error('Error in SalesRfq.getStatusHistory:', error);
      throw error;
    }
  }

  static async getStats() {
    try {
      const query = `
        SELECT 
          COUNT(*) as total_rfqs,
          COUNT(*) FILTER (WHERE status = 'DRAFT') as draft_rfqs,
          COUNT(*) FILTER (WHERE status = 'SENT') as sent_rfqs,
          COUNT(*) FILTER (WHERE status = 'RESPONDED') as responded_rfqs,
          COUNT(*) FILTER (WHERE status = 'PARTIALLY_RESPONDED') as partially_responded_rfqs,
          COUNT(*) FILTER (WHERE status = 'COMPLETED') as completed_rfqs,
          COUNT(*) FILTER (WHERE response_deadline < CURRENT_DATE AND status IN ('SENT', 'PARTIALLY_RESPONDED')) as overdue_rfqs,
          SUM(supplier_total_amount) as total_quoted_value,
          AVG(supplier_total_amount) as avg_quoted_value
        FROM sales_rfqs
        WHERE deleted_at IS NULL
      `;

      const result = await db.query(query);
      return result.rows[0];
    } catch (error) {
      console.error('Error in SalesRfq.getStats:', error);
      throw error;
    }
  }

  static async delete(id, deletedBy) {
    try {
      const result = await db.query(
        'UPDATE sales_rfqs SET deleted_at = CURRENT_TIMESTAMP, updated_by = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING *',
        [id, deletedBy]
      );

      return result.rows[0] || null;
    } catch (error) {
      console.error('Error in SalesRfq.delete:', error);
      throw error;
    }
  }

  static async addCommunication(rfqId, communicationData, createdBy) {
    try {
      const query = `
        INSERT INTO sales_rfq_communications (
          sales_rfq_id, communication_type, direction, subject, message_content,
          sender_name, sender_email, recipient_name, recipient_email, 
          attachment_urls, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
      `;

      const values = [
        rfqId,
        communicationData.communication_type,
        communicationData.direction,
        communicationData.subject,
        communicationData.message_content,
        communicationData.sender_name,
        communicationData.sender_email,
        communicationData.recipient_name,
        communicationData.recipient_email,
        communicationData.attachment_urls || null,
        createdBy
      ];

      const result = await db.query(query, values);
      return result.rows[0];
    } catch (error) {
      console.error('Error in SalesRfq.addCommunication:', error);
      throw error;
    }
  }

  static async getCommunications(rfqId) {
    try {
      const query = `
        SELECT 
          sc.*,
          u.first_name || ' ' || u.last_name as created_by_name
        FROM sales_rfq_communications sc
        LEFT JOIN users u ON sc.created_by = u.id
        WHERE sc.sales_rfq_id = $1
        ORDER BY sc.created_at DESC
      `;

      const result = await db.query(query, [rfqId]);
      return result.rows;
    } catch (error) {
      console.error('Error in SalesRfq.getCommunications:', error);
      throw error;
    }
  }

  // Dual Approval Workflow Methods

  static async requestApproval(id, requestedBy, notes = '') {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Update RFQ status to pending dual approval
      const updateQuery = `
        UPDATE sales_rfqs 
        SET 
          status = 'PENDING_DUAL_APPROVAL',
          sales_approval_status = 'PENDING',
          procurement_approval_status = 'PENDING',
          overall_approval_status = 'PENDING',
          updated_by = $2,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *
      `;

      const result = await client.query(updateQuery, [id, requestedBy]);
      
      if (result.rows.length === 0) {
        throw new Error('Sales RFQ not found');
      }

      const rfq = result.rows[0];

      // Add status history
      await client.query(
        `INSERT INTO sales_rfq_status_history (sales_rfq_id, status, changed_by, change_reason) 
         VALUES ($1, $2, $3, $4)`,
        [id, 'PENDING_DUAL_APPROVAL', requestedBy, notes || 'Submitted for dual approval']
      );

      // Create notifications for both departments
      const Notification = require('./Notification');
      
      // Get users with sales approval authority
      const salesApprovers = await this.getSalesApprovers(rfq.supplier_total_amount || 0);
      for (const approver of salesApprovers) {
        await Notification.create({
          user_id: approver.user_id,
          type: 'SALES_RFQ_SUBMITTED_FOR_SALES_APPROVAL',
          title: `Sales RFQ Requires Sales Approval: ${rfq.rfq_number}`,
          message: `Sales RFQ ${rfq.rfq_number} has been submitted and requires sales team approval before proceeding to procurement review.`,
          data: { sales_rfq_id: id, rfq_number: rfq.rfq_number }
        });
      }

      // Get users with procurement approval authority  
      const procurementApprovers = await this.getProcurementApprovers(rfq.supplier_total_amount || 0);
      for (const approver of procurementApprovers) {
        await Notification.create({
          user_id: approver.user_id,
          type: 'SALES_RFQ_SUBMITTED_FOR_PROCUREMENT_APPROVAL',
          title: `Sales RFQ Requires Procurement Approval: ${rfq.rfq_number}`,
          message: `Sales RFQ ${rfq.rfq_number} has been submitted and requires procurement team approval for supplier engagement.`,
          data: { sales_rfq_id: id, rfq_number: rfq.rfq_number }
        });
      }

      await client.query('COMMIT');
      return await this.findById(id);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesRfq.requestApproval:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async approveBySales(id, approvedBy, approvalNotes = '') {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Update sales approval status
      const updateQuery = `
        UPDATE sales_rfqs 
        SET 
          sales_approval_status = 'APPROVED',
          sales_approved_by = $2,
          sales_approved_at = CURRENT_TIMESTAMP,
          sales_approval_notes = $3,
          overall_approval_status = CASE 
            WHEN procurement_approval_status = 'APPROVED' THEN 'FULLY_APPROVED'
            ELSE 'SALES_APPROVED'
          END,
          status = CASE 
            WHEN procurement_approval_status = 'APPROVED' THEN 'APPROVED'
            ELSE 'PENDING_PROCUREMENT_APPROVAL'
          END,
          updated_by = $2,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *
      `;

      const result = await client.query(updateQuery, [id, approvedBy, approvalNotes]);
      
      if (result.rows.length === 0) {
        throw new Error('Sales RFQ not found');
      }

      const rfq = result.rows[0];

      // Add status history
      await client.query(
        `INSERT INTO sales_rfq_status_history (sales_rfq_id, status, changed_by, change_reason) 
         VALUES ($1, $2, $3, $4)`,
        [id, rfq.status, approvedBy, `Sales approved: ${approvalNotes}`]
      );

      const Notification = require('./Notification');

      // Notify RFQ creator
      if (rfq.created_by) {
        await Notification.create({
          user_id: rfq.created_by,
          type: 'SALES_RFQ_SALES_APPROVED',
          title: `Sales RFQ Sales Approved: ${rfq.rfq_number}`,
          message: `Your Sales RFQ ${rfq.rfq_number} has been approved by the sales team. ${rfq.overall_approval_status === 'FULLY_APPROVED' ? 'RFQ is now fully approved and ready to send to supplier.' : 'Awaiting procurement approval.'}`,
          data: { sales_rfq_id: id, rfq_number: rfq.rfq_number }
        });
      }

      // If fully approved, notify procurement team and prepare for supplier sending
      if (rfq.overall_approval_status === 'FULLY_APPROVED') {
        const procurementApprovers = await this.getProcurementApprovers(0);
        for (const approver of procurementApprovers) {
          await Notification.create({
            user_id: approver.user_id,
            type: 'SALES_RFQ_FULLY_APPROVED',
            title: `Sales RFQ Fully Approved: ${rfq.rfq_number}`,
            message: `Sales RFQ ${rfq.rfq_number} has been fully approved by both departments and is ready to send to supplier.`,
            data: { sales_rfq_id: id, rfq_number: rfq.rfq_number }
          });
        }
      }

      await client.query('COMMIT');
      return await this.findById(id);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesRfq.approveBySales:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async approveByProcurement(id, approvedBy, approvalNotes = '') {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Update procurement approval status
      const updateQuery = `
        UPDATE sales_rfqs 
        SET 
          procurement_approval_status = 'APPROVED',
          procurement_approved_by = $2,
          procurement_approved_at = CURRENT_TIMESTAMP,
          procurement_approval_notes = $3,
          overall_approval_status = CASE 
            WHEN sales_approval_status = 'APPROVED' THEN 'FULLY_APPROVED'
            ELSE 'PROCUREMENT_APPROVED'
          END,
          status = CASE 
            WHEN sales_approval_status = 'APPROVED' THEN 'APPROVED'
            ELSE 'PENDING_SALES_APPROVAL'
          END,
          updated_by = $2,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *
      `;

      const result = await client.query(updateQuery, [id, approvedBy, approvalNotes]);
      
      if (result.rows.length === 0) {
        throw new Error('Sales RFQ not found');
      }

      const rfq = result.rows[0];

      // Add status history
      await client.query(
        `INSERT INTO sales_rfq_status_history (sales_rfq_id, status, changed_by, change_reason) 
         VALUES ($1, $2, $3, $4)`,
        [id, rfq.status, approvedBy, `Procurement approved: ${approvalNotes}`]
      );

      const Notification = require('./Notification');

      // Notify RFQ creator
      if (rfq.created_by) {
        await Notification.create({
          user_id: rfq.created_by,
          type: 'SALES_RFQ_PROCUREMENT_APPROVED',
          title: `Sales RFQ Procurement Approved: ${rfq.rfq_number}`,
          message: `Your Sales RFQ ${rfq.rfq_number} has been approved by the procurement team. ${rfq.overall_approval_status === 'FULLY_APPROVED' ? 'RFQ is now fully approved and ready to send to supplier.' : 'Awaiting sales approval.'}`,
          data: { sales_rfq_id: id, rfq_number: rfq.rfq_number }
        });
      }

      // Note: Auto-send removed - users will manually send via "Send to Supplier" button

      await client.query('COMMIT');
      return await this.findById(id);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesRfq.approveByProcurement:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async rejectBySales(id, rejectedBy, rejectionReason) {
    return this.rejectByDepartment(id, rejectedBy, rejectionReason, 'sales');
  }

  static async rejectByProcurement(id, rejectedBy, rejectionReason) {
    return this.rejectByDepartment(id, rejectedBy, rejectionReason, 'procurement');
  }

  static async rejectByDepartment(id, rejectedBy, rejectionReason, department) {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      const updateFields = department === 'sales' ? 
        'sales_approval_status = $2, sales_approved_by = $3, sales_approval_notes = $4' :
        'procurement_approval_status = $2, procurement_approved_by = $3, procurement_approval_notes = $4';

      const updateQuery = `
        UPDATE sales_rfqs 
        SET 
          ${updateFields},
          overall_approval_status = 'REJECTED',
          status = 'REJECTED',
          updated_by = $3,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *
      `;

      const result = await client.query(updateQuery, [id, 'REJECTED', rejectedBy, rejectionReason]);
      
      if (result.rows.length === 0) {
        throw new Error('Sales RFQ not found');
      }

      const rfq = result.rows[0];

      // Add status history
      await client.query(
        `INSERT INTO sales_rfq_status_history (sales_rfq_id, status, changed_by, change_reason) 
         VALUES ($1, $2, $3, $4)`,
        [id, 'REJECTED', rejectedBy, `Rejected by ${department}: ${rejectionReason}`]
      );

      const Notification = require('./Notification');

      // Notify RFQ creator
      if (rfq.created_by) {
        await Notification.create({
          user_id: rfq.created_by,
          type: department === 'sales' ? 'SALES_RFQ_SALES_REJECTED' : 'SALES_RFQ_PROCUREMENT_REJECTED',
          title: `Sales RFQ Rejected: ${rfq.rfq_number}`,
          message: `Your Sales RFQ ${rfq.rfq_number} has been rejected by the ${department} team. Reason: ${rejectionReason}`,
          data: { sales_rfq_id: id, rfq_number: rfq.rfq_number }
        });
      }

      await client.query('COMMIT');
      return await this.findById(id);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`Error in SalesRfq.rejectBy${department}:`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async sendToSupplier(id, sentBy) {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Generate response token for supplier portal (expiring, single-use)
      const { generateToken, expiryDate } = require('../services/portalTokens');
      const responseToken = generateToken();

      // Update status to sent and add response token
      const updateQuery = `
        UPDATE sales_rfqs
        SET
          status = 'SENT',
          response_token = $3,
          response_token_expires_at = $4,
          response_token_used_at = NULL,
          sent_at = CURRENT_TIMESTAMP,
          updated_by = $2,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND overall_approval_status = 'FULLY_APPROVED' AND deleted_at IS NULL
        RETURNING *
      `;

      const result = await client.query(updateQuery, [id, sentBy, responseToken, expiryDate()]);
      
      if (result.rows.length === 0) {
        throw new Error('Sales RFQ not found or not fully approved');
      }

      const rfq = result.rows[0];

      // Add status history
      await client.query(
        `INSERT INTO sales_rfq_status_history (sales_rfq_id, status, changed_by, change_reason) 
         VALUES ($1, $2, $3, $4)`,
        [id, 'SENT', sentBy, 'RFQ sent to supplier']
      );

      // Send email to supplier with response token
      const supplierEmailService = require('../services/supplierEmailService');
      const fullRfq = await this.findById(id);
      
      try {
        await supplierEmailService.sendSalesRFQEmail(fullRfq, responseToken);
        console.log(`Sales RFQ ${rfq.rfq_number} sent to supplier ${rfq.supplier_email} with response token`);
      } catch (emailError) {
        console.error('Error sending RFQ email to supplier:', emailError);
        // Don't fail the transaction for email errors, but log it
      }

      const Notification = require('./Notification');

      // Notify RFQ creator
      if (rfq.created_by) {
        await Notification.create({
          user_id: rfq.created_by,
          type: 'SALES_RFQ_SENT_TO_SUPPLIER',
          title: `Sales RFQ Sent to Supplier: ${rfq.rfq_number}`,
          message: `Sales RFQ ${rfq.rfq_number} has been sent to supplier ${rfq.supplier_name}. Awaiting supplier response.`,
          data: { sales_rfq_id: id, rfq_number: rfq.rfq_number }
        });
      }

      await client.query('COMMIT');
      return await this.findById(id);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesRfq.sendToSupplier:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  // Helper methods for getting approvers
  static async getSalesApprovers(amount) {
    try {
      const DelegationOfAuthority = require('./DelegationOfAuthority');
      return await DelegationOfAuthority.getApprovers('SALES_RFQ', amount);
    } catch (error) {
      console.error('Error getting sales approvers:', error);
      return [];
    }
  }

  static async getProcurementApprovers(amount) {
    try {
      const DelegationOfAuthority = require('./DelegationOfAuthority');
      return await DelegationOfAuthority.getApprovers('SALES_RFQ', amount);
    } catch (error) {
      console.error('Error getting procurement approvers:', error);
      return [];
    }
  }

  // Get pending approvals for a specific user
  static async getPendingSalesApprovals(userId) {
    try {
      const DelegationOfAuthority = require('./DelegationOfAuthority');
      const canApprove = await DelegationOfAuthority.canApproveSalesTransaction(userId, 0, 'SALES_RFQ');
      
      if (!canApprove) {
        return [];
      }

      const query = `
        SELECT 
          sr.*,
          s.legal_name as supplier_company_name,
          c.customer_name as customer_company_name,
          u_created.first_name || ' ' || u_created.last_name as created_by_name,
          COUNT(sri.id) as item_count
        FROM sales_rfqs sr
        LEFT JOIN suppliers s ON sr.supplier_id = s.id
        LEFT JOIN customers c ON sr.linked_customer_id = c.id
        LEFT JOIN users u_created ON sr.created_by = u_created.id
        LEFT JOIN sales_rfq_items sri ON sr.id = sri.sales_rfq_id
        WHERE sr.deleted_at IS NULL 
          AND sr.sales_approval_status = 'PENDING'
          AND sr.status IN ('PENDING_DUAL_APPROVAL', 'PENDING_SALES_APPROVAL')
        GROUP BY sr.id, s.legal_name, c.customer_name, u_created.first_name, u_created.last_name
        ORDER BY sr.created_at DESC
      `;

      const result = await db.query(query);
      return result.rows;
    } catch (error) {
      console.error('Error in SalesRfq.getPendingSalesApprovals:', error);
      throw error;
    }
  }

  static async getPendingProcurementApprovals(userId) {
    try {
      const DelegationOfAuthority = require('./DelegationOfAuthority');
      const canApprove = await DelegationOfAuthority.canApproveSalesTransaction(userId, 0, 'SALES_RFQ');
      
      if (!canApprove) {
        return [];
      }

      const query = `
        SELECT 
          sr.*,
          s.legal_name as supplier_company_name,
          c.customer_name as customer_company_name,
          u_created.first_name || ' ' || u_created.last_name as created_by_name,
          COUNT(sri.id) as item_count
        FROM sales_rfqs sr
        LEFT JOIN suppliers s ON sr.supplier_id = s.id
        LEFT JOIN customers c ON sr.linked_customer_id = c.id
        LEFT JOIN users u_created ON sr.created_by = u_created.id
        LEFT JOIN sales_rfq_items sri ON sr.id = sri.sales_rfq_id
        WHERE sr.deleted_at IS NULL 
          AND sr.procurement_approval_status = 'PENDING'
          AND sr.status IN ('PENDING_DUAL_APPROVAL', 'PENDING_PROCUREMENT_APPROVAL')
        GROUP BY sr.id, s.legal_name, c.customer_name, u_created.first_name, u_created.last_name
        ORDER BY sr.created_at DESC
      `;

      const result = await db.query(query);
      return result.rows;
    } catch (error) {
      console.error('Error in SalesRfq.getPendingProcurementApprovals:', error);
      throw error;
    }
  }
}

module.exports = SalesRfq;