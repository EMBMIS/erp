const express = require('express');
const router = express.Router();
const Item = require('../models/Item');
const AIService = require('../config/openai');
const { validateItem, validateUpdateItem, validateFilters, validateUUID } = require('../middleware/validation');
const { auth, requireManagerOrAdmin } = require('../middleware/auth');

// The filter validator (middleware/validation.js filterSchema) predates
// server-side pagination and knows nothing about page/sort_by/sort_dir (limit/
// offset are capped there at 100, which is below the 200 the reference list
// endpoint allows). Pull every list-control param off the query BEFORE
// validateFilters runs so the new keys are neither rejected as unknown nor
// stripped, and hand the handler the parsed values via req.listControls.
function extractListControls(req, res, next) {
  const q = req.query;
  req.listControls = {
    page: q.page,
    limit: q.limit,
    offset: q.offset,
    sort_by: q.sort_by,
    sort_dir: q.sort_dir,
  };
  delete q.page;
  delete q.limit;
  delete q.offset;
  delete q.sort_by;
  delete q.sort_dir;
  next();
}

// GET /items - List all items with filters, server-side pagination and sorting.
//
// Response contract mirrors customer-invoices GET / so the frontend
// useListControls hook works unchanged: { success, data: rows, total, limit,
// offset }. `count` is kept (additive) because pre-pagination callers read it.
// Callers that pass no page/limit/offset still get every matching row (the
// original fetch-all contract), with total/limit/offset filled in so a
// frontend that switches to useListControls starts paging immediately.
router.get('/', auth, extractListControls, validateFilters, async (req, res) => {
  try {
    const c = req.listControls;
    const paginating = c.page !== undefined || c.limit !== undefined || c.offset !== undefined;

    // Cap the page size (same reasoning as customer-invoices GET /): without an
    // upper bound ?limit=100000 is a denial of service typed into the address
    // bar, and the default must be finite too — but only when pagination is
    // actually requested. Sane defaults: page=1, limit=50, offset=0.
    const limit = Math.min(Math.max(parseInt(c.limit, 10) || 50, 1), 200);
    const page = Math.max(parseInt(c.page, 10) || 1, 1);
    const offset = c.page !== undefined ? (page - 1) * limit : Math.max(parseInt(c.offset, 10) || 0, 0);

    const { rows, total } = await Item.findAll({
      ...req.query,
      sort_by: c.sort_by,
      sort_dir: c.sort_dir,
      limit: paginating ? limit : undefined,
      offset: paginating ? offset : undefined,
    }, req.user.id);

    res.json({
      success: true,
      data: rows,
      total,
      limit: paginating ? limit : total,
      offset: paginating ? offset : 0,
      count: rows.length
    });
  } catch (error) {
    console.error('Error fetching items:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch items'
    });
  }
});

// GET /items/pending-approvals - Item masters awaiting review, from any creator.
//
// Must stay ABOVE any `/:id` route: Express matches in declaration order, so a
// later `/:id` would swallow "pending-approvals" as an id and return 404/500.
//
// Separate from GET /items because that endpoint scopes to the caller's own
// records — see Item.getPendingApprovals for why that made the approval portal
// permanently empty.
router.get('/pending-approvals', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const items = await Item.getPendingApprovals();
    res.json({ success: true, data: items, count: items.length });
  } catch (error) {
    console.error('Error fetching item masters pending approval:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch item masters pending approval' });
  }
});

// GET /items/stats - Get items statistics
router.get('/stats', auth, async (req, res) => {
  try {
    const stats = await Item.getStats(req.user.id);
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch statistics'
    });
  }
});

// GET /items/:id - Get single item by ID
router.get('/:id', auth, validateUUID, async (req, res) => {
  try {
    const item = await Item.findById(req.params.id, req.user.id);
    
    if (!item) {
      return res.status(404).json({
        success: false,
        error: 'Item not found'
      });
    }

    res.json({
      success: true,
      data: item
    });
  } catch (error) {
    console.error('Error fetching item:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch item'
    });
  }
});

