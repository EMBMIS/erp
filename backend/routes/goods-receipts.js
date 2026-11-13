const express = require('express');
const router = express.Router();
const GoodsReceiptService = require('../services/goodsReceiptService');
const { auth, requireRole } = require('../middleware/auth');

// GET /goods-receipts - list ALL receipts (GR history) with pagination + sort.
//
// Declared first on purpose: Express matches in declaration order, but this
// bare '/' route only matches the exact list path and can never shadow the
// deeper multi-segment routes below (/po/:poId, /summary, /storage-locations,
// /bins/:storageLocationId), each of which is matched by its own GET. Being
// first follows the file convention that the list route is the first GET.
//
// Response contract mirrors customer-invoices GET / (and items/fixed-assets
// GET /): { success, data: rows, total, limit, offset }.
router.get('/', auth, async (req, res) => {
  try {
    const { pool } = require('../config/database');
    const paginating = req.query.page !== undefined || req.query.limit !== undefined || req.query.offset !== undefined;

    // Cap the page size (same reasoning as customer-invoices GET /). Sane
    // defaults when pagination is requested: page=1, limit=50.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const offset = req.query.page !== undefined ? (page - 1) * limit : Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const conditions = [];
    const values = [];

    // Optional search: matches what a GR history screen would look for — PO
    // number, supplier, line item description, batch/lot, or notes.
    if (req.query.search) {
      conditions.push(`(
        po.po_number ILIKE $${values.length + 1} OR
        s.legal_name ILIKE $${values.length + 1} OR
        poli.item_description ILIKE $${values.length + 1} OR
        gr.batch_lot_number ILIKE $${values.length + 1} OR
        gr.notes ILIKE $${values.length + 1}
      )`);
      values.push(`%${req.query.search}%`);
    }
    const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';

    const select = `
      SELECT
        gr.id, gr.po_id, gr.po_line_item_id,
        gr.quantity_received, gr.condition_grade, gr.batch_lot_number,
        gr.serial_numbers, gr.expiry_date, gr.received_date,
        gr.storage_location_id, gr.bin_id, gr.notes, gr.created_at,
        po.po_number,
        s.legal_name AS supplier_name,
        poli.item_id, poli.item_description, poli.unit_of_measure, poli.unit_price,
        i.item_code, i.name AS item_name,
        u.first_name || ' ' || u.last_name AS received_by_name,
        sl.name AS storage_location_name,
        b.code AS bin_code
      FROM goods_receipts gr
      LEFT JOIN purchase_orders po ON gr.po_id = po.id
      LEFT JOIN suppliers s ON po.supplier_id = s.id
      LEFT JOIN purchase_order_line_items poli ON gr.po_line_item_id = poli.id
      LEFT JOIN items i ON poli.item_id = i.id
      LEFT JOIN users u ON gr.received_by = u.id
      LEFT JOIN storage_locations sl ON gr.storage_location_id = sl.id
      LEFT JOIN bins b ON gr.bin_id = b.id
    `;

    // Total BEFORE paging (all joins are LEFT, so COUNT(*) counts receipts).
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS n FROM goods_receipts gr
         LEFT JOIN purchase_orders po ON gr.po_id = po.id
         LEFT JOIN suppliers s ON po.supplier_id = s.id
         LEFT JOIN purchase_order_line_items poli ON gr.po_line_item_id = poli.id
         LEFT JOIN items i ON poli.item_id = i.id
         LEFT JOIN users u ON gr.received_by = u.id
         LEFT JOIN storage_locations sl ON gr.storage_location_id = sl.id
         LEFT JOIN bins b ON gr.bin_id = b.id` + where,
      values
    );

    // Sorting is whitelisted, never interpolated from the request.
    const SORTABLE = {
      received_date: 'gr.received_date',
      created_at: 'gr.created_at',
      po_number: 'po.po_number',
      quantity_received: 'gr.quantity_received',
      condition_grade: 'gr.condition_grade',
      supplier_name: 's.legal_name',
    };
    const sortColumn = SORTABLE[req.query.sort_by] || 'gr.received_date';
    const sortDirection = String(req.query.sort_dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    let orderBy = ` ORDER BY ${sortColumn} ${sortDirection} NULLS LAST, gr.id`;

    if (paginating) {
      orderBy += ` LIMIT $${values.length + 1}`;
      values.push(limit);
      orderBy += ` OFFSET $${values.length + 1}`;
      values.push(offset);
    }

    const result = await pool.query(select + where + orderBy, values);
    res.json({
      success: true,
      data: result.rows,
      total: countResult.rows[0].n,
      limit: paginating ? limit : countResult.rows[0].n,
      offset: paginating ? offset : 0,
    });
  } catch (error) {
    console.error('Error listing goods receipts:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch goods receipts'
    });
  }
});

// GET /goods-receipts/po/:poId - Get all receipts for a purchase order
router.get('/po/:poId', auth, async (req, res) => {
  try {
    const receipts = await GoodsReceiptService.getPOReceipts(req.params.poId);
    res.json({
      success: true,
      data: receipts
    });
  } catch (error) {
    console.error('Error fetching goods receipts:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch goods receipts'
    });
  }
});

// GET /goods-receipts/summary - Get receipts summary for dashboard
router.get('/summary', auth, async (req, res) => {
  try {
    const summary = await GoodsReceiptService.getReceiptsSummary(req.query);
    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    console.error('Error fetching receipts summary:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch receipts summary'
    });
  }
});

// POST /goods-receipts - Create a new goods receipt
router.post('/', auth, async (req, res) => {
  try {
    const {
      po_id,
      line_item_id,
      quantity_received,
      condition_grade,
      batch_lot_number,
      serial_numbers,
      expiry_date,
      received_date,
      storage_location_id,
      bin_id,
      notes
    } = req.body;

    // Validate required fields
    if (!po_id) {
      return res.status(400).json({
        success: false,
        error: 'Purchase order ID is required'
      });
    }

    if (!line_item_id) {
      return res.status(400).json({
        success: false,
        error: 'Purchase order line item ID is required'
      });
    }

    if (!quantity_received || parseFloat(quantity_received) <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Valid quantity received is required'
      });
    }

    const receiptData = {
      po_id,
      line_item_id,
      quantity_received: parseFloat(quantity_received),
      condition_grade: condition_grade || 'NEW',
      batch_lot_number,
      serial_numbers: serial_numbers || [],
      expiry_date,
      received_date,
      storage_location_id,
      bin_id,
      notes
    };

    const result = await GoodsReceiptService.receiveGoods(receiptData, req.user.id);
    
    res.status(201).json({
      success: true,
      data: result,
      message: 'Goods receipt processed successfully'
    });
  } catch (error) {
    console.error('Error processing goods receipt:', error);
    
    if (error.message.includes('Cannot receive') || error.message.includes('not found')) {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to process goods receipt'
    });
  }
});

// POST /goods-receipts/bulk - Process multiple receipts at once
router.post('/bulk', auth, async (req, res) => {
  try {
    const { receipts } = req.body;

    if (!receipts || !Array.isArray(receipts) || receipts.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Array of receipts is required'
      });
    }

    const results = [];
    const errors = [];

    for (let i = 0; i < receipts.length; i++) {
      try {
        const receipt = receipts[i];
        const receiptData = {
          ...receipt,
          quantity_received: parseFloat(receipt.quantity_received),
          condition_grade: receipt.condition_grade || 'NEW'
        };

        const result = await GoodsReceiptService.receiveGoods(receiptData, req.user.id);
        results.push({ index: i, success: true, data: result });
      } catch (error) {
        errors.push({ index: i, error: error.message });
      }
    }

    res.json({
      success: errors.length === 0,
      data: {
        processed: results.length,
        errors: errors.length,
        results: results,
        errors: errors
      },
      message: `Processed ${results.length} receipts successfully${errors.length > 0 ? `, ${errors.length} failed` : ''}`
    });
  } catch (error) {
    console.error('Error processing bulk goods receipts:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process bulk goods receipts'
    });
  }
});

// GET /goods-receipts/storage-locations - Get available storage locations
router.get('/storage-locations', auth, async (req, res) => {
  try {
    const { pool } = require('../config/database');
    const query = `
      SELECT sl.id, sl.name, sl.code, sl.address,
             COUNT(b.id) as bin_count
      FROM storage_locations sl
      LEFT JOIN bins b ON sl.id = b.storage_location_id AND b.status = 'APPROVED'
      WHERE sl.status = 'APPROVED'
      GROUP BY sl.id, sl.name, sl.code, sl.address
      ORDER BY sl.name
    `;
    
    const result = await pool.query(query);
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Error fetching storage locations:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch storage locations'
    });
  }
});

// GET /goods-receipts/bins/:storageLocationId - Get bins for a storage location
router.get('/bins/:storageLocationId', auth, async (req, res) => {
  try {
    const { pool } = require('../config/database');
    const query = `
      SELECT b.id, b.code, b.description,
             b.max_mass_capacity, b.max_volume_capacity,
             b.current_mass_used, b.current_volume_used,
             (b.max_mass_capacity - b.current_mass_used) as available_mass,
             (b.max_volume_capacity - b.current_volume_used) as available_volume
      FROM bins b
      WHERE b.storage_location_id = $1 AND b.status = 'APPROVED'
      ORDER BY b.code
    `;
    
    const result = await pool.query(query, [req.params.storageLocationId]);
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Error fetching bins:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch bins'
    });
  }
});

module.exports = router;