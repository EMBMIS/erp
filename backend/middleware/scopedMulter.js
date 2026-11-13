/**
 * Keep the request's company context alive across multer's streaming.
 *
 * The auth middleware establishes the company as an AsyncLocalStorage scope
 * around next(), and the database wrapper reads that scope to apply
 * `SET LOCAL app.current_company_id` per statement — that is what makes
 * row-level isolation work on a shared connection pool.
 *
 * Multer breaks the chain. It streams the body with busboy, and when a body
 * arrives in multiple chunks busboy's completion event is emitted from a
 * stream async context, NOT the request's ALS scope. The route handler that
 * multer finally invokes therefore has no ambient company: req.companyId is
 * perfectly set, yet the first INSERT fails with "new row violates
 * row-level security policy" because the company setting was never applied.
 * Small bodies (one chunk) slip through, which is why this presented as
 * intermittent — and why it hit exactly the large scans and CSVs.
 *
 * The fix wraps the multer middleware: the company is captured before the
 * stream starts (auth has already run) and re-entered around the next() that
 * hands control to the handler, so every query the handler makes is scoped.
 */
const { runWithCompany } = require('../services/companyContext');

function scopedMulter(middleware) {
  return (req, res, next) => {
    const companyId = req.companyId || null;
    return middleware(req, res, (err) => {
      if (err) return next(err);
      return runWithCompany(companyId, () => next());
    });
  };
}

module.exports = { scopedMulter };
