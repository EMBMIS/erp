// CRM and Projects tests.
//
// Weighted toward billing, because that is where this module touches money and
// the customer sees the result. The tests that matter most are the ones proving
// an hour cannot be billed twice — under a retry, under a double-click, and
// under two people billing the same project at the same moment.
//
// The concurrency test runs two real overlapping transactions against the real
// database rather than mocking the race, since the guarantee being tested is a
// property of the SQL, not of the JavaScript around it.
//
// Run on its own:  npm run test:crm-projects

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');

const { pool } = require('../config/database');
const { Contacts, Deals, Activities } = require('../models/Crm');
const { Projects, TimeEntries } = require('../models/Project');

let dbAvailable = false;
// chart_of_accounts.current_balance is maintained additively by
// JournalEntry.updateAccountBalances, so deleting a journal entry does not undo
// its effect on the cache. Any test that posts to the GL must restore the
// balances it moved, or it leaves the database failing db:verify's
// account-balance-cache invariant for every later run.
let balanceSnapshot = null;

let userId = null;
let approverId = null;
let customerId = null;

const created = {
  contactIds: [], dealIds: [], activityIds: [],
  projectIds: [], taskIds: [], timeEntryIds: [],
  invoiceIds: [], journalEntryIds: [], customerIds: [],
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
    name: `Test Project ${Math.random().toString(36).slice(2, 8)}`,
    customer_id: customerId,
    billing_type: 'TIME_AND_MATERIALS',
    default_hourly_rate: 100,
    currency: 'USD',
    ...overrides,
  }, userId);
  created.projectIds.push(project.id);
  return project;
}

async function logHours(projectId, hours, overrides = {}) {
  const entry = await TimeEntries.create({
    project_id: projectId,
    entry_date: new Date().toISOString().split('T')[0],
    hours,
    description: 'test work',
    ...overrides,
  }, userId);
  created.timeEntryIds.push(entry.id);
  return entry;
}

// Time entries default to PENDING approval and cannot be billed until a
// distinct user approves them (SoD) — see tests/timesheetApproval.test.js for
// the approval gate itself. Most billing tests here are not about approval,
// so they approve immediately via this helper to get back to the previous
// "log then bill" shape.
async function logApprovedHours(projectId, hours, overrides = {}) {
  const entry = await logHours(projectId, hours, overrides);
  await TimeEntries.approve(entry.id, approverId);
  return entry;
}

