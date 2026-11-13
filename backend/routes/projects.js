/**
 * Projects: work breakdown, time tracking and billing.
 *
 * Authority split follows what the action costs if it is wrong. Logging and
 * editing your own time is ordinary work and open to any authenticated user.
 * Creating a project, or turning time into an invoice the customer will see,
 * is gated — the billing run posts revenue to the general ledger and cannot be
 * undone by editing a row.
 */

const express = require('express');
const router = express.Router();
const { auth, requireManagerOrAdmin } = require('../middleware/auth');
const { Projects, ProjectTasks, TimeEntries, ResourceAssignments, Milestones } = require('../models/Project');

const handle = (fn) => async (req, res) => {
  try {
    const result = await fn(req, res);
    if (!res.headersSent) res.json({ success: true, ...result });
  } catch (error) {
    console.error(`Projects error (${req.method} ${req.path}):`, error.message);
    if (!res.headersSent) res.status(400).json({ success: false, error: error.message });
  }
};

// GET /projects/analytics?months=12 — the module overview in one round trip.
//
// Declared before '/:id' for the same reason 'time-entries' is: an
// uncaptured '/analytics' would be read as a project id and 404 against a
// uuid cast.
router.get('/analytics', auth, handle(async (req) => {
  const { getProjectsAnalytics } = require('../services/projectsAnalytics');
  return { data: await getProjectsAnalytics(Number(req.query.months) || 12) };
}));

// --- Projects ---------------------------------------------------------------

router.get('/', auth, handle(async (req) => ({
  data: await Projects.findAll({
    status: req.query.status,
    customer_id: req.query.customer_id,
    manager_id: req.query.manager_id,
    open_only: req.query.open_only === 'true',
    limit: req.query.limit,
  }),
})));

router.post('/', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await Projects.create(req.body, req.user.id),
})));

// --- Time entries -----------------------------------------------------------
//
// Declared before `/:id` so "time-entries" is not swallowed as a project id.

router.get('/time-entries', auth, handle(async (req) => ({
  data: await TimeEntries.findAll({
    project_id: req.query.project_id,
    // Default to the caller's own time: a timesheet screen asks "what did I
    // log", and returning everyone's by default is both wrong and noisy.
    user_id: req.query.user_id || (req.query.all === 'true' ? undefined : req.user.id),
    task_id: req.query.task_id,
    from_date: req.query.from_date,
    to_date: req.query.to_date,
    unbilled_only: req.query.unbilled_only === 'true',
    limit: req.query.limit,
  }),
})));

router.post('/time-entries', auth, handle(async (req) => ({
  data: await TimeEntries.create(req.body, req.user.id),
})));

router.put('/time-entries/:id', auth, handle(async (req) => ({
  data: await TimeEntries.update(req.params.id, req.body),
})));

router.delete('/time-entries/:id', auth, handle(async (req) => ({
  data: await TimeEntries.remove(req.params.id),
})));

// Approval requires a distinct user from whoever logged the time (SoD).
router.post('/time-entries/:id/approve', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await TimeEntries.approve(req.params.id, req.user.id),
})));

router.post('/time-entries/:id/reject', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await TimeEntries.reject(req.params.id, req.user.id, req.body.reason),
})));

// --- Resource loading ---------------------------------------------------------
//
// Declared before `/:id` for the same reason time-entries is.

router.get('/resource-loading', auth, handle(async (req) => ({
  data: await ResourceAssignments.loadOverview(req.query.as_of),
})));

router.get('/resource-loading/:employeeId', auth, handle(async (req) => ({
  data: await ResourceAssignments.loadForEmployee(req.params.employeeId, req.query.as_of),
})));

router.post('/assignments', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await ResourceAssignments.create(req.body, req.user.id),
})));

router.delete('/assignments/:id', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await ResourceAssignments.remove(req.params.id),
})));

// --- Tasks ------------------------------------------------------------------

router.post('/tasks', auth, handle(async (req) => ({
  data: await ProjectTasks.create(req.body),
})));

router.put('/tasks/:id', auth, handle(async (req) => ({
  data: await ProjectTasks.update(req.params.id, req.body),
})));

// --- Single project ---------------------------------------------------------

router.get('/:id', auth, handle(async (req) => {
  const project = await Projects.findById(req.params.id);
  if (!project) throw new Error('Project not found.');
  return { data: project };
}));

router.put('/:id', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await Projects.update(req.params.id, req.body),
})));

router.get('/:id/pnl', auth, handle(async (req) => ({
  data: await Projects.profitAndLoss(req.params.id),
})));

router.get('/:id/budget', auth, handle(async (req) => ({
  data: await Projects.budgetReport(req.params.id),
})));

router.get('/:id/assignments', auth, handle(async (req) => ({
  data: await ResourceAssignments.findByProject(req.params.id),
})));

router.get('/:id/milestones', auth, handle(async (req) => ({
  data: await Milestones.findByProject(req.params.id),
})));

router.post('/:id/milestones', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await Milestones.create({ ...req.body, project_id: req.params.id }, req.user.id),
})));

router.post('/milestones/:id/achieve', auth, handle(async (req) => ({
  data: await Milestones.achieve(req.params.id, req.user.id),
})));

router.post('/milestones/:id/bill', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await Milestones.bill(req.params.id, req.user.id),
})));

// What would be billed, without billing it — the review step before a customer
// sees the invoice.
router.get('/:id/billing-preview', auth, handle(async (req) => ({
  data: await TimeEntries.previewBilling(req.params.id, { to_date: req.query.to_date }),
})));

// Creates a customer invoice and posts revenue to the ledger.
router.post('/:id/bill', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await TimeEntries.billProject(req.params.id, {
    to_date: req.body.to_date,
    tax_rate: req.body.tax_rate,
    description: req.body.description,
  }, req.user.id),
})));

module.exports = router;
