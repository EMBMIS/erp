const { pool } = require('../config/database');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * BankAccount — a bank account linked to a GL cash account, plus the
 * reconciliation summary that compares the book (GL) balance against the
 * cleared balance (opening balance + reconciled statement lines).
 */
class BankAccount {

  static async create(data, userId) {
    // Default the linked GL account to Cash (1110) when not specified.
    let glAccountId = data.gl_account_id || null;
    if (!glAccountId) {
      const cash = await pool.query("SELECT id FROM chart_of_accounts WHERE account_code = '1110' AND deleted_at IS NULL");
      glAccountId = cash.rows[0]?.id || null;
    }

    const result = await pool.query(`
      INSERT INTO bank_accounts (account_name, bank_name, account_number, currency, gl_account_id, opening_balance, notes, created_by, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
      RETURNING *
    `, [
      data.account_name,
      data.bank_name || null,
      data.account_number || null,
      data.currency || 'USD',
      glAccountId,
      data.opening_balance || 0,
      data.notes || null,
      userId,
    ]);
    return result.rows[0];
  }

  static async findAll() {
    const result = await pool.query(`
      SELECT ba.*, coa.account_code AS gl_account_code, coa.account_name AS gl_account_name,
             coa.current_balance AS book_balance,
             (SELECT COUNT(*) FROM bank_transactions bt WHERE bt.bank_account_id = ba.id AND bt.deleted_at IS NULL AND bt.is_reconciled = false)::int AS unreconciled_count
      FROM bank_accounts ba
      LEFT JOIN chart_of_accounts coa ON ba.gl_account_id = coa.id
      WHERE ba.deleted_at IS NULL
      ORDER BY ba.created_at DESC
    `);
    return result.rows;
  }

  static async findById(id) {
    const result = await pool.query(`
      SELECT ba.*, coa.account_code AS gl_account_code, coa.account_name AS gl_account_name,
             coa.current_balance AS book_balance
      FROM bank_accounts ba
      LEFT JOIN chart_of_accounts coa ON ba.gl_account_id = coa.id
      WHERE ba.id = $1 AND ba.deleted_at IS NULL
    `, [id]);
    return result.rows[0] || null;
  }

  // Reconciliation summary: book (GL) balance vs cleared (opening + reconciled).
  static async getReconciliationSummary(id) {
    const account = await this.findById(id);
    if (!account) return null;

    const totals = await pool.query(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE is_reconciled = true), 0) AS reconciled_amount,
        COALESCE(SUM(amount) FILTER (WHERE is_reconciled = false), 0) AS unreconciled_amount,
        COUNT(*) FILTER (WHERE is_reconciled = false)::int AS unreconciled_count,
        COUNT(*)::int AS total_lines
      FROM bank_transactions
      WHERE bank_account_id = $1 AND deleted_at IS NULL
    `, [id]);
    const t = totals.rows[0];

    const opening = Number(account.opening_balance);
    const clearedBalance = round2(opening + Number(t.reconciled_amount));
    const statementBalance = round2(opening + Number(t.reconciled_amount) + Number(t.unreconciled_amount));
    const bookBalance = round2(Number(account.book_balance || 0));

    return {
      account,
      opening_balance: opening,
      book_balance: bookBalance,             // GL cash balance
      cleared_balance: clearedBalance,       // opening + reconciled lines
      statement_balance: statementBalance,   // opening + all lines
      unreconciled_amount: round2(Number(t.unreconciled_amount)),
      unreconciled_count: t.unreconciled_count,
      total_lines: t.total_lines,
      difference: round2(bookBalance - clearedBalance), // 0 => fully reconciled to book
    };
  }
}

module.exports = BankAccount;
