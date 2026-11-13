const express = require('express');
const router = express.Router();
const SalesOrder = require('../models/SalesOrder');
const Customer = require('../models/Customer');
const orderWatch = require('../services/orderWatch');
const taxService = require('../services/taxService');
const { auth, requireRole, requireManagerOrAdmin } = require('../middleware/auth');
const multer = require('multer');
const { portalCompany } = require('../services/portalScope');
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });
const { scopedMulter } = require('../middleware/scopedMulter');
const pdfParse = require('pdf-parse');
const { requireSoD } = require('../middleware/rbac');
const { recordCreator } = require('../middleware/recordOwner');

// POST /sales-orders/upload-po — read a customer PO PDF and PROPOSE a sales order.
//
// This endpoint deliberately creates nothing. It returns what the document says,
// which customer and items it matched, how confident the extraction was, and
// what a person should check. The client reviews that and posts the result to
// /confirm-po below.
//
// It used to create the order outright, defaulting the total to a hardcoded
// 250.00 when its regex missed and assigning it to whatever customer came back
// first from `LIMIT 1`. See services/ai/customerPoIntake.js for why that shape
// of "helpfulness" is worse than refusing.
router.post('/upload-po', auth, scopedMulter(upload.single('file')), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No PDF file uploaded.' });
    }

    const { processCustomerPoPdf } = require('../services/ai/customerPoIntake');
    const result = await processCustomerPoPdf(req.file.buffer, req.file.originalname);

    if (!result.ok) {
      return res.status(422).json({ success: false, error: result.error, data: result });
    }

    res.json({
      success: true,
      message: result.warnings.length
        ? 'PO read, but some details need checking before this can become an order.'
        : 'PO read. Review the details and confirm to create the draft order.',
      data: result,
    });
  } catch (error) {
    console.error('Customer PO intake error:', error);
    res.status(500).json({ success: false, error: 'The PO could not be processed.' });
  }
});

// POST /sales-orders/confirm-po — create the draft order a human just approved.
//
// Separate from the read step on purpose: this takes the reviewed values from
// the client, not the model's raw output, so the record is created from what a
// person confirmed rather than from what was extracted.
router.post('/confirm-po', auth, async (req, res) => {
  try {
    const { customer_id, customer_po_number, order_date, line_items, notes, source_file } = req.body;

    if (!customer_id) {
      return res.status(400).json({
        success: false,
        error: 'A customer must be selected before the order can be created.',
      });
    }
    if (!Array.isArray(line_items) || line_items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one line item is required.',
      });
    }

    // Every line must carry its own real numbers. No defaulting: a line whose
    // quantity or price could not be established is a line a person has to
    // supply, not one the server should invent.
    for (const [i, line] of line_items.entries()) {
      const qty = Number(line.quantity);
      const price = Number(line.unit_price);
      if (!Number.isFinite(qty) || qty <= 0) {
        return res.status(400).json({
          success: false,
          error: `Line ${i + 1} has no valid quantity.`,
        });
      }
      if (!Number.isFinite(price) || price < 0) {
        return res.status(400).json({
          success: false,
          error: `Line ${i + 1} has no valid unit price.`,
        });
      }
    }

    const orderData = {
      customer_id,
      customer_po_number: customer_po_number || null,
      order_date: order_date || new Date().toISOString().split('T')[0],
      notes: [notes, source_file ? `Created from customer PO document: ${source_file}` : null]
        .filter(Boolean).join('\n'),
      line_items: line_items.map((l) => ({
        item_id: l.item_id || null,
        description: l.description,
        quantity: Number(l.quantity),
        unit_price: Number(l.unit_price),
        total_price: Number(l.quantity) * Number(l.unit_price),
      })),
    };

    const draftOrder = await SalesOrder.createOrder(orderData, req.user.id);
    // The moment the order lands, Simeli checks it can ship on the day (services/orderWatch.js).
    orderWatch.onOrderLanded(req.companyId, draftOrder?.id, 'keyed in from the customer PO');
    res.json({
      success: true,
      message: `Draft sales order ${draftOrder.so_number || draftOrder.id} created.`,
      data: draftOrder,
    });
  } catch (error) {
    console.error('Customer PO confirmation error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /sales-orders - List all sales orders with filters
router.get('/', auth, async (req, res) => {
  try {
    const filters = {
      userId: req.user.id,  // CRITICAL: B2C user isolation
      search: req.query.search,
      status: req.query.status,
      customer_id: req.query.customer_id,
      priority: req.query.priority,
      date_from: req.query.date_from,
      date_to: req.query.date_to,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
    };

    // Remove undefined filters
    Object.keys(filters).forEach(key => {
      if (filters[key] === undefined || filters[key] === '') {
        delete filters[key];
      }
    });

    const salesOrders = await SalesOrder.findAll(filters);
    
    res.json({
      success: true,
      data: salesOrders,
      count: salesOrders.length
    });
  } catch (error) {
    console.error('Error fetching sales orders:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch sales orders'
    });
  }
});

// GET /sales-orders/similar?q=<text>&limit=10 - Semantic similarity search
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
      `SELECT so.*, 1 - (so.embedding <=> $1::vector) AS score
         FROM sales_orders so
        WHERE so.embedding IS NOT NULL AND so.deleted_at IS NULL
        ORDER BY so.embedding <=> $1::vector ASC
        LIMIT $2`,
      [queryVector, limit]
    );

    res.json({ success: true, query: q, data: rows, count: rows.length });
  } catch (error) {
    console.error('Error running sales order similarity search:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to run similarity search' });
  }
});

