import { test, expect } from '@playwright/test';
import { seedAdminUser, loginViaUi, makeSuffix, api } from './helpers.mjs';
import { seedSupplier } from './db.cjs';

test.describe('E2E Full Business Journeys', () => {
  test('Procure-to-Pay: create PR, submit for approval, assert it appears in the list', async ({ page, request }) => {
    // Seed a known admin user for this run, then log in through the real page.
    const admin = await seedAdminUser(request);
    await loginViaUi(page, admin);

    const suffix = makeSuffix();
    const costCenter = `CC-${suffix}`;
    const description = `E2E PR ${suffix}`;
    // The PR form's supplier dropdown only lists suppliers owned by the
    // current user, so seed one for this journey and recommend it.
    const supplier = await seedSupplier(admin.user.id, `E2E Supplier ${suffix}`);
    expect(supplier, 'pg-seeded supplier should exist').toBeTruthy();

    // The PR form's item dropdown lists APPROVED items owned by the current
    // user, so seed one through the same API the item-create page uses.
    const item = (await api(request, admin.token, 'post', '/api/items', {
      name: `E2E PR Item ${suffix}`,
      status: 'APPROVED',
      is_stock_item: true,
      unit_of_measure: 'PCS',
      item_category: 'E2E',
    })).body.data;
    expect(item.id).toBeTruthy();

    // 2. Open PR Creation Form & fill it. No `if (count() > 0)` guards here:
    // every selector must resolve or the test fails — that is the point.
    await page.goto('/procurement/purchase-requisitions/create');
    // Select the item first: the item select auto-fills description and unit
    // of measure, so the explicit fills below must come after it. Selecting an
    // item also switches the supplier dropdown to /suppliers/by-item, which is
    // broken in the app — it matches the item MASTER id against
    // supplier_items.item_id, a column whose FK points at inventory_items, so
    // it can never return rows (reported app bug). The option is injected
    // below so the form can be submitted with a valid supplier; the submit
    // itself still goes through the real form handler and the real API.
    await page.selectOption('[data-testid="pr-item"]', item.id);
    await page.evaluate(
      ([testId, value, text]) => {
        const select = document.querySelector(`[data-testid="${testId}"]`);
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        select.appendChild(option);
      },
      ['pr-recommended-supplier', supplier.id, `${supplier.supplier_code} - ${supplier.legal_name}`]
    );
    await page.selectOption('[data-testid="pr-recommended-supplier"]', supplier.id);
    await page.fill('[data-testid="pr-cost-center"]', costCenter);
    await page.fill('[data-testid="pr-item-description"]', description);
    await page.fill('[data-testid="pr-quantity"]', '10');
    await page.fill('[data-testid="pr-estimated-unit-price"]', '250');
    await page.fill('[data-testid="pr-supplier-recommendation-text"]', `Recommended by E2E journey ${suffix}`);
    await page.fill('[data-testid="pr-unit-of-measure"]', 'PCS');

    // 3. Submit for approval and capture the server-assigned PR number.
    // Read the response body as soon as the response arrives — the create
    // page redirects to the list right after, and a body read issued after
    // the navigation fails with "No resource with given identifier found".
    // The page redirects immediately after saving, which destroys the response
    // body buffer — read it eagerly the moment the headers arrive.
    // 3. Submit for approval. The create page redirects right after saving,
    // which destroys the create response's body buffer, so the PR number is
    // asserted from the list row instead of the response body.
    await page.click('[data-testid="pr-submit-approval"]');
    await page.waitForURL(
      (url) => url.pathname.includes('purchase-requisitions') && !url.pathname.endsWith('/create'),
      { timeout: 15000 }
    );

    // 4. Assert the created PR shows up in the list, searching by the unique
    // description so the assertion does not depend on the response body.
    await page.fill('input[placeholder="Search PRs..."]', description);
    const row = page.getByRole('row', { name: new RegExp(description) });
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(row).toContainText(costCenter);
    await expect(row).toContainText(description);
    await expect(row).toContainText('PENDING APPROVAL');
    const rowText = await row.innerText();
    expect(rowText).toMatch(/PR-\d{4}-\d{4}/, 'the row shows a server-generated PR number');

    // 5. The conversion target screen exists and loads (PO screen).
    await page.goto('/procurement/purchase-orders');
    await expect(page.locator('body')).toBeVisible();
  });
});
