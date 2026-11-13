/**
 * US federal payroll statutory withholding — federal income tax (IRS
 * Publication 15-T percentage method, Standard Withholding, Forms W-4 from
 * 2020 or later) plus FICA (Social Security + Medicare, employee and
 * employer portions).
 *
 * SCOPE: US federal only. State/local withholding is not calculated here —
 * every state has its own brackets (or no income tax at all), and seeding
 * that honestly means picking specific states the way tax_jurisdictions
 * (migration 202608090300) does for VAT/sales tax, not guessing at all 50.
 *
 * ACCURACY: bracket figures below are the 2024 tax year's published Pub
 * 15-T tables, to the best of what's encoded here — payroll tax brackets
 * change annually (usually announced each November for the following year).
 * Verify against the current year's actual IRS Publication 15-T before
 * relying on this for a real filing; treat FEDERAL_BRACKETS as needing a
 * yearly refresh, not a one-time constant.
 */

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const SS_WAGE_BASE = 168600; // 2024
const SS_RATE = 0.062;
const MEDICARE_RATE = 0.0145;
const ADDL_MEDICARE_RATE = 0.009; // employee-only; employer does not match this portion
const ADDL_MEDICARE_THRESHOLD = {
  SINGLE: 200000,
  HEAD_OF_HOUSEHOLD: 200000,
  MARRIED_JOINT: 250000,
};

// [annualIncomeAtOrAbove, rate, baseTaxAtThatThreshold] — 2024 IRS Pub 15-T
// Annual Percentage Method, Standard Withholding Rate Schedules.
const FEDERAL_BRACKETS = {
  SINGLE: [
    [0, 0.00, 0],
    [6000, 0.10, 0],
    [17600, 0.12, 1160.00],
    [53150, 0.22, 5426.00],
    [106525, 0.24, 17168.50],
    [197950, 0.32, 39110.50],
    [249450, 0.35, 55590.50],
    [615700, 0.37, 183647.75],
  ],
  MARRIED_JOINT: [
    [0, 0.00, 0],
    [12900, 0.10, 0],
    [35300, 0.12, 2240.00],
    [106300, 0.22, 10852.00],
    [213050, 0.24, 34337.00],
    [395900, 0.32, 78221.00],
    [498900, 0.35, 111357.00],
    [731200, 0.37, 192102.50],
  ],
  HEAD_OF_HOUSEHOLD: [
    [0, 0.00, 0],
    [10950, 0.10, 0],
    [28000, 0.12, 1705.00],
    [75850, 0.22, 7447.00],
    [113800, 0.24, 15798.00],
    [205250, 0.32, 37730.00],
    [256750, 0.35, 54210.00],
    [623000, 0.37, 182402.50],
  ],
};

function annualFederalTax(annualTaxableWages, filingStatus) {
  const brackets = FEDERAL_BRACKETS[filingStatus] || FEDERAL_BRACKETS.SINGLE;
  let bracket = brackets[0];
  for (const row of brackets) {
    if (annualTaxableWages >= row[0]) bracket = row;
    else break;
  }
  const [threshold, rate, baseTax] = bracket;
  return Math.max(0, baseTax + (annualTaxableWages - threshold) * rate);
}

/**
 * Federal income tax withholding for one pay period, via the IRS's
 * annualize-then-divide method: multiply this period's gross by the number
 * of periods in a year to estimate annual income, tax that at the bracket
 * rates, then divide back down to a per-period amount.
 */
function federalWithholding({ grossPay, payPeriodsPerYear = 12, filingStatus = 'SINGLE' }) {
  const periods = Number(payPeriodsPerYear) || 12;
  const annualized = (Number(grossPay) || 0) * periods;
  const annualTax = annualFederalTax(annualized, filingStatus);
  return round2(annualTax / periods);
}

/**
 * Social Security tax for this pay period — 6.2%, capped at the annual wage
 * base. `ytdWagesBeforeThisPeriod` is what makes the cap correct mid-year:
 * once an employee's cumulative wages this calendar year cross SS_WAGE_BASE,
 * no further SS tax is owed (by either side) for the rest of the year.
 * Returns the SAME dollar figure for employee and employer — both pay 6.2%
 * on the identical taxable base.
 */
function socialSecurityTax(wagesThisPeriod, ytdWagesBeforeThisPeriod = 0) {
  const remaining = Math.max(0, SS_WAGE_BASE - Number(ytdWagesBeforeThisPeriod));
  const taxable = Math.min(Number(wagesThisPeriod) || 0, remaining);
  const amount = round2(taxable * SS_RATE);
  return { employee: amount, employer: amount };
}

/**
 * Medicare tax for this pay period — 1.45% with no wage cap, plus an
 * additional 0.9% on wages above the filing-status threshold. The additional
 * 0.9% is withheld from the EMPLOYEE only; the employer never matches it.
 */
function medicareTax(wagesThisPeriod, ytdWagesBeforeThisPeriod = 0, filingStatus = 'SINGLE') {
  const wages = Number(wagesThisPeriod) || 0;
  const ytdBefore = Number(ytdWagesBeforeThisPeriod) || 0;
  const base = round2(wages * MEDICARE_RATE);

  const threshold = ADDL_MEDICARE_THRESHOLD[filingStatus] || ADDL_MEDICARE_THRESHOLD.SINGLE;
  const ytdAfter = ytdBefore + wages;
  let additional = 0;
  if (ytdAfter > threshold) {
    const subjectToAddl = Math.min(wages, ytdAfter - threshold);
    additional = round2(Math.max(0, subjectToAddl) * ADDL_MEDICARE_RATE);
  }
  return { employee: round2(base + additional), employer: base };
}

/**
 * Full statutory withholding breakdown for one employee, one pay period.
 * `ytdGrossBeforeThisPeriod` should be the sum of gross pay from every
 * EARLIER payroll run this calendar year — PayrollRun.createAndProcess
 * derives it from payroll_items rather than storing a separately-maintained
 * running total, so it can never drift from the run history.
 */
function calculatePayrollTax({ grossPay, payPeriodsPerYear = 12, filingStatus = 'SINGLE', ytdGrossBeforeThisPeriod = 0 }) {
  const gross = Number(grossPay) || 0;
  const federal = federalWithholding({ grossPay: gross, payPeriodsPerYear, filingStatus });
  const ss = socialSecurityTax(gross, ytdGrossBeforeThisPeriod);
  const medicare = medicareTax(gross, ytdGrossBeforeThisPeriod, filingStatus);

  const totalEmployeeWithholding = round2(federal + ss.employee + medicare.employee);

  return {
    gross_pay: gross,
    federal_income_tax: federal,
    social_security_employee: ss.employee,
    social_security_employer: ss.employer,
    medicare_employee: medicare.employee,
    medicare_employer: medicare.employer,
    total_employee_withholding: totalEmployeeWithholding,
    net_pay: round2(gross - totalEmployeeWithholding),
    employer_payroll_tax_cost: round2(ss.employer + medicare.employer),
  };
}

module.exports = {
  federalWithholding,
  socialSecurityTax,
  medicareTax,
  calculatePayrollTax,
  SS_WAGE_BASE,
  SS_RATE,
  MEDICARE_RATE,
};
