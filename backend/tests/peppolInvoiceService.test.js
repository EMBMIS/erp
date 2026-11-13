// Peppol BIS Billing 3.0 e-invoice export (services/peppolInvoiceService.js).
// Real DB round-trip: seeds a company (with seller tax data), a customer
// (with buyer tax data) and an invoice with a line item, then generates and
// checks the actual UBL XML — not a mock of what it should look like.
//
// Run on its own: node --test tests/peppolInvoiceService.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { pool } = require('../config/database');
const companyContext = require('../services/companyContext');
const { Companies } = require('../models/Company');
const { generateInvoiceXml, validateForExport, loadInvoiceData } = require('../services/peppolInvoiceService');

let dbAvailable = false;
let userId = null;
let company = null;
let custId = null;
let invId = null;
let bareCustId = null;
let bareInvId = null;

before(async () => {
  try {
    await pool.query('SELECT 1');
    const { rows } = await pool.query('SELECT id FROM users LIMIT 1');
    if (!rows.length) throw new Error('no users');
    userId = rows[0].id;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }

  const suffix = Date.now().toString().slice(-6);
  company = await Companies.create({
    company_code: `PPT${suffix}`,
    name: 'Peppol Test GmbH',
    legal_name: 'Peppol Test GmbH',
    base_currency: 'EUR',
    tax_number: 'DE123456789',
    address_line1: 'Teststrasse 1',
    city: 'Berlin',
    country_code: 'DE',
  }, userId);

  await companyContext.runWithCompany(company.id, async () => {
    const cust = await pool.query(
      `INSERT INTO customers (customer_code, customer_name, vat_number, billing_address_line1, billing_city, billing_country, status, created_by)
       VALUES ($1,'Acme Buyer SA','FR98765432100','1 Rue de Paris','Paris','FR','ACTIVE',$2) RETURNING id`,
      [`AC${suffix}`, userId]
    );
    custId = cust.rows[0].id;

    const inv = await pool.query(
      `INSERT INTO customer_invoices (invoice_number, customer_id, invoice_date, due_date, currency, subtotal, tax_amount, discount_amount, total_amount, status, created_by)
       VALUES ($1,$2,CURRENT_DATE,CURRENT_DATE+30,'EUR',1000,190,0,1190,'SENT',$3) RETURNING id`,
      [`PP-${suffix}`, custId, userId]
    );
    invId = inv.rows[0].id;

    await pool.query(
      `INSERT INTO customer_invoice_items (invoice_id, line_number, item_description, quantity, unit_of_measure, unit_price, line_total, tax_rate, tax_amount)
       VALUES ($1,1,'Consulting services',10,'HUR',100,1000,0.19,190)`,
      [invId]
    );

    // A customer/invoice with none of the required Peppol fields, to prove
    // validateForExport actually catches missing data rather than emitting
    // a document silently missing mandatory party info.
    const bareCust = await pool.query(
      `INSERT INTO customers (customer_code, customer_name, status, created_by) VALUES ($1,'Bare Customer','ACTIVE',$2) RETURNING id`,
      [`BC${suffix}`, userId]
    );
    bareCustId = bareCust.rows[0].id;
    const bareInv = await pool.query(
      `INSERT INTO customer_invoices (invoice_number, customer_id, invoice_date, due_date, subtotal, tax_amount, total_amount, status, created_by)
       VALUES ($1,$2,CURRENT_DATE,CURRENT_DATE+30,100,0,100,'DRAFT',$3) RETURNING id`,
      [`PPB-${suffix}`, bareCustId, userId]
    );
    bareInvId = bareInv.rows[0].id;
  });
});

after(async () => {
  if (dbAvailable && company) {
    await companyContext.runWithCompany(company.id, async () => {
      await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id = ANY($1::uuid[])', [[invId, bareInvId].filter(Boolean)]);
      await pool.query('DELETE FROM customer_invoices WHERE id = ANY($1::uuid[])', [[invId, bareInvId].filter(Boolean)]);
      await pool.query('DELETE FROM customers WHERE id = ANY($1::uuid[])', [[custId, bareCustId].filter(Boolean)]);
    });
    await pool.query('DELETE FROM user_companies WHERE company_id = $1', [company.id]);
    await pool.query('DELETE FROM company_modules WHERE company_id = $1', [company.id]);
    await pool.query('DELETE FROM company_subscriptions WHERE company_id = $1', [company.id]);
    await pool.query('DELETE FROM agent_definitions WHERE company_id = $1', [company.id]);
    await pool.query('DELETE FROM companies WHERE id = $1', [company.id]);
  }
  await pool.end();
});

test('generateInvoiceXml produces well-formed XML with the right root and namespaces', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const xml = await companyContext.runWithCompany(company.id, () => generateInvoiceXml(invId));
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"/);
  assert.match(xml, /<cbc:CustomizationID>urn:cen\.eu:en16931:2017#compliant#urn:fdc:peppol\.eu:2017:poacc:billing:3\.0<\/cbc:CustomizationID>/);
  // Balanced tags is the cheapest real well-formedness signal without pulling
  // in an XML parser dependency for one test file.
  const opens = (xml.match(/<[a-zA-Z][^/>]*[^/]>/g) || []).length;
  const closes = (xml.match(/<\/[a-zA-Z][^>]*>/g) || []).length;
  const selfClosing = (xml.match(/<[a-zA-Z][^>]*\/>/g) || []).length;
  assert.equal(opens - selfClosing, closes, 'every opening tag must have a matching closing tag');
});

test('generateInvoiceXml carries the real seller, buyer and monetary data through', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const xml = await companyContext.runWithCompany(company.id, () => generateInvoiceXml(invId));
  assert.match(xml, /<cbc:EndpointID schemeID="9915">DE123456789<\/cbc:EndpointID>/, 'seller VAT number');
  assert.match(xml, /<cbc:EndpointID schemeID="9915">FR98765432100<\/cbc:EndpointID>/, 'buyer VAT number');
  assert.match(xml, /<cbc:PayableAmount currencyID="EUR">1190\.00<\/cbc:PayableAmount>/);
  assert.match(xml, /<cbc:TaxAmount currencyID="EUR">190\.00<\/cbc:TaxAmount>/);
  assert.match(xml, /<cbc:Name>Consulting services<\/cbc:Name>/);
});

test('validateForExport lists every missing required field rather than failing on the first', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const data = await companyContext.runWithCompany(company.id, () => loadInvoiceData(bareInvId));
  const problems = validateForExport(data);
  assert.ok(problems.some((p) => p.includes('vat_number')), 'missing buyer VAT should be reported');
  assert.ok(problems.some((p) => p.includes('billing address')), 'missing buyer address should be reported');
  assert.ok(problems.some((p) => p.includes('no line items')), 'missing line items should be reported');
  assert.ok(problems.some((p) => p.includes('DRAFT')), 'a still-draft invoice should be flagged, not exported as if issued');
});

test('generateInvoiceXml throws with the validation problem list attached, rather than emitting an incomplete document', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  await assert.rejects(
    () => companyContext.runWithCompany(company.id, () => generateInvoiceXml(bareInvId)),
    (err) => {
      assert.ok(Array.isArray(err.validationProblems) && err.validationProblems.length > 0);
      return true;
    }
  );
});

test('generateInvoiceXml rejects an unknown invoice id cleanly', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  await assert.rejects(
    () => companyContext.runWithCompany(company.id, () => generateInvoiceXml('00000000-0000-0000-0000-000000000000')),
    /Invoice not found/
  );
});
