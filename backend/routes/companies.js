/**
 * Companies, company switching and intercompany transactions.
 *
 * Creating companies and posting between them is admin/finance territory:
 * an intercompany entry writes into two entities' ledgers at once, which is
 * more authority than any ordinary document in this system carries. Listing
 * the companies you may act for is open to any authenticated user, because the
 * company switcher needs it on every page load.
 */

const express = require('express');
const router = express.Router();
const { auth, requireAdmin, requireFinanceManager } = require('../middleware/auth');
const { Companies, Intercompany } = require('../models/Company');
const companyContext = require('../services/companyContext');

const handle = (fn) => async (req, res) => {
  try {
    const result = await fn(req, res);
    if (!res.headersSent) res.json({ success: true, ...result });
  } catch (error) {
    console.error(`Companies error (${req.method} ${req.path}):`, error.message);
    if (!res.headersSent) res.status(400).json({ success: false, error: error.message });
  }
};

// --- Companies --------------------------------------------------------------

// What the company switcher reads: only companies this user may act for.
router.get('/mine', auth, handle(async (req) => ({
  data: await companyContext.listCompaniesFor(req.user.id),
  current: req.companyId || null,
})));

router.get('/', auth, handle(async (req) => ({
  data: await Companies.findAll({ include_inactive: req.query.include_inactive === 'true' }),
})));

/**
 * Whether company isolation is genuinely in force.
 *
 * Admin-only and deliberately blunt: it reports what the database says about
 * the *running connection*, not what configuration intends. Those two came
 * apart once already — policies were active while a superuser connection saw
 * every company — and this is the endpoint that would have caught it.
 */
router.get('/isolation-status', auth, requireAdmin, handle(async () => ({
  data: await Companies.isolationStatus(),
})));

router.get('/:id', auth, handle(async (req) => {
  const company = await Companies.findById(req.params.id);
  if (!company) throw new Error('Company not found.');
  return { data: company };
}));

// Creating a company must also give it the finance master data every posting
// needs — the standard chart of accounts, cost centers and open accounting
// periods — or the new entity's first GL posting fails with "Required accounts
// not found" (the same empty-COA-at-signup bug the self-service register-company
// path fixes in routes/auth.js). The seed is idempotent (ON CONFLICT DO
// NOTHING) and scoped to the new company (RLS).
router.post('/', auth, requireAdmin, handle(async (req) => {
  const company = await Companies.create(req.body, req.user.id);
  const ChartOfAccounts = require('../models/ChartOfAccounts');
  const companyScope = require('../services/companyScope');
  await companyScope.runWithCompany(company.id, () =>
    ChartOfAccounts.seedFinanceMasterData(company.id, req.user.id));
  // Every company gets a mailbox (company-code@embmis.com) the moment it
  // exists — same "provisioning step right after creation" shape as the
  // chart-of-accounts seed above. mailboxes is not RLS-scoped (see migration
  // 202608280901), so this doesn't need runWithCompany.
  const mailboxService = require('../services/mailboxService');
  await mailboxService.createCompanyMailbox(company, req.user.id).catch((err) => {
    console.error(`Failed to provision mailbox for company ${company.id}:`, err.message);
  });
  return { data: company };
}));

router.put('/:id', auth, requireAdmin, handle(async (req) => ({
  data: await Companies.update(req.params.id, req.body),
})));

// --- User assignment --------------------------------------------------------

router.post('/:id/users', auth, requireAdmin, handle(async (req) => ({
  data: await Companies.assignUser(req.body.user_id, req.params.id, {
    role: req.body.role,
    is_primary: req.body.is_primary,
  }),
})));

router.delete('/:id/users/:userId', auth, requireAdmin, handle(async (req) => ({
  data: await Companies.removeUser(req.params.userId, req.params.id),
})));

// --- Intercompany -----------------------------------------------------------

router.get('/intercompany/transactions', auth, handle(async (req) => ({
  data: await Intercompany.findAll({
    company_id: req.query.company_id,
    status: req.query.status,
    from_date: req.query.from_date,
    to_date: req.query.to_date,
    limit: req.query.limit,
  }),
})));

// Posts into two companies' ledgers in one transaction.
router.post('/intercompany/transactions', auth, requireFinanceManager, handle(async (req) => ({
  data: await Intercompany.post(req.body, req.user.id),
})));

router.get('/intercompany/reconciliation', auth, handle(async (req) => ({
  data: await Intercompany.reconciliation({ as_of: req.query.as_of }),
})));

router.post('/intercompany/eliminate', auth, requireFinanceManager, handle(async (req) => ({
  data: await Intercompany.markEliminated(req.body.ids, req.body.period, req.user.id),
})));

module.exports = router;
