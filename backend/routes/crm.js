/**
 * CRM: contacts, deals and activities.
 *
 * Nothing here posts to the ledger, so the endpoints are open to any
 * authenticated user rather than gated to manager authority — a salesperson
 * must be able to log their own calls without an approval step. The one
 * exception is converting a won deal into a sales order, which creates a real
 * commercial document and follows the sales module's own authority rules.
 */

const express = require('express');
const router = express.Router();
const { auth, requireManagerOrAdmin } = require('../middleware/auth');
const { Contacts, Deals, Activities } = require('../models/Crm');
const { pool } = require('../config/database');
const multer = require('multer');

// Memory storage: a contact list is small, and writing it to disk would leave
// somebody's customer database sitting in a temp directory.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const { scopedMulter } = require('../middleware/scopedMulter');

const handle = (fn) => async (req, res) => {
  try {
    const result = await fn(req, res);
    if (!res.headersSent) res.json({ success: true, ...result });
  } catch (error) {
    console.error(`CRM error (${req.method} ${req.path}):`, error.message);
    if (!res.headersSent) {
      res.status(400).json({ success: false, error: error.message, ...(error.detail ? { data: error.detail } : {}) });
    }
  }
};

// GET /crm/analytics?months=12 — the module overview in one round trip.
router.get('/analytics', auth, handle(async (req) => {
  const { getCrmAnalytics } = require('../services/crmAnalytics');
  return { data: await getCrmAnalytics(Number(req.query.months) || 12) };
}));

// --- Import -----------------------------------------------------------------

/**
 * POST /crm/import/analyse — read an uploaded contact list and PROPOSE what it
 * would create. Creates nothing.
 *
 * Simeli does the work here: it reads the header row and three sample rows and
 * maps whatever the source system called its columns onto CRM fields. Every
 * row is then extracted deterministically against that mapping, matched
 * against contacts that already exist, and matched against the rest of the file
 * for people listed twice.
 *
 * What comes back is a staged batch, not a result. The client reviews it and
 * posts the rows it approves to /import/commit below.
 *
 * Gated to manager/admin: this writes to the contact database in bulk, which is
 * a different act from a salesperson adding the person they just met.
 */
router.post('/import/analyse', auth, requireManagerOrAdmin, scopedMulter(upload.single('file')),
  handle(async (req) => {
    if (!req.file) throw new Error('No file was uploaded.');
    const { analyse } = require('../services/ai/crmImport');
    const result = await analyse(req.file.buffer, req.file.originalname);
    if (!result.ok) {
      const err = new Error(result.error);
      err.detail = result;
      throw err;
    }
    return { data: result };
  }));

/**
 * POST /crm/import/commit — create the contacts a person approved.
 *
 * Takes the reviewed rows from the client rather than re-reading the file, so
 * the records are created from what somebody confirmed rather than from what
 * was extracted. An edit made in the review table is a real edit, and a row
 * deselected there is genuinely not written.
 *
 * All or nothing. A half-finished import is the worst outcome, because nobody
 * can tell which half of the file made it in.
 */
router.post('/import/commit', auth, requireManagerOrAdmin, handle(async (req) => {
  const { commit } = require('../services/ai/crmImport');
  const result = await commit(req.body?.rows, req.user.id, {
    link_company: req.body?.link_company !== false,
  });
  if (!result.ok) {
    const err = new Error(result.message);
    err.detail = result;
    throw err;
  }
  return {
    data: result,
    message: `${result.created.length} contact(s) imported.`,
  };
}));

// --- Contacts ---------------------------------------------------------------

router.get('/contacts', auth, handle(async (req) => ({
  data: await Contacts.findAll({
    search: req.query.search,
    customer_id: req.query.customer_id,
    owner_id: req.query.owner_id,
    limit: req.query.limit,
  }),
})));

/**
 * Duplicate check as the form is typed. Deliberately a separate endpoint rather
 * than a hard block on create: the user is the one who can tell "same name,
 * different person" from a genuine duplicate.
 */
router.get('/contacts/check-duplicate', auth, handle(async (req) => ({
  data: await Contacts.findPossibleDuplicates({
    email: req.query.email,
    first_name: req.query.first_name,
    last_name: req.query.last_name,
  }),
})));

