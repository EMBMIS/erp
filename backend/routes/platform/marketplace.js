/**
 * The marketplace.
 *
 * Browsing is open to anyone who can see the shell — deciding whether a
 * capability is worth having is not an administrator's private business.
 * Publishing and installing are administrator-only: both change what a company
 * runs and what its data is exposed to.
 */

const express = require('express');
const router = express.Router();

const { auth } = require('../../middleware/auth');
const { handler, requireAdmin, companyOf, userOf } = require('./_shared');
const marketplace = require('../../services/platform/marketplace');

router.use(auth);

/** What is on offer, marked up with what this company already has and holds. */
router.get('/', handler(async (req, res) => {
  res.json({ success: true, data: await marketplace.browse(companyOf(req)) });
}));

/** This company's own listings. */
router.get('/published', handler(async (req, res) => {
  res.json({ success: true, data: await marketplace.published(companyOf(req)) });
}));

/** Offer an application built here to everybody else. */
router.post('/:appKey', requireAdmin, handler(async (req, res) => {
  res.status(201).json({
    success: true,
    data: await marketplace.publish({
      companyId: companyOf(req),
      appKey: req.params.appKey,
      summary: req.body?.summary,
      priceCents: Number.isFinite(req.body?.priceCents) ? Math.trunc(req.body.priceCents) : 0,
      currency: (req.body?.currency || 'USD').toUpperCase(),
      category: req.body?.category || null,
      actorId: userOf(req),
    }),
  });
}));

/**
 * Stop offering it. Companies already running it keep it, and keep their
 * data — withdrawal is about the shop window, not about reaching into
 * somebody else's business.
 */
router.delete('/:appKey', requireAdmin, handler(async (req, res) => {
  res.json({
    success: true,
    data: await marketplace.withdraw({
      companyId: companyOf(req), appKey: req.params.appKey, actorId: userOf(req),
    }),
  });
}));

/** Install somebody else's application. Free listings only, for now. */
router.post('/:appKey/install', requireAdmin, handler(async (req, res) => {
  res.status(201).json({
    success: true,
    data: await marketplace.install({
      companyId: companyOf(req), appKey: req.params.appKey, actorId: userOf(req),
    }),
  });
}));

module.exports = router;
