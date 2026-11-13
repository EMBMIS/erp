const { test } = require('node:test');
const assert = require('node:assert/strict');
const calc = require('../services/financeCalc');

test('round2 rounds to two decimals', () => {
  assert.equal(calc.round2(1.005), 1.01);
  assert.equal(calc.round2(2.334), 2.33);
  assert.equal(calc.round2(0), 0);
});

// --- VAT --------------------------------------------------------------------

test('computeVat computes tax and guards zero/negative', () => {
  assert.equal(calc.computeVat(100, 18), 18);
  assert.equal(calc.computeVat(200, 18), 36);
  assert.equal(calc.computeVat(100, 0), 0);
  assert.equal(calc.computeVat(0, 18), 0);
  assert.equal(calc.computeVat(-50, 18), 0);
});

test('applyVat returns rate, tax and gross total', () => {
  assert.deepEqual(calc.applyVat(200, 18), { rate: 18, taxAmount: 36, total: 236 });
  assert.deepEqual(calc.applyVat(0, 18), { rate: 18, taxAmount: 0, total: 0 });
});

test('resolveVatRate honors exemption, export, own rate and default', () => {
  assert.equal(calc.resolveVatRate({ tax_exempt: true }, 18), 0);
  assert.equal(calc.resolveVatRate({ customer_type: 'EXPORT' }, 18), 0);
  assert.equal(calc.resolveVatRate({ tax_rate: 5 }, 18), 5);
  assert.equal(calc.resolveVatRate({ customer_type: 'COMPANY' }, 18), 18);
  assert.equal(calc.resolveVatRate({}, 0), 0);
});

// --- Payroll ----------------------------------------------------------------

test('monthlyGross is annual / 12 rounded', () => {
  assert.equal(calc.monthlyGross(120000), 10000);
  assert.equal(calc.monthlyGross(100000), 8333.33);
  assert.equal(calc.monthlyGross(0), 0);
});

test('payrollLine computes gross, deductions and net', () => {
  assert.deepEqual(calc.payrollLine(120000, 10), { gross: 10000, deductions: 1000, net: 9000 });
  assert.deepEqual(calc.payrollLine(120000, 0), { gross: 10000, deductions: 0, net: 10000 });
});

// --- Depreciation -----------------------------------------------------------

test('straightLineMonthly depreciates evenly and caps at the base', () => {
  // (12000 - 0) / (1yr * 12) = 1000/month
  assert.equal(calc.straightLineMonthly(12000, 0, 1, 0, 1), 1000);
  // salvage reduces the depreciable base: (12000-1200)/12 = 900
  assert.equal(calc.straightLineMonthly(12000, 1200, 1, 0, 1), 900);
  // near the end it caps at the remaining amount
  assert.equal(calc.straightLineMonthly(12000, 0, 1, 11500, 1), 500);
  // fully depreciated -> 0
  assert.equal(calc.straightLineMonthly(12000, 0, 1, 12000, 1), 0);
  // guards
  assert.equal(calc.straightLineMonthly(0, 0, 5, 0, 1), 0);
  assert.equal(calc.straightLineMonthly(1000, 0, 0, 0, 1), 0);
});

test('decliningBalanceMonthly charges on book value, not the depreciable base', () => {
  // 10000 cost, 5 years, 200% -> monthly rate 2/60. First month: 10000 * 2/60.
  assert.equal(calc.decliningBalanceMonthly(10000, 1000, 5, 0, 1, 2, 0), 333.33);
  // Salvage does not reduce what the rate applies to — only the floor. Same
  // charge with no salvage at all, which is what separates this from
  // straight-line (where salvage would change the first month's figure).
  assert.equal(calc.decliningBalanceMonthly(10000, 0, 5, 0, 1, 2, 0), 333.33);
  // Second month compounds on the reduced book value: 9666.67 * 2/60.
  assert.equal(calc.decliningBalanceMonthly(10000, 1000, 5, 333.33, 1, 2, 1), 322.22);
  // A two-month run compounds rather than doubling the first month.
  assert.equal(calc.decliningBalanceMonthly(10000, 1000, 5, 0, 2, 2, 0), 655.56);
});

test('decliningBalanceMonthly never writes an asset below its salvage value', () => {
  // Book value 1010 against a 1000 floor: the rate alone would charge 33.67,
  // which would take the asset below salvage, so only the remaining 10 goes.
  assert.equal(calc.decliningBalanceMonthly(10000, 1000, 5, 8990, 1, 2, 50), 10);
  // At the floor exactly, nothing further is charged.
  assert.equal(calc.decliningBalanceMonthly(10000, 1000, 5, 9000, 1, 2, 55), 0);
  // And a multi-month run stops at the floor rather than running past it.
  assert.equal(calc.decliningBalanceMonthly(10000, 1000, 5, 8990, 6, 2, 50), 10);
});

