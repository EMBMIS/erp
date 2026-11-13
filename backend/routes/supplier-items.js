const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const db = require('../config/database');
const supplierEmailService = require('../services/supplierEmailService');

// GET /supplier-items - Get all supplier-item relationships with filters
router.get('/', auth, async (req, res) => {
  try {
    const { supplier_id, item_id, status = 'ACTIVE' } = req.query;
    
    let query = `
      SELECT 
        si.*,
        s.legal_name as supplier_name,
        s.supplier_code,
        ii.item_master_id,
        i.name as item_name,
        i.approved_item_code as sku,
        i.item_category as category,
        i.unit_of_measure
      FROM supplier_items si
      JOIN suppliers s ON si.supplier_id = s.id
      JOIN inventory_items ii ON si.item_id = ii.id
      JOIN items i ON ii.item_master_id = i.id
      WHERE 1=1
    `;
    
    const params = [];
    
    if (supplier_id) {
      params.push(supplier_id);
      query += ` AND si.supplier_id = $${params.length}`;
    }
    
    if (item_id) {
      params.push(item_id);
      query += ` AND si.item_id = $${params.length}`;
    }
    
    if (status) {
      params.push(status);
      query += ` AND si.status = $${params.length}`;
    }
    
    query += ` ORDER BY s.legal_name, i.name`;
    
    const result = await db.query(query, params);
    
    res.json({
      success: true,
      data: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching supplier items:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch supplier items'
    });
  }
});

// GET /supplier-items/by-supplier/:supplierId - Get items supplied by a specific supplier
router.get('/by-supplier/:supplierId', auth, async (req, res) => {
  try {
    console.log('Fetching supplier items for supplier:', req.params.supplierId);
    const { status = 'ACTIVE' } = req.query;
    console.log('Filtering by status:', status);
    
    let query = `
      SELECT 
        si.*,
        ii.item_master_id,
        i.name as item_name,
        i.approved_item_code as sku,
        i.item_category as category,
        i.unit_of_measure,
        i.description as item_description
      FROM supplier_items si
      JOIN inventory_items ii ON si.item_id = ii.id
      JOIN items i ON ii.item_master_id = i.id
      WHERE si.supplier_id = $1
    `;
    
    const params = [req.params.supplierId];
    
    if (status !== 'ALL') {
      query += ` AND si.status = $2`;
      params.push(status);
    }
    
    query += ` ORDER BY i.name`;
    
    const result = await db.query(query, params);
    console.log('Found supplier items:', result.rows.length);
    console.log('Sample items:', result.rows.map(r => ({ id: r.id, item_id: r.item_id, status: r.status })));
    
    res.json({
      success: true,
      data: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching supplier items:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch supplier items'
    });
  }
});

// GET /supplier-items/by-item/:itemId - Get suppliers for a specific item
router.get('/by-item/:itemId', auth, async (req, res) => {
  try {
    const { status = 'ACTIVE' } = req.query;
    
    const query = `
      SELECT 
        si.*,
        s.legal_name as supplier_name,
        s.supplier_code,
        s.contact_email,
        s.certification_status
      FROM supplier_items si
      JOIN suppliers s ON si.supplier_id = s.id
      WHERE si.item_id = $1 AND si.status = $2
      ORDER BY si.is_preferred DESC, si.unit_price ASC
    `;
    
    const result = await db.query(query, [req.params.itemId, status]);
    
    res.json({
      success: true,
      data: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching item suppliers:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch item suppliers'
    });
  }
});

