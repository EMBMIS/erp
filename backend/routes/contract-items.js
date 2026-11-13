const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const db = require('../config/database');

// GET /contract-items - Get all contract items with filters
router.get('/', auth, async (req, res) => {
  try {
    const { contract_id, item_id, status = 'ACTIVE' } = req.query;
    
    let query = `
      SELECT 
        ci.*,
        c.contract_number,
        c.title as contract_title,
        s.legal_name as supplier_name,
        i.name as item_name,
        i.sku,
        i.category,
        i.unit_of_measure
      FROM contract_items ci
      JOIN contracts c ON ci.contract_id = c.id
      JOIN suppliers s ON c.supplier_id = s.id
      JOIN items i ON ci.item_id = i.id
      WHERE 1=1
    `;
    
    const params = [];
    
    if (contract_id) {
      params.push(contract_id);
      query += ` AND ci.contract_id = $${params.length}`;
    }
    
    if (item_id) {
      params.push(item_id);
      query += ` AND ci.item_id = $${params.length}`;
    }
    
    if (status) {
      params.push(status);
      query += ` AND ci.status = $${params.length}`;
    }
    
    query += ` ORDER BY c.contract_number, i.name`;
    
    const result = await db.query(query, params);
    
    res.json({
      success: true,
      data: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching contract items:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch contract items'
    });
  }
});

// GET /contract-items/by-contract/:contractId - Get items for a specific contract
router.get('/by-contract/:contractId', auth, async (req, res) => {
  try {
    const { status = 'ACTIVE' } = req.query;
    
    const query = `
      SELECT 
        ci.*,
        i.name as item_name,
        i.sku,
        i.category,
        i.unit_of_measure,
        i.description as item_description,
        si.unit_price as supplier_unit_price,
        si.currency as supplier_currency,
        si.minimum_order_quantity,
        si.lead_time_days
      FROM contract_items ci
      JOIN items i ON ci.item_id = i.id
      LEFT JOIN contracts c ON ci.contract_id = c.id
      LEFT JOIN supplier_items si ON c.supplier_id = si.supplier_id AND ci.item_id = si.item_id
      WHERE ci.contract_id = $1 AND ci.status = $2
      ORDER BY i.name
    `;
    
    const result = await db.query(query, [req.params.contractId, status]);
    
    res.json({
      success: true,
      data: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching contract items:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch contract items'
    });
  }
});

// GET /contract-items/available/:contractId - Get available items for a contract (from supplier)
router.get('/available/:contractId', auth, async (req, res) => {
  try {
    const query = `
      SELECT DISTINCT
        si.item_id,
        i.name as item_name,
        i.sku,
        i.category,
        i.unit_of_measure,
        i.description,
        si.unit_price,
        si.currency,
        si.minimum_order_quantity,
        si.lead_time_days,
        si.is_preferred
      FROM supplier_items si
      JOIN items i ON si.item_id = i.id
      JOIN contracts c ON c.supplier_id = si.supplier_id
      WHERE c.id = $1 
        AND si.status = 'ACTIVE'
        AND si.item_id NOT IN (
          SELECT item_id FROM contract_items 
          WHERE contract_id = $1 AND status IN ('ACTIVE', 'PENDING_APPROVAL', 'APPROVED')
        )
      ORDER BY si.is_preferred DESC, i.name
    `;
    
    const result = await db.query(query, [req.params.contractId]);
    
    res.json({
      success: true,
      data: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching available items:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch available items'
    });
  }
});

