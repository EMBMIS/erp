const { pool } = require('../config/database');
const JournalEntry = require('./JournalEntry');
const calc = require('../services/financeCalc');
const payrollTax = require('../services/payrollTaxService');

const round2 = calc.round2;

/**
 * PayrollRun — a monthly payroll. Processing generates one item per active
 * employee (monthly gross = annual base / 12, with a configurable deduction
 * rate) and totals the run. Posting books Dr Salaries Expense (5210) /
 * Cr Cash (1110) for net / Cr Accrued Expenses (2120) for deductions.
 */
class PayrollRun {

  static async findAll() {
    const result = await pool.query(`
      SELECT pr.*, u.first_name || ' ' || u.last_name AS created_by_name, je.journal_number,
             (SELECT COUNT(*) FROM payroll_items pi WHERE pi.payroll_run_id = pr.id)::int AS item_count
      FROM payroll_runs pr
      LEFT JOIN users u ON pr.created_by = u.id
      LEFT JOIN journal_entries je ON pr.journal_entry_id = je.id
      WHERE pr.deleted_at IS NULL
      ORDER BY pr.period_year DESC, pr.period_month DESC, pr.created_at DESC
    `);
    return result.rows;
  }

  static async findById(id) {
    const runResult = await pool.query('SELECT * FROM payroll_runs WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (runResult.rows.length === 0) return null;
    const run = runResult.rows[0];
    const items = await pool.query('SELECT * FROM payroll_items WHERE payroll_run_id = $1 ORDER BY employee_name', [id]);
    run.items = items.rows;
    return run;
  }

  // Create a run for a period and generate items from active employees.
  static async createAndProcess(data, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const year = Number(data.period_year);
      const month = Number(data.period_month);
      if (!year || !month || month < 1 || month > 12) throw new Error('Valid period_year and period_month (1-12) are required');

      const run_number = `PR-${year}-${String(month).padStart(2, '0')}`;
      const existing = await client.query('SELECT id FROM payroll_runs WHERE run_number = $1 AND deleted_at IS NULL', [run_number]);
      if (existing.rows.length > 0) throw new Error(`Payroll run ${run_number} already exists`);

      // Deduction rate (percent of gross) — configurable, default 0. Only
      // used when useStatutoryWithholding is false (see below) — kept as the
      // default so every existing caller's behavior is unchanged.
      const deductionRate = data.deduction_rate != null ? Number(data.deduction_rate) : 0;

      // Real US federal withholding (services/payrollTaxService.js) instead
      // of a flat percent-of-gross guess. Opt-in and default false so no
      // existing caller's numbers change under them — a non-US company (or
      // one not ready to switch) keeps getting exactly today's behavior.
      const useStatutoryWithholding = Boolean(data.use_statutory_withholding);

      // Created as DRAFT, not PROCESSED — computing the run's numbers is not
      // the same as authorizing them. approve() (SoD-gated, a distinct user
      // from whoever ran this) moves it to PROCESSED, and only a PROCESSED
      // run can post() to the GL.
      const runResult = await client.query(`
        INSERT INTO payroll_runs (run_number, period_year, period_month, status, notes, created_by, updated_by)
        VALUES ($1,$2,$3,'DRAFT',$4,$5,$5)
        RETURNING *
      `, [run_number, year, month, data.notes || null, userId]);
      const run = runResult.rows[0];

      const employees = await client.query(`
        SELECT id, first_name, last_name, base_salary, filing_status,
               COALESCE(housing_allowance, 0) AS housing_allowance,
               COALESCE(transport_allowance, 0) AS transport_allowance,
               COALESCE(other_allowance, 0) AS other_allowance
        FROM employees WHERE status = 'ACTIVE' AND deleted_at IS NULL
      `);

      let totalGross = 0, totalDeductions = 0, totalNet = 0;
      let totalEmployerPayrollTax = 0;
      for (const emp of employees.rows) {
        // Monthly gross = base/12 + monthly allowances; deductions apply to gross.
        const allowances = Number(emp.housing_allowance) + Number(emp.transport_allowance) + Number(emp.other_allowance);
        const monthlyGross = calc.round2(calc.monthlyGross(emp.base_salary) + allowances);

        let deductions, net;
        let statutory = null;
        if (useStatutoryWithholding) {
          // YTD gross from every earlier run THIS calendar year for this
          // employee — derived from actual run history each time, rather
          // than a separately-maintained running total that could drift
          // from it (e.g. after a run is corrected or reprocessed).
          const ytd = await client.query(`
            SELECT COALESCE(SUM(pi.gross_salary), 0)::float AS ytd_gross
              FROM payroll_items pi
              JOIN payroll_runs pr ON pr.id = pi.payroll_run_id
             WHERE pi.employee_id = $1 AND pr.period_year = $2 AND pr.id != $3 AND pr.deleted_at IS NULL
          `, [emp.id, year, run.id]);
          statutory = payrollTax.calculatePayrollTax({
            grossPay: monthlyGross,
            payPeriodsPerYear: 12,
            filingStatus: emp.filing_status || 'SINGLE',
            ytdGrossBeforeThisPeriod: Number(ytd.rows[0].ytd_gross),
          });
          deductions = statutory.total_employee_withholding;
          net = statutory.net_pay;
          totalEmployerPayrollTax += statutory.employer_payroll_tax_cost;
        } else {
          deductions = calc.round2(monthlyGross * (deductionRate / 100));
          net = calc.round2(monthlyGross - deductions);
        }

        await client.query(`
          INSERT INTO payroll_items (
            payroll_run_id, employee_id, employee_name, gross_salary, deductions, net_salary,
            federal_tax_withheld, social_security_employee, medicare_employee,
            social_security_employer, medicare_employer
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        `, [
          run.id, emp.id, `${emp.first_name} ${emp.last_name}`, monthlyGross, deductions, net,
          statutory?.federal_income_tax || 0, statutory?.social_security_employee || 0, statutory?.medicare_employee || 0,
          statutory?.social_security_employer || 0, statutory?.medicare_employer || 0,
        ]);
        totalGross += monthlyGross;
        totalDeductions += deductions;
        totalNet += net;
      }

      const updated = await client.query(`
        UPDATE payroll_runs
           SET total_gross = $1, total_deductions = $2, total_net = $3, employer_payroll_tax = $4, updated_at = CURRENT_TIMESTAMP
         WHERE id = $5 RETURNING *
      `, [round2(totalGross), round2(totalDeductions), round2(totalNet), round2(totalEmployerPayrollTax), run.id]);

      await client.query('COMMIT');
      return { ...updated.rows[0], employees_processed: employees.rows.length };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Approve a DRAFT run — the SoD gate that makes "approved" a real step
  // rather than a formality (route enforces the creator != approver check via
  // requireSoD; this re-checks so the model is safe to call directly too).
  static async approve(id, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const runRes = await client.query('SELECT * FROM payroll_runs WHERE id = $1 FOR UPDATE', [id]);
      if (runRes.rows.length === 0) throw new Error('Payroll run not found');
      const run = runRes.rows[0];

      if (run.status !== 'DRAFT') throw new Error(`Only a DRAFT payroll run can be approved (this run is ${run.status})`);
      if (String(run.created_by) === String(userId)) {
        throw new Error('Segregation of duties: you ran this payroll, so you cannot approve it. Someone else with the necessary authority has to.');
      }

      const result = await client.query(`
        UPDATE payroll_runs SET status = 'PROCESSED', approved_by = $2, approved_at = CURRENT_TIMESTAMP,
               updated_by = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 RETURNING *
      `, [id, userId]);

      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Post the payroll run to the GL. Posting is mandatory — a run marked POSTED
  // with no journal entry misstates the P&L and payroll liabilities (audit B11).
  static async post(id, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const runRes = await client.query('SELECT * FROM payroll_runs WHERE id = $1 FOR UPDATE', [id]);
      if (runRes.rows.length === 0) throw new Error('Payroll run not found');
      const run = runRes.rows[0];

      if (run.status === 'POSTED') throw new Error('Payroll run already posted');
      if (run.status !== 'PROCESSED') throw new Error(`Only an approved (PROCESSED) payroll run can be posted — this run is ${run.status}. Approve it first.`);
      if (Number(run.total_gross) <= 0) throw new Error('Nothing to post — run has no payroll');

      let journalEntryId = null;
      {
        const accs = await client.query(`
          SELECT id, account_code FROM chart_of_accounts
          WHERE account_code IN ('5210','1110','2120','2125','2126','5211') AND status = 'ACTIVE' AND deleted_at IS NULL
        `);
        const map = {};
        accs.rows.forEach((a) => { map[a.account_code] = a.id; });

        const netCreditAccount = map['2125'] || map['1110'];
        const deductionCreditAccount = map['2126'] || map['2120'];
        if (!map['5210'] || !netCreditAccount) {
          throw new Error('Cannot post payroll: Salaries Expense (5210) and/or a net-pay account (2125 Salaries Payable or 1110 Cash) missing or inactive');
        }

        const byCC = await client.query(`
          SELECT e.cost_center_id, COALESCE(SUM(pi.gross_salary), 0) AS gross
          FROM payroll_items pi
          JOIN employees e ON pi.employee_id = e.id
          WHERE pi.payroll_run_id = $1
          GROUP BY e.cost_center_id
        `, [id]);

        const expenseLines = byCC.rows
          .filter((r) => Number(r.gross) > 0)
          .map((r) => ({
            account_id: map['5210'],
            debit_amount: Number(r.gross),
            credit_amount: 0,
            cost_center_id: r.cost_center_id || null,
            description: 'Salaries expense',
          }));

        const items = expenseLines.length > 0
          ? expenseLines.slice()
          : [{ account_id: map['5210'], debit_amount: Number(run.total_gross), credit_amount: 0, description: 'Salaries expense' }];
        const netLine = { account_id: netCreditAccount, debit_amount: 0, credit_amount: Number(run.total_net), description: map['2125'] ? 'Net pay payable' : 'Net pay (cash)' };
        items.push(netLine);
        if (Number(run.total_deductions) > 0 && deductionCreditAccount) {
          items.push({ account_id: deductionCreditAccount, debit_amount: 0, credit_amount: Number(run.total_deductions), description: 'Payroll tax/deductions payable' });
        } else if (Number(run.total_deductions) > 0) {
          netLine.credit_amount = Number(run.total_gross);
        }

        if (Number(run.employer_payroll_tax) > 0 && map['5211'] && deductionCreditAccount) {
          items.push({ account_id: map['5211'], debit_amount: Number(run.employer_payroll_tax), credit_amount: 0, description: 'Employer payroll tax expense (FICA match)' });
          items.push({ account_id: deductionCreditAccount, debit_amount: 0, credit_amount: Number(run.employer_payroll_tax), description: 'Employer payroll tax payable' });
        }

        // Pass externalClient = client so JournalEntry.create and updateStatus share this transaction
        const entry = await JournalEntry.create({
          entry_date: new Date().toISOString().split('T')[0],
          source_type: 'PAYROLL',
          source_id: id,
          description: `Payroll ${run.run_number}`,
          reference: run.run_number,
          requires_approval: false,
        }, items, userId, client);

        await JournalEntry.postAsSystem(entry.id, userId, 'Auto-posted payroll', client);
        journalEntryId = entry.id;
      }

      const result = await client.query(`
        UPDATE payroll_runs SET status = 'POSTED', journal_entry_id = COALESCE($2, journal_entry_id), updated_by = $3, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 RETURNING *
      `, [id, journalEntryId, userId]);

      // Append transaction-atomic audit record for Payroll Post
      const { auditStatusTransition } = require('../services/auditHook');
      await auditStatusTransition({
        client,
        entityType: 'PAYROLL_RUN',
        entityId: id,
        fromStatus: run.status,
        toStatus: 'POSTED',
        actorId: userId,
        reason: `Payroll run ${run.run_number} posted to GL`
      });

      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Settle a posted payroll: pay the accrued net from cash.
  // Dr Salaries Payable (2125) / Cr Cash (1110).
  static async markPaid(id, userId, cashAccountCode = '1110') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const runRes = await client.query('SELECT * FROM payroll_runs WHERE id = $1 FOR UPDATE', [id]);
      if (runRes.rows.length === 0) throw new Error('Payroll run not found');
      const run = runRes.rows[0];

      if (run.status === 'PAID') throw new Error('Payroll run already paid');
      if (run.status !== 'POSTED') throw new Error('Only a POSTED payroll run can be paid');

      const accs = await client.query(`
        SELECT id, account_code FROM chart_of_accounts
        WHERE account_code IN ('2125', $1) AND status = 'ACTIVE' AND deleted_at IS NULL
      `, [cashAccountCode]);
      const map = {};
      accs.rows.forEach((a) => { map[a.account_code] = a.id; });
      if (!map['2125'] || !map[cashAccountCode]) {
        throw new Error(`Cannot post payroll payment: Salaries Payable (2125) and/or cash account ${cashAccountCode} missing or inactive`);
      }

      const entry = await JournalEntry.create({
        entry_date: new Date().toISOString().split('T')[0],
        source_type: 'PAYROLL',
        source_id: id,
        description: `Payroll payment ${run.run_number}`,
        reference: run.run_number,
        requires_approval: false,
      }, [
        { account_id: map['2125'], debit_amount: Number(run.total_net), credit_amount: 0, description: 'Settle net pay payable' },
        { account_id: map[cashAccountCode], debit_amount: 0, credit_amount: Number(run.total_net), description: 'Salaries paid' },
      ], userId, client);

      await JournalEntry.postAsSystem(entry.id, userId, 'Auto-posted payroll payment', client);

      const result = await client.query(
        "UPDATE payroll_runs SET status = 'PAID', updated_by = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *",
        [id, userId]
      );

      // Append transaction-atomic audit record for Payroll Payment
      const { auditStatusTransition } = require('../services/auditHook');
      await auditStatusTransition({
        client,
        entityType: 'PAYROLL_RUN',
        entityId: id,
        fromStatus: run.status,
        toStatus: 'PAID',
        actorId: userId,
        reason: `Payroll run ${run.run_number} marked paid`
      });

      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = PayrollRun;
