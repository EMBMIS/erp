/**
 * Who the business is waiting on — the HR screens' view of the same answer
 * Simeli gives (services/peopleCoverage.js): who decides what, who is away
 * when, which decisions lose their last approver, and what approving a leave
 * request would do. Reading is open to everyone (scoped to their role);
 * carrying out a proposal is a manager's or admin's confirmation.
 */

const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const { peopleCoverage, actOnCoverage } = require('../services/peopleCoverage');

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// GET /people-coverage?horizon_days=14&person=&what_if_person=&what_if_from=&what_if_to=
router.get('/', auth, async (req, res) => {
  try {
    for (const k of ['what_if_from', 'what_if_to']) {
      if (req.query[k] && !ISO.test(String(req.query[k]))) {
        return res.status(400).json({ success: false, error: `${k} must be YYYY-MM-DD.` });
      }
    }
    const data = await peopleCoverage({
      companyId: req.companyId,
      userId: req.user?.isApiKey ? null : req.user?.id,
      role: req.user?.role,
      horizonDays: req.query.horizon_days,
      person: req.query.person || null,
      whatIf: req.query.what_if_person
        ? { person: req.query.what_if_person, from: req.query.what_if_from, to: req.query.what_if_to }
        : null,
    });
    if (data.error) return res.status(400).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('People coverage error:', error.message);
    res.status(500).json({ success: false, error: 'Could not work out who covers what.' });
  }
});

// POST /people-coverage/act { proposal_id } — a manager or admin confirms one proposal.
router.post('/act', auth, async (req, res) => {
  try {
    if (req.user?.isApiKey) return res.status(403).json({ success: false, error: 'A person confirms this.' });
    const out = await actOnCoverage({
      companyId: req.companyId,
      userId: req.user?.id,
      role: req.user?.role,
      proposalId: req.body?.proposal_id,
      horizonDays: req.body?.horizon_days,
    });
    if (out.error) return res.status(out.status || 400).json({ success: false, error: out.error });
    res.json({ success: true, data: out, message: out.done });
  } catch (error) {
    console.error('People coverage act error:', error.message);
    res.status(500).json({ success: false, error: 'Could not carry out the proposal.' });
  }
});

module.exports = router;
