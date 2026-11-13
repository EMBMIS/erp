const express = require('express');
const router = express.Router();
const CostCenter = require('../models/CostCenter');
const { auth, requireManagerOrAdmin } = require('../middleware/auth');

router.get('/', auth, async (req, res) => {
  try {
    const centers = await CostCenter.findAll({ status: req.query.status });
    res.json({ success: true, data: centers });
  } catch (error) {
    console.error('List cost centers error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const center = await CostCenter.findById(req.params.id);
    if (!center) return res.status(404).json({ success: false, error: 'Cost center not found' });
    res.json({ success: true, data: center });
  } catch (error) {
    console.error('Get cost center error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    if (!req.body.name) return res.status(400).json({ success: false, error: 'name is required' });
    const center = await CostCenter.create(req.body, req.user.id);
    res.status(201).json({ success: true, data: center });
  } catch (error) {
    console.error('Create cost center error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

router.put('/:id', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const center = await CostCenter.update(req.params.id, req.body, req.user.id);
    res.json({ success: true, data: center });
  } catch (error) {
    console.error('Update cost center error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