// GET /sales-orders/stats - Get sales order statistics
router.get('/stats', auth, async (req, res) => {
  try {
    const stats = await SalesOrder.getStats(req.user.id);
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Error fetching sales order stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch sales order statistics'
    });
  }
});

// GET /sales-orders/pending-approvals - Get orders pending approval for current user
// GET /sales-orders/revenue-drivers?from=&to=&baseline_from=&baseline_to=&customer=
// "Why are sales down?" — the same answer Simeli gives (services/revenueDrivers.js): the change in sales split into
// customers (lapsed, buying less, new), with volume and price, lost and open quotations, holds and overdue invoices.
// Read-only; outside management the caller sees their own book.
router.get('/revenue-drivers', auth, async (req, res) => {
  try {
    const { explainRevenue } = require('../services/revenueDrivers');
    const q = req.query;
    const data = await explainRevenue({
      companyId: req.companyId,
      userId: req.user?.isApiKey ? null : req.user?.id,
      role: req.user?.role,
      from: q.from || null,
      to: q.to || null,
      baselineFrom: q.baseline_from || null,
      baselineTo: q.baseline_to || null,
      customer: q.customer || null,
      limit: q.limit,
    });
    if (data.error) return res.status(400).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Revenue drivers error:', error.message);
    res.status(500).json({ success: false, error: 'Could not explain the change in sales.' });
  }
});

// POST /sales-orders/revenue-drivers/follow-ups { customer_ids?: [...], from?, to?, baseline_from?, baseline_to? }
// A person's click: runs the analysis again and puts a follow-up call for each falling customer on its account
// owner's CRM list. Nothing is sent to a customer.
router.post('/revenue-drivers/follow-ups', auth, async (req, res) => {
  try {
    const { prepareRevenueFollowUps } = require('../services/revenueDrivers');
    const b = req.body || {};
    const data = await prepareRevenueFollowUps({
      companyId: req.companyId,
      userId: req.user?.isApiKey ? null : req.user?.id,
      role: req.user?.role,
      customerIds: Array.isArray(b.customer_ids) ? b.customer_ids : null,
      from: b.from || null,
      to: b.to || null,
      baselineFrom: b.baseline_from || null,
      baselineTo: b.baseline_to || null,
    });
    if (data.error) return res.status(400).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Revenue follow-ups error:', error.message);
    res.status(500).json({ success: false, error: 'Could not prepare the follow-up calls.' });
  }
});