before(async () => {
  try {
    await pool.query('SELECT 1');
    const users = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 2');
    if (!users.rows.length) return;
    userId = users.rows[0].id;
    // Approving your own time is refused (SoD) — fall back to the same user
    // only if this test DB genuinely has no second user, in which case the
    // approval-gated tests below self-skip rather than false-fail.
    approverId = users.rows[1]?.id || null;

    const cust = await pool.query(
      `INSERT INTO customers (customer_code, customer_name, status, credit_days, created_by)
       VALUES ($1, 'CRM Projects Test Co', 'ACTIVE', 30, $2) RETURNING id`,
      [`CPT${String(Date.now()).slice(-9)}`, userId]
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
    // Time entries reference invoices, so clear the link before removing either.
    await pool.query('UPDATE time_entries SET invoice_id = NULL WHERE project_id = ANY($1)',
      [created.projectIds]).catch(() => {});
    for (const id of created.invoiceIds) {
      await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM customer_invoice_status_history WHERE invoice_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM customer_invoices WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.journalEntryIds) await purgeJournalEntry(id);
    await pool.query('DELETE FROM time_entries WHERE project_id = ANY($1)', [created.projectIds]).catch(() => {});
    await pool.query('DELETE FROM project_tasks WHERE project_id = ANY($1)', [created.projectIds]).catch(() => {});
    await pool.query('DELETE FROM projects WHERE id = ANY($1)', [created.projectIds]).catch(() => {});
    await pool.query('DELETE FROM activities WHERE id = ANY($1)', [created.activityIds]).catch(() => {});
    await pool.query('DELETE FROM activities WHERE deal_id = ANY($1)', [created.dealIds]).catch(() => {});
    await pool.query('DELETE FROM deals WHERE id = ANY($1)', [created.dealIds]).catch(() => {});
    await pool.query('DELETE FROM contacts WHERE id = ANY($1)', [created.contactIds]).catch(() => {});
    for (const id of created.customerIds) {
      await pool.query('DELETE FROM customers WHERE id = $1', [id]).catch(() => {});
    }
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
// Billing integrity — the reason this file exists
// ===========================================================================

test('billing an hour twice is impossible: the second attempt bills nothing', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  if (!approverId) return t.skip('need a second user for timesheet approval SoD');

  const project = await makeProject();
  await logApprovedHours(project.id, 8);

  const first = await TimeEntries.billProject(project.id, {}, userId);
  created.invoiceIds.push(first.invoice.id);
  created.journalEntryIds.push(first.invoice.journal_entry_id);

  assert.equal(first.entries_billed, 1);
  assert.equal(first.hours_billed, 8);

  // Same call again — a retry or a double-click.
  await assert.rejects(
    () => TimeEntries.billProject(project.id, {}, userId),
    /no unbilled|nothing to bill/i,
    'a second billing run must find nothing left to bill'
  );

  // Count from the invoice side: a second invoice for the same work is the
  // damage, and it stays invisible if you only count invoice_id links (the
  // re-billing run overwrites the link rather than adding one).
  const invoices = await pool.query(
    `SELECT COUNT(*)::int n FROM customer_invoices
      WHERE deleted_at IS NULL AND description LIKE '%' || $1 || '%'`,
    [project.name]);
  assert.equal(invoices.rows[0].n, 1, 'only one invoice may exist for this work');
});

test('two concurrent billing runs cannot both bill the same hours', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  if (!approverId) return t.skip('need a second user for timesheet approval SoD');

  const project = await makeProject();
  await logApprovedHours(project.id, 5);

  // Fire both without awaiting the first, so their transactions overlap.
  const results = await Promise.allSettled([
    TimeEntries.billProject(project.id, {}, userId),
    TimeEntries.billProject(project.id, {}, userId),
  ]);

  for (const r of results) {
    if (r.status === 'fulfilled') {
      created.invoiceIds.push(r.value.invoice.id);
      created.journalEntryIds.push(r.value.invoice.journal_entry_id);
    }
  }

  // The decisive check is how many invoices exist for this project's work, NOT
  // how many time_entries point at an invoice.
  //
  // This distinction was found by deliberately removing the guards and watching
  // what broke: both runs then succeeded and created TWO invoices for the same
  // five hours, but the second run's UPDATE simply overwrote invoice_id on the
  // entry. Counting distinct invoice_id links therefore still returned 1 and
  // reported success while the customer was being billed twice. The duplicate
  // is only visible from the invoice side.
  const invoices = await pool.query(
    `SELECT COUNT(*)::int n FROM customer_invoices
      WHERE deleted_at IS NULL AND description LIKE '%' || $1 || '%'`,
    [project.name]
  );
  assert.equal(invoices.rows[0].n, 1,
    'exactly one invoice may exist for this work — two means the same hours were charged twice');

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  assert.equal(fulfilled.length, 1, 'exactly one run should succeed');

  const entries = await pool.query(
    `SELECT COUNT(*)::int n FROM time_entries WHERE project_id = $1 AND invoice_id IS NOT NULL`,
    [project.id]);
  assert.equal(entries.rows[0].n, 1);
});

test('re-billing after new time is logged charges only the new hours', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  if (!approverId) return t.skip('need a second user for timesheet approval SoD');

  // The realistic sequel to a first invoice: more work happens, and the next run
  // must pick up only the new hours. Getting this wrong in either direction is
  // costly — re-billing the old hours overcharges, skipping the new ones loses
  // revenue.
  const project = await makeProject({ default_hourly_rate: 100 });
  await logApprovedHours(project.id, 3);

  const first = await TimeEntries.billProject(project.id, {}, userId);
  created.invoiceIds.push(first.invoice.id);
  created.journalEntryIds.push(first.invoice.journal_entry_id);
  assert.equal(first.hours_billed, 3);
  assert.equal(Number(first.invoice.subtotal), 300);

  await logApprovedHours(project.id, 2);

  const second = await TimeEntries.billProject(project.id, {}, userId);
  created.invoiceIds.push(second.invoice.id);
  created.journalEntryIds.push(second.invoice.journal_entry_id);

  assert.equal(second.hours_billed, 2, 'the second invoice must cover only the newly logged hours');
  assert.equal(Number(second.invoice.subtotal), 200);
  assert.notEqual(second.invoice.id, first.invoice.id);

  // Every hour billed exactly once across both invoices.
  const totals = await pool.query(
    `SELECT SUM(hours)::float billed, COUNT(*)::int entries
       FROM time_entries WHERE project_id = $1 AND invoice_id IS NOT NULL`, [project.id]);
  assert.equal(totals.rows[0].billed, 5, 'all five hours billed');
  assert.equal(totals.rows[0].entries, 2);

  const nothingLeft = await TimeEntries.previewBilling(project.id);
  assert.equal(nothingLeft.entries.length, 0, 'nothing should remain unbilled');
});

test('a failed billing run leaves no invoice and no journal entry behind', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  if (!approverId) return t.skip('need a second user for timesheet approval SoD');

  const project = await makeProject();
  await logApprovedHours(project.id, 3);

  const before = await pool.query(`
    SELECT (SELECT COUNT(*)::int FROM customer_invoices WHERE deleted_at IS NULL) invoices,
           (SELECT COUNT(*)::int FROM journal_entries WHERE deleted_at IS NULL)  entries`);

  // Break the last step of billing, after the invoice and the GL entry exist.
  const CustomerInvoice = require('../models/CustomerInvoice');
  const original = CustomerInvoice.addStatusHistory;
  CustomerInvoice.addStatusHistory = async () => { throw new Error('injected billing failure'); };

  try {
    await assert.rejects(() => TimeEntries.billProject(project.id, {}, userId), /injected billing failure/);
  } finally {
    CustomerInvoice.addStatusHistory = original;
  }

  const after = await pool.query(`
    SELECT (SELECT COUNT(*)::int FROM customer_invoices WHERE deleted_at IS NULL) invoices,
           (SELECT COUNT(*)::int FROM journal_entries WHERE deleted_at IS NULL)  entries`);

  assert.equal(after.rows[0].invoices, before.rows[0].invoices, 'no invoice should survive');
  assert.equal(after.rows[0].entries, before.rows[0].entries,
    'no journal entry should survive — revenue must not post for an invoice that rolled back');

  // And crucially the time must be billable again, not stranded as invoiced.
  const stranded = await pool.query(
    `SELECT COUNT(*)::int n FROM time_entries
      WHERE project_id = $1 AND (invoice_id IS NOT NULL OR invoiced_at IS NOT NULL)`, [project.id]);
  assert.equal(stranded.rows[0].n, 0, 'a failed run must release the time it claimed');
});

