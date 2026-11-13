import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateLineTotal,
  calculateOrderTotals,
  convertCurrency,
  roundMoney,
  requiresApproval,
} from './calculations.js';

test('calculateLineTotal calculates correctly with discount', () => {
  const total = calculateLineTotal(10, 25, 5);
  assert.equal(total, 245);
});

test('calculateOrderTotals sums subtotal, applies tax and global discount', () => {
  const items = [
    { quantity: 2, unit_price: 100, discount_amount: 10 },
    { quantity: 5, unit_price: 20, discount_amount: 0 },
  ];
  // Subtotal = (2*100 - 10) + (5*20 - 0) = 190 + 100 = 290
  // Global discount = 10 -> taxable = 280
  // Tax 5% = 14
  // Total = 294
  const result = calculateOrderTotals(items, 5, 10);
  assert.equal(result.subtotal, 290);
  assert.equal(result.taxAmount, 14);
  assert.equal(result.totalAmount, 294);
});

describe('roundMoney — half-up to 2dp', () => {
  test('rounds the classic float traps up', () => {
    assert.equal(roundMoney(1.005), 1.01);
    assert.equal(roundMoney(2.675), 2.68);
    assert.equal(roundMoney(0.015), 0.02);
  });

  test('rounds ordinary values half-up', () => {
    assert.equal(roundMoney(123.456), 123.46);
    assert.equal(roundMoney(123.454), 123.45);
    assert.equal(roundMoney(0.0049), 0);
    assert.equal(roundMoney(10), 10);
    assert.equal(roundMoney(0.005), 0.01);
  });

  test('coerces strings and guards missing/NaN input', () => {
    assert.equal(roundMoney('19.99'), 19.99);
    assert.equal(roundMoney('1.005'), 1.01);
    assert.equal(roundMoney(undefined), 0);
    assert.equal(roundMoney(null), 0);
  });
});

describe('calculateLineTotal — line totals a user will act on', () => {
  test('plain quantity x price', () => {
    assert.equal(calculateLineTotal(3, 4.5), 13.5);
    assert.equal(calculateLineTotal(0, 100), 0);
  });

  test('flat amount discount', () => {
    assert.equal(calculateLineTotal(2, 100, 10), 190);
    assert.equal(calculateLineTotal(10, 25, 5), 245);
  });

  test('percentage discount', () => {
    // 10 x 25 = 250, 10% off -> 225
    assert.equal(calculateLineTotal(10, 25, 0, 10), 225);
    // 100% off -> zero
    assert.equal(calculateLineTotal(10, 25, 0, 100), 0);
    // percent then flat amount: 250 - 10% = 225 - 5 = 220
    assert.equal(calculateLineTotal(10, 25, 5, 10), 220);
  });

  test('never goes below zero', () => {
    assert.equal(calculateLineTotal(1, 10, 25), 0);
    assert.equal(calculateLineTotal(10, 25, 0, 150), 0);
    assert.equal(calculateLineTotal(-1, 100), 0);
  });

  test('rounds each line half-up so 200 lines cannot drift', () => {
    // The float trap: 1.005 * 200 = 200.99999999999997. If a line were not
    // rounded (or the sum were rounded once at the end) this becomes 201.00;
    // per-line half-up rounding makes it 202.00. Reconciliation depends on
    // the per-line rounding being the same every time.
    assert.equal(calculateLineTotal(1, 1.005), 1.01);
    assert.equal(calculateLineTotal(1, 1.004), 1.0);
  });

  test('coerces string inputs', () => {
    assert.equal(calculateLineTotal('2', '10.50'), 21);
    assert.equal(calculateLineTotal('2', '10.50', '1'), 20);
  });
});

