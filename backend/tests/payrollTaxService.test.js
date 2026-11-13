// Real US federal payroll withholding (services/payrollTaxService.js) —
// replaces PayrollRun.createAndProcess's flat "deduction_rate% of gross"
// with actual federal income tax (IRS Pub 15-T percentage method) and FICA
// (Social Security + Medicare, both halves).
//
// Run on its own: node --test tests/payrollTaxService.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const payrollTax = require('../services/payrollTaxService');

test('federalWithholding taxes nothing below the zero-rate bracket', () => {
  // $5,000/month = $60,000/year annualized is still inside SINGLE's 12%
  // bracket well above zero, so use a genuinely tiny monthly wage instead.
  const tax = payrollTax.federalWithholding({ grossPay: 400, payPeriodsPerYear: 12, filingStatus: 'SINGLE' });
  // $400 * 12 = $4,800/year, below the $6,000 zero-rate threshold.
  assert.equal(tax, 0);
});

test('federalWithholding taxes progressively higher for higher earners', () => {
  const low = payrollTax.federalWithholding({ grossPay: 3000, payPeriodsPerYear: 12, filingStatus: 'SINGLE' });
  const high = payrollTax.federalWithholding({ grossPay: 15000, payPeriodsPerYear: 12, filingStatus: 'SINGLE' });
  assert.ok(high > low * 3, 'a 5x higher salary should owe more than 5x the tax (progressive brackets)');
});

test('federalWithholding differs by filing status for the same income', () => {
  const single = payrollTax.federalWithholding({ grossPay: 8000, payPeriodsPerYear: 12, filingStatus: 'SINGLE' });
  const marriedJoint = payrollTax.federalWithholding({ grossPay: 8000, payPeriodsPerYear: 12, filingStatus: 'MARRIED_JOINT' });
  assert.ok(marriedJoint < single, 'married filing jointly has wider brackets, so withholding should be lower for the same gross');
});

test('socialSecurityTax is 6.2% for both employee and employer, identical amounts', () => {
  const ss = payrollTax.socialSecurityTax(5000, 0);
  assert.equal(ss.employee, 310); // 6.2% of 5000
  assert.equal(ss.employer, ss.employee);
});

test('socialSecurityTax stops once YTD wages cross the annual wage base', () => {
  // Already at the wage base before this period — no further SS tax owed.
  const ss = payrollTax.socialSecurityTax(5000, payrollTax.SS_WAGE_BASE);
  assert.equal(ss.employee, 0);
  assert.equal(ss.employer, 0);
});

test('socialSecurityTax partially caps when this period straddles the wage base', () => {
  const ytdBefore = payrollTax.SS_WAGE_BASE - 1000; // 1000 of headroom left
  const ss = payrollTax.socialSecurityTax(5000, ytdBefore);
  assert.equal(ss.employee, 62); // 6.2% of the 1000 that's still taxable, not the full 5000
});

test('medicareTax is 1.45% flat with no cap for ordinary wages', () => {
  const m = payrollTax.medicareTax(10000, 0, 'SINGLE');
  assert.equal(m.employee, 145);
  assert.equal(m.employer, 145); // no additional 0.9% yet, so both sides match
});

test('medicareTax adds the employee-only 0.9% once YTD wages cross the threshold', () => {
  // Already over the $200k SINGLE threshold before this period.
  const m = payrollTax.medicareTax(10000, 200000, 'SINGLE');
  assert.equal(m.employer, 145, 'employer never matches the additional 0.9%');
  assert.equal(m.employee, 145 + 90, 'employee pays 1.45% + 0.9% once over the threshold');
});

test('medicareTax additional threshold is higher for MARRIED_JOINT', () => {
  const overSingleThreshold = payrollTax.medicareTax(10000, 200000, 'MARRIED_JOINT');
  assert.equal(overSingleThreshold.employee, 145, 'MFJ threshold is $250k, so $200k YTD owes no additional Medicare yet');
});

test('calculatePayrollTax returns a coherent breakdown that reconciles to net pay', () => {
  const result = payrollTax.calculatePayrollTax({
    grossPay: 6000,
    payPeriodsPerYear: 12,
    filingStatus: 'SINGLE',
    ytdGrossBeforeThisPeriod: 0,
  });
  assert.equal(result.gross_pay, 6000);
  assert.equal(
    result.total_employee_withholding,
    Math.round((result.federal_income_tax + result.social_security_employee + result.medicare_employee + Number.EPSILON) * 100) / 100
  );
  assert.equal(result.net_pay, Math.round((result.gross_pay - result.total_employee_withholding + Number.EPSILON) * 100) / 100);
  assert.ok(result.employer_payroll_tax_cost > 0, 'employer FICA match must be a real, non-zero reported cost');
  assert.equal(result.social_security_employer, result.social_security_employee);
});

test('calculatePayrollTax: employer cost never includes the employee-only additional Medicare surtax', () => {
  const result = payrollTax.calculatePayrollTax({
    grossPay: 10000,
    payPeriodsPerYear: 12,
    filingStatus: 'SINGLE',
    ytdGrossBeforeThisPeriod: 200000,
  });
  assert.ok(result.medicare_employee > result.medicare_employer, 'employee owes the extra 0.9%, employer does not');
});
