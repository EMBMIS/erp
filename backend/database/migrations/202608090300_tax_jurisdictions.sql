-- Real multi-jurisdiction tax infrastructure, replacing the single
-- DEFAULT_VAT_RATE env var taxService.js used for every customer/supplier
-- regardless of country. Two global reference tables (like `currencies` —
-- tax rates are an external fact, not a per-tenant preference):
--
--   tax_jurisdictions — country, or country+region (US state, CA province).
--   tax_codes         — a named rate within a jurisdiction: VAT/GST/sales-tax
--                        standard/reduced/zero rates, and withholding tax
--                        rates by payment type. Date-keyed (effective_from),
--                        same pattern as exchange_rates, since rates change
--                        over time and a document should use the rate that
--                        was actually in force on its date.
--
-- Seed data covers major markets' STANDARD domestic rates as a genuinely
-- useful starting set — not exhaustive global tax law. Two things it does
-- NOT attempt, and this is a real limitation to know about, not an oversight:
--   * Sub-national add-ons (US county/city sales tax on top of the state
--     rate, Canadian PST on top of GST in some provinces) — only the
--     state/province-level rate is seeded.
--   * Treaty-adjusted withholding tax — WHT rates are seeded as each
--     jurisdiction's DOMESTIC (non-treaty) rate. Real WHT is bilateral:
--     the US-UK treaty rate for dividends differs from the US-generic rate,
--     and treaty relief requires the recipient's actual tax residency and
--     often a certificate. These seeded rates are a starting default an
--     admin must review per real cross-border payment, not an authority.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS tax_jurisdictions (
  code          TEXT PRIMARY KEY,          -- 'DE', 'US-CA', 'GB'
  name          TEXT NOT NULL,
  country_code  TEXT NOT NULL,             -- ISO 3166-1 alpha-2
  region_code   TEXT,                      -- state/province code, NULL for country-level
  tax_system    TEXT NOT NULL CHECK (tax_system IN ('VAT', 'GST', 'SALES_TAX'))
);

