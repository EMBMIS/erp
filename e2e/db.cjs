// Opening-stock seeding for the production journey.
//
// CommonJS on purpose: Playwright's transform pipeline loads helper files as
// CommonJS, so any `import.meta` in an ESM helper explodes. This file uses the
// backend's own pg pool (backend/.env), which is exactly how
// backend/tests/manufacturing.test.js seeds component stock. The journeys
// themselves assert through the public API/UI.
'use strict';
const path = require('path');

let pool = null;

function getPool() {
  if (pool !== null) return pool;
  try {
    pool = require(path.join(__dirname, '..', 'backend', 'config', 'database')).pool;
  } catch (err) {
    pool = undefined; // backend deps not installed (e.g. CI frontend-only job)
  }
  return pool;
}

/**
 * Insert an approved inventory record with opening stock.
 * Returns { id, current_stock_quantity } or null when pg is unavailable.
 */
async function seedStock(itemMasterId, quantity, unitPrice, userId) {
  const p = getPool();
  if (!p) return null;
  const { rows } = await p.query(
    `INSERT INTO inventory_items (item_master_id, company_id, current_stock_quantity, unit_price, currency, user_id, status)
     VALUES ($1, (SELECT id FROM companies WHERE is_default = true LIMIT 1), $2, $3, 'USD', $4, 'APPROVED')
     RETURNING id, current_stock_quantity`,
    [itemMasterId, quantity, unitPrice, userId]
  );
  return rows[0];
}

/**
 * Insert an ACTIVE supplier owned by the journey's user, so the PR form's
 * supplier dropdown (GET /suppliers/active filters by created_by) offers a
 * selectable option. Returns the supplier or null when pg is unavailable.
 */
async function seedSupplier(userId, legalName) {
  const p = getPool();
  if (!p) return null;
  const { rows } = await p.query(
    `INSERT INTO suppliers (supplier_code, legal_name, status, created_by)
     VALUES (CONCAT('SUP-E2E-', floor(random() * 100000)::int), $1, 'ACTIVE', $2)
     RETURNING id, supplier_code, legal_name`,
    [legalName, userId]
  );
  return rows[0];
}

/**
 * Make a self-registered user a verified ADMIN. Registration deliberately ignores any requested role (every
 * self-registration is a USER; only the very first user of an install is an ADMIN), so the journeys promote
 * their own throw-away user directly. Returns true when promoted, false when pg is unavailable.
 */
async function promoteToAdmin(email) {
  const p = getPool();
  if (!p) return false;
  await p.query("UPDATE users SET role = 'ADMIN', email_verified = true WHERE email = $1", [email]);
  return true;
}

module.exports = { seedStock, seedSupplier, promoteToAdmin };
