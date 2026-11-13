/**
 * Pure finance calculations — no I/O, no database. This is the single source of
 * truth for the arithmetic used across tax, payroll, depreciation and aging, so
 * the same rules are testable in isolation and reused by the models.
 */

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// --- VAT / tax --------------------------------------------------------------

/** Tax amount for a base and rate (percent). */
const computeVat = (base, ratePercent) => {
  const b = Number(base) || 0;
  const r = Number(ratePercent) || 0;
  if (b <= 0 || r <= 0) return 0;
  return round2((b * r) / 100);
};

/** { rate, taxAmount, total } for a subtotal and rate (percent). */
const applyVat = (subtotal, ratePercent) => {
  const sub = Number(subtotal) || 0;
  const rate = Number(ratePercent) || 0;
  const taxAmount = computeVat(sub, rate);
  return { rate, taxAmount, total: round2(sub + taxAmount) };
};

/**
 * Resolve a customer/supplier VAT rate (percent).
 * Order: explicit exemption -> export zero-rating -> own rate -> default.
 */
const resolveVatRate = (entity = {}, defaultRate = 0) => {
  if (entity.tax_exempt) return 0;
  if ((entity.customer_type || '').toUpperCase() === 'EXPORT') return 0;
  const own = Number(entity.tax_rate);
  if (Number.isFinite(own) && own > 0) return own;
  const d = Number(defaultRate);
  return Number.isFinite(d) && d >= 0 ? d : 0;
};

// --- Payroll ----------------------------------------------------------------

/** Monthly gross from an annual base salary. */
const monthlyGross = (annualSalary) => round2((Number(annualSalary) || 0) / 12);

/** { gross, deductions, net } for one employee for a month. */
const payrollLine = (annualSalary, deductionRatePercent = 0) => {
  const gross = monthlyGross(annualSalary);
  const deductions = round2(gross * ((Number(deductionRatePercent) || 0) / 100));
  return { gross, deductions, net: round2(gross - deductions) };
};

// --- Depreciation -----------------------------------------------------------

/**
 * Straight-line depreciation for a number of months, capped so accumulated
 * never exceeds the depreciable base (cost - salvage).
 */
const straightLineMonthly = (cost, salvage, usefulLifeYears, accumulated = 0, months = 1) => {
  const base = round2((Number(cost) || 0) - (Number(salvage) || 0));
  const years = Number(usefulLifeYears) || 0;
  if (base <= 0 || years <= 0) return 0;
  const remaining = round2(base - (Number(accumulated) || 0));
  if (remaining <= 0) return 0;
  const perMonth = base / (years * 12);
  return round2(Math.min(perMonth * months, remaining));
};

/** Methods the asset register knows how to charge. */
const DEPRECIATION_METHODS = [
  'STRAIGHT_LINE',
  'DECLINING_BALANCE',
  'DOUBLE_DECLINING',
  'SUM_OF_YEARS_DIGITS',
];

/** Default acceleration factor per method — DOUBLE_DECLINING is 200% by name. */
const decliningFactorFor = (method, factor) => {
  const explicit = Number(factor);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return method === 'DOUBLE_DECLINING' ? 2 : 1.5;
};

/**
 * Declining-balance depreciation for a number of months.
 *
 * Three things separate this from straight-line, and getting any of them wrong
 * misstates the asset for the whole of its life:
 *
 *   1. The charge is a rate applied to the CURRENT net book value (cost less
 *      accumulated depreciation), not to the depreciable base. Salvage does not
 *      reduce what the rate is applied to — it only sets the floor the asset
 *      may not be written below.
 *
 *   2. Book value falls geometrically, so the method never reaches the floor on
 *      its own. Every asset would end its life still carrying a balance. The
 *      standard remedy, and what is implemented here, is to switch to
 *      straight-line over the REMAINING life once straight-line charges more —
 *      which is why `elapsedMonths` is a parameter rather than something that
 *      could be inferred from `accumulated`: after the switch the two no longer
 *      imply each other.
 *
 *   3. Each month compounds on the last, so a multi-month run is not one month
 *      scaled up. Months are charged one at a time.
 */
const decliningBalanceMonthly = (
  cost, salvage, usefulLifeYears, accumulated = 0, months = 1, factor = 1.5, elapsedMonths = 0
) => {
  const c = Number(cost) || 0;
  const s = Number(salvage) || 0;
  const years = Number(usefulLifeYears) || 0;
  const rate = Number(factor) || 0;
  if (c <= 0 || years <= 0 || rate <= 0) return 0;

  const lifeMonths = Math.round(years * 12);
  const monthlyRate = rate / lifeMonths;

  let acc = Number(accumulated) || 0;
  let elapsed = Math.max(0, Math.floor(Number(elapsedMonths) || 0));
  let charged = 0;

  for (let i = 0; i < Math.max(1, Math.floor(Number(months) || 1)); i += 1) {
    const bookValue = c - acc;
    const floor = round2(bookValue - s);
    if (floor <= 0) break;

    const declining = bookValue * monthlyRate;
    // Remaining life is never allowed to reach zero: an asset still on the
    // books past its useful life charges the rest off in the current month
    // rather than dividing by nothing.
    const remainingMonths = Math.max(1, lifeMonths - elapsed);
    const straightLine = floor / remainingMonths;

    const amount = Math.min(Math.max(declining, straightLine), floor);
    if (amount <= 0) break;

    charged += amount;
    acc += amount;
    elapsed += 1;
  }

  return round2(charged);
};

