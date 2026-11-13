// Regression tests for PHASE3_TEN_TENTHS_PROMPT.md item 4 ("Projects: 4 -> 10"):
// timesheet approval, budget/commitment/EAC forecasting, resource loading,
// and milestone-based revenue recognition posting to the GL.
//
// Billing integrity itself (double-billing, rate freezing, P&L) is covered by
// tests/crmProjects.test.js — this file is scoped to the four gaps found
// while reading models/Project.js against that prompt's checklist: none of
// this existed before this session.
//
// Real-DB suite: self-skips when no database is reachable, or when the DB
// has fewer than two ADMIN/MANAGER users (needed for the SoD half of the
// approval tests). Run on its own:
//   cd backend && node --test tests/projectPhase3.test.js

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');

const { pool } = require('../config/database');
const { Projects, TimeEntries, ResourceAssignments, Milestones } = require('../models/Project');

let dbAvailable = false;
let balanceSnapshot = null;
let userId = null;
let approverId = null;
let customerId = null;

const created = {
  projectIds: [], timeEntryIds: [], invoiceIds: [], journalEntryIds: [],
  employeeIds: [], assignmentIds: [], milestoneIds: [], poIds: [], customerIds: [],
};

async function purgeJournalEntry(id) {
  if (!id) return;
  const items = await pool.query(
    'SELECT account_code, debit_amount::float d, credit_amount::float c FROM journal_entry_items WHERE journal_entry_id = $1',
    [id]
  );
  for (const it of items.rows) {
    const delta = (it.d || 0) - (it.c || 0);
    await pool.query(
      `UPDATE chart_of_accounts
          SET current_balance = current_balance - ($2::numeric * CASE WHEN normal_balance = 'DEBIT' THEN 1 ELSE -1 END)
        WHERE account_code = $1`,
      [it.account_code, delta]
    ).catch(() => {});
  }
  await pool.query('DELETE FROM journal_entry_status_history WHERE journal_entry_id = $1', [id]).catch(() => {});
  await pool.query('DELETE FROM journal_entry_items WHERE journal_entry_id = $1', [id]).catch(() => {});
  await pool.query('DELETE FROM journal_entries WHERE id = $1', [id]).catch(() => {});
}

async function makeProject(overrides = {}) {
  const project = await Projects.create({
    name: `Phase3 Project ${Math.random().toString(36).slice(2, 8)}`,
    customer_id: customerId,
    billing_type: 'TIME_AND_MATERIALS',
    default_hourly_rate: 100,
    currency: 'USD',
    ...overrides,
  }, userId);
  created.projectIds.push(project.id);
  return project;
}

async function makeEmployee(overrides = {}) {
  const emp = await pool.query(
    `INSERT INTO employees (employee_number, first_name, last_name, status, base_salary, hourly_cost_rate, weekly_capacity_hours, created_by)
     VALUES ($1,'Res','Ource','ACTIVE',$2,$3,$4,$5) RETURNING id`,
    [`EMP${String(Date.now()).slice(-9)}${Math.floor(Math.random() * 100)}`,
     overrides.base_salary || 104000, overrides.hourly_cost_rate ?? 50,
     overrides.weekly_capacity_hours ?? 40, userId]
  );
  created.employeeIds.push(emp.rows[0].id);
  return emp.rows[0].id;
}

async function logHours(projectId, hours, overrides = {}) {
  const entry = await TimeEntries.create({
    project_id: projectId,
    entry_date: new Date().toISOString().split('T')[0],
    hours,
    description: 'phase3 test work',
    ...overrides,
  }, userId);
  created.timeEntryIds.push(entry.id);
  return entry;
}

