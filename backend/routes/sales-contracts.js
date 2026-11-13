const express = require('express');
const router = express.Router();
const SalesContract = require('../models/SalesContract');
const { auth: requireAuth, requireRole } = require('../middleware/auth');
const { portalCompany } = require('../services/portalScope');
const { appBase } = require('../config/appLinks');

router.get('/', requireAuth, async (req, res) => {
  try {
    const filters = {
      search: req.query.search,
      status: req.query.status,
      contract_type: req.query.contract_type,
      customer_id: req.query.customer_id,
      supplier_id: req.query.supplier_id,
      approval_status: req.query.approval_status,
      start_date_from: req.query.start_date_from,
      end_date_to: req.query.end_date_to,
      expiring_soon: req.query.expiring_soon,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
    };

    const contracts = await SalesContract.findAll(filters);
    
    res.json({
      success: true,
      data: contracts,
      total: contracts.length
    });
  } catch (error) {
    console.error('Error fetching sales contracts:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch sales contracts' 
    });
  }
});

router.get('/stats', requireAuth, async (req, res) => {
  try {
    const stats = await SalesContract.getStats();
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Error fetching contract stats:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch contract statistics' 
    });
  }
});

// GET /sales-contracts/pending-approvals - Get contracts pending approval for current user
router.get('/pending-approvals', requireAuth, async (req, res) => {
  try {
    const pendingApprovals = await SalesContract.getPendingApprovals(req.user.id);
    
    res.json({
      success: true,
      data: pendingApprovals
    });
  } catch (error) {
    console.error('Error fetching pending contract approvals:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch pending approvals' 
    });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const contract = await SalesContract.findById(req.params.id);
    
    if (!contract) {
      return res.status(404).json({
        success: false,
        error: 'Sales contract not found'
      });
    }

    // The admin UI has no other way to see or share this — it was previously
    // only ever emailed, and silently never emailed at all when the customer
    // has no primary_email on file.
    const tokenLive = contract.customer_response_token
      && !contract.customer_response_token_used_at
      && (!contract.customer_response_token_expires_at || new Date(contract.customer_response_token_expires_at) > new Date());
    contract.customer_portal_url = tokenLive
      ? `${appBase()}/contract-response/${contract.customer_response_token}`
      : null;

    res.json({
      success: true,
      data: contract
    });
  } catch (error) {
    console.error('Error fetching sales contract:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch sales contract'
    });
  }
});

router.get('/:id/status-history', requireAuth, async (req, res) => {
  try {
    const history = await SalesContract.getStatusHistory(req.params.id);
    
    res.json({
      success: true,
      data: history
    });
  } catch (error) {
    console.error('Error fetching contract status history:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch status history' 
    });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const {
      contract_name,
      customer_id,
      customer_name,
      supplier_id,
      supplier_name,
      contract_type,
      contract_value,
      currency,
      payment_terms,
      incoterms,
      start_date,
      end_date,
      auto_renewal,
      renewal_period_months,
      default_lead_time_days,
      delivery_terms,
      delivery_location,
      signed_contract_url,
      contract_attachment_urls,
      terms_and_conditions,
      special_conditions,
      days_before_expiry_notification,
      linked_rfq_id,
      linked_quotation_id,
      notes,
      internal_notes,
      items
    } = req.body;

    if (!contract_name) {
      return res.status(400).json({ 
        success: false, 
        error: 'Contract name is required' 
      });
    }

    if (!start_date || !end_date) {
      return res.status(400).json({
        success: false,
        error: 'Start date and end date are required'
      });
    }

    // new Date() on a garbled string returns Invalid Date, and every comparison
    // against a NaN timestamp — including <= — evaluates to false, so a bad
    // date used to sail straight past the check below and fail later as a raw
    // Postgres "invalid input syntax for type date" 500.
    if (isNaN(new Date(start_date).getTime()) || isNaN(new Date(end_date).getTime())) {
      return res.status(400).json({
        success: false,
        error: 'Start date and end date must be valid dates'
      });
    }

    if (new Date(end_date) <= new Date(start_date)) {
      return res.status(400).json({
        success: false,
        error: 'End date must be after start date'
      });
    }

    if (!items || items.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'At least one contract item is required' 
      });
    }

    for (const item of items) {
      if (!item.item_name || !item.unit_price || !item.unit_of_measure) {
        return res.status(400).json({ 
          success: false, 
          error: 'All item fields are required: item_name, unit_price, unit_of_measure' 
        });
      }
    }

    // Helper function to clean integer fields
    const cleanIntField = (value) => {
      if (value === '' || value === null || value === undefined) return null;
      const parsed = parseInt(value);
      return isNaN(parsed) ? null : parsed;
    };

    // Helper to clean empty string fields to null for UUID fields
    const cleanUuidField = (value) => {
      return (value === '' || value === null || value === undefined) ? null : value;
    };

    const contractData = {
      contract_name,
      customer_id,
      customer_name,
      supplier_id,
      supplier_name,
      contract_type: contract_type || 'SALES',
      contract_value,
      currency: currency || 'USD',
      payment_terms,
      incoterms,
      start_date,
      end_date,
      auto_renewal,
      renewal_period_months: cleanIntField(renewal_period_months),
      default_lead_time_days: cleanIntField(default_lead_time_days),
      delivery_terms,
      delivery_location,
      signed_contract_url,
      contract_attachment_urls,
      terms_and_conditions,
      special_conditions,
      days_before_expiry_notification: cleanIntField(days_before_expiry_notification),
      linked_rfq_id: cleanUuidField(linked_rfq_id),
      linked_quotation_id: cleanUuidField(linked_quotation_id),
      notes,
      internal_notes,
      items
    };

    const contract = await SalesContract.create(contractData, req.user.id);
    
    res.status(201).json({
      success: true,
      data: contract,
      message: 'Sales contract created successfully'
    });
  } catch (error) {
    console.error('Error creating sales contract:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to create sales contract' 
    });
  }
});