router.get('/pending-approvals', auth, async (req, res) => {
  try {
    const pendingApprovals = await SalesOrder.getPendingApprovals(req.user.id);
    
    res.json({
      success: true,
      data: pendingApprovals
    });
  } catch (error) {
    console.error('Error fetching pending order approvals:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch pending approvals' 
    });
  }
});

// GET /sales-orders/:id - Get specific sales order by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const salesOrder = await SalesOrder.findById(req.params.id, req.user.id);
    
    if (!salesOrder) {
      return res.status(404).json({
        success: false,
        error: 'Sales order not found'
      });
    }

    res.json({
      success: true,
      data: salesOrder
    });
  } catch (error) {
    console.error('Error fetching sales order:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch sales order'
    });
  }
});

// GET /sales-orders/:id/items - Get items for a sales order
router.get('/:id/items', auth, async (req, res) => {
  try {
    const items = await SalesOrder.getItems(req.params.id);
    
    res.json({
      success: true,
      data: items
    });
  } catch (error) {
    console.error('Error fetching sales order items:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch sales order items'
    });
  }
});

// GET /sales-orders/:id/status-history - Get status history for a sales order
router.get('/:id/status-history', auth, async (req, res) => {
  try {
    const statusHistory = await SalesOrder.getStatusHistory(req.params.id);
    
    res.json({
      success: true,
      data: statusHistory
    });
  } catch (error) {
    console.error('Error fetching status history:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch status history'
    });
  }
});

// POST /sales-orders - Create new sales order
router.post('/', auth, async (req, res) => {
  try {
    const {
      customer_id,
      customer_name,
      order_date,
      delivery_date,
      reference_number,
      currency,
      priority,
      delivery_address,
      delivery_instructions,
      shipping_method,
      notes,
      internal_notes,
      payment_terms,
      delivery_terms,
      items
    } = req.body;

    // Validate required fields
    if (!customer_id) {
      return res.status(400).json({
        success: false,
        error: 'Customer is required'
      });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one item is required'
      });
    }

    // Validate each item
    for (const item of items) {
      if (!item.item_name || !item.quantity || !item.unit_price || !item.unit_of_measure) {
        return res.status(400).json({
          success: false,
          error: 'Each item must have name, quantity, unit price, and unit of measure'
        });
      }
    }

    // Calculate totals
    let subtotal = 0;
    const processedItems = items.map(item => {
      const discountAmount = item.discount_amount || 0;
      const lineTotal = (item.quantity * item.unit_price) - discountAmount;
      subtotal += lineTotal;
      
      return {
        ...item,
        discount_amount: discountAmount,
        line_total: lineTotal
      };
    });

    let customerObj = {};
    if (customer_id) {
      try { customerObj = (await Customer.findById(customer_id)) || {}; } catch (_) {}
    }
    const vatRate = taxService.resolveCustomerRate(customerObj);
    const discount_amount = parseFloat(req.body.discount_amount || 0);
    const netSubtotal = Math.max(0, subtotal - discount_amount);
    const tax_amount = taxService.computeTax(netSubtotal, vatRate);
    const total_amount = taxService.round2(netSubtotal + tax_amount);

    const salesOrderData = {
      customer_id,
      customer_name: customer_name || 'Unknown Customer',
      order_date,
      delivery_date,
      reference_number,
      currency: currency || 'USD',
      subtotal,
      tax_amount,
      discount_amount,
      total_amount,
      priority: priority || 'NORMAL',
      delivery_address,
      delivery_instructions,
      shipping_method,
      notes,
      internal_notes,
      payment_terms,
      delivery_terms,
      items: processedItems
    };

    const newSalesOrder = await SalesOrder.create(salesOrderData, req.user.id);
    orderWatch.onOrderLanded(req.companyId, newSalesOrder?.id, 'created');
    
    res.status(201).json({
      success: true,
      message: 'Sales order created successfully',
      data: newSalesOrder
    });
  } catch (error) {
    console.error('Error creating sales order:', error);
    
    if (error.code === '23505') { // Unique constraint violation
      return res.status(409).json({
        success: false,
        error: 'Sales order number already exists'
      });
    }
    
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create sales order'
    });
  }
});

