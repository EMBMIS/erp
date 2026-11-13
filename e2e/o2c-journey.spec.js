// Order-to-Cash journey: customer -> quotation -> accepted -> sales order ->
// delivery schedule (delivered) -> customer invoice. The load-bearing
// assertion is the cross-module money handoff: the invoice total must equal
// the order total, and both must equal the quotation total.
//
// Everything is created with a run-specific suffix so reruns on a shared
// database never collide.

import { test, expect } from '@playwright/test';
import { seedAdminUser, loginViaUi, makeSuffix, api } from './helpers.mjs';

test.describe('Order-to-Cash (O2C) journey', () => {
  test('customer -> quotation -> sales order -> delivery -> invoice with matching totals', async ({ page, request }) => {
    const admin = await seedAdminUser(request);
    await loginViaUi(page, admin);

    const suffix = makeSuffix();
    const customerName = `E2E O2C Customer ${suffix}`;
    const itemName = `E2E O2C Widget ${suffix}`;
    const ref = `E2E-O2C-${suffix}`;

    // --- Seed a sellable inventory item (API = the same endpoint the UI uses) --
    const itemRes = await api(request, admin.token, 'post', '/api/items', {
      name: itemName,
      description: `E2E O2C journey item ${suffix}`,
      status: 'APPROVED',
      is_stock_item: true,
      unit_of_measure: 'PCS',
      item_category: 'E2E',
    });
    const item = itemRes.body.data;
    expect(item.item_code).toBeTruthy();
    const invItemRes = await api(request, admin.token, 'post', '/api/inventory-items', {
      item_master_id: item.id,
      unit_price: 75,
      currency: 'USD',
    });
    const invItem = invItemRes.body.data;
    expect(invItem.id, 'inventory record for the sellable item should exist').toBeTruthy();

    // --- 1. Create the customer through the UI -------------------------------
    await page.goto('/sales/customers/create');
    await page.fill('[data-testid="customer-name"]', customerName);
    await page.fill('#primary-email', `e2e.${suffix}@gmail.com`);
    // Wait for ANY create response (not just 201) so a backend failure shows
    // its status + body in the failure message instead of a bare timeout.
    let resolveCustomer;
    const customerPromise = new Promise((res) => { resolveCustomer = res; });
    await Promise.all([
      page.waitForResponse(
        (r) => {
          if (r.url().includes('/api/customers') && r.request().method() === 'POST') {
            r.json().then((b) => resolveCustomer({ status: r.status(), body: b }))
              .catch(() => resolveCustomer({ status: r.status(), body: null }));
            return true;
          }
          return false;
        }
      ),
      page.click('[data-testid="customer-submit"]'),
    ]);
    const customerResp = await customerPromise;
    expect(
      customerResp.status,
      `POST /api/customers -> ${customerResp.status} ${JSON.stringify(customerResp.body)}`
    ).toBe(201);
    await page.waitForURL(
      (url) => url.pathname.startsWith('/sales/customers') && !url.pathname.endsWith('/create'),
      { timeout: 15000 }
    );

    const customers = await api(request, admin.token, 'get', `/api/customers?search=${encodeURIComponent(customerName)}`);
    const customer = customers.body.data.find((c) => c.customer_name === customerName);
    expect(customer, `customer ${customerName} should exist via API`).toBeTruthy();
    expect(customer.status).toBe('ACTIVE');

    // --- 2. Create the quotation through the UI ------------------------------
    await page.goto('/sales/quotations/create');
    await page.selectOption('[data-testid="sq-customer"]', customer.id);
    await page.fill('[data-testid="sq-reference-number"]', ref);
    await page.fill('#payment-terms', '30');
    await page.fill('#estimated-delivery-days', '7');
    await page.selectOption('[data-testid="sq-item-0-inventory"]', invItem.id);
    await page.fill('[data-testid="sq-item-0-name"]', itemName);
    await page.fill('[data-testid="sq-item-0-quantity"]', '2');
    await page.fill('[data-testid="sq-item-0-unit-price"]', '75');
    await page.fill('[data-testid="sq-item-0-unit-price"]', '75.00');

    let resolveQuote;
    const quotePromise = new Promise((res) => { resolveQuote = res; });
    await Promise.all([
      page.waitForResponse(
        (r) => {
          if (r.url().includes('/api/sales-quotations') && r.request().method() === 'POST') {
            r.json().then((b) => resolveQuote({ status: r.status(), body: b }))
              .catch(() => resolveQuote({ status: r.status(), body: null }));
            return true;
          }
          return false;
        }
      ),
      page.click('[data-testid="sq-submit-draft"]'),
    ]);
    const quoteResp = await quotePromise;
    expect(quoteResp.status, 'POST quotation status ' + quoteResp.status).toBe(201);
    const quotation = quoteResp.body.data;
    expect(quotation.quotation_number).toBeTruthy();
    expect(Number(quotation.total_amount)).toBeGreaterThan(0);
    const quoteTotal = Number(quotation.total_amount);

    // --- 3. Accept the quotation, then convert to a sales order ---------------
    // (Same endpoint the quotation view's status control drives.)
    const accepted = await api(request, admin.token, 'put', `/api/sales-quotations/${quotation.id}/status`, {
      status: 'ACCEPTED',
      reason: `E2E acceptance ${suffix}`,
    });
    expect(accepted.body.data.status).toBe('ACCEPTED');

    await page.goto(`/sales/quotations/${quotation.id}`);
    await expect(page.getByRole('button', { name: 'Convert to Sales Order' })).toBeVisible({ timeout: 15000 });
    page.once('dialog', (d) => d.accept());
    const [convertResp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes(`/api/sales-quotations/${quotation.id}/convert-to-sales-order`) && r.request().method() === 'POST'
      ),
      page.getByRole('button', { name: 'Convert to Sales Order' }).click(),
    ]);
    const convertBody = (await convertResp.json()).data;
    const salesOrder = convertBody?.id ? convertBody : convertBody.data;
    expect(salesOrder.id).toBeTruthy();
    expect(salesOrder.so_number).toBeTruthy();
    expect(Number(salesOrder.total_amount)).toBeCloseTo(quoteTotal, 2);
    await page.waitForURL(`**/sales/sales-orders/${salesOrder.id}`);

    // --- 4. Confirm the order, schedule the delivery, deliver it --------------
    // Same endpoints the sales-order view status control and the delivery
    // scheduling screens drive.
    const confirmed = await api(request, admin.token, 'put', `/api/sales-orders/${salesOrder.id}/status`, {
      status: 'CONFIRMED',
      reason: `E2E confirm ${suffix}`,
    });
    expect(confirmed.body.data.status).toBe('CONFIRMED');

    const delivery = await api(request, admin.token, 'post', `/api/delivery-schedules/from-sales-order/${salesOrder.id}`);
    const schedule = delivery.body.data;
    expect(schedule.schedule_number).toBeTruthy();
    expect(schedule.sales_order_id).toBe(salesOrder.id);

    const delivered = await api(request, admin.token, 'put', `/api/delivery-schedules/${schedule.id}/status`, {
      status: 'DELIVERED',
      reason: `E2E delivery ${suffix}`,
    });
    expect(delivered.body.data.status).toBe('DELIVERED');

    // --- 5. The order completes and the invoice is generated ------------------
    const soAfter = await api(request, admin.token, 'get', `/api/sales-orders/${salesOrder.id}`);
    // Delivery moves the order to WAITING_CUSTOMER_DELIVERY_CONFIRMATION;
    // completion awaits the customer's delivery confirmation.
    expect(soAfter.body.data.status).toBe('WAITING_CUSTOMER_DELIVERY_CONFIRMATION');

    const invoices = await api(request, admin.token, 'get', '/api/customer-invoices?limit=100');
    const invoice = invoices.body.data.find((inv) => inv.sales_order_id === salesOrder.id);
    expect(invoice, `invoice for sales order ${salesOrder.so_number} should exist`).toBeTruthy();

    // The money handoff: invoice total == order total (== quotation total).
    expect(Number(invoice.total_amount)).toBeCloseTo(Number(salesOrder.total_amount), 2);
    expect(Number(invoice.subtotal)).toBeCloseTo(Number(salesOrder.subtotal), 2);

    // --- 6. The invoice is visible on the finance screen ----------------------
    await page.goto('/finance/customer-invoices');
    await expect(page.getByText(invoice.invoice_number, { exact: true })).toBeVisible({ timeout: 15000 });
  });
});