// POST /supplier-items - Create new supplier-item relationship
router.post('/', auth, async (req, res) => {
  try {
    console.log('Creating supplier item with data:', req.body);
    console.log('User:', req.user);
    
    const {
      supplier_id,
      item_id,
      unit_price,
      currency = 'USD',
      minimum_order_quantity = 1,
      lead_time_days,
      is_preferred = false,
      notes
    } = req.body;

    // Validate required fields
    if (!supplier_id || !item_id) {
      return res.status(400).json({
        success: false,
        error: 'Supplier ID and Item ID are required'
      });
    }

    // Check if supplier exists and is active
    console.log('Checking supplier:', supplier_id);
    const supplierCheck = await db.query(
      'SELECT id, status FROM suppliers WHERE id = $1',
      [supplier_id]
    );
    console.log('Supplier check result:', supplierCheck.rows);

    if (supplierCheck.rows.length === 0) {
      console.log('Supplier not found');
      return res.status(404).json({
        success: false,
        error: 'Supplier not found'
      });
    }

    // Check if item exists (inventory item)
    console.log('Checking inventory item:', item_id);
    const itemCheck = await db.query(
      'SELECT id FROM inventory_items WHERE id = $1 AND status = \'APPROVED\'',
      [item_id]
    );
    console.log('Item check result:', itemCheck.rows);

    if (itemCheck.rows.length === 0) {
      console.log('Item not found or not approved');
      return res.status(404).json({
        success: false,
        error: 'Item not found or not approved'
      });
    }

    // Check if relationship already exists
    console.log('Checking for existing relationship...');
    const existingCheck = await db.query(
      'SELECT id, status FROM supplier_items WHERE supplier_id = $1 AND item_id = $2',
      [supplier_id, item_id]
    );
    console.log('Existing relationship check:', existingCheck.rows);

    if (existingCheck.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Supplier-item relationship already exists'
      });
    }

    // Generate confirmation token for supplier (expiring, single-use)
    const { expiryDate } = require('../services/portalTokens');
    const confirmationToken = supplierEmailService.generateConfirmationToken();

    const result = await db.query(`
      INSERT INTO supplier_items (
        supplier_id, item_id, unit_price, currency, minimum_order_quantity,
        lead_time_days, is_preferred, notes, created_by, status,
        confirmation_token, confirmation_requested_at, supplier_confirmed,
        confirmation_token_expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *
    `, [
      supplier_id, item_id, unit_price, currency, minimum_order_quantity,
      lead_time_days, is_preferred, notes, req.user.id, 'PENDING_SUPPLIER_CONFIRMATION',
      confirmationToken, new Date(), false, expiryDate()
    ]);

    const supplierItem = result.rows[0];
    
    // Get supplier and item details for email
    const supplierQuery = await db.query(
      'SELECT legal_name, email FROM suppliers WHERE id = $1',
      [supplier_id]
    );
    
    const itemQuery = await db.query(`
      SELECT ii.id, i.name as item_name, i.approved_item_code as sku, i.item_category as category
      FROM inventory_items ii 
      JOIN items i ON ii.item_master_id = i.id 
      WHERE ii.id = $1
    `, [item_id]);
    
    if (supplierQuery.rows.length > 0 && itemQuery.rows.length > 0) {
      const supplier = supplierQuery.rows[0];
      const item = itemQuery.rows[0];
      
      console.log('Supplier details for email:', { 
        legal_name: supplier.legal_name, 
        email: supplier.email 
      });
      console.log('Item details for email:', { 
        item_name: item.item_name, 
        sku: item.sku 
      });
      
      if (!supplier.email) {
        console.log('Warning: Supplier has no email address, skipping email notification');
      } else {
        try {
          // Send confirmation email to supplier
          const emailResult = await supplierEmailService.sendItemAssignmentConfirmation(
            supplier,
            [item],
            req.user,
            confirmationToken
          );
          
          console.log(`Confirmation email sent to supplier: ${supplier.legal_name} at ${supplier.email}`);
          console.log('Email result:', emailResult);
        } catch (emailError) {
          console.error('Failed to send confirmation email:', emailError);
          console.error('Email error details:', emailError.message);
          // Continue despite email failure - item is still created
        }
      }
    } else {
      console.log('Missing supplier or item data for email:', {
        supplierFound: supplierQuery.rows.length > 0,
        itemFound: itemQuery.rows.length > 0
      });
    }

    res.status(201).json({
      success: true,
      data: supplierItem,
      message: 'Supplier-item relationship created and confirmation email sent'
    });
  } catch (error) {
    console.error('Error creating supplier item:', error);
    
    if (error.code === '23505') { // Unique constraint violation
      return res.status(400).json({
        success: false,
        error: 'Supplier-item relationship already exists'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to create supplier-item relationship'
    });
  }
});

// PUT /supplier-items/:id - Update supplier-item relationship
router.put('/:id', auth, async (req, res) => {
  try {
    const {
      unit_price,
      currency,
      minimum_order_quantity,
      lead_time_days,
      is_preferred,
      notes,
      status
    } = req.body;

    const updateFields = [];
    const params = [];
    let paramCount = 1;

    if (unit_price !== undefined) {
      updateFields.push(`unit_price = $${paramCount++}`);
      params.push(unit_price);
    }
    if (currency !== undefined) {
      updateFields.push(`currency = $${paramCount++}`);
      params.push(currency);
    }
    if (minimum_order_quantity !== undefined) {
      updateFields.push(`minimum_order_quantity = $${paramCount++}`);
      params.push(minimum_order_quantity);
    }
    if (lead_time_days !== undefined) {
      updateFields.push(`lead_time_days = $${paramCount++}`);
      params.push(lead_time_days);
    }
    if (is_preferred !== undefined) {
      updateFields.push(`is_preferred = $${paramCount++}`);
      params.push(is_preferred);
    }
    if (notes !== undefined) {
      updateFields.push(`notes = $${paramCount++}`);
      params.push(notes);
    }
    if (status !== undefined) {
      updateFields.push(`status = $${paramCount++}`);
      params.push(status);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No fields to update'
      });
    }

    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
    params.push(req.params.id);

    const query = `
      UPDATE supplier_items 
      SET ${updateFields.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `;

    const result = await db.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Supplier-item relationship not found'
      });
    }

    res.json({
      success: true,
      data: result.rows[0],
      message: 'Supplier-item relationship updated successfully'
    });
  } catch (error) {
    console.error('Error updating supplier item:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update supplier-item relationship'
    });
  }
});

