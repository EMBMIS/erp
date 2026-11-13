const db = require('../config/database');
const { v4: uuidv4 } = require('uuid');

class Customer {
  // Create a new customer
  static async create(customerData, userId) {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const {
        customer_name,
        legal_entity_name,
        customer_type = 'COMPANY',
        primary_email,
        secondary_email,
        phone,
        mobile,
        fax,
        website,
        billing_address_line1,
        billing_address_line2,
        billing_city,
        billing_state,
        billing_country,
        billing_postal_code,
        shipping_address_line1,
        shipping_address_line2,
        shipping_city,
        shipping_state,
        shipping_country,
        shipping_postal_code,
        use_billing_as_shipping = true,
        currency = 'USD',
        credit_limit = 0,
        credit_days = 30,
        payment_terms,
        tax_number,
        vat_number,
        tax_exempt = false,
        tax_rate = 0,
        primary_contact_name,
        primary_contact_title,
        primary_contact_email,
        primary_contact_phone,
        secondary_contact_name,
        secondary_contact_title,
        secondary_contact_email,
        secondary_contact_phone,
        customer_category,
        customer_group,
        sales_rep_id,
        credit_risk_level = 'LOW',
        credit_check_required = false,
        late_delivery_penalty = null,
        late_delivery_penalty_per_day = null,
        notes,
        internal_notes
      } = customerData;

      // Generate customer code
      const customerCode = await this.generateCustomerCode(client);
      const customerId = uuidv4();

      const query = `
        INSERT INTO customers (
          id, customer_code, customer_name, legal_entity_name, customer_type,
          primary_email, secondary_email, phone, mobile, fax, website,
          billing_address_line1, billing_address_line2, billing_city, billing_state, 
          billing_country, billing_postal_code,
          shipping_address_line1, shipping_address_line2, shipping_city, shipping_state,
          shipping_country, shipping_postal_code, use_billing_as_shipping,
          currency, credit_limit, credit_days, payment_terms,
          tax_number, vat_number, tax_exempt, tax_rate,
          primary_contact_name, primary_contact_title, primary_contact_email, primary_contact_phone,
          secondary_contact_name, secondary_contact_title, secondary_contact_email, secondary_contact_phone,
          customer_category, customer_group, sales_rep_id,
          credit_risk_level, credit_check_required, notes, internal_notes,
          created_by, late_delivery_penalty, late_delivery_penalty_per_day
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
          $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32,
          $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, $46, $47, $48,
          $49, $50
        )
        RETURNING *
      `;

      const values = [
        customerId, customerCode, customer_name, legal_entity_name, customer_type,
        primary_email, secondary_email, phone, mobile, fax, website,
        billing_address_line1, billing_address_line2, billing_city, billing_state,
        billing_country, billing_postal_code,
        shipping_address_line1, shipping_address_line2, shipping_city, shipping_state,
        shipping_country, shipping_postal_code, use_billing_as_shipping,
        currency, credit_limit, credit_days, payment_terms,
        tax_number, vat_number, tax_exempt, tax_rate,
        primary_contact_name, primary_contact_title, primary_contact_email, primary_contact_phone,
        secondary_contact_name, secondary_contact_title, secondary_contact_email, secondary_contact_phone,
        customer_category, customer_group, sales_rep_id,
        credit_risk_level, credit_check_required, notes, internal_notes,
        userId, late_delivery_penalty, late_delivery_penalty_per_day
      ];

      const result = await client.query(query, values);
      const customer = result.rows[0];

      // Log audit trail
      await this.logAudit(client, customerId, 'CREATED', null, null, null, userId, 'Customer created');

      await client.query('COMMIT');
      return customer;
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Generate unique customer code
  static async generateCustomerCode(client) {
    const result = await client.query(
      'SELECT customer_code FROM customers WHERE customer_code ~ $1 ORDER BY customer_code DESC LIMIT 1',
      ['^CUST-[0-9]+$']
    );
    
    let nextNumber = 1;
    if (result.rows.length > 0) {
      const lastCode = result.rows[0].customer_code;
      const lastNumber = parseInt(lastCode.split('-')[1]);
      nextNumber = lastNumber + 1;
    }
    
    return `CUST-${nextNumber.toString().padStart(4, '0')}`;
  }

  // Get all customers with filtering
  static async findAll(filters = {}) {
    let query = `
      SELECT 
        c.*,
        u1.first_name || ' ' || u1.last_name as created_by_name,
        u2.first_name || ' ' || u2.last_name as sales_rep_name,
        0 as active_orders_count,
        0 as active_orders_value
      FROM customers c
      LEFT JOIN users u1 ON c.created_by = u1.id
      LEFT JOIN users u2 ON c.sales_rep_id = u2.id
      WHERE c.deleted_at IS NULL
    `;
    
    const conditions = [];
    const values = [];
    let paramIndex = 1;

    if (filters.search) {
      conditions.push(`(c.customer_name ILIKE $${paramIndex} OR c.customer_code ILIKE $${paramIndex} OR c.primary_email ILIKE $${paramIndex})`);
      values.push(`%${filters.search}%`);
      paramIndex++;
    }

    if (filters.status) {
      conditions.push(`c.status = $${paramIndex}`);
      values.push(filters.status);
      paramIndex++;
    }

    if (filters.customer_type) {
      conditions.push(`c.customer_type = $${paramIndex}`);
      values.push(filters.customer_type);
      paramIndex++;
    }

    if (filters.credit_risk_level) {
      conditions.push(`c.credit_risk_level = $${paramIndex}`);
      values.push(filters.credit_risk_level);
      paramIndex++;
    }

    if (filters.sales_rep_id) {
      conditions.push(`c.sales_rep_id = $${paramIndex}`);
      values.push(filters.sales_rep_id);
      paramIndex++;
    }

    if (conditions.length > 0) {
      query += ' AND ' + conditions.join(' AND ');
    }

    query += `
      ORDER BY c.created_at DESC
    `;

    if (filters.limit) {
      query += ` LIMIT $${paramIndex}`;
      values.push(filters.limit);
      paramIndex++;
    }

    if (filters.offset) {
      query += ` OFFSET $${paramIndex}`;
      values.push(filters.offset);
    }

    const result = await db.query(query, values);
    return result.rows;
  }

  // Get customer by ID
  static async findById(id) {
    const query = `
      SELECT 
        c.*,
        u1.first_name || ' ' || u1.last_name as created_by_name,
        u2.first_name || ' ' || u2.last_name as sales_rep_name
      FROM customers c
      LEFT JOIN users u1 ON c.created_by = u1.id
      LEFT JOIN users u2 ON c.sales_rep_id = u2.id
      WHERE c.id = $1 AND c.deleted_at IS NULL
    `;
    
    const result = await db.query(query, [id]);
    return result.rows[0] || null;
  }

  // Update customer
  static async update(id, customerData, userId) {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Get current data for audit trail
      const currentResult = await client.query('SELECT * FROM customers WHERE id = $1', [id]);
      const currentCustomer = currentResult.rows[0];
      
      if (!currentCustomer) {
        throw new Error('Customer not found');
      }

      const fields = [];
      const values = [];
      let paramIndex = 1;

      const allowedFields = [
        'customer_name', 'legal_entity_name', 'customer_type', 'primary_email', 'secondary_email',
        'phone', 'mobile', 'fax', 'website', 'billing_address_line1', 'billing_address_line2',
        'billing_city', 'billing_state', 'billing_country', 'billing_postal_code',
        'shipping_address_line1', 'shipping_address_line2', 'shipping_city', 'shipping_state',
        'shipping_country', 'shipping_postal_code', 'use_billing_as_shipping', 'currency',
        'credit_limit', 'credit_days', 'payment_terms', 'tax_number', 'vat_number', 'tax_exempt',
        'tax_rate', 'primary_contact_name', 'primary_contact_title', 'primary_contact_email',
        'primary_contact_phone', 'secondary_contact_name', 'secondary_contact_title',
        'secondary_contact_email', 'secondary_contact_phone', 'status', 'customer_category',
        'customer_group', 'sales_rep_id', 'credit_risk_level', 'credit_check_required',
        'late_delivery_penalty', 'late_delivery_penalty_per_day',
        'notes', 'internal_notes'
      ];

      allowedFields.forEach(field => {
        if (customerData.hasOwnProperty(field)) {
          fields.push(`${field} = $${paramIndex}`);
          values.push(customerData[field]);
          
          // Log significant field changes
          if (currentCustomer[field] !== customerData[field]) {
            this.logAudit(client, id, 'UPDATED', field, currentCustomer[field], customerData[field], userId);
          }
          
          paramIndex++;
        }
      });

      if (fields.length === 0) {
        throw new Error('No valid fields to update');
      }

      fields.push(`updated_by = $${paramIndex}`, `updated_at = CURRENT_TIMESTAMP`);
      values.push(userId, id);

      const query = `
        UPDATE customers 
        SET ${fields.join(', ')}
        WHERE id = $${paramIndex + 1} AND deleted_at IS NULL
        RETURNING *
      `;

      const result = await client.query(query, values);
      
      if (result.rows.length === 0) {
        throw new Error('Customer not found or already deleted');
      }

      await client.query('COMMIT');
      return result.rows[0];
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Soft delete customer
  static async delete(id, userId) {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      const query = `
        UPDATE customers 
        SET deleted_at = CURRENT_TIMESTAMP, deleted_by = $2
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *
      `;

      const result = await client.query(query, [id, userId]);
      
      if (result.rows.length === 0) {
        throw new Error('Customer not found or already deleted');
      }

      // Log audit trail
      await this.logAudit(client, id, 'DELETED', null, null, null, userId, 'Customer deleted');

      await client.query('COMMIT');
      return result.rows[0];
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Get customer statistics
  static async getStats() {
    const query = `
      SELECT 
        COUNT(*) as total_customers,
        COUNT(CASE WHEN status = 'ACTIVE' THEN 1 END) as active_customers,
        COUNT(CASE WHEN status = 'INACTIVE' THEN 1 END) as inactive_customers,
        COUNT(CASE WHEN status = 'BLOCKED' THEN 1 END) as blocked_customers,
        COUNT(CASE WHEN credit_risk_level = 'HIGH' THEN 1 END) as high_risk_customers,
        COALESCE(SUM(credit_limit), 0) as total_credit_limit,
        COALESCE(SUM(current_balance), 0) as total_outstanding_balance
      FROM customers 
      WHERE deleted_at IS NULL
    `;

    const result = await db.query(query);
    return result.rows[0];
  }

  // Log audit trail
  static async logAudit(client, customerId, action, fieldChanged, oldValue, newValue, userId, notes = null) {
    const query = `
      INSERT INTO customer_audit_log (
        customer_id, action, field_changed, old_value, new_value, changed_by, notes
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;

    await client.query(query, [
      customerId, action, fieldChanged, 
      oldValue ? String(oldValue) : null,
      newValue ? String(newValue) : null,
      userId, notes
    ]);
  }

  // Get audit trail for a customer
  static async getAuditTrail(customerId) {
    const query = `
      SELECT 
        al.*,
        u.first_name || ' ' || u.last_name as changed_by_name
      FROM customer_audit_log al
      LEFT JOIN users u ON al.changed_by = u.id
      WHERE al.customer_id = $1
      ORDER BY al.changed_at DESC
    `;

    const result = await db.pool.query(query, [customerId]);
    return result.rows;
  }

  // Update customer balance (used when payments/invoices are processed)
  static async updateBalance(customerId, balanceChange, userId) {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      const result = await client.query(
        'UPDATE customers SET current_balance = current_balance + $1 WHERE id = $2 RETURNING *',
        [balanceChange, customerId]
      );

      if (result.rows.length === 0) {
        throw new Error('Customer not found');
      }

      // Log audit trail
      await this.logAudit(
        client, customerId, 'BALANCE_UPDATED', 'current_balance', 
        null, balanceChange, userId, 
        `Balance ${balanceChange >= 0 ? 'increased' : 'decreased'} by ${Math.abs(balanceChange)}`
      );

      await client.query('COMMIT');
      return result.rows[0];
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = Customer;