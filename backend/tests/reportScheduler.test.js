// Reporting session — scheduled report delivery.
//
// services/reportScheduler.js already exists (claim-then-run, restart-safe,
// gated on REPORT_SCHEDULER_ENABLED) but had no test coverage. This proves
// the whole path works end to end: a due schedule is claimed, the underlying
// report actually runs against real data, a file (CSV) is produced and
// "delivered" (captured here instead of hitting real SMTP), and the run is
// archived in report_runs.

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');

const { pool } = require('../config/database');
const { Reports } = require('../services/reportService');
const emailService = require('../services/emailService');
const reportScheduler = require('../services/reportScheduler');

let dbAvailable = false;
let userId = null;
let reportId = null;
let scheduleId = null;

before(async () => {
  try {
    await pool.query('SELECT 1');
    const users = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
    if (!users.rows.length) return;
    userId = users.rows[0].id;
    dbAvailable = true;
  } catch (err) {
    console.error('reportScheduler test setup failed:', err.message);
  }
});

after(async () => {
  if (!dbAvailable) return;
  if (scheduleId) await pool.query('DELETE FROM report_schedules WHERE id = $1', [scheduleId]);
  if (reportId) {
    await pool.query('DELETE FROM report_runs WHERE report_id = $1', [reportId]);
    await pool.query('DELETE FROM report_definitions WHERE id = $1', [reportId]);
  }
});

after(async () => {
  await Promise.race([pool.end(), new Promise((r) => setTimeout(r, 5000))]);
});

test('a due schedule is claimed, the report runs, a file is produced, delivery is recorded and archived', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const report = await Reports.create(
    { name: 'RS Test Trial Balance', report_type: 'BUILTIN', builtin_key: 'trial_balance', is_shared: true },
    userId
  );
  reportId = report.id;

  const { rows } = await pool.query(
    `INSERT INTO report_schedules
       (report_id, name, interval_seconds, next_run_at, format, recipients, enabled, created_by)
     VALUES ($1, 'RS Test Schedule', 300, CURRENT_TIMESTAMP - INTERVAL '1 minute', 'CSV',
             ARRAY['rs-test@example.com'], true, $2)
     RETURNING *`,
    [reportId, userId]
  );
  scheduleId = rows[0].id;

  // Claim it — the same claim-then-run step tick() uses. Confirms the due
  // schedule is actually pickable and next_run_at gets re-armed atomically.
  const due = await reportScheduler.claimDue(5);
  const claimed = due.find((s) => s.id === scheduleId);
  assert.ok(claimed, 'the due schedule must be claimed');
  assert.ok(new Date(claimed.next_run_at) > new Date(), 'next_run_at is re-armed into the future on claim');

  // Capture the "email" instead of hitting real SMTP — the scheduler's job is
  // to produce the right file and hand it to the mailer; sending mail for
  // real is emailService's concern, already exercised elsewhere.
  const sent = [];
  const originalSendEmail = emailService.sendEmail;
  emailService.sendEmail = async (opts) => { sent.push(opts); return { messageId: 'test' }; };

  let result;
  try {
    result = await reportScheduler.runSchedule(claimed);
  } finally {
    emailService.sendEmail = originalSendEmail;
  }

  assert.equal(result.ok, true);
  assert.equal(result.delivered, 1);

  assert.equal(sent.length, 1, 'exactly one email attempt for the one recipient set');
  const email = sent[0];
  assert.equal(email.to, 'rs-test@example.com');
  assert.equal(email.attachments.length, 1);
  const file = email.attachments[0];
  assert.match(file.filename, /\.csv$/);
  assert.ok(String(file.content).includes('account_code'), 'the produced CSV has a real header row, not an empty file');
  assert.ok(String(file.content).length > 20, 'the produced file is non-trivial');

  // Archived in report_runs — the "report archive" requirement.
  const runs = await pool.query(
    `SELECT status, row_count, delivered_to FROM report_runs WHERE schedule_id = $1 ORDER BY run_at DESC LIMIT 1`,
    [scheduleId]
  );
  assert.equal(runs.rows.length, 1);
  assert.equal(runs.rows[0].status === 'SUCCESS' || runs.rows[0].status === 'TRUNCATED', true);
  assert.deepEqual(runs.rows[0].delivered_to, ['rs-test@example.com']);
});

test('a failing report is recorded as FAILED, not thrown, and does not stop the scheduler', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const badReport = await Reports.create(
    // Passes save-time validation (a real allowlisted table) but fails at
    // run time (a column that does not exist) — proves the failure path
    // that matters: a query that looked fine when saved but breaks later.
    { name: 'RS Test Bad Report', report_type: 'QUERY', sql_text: 'SELECT this_column_does_not_exist FROM customers', is_shared: true },
    userId
  );
  try {
    const fakeSchedule = {
      id: null, report_id: badReport.id, recipients: [], format: 'CSV',
      parameter_values: {}, created_by: userId,
    };
    const result = await reportScheduler.runSchedule(fakeSchedule);
    assert.equal(result.ok, false);
    assert.ok(result.error);

    const runs = await pool.query(
      `SELECT status, error FROM report_runs WHERE report_id = $1 ORDER BY run_at DESC LIMIT 1`,
      [badReport.id]
    );
    assert.equal(runs.rows.length, 1);
    assert.equal(runs.rows[0].status, 'FAILED');
    assert.ok(runs.rows[0].error);
  } finally {
    await pool.query('DELETE FROM report_runs WHERE report_id = $1', [badReport.id]);
    await pool.query('DELETE FROM report_definitions WHERE id = $1', [badReport.id]);
  }
});
