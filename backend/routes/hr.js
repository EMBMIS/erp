const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const { scopedMulter } = require('../middleware/scopedMulter');
const Employee = require('../models/Employee');
const PayrollRun = require('../models/PayrollRun');
const Leave = require('../models/Leave');
const { auth, requireManagerOrAdmin } = require('../middleware/auth');
const { requireSoD } = require('../middleware/rbac');
const { recordCreator } = require('../middleware/recordOwner');

// GET /hr/analytics?months=12 — the module overview in one round trip.
router.get('/analytics', auth, async (req, res) => {
  try {
    const { getHrAnalytics } = require('../services/hrAnalytics');
    const data = await getHrAnalytics(Number(req.query.months) || 12);
    res.json({ success: true, data });
  } catch (error) {
    console.error('HR analytics error:', error);
    res.status(500).json({ success: false, error: 'Failed to load HR analytics' });
  }
});

// ---- Employees -------------------------------------------------------------

router.get('/employees', auth, async (req, res) => {
  try {
    // Server-side paging + sorting, same envelope as /customer-invoices so the
    // shared useListControls front-end hook works unchanged. Page size is
    // capped: `?limit=100000` is a denial of service anyone can type into the
    // address bar, and the default has to be finite too — an HR directory with
    // thousands of employees should not be serialized in full because a caller
    // omitted a parameter.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    // The front-end hook sends ?offset=; REST-style ?page=1..N is accepted too.
    // offset wins when both are present.
    const offset = req.query.offset !== undefined
      ? Math.max(parseInt(req.query.offset, 10) || 0, 0)
      : Math.max((parseInt(req.query.page, 10) || 1) - 1, 0) * limit;

    const { rows, total } = await Employee.findAll({
      status: req.query.status,
      search: req.query.search,
      sort_by: req.query.sort_by,
      sort_dir: req.query.sort_dir,
      limit,
      offset,
    });
    res.json({ success: true, data: rows, total, limit, offset });
  } catch (error) {
    console.error('List employees error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/employees/stats', auth, async (req, res) => {
  try {
    const stats = await Employee.getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('Employee stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/employees', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    if (!req.body.first_name || !req.body.last_name) {
      return res.status(400).json({ success: false, error: 'first_name and last_name are required' });
    }
    const employee = await Employee.create(req.body, req.user.id);
    res.status(201).json({ success: true, data: employee });
  } catch (error) {
    console.error('Create employee error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

router.put('/employees/:id', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const employee = await Employee.update(req.params.id, req.body, req.user.id);
    res.json({ success: true, data: employee });
  } catch (error) {
    console.error('Update employee error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// GET /hr/employees/org-chart — the full reporting tree, rooted at whoever
// has no manager. Placed before /:id-style routes below would collide with,
// but there are none on this path, so no ordering hazard.
router.get('/employees/org-chart', auth, async (req, res) => {
  try {
    const tree = await Employee.orgChart();
    res.json({ success: true, data: tree });
  } catch (error) {
    console.error('Org chart error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/employees/:id/job-history', auth, async (req, res) => {
  try {
    const history = await Employee.jobHistory(req.params.id);
    res.json({ success: true, data: history });
  } catch (error) {
    console.error('Job history error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---- Employee document vault ------------------------------------------------
// Manager/admin only both ways: personnel files (contracts, ID copies,
// performance reviews) are exactly the kind of record that should not be
// self-service-readable by every authenticated user.

router.get('/employees/:id/documents', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const { rows } = await require('../config/database').pool.query(
      `SELECT id, employee_id, category, file_name, mime_type, file_size, uploaded_by, created_at
         FROM employee_documents WHERE employee_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/employees/:id/documents', auth, requireManagerOrAdmin, scopedMulter(upload.single('file')), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'file is required (multipart field "file").' });
    const { v4: uuidv4 } = require('uuid');
    const category = ['CONTRACT', 'ID', 'CERTIFICATE', 'PERFORMANCE', 'OTHER'].includes(req.body?.category) ? req.body.category : 'OTHER';
    const { rows: [doc] } = await require('../config/database').pool.query(
      `INSERT INTO employee_documents (id, employee_id, category, file_name, mime_type, file_size, file_data, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, employee_id, category, file_name, mime_type, file_size, uploaded_by, created_at`,
      [uuidv4(), req.params.id, category, req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer, req.user.id]
    );
    res.status(201).json({ success: true, data: doc });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.get('/employees/:id/documents/:docId/download', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const { rows } = await require('../config/database').pool.query(
      `SELECT file_name, mime_type, file_data FROM employee_documents
        WHERE id = $1 AND employee_id = $2 AND deleted_at IS NULL`,
      [req.params.docId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Document not found' });
    const doc = rows[0];
    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${doc.file_name}"`);
    res.send(doc.file_data);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/employees/:id/documents/:docId', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const { rowCount } = await require('../config/database').pool.query(
      `UPDATE employee_documents SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND employee_id = $2 AND deleted_at IS NULL`,
      [req.params.docId, req.params.id]
    );
    if (!rowCount) return res.status(404).json({ success: false, error: 'Document not found' });
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// ---- Payroll ---------------------------------------------------------------

router.get('/payroll', auth, async (req, res) => {
  try {
    const runs = await PayrollRun.findAll();
    res.json({ success: true, data: runs });
  } catch (error) {
    console.error('List payroll runs error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/payroll/:id', auth, async (req, res) => {
  try {
    const run = await PayrollRun.findById(req.params.id);
    if (!run) return res.status(404).json({ success: false, error: 'Payroll run not found' });
    res.json({ success: true, data: run });
  } catch (error) {
    console.error('Get payroll run error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /hr/payroll/:id/payslip/:itemId - printable payslip PDF for one employee
// line within a run. Manager/Admin only (payslips carry other employees' pay).
router.get('/payroll/:id/payslip/:itemId', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const run = await PayrollRun.findById(req.params.id);
    if (!run) return res.status(404).json({ success: false, error: 'Payroll run not found' });
    const item = (run.items || []).find((i) => i.id === req.params.itemId);
    if (!item) return res.status(404).json({ success: false, error: 'Payroll item not found in this run' });

    const employeeResult = await Employee.findById ? await Employee.findById(item.employee_id).catch(() => null) : null;
    const { generatePayslipPdf } = require('../services/pdf/pdfService');
    const doc = generatePayslipPdf(run, item, employeeResult || {});
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="payslip-${run.run_number}-${item.employee_name}.pdf"`);
    doc.pipe(res);
  } catch (error) {
    console.error('Generate payslip PDF error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create + process a run for a period (generates items from active employees)
router.post('/payroll', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const run = await PayrollRun.createAndProcess(req.body, req.user.id);
    res.status(201).json({ success: true, data: run });
  } catch (error) {
    console.error('Create payroll run error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// Approve a DRAFT run (SoD: the person who ran it cannot approve it)
router.post('/payroll/:id/approve', auth, requireManagerOrAdmin, requireSoD(recordCreator('payroll_runs'), 'payroll approval'), async (req, res) => {
  try {
    const run = await PayrollRun.approve(req.params.id, req.user.id);
    res.json({ success: true, data: run });
  } catch (error) {
    console.error('Approve payroll run error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// Post a run to the GL (accrue)
router.post('/payroll/:id/post', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const run = await PayrollRun.post(req.params.id, req.user.id);
    res.json({ success: true, data: run });
  } catch (error) {
    console.error('Post payroll run error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// Pay a posted run (settle the accrued net from cash)
router.post('/payroll/:id/pay', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const run = await PayrollRun.markPaid(req.params.id, req.user.id, req.body?.cash_account_code || '1110');
    res.json({ success: true, data: run });
  } catch (error) {
    console.error('Pay payroll run error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// ---- Leave requests --------------------------------------------------------

router.get('/leave', auth, async (req, res) => {
  try {
    const { employee_id, status } = req.query;
    let q = 'SELECT lr.*, e.first_name, e.last_name FROM leave_requests lr JOIN employees e ON lr.employee_id = e.id WHERE lr.deleted_at IS NULL';
    const p = [];
    if (employee_id) { p.push(employee_id); q += ` AND lr.employee_id = $${p.length}`; }
    if (status) { p.push(status); q += ` AND lr.status = $${p.length}`; }
    q += ' ORDER BY lr.start_date DESC LIMIT 200';
    const { rows } = await require('../config/database').pool.query(q, p);
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/leave', auth, async (req, res) => {
  try {
    const { employee_id, leave_type, start_date, end_date, reason } = req.body;
    if (!employee_id || !leave_type || !start_date || !end_date) {
      return res.status(400).json({ success: false, error: 'employee_id, leave_type, start_date, end_date required.' });
    }
    const days = Math.max(1, (new Date(end_date) - new Date(start_date)) / (1000 * 60 * 60 * 24) + 1);
    const { v4: uuidv4 } = require('uuid');
    const { rows: [lr] } = await require('../config/database').pool.query(
      `INSERT INTO leave_requests (id, employee_id, leave_type, start_date, end_date, total_days, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [uuidv4(), employee_id, leave_type, start_date, end_date, days, reason || null, req.user.id]
    );
    res.status(201).json({ success: true, data: lr });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// Decide a leave request. APPROVED deducts from the employee's leave balance
// (blocked if insufficient — UNPAID leave has no balance to check); a
// CANCELLED after a prior APPROVED credits the days back.
router.patch('/leave/:id', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const lr = await Leave.decide(req.params.id, req.body.status, req.user.id);
    res.json({ success: true, data: lr });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// ---- Leave accrual policies + balances --------------------------------------

router.get('/leave/policies', auth, async (req, res) => {
  try {
    res.json({ success: true, data: await Leave.listPolicies() });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/leave/policies', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    res.status(201).json({ success: true, data: await Leave.upsertPolicy(req.body, req.user.id) });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

router.get('/leave/balances/:employeeId', auth, async (req, res) => {
  try {
    res.json({ success: true, data: await Leave.getBalances(req.params.employeeId) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Run one period's accrual for every active employee against every policy.
// Idempotent — a second call for the same year/month is a safe no-op.
router.post('/leave/accrue', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const { period_year, period_month } = req.body;
    res.json({ success: true, data: await Leave.accrueMonthly(Number(period_year), Number(period_month), req.user.id) });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// ---- Attendance -------------------------------------------------------------

router.get('/attendance', auth, async (req, res) => {
  try {
    const { employee_id, date_from, date_to } = req.query;
    let q = 'SELECT ar.*, e.first_name, e.last_name FROM attendance_records ar JOIN employees e ON ar.employee_id = e.id WHERE 1=1';
    const p = [];
    if (employee_id) { p.push(employee_id); q += ` AND ar.employee_id = $${p.length}`; }
    if (date_from) { p.push(date_from); q += ` AND ar.record_date >= $${p.length}`; }
    if (date_to) { p.push(date_to); q += ` AND ar.record_date <= $${p.length}`; }
    q += ' ORDER BY ar.record_date DESC LIMIT 200';
    const { rows } = await require('../config/database').pool.query(q, p);
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/attendance/clock-in', auth, async (req, res) => {
  try {
    const { employee_id } = req.body;
    if (!employee_id) return res.status(400).json({ success: false, error: 'employee_id required.' });
    const today = new Date().toISOString().slice(0, 10);
    const { v4: uuidv4 } = require('uuid');
    const { rows: [rec] } = await require('../config/database').pool.query(
      `INSERT INTO attendance_records (id, employee_id, record_date, clock_in, status)
       VALUES ($1,$2,$3,CURRENT_TIMESTAMP,'PRESENT')
       ON CONFLICT (employee_id, record_date) DO UPDATE SET clock_in = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       RETURNING *`, [uuidv4(), employee_id, today]
    );
    res.status(201).json({ success: true, data: rec });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

router.post('/attendance/clock-out', auth, async (req, res) => {
  try {
    const { employee_id } = req.body;
    if (!employee_id) return res.status(400).json({ success: false, error: 'employee_id required.' });
    const today = new Date().toISOString().slice(0, 10);
    const { rows: [rec] } = await require('../config/database').pool.query(
      `UPDATE attendance_records SET clock_out = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE employee_id = $1 AND record_date = $2 AND clock_out IS NULL
        RETURNING *`, [employee_id, today]
    );
    if (!rec) return res.status(404).json({ success: false, error: 'No open clock-in found for today.' });
    res.json({ success: true, data: rec });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

module.exports = router;
