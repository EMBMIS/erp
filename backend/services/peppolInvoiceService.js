/**
 * Peppol BIS Billing 3.0 e-invoice export.
 *
 * Generates a UBL 2.1 Invoice XML document from a posted customer invoice —
 * the format Peppol network access points actually transmit, and the
 * required B2G e-invoicing format across most of the EU (and a growing list
 * of countries elsewhere). This is a REPORT/EXPORT capability: it produces a
 * standards-conformant document a real Peppol Access Point can transmit, but
 * this service does not itself connect to a Peppol Access Point or the
 * network — actually sending requires a contracted AP provider, which is an
 * operational/commercial relationship, not something to fake a connection to.
 *
 * SCOPE: covers UBL 2.1 / Peppol BIS Billing 3.0's mandatory fields for a
 * standard commercial invoice (type code 380) with line-level VAT. It does
 * not cover credit notes, self-billing, or country-specific CIUS extensions
 * (e.g. France's Factur-X, Italy's FatturaPA) — those are real, separate
 * formats layered on top of the base standard, not this one file's job.
 */

const { pool } = require('../config/database');

// Peppol requires an ISO 6523 scheme identifier prefixing the actual
// registration number in EndpointID/CompanyID (e.g. "0088" = GLN, "9915" =
// generic EU VAT scheme used here since we only reliably have a VAT/tax
// number, not a verified GLN). See the Peppol eDEC Code Lists.
const GENERIC_VAT_SCHEME = '9915';

const UBL_UNIT_CODE_FALLBACK = 'C62'; // UN/ECE Rec 20: "one" / piece, used when no unit is recorded

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function fmtAmount(n) {
  return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
}

function fmtQty(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? v.toFixed(0) : String(v);
}

async function loadInvoiceData(invoiceId) {
  const { rows: invRows } = await pool.query(
    `SELECT ci.*, c.customer_code, c.customer_name, c.legal_entity_name, c.vat_number, c.tax_number,
            c.billing_address_line1, c.billing_address_line2, c.billing_city, c.billing_state,
            c.billing_country, c.billing_postal_code, c.primary_email
       FROM customer_invoices ci
       JOIN customers c ON c.id = ci.customer_id
      WHERE ci.id = $1 AND ci.deleted_at IS NULL`,
    [invoiceId]
  );
  if (!invRows.length) return null;
  const invoice = invRows[0];

  const { rows: items } = await pool.query(
    `SELECT * FROM customer_invoice_items WHERE invoice_id = $1 ORDER BY line_number`,
    [invoiceId]
  );

  const { rows: companyRows } = await pool.query(
    `SELECT name, legal_name, tax_number, registration_number, address_line1, address_line2,
            city, state, postal_code, country_code, base_currency
       FROM companies WHERE id = $1`,
    [invoice.company_id]
  );
  const company = companyRows[0] || null;

  return { invoice, items, company };
}

/**
 * What Peppol BIS Billing 3.0 needs that this system might not have on file
 * yet. Returns an array of human-readable problems — empty means ready to
 * export. Checked up front so a caller gets one clear list instead of a
 * cryptic XML validation failure (or, worse, technically-valid-looking XML
 * that a real Access Point would reject for missing mandatory party data).
 */
function validateForExport({ invoice, items, company }) {
  const problems = [];
  if (!company) problems.push('Company record not found.');
  else {
    if (!company.tax_number) problems.push("Seller (your company) has no tax_number on file — required for the seller's VAT scheme.");
    if (!company.address_line1 || !company.city || !company.country_code) problems.push("Seller (your company) is missing a full address (address_line1, city, country_code) — required for AccountingSupplierParty.");
  }
  if (!invoice.vat_number && !invoice.tax_number) problems.push('Customer has no vat_number or tax_number on file — required for the buyer\'s VAT scheme.');
  if (!invoice.billing_address_line1 || !invoice.billing_city || !invoice.billing_country) problems.push('Customer is missing a full billing address (billing_address_line1, billing_city, billing_country) — required for AccountingCustomerParty.');
  if (!items.length) problems.push('Invoice has no line items.');
  if (invoice.status === 'DRAFT') problems.push('Invoice is still a DRAFT — only an issued (non-draft) invoice should be transmitted as an e-invoice.');
  return problems;
}

function buildPartyXml({ tag, name, legalName, taxNumber, addressLine1, addressLine2, city, state, postalCode, countryCode, endpointSchemeId = GENERIC_VAT_SCHEME }) {
  return `
    <cac:${tag}>
      <cbc:EndpointID schemeID="${escapeXml(endpointSchemeId)}">${escapeXml(taxNumber)}</cbc:EndpointID>
      <cac:Party>
        <cac:PartyName>
          <cbc:Name>${escapeXml(name)}</cbc:Name>
        </cac:PartyName>
        <cac:PostalAddress>
          <cbc:StreetName>${escapeXml(addressLine1)}</cbc:StreetName>
          ${addressLine2 ? `<cbc:AdditionalStreetName>${escapeXml(addressLine2)}</cbc:AdditionalStreetName>` : ''}
          <cbc:CityName>${escapeXml(city)}</cbc:CityName>
          ${postalCode ? `<cbc:PostalZone>${escapeXml(postalCode)}</cbc:PostalZone>` : ''}
          ${state ? `<cbc:CountrySubentity>${escapeXml(state)}</cbc:CountrySubentity>` : ''}
          <cac:Country>
            <cbc:IdentificationCode>${escapeXml(countryCode)}</cbc:IdentificationCode>
          </cac:Country>
        </cac:PostalAddress>
        <cac:PartyTaxScheme>
          <cbc:CompanyID>${escapeXml(taxNumber)}</cbc:CompanyID>
          <cac:TaxScheme>
            <cbc:ID>VAT</cbc:ID>
          </cac:TaxScheme>
        </cac:PartyTaxScheme>
        <cac:PartyLegalEntity>
          <cbc:RegistrationName>${escapeXml(legalName || name)}</cbc:RegistrationName>
          ${taxNumber ? `<cbc:CompanyID>${escapeXml(taxNumber)}</cbc:CompanyID>` : ''}
        </cac:PartyLegalEntity>
      </cac:Party>
    </cac:${tag}>`;
}

