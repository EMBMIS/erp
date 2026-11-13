const express = require('express');
const router = express.Router();
const PurchaseRequisition = require('../models/PurchaseRequisition');
const { auth, requireRole } = require('../middleware/auth');
const { requireSoD } = require('../middleware/rbac');
const { recordCreator } = require('../middleware/recordOwner');

// GET /purchase-requisitions - List all PRs with filters
router.get('/', auth, async (req, res) => {
  try {
    const prs = await PurchaseRequisition.findAll(req.query, req.user.id);
    res.json({
      success: true,
      data: prs,
      count: prs.length
    });
  } catch (error) {
    console.error('Error fetching purchase requisitions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch purchase requisitions'
    });
  }
});

// GET /purchase-requisitions/stats - Get PR statistics
router.get('/stats', auth, async (req, res) => {
  try {
    const stats = await PurchaseRequisition.getStats(req.user.id);
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Error fetching PR stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch statistics'
    });
  }
});

// GET /purchase-requisitions/pending-approval - Get PRs pending approval (Manager/Admin only)
router.get('/pending-approval', auth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const prs = await PurchaseRequisition.findPendingApproval();
    res.json({
      success: true,
      data: prs
    });
  } catch (error) {
    console.error('Error fetching pending PRs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch pending purchase requisitions'
    });
  }
});

// GET /purchase-requisitions/approved - Get approved PRs for RFQ/PO creation
router.get('/approved', auth, async (req, res) => {
  try {
    const prs = await PurchaseRequisition.getApprovedPRs();
    res.json({
      success: true,
      data: prs
    });
  } catch (error) {
    console.error('Error fetching approved PRs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch approved purchase requisitions'
    });
  }
});

// GET /purchase-requisitions/cost-center/:costCenter - Get PRs by cost center
router.get('/cost-center/:costCenter', auth, async (req, res) => {
  try {
    const prs = await PurchaseRequisition.getByCostCenter(req.params.costCenter);
    res.json({
      success: true,
      data: prs
    });
  } catch (error) {
    console.error('Error fetching PRs by cost center:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch purchase requisitions by cost center'
    });
  }
});

// GET /purchase-requisitions/:id - Get single PR by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const pr = await PurchaseRequisition.findById(req.params.id, req.user.id);
    
    if (!pr) {
      return res.status(404).json({
        success: false,
        error: 'Purchase requisition not found'
      });
    }

    res.json({
      success: true,
      data: pr
    });
  } catch (error) {
    console.error('Error fetching purchase requisition:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch purchase requisition'
    });
  }
});

// GET /purchase-requisitions/:id/can-convert - Check if PR can be converted to RFQ/PO
router.get('/:id/can-convert', auth, async (req, res) => {
  try {
    const canConvert = await PurchaseRequisition.canConvertToRFQ(req.params.id);
    res.json({
      success: true,
      data: { can_convert: canConvert }
    });
  } catch (error) {
    console.error('Error checking PR conversion status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check conversion status'
    });
  }
});

// POST /purchase-requisitions - Create new PR
router.post('/', auth, async (req, res) => {
  try {
    const {
      cost_center,
      item_description,
      unit_of_measure,
      quantity,
      estimated_unit_price,
      source
    } = req.body;

    // Validate required fields
    if (!cost_center) {
      return res.status(400).json({
        success: false,
        error: 'Cost center is required'
      });
    }

    if (!item_description) {
      return res.status(400).json({
        success: false,
        error: 'Item description is required'
      });
    }

    if (!quantity || quantity <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Valid quantity is required'
      });
    }

    // Auto-generated requisitions (MRP/reorder) may not have a supplier price
    // on file yet; only manual, user-submitted requisitions require an estimate
    // up front so the list's Estimated Value column is never silently blank.
    if (source !== 'MRP' && source !== 'REORDER' && (!estimated_unit_price || estimated_unit_price <= 0)) {
      return res.status(400).json({
        success: false,
        error: 'A valid estimated unit price is required'
      });
    }

    const pr = await PurchaseRequisition.create(req.body, req.user.id);
    
    res.status(201).json({
      success: true,
      data: pr,
      message: 'Purchase requisition created successfully'
    });
  } catch (error) {
    console.error('Error creating purchase requisition:', error);
    
    if (error.code === '23503') { // Foreign key constraint
      return res.status(400).json({
        success: false,
        error: 'Invalid item or supplier selected'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to create purchase requisition'
    });
  }
});

// PUT /purchase-requisitions/:id - Update PR
router.put('/:id', auth, async (req, res) => {
  try {
    const pr = await PurchaseRequisition.update(req.params.id, req.body, req.user.id);
    
    if (!pr) {
      return res.status(404).json({
        success: false,
        error: 'Purchase requisition not found'
      });
    }

    res.json({
      success: true,
      data: pr,
      message: 'Purchase requisition updated successfully'
    });
  } catch (error) {
    console.error('Error updating purchase requisition:', error);
    
    if (error.message === 'No valid fields to update') {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to update purchase requisition'
    });
  }
});

