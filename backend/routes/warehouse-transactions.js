const express = require('express');
const router = express.Router();
const WarehouseTransaction = require('../models/WarehouseTransaction');
const { auth, requireRole } = require('../middleware/auth');

// Get all warehouse transactions with filters
router.get('/', auth, async (req, res) => {
  try {
    const filters = {
      transaction_type: req.query.transaction_type,
      status: req.query.status,
      date_from: req.query.date_from,
      date_to: req.query.date_to,
      created_by: req.query.created_by,
      reference_document: req.query.reference_document,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
    };

    // Remove undefined filters
    Object.keys(filters).forEach(key => {
      if (filters[key] === undefined || filters[key] === '') {
        delete filters[key];
      }
    });

    const transactions = await WarehouseTransaction.getAll(filters);
    
    res.json({
      success: true,
      data: transactions,
      count: transactions.length
    });
  } catch (error) {
    console.error('Error fetching warehouse transactions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch warehouse transactions'
    });
  }
});

// Get warehouse transaction statistics
router.get('/stats', auth, async (req, res) => {
  try {
    const filters = {
      date_from: req.query.date_from,
      date_to: req.query.date_to
    };

    // Remove undefined filters
    Object.keys(filters).forEach(key => {
      if (filters[key] === undefined || filters[key] === '') {
        delete filters[key];
      }
    });

    const stats = await WarehouseTransaction.getStats(filters);
    
    res.json({
      success: true,
      data: {
        todayTransactions: parseInt(stats.today_transactions),
        weeklyTransactions: parseInt(stats.week_transactions),
        pendingApprovals: parseInt(stats.pending_approvals),
        stockValue: parseFloat(stats.total_value || 0),
        totalTransactions: parseInt(stats.total_transactions),
        breakdowns: {
          goodsReceipts: parseInt(stats.goods_receipts),
          goodsIssues: parseInt(stats.goods_issues),
          goodsReturns: parseInt(stats.goods_returns),
          goodsTransfers: parseInt(stats.goods_transfers),
          stockAdjustments: parseInt(stats.stock_adjustments)
        }
      }
    });
  } catch (error) {
    console.error('Error fetching warehouse transaction stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch warehouse transaction statistics'
    });
  }
});

// Get specific warehouse transaction by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const transaction = await WarehouseTransaction.getById(req.params.id);
    
    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Warehouse transaction not found'
      });
    }

    res.json({
      success: true,
      data: transaction
    });
  } catch (error) {
    console.error('Error fetching warehouse transaction:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch warehouse transaction'
    });
  }
});

// Get audit trail for a transaction
router.get('/:id/audit', auth, async (req, res) => {
  try {
    const auditTrail = await WarehouseTransaction.getAuditTrail(req.params.id);
    
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

// Create new warehouse transaction
router.post('/', auth, async (req, res) => {
  try {
    const {
      transaction_type,
      reference_document,
      reference_type,
      reference_id,
      return_type,
      transfer_type,
      adjustment_type,
      cost_center,
      job_reference,
      notes,
      sales_order_id,
      items = []
    } = req.body;

    // Validate required fields
    if (!transaction_type) {
      return res.status(400).json({
        success: false,
        error: 'Transaction type is required'
      });
    }

    if (!items || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one item is required'
      });
    }

    // Validate transaction type
    const validTypes = ['GR', 'GI', 'GE', 'GT', 'SA'];
    if (!validTypes.includes(transaction_type)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid transaction type'
      });
    }

    // Validate items based on transaction type
    for (const item of items) {
      if (!item.item_name) {
        return res.status(400).json({
          success: false,
          error: 'Item name is required for all items'
        });
      }

      // Check quantity fields based on transaction type
      switch (transaction_type) {
        case 'GR':
          if (!item.received_quantity) {
            return res.status(400).json({
              success: false,
              error: 'Received quantity is required for goods receipt'
            });
          }
          break;
        case 'GI':
          if (!item.issued_quantity) {
            return res.status(400).json({
              success: false,
              error: 'Issue quantity is required for goods issue'
            });
          }
          break;
        case 'GE':
          if (!item.return_quantity) {
            return res.status(400).json({
              success: false,
              error: 'Return quantity is required for goods return'
            });
          }
          break;
        case 'GT':
          if (!item.transfer_quantity) {
            return res.status(400).json({
              success: false,
              error: 'Transfer quantity is required for goods transfer'
            });
          }
          if (!item.destination_storage_location_id) {
            return res.status(400).json({
              success: false,
              error: 'Destination location is required for goods transfer'
            });
          }
          break;
        case 'SA':
          if (item.physical_quantity === undefined || item.physical_quantity === null) {
            return res.status(400).json({
              success: false,
              error: 'Physical quantity is required for stock adjustment'
            });
          }
          break;
      }
    }

    // Check if approval is required for stock adjustments
    let requiresApproval = false;
    const approvalThreshold = 1000; // $1000 threshold

    if (transaction_type === 'SA') {
      const totalValue = items.reduce((sum, item) => {
        const adjustmentQty = Math.abs(item.adjustment_quantity || 0);
        const unitCost = parseFloat(item.unit_cost || 0);
        return sum + (adjustmentQty * unitCost);
      }, 0);
      
      requiresApproval = totalValue > approvalThreshold;
    }

    const transactionData = {
      transaction_type,
      reference_document,
      reference_type,
      reference_id: sales_order_id || reference_id,
      return_type,
      transfer_type,
      adjustment_type,
      cost_center,
      job_reference,
      notes,
      created_by: req.user.id,
      processed_by: req.user.id,
      requires_approval: requiresApproval
    };

    const transaction = await WarehouseTransaction.create(transactionData, items);
    
    res.status(201).json({
      success: true,
      message: requiresApproval 
        ? 'Transaction created and submitted for approval' 
        : 'Transaction created successfully',
      data: transaction
    });
  } catch (error) {
    console.error('Error creating warehouse transaction:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create warehouse transaction'
    });
  }
});

