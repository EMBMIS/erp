const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

class Contract {
  static async create(contractData, userId) {
    const {
      contract_name,
      supplier_id,
      contract_type = 'PURCHASE',
      start_date,
      end_date,
      payment_terms,
      incoterms,
      currency = 'USD',
      supplier_instructions,
      attachment_url,
      status = 'DRAFT'
    } = contractData;

    const id = uuidv4();
    
    // Generate contract number
    const numberResult = await pool.query('SELECT generate_contract_number() as number');
    const contract_number = numberResult.rows[0].number;

    const query = `
      INSERT INTO contracts (
        id, contract_number, contract_name, supplier_id, contract_type,
        start_date, end_date, payment_terms, incoterms, currency,
        supplier_instructions, attachment_url, status, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *
    `;

    const values = [
      id, contract_number, contract_name, supplier_id, contract_type,
      start_date, end_date, payment_terms, incoterms, currency,
      supplier_instructions, attachment_url, status, userId
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
      SELECT c.*,
             s.legal_name as supplier_name,
             s.supplier_code,
             u1.first_name || ' ' || u1.last_name as created_by_name,
             u2.first_name || ' ' || u2.last_name as approved_by_name,
             COUNT(ci.id) as item_count
      FROM contracts c
      LEFT JOIN suppliers s ON c.supplier_id = s.id
      LEFT JOIN users u1 ON c.created_by = u1.id
      LEFT JOIN users u2 ON c.approved_by = u2.id
      LEFT JOIN contract_items ci ON c.id = ci.contract_id
    `;
    
    let conditions = [];
    let values = [];
    let paramIndex = 1;

    // Filter by user if provided
    if (userId) {
      conditions.push(`c.created_by = $${paramIndex}`);
      values.push(userId);
      paramIndex++;
    }

    if (filters.status) {
      conditions.push(`c.status = $${paramIndex}`);
      values.push(filters.status);
      paramIndex++;
    }

    if (filters.supplier_id) {
      conditions.push(`c.supplier_id = $${paramIndex}`);
      values.push(filters.supplier_id);
      paramIndex++;
    }

    if (filters.contract_type) {
      conditions.push(`c.contract_type = $${paramIndex}`);
      values.push(filters.contract_type);
      paramIndex++;
    }

    if (filters.search) {
      conditions.push(`(c.contract_name ILIKE $${paramIndex} OR c.contract_number ILIKE $${paramIndex} OR s.legal_name ILIKE $${paramIndex})`);
      values.push(`%${filters.search}%`);
      paramIndex++;
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' GROUP BY c.id, s.legal_name, s.supplier_code, u1.first_name, u1.last_name, u2.first_name, u2.last_name';
    query += ' ORDER BY c.created_at DESC';

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
      SELECT c.*,
             s.legal_name as supplier_name,
             s.supplier_code,
             s.email as supplier_email,
             s.phone as supplier_phone,
             u1.first_name || ' ' || u1.last_name as created_by_name,
             u2.first_name || ' ' || u2.last_name as approved_by_name
      FROM contracts c
      LEFT JOIN suppliers s ON c.supplier_id = s.id
      LEFT JOIN users u1 ON c.created_by = u1.id
      LEFT JOIN users u2 ON c.approved_by = u2.id
      WHERE c.id = $1
    `;
    
    let values = [id];
    
    if (userId) {
      query += ' AND c.created_by = $2';
      values.push(userId);
    }

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async update(id, contractData, userId = null) {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    const allowedFields = [
      'contract_name', 'supplier_id', 'contract_type', 'start_date', 'end_date',
      'payment_terms', 'incoterms', 'currency', 'supplier_instructions', 
      'attachment_url', 'status'
    ];

    allowedFields.forEach(field => {
      if (contractData.hasOwnProperty(field)) {
        fields.push(`${field} = $${paramIndex}`);
        values.push(contractData[field]);
        paramIndex++;
      }
    });

    if (fields.length === 0) {
      throw new Error('No valid fields to update');
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');

    values.push(id);
    let query = `
      UPDATE contracts 
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
    let query = 'DELETE FROM contracts WHERE id = $1';
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

  // Contract Items Management
  static async addItem(contractId, itemData) {
    const {
      item_id,
      unit_price,
      currency = 'USD',
      lead_time_days = 30,
      moq = 1
    } = itemData;

    const id = uuidv4();

    const query = `
      INSERT INTO contract_items (id, contract_id, item_id, unit_price, currency, lead_time_days, moq)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `;

    const values = [id, contractId, item_id, unit_price, currency, lead_time_days, moq];

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async removeItem(contractId, itemId) {
    const query = `
      DELETE FROM contract_items 
      WHERE contract_id = $1 AND item_id = $2
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [contractId, itemId]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async getItems(contractId) {
    const query = `
      SELECT ci.*,
             i.name as item_name,
             i.approved_item_code,
             i.description as item_description,
             i.unit_of_measure
      FROM contract_items ci
      JOIN items i ON ci.item_id = i.id
      WHERE ci.contract_id = $1
      ORDER BY i.name
    `;

    try {
      const result = await pool.query(query, [contractId]);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  // Contract lifecycle methods
  static async sendToSupplier(id, userId) {
    const query = `
      UPDATE contracts 
      SET status = 'SENT_TO_SUPPLIER', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'DRAFT' AND created_by = $2
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id, userId]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async markUnderReview(id) {
    const query = `
      UPDATE contracts 
      SET status = 'UNDER_REVIEW', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'SENT_TO_SUPPLIER'
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async activate(id, approvedBy) {
    const query = `
      UPDATE contracts 
      SET status = 'ACTIVE', 
          approved_by = $2,
          approved_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'UNDER_REVIEW'
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id, approvedBy]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async terminate(id, reason) {
    const query = `
      UPDATE contracts 
      SET status = 'TERMINATED', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'ACTIVE'
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Get active contracts
  static async getActiveContracts(supplierId = null) {
    let query = `
      SELECT c.*, s.legal_name as supplier_name, s.supplier_code
      FROM contracts c
      JOIN suppliers s ON c.supplier_id = s.id
      WHERE c.status = 'ACTIVE'
    `;
    
    let values = [];
    
    if (supplierId) {
      query += ' AND c.supplier_id = $1';
      values.push(supplierId);
    }
    
    query += ' ORDER BY c.contract_name';

    try {
      const result = await pool.query(query, values);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  // Get contract pricing for an item
  static async getItemPrice(contractId, itemId) {
    const query = `
      SELECT ci.*
      FROM contract_items ci
      WHERE ci.contract_id = $1 AND ci.item_id = $2
    `;

    try {
      const result = await pool.query(query, [contractId, itemId]);
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
        COUNT(CASE WHEN status = 'SENT_TO_SUPPLIER' THEN 1 END) as sent_to_supplier,
        COUNT(CASE WHEN status = 'UNDER_REVIEW' THEN 1 END) as under_review,
        COUNT(CASE WHEN end_date < CURRENT_DATE AND status = 'ACTIVE' THEN 1 END) as expired
      FROM contracts
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

  // Get contracts expiring soon
  static async getExpiringContracts(daysAhead = 30) {
    const query = `
      SELECT c.*, s.legal_name as supplier_name, s.supplier_code
      FROM contracts c
      JOIN suppliers s ON c.supplier_id = s.id
      WHERE c.status = 'ACTIVE' 
        AND c.end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '${daysAhead} days'
      ORDER BY c.end_date ASC
    `;

    try {
      const result = await pool.query(query);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  // DoA Approval Methods
  static async submitForApproval(id, userId = null) {
    let query = `
      UPDATE contracts 
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
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async getPendingApprovals(userId = null) {
    let query = `
      SELECT c.*,
             s.legal_name as supplier_name,
             s.supplier_code,
             u.first_name || ' ' || u.last_name as created_by_name
      FROM contracts c
      LEFT JOIN suppliers s ON c.supplier_id = s.id
      LEFT JOIN users u ON c.created_by = u.id
      WHERE c.status = 'PENDING_APPROVAL'
    `;
    let values = [];
    
    if (userId) {
      query += ' AND c.created_by = $1';
      values.push(userId);
    }
    
    query += ' ORDER BY c.created_at ASC';

    try {
      const result = await pool.query(query, values);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  static async approveContract(id, approvedBy) {
    const query = `
      UPDATE contracts 
      SET status = 'DRAFT', 
          approved_by = $2, 
          approved_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'PENDING_APPROVAL'
      RETURNING *
    `;
    try {
      const result = await pool.query(query, [id, approvedBy]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async declineContract(id, declinedBy, reason = null) {
    const query = `
      UPDATE contracts 
      SET status = 'DECLINED',
          approved_by = $2,
          approved_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'PENDING_APPROVAL'
      RETURNING *
    `;
    try {
      const result = await pool.query(query, [id, declinedBy]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Supplier Workflow Methods
  static async sendToSupplier(id, sentBy) {
    const { generateToken, expiryDate } = require('../services/portalTokens');
    const responseToken = generateToken();
    const responseDue = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days from now

    const query = `
      UPDATE contracts
      SET status = 'SENT_TO_SUPPLIER',
          sent_to_supplier_at = CURRENT_TIMESTAMP,
          supplier_response_due = $2,
          supplier_response_token = $3,
          supplier_response_token_expires_at = $4,
          supplier_response_token_used_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'PENDING_APPROVAL'
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id, responseDue, responseToken, expiryDate(7)]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async supplierAcceptContract(id, token) {
    const query = `
      UPDATE contracts
      SET status = 'UNDER_REVIEW',
          supplier_accepted_at = CURRENT_TIMESTAMP,
          supplier_response_token_used_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND supplier_response_token = $2 AND status = 'SENT_TO_SUPPLIER'
        AND supplier_response_due > CURRENT_TIMESTAMP
        AND supplier_response_token_used_at IS NULL
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id, token]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async supplierDeclineContract(id, token, reason = null) {
    const query = `
      UPDATE contracts
      SET status = 'SUPPLIER_DECLINED',
          supplier_declined_at = CURRENT_TIMESTAMP,
          supplier_response_token_used_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND supplier_response_token = $2 AND status = 'SENT_TO_SUPPLIER'
        AND supplier_response_due > CURRENT_TIMESTAMP
        AND supplier_response_token_used_at IS NULL
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id, token]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async getContractByToken(token) {
    const query = `
      SELECT c.*,
             s.legal_name as supplier_name,
             s.email as supplier_email,
             s.supplier_code
      FROM contracts c
      LEFT JOIN suppliers s ON c.supplier_id = s.id
      WHERE c.supplier_response_token = $1
        AND (c.supplier_response_token_expires_at IS NULL OR c.supplier_response_token_expires_at > NOW())
        AND c.supplier_response_token_used_at IS NULL
    `;

    try {
      const result = await pool.query(query, [token]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async startProcurementReview(id, reviewedBy) {
    const query = `
      UPDATE contracts 
      SET status = 'UNDER_REVIEW',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'SUPPLIER_ACCEPTED'
      RETURNING *
    `;
    
    try {
      const result = await pool.query(query, [id]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async markContractSigned(id, signedBy, notes = null) {
    const query = `
      UPDATE contracts 
      SET status = 'ACTIVE',
          signed_at = CURRENT_TIMESTAMP,
          signed_by = $2,
          procurement_validation_notes = $3,
          final_approved_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'UNDER_REVIEW'
      RETURNING *
    `;
    
    try {
      const result = await pool.query(query, [id, signedBy, notes]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async activateContract(id, approvedBy) {
    const query = `
      UPDATE contracts 
      SET status = 'ACTIVE',
          final_approved_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'SIGNED'
      RETURNING *
    `;
    
    try {
      const result = await pool.query(query, [id]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async expireSupplierContracts() {
    const query = `
      UPDATE contracts 
      SET status = 'EXPIRED',
          updated_at = CURRENT_TIMESTAMP
      WHERE status = 'SENT_TO_SUPPLIER'
        AND supplier_response_due < CURRENT_TIMESTAMP
      RETURNING *
    `;
    
    try {
      const result = await pool.query(query);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  static async getContractsForSupplierReview() {
    const query = `
      SELECT c.*,
             s.legal_name as supplier_name,
             s.supplier_code,
             u.first_name || ' ' || u.last_name as created_by_name
      FROM contracts c
      LEFT JOIN suppliers s ON c.supplier_id = s.id
      LEFT JOIN users u ON c.created_by = u.id
      WHERE c.status = 'UNDER_REVIEW'
      ORDER BY c.supplier_accepted_at ASC
    `;
    
    try {
      const result = await pool.query(query);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = Contract;