const express = require('express');
const router = express.Router();
const Budget = require('../models/Budget');
const { auth, requireManagerOrAdmin } = require('../middleware/auth');

router.get('/', auth, async (req, res) => {
  try {
    const budgets = await Budget.findAll();
    res.json({ success: true, data: budgets });
  } catch (error) {
    console.error('List budgets error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const budget = await Budget.findById(req.params.id);
    if (!budget) return res.status(404).json({ success: false, error: 'Budget not found' });
    res.json({ success: true, data: budget });
  } catch (error) {
    console.error('Get budget error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /budgets/:id/vs-actual - budget vs actual report
router.get('/:id/vs-actual', auth, async (req, res) => {
  try {
    const report = await Budget.getBudgetVsActual(req.params.id);
    if (!report) return res.status(404).json({ success: false, error: 'Budget not found' });
    res.json({ success: true, data: report });
  } catch (error) {
    console.error('Budget vs actual error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const { lines = [], ...data } = req.body;
    if (!data.name || !data.fiscal_year) {
      return res.status(400).json({ success: false, error: 'name and fiscal_year are required' });
    }
    const budget = await Budget.create(data, lines, req.user.id);
    res.status(201).json({ success: true, data: budget });
  } catch (error) {
    console.error('Create budget error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /budgets/:id/lines - add a line to an existing budget
router.post('/:id/lines', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const line = await Budget.addLine(req.params.id, req.body, req.user.id);
    res.status(201).json({ success: true, data: line });
  } catch (error) {
    console.error('Add budget line error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
