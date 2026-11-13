const express = require('express');
const router = express.Router();
const CustomerInvoice = require('../models/CustomerInvoice');
const { auth, requireManagerOrAdmin } = require('../middleware/auth');

// GET /customer-invoices - list invoices (Accounts Receivable)
router.get('/', auth, async (req, res) => {
  try {
    // Cap the page size. Without an upper bound `?limit=100000` is a denial of
    // service anyone can type into the address bar, and the default has to be
    // finite too — an AR ledger with thousands of open invoices should not be
    // serialized in full because a caller omitted a parameter.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { rows, total } = await CustomerInvoice.findAll({
      search: req.query.search,
      status: req.query.status,
      customer_id: req.query.customer_id,
      overdue_only: req.query.overdue_only === 'true',
      sort_by: req.query.sort_by,
      sort_dir: req.query.sort_dir,
      limit,
      offset,
    });
    res.json({ success: true, data: rows, total, limit, offset });
  } catch (error) {
    console.error('List customer invoices error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /customer-invoices/stats - AR summary
router.get('/stats', auth, async (req, res) => {
  try {
    const stats = await CustomerInvoice.getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('Customer invoice stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /customer-invoices/:id - single invoice with items and payments
router.get('/:id', auth, async (req, res) => {
  try {
    const invoice = await CustomerInvoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ success: false, error: 'Invoice not found' });
    res.json({ success: true, data: invoice });
  } catch (error) {
    console.error('Get customer invoice error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /customer-invoices/:id/pdf - printable invoice PDF
router.get('/:id/pdf', auth, async (req, res) => {
  try {
    const invoice = await CustomerInvoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ success: false, error: 'Invoice not found' });

    const { generateInvoicePdf } = require('../services/pdf/pdfService');
    const doc = generateInvoicePdf(invoice);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="invoice-${invoice.invoice_number}.pdf"`);
    doc.pipe(res);
  } catch (error) {
    console.error('Generate invoice PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /customer-invoices/:id/e-invoice - Peppol BIS Billing 3.0 UBL XML export.
// A report/export capability, not a live send: this produces the standards-
// conformant document a Peppol Access Point would transmit, but does not
// itself connect to the Peppol network (see services/peppolInvoiceService.js).
router.get('/:id/e-invoice', auth, async (req, res) => {
  try {
    const { generateInvoiceXml } = require('../services/peppolInvoiceService');
    const xml = await generateInvoiceXml(req.params.id);
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="e-invoice-${req.params.id}.xml"`);
    res.send(xml);
  } catch (error) {
    if (error.message === 'Invoice not found.') {
      return res.status(404).json({ success: false, error: error.message });
    }
    if (error.validationProblems) {
      return res.status(422).json({ success: false, error: error.message, problems: error.validationProblems });
    }
    console.error('Generate e-invoice error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /customer-invoices/from-sales-order/:salesOrderId - generate invoice
router.post('/from-sales-order/:salesOrderId', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const invoice = await CustomerInvoice.createFromSalesOrder(req.params.salesOrderId, req.user.id);
    res.status(201).json({ success: true, data: invoice });
  } catch (error) {
    console.error('Create invoice from sales order error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// PATCH /customer-invoices/:id/status - update status (SENT, CANCELLED, ...)
router.patch('/:id/status', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const { status, reason } = req.body;
    const valid = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PAID', 'PARTIALLY_PAID', 'OVERDUE', 'CANCELLED'];
    if (!valid.includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status' });
    }
    const invoice = await CustomerInvoice.updateStatus(req.params.id, status, req.user.id, reason || '');
    res.json({ success: true, data: invoice });
  } catch (error) {
    console.error('Update invoice status error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
