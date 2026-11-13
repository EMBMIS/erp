const { pool } = require('../config/database');

/**
 * BankTransaction — a single bank statement line. Lines are marked reconciled
 * (optionally matched to a customer/supplier payment) during reconciliation.
 */
class BankTransaction {

  static async create(data, userId) {
    const result = await pool.query(`
      INSERT INTO bank_transactions (bank_account_id, transaction_date, description, reference, amount, matched_type, matched_id, created_by)
      VALUES ($1, COALESCE($2, CURRENT_DATE), $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [
      data.bank_account_id,
      data.transaction_date || null,
      data.description || null,
      data.reference || null,
      data.amount,
      data.matched_type || null,
      data.matched_id || null,
      userId,
    ]);
    return result.rows[0];
  }

  // Bulk create (e.g. a statement import). Returns count inserted.
  static async createMany(bankAccountId, lines = [], userId) {
    let count = 0;
    for (const line of lines) {
      if (line.amount == null) continue;
      await this.create({ ...line, bank_account_id: bankAccountId }, userId);
      count++;
    }
    return count;
  }

  static async findAll(bankAccountId, filters = {}) {
    let query = `
      SELECT * FROM bank_transactions
      WHERE bank_account_id = $1 AND deleted_at IS NULL
    `;
    const values = [bankAccountId];
    if (filters.reconciled === 'true' || filters.reconciled === true) query += ' AND is_reconciled = true';
    if (filters.reconciled === 'false' || filters.reconciled === false) query += ' AND is_reconciled = false';
    query += ' ORDER BY transaction_date DESC, created_at DESC';
    const result = await pool.query(query, values);
    return result.rows;
  }

  static async setReconciled(id, reconciled, userId, match = {}) {
    // Explicit casts on the CASE/COALESCE branches: an untyped parameter next to
    // a NULL literal can make Postgres infer the wrong type for the whole
    // expression (the same class of bug as the period-close $3 issue elsewhere
    // in this codebase), which surfaced here as "reconciled_by is of type uuid
    // but expression is of type text" once a real userId was passed.
    const result = await pool.query(`
      UPDATE bank_transactions
      SET is_reconciled = $1,
          reconciled_at = CASE WHEN $1 THEN CURRENT_TIMESTAMP ELSE NULL END,
          reconciled_by = CASE WHEN $1 THEN $2::uuid ELSE NULL END,
          matched_type = COALESCE($3::varchar, matched_type),
          matched_id = COALESCE($4::uuid, matched_id)
      WHERE id = $5 AND deleted_at IS NULL
      RETURNING *
    `, [reconciled, userId, match.matched_type || null, match.matched_id || null, id]);
    if (result.rows.length === 0) throw new Error('Bank transaction not found');
    return result.rows[0];
  }

  // Suggest book matches (customer/supplier payments) for an unreconciled line
  // by matching amount within a small date window.
  static async suggestMatches(id) {
    const txnResult = await pool.query('SELECT * FROM bank_transactions WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (txnResult.rows.length === 0) return [];
    const txn = txnResult.rows[0];
    const amount = Math.abs(Number(txn.amount));
    const suggestions = [];

    try {
      if (Number(txn.amount) > 0) {
        // Inflow -> customer payment received
        const cp = await pool.query(`
          SELECT id, payment_number AS ref, payment_amount AS amount, payment_date
          FROM customer_payments
          WHERE deleted_at IS NULL AND ABS(payment_amount - $1) < 0.01
            AND payment_date BETWEEN $2::date - INTERVAL '7 days' AND $2::date + INTERVAL '7 days'
          LIMIT 5
        `, [amount, txn.transaction_date]);
        cp.rows.forEach((r) => suggestions.push({ type: 'CUSTOMER_PAYMENT', ...r }));
      } else {
        // Outflow -> supplier payment made
        const sp = await pool.query(`
          SELECT id, payment_number AS ref, payment_amount AS amount, payment_date
          FROM supplier_payments
          WHERE deleted_at IS NULL AND ABS(payment_amount - $1) < 0.01
            AND payment_date BETWEEN $2::date - INTERVAL '7 days' AND $2::date + INTERVAL '7 days'
          LIMIT 5
        `, [amount, txn.transaction_date]);
        sp.rows.forEach((r) => suggestions.push({ type: 'SUPPLIER_PAYMENT', ...r }));
      }
    } catch (_) { /* payment tables may not exist yet */ }

    return suggestions;
  }

  // Auto-reconciliation rule: for every unreconciled line on this account, run
  // suggestMatches(). If EXACTLY ONE candidate comes back (unambiguous amount +
  // date-window match), reconcile automatically and link it. Anything with zero
  // or multiple candidates is left for a human to resolve manually — auto-match
  // is conservative by design (ERP-Roadmap P2 #10).
  static async autoReconcile(bankAccountId, userId) {
    const unreconciled = await this.findAll(bankAccountId, { reconciled: false });
    let reconciled = 0;
    let ambiguous = 0;
    let unmatched = 0;
    const details = [];

    for (const txn of unreconciled) {
      const suggestions = await this.suggestMatches(txn.id);
      if (suggestions.length === 1) {
        const match = suggestions[0];
        await this.setReconciled(txn.id, true, userId, { matched_type: match.type, matched_id: match.id });
        reconciled++;
        details.push({ transaction_id: txn.id, description: txn.description, matched_type: match.type, matched_id: match.id });
      } else if (suggestions.length > 1) {
        ambiguous++;
      } else {
        unmatched++;
      }
    }

    return { checked: unreconciled.length, reconciled, ambiguous, unmatched, details };
  }
}

module.exports = BankTransaction;
