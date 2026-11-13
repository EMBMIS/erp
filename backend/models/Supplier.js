const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const NotificationService = require('../services/notificationService');
const EmailService = require('../services/emailService');

class Supplier {
  static async create(supplierData, userId) {
    const {
      legal_name,
      trade_name,
      email,
      phone,
      address,
      country,
      city,
      postal_code,
      supplier_type = 'TRANSACTIONAL',
      certification_status = 'PENDING',
      payment_terms = '30 DAYS NET',
      currency = 'USD',
      status = 'DRAFT'
    } = supplierData;

    const id = uuidv4();
    
    // Generate supplier code
    const codeResult = await pool.query('SELECT generate_supplier_code() as code');
    const supplier_code = codeResult.rows[0].code;

    const query = `
      INSERT INTO suppliers (
        id, supplier_code, legal_name, trade_name, email, phone, address, 
        country, city, postal_code, supplier_type, certification_status, 
        payment_terms, currency, status, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING *
    `;

    const values = [
      id, supplier_code, legal_name, trade_name, email, phone, address,
      country, city, postal_code, supplier_type, certification_status,
      payment_terms, currency, status, userId
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
      SELECT s.*, 
             u1.first_name || ' ' || u1.last_name as created_by_name,
             u2.first_name || ' ' || u2.last_name as approved_by_name
      FROM suppliers s
      LEFT JOIN users u1 ON s.created_by = u1.id
      LEFT JOIN users u2 ON s.approved_by = u2.id
    `;
    
    let conditions = [];
    let values = [];
    let paramIndex = 1;

    // Filter by user if provided (suppliers created by user)
    if (userId) {
      conditions.push(`s.created_by = $${paramIndex}`);
      values.push(userId);
      paramIndex++;
    }

    if (filters.status) {
      conditions.push(`s.status = $${paramIndex}`);
      values.push(filters.status);
      paramIndex++;
    }

    if (filters.supplier_type) {
      conditions.push(`s.supplier_type = $${paramIndex}`);
      values.push(filters.supplier_type);
      paramIndex++;
    }

    if (filters.certification_status) {
      conditions.push(`s.certification_status = $${paramIndex}`);
      values.push(filters.certification_status);
      paramIndex++;
    }

    if (filters.search) {
      conditions.push(`(s.legal_name ILIKE $${paramIndex} OR s.trade_name ILIKE $${paramIndex} OR s.supplier_code ILIKE $${paramIndex})`);
      values.push(`%${filters.search}%`);
      paramIndex++;
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY s.created_at DESC';

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
      SELECT s.*,
             u1.first_name || ' ' || u1.last_name as created_by_name,
             u2.first_name || ' ' || u2.last_name as approved_by_name
      FROM suppliers s
      LEFT JOIN users u1 ON s.created_by = u1.id
      LEFT JOIN users u2 ON s.approved_by = u2.id
      WHERE s.id = $1
    `;
    
    let values = [id];
    
    if (userId) {
      query += ' AND s.created_by = $2';
      values.push(userId);
    }

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async findByCode(code, userId = null) {
    let query = 'SELECT * FROM suppliers WHERE supplier_code = $1';
    let values = [code];
    
    if (userId) {
      query += ' AND created_by = $2';
      values.push(userId);
    }

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async update(id, supplierData, userId = null) {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    const allowedFields = [
      'legal_name', 'trade_name', 'email', 'phone', 'address', 
      'country', 'city', 'postal_code', 'supplier_type', 
      'certification_status', 'payment_terms', 'currency', 'status'
    ];

    allowedFields.forEach(field => {
      if (supplierData.hasOwnProperty(field)) {
        fields.push(`${field} = $${paramIndex}`);
        values.push(supplierData[field]);
        paramIndex++;
      }
    });

    if (fields.length === 0) {
      throw new Error('No valid fields to update');
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');

    values.push(id);
    let query = `
      UPDATE suppliers 
      SET ${fields.join(', ')} 
      WHERE id = $${paramIndex}
    `;
    
    if (userId) {
      paramIndex++;
      values.push(userId);
      query += ` AND created_by = $${paramIndex}`;
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
    let query = 'DELETE FROM suppliers WHERE id = $1';
    let values = [id];
    
    if (userId) {
      query += ' AND created_by = $2';
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
        COUNT(CASE WHEN status = 'ACTIVE' THEN 1 END) as active,
        COUNT(CASE WHEN status = 'DRAFT' THEN 1 END) as draft,
        COUNT(CASE WHEN status = 'PENDING_APPROVAL' THEN 1 END) as pending_approval,
        COUNT(CASE WHEN certification_status = 'CERTIFIED' THEN 1 END) as certified,
        COUNT(CASE WHEN supplier_type = 'STRATEGIC' THEN 1 END) as strategic,
        COUNT(CASE WHEN supplier_type = 'PREFERRED' THEN 1 END) as preferred
      FROM suppliers
    `;
    
    let values = [];
    
    if (userId) {
      query += ' WHERE created_by = $1';
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
  static async findPendingApproval(userId = null) {
    let query = `
      SELECT s.*,
             u.first_name || ' ' || u.last_name as created_by_name
      FROM suppliers s
      LEFT JOIN users u ON s.created_by = u.id
      WHERE s.status = 'PENDING_APPROVAL'
    `;
    let values = [];
    
    if (userId) {
      query += ' AND s.created_by = $1';
      values.push(userId);
    }
    
    query += ' ORDER BY s.created_at DESC';

    try {
      const result = await pool.query(query, values);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  static async submitForApproval(id, userId = null) {
    let query = `
      UPDATE suppliers 
      SET status = 'PENDING_APPROVAL', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'DRAFT'
    `;
    
    let values = [id];
    
    if (userId) {
      query += ' AND created_by = $2';
      values.push(userId);
    }
    
    query += ' RETURNING *';
    
    try {
      const result = await pool.query(query, values);
      const submittedSupplier = result.rows[0];
      
      if (submittedSupplier) {
        // Create notification for managers about new supplier submission
        await NotificationService.createSupplierSubmittedNotification(submittedSupplier, userId);
      }
      
      return submittedSupplier;
    } catch (error) {
      throw error;
    }
  }

  static async approve(id, approvedBy) {
    const query = `
      UPDATE suppliers 
      SET status = 'PENDING_SUPPLIER_CONFIRMATION', 
          approved_by = $2, 
          approved_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'PENDING_APPROVAL'
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id, approvedBy]);
      const approvedSupplier = result.rows[0];
      
      if (approvedSupplier) {
        // Create notification for the original user about management approval
        await NotificationService.createSupplierApprovedNotification(approvedSupplier, approvedBy, approvedSupplier.created_by);
        
        // Send partnership invitation email to supplier for their confirmation
        try {
          const createdByUser = await pool.query('SELECT first_name || \' \' || last_name as name FROM users WHERE id = $1', [approvedSupplier.created_by]);
          const createdByName = createdByUser.rows[0]?.name || 'Simeli Team';
          
          await EmailService.sendSupplierOnboardingEmail(approvedSupplier, createdByName);
          console.log(`Partnership email sent to ${approvedSupplier.email} for confirmation`);
        } catch (emailError) {
          console.error('Error sending partnership email:', emailError);
          // Don't fail the approval if email fails
        }
      }
      
      return approvedSupplier;
    } catch (error) {
      throw error;
    }
  }

  static async decline(id, declinedBy, reason) {
    const query = `
      UPDATE suppliers 
      SET status = 'DECLINED',
          approved_by = $2,
          approved_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'PENDING_APPROVAL'
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id, declinedBy]);
      const declinedSupplier = result.rows[0];
      
      if (declinedSupplier) {
        // Create notification for the original user
        await NotificationService.createSupplierDeclinedNotification(declinedSupplier, declinedBy, declinedSupplier.created_by, reason);
      }
      
      return declinedSupplier;
    } catch (error) {
      throw error;
    }
  }

  static async certify(id, certifiedBy) {
    const query = `
      UPDATE suppliers 
      SET certification_status = 'CERTIFIED',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'ACTIVE'
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id]);
      const certifiedSupplier = result.rows[0];
      
      if (certifiedSupplier) {
        // Create notification for the original user
        await NotificationService.createSupplierCertifiedNotification(certifiedSupplier, certifiedBy, certifiedSupplier.created_by);
      }
      
      return certifiedSupplier;
    } catch (error) {
      throw error;
    }
  }

