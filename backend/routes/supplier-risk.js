/**
 * Suppliers at risk, and why — the Procurement screens' view of the same
 * assessment Simeli answers from (services/supplierRisk.js). Read-only.
 */

const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const { assessSupplierRisk } = require('../services/supplierRisk');
const { recallSupplierPrecedent } = require('../services/supplierMemory');
const moduleService = require('../services/moduleService');

// GET /supplier-risk?supplier=&include_low=1
router.get('/', auth, async (req, res) => {
  try {
    if (req.companyId) {
      const enabled = await moduleService.getEnabledModuleKeys(req.companyId);
      if (!enabled.has('procurement')) return res.status(403).json({ success: false, error: 'Procurement is not enabled for this company.' });
    }
    const data = await assessSupplierRisk({
      companyId: req.companyId,
      userId: req.user?.isApiKey ? null : req.user?.id,
      role: req.user?.role,
      supplier: req.query.supplier_id || req.query.supplier || null,
      includeLow: req.query.include_low === '1' || req.query.include_low === 'true',
    });
    if (data.error) return res.status(404).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Supplier risk error:', error.message);
    res.status(500).json({ success: false, error: 'Could not assess supplier risk.' });
  }
});

// GET /supplier-risk/precedent?supplier_id=
// "<supplier> is late again. What did we do last time?" — the same answer Simeli gives
// (services/supplierMemory.js). Read-only; the split order is a proposal a person drafts.
router.get('/precedent', auth, async (req, res) => {
  try {
    if (req.companyId) {
      const enabled = await moduleService.getEnabledModuleKeys(req.companyId);
      if (!enabled.has('procurement')) return res.status(403).json({ success: false, error: 'Procurement is not enabled for this company.' });
    }
    const data = await recallSupplierPrecedent({
      companyId: req.companyId,
      userId: req.user?.isApiKey ? null : req.user?.id,
      role: req.user?.role,
      supplier: req.query.supplier_id || req.query.supplier || null,
    });
    if (data.error) return res.status(404).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Supplier precedent error:', error.message);
    res.status(500).json({ success: false, error: 'Could not read what was done last time.' });
  }
});

module.exports = router;
