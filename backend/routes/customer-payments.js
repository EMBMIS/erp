const express = require('express');
const router = express.Router();
const CustomerPayment = require('../models/CustomerPayment');
const { auth, requireManagerOrAdmin } = require('../middleware/auth');

// GET /customer-payments - list payments
router.get('/', auth, async (req, res) => {
  try {
    const payments = await CustomerPayment.findAll({
      search: req.query.search,
      status: req.query.status,
      customer_id: req.query.customer_id,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
    });
    res.json({ success: true, data: payments });
  } catch (error) {
    console.error('List customer payments error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /customer-payments/:id - single payment with allocations
router.get('/:id', auth, async (req, res) => {
  try {
    const payment = await CustomerPayment.findById(req.params.id);
    if (!payment) return res.status(404).json({ success: false, error: 'Payment not found' });
    res.json({ success: true, data: payment });
  } catch (error) {
    console.error('Get customer payment error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /customer-payments - record a payment and allocate to invoices
router.post('/', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const { allocations = [], ...paymentData } = req.body;
    const payment = await CustomerPayment.create(paymentData, allocations, req.user.id);
    res.status(201).json({ success: true, data: payment });
  } catch (error) {
    console.error('Record customer payment error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