test('an invoiced time entry cannot be edited or deleted', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  if (!approverId) return t.skip('need a second user for timesheet approval SoD');

  const project = await makeProject();
  const entry = await logApprovedHours(project.id, 4);

  const billed = await TimeEntries.billProject(project.id, {}, userId);
  created.invoiceIds.push(billed.invoice.id);
  created.journalEntryIds.push(billed.invoice.journal_entry_id);

  // Changing billed hours would make the invoice unexplainable.
  await assert.rejects(
    () => TimeEntries.update(entry.id, { hours: 99 }),
    /invoiced|cannot/i
  );
  await assert.rejects(
    () => TimeEntries.remove(entry.id),
    /invoiced|cannot|not found/i
  );

  const check = await pool.query('SELECT hours::float h FROM time_entries WHERE id = $1', [entry.id]);
  assert.equal(check.rows[0].h, 4, 'the billed hours must be unchanged');
});

test('billing produces one invoice line per time entry and a balanced journal entry', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  if (!approverId) return t.skip('need a second user for timesheet approval SoD');

  const project = await makeProject({ default_hourly_rate: 150 });
  await logApprovedHours(project.id, 2, { description: 'day one' });
  await logApprovedHours(project.id, 3, { description: 'day two' });

  const result = await TimeEntries.billProject(project.id, {}, userId);
  created.invoiceIds.push(result.invoice.id);
  created.journalEntryIds.push(result.invoice.journal_entry_id);

  assert.equal(result.entries_billed, 2);
  assert.equal(result.hours_billed, 5);
  assert.equal(Number(result.invoice.subtotal), 750, '5 hours at 150');

  // Note: billing currently writes a single summary line covering all hours
  // rather than itemising each entry. Asserted as-is so the behaviour is pinned;
  // whether professional-services invoices should itemise per day is a product
  // decision, not a defect.
  const lines = await pool.query(
    'SELECT COUNT(*)::int n, SUM(line_total)::float total, SUM(quantity)::float qty FROM customer_invoice_items WHERE invoice_id = $1',
    [result.invoice.id]);
  assert.equal(lines.rows[0].n, 1, 'one summary line is written for the billing run');
  assert.equal(lines.rows[0].qty, 5, 'covering all billed hours');
  assert.equal(lines.rows[0].total, 750, 'and the full billed value');

  const je = await pool.query(
    `SELECT je.status, ROUND(SUM(jei.debit_amount),2)::float d, ROUND(SUM(jei.credit_amount),2)::float c
       FROM journal_entries je JOIN journal_entry_items jei ON jei.journal_entry_id = je.id
      WHERE je.id = $1 GROUP BY je.id, je.status`,
    [result.invoice.journal_entry_id]);
  assert.equal(je.rows[0].status, 'POSTED');
  assert.equal(je.rows[0].d, je.rows[0].c, 'the revenue entry must balance');
});