before(async () => {
  try {
    await pool.query('SELECT 1');
    const users = await pool.query(
      "SELECT id FROM users WHERE deleted_at IS NULL AND COALESCE(is_active, true) = true ORDER BY created_at LIMIT 2"
    );
    if (users.rows.length < 2) throw new Error('need at least 2 users');
    [userId, approverId] = users.rows.map((r) => r.id);

    const cust = await pool.query(
      `INSERT INTO customers (customer_code, customer_name, status, credit_days, created_by)
       VALUES ($1, 'Phase3 Test Co', 'ACTIVE', 30, $2) RETURNING id`,
      [`P3T${String(Date.now()).slice(-9)}`, userId]
    );
    customerId = cust.rows[0].id;
    created.customerIds.push(customerId);

    balanceSnapshot = (await pool.query('SELECT id, current_balance FROM chart_of_accounts')).rows;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  if (dbAvailable) {
    for (const id of created.poIds) await pool.query('DELETE FROM purchase_orders WHERE id = $1', [id]).catch(() => {});
    await pool.query('UPDATE time_entries SET invoice_id = NULL WHERE project_id = ANY($1)', [created.projectIds]).catch(() => {});
    for (const id of created.invoiceIds) {
      await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM customer_invoice_status_history WHERE invoice_id = $1', [id]).catch(() => {});
      await pool.query('UPDATE project_milestones SET invoice_id = NULL WHERE invoice_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM customer_invoices WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.journalEntryIds) await purgeJournalEntry(id);
    await pool.query('DELETE FROM project_milestones WHERE project_id = ANY($1)', [created.projectIds]).catch(() => {});
    await pool.query('DELETE FROM project_assignments WHERE project_id = ANY($1)', [created.projectIds]).catch(() => {});
    await pool.query('DELETE FROM time_entries WHERE project_id = ANY($1)', [created.projectIds]).catch(() => {});
    await pool.query('DELETE FROM projects WHERE id = ANY($1)', [created.projectIds]).catch(() => {});
    for (const id of created.employeeIds) await pool.query('DELETE FROM employees WHERE id = $1', [id]).catch(() => {});
    for (const id of created.customerIds) await pool.query('DELETE FROM customers WHERE id = $1', [id]).catch(() => {});
  }
  if (balanceSnapshot) {
    for (const row of balanceSnapshot) {
      await pool.query('UPDATE chart_of_accounts SET current_balance = $2 WHERE id = $1',
        [row.id, row.current_balance]).catch(() => {});
    }
  }
  await pool.end();
});

// ===========================================================================
// Timesheet approval
// ===========================================================================

test('an unapproved hour cannot be billed', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const project = await makeProject();
  await logHours(project.id, 4);

  const preview = await TimeEntries.previewBilling(project.id);
  assert.equal(preview.entries.length, 0, 'a PENDING entry must not appear as billable');

  await assert.rejects(() => TimeEntries.billProject(project.id, {}, userId), /no unbilled|nothing to bill/i);
});

test('you cannot approve your own time entry', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const project = await makeProject();
  const entry = await logHours(project.id, 2);

  await assert.rejects(() => TimeEntries.approve(entry.id, userId), /cannot approve your own/i);
});

test('a distinct approver can approve, and the entry then bills', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const project = await makeProject();
  const entry = await logHours(project.id, 3);

  const approved = await TimeEntries.approve(entry.id, approverId);
  assert.equal(approved.approval_status, 'APPROVED');
  assert.equal(approved.approved_by, approverId);

  const result = await TimeEntries.billProject(project.id, {}, userId);
  created.invoiceIds.push(result.invoice.id);
  created.journalEntryIds.push(result.invoice.journal_entry_id);
  assert.equal(result.hours_billed, 3);
});

test('rejecting a time entry requires a reason and records it, and it can be corrected and resubmitted', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const project = await makeProject();
  const entry = await logHours(project.id, 5);

  await assert.rejects(() => TimeEntries.reject(entry.id, approverId, ''), /reason/i);

  const rejected = await TimeEntries.reject(entry.id, approverId, 'wrong project code');
  assert.equal(rejected.approval_status, 'REJECTED');
  assert.equal(rejected.rejection_reason, 'wrong project code');

  // Editing a rejected entry puts it back to PENDING — a changed entry is not
  // the same claim the rejection was about.
  const corrected = await TimeEntries.update(entry.id, { hours: 4 });
  assert.equal(corrected.approval_status, 'PENDING');
  assert.equal(Number(corrected.hours), 4);
});

