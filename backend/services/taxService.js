require('dotenv').config();
const calc = require('./financeCalc');
const { pool } = require('../config/database');

/**
 * Multi-jurisdiction tax engine, backed by the tax_jurisdictions/tax_codes
 * tables (migration 202608090300) rather than one flat DEFAULT_VAT_RATE for
 * every customer regardless of country.
 *
 * WHY A CACHE, NOT A QUERY PER CALL
 * ===========================================================================
 * resolveCustomerRate/resolveSupplierRate are called synchronously from
 * routes/sales-orders.js, routes/sales-quotations.js, models/CustomerInvoice.js
 * and models/Project.js — none of them await it today, and making that async
 * would mean auditing and changing every call site's control flow for a
 * feature whose whole point is transactional correctness. Tax rates are
 * reference data that changes on the order of "a government changes VAT
 * policy", not per-request, so an in-memory cache loaded once (loadTaxCodes,
 * called at server startup) and refreshed on demand (reloadTaxCodes) is the
 * right trade — same shape as i18n/index.js's LOCALES, loaded once and read
 * synchronously everywhere.
 *
 * Rate resolution order (unchanged plus one new step — see resolveVatRate in
 * financeCalc.js): explicit exemption -> export zero-rating -> the entity's
 * own explicit tax_rate -> jurisdiction lookup (NEW, via jurisdiction_code)
 * -> DEFAULT_VAT_RATE. An entity that already has tax_rate set keeps behaving
 * exactly as before; jurisdiction lookup only fires for one that doesn't.
 */

const round2 = calc.round2;

const getDefaultVatRate = () => {
  const r = Number(process.env.DEFAULT_VAT_RATE);
  return Number.isFinite(r) && r >= 0 ? r : 0;
};

// jurisdiction_code -> tax_type -> category -> { code, rate_percent, effective_from }
let cache = null;
let loadingPromise = null;

async function loadTaxCodes() {
  const { rows } = await pool.query(
    `SELECT code, jurisdiction_code, tax_type, category, rate_percent, effective_from
       FROM tax_codes
      WHERE is_active = true AND effective_from <= CURRENT_DATE
      ORDER BY effective_from ASC`
  );
  const next = {};
  for (const row of rows) {
    next[row.jurisdiction_code] ||= {};
    next[row.jurisdiction_code][row.tax_type] ||= {};
    // Rows are ordered oldest-first, so the last write per (jurisdiction,
    // type, category) is the most recent effective_from <= today — exactly
    // the rate in force now, the same "latest as-of" rule exchange_rates uses.
    next[row.jurisdiction_code][row.tax_type][row.category] = {
      code: row.code,
      rate_percent: Number(row.rate_percent),
      effective_from: row.effective_from,
    };
  }
  cache = next;
  return cache;
}

function reloadTaxCodes() {
  loadingPromise = loadTaxCodes();
  return loadingPromise;
}

// Fire-and-forget at require time so the common case (cache already warm by
// the time a request needs it) doesn't pay a query — callers that race the
// very first load just fall through resolveJurisdictionRate's null case to
// the existing default-rate behavior, never block or throw.
if (!loadingPromise) loadingPromise = loadTaxCodes().catch((err) => {
  console.error('taxService: initial tax code load failed:', err.message);
  cache = {};
});

/** Looks up the cached rate for a jurisdiction/type/category, or null if not loaded or not found. */
function resolveJurisdictionRate(jurisdictionCode, taxType, category = 'STANDARD') {
  if (!jurisdictionCode || !cache) return null;
  return cache[jurisdictionCode]?.[taxType]?.[category] || null;
}

/**
 * Resolve the VAT/GST/sales-tax rate (percent) for a customer or invoice
 * line. `entity.jurisdiction_code` (e.g. 'DE', 'US-CA') is optional — an
 * entity with none, or one this install hasn't seeded, falls through to the
 * pre-existing explicit-rate/default-rate behavior exactly as before.
 */
const resolveCustomerRate = (customer = {}) => {
  if (customer.tax_exempt) return 0;
  if ((customer.customer_type || '').toUpperCase() === 'EXPORT') return 0;
  if (Number.isFinite(Number(customer.tax_rate)) && Number(customer.tax_rate) > 0) return Number(customer.tax_rate);
  const jurisdiction = customer.jurisdiction_code || customer.tax_jurisdiction_code;
  const jurisdictionRow = cache?.[jurisdiction];
  const found = jurisdictionRow && (jurisdictionRow.VAT?.STANDARD || jurisdictionRow.GST?.STANDARD || jurisdictionRow.SALES_TAX?.STANDARD);
  if (found) return found.rate_percent;
  return calc.resolveVatRate(customer, getDefaultVatRate());
};

