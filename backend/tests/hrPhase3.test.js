// HR: 6 -> 10 regression suite.
//
// Covers the three real gaps closed this session:
//  1. Payroll run lifecycle — createAndProcess now creates DRAFT, not
//     PROCESSED. approve() is SoD-gated (creator cannot approve their own
//     run) and only an approved (PROCESSED) run can post() to the GL.
//  2. Leave accrual + a real balance ledger — leave_accrual_policies,
//     leave_balances, leave_balance_transactions. Approving a leave request
//     deducts from the balance and is blocked when insufficient; UNPAID
//     leave never touches a balance; cancelling an approved request credits
//     the days back; a second accrual run for the same period is a no-op.
//  3. Org chart + job history — employees.manager_id builds a real tree;
//     Employee.update writes a job_history row for every tracked field that
//     actually changed.
//
// Real-DB suite: self-skips when no database is reachable. Run on its own:
//   cd backend && node --test tests/hrPhase3.test.js

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { pool } = require('../config/database');
const Employee = require('../models/Employee');
const PayrollRun = require('../models/PayrollRun');
const Leave = require('../models/Leave');

let dbAvailable = false;
let creatorId = null;
let approverId = null;

const created = { employeeIds: [], payrollRunIds: [], leaveRequestIds: [] };

before(async () => {
  try {
    await pool.query('SELECT 1');
    const users = await pool.query(
      "SELECT id FROM users WHERE deleted_at IS NULL AND COALESCE(is_active, true) = true AND role IN ('ADMIN','MANAGER') ORDER BY created_at LIMIT 2"
    );
    if (users.rows.length < 2) throw new Error('need at least 2 manager/admin users for the SoD half of this test');
    [creatorId, approverId] = users.rows.map((r) => r.id);
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }
});

after(async () => {
  if (dbAvailable) {
    for (const id of created.leaveRequestIds) {
      await pool.query('DELETE FROM leave_balance_transactions WHERE reference_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM leave_requests WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.payrollRunIds) {
      await pool.query('DELETE FROM journal_entry_items WHERE journal_entry_id IN (SELECT journal_entry_id FROM payroll_runs WHERE id = $1)', [id]).catch(() => {});
      await pool.query('DELETE FROM journal_entries WHERE id IN (SELECT journal_entry_id FROM payroll_runs WHERE id = $1)', [id]).catch(() => {});
      await pool.query('DELETE FROM payroll_items WHERE payroll_run_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM payroll_runs WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.employeeIds) {
      await pool.query('DELETE FROM leave_balances WHERE employee_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM leave_balance_transactions WHERE employee_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM employee_job_history WHERE employee_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM employees WHERE id = $1', [id]).catch(() => {});
    }
  }
  await pool.end().catch(() => {});
});

async function seedEmployee(overrides = {}) {
  const emp = await Employee.create({
    first_name: `HRTest${randomUUID().slice(0, 6)}`,
    last_name: 'Employee',
    base_salary: 60000,
    status: 'ACTIVE',
    ...overrides,
  }, creatorId);
  created.employeeIds.push(emp.id);
  return emp;
}

// ---- Payroll lifecycle -------------------------------------------------

test('payroll run: created DRAFT, cannot post before approval, SoD blocks self-approval, distinct approver can post', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  await seedEmployee({ base_salary: 60000 });

  const year = 2031, month = 1; // future/unused period, avoids colliding with real data
  const run = await PayrollRun.createAndProcess({ period_year: year, period_month: month, deduction_rate: 10 }, creatorId);
  created.payrollRunIds.push(run.id);
  assert.equal(run.status, 'DRAFT', 'a freshly-processed run is DRAFT, not already PROCESSED');

  await assert.rejects(
    () => PayrollRun.post(run.id, approverId),
    /Only an approved.*PROCESSED.*payroll run can be posted/,
    'posting a DRAFT run must be refused'
  );

  await assert.rejects(
    () => PayrollRun.approve(run.id, creatorId),
    /Segregation of duties/,
    'the person who ran payroll cannot approve their own run'
  );

  // The route wires requireSoD(recordCreator('payroll_runs'), ...) — prove
  // that resolver actually finds this run's real creator, the same way
  // creditNoteApproval.test.js proves it for sales_credit_notes, so the SoD
  // guard on the live route (not just the model) is backed by a real check.
  const { recordCreator } = require('../middleware/recordOwner');
  const getCreator = recordCreator('payroll_runs');
  const ownerId = await getCreator({ params: { id: run.id } });
  assert.equal(ownerId, creatorId, "recordCreator('payroll_runs') must resolve the run's actual creator");

  const approved = await PayrollRun.approve(run.id, approverId);
  assert.equal(approved.status, 'PROCESSED');
  assert.equal(approved.approved_by, approverId);

  await assert.rejects(
    () => PayrollRun.approve(run.id, approverId),
    /Only a DRAFT payroll run can be approved/,
    'an already-approved run cannot be re-approved'
  );

  const posted = await PayrollRun.post(run.id, approverId);
  assert.equal(posted.status, 'POSTED');
  assert.ok(posted.journal_entry_id, 'posting must produce a journal entry');

  const lines = await pool.query('SELECT debit_amount, credit_amount FROM journal_entry_items WHERE journal_entry_id = $1', [posted.journal_entry_id]);
  const totalDebit = lines.rows.reduce((s, l) => s + Number(l.debit_amount), 0);
  const totalCredit = lines.rows.reduce((s, l) => s + Number(l.credit_amount), 0);
  assert.equal(totalDebit.toFixed(2), totalCredit.toFixed(2), 'the posted journal entry must balance');
});

// ---- Leave accrual + balance ledger -------------------------------------

test('leave accrual: policy accrues once per period, is idempotent, and the balance ledger reflects it', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const emp = await seedEmployee();
  await Leave.upsertPolicy({ leave_type: 'ANNUAL', monthly_accrual_days: 1.5 }, creatorId);

  const year = 2031, month = 3;
  const first = await Leave.accrueMonthly(year, month, creatorId);
  assert.ok(first.accrued >= 1, 'at least this employee should accrue');

  const balances = await Leave.getBalances(emp.id);
  const annual = balances.find((b) => b.leave_type === 'ANNUAL');
  assert.ok(annual, 'a balance row for ANNUAL must exist after accrual');
  assert.equal(Number(annual.balance_days), 1.5);

  // Re-running the same period must not double-credit.
  const second = await Leave.accrueMonthly(year, month, creatorId);
  assert.ok(second.skipped >= 1, 'a second accrual for the same period must be skipped, not re-applied');

  const balancesAfter = await Leave.getBalances(emp.id);
  const annualAfter = balancesAfter.find((b) => b.leave_type === 'ANNUAL');
  assert.equal(Number(annualAfter.balance_days), 1.5, 'balance must be unchanged by the idempotent re-run');
});

