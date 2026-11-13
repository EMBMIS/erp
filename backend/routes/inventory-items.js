const express = require('express');
const { auth, requireRole, requireManagerOrAdmin } = require('../middleware/auth');
const requireModule = require('../middleware/requireModule');
const InventoryItem = require('../models/InventoryItem');

const router = express.Router();

// POST /inventory-items/reorder-check - MRP-lite: draft purchase requisitions
// for every item at/below its reorder point. { dry_run: true } previews without
// creating anything. Safe to re-run — items with an already-open PR are skipped.
router.post('/reorder-check', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const { runReorderCheck } = require('../services/reorderService');
    const result = await runReorderCheck(req.user.id, { dryRun: req.body?.dry_run === true });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Reorder check error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /inventory-items/valuation-report?as_of=2026-08-14
//
// Inventory valuation under both costing methods already maintained in this
// codebase (moving-average on inventory_items.unit_price, FIFO layers in
// cost_layers), compared against the real 1130 (Inventory) GL balance
// recomputed from posted journal entries — not a claim, a recomputed check
// (same pattern as financial-reports.js's cash-flow-statement banner).
router.get('/valuation-report', auth, async (req, res) => {
  try {
    const { valuationReport } = require('../services/inventoryValuationService');
    const report = await valuationReport({ asOfDate: req.query.as_of || null });
    res.json({ success: true, data: report });
  } catch (error) {
    console.error('Inventory valuation report error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// GET /inventory-items/semantic-search?q=...&type=item|supplier
//
// Duplicate check against master data. Returns `method` and `degraded` so the
// caller can tell a semantic answer from a lexical fallback — "no similar
// items" means something quite different depending on which ran.
router.get('/semantic-search', auth, async (req, res) => {
  try {
    const VectorSearchService = require('../services/ai/vectorSearchService');
    const kind = req.query.type === 'supplier' ? 'supplier' : 'item';
    const limit = Math.min(20, Number(req.query.limit) || 5);

    const result = await VectorSearchService.findSimilar(kind, req.query.q || '', { limit });

    res.json({
      success: true,
      count: result.matches.length,
      method: result.method,
      degraded: result.degraded,
      data: result.matches,
    });
  } catch (error) {
    console.error('Semantic search error:', error);
    res.status(500).json({ success: false, error: 'The similarity search could not be completed.' });
  }
});

// POST /inventory-items/semantic-search/reindex — build the embedding index.
//
// Manual and manager-gated: it makes one embeddings API call per record, so it
// is a deliberate act with a cost, not something to run on every save.
router.post('/semantic-search/reindex', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const VectorSearchService = require('../services/ai/vectorSearchService');
    const kind = req.body.type === 'supplier' ? 'supplier' : 'item';
    const result = await VectorSearchService.reindex(kind, { limit: Number(req.body.limit) || 2000 });
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Reindex error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// GET /inventory-items/similar?q=<text>&limit=10
//
// Semantic similarity search over stocked inventory items (embedding
// vector(384) on inventory_items, migration 202608070200) — distinct from
// /semantic-search above, which deduplicates against the item MASTER
// (items table) at creation time. This searches actual stock records.
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
      `SELECT ii.*, im.item_code, im.name, im.description, im.category,
              1 - (ii.embedding <=> $1::vector) AS score
         FROM inventory_items ii
         LEFT JOIN items im ON im.id = ii.item_master_id
        WHERE ii.embedding IS NOT NULL
        ORDER BY ii.embedding <=> $1::vector ASC
        LIMIT $2`,
      [queryVector, limit]
    );

    res.json({ success: true, query: q, data: rows, count: rows.length });
  } catch (error) {
    console.error('Error running inventory item similarity search:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to run similarity search' });
  }
});

// GET /inventory-items/barcode/:code — scan-to-lookup.
//
// Gated behind the 'barcode_scanning' module (see services/moduleService.js)
// — the proof-of-concept for the module system actually unlocking a genuinely
// new capability, not just relabelling or hiding existing ones. Matches
// items.barcode exactly (barcodes are printed/scanned values, not free text
// to fuzzy-search) and returns every stock record for that item master, since
// the same barcode can have more than one stock record (different condition
// grades, lots, etc.) — see inventory_storage_mappings for actual bin/location
// detail, out of scope for this lookup.
router.get('/barcode/:code', auth, requireModule('barcode_scanning'), async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    if (!code) return res.status(400).json({ success: false, error: 'A barcode value is required.' });

    const db = require('../config/database');
    const { rows } = await db.query(
      `SELECT ii.id, ii.current_stock_quantity, ii.unit_price, ii.currency, ii.status,
              ii.condition_grade,
              im.id AS item_master_id, im.item_code, im.name, im.description, im.category, im.barcode
         FROM items im
         LEFT JOIN inventory_items ii ON ii.item_master_id = im.id
        WHERE im.barcode = $1
        ORDER BY ii.current_stock_quantity DESC NULLS LAST`,
      [code]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, error: `No item found for barcode "${code}".` });
    }

    const { item_master_id, item_code, name, description, category, barcode } = rows[0];
    res.json({
      success: true,
      data: {
        item_master_id, item_code, name, description, category, barcode,
        stock_records: rows
          .filter((r) => r.id)
          .map((r) => ({
            id: r.id,
            quantity: Number(r.current_stock_quantity),
            unit_price: r.unit_price != null ? Number(r.unit_price) : null,
            currency: r.currency,
            status: r.status,
            condition_grade: r.condition_grade,
          })),
      },
    });
  } catch (error) {
    console.error('Error looking up barcode:', error);
    res.status(500).json({ success: false, error: 'Failed to look up that barcode.' });
  }
});