// PUT /sales-orders/:id - Update sales order
router.put('/:id', auth, async (req, res) => {
  try {
    const updateData = req.body;
    
    // Validate items if provided
    if (updateData.items) {
      if (!Array.isArray(updateData.items) || updateData.items.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'At least one item is required'
        });
      }

      // Validate each item
      for (const item of updateData.items) {
        if (!item.item_name || !item.quantity || !item.unit_price || !item.unit_of_measure) {
          return res.status(400).json({
            success: false,
            error: 'Each item must have name, quantity, unit price, and unit of measure'
          });
        }
      }

      // Calculate totals
      let subtotal = 0;
      updateData.items = updateData.items.map(item => {
        const discountAmount = item.discount_amount || 0;
        const lineTotal = (item.quantity * item.unit_price) - discountAmount;
        subtotal += lineTotal;
        
        return {
          ...item,
          discount_amount: discountAmount,
          line_total: lineTotal
        };
      });

      let customerObj = {};
      const custId = updateData.customer_id;
      if (custId) {
        try { customerObj = (await Customer.findById(custId)) || {}; } catch (_) {}
      }
      const vatRate = taxService.resolveCustomerRate(customerObj);
      const discount_amount = parseFloat(updateData.discount_amount || 0);
      const netSubtotal = Math.max(0, subtotal - discount_amount);
      const tax_amount = taxService.computeTax(netSubtotal, vatRate);
      
      updateData.subtotal = subtotal;
      updateData.tax_amount = tax_amount;
      updateData.total_amount = taxService.round2(netSubtotal + tax_amount);
    }

    const updatedSalesOrder = await SalesOrder.update(req.params.id, updateData, req.user.id);
    orderWatch.onOrderLanded(req.companyId, req.params.id, 'changed');
    
    res.json({
      success: true,
      message: 'Sales order updated successfully',
      data: updatedSalesOrder
    });
  } catch (error) {
    console.error('Error updating sales order:', error);
    
    if (error.message === 'Sales order not found') {
      return res.status(404).json({
        success: false,
        error: 'Sales order not found'
      });
    }
    
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update sales order'
    });
  }
});

// POST /sales-orders/:id/cancel - Cancel a sales order
//
// This is the ONLY manual, click-driven status change left on a sales order.
// Every other stage (CONFIRMED, IN_PRODUCTION, GOODS_ISSUED, SHIPPED/DELIVERED,
// COMPLETED/invoiced) is now a byproduct of a real operation — customer portal
// acceptance, a work order releasing, a goods-issue posting, a delivery
// schedule action, or a customer confirming delivery — exactly like purchase
// orders have no manual "Update Status" panel and only PurchaseOrder.cancel()
// as an equivalent single-purpose abort action.
router.put('/:id/status', auth, (req, res) => {
  res.status(410).json({
    success: false,
    error: 'Manual status updates have been removed. Sales order status now advances only through real operations (approval, production start, goods issue, delivery, invoicing) or POST /:id/cancel.'
  });
});

router.post('/:id/cancel', auth, async (req, res) => {
  try {
    const reason = (req.body?.reason || '').trim();
    if (reason.length < 3) {
      return res.status(400).json({
        success: false,
        error: 'A reason (at least 3 characters) is required to cancel a sales order'
      });
    }

    const cancelledOrder = await SalesOrder.updateStatus(req.params.id, 'CANCELLED', req.user, reason);
    orderWatch.onOrderLanded(req.companyId, req.params.id, 'cancelled');

    res.json({
      success: true,
      message: 'Sales order cancelled successfully',
      data: cancelledOrder
    });
  } catch (error) {
    console.error('Error cancelling sales order:', error);
    res.status(error.status || 400).json({
      success: false,
      error: error.message || 'Failed to cancel sales order'
    });
  }
});

