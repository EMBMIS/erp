/**
 * Serial / lot recall report — GET /inventory-traceability/recall.
 *
 * Answers the question a real recall needs answered: "supplier X told us lot
 * ABC is defective — which receipts brought it in, and which sales orders did
 * it go out on?" Backed by services/serialLotService.js's ledger, which is
 * populated by every goods receipt and goods issue that names a serial or
 * batch/lot number.
 */

const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const SerialLotService = require('../services/serialLotService');

router.use(auth);

// GET /inventory-traceability/recall?serial_number=SN123
// GET /inventory-traceability/recall?batch_lot_number=LOT-2026-01
router.get('/recall', async (req, res) => {
  try {
    const { serial_number, batch_lot_number, inventory_item_id } = req.query;
    if (!serial_number && !batch_lot_number) {
      return res.status(400).json({ success: false, error: 'serial_number or batch_lot_number query parameter is required' });
    }

    const report = await SerialLotService.recallReport({
      inventoryItemId: inventory_item_id || null,
      serialNumber: serial_number || null,
      batchLotNumber: batch_lot_number || null,
    });

    res.json({ success: true, data: report });
  } catch (err) {
    console.error('Recall report error:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
