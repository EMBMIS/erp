const express = require('express');
const router = express.Router();
const SalesRfq = require('../models/SalesRfq');
const { auth: requireAuth, requireRole } = require('../middleware/auth');

// Get all sales RFQs with filtering
router.get('/', requireAuth, async (req, res) => {
  try {
    const filters = {
      search: req.query.search,
      status: req.query.status,
      supplier_id: req.query.supplier_id,
      customer_id: req.query.customer_id,
      priority: req.query.priority,
      request_type: req.query.request_type,
      overdue: req.query.overdue,
      date_from: req.query.date_from,
      date_to: req.query.date_to,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
    };

    const rfqs = await SalesRfq.findAll(filters);
    
    res.json({
      success: true,
      data: rfqs,
      total: rfqs.length
    });
  } catch (error) {
    console.error('Error fetching sales RFQs:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch sales RFQs' 
    });
  }
});

// Get sales RFQ statistics
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const stats = await SalesRfq.getStats();
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Error fetching RFQ stats:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch RFQ statistics' 
    });
  }
});

// Get pending sales approvals for current user
router.get('/pending-sales-approvals', requireAuth, async (req, res) => {
  try {
    const pendingRfqs = await SalesRfq.getPendingSalesApprovals(req.user.id);
    
    res.json({
      success: true,
      data: pendingRfqs,
      count: pendingRfqs.length
    });
  } catch (error) {
    console.error('Error fetching pending sales approvals:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch pending sales approvals'
    });
  }
});

// Get pending procurement approvals for current user  
router.get('/pending-procurement-approvals', requireAuth, async (req, res) => {
  try {
    const pendingRfqs = await SalesRfq.getPendingProcurementApprovals(req.user.id);
    
    res.json({
      success: true,
      data: pendingRfqs,
      count: pendingRfqs.length
    });
  } catch (error) {
    console.error('Error fetching pending procurement approvals:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch pending procurement approvals'
    });
  }
});

// Get single sales RFQ by ID
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const rfq = await SalesRfq.findById(req.params.id);
    
    if (!rfq) {
      return res.status(404).json({ 
        success: false, 
        error: 'Sales RFQ not found' 
      });
    }
    
    res.json({
      success: true,
      data: rfq
    });
  } catch (error) {
    console.error('Error fetching sales RFQ:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch sales RFQ' 
    });
  }
});

// Get RFQ status history
router.get('/:id/status-history', requireAuth, async (req, res) => {
  try {
    const history = await SalesRfq.getStatusHistory(req.params.id);
    
    res.json({
      success: true,
      data: history
    });
  } catch (error) {
    console.error('Error fetching RFQ status history:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch status history' 
    });
  }
});

// Get RFQ communications
router.get('/:id/communications', requireAuth, async (req, res) => {
  try {
    const communications = await SalesRfq.getCommunications(req.params.id);
    
    res.json({
      success: true,
      data: communications
    });
  } catch (error) {
    console.error('Error fetching RFQ communications:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch communications' 
    });
  }
});

// Create new sales RFQ
router.post('/', requireAuth, async (req, res) => {
  try {
    const {
      rfq_title,
      supplier_id,
      supplier_name,
      supplier_email,
      supplier_contact_person,
      supplier_phone,
      request_type,
      required_delivery_date,
      delivery_location,
      delivery_terms,
      payment_terms,
      priority,
      response_deadline,
      special_requirements,
      terms_and_conditions,
      internal_notes,
      attachment_urls,
      linked_customer_id,
      source_document_type,
      source_document_id,
      items
    } = req.body;

    // Validation
    if (!rfq_title) {
      return res.status(400).json({ 
        success: false, 
        error: 'RFQ title is required' 
      });
    }

    if (!supplier_id && !supplier_name) {
      return res.status(400).json({ 
        success: false, 
        error: 'Supplier ID or supplier name is required' 
      });
    }

    if (!items || items.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'At least one RFQ item is required' 
      });
    }

    // Validate items
    for (const item of items) {
      if (!item.item_name || !item.requested_quantity || !item.unit_of_measure) {
        return res.status(400).json({ 
          success: false, 
          error: 'All item fields are required: item_name, requested_quantity, unit_of_measure' 
        });
      }
    }

    const rfqData = {
      rfq_title,
      supplier_id,
      supplier_name,
      supplier_email,
      supplier_contact_person,
      supplier_phone,
      request_type: request_type || 'TRADING',
      required_delivery_date,
      delivery_location,
      delivery_terms,
      payment_terms,
      priority: priority || 'MEDIUM',
      response_deadline,
      special_requirements,
      terms_and_conditions,
      internal_notes,
      attachment_urls,
      linked_customer_id,
      source_document_type,
      source_document_id,
      items
    };

    const rfq = await SalesRfq.create(rfqData, req.user.id);
    
    res.status(201).json({
      success: true,
      data: rfq,
      message: 'Sales RFQ created successfully'
    });
  } catch (error) {
    console.error('Error creating sales RFQ:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to create sales RFQ' 
    });
  }
});

