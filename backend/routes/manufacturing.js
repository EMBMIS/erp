/**
 * Manufacturing: bills of material, work orders and MRP.
 *
 * Material issue and production confirmation post to the general ledger, so
 * they are gated to manager/finance authority rather than any authenticated
 * user — the same standard applied to the other money endpoints here.
 */

const express = require('express');
const router = express.Router();
const { auth, requireManagerOrAdmin } = require('../middleware/auth');
const BillOfMaterial = require('../models/BillOfMaterial');
const WorkOrder = require('../models/WorkOrder');
const WorkCenter = require('../models/WorkCenter');
const mrpService = require('../services/mrpService');

const handle = (fn) => async (req, res) => {
  try {
    const result = await fn(req, res);
    if (!res.headersSent) res.json({ success: true, ...result });
  } catch (error) {
    console.error(`Manufacturing error (${req.method} ${req.path}):`, error.message);
    if (!res.headersSent) res.status(400).json({ success: false, error: error.message });
  }
};

// --- Bills of material ------------------------------------------------------

// GET /manufacturing/analytics?months=12 — the module overview in one round
// trip: production and scrap, OEE and its three factors, work-centre load, top
// products, material consumption, MRP shortages and the open order list.
router.get('/analytics', auth, handle(async (req) => {
  const { getManufacturingAnalytics } = require('../services/manufacturingAnalytics');
  const m = parseInt(req.query.months, 10);
  const months = Number.isInteger(m) ? Math.min(Math.max(m, 2), 36) : 12;
  return getManufacturingAnalytics(months);
}));

router.get('/boms', auth, handle(async (req) => ({
  data: await BillOfMaterial.findAll({ status: req.query.status, item_id: req.query.item_id }),
})));

router.get('/boms/:id', auth, handle(async (req) => {
  const bom = await BillOfMaterial.findById(req.params.id);
  if (!bom) throw new Error('Bill of material not found.');
  return { data: bom };
}));

router.post('/boms', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await BillOfMaterial.create(req.body, req.user.id),
})));

router.post('/boms/:id/components', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await BillOfMaterial.addComponent(req.params.id, req.body),
})));

router.post('/boms/:id/activate', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await BillOfMaterial.activate(req.params.id),
})));

// GET /manufacturing/boms/explode/:itemId?quantity=10
router.get('/boms/explode/:itemId', auth, handle(async (req) => ({
  data: await BillOfMaterial.explode(req.params.itemId, Number(req.query.quantity) || 1),
})));

// --- Work orders ------------------------------------------------------------

router.get('/work-orders', auth, handle(async (req) => ({
  data: await WorkOrder.findAll({ status: req.query.status, limit: req.query.limit }),
})));

router.get('/work-orders/:id', auth, handle(async (req) => {
  const wo = await WorkOrder.findById(req.params.id);
  if (!wo) throw new Error('Work order not found.');
  return { data: wo };
}));

router.post('/work-orders', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await WorkOrder.create(req.body, req.user.id),
})));

router.post('/work-orders/:id/release', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await WorkOrder.release(req.params.id, req.user.id),
})));

// Posts Dr WIP / Cr Inventory.
router.post('/work-orders/:id/issue-materials', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await WorkOrder.issueMaterials(req.params.id, req.body.issues, req.user.id),
})));

// Posts Dr Inventory / Cr WIP (+ scrap variance).
router.post('/work-orders/:id/confirm', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await WorkOrder.confirmProduction(req.params.id, req.body, req.user.id),
})));

router.post('/work-orders/:id/cancel', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await WorkOrder.cancel(req.params.id, req.body.reason, req.user.id),
})));

// --- MRP --------------------------------------------------------------------

// POST /manufacturing/mrp/run { horizon_days, persist }
router.post('/mrp/run', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await mrpService.runMrp({
    horizonDays: Number(req.body.horizon_days) || 90,
    persist: req.body.persist !== false,
    includeReorderDemand: req.body.include_reorder_demand !== false,
  }),
})));

router.get('/mrp/planned-orders', auth, handle(async (req) => ({
  data: await mrpService.listPlannedOrders({ runId: req.query.run_id, status: req.query.status }),
})));

// Turns a planned MAKE order into a real DRAFT work order. mrpService already
// had this function (convertPlannedOrder) fully implemented, but no route
// ever called it — MRPWorkbench.jsx and ProductionDashboard.jsx's "Convert"
// buttons both post to this exact path and have 404'd since either was built.
router.post('/mrp/planned-orders/:id/convert', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await mrpService.convertPlannedOrder(req.params.id, req.user.id),
})));

// --- Work centres -----------------------------------------------------------
//
// Capacity is computed from the routing actually booked onto released work
// orders (see models/WorkCenter.js). It reports an empty list when no work
// centre has been set up, rather than inventing a plausible-looking shop floor.

router.get('/work-centers', auth, handle(async (req) => ({
  data: await WorkCenter.findAll({
    status: req.query.status,
    includeInactive: req.query.include_inactive === 'true',
  }),
})));

router.get('/work-centers/capacity', auth, handle(async (req) => ({
  data: await WorkCenter.capacity({ horizonDays: Number(req.query.horizon_days) || 7 }),
})));