// GET /inventory-items - List all inventory items with filters
router.get('/', auth, async (req, res) => {
  try {
    const items = await InventoryItem.findAll(req.query, req.user.id);
    res.json({
      success: true,
      data: items,
      count: items.length
    });
  } catch (error) {
    console.error('Error fetching inventory items:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch inventory items'
    });
  }
});

// GET /inventory-items/available-masters - Get item masters that can become inventory items
router.get('/available-masters', auth, async (req, res) => {
  try {
    const items = await InventoryItem.getAvailableItemMasters(req.user.id);
    res.json({
      success: true,
      data: items,
      count: items.length
    });
  } catch (error) {
    console.error('Error fetching available item masters:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch available item masters'
    });
  }
});

// GET /inventory-items/stats - Get inventory statistics
// GET /inventory-items/analytics?months=12&slow_days=90 — the whole overview in
// one round trip: where the stock is, how it moved, what it is made of, how
// accurate the book is, and how fast it turns.
router.get('/analytics', auth, async (req, res) => {
  try {
    const m = parseInt(req.query.months, 10);
    const s = parseInt(req.query.slow_days, 10);
    const months = Number.isInteger(m) ? Math.min(Math.max(m, 2), 36) : 12;
    const slowDays = Number.isInteger(s) ? Math.min(Math.max(s, 7), 730) : 90;
    const data = await InventoryItem.getAnalytics(req.user.id, months, slowDays);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching inventory analytics:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch inventory analytics' });
  }
});

router.get('/stats', auth, async (req, res) => {
  try {
    const stats = await InventoryItem.getStats(req.user.id);
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Error fetching inventory stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch inventory statistics'
    });
  }
});

// GET /inventory-items/pending-approvals - Get inventory items pending approval (Manager and Admin)
router.get('/pending-approvals', auth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const pendingItems = await InventoryItem.getPendingApprovals();
    
    res.json({
      success: true,
      data: pendingItems,
      message: 'Pending approval inventory items retrieved successfully'
    });
  } catch (error) {
    console.error('Error fetching pending approvals:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch pending approval inventory items'
    });
  }
});

// GET /inventory-items/:id/atp - Real-time Available-to-Promise (ATP) calculation
router.get('/:id/atp', auth, async (req, res) => {
  try {
    const ATPService = require('../services/atpService');
    const atp = await ATPService.calculateTimePhasedATP(req.params.id, Number(req.query.horizonDays) || 60, req.companyId);
    res.json({
      success: true,
      data: atp,
    });
  } catch (error) {
    console.error('ATP calculation error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// GET /inventory-items/:id/replenishment
// "We're going to run low on this. What should I do?" — the same answer Simeli gives
// (services/replenishmentPlan.js). Read-only; the purchase order is a proposal a person drafts.
router.get('/:id/replenishment', auth, async (req, res) => {
  try {
    const { planReplenishment } = require('../services/replenishmentPlan');
    const data = await planReplenishment({
      companyId: req.companyId,
      userId: req.user?.isApiKey ? null : req.user?.id,
      role: req.user?.role,
      item: req.params.id,
    });
    if (data.error) return res.status(404).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Replenishment plan error:', error.message);
    res.status(500).json({ success: false, error: 'Could not plan the replenishment.' });
  }
});

// GET /inventory-items/:id - Get single inventory item by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const item = await InventoryItem.findById(req.params.id, req.user.id);
    
    if (!item) {
      return res.status(404).json({
        success: false,
        error: 'Inventory item not found'
      });
    }

    res.json({
      success: true,
      data: item
    });
  } catch (error) {
    console.error('Error fetching inventory item:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch inventory item'
    });
  }
});

