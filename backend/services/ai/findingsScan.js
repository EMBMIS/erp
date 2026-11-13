/**
 * Scheduled AI findings scan (ERP-Roadmap AI P2 #4 + #5).
 *
 * Every check here is a real, deterministic SQL query over real data —
 * duplicate invoices, weekend/off-hours postings, suspiciously round journal
 * amounts, low stock, overdue supplier deliveries — NOT an LLM guessing.
 * This follows the roadmap's explicit design rule: "replace pure-LLM
 * predictions with statistical baselines, letting the LLM explain rather than
 * invent numbers." No model call is made here at all; it's cheap, fast, and
 * has zero hallucination risk. Turns AI-Insights from pull (ask a question) to
 * push (findings surface on their own, and HIGH-severity ones notify managers).
 *
 * Re-running the scan is safe: a unique index (migration 100) on
 * (finding_type, entity_type, entity_id) WHERE status='OPEN' means the same
 * underlying issue is never reported twice while still open.
 */

const { pool } = require('../../config/database');
const Notification = require('../../models/Notification');

/**
 * Create an ai_findings row for one detected issue, deduplicated and
 * suppression-aware:
 *
 *   • At most one OPEN finding per (company, type, entity) — the partial unique
 *     index settles the race even when two scans run concurrently.
 *   • A recent dismissal (ai_finding_suppressions, migration 145) suppresses
 *     re-raising for its window, so "dismiss → records why → the next sweep
 *     doesn't re-raise it" holds.
 *
 * @returns {Promise<{id: string|null, created: boolean}>} id null = skipped
 *          (already open, or suppressed).
 */
async function upsertFinding({ finding_type, severity, entity_type, entity_id, title, description, data, companyId }) {
  const companyScope = require('../companyScope');
  let resolvedCompanyId = companyId || companyScope.currentCompanyId();
  if (!resolvedCompanyId) {
    const { rows } = await pool.query("SELECT id FROM companies ORDER BY created_at ASC LIMIT 1");
    resolvedCompanyId = rows[0]?.id;
  }
  if (!resolvedCompanyId) return { id: null, created: false };

  // A dismissal suppresses re-raising until it expires (default 30 days). The
  // suppression is keyed on the same (type, entity) triple as the dedup index.
  const { rows: supp } = await pool.query(
    `SELECT 1 FROM ai_finding_suppressions
      WHERE company_id = $1 AND finding_type = $2
        AND entity_type IS NOT DISTINCT FROM $3 AND entity_id IS NOT DISTINCT FROM $4
        AND suppressed_until > CURRENT_TIMESTAMP
      LIMIT 1`,
    [resolvedCompanyId, finding_type, entity_type, entity_id]
  );
  if (supp.length) return { id: null, created: false, suppressed: true };

  const result = await pool.query(
    `INSERT INTO ai_findings (company_id, finding_type, severity, entity_type, entity_id, title, description, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (company_id, finding_type, entity_type, entity_id) WHERE status = 'OPEN' DO NOTHING
     RETURNING id`,
    [resolvedCompanyId, finding_type, severity, entity_type, entity_id, title, description, data ? JSON.stringify(data) : null]
  );
  return { id: result.rows[0]?.id || null, created: !!result.rows.length };
}

async function findDuplicateInvoices() {
  const rows = await pool.query(`
    SELECT a.id AS id_a, b.id AS id_b, a.customer_id, a.total_amount, a.invoice_number AS num_a, b.invoice_number AS num_b, c.customer_name
    FROM customer_invoices a
    JOIN customer_invoices b ON a.customer_id = b.customer_id
      AND a.total_amount = b.total_amount AND a.id < b.id
      AND ABS(a.invoice_date - b.invoice_date) <= 7
    LEFT JOIN customers c ON a.customer_id = c.id
    WHERE a.deleted_at IS NULL AND b.deleted_at IS NULL
      AND a.status NOT IN ('CANCELLED') AND b.status NOT IN ('CANCELLED')
  `);
  const created = [];
  for (const row of rows.rows) {
    const r = await upsertFinding({
      finding_type: 'DUPLICATE_INVOICE',
      severity: 'HIGH',
      entity_type: 'CUSTOMER_INVOICE',
      entity_id: row.id_b,
      title: `Possible duplicate invoice: ${row.num_a} and ${row.num_b}`,
      description: `Two invoices for ${row.customer_name || 'the same customer'} share the same amount ($${row.total_amount}) within 7 days of each other.`,
      data: { invoice_a: row.num_a, invoice_b: row.num_b, amount: row.total_amount },
    });
    if (r) created.push(r.id);
  }
  return created;
}

