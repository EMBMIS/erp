/**
 * The warehouse twin — every bay, its cover, and the orders a short one puts
 * at risk. The Warehouse screens' view of the same model Simeli answers from
 * (services/warehouseTwin.js). Read-only.
 */

const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const { assessWarehouse } = require('../services/warehouseTwin');
const moduleService = require('../services/moduleService');

// GET /warehouse-twin?location=&bin=&horizon=
router.get('/', auth, async (req, res) => {
  try {
    if (req.companyId) {
      const enabled = await moduleService.getEnabledModuleKeys(req.companyId);
      if (!enabled.has('inventory')) return res.status(403).json({ success: false, error: 'Inventory is not enabled for this company.' });
    }
    const data = await assessWarehouse({
      companyId: req.companyId,
      userId: req.user?.isApiKey ? null : req.user?.id,
      role: req.user?.role,
      location: req.query.location_id || req.query.location || null,
      bin: req.query.bin || null,
      horizonDays: req.query.horizon,
    });
    if (data.error) return res.status(404).json({ success: false, error: data.error });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Warehouse twin error:', error.message);
    res.status(500).json({ success: false, error: 'Could not read the warehouse.' });
  }
});

module.exports = router;
