/**
 * Look up who created a record, for segregation-of-duties checks.
 *
 * The SoD guard needs one fact — the author of the record about to be approved
 * — and every approval route already has the record's id in `req.params.id`.
 * Rather than have each route hand-roll that lookup (and each get the column
 * name subtly wrong), this returns a resolver bound to a table.
 *
 * The table name is interpolated into SQL, so it is checked against an
 * allowlist first. It always comes from a literal in this codebase, never from
 * a request — but a table name cannot be a bound parameter, and "it is only
 * ever called with constants" is a property that stays true right up until it
 * doesn't.
 */

const { pool } = require('../config/database');

// Tables whose approval flows are subject to SoD, and the column on each that
// records who raised the document.
//
// The column is NOT `created_by` everywhere, which is the trap: three of these
// use something else, and a guard that assumed `created_by` would throw
// "column does not exist" on those tables. Because the guard runs as
// middleware, that error surfaces as a failed approval rather than as a
// bypass — safe, but it means the route stops working entirely, so it has to
// be right rather than merely fail-closed.
const OWNER_COLUMNS = {
  purchase_requisitions: 'requested_by',
  purchase_orders: 'created_by',
  sales_orders: 'created_by',
  sales_quotations: 'created_by',
  sales_contracts: 'created_by',
  contracts: 'created_by',
  journal_entries: 'created_by',
  supplier_invoices: 'created_by',
  customer_invoices: 'created_by',
  inventory_items: 'user_id',
  items: 'user_id',
  sales_credit_notes: 'created_by',
  payroll_runs: 'created_by',
  stocktake_sheets: 'counted_by',
};

const APPROVABLE_TABLES = new Set(Object.keys(OWNER_COLUMNS));

/**
 * @param {string} table
 * @param {string} [idParam] the route param holding the record id
 * @returns {(req) => Promise<string|null>}
 */
function recordCreator(table, idParam = 'id') {
  const ownerColumn = OWNER_COLUMNS[table];
  if (!ownerColumn) {
    // Thrown at module load, not per request: a typo should stop the server
    // starting rather than silently disable a control at 3am.
    throw new Error(`recordCreator: "${table}" is not a known approvable table.`);
  }

  return async (req) => {
    const id = req.params[idParam];
    if (!id) return null;

    const { rows } = await pool.query(
      `SELECT ${ownerColumn} AS owner FROM ${table} WHERE id = $1`,
      [id]
    );
    // No row means the record does not exist. That is the route's problem to
    // report as a 404, not this guard's to turn into a permission error, so it
    // returns null and lets the handler run.
    return rows[0]?.owner || null;
  };
}

module.exports = { recordCreator, APPROVABLE_TABLES, OWNER_COLUMNS };
