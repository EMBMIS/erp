const express = require('express');
const router = express.Router();
const PurchaseOrder = require('../models/PurchaseOrder');
const { auth, requireRole } = require('../middleware/auth');
const { requireSoD } = require('../middleware/rbac');
const { recordCreator } = require('../middleware/recordOwner');

// GET /purchase-orders - List all POs with filters
router.get('/', auth, async (req, res) => {
  try {
    const pos = await PurchaseOrder.findAll(req.query, req.user.id);
    res.json({
      success: true,
      data: pos,
      count: pos.length
    });
  } catch (error) {
    console.error('Error fetching purchase orders:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch purchase orders'
    });
  }
});

// GET /purchase-orders/similar?q=<text>&limit=10 - Semantic similarity search
router.get('/similar', auth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) {
      return res.status(400).json({ success: false, error: 'Query parameter "q" is required.' });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);

    const { generateEmbedding, toVectorLiteral } = require('../services/ai/embeddings');
    const queryVector = toVectorLiteral(await generateEmbedding(q));

    const db = require('../config/database');
    const { rows } = await db.query(
      `SELECT po.*, s.legal_name AS supplier_name,
              1 - (po.embedding <=> $1::vector) AS score
         FROM purchase_orders po
         LEFT JOIN suppliers s ON s.id = po.supplier_id
        WHERE po.embedding IS NOT NULL
        ORDER BY po.embedding <=> $1::vector ASC
        LIMIT $2`,
      [queryVector, limit]
    );

    res.json({ success: true, query: q, data: rows, count: rows.length });
  } catch (error) {
    console.error('Error running purchase order similarity search:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to run similarity search' });
  }
});

// GET /purchase-orders/stats - Get PO statistics
// GET /purchase-orders/analytics?months=24 — spend by supplier and category,
// on-time delivery, and committed spend by month. Read-only, and scoped the
// same way the list and the stats are so the numbers reconcile with each other.
// GET /purchase-orders/spend-drivers?from=&to=&baseline_from=&baseline_to=&supplier=
// "Why are our costs up?" — the same answer Simeli gives (services/spendDrivers.js): spend committed this period against
// the usual pace, split into suppliers (price, volume, bills with no purchase order, new), with contracts, who raised and
// approved the orders, and the customer orders behind them; the ledger lens for finance roles. Read-only; outside
// management and finance the caller sees their own spend.
router.get('/spend-drivers', auth, async (req, res) => {
  try {
    const { explainSpend } = require('../services/spendDrivers');
    const q = req.query;
    const data = await explainSpend({
      companyId: req.companyId,
      userId: req.user?.isApiKey ? null : req.user?.id,
      role: req.user?.role,
      from: q.from || null,
      to: q.to || null,
      baselineFrom: q.baseline_from || null,
      baselineTo: q.baseline_to || null,
      supplier: q.supplier || null,
      limit: q.limit,
    });
    if (data.error) return res.status(400).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Spend drivers error:', error.message);
    res.status(500).json({ success: false, error: 'Could not explain the change in spending.' });
  }
});

// POST /purchase-orders/spend-drivers/follow-ups { supplier_ids?: [...], from?, to?, baseline_from?, baseline_to? }
// A person's click: runs the analysis again, drafts a re-quote (DRAFT RFQ) for each item whose price went up and asks
// the owners of bills with no order or orders with no customer order behind them. Nothing is sent to a supplier.
router.post('/spend-drivers/follow-ups', auth, async (req, res) => {
  try {
    const { prepareSpendFollowUps } = require('../services/spendDrivers');
    const b = req.body || {};
    const data = await prepareSpendFollowUps({
      companyId: req.companyId,
      userId: req.user?.isApiKey ? null : req.user?.id,
      role: req.user?.role,
      supplierIds: Array.isArray(b.supplier_ids) ? b.supplier_ids : null,
      from: b.from || null,
      to: b.to || null,
      baselineFrom: b.baseline_from || null,
      baselineTo: b.baseline_to || null,
    });
    if (data.error) return res.status(400).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Spend follow-ups error:', error.message);
    res.status(500).json({ success: false, error: 'Could not prepare the follow-ups.' });
  }
});

