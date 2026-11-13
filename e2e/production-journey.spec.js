// Production journey: BOM -> work order -> release -> issue materials ->
// confirm production. The load-bearing assertions are the warehouse and
// ledger handoffs: component stock must fall by exactly the BOM quantities,
// finished goods must land in stock, and balanced GL entries must exist for
// both the issue (WORK_ORDER_ISSUE) and the completion (WORK_ORDER_COMPLETION).
//
// Item/BOM setup goes through the same public API endpoints the UI pages use;
// opening component stock is seeded directly in the DB exactly like
// backend/tests/manufacturing.test.js does. Everything carries a run-specific
// suffix so reruns on a shared database never collide.

import { test, expect } from '@playwright/test';
import { seedAdminUser, loginViaUi, makeSuffix, api } from './helpers.mjs';
import { seedStock } from './db.cjs';

test.describe('Production journey', () => {
  test('BOM -> work order -> issue materials -> complete with stock moved and GL entries', async ({ page, request }) => {
    const admin = await seedAdminUser(request);
    await loginViaUi(page, admin);

    const suffix = makeSuffix();
    const fgName = `E2E FG Widget ${suffix}`;
    const boltName = `E2E Bolt ${suffix}`;
    const plateName = `E2E Plate ${suffix}`;

    // --- Seed item masters (same endpoint the item-create UI uses) ------------
    const fg = (await api(request, admin.token, 'post', '/api/items', {
      name: fgName, status: 'APPROVED', is_stock_item: true, unit_of_measure: 'PCS', item_category: 'E2E',
    })).body.data;
    const bolt = (await api(request, admin.token, 'post', '/api/items', {
      name: boltName, status: 'APPROVED', is_stock_item: true, unit_of_measure: 'PCS', item_category: 'E2E',
    })).body.data;
    const plate = (await api(request, admin.token, 'post', '/api/items', {
      name: plateName, status: 'APPROVED', is_stock_item: true, unit_of_measure: 'PCS', item_category: 'E2E',
    })).body.data;

    // --- Opening component stock: 4 bolts @ 5.00 + 1 plate @ 20.00 per unit ---
    const boltStock = await seedStock(bolt.id, 1000, 5, admin.user.id);
    const plateStock = await seedStock(plate.id, 1000, 20, admin.user.id);

    // --- BOM (same endpoint the BOM page uses), then activate -----------------
    const bom = (await api(request, admin.token, 'post', '/api/manufacturing/boms', {
      item_id: fg.id,
      description: `E2E BOM ${suffix}`,
      output_quantity: 1,
      components: [
        { component_item_id: bolt.id, quantity_per: 4 },
        { component_item_id: plate.id, quantity_per: 1 },
      ],
    })).body.data;
    expect(bom.id).toBeTruthy();
    await api(request, admin.token, 'post', `/api/manufacturing/boms/${bom.id}/activate`);

    // --- Create the work order through the UI --------------------------------
    await page.goto('/manufacturing/work-orders');
    await expect(page.locator('body')).toBeVisible();
    await page.getByRole('button', { name: 'New Work Order' }).click();
    const modal = page.getByRole('dialog').last();
    await expect(modal).toBeVisible();
    await modal.locator('select').selectOption({ value: fg.id });
    await modal.locator('input[type="number"]').fill('10');
    const [woCreate] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/manufacturing/work-orders') && r.request().method() === 'POST' && r.status() === 200
      ),
      modal.getByRole('button', { name: 'Create Work Order' }).click(),
    ]);
    const woBody = (await woCreate.json()).data;
    const workOrder = woBody?.id ? woBody : woBody.data;
    expect(workOrder.wo_number).toBeTruthy();
    expect(workOrder.status).toBe('DRAFT');
    expect(workOrder.components.length).toBe(2);

    // Row for our work order is visible on the page.
    const woRow = page.getByRole('row', { name: new RegExp(workOrder.wo_number) });
    await expect(woRow).toBeVisible({ timeout: 15000 });
    await expect(woRow).toContainText(/draft/i);

    // --- Release, issue materials, confirm production — all through the UI ----
    await woRow.getByTitle('Release').click();
    await expect(page.getByRole('row', { name: new RegExp(workOrder.wo_number) })).toContainText(/released/i, { timeout: 15000 });

    await woRow.getByTitle('Issue materials').click();
    await expect(page.getByRole('row', { name: new RegExp(workOrder.wo_number) })).toContainText(/in progress/i, { timeout: 15000 });

    await woRow.getByTitle('Confirm production').click();
    const confirmModal = page.getByRole('dialog').last();
    await expect(confirmModal).toBeVisible();
    await confirmModal.getByRole('button', { name: 'Confirm Production' }).click();
    await expect(page.getByRole('row', { name: new RegExp(workOrder.wo_number) })).toContainText(/completed/i, { timeout: 15000 });

    // --- Assertions on the data this journey created --------------------------
    const woAfter = (await api(request, admin.token, 'get', `/api/manufacturing/work-orders/${workOrder.id}`)).body.data;
    expect(woAfter.status).toBe('COMPLETED');
    expect(Number(woAfter.quantity_produced)).toBe(10);

    // Stock moved: 40 bolts and 10 plates left; 10 finished widgets arrived.
    const boltAfter = (await api(request, admin.token, 'get', `/api/inventory-items/${boltStock.id}`)).body.data;
    const plateAfter = (await api(request, admin.token, 'get', `/api/inventory-items/${plateStock.id}`)).body.data;
    expect(Number(boltAfter.current_stock_quantity)).toBeCloseTo(1000 - 40, 4);
    expect(Number(plateAfter.current_stock_quantity)).toBeCloseTo(1000 - 10, 4);

    const fgSearch = (await api(request, admin.token, 'get', `/api/inventory-items?search=${encodeURIComponent(fg.item_code)}`)).body.data;
    const fgInv = fgSearch.find((inv) => inv.item_master_id === fg.id);
    expect(fgInv, `finished goods ${fg.item_code} should have inventory stock`).toBeTruthy();
    expect(Number(fgInv.current_stock_quantity)).toBeCloseTo(10, 4);

    // GL entries exist for the issue and the completion, both balanced.
    const issueEntries = (await api(request, admin.token, 'get', '/api/journal-entries?source_type=WORK_ORDER_ISSUE&limit=100')).body.data;
    const issueEntry = issueEntries.find((e) => e.source_id === workOrder.id);
    expect(issueEntry, `WORK_ORDER_ISSUE journal entry for ${workOrder.wo_number}`).toBeTruthy();

    const completeEntries = (await api(request, admin.token, 'get', '/api/journal-entries?source_type=WORK_ORDER_COMPLETION&limit=100')).body.data;
    const completeEntry = completeEntries.find((e) => e.source_id === workOrder.id);
    expect(completeEntry, `WORK_ORDER_COMPLETION journal entry for ${workOrder.wo_number}`).toBeTruthy();
  });
});
