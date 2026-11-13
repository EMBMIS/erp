const express = require('express');
const router = express.Router();
const Supplier = require('../models/Supplier');
const { auth, requireRole } = require('../middleware/auth');

// GET /suppliers - List all suppliers with filters
router.get('/', auth, async (req, res) => {
  try {
    const suppliers = await Supplier.findAll(req.query, req.user.id);
    res.json({
      success: true,
      data: suppliers,
      count: suppliers.length
    });
  } catch (error) {
    console.error('Error fetching suppliers:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch suppliers'
    });
  }
});

// GET /suppliers/stats - Get supplier statistics
router.get('/stats', auth, async (req, res) => {
  try {
    const stats = await Supplier.getStats(req.user.id);
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Error fetching supplier stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch statistics'
    });
  }
});

// GET /suppliers/active - Get active suppliers for dropdowns (filtered by user)
router.get('/active', auth, async (req, res) => {
  try {
    const suppliers = await Supplier.getActiveSuppliersByUser(req.user.id);
    res.json({
      success: true,
      data: suppliers
    });
  } catch (error) {
    console.error('Error fetching active suppliers:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch active suppliers'
    });
  }
});

// GET /suppliers/certified - Get certified suppliers for contracts
router.get('/certified', auth, async (req, res) => {
  try {
    const suppliers = await Supplier.getCertifiedSuppliers();
    res.json({
      success: true,
      data: suppliers
    });
  } catch (error) {
    console.error('Error fetching certified suppliers:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch certified suppliers'
    });
  }
});

// GET /suppliers/by-item/:itemId - Get suppliers who can provide a specific item
router.get('/by-item/:itemId', auth, async (req, res) => {
  try {
    const { status = 'ACTIVE' } = req.query;
    
    const query = `
      SELECT DISTINCT
        s.id,
        s.supplier_code,
        s.legal_name,
        s.trade_name,
        s.email,
        s.phone,
        s.status,
        s.certification_status,
        si.unit_price,
        si.currency,
        si.minimum_order_quantity,
        si.lead_time_days,
        si.is_preferred,
        si.supplier_confirmed
      FROM suppliers s
      JOIN supplier_items si ON s.id = si.supplier_id
      WHERE si.item_id = $1 
        AND si.status = $2 
        AND s.status = 'ACTIVE'
      ORDER BY si.is_preferred DESC, si.unit_price ASC
    `;
    
    const result = await require('../config/database').query(query, [req.params.itemId, status]);
    
    res.json({
      success: true,
      data: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching suppliers by item:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch suppliers for item'
    });
  }
});

// GET /suppliers/pending-approval - Get suppliers pending approval (Manager/Admin only)
router.get('/pending-approval', auth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const suppliers = await Supplier.findPendingApproval();
    res.json({
      success: true,
      data: suppliers
    });
  } catch (error) {
    console.error('Error fetching pending suppliers:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch pending suppliers'
    });
  }
});

// GET /suppliers/:id - Get single supplier by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id, req.user.id);
    
    if (!supplier) {
      return res.status(404).json({
        success: false,
        error: 'Supplier not found'
      });
    }

    res.json({
      success: true,
      data: supplier
    });
  } catch (error) {
    console.error('Error fetching supplier:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch supplier'
    });
  }
});

// POST /suppliers - Create new supplier
router.post('/', auth, async (req, res) => {
  try {
    const {
      legal_name,
      trade_name,
      email,
      phone,
      address,
      country,
      city,
      postal_code,
      supplier_type,
      payment_terms,
      currency
    } = req.body;

    // Validate required fields
    if (!legal_name) {
      return res.status(400).json({
        success: false,
        error: 'Legal name is required'
      });
    }

    const supplier = await Supplier.create(req.body, req.user.id);
    
    res.status(201).json({
      success: true,
      data: supplier,
      message: 'Supplier created successfully'
    });
  } catch (error) {
    console.error('Error creating supplier:', error);
    
    if (error.code === '23505') { // Unique constraint violation
      return res.status(400).json({
        success: false,
        error: 'Supplier code already exists'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to create supplier'
    });
  }
});

// PUT /suppliers/:id - Update supplier
router.put('/:id', auth, async (req, res) => {
  try {
    const supplier = await Supplier.update(req.params.id, req.body, req.user.id);
    
    if (!supplier) {
      return res.status(404).json({
        success: false,
        error: 'Supplier not found'
      });
    }

    res.json({
      success: true,
      data: supplier,
      message: 'Supplier updated successfully'
    });
  } catch (error) {
    console.error('Error updating supplier:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update supplier'
    });
  }
});

