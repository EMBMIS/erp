/**
 * Automated Period-Close Validation & Sign-Off Service.
 *
 * ROADMAP_TO_10 Task 17 (F2): a close that can't refuse isn't a close.
 *
 *  - validatePreCloseChecks(): ten pre-close gates. Each returns
 *    severity 'BLOCKING' (the close is refused) or 'WARNING' (recorded and
 *    acknowledged on the sign-off checklist, close may proceed):
 *      1. unposted_journal_entries    — DRAFT/PENDING/APPROVED entries in the period (BLOCKING)
 *      2. bank_reconciliation         — unreconciled bank transactions (WARNING)
 *      3. negative_inventory          — negative stock on hand (BLOCKING)
 *      4. grir_received_not_invoiced  — goods received, not yet invoiced (WARNING)
 *      5. grir_invoiced_not_received  — invoiced, not yet received (WARNING)
 *      6. ar_gl_tie                   — AR aging vs AR control account (BLOCKING)
 *      7. ap_gl_tie                   — AP aging vs AP control account (BLOCKING)
 *      8. inventory_gl_tie            — inventory valuation vs inventory control (BLOCKING)
 *      9. fx_revaluation              — multicurrency activity without a revaluation entry (WARNING)
 *     10. depreciation_posted         — active assets not depreciated through the period (WARNING)
 *    Checks 6-8 are the ones that actually catch problems: the sub-ledger and
 *    the general ledger must agree at close time.
 *
 *  - closePeriod(): refuses when any BLOCKING check fails, requires every
 *    checklist item (named owner + sign-off) to be signed, persists the
 *    checklist to period_close_checklist, flips the period to CLOSED and
 *    appends a hash-chained audit record. The actual refusal for any LATER
 *    posting into the closed period is enforced at the database layer by
 *    trigger fn_guard_closed_period_posting (migration
 *    202608020900_period_close_hard_lock.sql) — this service is the gate, the
 *    trigger is the lock.
 *
 *  - reopenPeriod(): requires a documented reason and writes a hash-chained
 *    audit record before flipping the period back to OPEN.
 */

const { pool } = require('../config/database');
const { currentCompanyId } = require('./companyContext');
const { appendAuditRecord } = require('./auditTrailService');

// The pre-close gates: key (stable identifier), display name, severity and
// the NAMED OWNER responsible for clearing the check or signing it off.
const PRE_CLOSE_CHECKS = [
  { key: 'unposted_journal_entries', name: 'Unposted journal entries in the period', severity: 'BLOCKING', owner: 'GL Accountant' },
  { key: 'bank_reconciliation', name: 'Unreconciled bank transactions', severity: 'WARNING', owner: 'Treasury Analyst' },
  { key: 'negative_inventory', name: 'Negative inventory on hand', severity: 'BLOCKING', owner: 'Inventory Controller' },
  { key: 'grir_received_not_invoiced', name: 'GR/IR unmatched — goods received not invoiced', severity: 'WARNING', owner: 'AP Accountant' },
  { key: 'grir_invoiced_not_received', name: 'GR/IR unmatched — invoiced not received', severity: 'WARNING', owner: 'AP Accountant' },
  { key: 'ar_gl_tie', name: 'Sub-ledger ↔ GL tie — AR aging vs AR control account', severity: 'BLOCKING', owner: 'AR Accountant' },
  { key: 'ap_gl_tie', name: 'Sub-ledger ↔ GL tie — AP aging vs AP control account', severity: 'BLOCKING', owner: 'AP Accountant' },
  { key: 'inventory_gl_tie', name: 'Sub-ledger ↔ GL tie — inventory valuation vs inventory control', severity: 'BLOCKING', owner: 'Inventory Controller' },
  { key: 'fx_revaluation', name: 'FX revaluation run for multicurrency activity', severity: 'WARNING', owner: 'Treasury Analyst' },
  { key: 'depreciation_posted', name: 'Depreciation posted for the period', severity: 'WARNING', owner: 'Fixed Asset Accountant' },
];