// Update sales RFQ
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const {
      rfq_title,
      supplier_id,
      supplier_name,
      supplier_email,
      supplier_contact_person,
      supplier_phone,
      request_type,
      required_delivery_date,
      delivery_location,
      delivery_terms,
      payment_terms,
      priority,
      response_deadline,
      special_requirements,
      terms_and_conditions,
      internal_notes,
      attachment_urls,
      linked_customer_id,
      items
    } = req.body;

    // Validate items if provided
    if (items && items.length > 0) {
      for (const item of items) {
        if (!item.item_name || !item.requested_quantity || !item.unit_of_measure) {
          return res.status(400).json({ 
            success: false, 
            error: 'All item fields are required: item_name, requested_quantity, unit_of_measure' 
          });
        }
      }
    }

    const rfqData = {
      rfq_title,
      supplier_id,
      supplier_name,
      supplier_email,
      supplier_contact_person,
      supplier_phone,
      request_type,
      required_delivery_date,
      delivery_location,
      delivery_terms,
      payment_terms,
      priority,
      response_deadline,
      special_requirements,
      terms_and_conditions,
      internal_notes,
      attachment_urls,
      linked_customer_id,
      items
    };

    const rfq = await SalesRfq.update(req.params.id, rfqData, req.user.id);
    
    if (!rfq) {
      return res.status(404).json({ 
        success: false, 
        error: 'Sales RFQ not found' 
      });
    }
    
    res.json({
      success: true,
      data: rfq,
      message: 'Sales RFQ updated successfully'
    });
  } catch (error) {
    console.error('Error updating sales RFQ:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to update sales RFQ' 
    });
  }
});

// Update RFQ status
router.put('/:id/status', requireAuth, async (req, res) => {
  try {
    const { status, reason } = req.body;
    
    if (!status) {
      return res.status(400).json({ 
        success: false, 
        error: 'Status is required' 
      });
    }

    const validStatuses = ['DRAFT', 'SENT', 'RESPONDED', 'PARTIALLY_RESPONDED', 'EXPIRED', 'CANCELLED', 'COMPLETED'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid status' 
      });
    }

    const rfq = await SalesRfq.updateStatus(
      req.params.id, 
      status, 
      req.user.id, 
      reason || ''
    );
    
    if (!rfq) {
      return res.status(404).json({ 
        success: false, 
        error: 'Sales RFQ not found' 
      });
    }
    
    res.json({
      success: true,
      data: rfq,
      message: 'RFQ status updated successfully'
    });
  } catch (error) {
    console.error('Error updating RFQ status:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to update RFQ status' 
    });
  }
});

