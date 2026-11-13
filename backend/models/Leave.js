const { pool } = require('../config/database');

/**
 * Leave accrual policies + a real balance ledger. UNPAID leave never touches
 * a balance (there is nothing to accrue or consume for it) — every other
 * leave_type is tracked.
 */
class Leave {

  static async listPolicies() {
    const result = await pool.query('SELECT * FROM leave_accrual_policies ORDER BY leave_type');
    return result.rows;
  }

  static async upsertPolicy(data, userId) {
    if (!data.leave_type) throw new Error('leave_type is required');
    if (data.leave_type === 'UNPAID') throw new Error('UNPAID leave does not accrue and cannot have a policy');
    const rate = Number(data.monthly_accrual_days);
    if (!(rate >= 0)) throw new Error('monthly_accrual_days must be a non-negative number');

    const result = await pool.query(`
      INSERT INTO leave_accrual_policies (company_id, leave_type, monthly_accrual_days, max_balance_days, created_by)
      VALUES (COALESCE(current_company_id(), (SELECT id FROM companies ORDER BY created_at LIMIT 1)), $1, $2, $3, $4)
      ON CONFLICT (company_id, leave_type) DO UPDATE
        SET monthly_accrual_days = EXCLUDED.monthly_accrual_days,
            max_balance_days = EXCLUDED.max_balance_days,
            updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [data.leave_type, rate, data.max_balance_days ?? null, userId]);
    return result.rows[0];
  }

  static async getBalances(employeeId) {
    const result = await pool.query(
      'SELECT * FROM leave_balances WHERE employee_id = $1 ORDER BY leave_type',
      [employeeId]
    );
    return result.rows;
  }

  // Accrue one month of leave for every ACTIVE employee, for every policy.
  // Idempotent: a second call for the same (employee, leave_type, year,
  // month) is a no-op — the partial unique index on leave_balance_transactions
  // rejects the duplicate ACCRUAL row and this catches that specific error
  // rather than letting it look like a real failure.
  static async accrueMonthly(year, month, userId) {
    if (!year || !month || month < 1 || month > 12) throw new Error('Valid year and month (1-12) are required');

    const policies = await pool.query('SELECT * FROM leave_accrual_policies');
    const employees = await pool.query("SELECT id FROM employees WHERE status = 'ACTIVE' AND deleted_at IS NULL");

    let accrued = 0;
    let skipped = 0;
    for (const policy of policies.rows) {
      for (const emp of employees.rows) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `INSERT INTO leave_balance_transactions
               (employee_id, leave_type, days, transaction_type, period_year, period_month, created_by)
             VALUES ($1, $2, $3, 'ACCRUAL', $4, $5, $6)`,
            [emp.id, policy.leave_type, policy.monthly_accrual_days, year, month, userId]
          );

          const capClause = policy.max_balance_days != null ? 'LEAST(leave_balances.balance_days + $3, $4)' : 'leave_balances.balance_days + $3';
          const params = policy.max_balance_days != null
            ? [emp.id, policy.leave_type, policy.monthly_accrual_days, policy.max_balance_days]
            : [emp.id, policy.leave_type, policy.monthly_accrual_days];
          await client.query(`
            INSERT INTO leave_balances (employee_id, leave_type, balance_days)
            VALUES ($1, $2, $3)
            ON CONFLICT (employee_id, leave_type) DO UPDATE
              SET balance_days = ${capClause}, updated_at = CURRENT_TIMESTAMP
          `, params);

          await client.query('COMMIT');
          accrued += 1;
        } catch (error) {
          await client.query('ROLLBACK');
          if (error.code === '23505') { skipped += 1; } // already accrued this period
          else throw error;
        } finally {
          client.release();
        }
      }
    }
    return { accrued, skipped, period: `${year}-${String(month).padStart(2, '0')}` };
  }

  // Decide a pending leave request: APPROVED deducts from the balance
  // (blocked if insufficient, except UNPAID which has none to deduct);
  // CANCELLED after a prior APPROVED releases the days back.
  static async decide(id, decision, userId) {
    if (!['APPROVED', 'REJECTED', 'CANCELLED'].includes(decision)) {
      throw new Error('status must be APPROVED, REJECTED, or CANCELLED');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const lrRes = await client.query('SELECT * FROM leave_requests WHERE id = $1 FOR UPDATE', [id]);
      if (lrRes.rows.length === 0) throw new Error('Leave request not found');
      const lr = lrRes.rows[0];
      const days = Number(lr.total_days);
      const trackBalance = lr.leave_type !== 'UNPAID';

      if (decision === 'APPROVED') {
        if (lr.status === 'APPROVED') throw new Error('Leave request already approved');
        if (trackBalance) {
          const balRes = await client.query(
            'SELECT balance_days FROM leave_balances WHERE employee_id = $1 AND leave_type = $2 FOR UPDATE',
            [lr.employee_id, lr.leave_type]
          );
          const balance = Number(balRes.rows[0]?.balance_days || 0);
          if (balance < days) {
            throw new Error(`Insufficient ${lr.leave_type} leave balance: employee has ${balance} day(s), requested ${days}`);
          }
          await client.query(`
            INSERT INTO leave_balances (employee_id, leave_type, balance_days)
            VALUES ($1, $2, -$3::numeric)
            ON CONFLICT (employee_id, leave_type) DO UPDATE
              SET balance_days = leave_balances.balance_days - $3::numeric, updated_at = CURRENT_TIMESTAMP
          `, [lr.employee_id, lr.leave_type, days]);
          await client.query(
            `INSERT INTO leave_balance_transactions (employee_id, leave_type, days, transaction_type, reference_id, created_by)
             VALUES ($1, $2, $3, 'USAGE', $4, $5)`,
            [lr.employee_id, lr.leave_type, -days, id, userId]
          );
        }
      } else if (decision === 'CANCELLED' && lr.status === 'APPROVED' && trackBalance) {
        await client.query(`
          UPDATE leave_balances SET balance_days = balance_days + $3, updated_at = CURRENT_TIMESTAMP
          WHERE employee_id = $1 AND leave_type = $2
        `, [lr.employee_id, lr.leave_type, days]);
        await client.query(
          `INSERT INTO leave_balance_transactions (employee_id, leave_type, days, transaction_type, reference_id, created_by)
           VALUES ($1, $2, $3, 'RELEASE', $4, $5)`,
          [lr.employee_id, lr.leave_type, days, id, userId]
        );
      }

      const updated = await client.query(`
        UPDATE leave_requests SET status = $1, approved_by = $2, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 RETURNING *
      `, [decision, userId, id]);

      await client.query('COMMIT');
      return updated.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = Leave;