/** Fallback company: the default company (tests and scripts have no request context). */
async function resolveCompanyId(companyId) {
  // A caller may pass null explicitly, which skips the currentCompanyId()
  // parameter default; the ambient company still comes before the fallback.
  if (companyId) return companyId;
  const ambient = currentCompanyId();
  if (ambient) return ambient;
  const { rows } = await pool.query(
    'SELECT id FROM companies WHERE deleted_at IS NULL ORDER BY is_default DESC, created_at LIMIT 1'
  );
  return rows[0]?.id || null;
}

/** [start, end) ISO dates covering a month, e.g. 2099-12-01 → 2100-01-01. */
function periodBounds(year, month) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const end = month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  return { start, end };
}

async function getPeriod(periodId, companyId) {
  const { rows } = await pool.query(
    'SELECT * FROM accounting_periods WHERE id = $1 AND company_id = $2',
    [periodId, companyId]
  );
  return rows[0] || null;
}

/** Balance of the mapped control account for a company, or null when unmapped. */
async function controlAccount(companyId, purpose) {
  const { rows } = await pool.query(
    `SELECT coa.account_code, coa.normal_balance, coa.current_balance
       FROM company_gl_mappings m
       JOIN chart_of_accounts coa
         ON coa.account_code = m.account_code AND coa.company_id = m.company_id
      WHERE m.company_id = $1 AND m.purpose = $2
        AND coa.deleted_at IS NULL
      LIMIT 1`,
    [companyId, purpose]
  );
  return rows[0] || null;
}

/**
 * Run automated pre-close checks for a given period & company.
 * @returns {Promise<{all_passed: boolean, blocking_passed: boolean, checks: Array, evaluated_at: string}>}
 */
async function validatePreCloseChecks(periodId, companyId = currentCompanyId()) {
  companyId = await resolveCompanyId(companyId);
  const period = await getPeriod(periodId, companyId);
  if (!period) throw new Error('Accounting period not found for this company.');
  return runPreCloseChecks(period.period_year, period.period_month, companyId);
}

/**
 * The same gates, addressed by calendar month instead of by period row.
 *
 * The checks only ever read the period for its year and month — every query
 * below is bounded by dates, not by a period id — so a caller that wants to
 * see where a month stands does not need a period row to exist yet. That
 * matters for the read path: a screen asking "how close are we?" must not
 * bring the period into being as a side effect of being looked at.
 */
async function validatePreCloseChecksForMonth(year, month, companyId = currentCompanyId()) {
  companyId = await resolveCompanyId(companyId);
  return runPreCloseChecks(year, month, companyId);
}