/**
 * Generate the Peppol BIS Billing 3.0 UBL XML for one customer invoice.
 * Throws with a validation problem list if required data is missing —
 * never emits a document silently missing mandatory fields.
 */
async function generateInvoiceXml(invoiceId) {
  const data = await loadInvoiceData(invoiceId);
  if (!data) throw new Error('Invoice not found.');

  const problems = validateForExport(data);
  if (problems.length) {
    const err = new Error(`Cannot generate a Peppol e-invoice — missing required data: ${problems.join(' ')}`);
    err.validationProblems = problems;
    throw err;
  }

  const { invoice, items, company } = data;
  const currency = invoice.currency || company.base_currency || 'USD';
  const taxRate = items.length ? Number(items[0].tax_rate) * 100 : 0; // BIS 3.0 groups by rate; this system's invoices carry one effective rate today
  const taxCategoryId = taxRate > 0 ? 'S' : 'Z'; // S = Standard rate, Z = Zero rated (UNCL5305)

  const lineXml = items.map((item, i) => `
    <cac:InvoiceLine>
      <cbc:ID>${i + 1}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="${escapeXml(item.unit_of_measure || UBL_UNIT_CODE_FALLBACK)}">${fmtQty(item.quantity)}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="${escapeXml(currency)}">${fmtAmount(item.line_total)}</cbc:LineExtensionAmount>
      <cac:Item>
        <cbc:Name>${escapeXml(item.item_description)}</cbc:Name>
        <cac:ClassifiedTaxCategory>
          <cbc:ID>${taxCategoryId}</cbc:ID>
          <cbc:Percent>${fmtAmount(Number(item.tax_rate) * 100)}</cbc:Percent>
          <cac:TaxScheme>
            <cbc:ID>VAT</cbc:ID>
          </cac:TaxScheme>
        </cac:ClassifiedTaxCategory>
      </cac:Item>
      <cac:Price>
        <cbc:PriceAmount currencyID="${escapeXml(currency)}">${fmtAmount(item.unit_price)}</cbc:PriceAmount>
      </cac:Price>
    </cac:InvoiceLine>`).join('');

  const supplierXml = buildPartyXml({
    tag: 'AccountingSupplierParty',
    name: company.name,
    legalName: company.legal_name,
    taxNumber: company.tax_number,
    addressLine1: company.address_line1,
    addressLine2: company.address_line2,
    city: company.city,
    state: company.state,
    postalCode: company.postal_code,
    countryCode: company.country_code,
  });

  const customerXml = buildPartyXml({
    tag: 'AccountingCustomerParty',
    name: invoice.customer_name,
    legalName: invoice.legal_entity_name,
    taxNumber: invoice.vat_number || invoice.tax_number,
    addressLine1: invoice.billing_address_line1,
    addressLine2: invoice.billing_address_line2,
    city: invoice.billing_city,
    state: invoice.billing_state,
    postalCode: invoice.billing_postal_code,
    countryCode: invoice.billing_country,
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
  <cbc:ID>${escapeXml(invoice.invoice_number)}</cbc:ID>
  <cbc:IssueDate>${invoice.invoice_date.toISOString().split('T')[0]}</cbc:IssueDate>
  <cbc:DueDate>${invoice.due_date.toISOString().split('T')[0]}</cbc:DueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  ${invoice.notes ? `<cbc:Note>${escapeXml(invoice.notes)}</cbc:Note>` : ''}
  <cbc:DocumentCurrencyCode>${escapeXml(currency)}</cbc:DocumentCurrencyCode>
  ${supplierXml}
  ${customerXml}
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${escapeXml(currency)}">${fmtAmount(invoice.tax_amount)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${escapeXml(currency)}">${fmtAmount(invoice.subtotal - invoice.discount_amount)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${escapeXml(currency)}">${fmtAmount(invoice.tax_amount)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>${taxCategoryId}</cbc:ID>
        <cbc:Percent>${fmtAmount(taxRate)}</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${escapeXml(currency)}">${fmtAmount(invoice.subtotal)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${escapeXml(currency)}">${fmtAmount(invoice.subtotal - invoice.discount_amount)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${escapeXml(currency)}">${fmtAmount(invoice.total_amount)}</cbc:TaxInclusiveAmount>
    ${Number(invoice.discount_amount) > 0 ? `<cbc:AllowanceTotalAmount currencyID="${escapeXml(currency)}">${fmtAmount(invoice.discount_amount)}</cbc:AllowanceTotalAmount>` : ''}
    <cbc:PayableAmount currencyID="${escapeXml(currency)}">${fmtAmount(invoice.total_amount)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  ${lineXml}
</Invoice>`;

  return xml;
}

module.exports = { generateInvoiceXml, validateForExport, loadInvoiceData };
