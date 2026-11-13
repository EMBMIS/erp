const express = require('express');
const router = express.Router();
const RequestForQuotation = require('../models/RequestForQuotation');
const { auth, requireRole } = require('../middleware/auth');

// GET /request-for-quotations - List all RFQs with filters
router.get('/', auth, async (req, res) => {
  try {
    const rfqs = await RequestForQuotation.findAll(req.query, req.user.id);
    res.json({
      success: true,
      data: rfqs,
      count: rfqs.length
    });
  } catch (error) {
    console.error('Error fetching RFQs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch request for quotations'
    });
  }
});

// GET /request-for-quotations/stats - Get RFQ statistics
// GET /request-for-quotations/savings?days=365 — what taking the best quote
// saved against the average of the quotes received, over the window.
router.get('/savings', auth, async (req, res) => {
  try {
    const requested = parseInt(req.query.days, 10);
    const days = Number.isInteger(requested) ? Math.min(Math.max(requested, 7), 1825) : 365;
    const data = await RequestForQuotation.getSourcingSavings(req.user.id, days);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching RFQ savings:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch sourcing savings' });
  }
});

router.get('/stats', auth, async (req, res) => {
  try {
    const stats = await RequestForQuotation.getStats(req.user.id);
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Error fetching RFQ stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch statistics'
    });
  }
});

// GET /request-for-quotations/completed - Get completed RFQs for PO creation
router.get('/completed', auth, async (req, res) => {
  try {
    const rfqs = await RequestForQuotation.getCompletedRFQs();
    res.json({
      success: true,
      data: rfqs
    });
  } catch (error) {
    console.error('Error fetching completed RFQs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch completed RFQs'
    });
  }
});

// GET /request-for-quotations/:id - Get single RFQ by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const rfq = await RequestForQuotation.findById(req.params.id, req.user.id);
    
    if (!rfq) {
      return res.status(404).json({
        success: false,
        error: 'Request for quotation not found'
      });
    }

    res.json({
      success: true,
      data: rfq
    });
  } catch (error) {
    console.error('Error fetching RFQ:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch request for quotation'
    });
  }
});

// GET /request-for-quotations/:id/line-items - Get RFQ line items
router.get('/:id/line-items', auth, async (req, res) => {
  try {
    const items = await RequestForQuotation.getLineItems(req.params.id);
    res.json({
      success: true,
      data: items
    });
  } catch (error) {
    console.error('Error fetching RFQ line items:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch RFQ line items'
    });
  }
});

// GET /request-for-quotations/:id/suppliers - Get RFQ suppliers
router.get('/:id/suppliers', auth, async (req, res) => {
  try {
    const suppliers = await RequestForQuotation.getSuppliers(req.params.id);
    res.json({
      success: true,
      data: suppliers
    });
  } catch (error) {
    console.error('Error fetching RFQ suppliers:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch RFQ suppliers'
    });
  }
});

// GET /request-for-quotations/:id/quotations - Get RFQ quotations
router.get('/:id/quotations', auth, async (req, res) => {
  try {
    const supplierId = req.query.supplier_id || null;
    console.log(`🔍 Fetching quotations for RFQ ${req.params.id}, supplier: ${supplierId}`);
    const quotations = await RequestForQuotation.getQuotations(req.params.id, supplierId);
    console.log(`📋 Found ${quotations.length} quotations for RFQ ${req.params.id}`);
    res.json({
      success: true,
      data: quotations,
      debug: {
        rfqId: req.params.id,
        supplierId,
        quotationCount: quotations.length,
        quotationIds: quotations.map(q => q.id)
      }
    });
  } catch (error) {
    console.error('Error fetching RFQ quotations:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch RFQ quotations'
    });
  }
});

// POST /request-for-quotations - Create new RFQ
router.post('/', auth, async (req, res) => {
  try {
    const {
      title,
      description,
      response_deadline,
      line_items,
      suppliers
    } = req.body;

    // Validate required fields
    if (!title) {
      return res.status(400).json({
        success: false,
        error: 'Title is required'
      });
    }

    if (!line_items || line_items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one line item is required'
      });
    }

    if (!suppliers || suppliers.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one supplier is required'
      });
    }

    const rfq = await RequestForQuotation.create(req.body, req.user.id);
    
    res.status(201).json({
      success: true,
      data: rfq,
      message: 'Request for quotation created successfully'
    });
  } catch (error) {
    console.error('Error creating RFQ:', error);
    
    if (error.code === '23503') { // Foreign key constraint
      return res.status(400).json({
        success: false,
        error: 'Invalid purchase requisition or supplier selected'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to create request for quotation'
    });
  }
});