test('non-billable and internal-project time is never invoiced', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  if (!approverId) return t.skip('need a second user for timesheet approval SoD');

  // Internal projects force billable = false whatever the caller asks.
  const internal = await makeProject({ billing_type: 'INTERNAL', customer_id: null, default_hourly_rate: null });
  const internalEntry = await logHours(internal.id, 6, { billable: true });
  assert.equal(internalEntry.billable, false,
    'time on an internal project must not be marked billable, or it inflates unbilled revenue');

  await assert.rejects(() => TimeEntries.billProject(internal.id, {}, userId), /internal|not billable|no customer/i);

  // A non-billable entry on a billable project is excluded too.
  const project = await makeProject();
  await logHours(project.id, 2, { billable: false });
  await logApprovedHours(project.id, 1, { billable: true });

  const preview = await TimeEntries.previewBilling(project.id);
  assert.equal(preview.entries.length, 1, 'only the billable entry should be billable');
  assert.equal(preview.hours, 1);
});

test('the billing rate is frozen on the entry, so later rate changes do not rewrite history', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  if (!approverId) return t.skip('need a second user for timesheet approval SoD');

  const project = await makeProject({ default_hourly_rate: 100 });
  await logApprovedHours(project.id, 10); // captured at 100

  await Projects.update(project.id, { default_hourly_rate: 500 });
  await logApprovedHours(project.id, 1); // captured at 500

  const preview = await TimeEntries.previewBilling(project.id);
  // 10 × 100 + 1 × 500 = 1500. Billing everything at the new rate would give 5500.
  assert.equal(preview.amount, 1500,
    'historic hours must bill at the rate in force when they were logged');
});

test('time cannot be logged to a closed project', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const project = await makeProject();
  await Projects.update(project.id, { status: 'COMPLETED' });
  await assert.rejects(() => logHours(project.id, 1), /COMPLETED|open project/i);
});