test('an approved entry cannot be silently edited or deleted', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const project = await makeProject();
  const entry = await logHours(project.id, 2);
  await TimeEntries.approve(entry.id, approverId);

  await assert.rejects(() => TimeEntries.update(entry.id, { hours: 99 }), /approved|invoiced/i);
  await assert.rejects(() => TimeEntries.remove(entry.id), /approved|invoiced/i);
});

// ===========================================================================
// Budgeting, commitment tracking and estimate-at-completion
// ===========================================================================

test('budget report shows actual cost, open PO commitment and a projected total', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const project = await makeProject({ budget_amount: 10000, budget_hours: 100 });

  const employeeId = await makeEmployee({ hourly_cost_rate: 60 });
  const entry = await logHours(project.id, 20, { employee_id: employeeId });
  await TimeEntries.approve(entry.id, approverId);

  // An open commitment: a PO raised against this project that has not yet
  // been received.
  const supplier = await pool.query(`SELECT id FROM suppliers LIMIT 1`);
  if (supplier.rows.length) {
    const po = await pool.query(
      `INSERT INTO purchase_orders (po_number, supplier_id, project_id, status, subtotal, total_amount, created_by)
       VALUES ($1,$2,$3,'CONFIRMED',3000,3000,$4) RETURNING id`,
      [`P3PO${String(Date.now()).slice(-8)}`, supplier.rows[0].id, project.id, userId]
    );
    created.poIds.push(po.rows[0].id);
  }

  const report = await Projects.budgetReport(project.id);
  assert.equal(report.budget.amount, 10000);
  assert.equal(report.budget.hours, 100);
  assert.equal(report.actual.cost, 1200, '20 hours at a 60 cost rate');
  assert.equal(report.actual.hours, 20);
  if (supplier.rows.length) {
    assert.equal(report.committed, 3000);
    assert.equal(report.projected_total, 4200, 'actual 1200 + committed 3000');
  }
  assert.ok(report.forecast.estimate_at_completion > report.actual.cost,
    'EAC should project beyond cost incurred so far, since only 20 of 100 budgeted hours are logged');
  assert.equal(report.forecast.percent_complete, 20);
});

test('EAC is not fabricated when there is no burn rate to project from', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const project = await makeProject({ budget_amount: 5000, budget_hours: 50 });

  const report = await Projects.budgetReport(project.id);
  assert.equal(report.forecast.estimate_at_completion, null, 'no hours logged means no rate to project from');
  assert.match(report.forecast.note, /no cost rate|needs at least one costed hour/i);

  const projectNoHourBudget = await makeProject({ budget_amount: 5000 });
  const reportNoHourBudget = await Projects.budgetReport(projectNoHourBudget.id);
  assert.equal(reportNoHourBudget.forecast.estimate_at_completion, null);
  assert.match(reportNoHourBudget.forecast.note, /no budget_hours/i);
});

// ===========================================================================
// Resource loading
// ===========================================================================

test('resource loading reports allocation against capacity and flags overallocation', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const projectA = await makeProject();
  const projectB = await makeProject();
  const employeeId = await makeEmployee({ weekly_capacity_hours: 40 });

  const today = new Date().toISOString().split('T')[0];
  const a1 = await ResourceAssignments.create(
    { project_id: projectA.id, employee_id: employeeId, allocation_hours_per_week: 25, start_date: today }, userId);
  const a2 = await ResourceAssignments.create(
    { project_id: projectB.id, employee_id: employeeId, allocation_hours_per_week: 20, start_date: today }, userId);
  created.assignmentIds.push(a1.id, a2.id);

  const load = await ResourceAssignments.loadForEmployee(employeeId, today);
  assert.equal(load.capacity_hours_per_week, 40);
  assert.equal(load.allocated_hours_per_week, 45, '25 + 20 across two active projects');
  assert.equal(load.overallocated, true);
  assert.equal(load.assignments.length, 2);

  const overview = await ResourceAssignments.loadOverview(today);
  const row = overview.find((r) => r.employee_id === employeeId);
  assert.ok(row, 'the overallocated employee should appear in the company-wide overview');
  assert.equal(row.overallocated, true);
});