CREATE TABLE IF NOT EXISTS tax_codes (
  code               TEXT PRIMARY KEY,      -- 'DE-VAT-STD', 'US-CA-SALES-STD'
  jurisdiction_code   TEXT NOT NULL REFERENCES tax_jurisdictions(code),
  name               TEXT NOT NULL,
  tax_type           TEXT NOT NULL CHECK (tax_type IN ('VAT', 'GST', 'SALES_TAX', 'WHT')),
  -- STANDARD/REDUCED/ZERO/EXEMPT for VAT/GST/SALES_TAX; for WHT, the payment
  -- type the rate applies to (SERVICES, DIVIDENDS, INTEREST, ROYALTIES).
  category           TEXT NOT NULL,
  rate_percent       NUMERIC(6,3) NOT NULL CHECK (rate_percent >= 0),
  effective_from     DATE NOT NULL DEFAULT CURRENT_DATE,
  is_active          BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_tax_codes_lookup
  ON tax_codes (jurisdiction_code, tax_type, category, effective_from DESC);

INSERT INTO tax_jurisdictions (code, name, country_code, region_code, tax_system) VALUES
  ('DE', 'Germany', 'DE', NULL, 'VAT'),
  ('FR', 'France', 'FR', NULL, 'VAT'),
  ('GB', 'United Kingdom', 'GB', NULL, 'VAT'),
  ('IE', 'Ireland', 'IE', NULL, 'VAT'),
  ('ES', 'Spain', 'ES', NULL, 'VAT'),
  ('IT', 'Italy', 'IT', NULL, 'VAT'),
  ('NL', 'Netherlands', 'NL', NULL, 'VAT'),
  ('AE', 'United Arab Emirates', 'AE', NULL, 'VAT'),
  ('SA', 'Saudi Arabia', 'SA', NULL, 'VAT'),
  ('IN', 'India', 'IN', NULL, 'GST'),
  ('AU', 'Australia', 'AU', NULL, 'GST'),
  ('SG', 'Singapore', 'SG', NULL, 'GST'),
  ('CA', 'Canada (federal GST)', 'CA', NULL, 'GST'),
  ('JP', 'Japan', 'JP', NULL, 'VAT'),
  ('US-CA', 'California', 'US', 'CA', 'SALES_TAX'),
  ('US-NY', 'New York (state)', 'US', 'NY', 'SALES_TAX'),
  ('US-TX', 'Texas', 'US', 'TX', 'SALES_TAX'),
  ('US-FL', 'Florida', 'US', 'FL', 'SALES_TAX'),
  ('US-WA', 'Washington', 'US', 'WA', 'SALES_TAX')
ON CONFLICT (code) DO NOTHING;

INSERT INTO tax_codes (code, jurisdiction_code, name, tax_type, category, rate_percent) VALUES
  ('DE-VAT-STD', 'DE', 'Germany VAT standard', 'VAT', 'STANDARD', 19.0),
  ('DE-VAT-RED', 'DE', 'Germany VAT reduced', 'VAT', 'REDUCED', 7.0),
  ('FR-VAT-STD', 'FR', 'France VAT standard', 'VAT', 'STANDARD', 20.0),
  ('FR-VAT-RED', 'FR', 'France VAT reduced', 'VAT', 'REDUCED', 5.5),
  ('GB-VAT-STD', 'GB', 'UK VAT standard', 'VAT', 'STANDARD', 20.0),
  ('GB-VAT-RED', 'GB', 'UK VAT reduced', 'VAT', 'REDUCED', 5.0),
  ('IE-VAT-STD', 'IE', 'Ireland VAT standard', 'VAT', 'STANDARD', 23.0),
  ('ES-VAT-STD', 'ES', 'Spain VAT standard', 'VAT', 'STANDARD', 21.0),
  ('IT-VAT-STD', 'IT', 'Italy VAT standard', 'VAT', 'STANDARD', 22.0),
  ('NL-VAT-STD', 'NL', 'Netherlands VAT standard', 'VAT', 'STANDARD', 21.0),
  ('AE-VAT-STD', 'AE', 'UAE VAT standard', 'VAT', 'STANDARD', 5.0),
  ('SA-VAT-STD', 'SA', 'Saudi Arabia VAT standard', 'VAT', 'STANDARD', 15.0),
  ('IN-GST-STD', 'IN', 'India GST standard slab', 'GST', 'STANDARD', 18.0),
  ('AU-GST-STD', 'AU', 'Australia GST', 'GST', 'STANDARD', 10.0),
  ('SG-GST-STD', 'SG', 'Singapore GST', 'GST', 'STANDARD', 9.0),
  ('CA-GST-STD', 'CA', 'Canada federal GST', 'GST', 'STANDARD', 5.0),
  ('JP-VAT-STD', 'JP', 'Japan consumption tax', 'VAT', 'STANDARD', 10.0),
  ('US-CA-SALES-STD', 'US-CA', 'California state sales tax', 'SALES_TAX', 'STANDARD', 7.25),
  ('US-NY-SALES-STD', 'US-NY', 'New York state sales tax', 'SALES_TAX', 'STANDARD', 4.0),
  ('US-TX-SALES-STD', 'US-TX', 'Texas state sales tax', 'SALES_TAX', 'STANDARD', 6.25),
  ('US-FL-SALES-STD', 'US-FL', 'Florida state sales tax', 'SALES_TAX', 'STANDARD', 6.0),
  ('US-WA-SALES-STD', 'US-WA', 'Washington state sales tax', 'SALES_TAX', 'STANDARD', 6.5),
  -- Domestic (non-treaty) withholding tax defaults — see the header note.
  ('DE-WHT-SERVICES', 'DE', 'Germany WHT — services', 'WHT', 'SERVICES', 15.0),
  ('DE-WHT-DIVIDENDS', 'DE', 'Germany WHT — dividends', 'WHT', 'DIVIDENDS', 26.375),
  ('GB-WHT-INTEREST', 'GB', 'UK WHT — interest', 'WHT', 'INTEREST', 20.0),
  ('IN-WHT-SERVICES', 'IN', 'India WHT (TDS) — services', 'WHT', 'SERVICES', 10.0),
  ('IN-WHT-ROYALTIES', 'IN', 'India WHT (TDS) — royalties', 'WHT', 'ROYALTIES', 10.0),
  ('AE-WHT-SERVICES', 'AE', 'UAE WHT — services', 'WHT', 'SERVICES', 0.0)
ON CONFLICT (code) DO NOTHING;