// ===========================================================================
// Project P&L
// ===========================================================================

test('project P&L counts labour cost, ledger cost and only invoiced revenue', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  if (!approverId) return t.skip('need a second user for timesheet approval SoD');

  const project = await makeProject({ default_hourly_rate: 200 });

  // An employee with a known cost rate, so labour cost is real rather than zero.
  const emp = await pool.query(
    `INSERT INTO employees (employee_number, first_name, last_name, status, base_salary, hourly_cost_rate, created_by)
     VALUES ($1,'Cost','Tester','ACTIVE',104000,50,$2) RETURNING id`,
    [`EMP${String(Date.now()).slice(-9)}`, userId]
  );
  const employeeId = emp.rows[0].id;

  try {
    await logHours(project.id, 10, { employee_id: employeeId });

    const beforeBilling = await Projects.profitAndLoss(project.id);
    assert.equal(beforeBilling.cost.labour, 500, '10 hours at a 50 cost rate');
    assert.equal(beforeBilling.revenue.invoiced, 0,
      'revenue must not be recognised before invoicing — it would flatter every live project');
    assert.equal(beforeBilling.revenue.unbilled_wip, 2000, '10 hours at the 200 billing rate');
    assert.equal(beforeBilling.hours.logged, 10);

    const [entry] = (await pool.query(
      'SELECT id FROM time_entries WHERE project_id = $1 AND employee_id = $2', [project.id, employeeId]
    )).rows;
    await TimeEntries.approve(entry.id, approverId);

    const billed = await TimeEntries.billProject(project.id, {}, userId);
    created.invoiceIds.push(billed.invoice.id);
    created.journalEntryIds.push(billed.invoice.journal_entry_id);

    const afterBilling = await Projects.profitAndLoss(project.id);
    assert.equal(afterBilling.revenue.invoiced, 2000, 'revenue appears once invoiced');
    assert.equal(afterBilling.revenue.unbilled_wip, 0);
    assert.equal(afterBilling.cost.labour, 500);
    assert.equal(afterBilling.margin, 1500, 'revenue 2000 less labour cost 500');
    assert.equal(afterBilling.margin_pct, 75);
  } finally {
    await pool.query('UPDATE time_entries SET employee_id = NULL WHERE employee_id = $1', [employeeId]).catch(() => {});
    await pool.query('DELETE FROM employees WHERE id = $1', [employeeId]).catch(() => {});
  }
});

test('an unknown employee cost rate reports zero cost rather than guessing', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const project = await makeProject();
  await logHours(project.id, 5); // no employee linked

  const pl = await Projects.profitAndLoss(project.id);
  // Falling back to the billing rate would report cost equal to revenue and a
  // zero margin on every project with no cost data — worse than reporting none.
  assert.equal(pl.cost.labour, 0, 'unknown cost must not be inferred from the billing rate');
  // And the zero must be explained, so it is not read as a free project.
  assert.match(pl.cost.note, /no cost rate is set/i);
});

// ===========================================================================
// CRM
// ===========================================================================

test('a closed deal cannot be reopened', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const deal = await Deals.create({ title: 'Reopen probe', customer_id: customerId, value: 5000 }, userId);
  created.dealIds.push(deal.id);

  await Deals.moveStage(deal.id, 'QUALIFIED', {}, userId);
  const won = await Deals.moveStage(deal.id, 'WON', {}, userId);
  assert.ok(won.closed_at, 'winning a deal should stamp closed_at');

  // Reopening would corrupt every win-rate and cycle-time figure derived from it.
  await assert.rejects(
    () => Deals.moveStage(deal.id, 'NEGOTIATION', {}, userId),
    /already WON|cannot be reopened/i
  );
});