router.put('/:id', requireAuth, async (req, res) => {
  try {
    const {
      contract_name,
      customer_id,
      customer_name,
      supplier_id,
      supplier_name,
      contract_type,
      contract_value,
      currency,
      payment_terms,
      incoterms,
      start_date,
      end_date,
      auto_renewal,
      renewal_period_months,
      default_lead_time_days,
      delivery_terms,
      delivery_location,
      signed_contract_url,
      contract_attachment_urls,
      terms_and_conditions,
      special_conditions,
      days_before_expiry_notification,
      notes,
      internal_notes,
      items
    } = req.body;

    if (start_date && isNaN(new Date(start_date).getTime())) {
      return res.status(400).json({
        success: false,
        error: 'Start date must be a valid date'
      });
    }

    if (end_date && isNaN(new Date(end_date).getTime())) {
      return res.status(400).json({
        success: false,
        error: 'End date must be a valid date'
      });
    }

    if (start_date && end_date && new Date(end_date) <= new Date(start_date)) {
      return res.status(400).json({
        success: false,
        error: 'End date must be after start date'
      });
    }

    if (items && items.length > 0) {
      for (const item of items) {
        if (!item.item_name || !item.unit_price || !item.unit_of_measure) {
          return res.status(400).json({ 
            success: false, 
            error: 'All item fields are required: item_name, unit_price, unit_of_measure' 
          });
        }
      }
    }

    // Helper function to clean integer fields
    const cleanIntField = (value) => {
      if (value === '' || value === null || value === undefined) return null;
      const parsed = parseInt(value);
      return isNaN(parsed) ? null : parsed;
    };

    const contractData = {
      contract_name,
      customer_id,
      customer_name,
      supplier_id,
      supplier_name,
      contract_type,
      contract_value,
      currency,
      payment_terms,
      incoterms,
      start_date,
      end_date,
      auto_renewal,
      renewal_period_months: cleanIntField(renewal_period_months),
      default_lead_time_days: cleanIntField(default_lead_time_days),
      delivery_terms,
      delivery_location,
      signed_contract_url,
      contract_attachment_urls,
      terms_and_conditions,
      special_conditions,
      days_before_expiry_notification: cleanIntField(days_before_expiry_notification),
      notes,
      internal_notes,
      items
    };

    const contract = await SalesContract.update(req.params.id, contractData, req.user.id);
    
    if (!contract) {
      return res.status(404).json({ 
        success: false, 
        error: 'Sales contract not found' 
      });
    }
    
    res.json({
      success: true,
      data: contract,
      message: 'Sales contract updated successfully'
    });
  } catch (error) {
    console.error('Error updating sales contract:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to update sales contract' 
    });
  }
});

router.put('/:id/status', requireAuth, async (req, res) => {
  try {
    const { status, reason } = req.body;
    
    if (!status) {
      return res.status(400).json({ 
        success: false, 
        error: 'Status is required' 
      });
    }

    const validStatuses = ['DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'EXPIRED', 'TERMINATED', 'SUSPENDED'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid status' 
      });
    }

    const contract = await SalesContract.updateStatus(
      req.params.id, 
      status, 
      req.user.id, 
      reason || ''
    );
    
    if (!contract) {
      return res.status(404).json({ 
        success: false, 
        error: 'Sales contract not found' 
      });
    }
    
    res.json({
      success: true,
      data: contract,
      message: 'Contract status updated successfully'
    });
  } catch (error) {
    console.error('Error updating contract status:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to update contract status' 
    });
  }
});