test('leave approval: deducts from balance, blocks when insufficient, releases on cancel, UNPAID never touches a balance', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const emp = await seedEmployee();
  await Leave.upsertPolicy({ leave_type: 'ANNUAL', monthly_accrual_days: 2 }, creatorId);
  await Leave.accrueMonthly(2031, 4, creatorId); // balance = 2

  // Request more than the balance — approval must be refused.
  const bigReqId = randomUUID();
  await pool.query(
    `INSERT INTO leave_requests (id, employee_id, leave_type, start_date, end_date, total_days, created_by)
     VALUES ($1,$2,'ANNUAL','2031-05-01','2031-05-05',5,$3)`,
    [bigReqId, emp.id, creatorId]
  );
  created.leaveRequestIds.push(bigReqId);
  await assert.rejects(
    () => Leave.decide(bigReqId, 'APPROVED', approverId),
    /Insufficient ANNUAL leave balance/
  );

  // A request within balance succeeds and deducts.
  const okReqId = randomUUID();
  await pool.query(
    `INSERT INTO leave_requests (id, employee_id, leave_type, start_date, end_date, total_days, created_by)
     VALUES ($1,$2,'ANNUAL','2031-05-01','2031-05-01',1,$3)`,
    [okReqId, emp.id, creatorId]
  );
  created.leaveRequestIds.push(okReqId);
  const decided = await Leave.decide(okReqId, 'APPROVED', approverId);
  assert.equal(decided.status, 'APPROVED');

  let balances = await Leave.getBalances(emp.id);
  assert.equal(Number(balances.find((b) => b.leave_type === 'ANNUAL').balance_days), 1, 'balance must drop by the approved days');

  // Cancelling an approved request releases the days back.
  await Leave.decide(okReqId, 'CANCELLED', approverId);
  balances = await Leave.getBalances(emp.id);
  assert.equal(Number(balances.find((b) => b.leave_type === 'ANNUAL').balance_days), 2, 'cancelling an approved request must credit the days back');

  // UNPAID leave never touches a balance, and is never blocked by one.
  const unpaidReqId = randomUUID();
  await pool.query(
    `INSERT INTO leave_requests (id, employee_id, leave_type, start_date, end_date, total_days, created_by)
     VALUES ($1,$2,'UNPAID','2031-06-01','2031-06-10',10,$3)`,
    [unpaidReqId, emp.id, creatorId]
  );
  created.leaveRequestIds.push(unpaidReqId);
  const unpaidDecided = await Leave.decide(unpaidReqId, 'APPROVED', approverId);
  assert.equal(unpaidDecided.status, 'APPROVED');
  balances = await Leave.getBalances(emp.id);
  assert.equal(Number(balances.find((b) => b.leave_type === 'ANNUAL').balance_days), 2, 'UNPAID approval must not touch the ANNUAL balance');
});

// ---- Org chart + job history --------------------------------------------

test('org chart: manager_id builds a real reporting tree', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const manager = await seedEmployee();
  const report = await seedEmployee({ manager_id: manager.id });

  const tree = await Employee.orgChart();
  const managerNode = tree.find((n) => n.id === manager.id) || tree.flatMap((n) => n.reports).find((n) => n.id === manager.id);
  assert.ok(managerNode, 'the manager must appear somewhere in the tree');
  assert.ok(managerNode.reports.some((r) => r.id === report.id), 'the report must be nested under their manager');
});

test('job history: Employee.update writes a row per changed tracked field, and no row for an unchanged field', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const emp = await seedEmployee({ department: 'Engineering', base_salary: 60000 });

  await Employee.update(emp.id, { department: 'Sales', base_salary: 60000, first_name: emp.first_name }, approverId);

  const history = await Employee.jobHistory(emp.id);
  const deptChange = history.find((h) => h.field_name === 'department');
  assert.ok(deptChange, 'a department change must be recorded');
  assert.equal(deptChange.old_value, 'Engineering');
  assert.equal(deptChange.new_value, 'Sales');
  assert.equal(deptChange.changed_by, approverId);

  const salaryChange = history.find((h) => h.field_name === 'base_salary');
  assert.ok(!salaryChange, 'an unchanged field must not produce a history row');
});
