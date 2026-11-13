import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Reuses the backend's own DB credentials (same repo, same Postgres instance)
// rather than duplicating connection config here.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../backend/.env') });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const API_BASE = 'http://localhost:3001/api';
const ADMIN_EMAIL = 'admin@qiraerp.com';
const ADMIN_PASSWORD = 'admin123';

/**
 * Regression test for two stacked contract_items bugs fixed 2026-08-05 (see
 * ERP_HONEST_AUDIT.md, "Schema-Mismatch Sweep"):
 *   1. Every field routes/contract-items.js referenced on the `contract_items`
 *      table was missing from the schema (fixed by migration
 *      202608051500_contract_items_missing_columns.sql).
 *   2. Even with the columns in place, POST /contract-items/bulk inserted the
 *      inventory_items.id it receives (that's what supplier_items.item_id
 *      actually FKs to) straight into contract_items.item_id, which FKs to
 *      items(id) -- the item master, a different table. Every insert violated
 *      that foreign key.
 * Both failures were silent: the bulk endpoint catches each item's error
 * individually and still returns HTTP 200, and the frontend's alert() only
 * checks the top-level `success` flag -- so every contract created through
 * the UI ended up with zero line items while showing "Contract created
 * successfully with N items!". This drives the real UI end to end and
 * asserts the item actually lands in the database, not what the page claims.
 */

let supplierId;
let supplierCode;
let inventoryItemId;
let itemName;
let createdContractId;

test.beforeAll(async () => {
  const loginRes = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const loginBody = await loginRes.json();
  if (!loginBody.success) throw new Error('E2E fixture setup: admin login failed — ' + JSON.stringify(loginBody));

  // A real, existing inventory item + its item master (created by an
  // earlier backend test run; reused rather than duplicated).
  const itemRow = await pool.query(
    `SELECT ii.id AS inventory_item_id, i.name
       FROM inventory_items ii JOIN items i ON ii.item_master_id = i.id
      LIMIT 1`
  );
  if (!itemRow.rows.length) throw new Error('E2E fixture setup: no inventory_items with a linked item master exist to test against.');
  inventoryItemId = itemRow.rows[0].inventory_item_id;
  itemName = itemRow.rows[0].name;

  // Supplier certification is a multi-step workflow (submit -> approve ->
  // supplier-portal-token confirmation -> certify) that isn't what this test
  // is verifying. Seeding the end state directly via SQL is the same
  // "arrange via DB, act via UI" pattern the backend suite already uses for
  // its own fixtures (see tests/consolidation.test.js, anomalyDetection.test.js).
  const companyRow = await pool.query('SELECT id FROM companies WHERE deleted_at IS NULL LIMIT 1');
  const companyId = companyRow.rows[0].id;
  supplierCode = `E2E-SUP-${Date.now()}`.slice(0, 20);
  const supplierRes = await pool.query(
    `INSERT INTO suppliers (supplier_code, legal_name, email, country, payment_terms, currency, status, certification_status, company_id, created_by)
     VALUES ($1, 'E2E Playwright Test Supplier', 'e2e-playwright-supplier@example.com', 'US', 'Net 30', 'USD', 'ACTIVE', 'CERTIFIED', $2, $3)
     RETURNING id`,
    [supplierCode, companyId, loginBody.data.user.id]
  );
  supplierId = supplierRes.rows[0].id;

  await pool.query(
    `INSERT INTO supplier_items (supplier_id, item_id, unit_price, currency, status, company_id)
     VALUES ($1, $2, 25.50, 'USD', 'ACTIVE', $3)`,
    [supplierId, inventoryItemId, companyId]
  );
});

test.afterAll(async () => {
  // Delete every contract this supplier ended up with, not just
  // createdContractId -- a failed assertion mid-test can leave the contract
  // created without that variable ever being set, and an orphaned contract
  // referencing this supplier would otherwise block the supplier delete below.
  if (supplierId) {
    const stray = await pool.query('SELECT id FROM contracts WHERE supplier_id = $1', [supplierId]);
    for (const row of stray.rows) {
      await pool.query('DELETE FROM contract_items WHERE contract_id = $1', [row.id]);
      await pool.query('DELETE FROM contracts WHERE id = $1', [row.id]);
    }
    await pool.query('DELETE FROM supplier_items WHERE supplier_id = $1', [supplierId]);
    await pool.query('DELETE FROM suppliers WHERE id = $1', [supplierId]);
  }
  await pool.end();
});

