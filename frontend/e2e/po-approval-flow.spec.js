import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../backend/.env') });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const API_BASE = 'http://localhost:3001/api';
const ADMIN_EMAIL = 'admin@qiraerp.com';
const ADMIN_PASSWORD = 'admin123';

/**
 * Regression test for the two dead PO-approval buttons documented in
 * ERP_HONEST_AUDIT.md ("Procurement Frontend Audit"): POView.jsx called
 * `/purchase-orders/:id/submit` and `/purchase-orders/:id/send`, neither of
 * which exist -- the real routes are `/submit-for-approval` and
 * `/send-to-supplier`. Both buttons 404'd on every click, on every PO, for
 * as long as this screen existed. Fixed by another session, independently
 * re-verified live in this one; this spec is what keeps it fixed.
 */

let adminUserId;
let supplierId;
let poId;

test.beforeAll(async () => {
  const loginRes = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const loginBody = await loginRes.json();
  if (!loginBody.success) throw new Error('E2E fixture setup: admin login failed — ' + JSON.stringify(loginBody));
  adminUserId = loginBody.data.user.id;

  const supplierRow = await pool.query('SELECT id FROM suppliers LIMIT 1');
  if (!supplierRow.rows.length) throw new Error('E2E fixture setup: no suppliers exist to test against.');
  supplierId = supplierRow.rows[0].id;

  const companyRow = await pool.query('SELECT id FROM companies WHERE deleted_at IS NULL LIMIT 1');
  const poRes = await pool.query(
    `INSERT INTO purchase_orders (po_number, supplier_id, company_id, currency, subtotal, total_amount, status, created_by, source_type)
     VALUES (generate_po_number(), $1, $2, 'USD', 100, 100, 'DRAFT', $3, 'MANUAL')
     RETURNING id, po_number`,
    [supplierId, companyRow.rows[0].id, adminUserId]
  );
  poId = poRes.rows[0].id;
  await pool.query(
    `INSERT INTO purchase_order_line_items (po_id, item_description, unit_of_measure, quantity, unit_price)
     VALUES ($1, 'E2E PO approval test line', 'EA', 5, 20)`,
    [poId]
  );
});

test.afterAll(async () => {
  if (poId) {
    await pool.query('DELETE FROM purchase_order_line_items WHERE po_id = $1', [poId]);
    await pool.query('DELETE FROM purchase_orders WHERE id = $1', [poId]);
  }
  await pool.end();
});

test('Submit for Approval and Send to Supplier both hit real routes and advance PO status', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(ADMIN_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/', { timeout: 10000 });

  await page.goto(`/procurement/purchase-orders/${poId}`);
  await expect(page.getByRole('button', { name: 'Submit for Approval' })).toBeVisible();

  // Both actions confirm in an in-page dialog that names the order (it
  // replaced window.confirm, which could not be styled or read reliably).

  let submitStatus = null;
  await page.route('**/purchase-orders/*/submit-for-approval', async (route) => {
    const response = await route.fetch();
    submitStatus = response.status();
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Submit for Approval' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Submit PO-/ }).click();
  await expect.poll(() => submitStatus, { timeout: 10000 }).toBe(200);
  await expect(page.getByText('PENDING APPROVAL')).toBeVisible();

  const afterSubmit = await pool.query('SELECT status FROM purchase_orders WHERE id = $1', [poId]);
  expect(afterSubmit.rows[0].status).toBe('PENDING_APPROVAL');

  // Reaching APPROVED for real means driving the DoA approval chain, a
  // separate concern from "does this button hit a route that exists" (which
  // is the actual bug this spec guards against) -- seeded directly, same
  // "arrange via DB, act via UI" pattern as the contract-creation spec.
  await pool.query("UPDATE purchase_orders SET status = 'APPROVED' WHERE id = $1", [poId]);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Send to Supplier' })).toBeVisible();

  let sendStatus = null;
  await page.route('**/purchase-orders/*/send-to-supplier', async (route) => {
    const response = await route.fetch();
    sendStatus = response.status();
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Send to Supplier' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Send PO-/ }).click();
  await expect.poll(() => sendStatus, { timeout: 10000 }).toBe(200);
  await expect(page.getByText('SENT TO SUPPLIER')).toBeVisible();

  const afterSend = await pool.query('SELECT status FROM purchase_orders WHERE id = $1', [poId]);
  expect(afterSend.rows[0].status).toBe('SENT_TO_SUPPLIER');
});
