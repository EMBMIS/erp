const express = require('express');
const router = express.Router();
const SalesQuotation = require('../models/SalesQuotation');
const Customer = require('../models/Customer');
const taxService = require('../services/taxService');
const { auth: requireAuth, requireRole } = require('../middleware/auth');
const { portalCompany } = require('../services/portalScope');

router.get('/', requireAuth, async (req, res) => {
  try {
    const filters = {
      search: req.query.search,
      status: req.query.status,
      customer_id: req.query.customer_id,
      priority: req.query.priority,
      date_from: req.query.date_from,
      date_to: req.query.date_to,
      expired: req.query.expired,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
    };

    const quotations = await SalesQuotation.findAll(filters);
    
    res.json({
      success: true,
      data: quotations,
      total: quotations.length
    });
  } catch (error) {
    console.error('Error fetching sales quotations:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch sales quotations' 
    });
  }
});

router.get('/stats', requireAuth, async (req, res) => {
  try {
    const stats = await SalesQuotation.getStats();
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Error fetching quotation stats:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch quotation statistics' 
    });
  }
});

// GET /sales-quotations/pending-approvals - Get quotations pending approval for current user
router.get('/pending-approvals', requireAuth, async (req, res) => {
  try {
    const pendingApprovals = await SalesQuotation.getPendingApprovals(req.user.id);
    
    res.json({
      success: true,
      data: pendingApprovals
    });
  } catch (error) {
    console.error('Error fetching pending quotation approvals:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch pending approvals' 
    });
  }
});

// POST /sales-quotations/:id/request-approval - Request approval for quotation
router.post('/:id/request-approval', requireAuth, async (req, res) => {
  try {
    const { notes } = req.body;
    
    const quotation = await SalesQuotation.requestApproval(
      req.params.id, 
      req.user.id, 
      notes || ''
    );
    
    res.json({
      success: true,
      data: quotation,
      message: 'Quotation sent for approval successfully'
    });
  } catch (error) {
    console.error('Error requesting quotation approval:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to request quotation approval' 
    });
  }
});

// POST /sales-quotations/:id/approve - Approve quotation
router.post('/:id/approve', requireAuth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const { approval_notes } = req.body;
    
    const approvedQuotation = await SalesQuotation.approveQuotation(
      req.params.id, 
      req.user.id, 
      approval_notes || ''
    );
    
    res.json({
      success: true,
      data: approvedQuotation,
      message: 'Quotation approved successfully'
    });
  } catch (error) {
    console.error('Error approving quotation:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to approve quotation' 
    });
  }
});

// POST /sales-quotations/:id/reject - Reject quotation
router.post('/:id/reject', requireAuth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const { rejection_reason } = req.body;
    
    if (!rejection_reason || !rejection_reason.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Rejection reason is required'
      });
    }
    
    const rejectedQuotation = await SalesQuotation.rejectQuotation(
      req.params.id, 
      req.user.id, 
      rejection_reason
    );
    
    res.json({
      success: true,
      data: rejectedQuotation,
      message: 'Quotation rejected successfully'
    });
  } catch (error) {
    console.error('Error rejecting quotation:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to reject quotation' 
    });
  }
});

// POST /sales-quotations/:id/request-send - Request approval to send quotation to customer
router.post('/:id/request-send', requireAuth, async (req, res) => {
  try {
    const result = await SalesQuotation.requestSendApproval(req.params.id, req.user.id);
    
    res.json({
      success: true,
      data: result,
      message: result.message
    });
  } catch (error) {
    console.error('Error requesting send approval:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to request send approval' 
    });
  }
});

// POST /sales-quotations/:id/approve-send - Approve sending quotation to customer
router.post('/:id/approve-send', requireAuth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const { approval_notes } = req.body;
    const result = await SalesQuotation.approveSendToCustomer(req.params.id, req.user.id, approval_notes || '');
    
    res.json({
      success: true,
      data: result,
      message: result.message
    });
  } catch (error) {
    console.error('Error approving send:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to approve send' 
    });
  }
});

// POST /sales-quotations/:id/send - Send quotation to customer (after approval)
router.post('/:id/send', requireAuth, async (req, res) => {
  try {
    const result = await SalesQuotation.sendToCustomer(req.params.id, req.user.id);
    
    res.json({
      success: true,
      data: result,
      message: 'Quotation sent to customer successfully'
    });
  } catch (error) {
    console.error('Error sending quotation:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to send quotation' 
    });
  }
});