// POST /request-for-quotations/:id/line-items - Add line item to RFQ
router.post('/:id/line-items', auth, async (req, res) => {
  try {
    const {
      item_description,
      unit_of_measure,
      quantity
    } = req.body;

    // Validate required fields
    if (!item_description || !quantity) {
      return res.status(400).json({
        success: false,
        error: 'Item description and quantity are required'
      });
    }

    const lineItem = await RequestForQuotation.addLineItem(req.params.id, req.body);
    
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
        error: 'Invalid RFQ or item ID'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to add line item'
    });
  }
});

// POST /request-for-quotations/:id/suppliers - Add supplier to RFQ
router.post('/:id/suppliers', auth, async (req, res) => {
  try {
    const { supplier_id } = req.body;

    if (!supplier_id) {
      return res.status(400).json({
        success: false,
        error: 'Supplier ID is required'
      });
    }

    const supplier = await RequestForQuotation.addSupplier(req.params.id, supplier_id);
    
    res.status(201).json({
      success: true,
      data: supplier,
      message: 'Supplier added to RFQ successfully'
    });
  } catch (error) {
    console.error('Error adding supplier to RFQ:', error);
    
    if (error.code === '23505') { // Unique constraint violation
      return res.status(400).json({
        success: false,
        error: 'Supplier already added to this RFQ'
      });
    }
    
    if (error.code === '23503') { // Foreign key constraint
      return res.status(400).json({
        success: false,
        error: 'Invalid RFQ or supplier ID'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to add supplier to RFQ'
    });
  }
});

// POST /request-for-quotations/:id/quotations - Add quotation to RFQ
router.post('/:id/quotations', auth, async (req, res) => {
  try {
    const {
      supplier_id,
      rfq_line_item_id,
      unit_price
    } = req.body;

    // Validate required fields
    if (!supplier_id || !rfq_line_item_id || !unit_price) {
      return res.status(400).json({
        success: false,
        error: 'Supplier ID, line item ID, and unit price are required'
      });
    }

    const quotationData = {
      ...req.body,
      rfq_id: req.params.id
    };

    const quotation = await RequestForQuotation.addQuotation(quotationData);
    
    res.status(201).json({
      success: true,
      data: quotation,
      message: 'Quotation added successfully'
    });
  } catch (error) {
    console.error('Error adding quotation:', error);
    
    if (error.code === '23505') { // Unique constraint violation
      return res.status(400).json({
        success: false,
        error: 'Quotation already exists for this supplier and line item'
      });
    }
    
    if (error.code === '23503') { // Foreign key constraint
      return res.status(400).json({
        success: false,
        error: 'Invalid RFQ, supplier, or line item ID'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to add quotation'
    });
  }
});

// POST /request-for-quotations/:id/submit - Submit RFQ for approval
router.post('/:id/submit', auth, async (req, res) => {
  try {
    const rfq = await RequestForQuotation.submitForApproval(req.params.id, req.user.id);
    
    if (!rfq) {
      return res.status(404).json({
        success: false,
        error: 'RFQ not found or cannot be submitted'
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

// PUT /request-for-quotations/:id - Update RFQ
router.put('/:id', auth, async (req, res) => {
  try {
    const rfq = await RequestForQuotation.update(req.params.id, req.body, req.user.id);
    
    if (!rfq) {
      return res.status(404).json({
        success: false,
        error: 'Request for quotation not found'
      });
    }

    res.json({
      success: true,
      data: rfq,
      message: 'Request for quotation updated successfully'
    });
  } catch (error) {
    console.error('Error updating RFQ:', error);
    
    if (error.message === 'No valid fields to update') {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to update request for quotation'
    });
  }
});

// POST /request-for-quotations/:id/send - Send RFQ to suppliers
router.post('/:id/send', auth, async (req, res) => {
  try {
    const rfq = await RequestForQuotation.send(req.params.id, req.user.id);
    
    if (!rfq) {
      return res.status(404).json({
        success: false,
        error: 'RFQ not found or cannot be sent'
      });
    }

    res.json({
      success: true,
      data: rfq,
      message: 'RFQ sent to suppliers successfully'
    });
  } catch (error) {
    console.error('Error sending RFQ:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send RFQ'
    });
  }
});

// POST /request-for-quotations/:id/mark-responses-received - Mark responses received
router.post('/:id/mark-responses-received', auth, async (req, res) => {
  try {
    const rfq = await RequestForQuotation.markResponsesReceived(req.params.id);
    
    if (!rfq) {
      return res.status(404).json({
        success: false,
        error: 'RFQ not found or not in correct state'
      });
    }

    res.json({
      success: true,
      data: rfq,
      message: 'RFQ marked as responses received successfully'
    });
  } catch (error) {
    console.error('Error marking responses received:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to mark responses received'
    });
  }
});

// POST /request-for-quotations/:id/mark-evaluated - Mark RFQ as evaluated
router.post('/:id/mark-evaluated', auth, async (req, res) => {
  try {
    const rfq = await RequestForQuotation.markEvaluated(req.params.id);
    
    if (!rfq) {
      return res.status(404).json({
        success: false,
        error: 'RFQ not found or not in correct state'
      });
    }

    res.json({
      success: true,
      data: rfq,
      message: 'RFQ marked as evaluated successfully'
    });
  } catch (error) {
    console.error('Error marking RFQ evaluated:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to mark RFQ as evaluated'
    });
  }
});

// GET /request-for-quotations/:id/supplier-recommendations - Get supplier recommendations
router.get('/:id/supplier-recommendations', auth, async (req, res) => {
  try {
    const recommendations = await RequestForQuotation.getBestSupplierRecommendation(req.params.id);
    
    res.json({
      success: true,
      data: recommendations,
      message: 'Supplier recommendations retrieved successfully'
    });
  } catch (error) {
    console.error('Error getting supplier recommendations:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get supplier recommendations'
    });
  }
});

// POST /request-for-quotations/:id/auto-select-supplier - Auto-select best supplier
router.post('/:id/auto-select-supplier', auth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const rfq = await RequestForQuotation.autoSelectBestSupplier(req.params.id);
    
    if (!rfq) {
      return res.status(404).json({
        success: false,
        error: 'RFQ not found or not ready for supplier selection'
      });
    }

    res.json({
      success: true,
      data: rfq,
      message: 'Best supplier selected automatically'
    });
  } catch (error) {
    console.error('Error auto-selecting supplier:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to auto-select supplier'
    });
  }
});

