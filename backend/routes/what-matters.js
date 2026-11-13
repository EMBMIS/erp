/**
 * What matters now — the Home screen's view of the same brief Simeli gives to
 * "what needs my attention today?" (services/whatMattersNow.js). Every watcher
 * runs as the signed-in person, inside their company. Read-only.
 */

const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const { whatMattersNow } = require('../services/whatMattersNow');
const { watchFeed } = require('../services/simeliWatch');
const { builtInTheBusiness } = require('../services/builtInTheBusiness');
const { businessMap } = require('../services/businessMap');

// GET /what-matters?limit=7&fresh=1
router.get('/', auth, async (req, res) => {
  try {
    const data = await whatMattersNow({
      companyId: req.companyId,
      userId: req.user?.isApiKey ? null : req.user?.id,
      role: req.user?.role,
      limit: req.query.limit,
      fresh: req.query.fresh === '1' || req.query.fresh === 'true',
    });
    if (data.error) return res.status(400).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('What matters error:', error.message);
    res.status(500).json({ success: false, error: 'Could not read what needs attention.' });
  }
});

// GET /what-matters/watch?since=ISO&check=1 — what Simeli noticed for this person: new, worse, still open, cleared.
// check=1 watches them first (no notification: they are reading it). Writes only the watch's own memory.
router.get('/watch', auth, async (req, res) => {
  try {
    if (req.user?.isApiKey) return res.status(400).json({ success: false, error: 'The watch is kept per person.' });
    const data = await watchFeed({
      companyId: req.companyId,
      userId: req.user?.id,
      role: req.user?.role,
      since: req.query.since,
      checkNow: req.query.check === '1' || req.query.check === 'true',
    });
    if (data.error) return res.status(400).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Simeli watch error:', error.message);
    res.status(500).json({ success: false, error: 'Could not read what Simeli noticed.' });
  }
});

// GET /what-matters/built?application=key — what the company built in Sandbox, read as this person and tied to the
// suppliers, customers and orders it reaches. Read-only.
router.get('/built', auth, async (req, res) => {
  try {
    if (req.user?.isApiKey) return res.status(400).json({ success: false, error: 'Built applications are read as a person.' });
    const data = await builtInTheBusiness({
      companyId: req.companyId, userId: req.user?.id, role: req.user?.role, application: req.query.application || null,
    });
    if (data.error) return res.status(400).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Built in the business error:', error.message);
    res.status(500).json({ success: false, error: 'Could not read what was built.' });
  }
});

// GET /what-matters/map?fresh=1 — the whole business on one map: every part as this person sees it, what depends on
// what, and the at-risk order whose cause crosses the most of it. Read-only.
router.get('/map', auth, async (req, res) => {
  try {
    const data = await businessMap({
      companyId: req.companyId,
      userId: req.user?.isApiKey ? null : req.user?.id,
      role: req.user?.role,
      fresh: req.query.fresh === '1' || req.query.fresh === 'true',
    });
    if (data.error) return res.status(400).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Business map error:', error.message);
    res.status(500).json({ success: false, error: 'Could not read the business map.' });
  }
});

module.exports = router;