test('an assignment outside its date range does not count toward the load', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const project = await makeProject();
  const employeeId = await makeEmployee();

  const assignment = await ResourceAssignments.create(
    { project_id: project.id, employee_id: employeeId, allocation_hours_per_week: 30,
      start_date: '2020-01-01', end_date: '2020-06-30' }, userId);
  created.assignmentIds.push(assignment.id);

  const load = await ResourceAssignments.loadForEmployee(employeeId, '2026-01-01');
  assert.equal(load.allocated_hours_per_week, 0, 'an assignment that already ended must not still show as load');
  assert.equal(load.overallocated, false);
});

// ===========================================================================
// Milestone billing / revenue recognition
// ===========================================================================

test('a milestone must be achieved before it can be billed, and billing posts a balanced GL entry', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const project = await makeProject({ billing_type: 'FIXED_PRICE', fixed_price: 20000, default_hourly_rate: null });

  const milestone = await Milestones.create(
    { project_id: project.id, name: 'Phase 1 delivery', amount: 8000 }, userId);
  created.milestoneIds.push(milestone.id);
  assert.equal(milestone.status, 'PENDING');

  await assert.rejects(() => Milestones.bill(milestone.id, userId), /ACHIEVED/i,
    'a PENDING milestone cannot be billed');

  const achieved = await Milestones.achieve(milestone.id, userId);
  assert.equal(achieved.status, 'ACHIEVED');

  const result = await Milestones.bill(milestone.id, userId);
  created.invoiceIds.push(result.invoice.id);
  created.journalEntryIds.push(result.invoice.journal_entry_id);

  assert.equal(result.milestone.status, 'BILLED');
  assert.equal(result.milestone.invoice_id, result.invoice.id);
  assert.equal(Number(result.invoice.total_amount), 8000);
  assert.equal(result.invoice.project_id, project.id);

  const je = await pool.query(
    `SELECT je.status, ROUND(SUM(jei.debit_amount),2)::float d, ROUND(SUM(jei.credit_amount),2)::float c
       FROM journal_entries je JOIN journal_entry_items jei ON jei.journal_entry_id = je.id
      WHERE je.id = $1 GROUP BY je.id, je.status`,
    [result.invoice.journal_entry_id]);
  assert.equal(je.rows[0].status, 'POSTED');
  assert.equal(je.rows[0].d, je.rows[0].c, 'the milestone revenue entry must balance');

  // Milestone revenue counts in the project P&L exactly like time-billed
  // revenue does, because customer_invoices.project_id now tags both.
  const pl = await Projects.profitAndLoss(project.id);
  assert.equal(pl.revenue.invoiced, 8000);
});

test('a milestone cannot be billed twice', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const project = await makeProject({ billing_type: 'FIXED_PRICE', fixed_price: 5000, default_hourly_rate: null });
  const milestone = await Milestones.create({ project_id: project.id, name: 'Only milestone', amount: 5000 }, userId);
  created.milestoneIds.push(milestone.id);

  await Milestones.achieve(milestone.id, userId);
  const first = await Milestones.bill(milestone.id, userId);
  created.invoiceIds.push(first.invoice.id);
  created.journalEntryIds.push(first.invoice.journal_entry_id);

  await assert.rejects(() => Milestones.bill(milestone.id, userId), /BILLED|ACHIEVED/i);
});

test('a milestone on a project with no customer cannot be invoiced', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const project = await Projects.create({
    name: `Phase3 No-Customer ${Math.random().toString(36).slice(2, 8)}`,
    billing_type: 'INTERNAL',
  }, userId);
  created.projectIds.push(project.id);

  const milestone = await Milestones.create({ project_id: project.id, name: 'Internal milestone', amount: 1000 }, userId);
  created.milestoneIds.push(milestone.id);
  await Milestones.achieve(milestone.id, userId);

  await assert.rejects(() => Milestones.bill(milestone.id, userId), /no customer/i);
});
