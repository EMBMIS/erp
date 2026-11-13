const express = require('express');
const router = express.Router();
const InventoryTransfer = require('../models/InventoryTransfer');
const { auth } = require('../middleware/auth');

// GET /inventory-transfers - list transfers, optionally filtered by status
router.get('/', auth, async (req, res) => {
  try {
    const transfers = await InventoryTransfer.findAll({
      status: req.query.status,
      inventory_item_id: req.query.inventory_item_id,
    });
    res.json({ success: true, data: transfers });
  } catch (error) {
    console.error('List inventory transfers error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /inventory-transfers/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const transfer = await InventoryTransfer.findById(req.params.id);
    if (!transfer) return res.status(404).json({ success: false, error: 'Transfer not found' });
    res.json({ success: true, data: transfer });
  } catch (error) {
    console.error('Get inventory transfer error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /inventory-transfers - dispatch a transfer (removes stock from source now)
router.post('/', auth, async (req, res) => {
  try {
    const transfer = await InventoryTransfer.dispatch(req.body, req.user.id);
    res.status(201).json({ success: true, data: transfer });
  } catch (error) {
    console.error('Dispatch inventory transfer error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /inventory-transfers/:id/receive - confirm arrival at destination
router.post('/:id/receive', auth, async (req, res) => {
  try {
    const transfer = await InventoryTransfer.receive(req.params.id, req.user.id);
    res.json({ success: true, data: transfer });
  } catch (error) {
    console.error('Receive inventory transfer error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /inventory-transfers/:id/cancel - cancel while in transit (returns to source)
router.post('/:id/cancel', auth, async (req, res) => {
  try {
    const transfer = await InventoryTransfer.cancel(req.params.id, req.user.id);
    res.json({ success: true, data: transfer });
  } catch (error) {
    console.error('Cancel inventory transfer error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