// Update supplier response
router.put('/:id/supplier-response', requireAuth, async (req, res) => {
  try {
    const {
      supplier_response_method,
      supplier_total_amount,
      supplier_currency,
      supplier_validity_days,
      supplier_comments,
      supplier_alternative_items,
      items
    } = req.body;

    const responseData = {
      supplier_response_method: supplier_response_method || 'SYSTEM',
      supplier_total_amount,
      supplier_currency: supplier_currency || 'USD',
      supplier_validity_days,
      supplier_comments,
      supplier_alternative_items,
      items
    };

    const rfq = await SalesRfq.updateSupplierResponse(req.params.id, responseData, req.user.id);
    
    if (!rfq) {
      return res.status(404).json({ 
        success: false, 
        error: 'Sales RFQ not found' 
      });
    }
    
    res.json({
      success: true,
      data: rfq,
      message: 'Supplier response updated successfully'
    });
  } catch (error) {
    console.error('Error updating supplier response:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to update supplier response' 
    });
  }
});

// Add communication log
router.post('/:id/communications', requireAuth, async (req, res) => {
  try {
    const {
      communication_type,
      direction,
      subject,
      message_content,
      sender_name,
      sender_email,
      recipient_name,
      recipient_email,
      attachment_urls
    } = req.body;

    if (!communication_type) {
      return res.status(400).json({ 
        success: false, 
        error: 'Communication type is required' 
      });
    }

    const communicationData = {
      communication_type,
      direction,
      subject,
      message_content,
      sender_name,
      sender_email,
      recipient_name,
      recipient_email,
      attachment_urls
    };

    const communication = await SalesRfq.addCommunication(
      req.params.id, 
      communicationData, 
      req.user.id
    );
    
    res.status(201).json({
      success: true,
      data: communication,
      message: 'Communication logged successfully'
    });
  } catch (error) {
    console.error('Error adding communication:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to log communication' 
    });
  }
});

// Submit RFQ for approval
router.post('/:id/send', requireAuth, async (req, res) => {
  try {
    const { notes } = req.body;
    
    const rfq = await SalesRfq.requestApproval(req.params.id, req.user.id, notes || 'Submitted for dual approval');
    
    if (!rfq) {
      return res.status(404).json({ 
        success: false, 
        error: 'Sales RFQ not found' 
      });
    }
    
    res.json({
      success: true,
      data: rfq,
      message: 'RFQ submitted for approval successfully'
    });
  } catch (error) {
    console.error('Error submitting RFQ for approval:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to submit RFQ for approval' 
    });
  }
});

// Dual Approval Workflow Routes

// Request dual approval for sales RFQ
router.post('/:id/request-approval', requireAuth, async (req, res) => {
  try {
    const { notes } = req.body;
    
    const rfq = await SalesRfq.requestApproval(req.params.id, req.user.id, notes || '');
    
    res.json({
      success: true,
      data: rfq,
      message: 'Sales RFQ submitted for dual approval (Sales + Procurement)'
    });
  } catch (error) {
    console.error('Error requesting RFQ approval:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to request approval'
    });
  }
});

// Sales team approval
router.post('/:id/approve-sales', requireAuth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const { approval_notes } = req.body;
    
    const approvedRfq = await SalesRfq.approveBySales(
      req.params.id,
      req.user.id,
      approval_notes || ''
    );
    
    res.json({
      success: true,
      data: approvedRfq,
      message: 'Sales RFQ approved by sales team'
    });
  } catch (error) {
    console.error('Error approving RFQ by sales:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to approve by sales'
    });
  }
});

// Procurement team approval
router.post('/:id/approve-procurement', requireAuth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const { approval_notes } = req.body;
    
    const approvedRfq = await SalesRfq.approveByProcurement(
      req.params.id,
      req.user.id,
      approval_notes || ''
    );
    
    res.json({
      success: true,
      data: approvedRfq,
      message: 'Sales RFQ approved by procurement team'
    });
  } catch (error) {
    console.error('Error approving RFQ by procurement:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to approve by procurement'
    });
  }
});

// Sales team rejection
router.post('/:id/reject-sales', requireAuth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const { rejection_reason } = req.body;
    
    if (!rejection_reason || !rejection_reason.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Rejection reason is required'
      });
    }
    
    const rejectedRfq = await SalesRfq.rejectBySales(
      req.params.id,
      req.user.id,
      rejection_reason
    );
    
    res.json({
      success: true,
      data: rejectedRfq,
      message: 'Sales RFQ rejected by sales team'
    });
  } catch (error) {
    console.error('Error rejecting RFQ by sales:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to reject by sales'
    });
  }
});

