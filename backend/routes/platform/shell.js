/**
 * What the shell itself needs: the company home, and later the cross-
 * application inbox.
 *
 * Separate from /platform/applications (the catalogue) and
 * /platform/apps-directory (what is installed and its switches) because this
 * is neither — it is the operating system's own screens, which are about the
 * business rather than about the software running it.
 */

const express = require('express');
const router = express.Router();

const { auth } = require('../../middleware/auth');
const { handler, companyOf, userOf } = require('./_shared');
const companyHome = require('../../services/platform/companyHome');
const myWork = require('../../services/platform/myWork');
const shellPreferences = require('../../services/platform/shellPreferences');

router.use(auth);

/**
 * The company home.
 *
 * Every figure is computed from canonical rows and every health verdict from
 * a declared threshold — see services/platform/companyHome.js. No model is
 * called here, deliberately: a judgement on a home page has to be the same
 * judgement tomorrow for the same data.
 */
router.get('/company-home', handler(async (req, res) => {
  res.json({ success: true, data: await companyHome.build(companyOf(req)) });
}));

/**
 * Everything waiting on the caller, from every application.
 *
 * The shell does not know what kinds of work exist — each application
 * reports its own. A capability with an approval step deployed this
 * afternoon is in this response this afternoon.
 */
router.get('/my-work', handler(async (req, res) => {
  res.json({
    success: true,
    data: await myWork.build(companyOf(req), { userId: userOf(req), role: req.user?.role }),
  });
}));

/**
 * The rail: which applications this person keeps to hand.
 *
 * Resolved against what the company actually runs, so a pin is a shortcut to
 * something they already have and never a way to acquire one.
 */
router.get('/rail', handler(async (req, res) => {
  res.json({ success: true, data: await shellPreferences.rail(companyOf(req), userOf(req)) });
}));

router.put('/rail', handler(async (req, res) => {
  const userId = userOf(req);
  if (!userId) {
    return res.status(400).json({ success: false, error: 'A rail belongs to a person.', code: 'NO_USER' });
  }
  res.json({ success: true, data: await shellPreferences.setPins(companyOf(req), userId, req.body?.pinned) });
}));

/** Forget the choice: back to the core applications. */
router.delete('/rail', handler(async (req, res) => {
  const userId = userOf(req);
  if (!userId) {
    return res.status(400).json({ success: false, error: 'A rail belongs to a person.', code: 'NO_USER' });
  }
  res.json({ success: true, data: await shellPreferences.reset(companyOf(req), userId) });
}));

module.exports = router;
