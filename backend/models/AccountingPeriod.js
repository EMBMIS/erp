const { pool } = require('../config/database');

/**
 * AccountingPeriod — monthly period status for period close. A CLOSED period
 * locks GL postings (enforced centrally in JournalEntry.create).
 */
class AccountingPeriod {

  static async findAll(year = null) {
    let query = 'SELECT ap.*, u.first_name || \' \' || u.last_name AS closed_by_name FROM accounting_periods ap LEFT JOIN users u ON ap.closed_by = u.id';
    const values = [];
    if (year) { values.push(year); query += ` WHERE ap.period_year = $1`; }
    query += ' ORDER BY ap.period_year DESC, ap.period_month DESC';
    const result = await pool.query(query, values);
    return result.rows;
  }

  static async setStatus(year, month, status, userId, notes = '') {
    if (!['OPEN', 'CLOSED'].includes(status)) throw new Error('status must be OPEN or CLOSED');
    if (!year || !month || month < 1 || month > 12) throw new Error('valid year and month (1-12) required');

    const result = await pool.query(`
      INSERT INTO accounting_periods (period_year, period_month, status, closed_by, closed_at, notes)
      VALUES ($1, $2, $3::varchar, $4, CASE WHEN $3::varchar = 'CLOSED' THEN CURRENT_TIMESTAMP ELSE NULL END, $5)
      -- Periods are per company (migration 202608130100): company_id defaults
      -- from the session, and the unique key is the partial index on
      -- (company_id, period_year, period_month).
      ON CONFLICT (company_id, period_year, period_month) WHERE company_id IS NOT NULL
      DO UPDATE SET status = EXCLUDED.status,
                    closed_by = CASE WHEN EXCLUDED.status = 'CLOSED' THEN EXCLUDED.closed_by ELSE NULL END,
                    closed_at = CASE WHEN EXCLUDED.status = 'CLOSED' THEN CURRENT_TIMESTAMP ELSE NULL END,
                    notes = EXCLUDED.notes,
                    updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [year, month, status, userId, notes || null]);
    return result.rows[0];
  }

  static async isOpen(date) {
    const d = date instanceof Date ? date : new Date(date);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const result = await pool.query(
      'SELECT status FROM accounting_periods WHERE period_year = $1 AND period_month = $2',
      [year, month]
    );
    return result.rows.length === 0 || result.rows[0].status !== 'CLOSED';
  }
}

module.exports = AccountingPeriod;
