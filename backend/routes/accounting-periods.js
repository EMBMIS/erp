const express = require('express');
const router = express.Router();
const AccountingPeriod = require('../models/AccountingPeriod');
const { auth, requireManagerOrAdmin } = require('../middleware/auth');
const { pool } = require('../config/database');

// GET /accounting-periods
router.get('/', auth, async (req, res) => {
  try {
    const periods = await AccountingPeriod.findAll(req.query.year ? parseInt(req.query.year, 10) : null);
    res.json({ success: true, data: periods });
  } catch (error) {
    console.error('List accounting periods error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /accounting-periods/:year/:month/pre-close-checks
//
// Where a month stands, read-only. The same ten gates POST /close runs, but
// without the close: nothing is written, no period row is created, and the
// caller needs no manager role to look — deciding whether to attempt a close
// is not the same act as attempting one, and a finance screen that reports
// readiness should not be the thing that makes a period exist.
//
// Answers the checks verbatim plus a rollup, so a caller can render progress
// without re-deriving the severity rules.
// ---------------------------------------------------------------------------
router.get('/:year/:month/pre-close-checks', auth, async (req, res) => {
  const year = parseInt(req.params.year, 10);
  const month = parseInt(req.params.month, 10);
  if (!Number.isInteger(year) || year < 1970 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12) {
    return res.status(400).json({ success: false, error: 'A valid year and month (1-12) are required.' });
  }

  try {
    const PeriodCloseService = require('../services/periodCloseService');
    // The caller's company, as resolved by the auth middleware. (This read
    // req.user.company_id, which the token does not carry, so it passed null and
    // the checklist ran against the platform's first company instead.)
    const companyId = req.companyId;
    const result = await PeriodCloseService.validatePreCloseChecksForMonth(year, month, companyId);

    // The period row is reported if it happens to exist, so a caller can tell
    // "open and 80% ready" from "already closed" — but its absence is a normal
    // answer, not an error.
    const { rows } = await pool.query(
      `SELECT id, status, closed_at FROM accounting_periods
        WHERE period_year = $1 AND period_month = $2
          AND ($3::uuid IS NULL OR company_id = $3)
        LIMIT 1`,
      [year, month, companyId]
    );

    const passed = result.checks.filter((c) => c.passed).length;
    res.json({
      success: true,
      data: {
        year,
        month,
        period: rows[0] || null,
        checks: result.checks,
        passed,
        total: result.checks.length,
        blocking_passed: result.blocking_passed,
        all_passed: result.all_passed,
        evaluated_at: result.evaluated_at,
      },
    });
  } catch (error) {
    console.error('Pre-close checks error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// POST /accounting-periods/close — close a period with automated P&L closing
//
// Generates a journal entry that zeroes all REVENUE and EXPENSE accounts into
// Retained Earnings (3200), then flips the period to CLOSED. The closing entry
// is auto-posted and linked back to the period via closing_entry_id.
//
// Was broken outright: it upserted with `ON CONFLICT (period_year,
// period_month)`, a target migration 202608130100 removed when
// accounting_periods became company-scoped — replaced by a partial unique
// index on (company_id, period_year, period_month). Postgres refuses an
// ON CONFLICT clause that names no matching constraint/index, so every call
// to this endpoint threw. It also ran only one gate (unposted entries in the
// period, itself unscoped by company) before flipping status, silently
// skipping every other pre-close check this codebase already has —
// negative inventory, AR/AP/inventory <-> GL ties, GR/IR mismatches — the
// real, tested gate `PeriodCloseService.validatePreCloseChecks` enforces at
// /financial-reports/period-close/close. Both are fixed here: the upsert
// targets the real composite key, and the same BLOCKING checks now gate this
// endpoint's close too (this endpoint does not collect PeriodCloseService's
// per-item sign-off checklist, so it is a gate, not the full audited flow —
// see ERP_PRODUCT_EVALUATION.md §27 for that distinction).
// ---------------------------------------------------------------------------
router.post('/close', auth, requireManagerOrAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { year, month, notes } = req.body;
    if (!year || !month || month < 1 || month > 12) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Valid year and month (1-12) required.' });
    }

    // The caller's company (auth middleware). Picking "the default company, else
    // the oldest" here closed the platform's first company's period for every
    // tenant, which row-level security then refused with a 500 for all but one.
    const companyId = req.companyId;
    if (!companyId) {
      await client.query('ROLLBACK');
      return res.status(500).json({ success: false, error: 'No company found.' });
    }

    const periodResult = await client.query(
      `INSERT INTO accounting_periods (company_id, period_year, period_month, status)
       VALUES ($1, $2, $3, 'OPEN')
       ON CONFLICT (company_id, period_year, period_month) WHERE company_id IS NOT NULL
       DO UPDATE SET updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [companyId, year, month]
    );
    const period = periodResult.rows[0];
    if (period.status === 'CLOSED') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: `Period ${year}-${String(month).padStart(2, '0')} is already CLOSED.` });
    }

    // 1. The real pre-close gate: every BLOCKING check in PeriodCloseService
    //    must pass (unposted entries, negative inventory, AR/AP/inventory GL
    //    ties, ...) — not just the single unposted-entries count this
    //    endpoint used to check alone.
    const PeriodCloseService = require('../services/periodCloseService');
    const validation = await PeriodCloseService.validatePreCloseChecks(period.id, companyId);
    const blockingFailures = validation.checks.filter((c) => c.severity === 'BLOCKING' && !c.passed);
    if (blockingFailures.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        error: `Cannot close period ${year}-${String(month).padStart(2, '0')}: ${blockingFailures.length} blocking check(s) failed — ` +
          blockingFailures.map((c) => `${c.name} (${c.details})`).join('; '),
        checks: validation.checks,
      });
    }

    // 2. Compute P&L account balances for this period.
    const { rows: balances } = await client.query(
      `SELECT coa.id AS account_id, coa.account_code, coa.account_name, coa.account_type,
              COALESCE(SUM(jel.credit_amount - jel.debit_amount), 0)::numeric(15,2) AS balance
         FROM chart_of_accounts coa
         JOIN journal_entry_items jel ON jel.account_id = coa.id
         JOIN journal_entries je ON jel.journal_entry_id = je.id
        WHERE coa.account_type IN ('REVENUE', 'EXPENSE')
          AND coa.status = 'ACTIVE' AND coa.deleted_at IS NULL
          AND je.status = 'POSTED' AND je.deleted_at IS NULL
          AND EXTRACT(YEAR FROM je.entry_date) = $1
          AND EXTRACT(MONTH FROM je.entry_date) = $2
        GROUP BY coa.id, coa.account_code, coa.account_name, coa.account_type
       HAVING COALESCE(SUM(jel.credit_amount - jel.debit_amount), 0) <> 0
        ORDER BY coa.account_type, coa.account_code`,
      [year, month]
    );

    if (balances.length === 0) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        success: false,
        error: `No posted P&L activity found in ${year}-${String(month).padStart(2, '0')}. Nothing to close.`,
      });
    }

    // 3. Find Retained Earnings account.
    const reResult = await client.query(
      `SELECT id FROM chart_of_accounts WHERE account_code = '3200' AND status = 'ACTIVE' AND deleted_at IS NULL`
    );
    if (reResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(500).json({ success: false, error: 'Retained Earnings account (3200) not found.' });
    }
    const reAccountId = reResult.rows[0].id;

    // 4. Build closing entry lines.
    const lines = [];
    let totalRevenue = 0, totalExpense = 0;

    for (const acct of balances) {
      const bal = Number(acct.balance);
      if (acct.account_type === 'REVENUE') {
        // Revenue has credit balance — debit to zero it out.
        lines.push({
          account_id: acct.account_id,
          debit_amount: bal > 0 ? bal : 0,
          credit_amount: bal < 0 ? Math.abs(bal) : 0,
          description: `Close ${acct.account_code} ${acct.account_name} (${bal > 0 ? 'Dr' : 'Cr'} ${Math.abs(bal).toFixed(2)})`,
        });
        totalRevenue += bal;
      } else {
        // Expense has debit balance — credit to zero it out.
        lines.push({
          account_id: acct.account_id,
          debit_amount: bal < 0 ? Math.abs(bal) : 0,
          credit_amount: bal > 0 ? bal : 0,
          description: `Close ${acct.account_code} ${acct.account_name} (${bal > 0 ? 'Dr' : 'Cr'} ${Math.abs(bal).toFixed(2)})`,
        });
        totalExpense += bal;
      }
    }

    // Balancing line to Retained Earnings.
    const netIncome = Math.round((totalRevenue - totalExpense) * 100) / 100;
    if (netIncome > 0) {
      lines.push({
        account_id: reAccountId,
        debit_amount: 0,
        credit_amount: netIncome,
        description: `Net income for ${year}-${String(month).padStart(2, '0')} → Retained Earnings`,
      });
    } else if (netIncome < 0) {
      lines.push({
        account_id: reAccountId,
        debit_amount: Math.abs(netIncome),
        credit_amount: 0,
        description: `Net loss for ${year}-${String(month).padStart(2, '0')} → Retained Earnings`,
      });
    }

    // 5. Create and post the closing journal entry.
    const JournalEntry = require('../models/JournalEntry');
    const closeEntry = await JournalEntry.create({
      entry_date: new Date(year, month - 1, 1).toISOString().split('T')[0],
      source_type: 'YEAR_END_CLOSE',
      description: `Period close — ${year}-${String(month).padStart(2, '0')} P&L to Retained Earnings`,
      reference: `CLOSE-${year}-${String(month).padStart(2, '0')}`,
      requires_approval: false,
    }, lines, req.user.id);
    await JournalEntry.postAsSystem(closeEntry.id, req.user.id, 'Auto-posted period-close entry');

    // 6. Close the period (the row already exists — it was fetched/created,
    //    OPEN, at the top of this handler) and link the closing entry.
    await client.query(
      `UPDATE accounting_periods
          SET status = 'CLOSED', closed_by = $1, closed_at = CURRENT_TIMESTAMP,
              closing_entry_id = $2, notes = COALESCE(notes, '') || '; ' || COALESCE($3, ''),
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $4`,
      [req.user.id, closeEntry.id, notes || null, period.id]
    );

    const { appendAuditRecord } = require('../services/auditTrailService');
    await appendAuditRecord({
      entity_type: 'ACCOUNTING_PERIOD',
      entity_id: period.id,
      from_status: 'OPEN',
      to_status: 'CLOSED',
      changed_by: req.user.id,
      reason: notes || `Period ${year}-${String(month).padStart(2, '0')} closed with automated P&L close to Retained Earnings.`,
      company_id: companyId,
    }, { client });

    await client.query('COMMIT');

    res.json({
      success: true,
      data: {
        period: `${year}-${String(month).padStart(2, '0')}`,
        status: 'CLOSED',
        closing_entry_id: closeEntry.id,
        summary: {
          total_revenue: Math.round(totalRevenue * 100) / 100,
          total_expenses: Math.round(totalExpense * 100) / 100,
          net_income: netIncome,
          accounts_closed: balances.length,
        },
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Close period error:', error);
    res.status(400).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// POST /accounting-periods/reopen — reopen a period and reverse its closing entry
//
// A documented `reason` is MANDATORY (audit compliance) and is written to the
// hash-chained audit log. The period is flipped to OPEN BEFORE the closing
// entry is reversed: the database hard lock (fn_guard_closed_period_posting)
// refuses any INSERT/UPDATE on journal entries dated into a CLOSED period, so
// the reversal can only run after the reopen.
// ---------------------------------------------------------------------------
router.post('/reopen', auth, requireManagerOrAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { year, month, notes } = req.body;
    const reason = (req.body.reason || notes || '').trim();
    if (!year || !month || month < 1 || month > 12) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Valid year and month (1-12) required.' });
    }
    if (!reason) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'A reopen reason is required for audit compliance.' });
    }

    // The caller's company (auth middleware), not the platform's first company.
    const companyId = req.companyId;

    // Find the period and its closing entry, scoped to this company —
    // matching by (year, month) alone would reopen a different tenant's
    // period of the same name.
    const periodResult = await client.query(
      'SELECT * FROM accounting_periods WHERE period_year = $1 AND period_month = $2 AND company_id IS NOT DISTINCT FROM $3',
      [year, month, companyId]
    );
    if (periodResult.rows.length === 0 || periodResult.rows[0].status !== 'CLOSED') {
      await client.query('ROLLBACK');
      return res.status(422).json({ success: false, error: 'Period is not closed.' });
    }
    const period = periodResult.rows[0];

    // 1. Reopen FIRST (the DB hard lock refuses entries dated into a CLOSED
    //    period, and the reversal below is dated into it).
    await client.query(
      `UPDATE accounting_periods
          SET status = 'OPEN', closing_entry_id = NULL, closed_by = NULL, closed_at = NULL,
              notes = COALESCE(notes, '') || '; REOPENED: ' || $2,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [period.id, reason]
    );

    // 2. Write the hash-chained audit record for the reopen.
    const { appendAuditRecord } = require('../services/auditTrailService');
    await appendAuditRecord({
      entity_type: 'ACCOUNTING_PERIOD',
      entity_id: period.id,
      from_status: 'CLOSED',
      to_status: 'OPEN',
      changed_by: req.user.id,
      reason,
      company_id: period.company_id,
    }, { client });

    // 3. Reverse the closing entry if one exists.
    if (period.closing_entry_id) {
      const JournalEntry = require('../models/JournalEntry');
      const reversal = await JournalEntry.reverse(period.closing_entry_id, req.user.id, `Reopen period ${year}-${String(month).padStart(2, '0')}: ${reason}`);
      await JournalEntry.postAsSystem(reversal.id, req.user.id, 'Auto-posted period-reopen reversal');
    }

    await client.query('COMMIT');
    res.json({ success: true, data: { period: `${year}-${String(month).padStart(2, '0')}`, status: 'OPEN', reason } });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Reopen period error:', error);
    res.status(400).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

module.exports = router;