// GET /sales-quotations/pending-send-approvals - Get quotations pending send approval
router.get('/pending-send-approvals', requireAuth, async (req, res) => {
  try {
    const DelegationOfAuthority = require('../models/DelegationOfAuthority');
    
    // Get user's authority levels
    const authorities = await DelegationOfAuthority.getUserAuthority(req.user.id, null, 'SALES_QUOTATION');
    
    if (!authorities.length) {
      return res.json({
        success: true,
        data: []
      });
    }
    
    // Find quotations that need send approval within user's authority
    const maxAuthority = Math.max(...authorities.map(a => a.max_amount || Number.MAX_SAFE_INTEGER));
    const minAuthority = Math.min(...authorities.map(a => a.min_amount || 0));
    
    const query = `
      SELECT 
        sq.*,
        c.customer_name,
        u.first_name || ' ' || u.last_name as requested_by_name
      FROM sales_quotations sq
      LEFT JOIN customers c ON sq.customer_id = c.id
      LEFT JOIN users u ON sq.send_requested_by = u.id
      WHERE sq.status = 'PENDING_SEND_APPROVAL'
        AND sq.total_amount >= $1
        AND sq.total_amount <= $2
        AND sq.send_requested_by != $3
        AND sq.deleted_at IS NULL
      ORDER BY sq.send_requested_at ASC
    `;
    
    const db = require('../config/database');
    const result = await db.query(query, [minAuthority, maxAuthority, req.user.id]);
    
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Error fetching pending send approvals:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch pending send approvals' 
    });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const quotation = await SalesQuotation.findById(req.params.id);
    
    if (!quotation) {
      return res.status(404).json({ 
        success: false, 
        error: 'Sales quotation not found' 
      });
    }
    
    res.json({
      success: true,
      data: quotation
    });
  } catch (error) {
    console.error('Error fetching sales quotation:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch sales quotation' 
    });
  }
});

router.get('/:id/status-history', requireAuth, async (req, res) => {
  try {
    const history = await SalesQuotation.getStatusHistory(req.params.id);
    
    res.json({
      success: true,
      data: history
    });
  } catch (error) {
    console.error('Error fetching quotation status history:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch status history' 
    });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const {
      customer_id,
      customer_name,
      quotation_date,
      valid_until,
      reference_number,
      currency,
      priority,
      delivery_address,
      delivery_terms,
      estimated_delivery_days,
      notes,
      internal_notes,
      terms_and_conditions,
      payment_terms,
      items
    } = req.body;

    if (!customer_id) {
      return res.status(400).json({ 
        success: false, 
        error: 'Customer ID is required' 
      });
    }

    if (!customer_name) {
      return res.status(400).json({ 
        success: false, 
        error: 'Customer name is required' 
      });
    }

    if (!items || items.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'At least one quotation item is required' 
      });
    }

    for (const item of items) {
      if (!item.item_name || !item.quantity || !item.unit_price || !item.unit_of_measure) {
        return res.status(400).json({ 
          success: false, 
          error: 'All item fields are required: item_name, quantity, unit_price, unit_of_measure' 
        });
      }
    }

    const quotationData = {
      customer_id,
      customer_name,
      quotation_date,
      valid_until,
      reference_number,
      currency,
      priority,
      delivery_address,
      delivery_terms,
      estimated_delivery_days,
      notes,
      internal_notes,
      terms_and_conditions,
      payment_terms: payment_terms === '' ? null : payment_terms,
      estimated_delivery_days: estimated_delivery_days === '' ? null : estimated_delivery_days,
      items: items.map(item => ({
        ...item,
        // Blank form fields must not crash typed columns: null, not ''.
        estimated_delivery_date: item.estimated_delivery_date || null,
        source_bin_id: item.source_bin_id || null,
        linked_sales_rfq_id: item.linked_sales_rfq_id || null,
        supplier_id: item.supplier_id || null,
        line_total: (parseFloat(item.quantity) * parseFloat(item.unit_price)) - (parseFloat(item.discount_amount) || 0)
      }))
    };

    const subtotal = quotationData.items.reduce((sum, item) => sum + item.line_total, 0);
    const discountAmount = parseFloat(quotationData.discount_amount || 0);
    let customerObj = {};
    if (quotationData.customer_id) {
      try { customerObj = (await Customer.findById(quotationData.customer_id)) || {}; } catch (_) {}
    }
    const vatRate = taxService.resolveCustomerRate(customerObj);
    const netSubtotal = Math.max(0, subtotal - discountAmount);

    quotationData.subtotal = subtotal;
    quotationData.tax_amount = taxService.computeTax(netSubtotal, vatRate);
    quotationData.total_amount = taxService.round2(netSubtotal + quotationData.tax_amount);

    const quotation = await SalesQuotation.create(quotationData, req.user.id);
    
    res.status(201).json({
      success: true,
      data: quotation,
      message: 'Sales quotation created successfully'
    });
  } catch (error) {
    console.error('Error creating sales quotation:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to create sales quotation' 
    });
  }
});

