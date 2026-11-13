const express = require('express');
const router = express.Router();
const { auth, requireManagerOrAdmin } = require('../middleware/auth');
const FinancialPostingService = require('../services/financialPostingService');
const { pool } = require('../config/database');

// Get trial balance
router.get('/trial-balance', auth, async (req, res) => {
  try {
    const { as_of_date } = req.query;
    
    const trialBalance = await FinancialPostingService.getTrialBalance(as_of_date);
    
    res.json({
      success: true,
      data: trialBalance,
      as_of_date: as_of_date || new Date().toISOString().split('T')[0]
    });
  } catch (error) {
    console.error('Error generating trial balance:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate trial balance'
    });
  }
});

// Get balance sheet
router.get('/balance-sheet', auth, async (req, res) => {
  try {
    const { as_of_date } = req.query;
    const asOfDate = as_of_date || new Date().toISOString().split('T')[0];
    
    // Parameterized — never interpolate query input into SQL.
    const dateFilter = `AND je.entry_date <= $1 AND je.status = 'POSTED'`;
    const dateParams = [asOfDate];

    // Get assets
    const assetsQuery = `
      SELECT
        coa.id as account_id,
        coa.account_code,
        coa.account_name,
        coa.account_subtype,
        SUM(CASE 
          WHEN coa.normal_balance = 'DEBIT' 
          THEN jei.debit_amount - jei.credit_amount
          ELSE jei.credit_amount - jei.debit_amount
        END) as balance
      FROM chart_of_accounts coa
      LEFT JOIN journal_entry_items jei ON coa.id = jei.account_id
      LEFT JOIN journal_entries je ON jei.journal_entry_id = je.id
      WHERE coa.deleted_at IS NULL 
        AND coa.is_active = true 
        AND coa.is_header = false
        AND coa.account_type = 'ASSET'
        ${dateFilter}
      GROUP BY coa.id, coa.account_code, coa.account_name, coa.account_subtype, coa.normal_balance
      HAVING SUM(jei.debit_amount) > 0 OR SUM(jei.credit_amount) > 0
      ORDER BY coa.account_code
    `;

    // Get liabilities
    const liabilitiesQuery = `
      SELECT
        coa.id as account_id,
        coa.account_code,
        coa.account_name,
        coa.account_subtype,
        SUM(CASE 
          WHEN coa.normal_balance = 'CREDIT' 
          THEN jei.credit_amount - jei.debit_amount
          ELSE jei.debit_amount - jei.credit_amount
        END) as balance
      FROM chart_of_accounts coa
      LEFT JOIN journal_entry_items jei ON coa.id = jei.account_id
      LEFT JOIN journal_entries je ON jei.journal_entry_id = je.id
      WHERE coa.deleted_at IS NULL 
        AND coa.is_active = true 
        AND coa.is_header = false
        AND coa.account_type = 'LIABILITY'
        ${dateFilter}
      GROUP BY coa.id, coa.account_code, coa.account_name, coa.account_subtype, coa.normal_balance
      HAVING SUM(jei.debit_amount) > 0 OR SUM(jei.credit_amount) > 0
      ORDER BY coa.account_code
    `;

    // Get equity
    const equityQuery = `
      SELECT
        coa.id as account_id,
        coa.account_code,
        coa.account_name,
        coa.account_subtype,
        SUM(CASE 
          WHEN coa.normal_balance = 'CREDIT' 
          THEN jei.credit_amount - jei.debit_amount
          ELSE jei.debit_amount - jei.credit_amount
        END) as balance
      FROM chart_of_accounts coa
      LEFT JOIN journal_entry_items jei ON coa.id = jei.account_id
      LEFT JOIN journal_entries je ON jei.journal_entry_id = je.id
      WHERE coa.deleted_at IS NULL 
        AND coa.is_active = true 
        AND coa.is_header = false
        AND coa.account_type = 'EQUITY'
        ${dateFilter}
      GROUP BY coa.id, coa.account_code, coa.account_name, coa.account_subtype, coa.normal_balance
      HAVING SUM(jei.debit_amount) > 0 OR SUM(jei.credit_amount) > 0
      ORDER BY coa.account_code
    `;

    const [assetsResult, liabilitiesResult, equityResult] = await Promise.all([
      pool.query(assetsQuery, dateParams),
      pool.query(liabilitiesQuery, dateParams),
      pool.query(equityQuery, dateParams)
    ]);

    const balanceSheet = {
      assets: assetsResult.rows,
      liabilities: liabilitiesResult.rows,
      equity: equityResult.rows,
      total_assets: assetsResult.rows.reduce((sum, account) => sum + parseFloat(account.balance || 0), 0),
      total_liabilities: liabilitiesResult.rows.reduce((sum, account) => sum + parseFloat(account.balance || 0), 0),
      total_equity: equityResult.rows.reduce((sum, account) => sum + parseFloat(account.balance || 0), 0)
    };

    // A balance sheet must balance by construction: unclosed current-period
    // earnings (P&L posted since the last close) are part of equity. The
    // ledger reads them from REVENUE/EXPENSE lines; without a synthetic
    // earnings line here, total_assets - (liabilities + equity) equals
    // exactly the unclosed net income and the page reports an imbalance
    // that is not a bookkeeping error. Mirrors finance.js /balance-sheet.
    const { rows: earningsRows } = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN coa.account_type = 'REVENUE' THEN
           CASE WHEN coa.normal_balance = 'DEBIT' THEN jei.debit_amount - jei.credit_amount
                ELSE jei.credit_amount - jei.debit_amount END ELSE 0 END), 0)
         - COALESCE(SUM(CASE WHEN coa.account_type = 'EXPENSE' THEN
           CASE WHEN coa.normal_balance = 'DEBIT' THEN jei.debit_amount - jei.credit_amount
                ELSE jei.credit_amount - jei.debit_amount END ELSE 0 END), 0)
         AS current_earnings
       FROM chart_of_accounts coa
       JOIN journal_entry_items jei ON coa.id = jei.account_id
       JOIN journal_entries je ON jei.journal_entry_id = je.id
       WHERE coa.deleted_at IS NULL AND coa.is_header = false
         AND coa.account_type IN ('REVENUE', 'EXPENSE')
         AND je.entry_date <= $1 AND je.status = 'POSTED' AND je.deleted_at IS NULL`,
      [asOfDate]
    );
    const currentEarnings = Math.round(Number(earningsRows[0].current_earnings || 0) * 100) / 100;
    if (Math.abs(currentEarnings) >= 0.01) {
      balanceSheet.equity = balanceSheet.equity.concat([{
        account_code: '3999',
        account_name: 'Current Period Earnings (unclosed)',
        account_subtype: 'RETAINED_EARNINGS',
        normal_balance: 'CREDIT',
        balance: currentEarnings,
        is_computed: true,
      }]);
      balanceSheet.total_equity = Math.round((balanceSheet.total_equity + currentEarnings) * 100) / 100;
    }
    balanceSheet.current_earnings = currentEarnings;
    balanceSheet.isBalanced = Math.abs(balanceSheet.total_assets - balanceSheet.total_liabilities - balanceSheet.total_equity) < 0.01;

    res.json({
      success: true,
      data: balanceSheet,
      as_of_date: asOfDate
    });
  } catch (error) {
    console.error('Error generating balance sheet:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate balance sheet'
    });
  }
});

// Get income statement (P&L)
router.get('/income-statement', auth, async (req, res) => {
  try {
    const { date_from, date_to } = req.query;
    const dateFrom = date_from || new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0]; // Start of year
    const dateTo = date_to || new Date().toISOString().split('T')[0]; // Today
    
    // Parameterized — never interpolate query input into SQL.
    const dateFilter = `AND je.entry_date >= $1 AND je.entry_date <= $2 AND je.status = 'POSTED'`;
    const dateParams = [dateFrom, dateTo];

    // Get revenue accounts
    const revenueQuery = `
      SELECT
        coa.id as account_id,
        coa.account_code,
        coa.account_name,
        coa.account_subtype,
        SUM(CASE 
          WHEN coa.normal_balance = 'CREDIT' 
          THEN jei.credit_amount - jei.debit_amount
          ELSE jei.debit_amount - jei.credit_amount
        END) as balance
      FROM chart_of_accounts coa
      LEFT JOIN journal_entry_items jei ON coa.id = jei.account_id
      LEFT JOIN journal_entries je ON jei.journal_entry_id = je.id
      WHERE coa.deleted_at IS NULL 
        AND coa.is_active = true 
        AND coa.is_header = false
        AND coa.account_type = 'REVENUE'
        ${dateFilter}
      GROUP BY coa.id, coa.account_code, coa.account_name, coa.account_subtype, coa.normal_balance
      HAVING SUM(jei.debit_amount) > 0 OR SUM(jei.credit_amount) > 0
      ORDER BY coa.account_code
    `;

    // Get expense accounts
    const expenseQuery = `
      SELECT
        coa.id as account_id,
        coa.account_code,
        coa.account_name,
        coa.account_subtype,
        SUM(CASE 
          WHEN coa.normal_balance = 'DEBIT' 
          THEN jei.debit_amount - jei.credit_amount
          ELSE jei.credit_amount - jei.debit_amount
        END) as balance
      FROM chart_of_accounts coa
      LEFT JOIN journal_entry_items jei ON coa.id = jei.account_id
      LEFT JOIN journal_entries je ON jei.journal_entry_id = je.id
      WHERE coa.deleted_at IS NULL 
        AND coa.is_active = true 
        AND coa.is_header = false
        AND coa.account_type = 'EXPENSE'
        ${dateFilter}
      GROUP BY coa.id, coa.account_code, coa.account_name, coa.account_subtype, coa.normal_balance
      HAVING SUM(jei.debit_amount) > 0 OR SUM(jei.credit_amount) > 0
      ORDER BY coa.account_code
    `;

    const [revenueResult, expenseResult] = await Promise.all([
      pool.query(revenueQuery, dateParams),
      pool.query(expenseQuery, dateParams)
    ]);

    const totalRevenue = revenueResult.rows.reduce((sum, account) => sum + parseFloat(account.balance || 0), 0);
    const totalExpenses = expenseResult.rows.reduce((sum, account) => sum + parseFloat(account.balance || 0), 0);

    const incomeStatement = {
      revenue: revenueResult.rows,
      expenses: expenseResult.rows,
      total_revenue: totalRevenue,
      total_expenses: totalExpenses,
      net_income: totalRevenue - totalExpenses
    };

    res.json({
      success: true,
      data: incomeStatement,
      date_from: dateFrom,
      date_to: dateTo
    });
  } catch (error) {
    console.error('Error generating income statement:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate income statement'
    });
  }
});

// Get general ledger for specific account
router.get('/general-ledger/:accountId', auth, async (req, res) => {
  try {
    const { accountId } = req.params;
    const { date_from, date_to } = req.query;
    // Coerce and bound pagination — never interpolate raw query input into SQL.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    let dateFilter = '';
    const values = [accountId];
    let paramCount = 1;

    if (date_from) {
      paramCount++;
      dateFilter += ` AND je.entry_date >= $${paramCount}`;
      values.push(date_from);
    }

    if (date_to) {
      paramCount++;
      dateFilter += ` AND je.entry_date <= $${paramCount}`;
      values.push(date_to);
    }

    const limitParam = `$${paramCount + 1}`;
    const offsetParam = `$${paramCount + 2}`;
    values.push(limit, offset);

    const query = `
      SELECT 
        je.journal_number,
        je.entry_date,
        je.description as entry_description,
        je.reference,
        je.status,
        jei.description as line_description,
        jei.debit_amount,
        jei.credit_amount,
        u.first_name || ' ' || u.last_name as created_by_name
      FROM journal_entry_items jei
      INNER JOIN journal_entries je ON jei.journal_entry_id = je.id
      LEFT JOIN users u ON je.created_by = u.id
      WHERE jei.account_id = $1 
        AND je.deleted_at IS NULL 
        AND je.status = 'POSTED'
        ${dateFilter}
      ORDER BY je.entry_date DESC, je.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `;

    const result = await pool.query(query, values);
    
    // Get account details
    const accountQuery = `
      SELECT account_code, account_name, account_type, normal_balance, current_balance
      FROM chart_of_accounts 
      WHERE id = $1 AND deleted_at IS NULL
    `;
    
    const accountResult = await pool.query(accountQuery, [accountId]);
    
    res.json({
      success: true,
      data: {
        account: accountResult.rows[0],
        transactions: result.rows
      }
    });
  } catch (error) {
    console.error('Error generating general ledger:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate general ledger'
    });
  }
});

// Shared aging bucket SQL for an invoice-style table with due_date + outstanding_amount
function agingQuery(table, openStatuses) {
  return `
    SELECT
      COALESCE(SUM(outstanding_amount), 0) AS total_outstanding,
      COALESCE(SUM(CASE WHEN due_date >= CURRENT_DATE THEN outstanding_amount ELSE 0 END), 0) AS current_bucket,
      COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE AND due_date >= CURRENT_DATE - INTERVAL '30 days' THEN outstanding_amount ELSE 0 END), 0) AS days_1_30,
      COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE - INTERVAL '30 days' AND due_date >= CURRENT_DATE - INTERVAL '60 days' THEN outstanding_amount ELSE 0 END), 0) AS days_31_60,
      COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE - INTERVAL '60 days' AND due_date >= CURRENT_DATE - INTERVAL '90 days' THEN outstanding_amount ELSE 0 END), 0) AS days_61_90,
      COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE - INTERVAL '90 days' THEN outstanding_amount ELSE 0 END), 0) AS days_90_plus,
      COUNT(*)::int AS open_count
    FROM ${table}
    WHERE deleted_at IS NULL AND status IN (${openStatuses})
  `;
}

// GET /financial-reports/ar-aging - Accounts Receivable aging
router.get('/ar-aging', auth, async (req, res) => {
  try {
    const summary = await pool.query(agingQuery('customer_invoices', `'APPROVED','SENT','PARTIALLY_PAID','OVERDUE'`));
    const detail = await pool.query(`
      SELECT ci.id, ci.journal_entry_id, ci.invoice_number, ci.due_date, ci.total_amount, ci.outstanding_amount, ci.status,
             c.customer_name,
             GREATEST(0, (CURRENT_DATE - ci.due_date))::int AS days_overdue
      FROM customer_invoices ci
      LEFT JOIN customers c ON ci.customer_id = c.id
      WHERE ci.deleted_at IS NULL AND ci.status IN ('APPROVED','SENT','PARTIALLY_PAID','OVERDUE') AND ci.outstanding_amount > 0
      ORDER BY ci.due_date ASC
    `);
    res.json({ success: true, summary: summary.rows[0], detail: detail.rows });
  } catch (error) {
    console.error('AR aging error:', error.message);
    res.json({ success: true, summary: null, detail: [], note: 'AR tables unavailable — run the finance AR/AP migration.' });
  }
});

// POST /financial-reports/dunning/run - send payment-reminder emails for
// overdue customer invoices. { dry_run: boolean } to preview without emailing.
// MANAGER/ADMIN only — this sends real email to customers.
router.post('/dunning/run', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const { runDunning } = require('../services/dunningService');
    const result = await runDunning({ dryRun: req.body?.dry_run === true });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Dunning run error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /financial-reports/ap-aging - Accounts Payable aging
router.get('/ap-aging', auth, async (req, res) => {
  try {
    const summary = await pool.query(agingQuery('supplier_invoices', `'APPROVED','PARTIALLY_PAID','OVERDUE'`));
    const detail = await pool.query(`
      SELECT si.id, si.journal_entry_id, si.bill_number, si.supplier_invoice_number, si.due_date, si.total_amount, si.outstanding_amount, si.status,
             s.legal_name AS supplier_name,
             GREATEST(0, (CURRENT_DATE - si.due_date))::int AS days_overdue
      FROM supplier_invoices si
      LEFT JOIN suppliers s ON si.supplier_id = s.id
      WHERE si.deleted_at IS NULL AND si.status IN ('APPROVED','PARTIALLY_PAID','OVERDUE') AND si.outstanding_amount > 0
      ORDER BY si.due_date ASC
    `);
    res.json({ success: true, summary: summary.rows[0], detail: detail.rows });
  } catch (error) {
    console.error('AP aging error:', error.message);
    res.json({ success: true, summary: null, detail: [], note: 'AP tables unavailable — run the finance AR/AP migration.' });
  }
});

// GET /financial-reports/vat-summary?from=YYYY-MM-DD&to=YYYY-MM-DD - VAT return summary
router.get('/vat-summary', auth, async (req, res) => {
  const { from, to } = req.query;
  try {
    const outputParams = [];
    let outputWhere = `deleted_at IS NULL AND status <> 'CANCELLED'`;
    if (from) { outputParams.push(from); outputWhere += ` AND invoice_date >= $${outputParams.length}`; }
    if (to) { outputParams.push(to); outputWhere += ` AND invoice_date <= $${outputParams.length}`; }

    const output = await pool.query(
      `SELECT COALESCE(SUM(tax_amount),0) AS output_vat, COALESCE(SUM(subtotal - discount_amount),0) AS taxable_sales FROM customer_invoices WHERE ${outputWhere}`,
      outputParams
    );

    let inputVat = 0, taxablePurchases = 0;
    try {
      const inputParams = [];
      let inputWhere = `deleted_at IS NULL AND status <> 'CANCELLED'`;
      if (from) { inputParams.push(from); inputWhere += ` AND invoice_date >= $${inputParams.length}`; }
      if (to) { inputParams.push(to); inputWhere += ` AND invoice_date <= $${inputParams.length}`; }
      const input = await pool.query(
        `SELECT COALESCE(SUM(tax_amount),0) AS input_vat, COALESCE(SUM(subtotal - discount_amount),0) AS taxable_purchases FROM supplier_invoices WHERE ${inputWhere}`,
        inputParams
      );
      inputVat = Number(input.rows[0].input_vat);
      taxablePurchases = Number(input.rows[0].taxable_purchases);
    } catch (_) { /* AP tables may not exist yet */ }

    const outputVat = Number(output.rows[0].output_vat);
    res.json({
      success: true,
      period: { from: from || null, to: to || null },
      taxable_sales: Number(output.rows[0].taxable_sales),
      output_vat: outputVat,
      taxable_purchases: taxablePurchases,
      input_vat: inputVat,
      net_vat_payable: Math.round((outputVat - inputVat) * 100) / 100,
    });
  } catch (error) {
    console.error('VAT summary error:', error.message);
    res.json({ success: true, note: 'VAT tables unavailable — run the finance AR/AP migration.', output_vat: 0, input_vat: 0, net_vat_payable: 0 });
  }
});

// ---------------------------------------------------------------------------
// GET /financial-reports/gr-ir-aging — GR/IR clearing account aging.
// Shows goods received but not yet invoiced, grouped by PO and aging bucket.
// The GR/IR account (2115) is credited on receipt and debited on invoice —
// an uncleared credit balance means goods were received without a matching
// supplier bill. This report is the "received not invoiced" counterpart to
// the AR/AP aging reports.
// ---------------------------------------------------------------------------
router.get('/gr-ir-aging', auth, async (req, res) => {
  try {
    const grIrAccount = await pool.query(
      "SELECT id FROM chart_of_accounts WHERE account_code = '2115' AND deleted_at IS NULL AND status = 'ACTIVE'"
    );
    if (grIrAccount.rows.length === 0) {
      return res.json({ success: true, note: 'GR/IR account (2115) not found.', balances: [] });
    }

    // Find all goods receipt journal lines that haven't been fully cleared.
    // A receipt creates a credit to 2115; an invoice debits 2115. The net
    // per-source_id is the uncleared amount.
    const { rows } = await pool.query(`
      WITH gr_lines AS (
        SELECT jel.journal_entry_id, je.source_id AS receipt_id, je.source_type,
               jel.credit_amount - jel.debit_amount AS net_credit,
               je.entry_date, je.description
          FROM journal_entry_items jel
          JOIN journal_entries je ON jel.journal_entry_id = je.id
          JOIN chart_of_accounts coa ON jel.account_id = coa.id
         WHERE coa.account_code = '2115'
           AND je.deleted_at IS NULL
      ),
      uncleared AS (
        SELECT receipt_id,
               COALESCE(SUM(net_credit), 0)::numeric(15,2) AS balance,
               MIN(entry_date) AS first_date,
               MAX(description) AS description,
               array_agg(DISTINCT journal_entry_id) AS journal_entry_ids
          FROM gr_lines
         GROUP BY receipt_id
        HAVING COALESCE(SUM(net_credit), 0) > 0.01
      )
      SELECT u.*,
             gr.po_id, po.po_number, s.legal_name AS supplier_name,
             CURRENT_DATE - u.first_date::date AS days_outstanding
        FROM uncleared u
        LEFT JOIN goods_receipts gr ON gr.id = u.receipt_id
        LEFT JOIN purchase_orders po ON gr.po_id = po.id
        LEFT JOIN suppliers s ON po.supplier_id = s.id
       ORDER BY days_outstanding DESC
    `);

    const aging = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
    let totalUncleared = 0;
    for (const r of rows) {
      totalUncleared += Number(r.balance);
      const d = r.days_outstanding || 0;
      if (d <= 30) aging['0-30'] += Number(r.balance);
      else if (d <= 60) aging['31-60'] += Number(r.balance);
      else if (d <= 90) aging['61-90'] += Number(r.balance);
      else aging['90+'] += Number(r.balance);
    }

    res.json({
      success: true,
      account: '2115 — GR/IR Clearing',
      total_uncleared: Math.round(totalUncleared * 100) / 100,
      aging: Object.fromEntries(Object.entries(aging).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      items: rows.map((r) => ({
        receipt_id: r.receipt_id,
        po_id: r.po_id,
        po_number: r.po_number || 'N/A',
        supplier: r.supplier_name || 'N/A',
        description: r.description,
        balance: Number(r.balance),
        days_outstanding: r.days_outstanding || 0,
        first_date: r.first_date,
        journal_entry_ids: (r.journal_entry_ids || []).filter(Boolean),
      })),
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('GR/IR aging error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// POST /financial-reports/gr-ir-clear — clear uncleared GR/IR receipt balance
// ---------------------------------------------------------------------------
router.post('/gr-ir-clear', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { receiptId, poId, amount, reason = 'GR/IR Manual Clearing Workbench' } = req.body;
    if (!receiptId && !poId) {
      return res.status(400).json({ success: false, error: 'receiptId or poId is required.' });
    }

    await client.query('BEGIN');

    // Find 2115 (GR/IR) and 2110 (AP) account IDs
    const { rows: accounts } = await client.query(
      "SELECT id, account_code FROM chart_of_accounts WHERE account_code IN ('2115', '2110') AND deleted_at IS NULL"
    );
    const grIrAcc = accounts.find(a => a.account_code === '2115');
    const apAcc = accounts.find(a => a.account_code === '2110');

    if (!grIrAcc || !apAcc) {
      throw new Error('GR/IR (2115) or AP (2110) account not found in Chart of Accounts.');
    }

    const clearAmount = Number(amount) || 0;
    if (clearAmount <= 0) {
      throw new Error('Clear amount must be greater than zero.');
    }

    const JournalEntry = require('../models/JournalEntry');
    const entry = await JournalEntry.create({
      entry_date: new Date().toISOString().split('T')[0],
      description: `GR/IR Clearing: ${reason}`,
      source_type: 'GR_IR_CLEARING',
      source_id: receiptId || poId,
    }, [
      { account_id: grIrAcc.id, debit_amount: clearAmount, credit_amount: 0, description: 'Debit GR/IR Clearing' },
      { account_id: apAcc.id, debit_amount: 0, credit_amount: clearAmount, description: 'Credit Accounts Payable' },
    ], req.user.id, client);

    await JournalEntry.postAsSystem(entry.id, req.user.id, reason, client);

    await client.query('COMMIT');
    res.json({ success: true, message: 'GR/IR balance cleared successfully', journal_entry_id: entry.id });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('GR/IR clearing error:', error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// GET /financial-reports/year-end-preview — preview fiscal year-end closing
// ---------------------------------------------------------------------------
router.get('/year-end-preview', auth, async (req, res) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear() - 1;
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    const { rows } = await pool.query(
      `SELECT coa.id, coa.account_code, coa.account_name, coa.account_type,
              COALESCE(SUM(jel.debit_amount), 0)::numeric(15,2) AS total_debit,
              COALESCE(SUM(jel.credit_amount), 0)::numeric(15,2) AS total_credit
         FROM chart_of_accounts coa
         LEFT JOIN journal_entry_items jel ON coa.id = jel.account_id
         LEFT JOIN journal_entries je ON jel.journal_entry_id = je.id AND je.status = 'POSTED' AND je.entry_date BETWEEN $1 AND $2 AND je.deleted_at IS NULL
        WHERE coa.deleted_at IS NULL
          AND coa.account_type IN ('REVENUE', 'EXPENSE')
        GROUP BY coa.id, coa.account_code, coa.account_name, coa.account_type
        HAVING COALESCE(SUM(jel.debit_amount), 0) > 0 OR COALESCE(SUM(jel.credit_amount), 0) > 0`,
      [startDate, endDate]
    );

    let totalRevenue = 0;
    let totalExpense = 0;

    const accounts = rows.map(r => {
      const db = Number(r.total_debit);
      const cr = Number(r.total_credit);
      let balance = 0;
      if (r.account_type === 'REVENUE') {
        balance = cr - db;
        totalRevenue += balance;
      } else {
        balance = db - cr;
        totalExpense += balance;
      }
      return {
        id: r.id,
        code: r.account_code,
        name: r.account_name,
        type: r.account_type,
        balance,
      };
    });

    const netIncome = totalRevenue - totalExpense;

    res.json({
      success: true,
      fiscal_year: year,
      total_revenue: Math.round(totalRevenue * 100) / 100,
      total_expense: Math.round(totalExpense * 100) / 100,
      net_income: Math.round(netIncome * 100) / 100,
      accounts_count: accounts.length,
      accounts,
    });
  } catch (error) {
    console.error('Year-end preview error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// POST /financial-reports/year-end-close — execute year-end closing entry
// ---------------------------------------------------------------------------
router.post('/year-end-close', auth, requireManagerOrAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const year = Number(req.body.year) || new Date().getFullYear() - 1;
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;
    const reason = req.body.reason || `Year-End Close for Fiscal Year ${year}`;

    await client.query('BEGIN');

    // Find Retained Earnings Account (3200 or Equity)
    const { rows: reAccount } = await client.query(
      "SELECT id FROM chart_of_accounts WHERE (account_code = '3200' OR account_name ILIKE '%Retained Earnings%') AND deleted_at IS NULL LIMIT 1"
    );
    if (reAccount.length === 0) {
      throw new Error('Retained Earnings account (3200) not found in Chart of Accounts.');
    }
    const retainedEarningsId = reAccount[0].id;

    // Fetch Revenue and Expense balances
    const { rows: balances } = await client.query(
      `SELECT coa.id, coa.account_code, coa.account_name, coa.account_type,
              COALESCE(SUM(jel.debit_amount), 0)::numeric(15,2) AS total_debit,
              COALESCE(SUM(jel.credit_amount), 0)::numeric(15,2) AS total_credit
         FROM chart_of_accounts coa
         JOIN journal_entry_items jel ON coa.id = jel.account_id
         JOIN journal_entries je ON jel.journal_entry_id = je.id AND je.status = 'POSTED' AND je.entry_date BETWEEN $1 AND $2 AND je.deleted_at IS NULL
        WHERE coa.deleted_at IS NULL
          AND coa.account_type IN ('REVENUE', 'EXPENSE')
        GROUP BY coa.id, coa.account_code, coa.account_name, coa.account_type`,
      [startDate, endDate]
    );

    if (balances.length === 0) {
      throw new Error(`No active revenue or expense journal lines found for fiscal year ${year}.`);
    }

    const lines = [];
    let netEquityCredit = 0;

    for (const b of balances) {
      const db = Number(b.total_debit);
      const cr = Number(b.total_credit);
      if (b.account_type === 'REVENUE') {
        const netCr = cr - db;
        if (netCr !== 0) {
          lines.push({ account_id: b.id, debit_amount: netCr > 0 ? netCr : 0, credit_amount: netCr < 0 ? Math.abs(netCr) : 0, description: `Close Revenue ${b.account_code}` });
          netEquityCredit += netCr;
        }
      } else {
        const netDb = db - cr;
        if (netDb !== 0) {
          lines.push({ account_id: b.id, debit_amount: netDb < 0 ? Math.abs(netDb) : 0, credit_amount: netDb > 0 ? netDb : 0, description: `Close Expense ${b.account_code}` });
          netEquityCredit -= netDb;
        }
      }
    }

    if (netEquityCredit > 0) {
      lines.push({ account_id: retainedEarningsId, debit_amount: 0, credit_amount: netEquityCredit, description: `Transfer Net Income to Retained Earnings` });
    } else if (netEquityCredit < 0) {
      lines.push({ account_id: retainedEarningsId, debit_amount: Math.abs(netEquityCredit), credit_amount: 0, description: `Transfer Net Loss to Retained Earnings` });
    }

    const JournalEntry = require('../models/JournalEntry');
    const entry = await JournalEntry.create({
      entry_date: endDate,
      description: `Year-End Financial Close FY${year}: ${reason}`,
      source_type: 'YEAR_END_CLOSE',
      source_id: `FY${year}`,
    }, lines, req.user.id, client);

    await JournalEntry.postAsSystem(entry.id, req.user.id, reason, client);

    await client.query('COMMIT');
    res.json({
      success: true,
      message: `Fiscal Year ${year} successfully closed`,
      journal_entry_id: entry.id,
      net_income_transferred: netEquityCredit,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Year-end close execution error:', error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// GET /financial-reports/period-close/checks
router.get('/period-close/checks', auth, async (req, res) => {
  try {
    const PeriodCloseService = require('../services/periodCloseService');
    const result = await PeriodCloseService.validatePreCloseChecks(req.query.period_id);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /financial-reports/period-close/close
// Requires the signed sign-off checklist in the body (see
// periodCloseService.buildChecklist for the shape): every pre-close check has
// a named owner and must be signed before the close proceeds.
router.post('/period-close/close', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const PeriodCloseService = require('../services/periodCloseService');
    const result = await PeriodCloseService.closePeriod(
      req.body.period_id,
      req.user.id,
      null,
      { checklist: req.body.checklist, reason: req.body.reason }
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /financial-reports/period-close/reopen
router.post('/period-close/reopen', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const PeriodCloseService = require('../services/periodCloseService');
    const result = await PeriodCloseService.reopenPeriod(req.body.period_id, req.body.reason, req.user.id);
    res.json(result);
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// GET /financial-reports/cashflow-forecast - 13-week cash flow forecast with P10/P50/P90
router.get('/cashflow-forecast', auth, async (req, res) => {
  try {
    const CashflowForecastService = require('../services/cashflowForecastService');
    const forecast = await CashflowForecastService.generate13WeekForecast();
    res.json(forecast);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /financial-reports/cash-flow-statement?date_from=&date_to= — indirect-method
// cash flow statement built from real GL account movements (see
// services/cashFlowStatementService.js). Distinct from /cashflow-forecast,
// which projects future cash, not a historical statement.
router.get('/cash-flow-statement', auth, async (req, res) => {
  try {
    const { date_from, date_to } = req.query;
    const dateFrom = date_from || new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0];
    const dateTo = date_to || new Date().toISOString().split('T')[0];
    const CashFlowStatementService = require('../services/cashFlowStatementService');
    const statement = await CashFlowStatementService.generateCashFlowStatement({ dateFrom, dateTo });
    res.json({ success: true, data: statement });
  } catch (error) {
    console.error('Cash flow statement error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