test('creating a contract with a line item through the UI actually persists the item', async ({ page }) => {
  // Real login through the real UI, not a stubbed session.
  await page.goto('/login');
  await page.getByLabel('Email address').fill(ADMIN_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/', { timeout: 10000 });

  await page.goto('/procurement/contracts/create');
  await expect(page.getByRole('heading', { name: 'Create New Contract' })).toBeVisible();

  // selectOption's {label} matcher requires an exact string, and both option
  // labels here are built from live data (supplier code, formatted price) --
  // easier and less brittle to find the matching <option> by partial text
  // and select its value directly.
  const selectByPartialOptionText = async (selectLocator, partialText) => {
    const value = await selectLocator.evaluate((el, text) => {
      const opt = Array.from(el.options).find((o) => o.textContent.includes(text));
      return opt ? opt.value : null;
    }, partialText);
    if (!value) throw new Error(`No <option> containing "${partialText}" found in select#${await selectLocator.evaluate((el) => el.id)}`);
    await selectLocator.selectOption(value);
  };

  const contractTitle = `E2E Playwright Contract ${Date.now()}`;
  // Match on the run-unique supplier code, not just the shared display name --
  // a previous run's leftover fixture (if cleanup ever fails mid-run) would
  // otherwise be an equally valid, wrong match for a generic name search.
  await selectByPartialOptionText(page.locator('#supplier_id'), supplierCode);
  await page.locator('#title').fill(contractTitle);
  await page.locator('#contract_value').fill('255.00');
  await page.locator('#start_date').fill('2026-09-01');
  await page.locator('#end_date').fill('2027-09-01');

  // Contract Items section only renders once a supplier is selected.
  await expect(page.getByRole('heading', { name: 'Contract Items' })).toBeVisible();
  await page.getByRole('button', { name: 'Add Item' }).click();
  await selectByPartialOptionText(page.locator('#item'), itemName);
  await page.locator('#quantity').fill('10');
  await page.getByRole('button', { name: 'Add Item to Contract' }).click();
  await expect(page.getByText('Selected Items (1)')).toBeVisible();

  // Capture the actual bulk-add response for a direct assertion, in addition
  // to the DB check below. Routed through Playwright's own fetch (not a
  // passive response/requestfinished listener) because the page navigates
  // away immediately after this call resolves, which reliably raced away the
  // body when read passively.
  let bulkStatus = null;
  let bulkBody = null;
  await page.route('**/contract-items/bulk', async (route) => {
    const response = await route.fetch();
    bulkStatus = response.status();
    bulkBody = await response.json();
    await route.fulfill({ response });
  });
  page.once('dialog', (dialog) => dialog.accept()); // the post-submit alert()

  await page.getByRole('button', { name: 'Create Contract' }).click();
  await expect.poll(() => bulkStatus, { timeout: 10000 }).toBe(200);
  await expect(page).toHaveURL(/\/procurement\/contracts/, { timeout: 10000 });

  expect(bulkBody.data.summary.successfully_created).toBe(1);
  expect(bulkBody.data.errors).toHaveLength(0);

  // The old bugs' failure mode was invisible in the UI (still showed a
  // "success" alert with 0 items silently dropped) -- the real assertion has
  // to be against the database, not what the page or the response claims.
  const contractRow = await pool.query(
    'SELECT id FROM contracts WHERE title = $1 AND supplier_id = $2',
    [contractTitle, supplierId]
  );
  expect(contractRow.rows.length).toBe(1);
  createdContractId = contractRow.rows[0].id;

  const itemRows = await pool.query(
    'SELECT quantity, status, item_id FROM contract_items WHERE contract_id = $1',
    [createdContractId]
  );
  expect(itemRows.rows.length).toBe(1);
  expect(Number(itemRows.rows[0].quantity)).toBe(10);
  // The persisted item_id must be the item MASTER id, not the inventory_items
  // id the form actually submitted -- this is the exact translation the
  // second bug skipped.
  const masterRow = await pool.query('SELECT item_master_id FROM inventory_items WHERE id = $1', [inventoryItemId]);
  expect(itemRows.rows[0].item_id).toBe(masterRow.rows[0].item_master_id);
});
