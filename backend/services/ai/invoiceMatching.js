/**
 * Smart invoice matching (3-way match assistance) and bank auto-reconciliation
 * suggestions.
 *
 * Two related problems, same shape — an incoming document has to be tied to the
 * commitments already in the ledger:
 *
 *   • A supplier bill should match a purchase order and the goods actually
 *     received. Paying an unmatched bill is how companies pay for goods that
 *     never arrived, or pay twice.
 *   • A bank line should match an invoice or payment already recorded.
 *
 * The existing BankTransaction.autoReconcile is deliberately conservative: it
 * acts only on an unambiguous single match. That is correct for something that
 * *writes*. This module is the advisory counterpart — it ranks and explains
 * plausible matches, including ambiguous ones, and never writes anything. A
 * human (or the agent, with confirmation) decides.
 *
 * Scoring is arithmetic on real amounts, dates and quantities. No LLM: matching
 * a number to a number does not need one, and a model would introduce
 * non-determinism into an audit-relevant decision.
 */

const { pool } = require('../../config/database');
const stats = require('./stats');

// Tolerance for "the amounts agree" — covers rounding and minor FX drift.
const AMOUNT_TOLERANCE_PCT = 0.02;
const AMOUNT_TOLERANCE_ABS = 1.0;

function amountsAgree(a, b) {
  const diff = Math.abs(Number(a) - Number(b));
  return diff <= AMOUNT_TOLERANCE_ABS || diff <= Math.abs(Number(a)) * AMOUNT_TOLERANCE_PCT;
}

// ---------------------------------------------------------------------------
// 3-way match: invoice ↔ purchase order ↔ goods received
// ---------------------------------------------------------------------------

/**
 * Evaluate a supplier invoice against its PO and the goods receipted against
 * that PO, and report every discrepancy found.
 */
