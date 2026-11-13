const express = require('express');
const router = express.Router();
const FixedAsset = require('../models/FixedAsset');
const { auth, requireManagerOrAdmin, requireFinanceManager } = require('../middleware/auth');

// GET /fixed-assets - list assets with filters, server-side pagination + sort.
//
// Response contract mirrors customer-invoices GET / (and items GET /) so the
// frontend useListControls hook works unchanged: { success, data: rows, total,
// limit, offset }. Callers that pass no page/limit/offset still get every
// matching row (the original fetch-all contract) with total/limit/offset
// filled in, so the shape only ever grows.
router.get('/', auth, async (req, res) => {
  try {
    const paginating = req.query.page !== undefined || req.query.limit !== undefined || req.query.offset !== undefined;

    // Cap the page size (same reasoning as customer-invoices GET /): without an
    // upper bound ?limit=100000 is a denial of service typed into the address
    // bar, and the default must be finite too — but only when pagination is
    // actually requested. Sane defaults: page=1, limit=50, offset=0.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const offset = req.query.page !== undefined ? (page - 1) * limit : Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { rows, total } = await FixedAsset.findAll({
      search: req.query.search,
      status: req.query.status,
      category: req.query.category,
      sort_by: req.query.sort_by,
      sort_dir: req.query.sort_dir,
      limit: paginating ? limit : undefined,
      offset: paginating ? offset : undefined,
    });
    res.json({
      success: true,
      data: rows,
      total,
      limit: paginating ? limit : total,
      offset: paginating ? offset : 0,
    });
  } catch (error) {
    console.error('List fixed assets error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /fixed-assets/stats
router.get('/stats', auth, async (req, res) => {
  try {
    const stats = await FixedAsset.getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('Fixed asset stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /fixed-assets/run-depreciation - depreciate all active assets one period
router.post('/run-depreciation', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const { period_date, months } = req.body || {};
    const result = await FixedAsset.runDepreciationAll(req.user.id, period_date || null, months || 1);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Run depreciation (all) error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// GET /fixed-assets/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const asset = await FixedAsset.findById(req.params.id);
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    res.json({ success: true, data: asset });
  } catch (error) {
    console.error('Get fixed asset error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /fixed-assets - register a new asset
router.post('/', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    if (!req.body.name || req.body.acquisition_cost == null) {
      return res.status(400).json({ success: false, error: 'name and acquisition_cost are required' });
    }
    const asset = await FixedAsset.create(req.body, req.user.id);
    res.status(201).json({ success: true, data: asset });
  } catch (error) {
    console.error('Create fixed asset error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// GET /fixed-assets/:id/schedule - projected remaining depreciation, posts nothing
router.get('/:id/schedule', auth, async (req, res) => {
  try {
    const data = await FixedAsset.schedule(req.params.id, {
      maxPeriods: req.query.periods ? Math.min(parseInt(req.query.periods, 10) || 600, 600) : 600,
    });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Asset schedule error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /fixed-assets/:id/depreciate - depreciate a single asset one period
router.post('/:id/depreciate', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const { period_date, months } = req.body || {};
    const result = await FixedAsset.runDepreciation(req.params.id, req.user.id, period_date || null, months || 1);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Depreciate asset error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// PATCH /fixed-assets/:id/dispose
router.patch('/:id/dispose', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const asset = await FixedAsset.dispose(req.params.id, req.user.id, req.body?.reason || '', req.body?.proceeds || 0, req.body?.cash_account_code || '1110');
    res.json({ success: true, data: asset });
  } catch (error) {
    console.error('Dispose asset error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /fixed-assets/:id/revalue
//
// Finance-manager authority rather than general manager: a revaluation moves
// the balance sheet by an amount somebody chose, with no invoice or receipt
// behind it, and an upward one credits equity directly.
router.post('/:id/revalue', auth, requireFinanceManager, async (req, res) => {
  try {
    const result = await FixedAsset.revalue(req.params.id, {
      revalued_amount: req.body?.revalued_amount,
      revaluation_date: req.body?.revaluation_date,
      basis: req.body?.basis,
    }, req.user.id);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Revalue asset error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// GET /fixed-assets/:id/revaluations
router.get('/:id/revaluations', auth, async (req, res) => {
  try {
    res.json({ success: true, data: await FixedAsset.revaluationHistory(req.params.id) });
  } catch (error) {
    console.error('Revaluation history error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
