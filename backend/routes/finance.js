const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { auth, requireFinanceUser, requireManagerOrAdmin } = require('../middleware/auth');

const JournalEntry = require('../models/JournalEntry');
const ChartOfAccounts = require('../models/ChartOfAccounts');
const RevenueRecognitionService = require('../services/revenueRecognitionService');
const LandedCostService = require('../services/landedCostService');

/**
 * Every route in this file requires authentication and finance user authorization.
 */
router.use(auth, requireFinanceUser);

// Revenue Recognition Schedule Creation
router.post('/revenue-recognition/schedules', async (req, res) => {
  try {
    const schedules = await RevenueRecognitionService.createSchedule(req.body, req.companyId);
    res.json({ success: true, schedules });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Process Due Revenue Recognition
router.post('/revenue-recognition/process', async (req, res) => {
  try {
    const result = await RevenueRecognitionService.recognizeDueRevenue(req.body?.asOfDate, req.user?.id, req.companyId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Landed Cost Allocation
router.post('/landed-costs/allocate', async (req, res) => {
  try {
    const result = await LandedCostService.allocateAndPost(req.body, req.user?.id, req.companyId);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Financial Dashboard Data
router.get('/dashboard', async (req, res) => {
  try {
    const [
      balanceSheetData,
      incomeStatementData,
      kpiData,
      recentTransactions,
      accountTrends
    ] = await Promise.all([
      getBalanceSheetData(),
      getIncomeStatementData(), 
      getKPIData(),
      getRecentTransactions(),
      getAccountTrends()
    ]);

    res.json({
      balanceSheet: balanceSheetData,
      incomeStatement: incomeStatementData,
      kpis: kpiData,
      recentTransactions,
      accountTrends
    });
  } catch (error) {
    console.error('Error fetching dashboard data:', error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /finance/kpi-trends?months=12 — real month-by-month P&L movement.
//
// The dashboard KPIs are point-in-time balances off chart_of_accounts, which
// answer "where are we" but carry no shape: a finance screen that wants to draw
// revenue as a line has nothing to draw it from. This walks the posted journal
// instead, so each month is the activity that actually hit the P&L accounts in
// it, on the same sign convention the period close uses (revenue is credit
// less debit, expense the reverse).
//
// Months with no posted activity are returned as zeros rather than skipped —
// a gap in a series is a drawing artefact, not a fact about the business.
// ---------------------------------------------------------------------------
// GET /finance/margin-drivers?from=&to=&baseline_from=&baseline_to=&discount_policy_pct=&item=
// "What is hurting our margins?" — the same answer Simeli gives (services/marginDrivers.js). Read-only.
router.get('/margin-drivers', async (req, res) => {
  try {
    const { explainMargin } = require('../services/marginDrivers');
    const q = req.query;
    const data = await explainMargin({
      companyId: req.companyId,
      userId: req.user?.isApiKey ? null : req.user?.id,
      role: req.user?.role,
      from: q.from || null,
      to: q.to || null,
      baselineFrom: q.baseline_from || null,
      baselineTo: q.baseline_to || null,
      discountPolicyPct: q.discount_policy_pct != null && q.discount_policy_pct !== '' ? Number(q.discount_policy_pct) : null,
      item: q.item || null,
      limit: q.limit,
    });
    if (data.error) return res.status(400).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Margin drivers error:', error.message);
    res.status(500).json({ success: false, error: 'Could not explain the margin.' });
  }
});

// GET /finance/cash-outlook?floor=
// "Will we have the cash?" — the same answer Simeli gives (services/cashOutlook.js): the 13-week forecast with
// purchase orders not yet billed, orders not yet invoiced and held bills, the low point, its causes and what lifts it.
router.get('/cash-outlook', async (req, res) => {
  try {
    const { explainCashOutlook } = require('../services/cashOutlook');
    const floor = req.query.floor != null && req.query.floor !== '' ? Number(req.query.floor) : null;
    const data = await explainCashOutlook({
      companyId: req.companyId,
      userId: req.user?.isApiKey ? null : req.user?.id,
      role: req.user?.role,
      floor: Number.isFinite(floor) ? floor : null,
    });
    if (data.error) return res.status(data.status || 400).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Cash outlook error:', error.message);
    res.status(500).json({ success: false, error: 'Could not read the cash outlook.' });
  }
});

// POST /finance/cash-outlook/reminders { invoice_ids: [...] }
// A person in finance sends the reminders a "remind" proposal named; each is emailed and recorded on the customer.
router.post('/cash-outlook/reminders', async (req, res) => {
  try {
    const { sendReminders } = require('../services/cashOutlook');
    const data = await sendReminders({
      companyId: req.companyId,
      userId: req.user?.id,
      role: req.user?.role,
      invoiceIds: Array.isArray(req.body?.invoice_ids) ? req.body.invoice_ids : [],
    });
    if (data.error) return res.status(data.status || 400).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Cash reminders error:', error.message);
    res.status(500).json({ success: false, error: 'Could not send the reminders.' });
  }
});

// POST /finance/margin-drivers/follow-ups { kinds?: ['rfq','approval_rule','quality_review'], from?, to?, ... }
// "Prepare the follow-ups": runs the margin analysis again and drafts what it proposes now — an RFQ
// (DRAFT), a discount rule (PROPOSED) and a quality review (OPEN), each waiting on its owner.
router.post('/margin-drivers/follow-ups', async (req, res) => {
  try {
    const { prepareFollowUps } = require('../services/marginFollowUps');
    const b = req.body || {};
    const data = await prepareFollowUps({
      companyId: req.companyId,
      userId: req.user?.isApiKey ? null : req.user?.id,
      role: req.user?.role,
      kinds: Array.isArray(b.kinds) ? b.kinds : null,
      from: b.from || null,
      to: b.to || null,
      baselineFrom: b.baseline_from || null,
      baselineTo: b.baseline_to || null,
      discountPolicyPct: b.discount_policy_pct != null && b.discount_policy_pct !== '' ? Number(b.discount_policy_pct) : null,
    });
    if (data.error) return res.status(400).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Margin follow-ups error:', error.message);
    res.status(500).json({ success: false, error: 'Could not prepare the follow-ups.' });
  }
});

// GET /finance/margin-follow-ups — discount rules proposed or active, and open quality reviews.
router.get('/margin-follow-ups', async (req, res) => {
  try {
    const { listFollowUps } = require('../services/marginFollowUps');
    res.json({ success: true, data: await listFollowUps({ companyId: req.companyId, role: req.user?.role }) });
  } catch (error) {
    console.error('Margin follow-ups list error:', error.message);
    res.status(500).json({ success: false, error: 'Could not read the follow-ups.' });
  }
});

// POST /finance/discount-rules/:id/decision { decision: 'activate'|'decline'|'retire', approver_user_id?, reason? }
// A person with sales approval authority — not the one who proposed it — makes a proposed rule binding.
router.post('/discount-rules/:id/decision', async (req, res) => {
  try {
    const { decideDiscountRule } = require('../services/marginFollowUps');
    const { isPlatformOwner } = require('../middleware/auth');
    const b = req.body || {};
    const data = await decideDiscountRule({
      companyId: req.companyId,
      userId: req.user?.id,
      role: req.user?.role,
      bypassSoD: isPlatformOwner(req.user),
      id: req.params.id,
      decision: b.decision,
      approverUserId: b.approver_user_id || null,
      reason: b.reason || null,
    });
    if (data.error) return res.status(400).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Discount rule decision error:', error.message);
    res.status(500).json({ success: false, error: 'Could not record the decision.' });
  }
});

router.get('/kpi-trends', async (req, res) => {
  try {
    const requested = parseInt(req.query.months, 10);
    const months = Number.isInteger(requested) ? Math.min(Math.max(requested, 2), 36) : 12;

    const { rows } = await pool.query(
      `WITH span AS (
         SELECT generate_series(
           date_trunc('month', CURRENT_DATE) - make_interval(months => $1::int - 1),
           date_trunc('month', CURRENT_DATE),
           interval '1 month'
         )::date AS month_start
       ),
       activity AS (
         SELECT date_trunc('month', je.entry_date)::date AS month_start,
                COALESCE(SUM(jei.credit_amount - jei.debit_amount)
                         FILTER (WHERE coa.account_type = 'REVENUE'), 0)::numeric AS revenue,
                COALESCE(SUM(jei.debit_amount - jei.credit_amount)
                         FILTER (WHERE coa.account_type = 'EXPENSE'), 0)::numeric AS expenses
           FROM journal_entries je
           JOIN journal_entry_items jei ON jei.journal_entry_id = je.id
           JOIN chart_of_accounts coa ON coa.id = jei.account_id
          WHERE je.status = 'POSTED'
            AND je.deleted_at IS NULL
            AND coa.deleted_at IS NULL
            AND coa.account_type IN ('REVENUE', 'EXPENSE')
            AND je.entry_date >= date_trunc('month', CURRENT_DATE) - make_interval(months => $1::int - 1)
          GROUP BY 1
       )
       SELECT to_char(s.month_start, 'YYYY-MM') AS month,
              COALESCE(a.revenue, 0)::float8 AS revenue,
              COALESCE(a.expenses, 0)::float8 AS expenses
         FROM span s
         LEFT JOIN activity a ON a.month_start = s.month_start
        ORDER BY s.month_start`,
      [months]
    );

    const series = rows.map((r) => {
      const revenue = Number(r.revenue) || 0;
      const expenses = Number(r.expenses) || 0;
      const netIncome = revenue - expenses;
      return {
        month: r.month,
        revenue,
        expenses,
        netIncome,
        // Undefined rather than 0 for a month with no revenue: a margin of zero
        // and no basis for a margin are different readings, and a chart should
        // not be able to confuse them.
        margin: revenue > 0 ? netIncome / revenue : null,
      };
    });

    res.json({ success: true, data: series });
  } catch (error) {
    console.error('Error fetching finance KPI trends:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Balance Sheet endpoint
router.get('/balance-sheet', async (req, res) => {
  try {
    const { asOfDate } = req.query;
    
    const query = `
      SELECT
        account_code,
        account_name,
        account_type,
        account_subtype,
        current_balance,
        normal_balance
      FROM chart_of_accounts
      WHERE account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')
        AND status = 'ACTIVE'
        AND is_header = false
      ORDER BY account_code
    `;

    const result = await pool.query(query);

    const sumOf = (rows) => rows.reduce(
      (sum, account) => sum + parseFloat(account.current_balance || 0), 0
    );

    const isPermanent = (t) => t === 'ASSET' || t === 'LIABILITY' || t === 'EQUITY';

    const grouped = result.rows.reduce((acc, account) => {
      if (!isPermanent(account.account_type)) return acc;
      if (!acc[account.account_type]) {
        acc[account.account_type] = [];
      }
      acc[account.account_type].push(account);
      return acc;
    }, {});

    const totals = {};
    Object.keys(grouped).forEach(type => {
      totals[type] = sumOf(grouped[type]);
    });

    const totalRevenue = sumOf(result.rows.filter(a => a.account_type === 'REVENUE'));
    const totalExpenses = sumOf(result.rows.filter(a => a.account_type === 'EXPENSE'));
    const currentEarnings = totalRevenue - totalExpenses;

    if (Math.abs(currentEarnings) >= 0.01) {
      grouped.EQUITY = grouped.EQUITY || [];
      grouped.EQUITY.push({
        account_code: '3999',
        account_name: 'Current Period Earnings (unclosed)',
        account_type: 'EQUITY',
        account_subtype: 'RETAINED_EARNINGS',
        current_balance: currentEarnings,
        normal_balance: 'CREDIT',
        is_computed: true
      });
      totals.EQUITY = (totals.EQUITY || 0) + currentEarnings;
    }

    const totalAssets = totals.ASSET || 0;
    const totalLiabilities = totals.LIABILITY || 0;
    const totalEquity = totals.EQUITY || 0;

    res.json({
      accounts: grouped,
      totals,
      currentEarnings,
      asOfDate: asOfDate || new Date().toISOString().split('T')[0],
      isBalanced: Math.abs(totalAssets - totalLiabilities - totalEquity) < 0.01
    });
  } catch (error) {
    console.error('Error generating balance sheet:', error);
    res.status(500).json({ error: error.message });
  }
});

// Income Statement endpoint  
router.get('/income-statement', async (req, res) => {
  try {
    const { periodFrom, periodTo } = req.query;
    
    const query = `
      SELECT 
        account_code,
        account_name,
        account_type,
        current_balance
      FROM chart_of_accounts 
      WHERE account_type IN ('REVENUE', 'EXPENSE')
        AND status = 'ACTIVE'
        AND is_header = false
      ORDER BY account_code
    `;
    
    const result = await pool.query(query);
    
    const revenue = result.rows.filter(acc => acc.account_type === 'REVENUE');
    const expenses = result.rows.filter(acc => acc.account_type === 'EXPENSE');
    
    const totalRevenue = revenue.reduce((sum, acc) => sum + parseFloat(acc.current_balance || 0), 0);
    const totalExpenses = expenses.reduce((sum, acc) => sum + parseFloat(acc.current_balance || 0), 0);
    const netIncome = totalRevenue - Math.abs(totalExpenses);
    
    res.json({
      revenue,
      expenses,
      totals: {
        revenue: totalRevenue,
        expenses: Math.abs(totalExpenses),
        netIncome
      },
      period: {
        from: periodFrom || new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0],
        to: periodTo || new Date().toISOString().split('T')[0]
      }
    });
  } catch (error) {
    console.error('Error generating income statement:', error);
    res.status(500).json({ error: error.message });
  }
});

// Trial Balance endpoint
router.get('/trial-balance', async (req, res) => {
  try {
    const { asOfDate } = req.query;
    if (asOfDate && !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
      return res.status(400).json({ error: 'asOfDate must use YYYY-MM-DD format' });
    }

    const values = [];
    const asOfDateFilter = asOfDate
      ? `AND je.entry_date <= $${values.push(asOfDate)}`
      : '';
    
    const query = `
      SELECT 
        coa.account_code,
        coa.account_name,
        coa.account_type,
        coa.normal_balance,
        coa.current_balance,
        COALESCE(SUM(jei.debit_amount), 0) as total_debits,
        COALESCE(SUM(jei.credit_amount), 0) as total_credits
      FROM chart_of_accounts coa
      LEFT JOIN journal_entry_items jei ON coa.id = jei.account_id
      LEFT JOIN journal_entries je ON jei.journal_entry_id = je.id
      WHERE coa.status = 'ACTIVE' 
        AND coa.is_header = false
        AND (je.status = 'POSTED' OR je.status IS NULL)
        ${asOfDateFilter}
      GROUP BY coa.id, coa.account_code, coa.account_name, coa.account_type, coa.normal_balance, coa.current_balance
      ORDER BY coa.account_code
    `;
    
    const result = await pool.query(query, values);
    
    const totalDebits = result.rows.reduce((sum, row) => sum + parseFloat(row.total_debits), 0);
    const totalCredits = result.rows.reduce((sum, row) => sum + parseFloat(row.total_credits), 0);
    
    res.json({
      accounts: result.rows,
      totals: {
        debits: totalDebits,
        credits: totalCredits,
        difference: totalDebits - totalCredits
      },
      isBalanced: Math.abs(totalDebits - totalCredits) < 0.01,
      asOfDate: asOfDate || new Date().toISOString().split('T')[0]
    });
  } catch (error) {
    console.error('Error generating trial balance:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper functions
async function getBalanceSheetData() {
  const query = `
    SELECT 
      account_type,
      SUM(current_balance) as total_balance,
      COUNT(*) as account_count
    FROM chart_of_accounts 
    WHERE account_type IN ('ASSET', 'LIABILITY', 'EQUITY')
      AND status = 'ACTIVE'
      AND is_header = false
    GROUP BY account_type
    ORDER BY account_type
  `;
  
  const result = await pool.query(query);
  return result.rows;
}

async function getIncomeStatementData() {
  const query = `
    SELECT 
      account_type,
      SUM(current_balance) as total_balance,
      COUNT(*) as account_count
    FROM chart_of_accounts 
    WHERE account_type IN ('REVENUE', 'EXPENSE')
      AND status = 'ACTIVE' 
      AND is_header = false
    GROUP BY account_type
    ORDER BY account_type
  `;
  
  const result = await pool.query(query);
  
  const data = result.rows.map(row => ({
    ...row,
    total_balance: row.account_type === 'EXPENSE' ? 
      Math.abs(parseFloat(row.total_balance)) : 
      parseFloat(row.total_balance)
  }));
  
  return data;
}

async function getKPIData() {
  const queries = await Promise.all([
    pool.query(`
      SELECT SUM(current_balance) as total 
      FROM chart_of_accounts 
      WHERE account_type = 'ASSET' AND status = 'ACTIVE' AND is_header = false
    `),
    pool.query(`
      SELECT SUM(current_balance) as total 
      FROM chart_of_accounts 
      WHERE account_type = 'LIABILITY' AND status = 'ACTIVE' AND is_header = false
    `),
    pool.query(`
      SELECT SUM(current_balance) as total 
      FROM chart_of_accounts 
      WHERE account_type = 'EQUITY' AND status = 'ACTIVE' AND is_header = false
    `),
    pool.query(`
      SELECT SUM(current_balance) as total 
      FROM chart_of_accounts 
      WHERE account_type = 'REVENUE' AND status = 'ACTIVE' AND is_header = false
    `),
    pool.query(`
      SELECT SUM(current_balance) as total 
      FROM chart_of_accounts 
      WHERE account_type = 'EXPENSE' AND status = 'ACTIVE' AND is_header = false
    `),
    pool.query(`
      SELECT COUNT(*) as count 
      FROM journal_entries 
      WHERE status = 'POSTED' AND entry_date >= CURRENT_DATE - INTERVAL '30 days'
    `)
  ]);
  
  const revenue = parseFloat(queries[3].rows[0]?.total || 0);
  const expenses = parseFloat(queries[4].rows[0]?.total || 0);
  
  return {
    totalAssets: parseFloat(queries[0].rows[0]?.total || 0),
    totalLiabilities: parseFloat(queries[1].rows[0]?.total || 0),
    totalEquity: parseFloat(queries[2].rows[0]?.total || 0),
    totalRevenue: revenue,
    totalExpenses: Math.abs(expenses),
    netIncome: revenue - Math.abs(expenses),
    transactionCount: parseInt(queries[5].rows[0]?.count || 0)
  };
}

async function getRecentTransactions() {
  const query = `
    SELECT 
      je.journal_number,
      je.entry_date,
      je.description,
      je.total_debit,
      je.source_type,
      je.reference,
      u.first_name || ' ' || u.last_name as created_by_name
    FROM journal_entries je
    LEFT JOIN users u ON je.created_by = u.id
    WHERE je.status = 'POSTED'
    ORDER BY je.entry_date DESC, je.created_at DESC
    LIMIT 10
  `;
  
  const result = await pool.query(query);
  return result.rows;
}

async function getAccountTrends() {
  const result = await pool.query(`
    SELECT
      je.entry_date::text AS date,
      SUM(je.total_debit)::numeric AS activity
    FROM journal_entries je
    WHERE je.status = 'POSTED'
      AND je.entry_date >= CURRENT_DATE - INTERVAL '30 days'
    GROUP BY je.entry_date
    ORDER BY je.entry_date
  `);

  return result.rows.map(row => ({
    date: row.date,
    activity: parseFloat(row.activity || 0)
  }));
}

// Journal Entries Dashboard endpoint
router.get('/journal-dashboard', async (req, res) => {
  try {
    const { period = '30days', status = 'all' } = req.query;
    const validPeriods = new Set(['7days', '30days', '90days', 'ytd']);
    const validStatuses = new Set(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'POSTED', 'REJECTED', 'REVERSED']);

    if (!validPeriods.has(period)) {
      return res.status(400).json({ error: 'Invalid period' });
    }
    if (status !== 'all' && !validStatuses.has(status)) {
      return res.status(400).json({ error: 'Invalid journal entry status' });
    }
    
    const values = [];
    let startDate;
    const today = new Date();
    
    switch (period) {
      case '7days':
        const week = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
        startDate = week.toISOString().split('T')[0];
        break;
      case '30days':
        const month = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
        startDate = month.toISOString().split('T')[0];
        break;
      case '90days':
        const quarter = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);
        startDate = quarter.toISOString().split('T')[0];
        break;
      case 'ytd':
        const yearStart = new Date(today.getFullYear(), 0, 1);
        startDate = yearStart.toISOString().split('T')[0];
        break;
    }
    
    const dateFilter = `AND je.entry_date >= $${values.push(startDate)}`;
    const statusFilter = status !== 'all' ? `AND je.status = $${values.push(status)}` : '';
    
    const [
      summaryData,
      sourceTypeData,
      recentEntries,
      accountActivity,
      dailyActivity
    ] = await Promise.all([
      pool.query(`
        SELECT 
          COUNT(*) as total_entries,
          SUM(total_debit) as total_debits,
          SUM(total_credit) as total_credits,
          COUNT(CASE WHEN status = 'POSTED' THEN 1 END) as posted_entries
        FROM journal_entries je
        WHERE 1=1 ${dateFilter} ${statusFilter}
      `, values),
      
      pool.query(`
        SELECT 
          COALESCE(source_type, 'MANUAL') as source_type,
          COUNT(*) as entry_count,
          SUM(total_debit) as total_amount
        FROM journal_entries je
        WHERE 1=1 ${dateFilter} ${statusFilter}
        GROUP BY source_type
        ORDER BY entry_count DESC
      `, values),
      
      pool.query(`
        SELECT 
          je.journal_number,
          je.entry_date,
          je.source_type,
          je.reference,
          je.description,
          je.total_debit,
          je.status,
          u.first_name || ' ' || u.last_name as created_by_name
        FROM journal_entries je
        LEFT JOIN users u ON je.created_by = u.id
        WHERE 1=1 ${dateFilter} ${statusFilter}
        ORDER BY je.entry_date DESC, je.created_at DESC
        LIMIT 20
      `, values),
      
      pool.query(`
        SELECT 
          coa.account_code,
          coa.account_name,
          coa.account_type,
          COUNT(jei.id) as transaction_count,
          SUM(GREATEST(jei.debit_amount, jei.credit_amount)) as total_activity
        FROM chart_of_accounts coa
        LEFT JOIN journal_entry_items jei ON coa.id = jei.account_id
        LEFT JOIN journal_entries je ON jei.journal_entry_id = je.id
        WHERE coa.status = 'ACTIVE' 
          AND coa.is_header = false
          ${dateFilter.replace('je.', 'je.')}
          ${statusFilter.replace('je.', 'je.')}
        GROUP BY coa.id, coa.account_code, coa.account_name, coa.account_type
        HAVING COUNT(jei.id) > 0
        ORDER BY transaction_count DESC, total_activity DESC
        LIMIT 10
      `, values),

      pool.query(`
        SELECT
          je.entry_date::text AS date,
          COUNT(*)::int AS volume,
          COALESCE(SUM(je.total_debit), 0)::numeric AS amount
        FROM journal_entries je
        WHERE 1=1 ${dateFilter} ${statusFilter}
        GROUP BY je.entry_date
        ORDER BY je.entry_date
      `, values)
    ]);
    
    res.json({
      summary: summaryData.rows[0],
      sourceTypes: sourceTypeData.rows,
      recentEntries: recentEntries.rows,
      accountActivity: accountActivity.rows,
      dailyActivity: dailyActivity.rows.map(row => ({
        ...row,
        volume: Number(row.volume || 0),
        amount: parseFloat(row.amount || 0)
      })),
      period,
      status
    });
  } catch (error) {
    console.error('Error fetching journal dashboard data:', error);
    res.status(500).json({ error: error.message });
  }
});


// POST /finance/intercompany/mirror-po
router.post('/intercompany/mirror-po', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const intercompanyService = require('../services/intercompanyService');
    const { po_id, selling_company_id, customer_id } = req.body;
    if (!po_id || !selling_company_id || !customer_id) {
      return res.status(400).json({ success: false, error: 'po_id, selling_company_id, customer_id are required' });
    }
    const result = await intercompanyService.mirrorPOToSalesOrder(po_id, selling_company_id, customer_id);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /finance/intercompany/consolidated-financials
router.get('/intercompany/consolidated-financials', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const intercompanyService = require('../services/intercompanyService');
    const result = await intercompanyService.generateConsolidatedFinancials({});
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;