describe('calculateOrderTotals — full pipeline', () => {
  test('subtotal -> line discounts -> global discount -> tax -> freight -> grand total', () => {
    const items = [
      { quantity: 1, unit_price: 200, discount_amount: 0, discount_percentage: 10 },
      { quantity: 2, unit_price: 50, discount_amount: 5 },
    ];
    // Line 1: 200 - 10% = 180 | Line 2: 100 - 5 = 95 | subtotal 275
    // Global discount 25 -> taxable 250 | tax 10% = 25 | freight 30
    // Total = 250 + 25 + 30 = 305
    const result = calculateOrderTotals(items, 10, 25, { freight: 30 });
    assert.equal(result.subtotal, 275);
    assert.equal(result.discountAmount, 25);
    assert.equal(result.taxableSubtotal, 250);
    assert.equal(result.taxAmount, 25);
    assert.equal(result.freightAmount, 30);
    assert.equal(result.totalAmount, 305);
    assert.equal(result.grandTotal, 305); // no FX -> grand total == total
    assert.equal(result.exchangeRate, 1);
  });

  test('line percentage discount feeds the subtotal', () => {
    const items = [
      { quantity: 1, unit_price: 100, discount_amount: 0, discount_percentage: 10 },
      { quantity: 1, unit_price: 50, discount_amount: 0, discount_percentage: 20 },
    ];
    const result = calculateOrderTotals(items);
    assert.equal(result.subtotal, 130); // 90 + 40
    assert.equal(result.totalAmount, 130);
  });

  test('tax-exclusive: tax is added on top', () => {
    const result = calculateOrderTotals([{ quantity: 1, unit_price: 200 }], 20);
    assert.equal(result.taxAmount, 40);
    assert.equal(result.totalAmount, 240);
  });

  test('tax-inclusive: tax is extracted, not added on top', () => {
    const result = calculateOrderTotals([{ quantity: 1, unit_price: 200 }], 20, 0, {
      taxInclusive: true,
    });
    // 200 - 200/1.2 = 33.333... -> 33.33
    assert.equal(result.taxAmount, 33.33);
    assert.equal(result.totalAmount, 200);
  });

  test('tax-inclusive with freight keeps freight on top of the inclusive total', () => {
    const result = calculateOrderTotals([{ quantity: 1, unit_price: 200 }], 20, 0, {
      taxInclusive: true,
      freight: 12.5,
    });
    assert.equal(result.taxAmount, 33.33);
    assert.equal(result.freightAmount, 12.5);
    assert.equal(result.totalAmount, 212.5);
  });

  test('global discount larger than the subtotal clamps to zero', () => {
    const result = calculateOrderTotals([{ quantity: 1, unit_price: 100 }], 10, 500);
    assert.equal(result.subtotal, 100);
    assert.equal(result.discountAmount, 500);
    assert.equal(result.taxableSubtotal, 0);
    assert.equal(result.taxAmount, 0);
    assert.equal(result.totalAmount, 0);
  });

  test('empty order is all zeros', () => {
    const result = calculateOrderTotals();
    assert.equal(result.subtotal, 0);
    assert.equal(result.taxAmount, 0);
    assert.equal(result.totalAmount, 0);
    assert.equal(result.grandTotal, 0);
  });

  test('negative tax rate is treated as no tax', () => {
    const result = calculateOrderTotals([{ quantity: 1, unit_price: 100 }], -5);
    assert.equal(result.taxAmount, 0);
    assert.equal(result.totalAmount, 100);
  });
});

describe('multi-currency — FX conversion with rounding at each step', () => {
  test('convertCurrency multiplies and rounds half-up', () => {
    assert.equal(convertCurrency(100, 0.85), 85);
    // 99.99 * 1.2345 = 123.437655 -> 123.44
    assert.equal(convertCurrency(99.99, 1.2345), 123.44);
    // rounding at the conversion step itself
    assert.equal(convertCurrency(123.455, 1), 123.46);
    assert.equal(convertCurrency(0, 1.5), 0);
  });

  test('missing or non-positive rate means no conversion', () => {
    assert.equal(convertCurrency(100, 0), 100);
    assert.equal(convertCurrency(100, -5), 100);
    assert.equal(convertCurrency(100, undefined), 100);
  });

  test('order totals convert the rounded total to a rounded grand total', () => {
    const result = calculateOrderTotals([{ quantity: 1, unit_price: 123.45 }], 5, 0, {
      freight: 10.25,
      exchangeRate: 0.85,
    });
    // Per-step transaction-currency values, rounded:
    assert.equal(result.subtotal, 123.45);
    assert.equal(result.taxAmount, 6.17); // 123.45 * 0.05 = 6.1725 -> 6.17
    assert.equal(result.freightAmount, 10.25);
    assert.equal(result.totalAmount, 139.87); // 123.45 + 6.17 + 10.25
    assert.equal(result.exchangeRate, 0.85);
    // Conversion happens on the rounded total, rounded again:
    // 139.87 * 0.85 = 118.8895 -> 118.89
    assert.equal(result.grandTotal, 118.89);
  });

  test('per-step base-currency values are each rounded independently', () => {
    const result = calculateOrderTotals([{ quantity: 1, unit_price: 123.45 }], 5, 0, {
      freight: 10.25,
      exchangeRate: 0.85,
    });
    const baseSubtotal = convertCurrency(result.subtotal, result.exchangeRate);
    const baseTax = convertCurrency(result.taxAmount, result.exchangeRate);
    const baseFreight = convertCurrency(result.freightAmount, result.exchangeRate);
    assert.equal(baseSubtotal, 104.93); // 123.45 * 0.85 = 104.9325
    assert.equal(baseTax, 5.24); // 6.17 * 0.85 = 5.2445
    assert.equal(baseFreight, 8.71); // 10.25 * 0.85 = 8.7125
    // Documented FX triangle: converting the parts and summing them can differ
    // by a cent from converting the total. The pipeline converts the total.
    assert.equal(baseSubtotal + baseTax + baseFreight, 118.88);
    assert.equal(result.grandTotal, 118.89);
  });
});