// Procurement team rejection
router.post('/:id/reject-procurement', requireAuth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const { rejection_reason } = req.body;
    
    if (!rejection_reason || !rejection_reason.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Rejection reason is required'
      });
    }
    
    const rejectedRfq = await SalesRfq.rejectByProcurement(
      req.params.id,
      req.user.id,
      rejection_reason
    );
    
    res.json({
      success: true,
      data: rejectedRfq,
      message: 'Sales RFQ rejected by procurement team'
    });
  } catch (error) {
    console.error('Error rejecting RFQ by procurement:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to reject by procurement'
    });
  }
});

// Generic approve endpoint (works with Sales Approval Dashboard)
router.post('/:id/approve', requireAuth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const { approval_notes } = req.body;
    
    const approvedRfq = await SalesRfq.approveBySales(
      req.params.id,
      req.user.id,
      approval_notes || ''
    );
    
    res.json({
      success: true,
      data: approvedRfq,
      message: 'Sales RFQ approved successfully'
    });
  } catch (error) {
    console.error('Error approving RFQ:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to approve RFQ'
    });
  }
});

// Generic reject endpoint (works with Sales Approval Dashboard)
router.post('/:id/reject', requireAuth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const { rejection_reason } = req.body;
    
    if (!rejection_reason || !rejection_reason.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Rejection reason is required'
      });
    }
    
    const rejectedRfq = await SalesRfq.rejectBySales(
      req.params.id,
      req.user.id,
      rejection_reason
    );
    
    res.json({
      success: true,
      data: rejectedRfq,
      message: 'Sales RFQ rejected successfully'
    });
  } catch (error) {
    console.error('Error rejecting RFQ:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to reject RFQ'
    });
  }
});

// Send approved RFQ to supplier manually (if auto-send fails)
router.post('/:id/send-to-supplier', requireAuth, async (req, res) => {
  try {
    const rfq = await SalesRfq.sendToSupplier(req.params.id, req.user.id);
    
    res.json({
      success: true,
      data: rfq,
      message: 'Sales RFQ sent to supplier successfully'
    });
  } catch (error) {
    console.error('Error sending RFQ to supplier:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to send RFQ to supplier'
    });
  }
});

// Delete sales RFQ (soft delete)
router.delete('/:id', requireAuth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const rfq = await SalesRfq.delete(req.params.id, req.user.id);
    
    if (!rfq) {
      return res.status(404).json({ 
        success: false, 
        error: 'Sales RFQ not found' 
      });
    }
    
    res.json({
      success: true,
      message: 'Sales RFQ deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting sales RFQ:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to delete sales RFQ' 
    });
  }
});