async function runPreCloseChecks(year, month, companyId) {
  const { start, end } = periodBounds(year, month);
  const checks = [];

  // Check 1: Unposted journal entries in the period (BLOCKING)
  {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM journal_entries
        WHERE company_id = $1 AND deleted_at IS NULL
          AND period_year = $2 AND period_month = $3
          AND status NOT IN ('POSTED', 'CANCELLED')`,
      [companyId, year, month]
    );
    const cnt = rows[0]?.cnt || 0;
    checks.push({
      key: 'unposted_journal_entries',
      name: 'Unposted journal entries in the period',
      severity: 'BLOCKING',
      passed: cnt === 0,
      details: `${cnt} unposted journal entr${cnt === 1 ? 'y' : 'ies'} in ${year}-${String(month).padStart(2, '0')}.`
    });
  }

  // Check 2: Unreconciled bank transactions (WARNING)
  {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM bank_transactions
        WHERE company_id = $1 AND deleted_at IS NULL
          AND is_reconciled = false
          AND transaction_date >= $2::date AND transaction_date < $3::date`,
      [companyId, start, end]
    );
    const cnt = rows[0]?.cnt || 0;
    checks.push({
      key: 'bank_reconciliation',
      name: 'Unreconciled bank transactions',
      severity: 'WARNING',
      passed: cnt === 0,
      details: `${cnt} unreconciled bank transaction(s) in ${year}-${String(month).padStart(2, '0')}.`
    });
  }

  // Check 3: Negative inventory on hand (BLOCKING)
  {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM inventory_items
        WHERE company_id = $1 AND current_stock_quantity < 0`,
      [companyId]
    );
    const cnt = rows[0]?.cnt || 0;
    checks.push({
      key: 'negative_inventory',
      name: 'Negative inventory on hand',
      severity: 'BLOCKING',
      passed: cnt === 0,
      details: `${cnt} inventory item(s) with negative stock balance.`
    });
  }

  // Check 4: GR/IR — goods received this period but not invoiced (WARNING)
  {
    const { rows } = await pool.query(
      `WITH received AS (
         SELECT gr.po_id, SUM(gr.quantity_received) AS qty
           FROM goods_receipts gr
          WHERE gr.company_id = $1
            AND gr.received_date >= $2::date AND gr.received_date < $3::date
          GROUP BY gr.po_id
       ),
       invoiced AS (
         SELECT si.purchase_order_id AS po_id, SUM(sii.quantity) AS qty
           FROM supplier_invoices si
           JOIN supplier_invoice_items sii ON sii.bill_id = si.id
          WHERE si.company_id = $1 AND si.deleted_at IS NULL
            AND si.status NOT IN ('CANCELLED', 'VOID', 'REJECTED')
          GROUP BY si.purchase_order_id
       )
       SELECT COUNT(*)::int AS cnt
         FROM received r
         LEFT JOIN invoiced i ON i.po_id = r.po_id
        WHERE COALESCE(r.qty, 0) > COALESCE(i.qty, 0) + 0.001`,
      [companyId, start, end]
    );
    const cnt = rows[0]?.cnt || 0;
    checks.push({
      key: 'grir_received_not_invoiced',
      name: 'GR/IR unmatched — goods received not invoiced',
      severity: 'WARNING',
      passed: cnt === 0,
      details: `${cnt} purchase order(s) with goods received in ${year}-${String(month).padStart(2, '0')} that are not fully invoiced.`
    });
  }

  // Check 5: GR/IR — invoiced this period but not received (WARNING)
  {
    const { rows } = await pool.query(
      `WITH invoiced AS (
         SELECT si.purchase_order_id AS po_id, SUM(sii.quantity) AS qty
           FROM supplier_invoices si
           JOIN supplier_invoice_items sii ON sii.bill_id = si.id
          WHERE si.company_id = $1 AND si.deleted_at IS NULL
            AND si.status NOT IN ('CANCELLED', 'VOID', 'REJECTED')
            AND si.invoice_date >= $2::date AND si.invoice_date < $3::date
          GROUP BY si.purchase_order_id
       ),
       received AS (
         SELECT gr.po_id, SUM(gr.quantity_received) AS qty
           FROM goods_receipts gr
          WHERE gr.company_id = $1
          GROUP BY gr.po_id
       )
       SELECT COUNT(*)::int AS cnt
         FROM invoiced i
         LEFT JOIN received r ON r.po_id = i.po_id
        WHERE COALESCE(i.qty, 0) > COALESCE(r.qty, 0) + 0.001`,
      [companyId, start, end]
    );
    const cnt = rows[0]?.cnt || 0;
    checks.push({
      key: 'grir_invoiced_not_received',
      name: 'GR/IR unmatched — invoiced not received',
      severity: 'WARNING',
      passed: cnt === 0,
      details: `${cnt} supplier invoice(s) in ${year}-${String(month).padStart(2, '0')} that exceed what has been received.`
    });
  }

  // Check 6: Sub-ledger ↔ GL tie — AR aging vs AR control account (BLOCKING)
  {
    const [aging, control] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(outstanding_amount), 0)::numeric(15,2) AS total
           FROM customer_invoices
          WHERE company_id = $1 AND deleted_at IS NULL
            AND status NOT IN ('PAID', 'CANCELLED')`,
        [companyId]
      ),
      controlAccount(companyId, 'AR_CONTROL')
    ]);
    const agingTotal = Number(aging.rows[0].total);
    if (!control) {
      checks.push({
        key: 'ar_gl_tie',
        name: 'Sub-ledger ↔ GL tie — AR aging vs AR control account',
        severity: 'BLOCKING',
        passed: false,
        details: 'AR control account is not mapped (company_gl_mappings purpose AR_CONTROL). Configure it before closing.'
      });
    } else {
      const glTotal = Number(control.current_balance);
      const diff = Math.abs(agingTotal - glTotal);
      checks.push({
        key: 'ar_gl_tie',
        name: 'Sub-ledger ↔ GL tie — AR aging vs AR control account',
        severity: 'BLOCKING',
        passed: diff <= 0.01,
        details: `AR aging $${agingTotal.toFixed(2)} vs AR control ${control.account_code} $${glTotal.toFixed(2)} (difference $${diff.toFixed(2)}).`
      });
    }
  }

  // Check 7: Sub-ledger ↔ GL tie — AP aging vs AP control account (BLOCKING)
  {
    const [aging, control] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(outstanding_amount), 0)::numeric(15,2) AS total
           FROM supplier_invoices
          WHERE company_id = $1 AND deleted_at IS NULL
            AND status NOT IN ('PAID', 'CANCELLED')`,
        [companyId]
      ),
      controlAccount(companyId, 'AP_CONTROL')
    ]);
    const agingTotal = Number(aging.rows[0].total);
    if (!control) {
      checks.push({
        key: 'ap_gl_tie',
        name: 'Sub-ledger ↔ GL tie — AP aging vs AP control account',
        severity: 'BLOCKING',
        passed: false,
        details: 'AP control account is not mapped (company_gl_mappings purpose AP_CONTROL). Configure it before closing.'
      });
    } else {
      const glTotal = Number(control.current_balance);
      const diff = Math.abs(agingTotal - glTotal);
      checks.push({
        key: 'ap_gl_tie',
        name: 'Sub-ledger ↔ GL tie — AP aging vs AP control account',
        severity: 'BLOCKING',
        passed: diff <= 0.01,
        details: `AP aging $${agingTotal.toFixed(2)} vs AP control ${control.account_code} $${glTotal.toFixed(2)} (difference $${diff.toFixed(2)}).`
      });
    }
  }

  // Check 8: Sub-ledger ↔ GL tie — inventory valuation vs inventory control (BLOCKING)
  {
    const [valuation, control] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(current_stock_quantity * COALESCE(unit_price, 0)), 0)::numeric(15,2) AS total
           FROM inventory_items
          WHERE company_id = $1`,
        [companyId]
      ),
      controlAccount(companyId, 'INVENTORY_CONTROL')
    ]);
    const valuationTotal = Number(valuation.rows[0].total);
    if (!control) {
      checks.push({
        key: 'inventory_gl_tie',
        name: 'Sub-ledger ↔ GL tie — inventory valuation vs inventory control',
        severity: 'BLOCKING',
        passed: false,
        details: 'Inventory control account is not mapped (company_gl_mappings purpose INVENTORY_CONTROL). Configure it before closing.'
      });
    } else {
      const glTotal = Number(control.current_balance);
      const diff = Math.abs(valuationTotal - glTotal);
      checks.push({
        key: 'inventory_gl_tie',
        name: 'Sub-ledger ↔ GL tie — inventory valuation vs inventory control',
        severity: 'BLOCKING',
        passed: diff <= 0.01,
        details: `Inventory valuation $${valuationTotal.toFixed(2)} vs inventory control ${control.account_code} $${glTotal.toFixed(2)} (difference $${diff.toFixed(2)}).`
      });
    }
  }

  // Check 9: FX revaluation — multicurrency activity without a revaluation entry (WARNING)
  {
    const base = await pool.query(
      'SELECT base_currency FROM companies WHERE id = $1',
      [companyId]
    );
    const baseCurrency = base.rows[0]?.base_currency || 'USD';
    const [mc, reval] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS cnt FROM journal_entries
          WHERE company_id = $1 AND deleted_at IS NULL AND status = 'POSTED'
            AND period_year = $2 AND period_month = $3
            AND (currency IS DISTINCT FROM $4 OR exchange_rate IS DISTINCT FROM 1)`,
        [companyId, year, month, baseCurrency]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS cnt FROM journal_entries
          WHERE company_id = $1 AND deleted_at IS NULL AND status = 'POSTED'
            AND period_year = $2 AND period_month = $3
            AND (reference ILIKE '%FX-REVAL%' OR reference ILIKE '%FX_REVAL%' OR description ILIKE '%fx revalu%')`,
        [companyId, year, month]
      )
    ]);
    const mcCount = mc.rows[0]?.cnt || 0;
    const revalCount = reval.rows[0]?.cnt || 0;
    checks.push({
      key: 'fx_revaluation',
      name: 'FX revaluation run for multicurrency activity',
      severity: 'WARNING',
      passed: mcCount === 0 || revalCount > 0,
      details: mcCount === 0
        ? 'No multicurrency activity in the period.'
        : `${mcCount} multicurrency posting(s) in the period; ${revalCount} FX revaluation posting(s) found (reference FX-REVAL…).`
    });
  }

  // Check 10: Depreciation — active assets not depreciated through the period (WARNING)
  {
    const [assets, postings] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS cnt FROM fixed_assets
          WHERE company_id = $1 AND deleted_at IS NULL AND status = 'ACTIVE'
            AND (last_depreciation_date IS NULL OR last_depreciation_date < $2::date)`,
        [companyId, start]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS cnt FROM journal_entries
          WHERE company_id = $1 AND deleted_at IS NULL AND status = 'POSTED'
            AND source_type = 'DEPRECIATION'
            AND period_year = $2 AND period_month = $3`,
        [companyId, year, month]
      )
    ]);
    const assetCount = assets.rows[0]?.cnt || 0;
    const postingCount = postings.rows[0]?.cnt || 0;
    checks.push({
      key: 'depreciation_posted',
      name: 'Depreciation posted for the period',
      severity: 'WARNING',
      passed: assetCount === 0 || postingCount > 0,
      details: assetCount === 0
        ? 'No active fixed assets awaiting depreciation.'
        : `${assetCount} active asset(s) not depreciated through ${year}-${String(month).padStart(2, '0')}; ${postingCount} depreciation posting(s) in the period.`
    });
  }

  const blocking = checks.filter((c) => c.severity === 'BLOCKING');
  return {
    all_passed: checks.every((c) => c.passed),
    blocking_passed: blocking.every((c) => c.passed),
    checks,
    evaluated_at: new Date().toISOString()
  };
}