// POST /request-for-quotations/:id/select-supplier - Select winning supplier
router.post('/:id/select-supplier', auth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const { winning_supplier_id, selection_reason } = req.body;

    if (!winning_supplier_id) {
      return res.status(400).json({
        success: false,
        error: 'Winning supplier ID is required'
      });
    }

    if (!selection_reason || selection_reason.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Selection reason is required'
      });
    }

    const rfq = await RequestForQuotation.selectSupplier(req.params.id, winning_supplier_id, selection_reason);
    
    if (!rfq) {
      return res.status(404).json({
        success: false,
        error: 'RFQ not found or not ready for supplier selection'
      });
    }

    res.json({
      success: true,
      data: rfq,
      message: 'Supplier selected successfully'
    });
  } catch (error) {
    console.error('Error selecting supplier:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to select supplier'
    });
  }
});

// POST /request-for-quotations/:id/close - Close RFQ
router.post('/:id/close', auth, async (req, res) => {
  try {
    const rfq = await RequestForQuotation.close(req.params.id);
    
    if (!rfq) {
      return res.status(404).json({
        success: false,
        error: 'RFQ not found or cannot be closed'
      });
    }

    res.json({
      success: true,
      data: rfq,
      message: 'RFQ closed successfully'
    });
  } catch (error) {
    console.error('Error closing RFQ:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to close RFQ'
    });
  }
});

// DELETE /request-for-quotations/:id/line-items/:lineItemId - Remove line item
router.delete('/:id/line-items/:lineItemId', auth, async (req, res) => {
  try {
    const lineItem = await RequestForQuotation.removeLineItem(req.params.id, req.params.lineItemId);
    
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

// DELETE /request-for-quotations/:id/suppliers/:supplierId - Remove supplier
router.delete('/:id/suppliers/:supplierId', auth, async (req, res) => {
  try {
    const supplier = await RequestForQuotation.removeSupplier(req.params.id, req.params.supplierId);
    
    if (!supplier) {
      return res.status(404).json({
        success: false,
        error: 'Supplier not found in RFQ'
      });
    }

    res.json({
      success: true,
      message: 'Supplier removed from RFQ successfully'
    });
  } catch (error) {
    console.error('Error removing supplier from RFQ:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to remove supplier from RFQ'
    });
  }
});

// DELETE /request-for-quotations/:id - Delete RFQ
router.delete('/:id', auth, async (req, res) => {
  try {
    // Managers and admins can delete any RFQ, users can only delete their own
    const isManager = req.user.role === 'MANAGER' || req.user.role === 'ADMIN';
    const userIdRestriction = isManager ? null : req.user.id;
    
    const rfq = await RequestForQuotation.delete(req.params.id, userIdRestriction);
    
    if (!rfq) {
      return res.status(404).json({
        success: false,
        error: 'Request for quotation not found'
      });
    }

    res.json({
      success: true,
      message: 'Request for quotation deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting RFQ:', error);
    
    if (error.code === '23503') { // Foreign key constraint
      return res.status(400).json({
        success: false,
        error: 'Cannot delete RFQ - it is referenced by other records'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to delete request for quotation'
    });
  }
});

module.exports = router;