  static async decertify(id, decertifiedBy, reason) {
    const query = `
      UPDATE suppliers 
      SET certification_status = 'NOT_CERTIFIED',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id]);
      const decertifiedSupplier = result.rows[0];
      
      if (decertifiedSupplier) {
        // Create notification for the original user
        await NotificationService.createSupplierDecertifiedNotification(decertifiedSupplier, decertifiedBy, decertifiedSupplier.created_by, reason);
      }
      
      return decertifiedSupplier;
    } catch (error) {
      throw error;
    }
  }

  // Get active suppliers for dropdowns
  static async getActiveSuppliers() {
    const query = `
      SELECT id, supplier_code, legal_name, trade_name, certification_status, supplier_type
      FROM suppliers 
      WHERE status = 'ACTIVE' 
      ORDER BY legal_name
    `;

    try {
      const result = await pool.query(query);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  // Get active suppliers for dropdowns (filtered by user)
  static async getActiveSuppliersByUser(userId) {
    const query = `
      SELECT id, supplier_code, legal_name, trade_name, email, phone, 
             certification_status, supplier_type
      FROM suppliers 
      WHERE status = 'ACTIVE' AND created_by = $1
      ORDER BY legal_name
    `;

    try {
      const result = await pool.query(query, [userId]);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  // Get certified suppliers (for contracts)
  static async getCertifiedSuppliers() {
    const query = `
      SELECT id, supplier_code, legal_name, trade_name, supplier_type
      FROM suppliers 
      WHERE status = 'ACTIVE' AND certification_status = 'CERTIFIED'
      ORDER BY legal_name
    `;

    try {
      const result = await pool.query(query);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = Supplier;