// POST /contract-items - Add item to contract
router.post('/', auth, async (req, res) => {
  try {
    const {
      contract_id,
      item_id,
      quantity,
      unit_price,
      currency = 'USD',
      delivery_schedule,
      specifications,
      amendment_reason
    } = req.body;

    // Validate required fields
    if (!contract_id || !item_id || !quantity) {
      return res.status(400).json({
        success: false,
        error: 'Contract ID, item ID, and quantity are required'
      });
    }

    // Check if contract exists
    const contractCheck = await db.query(
      'SELECT id, status FROM contracts WHERE id = $1',
      [contract_id]
    );

    if (contractCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Contract not found'
      });
    }

    // Check if item exists
    const itemCheck = await db.query(
      'SELECT id FROM items WHERE id = $1',
      [item_id]
    );

    if (itemCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Item not found'
      });
    }

    // Check if item is already in contract
    const existingCheck = await db.query(
      'SELECT id FROM contract_items WHERE contract_id = $1 AND item_id = $2 AND status IN (\'ACTIVE\', \'PENDING_APPROVAL\', \'APPROVED\')',
      [contract_id, item_id]
    );

    if (existingCheck.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Item is already in this contract'
      });
    }

    // Determine status based on contract status
    const contractStatus = contractCheck.rows[0].status;
    let itemStatus = 'ACTIVE';
    
    if (contractStatus === 'ACTIVE' || contractStatus === 'APPROVED') {
      // If adding to an active contract, it needs approval
      itemStatus = 'PENDING_APPROVAL';
    }

    const result = await db.query(`
      INSERT INTO contract_items (
        contract_id, item_id, quantity, unit_price, currency,
        delivery_schedule, specifications, status, amendment_reason,
        amendment_requested_by, amendment_requested_at, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `, [
      contract_id, item_id, quantity, unit_price, currency,
      delivery_schedule, specifications, itemStatus, amendment_reason,
      req.user.id, new Date(), req.user.id
    ]);

    res.status(201).json({
      success: true,
      data: result.rows[0],
      message: itemStatus === 'PENDING_APPROVAL' ? 
        'Item added to contract and is pending approval' : 
        'Item added to contract successfully'
    });
  } catch (error) {
    console.error('Error adding contract item:', error);
    
    if (error.code === '23505') { // Unique constraint violation
      return res.status(400).json({
        success: false,
        error: 'Item is already in this contract'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to add item to contract'
    });
  }
});