router.put('/:id', requireAuth, async (req, res) => {
  try {
    const {
      customer_id,
      customer_name,
      quotation_date,
      valid_until,
      reference_number,
      currency,
      priority,
      delivery_address,
      delivery_terms,
      estimated_delivery_days,
      notes,
      internal_notes,
      terms_and_conditions,
      payment_terms,
      items
    } = req.body;

    if (items && items.length > 0) {
      for (const item of items) {
        if (!item.item_name || !item.quantity || !item.unit_price || !item.unit_of_measure) {
          return res.status(400).json({ 
            success: false, 
            error: 'All item fields are required: item_name, quantity, unit_price, unit_of_measure' 
          });
        }
      }
    }

    const quotationData = {
      customer_id,
      customer_name,
      quotation_date,
      valid_until,
      reference_number,
      currency,
      priority,
      delivery_address,
      delivery_terms,
      estimated_delivery_days,
      notes,
      internal_notes,
      terms_and_conditions,
      payment_terms
    };

    if (items) {
      quotationData.items = items.map(item => ({
        ...item,
        line_total: (parseFloat(item.quantity) * parseFloat(item.unit_price)) - (parseFloat(item.discount_amount) || 0)
      }));

      const subtotal = quotationData.items.reduce((sum, item) => sum + item.line_total, 0);
      const discountAmount = parseFloat(quotationData.discount_amount || 0);
      let customerObj = {};
      if (quotationData.customer_id) {
        try { customerObj = (await Customer.findById(quotationData.customer_id)) || {}; } catch (_) {}
      }
      const vatRate = taxService.resolveCustomerRate(customerObj);
      const netSubtotal = Math.max(0, subtotal - discountAmount);

      quotationData.subtotal = subtotal;
      quotationData.tax_amount = taxService.computeTax(netSubtotal, vatRate);
      quotationData.total_amount = taxService.round2(netSubtotal + quotationData.tax_amount);
    }

    const quotation = await SalesQuotation.update(req.params.id, quotationData, req.user.id);
    
    if (!quotation) {
      return res.status(404).json({ 
        success: false, 
        error: 'Sales quotation not found' 
      });
    }
    
    res.json({
      success: true,
      data: quotation,
      message: 'Sales quotation updated successfully'
    });
  } catch (error) {
    console.error('Error updating sales quotation:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to update sales quotation' 
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

    // Derived from the state machine, not typed out here. The hardcoded list
    // this replaces omitted PENDING_APPROVAL — a status the state machine has
    // (DRAFT -> PENDING_APPROVAL -> SENT) and the quotation-approval UI expects
    // — so the approval step was unreachable through the API and a quotation
    // could only ever be sent unapproved. That is the same route-allowlist /
    // state-machine drift that made a delivered sales order 500, and it will
    // keep recurring for as long as the vocabulary is written down twice.
    const { getTransitionMap } = require('../services/stateMachine');
    const validStatuses = Object.keys(getTransitionMap('SALES_QUOTATION') || {});
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Invalid status '${status}'. Valid statuses: ${validStatuses.join(', ')}.`,
      });
    }

    const quotation = await SalesQuotation.updateStatus(req.params.id, status, req.user.id, reason || '');
    
    if (!quotation) {
      return res.status(404).json({ 
        success: false, 
        error: 'Sales quotation not found' 
      });
    }
    
    res.json({
      success: true,
      data: quotation,
      message: 'Sales quotation status updated successfully'
    });
  } catch (error) {
    console.error('Error updating quotation status:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to update quotation status' 
    });
  }
});

router.post('/:id/convert-to-sales-order', requireAuth, async (req, res) => {
  try {
    const salesOrder = await SalesQuotation.convertToSalesOrder(req.params.id, req.user.id);
    
    res.json({
      success: true,
      data: salesOrder,
      message: 'Quotation converted to sales order successfully'
    });
  } catch (error) {
    console.error('Error converting quotation to sales order:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to convert quotation to sales order' 
    });
  }
});

router.delete('/:id', requireAuth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const quotation = await SalesQuotation.delete(req.params.id, req.user.id);
    
    if (!quotation) {
      return res.status(404).json({ 
        success: false, 
        error: 'Sales quotation not found' 
      });
    }
    
    res.json({
      success: true,
      message: 'Sales quotation deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting sales quotation:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to delete sales quotation' 
    });
  }
});

// POST /sales-quotations/customer-response/:token - Customer response endpoint (public)
router.post('/customer-response/:token', portalCompany('customer_quotation'), async (req, res) => {
  try {
    const { action, notes } = req.body;
    
    if (!['accept', 'reject'].includes(action)) {
      return res.status(400).json({
        success: false,
        error: 'Action must be "accept" or "reject"'
      });
    }
    
    const result = await SalesQuotation.customerResponse(req.params.token, action, notes || '');
    
    res.json({
      success: true,
      data: result,
      message: result.message
    });
  } catch (error) {
    console.error('Error processing customer response:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to process customer response' 
    });
  }
});

// GET /sales-quotations/customer-response/:token - Get quotation details for customer (public)
router.get('/customer-response/:token', portalCompany('customer_quotation'), async (req, res) => {
  try {
    const query = `
      SELECT 
        sq.*,
        c.customer_name,
        c.primary_email as customer_email
      FROM sales_quotations sq
      LEFT JOIN customers c ON sq.customer_id = c.id
      WHERE sq.customer_response_token = $1
        AND sq.deleted_at IS NULL
        AND sq.status = 'SENT'
        AND (sq.customer_response_token_expires_at IS NULL OR sq.customer_response_token_expires_at > NOW())
        AND sq.customer_response_token_used_at IS NULL
    `;
    
    const db = require('../config/database');
    const result = await db.query(query, [req.params.token]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Quotation not found or no longer available for response'
      });
    }
    
    // Get quotation items
    const itemsQuery = `
      SELECT * FROM sales_quotation_items 
      WHERE sales_quotation_id = $1 
      ORDER BY created_at ASC
    `;
    const itemsResult = await db.query(itemsQuery, [result.rows[0].id]);
    
    const quotation = {
      ...result.rows[0],
      items: itemsResult.rows
    };
    
    res.json({
      success: true,
      data: quotation
    });
  } catch (error) {
    console.error('Error fetching quotation for customer response:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch quotation details' 
    });
  }
});

router.post('/expire-quotations', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const expiredQuotations = await SalesQuotation.expireQuotations();
    
    res.json({
      success: true,
      data: expiredQuotations,
      message: `${expiredQuotations.length} quotations expired successfully`
    });
  } catch (error) {
    console.error('Error expiring quotations:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to expire quotations' 
    });
  }
});

// GET /sales-quotations/:id/pdf — download quotation PDF
router.get('/:id/pdf', requireAuth, async (req, res) => {
  try {
    const { pool } = require('../config/database');
    const { rows: [q] } = await pool.query(
      'SELECT sq.*, c.customer_name FROM sales_quotations sq LEFT JOIN customers c ON sq.customer_id = c.id WHERE sq.id = $1 AND sq.deleted_at IS NULL',
      [req.params.id]
    );
    if (!q) return res.status(404).json({ success: false, error: 'Quotation not found' });
    const { rows: items } = await pool.query(
      'SELECT * FROM sales_quotation_items WHERE quotation_id = $1 ORDER BY line_number',
      [req.params.id]
    );
    const { generateTabularPdf, renderToBuffer } = require('../services/pdf/pdfService');
    const buffer = await renderToBuffer(generateTabularPdf(
      `Quotation ${q.quotation_number}`,
      [`Customer: ${q.customer_name}`, `Date: ${q.quotation_date}`, `Valid until: ${q.valid_until || 'N/A'}`],
      ['Item', 'Description', 'Qty', 'Unit Price', 'Line Total'],
      items.map(i => [i.item_code || '', i.item_name || '', String(i.quantity), String(i.unit_price), String(i.line_total)])
    ));
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="quotation-${q.quotation_number}.pdf"` });
    res.send(buffer);
  } catch (err) { console.error('Quotation PDF error:', err); res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;