// POST /sales-contracts/:id/request-approval - Request approval for contract
router.post('/:id/request-approval', requireAuth, async (req, res) => {
  try {
    const { notes } = req.body;
    
    const contract = await SalesContract.requestApproval(
      req.params.id,
      req.user.id,
      notes || ''
    );
    
    res.json({
      success: true,
      data: contract,
      message: 'Contract submitted for approval successfully'
    });
  } catch (error) {
    console.error('Error requesting contract approval:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to submit contract for approval'
    });
  }
});

// POST /sales-contracts/:id/approve - Approve contract
router.post('/:id/approve', requireAuth, async (req, res) => {
  try {
    const { approval_notes } = req.body;
    
    const approvedContract = await SalesContract.approveContract(
      req.params.id, 
      req.user.id, 
      approval_notes || ''
    );
    
    res.json({
      success: true,
      data: approvedContract,
      message: approvedContract.email_warning || 'Contract approved successfully and sent to customer'
    });
  } catch (error) {
    console.error('Error approving contract:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to approve contract' 
    });
  }
});

// POST /sales-contracts/:id/resend-customer-email - Re-send the customer acceptance link
router.post('/:id/resend-customer-email', requireAuth, async (req, res) => {
  try {
    const result = await SalesContract.resendCustomerEmail(req.params.id);
    res.json({
      success: true,
      data: result,
      message: `Contract email re-sent to ${result.recipient}`
    });
  } catch (error) {
    console.error('Error resending contract email:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to resend contract email'
    });
  }
});

// POST /sales-contracts/:id/reject - Reject contract
router.post('/:id/reject', requireAuth, async (req, res) => {
  try {
    const { rejection_reason } = req.body;
    
    if (!rejection_reason || !rejection_reason.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Rejection reason is required'
      });
    }
    
    const rejectedContract = await SalesContract.rejectContract(
      req.params.id, 
      req.user.id, 
      rejection_reason
    );
    
    res.json({
      success: true,
      data: rejectedContract,
      message: 'Contract rejected successfully'
    });
  } catch (error) {
    console.error('Error rejecting contract:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to reject contract' 
    });
  }
});

// PUT /sales-contracts/:id/approve - Legacy approve endpoint (keeping for backward compatibility)
router.put('/:id/approve', requireAuth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const { reason } = req.body;

    const contract = await SalesContract.approve(req.params.id, req.user.id, reason || '');
    
    if (!contract) {
      return res.status(404).json({ 
        success: false, 
        error: 'Sales contract not found' 
      });
    }
    
    res.json({
      success: true,
      data: contract,
      message: 'Contract approved successfully'
    });
  } catch (error) {
    console.error('Error approving contract:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to approve contract' 
    });
  }
});

router.delete('/:id', requireAuth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const contract = await SalesContract.delete(req.params.id, req.user.id);
    
    if (!contract) {
      return res.status(404).json({ 
        success: false, 
        error: 'Sales contract not found' 
      });
    }
    
    res.json({
      success: true,
      message: 'Sales contract deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting sales contract:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to delete sales contract' 
    });
  }
});

// GET /sales-contracts/customer-response/:token - Get contract details for customer (public)
router.get('/customer-response/:token', portalCompany('customer_contract'), async (req, res) => {
  try {
    const { token } = req.params;
    
    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'Token is required'
      });
    }
    
    const db = require('../config/database');
    const query = `
      SELECT 
        sc.*,
        c.customer_name as customer_name_full,
        c.primary_email as customer_email,
        c.phone as customer_phone,
        u.first_name || ' ' || u.last_name as created_by_name
      FROM sales_contracts sc
      LEFT JOIN customers c ON sc.customer_id = c.id
      LEFT JOIN users u ON sc.created_by = u.id
      WHERE sc.customer_response_token = $1
        AND sc.deleted_at IS NULL
        AND (sc.customer_response_token_expires_at IS NULL OR sc.customer_response_token_expires_at > NOW())
        AND sc.customer_response_token_used_at IS NULL
    `;
    
    const result = await db.query(query, [token]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Contract not found or invalid token'
      });
    }
    
    const contract = result.rows[0];
    
    // Get contract items
    const itemsQuery = `
      SELECT 
        sci.*,
        i.name as inventory_item_name,
        i.item_code as inventory_item_code,
        i.approved_item_code
      FROM sales_contract_items sci
      LEFT JOIN inventory_items ii ON sci.inventory_item_id = ii.id
      LEFT JOIN items i ON ii.item_master_id = i.id
      WHERE sci.sales_contract_id = $1
      ORDER BY sci.line_number
    `;
    
    const itemsResult = await db.query(itemsQuery, [contract.id]);
    contract.items = itemsResult.rows;
    
    // Remove sensitive data
    delete contract.internal_notes;
    delete contract.approval_notes;
    delete contract.rejection_reason;
    
    res.json({
      success: true,
      data: contract
    });
  } catch (error) {
    console.error('Error fetching contract for customer response:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch contract details'
    });
  }
});