// Approve warehouse transaction (Manager/Admin only)
router.post('/:id/approve', auth, requireRole(['MANAGER', 'ADMIN']), async (req, res) => {
  try {
    const { notes } = req.body;
    
    const transaction = await WarehouseTransaction.approve(req.params.id, req.user.id, notes);
    
    res.json({
      success: true,
      message: 'Transaction approved successfully',
      data: transaction
    });
  } catch (error) {
    console.error('Error approving warehouse transaction:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to approve warehouse transaction'
    });
  }
});

// Reject warehouse transaction (Manager/Admin only)
router.post('/:id/reject', auth, requireRole(['MANAGER', 'ADMIN']), async (req, res) => {
  try {
    const { reason } = req.body;
    
    if (!reason) {
      return res.status(400).json({
        success: false,
        error: 'Rejection reason is required'
      });
    }
    
    const transaction = await WarehouseTransaction.reject(req.params.id, req.user.id, reason);
    
    res.json({
      success: true,
      message: 'Transaction rejected successfully',
      data: transaction
    });
  } catch (error) {
    console.error('Error rejecting warehouse transaction:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to reject warehouse transaction'
    });
  }
});

// Cancel warehouse transaction
router.post('/:id/cancel', auth, async (req, res) => {
  try {
    const { reason } = req.body;
    
    if (!reason) {
      return res.status(400).json({
        success: false,
        error: 'Cancellation reason is required'
      });
    }
    
    const transaction = await WarehouseTransaction.cancel(req.params.id, req.user.id, reason);
    
    res.json({
      success: true,
      message: 'Transaction cancelled successfully',
      data: transaction
    });
  } catch (error) {
    console.error('Error cancelling warehouse transaction:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to cancel warehouse transaction'
    });
  }
});

// Get pending approvals (Manager/Admin only)
router.get('/approvals/pending', auth, requireRole(['MANAGER', 'ADMIN']), async (req, res) => {
  try {
    const transactions = await WarehouseTransaction.getAll({ status: 'PENDING_APPROVAL' });
    
    res.json({
      success: true,
      data: transactions,
      count: transactions.length
    });
  } catch (error) {
    console.error('Error fetching pending approvals:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch pending approvals'
    });
  }
});

// Bulk approve multiple transactions (Admin only)
router.post('/approvals/bulk-approve', auth, requireRole(['ADMIN']), async (req, res) => {
  try {
    const { transaction_ids, notes } = req.body;
    
    if (!transaction_ids || !Array.isArray(transaction_ids) || transaction_ids.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Transaction IDs array is required'
      });
    }

    const results = [];
    const errors = [];

    for (const id of transaction_ids) {
      try {
        const transaction = await WarehouseTransaction.approve(id, req.user.id, notes);
        results.push(transaction);
      } catch (error) {
        errors.push({ id, error: error.message });
      }
    }
    
    res.json({
      success: true,
      message: `${results.length} transactions approved successfully`,
      data: {
        approved: results,
        errors: errors
      }
    });
  } catch (error) {
    console.error('Error bulk approving transactions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to bulk approve transactions'
    });
  }
});

module.exports = router;