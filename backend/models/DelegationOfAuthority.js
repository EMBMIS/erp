const db = require('../config/database');
const { v4: uuidv4 } = require('uuid');

class DelegationOfAuthority {
  static async create(dofaData, userId) {
    const {
      cost_center,
      user_id,
      min_amount = 0,
      max_amount,
      currency = 'USD',
      applies_to = 'ALL',
      is_active = true,
      effective_from = new Date().toISOString().split('T')[0],
      effective_until,
      second_approver_id = null
    } = dofaData;

    const id = uuidv4();

    const query = `
      INSERT INTO delegation_of_authority (
        id, cost_center, user_id, min_amount, max_amount, currency,
        applies_to, is_active, effective_from, effective_until, created_by,
        second_approver_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `;

    const values = [
      id, cost_center, user_id, min_amount, max_amount, currency,
      applies_to, is_active, effective_from, effective_until, userId,
      second_approver_id
    ];

    try {
      const result = await db.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async findAll(filters = {}) {
    let query = `
      SELECT doa.*,
             u1.first_name || ' ' || u1.last_name as user_name,
             u1.email as user_email,
             u2.first_name || ' ' || u2.last_name as created_by_name,
             u3.first_name || ' ' || u3.last_name as second_approver_name,
             u3.email as second_approver_email
      FROM delegation_of_authority doa
      LEFT JOIN users u1 ON doa.user_id = u1.id
      LEFT JOIN users u2 ON doa.created_by = u2.id
      LEFT JOIN users u3 ON doa.second_approver_id = u3.id
    `;
    
    let conditions = [];
    let values = [];
    let paramIndex = 1;

    if (filters.user_id) {
      conditions.push(`doa.user_id = $${paramIndex}`);
      values.push(filters.user_id);
      paramIndex++;
    }

    if (filters.cost_center) {
      conditions.push(`doa.cost_center = $${paramIndex}`);
      values.push(filters.cost_center);
      paramIndex++;
    }

    if (filters.applies_to) {
      conditions.push(`doa.applies_to = $${paramIndex}`);
      values.push(filters.applies_to);
      paramIndex++;
    }

    if (filters.is_active !== undefined && filters.is_active !== '') {
      conditions.push(`doa.is_active = $${paramIndex}`);
      values.push(filters.is_active === 'true' || filters.is_active === true);
      paramIndex++;
    }

    if (filters.search) {
      conditions.push(`(doa.cost_center ILIKE $${paramIndex} OR u1.first_name ILIKE $${paramIndex} OR u1.last_name ILIKE $${paramIndex})`);
      values.push(`%${filters.search}%`);
      paramIndex++;
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY doa.cost_center, u1.first_name, u1.last_name';

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
      const result = await db.query(query, values);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  static async findById(id) {
    const query = `
      SELECT doa.*,
             u1.first_name || ' ' || u1.last_name as user_name,
             u1.email as user_email,
             u2.first_name || ' ' || u2.last_name as created_by_name,
             u3.first_name || ' ' || u3.last_name as second_approver_name,
             u3.email as second_approver_email
      FROM delegation_of_authority doa
      LEFT JOIN users u1 ON doa.user_id = u1.id
      LEFT JOIN users u2 ON doa.created_by = u2.id
      LEFT JOIN users u3 ON doa.second_approver_id = u3.id
      WHERE doa.id = $1
    `;

    try {
      const result = await db.query(query, [id]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async update(id, dofaData) {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    const allowedFields = [
      'cost_center', 'user_id', 'min_amount', 'max_amount', 'currency',
      'applies_to', 'is_active', 'effective_from', 'effective_until',
      'second_approver_id'
    ];

    allowedFields.forEach(field => {
      if (dofaData.hasOwnProperty(field)) {
        fields.push(`${field} = $${paramIndex}`);
        values.push(dofaData[field]);
        paramIndex++;
      }
    });

    if (fields.length === 0) {
      throw new Error('No valid fields to update');
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');

    values.push(id);
    const query = `
      UPDATE delegation_of_authority 
      SET ${fields.join(', ')} 
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    try {
      const result = await db.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async delete(id) {
    const query = 'DELETE FROM delegation_of_authority WHERE id = $1 RETURNING *';
    
    try {
      const result = await db.query(query, [id]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Check if a user has authority for a specific amount and transaction type
  static async checkAuthority(userId, amount, costCenter = null, transactionType = 'ALL') {
    let query = `
      SELECT doa.*,
             u.first_name || ' ' || u.last_name as user_name
      FROM delegation_of_authority doa
      LEFT JOIN users u ON doa.user_id = u.id
      WHERE doa.user_id = $1
        AND doa.is_active = TRUE
        AND doa.effective_from <= CURRENT_DATE
        AND (doa.effective_until IS NULL OR doa.effective_until >= CURRENT_DATE)
        AND doa.min_amount <= $2
        AND (doa.max_amount IS NULL OR doa.max_amount >= $2)
        AND (doa.applies_to = 'ALL' OR doa.applies_to = $3)
    `;
    
    let values = [userId, amount, transactionType];
    
    if (costCenter) {
      query += ' AND doa.cost_center = $4';
      values.push(costCenter);
    }
    
    query += ' ORDER BY doa.max_amount ASC LIMIT 1';

    try {
      const result = await db.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Get all users who have authority for a specific amount and transaction type
  static async getAuthorizedUsers(amount, costCenter = null, transactionType = 'ALL') {
    let query = `
      SELECT DISTINCT doa.user_id,
             u.first_name || ' ' || u.last_name as user_name,
             u.email as user_email,
             doa.cost_center,
             doa.max_amount
      FROM delegation_of_authority doa
      JOIN users u ON doa.user_id = u.id
      WHERE doa.is_active = TRUE
        AND doa.effective_from <= CURRENT_DATE
        AND (doa.effective_until IS NULL OR doa.effective_until >= CURRENT_DATE)
        AND doa.min_amount <= $1
        AND (doa.max_amount IS NULL OR doa.max_amount >= $1)
        AND (doa.applies_to = 'ALL' OR doa.applies_to = $2)
    `;
    
    let values = [amount, transactionType];
    
    if (costCenter) {
      query += ' AND doa.cost_center = $3';
      values.push(costCenter);
    }
    
    query += ' ORDER BY doa.max_amount ASC';

    try {
      const result = await db.query(query, values);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  // Get authority limits for a user
  static async getUserAuthority(userId, costCenter = null, transactionType = 'ALL') {
    let query = `
      SELECT doa.*,
             u.first_name || ' ' || u.last_name as user_name
      FROM delegation_of_authority doa
      LEFT JOIN users u ON doa.user_id = u.id
      WHERE doa.user_id = $1
        AND doa.is_active = TRUE
        AND doa.effective_from <= CURRENT_DATE
        AND (doa.effective_until IS NULL OR doa.effective_until >= CURRENT_DATE)
        AND (doa.applies_to = 'ALL' OR doa.applies_to = $2)
    `;
    
    let values = [userId, transactionType];
    
    if (costCenter) {
      query += ' AND doa.cost_center = $3';
      values.push(costCenter);
    }
    
    query += ' ORDER BY doa.max_amount DESC';

    try {
      const result = await db.query(query, values);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  // Get active authorities by cost center
  static async getByCostCenter(costCenter) {
    const query = `
      SELECT doa.*,
             u.first_name || ' ' || u.last_name as user_name,
             u.email as user_email
      FROM delegation_of_authority doa
      LEFT JOIN users u ON doa.user_id = u.id
      WHERE doa.cost_center = $1
        AND doa.is_active = TRUE
        AND doa.effective_from <= CURRENT_DATE
        AND (doa.effective_until IS NULL OR doa.effective_until >= CURRENT_DATE)
      ORDER BY doa.max_amount DESC
    `;

    try {
      const result = await db.query(query, [costCenter]);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  // Get expired authorities
  static async getExpiredAuthorities() {
    const query = `
      SELECT doa.*,
             u.first_name || ' ' || u.last_name as user_name,
             u.email as user_email
      FROM delegation_of_authority doa
      LEFT JOIN users u ON doa.user_id = u.id
      WHERE doa.effective_until < CURRENT_DATE
        AND doa.is_active = TRUE
      ORDER BY doa.effective_until DESC
    `;

    try {
      const result = await db.query(query);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  // Get authorities expiring soon
  static async getExpiringAuthorities(daysAhead = 30) {
    const query = `
      SELECT doa.*,
             u.first_name || ' ' || u.last_name as user_name,
             u.email as user_email
      FROM delegation_of_authority doa
      LEFT JOIN users u ON doa.user_id = u.id
      WHERE doa.effective_until BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '${daysAhead} days'
        AND doa.is_active = TRUE
      ORDER BY doa.effective_until ASC
    `;

    try {
      const result = await db.query(query);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  // Deactivate expired authorities
  static async deactivateExpiredAuthorities() {
    const query = `
      UPDATE delegation_of_authority 
      SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP
      WHERE effective_until < CURRENT_DATE
        AND is_active = TRUE
      RETURNING *
    `;

    try {
      const result = await db.query(query);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  static async getStats() {
    const query = `
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN is_active = TRUE THEN 1 END) as active,
        COUNT(CASE WHEN is_active = FALSE THEN 1 END) as inactive,
        COUNT(CASE WHEN effective_until < CURRENT_DATE AND is_active = TRUE THEN 1 END) as expired,
        COUNT(CASE WHEN effective_until BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days' AND is_active = TRUE THEN 1 END) as expiring_soon,
        COUNT(DISTINCT user_id) as unique_users,
        COUNT(DISTINCT cost_center) as unique_cost_centers
      FROM delegation_of_authority
    `;

    try {
      const result = await db.query(query);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Get cost centers with authority setup
  static async getCostCentersWithAuthority() {
    const query = `
      SELECT DISTINCT cost_center,
             COUNT(*) as authority_count,
             MAX(max_amount) as highest_authority,
             MIN(min_amount) as lowest_authority
      FROM delegation_of_authority
      WHERE is_active = TRUE
        AND effective_from <= CURRENT_DATE
        AND (effective_until IS NULL OR effective_until >= CURRENT_DATE)
      GROUP BY cost_center
      ORDER BY cost_center
    `;

    try {
      const result = await db.query(query);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  // Validation helper to check for overlapping authorities
  static async checkOverlappingAuthorities(userId, costCenter, minAmount, maxAmount, appliesTo, effectiveFrom, effectiveUntil, excludeId = null) {
    let query = `
      SELECT doa.*,
             u.first_name || ' ' || u.last_name as user_name
      FROM delegation_of_authority doa
      LEFT JOIN users u ON doa.user_id = u.id
      WHERE doa.user_id = $1
        AND doa.cost_center = $2
        AND doa.applies_to = $3
        AND doa.is_active = TRUE
        AND (
          (doa.effective_from <= $4 AND (doa.effective_until IS NULL OR doa.effective_until >= $4))
          OR
          (doa.effective_from <= $5 AND (doa.effective_until IS NULL OR doa.effective_until >= $5))
          OR
          (doa.effective_from >= $4 AND (doa.effective_until IS NULL OR doa.effective_until <= $5))
        )
        AND (
          (doa.min_amount <= $6 AND doa.max_amount >= $6)
          OR
          (doa.min_amount <= $7 AND doa.max_amount >= $7)
          OR
          (doa.min_amount >= $6 AND doa.max_amount <= $7)
        )
    `;
    
    let values = [userId, costCenter, appliesTo, effectiveFrom, effectiveUntil || '9999-12-31', minAmount, maxAmount];
    
    if (excludeId) {
      query += ' AND doa.id != $8';
      values.push(excludeId);
    }

    try {
      const result = await db.query(query, values);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  // Sales-specific DOA methods
  static async checkSalesQuotationAuthority(userId, amount, costCenter = null) {
    return await this.checkAuthority(userId, amount, costCenter, 'SALES_QUOTATION');
  }

  static async checkSalesContractAuthority(userId, amount, costCenter = null) {
    return await this.checkAuthority(userId, amount, costCenter, 'SALES_CONTRACT');
  }

  static async checkSalesOrderAuthority(userId, amount, costCenter = null) {
    return await this.checkAuthority(userId, amount, costCenter, 'SALES_ORDER');
  }

  static async getSalesAuthorizedUsers(amount, costCenter = null, transactionType = 'SALES') {
    return await this.getAuthorizedUsers(amount, costCenter, transactionType);
  }

  // Find the next approver in the hierarchy for sales transactions
  static async getNextSalesApprover(amount, costCenter = null, transactionType = 'SALES', excludeUserId = null) {
    let query = `
      SELECT DISTINCT doa.user_id,
             u.first_name || ' ' || u.last_name as user_name,
             u.email as user_email,
             doa.cost_center,
             doa.max_amount,
             doa.applies_to
      FROM delegation_of_authority doa
      JOIN users u ON doa.user_id = u.id
      WHERE doa.is_active = TRUE
        AND doa.effective_from <= CURRENT_DATE
        AND (doa.effective_until IS NULL OR doa.effective_until >= CURRENT_DATE)
        AND doa.min_amount <= $1
        AND (doa.max_amount IS NULL OR doa.max_amount >= $1)
        AND (doa.applies_to = 'ALL' OR doa.applies_to LIKE '%SALES%' OR doa.applies_to = $2)
    `;
    
    let values = [amount, transactionType];
    let paramIndex = 3;
    
    if (costCenter) {
      query += ` AND doa.cost_center = $${paramIndex}`;
      values.push(costCenter);
      paramIndex++;
    }
    
    if (excludeUserId) {
      query += ` AND doa.user_id != $${paramIndex}`;
      values.push(excludeUserId);
    }
    
    query += ' ORDER BY doa.max_amount ASC, doa.created_at ASC LIMIT 1';

    try {
      const result = await db.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Check if user can approve sales transactions based on hierarchy
  static async canApproveSalesTransaction(userId, amount, transactionType = 'SALES', costCenter = null) {
    const authority = await this.checkAuthority(userId, amount, costCenter, transactionType);
    return !!authority;
  }
}

module.exports = DelegationOfAuthority;