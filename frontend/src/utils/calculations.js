/**
 * Line item calculation helpers for Sales Orders, Invoices, and Purchase Orders.
 *
 * Money conventions used across this module (and locked down by
 * calculations.test.js):
 * - every number a user will act on is rounded half-up to 2 decimal places;
 * - rounding happens at EACH step (line, tax, freight, total, FX) so a
 *   0.01 reconciliation drift cannot accumulate silently;
 * - negative money clamps to 0 for totals.
 */

/**
 * Round half-up to 2 decimal places. Number.EPSILON guards the classic
 * float trap (1.005 * 100 === 100.49999999999999) so 1.005 -> 1.01.
 */
export function roundMoney(amount) {
  const n = Number(amount) || 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Line total with an optional flat discount and/or a percentage discount.
 * The percentage discount is applied to the gross (qty * price) first, then
 * the flat amount discount; the result never goes below 0 and is rounded
 * half-up to 2dp.
 */
export function calculateLineTotal(quantity, unitPrice, discountAmount = 0, discountPercent = 0) {
  const qty = Number(quantity) || 0;
  const price = Number(unitPrice) || 0;
  const disc = Number(discountAmount) || 0;
  const pct = Number(discountPercent) || 0;
  const gross = qty * price;
  const afterPercent = gross * (1 - pct / 100);
  return roundMoney(Math.max(0, afterPercent - disc));
}

/**
 * Convert an amount at an exchange rate, rounding the result half-up to 2dp.
 * A missing or non-positive rate is treated as 1 (no conversion).
 */
export function convertCurrency(amount, exchangeRate) {
  const n = Number(amount) || 0;
  const rate = Number(exchangeRate) > 0 ? Number(exchangeRate) : 1;
  return roundMoney(n * rate);
}

/**
 * Order totals pipeline:
 *   subtotal (Σ line totals, line discounts already applied)
 *   → global discount → taxable subtotal
 *   → tax (exclusive: rate on taxable subtotal; inclusive: extracted from it)
 *   → freight → total (transaction currency) → grand total (base currency).
 *
 * `options`:
 *   freight       {number} freight/shipping charge added after tax (default 0)
 *   taxInclusive  {boolean} true when prices already include tax (default false)
 *   exchangeRate  {number} FX rate to the reporting/base currency (default 1)
 *
 * Every field is rounded half-up to 2dp; when an exchange rate is given the
 * conversion is applied to the rounded transaction-currency value and rounded
 * again, so each step stays exact to the cent.
 */
export function calculateOrderTotals(lineItems = [], taxRate = 0, globalDiscount = 0, options = {}) {
  const { freight = 0, taxInclusive = false, exchangeRate = 1 } = options || {};

  const subtotal = lineItems.reduce((acc, item) => {
    return acc + calculateLineTotal(item.quantity, item.unit_price, item.discount_amount, item.discount_percentage);
  }, 0);

  const discount = Number(globalDiscount) || 0;
  const taxableSubtotal = Math.max(0, subtotal - discount);
  const rate = Math.max(0, Number(taxRate) || 0);

  let taxAmount;
  let totalAmount;
  if (taxInclusive) {
    // Prices already contain the tax: extract it for reporting, and do not
    // add it on top of the total.
    taxAmount = rate > 0 ? taxableSubtotal - taxableSubtotal / (1 + rate / 100) : 0;
    totalAmount = taxableSubtotal + (Number(freight) || 0);
  } else {
    taxAmount = (taxableSubtotal * rate) / 100;
    totalAmount = taxableSubtotal + taxAmount + (Number(freight) || 0);
  }

  const fxRate = Number(exchangeRate) > 0 ? Number(exchangeRate) : 1;
  const toBase = (v) => roundMoney(v * fxRate);

  const rounded = {
    subtotal: roundMoney(subtotal),
    discountAmount: roundMoney(discount),
    taxableSubtotal: roundMoney(taxableSubtotal),
    taxAmount: roundMoney(taxAmount),
    freightAmount: roundMoney(Number(freight) || 0),
    totalAmount: roundMoney(totalAmount),
  };

  return {
    ...rounded,
    grandTotal: toBase(rounded.totalAmount),
    exchangeRate: fxRate,
  };
}

/**
 * Approval gate matching the backend contract (backend/middleware/approval.js:
 * `if (!threshold) return false;` then
 * `totalValue >= threshold || Boolean(additionalCriteria.forceApproval)`).
 * Exactly-at-threshold MUST require approval every time; the boundary is
 * `>=`, never `>`. A missing/zero threshold means no approval gate.
 */
export function requiresApproval(totalValue, threshold, { forceApproval = false } = {}) {
  const limit = Number(threshold);
  if (!limit) return false; // no threshold configured -> no approval gate
  const total = Number(totalValue) || 0;
  return total >= limit || Boolean(forceApproval);
}
