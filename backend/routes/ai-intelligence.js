/**
 * AI intelligence endpoints: forecasting, anomaly detection, duplicate
 * detection, GL-coding suggestions, invoice matching and natural-language
 * reporting.
 *
 * Everything here is read-only or advisory — no endpoint posts, merges or
 * reconciles anything. Suggestions flow back through the normal approval path.
 * Financial detail is gated to finance/manager roles rather than any
 * authenticated user, matching the rest of the money endpoints.
 */

const express = require('express');
const router = express.Router();
const { auth, requireManagerOrAdmin } = require('../middleware/auth');

const forecasting = require('../services/ai/forecasting');
const duplicates = require('../services/ai/duplicateDetection');
const journalSuggestions = require('../services/ai/journalSuggestions');
const invoiceMatching = require('../services/ai/invoiceMatching');
const nlQuery = require('../services/ai/nlQuery');
const auditAnalysis = require('../services/ai/auditAnalysis');
const demandForecast = require('../services/ai/demandForecast');

// Keep handlers flat: one wrapper instead of a try/catch in every route.
const handle = (fn) => async (req, res) => {
  try {
    const result = await fn(req, res);
    if (!res.headersSent) res.json({ success: true, ...result });
  } catch (error) {
    console.error(`AI intelligence error (${req.method} ${req.path}):`, error.message);
    if (!res.headersSent) res.status(500).json({ success: false, error: error.message });
  }
};

const intOr = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

// ---------------------------------------------------------------------------
// Forecasting & anomalies
// ---------------------------------------------------------------------------

// GET /ai-intelligence/forecast/profit-and-loss?horizon=3&months=24
router.get('/forecast/profit-and-loss', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await forecasting.forecastProfitAndLoss({
    horizon: Math.min(intOr(req.query.horizon, 3), 12),
    months: Math.min(intOr(req.query.months, 24), 60),
  }),
})));

// GET /ai-intelligence/forecast/cash-flow?horizon_days=90
router.get('/forecast/cash-flow', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await forecasting.forecastCashFlow({
    horizonDays: Math.min(intOr(req.query.horizon_days, 90), 365),
  }),
})));

// GET /ai-intelligence/anomalies?months=12&threshold=4
router.get('/anomalies', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await forecasting.detectAmountAnomalies({
    months: Math.min(intOr(req.query.months, 12), 60),
    threshold: Number(req.query.threshold) || 4,
    limit: Math.min(intOr(req.query.limit, 25), 100),
  }),
})));

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

// GET /ai-intelligence/duplicates — everything at once
router.get('/duplicates', auth, handle(async () => ({ data: await duplicates.scanAll() })));

router.get('/duplicates/suppliers', auth, handle(async () => ({
  data: await duplicates.findDuplicateSuppliers(),
})));

router.get('/duplicates/customers', auth, handle(async () => ({
  data: await duplicates.findDuplicateCustomers(),
})));

router.get('/duplicates/supplier-invoices', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await duplicates.findDuplicateSupplierInvoices({
    dayWindow: Math.min(intOr(req.query.day_window, 45), 365),
  }),
})));

// ---------------------------------------------------------------------------
// GL coding suggestions
// ---------------------------------------------------------------------------

// POST /ai-intelligence/suggest-accounts { description, supplier_id, amount }
router.post('/suggest-accounts', auth, handle(async (req) => ({
  data: await journalSuggestions.suggestAccounts({
    description: req.body.description,
    supplier_id: req.body.supplier_id,
    amount: req.body.amount,
    allow_llm: req.body.allow_llm !== false,
  }),
})));

// POST /ai-intelligence/suggest-journal-entry { description, amount, supplier_id }
// Returns a DRAFT proposal only — it does not create the entry.
router.post('/suggest-journal-entry', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await journalSuggestions.suggestJournalEntry({
    description: req.body.description,
    amount: req.body.amount,
    supplier_id: req.body.supplier_id,
    entry_date: req.body.entry_date,
    counterpart_account_code: req.body.counterpart_account_code,
  }),
})));

// POST /ai-intelligence/categorize-expense { description, supplier_id, amount }
router.post('/categorize-expense', auth, handle(async (req) => ({
  data: await journalSuggestions.categorizeExpense({
    description: req.body.description,
    supplier_id: req.body.supplier_id,
    amount: req.body.amount,
  }),
})));