async function threeWayMatch(supplierInvoiceId) {
  const { rows: invRows } = await pool.query(
    `SELECT si.*, s.legal_name AS supplier_name
       FROM supplier_invoices si
       LEFT JOIN suppliers s ON s.id = si.supplier_id
      WHERE si.id = $1 AND si.deleted_at IS NULL`,
    [supplierInvoiceId]
  );
  if (!invRows.length) return { found: false, error: 'Supplier invoice not found.' };
  const invoice = invRows[0];

  if (!invoice.purchase_order_id) {
    const candidates = await suggestPurchaseOrdersForInvoice(supplierInvoiceId);
    return {
      found: true,
      bill_number: invoice.bill_number,
      matched: false,
      status: 'NO_PO_LINKED',
      message: 'This bill is not linked to a purchase order, so it cannot be 3-way matched.',
      suggested_purchase_orders: candidates.suggestions,
    };
  }

  const [{ rows: poRows }, { rows: lineRows }, { rows: grRows }] = await Promise.all([
    pool.query('SELECT * FROM purchase_orders WHERE id = $1', [invoice.purchase_order_id]),
    pool.query(
      `SELECT id, item_description, quantity, unit_price, line_total, quantity_received
         FROM purchase_order_line_items WHERE po_id = $1 ORDER BY created_at`,
      [invoice.purchase_order_id]
    ),
    pool.query(
      `SELECT po_line_item_id, SUM(quantity_received)::float AS received
         FROM goods_receipts WHERE po_id = $1 GROUP BY po_line_item_id`,
      [invoice.purchase_order_id]
    ),
  ]);

  if (!poRows.length) {
    return { found: true, matched: false, status: 'PO_MISSING', message: 'The linked purchase order no longer exists.' };
  }
  const po = poRows[0];
  const receivedByLine = new Map(grRows.map((r) => [r.po_line_item_id, Number(r.received)]));

  const discrepancies = [];

  // 1. Supplier must be the same party.
  if (po.supplier_id !== invoice.supplier_id) {
    discrepancies.push({
      type: 'SUPPLIER_MISMATCH',
      severity: 'critical',
      detail: 'The bill and the purchase order are against different suppliers.',
    });
  }

  // 2. Invoice total vs PO total.
  if (!amountsAgree(invoice.total_amount, po.total_amount)) {
    const diff = Number(invoice.total_amount) - Number(po.total_amount);
    discrepancies.push({
      type: 'AMOUNT_MISMATCH',
      severity: Math.abs(diff) > Number(po.total_amount) * 0.02 ? 'critical' : 'warning',
      detail: `Billed ${stats.round2(invoice.total_amount)} against a PO of ${stats.round2(po.total_amount)} (${diff > 0 ? 'over' : 'under'} by ${stats.round2(Math.abs(diff))}).`,
      invoice_amount: stats.round2(invoice.total_amount),
      po_amount: stats.round2(po.total_amount),
      difference: stats.round2(diff),
    });
  }

  // 3. Goods actually received vs ordered — the leg that stops payment for
  //    undelivered goods.
  let anyReceived = false;
  const lineDetail = lineRows.map((l) => {
    const received = receivedByLine.get(l.id) ?? Number(l.quantity_received || 0);
    if (received > 0) anyReceived = true;
    const ordered = Number(l.quantity || 0);
    const shortfall = stats.round2(ordered - received);
    if (received + 1e-9 < ordered) {
      discrepancies.push({
        type: 'UNDER_RECEIPT',
        severity: received === 0 ? 'critical' : 'warning',
        detail: `"${l.item_description}": ${received} of ${ordered} received — billing for ${shortfall} not yet delivered.`,
      });
    } else if (received > ordered + 1e-9) {
      discrepancies.push({
        type: 'OVER_RECEIPT',
        severity: 'warning',
        detail: `"${l.item_description}": ${received} received against ${ordered} ordered.`,
      });
    }
    return {
      item_description: l.item_description,
      ordered,
      received,
      unit_price: Number(l.unit_price),
      line_total: Number(l.line_total),
    };
  });

  if (!anyReceived && lineRows.length) {
    discrepancies.push({
      type: 'NO_GOODS_RECEIPT',
      severity: 'critical',
      detail: 'No goods receipt exists against this purchase order — nothing has been confirmed as delivered.',
    });
  }

  const critical = discrepancies.filter((d) => d.severity === 'critical');
  const status = critical.length ? 'BLOCKED' : discrepancies.length ? 'MATCHED_WITH_VARIANCE' : 'FULLY_MATCHED';

  return {
    found: true,
    bill_number: invoice.bill_number,
    po_number: po.po_number,
    supplier_name: invoice.supplier_name,
    matched: status === 'FULLY_MATCHED',
    passed: status !== 'BLOCKED',
    status,
    invoice_total: stats.round2(invoice.total_amount),
    po_total: stats.round2(po.total_amount),
    lines: lineDetail,
    discrepancies,
    recommendation:
      status === 'FULLY_MATCHED'
        ? 'Invoice, purchase order and goods receipt agree — safe to approve for payment.'
        : critical.length
          ? 'Do NOT approve for payment until the critical discrepancies above are resolved.'
          : 'Minor variances only — review before approving.',
  };
}

/**
 * For an unlinked bill, rank the purchase orders it plausibly belongs to.
 */