describe('rounding — a 0.01 drift across 200 lines is a reconciliation failure', () => {
  test('200 identical trap lines sum to 202.00, not the naive 201.00', () => {
    const items = Array.from({ length: 200 }, () => ({ quantity: 1, unit_price: 1.005 }));
    const result = calculateOrderTotals(items);
    // Naive raw sum: 200 * 1.005 = 200.99999999999997 -> 201.00. Half-up per
    // line: 200 * 1.01 = 202.00. The pipeline must never produce 201.00.
    assert.equal(result.subtotal, 202);
    assert.notEqual(result.subtotal, 201);
    assert.equal(result.totalAmount, 202);
    assert.equal(result.grandTotal, 202);
  });

  test('200 alternating trap lines: per-line rounding, then sum', () => {
    const items = Array.from({ length: 200 }, (_, i) => ({
      quantity: 1,
      unit_price: i % 2 === 0 ? 1.005 : 1.004,
    }));
    const result = calculateOrderTotals(items);
    // 100 * 1.01 + 100 * 1.00 = 201.00 (raw float sum would be 200.90)
    assert.equal(result.subtotal, 201);
    assert.equal(result.totalAmount, 201);
  });

  test('drift guard also holds with tax applied', () => {
    const items = Array.from({ length: 200 }, () => ({ quantity: 1, unit_price: 1.005 }));
    const result = calculateOrderTotals(items, 10);
    assert.equal(result.subtotal, 202);
    assert.equal(result.taxAmount, 20.2);
    assert.equal(result.totalAmount, 222.2);
  });
});

describe('approval threshold — exactly-at-threshold routes the same way every time', () => {
  test('exactly at the threshold REQUIRES approval (>=, never >)', () => {
    assert.equal(requiresApproval(1000, 1000), true);
    assert.equal(requiresApproval(50000, 50000), true);
    assert.equal(requiresApproval(9999.99, 10000), false);
    assert.equal(requiresApproval(10000.01, 10000), true);
  });

  test('the exact-at-threshold route is deterministic across repeated calls', () => {
    for (let i = 0; i < 200; i += 1) {
      assert.equal(requiresApproval(10000, 10000), true, `iteration ${i}`);
    }
    for (let i = 0; i < 200; i += 1) {
      assert.equal(requiresApproval(9999.99, 10000), false, `iteration ${i}`);
    }
  });

  test('forceApproval overrides a below-threshold total', () => {
    assert.equal(requiresApproval(100, 1000, { forceApproval: true }), true);
    assert.equal(requiresApproval(100, 1000, { forceApproval: false }), false);
  });

  test('no configured threshold means no approval gate', () => {
    assert.equal(requiresApproval(1000, undefined), false);
    assert.equal(requiresApproval(1000, null), false);
    assert.equal(requiresApproval(1000, 0), false);
  });

  test('thresholds and totals coerce from strings', () => {
    assert.equal(requiresApproval(1000, '1000'), true);
    assert.equal(requiresApproval('999.99', 1000), false);
    assert.equal(requiresApproval('10000', '10000'), true);
  });
});