// Create Purchase Order from Sales RFQ response
router.post('/:id/create-purchase-order', requireAuth, async (req, res) => {
  try {
    let { response_id } = req.body;

    // Get the RFQ with supplier response
    const db = require('../config/database');
    
    // First get the RFQ details
    const rfqQuery = `
      SELECT sr.*, c.customer_name
      FROM sales_rfqs sr
      LEFT JOIN customers c ON sr.linked_customer_id = c.id
      WHERE sr.id = $1 AND sr.deleted_at IS NULL
    `;
    
    const rfqResult = await db.query(rfqQuery, [req.params.id]);
    
    if (rfqResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Sales RFQ not found'
      });
    }
    
    const rfq = rfqResult.rows[0];

    const existingPurchaseOrder = await db.query(
      'SELECT id, po_number FROM purchase_orders WHERE sales_rfq_id = $1 LIMIT 1',
      [req.params.id]
    );
    if (existingPurchaseOrder.rows.length > 0) {
      return res.status(409).json({
        success: false,
        error: `Purchase Order ${existingPurchaseOrder.rows[0].po_number} has already been created for this Sales RFQ`,
        data: existingPurchaseOrder.rows[0]
      });
    }

    // The portal stores responses in a separate table. The internal response
    // screen only knows the RFQ, so use its latest portal response when no ID
    // is supplied rather than making the UI call an endpoint it cannot satisfy.
    if (!response_id) {
      const latestResponse = await db.query(`
        SELECT id
        FROM sales_rfq_supplier_responses
        WHERE sales_rfq_id = $1
        ORDER BY responded_at DESC NULLS LAST, updated_at DESC, created_at DESC
        LIMIT 1
      `, [req.params.id]);
      response_id = latestResponse.rows[0]?.id;
    }

    let supplierResponse;
    let itemResponses;

    if (response_id) {
      // Portal responses are normalized into their own header/items tables.
      const responseResult = await db.query(`
        SELECT * FROM sales_rfq_supplier_responses
        WHERE id = $1 AND sales_rfq_id = $2
      `, [response_id, req.params.id]);
      if (responseResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Supplier response not found' });
      }
      supplierResponse = responseResult.rows[0];

      const itemResponseResult = await db.query(`
        SELECT sir.*, ri.item_id, ri.item_name, ri.item_description, ri.requested_quantity, ri.unit_of_measure
        FROM sales_rfq_item_responses sir
        JOIN sales_rfq_items ri ON sir.sales_rfq_item_id = ri.id
        WHERE sir.response_id = $1
      `, [response_id]);
      itemResponses = itemResponseResult.rows.map(item => ({
        ...item,
        unit_price: item.quoted_unit_price
      }));
    } else {
      // Older/internal response entry writes directly to sales_rfqs and
      // sales_rfq_items. Supporting it here keeps the action consistent with
      // the response editor shown on this page.
      if (!rfq.response_received_at) {
        return res.status(400).json({
          success: false,
          error: 'No supplier response is available for this Sales RFQ'
        });
      }
      supplierResponse = rfq;
      const itemResponseResult = await db.query(`
        SELECT item_id, item_name, item_description, requested_quantity,
               unit_of_measure, quoted_unit_price
        FROM sales_rfq_items
        WHERE sales_rfq_id = $1
      `, [req.params.id]);
      itemResponses = itemResponseResult.rows.map(item => ({
        ...item,
        unit_price: item.quoted_unit_price
      }));
    }

    if (itemResponses.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'The supplier response has no line items to purchase'
      });
    }

    // Use the fields PurchaseOrder.create actually persists. The prior payload
    // used fields from a different, older PO shape, so the delivery date and
    // Sales RFQ link were silently dropped.
    const poData = {
      supplier_id: rfq.supplier_id,
      purchase_requisition_id: null,
      rfq_id: null,
      po_date: new Date().toISOString().split('T')[0],
      delivery_date: rfq.required_delivery_date || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      currency: supplierResponse.supplier_currency || 'USD',
      payment_terms: rfq.payment_terms || 'Net 30',
      incoterms: rfq.delivery_terms || 'FOB',
      delivery_address: rfq.delivery_location || '',
      source_type: 'sales_rfq',
      sales_rfq_id: req.params.id,
      line_items: itemResponses.map(item => ({
        item_id: item.item_id || null,
        item_description: `${item.item_name} - ${item.item_description || ''}`.trim(),
        unit_of_measure: item.unit_of_measure || 'PCS',
        quantity: parseFloat(item.requested_quantity || 1),
        unit_price: parseFloat(item.unit_price || 0),
        requested_delivery_date: rfq.required_delivery_date || null
      }))
    };

    // Import PurchaseOrder model
    const PurchaseOrder = require('../models/PurchaseOrder');
    
    // Create the Purchase Order
    const newPO = await PurchaseOrder.create(poData, req.user.id);

    // Update the RFQ status to indicate PO was created
    await SalesRfq.updateStatus(req.params.id, 'PURCHASE_ORDER_CREATED', req.user.id, 
      `Purchase Order PO-${newPO.id} created from supplier response`);

    res.status(201).json({
      success: true,
      data: newPO,
      message: 'Purchase Order created successfully from Sales RFQ response'
    });

  } catch (error) {
    console.error('Error creating Purchase Order from Sales RFQ:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create Purchase Order from Sales RFQ'
    });
  }
});

module.exports = router;