// PUT /contract-items/:id - Update contract item
router.put('/:id', auth, async (req, res) => {
  try {
    const {
      quantity,
      unit_price,
      currency,
      delivery_schedule,
      specifications,
      status
    } = req.body;

    const updateFields = [];
    const params = [];
    let paramCount = 1;

    if (quantity !== undefined) {
      updateFields.push(`quantity = $${paramCount++}`);
      params.push(quantity);
    }
    if (unit_price !== undefined) {
      updateFields.push(`unit_price = $${paramCount++}`);
      params.push(unit_price);
    }
    if (currency !== undefined) {
      updateFields.push(`currency = $${paramCount++}`);
      params.push(currency);
    }
    if (delivery_schedule !== undefined) {
      updateFields.push(`delivery_schedule = $${paramCount++}`);
      params.push(delivery_schedule);
    }
    if (specifications !== undefined) {
      updateFields.push(`specifications = $${paramCount++}`);
      params.push(specifications);
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
      UPDATE contract_items 
      SET ${updateFields.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `;

    const result = await db.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Contract item not found'
      });
    }

    res.json({
      success: true,
      data: result.rows[0],
      message: 'Contract item updated successfully'
    });
  } catch (error) {
    console.error('Error updating contract item:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update contract item'
    });
  }
});

// POST /contract-items/approve/:id - Approve contract item (DoA or Supplier)
router.post('/approve/:id', auth, async (req, res) => {
  try {
    const { approval_type } = req.body; // 'company' or 'supplier'
    
    if (!['company', 'supplier'].includes(approval_type)) {
      return res.status(400).json({
        success: false,
        error: 'Approval type must be "company" or "supplier"'
      });
    }

    const contractItem = await db.query(
      'SELECT * FROM contract_items WHERE id = $1',
      [req.params.id]
    );

    if (contractItem.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Contract item not found'
      });
    }

    const item = contractItem.rows[0];

    // Update approval fields
    let updateFields = ['updated_at = CURRENT_TIMESTAMP'];
    let params = [req.user.id, new Date(), req.params.id];

    if (approval_type === 'company') {
      updateFields.push('company_approved_by = $1', 'company_approved_at = $2');
    } else {
      updateFields.push('supplier_approved_by = $1', 'supplier_approved_at = $2');
    }

    // Check if both approvals are complete
    const otherApproval = approval_type === 'company' ? 
      item.supplier_approved_by : 
      item.company_approved_by;

    if (otherApproval) {
      // Both approvals complete, mark as APPROVED
      updateFields.push('status = \'APPROVED\'');
    }

    const query = `
      UPDATE contract_items 
      SET ${updateFields.join(', ')}
      WHERE id = $${params.length + 1}
      RETURNING *
    `;

    const result = await db.query(query, [...params, req.params.id]);

    res.json({
      success: true,
      data: result.rows[0],
      message: `Contract item approved by ${approval_type}`
    });
  } catch (error) {
    console.error('Error approving contract item:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to approve contract item'
    });
  }
});

// POST /contract-items/decline/:id - Decline contract item
router.post('/decline/:id', auth, async (req, res) => {
  try {
    const { reason, approval_type } = req.body;

    const result = await db.query(`
      UPDATE contract_items 
      SET status = 'DECLINED', 
          amendment_reason = $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *
    `, [reason || 'Declined', req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Contract item not found'
      });
    }

    res.json({
      success: true,
      data: result.rows[0],
      message: 'Contract item declined'
    });
  } catch (error) {
    console.error('Error declining contract item:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to decline contract item'
    });
  }
});

// DELETE /contract-items/:id - Remove contract item
router.delete('/:id', auth, async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM contract_items WHERE id = $1 RETURNING *',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Contract item not found'
      });
    }

    res.json({
      success: true,
      message: 'Contract item removed successfully'
    });
  } catch (error) {
    console.error('Error removing contract item:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to remove contract item'
    });
  }
});

// POST /contract-items/bulk - Bulk add items to contract
router.post('/bulk', auth, async (req, res) => {
  try {
    const { contract_id, items } = req.body;

    if (!contract_id || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Contract ID and items array are required'
      });
    }

    // Validate contract exists and get supplier_id
    const contractCheck = await db.query(
      'SELECT id, status, supplier_id FROM contracts WHERE id = $1',
      [contract_id]
    );

    if (contractCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Contract not found'
      });
    }

    const contract = contractCheck.rows[0];
    const contractStatus = contract.status;
    const supplierId = contract.supplier_id;
    const itemStatus = (contractStatus === 'ACTIVE' || contractStatus === 'APPROVED') ? 
      'PENDING_APPROVAL' : 'ACTIVE';

    const results = [];
    const errors = [];

    for (const item of items) {
      try {
        const {
          item_id,
          quantity,
          unit_price,
          currency = 'USD',
          delivery_schedule,
          specifications,
          needs_supplier_assignment = false
        } = item;

        if (!item_id || !quantity) {
          errors.push({ item, error: 'Item ID and quantity are required' });
          continue;
        }

        // The `item_id` this endpoint receives is an inventory_items.id (it
        // comes from the supplier-items list, whose own item_id column FKs to
        // inventory_items -- see supplier_items_item_id_fkey). contract_items
        // FKs item_id to items(id), the item master, not inventory_items --
        // inserting the raw inventory_items id was a foreign-key violation on
        // every single item, on every contract, always caught by the
        // try/catch below and swallowed into `errors`. Every contract created
        // through the UI has therefore had zero items despite the "success"
        // alert the frontend showed.
        const masterLookup = await db.query('SELECT item_master_id FROM inventory_items WHERE id = $1', [item_id]);
        const itemMasterId = masterLookup.rows[0]?.item_master_id;
        if (!itemMasterId) {
          errors.push({ item, error: `Item ${item_id} does not resolve to a known item master` });
          continue;
        }

        // Check if item already exists in contract
        const existingCheck = await db.query(
          'SELECT id FROM contract_items WHERE contract_id = $1 AND item_id = $2',
          [contract_id, itemMasterId]
        );

        if (existingCheck.rows.length > 0) {
          errors.push({ item, error: 'Item already exists in contract' });
          continue;
        }

        // If item needs supplier assignment, create supplier-item relationship first
        if (needs_supplier_assignment && unit_price) {
          try {
            // Check if supplier-item relationship already exists
            const supplierItemCheck = await db.query(
              'SELECT id FROM supplier_items WHERE supplier_id = $1 AND item_id = $2',
              [supplierId, item_id]
            );

            if (supplierItemCheck.rows.length === 0) {
              // Create supplier-item relationship
              await db.query(`
                INSERT INTO supplier_items (
                  supplier_id, item_id, unit_price, currency, minimum_order_quantity,
                  created_by, status
                ) VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (supplier_id, item_id) DO UPDATE SET
                  unit_price = EXCLUDED.unit_price,
                  currency = EXCLUDED.currency,
                  updated_at = CURRENT_TIMESTAMP
              `, [
                supplierId, item_id, unit_price, currency, 1, req.user.id, 'ACTIVE'
              ]);
            }
          } catch (supplierItemError) {
            console.warn('Could not create supplier-item relationship:', supplierItemError.message);
            // Continue anyway - we can still create the contract item
          }
        }

        const result = await db.query(`
          INSERT INTO contract_items (
            contract_id, item_id, quantity, unit_price, currency,
            delivery_schedule, specifications, status, created_by
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING *
        `, [
          contract_id, itemMasterId, quantity, unit_price, currency,
          delivery_schedule, specifications, itemStatus, req.user.id
        ]);

        results.push(result.rows[0]);
      } catch (error) {
        console.error('Error in bulk insert:', error);
        errors.push({ item, error: error.message });
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
          errors: errors.length,
          status: itemStatus
        }
      },
      message: `Bulk operation completed: ${results.length} items added, ${errors.length} errors`
    });
  } catch (error) {
    console.error('Error in bulk contract items creation:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to add items to contract in bulk'
    });
  }
});

module.exports = router;