// POST /sales-orders/:id/request-approval - Request approval for order
router.post('/:id/request-approval', auth, async (req, res) => {
  try {
    const { notes } = req.body;
    
    const order = await SalesOrder.requestApproval(
      req.params.id,
      req.user.id,
      notes || ''
    );
    orderWatch.onOrderLanded(req.companyId, req.params.id, 'sent for approval');
    
    res.json({
      success: true,
      data: order,
      message: 'Order submitted for approval successfully'
    });
  } catch (error) {
    console.error('Error requesting order approval:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to submit order for approval'
    });
  }
});

// POST /sales-orders/:id/approve - Approve order
router.post('/:id/approve', auth, requireManagerOrAdmin, requireSoD(recordCreator('sales_orders'), 'approval'), async (req, res) => {
  try {
    const { approval_notes } = req.body;
    
    const approvedOrder = await SalesOrder.approveOrder(
      req.params.id, 
      req.user.id, 
      approval_notes || ''
    );
    orderWatch.onOrderLanded(req.companyId, req.params.id, 'approved');
    
    res.json({
      success: true,
      data: approvedOrder,
      message: 'Order approved successfully'
    });
  } catch (error) {
    console.error('Error approving order:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to approve order' 
    });
  }
});

// POST /sales-orders/:id/reject - Reject order
router.post('/:id/reject', auth, async (req, res) => {
  try {
    const { rejection_reason } = req.body;
    
    if (!rejection_reason || !rejection_reason.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Rejection reason is required'
      });
    }
    
    const rejectedOrder = await SalesOrder.rejectOrder(
      req.params.id, 
      req.user.id, 
      rejection_reason
    );
    
    res.json({
      success: true,
      data: rejectedOrder,
      message: 'Order rejected successfully'
    });
  } catch (error) {
    console.error('Error rejecting order:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to reject order' 
    });
  }
});

// DELETE /sales-orders/:id - Delete sales order (soft delete)
router.delete('/:id', auth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const deletedSalesOrder = await SalesOrder.delete(req.params.id, req.user.id);
    
    res.json({
      success: true,
      message: 'Sales order deleted successfully',
      data: deletedSalesOrder
    });
  } catch (error) {
    console.error('Error deleting sales order:', error);
    
    if (error.message === 'Sales order not found or already deleted') {
      return res.status(404).json({
        success: false,
        error: 'Sales order not found'
      });
    }
    
    if (error.code === '23503') { // Foreign key constraint
      return res.status(400).json({
        success: false,
        error: 'Cannot delete sales order - it has related records (deliveries, invoices, etc.)'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to delete sales order'
    });
  }
});

