const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const NotificationService = require('../services/notificationService');

class PurchaseRequisition {
  // The browser forms send empty strings for UUID fields the user left
  // unselected (item_id, recommended_supplier_id). Postgres refuses '' as a
  // uuid ("invalid input syntax for type uuid") and PR creation 500s.
  // Normalize '' (and whitespace) to NULL here so an unset reference is a
  // real NULL, which the schema allows.
  static normalizeUuid(value) {
    if (value === null || value === undefined) return null;
    return String(value).trim() === '' ? null : value;
  }

  static async create(prData, userId) {
    const {
      cost_center,
      item_id,
      item_description,
      unit_of_measure,
      quantity,
      estimated_unit_price,
      currency = 'USD',
      recommended_supplier_id,
      supplier_recommendation_text,
      attachments = [],
      status = 'DRAFT'
    } = prData;

    const id = uuidv4();
    
    // Generate PR number
    const numberResult = await pool.query('SELECT generate_pr_number() as number');
    const pr_number = numberResult.rows[0].number;

    const query = `
      INSERT INTO purchase_requisitions (
        id, pr_number, cost_center, requested_by, item_id, item_description,
        unit_of_measure, quantity, estimated_unit_price, currency,
        recommended_supplier_id, supplier_recommendation_text, attachments, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *
    `;

    const values = [
      id, pr_number, cost_center, userId, this.normalizeUuid(item_id), item_description,
      unit_of_measure, quantity, estimated_unit_price, currency,
      this.normalizeUuid(recommended_supplier_id), supplier_recommendation_text,
      JSON.stringify(attachments), status
    ];

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async findAll(filters = {}, userId = null) {
    let query = `
      SELECT pr.*,
             u1.first_name || ' ' || u1.last_name as requested_by_name,
             u2.first_name || ' ' || u2.last_name as approved_by_name,
             i.name as item_name,
             i.approved_item_code,
             s.legal_name as recommended_supplier_name,
             s.supplier_code as recommended_supplier_code
      FROM purchase_requisitions pr
      LEFT JOIN users u1 ON pr.requested_by = u1.id
      LEFT JOIN users u2 ON pr.approved_by = u2.id
      LEFT JOIN items i ON pr.item_id = i.id
      LEFT JOIN suppliers s ON pr.recommended_supplier_id = s.id
    `;
    
    let conditions = [];
    let values = [];
    let paramIndex = 1;

    // Filter by user if provided
    if (userId) {
      conditions.push(`pr.requested_by = $${paramIndex}`);
      values.push(userId);
      paramIndex++;
    }

    if (filters.status) {
      conditions.push(`pr.status = $${paramIndex}`);
      values.push(filters.status);
      paramIndex++;
    }

    if (filters.cost_center) {
      conditions.push(`pr.cost_center = $${paramIndex}`);
      values.push(filters.cost_center);
      paramIndex++;
    }

    if (filters.item_id) {
      conditions.push(`pr.item_id = $${paramIndex}`);
      values.push(filters.item_id);
      paramIndex++;
    }

    if (filters.recommended_supplier_id) {
      conditions.push(`pr.recommended_supplier_id = $${paramIndex}`);
      values.push(filters.recommended_supplier_id);
      paramIndex++;
    }

    if (filters.search) {
      conditions.push(`(pr.pr_number ILIKE $${paramIndex} OR pr.item_description ILIKE $${paramIndex} OR i.name ILIKE $${paramIndex})`);
      values.push(`%${filters.search}%`);
      paramIndex++;
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY pr.created_at DESC';

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
      SELECT pr.*,
             u1.first_name || ' ' || u1.last_name as requested_by_name,
             u2.first_name || ' ' || u2.last_name as approved_by_name,
             i.name as item_name,
             i.approved_item_code,
             i.description as item_full_description,
             s.legal_name as recommended_supplier_name,
             s.supplier_code as recommended_supplier_code,
             s.email as recommended_supplier_email,
             s.phone as recommended_supplier_phone
      FROM purchase_requisitions pr
      LEFT JOIN users u1 ON pr.requested_by = u1.id
      LEFT JOIN users u2 ON pr.approved_by = u2.id
      LEFT JOIN items i ON pr.item_id = i.id
      LEFT JOIN suppliers s ON pr.recommended_supplier_id = s.id
      WHERE pr.id = $1
    `;
    
    let values = [id];
    
    if (userId) {
      query += ' AND pr.requested_by = $2';
      values.push(userId);
    }

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async update(id, prData, userId = null) {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    const allowedFields = [
      'cost_center', 'item_id', 'item_description', 'unit_of_measure',
      'quantity', 'estimated_unit_price', 'currency', 'recommended_supplier_id',
      'supplier_recommendation_text', 'attachments', 'status'
    ];

    allowedFields.forEach(field => {
      if (prData.hasOwnProperty(field)) {
        if (field === 'attachments') {
          fields.push(`${field} = $${paramIndex}`);
          values.push(JSON.stringify(prData[field]));
        } else if (field === 'item_id' || field === 'recommended_supplier_id') {
          fields.push(`${field} = $${paramIndex}`);
          values.push(this.normalizeUuid(prData[field]));
        } else {
          fields.push(`${field} = $${paramIndex}`);
          values.push(prData[field]);
        }
        paramIndex++;
      }
    });

    if (fields.length === 0) {
      throw new Error('No valid fields to update');
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');

    values.push(id);
    let query = `
      UPDATE purchase_requisitions 
      SET ${fields.join(', ')} 
      WHERE id = $${paramIndex}
    `;
    
    if (userId) {
      paramIndex++;
      values.push(userId);
      query += ` AND requested_by = $${paramIndex}`;
    }
    
    query += ' RETURNING *';

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async delete(id, userId = null) {
    let query = 'DELETE FROM purchase_requisitions WHERE id = $1';
    let values = [id];
    
    if (userId) {
      query += ' AND requested_by = $2';
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
        COUNT(CASE WHEN status = 'DRAFT' THEN 1 END) as draft,
        COUNT(CASE WHEN status = 'SUBMITTED' THEN 1 END) as submitted,
        COUNT(CASE WHEN status = 'PENDING_APPROVAL' THEN 1 END) as pending_approval,
        COUNT(CASE WHEN status = 'APPROVED' THEN 1 END) as approved,
        COUNT(CASE WHEN status = 'DECLINED' THEN 1 END) as declined,
        SUM(CASE WHEN estimated_unit_price IS NOT NULL THEN quantity * estimated_unit_price ELSE 0 END) as total_estimated_value
      FROM purchase_requisitions
    `;
    
    let values = [];
    
    if (userId) {
      query += ' WHERE requested_by = $1';
      values.push(userId);
    }

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Approval workflow methods
  static async findPendingApproval() {
    const query = `
      SELECT pr.*,
             u.first_name || ' ' || u.last_name as requested_by_name,
             i.name as item_name,
             i.approved_item_code,
             s.legal_name as recommended_supplier_name
      FROM purchase_requisitions pr
      LEFT JOIN users u ON pr.requested_by = u.id
      LEFT JOIN items i ON pr.item_id = i.id
      LEFT JOIN suppliers s ON pr.recommended_supplier_id = s.id
      WHERE pr.status = 'PENDING_APPROVAL'
      ORDER BY pr.created_at DESC
    `;

    try {
      const result = await pool.query(query);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  static async submitForApproval(id, userId = null) {
    let query = `
      UPDATE purchase_requisitions 
      SET status = 'PENDING_APPROVAL', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status IN ('DRAFT', 'SUBMITTED')
    `;
    
    let values = [id];
    
    if (userId) {
      query += ' AND requested_by = $2';
      values.push(userId);
    }
    
    query += ' RETURNING *';
    
    try {
      const result = await pool.query(query, values);
      const submittedPR = result.rows[0];
      
      if (submittedPR) {
        // Create notification for managers about new PR submission
        await NotificationService.createPRSubmittedNotification(submittedPR, userId);
      }
      
      return submittedPR;
    } catch (error) {
      throw error;
    }
  }

  static async approve(id, approvedBy) {
    const query = `
      UPDATE purchase_requisitions 
      SET status = 'APPROVED', 
          approved_by = $2, 
          approved_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'PENDING_APPROVAL'
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id, approvedBy]);
      const approvedPR = result.rows[0];
      
      if (approvedPR) {
        // Create notification for the requester
        await NotificationService.createPRApprovedNotification(approvedPR, approvedBy, approvedPR.requested_by);
      }
      
      return approvedPR;
    } catch (error) {
      throw error;
    }
  }

  static async decline(id, declinedBy, reason) {
    const query = `
      UPDATE purchase_requisitions 
      SET status = 'DECLINED',
          approved_by = $2,
          approved_at = CURRENT_TIMESTAMP,
          decline_reason = $3,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'PENDING_APPROVAL'
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id, declinedBy, reason]);
      const declinedPR = result.rows[0];
      
      if (declinedPR) {
        // Create notification for the requester
        await NotificationService.createPRDeclinedNotification(declinedPR, declinedBy, declinedPR.requested_by, reason);
      }
      
      return declinedPR;
    } catch (error) {
      throw error;
    }
  }

  // Utility methods
  static async getByCostCenter(costCenter) {
    const query = `
      SELECT pr.*,
             u.first_name || ' ' || u.last_name as requested_by_name,
             i.name as item_name
      FROM purchase_requisitions pr
      LEFT JOIN users u ON pr.requested_by = u.id
      LEFT JOIN items i ON pr.item_id = i.id
      WHERE pr.cost_center = $1
      ORDER BY pr.created_at DESC
    `;

    try {
      const result = await pool.query(query, [costCenter]);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  static async getApprovedPRs() {
    const query = `
      SELECT pr.*,
             u1.first_name || ' ' || u1.last_name as requested_by_name,
             u2.first_name || ' ' || u2.last_name as approved_by_name,
             i.name as item_name,
             i.approved_item_code,
             s.legal_name as recommended_supplier_name
      FROM purchase_requisitions pr
      LEFT JOIN users u1 ON pr.requested_by = u1.id
      LEFT JOIN users u2 ON pr.approved_by = u2.id
      LEFT JOIN items i ON pr.item_id = i.id
      LEFT JOIN suppliers s ON pr.recommended_supplier_id = s.id
      WHERE pr.status = 'APPROVED'
      ORDER BY pr.approved_at DESC
    `;

    try {
      const result = await pool.query(query);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  // Check if PR can be converted to RFQ/PO
  static async canConvertToRFQ(id) {
    const query = `
      SELECT id, status FROM purchase_requisitions 
      WHERE id = $1 AND status = 'APPROVED'
    `;

    try {
      const result = await pool.query(query, [id]);
      return result.rows[0] !== undefined;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = PurchaseRequisition;