/**
 * Build the sign-off checklist for the pre-close checks: one line per gate
 * with its NAMED OWNER. `signed: true` must be supplied by the caller for
 * every line before closePeriod() will proceed.
 */
function buildChecklist() {
  return PRE_CLOSE_CHECKS.map((cfg) => ({
    check_key: cfg.key,
    check_name: cfg.name,
    severity: cfg.severity,
    owner: cfg.owner,
    signed: false
  }));
}

/**
 * Close a period behind real gates.
 *
 * @param {string} periodId
 * @param {string} userId
 * @param {string|null} [companyId]
 * @param {object} [options]
 * @param {Array<{check_key: string, owner?: string, signed: boolean}>} [options.checklist]
 *   sign-offs for every check; unsigned items refuse the close.
 * @param {string} [options.reason] documented reason, recorded in the audit chain.
 */
async function closePeriod(periodId, userId, companyId = currentCompanyId(), options = {}) {
  companyId = await resolveCompanyId(companyId);
  const period = await getPeriod(periodId, companyId);
  if (!period) throw new Error('Accounting period not found for this company.');
  if (period.status !== 'OPEN') throw new Error(`Period ${period.period_year}-${period.period_month} is not OPEN (status: ${period.status}).`);

  const result = await validatePreCloseChecks(periodId, companyId);
  const byKey = new Map(result.checks.map((c) => [c.key, c]));

  const blockingFailures = result.checks.filter((c) => c.severity === 'BLOCKING' && !c.passed);
  if (blockingFailures.length > 0) {
    const error = new Error(
      `Cannot close period ${period.period_year}-${String(period.period_month).padStart(2, '0')}: ` +
      `${blockingFailures.length} blocking check(s) failed — ` +
      blockingFailures.map((c) => `${c.name} (${c.details})`).join('; ')
    );
    error.code = 'PZ-4002';
    error.checks = result.checks;
    throw error;
  }

  // Sign-off checklist: every item must be signed by the closing user.
  const supplied = new Map((options.checklist || []).map((c) => [c.check_key, c]));
  const unsigned = PRE_CLOSE_CHECKS.filter((cfg) => !(supplied.get(cfg.key) || {}).signed);
  if (unsigned.length > 0) {
    const error = new Error(
      `Cannot close period ${period.period_year}-${String(period.period_month).padStart(2, '0')}: ` +
      `${unsigned.length} checklist item(s) not signed off — ${unsigned.map((c) => c.key).join(', ')}`
    );
    error.code = 'PZ-4003';
    throw error;
  }

  const signedAt = new Date();
  const checklistRows = PRE_CLOSE_CHECKS.map((cfg) => ({
    check_key: cfg.key,
    check_name: cfg.name,
    severity: cfg.severity,
    passed: byKey.get(cfg.key).passed,
    owner: (supplied.get(cfg.key) || {}).owner || cfg.owner,
    signed_by: userId,
    signed_at: signedAt
  }));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE accounting_periods
          SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP, closed_by = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2 AND company_id = $3 AND status = 'OPEN'
        RETURNING *`,
      [userId, periodId, companyId]
    );
    if (!rows[0]) {
      throw new Error('Period could not be closed (not found, or not OPEN).');
    }

    await client.query('DELETE FROM period_close_checklist WHERE period_id = $1', [periodId]);
    for (const row of checklistRows) {
      await client.query(
        `INSERT INTO period_close_checklist
           (period_id, company_id, check_key, check_name, severity, passed, owner, signed_by, signed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [periodId, companyId, row.check_key, row.check_name, row.severity, row.passed, row.owner, row.signed_by, row.signed_at]
      );
    }

    await appendAuditRecord({
      entity_type: 'ACCOUNTING_PERIOD',
      entity_id: periodId,
      from_status: 'OPEN',
      to_status: 'CLOSED',
      changed_by: userId,
      reason: options.reason || `Period ${period.period_year}-${String(period.period_month).padStart(2, '0')} closed after pre-close validation (${result.checks.filter((c) => !c.passed).length} open warning(s)).`,
      company_id: companyId
    }, { client });

    await client.query('COMMIT');

    return {
      success: true,
      period: rows[0],
      checks: result.checks,
      checklist: checklistRows,
      warnings: result.checks.filter((c) => c.severity === 'WARNING' && !c.passed)
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Reopen a closed period. A documented reason is mandatory (audit compliance)
 * and a hash-chained audit record is written before the period flips back.
 */
async function reopenPeriod(periodId, reason, userId, companyId = currentCompanyId()) {
  if (!reason || !reason.trim()) {
    throw new Error('Reopen reason is required for audit compliance.');
  }

  companyId = await resolveCompanyId(companyId);
  const period = await getPeriod(periodId, companyId);
  if (!period) throw new Error('Accounting period not found for this company.');
  if (period.status !== 'CLOSED') throw new Error(`Period ${period.period_year}-${period.period_month} is not CLOSED.`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE accounting_periods
          SET status = 'OPEN', updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND company_id = $2 AND status = 'CLOSED'
        RETURNING *`,
      [periodId, companyId]
    );
    if (!rows[0]) {
      throw new Error('Period could not be reopened (not found, or not CLOSED).');
    }

    await appendAuditRecord({
      entity_type: 'ACCOUNTING_PERIOD',
      entity_id: periodId,
      from_status: 'CLOSED',
      to_status: 'OPEN',
      changed_by: userId,
      reason: reason.trim(),
      company_id: companyId
    }, { client });

    await client.query('COMMIT');

    return { success: true, period: rows[0], reason: reason.trim() };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  PRE_CLOSE_CHECKS,
  validatePreCloseChecks,
  validatePreCloseChecksForMonth,
  buildChecklist,
  closePeriod,
  reopenPeriod
};