// POST /sales-contracts/customer-response/:token - Customer response endpoint (public)
router.post('/customer-response/:token', portalCompany('customer_contract'), async (req, res) => {
  try {
    const { token } = req.params;
    const { action, customer_name, customer_email, comments } = req.body;
    
    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'Token is required'
      });
    }
    
    if (!action || !['accept', 'reject'].includes(action)) {
      return res.status(400).json({
        success: false,
        error: 'Action must be either "accept" or "reject"'
      });
    }
    
    const db = require('../config/database');
    
    // Find the contract by token
    const contractQuery = `
      SELECT sc.*, c.customer_name as customer_name_full, c.primary_email
      FROM sales_contracts sc
      LEFT JOIN customers c ON sc.customer_id = c.id
      WHERE sc.customer_response_token = $1
        AND sc.deleted_at IS NULL
        AND (sc.customer_response_token_expires_at IS NULL OR sc.customer_response_token_expires_at > NOW())
        AND sc.customer_response_token_used_at IS NULL
    `;
    
    const contractResult = await db.query(contractQuery, [token]);
    
    if (contractResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Contract not found or invalid token'
      });
    }
    
    const contract = contractResult.rows[0];
    
    // Check if contract is still pending customer response
    if (contract.status !== 'SENT_TO_CUSTOMER') {
      return res.status(400).json({
        success: false,
        error: 'This contract is no longer available for customer response'
      });
    }
    
    // Update contract based on customer response
    const newStatus = action === 'accept' ? 'ACTIVE' : 'CUSTOMER_REJECTED';
    const newApprovalStatus = action === 'accept' ? 'APPROVED' : contract.approval_status;
    
    const updateQuery = `
      UPDATE sales_contracts
      SET
        status = $1,
        approval_status = $2,
        customer_response_date = CURRENT_TIMESTAMP,
        customer_response_action = $3,
        customer_response_comments = $4,
        customer_response_name = $5,
        customer_response_email = $6,
        customer_response_token_used_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $7
      RETURNING *
    `;
    
    await db.query(updateQuery, [
      newStatus,
      newApprovalStatus,
      action.toUpperCase(),
      comments || '',
      customer_name || contract.customer_name_full,
      customer_email || contract.primary_email,
      contract.id
    ]);
    
    // Add status history
    const SalesContract = require('../models/SalesContract');
    const statusHistoryQuery = `
      INSERT INTO sales_contract_status_history 
      (sales_contract_id, from_status, to_status, reason, status_date)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
    `;
    
    await db.query(statusHistoryQuery, [
      contract.id,
      'SENT_TO_CUSTOMER',
      newStatus,
      `Customer ${action}ed contract${comments ? ': ' + comments : ''}`
    ]);
    
    // Create notification for contract creator and approver
    const Notification = require('../models/Notification');
    
    const notificationTitle = `Contract ${action === 'accept' ? 'Activated' : 'Rejected'}: ${contract.contract_name}`;
    const notificationMessage = `Customer has ${action}ed contract ${contract.contract_number}${action === 'accept' ? ' - Contract is now ACTIVE' : ''}${comments ? ': ' + comments : ''}`;
    
    // Notify contract creator
    if (contract.created_by) {
      await Notification.create({
        user_id: contract.created_by,
        type: `SALES_CONTRACT_CUSTOMER_${action.toUpperCase()}ED`,
        title: notificationTitle,
        message: notificationMessage,
        related_type: 'CONTRACT',
        related_id: contract.id
      });
    }
    
    // Notify approver if different from creator
    if (contract.approved_by && contract.approved_by !== contract.created_by) {
      await Notification.create({
        user_id: contract.approved_by,
        type: `SALES_CONTRACT_CUSTOMER_${action.toUpperCase()}ED`,
        title: notificationTitle,
        message: notificationMessage,
        related_type: 'CONTRACT',
        related_id: contract.id
      });
    }
    
    res.json({
      success: true,
      message: `Contract ${action}ed successfully`,
      data: {
        contract_number: contract.contract_number,
        contract_name: contract.contract_name,
        action: action,
        response_date: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error processing customer response:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to process customer response' 
    });
  }
});

module.exports = router;