// GET /sales-orders/customer-response/:token - Get order details for customer (public)
router.get('/customer-response/:token', portalCompany('customer_order'), async (req, res) => {
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
        so.*,
        c.customer_name as customer_name_full,
        c.primary_email as customer_email,
        c.phone as customer_phone,
        u.first_name || ' ' || u.last_name as created_by_name
      FROM sales_orders so
      LEFT JOIN customers c ON so.customer_id = c.id
      LEFT JOIN users u ON so.created_by = u.id
      WHERE so.customer_response_token = $1
        AND so.deleted_at IS NULL
        AND (so.customer_response_token_expires_at IS NULL OR so.customer_response_token_expires_at > NOW())
        AND so.customer_response_token_used_at IS NULL
    `;
    
    const result = await db.query(query, [token]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Order not found or invalid token'
      });
    }
    
    const order = result.rows[0];
    
    // Get order items
    const itemsQuery = `
      SELECT 
        soi.*,
        i.name as inventory_item_name,
        i.item_code as inventory_item_code
      FROM sales_order_items soi
      LEFT JOIN inventory_items ii ON soi.inventory_item_id = ii.id
      LEFT JOIN items i ON ii.item_master_id = i.id
      WHERE soi.sales_order_id = $1
      ORDER BY soi.line_number
    `;
    
    const itemsResult = await db.query(itemsQuery, [order.id]);
    order.items = itemsResult.rows;
    
    // Remove sensitive data
    delete order.internal_notes;
    delete order.approval_notes;
    delete order.rejection_reason;
    
    res.json({
      success: true,
      data: order
    });
  } catch (error) {
    console.error('Error fetching order for customer response:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch order details'
    });
  }
});

// POST /sales-orders/customer-response/:token - Customer response endpoint (public)
router.post('/customer-response/:token', portalCompany('customer_order'), async (req, res) => {
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
    
    // Find the order by token
    const orderQuery = `
      SELECT so.*, c.customer_name as customer_name_full, c.primary_email
      FROM sales_orders so
      LEFT JOIN customers c ON so.customer_id = c.id
      WHERE so.customer_response_token = $1
        AND so.deleted_at IS NULL
        AND (so.customer_response_token_expires_at IS NULL OR so.customer_response_token_expires_at > NOW())
        AND so.customer_response_token_used_at IS NULL
    `;

    const orderResult = await db.query(orderQuery, [token]);

    if (orderResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Order not found, invalid, expired, or already-used token'
      });
    }
    
    const order = orderResult.rows[0];
    
    // Check if order is still available for customer response
    if (order.status !== 'SENT_TO_CUSTOMER') {
      return res.status(400).json({
        success: false,
        error: 'This order is no longer available for customer response'
      });
    }
    
    // Update order based on customer response
    const newStatus = action === 'accept' ? 'CONFIRMED' : 'CUSTOMER_REJECTED';
    
    const updateQuery = `
      UPDATE sales_orders
      SET
        status = $1,
        customer_response_date = CURRENT_TIMESTAMP,
        customer_response_action = $2,
        customer_response_comments = $3,
        customer_response_name = $4,
        customer_response_email = $5,
        customer_response_token_used_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING *
    `;
    
    await db.query(updateQuery, [
      newStatus,
      action.toUpperCase(),
      comments || '',
      customer_name || order.customer_name_full,
      customer_email || order.primary_email,
      order.id
    ]);
    
    // Add status history
    const statusHistoryQuery = `
      INSERT INTO sales_order_status_history 
      (sales_order_id, from_status, to_status, reason, status_date)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
    `;
    
    await db.query(statusHistoryQuery, [
      order.id,
      'SENT_TO_CUSTOMER',
      newStatus,
      `Customer ${action}ed order${comments ? ': ' + comments : ''}`
    ]);
    
    // Create notification for order creator and approver
    const Notification = require('../models/Notification');
    
    const notificationTitle = `Order ${action === 'accept' ? 'Confirmed' : 'Rejected'}: ${order.so_number}`;
    const notificationMessage = `Customer has ${action}ed order ${order.so_number}${action === 'accept' ? ' - Order is now CONFIRMED' : ''}${comments ? ': ' + comments : ''}`;
    
    // Determine correct notification type
    const notificationType = action === 'accept' ? 'SALES_ORDER_CUSTOMER_CONFIRMED' : 'SALES_ORDER_CUSTOMER_CANCELLED';
    
    // Notify order creator
    if (order.created_by) {
      await Notification.create({
        user_id: order.created_by,
        type: notificationType,
        title: notificationTitle,
        message: notificationMessage,
        related_type: 'SALES_ORDER',
        related_id: order.id
      });
    }
    
    // Notify approver if different from creator
    if (order.approved_by && order.approved_by !== order.created_by) {
      await Notification.create({
        user_id: order.approved_by,
        type: notificationType,
        title: notificationTitle,
        message: notificationMessage,
        related_type: 'SALES_ORDER',
        related_id: order.id
      });
    }
    
    if (action === 'accept') orderWatch.onOrderLanded(order.company_id, order.id, 'confirmed by the customer');

    const successMessage = action === 'accept' 
      ? `Order signed and confirmed successfully. The order has been digitally signed by both parties and is now active.`
      : `Order declined successfully`;
    
    res.json({
      success: true,
      message: successMessage,
      data: {
        so_number: order.so_number,
        customer_name: order.customer_name,
        action: action,
        response_date: new Date().toISOString(),
        status: newStatus,
        digitally_signed: action === 'accept'
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