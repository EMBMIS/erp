const express = require('express');
const router = express.Router();
const Customer = require('../models/Customer');
const { auth, requireRole } = require('../middleware/auth');
const nameValidationService = require('../services/nameValidationService');
const PurchaseOrder = require('../models/PurchaseOrder');
const { portalCompany } = require('../services/portalScope');

// GET /customers - List all customers with filters
router.get('/', auth, async (req, res) => {
  try {
    const filters = {
      search: req.query.search,
      status: req.query.status,
      customer_type: req.query.customer_type,
      credit_risk_level: req.query.credit_risk_level,
      sales_rep_id: req.query.sales_rep_id,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
    };

    // Remove undefined filters
    Object.keys(filters).forEach(key => {
      if (filters[key] === undefined || filters[key] === '') {
        delete filters[key];
      }
    });

    const customers = await Customer.findAll(filters);
    
    res.json({
      success: true,
      data: customers,
      count: customers.length
    });
  } catch (error) {
    console.error('Error fetching customers:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch customers'
    });
  }
});

// GET /customers/stats - Get customer statistics
router.get('/stats', auth, async (req, res) => {
  try {
    const stats = await Customer.getStats();
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Error fetching customer stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch customer statistics'
    });
  }
});

// GET /customers/:id - Get specific customer by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    
    if (!customer) {
      return res.status(404).json({
        success: false,
        error: 'Customer not found'
      });
    }

    res.json({
      success: true,
      data: customer
    });
  } catch (error) {
    console.error('Error fetching customer:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch customer'
    });
  }
});

// GET /customers/:id/audit - Get audit trail for a customer
router.get('/:id/audit', auth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const auditTrail = await Customer.getAuditTrail(req.params.id);
    
    res.json({
      success: true,
      data: auditTrail
    });
  } catch (error) {
    console.error('Error fetching audit trail:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch audit trail'
    });
  }
});

// POST /customers - Create new customer
router.post('/', auth, async (req, res) => {
  try {
    const {
      customer_name,
      legal_entity_name,
      customer_type,
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
      use_billing_as_shipping,
      currency,
      credit_limit,
      credit_days,
      payment_terms,
      tax_number,
      vat_number,
      tax_exempt,
      tax_rate,
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
      credit_risk_level,
      credit_check_required,
      late_delivery_penalty,
      late_delivery_penalty_per_day,
      notes,
      internal_notes
    } = req.body;

    // Validate required fields
    if (!customer_name) {
      return res.status(400).json({
        success: false,
        error: 'Customer name is required'
      });
    }

    // Validate email format if provided
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (primary_email && !emailRegex.test(primary_email)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid primary email format'
      });
    }

    if (secondary_email && !emailRegex.test(secondary_email)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid secondary email format'
      });
    }

    const customerData = {
      customer_name,
      legal_entity_name,
      customer_type,
      // customers_email_format_check (migration 029) requires NULL or a valid
      // address — "" fails it and a form that leaves the field untouched
      // submits "", not undefined, so this 500s on every create without it.
      primary_email: primary_email && primary_email.trim() !== '' ? primary_email : null,
      secondary_email: secondary_email && secondary_email.trim() !== '' ? secondary_email : null,
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
      use_billing_as_shipping,
      currency,
      credit_limit: credit_limit ? parseFloat(credit_limit) : 0,
      credit_days: credit_days ? parseInt(credit_days) : 30,
      late_delivery_penalty: late_delivery_penalty === '' || late_delivery_penalty == null ? null : Math.max(parseFloat(late_delivery_penalty) || 0, 0),
      late_delivery_penalty_per_day: late_delivery_penalty_per_day === '' || late_delivery_penalty_per_day == null ? null : Math.max(parseFloat(late_delivery_penalty_per_day) || 0, 0),
      payment_terms,
      tax_number,
      vat_number,
      tax_exempt: Boolean(tax_exempt),
      tax_rate: tax_rate ? parseFloat(tax_rate) : 0,
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
      sales_rep_id: sales_rep_id && sales_rep_id.trim() !== '' ? sales_rep_id : null,
      credit_risk_level,
      credit_check_required: Boolean(credit_check_required),
      notes,
      internal_notes
    };

    const newCustomer = await Customer.create(customerData, req.user.id);
    
    res.status(201).json({
      success: true,
      message: 'Customer created successfully',
      data: newCustomer
    });
  } catch (error) {
    console.error('Error creating customer:', error);
    
    if (error.code === '23505') { // Unique constraint violation
      return res.status(409).json({
        success: false,
        error: 'Customer code already exists'
      });
    }
    
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create customer'
    });
  }
});