async function suggestPurchaseOrdersForInvoice(supplierInvoiceId) {
  const { rows: invRows } = await pool.query(
    'SELECT * FROM supplier_invoices WHERE id = $1 AND deleted_at IS NULL',
    [supplierInvoiceId]
  );
  if (!invRows.length) return { found: false, suggestions: [] };
  const invoice = invRows[0];

  const { rows: pos } = await pool.query(
    `SELECT po.id, po.po_number, po.po_date, po.total_amount, po.status, s.legal_name AS supplier_name
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id = po.supplier_id
      WHERE po.supplier_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM supplier_invoices si2
           WHERE si2.purchase_order_id = po.id AND si2.deleted_at IS NULL AND si2.id <> $2
        )
      ORDER BY po.po_date DESC
      LIMIT 50`,
    [invoice.supplier_id, supplierInvoiceId]
  );

  const suggestions = pos
    .map((po) => {
      let score = 0;
      const reasons = [];

      if (amountsAgree(invoice.total_amount, po.total_amount)) {
        score += 0.6;
        reasons.push('the totals agree');
      } else {
        const rel = Math.abs(Number(invoice.total_amount) - Number(po.total_amount)) / Math.max(Number(po.total_amount), 1);
        if (rel < 0.15) { score += 0.25; reasons.push('the totals are close'); }
      }

      const daysApart = Math.abs(
        (new Date(invoice.invoice_date) - new Date(po.po_date)) / 86400000
      );
      if (daysApart <= 90) {
        score += 0.3 * (1 - daysApart / 90);
        reasons.push(`raised ${Math.round(daysApart)} day(s) after the PO`);
      }

      if (po.status === 'COMPLETED' || po.status === 'APPROVED') {
        score += 0.1;
        reasons.push(`PO is ${po.status}`);
      }

      return {
        purchase_order_id: po.id,
        po_number: po.po_number,
        po_date: po.po_date,
        po_total: Number(po.total_amount),
        status: po.status,
        score: stats.round2(Math.min(score, 1)),
        confidence: score >= 0.8 ? 'high' : score >= 0.5 ? 'medium' : 'low',
        reason: reasons.length ? `Matched because ${reasons.join(', ')}.` : 'Same supplier only — weak evidence.',
      };
    })
    .filter((s) => s.score > 0.2)
    .sort((a, b) => b.score - a.score);

  return {
    found: true,
    bill_number: invoice.bill_number,
    invoice_total: Number(invoice.total_amount),
    suggestions: suggestions.slice(0, 5),
    note: suggestions.length ? null : 'No open purchase order for this supplier plausibly matches this bill.',
  };
}

/**
 * Every unmatched/unlinked supplier bill, with its match status — the AP
 * clerk's worklist.
 */
