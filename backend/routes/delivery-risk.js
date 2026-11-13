/**
 * Deliveries at risk, and why — the Sales screen's view of the same trace
 * Simeli answers from (services/deliveryRisk.js). Read-only.
 */

const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const { traceDeliveryRisk } = require('../services/deliveryRisk');
const moduleService = require('../services/moduleService');
const { planRecovery, approveRecovery } = require('../services/deliveryRecovery');

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// GET /delivery-risk?horizon_days=14&sales_order_id=&customer=&due_from=&due_to=&include_covered=1
router.get('/', auth, async (req, res) => {
  try {
    if (req.companyId) {
      const enabled = await moduleService.getEnabledModuleKeys(req.companyId);
      if (!enabled.has('sales')) return res.status(403).json({ success: false, error: 'Sales is not enabled for this company.' });
    }
    for (const k of ['due_from', 'due_to']) {
      if (req.query[k] && !ISO.test(String(req.query[k]))) {
        return res.status(400).json({ success: false, error: `${k} must be YYYY-MM-DD.` });
      }
    }
    const data = await traceDeliveryRisk({
      companyId: req.companyId,
      userId: req.user?.isApiKey ? null : req.user?.id,
      role: req.user?.role,
      salesOrder: req.query.sales_order_id || req.query.sales_order || null,
      customer: req.query.customer || null,
      dueFrom: req.query.due_from || null,
      dueTo: req.query.due_to || null,
      horizonDays: req.query.horizon_days,
      includeCovered: req.query.include_covered === '1' || req.query.include_covered === 'true',
    });
    if (data.error) return res.status(404).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Delivery risk error:', error.message);
    res.status(500).json({ success: false, error: 'Could not trace delivery risk.' });
  }
});

async function salesEnabled(req, res) {
  if (!req.companyId) return true;
  const enabled = await moduleService.getEnabledModuleKeys(req.companyId);
  if (enabled.has('sales')) return true;
  res.status(403).json({ success: false, error: 'Sales is not enabled for this company.' });
  return false;
}

// GET /delivery-risk/recovery?sales_order_id= — the fixes that would make this
// order hold, each measured by re-running the trace with it assumed. Read-only.
router.get('/recovery', auth, async (req, res) => {
  try {
    if (!(await salesEnabled(req, res))) return;
    const salesOrder = req.query.sales_order_id || req.query.sales_order;
    if (!salesOrder) return res.status(400).json({ success: false, error: 'sales_order_id is required.' });
    const data = await planRecovery({
      companyId: req.companyId,
      userId: req.user?.isApiKey ? null : req.user?.id,
      role: req.user?.role,
      salesOrder,
    });
    if (data.error) return res.status(404).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Delivery recovery error:', error.message);
    res.status(500).json({ success: false, error: 'Could not plan a recovery.' });
  }
});

// GET /delivery-risk/chain?sales_order_id= — one order and everything behind it:
// customer credit, stock, supplier, purchase or work order, invoice, margin
// (services/orderChain.js, the same answer Simeli gives). Read-only.
router.get('/chain', auth, async (req, res) => {
  try {
    if (!(await salesEnabled(req, res))) return;
    const salesOrder = req.query.sales_order_id || req.query.sales_order;
    if (!salesOrder) return res.status(400).json({ success: false, error: 'sales_order_id is required.' });
    const { traceOrderChain } = require('../services/orderChain');
    const data = await traceOrderChain({
      companyId: req.companyId,
      userId: req.user?.isApiKey ? null : req.user?.id,
      role: req.user?.role,
      salesOrder,
    });
    if (data.error) return res.status(404).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Order chain error:', error.message);
    res.status(500).json({ success: false, error: 'Could not read the order chain.' });
  }
});