// POST /suppliers/:id/submit-for-approval - Submit supplier for approval
router.post('/:id/submit-for-approval', auth, async (req, res) => {
  try {
    const supplier = await Supplier.submitForApproval(req.params.id, req.user.id);
    
    if (!supplier) {
      return res.status(404).json({
        success: false,
        error: 'Supplier not found or cannot be submitted for approval'
      });
    }

    res.json({
      success: true,
      data: supplier,
      message: 'Supplier submitted for approval successfully'
    });
  } catch (error) {
    console.error('Error submitting supplier for approval:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to submit supplier for approval'
    });
  }
});

// POST /suppliers/:id/approve - Approve supplier (Manager/Admin only)
router.post('/:id/approve', auth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const supplier = await Supplier.approve(req.params.id, req.user.id);
    
    if (!supplier) {
      return res.status(404).json({
        success: false,
        error: 'Supplier not found or not pending approval'
      });
    }

    res.json({
      success: true,
      data: supplier,
      message: 'Supplier approved successfully'
    });
  } catch (error) {
    console.error('Error approving supplier:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to approve supplier'
    });
  }
});

// POST /suppliers/:id/decline - Decline supplier (Manager/Admin only)
router.post('/:id/decline', auth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const { reason } = req.body;

    if (!reason || reason.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Decline reason is required'
      });
    }

    const supplier = await Supplier.decline(req.params.id, req.user.id, reason);
    
    if (!supplier) {
      return res.status(404).json({
        success: false,
        error: 'Supplier not found or not pending approval'
      });
    }

    res.json({
      success: true,
      data: supplier,
      message: 'Supplier declined successfully'
    });
  } catch (error) {
    console.error('Error declining supplier:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to decline supplier'
    });
  }
});

// DELETE /suppliers/:id - Delete supplier
router.delete('/:id', auth, async (req, res) => {
  try {
    const supplier = await Supplier.delete(req.params.id, req.user.id);
    
    if (!supplier) {
      return res.status(404).json({
        success: false,
        error: 'Supplier not found'
      });
    }

    res.json({
      success: true,
      message: 'Supplier deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting supplier:', error);
    
    if (error.code === '23503') { // Foreign key constraint
      return res.status(400).json({
        success: false,
        error: 'Cannot delete supplier - it is referenced by other records'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to delete supplier'
    });
  }
});

// POST /suppliers/:id/certify - Certify supplier (Manager/Admin only)
router.post('/:id/certify', auth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const supplier = await Supplier.certify(req.params.id, req.user.id);
    
    if (!supplier) {
      return res.status(404).json({
        success: false,
        error: 'Supplier not found or not approved'
      });
    }

    res.json({
      success: true,
      data: supplier,
      message: 'Supplier certified successfully'
    });
  } catch (error) {
    console.error('Error certifying supplier:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to certify supplier'
    });
  }
});

// POST /suppliers/:id/decertify - Revoke supplier certification (Manager/Admin only)
router.post('/:id/decertify', auth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const { reason } = req.body;

    if (!reason || reason.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Reason for decertification is required'
      });
    }

    const supplier = await Supplier.decertify(req.params.id, req.user.id, reason.trim());
    
    if (!supplier) {
      return res.status(404).json({
        success: false,
        error: 'Supplier not found'
      });
    }

    res.json({
      success: true,
      data: supplier,
      message: 'Supplier certification revoked successfully'
    });
  } catch (error) {
    console.error('Error revoking supplier certification:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to revoke supplier certification'
    });
  }
});

module.exports = router;