const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { auth, requireManagerOrAdmin } = require('../middleware/auth');
const {
  getAuditTrail,
  listEntityTypes,
  verifyAuditChain,
  exportSignedAuditTrail,
} = require('../services/auditTrailService');

// GET /audit-trail/entity-types - the browsable entity types (for a filter dropdown)
router.get('/entity-types', auth, (req, res) => {
  res.json({ success: true, data: listEntityTypes() });
});

// GET /audit-trail/verify - tamper-evidence check: walks the whole persisted
// hash chain, recomputes every hash and reports the FIRST row where the chain
// breaks (a direct UPDATE/DELETE via SQL shows up as hash_mismatch /
// prev_hash_mismatch at exactly that row).
router.get('/verify', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const verification = await verifyAuditChain();
    res.json({ success: true, data: verification });
  } catch (error) {
    console.error('Audit chain verification error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /audit-trail/export - signed, hash-chained export of the audit log.
// The Ed25519 signature in the manifest is verifiable by a third party with
// verifySignedExport() (or any Ed25519 tool) using the public key embedded in
// the manifest — no database access required. ?download=1 also writes the
// export to backend/exports/audit-trail-signed-<ts>.json for off-line use.
router.get('/export', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const signed = await exportSignedAuditTrail();
    if (req.query.download === '1') {
      const dir = path.join(__dirname, '../exports');
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `audit-trail-signed-${Date.now()}.json`);
      fs.writeFileSync(filePath, JSON.stringify(signed, null, 2));
      return res.json({ success: true, path: filePath, manifest: signed.manifest });
    }
    res.json({ success: true, data: signed });
  } catch (error) {
    console.error('Audit trail export error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /audit-trail - unified activity feed across every status-history table +
// warehouse audit log + AI actions. Manager/Admin only — this is cross-user,
// cross-module activity, not a single user's own records.
router.get('/', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const entries = await getAuditTrail({
      // `auth` (see middleware/auth.js's establishCompany) resolves this on
      // every authenticated request — it is the same company a company-scoped
      // model query would see under RLS. Passed explicitly here because none
      // of the *_status_history tables this feed unions have an RLS policy of
      // their own to fall back on: they carry no company_id at all, so this
      // is the only thing standing between one company and another's status
      // history. See auditTrailService.getAuditTrail's doc comment.
      company_id: req.companyId,
      entity_type: req.query.entity_type,
      entity_id: req.query.entity_id,
      user_id: req.query.user_id,
      date_from: req.query.date_from,
      date_to: req.query.date_to,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ success: true, count: entries.length, data: entries });
  } catch (error) {
    console.error('Audit trail error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
