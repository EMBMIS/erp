const express = require('express');
const router = express.Router();
const Currency = require('../models/Currency');
const { auth, requireManagerOrAdmin } = require('../middleware/auth');

// GET /currencies
router.get('/', auth, async (req, res) => {
  try {
    const currencies = await Currency.listCurrencies();
    const base = await Currency.getBaseCurrency();
    res.json({ success: true, data: currencies, base });
  } catch (error) {
    console.error('List currencies error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /currencies
router.post('/', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    if (!req.body.code || !req.body.name) return res.status(400).json({ success: false, error: 'code and name are required' });
    const currency = await Currency.addCurrency(req.body);
    res.status(201).json({ success: true, data: currency });
  } catch (error) {
    console.error('Add currency error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// GET /currencies/rates
router.get('/rates', auth, async (req, res) => {
  try {
    const rates = await Currency.listRates({
      from: req.query.from,
      to: req.query.to,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 100,
    });
    res.json({ success: true, data: rates });
  } catch (error) {
    console.error('List rates error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /currencies/rates
router.post('/rates', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    if (!req.body.from_currency || !req.body.to_currency || req.body.rate == null) {
      return res.status(400).json({ success: false, error: 'from_currency, to_currency and rate are required' });
    }
    const rate = await Currency.addRate(req.body, req.user.id);
    res.status(201).json({ success: true, data: rate });
  } catch (error) {
    console.error('Add rate error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /currencies/sync-rates - Daily Central Bank FX Rate Auto-Sync
router.post('/sync-rates', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const FXRateService = require('../services/fxRateService');
    const result = await FXRateService.syncCentralBankRates(req.body?.base_currency || 'USD', req.user.id);
    res.json({ success: true, message: 'Central bank exchange rates synced successfully', data: result });
  } catch (error) {
    console.error('FX rate sync error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /currencies/revalue - Period-end FX revaluation of open AR/AP to base
// currency. Posts an unrealized-gain/loss journal entry (or reports no-op
// when there is nothing to revalue) tagged FX-REVAL-<date> — the reference
// periodCloseService's own pre-close check looks for.
router.post('/revalue', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const FXRevaluationService = require('../services/fxRevaluationService');
    const result = await FXRevaluationService.revalueOpenBalances(
      req.body?.company_id || null,
      req.user.id,
      req.body?.as_of_date || null
    );
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('FX revaluation error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// GET /currencies/convert?amount=&from=&to=&date=
router.get('/convert', auth, async (req, res) => {
  try {
    const { amount, from, to, date } = req.query;
    if (amount == null || !from || !to) {
      return res.status(400).json({ success: false, error: 'amount, from and to are required' });
    }
    const result = await Currency.convert(Number(amount), from, to, date || null);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Convert error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
