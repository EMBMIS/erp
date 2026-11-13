/**
 * Reporting: saved reports, exports, schedules and dashboards.
 *
 * Open to any authenticated user. Reports read the business data the user can
 * already see through the module screens, and the read path is constrained by
 * the nlQuery allowlist plus a READ ONLY transaction — a report cannot write,
 * and cannot reach the tables holding credentials or portal tokens.
 *
 * Visibility is per report: you see your own plus anything shared. That is
 * enforced in the queries themselves (services/reportService.js), not here.
 */

const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const { Reports, BUILTINS, toCsv, toHtml } = require('../services/reportService');
const Dashboards = require('../models/Dashboard');
const reportScheduler = require('../services/reportScheduler');
const { pool } = require('../config/database');

const handle = (fn) => async (req, res) => {
  try {
    const result = await fn(req, res);
    if (!res.headersSent) res.json({ success: true, ...result });
  } catch (error) {
    console.error(`Reports error (${req.method} ${req.path}):`, error.message);
    if (!res.headersSent) res.status(400).json({ success: false, error: error.message });
  }
};

// --- Catalogue --------------------------------------------------------------

// GET /reports/analytics?months=12 — the module overview in one round trip.
// Declared before '/:id' (and before the list route, for readability) so
// "analytics" is never taken for a report id.
router.get('/analytics', auth, handle(async (req) => {
  const { getReportingAnalytics } = require('../services/reportingAnalytics');
  return { data: await getReportingAnalytics(Number(req.query.months) || 12) };
}));

router.get('/', auth, handle(async (req) => ({
  data: await Reports.findAll({
    userId: req.user.id,
    category: req.query.category,
    search: req.query.search,
  }),
})));

// The packaged reports, for a "start from" picker.
router.get('/builtins', auth, handle(async () => ({
  data: Object.keys(BUILTINS).map((key) => ({
    key,
    name: key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  })),
})));

// The tables a report may query, so the editor can show what is available
// rather than letting someone discover the allowlist by trial and error.
router.get('/schema', auth, handle(async () => {
  const nlQuery = require('../services/ai/nlQuery');
  return { data: { tables: [...nlQuery.ALLOWED_TABLES].sort(), max_rows: nlQuery.MAX_ROWS } };
}));

// --- Dashboards -------------------------------------------------------------
//
// Before `/:id` so "dashboards" is not read as a report id.

router.get('/dashboards', auth, handle(async (req) => ({
  data: await Dashboards.findAll(req.user.id),
})));

router.post('/dashboards', auth, handle(async (req) => ({
  data: await Dashboards.create(req.body, req.user.id),
})));

router.get('/dashboards/:id', auth, handle(async (req) => {
  const dashboard = await Dashboards.findById(req.params.id, req.user.id);
  if (!dashboard) throw new Error('Dashboard not found.');
  return { data: dashboard };
}));

// Runs every widget's report and returns the data with the layout.
router.get('/dashboards/:id/render', auth, handle(async (req) => ({
  data: await Dashboards.render(req.params.id, req.user.id, req.query || {}),
})));

router.put('/dashboards/:id', auth, handle(async (req) => ({
  data: await Dashboards.update(req.params.id, req.body, req.user.id),
})));

router.delete('/dashboards/:id', auth, handle(async (req) => ({
  data: await Dashboards.remove(req.params.id, req.user.id),
})));

router.post('/dashboards/:id/widgets', auth, handle(async (req) => ({
  data: await Dashboards.addWidget(req.params.id, req.body, req.user.id),
})));

router.put('/dashboards/widgets/:widgetId', auth, handle(async (req) => ({
  data: await Dashboards.updateWidget(req.params.widgetId, req.body, req.user.id),
})));

router.delete('/dashboards/widgets/:widgetId', auth, handle(async (req) => ({
  data: await Dashboards.removeWidget(req.params.widgetId, req.user.id),
})));

// --- Schedules --------------------------------------------------------------
//
// Kept in step with the CHECK constraint in migration 116. Validated here as
// well as in the database so a typo comes back as a sentence naming the
// choices, rather than as a constraint violation.
const SCHEDULE_FORMATS = ['CSV', 'JSON', 'HTML', 'PDF'];

router.get('/schedules/formats', auth, handle(async () => ({ data: SCHEDULE_FORMATS })));

router.get('/schedules', auth, handle(async (req) => {
  const { rows } = await pool.query(
    `SELECT s.*, d.name AS report_name
       FROM report_schedules s
       JOIN report_definitions d ON d.id = s.report_id
      WHERE d.deleted_at IS NULL AND (d.is_shared = true OR d.owner_id = $1)
      ORDER BY s.next_run_at`,
    [req.user.id]
  );
  return { data: rows, scheduler: reportScheduler.getStats() };
}));