// DELETE /supplier-items/:id - Delete supplier-item relationship
router.delete('/:id', auth, async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM supplier_items WHERE id = $1 RETURNING *',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Supplier-item relationship not found'
      });
    }

    res.json({
      success: true,
      message: 'Supplier-item relationship deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting supplier item:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete supplier-item relationship'
    });
  }
});

// POST /supplier-items/bulk - Bulk add items to supplier
router.post('/bulk', auth, async (req, res) => {
  try {
    const { supplier_id, items } = req.body;

    if (!supplier_id || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Supplier ID and items array are required'
      });
    }

    // Validate supplier exists
    const supplierCheck = await db.query(
      'SELECT id FROM suppliers WHERE id = $1',
      [supplier_id]
    );

    if (supplierCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Supplier not found'
      });
    }

    const results = [];
    const errors = [];

    for (const item of items) {
      try {
        const {
          item_id,
          unit_price,
          currency = 'USD',
          minimum_order_quantity = 1,
          lead_time_days,
          is_preferred = false,
          notes
        } = item;

        if (!item_id) {
          errors.push({ item, error: 'Item ID is required' });
          continue;
        }

        // Check if relationship already exists
        const existingCheck = await db.query(
          'SELECT id FROM supplier_items WHERE supplier_id = $1 AND item_id = $2',
          [supplier_id, item_id]
        );

        if (existingCheck.rows.length > 0) {
          errors.push({ item, error: 'Supplier-item relationship already exists' });
          continue;
        }

        // Generate confirmation token for each item (expiring, single-use)
        const { expiryDate } = require('../services/portalTokens');
        const confirmationToken = supplierEmailService.generateConfirmationToken();

        const result = await db.query(`
          INSERT INTO supplier_items (
            supplier_id, item_id, unit_price, currency, minimum_order_quantity,
            lead_time_days, is_preferred, notes, created_by, status,
            confirmation_token, confirmation_requested_at, supplier_confirmed,
            confirmation_token_expires_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          RETURNING *
        `, [
          supplier_id, item_id, unit_price, currency, minimum_order_quantity,
          lead_time_days, is_preferred, notes, req.user.id, 'PENDING_SUPPLIER_CONFIRMATION',
          confirmationToken, new Date(), false, expiryDate()
        ]);

        results.push(result.rows[0]);
      } catch (error) {
        console.error('Error in bulk insert:', error);
        errors.push({ item, error: error.message });
      }
    }

    // Send bulk confirmation email if items were created successfully
    if (results.length > 0) {
      try {
        // Get supplier details
        const supplierQuery = await db.query(
          'SELECT legal_name, email FROM suppliers WHERE id = $1',
          [supplier_id]
        );
        
        if (supplierQuery.rows.length > 0) {
          const supplier = supplierQuery.rows[0];
          
          // Get item details for all created items
          const itemIds = results.map(r => r.item_id);
          const itemsQuery = await db.query(`
            SELECT ii.id, i.name as item_name, i.approved_item_code as sku, i.item_category as category
            FROM inventory_items ii 
            JOIN items i ON ii.item_master_id = i.id 
            WHERE ii.id = ANY($1)
          `, [itemIds]);
          
          if (itemsQuery.rows.length > 0) {
            // Send bulk confirmation email to supplier
            await supplierEmailService.sendItemAssignmentConfirmation(
              supplier,
              itemsQuery.rows,
              req.user
            );
            
            console.log(`Bulk confirmation email sent to supplier: ${supplier.legal_name} for ${itemsQuery.rows.length} items`);
          }
        }
      } catch (emailError) {
        console.error('Failed to send bulk confirmation email:', emailError);
        // Continue despite email failure
      }
    }

    res.json({
      success: true,
      data: {
        created: results,
        errors: errors,
        summary: {
          total_requested: items.length,
          successfully_created: results.length,
          errors: errors.length
        }
      },
      message: `Bulk operation completed: ${results.length} created, ${errors.length} errors. Confirmation email sent to supplier.`
    });
  } catch (error) {
    console.error('Error in bulk supplier items creation:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create supplier items in bulk'
    });
  }
});

module.exports = router;