// PUT /customers/:id - Update customer
router.put('/:id', auth, async (req, res) => {
  try {
    const updateData = req.body;
    
    // Validate email format if provided
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (updateData.primary_email && !emailRegex.test(updateData.primary_email)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid primary email format'
      });
    }

    if (updateData.secondary_email && !emailRegex.test(updateData.secondary_email)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid secondary email format'
      });
    }

    // Same "" vs NULL issue as POST /customers: customers_email_format_check
    // rejects an empty string outright.
    if (updateData.primary_email !== undefined) {
      updateData.primary_email = updateData.primary_email && updateData.primary_email.trim() !== ''
        ? updateData.primary_email : null;
    }
    if (updateData.secondary_email !== undefined) {
      updateData.secondary_email = updateData.secondary_email && updateData.secondary_email.trim() !== ''
        ? updateData.secondary_email : null;
    }

    // Convert string numbers to appropriate types
    if (updateData.credit_limit !== undefined) {
      updateData.credit_limit = parseFloat(updateData.credit_limit) || 0;
    }
    if (updateData.credit_days !== undefined) {
      updateData.credit_days = parseInt(updateData.credit_days) || 30;
    }
    if (updateData.tax_rate !== undefined) {
      updateData.tax_rate = parseFloat(updateData.tax_rate) || 0;
    }
    // A customer's late-delivery terms; empty means none on record.
    for (const k of ['late_delivery_penalty', 'late_delivery_penalty_per_day']) {
      if (updateData[k] !== undefined) {
        updateData[k] = updateData[k] === '' || updateData[k] === null ? null : Math.max(parseFloat(updateData[k]) || 0, 0);
      }
    }
    
    // Convert boolean fields
    if (updateData.tax_exempt !== undefined) {
      updateData.tax_exempt = Boolean(updateData.tax_exempt);
    }
    if (updateData.credit_check_required !== undefined) {
      updateData.credit_check_required = Boolean(updateData.credit_check_required);
    }
    if (updateData.use_billing_as_shipping !== undefined) {
      updateData.use_billing_as_shipping = Boolean(updateData.use_billing_as_shipping);
    }
    
    // Handle UUID fields - convert empty strings to null
    if (updateData.sales_rep_id !== undefined) {
      updateData.sales_rep_id = updateData.sales_rep_id && updateData.sales_rep_id.trim() !== '' ? updateData.sales_rep_id : null;
    }

    const updatedCustomer = await Customer.update(req.params.id, updateData, req.user.id);
    
    res.json({
      success: true,
      message: 'Customer updated successfully',
      data: updatedCustomer
    });
  } catch (error) {
    console.error('Error updating customer:', error);
    
    if (error.message === 'Customer not found') {
      return res.status(404).json({
        success: false,
        error: 'Customer not found'
      });
    }
    
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update customer'
    });
  }
});

// DELETE /customers/:id - Delete customer (soft delete)
router.delete('/:id', auth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const deletedCustomer = await Customer.delete(req.params.id, req.user.id);
    
    res.json({
      success: true,
      message: 'Customer deleted successfully',
      data: deletedCustomer
    });
  } catch (error) {
    console.error('Error deleting customer:', error);
    
    if (error.message === 'Customer not found or already deleted') {
      return res.status(404).json({
        success: false,
        error: 'Customer not found'
      });
    }
    
    if (error.code === '23503') { // Foreign key constraint
      return res.status(400).json({
        success: false,
        error: 'Cannot delete customer - it has related records (sales orders, invoices, etc.)'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to delete customer'
    });
  }
});

// POST /customers/:id/balance - Update customer balance
router.post('/:id/balance', auth, requireRole('MANAGER', 'ADMIN', 'ACCOUNTANT'), async (req, res) => {
  try {
    const { balance_change, reason } = req.body;
    
    if (balance_change === undefined || balance_change === null) {
      return res.status(400).json({
        success: false,
        error: 'Balance change amount is required'
      });
    }

    const balanceChangeAmount = parseFloat(balance_change);
    
    if (isNaN(balanceChangeAmount)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid balance change amount'
      });
    }

    const updatedCustomer = await Customer.updateBalance(req.params.id, balanceChangeAmount, req.user.id);
    
    res.json({
      success: true,
      message: 'Customer balance updated successfully',
      data: updatedCustomer
    });
  } catch (error) {
    console.error('Error updating customer balance:', error);
    
    if (error.message === 'Customer not found') {
      return res.status(404).json({
        success: false,
        error: 'Customer not found'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to update customer balance'
    });
  }
});

// POST /customers/validate-name - Customer name validation  
router.post('/validate-name', auth, async (req, res) => {
  try {
    const { name, type } = req.body;
    
    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Name is required'
      });
    }
    
    // Use different validation based on type
    let result;
    if (type === 'legal') {
      result = await nameValidationService.validateLegalName(name.trim());
    } else {
      result = await nameValidationService.validateCustomerName(name.trim());
    }
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error validating name:', error);
    res.status(500).json({
      success: false,
      error: 'Name validation temporarily unavailable'
    });
  }
});

