-- 202608071500 — Modular business-type system.
--
-- The ERP so far assumes every tenant is roughly the same shape: some
-- inventory, some procurement, some manufacturing. A services firm or a
-- marketplace has no use for half the nav tree, and forcing it on them is
-- exactly the "UX is overpacked" complaint this migration exists to fix.
--
-- Three pieces:
--   business_types           — reference data: the business categories a
--                               company can pick at signup (GLOBAL, same for
--                               every tenant, not company-scoped).
--   modules                  — the registry of toggleable feature areas
--                               (GLOBAL). `is_core = true` means every
--                               company has it always on — Finance, Admin,
--                               Reporting, and the AI assistant baseline
--                               aren't things a real business opts out of.
--   business_type_default_modules — which non-core modules a business type
--                               starts with enabled (GLOBAL, a join table).
--   company_modules           — the actual per-company on/off switch
--                               (COMPANY-SCOPED). Seeded from the business
--                               type's defaults at signup, then freely
--                               editable — a company can turn on a module its
--                               business type doesn't default to, which is
--                               exactly the "some companies still want
--                               sections available anyway" requirement.
--
-- Nothing here enforces anything by itself — routes/nav/AI tool gating read
-- company_modules and decide what to show or allow. This migration is the
-- data model only.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS business_types (
  code         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  category     TEXT NOT NULL,
  description  TEXT
);

CREATE TABLE IF NOT EXISTS modules (
  key          TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  -- Core modules can't be disabled — see header. Non-core modules are what
  -- business_type_default_modules and company_modules actually govern.
  is_core      BOOLEAN NOT NULL DEFAULT false,
  -- Matches the top-level nav section name in frontend/src/components/Layout.jsx,
  -- so the nav-gating code (a later change) has a direct key to filter on.
  nav_section  TEXT
);

CREATE TABLE IF NOT EXISTS business_type_default_modules (
  business_type_code  TEXT NOT NULL REFERENCES business_types(code) ON DELETE CASCADE,
  module_key          TEXT NOT NULL REFERENCES modules(key) ON DELETE CASCADE,
  PRIMARY KEY (business_type_code, module_key)
);

CREATE TABLE IF NOT EXISTS company_modules (
  company_id   UUID NOT NULL
                 DEFAULT COALESCE(current_company_id(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::uuid)
                 REFERENCES companies(id) ON DELETE CASCADE,
  module_key   TEXT NOT NULL REFERENCES modules(key) ON DELETE CASCADE,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id, module_key)
);

CREATE INDEX IF NOT EXISTS idx_company_modules_company ON company_modules (company_id);

ALTER TABLE companies ADD COLUMN IF NOT EXISTS business_type_code TEXT REFERENCES business_types(code);