// POST /purchase-requisitions/:id/submit-for-approval - Submit PR for approval
router.post('/:id/submit-for-approval', auth, async (req, res) => {
  try {
    const pr = await PurchaseRequisition.submitForApproval(req.params.id, req.user.id);
    
    if (!pr) {
      return res.status(404).json({
        success: false,
        error: 'Purchase requisition not found or cannot be submitted for approval'
      });
    }

    res.json({
      success: true,
      data: pr,
      message: 'Purchase requisition submitted for approval successfully'
    });
  } catch (error) {
    console.error('Error submitting PR for approval:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to submit purchase requisition for approval'
    });
  }
});

// POST /purchase-requisitions/:id/approve - Approve PR with DoA and ApprovalChain validation
router.post('/:id/approve', auth, requireRole('MANAGER', 'ADMIN'), requireSoD(recordCreator('purchase_requisitions'), 'approval'), async (req, res) => {
  try {
    const { id } = req.params;
    const db = require('../config/database');
    const ApprovalRulesEngine = require('../services/approvalRulesEngine');
    const ApprovalChain = require('../models/ApprovalChain');

    const prResult = await db.query(
      'SELECT id, cost_center, quantity, estimated_unit_price, status FROM purchase_requisitions WHERE id = $1',
      [id]
    );
    if (prResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Purchase requisition not found'
      });
    }

    const prRow = prResult.rows[0];
    const prAmount = parseFloat(
      prRow.total_amount || (parseFloat(prRow.quantity || 0) * parseFloat(prRow.estimated_unit_price || 0)) || 0
    );

    // Amount-scoped DoA binds every role, ADMIN included; the only identity
    // exempt from amount bands is the platform owner, which the engine already
    // synthesizes as an unlimited grant (see loadDoaDefinitions).
    const hasAuthority = await ApprovalRulesEngine.checkUserAuthority(
      req.user.id,
      prAmount,
      prRow.cost_center,
      'PR'
    ) || await ApprovalRulesEngine.checkUserAuthority(
      req.user.id,
      prAmount,
      prRow.cost_center,
      'PURCHASE_REQUISITION'
    );

    if (!hasAuthority) {
      return res.status(403).json({
        success: false,
        error: `Insufficient delegation of authority to approve this purchase requisition (amount: $${prAmount})`
      });
    }

    // Check if an ApprovalChain request exists for this PR
    const pendingChain = await db.query(
      "SELECT id FROM approval_requests WHERE document_type IN ('PR', 'PURCHASE_REQUISITION') AND document_id = $1 AND status = 'PENDING'",
      [id]
    );
    if (pendingChain.rows.length > 0) {
      const updatedChain = await ApprovalChain.decide(
        pendingChain.rows[0].id,
        req.user.id,
        req.user.role,
        'APPROVE',
        req.body?.comments || ''
      );
      if (updatedChain.status === 'PENDING') {
        return res.json({
          success: true,
          data: updatedChain,
          message: `Approval step ${updatedChain.current_step - 1} completed. Request advances to step ${updatedChain.current_step}.`
        });
      }
    }

    const pr = await PurchaseRequisition.approve(id, req.user.id);
    
    if (!pr) {
      return res.status(404).json({
        success: false,
        error: 'Purchase requisition not found or not pending approval'
      });
    }

    res.json({
      success: true,
      data: pr,
      message: 'Purchase requisition approved successfully'
    });
  } catch (error) {
    console.error('Error approving purchase requisition:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to approve purchase requisition'
    });
  }
});

// POST /purchase-requisitions/:id/decline - Decline PR (Manager/Admin only)
router.post('/:id/decline', auth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const { reason } = req.body;

    if (!reason || reason.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Decline reason is required'
      });
    }

    const pr = await PurchaseRequisition.decline(req.params.id, req.user.id, reason);
    
    if (!pr) {
      return res.status(404).json({
        success: false,
        error: 'Purchase requisition not found or not pending approval'
      });
    }

    res.json({
      success: true,
      data: pr,
      message: 'Purchase requisition declined successfully'
    });
  } catch (error) {
    console.error('Error declining purchase requisition:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to decline purchase requisition'
    });
  }
});

// DELETE /purchase-requisitions/:id - Delete PR
router.delete('/:id', auth, async (req, res) => {
  try {
    const pr = await PurchaseRequisition.delete(req.params.id, req.user.id);
    
    if (!pr) {
      return res.status(404).json({
        success: false,
        error: 'Purchase requisition not found'
      });
    }

    res.json({
      success: true,
      message: 'Purchase requisition deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting purchase requisition:', error);
    
    if (error.code === '23503') { // Foreign key constraint
      return res.status(400).json({
        success: false,
        error: 'Cannot delete purchase requisition - it is referenced by other records'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to delete purchase requisition'
    });
  }
});

module.exports = router;