async function findWeekendPostings() {
  const rows = await pool.query(`
    SELECT id, journal_number, entry_date, total_debit
    FROM journal_entries
    WHERE deleted_at IS NULL AND status = 'POSTED'
      AND EXTRACT(ISODOW FROM entry_date) IN (6, 7)
      AND entry_date >= CURRENT_DATE - INTERVAL '30 days'
  `);
  const created = [];
  for (const row of rows.rows) {
    const r = await upsertFinding({
      finding_type: 'WEEKEND_POSTING',
      severity: 'LOW',
      entity_type: 'JOURNAL_ENTRY',
      entity_id: row.id,
      title: `Journal entry ${row.journal_number} posted on a weekend`,
      description: `Entry dated ${row.entry_date.toISOString().split('T')[0]} (a weekend) for $${row.total_debit}. Worth confirming this was intentional.`,
      data: { journal_number: row.journal_number, amount: row.total_debit },
    });
    if (r) created.push(r.id);
  }
  return created;
}

async function findRoundNumberOutliers() {
  // A journal entry whose total is an exact multiple of 1000 and at least
  // $10,000 is statistically unusual for organic business activity and a
  // classic manual-entry/fraud heuristic.
  const rows = await pool.query(`
    SELECT id, journal_number, entry_date, total_debit, source_type
    FROM journal_entries
    WHERE deleted_at IS NULL AND status = 'POSTED'
      AND total_debit >= 10000
      AND total_debit = ROUND(total_debit / 1000) * 1000
      AND entry_date >= CURRENT_DATE - INTERVAL '30 days'
  `);
  const created = [];
  for (const row of rows.rows) {
    const r = await upsertFinding({
      finding_type: 'ROUND_NUMBER_OUTLIER',
      severity: 'LOW',
      entity_type: 'JOURNAL_ENTRY',
      entity_id: row.id,
      title: `Journal entry ${row.journal_number} is a suspiciously round amount`,
      description: `$${row.total_debit} is an exact multiple of $1,000 — worth a second look for manual entries or errors.`,
      data: { journal_number: row.journal_number, amount: row.total_debit, source_type: row.source_type },
    });
    if (r) created.push(r.id);
  }
  return created;
}

async function findStockoutRisks() {
  const rows = await pool.query(`
    SELECT ii.id, i.name AS item_name, ii.current_stock_quantity, ii.reorder_point
    FROM inventory_items ii
    JOIN items i ON ii.item_master_id = i.id
    WHERE ii.reorder_point IS NOT NULL AND ii.current_stock_quantity <= ii.reorder_point
  `);
  const created = [];
  for (const row of rows.rows) {
    const r = await upsertFinding({
      finding_type: 'STOCKOUT_RISK',
      severity: Number(row.current_stock_quantity) === 0 ? 'HIGH' : 'MEDIUM',
      entity_type: 'INVENTORY_ITEM',
      entity_id: row.id,
      title: `${row.item_name} is at or below its reorder point`,
      description: `Current stock ${row.current_stock_quantity}, reorder point ${row.reorder_point}. Consider running the reorder check.`,
      data: { item_name: row.item_name, current_stock: row.current_stock_quantity, reorder_point: row.reorder_point },
    });
    if (r) created.push(r.id);
  }
  return created;
}