router.post('/schedules', auth, handle(async (req) => {
  const { report_id, name, interval_seconds, parameter_values, format, recipients } = req.body;

  const report = await Reports.findById(report_id, req.user.id);
  if (!report) throw new Error('Report not found, or you do not have access to it.');

  const interval = Number(interval_seconds);
  // The floor is in the schema too; checked here so the message explains why.
  if (!(interval >= 300)) {
    throw new Error('The shortest schedule is every five minutes — anything faster mails people faster than they can read.');
  }

  const list = Array.isArray(recipients) ? recipients.filter(Boolean) : [];
  const bad = list.filter((r) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r));
  if (bad.length) throw new Error(`Not a valid email address: ${bad.join(', ')}`);

  const chosenFormat = String(format || 'CSV').toUpperCase();
  if (!SCHEDULE_FORMATS.includes(chosenFormat)) {
    throw new Error(`"${format}" is not a report format. Choose one of: ${SCHEDULE_FORMATS.join(', ')}.`);
  }

  const { rows } = await pool.query(
    `INSERT INTO report_schedules
       (report_id, name, interval_seconds, parameter_values, format, recipients, created_by,
        next_run_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, CURRENT_TIMESTAMP + ($3 || ' seconds')::interval)
     RETURNING *`,
    [report_id, name || report.name, interval, JSON.stringify(parameter_values || {}),
     chosenFormat, list, req.user.id]
  );
  return { data: rows[0] };
}));

router.put('/schedules/:id', auth, handle(async (req) => {
  const allowed = ['name', 'interval_seconds', 'parameter_values', 'format', 'recipients', 'enabled'];
  const sets = [];
  const params = [req.params.id, req.user.id];
  for (const key of allowed) {
    if (req.body[key] === undefined) continue;
    let value = req.body[key];
    if (key === 'parameter_values') {
      value = JSON.stringify(value);
    } else if (key === 'format') {
      value = String(value).toUpperCase();
      if (!SCHEDULE_FORMATS.includes(value)) {
        throw new Error(`"${req.body[key]}" is not a report format. Choose one of: ${SCHEDULE_FORMATS.join(', ')}.`);
      }
    }
    params.push(value);
    sets.push(`${key} = $${params.length}`);
  }
  if (!sets.length) throw new Error('Nothing to update.');
  sets.push('updated_at = CURRENT_TIMESTAMP');

  const { rows } = await pool.query(
    `UPDATE report_schedules SET ${sets.join(', ')}
      WHERE id = $1 AND created_by = $2 RETURNING *`,
    params
  );
  if (!rows.length) throw new Error('Schedule not found, or you did not create it.');
  return { data: rows[0] };
}));

router.delete('/schedules/:id', auth, handle(async (req) => {
  const { rows } = await pool.query(
    'DELETE FROM report_schedules WHERE id = $1 AND created_by = $2 RETURNING id',
    [req.params.id, req.user.id]
  );
  if (!rows.length) throw new Error('Schedule not found, or you did not create it.');
  return { data: { deleted: true } };
}));

// --- Single report ----------------------------------------------------------

router.post('/', auth, handle(async (req) => ({
  data: await Reports.create(req.body, req.user.id),
})));

router.get('/:id', auth, handle(async (req) => {
  const report = await Reports.findById(req.params.id, req.user.id);
  if (!report) throw new Error('Report not found.');
  return { data: report };
}));

router.put('/:id', auth, handle(async (req) => ({
  data: await Reports.update(req.params.id, req.body, req.user.id),
})));

router.delete('/:id', auth, handle(async (req) => ({
  data: await Reports.remove(req.params.id, req.user.id),
})));

router.post('/:id/run', auth, handle(async (req) => ({
  data: await Reports.run(req.params.id, { parameter_values: req.body?.parameters || {} }, req.user.id),
})));

router.get('/:id/runs', auth, handle(async (req) => ({
  data: await Reports.runHistory(req.params.id, req.query.limit),
})));

/**
 * Export.
 *
 * GET rather than POST so a report can be linked to and bookmarked, with
 * parameters in the query string. Values are bound, not interpolated, so this
 * is not a SQL surface.
 */
router.get('/:id/export', auth, async (req, res) => {
  try {
    const format = String(req.query.format || 'csv').toLowerCase();
    const { format: _f, ...parameters } = req.query;

    const result = await Reports.run(req.params.id, { parameter_values: parameters }, req.user.id);
    const filename = `${slug(result.report.name)}-${new Date().toISOString().split('T')[0]}`;

    if (format === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
      return res.type('application/json').send(JSON.stringify(result.rows, null, 2));
    }
    if (format === 'html') {
      res.setHeader('Content-Disposition', `inline; filename="${filename}.html"`);
      return res.type('text/html').send(toHtml(result.report.name, result.columns, result.rows));
    }
    if (format === 'pdf') {
      const { generateTabularPdf } = require('../services/pdf/pdfService');
      // inline rather than attachment: a PDF is the format people open to look
      // at, and the browser viewer is the point of asking for one.
      res.setHeader('Content-Disposition', `inline; filename="${filename}.pdf"`);
      res.type('application/pdf');
      const doc = generateTabularPdf(result.report.name, result.columns, result.rows, {
        subtitle: Object.keys(parameters).length
          ? Object.entries(parameters).map(([k, v]) => `${k}: ${v}`).join('   ')
          : null,
        truncated: result.truncated,
        meta: result.redacted_columns?.length
          ? `Redacted columns: ${result.redacted_columns.join(', ')}`
          : null,
      });
      return doc.pipe(res);
    }

    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    // text/csv rather than application/octet-stream so the browser does not
    // offer to run it; the CSV itself is formula-escaped in toCsv.
    return res.type('text/csv').send(toCsv(result.columns, result.rows));
  } catch (error) {
    console.error('Report export error:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'report';

module.exports = router;