// POST /items - Create new item
router.post('/', auth, validateItem, async (req, res) => {
  try {
    const item = await Item.create(req.body, req.user.id);
    
    res.status(201).json({
      success: true,
      data: item,
      message: 'Item created successfully'
    });
  } catch (error) {
    console.error('Error creating item:', error);
    
    if (error.code === '23505') { // Unique constraint violation
      return res.status(400).json({
        success: false,
        error: 'Item code already exists'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to create item'
    });
  }
});

// PUT /items/:id - Update item
router.put('/:id', auth, validateUUID, validateUpdateItem, async (req, res) => {
  try {
    const item = await Item.update(req.params.id, req.body, req.user.id);
    
    if (!item) {
      return res.status(404).json({
        success: false,
        error: 'Item not found'
      });
    }

    res.json({
      success: true,
      data: item,
      message: 'Item updated successfully'
    });
  } catch (error) {
    console.error('Error updating item:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update item'
    });
  }
});

// POST /items/:id/approve - Approve item and generate inventory code
router.post('/:id/approve', auth, requireManagerOrAdmin, validateUUID, async (req, res) => {
  try {
    const item = await Item.approve(req.params.id, req.user.id);
    
    res.json({
      success: true,
      data: item,
      message: `Item approved successfully. Inventory code: ${item.approved_item_code}`
    });
  } catch (error) {
    console.error('Error approving item:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to approve item'
    });
  }
});

// POST /items/:id/decline - Decline item with reason
router.post('/:id/decline', auth, requireManagerOrAdmin, validateUUID, async (req, res) => {
  try {
    const { reason } = req.body;
    
    if (!reason || reason.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Decline reason is required'
      });
    }
    
    const item = await Item.decline(req.params.id, reason, req.user.id);
    
    res.json({
      success: true,
      data: item,
      message: 'Item declined successfully'
    });
  } catch (error) {
    console.error('Error declining item:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to decline item'
    });
  }
});

// DELETE /items/:id - Delete item
router.delete('/:id', auth, validateUUID, async (req, res) => {
  try {
    const item = await Item.delete(req.params.id, req.user.id);
    
    if (!item) {
      return res.status(404).json({
        success: false,
        error: 'Item not found'
      });
    }

    res.json({
      success: true,
      message: 'Item deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting item:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete item'
    });
  }
});

// POST /items/ai/describe - Generate AI description
router.post('/ai/describe', auth, async (req, res) => {
  try {
    const { name } = req.body;
    
    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'Item name is required'
      });
    }

    const description = await AIService.generateItemDescription(name);
    
    res.json({
      success: true,
      data: { description }
    });
  } catch (error) {
    console.error('Error generating description:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate description'
    });
  }
});

// POST /items/ai/suggest - Get AI suggestions
router.post('/ai/suggest', auth, async (req, res) => {
  try {
    const { name, description } = req.body;
    
    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'Item name is required'
      });
    }

    const [stockSettings, criticality] = await Promise.all([
      AIService.suggestStockSettings(name, description || ''),
      AIService.predictCriticality(name, description || '')
    ]);
    
    res.json({
      success: true,
      data: {
        is_stock_item: stockSettings.is_stock_item,
        planned_stock: stockSettings.planned_stock,
        predicted_criticality: criticality
      }
    });
  } catch (error) {
    console.error('Error getting AI suggestions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get AI suggestions'
    });
  }
});

// POST /items/ai/parse - Parse natural language input
router.post('/ai/parse', auth, async (req, res) => {
  try {
    const { input } = req.body;
    
    if (!input) {
      return res.status(400).json({
        success: false,
        error: 'Input text is required'
      });
    }

    const parsed = await AIService.parseNLInput(input);
    
    res.json({
      success: true,
      data: parsed
    });
  } catch (error) {
    console.error('Error parsing input:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to parse input'
    });
  }
});

// POST /items/ai/comprehensive - Generate comprehensive data
router.post('/ai/comprehensive', auth, async (req, res) => {
  try {
    const { name, description } = req.body;
    
    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'Item name is required'
      });
    }

    const comprehensiveData = await AIService.generateComprehensiveData(name, description);
    
    res.json({
      success: true,
      data: comprehensiveData
    });
  } catch (error) {
    console.error('Error generating comprehensive data:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate comprehensive data'
    });
  }
});

module.exports = router;