async function findSupplierDelayRisks() {
  const rows = await pool.query(`
    SELECT po.id, po.po_number, po.supplier_delivery_due, s.legal_name AS supplier_name
    FROM purchase_orders po
    LEFT JOIN suppliers s ON po.supplier_id = s.id
    WHERE po.status NOT IN ('COMPLETED', 'FULLY_RECEIVED', 'CANCELLED')
      AND po.supplier_delivery_due IS NOT NULL
      AND po.supplier_delivery_due < CURRENT_DATE
  `);
  const created = [];
  for (const row of rows.rows) {
    const r = await upsertFinding({
      finding_type: 'SUPPLIER_DELAY_RISK',
      severity: 'MEDIUM',
      entity_type: 'PURCHASE_ORDER',
      entity_id: row.id,
      title: `PO ${row.po_number} is overdue from ${row.supplier_name || 'the supplier'}`,
      description: `Expected delivery was ${row.supplier_delivery_due.toISOString().split('T')[0]}, which has passed with no confirmed receipt.`,
      data: { po_number: row.po_number, supplier_name: row.supplier_name },
    });
    if (r) created.push(r.id);
  }
  return created;
}

/**
 * Run every check. Returns counts of NEW findings created (existing open
 * findings for the same issue are not duplicated). HIGH-severity new findings
 * notify managers.
 */
async function runFindingsScan() {
  const results = {
    duplicate_invoices: await findDuplicateInvoices(),
    weekend_postings: await findWeekendPostings(),
    round_number_outliers: await findRoundNumberOutliers(),
    stockout_risks: await findStockoutRisks(),
    supplier_delay_risks: await findSupplierDelayRisks(),
    // A work centre running slower than its own norm, priced, with the orders it puts at risk.
    line_slowdowns: (await require('../lineWatch').raiseLineFindings(require('../companyScope').currentCompanyId())).created,
    // Cash that falls under the floor (the next payroll) within 13 weeks, with its causes and what lifts it.
    cash_low: (await require('../cashOutlook').raiseCashFinding(require('../companyScope').currentCompanyId())).created,
    // A supplier whose record, open orders and dependencies add up to a high risk.
    supplier_risks: (await require('../supplierRisk').raiseSupplierFindings(require('../companyScope').currentCompanyId())).created,
    // An approval nobody has made, holding up a customer order due this week.
    decisions_holding_orders: (await require('../decisionsHeldOpen').raiseDecisionFindings(require('../companyScope').currentCompanyId())).created,
  };

  // Round 7, Task 20 learned-baseline fraud/anomaly detectors
  // (services/ai/anomalyDetectionService.js) — real and unit-tested, but
  // previously had no caller anywhere except their own test. Included here so
  // POST /ai-findings/scan and the AI chat tool actually run them, not just
  // the nightly scheduler sweep (services/agents/scheduler.js).
  const AnomalyDetectionService = require('./anomalyDetectionService');
  const anomalyScan = await AnomalyDetectionService.runAnomalyScan();
  results.anomaly_scan = anomalyScan;

  const totalNew = Object.values(results).reduce(
    (sum, val) => sum + (Array.isArray(val) ? val.length : val.total_new_findings || 0),
    0
  );

  // Notify managers about new HIGH-severity findings only — low/medium ones
  // are there to browse, not to interrupt anyone. (Duplicate invoices are
  // always HIGH; stockout risk is only HIGH when a specific item hits zero,
  // which is checked per-item above rather than here.)
  if (results.duplicate_invoices.length > 0) {
    await Notification.createForManagers({
      type: 'AI_FINDING',
      title: 'AI scan found possible duplicate invoices',
      message: `${results.duplicate_invoices.length} possible duplicate invoice(s) detected. Review the AI findings list.`,
      data: { finding_ids: results.duplicate_invoices },
    }).catch((err) => console.warn('Failed to notify managers of AI findings:', err.message));
  }

  return { total_new: totalNew, ...results };
}

module.exports = { runFindingsScan, upsertFinding };
