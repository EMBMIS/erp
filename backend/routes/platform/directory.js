/**
 * The application directory: what this company runs, and the switch for it.
 *
 * One set of endpoints for built-in modules and for capabilities a company
 * designed itself. A caller that wants to switch Finance off and a caller that
 * wants to switch off a supplier-quality application built last Tuesday send
 * the same request to the same place.
 *
 * There is no DELETE here, and that is the design rather than an omission —
 * see services/platform/appDirectory.js and migration 202609050100.
 */

const express = require('express');
const router = express.Router();

const { auth } = require('../../middleware/auth');
const { handler, requireAdmin, companyOf, userOf } = require('./_shared');
const directory = require('../../services/platform/appDirectory');

router.use(auth);

/** Everything installed, on or off. Readable by anyone who can see the shell. */
router.get('/', handler(async (req, res) => {
  res.json({ success: true, data: await directory.list(companyOf(req)) });
}));

/**
 * The composed home page.
 *
 * The shell asks for this and renders whatever comes back. It does not know
 * which applications exist, and it must not: a capability deployed this
 * morning appears here this morning without a frontend release.
 */
router.get('/home', handler(async (req, res) => {
  res.json({
    success: true,
    data: await directory.home(companyOf(req), { userId: userOf(req), role: req.user?.role }),
  });
}));

/**
 * Switch one on or off. Administrator only: deciding which applications a
 * company runs is not a permission any application can grant itself.
 */
router.post('/:appKey/enabled', requireAdmin, handler(async (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({
      success: false, error: 'Say whether it should be enabled: true or false.', code: 'ENABLED_REQUIRED',
    });
  }
  const app = await directory.setEnabled(companyOf(req), req.params.appKey, enabled, {
    actorId: userOf(req), reason: req.body?.reason || null,
  });
  res.json({ success: true, data: app });
}));

module.exports = router;