// GET /inventory-items/:id/storage-mappings - Get storage mappings for an inventory item
router.get('/:id/storage-mappings', auth, async (req, res) => {
  try {
    const mappings = await InventoryItem.getStorageMappings(req.params.id, req.user.id);
    res.json({
      success: true,
      data: mappings
    });
  } catch (error) {
    console.error('Error fetching storage mappings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch storage mappings'
    });
  }
});

// POST /inventory-items - Create new inventory item
router.post('/', auth, async (req, res) => {
  try {
    const { 
      item_master_id, 
      unit_price, 
      currency,
      condition_grade,
      condition_notes
    } = req.body;

    if (!item_master_id) {
      return res.status(400).json({
        success: false,
        error: 'Item master ID is required'
      });
    }

    // Validate condition grade if provided
    if (condition_grade && !['A', 'B', 'C', 'D'].includes(condition_grade)) {
      return res.status(400).json({
        success: false,
        error: 'Condition grade must be A, B, C, or D'
      });
    }

    const inventoryData = {
      item_master_id,
      unit_price: unit_price || null,
      currency: currency || 'USD',
      condition_grade: condition_grade || 'A',
      condition_notes: condition_notes || null
    };

    const newItem = await InventoryItem.create(inventoryData, req.user.id);
    
    res.status(201).json({
      success: true,
      data: newItem,
      message: 'Inventory item created successfully'
    });
  } catch (error) {
    console.error('Error creating inventory item:', error);
    
    if (error.message.includes('already exists')) {
      return res.status(409).json({
        success: false,
        error: error.message
      });
    }
    
    if (error.message.includes('not found') || error.message.includes('approved')) {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to create inventory item'
    });
  }
});

// PUT /inventory-items/:id - Update inventory item
router.put('/:id', auth, async (req, res) => {
  try {
    const updateData = req.body;
    const updatedItem = await InventoryItem.update(req.params.id, updateData, req.user.id);
    
    if (!updatedItem) {
      return res.status(404).json({
        success: false,
        error: 'Inventory item not found'
      });
    }

    res.json({
      success: true,
      data: updatedItem,
      message: 'Inventory item updated successfully'
    });
  } catch (error) {
    console.error('Error updating inventory item:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to update inventory item'
    });
  }
});

// DELETE /inventory-items/:id - Delete inventory item
router.delete('/:id', auth, async (req, res) => {
  try {
    const deletedItem = await InventoryItem.delete(req.params.id, req.user.id);
    
    if (!deletedItem) {
      return res.status(404).json({
        success: false,
        error: 'Inventory item not found'
      });
    }

    res.json({
      success: true,
      message: 'Inventory item deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting inventory item:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete inventory item'
    });
  }
});

// POST /inventory-items/:id/storage-mapping - Add storage mapping
router.post('/:id/storage-mapping', auth, async (req, res) => {
  try {
    const { storage_location_id, bin_id, quantity_in_location, status } = req.body;

    if (!storage_location_id) {
      return res.status(400).json({
        success: false,
        error: 'Storage location ID is required'
      });
    }

    const mapping = await InventoryItem.addStorageMapping(
      req.params.id,
      storage_location_id,
      bin_id || null,
      quantity_in_location || 0,
      req.user.id,
      status || 'PENDING_APPROVAL'
    );

    res.status(201).json({
      success: true,
      data: mapping,
      message: 'Storage mapping added successfully'
    });
  } catch (error) {
    console.error('Error adding storage mapping:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to add storage mapping'
    });
  }
});

// DELETE /inventory-items/:id/storage-mapping/:mappingId - Remove storage mapping
router.delete('/:id/storage-mapping/:mappingId', auth, async (req, res) => {
  try {
    const deletedMapping = await InventoryItem.removeStorageMapping(
      req.params.id,
      req.params.mappingId,
      req.user.id
    );

    if (!deletedMapping) {
      return res.status(404).json({
        success: false,
        error: 'Storage mapping not found'
      });
    }

    res.json({
      success: true,
      message: 'Storage mapping removed successfully'
    });
  } catch (error) {
    console.error('Error removing storage mapping:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to remove storage mapping'
    });
  }
});


