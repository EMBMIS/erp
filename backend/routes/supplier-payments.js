const express = require('express');
const router = express.Router();
const SupplierPayment = require('../models/SupplierPayment');
const { auth, requireManagerOrAdmin } = require('../middleware/auth');

// GET /supplier-payments - list payments made to suppliers
router.get('/', auth, async (req, res) => {
  try {
    const payments = await SupplierPayment.findAll({
      search: req.query.search,
      status: req.query.status,
      supplier_id: req.query.supplier_id,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
    });
    res.json({ success: true, data: payments });
  } catch (error) {
    console.error('List supplier payments error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /supplier-payments/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const payment = await SupplierPayment.findById(req.params.id);
    if (!payment) return res.status(404).json({ success: false, error: 'Payment not found' });
    res.json({ success: true, data: payment });
  } catch (error) {
    console.error('Get supplier payment error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /supplier-payments - record a payment and allocate to bills
router.post('/', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const { allocations = [], ...paymentData } = req.body;
    const payment = await SupplierPayment.create(paymentData, allocations, req.user.id);
    res.status(201).json({ success: true, data: payment });
  } catch (error) {
    console.error('Record supplier payment error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