router.get('/analytics', auth, async (req, res) => {
  try {
    const requested = parseInt(req.query.months, 10);
    const months = Number.isInteger(requested) ? Math.min(Math.max(requested, 2), 36) : 24;
    const data = await PurchaseOrder.getAnalytics(req.user.id, months);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching PO analytics:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch analytics' });
  }
});

router.get('/stats', auth, async (req, res) => {
  try {
    const stats = await PurchaseOrder.getStats(req.user.id);
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Error fetching PO stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch statistics'
    });
  }
});

// GET /purchase-orders/pending-approval - Get POs pending approval (Manager/Admin only)
router.get('/pending-approval', auth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const pos = await PurchaseOrder.findPendingApproval();
    res.json({
      success: true,
      data: pos
    });
  } catch (error) {
    console.error('Error fetching pending POs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch pending purchase orders'
    });
  }
});

// GET /purchase-orders/supplier/:supplierId - Get POs by supplier
router.get('/supplier/:supplierId', auth, async (req, res) => {
  try {
    const pos = await PurchaseOrder.getBySupplier(req.params.supplierId);
    res.json({
      success: true,
      data: pos
    });
  } catch (error) {
    console.error('Error fetching POs by supplier:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch purchase orders by supplier'
    });
  }
});

// GET /purchase-orders/delivery-tracking - Get POs in delivery workflow (Manager/Admin only)
router.get('/delivery-tracking', auth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const pos = await PurchaseOrder.findDeliveryTracking(req.query);
    res.json({
      success: true,
      data: pos
    });
  } catch (error) {
    console.error('Error fetching delivery tracking POs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch delivery tracking data'
    });
  }
});

// GET /purchase-orders/:id - Get single PO by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const po = await PurchaseOrder.findById(req.params.id, req.user.id);
    
    if (!po) {
      return res.status(404).json({
        success: false,
        error: 'Purchase order not found'
      });
    }

    res.json({
      success: true,
      data: po
    });
  } catch (error) {
    console.error('Error fetching purchase order:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch purchase order'
    });
  }
});

