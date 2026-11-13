const express = require('express');
const router = express.Router();
const db = require('../config/database');
const supplierEmailService = require('../services/supplierEmailService');
const { portalCompany } = require('../services/portalScope');

// GET /supplier-confirmation/:token - Display confirmation page for supplier
router.get('/:token', portalCompany('supplier_item'), async (req, res) => {
  try {
    console.log('=== Supplier Confirmation Request ===');
    console.log('Token received:', req.params.token);
    const { token } = req.params;
    
    // Find supplier items that need confirmation with this token
    const query = `
      SELECT 
        si.*,
        s.legal_name as supplier_name,
        s.email,
        ii.item_master_id,
        i.name as item_name,
        i.approved_item_code as sku,
        i.item_category as category,
        i.unit_of_measure,
        i.description
      FROM supplier_items si
      JOIN suppliers s ON si.supplier_id = s.id
      JOIN inventory_items ii ON si.item_id = ii.id
      JOIN items i ON ii.item_master_id = i.id
      WHERE si.confirmation_token = $1
        AND si.status = 'PENDING_SUPPLIER_CONFIRMATION'
        AND (si.confirmation_token_expires_at IS NULL OR si.confirmation_token_expires_at > NOW())
    `;

    console.log('Executing query with token:', token);
    const result = await db.query(query, [token]);
    console.log('Query result rows count:', result.rows.length);
    
    if (result.rows.length === 0) {
      console.log('No pending items found for supplier');
      return res.status(404).json({
        success: false,
        error: 'No pending confirmations found for this supplier'
      });
    }
    
    const items = result.rows;
    const supplier = {
      legal_name: items[0].supplier_name,
      email: items[0].email
    };
    
    res.json({
      success: true,
      data: {
        supplier,
        items,
        token
      },
      message: 'Confirmation details retrieved successfully'
    });
  } catch (error) {
    console.error('Error fetching confirmation details:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch confirmation details'
    });
  }
});

// POST /supplier-confirmation/:token/confirm - Confirm items
router.post('/:token/confirm', portalCompany('supplier_item'), async (req, res) => {
  try {
    const { token } = req.params;
    const { confirmed_items, rejected_items, rejection_reason } = req.body;
    
    // Validate token and get items
    const tokenQuery = `
      SELECT si.*, s.legal_name as supplier_name, s.email as supplier_email, u.first_name, u.last_name, u.email
      FROM supplier_items si
      JOIN suppliers s ON si.supplier_id = s.id
      JOIN users u ON si.created_by = u.id
      WHERE si.confirmation_token = $1
        AND si.status = 'PENDING_SUPPLIER_CONFIRMATION'
        AND (si.confirmation_token_expires_at IS NULL OR si.confirmation_token_expires_at > NOW())
    `;
    
    const tokenResult = await db.query(tokenQuery, [token]);
    
    if (tokenResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Invalid or expired confirmation token'
      });
    }
    
    const supplierItems = tokenResult.rows;
    const supplier = {
      legal_name: supplierItems[0].supplier_name,
      email: supplierItems[0].supplier_email
    };
    const requestedBy = {
      first_name: supplierItems[0].first_name,
      last_name: supplierItems[0].last_name,
      email: supplierItems[0].email
    };
    
    let confirmedCount = 0;
    let rejectedCount = 0;
    
    // Process confirmed items
    if (confirmed_items && confirmed_items.length > 0) {
      const confirmQuery = `
        UPDATE supplier_items 
        SET status = 'ACTIVE', 
            supplier_confirmed = true, 
            supplier_confirmed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ANY($1) AND confirmation_token = $2
      `;
      
      const confirmResult = await db.query(confirmQuery, [confirmed_items, token]);
      confirmedCount = confirmResult.rowCount;
      
      // Get confirmed item details for notification
      if (confirmedCount > 0) {
        const confirmedItemsQuery = `
          SELECT ii.id, i.name as item_name, i.approved_item_code as sku
          FROM supplier_items si
          JOIN inventory_items ii ON si.item_id = ii.id
          JOIN items i ON ii.item_master_id = i.id
          WHERE si.id = ANY($1)
        `;
        
        const confirmedItemsResult = await db.query(confirmedItemsQuery, [confirmed_items]);
        
        // Send internal notification
        try {
          await supplierEmailService.sendInternalConfirmationUpdate(
            supplier,
            confirmedItemsResult.rows,
            'confirmed',
            requestedBy
          );
        } catch (emailError) {
          console.error('Failed to send internal confirmation email:', emailError);
        }
      }
    }
    
    // Process rejected items
    if (rejected_items && rejected_items.length > 0) {
      const rejectQuery = `
        UPDATE supplier_items 
        SET status = 'SUPPLIER_REJECTED', 
            supplier_confirmed = false, 
            supplier_confirmed_at = CURRENT_TIMESTAMP,
            supplier_rejection_reason = $3,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ANY($1) AND confirmation_token = $2
      `;
      
      const rejectResult = await db.query(rejectQuery, [rejected_items, token, rejection_reason]);
      rejectedCount = rejectResult.rowCount;
      
      // Get rejected item details for notification
      if (rejectedCount > 0) {
        const rejectedItemsQuery = `
          SELECT ii.id, i.name as item_name, i.approved_item_code as sku
          FROM supplier_items si
          JOIN inventory_items ii ON si.item_id = ii.id
          JOIN items i ON ii.item_master_id = i.id
          WHERE si.id = ANY($1)
        `;
        
        const rejectedItemsResult = await db.query(rejectedItemsQuery, [rejected_items]);
        
        // Send internal notification
        try {
          await supplierEmailService.sendInternalConfirmationUpdate(
            supplier,
            rejectedItemsResult.rows,
            'rejected',
            requestedBy
          );
        } catch (emailError) {
          console.error('Failed to send internal rejection email:', emailError);
        }
      }
    }
    
    res.json({
      success: true,
      data: {
        confirmed_count: confirmedCount,
        rejected_count: rejectedCount
      },
      message: `Confirmation processed: ${confirmedCount} items confirmed, ${rejectedCount} items rejected`
    });
    
  } catch (error) {
    console.error('Error processing supplier confirmation:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process confirmation'
    });
  }
});

// GET /supplier-confirmation/:token/status - Check status of confirmation
router.get('/:token/status', portalCompany('supplier_item'), async (req, res) => {
  try {
    const { token } = req.params;
    
    const query = `
      SELECT 
        si.status,
        si.supplier_confirmed,
        si.supplier_confirmed_at,
        si.supplier_rejection_reason,
        si.confirmation_requested_at,
        COUNT(*) as total_items,
        COUNT(CASE WHEN si.status = 'ACTIVE' THEN 1 END) as confirmed_items,
        COUNT(CASE WHEN si.status = 'SUPPLIER_REJECTED' THEN 1 END) as rejected_items,
        COUNT(CASE WHEN si.status = 'PENDING_SUPPLIER_CONFIRMATION' THEN 1 END) as pending_items
      FROM supplier_items si
      WHERE si.confirmation_token = $1
      GROUP BY si.status, si.supplier_confirmed, si.supplier_confirmed_at, 
               si.supplier_rejection_reason, si.confirmation_requested_at
    `;
    
    const result = await db.query(query, [token]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Confirmation token not found'
      });
    }
    
    const status = result.rows[0];
    
    res.json({
      success: true,
      data: {
        status,
        is_expired: new Date() > new Date(status.confirmation_requested_at).getTime() + (7 * 24 * 60 * 60 * 1000)
      }
    });
    
  } catch (error) {
    console.error('Error checking confirmation status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check confirmation status'
    });
  }
});

module.exports = router;