async function matchExceptionReport({ limit = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT si.id, si.bill_number, si.total_amount, si.status, si.purchase_order_id,
            s.legal_name AS supplier_name
       FROM supplier_invoices si
       LEFT JOIN suppliers s ON s.id = si.supplier_id
      WHERE si.deleted_at IS NULL
        AND si.status NOT IN ('PAID','CANCELLED','REJECTED')
      ORDER BY si.invoice_date DESC
      LIMIT $1`,
    [limit]
  );

  const results = [];
  for (const bill of rows) {
    const match = await threeWayMatch(bill.id);
    results.push({
      supplier_invoice_id: bill.id,
      bill_number: bill.bill_number,
      supplier_name: bill.supplier_name,
      total_amount: Number(bill.total_amount),
      match_status: match.status,
      blocking: match.status === 'BLOCKED',
      discrepancy_count: (match.discrepancies || []).length,
      recommendation: match.recommendation,
    });
  }

  return {
    total_reviewed: results.length,
    blocked: results.filter((r) => r.blocking).length,
    fully_matched: results.filter((r) => r.match_status === 'FULLY_MATCHED').length,
    exceptions: results.filter((r) => r.match_status !== 'FULLY_MATCHED'),
  };
}

// ---------------------------------------------------------------------------
// Bank reconciliation suggestions (advisory — never writes)
// ---------------------------------------------------------------------------

/**
 * Rank likely matches for unreconciled bank lines against open invoices.
 * Positive amounts are treated as customer receipts, negative as supplier
 * payments.
 */
async function suggestBankMatches({ bankAccountId, limit = 25 } = {}) {
  const params = [];
  let accountFilter = '';
  if (bankAccountId) {
    params.push(bankAccountId);
    accountFilter = `AND bt.bank_account_id = $${params.length}`;
  }
  params.push(limit);

  const { rows: txns } = await pool.query(
    `SELECT bt.id, bt.transaction_date, bt.description, bt.reference, bt.amount::float AS amount
       FROM bank_transactions bt
      WHERE bt.is_reconciled = false AND bt.deleted_at IS NULL ${accountFilter}
      ORDER BY bt.transaction_date DESC
      LIMIT $${params.length}`,
    params
  );

  const suggestions = [];
  for (const txn of txns) {
    const inbound = Number(txn.amount) >= 0;
    const table = inbound ? 'customer_invoices' : 'supplier_invoices';
    const nameJoin = inbound
      ? 'LEFT JOIN customers c ON c.id = i.customer_id'
      : 'LEFT JOIN suppliers c ON c.id = i.supplier_id';
    const nameCol = inbound ? 'c.customer_name' : 'c.legal_name';
    const numCol = inbound ? 'i.invoice_number' : 'i.bill_number';
    const target = Math.abs(Number(txn.amount));

    const { rows: candidates } = await pool.query(
      `SELECT i.id, ${numCol} AS document_number, i.outstanding_amount::float AS outstanding,
              i.total_amount::float AS total, i.due_date, ${nameCol} AS counterparty
         FROM ${table} i ${nameJoin}
        WHERE i.deleted_at IS NULL AND i.outstanding_amount > 0
        ORDER BY ABS(i.outstanding_amount - $1) ASC
        LIMIT 5`,
      [target]
    ).catch(() => ({ rows: [] }));

    const ranked = candidates
      .map((c) => {
        let score = 0;
        const reasons = [];

        if (amountsAgree(c.outstanding, target)) {
          score += 0.7;
          reasons.push('the outstanding amount matches exactly');
        } else if (Math.abs(c.outstanding - target) / Math.max(target, 1) < 0.1) {
          score += 0.3;
          reasons.push('the amount is close');
        }

        // The document number appearing in the bank narrative is very strong
        // evidence — this is how remittances are usually annotated.
        const haystack = `${txn.description || ''} ${txn.reference || ''}`.toLowerCase();
        if (c.document_number && haystack.includes(String(c.document_number).toLowerCase())) {
          score += 0.5;
          reasons.push(`the bank narrative quotes ${c.document_number}`);
        }
        if (c.counterparty && stats.nameSimilarity(c.counterparty, txn.description || '') > 0.6) {
          score += 0.2;
          reasons.push('the counterparty name appears in the narrative');
        }

        return {
          document_id: c.id,
          document_number: c.document_number,
          document_type: inbound ? 'customer_invoice' : 'supplier_invoice',
          counterparty: c.counterparty,
          outstanding: c.outstanding,
          score: stats.round2(Math.min(score, 1)),
          confidence: score >= 0.8 ? 'high' : score >= 0.5 ? 'medium' : 'low',
          reason: reasons.length ? `Suggested because ${reasons.join(' and ')}.` : 'Amount proximity only.',
        };
      })
      .filter((c) => c.score > 0.25)
      .sort((a, b) => b.score - a.score);

    suggestions.push({
      bank_transaction_id: txn.id,
      transaction_date: txn.transaction_date,
      description: txn.description,
      amount: Number(txn.amount),
      direction: inbound ? 'receipt' : 'payment',
      best_match: ranked[0] || null,
      // Ambiguity is information: two equally good matches must not be
      // auto-applied, and saying so is more useful than silently picking one.
      ambiguous: ranked.length > 1 && ranked[0].score - ranked[1].score < 0.15,
      candidates: ranked.slice(0, 3),
    });
  }

  const confident = suggestions.filter((s) => s.best_match?.confidence === 'high' && !s.ambiguous);
  return {
    unreconciled_reviewed: txns.length,
    with_confident_match: confident.length,
    suggestions,
    note: txns.length === 0 ? 'No unreconciled bank transactions.' : null,
  };
}

module.exports = {
  threeWayMatch,
  suggestPurchaseOrdersForInvoice,
  matchExceptionReport,
  suggestBankMatches,
  amountsAgree,
};