// GET /purchase-orders/:id/pdf - printable purchase order PDF
router.get('/:id/pdf', auth, async (req, res) => {
  try {
    const po = await PurchaseOrder.findById(req.params.id);
    if (!po) return res.status(404).json({ success: false, error: 'Purchase order not found' });
    po.items = await PurchaseOrder.getLineItems(req.params.id);

    const { generatePurchaseOrderPdf } = require('../services/pdf/pdfService');
    const doc = generatePurchaseOrderPdf(po);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="po-${po.po_number}.pdf"`);
    doc.pipe(res);
  } catch (error) {
    console.error('Generate PO PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /purchase-orders/:id/line-items - Get PO line items
router.get('/:id/line-items', auth, async (req, res) => {
  try {
    const items = await PurchaseOrder.getLineItems(req.params.id);
    res.json({
      success: true,
      data: items
    });
  } catch (error) {
    console.error('Error fetching PO line items:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch PO line items'
    });
  }
});

// POST /purchase-orders - Create new PO
router.post('/', auth, async (req, res) => {
  try {
    const {
      supplier_id,
      line_items
    } = req.body;

    // Validate required fields
    if (!supplier_id) {
      return res.status(400).json({
        success: false,
        error: 'Supplier is required'
      });
    }

    if (!line_items || line_items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one line item is required'
      });
    }

    // Validate line items
    for (const item of line_items) {
      if (!item.item_description || !item.quantity || !item.unit_price) {
        return res.status(400).json({
          success: false,
          error: 'Each line item must have description, quantity, and unit price'
        });
      }
    }

    const po = await PurchaseOrder.create(req.body, req.user.id);
    
    res.status(201).json({
      success: true,
      data: po,
      message: 'Purchase order created successfully'
    });
  } catch (error) {
    console.error('Error creating purchase order:', error);
    
    if (error.code === '23503') { // Foreign key constraint
      return res.status(400).json({
        success: false,
        error: 'Invalid supplier, PR, RFQ, or contract selected'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to create purchase order'
    });
  }
});

// POST /purchase-orders/:id/line-items - Add line item to PO
router.post('/:id/line-items', auth, async (req, res) => {
  try {
    const {
      item_description,
      unit_of_measure,
      quantity,
      unit_price
    } = req.body;

    // Validate required fields
    if (!item_description || !quantity || !unit_price) {
      return res.status(400).json({
        success: false,
        error: 'Item description, quantity, and unit price are required'
      });
    }

    const lineItem = await PurchaseOrder.addLineItem(req.params.id, req.body);
    
    res.status(201).json({
      success: true,
      data: lineItem,
      message: 'Line item added successfully'
    });
  } catch (error) {
    console.error('Error adding line item:', error);
    
    if (error.code === '23503') { // Foreign key constraint
      return res.status(400).json({
        success: false,
        error: 'Invalid PO or item ID'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to add line item'
    });
  }
});

// PUT /purchase-orders/:id - Update PO
router.put('/:id', auth, async (req, res) => {
  try {
    const po = await PurchaseOrder.update(req.params.id, req.body, req.user.id);
    
    if (!po) {
      return res.status(404).json({
        success: false,
        error: 'Purchase order not found'
      });
    }

    res.json({
      success: true,
      data: po,
      message: 'Purchase order updated successfully'
    });
  } catch (error) {
    console.error('Error updating purchase order:', error);
    
    if (error.message === 'No valid fields to update') {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to update purchase order'
    });
  }
});

// PUT /purchase-orders/:id/line-items/:lineItemId - Update line item
router.put('/:id/line-items/:lineItemId', auth, async (req, res) => {
  try {
    const lineItem = await PurchaseOrder.updateLineItem(req.params.id, req.params.lineItemId, req.body);
    
    if (!lineItem) {
      return res.status(404).json({
        success: false,
        error: 'Line item not found'
      });
    }

    res.json({
      success: true,
      data: lineItem,
      message: 'Line item updated successfully'
    });
  } catch (error) {
    console.error('Error updating line item:', error);
    
    if (error.message === 'No valid fields to update') {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to update line item'
    });
  }
});

// POST /purchase-orders/:id/submit-for-approval - Submit PO for approval
router.post('/:id/submit-for-approval', auth, async (req, res) => {
  try {
    const po = await PurchaseOrder.submitForApproval(req.params.id, req.user.id);
    
    if (!po) {
      return res.status(404).json({
        success: false,
        error: 'Purchase order not found or cannot be submitted for approval'
      });
    }

    res.json({
      success: true,
      data: po,
      message: 'Purchase order submitted for approval successfully'
    });
  } catch (error) {
    console.error('Error submitting PO for approval:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to submit purchase order for approval'
    });
  }
});

// POST /purchase-orders/:id/approve - Approve PO with DoA validation
router.post('/:id/approve', auth, requireRole('MANAGER', 'ADMIN'), requireSoD(recordCreator('purchase_orders'), 'approval'), async (req, res) => {
  try {
    const { id } = req.params;
    const db = require('../config/database');
    const ApprovalRulesEngine = require('../services/approvalRulesEngine');
    const ApprovalChain = require('../models/ApprovalChain');
    
    // First, get the PO to check its total amount
    const poResult = await db.query('SELECT total_amount FROM purchase_orders WHERE id = $1', [id]);
    if (poResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Purchase order not found'
      });
    }
    
    const poAmount = parseFloat(poResult.rows[0].total_amount || 0);
    
    // Check if user has DoA authority for purchase orders via ApprovalRulesEngine
    // Amount-scoped DoA binds every role, ADMIN included; the only identity
    // exempt from amount bands is the platform owner, which the engine already
    // synthesizes as an unlimited grant (see loadDoaDefinitions).
    const hasAuthority = await ApprovalRulesEngine.checkUserAuthority(
      req.user.id, 
      poAmount,
      null,
      'PO'
    ) || await ApprovalRulesEngine.checkUserAuthority(
      req.user.id,
      poAmount,
      null,
      'PURCHASE_ORDER'
    );
    
    if (!hasAuthority) {
      return res.status(403).json({
        success: false,
        error: `Insufficient delegation of authority to approve this purchase order (amount: $${poAmount})`
      });
    }

    // Check if an ApprovalChain request exists for this PO
    const pendingChain = await db.query(
      "SELECT id FROM approval_requests WHERE document_type IN ('PO', 'PURCHASE_ORDER') AND document_id = $1 AND status = 'PENDING'",
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
    
    const po = await PurchaseOrder.approve(req.params.id, req.user.id);
    
    if (!po) {
      return res.status(404).json({
        success: false,
        error: 'Purchase order not found or not pending approval'
      });
    }

    // Generate delivery token and send email to supplier
    try {
      console.log(`🚀 Starting email process for PO ${po.po_number}`);
      const emailService = require('../services/emailService');
      const { generateToken, expiryDate } = require('../services/portalTokens');

      // Generate secure delivery token (expiring, single-use)
      const deliveryToken = generateToken();
      const deliveryDue = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days from now
      console.log(`🔐 Generated delivery token: ${deliveryToken.substring(0, 20)}...`);

      // Update PO with delivery token
      console.log(`📝 Updating PO status to SENT_TO_SUPPLIER`);
      await require('../config/database').query(`
        UPDATE purchase_orders
        SET supplier_delivery_token = $1, supplier_delivery_due = $2, status = 'SENT_TO_SUPPLIER',
            supplier_delivery_token_expires_at = $4, supplier_delivery_token_used_at = NULL
        WHERE id = $3
      `, [deliveryToken, deliveryDue, po.id, expiryDate(7)]);
      console.log(`✅ PO status updated successfully`);
      
      // Get supplier details
      console.log(`🔍 Fetching supplier details for ID: ${po.supplier_id}`);
      const supplierResult = await require('../config/database').query(
        'SELECT * FROM suppliers WHERE id = $1', [po.supplier_id]
      );
      
      if (supplierResult.rows.length > 0) {
        const supplier = supplierResult.rows[0];
        console.log(`📧 Sending email to supplier: ${supplier.legal_name} (${supplier.email})`);
        
        // Send delivery confirmation email
        const emailResult = await emailService.sendPODeliveryConfirmation(po, supplier, deliveryToken);
        console.log(`✅ Delivery confirmation email sent successfully!`);
        console.log(`   Message ID: ${emailResult.messageId}`);
        console.log(`   Sent to: ${supplier.email}`);
      } else {
        console.error(`❌ Supplier not found for ID: ${po.supplier_id}`);
      }
    } catch (emailError) {
      console.error('❌ Error sending delivery confirmation email:', emailError);
      console.error('Email error stack:', emailError.stack);
      // Don't fail the approval if email fails
    }

    res.json({
      success: true,
      data: po,
      message: 'Purchase order approved and supplier notified for delivery coordination'
    });
  } catch (error) {
    console.error('Error approving purchase order:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to approve purchase order'
    });
  }
});

// POST /purchase-orders/:id/reject - Reject PO (Manager/Admin only)
router.post('/:id/reject', auth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const { reason } = req.body;

    // Require a non-empty reason so the rejection leaves an audit trail
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Rejection reason is required'
      });
    }

    const po = await PurchaseOrder.reject(req.params.id, req.user.id, reason.trim());

    if (!po) {
      return res.status(404).json({
        success: false,
        error: 'Purchase order not found or not pending approval'
      });
    }

    res.json({
      success: true,
      data: po,
      message: 'Purchase order rejected successfully'
    });
  } catch (error) {
    console.error('Error rejecting purchase order:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to reject purchase order'
    });
  }
});

// POST /purchase-orders/:id/send-to-supplier - Send PO to supplier
router.post('/:id/send-to-supplier', auth, async (req, res) => {
  try {
    const po = await PurchaseOrder.sendToSupplier(req.params.id, req.user.id);
    
    if (!po) {
      return res.status(404).json({
        success: false,
        error: 'Purchase order not found or cannot be sent'
      });
    }

    res.json({
      success: true,
      data: po,
      message: 'Purchase order sent to supplier successfully'
    });
  } catch (error) {
    console.error('Error sending PO to supplier:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send purchase order to supplier'
    });
  }
});

// POST /purchase-orders/:id/confirm - Confirm PO receipt from supplier
router.post('/:id/confirm', auth, async (req, res) => {
  try {
    const po = await PurchaseOrder.confirm(req.params.id);
    
    if (!po) {
      return res.status(404).json({
        success: false,
        error: 'Purchase order not found or cannot be confirmed'
      });
    }

    res.json({
      success: true,
      data: po,
      message: 'Purchase order confirmed successfully'
    });
  } catch (error) {
    console.error('Error confirming purchase order:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to confirm purchase order'
    });
  }
});

// POST /purchase-orders/:id/cancel - Cancel PO
router.post('/:id/cancel', auth, async (req, res) => {
  try {
    const po = await PurchaseOrder.cancel(req.params.id, req.user.id);
    
    if (!po) {
      return res.status(404).json({
        success: false,
        error: 'Purchase order not found or cannot be cancelled'
      });
    }

    res.json({
      success: true,
      data: po,
      message: 'Purchase order cancelled successfully'
    });
  } catch (error) {
    console.error('Error cancelling purchase order:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to cancel purchase order'
    });
  }
});

// POST /purchase-orders/:id/customer-handover - Update customer handover status
router.post('/:id/customer-handover', auth, async (req, res) => {
  try {
    const { status, notes } = req.body;
    
    if (!status) {
      return res.status(400).json({
        success: false,
        error: 'Status is required'
      });
    }

    const validStatuses = ['DELIVERED_TO_CUSTOMER', 'CUSTOMER_CONFIRMED'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid status for customer handover'
      });
    }

    const po = await PurchaseOrder.updateCustomerHandover(req.params.id, status, notes, req.user.id);
    
    if (!po) {
      return res.status(404).json({
        success: false,
        error: 'Purchase order not found or not ready for customer handover'
      });
    }

    res.json({
      success: true,
      data: po,
      message: `Purchase order ${status.toLowerCase().replace(/_/g, ' ')} successfully`
    });
  } catch (error) {
    console.error('Error updating customer handover:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update customer handover status'
    });
  }
});

// POST /purchase-orders/:id/receive-items - Receive items for PO line item
router.post('/:id/receive-items', auth, async (req, res) => {
  try {
    const { line_item_id, quantity_received } = req.body;

    if (!line_item_id || !quantity_received || quantity_received <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Line item ID and valid quantity received are required'
      });
    }

    const lineItem = await PurchaseOrder.receiveItems(req.params.id, line_item_id, quantity_received);
    
    if (!lineItem) {
      return res.status(404).json({
        success: false,
        error: 'Line item not found'
      });
    }

    res.json({
      success: true,
      data: lineItem,
      message: 'Items received successfully'
    });
  } catch (error) {
    console.error('Error receiving items:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to receive items'
    });
  }
});

// DELETE /purchase-orders/:id/line-items/:lineItemId - Remove line item
router.delete('/:id/line-items/:lineItemId', auth, async (req, res) => {
  try {
    const lineItem = await PurchaseOrder.removeLineItem(req.params.id, req.params.lineItemId);
    
    if (!lineItem) {
      return res.status(404).json({
        success: false,
        error: 'Line item not found'
      });
    }

    res.json({
      success: true,
      message: 'Line item removed successfully'
    });
  } catch (error) {
    console.error('Error removing line item:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to remove line item'
    });
  }
});

// DELETE /purchase-orders/:id - Delete PO
router.delete('/:id', auth, async (req, res) => {
  try {
    const po = await PurchaseOrder.delete(req.params.id, req.user.id);
    
    if (!po) {
      return res.status(404).json({
        success: false,
        error: 'Purchase order not found'
      });
    }

    res.json({
      success: true,
      message: 'Purchase order deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting purchase order:', error);
    
    if (error.code === '23503') { // Foreign key constraint
      return res.status(400).json({
        success: false,
        error: 'Cannot delete purchase order - it is referenced by other records'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to delete purchase order'
    });
  }
});


// POST /purchase-orders/:id/verify-delivery - Verify delivery (Manager/Admin only)
router.post('/:id/verify-delivery', auth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const { verified, verification_notes } = req.body;
    
    // Determine the verification result and status
    let isVerified, newStatus;
    
    if (verified === true) {
      // Perfect delivery - accept completely
      isVerified = true;
      newStatus = 'GOODS_READY_FOR_RECEIPT';
    } else if (verified === 'accept_with_issues') {
      // Accept with issues - proceed but notify supplier of problems
      isVerified = true; // Still progressing to goods receipt
      newStatus = 'GOODS_READY_FOR_RECEIPT';
    } else {
      // Reject delivery - return to supplier
      isVerified = false;
      newStatus = 'DELIVERY_REJECTED';
    }
    
    const po = await PurchaseOrder.verifyDelivery(
      req.params.id, 
      req.user.id, 
      isVerified, 
      verification_notes,
      newStatus
    );
    
    if (!po) {
      return res.status(404).json({
        success: false,
        error: 'Purchase order not found or not ready for verification'
      });
    }

    // Send email notification to supplier about verification result
    try {
      console.log(`📧 Sending delivery verification notification for PO ${po.po_number}`);
      const emailService = require('../services/emailService');
      
      // Get supplier details
      const supplierResult = await require('../config/database').query(
        'SELECT * FROM suppliers WHERE id = $1', [po.supplier_id]
      );
      
      // Get user who verified the delivery
      const userResult = await require('../config/database').query(
        'SELECT first_name, last_name FROM users WHERE id = $1', [req.user.id]
      );
      
      if (supplierResult.rows.length > 0 && userResult.rows.length > 0) {
        const supplier = supplierResult.rows[0];
        const user = userResult.rows[0];
        const verifiedByUser = `${user.first_name} ${user.last_name}`.trim();
        
        // Determine email type and content based on verification action
        let emailVerified, emailType;
        
        if (verified === true) {
          emailVerified = true;
          emailType = 'success';
        } else if (verified === 'accept_with_issues') {
          emailVerified = 'accept_with_issues'; // Special flag for accept with issues
          emailType = 'accept_with_issues';
        } else {
          emailVerified = false;
          emailType = 'rejected';
        }
        
        console.log(`📧 Sending ${emailType} notification to: ${supplier.legal_name} (${supplier.email})`);
        
        const emailResult = await emailService.sendDeliveryVerificationNotification(
          po, 
          supplier, 
          emailVerified, 
          verification_notes,
          verifiedByUser
        );
        
        console.log(`✅ Delivery verification email sent successfully!`);
        console.log(`   Message ID: ${emailResult.messageId}`);
        console.log(`   Status: ${verified ? 'Verified' : 'Issue Reported'}`);
      } else {
        console.error(`❌ Supplier or user not found for notification`);
      }
    } catch (emailError) {
      console.error('❌ Error sending delivery verification email:', emailError);
      // Don't fail the verification if email fails
    }

    res.json({
      success: true,
      data: po,
      message: verified ? 'Delivery verified successfully and supplier notified' : 'Delivery issue recorded and supplier notified'
    });
  } catch (error) {
    console.error('Error verifying delivery:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to verify delivery'
    });
  }
});

module.exports = router;