// POST /inventory-items/:id/approve - Approve inventory item (Manager and Admin)
router.post('/:id/approve', auth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const { minimum_stock_level, maximum_stock_level, reorder_point } = req.body;

    const approvalData = {
      minimum_stock_level,
      maximum_stock_level,
      reorder_point
    };

    const approvedItem = await InventoryItem.approve(req.params.id, approvalData, req.user.id);
    
    if (!approvedItem) {
      return res.status(404).json({
        success: false,
        error: 'Inventory item not found or already processed'
      });
    }

    res.json({
      success: true,
      data: approvedItem,
      message: 'Inventory item approved successfully'
    });
  } catch (error) {
    console.error('Error approving inventory item:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to approve inventory item'
    });
  }
});

// POST /inventory-items/:id/decline - Decline inventory item (Manager and Admin)
router.post('/:id/decline', auth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const { reason } = req.body;

    if (!reason || reason.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Decline reason is required'
      });
    }

    const declinedItem = await InventoryItem.decline(req.params.id, reason, req.user.id);
    
    if (!declinedItem) {
      return res.status(404).json({
        success: false,
        error: 'Inventory item not found or already processed'
      });
    }

    res.json({
      success: true,
      data: declinedItem,
      message: 'Inventory item declined successfully'
    });
  } catch (error) {
    console.error('Error declining inventory item:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to decline inventory item'
    });
  }
});

// GET /inventory-items/storage-assignments/pending - Get pending storage assignments (Manager and Admin)
router.get('/storage-assignments/pending', auth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const pendingAssignments = await InventoryItem.getPendingStorageAssignments();
    
    res.json({
      success: true,
      data: pendingAssignments,
      message: 'Pending storage assignments retrieved successfully'
    });
  } catch (error) {
    console.error('Error fetching pending storage assignments:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch pending storage assignments'
    });
  }
});

// POST /inventory-items/storage-assignments/:mappingId/approve - Approve storage assignment (Manager and Admin)
router.post('/storage-assignments/:mappingId/approve', auth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const approvedAssignment = await InventoryItem.approveStorageAssignment(req.params.mappingId, req.user.id);
    
    if (!approvedAssignment) {
      return res.status(404).json({
        success: false,
        error: 'Storage assignment not found or already processed'
      });
    }

    res.json({
      success: true,
      data: approvedAssignment,
      message: 'Storage assignment approved successfully'
    });
  } catch (error) {
    console.error('Error approving storage assignment:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to approve storage assignment'
    });
  }
});

// POST /inventory-items/storage-assignments/:mappingId/decline - Decline storage assignment (Manager and Admin)
router.post('/storage-assignments/:mappingId/decline', auth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const declinedAssignment = await InventoryItem.declineStorageAssignment(req.params.mappingId, req.user.id);
    
    if (!declinedAssignment) {
      return res.status(404).json({
        success: false,
        error: 'Storage assignment not found or already processed'
      });
    }

    res.json({
      success: true,
      data: declinedAssignment,
      message: 'Storage assignment declined successfully'
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to decline storage assignment'
    });
  }
});

// GET /inventory-items/uom/conversions - List unit of measure conversions
router.get('/uom/conversions', auth, async (req, res) => {
  try {
    const uomService = require('../services/uomService');
    const conversions = await uomService.listConversions(req.companyId);
    res.json({ success: true, conversions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// POST /inventory-items/:id/assign-to-bin - assign an item to a bin. The bin's
// storage location is resolved here so the mapping row stays complete; the
// mapping is created PENDING_APPROVAL so a manager can approve it.
router.post('/:id/assign-to-bin', auth, async (req, res) => {
  try {
    const { binId, status } = req.body;
    if (!binId) {
      return res.status(400).json({ success: false, error: 'binId is required' });
    }
    const { pool } = require('../config/database');
    const binRes = await pool.query(
      'SELECT id, storage_location_id FROM bins WHERE id = $1',
      [binId]
    );
    if (binRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Bin not found' });
    }
    const mapping = await InventoryItem.addStorageMapping(
      req.params.id,
      binRes.rows[0].storage_location_id,
      binId,
      0,
      req.user.id,
      status || 'PENDING_APPROVAL'
    );
    res.status(201).json({
      success: true,
      data: mapping,
      message: 'Assignment request submitted for approval'
    });
  } catch (error) {
    console.error('Error assigning item to bin:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to assign item to bin'
    });
  }
});

module.exports = router;