// Quality reviews the margin analysis opened on a work centre (services/marginFollowUps.js).
router.get('/quality-reviews', auth, handle(async (req) => {
  const { listFollowUps } = require('../services/marginFollowUps');
  const { quality_reviews: data } = await listFollowUps({
    companyId: req.companyId, role: req.user?.role, workCenterId: req.query.work_center_id || null,
  });
  return { data };
}));

router.post('/quality-reviews/:id/close', auth, handle(async (req) => {
  const { closeQualityReview } = require('../services/marginFollowUps');
  const out = await closeQualityReview({
    companyId: req.companyId, userId: req.user.id, role: req.user?.role, id: req.params.id, outcome: req.body?.outcome,
  });
  if (out.error) throw new Error(out.error);
  return { data: out };
}));

router.get('/work-centers/:id', auth, handle(async (req) => {
  const wc = await WorkCenter.findById(req.params.id);
  if (!wc) throw new Error('Work centre not found.');
  return { data: wc };
}));

router.post('/work-centers', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await WorkCenter.create(req.body, req.user.id),
})));

router.put('/work-centers/:id', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await WorkCenter.update(req.params.id, req.body),
})));

router.delete('/work-centers/:id', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await WorkCenter.remove(req.params.id),
})));

// --- Routing (standard operations on a BOM) ---------------------------------

router.get('/boms/:id/operations', auth, handle(async (req) => ({
  data: await WorkCenter.listBomOperations(req.params.id),
})));

router.post('/boms/:id/operations', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await WorkCenter.addBomOperation(req.params.id, req.body),
})));

router.delete('/bom-operations/:id', auth, requireManagerOrAdmin, handle(async (req) => ({
  data: await WorkCenter.removeBomOperation(req.params.id),
})));

// --- Work-order operations and time booking ---------------------------------

router.get('/work-orders/:id/operations', auth, handle(async (req) => ({
  data: await WorkCenter.listWorkOrderOperations(req.params.id),
})));

// Booking time or finishing an operation is when a line's pace changes, so the
// line watch re-checks that centre straight after (in the background — the
// booking never waits on it or fails because of it).
router.post('/operations/:id/book-time', auth, handle(async (req) => {
  const data = await WorkCenter.bookTime(req.params.id, req.body, req.user.id);
  require('../services/lineWatch').checkAfterBooking(req.companyId, req.params.id);
  return { data };
}));

router.post('/operations/:id/complete', auth, handle(async (req) => {
  const data = await WorkCenter.completeOperation(req.params.id);
  require('../services/lineWatch').checkAfterBooking(req.companyId, req.params.id);
  return { data };
}));

// --- Line watch ---------------------------------------------------------------

// GET /manufacturing/line-watch?work_center=ML-03&include_steady=1 — which
// work centres have slowed or stopped, what the queued work will cost at the
// pace they are really running, and which customer orders that puts at risk
// (services/lineWatch.js — the same answer Simeli gives). Read-only.
router.get('/line-watch', auth, async (req, res) => {
  try {
    if (req.companyId) {
      const enabled = await require('../services/moduleService').getEnabledModuleKeys(req.companyId);
      if (!enabled.has('manufacturing')) return res.status(403).json({ success: false, error: 'Manufacturing is not enabled for this company.' });
    }
    const data = await require('../services/lineWatch').watchLines({
      companyId: req.companyId,
      userId: req.user?.isApiKey ? null : req.user?.id,
      role: req.user?.role,
      workCenter: req.query.work_center || null,
      includeSteady: req.query.include_steady === '1' || req.query.include_steady === 'true',
    });
    if (data.error) return res.status(404).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Line watch error:', error.message);
    res.status(500).json({ success: false, error: 'Could not read the lines.' });
  }
});

// POST /manufacturing/operations/:id/move { work_center_id } — the person's
// side of the line watch's "move this operation" proposal. Simeli proposes it;
// only a manager can carry it out, and only on an operation not yet started.
router.post('/operations/:id/move', auth, requireManagerOrAdmin, handle(async (req) => {
  const target = req.body?.work_center_id;
  if (!target) throw new Error('work_center_id is required.');
  const { pool } = require('../config/database');
  const { rows: [wc] } = await pool.query(
    `SELECT id, code, hourly_rate FROM work_centers
      WHERE id = $1 AND deleted_at IS NULL AND status = 'ACTIVE'
        AND company_id = COALESCE($2::uuid, company_id)`,
    [target, req.companyId || null]
  );
  if (!wc) throw new Error('That work centre is not active in this company.');
  const { rows } = await pool.query(
    `UPDATE work_order_operations op
        SET work_center_id = $2, hourly_rate = CASE WHEN $3::numeric > 0 THEN $3::numeric ELSE op.hourly_rate END,
            updated_at = CURRENT_TIMESTAMP
       FROM work_orders wo
      WHERE op.id = $1 AND wo.id = op.work_order_id AND op.status = 'PENDING' AND op.actual_hours = 0
        AND wo.company_id = COALESCE($4::uuid, wo.company_id)
      RETURNING op.*`,
    [req.params.id, wc.id, wc.hourly_rate, req.companyId || null]
  );
  if (!rows.length) throw new Error('Only an operation that has not started can be moved.');
  return { data: rows[0], message: `Moved to ${wc.code}.` };
}));

module.exports = router;