// GET /delivery-risk/promise?sales_order_id=|quotation_id=&date= — can it ship in
// full on that day, what is short, the first day in full, and the supplier who
// lands in time (services/promiseCheck.js, the same answer Simeli gives). Read-only.
router.get('/promise', auth, async (req, res) => {
  try {
    if (!(await salesEnabled(req, res))) return;
    const salesOrder = req.query.sales_order_id || req.query.sales_order;
    const quotation = req.query.quotation_id || req.query.quotation;
    if (!salesOrder && !quotation) return res.status(400).json({ success: false, error: 'sales_order_id or quotation_id is required.' });
    if (req.query.date && !ISO.test(String(req.query.date))) return res.status(400).json({ success: false, error: 'date must be YYYY-MM-DD.' });
    const { checkPromise } = require('../services/promiseCheck');
    const data = await checkPromise({
      companyId: req.companyId,
      userId: req.user?.isApiKey ? null : req.user?.id,
      role: req.user?.role,
      salesOrder: salesOrder || null,
      quotation: salesOrder ? null : quotation,
      date: req.query.date || null,
    });
    if (data.error) return res.status(404).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Promise check error:', error.message);
    res.status(500).json({ success: false, error: 'Could not check the promise.' });
  }
});

// GET /delivery-risk/sites — the company's active storage locations an order can ship from.
router.get('/sites', auth, async (req, res) => {
  try {
    if (!(await salesEnabled(req, res))) return;
    const { pool } = require('../config/database');
    const companyId = req.companyId || (await require('../services/companyContext').getDefaultCompanyId());
    const { rows } = await pool.query(
      `SELECT id, code, name, city FROM storage_locations
        WHERE company_id = $1 AND status = 'ACTIVE' AND COALESCE(is_active, true)
        ORDER BY code`,
      [companyId],
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Delivery sites error:', error.message);
    res.status(500).json({ success: false, error: 'Could not list sites.' });
  }
});

// PUT /delivery-risk/ship-from { sales_order_id, storage_location_id|null } — where
// an open order is picked from. With a site set, the trace counts only stock
// placed there and offers stock at other sites as a transfer. Whoever may see
// the order in the trace may set it: its creator, or a manager, finance manager
// or admin.
router.put('/ship-from', auth, async (req, res) => {
  try {
    if (!(await salesEnabled(req, res))) return;
    const { pool } = require('../config/database');
    const companyId = req.companyId || (await require('../services/companyContext').getDefaultCompanyId());
    const orderId = req.body?.sales_order_id;
    const siteId = req.body?.storage_location_id || null;
    if (!/^[0-9a-f-]{36}$/i.test(String(orderId || '')) || (siteId && !/^[0-9a-f-]{36}$/i.test(String(siteId)))) {
      return res.status(400).json({ success: false, error: 'sales_order_id (and storage_location_id, when given) must be ids.' });
    }
    const { rows: [so] } = await pool.query(
      'SELECT id, so_number, status, created_by FROM sales_orders WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL',
      [orderId, companyId],
    );
    if (!so) return res.status(404).json({ success: false, error: 'No such sales order in this company.' });
    if (!['ADMIN', 'MANAGER', 'FINANCE_MANAGER'].includes(req.user?.role) && so.created_by !== req.user?.id) {
      return res.status(403).json({ success: false, error: `${so.so_number} belongs to someone else's book.` });
    }
    if (['SHIPPED', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'REJECTED'].includes(so.status)) {
      return res.status(409).json({ success: false, error: `${so.so_number} is ${so.status.toLowerCase()}; where it ships from no longer changes anything.` });
    }
    let site = null;
    if (siteId) {
      ({ rows: [site] } = await pool.query(
        `SELECT id, code, name FROM storage_locations
          WHERE id = $1 AND company_id = $2 AND status = 'ACTIVE' AND COALESCE(is_active, true)`,
        [siteId, companyId],
      ));
      if (!site) return res.status(404).json({ success: false, error: 'No active storage location with that id in this company.' });
    }
    await pool.query(
      'UPDATE sales_orders SET ship_from_location_id = $1, updated_by = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 AND company_id = $4',
      [site?.id || null, req.user?.id || null, so.id, companyId],
    );
    res.json({
      success: true,
      data: { sales_order_id: so.id, ship_from: site },
      message: site ? `${so.so_number} ships from ${site.name} (${site.code}).` : `${so.so_number} counts stock across every site.`,
    });
  } catch (error) {
    console.error('Delivery ship-from error:', error.message);
    res.status(500).json({ success: false, error: 'Could not set where the order ships from.' });
  }
});

// POST /delivery-risk/recovery/approve { sales_order_id, plan_id } — a person's
// approval of one plan. Manager or admin only; the plan is re-measured and must
// still be one the planner offers now, so nothing from the client runs as given.
router.post('/recovery/approve', auth, async (req, res) => {
  try {
    if (!(await salesEnabled(req, res))) return;
    if (req.user?.isApiKey) return res.status(403).json({ success: false, error: 'A person approves recovery plans.' });
    const out = await approveRecovery({
      companyId: req.companyId,
      userId: req.user?.id,
      role: req.user?.role,
      salesOrder: req.body?.sales_order_id,
      planId: req.body?.plan_id,
    });
    if (out.error) return res.status(out.status || 400).json({ success: false, error: out.error });
    res.json({ success: true, data: out, message: out.done });
  } catch (error) {
    console.error('Delivery recovery approve error:', error.message);
    res.status(500).json({ success: false, error: 'Could not carry out the plan.' });
  }
});

// GET /delivery-risk/watch?sales_order_id= — what Simeli caught the moment this
// order landed (services/orderWatch.js): the finding, re-checked live in the
// asker's own view. Read-only, except that a finding which no longer holds is
// resolved.
router.get('/watch', auth, async (req, res) => {
  try {
    if (!(await salesEnabled(req, res))) return;
    const salesOrder = req.query.sales_order_id || req.query.sales_order;
    if (!salesOrder) return res.status(400).json({ success: false, error: 'sales_order_id is required.' });
    const data = await require('../services/orderWatch').readWatch({
      companyId: req.companyId,
      userId: req.user?.isApiKey ? null : req.user?.id,
      role: req.user?.role,
      salesOrder,
    });
    if (data.error) return res.status(data.status || 404).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Order watch read error:', error.message);
    res.status(500).json({ success: false, error: 'Could not read the order watch.' });
  }
});

// GET /delivery-risk/watch/caught?days=14 — orders that landed short and are still open.
router.get('/watch/caught', auth, async (req, res) => {
  try {
    if (!(await salesEnabled(req, res))) return;
    const data = await require('../services/orderWatch').listCaught({
      companyId: req.companyId,
      userId: req.user?.isApiKey ? null : req.user?.id,
      role: req.user?.role,
      days: req.query.days,
    });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Order watch list error:', error.message);
    res.status(500).json({ success: false, error: 'Could not list the orders that landed short.' });
  }
});

// POST /delivery-risk/watch/draft-po { sales_order_id, item_id } — a person with
// procurement authority drafts the purchase order the watch proposed. The
// proposal is re-measured now; the draft goes through purchase approval.
router.post('/watch/draft-po', auth, async (req, res) => {
  try {
    if (!(await salesEnabled(req, res))) return;
    if (req.user?.isApiKey) return res.status(403).json({ success: false, error: 'A person drafts purchase orders.' });
    const salesOrder = req.body?.sales_order_id;
    if (!/^[0-9a-f-]{36}$/i.test(String(salesOrder || '')) || (req.body?.item_id && !/^[0-9a-f-]{36}$/i.test(String(req.body.item_id)))) {
      return res.status(400).json({ success: false, error: 'sales_order_id (and item_id, when given) must be ids.' });
    }
    const out = await require('../services/orderWatch').draftFromWatch({
      companyId: req.companyId,
      userId: req.user?.id,
      role: req.user?.role,
      salesOrder,
      itemId: req.body?.item_id || null,
    });
    if (out.error) return res.status(out.status || 400).json({ success: false, error: out.error });
    res.status(201).json({ success: true, data: out, message: out.done });
  } catch (error) {
    console.error('Order watch draft error:', error.message);
    res.status(500).json({ success: false, error: 'Could not draft the purchase order.' });
  }
});

module.exports = router;
