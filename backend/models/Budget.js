const { pool } = require('../config/database');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Budget — an annual plan with lines targeting GL accounts (and optionally cost
 * centers). Budget-vs-actual compares each line's annual_amount against the
 * actual movement on its account from posted journal entries in the fiscal year.
 */
class Budget {

  static async create(data, lines = [], userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const budgetResult = await client.query(`
        INSERT INTO budgets (name, fiscal_year, status, notes, created_by, updated_by)
        VALUES ($1,$2,$3,$4,$5,$5)
        RETURNING *
      `, [data.name, data.fiscal_year, data.status || 'DRAFT', data.notes || null, userId]);
      const budget = budgetResult.rows[0];

      for (const line of lines) {
        if (!line.account_id || line.annual_amount == null) continue;
        await client.query(`
          INSERT INTO budget_lines (budget_id, account_id, cost_center_id, annual_amount, notes)
          VALUES ($1,$2,$3,$4,$5)
        `, [budget.id, line.account_id, line.cost_center_id || null, line.annual_amount, line.notes || null]);
      }

      await client.query('COMMIT');
      return budget;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async addLine(budgetId, line, userId) {
    if (!line.account_id || line.annual_amount == null) throw new Error('account_id and annual_amount are required');
    const result = await pool.query(`
      INSERT INTO budget_lines (budget_id, account_id, cost_center_id, annual_amount, notes)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *
    `, [budgetId, line.account_id, line.cost_center_id || null, line.annual_amount, line.notes || null]);
    return result.rows[0];
  }

  static async findAll() {
    const result = await pool.query(`
      SELECT b.*,
             COALESCE(SUM(bl.annual_amount), 0) AS total_budget,
             COUNT(bl.id)::int AS line_count
      FROM budgets b
      LEFT JOIN budget_lines bl ON bl.budget_id = b.id
      WHERE b.deleted_at IS NULL
      GROUP BY b.id
      ORDER BY b.fiscal_year DESC, b.created_at DESC
    `);
    return result.rows;
  }

  static async findById(id) {
    const budgetResult = await pool.query('SELECT * FROM budgets WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (budgetResult.rows.length === 0) return null;
    const budget = budgetResult.rows[0];
    const lines = await pool.query(`
      SELECT bl.*, coa.account_code, coa.account_name, cc.code AS cost_center_code, cc.name AS cost_center_name
      FROM budget_lines bl
      LEFT JOIN chart_of_accounts coa ON bl.account_id = coa.id
      LEFT JOIN cost_centers cc ON bl.cost_center_id = cc.id
      WHERE bl.budget_id = $1
      ORDER BY coa.account_code
    `, [id]);
    budget.lines = lines.rows;
    return budget;
  }

  // Budget vs actual for a budget's fiscal year.
  static async getBudgetVsActual(id) {
    const budget = await this.findById(id);
    if (!budget) return null;

    const results = [];
    for (const line of budget.lines) {
      // Actual = net movement (debit - credit) on the account from POSTED
      // journal entries within the fiscal year. When the budget line targets a
      // specific cost center, only count journal lines tagged with that cost
      // center (dimensional budget-vs-actual).
      const params = [line.account_id, budget.fiscal_year];
      let ccFilter = '';
      if (line.cost_center_id) {
        params.push(line.cost_center_id);
        ccFilter = ` AND jei.cost_center_id = $${params.length}`;
      }
      const actualResult = await pool.query(`
        SELECT COALESCE(SUM(jei.debit_amount - jei.credit_amount), 0) AS actual
        FROM journal_entry_items jei
        JOIN journal_entries je ON jei.journal_entry_id = je.id
        WHERE jei.account_id = $1
          AND je.status = 'POSTED'
          AND je.deleted_at IS NULL
          AND EXTRACT(YEAR FROM je.entry_date) = $2${ccFilter}
      `, params);

      const budgeted = Number(line.annual_amount);
      const actual = round2(Number(actualResult.rows[0].actual));
      const variance = round2(budgeted - actual);
      results.push({
        account_code: line.account_code,
        account_name: line.account_name,
        cost_center_code: line.cost_center_code,
        cost_center_name: line.cost_center_name,
        budgeted,
        actual,
        variance,
        utilization_pct: budgeted !== 0 ? Math.round((actual / budgeted) * 100) : null,
      });
    }

    const totals = results.reduce((acc, r) => ({
      budgeted: acc.budgeted + r.budgeted,
      actual: acc.actual + r.actual,
    }), { budgeted: 0, actual: 0 });

    return {
      budget: { id: budget.id, name: budget.name, fiscal_year: budget.fiscal_year, status: budget.status },
      lines: results,
      totals: {
        budgeted: round2(totals.budgeted),
        actual: round2(totals.actual),
        variance: round2(totals.budgeted - totals.actual),
      },
    };
  }
}

module.exports = Budget;