const resolveSupplierRate = (supplier = {}) => {
  if (supplier.tax_exempt) return 0;
  if ((supplier.customer_type || '').toUpperCase() === 'EXPORT') return 0;
  if (Number.isFinite(Number(supplier.tax_rate)) && Number(supplier.tax_rate) > 0) return Number(supplier.tax_rate);
  const jurisdiction = supplier.jurisdiction_code || supplier.tax_jurisdiction_code;
  const jurisdictionRow = cache?.[jurisdiction];
  const found = jurisdictionRow && (jurisdictionRow.VAT?.STANDARD || jurisdictionRow.GST?.STANDARD || jurisdictionRow.SALES_TAX?.STANDARD);
  if (found) return found.rate_percent;
  return calc.resolveVatRate(supplier, getDefaultVatRate());
};

const computeTax = (base, ratePercent) => calc.computeVat(base, ratePercent);

const applyTax = (subtotal, ratePercent) => calc.applyVat(subtotal, ratePercent);

/**
 * Withholding tax for a cross-border payment. Domestic (non-treaty) default
 * rate only — see migration 202608090300's header on why this is a starting
 * point to review, not an authority on the actual treaty-adjusted rate.
 * Returns null (not 0) when this install has no seeded rate for the
 * jurisdiction/paymentType pair, so a caller can tell "no WHT applies" apart
 * from "we don't know" rather than silently withholding nothing.
 */
const calculateWithholdingTax = (amount, jurisdictionCode, paymentType = 'SERVICES') => {
  const found = resolveJurisdictionRate(jurisdictionCode, 'WHT', String(paymentType).toUpperCase());
  if (!found) return null;
  const base = Number(amount) || 0;
  return {
    jurisdiction_code: jurisdictionCode,
    payment_type: paymentType,
    tax_code: found.code,
    rate_percent: found.rate_percent,
    withheld_amount: round2((base * found.rate_percent) / 100),
    net_payable: round2(base - (base * found.rate_percent) / 100),
  };
};

/**
 * Compute multi-jurisdiction tax breakdown for a list of document line items.
 * @param {Array} lineItems - Array of { subtotal, tax_code, is_exempt }
 * @param {Object} entity - Customer/Supplier object with jurisdiction & country
 * @returns {Object} { totalTax, netSubtotal, grossTotal, taxBreakdown }
 */
const calculateDocumentTax = (lineItems = [], entity = {}) => {
  const isExport = entity.is_export || (entity.country && entity.country !== 'LOCAL');
  const isReverseCharge = entity.is_eu_vat && entity.country !== 'LOCAL';

  let totalTax = 0;
  let netSubtotal = 0;
  const taxBreakdown = [];

  for (const item of lineItems) {
    const itemSubtotal = round2(Number(item.subtotal || item.total_price || (item.quantity * item.unit_price) || 0));
    netSubtotal += itemSubtotal;

    let rate = 0;
    let category = 'STANDARD';

    if (item.is_exempt || entity.tax_exempt) {
      rate = 0;
      category = 'EXEMPT';
    } else if (isExport) {
      rate = 0;
      category = 'ZERO_RATED_EXPORT';
    } else if (isReverseCharge) {
      rate = 0;
      category = 'REVERSE_CHARGE';
    } else if (item.tax_rate != null) {
      rate = Number(item.tax_rate);
    } else if (entity.tax_rate != null) {
      rate = Number(entity.tax_rate);
    } else {
      const jurisdiction = item.jurisdiction_code || entity.jurisdiction_code || entity.tax_jurisdiction_code;
      const jurisdictionRow = cache?.[jurisdiction];
      const found = jurisdictionRow && (jurisdictionRow.VAT?.STANDARD || jurisdictionRow.GST?.STANDARD || jurisdictionRow.SALES_TAX?.STANDARD);
      rate = found ? found.rate_percent : getDefaultVatRate();
    }

    const itemTax = round2((itemSubtotal * rate) / 100);
    totalTax += itemTax;

    taxBreakdown.push({
      description: item.description || 'Line Item',
      subtotal: itemSubtotal,
      rate,
      category,
      tax_amount: itemTax,
    });
  }

  const grossTotal = round2(netSubtotal + totalTax);

  return {
    net_subtotal: round2(netSubtotal),
    total_tax: round2(totalTax),
    gross_total: grossTotal,
    tax_breakdown: taxBreakdown,
  };
};

module.exports = {
  round2,
  getDefaultVatRate,
  resolveCustomerRate,
  resolveSupplierRate,
  resolveJurisdictionRate,
  computeTax,
  applyTax,
  calculateDocumentTax,
  calculateWithholdingTax,
  loadTaxCodes,
  reloadTaxCodes,
};