router.get('/contacts/:id', auth, handle(async (req) => {
  const contact = await Contacts.findById(req.params.id);
  if (!contact) throw new Error('Contact not found.');
  return { data: contact };
}));

router.post('/contacts', auth, handle(async (req) => ({
  data: await Contacts.create(req.body, req.user.id),
})));

router.put('/contacts/:id', auth, handle(async (req) => ({
  data: await Contacts.update(req.params.id, req.body),
})));

router.delete('/contacts/:id', auth, handle(async (req) => ({
  data: await Contacts.remove(req.params.id),
})));

// --- Deals ------------------------------------------------------------------

router.get('/deals', auth, handle(async (req) => ({
  data: await Deals.findAll({
    stage: req.query.stage,
    owner_id: req.query.owner_id,
    customer_id: req.query.customer_id,
    open_only: req.query.open_only === 'true',
    limit: req.query.limit,
  }),
})));

// The board a sales manager opens: stage totals plus a weighted forecast.
router.get('/deals/pipeline', auth, handle(async (req) => ({
  data: await Deals.pipeline({ owner_id: req.query.owner_id }),
})));

router.get('/deals/:id', auth, handle(async (req) => {
  const deal = await Deals.findById(req.params.id);
  if (!deal) throw new Error('Deal not found.');
  return { data: deal };
}));

router.post('/deals', auth, handle(async (req) => ({
  data: await Deals.create(req.body, req.user.id),
})));

router.put('/deals/:id', auth, handle(async (req) => ({
  data: await Deals.update(req.params.id, req.body),
})));

// Drag-and-drop on the pipeline board lands here.
router.post('/deals/:id/stage', auth, handle(async (req) => ({
  data: await Deals.moveStage(
    req.params.id,
    req.body.stage,
    { probability: req.body.probability, lost_reason: req.body.lost_reason },
    req.user.id
  ),
})));

/**
 * Link a won deal to the sales order it produced.
 *
 * This does not create the order — the sales module owns that, with its own
 * pricing, availability and approval rules, and duplicating any of it here
 * would guarantee the two drift apart. This records the join so pipeline
 * value can be reconciled against booked revenue.
 */
router.post('/deals/:id/link-sales-order', auth, requireManagerOrAdmin, handle(async (req) => {
  const { sales_order_id } = req.body;
  if (!sales_order_id) throw new Error('A sales order id is required.');

  const order = await pool.query('SELECT id FROM sales_orders WHERE id = $1', [sales_order_id]);
  if (!order.rows.length) throw new Error('Sales order not found.');

  const { rows } = await pool.query(
    `UPDATE deals SET sales_order_id = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [req.params.id, sales_order_id]
  );
  if (!rows.length) throw new Error('Deal not found.');
  return { data: rows[0] };
}));

// POST /crm/deals/follow-ups/schedule - auto-schedule a TASK activity for
// every open deal that has gone quiet past the stale-days threshold (default
// 7). Manual/on-demand, same as /financial-reports/dunning/run — there is no
// cron runner in this codebase, so both are triggered on demand or by an
// external scheduler hitting the endpoint.
router.post('/deals/follow-ups/schedule', auth, requireManagerOrAdmin, handle(async (req) => {
  const { scheduleStaleDealFollowUps } = require('../services/crm/followUpScheduler');
  const result = await scheduleStaleDealFollowUps({ staleDays: req.body?.stale_days });
  return { ...result };
}));

// --- Activities -------------------------------------------------------------

router.get('/activities', auth, handle(async (req) => ({
  data: await Activities.findAll({
    owner_id: req.query.owner_id,
    deal_id: req.query.deal_id,
    contact_id: req.query.contact_id,
    lead_id: req.query.lead_id,
    open_only: req.query.open_only === 'true',
    overdue_only: req.query.overdue_only === 'true',
    limit: req.query.limit,
  }),
})));

router.post('/activities', auth, handle(async (req) => ({
  data: await Activities.create(req.body, req.user.id),
})));

router.post('/activities/:id/complete', auth, handle(async (req) => ({
  data: await Activities.complete(req.params.id),
})));

module.exports = router;