// ---------------------------------------------------------------------------
// Invoice matching
// ---------------------------------------------------------------------------

// GET /ai-intelligence/match/supplier-invoice/:id — full 3-way match
router.get('/match/supplier-invoice/:id', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await invoiceMatching.threeWayMatch(req.params.id),
})));

// GET /ai-intelligence/match/supplier-invoice/:id/purchase-orders
router.get('/match/supplier-invoice/:id/purchase-orders', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await invoiceMatching.suggestPurchaseOrdersForInvoice(req.params.id),
})));

// GET /ai-intelligence/match/exceptions — the AP clerk's worklist
router.get('/match/exceptions', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await invoiceMatching.matchExceptionReport({
    limit: Math.min(intOr(req.query.limit, 50), 200),
  }),
})));

// GET /ai-intelligence/match/bank?bank_account_id=...
router.get('/match/bank', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await invoiceMatching.suggestBankMatches({
    bankAccountId: req.query.bank_account_id,
    limit: Math.min(intOr(req.query.limit, 25), 100),
  }),
})));

// ---------------------------------------------------------------------------
// Natural-language reporting
// ---------------------------------------------------------------------------

// POST /ai-intelligence/ask { question, explain }
// Generated SQL is validated against an allowlist and run read-only.
router.post('/ask', auth, requireManagerOrAdmin, handle(async (req, res) => {
  const result = await nlQuery.ask(req.body.question, { explain: req.body.explain !== false });
  if (!result.answered) {
    res.status(result.ai_unavailable ? 503 : 400).json({ success: false, ...result });
    return {};
  }
  return { data: result };
}));

// GET /ai-intelligence/ask/schema — what the NL interface is allowed to see
router.get('/ask/schema', auth, requireManagerOrAdmin, handle(async () => ({
  allowed_tables: [...nlQuery.ALLOWED_TABLES],
  max_rows: nlQuery.MAX_ROWS,
})));

// ---------------------------------------------------------------------------
// Audit-trail analysis
//
// Manager/admin only: this surfaces control indicators attached to named
// individuals, which is not information for general staff.
// ---------------------------------------------------------------------------

// GET /ai-intelligence/audit-analysis?months=12
router.get('/audit-analysis', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await auditAnalysis.analyzeAuditTrail({
    months: Math.min(intOr(req.query.months, 12), 60),
  }),
})));

// GET /ai-intelligence/audit-analysis/segregation-of-duties
router.get('/audit-analysis/segregation-of-duties', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await auditAnalysis.checkSegregationOfDuties({
    months: Math.min(intOr(req.query.months, 12), 60),
  }),
})));

// GET /ai-intelligence/audit-analysis/benford
router.get('/audit-analysis/benford', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await auditAnalysis.checkBenfordsLaw({
    months: Math.min(intOr(req.query.months, 24), 60),
  }),
})));

// ---------------------------------------------------------------------------
// Predictive inventory
// ---------------------------------------------------------------------------

// GET /ai-intelligence/inventory/predictions?months=6&horizon_days=90
router.get('/inventory/predictions', auth, handle(async (req) => ({
  data: await demandForecast.predictReorders({
    months: Math.min(intOr(req.query.months, 6), 36),
    horizonDays: Math.min(intOr(req.query.horizon_days, 90), 365),
  }),
})));

// GET /ai-intelligence/inventory/reorder-point-recommendations
router.get('/inventory/reorder-point-recommendations', auth, handle(async (req) => ({
  data: await demandForecast.reorderPointRecommendations({
    months: Math.min(intOr(req.query.months, 6), 36),
  }),
})));

// ---------------------------------------------------------------------------
// GET /ai-intelligence/approval-brief/:type/:id
// AI-generated context summary for approval decisions.
// ---------------------------------------------------------------------------
router.get('/approval-brief/:type/:id', auth, handle(async (req) => {
  const { briefForDocument } = require('../services/ai/approvalBriefs');
  const { summary, alerts, context } = await briefForDocument(req.params.type, req.params.id);
  return { data: { summary, alerts, context } };
}));

module.exports = router;