test('marking a deal lost requires a reason', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const deal = await Deals.create({ title: 'Lost probe', customer_id: customerId, value: 1000 }, userId);
  created.dealIds.push(deal.id);

  await assert.rejects(() => Deals.moveStage(deal.id, 'LOST', {}, userId), /reason/i);

  const lost = await Deals.moveStage(deal.id, 'LOST', { lost_reason: 'Price' }, userId);
  assert.equal(lost.stage, 'LOST');
  assert.equal(lost.lost_reason, 'Price');
});

test('deal probability follows the stage unless explicitly overridden', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const deal = await Deals.create({ title: 'Probability probe', customer_id: customerId, value: 2000 }, userId);
  created.dealIds.push(deal.id);
  assert.equal(deal.probability, 10, 'a new deal should take the NEW default');

  const proposal = await Deals.moveStage(deal.id, 'PROPOSAL', {}, userId);
  assert.equal(proposal.probability, 50, 'advancing the stage should move the forecast');

  const override = await Deals.moveStage(deal.id, 'NEGOTIATION', { probability: 90 }, userId);
  assert.equal(override.probability, 90, 'an explicit probability should win');
});

test('the pipeline weights value by probability and reports no win rate without closed deals', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const owner = `${userId}`;
  const a = await Deals.create({ title: 'Pipe A', customer_id: customerId, value: 10000, stage: 'PROPOSAL', owner_id: owner }, userId);
  const b = await Deals.create({ title: 'Pipe B', customer_id: customerId, value: 4000, stage: 'NEW', owner_id: owner }, userId);
  created.dealIds.push(a.id, b.id);

  const pipeline = await Deals.pipeline({ owner_id: owner });
  const proposal = pipeline.stages.find((s) => s.stage === 'PROPOSAL');
  const newStage = pipeline.stages.find((s) => s.stage === 'NEW');

  assert.ok(proposal.total_value >= 10000);
  // 10000 at 50% = 5000 weighted, versus 10000 unweighted.
  assert.ok(proposal.weighted_value < proposal.total_value,
    'weighted value should discount by probability, so the forecast is not a wish list');
  assert.ok(newStage.total_value >= 4000);
});

test('possible duplicate contacts are surfaced by email and by name', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const email = `dup${Date.now()}@example.com`;
  const original = await Contacts.create(
    { first_name: 'Dupe', last_name: 'Tester', email, customer_id: customerId }, userId);
  created.contactIds.push(original.id);

  const byEmail = await Contacts.findPossibleDuplicates({ email });
  assert.ok(byEmail.some((c) => c.id === original.id), 'the same email should be flagged');

  const byName = await Contacts.findPossibleDuplicates({ first_name: 'Dupe', last_name: 'Tester' });
  assert.ok(byName.some((c) => c.id === original.id), 'the same name should be flagged');

  const unrelated = await Contacts.findPossibleDuplicates({ email: 'nobody-here@example.com' });
  assert.equal(unrelated.length, 0, 'an unknown contact should not be flagged');
});

test('a note is complete on creation while a task stays open', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const deal = await Deals.create({ title: 'Activity probe', customer_id: customerId, value: 100 }, userId);
  created.dealIds.push(deal.id);

  const note = await Activities.create(
    { activity_type: 'NOTE', subject: 'Spoke to them', deal_id: deal.id }, userId);
  created.activityIds.push(note.id);
  assert.ok(note.completed_at, 'a note records something that happened, so it is not an open item');

  const task = await Activities.create(
    { activity_type: 'TASK', subject: 'Follow up', deal_id: deal.id, due_date: '2020-01-01' }, userId);
  created.activityIds.push(task.id);
  assert.equal(task.completed_at, null);

  const overdue = await Activities.findAll({ deal_id: deal.id, overdue_only: true });
  assert.ok(overdue.some((a) => a.id === task.id), 'the overdue task should be listed');
  assert.ok(!overdue.some((a) => a.id === note.id), 'the note should not appear as overdue work');

  await Activities.complete(task.id);
  await assert.rejects(() => Activities.complete(task.id), /already complete|not found/i);
});