/**
 * Sum-of-years'-digits depreciation for a number of months.
 *
 * Accelerated like declining balance, but on the depreciable base and with a
 * defined endpoint — the weights sum to one, so the asset lands exactly on its
 * salvage value at the end of its life with no switch required.
 */
const sumOfYearsDigitsMonthly = (
  cost, salvage, usefulLifeYears, accumulated = 0, months = 1, elapsedMonths = 0
) => {
  const base = round2((Number(cost) || 0) - (Number(salvage) || 0));
  const years = Math.round(Number(usefulLifeYears) || 0);
  if (base <= 0 || years <= 0) return 0;

  const digits = (years * (years + 1)) / 2;
  let acc = Number(accumulated) || 0;
  let elapsed = Math.max(0, Math.floor(Number(elapsedMonths) || 0));
  let charged = 0;

  for (let i = 0; i < Math.max(1, Math.floor(Number(months) || 1)); i += 1) {
    const remaining = round2(base - acc);
    if (remaining <= 0) break;

    // Which year of the asset's life this month falls in. Past the useful
    // life the weight would go negative, so it is floored at the final year's.
    const yearIndex = Math.min(Math.floor(elapsed / 12) + 1, years);
    const weight = (years - yearIndex + 1) / digits;
    const amount = Math.min((base * weight) / 12, remaining);
    if (amount <= 0) break;

    charged += amount;
    acc += amount;
    elapsed += 1;
  }

  return round2(charged);
};

/**
 * One period's depreciation under whichever method the asset carries.
 *
 * The single entry point the asset register calls, so an unrecognised method is
 * rejected here rather than silently falling back to straight-line — a fallback
 * is how an asset set up as declining-balance depreciates on the wrong curve
 * for years without anyone being told.
 */
const depreciationForPeriod = ({
  method = 'STRAIGHT_LINE',
  cost,
  salvage = 0,
  usefulLifeYears,
  accumulated = 0,
  months = 1,
  elapsedMonths = 0,
  decliningFactor = null,
} = {}) => {
  const m = String(method || 'STRAIGHT_LINE').toUpperCase();

  switch (m) {
    case 'STRAIGHT_LINE':
      return straightLineMonthly(cost, salvage, usefulLifeYears, accumulated, months);
    case 'DECLINING_BALANCE':
    case 'DOUBLE_DECLINING':
      return decliningBalanceMonthly(
        cost, salvage, usefulLifeYears, accumulated, months,
        decliningFactorFor(m, decliningFactor), elapsedMonths
      );
    case 'SUM_OF_YEARS_DIGITS':
      return sumOfYearsDigitsMonthly(cost, salvage, usefulLifeYears, accumulated, months, elapsedMonths);
    default:
      throw new Error(
        `Unknown depreciation method "${method}". Supported: ${DEPRECIATION_METHODS.join(', ')}.`
      );
  }
};

/** Whole months between two dates, floored at zero. */
const monthsBetween = (from, to) => {
  const a = from instanceof Date ? from : new Date(from);
  const b = to instanceof Date ? to : new Date(to);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
  const months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  // A partial month does not count until the day of the month is reached.
  const adjusted = b.getDate() < a.getDate() ? months - 1 : months;
  return Math.max(0, adjusted);
};

// --- Aging ------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Classify an outstanding item by age relative to `asOf`.
 * Returns one of: current, 1-30, 31-60, 61-90, 90+.
 */
const agingBucket = (dueDate, asOf = new Date()) => {
  const due = dueDate instanceof Date ? dueDate : new Date(dueDate);
  const ref = asOf instanceof Date ? asOf : new Date(asOf);
  if (isNaN(due.getTime())) return 'current';
  const daysPast = Math.floor((ref.getTime() - due.getTime()) / DAY_MS);
  if (daysPast <= 0) return 'current';
  if (daysPast <= 30) return '1-30';
  if (daysPast <= 60) return '31-60';
  if (daysPast <= 90) return '61-90';
  return '90+';
};

module.exports = {
  round2,
  computeVat,
  applyVat,
  resolveVatRate,
  monthlyGross,
  payrollLine,
  straightLineMonthly,
  decliningBalanceMonthly,
  sumOfYearsDigitsMonthly,
  depreciationForPeriod,
  decliningFactorFor,
  monthsBetween,
  DEPRECIATION_METHODS,
  agingBucket,
};
