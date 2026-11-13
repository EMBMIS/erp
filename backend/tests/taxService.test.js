// Multi-jurisdiction tax engine (services/taxService.js) — the tax_codes-
// backed replacement for the single flat DEFAULT_VAT_RATE every customer used
// to get regardless of country (migration 202608090300).
//
// Run on its own: node --test tests/taxService.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const taxService = require('../services/taxService');
const { pool } = require('../config/database');

before(() => taxService.loadTaxCodes());
after(() => pool.end());

test('resolveCustomerRate looks up the standard rate for a seeded jurisdiction', () => {
  assert.equal(taxService.resolveCustomerRate({ jurisdiction_code: 'DE' }), 19);
  assert.equal(taxService.resolveCustomerRate({ jurisdiction_code: 'US-CA' }), 7.25);
  assert.equal(taxService.resolveCustomerRate({ jurisdiction_code: 'GB' }), 20);
});

test('an explicit tax_rate on the entity always wins over jurisdiction lookup', () => {
  assert.equal(taxService.resolveCustomerRate({ jurisdiction_code: 'DE', tax_rate: 2.5 }), 2.5);
});

test('tax_exempt and EXPORT customer_type both zero-rate regardless of jurisdiction', () => {
  assert.equal(taxService.resolveCustomerRate({ jurisdiction_code: 'DE', tax_exempt: true }), 0);
  assert.equal(taxService.resolveCustomerRate({ jurisdiction_code: 'DE', customer_type: 'export' }), 0);
});

test('an unseeded jurisdiction falls back to DEFAULT_VAT_RATE rather than throwing', () => {
  const rate = taxService.resolveCustomerRate({ jurisdiction_code: 'ZZ-NOWHERE' });
  assert.equal(rate, taxService.getDefaultVatRate());
});

test('resolveSupplierRate mirrors resolveCustomerRate for the supplier side', () => {
  assert.equal(taxService.resolveSupplierRate({ jurisdiction_code: 'FR' }), 20);
});

test('calculateWithholdingTax returns a real rate, amount and net for a seeded jurisdiction/payment type', () => {
  const result = taxService.calculateWithholdingTax(10000, 'IN', 'SERVICES');
  assert.ok(result);
  assert.equal(result.rate_percent, 10);
  assert.equal(result.withheld_amount, 1000);
  assert.equal(result.net_payable, 9000);
});

test('calculateWithholdingTax returns null (not zero) when this install has no rate for the pair', () => {
  assert.equal(taxService.calculateWithholdingTax(10000, 'ZZ-NOWHERE', 'SERVICES'), null);
  assert.equal(taxService.calculateWithholdingTax(10000, 'DE', 'ROYALTIES'), null, 'DE only seeds SERVICES/DIVIDENDS WHT');
});

test('calculateDocumentTax resolves each line to the entity jurisdiction\'s standard rate', () => {
  const result = taxService.calculateDocumentTax(
    [{ description: 'Widget', subtotal: 1000 }, { description: 'Gadget', subtotal: 500 }],
    { jurisdiction_code: 'DE' }
  );
  assert.equal(result.net_subtotal, 1500);
  assert.equal(result.total_tax, 285); // 19% of 1500
  assert.equal(result.gross_total, 1785);
  assert.ok(result.tax_breakdown.every((line) => line.rate === 19));
});

test('calculateDocumentTax still zero-rates an exempt line regardless of jurisdiction', () => {
  const result = taxService.calculateDocumentTax(
    [{ description: 'Exempt item', subtotal: 100, is_exempt: true }],
    { jurisdiction_code: 'DE' }
  );
  assert.equal(result.total_tax, 0);
  assert.equal(result.tax_breakdown[0].category, 'EXEMPT');
});

test('reloadTaxCodes picks up a newly inserted rate without a process restart', async () => {
  await pool.query(
    `INSERT INTO tax_jurisdictions (code, name, country_code, tax_system) VALUES ('ZZ-TEST', 'Test Jurisdiction', 'ZZ', 'VAT')
     ON CONFLICT (code) DO NOTHING`
  );
  await pool.query(
    `INSERT INTO tax_codes (code, jurisdiction_code, name, tax_type, category, rate_percent)
     VALUES ('ZZ-TEST-VAT-STD', 'ZZ-TEST', 'Test standard rate', 'VAT', 'STANDARD', 33.0)
     ON CONFLICT (code) DO UPDATE SET rate_percent = EXCLUDED.rate_percent`
  );
  try {
    await taxService.reloadTaxCodes();
    assert.equal(taxService.resolveCustomerRate({ jurisdiction_code: 'ZZ-TEST' }), 33);
  } finally {
    await pool.query('DELETE FROM tax_codes WHERE code = $1', ['ZZ-TEST-VAT-STD']);
    await pool.query('DELETE FROM tax_jurisdictions WHERE code = $1', ['ZZ-TEST']);
    await taxService.reloadTaxCodes();
  }
});
