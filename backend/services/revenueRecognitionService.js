const { pool } = require('../config/database');
const { currentCompanyId } = require('./companyContext');
const JournalEntry = require('../models/JournalEntry');

/**
 * Deferred Revenue & Subscription Amortization Service.
 *
 * Implements straight-line deferred revenue recognition schedules and performance obligation
 * postings over N periods. Account numbers are dynamically resolved per company rather
 * than hardcoding static numbers.
 */
class RevenueRecognitionService {
  /**
   * Resolve deferred revenue and sales revenue account numbers deterministically.
   *
   * Queries company_gl_mappings for explicit purpose-to-account assignments
   * ('DEFERRED_REVENUE' and 'RECOGNIZED_REVENUE').
   */
  static async resolveAccounts(companyId) {
    let deferredAccount = '2200';
    let revenueAccount = '4100';

    if (companyId) {
      // 1. Check explicit per-company GL mappings registry
      const { rows: mappings } = await pool.query(
        `SELECT purpose, account_code
           FROM company_gl_mappings
          WHERE company_id = $1 AND purpose IN ('DEFERRED_REVENUE', 'RECOGNIZED_REVENUE')`,
        [companyId]
      );

      for (const m of mappings) {
        if (m.purpose === 'DEFERRED_REVENUE') deferredAccount = m.account_code;
        if (m.purpose === 'RECOGNIZED_REVENUE') revenueAccount = m.account_code;
      }

      // 2. If unmapped, verify account presence in chart_of_accounts or fall back to default
      const { rows: coa } = await pool.query(
        `SELECT account_code, account_subtype, account_type
           FROM chart_of_accounts
          WHERE company_id = $1 AND status = 'ACTIVE'
          ORDER BY account_code ASC`,
        [companyId]
      );

      for (const row of coa) {
        if (row.account_subtype === 'DEFERRED_REVENUE' && deferredAccount === '2200') {
          deferredAccount = row.account_code;
        }
        if (row.account_type === 'REVENUE' && revenueAccount === '4100') {
          revenueAccount = row.account_code;
        }
      }
    }

    return { deferredAccount, revenueAccount };
  }

  /**
   * Create an amortization schedule for contract or subscription revenue over N months.
   */
  static async createSchedule(
    { salesOrderId, customerInvoiceId, totalAmount, startDate, monthsCount = 12 },
    companyId = currentCompanyId()
  ) {
    const monthlyAmount = Number((totalAmount / monthsCount).toFixed(2));
    const schedules = [];

    const start = new Date(startDate || Date.now());
    for (let i = 0; i < monthsCount; i++) {
      const periodDate = new Date(start.getFullYear(), start.getMonth() + i, 1);
      const periodDateStr = periodDate.toISOString().split('T')[0];

      const { rows } = await pool.query(
        `INSERT INTO revenue_schedules (sales_order_id, customer_invoice_id, period_date, amount, status, company_id)
         VALUES ($1, $2, $3, $4, 'SCHEDULED', COALESCE($5, public.current_company_id()))
         RETURNING *`,
        [salesOrderId || null, customerInvoiceId || null, periodDateStr, monthlyAmount, companyId]
      );
      schedules.push(rows[0]);
    }

    return schedules;
  }

  /**
   * Process and post due deferred revenue recognition entries:
   * Dr Deferred Revenue / Cr Sales Revenue
   */
  static async recognizeDueRevenue(
    asOfDate = new Date().toISOString().split('T')[0],
    userId = null,
    companyId = currentCompanyId()
  ) {
    const params = [asOfDate];
    let companyFilter = '';
    if (companyId) {
      companyFilter = 'AND company_id = $2';
      params.push(companyId);
    }

    const { rows: dueSchedules } = await pool.query(
      `SELECT * FROM revenue_schedules
        WHERE status = 'SCHEDULED'
          AND period_date <= $1 ${companyFilter}`,
      params
    );

    const processed = [];
    for (const item of dueSchedules) {
      const targetCompany = item.company_id || companyId;
      const { deferredAccount, revenueAccount } = await this.resolveAccounts(targetCompany);

      // Post GL entry: Dr Deferred Revenue / Cr Revenue
      // Idempotency: posting_key prevents duplicate postings under concurrency/re-runs
      const entry = await JournalEntry.create({
        entry_date: item.period_date,
        description: `Deferred Revenue Recognition for schedule ${item.id}`,
        source_type: 'REVENUE_SCHEDULE',
        source_id: item.id,
        posting_key: `REVENUE_RECOGNITION:${item.id}`,
        company_id: targetCompany,
        items: [
          { account_number: deferredAccount, debit: item.amount, credit: 0, description: 'Deferred Revenue Clearing' },
          { account_number: revenueAccount, debit: 0, credit: item.amount, description: 'Recognized Sales Revenue' },
        ],
      }, userId);


      await JournalEntry.post(entry.id, userId);

      await pool.query(
        `UPDATE revenue_schedules
            SET status = 'RECOGNIZED', journal_entry_id = $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2`,
        [entry.id, item.id]
      );

      processed.push(item.id);
    }

    return {
      success: true,
      processed_count: processed.length,
      schedule_ids: processed,
    };
  }
}

module.exports = RevenueRecognitionService;