-- Register the one real per-tenant table with the tenancy system. business_types/
-- modules/business_type_default_modules are GLOBAL reference data (see
-- tests/tenancyGuard.test.js's EXEMPT list, updated alongside this migration) —
-- identical for every tenant, so they do not belong in this registry.
INSERT INTO company_scoped_tables (table_name) VALUES ('company_modules')
  ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Module registry
-- ---------------------------------------------------------------------------
INSERT INTO modules (key, name, description, is_core, nav_section) VALUES
  ('inventory',         'Inventory',            'Stock, warehouses, transfers, stocktakes.',                     false, 'Inventory'),
  ('procurement',       'Procurement',           'Suppliers, purchase requisitions, RFQs, purchase orders.',      false, 'Procurement'),
  ('sales',             'Sales',                 'Customers, sales orders, quotations, delivery scheduling.',     false, 'Sales'),
  ('manufacturing',     'Manufacturing',         'Work orders, bills of material, MRP, work centers.',            false, 'Manufacturing'),
  ('crm',               'CRM',                   'Leads, deal pipeline, contacts, activities.',                  false, 'CRM'),
  ('projects',          'Projects',              'Project tracking and timesheets.',                             false, 'Projects'),
  ('hr',                'HR & Payroll',          'Employees, leave, attendance, payroll.',                       false, 'HR & Payroll'),
  ('barcode_scanning',  'Barcode Scanning',      'Camera-based barcode scan-to-lookup and scan-to-receive.',      false, 'Inventory'),
  ('finance',           'Finance',               'General ledger, AR/AP, assets, controlling, financial reports.', true, 'General Ledger'),
  ('reporting',         'Reporting',             'Cross-module reports and dashboards.',                          true, 'Reporting'),
  ('ai_assistant',      'AI Assistant',          'Chat, document search, autonomous agents.',                     true, 'Simeli AI'),
  ('admin',             'Administration',        'Users, approvals, delegation of authority, audit trail, billing.', true, NULL)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Business types — grouped to cover the full range of businesses this ERP
-- should serve without a bespoke row per named example (e.g. "clothing" and
-- "furniture" both land under product_ecommerce; they behave identically for
-- module purposes). category is the broader grouping for the signup UI.
-- ---------------------------------------------------------------------------
INSERT INTO business_types (code, name, category, description) VALUES
  ('product_ecommerce',    'Product / E-commerce / Retail',   'Product',        'Sells physical or digital products directly to customers.'),
  ('wholesale_distribution','Wholesale / Distribution',       'Product',        'Sells large quantities to other businesses.'),
  ('manufacturing',        'Manufacturing',                   'Product',        'Produces goods from raw materials or components.'),
  ('professional_services','Professional Services',           'Service',        'Sells expertise or labor — consulting, legal, agencies, repair.'),
  ('healthcare',           'Healthcare',                      'Service',        'Clinics, telemedicine, diagnostics, medical devices.'),
  ('education',            'Education / EdTech',              'Service',        'Courses, tutoring, learning platforms, institutions.'),
  ('saas',                 'SaaS',                             'Software',       'Software sold by subscription.'),
  ('enterprise_software',  'Enterprise Software',              'Software',       'ERP, CRM, HR, payroll and similar business software vendors.'),
  ('ai_ml',                'Artificial Intelligence',          'Software',       'Models, AI agents, AI infrastructure, computer vision, voice AI.'),
  ('cybersecurity',        'Cybersecurity',                    'Software',       'Endpoint protection, identity, threat intel, security consulting.'),
  ('marketplace',          'Marketplace',                      'Platform',       'Connects buyers and sellers; commission or listing-fee revenue.'),
  ('consumer_internet',    'Consumer Internet / Media',        'Platform',       'Social, streaming, gaming, news, creator platforms.'),
  ('logistics',            'Logistics & Transportation',       'Operations',     'Shipping, trucking, warehousing, delivery, fleet management.'),
  ('construction_realestate','Construction & Real Estate',     'Operations',     'Development, architecture, construction, property management.'),
  ('agriculture',          'Agriculture / AgTech',             'Operations',     'Farming, livestock, agricultural technology.'),
  ('energy',               'Energy',                           'Operations',     'Oil & gas, renewables, storage, distribution.'),
  ('industrial',           'Industrial & Infrastructure',      'Operations',     'Mining, heavy machinery, industrial automation.'),
  ('robotics_hardware',    'Robotics & Hardware',              'Operations',     'Industrial, warehouse, and consumer robotics and devices.'),
  ('biotechnology',        'Biotechnology',                    'Operations',     'Gene editing, drug discovery, synthetic biology.'),
  ('fintech',              'Finance (FinTech)',                'Finance',        'Payments, lending, investment platforms, insurance.'),
  ('hospitality_tourism',  'Hospitality & Tourism',            'Consumer',       'Hotels, restaurants, travel, events.'),
  ('advertising_marketing','Advertising & Marketing',          'Consumer',       'Agencies, SEO, influencer and affiliate marketing.'),
  ('telecommunications',   'Telecommunications',               'Consumer',       'Internet, mobile, satellite, fiber providers.'),
  ('government_nonprofit', 'Government & Nonprofit',           'Public',         'Public sector, defense, charities, NGOs, social enterprise.')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Default module set per business type. Only non-core modules need a row —
-- finance/reporting/ai_assistant/admin are always on regardless.
-- ---------------------------------------------------------------------------
INSERT INTO business_type_default_modules (business_type_code, module_key) VALUES
  ('product_ecommerce',     'inventory'), ('product_ecommerce',     'procurement'), ('product_ecommerce',     'sales'), ('product_ecommerce', 'crm'),
  ('wholesale_distribution','inventory'), ('wholesale_distribution','procurement'), ('wholesale_distribution','sales'), ('wholesale_distribution','barcode_scanning'),
  ('manufacturing',         'inventory'), ('manufacturing',         'procurement'), ('manufacturing',         'sales'), ('manufacturing', 'manufacturing'), ('manufacturing', 'crm'), ('manufacturing', 'projects'),
  ('professional_services', 'crm'),       ('professional_services', 'projects'),    ('professional_services', 'sales'),
  ('healthcare',            'crm'),       ('healthcare',            'projects'),    ('healthcare',            'hr'), ('healthcare', 'inventory'), ('healthcare', 'procurement'),
  ('education',             'crm'),       ('education',             'projects'),    ('education',             'hr'),
  ('saas',                  'crm'),       ('saas',                  'projects'),    ('saas',                  'sales'),
  ('enterprise_software',   'crm'),       ('enterprise_software',   'projects'),    ('enterprise_software',   'sales'),
  ('ai_ml',                 'crm'),       ('ai_ml',                 'projects'),
  ('cybersecurity',         'crm'),       ('cybersecurity',         'projects'),
  ('marketplace',           'crm'),       ('marketplace',           'sales'),
  ('consumer_internet',     'crm'),       ('consumer_internet',     'projects'),
  ('logistics',             'inventory'), ('logistics',             'procurement'), ('logistics',             'sales'), ('logistics', 'projects'), ('logistics', 'barcode_scanning'),
  ('construction_realestate','projects'), ('construction_realestate','procurement'), ('construction_realestate','crm'),
  ('agriculture',           'inventory'), ('agriculture',           'procurement'), ('agriculture',           'sales'),
  ('energy',                'inventory'), ('energy',                'procurement'), ('energy',                'projects'),
  ('industrial',            'inventory'), ('industrial',            'procurement'), ('industrial',            'manufacturing'), ('industrial', 'projects'), ('industrial', 'barcode_scanning'),
  ('robotics_hardware',     'inventory'), ('robotics_hardware',     'procurement'), ('robotics_hardware',     'manufacturing'), ('robotics_hardware', 'crm'), ('robotics_hardware', 'projects'),
  ('biotechnology',         'inventory'), ('biotechnology',         'procurement'), ('biotechnology',         'projects'),
  ('fintech',               'crm'),       ('fintech',               'projects'),
  ('hospitality_tourism',   'crm'),       ('hospitality_tourism',   'sales'),        ('hospitality_tourism',   'projects'),
  ('advertising_marketing', 'crm'),       ('advertising_marketing', 'projects'),
  ('telecommunications',    'crm'),       ('telecommunications',    'sales'),        ('telecommunications',    'projects'),
  ('government_nonprofit',  'crm'),       ('government_nonprofit',  'projects'),     ('government_nonprofit',  'procurement')
ON CONFLICT DO NOTHING;

-- Seed the existing default company with every non-core module enabled — it's
-- the pre-existing single-tenant install, which already uses the full app.
INSERT INTO company_modules (company_id, module_key, enabled)
  SELECT c.id, m.key, true
    FROM companies c, modules m
   WHERE c.is_default = true AND m.is_core = false
  ON CONFLICT DO NOTHING;

COMMENT ON TABLE modules IS
  'Toggleable feature areas. is_core=true modules are always on; others are governed by company_modules (per-tenant) seeded from business_type_default_modules at signup.';
COMMENT ON TABLE company_modules IS
  'Per-company module on/off switch. Company-scoped (RLS). Seeded from the company''s business_type defaults at signup; freely editable afterward via the modules settings page.';
