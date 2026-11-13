/**
 * Per-company module (feature area) configuration.
 *
 * Not to be confused with routes/modules.js, which is an unrelated schema-
 * introspection/discovery API (table structure, sample rows) mounted at
 * /api/modules. This is the business-type-driven feature toggle system
 * (migration 202608071500) — mounted at /api/company-modules.
 *
 * Reading the enabled set is open to any authenticated user — the frontend
 * nav needs it on every page load, the same way the company switcher needs
 * /companies/mine. Toggling a module is admin territory: it changes what an
 * entire company's users and AI assistant can see and do.
 */

const express = require('express');
const router = express.Router();
const { auth, requireAdmin } = require('../middleware/auth');
const moduleService = require('../services/moduleService');

const handle = (fn) => async (req, res) => {
  try {
    const result = await fn(req, res);
    if (!res.headersSent) res.json({ success: true, ...result });
  } catch (error) {
    console.error(`Company modules error (${req.method} ${req.path}):`, error.message);
    if (!res.headersSent) res.status(400).json({ success: false, error: error.message });
  }
};

// GET / — full registry with this company's current on/off state.
router.get('/', auth, handle(async (req) => ({
  data: await moduleService.getModulesWithStatus(req.companyId),
})));

// GET /enabled — just the enabled keys, the shape the frontend nav filter
// and the AI tool gate actually consume.
router.get('/enabled', auth, handle(async (req) => ({
  data: [...(await moduleService.getEnabledModuleKeys(req.companyId))],
})));

// Deliberately public (no `auth`) — the signup form (routes/auth.js's
// POST /register-company) needs this list before the user has a token, and
// it's global, non-sensitive reference data (business-type names), not
// anything scoped to a company.
router.get('/business-types', handle(async () => ({
  data: await moduleService.listBusinessTypes(),
})));

// PUT /:key — { enabled: boolean }
router.put('/:key', auth, requireAdmin, handle(async (req) => {
  const enabled = req.body?.enabled === true;
  await moduleService.setModuleEnabled(req.companyId, req.params.key, enabled);
  return { data: await moduleService.getModulesWithStatus(req.companyId) };
}));

module.exports = router;
