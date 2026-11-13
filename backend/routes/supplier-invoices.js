const express = require('express');
const router = express.Router();
const SupplierInvoice = require('../models/SupplierInvoice');
const { buildPaymentRun } = require('../services/paymentRunOptimizer');
const { auth, requireManagerOrAdmin } = require('../middleware/auth');

// GET /supplier-invoices - list vendor bills (Accounts Payable)
router.get('/', auth, async (req, res) => {
  try {
    // Server-side paging + sorting, same envelope as /customer-invoices so the
    // shared useListControls front-end hook works unchanged. Page size is
    // capped: `?limit=100000` is a denial of service anyone can type into the
    // address bar, and the default has to be finite too — an AP ledger with
    // thousands of open bills should not be serialized in full because a caller
    // omitted a parameter.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    // The front-end hook sends ?offset=; REST-style ?page=1..N is accepted too.
    // offset wins when both are present.
    const offset = req.query.offset !== undefined
      ? Math.max(parseInt(req.query.offset, 10) || 0, 0)
      : Math.max((parseInt(req.query.page, 10) || 1) - 1, 0) * limit;

    const { rows, total } = await SupplierInvoice.findAll({
      search: req.query.search,
      status: req.query.status,
      supplier_id: req.query.supplier_id,
      overdue_only: req.query.overdue_only === 'true',
      sort_by: req.query.sort_by,
      sort_dir: req.query.sort_dir,
      limit,
      offset,
    });
    res.json({ success: true, data: rows, total, limit, offset });
  } catch (error) {
    console.error('List supplier invoices error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /supplier-invoices/stats - AP summary
router.get('/stats', auth, async (req, res) => {
  try {
    const stats = await SupplierInvoice.getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('Supplier invoice stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /supplier-invoices/payment-run — which open bills to pay now, within a
// cash budget, capturing early-payment discounts that beat the hurdle rate.
// ?cash=25000 (omit for unlimited) &hurdle=10 (% a year) &horizon=7 (days)
router.get('/payment-run', auth, async (req, res) => {
  try {
    const cash = req.query.cash === undefined || req.query.cash === '' ? null : Number(req.query.cash);
    const hurdle = req.query.hurdle === undefined || req.query.hurdle === '' ? 10 : Number(req.query.hurdle);
    const horizon = req.query.horizon === undefined || req.query.horizon === '' ? 7 : parseInt(req.query.horizon, 10);
    if ((cash !== null && (!Number.isFinite(cash) || cash < 0)) || !Number.isFinite(hurdle) || hurdle < 0
        || !Number.isFinite(horizon) || horizon < 0 || horizon > 365) {
      return res.status(400).json({ success: false, error: 'cash must be >= 0, hurdle >= 0, horizon 0-365' });
    }
    const run = await buildPaymentRun({ cashAvailable: cash, hurdleRate: hurdle, horizonDays: horizon });
    res.json({ success: true, data: run });
  } catch (error) {
    console.error('Payment run error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// An invoice arrives twice (services/billedTwice.js): the same supplier's
// other bills, the order, what was received, what was paid — and the hold a
// person places so the second copy is not paid.
const billedTwice = require('../services/billedTwice');
const who = (req) => ({ companyId: req.companyId, userId: req.user?.isApiKey ? null : req.user?.id, role: req.user?.role });
const send = (res, data) => {
  if (data?.error) return res.status(data.status || 400).json({ success: false, error: data.error });
  return res.json({ success: true, data });
};

// GET /supplier-invoices/billed-twice — every open bill that looks like a
// second copy or bills beyond what was received, plus every bill on hold.
router.get('/billed-twice', auth, async (req, res) => {
  try {
    send(res, await billedTwice.scanBills({ ...who(req), limit: req.query.limit }));
  } catch (error) {
    console.error('Billed-twice scan error:', error.message);
    res.status(500).json({ success: false, error: 'Could not check bills for duplicates.' });
  }
});

// GET /supplier-invoices/:id/billed-twice — one bill, checked. Read-only.
router.get('/:id/billed-twice', auth, async (req, res) => {
  try {
    send(res, await billedTwice.checkBill({ ...who(req), bill: req.params.id }));
  } catch (error) {
    console.error('Billed-twice check error:', error.message);
    res.status(500).json({ success: false, error: 'Could not check this bill.' });
  }
});

// POST /supplier-invoices/:id/payment-hold { reason } — a finance manager,
// manager or admin stops payment on the bill. DELETE releases it.
router.post('/:id/payment-hold', auth, async (req, res) => {
  try {
    send(res, await billedTwice.holdPayment({ ...who(req), bill: req.params.id, reason: req.body?.reason }));
  } catch (error) {
    console.error('Payment hold error:', error.message);
    res.status(500).json({ success: false, error: 'Could not hold the payment.' });
  }
});

router.delete('/:id/payment-hold', auth, async (req, res) => {
  try {
    send(res, await billedTwice.releaseHold({ ...who(req), bill: req.params.id }));
  } catch (error) {
    console.error('Release payment hold error:', error.message);
    res.status(500).json({ success: false, error: 'Could not release the hold.' });
  }
});

// GET /supplier-invoices/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const bill = await SupplierInvoice.findById(req.params.id);
    if (!bill) return res.status(404).json({ success: false, error: 'Bill not found' });
    res.json({ success: true, data: bill });
  } catch (error) {
    console.error('Get supplier invoice error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /supplier-invoices — create a draft bill directly
router.post('/', auth, async (req, res) => {
  try {
    const bill = await SupplierInvoice.create(req.body, req.user.id);
    res.status(201).json({ success: true, data: bill });
  } catch (error) {
    console.error('Create bill error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /supplier-invoices/from-purchase-order/:purchaseOrderId
router.post('/from-purchase-order/:purchaseOrderId', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const bill = await SupplierInvoice.createFromPurchaseOrder(req.params.purchaseOrderId, req.body || {}, req.user.id);
    res.status(201).json({ success: true, data: bill });
  } catch (error) {
    console.error('Create bill from purchase order error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// PATCH /supplier-invoices/:id/status
router.patch('/:id/status', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const { status, reason } = req.body;
    const valid = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PAID', 'PARTIALLY_PAID', 'OVERDUE', 'CANCELLED'];
    if (!valid.includes(status)) return res.status(400).json({ success: false, error: 'Invalid status' });
    const bill = await SupplierInvoice.updateStatus(req.params.id, status, req.user.id, reason || '');
    res.json({ success: true, data: bill });
  } catch (error) {
    console.error('Update bill status error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