test('decliningBalanceMonthly switches to straight-line so the asset finishes', () => {
  // Late in life, straight-line over the remaining months exceeds the
  // declining charge and takes over. Month 55 of 60: book value 2000, floor
  // 1000, 5 months left -> SL 200 beats DB 2000*2/60 = 66.67.
  assert.equal(calc.decliningBalanceMonthly(10000, 1000, 5, 8000, 1, 2, 55), 200);
  // Without the switch a geometric charge never reaches the floor. Running the
  // full life must land on the salvage value.
  let acc = 0;
  for (let m = 0; m < 60; m += 1) {
    acc = calc.round2(acc + calc.decliningBalanceMonthly(10000, 1000, 5, acc, 1, 2, m));
  }
  assert.equal(acc, 9000);              // cost 10000 - salvage 1000
});

test('decliningBalanceMonthly guards zero and negative inputs', () => {
  assert.equal(calc.decliningBalanceMonthly(0, 0, 5, 0, 1, 2, 0), 0);
  assert.equal(calc.decliningBalanceMonthly(1000, 0, 0, 0, 1, 2, 0), 0);
  assert.equal(calc.decliningBalanceMonthly(1000, 0, 5, 0, 1, 0, 0), 0);
});

test('decliningFactorFor defaults 200% for double declining, 150% otherwise', () => {
  assert.equal(calc.decliningFactorFor('DOUBLE_DECLINING', null), 2);
  assert.equal(calc.decliningFactorFor('DECLINING_BALANCE', null), 1.5);
  assert.equal(calc.decliningFactorFor('DECLINING_BALANCE', 1.75), 1.75);
  assert.equal(calc.decliningFactorFor('DECLINING_BALANCE', 0), 1.5);   // 0 is not a factor
});

test('sumOfYearsDigitsMonthly weights early years and lands on salvage', () => {
  // 5 years -> digits 15. Year 1 weight 5/15: 9000 * 5/15 / 12 = 250.
  assert.equal(calc.sumOfYearsDigitsMonthly(10000, 1000, 5, 0, 1, 0), 250);
  // Year 5 weight 1/15: 9000 * 1/15 / 12 = 50.
  assert.equal(calc.sumOfYearsDigitsMonthly(10000, 1000, 5, 0, 1, 48), 50);
  let acc = 0;
  for (let m = 0; m < 60; m += 1) {
    acc = calc.round2(acc + calc.sumOfYearsDigitsMonthly(10000, 1000, 5, acc, 1, m));
  }
  assert.equal(acc, 9000);
});

test('depreciationForPeriod dispatches on method and rejects unknown ones', () => {
  const base = { cost: 10000, salvage: 1000, usefulLifeYears: 5, accumulated: 0, months: 1, elapsedMonths: 0 };

  assert.equal(calc.depreciationForPeriod({ ...base, method: 'STRAIGHT_LINE' }), 150);
  assert.equal(calc.depreciationForPeriod({ ...base, method: 'DOUBLE_DECLINING' }), 333.33);
  assert.equal(calc.depreciationForPeriod({ ...base, method: 'DECLINING_BALANCE' }), 250);
  assert.equal(calc.depreciationForPeriod({ ...base, method: 'SUM_OF_YEARS_DIGITS' }), 250);
  // An explicit factor overrides the method default.
  assert.equal(calc.depreciationForPeriod({ ...base, method: 'DECLINING_BALANCE', decliningFactor: 2 }), 333.33);
  // Lower case is accepted; anything unrecognised throws rather than quietly
  // charging straight-line, which is the bug this replaced.
  assert.equal(calc.depreciationForPeriod({ ...base, method: 'straight_line' }), 150);
  assert.throws(() => calc.depreciationForPeriod({ ...base, method: 'MACRS' }), /Unknown depreciation method/);
});

test('monthsBetween counts whole elapsed months only', () => {
  assert.equal(calc.monthsBetween('2026-01-15', '2026-01-15'), 0);
  assert.equal(calc.monthsBetween('2026-01-15', '2026-02-14'), 0);   // a day short
  assert.equal(calc.monthsBetween('2026-01-15', '2026-02-15'), 1);
  assert.equal(calc.monthsBetween('2026-01-15', '2027-01-15'), 12);
  assert.equal(calc.monthsBetween('2026-06-01', '2026-01-01'), 0);   // never negative
  assert.equal(calc.monthsBetween('not a date', '2026-01-01'), 0);
});

// --- Aging ------------------------------------------------------------------

test('agingBucket classifies by days past due', () => {
  const asOf = new Date('2026-01-31');
  assert.equal(calc.agingBucket('2026-02-15', asOf), 'current'); // not due
  assert.equal(calc.agingBucket('2026-01-31', asOf), 'current'); // due today
  assert.equal(calc.agingBucket('2026-01-15', asOf), '1-30');
  assert.equal(calc.agingBucket('2025-12-15', asOf), '31-60');
  assert.equal(calc.agingBucket('2025-11-15', asOf), '61-90');
  assert.equal(calc.agingBucket('2025-09-01', asOf), '90+');
});
