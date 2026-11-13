/**
 * Scheduled report distribution.
 *
 * Mirrors services/agents/scheduler.js deliberately — same claim-then-run
 * shape, same safety properties — because the failure modes are identical and
 * a second, subtly different scheduler would drift from the one that got the
 * hard parts right:
 *
 *   • Claim-then-run. Due schedules are claimed with UPDATE ... RETURNING,
 *     which re-arms next_run_at in the same statement. Two app instances
 *     therefore cannot both send the same report — which for this feature means
 *     the recipient does not get the same email twice.
 *   • Restart-safe. next_run_at lives in the database, so a deploy neither
 *     loses a schedule nor re-fires one that already ran.
 *   • Never crashes the host. A failing report is recorded and skipped; it must
 *     not take the API server down.
 *   • Off by default, gated on REPORT_SCHEDULER_ENABLED, so importing the app
 *     from a test or a CLI script never emails anyone.
 */

const { pool } = require('../config/database');
const { forEachCompany, currentCompanyId } = require('./companyContext');
const { Reports, toCsv, toHtml } = require('./reportService');
const { generateTabularPdf, renderToBuffer } = require('./pdf/pdfService');
const emailService = require('./emailService');
const { businessFrom } = require('../config/sender');

const DEFAULT_TICK_MS = 60_000;
const MAX_PER_TICK = 5;

let timer = null;
let ticking = false;
let stats = { ticks: 0, sent: 0, failures: 0, startedAt: null, lastTickAt: null };

/**
 * Atomically claim schedules that are due for a given company, re-arming them as they are claimed.
 */
async function claimDue(limit = MAX_PER_TICK, companyId = currentCompanyId()) {
  const params = [limit];
  let companyFilter = '';
  if (companyId) {
    companyFilter = 'AND s.company_id = $2';
    params.push(companyId);
  }

  const { rows } = await pool.query(
    `UPDATE report_schedules s
        SET next_run_at = CURRENT_TIMESTAMP + (s.interval_seconds || ' seconds')::interval,
            last_run_at = CURRENT_TIMESTAMP,
            updated_at  = CURRENT_TIMESTAMP
      WHERE s.id IN (
        SELECT id FROM report_schedules s
         WHERE enabled = true AND next_run_at <= CURRENT_TIMESTAMP ${companyFilter}
         ORDER BY next_run_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING s.*`,
    params
  );
  return rows;
}


async function runSchedule(schedule) {
  const started = Date.now();

  try {
    const result = await Reports.run(
      schedule.report_id,
      { parameter_values: schedule.parameter_values || {}, record: false },
      schedule.created_by
    );

    const recipients = (schedule.recipients || []).filter(Boolean);
    let delivered = [];

    if (recipients.length) {
      const name = result.report.name;
      const format = String(schedule.format || 'CSV').toUpperCase();

      // HTML is delivered as the body; everything else is an attachment.
      // A PDF is bytes rather than text, so it is built into a Buffer here
      // rather than being handed to the mailer as a string — a PDF stringified
      // as UTF-8 arrives corrupt, and does so silently.
      const body = format === 'HTML'
        ? toHtml(name, result.columns, result.rows)
        : format === 'JSON'
          ? JSON.stringify(result.rows, null, 2)
          : format === 'PDF'
            ? await renderToBuffer(generateTabularPdf(name, result.columns, result.rows, {
                subtitle: describeParameters(schedule.parameter_values),
                truncated: result.truncated,
              }))
            : toCsv(result.columns, result.rows);

      await emailService.sendEmail({
        from: businessFrom('info'),
        to: recipients.join(','),
        subject: `${name} — ${new Date().toISOString().split('T')[0]}`,
        html: format === 'HTML'
          ? body
          : `<p>${escapeHtml(name)} is attached — ${result.rows.length} row${result.rows.length === 1 ? '' : 's'}.</p>`,
        attachments: format === 'HTML' ? undefined : [{
          filename: `${slug(name)}-${new Date().toISOString().split('T')[0]}.${format.toLowerCase()}`,
          content: body,
          contentType: format === 'PDF' ? 'application/pdf' : undefined,
        }],
      });
      delivered = recipients;
    }

    await pool.query(
      `INSERT INTO report_runs
         (report_id, schedule_id, status, row_count, duration_ms, parameter_values, delivered_to, run_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [schedule.report_id, schedule.id, result.truncated ? 'TRUNCATED' : 'SUCCESS',
       result.rows.length, Date.now() - started,
       JSON.stringify(schedule.parameter_values || {}), delivered, schedule.created_by]
    );

    stats.sent += 1;
    return { ok: true, rows: result.rows.length, delivered: delivered.length };
  } catch (error) {
    stats.failures += 1;
    // Recorded rather than thrown: an unsupervised loop that dies on one bad
    // report stops delivering every other report too.
    await pool.query(
      `INSERT INTO report_runs
         (report_id, schedule_id, status, duration_ms, error, parameter_values, run_by)
       VALUES ($1,$2,'FAILED',$3,$4,$5,$6)`,
      [schedule.report_id, schedule.id, Date.now() - started, error.message,
       JSON.stringify(schedule.parameter_values || {}), schedule.created_by]
    ).catch(() => {});

    console.error(`Scheduled report ${schedule.report_id} failed:`, error.message);
    return { ok: false, error: error.message };
  }
}

async function tick() {
  if (ticking) return;          // a slow tick must not overlap the next one
  ticking = true;
  stats.ticks += 1;
  stats.lastTickAt = new Date();

  try {
    await forEachCompany(async (companyId) => {
      const due = await claimDue(MAX_PER_TICK, companyId);
      for (const schedule of due) {
        await runSchedule(schedule);
      }
    });
  } catch (error) {
    console.error('Report scheduler tick failed:', error.message);
  } finally {
    ticking = false;
  }
}


function startScheduler({ tickMs = DEFAULT_TICK_MS } = {}) {
  if (timer) return { started: false, reason: 'already running' };
  if (String(process.env.REPORT_SCHEDULER_ENABLED || '').toLowerCase() !== 'true') {
    return { started: false, reason: 'REPORT_SCHEDULER_ENABLED is not set' };
  }

  timer = setInterval(() => { tick().catch(() => {}); }, tickMs);
  // Do not hold the process open on this timer alone.
  timer.unref?.();
  stats.startedAt = new Date();
  return { started: true, tickMs };
}

function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  return { stopped: true };
}

const getStats = () => ({ ...stats, running: timer !== null });

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'report';

/** "from_date: 2026-01-01   to_date: 2026-03-31", for the PDF subtitle. */
const describeParameters = (values) => {
  const entries = Object.entries(values || {}).filter(([, v]) => v !== null && v !== '');
  return entries.length ? entries.map(([k, v]) => `${k}: ${v}`).join('   ') : null;
};
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

module.exports = { startScheduler, stopScheduler, tick, claimDue, runSchedule, getStats };
