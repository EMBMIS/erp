const express = require('express');
const router = express.Router();
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const { auth, requireManagerOrAdmin } = require('../middleware/auth');

// ---- Bank accounts ---------------------------------------------------------

// GET /bank/accounts
router.get('/accounts', auth, async (req, res) => {
  try {
    const accounts = await BankAccount.findAll();
    res.json({ success: true, data: accounts });
  } catch (error) {
    console.error('List bank accounts error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /bank/accounts
router.post('/accounts', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    if (!req.body.account_name) return res.status(400).json({ success: false, error: 'account_name is required' });
    const account = await BankAccount.create(req.body, req.user.id);
    res.status(201).json({ success: true, data: account });
  } catch (error) {
    console.error('Create bank account error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// GET /bank/accounts/:id/summary - reconciliation summary
router.get('/accounts/:id/summary', auth, async (req, res) => {
  try {
    const summary = await BankAccount.getReconciliationSummary(req.params.id);
    if (!summary) return res.status(404).json({ success: false, error: 'Bank account not found' });
    res.json({ success: true, data: summary });
  } catch (error) {
    console.error('Bank reconciliation summary error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---- Statement lines -------------------------------------------------------

// GET /bank/accounts/:id/transactions
router.get('/accounts/:id/transactions', auth, async (req, res) => {
  try {
    const txns = await BankTransaction.findAll(req.params.id, { reconciled: req.query.reconciled });
    res.json({ success: true, data: txns });
  } catch (error) {
    console.error('List bank transactions error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /bank/accounts/:id/transactions - add a line (or bulk via { lines: [...] })
router.post('/accounts/:id/transactions', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    if (Array.isArray(req.body.lines)) {
      const count = await BankTransaction.createMany(req.params.id, req.body.lines, req.user.id);
      return res.status(201).json({ success: true, data: { inserted: count } });
    }
    if (req.body.amount == null) return res.status(400).json({ success: false, error: 'amount is required' });
    const txn = await BankTransaction.create({ ...req.body, bank_account_id: req.params.id }, req.user.id);
    res.status(201).json({ success: true, data: txn });
  } catch (error) {
    console.error('Create bank transaction error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /bank/accounts/:id/import-statement - parse a CSV bank statement export
// and load it as unreconciled transaction lines. Body: { csv_text }.
router.post('/accounts/:id/import-statement', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    if (!req.body.csv_text) return res.status(400).json({ success: false, error: 'csv_text is required' });
    const { importStatement } = require('../services/bankStatementImport');
    const result = await importStatement(req.params.id, req.body.csv_text, req.user.id);
    res.status(201).json({ success: true, ...result });
  } catch (error) {
    console.error('Bank statement import error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /bank/accounts/:id/auto-reconcile - auto-match unreconciled lines against
// customer/supplier payments; ambiguous or unmatched lines are left for review.
router.post('/accounts/:id/auto-reconcile', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const result = await BankTransaction.autoReconcile(req.params.id, req.user.id);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Bank auto-reconcile error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /bank/transactions/:id/reconcile
router.patch('/transactions/:id/reconcile', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const reconciled = req.body.reconciled !== false;
    const txn = await BankTransaction.setReconciled(req.params.id, reconciled, req.user.id, {
      matched_type: req.body.matched_type,
      matched_id: req.body.matched_id,
    });
    res.json({ success: true, data: txn });
  } catch (error) {
    console.error('Reconcile bank transaction error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// GET /bank/transactions/:id/suggestions - suggested book matches
router.get('/transactions/:id/suggestions', auth, async (req, res) => {
  try {
    const suggestions = await BankTransaction.suggestMatches(req.params.id);
    res.json({ success: true, data: suggestions });
  } catch (error) {
    console.error('Bank match suggestions error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