// GET /customers/delivery-confirmation/:token - Customer delivery confirmation page (public)
router.get('/delivery-confirmation/:token', portalCompany('customer_delivery'), async (req, res) => {
  try {
    const { token } = req.params;
    
    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'Confirmation token is required'
      });
    }

    // Get sales order by delivery confirmation token
    const { pool } = require('../config/database');
    const query = `
      SELECT so.*, c.customer_name, c.primary_email,
             po.po_number, po.delivery_address, po.handover_notes
      FROM sales_orders so
      LEFT JOIN customers c ON so.customer_id = c.id
      LEFT JOIN purchase_orders po ON po.sales_order_id = so.id
      WHERE so.customer_delivery_token = $1
        AND so.status = 'WAITING_CUSTOMER_DELIVERY_CONFIRMATION'
    `;
    
    const result = await pool.query(query, [token]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Delivery confirmation not found or already processed'
      });
    }

    const salesOrder = result.rows[0];

    // Get sales order items
    const itemsQuery = `
      SELECT soi.*, i.name as item_master_name, i.approved_item_code
      FROM sales_order_items soi
      LEFT JOIN inventory_items ii ON soi.inventory_item_id = ii.id
      LEFT JOIN items i ON ii.item_master_id = i.id
      WHERE soi.sales_order_id = $1
      ORDER BY soi.created_at
    `;
    
    const itemsResult = await pool.query(itemsQuery, [salesOrder.id]);
    salesOrder.items = itemsResult.rows;

    res.json({
      success: true,
      data: salesOrder
    });
  } catch (error) {
    console.error('Error fetching delivery confirmation:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch delivery confirmation'
    });
  }
});

// POST /customers/delivery-confirmation/:token - Process customer delivery confirmation (public)
router.post('/delivery-confirmation/:token', portalCompany('customer_delivery'), async (req, res) => {
  try {
    const { token } = req.params;
    const { action, notes } = req.body;
    
    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'Confirmation token is required'
      });
    }

    if (!action || !['confirm', 'issue'].includes(action)) {
      return res.status(400).json({
        success: false,
        error: 'Action must be either "confirm" or "issue"'
      });
    }

    const { pool } = require('../config/database');
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Get sales order and related PO
      const findQuery = `
        SELECT so.*, po.id as po_id
        FROM sales_orders so
        LEFT JOIN purchase_orders po ON po.sales_order_id = so.id
        WHERE so.customer_delivery_token = $1
          AND so.status = 'WAITING_CUSTOMER_DELIVERY_CONFIRMATION'
      `;
      
      const findResult = await client.query(findQuery, [token]);
      
      if (findResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          error: 'Delivery confirmation not found or already processed'
        });
      }

      const salesOrder = findResult.rows[0];

      if (action === 'confirm') {
        // Customer confirmed delivery - mark both SO and PO as completed
        
        // Update customer delivery confirmation fields first
        await client.query(`
          UPDATE sales_orders 
          SET customer_delivery_confirmed_at = CURRENT_TIMESTAMP,
              customer_delivery_notes = $1,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $2
        `, [notes, salesOrder.id]);

        // Commit the delivery notes first
        await client.query('COMMIT');
        
        // Use model methods to trigger finance integration
        const SalesOrder = require('../models/SalesOrder');
        const PurchaseOrder = require('../models/PurchaseOrder');

        // Who the system records as making this change. The person clicking is
        // the CUSTOMER — not a user of this system at all — so there is no
        // session to read. The old fallback named the order's own creator,
        // which was wrong twice over: it credited a staff member with a decision
        // they did not make, and Segregation of Duties then refused the
        // transition outright (creator cannot complete their own order), so
        // confirming a delivery through the portal always failed with a 500.
        // The deployment's posting authority is the right signer: the token is
        // what authorized this, and the reason string records who acted.
        const { resolvePostingAuthority } = require('../services/platformOwner');
        const actorId = req.user?.id || await resolvePostingAuthority(salesOrder.created_by);
        const reason = 'Customer confirmed delivery via portal link';

        // Update SO status (triggers customer invoice and journal entry)
        await SalesOrder.updateStatus(salesOrder.id, 'COMPLETED', actorId, reason);

        // Update PO status (triggers AP journal entry)
        if (salesOrder.po_id) {
          await PurchaseOrder.updateStatus(salesOrder.po_id, 'COMPLETED', actorId, reason);
        }
        
        // Start new transaction for response
        await client.query('BEGIN');

        await client.query('COMMIT');

        res.json({
          success: true,
          message: 'Delivery confirmed successfully. Thank you!',
          action: 'confirmed'
        });

      } else if (action === 'issue') {
        // Customer reported delivery issues - update status and notes
        await client.query(`
          UPDATE sales_orders 
          SET status = 'DELIVERY_ISSUE_REPORTED',
              customer_delivery_issue_reported_at = CURRENT_TIMESTAMP,
              customer_delivery_notes = $1,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $2
        `, [notes, salesOrder.id]);

        if (salesOrder.po_id) {
          await client.query(`
            UPDATE purchase_orders 
            SET status = 'DELIVERY_ISSUE_REPORTED',
                customer_confirmation_notes = $1,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
          `, [notes, salesOrder.po_id]);
        }

        await client.query('COMMIT');

        res.json({
          success: true,
          message: 'Delivery issue reported. Our team will contact you shortly.',
          action: 'issue_reported'
        });
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error processing delivery confirmation:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process delivery confirmation'
    });
  }
});

module.exports = router;