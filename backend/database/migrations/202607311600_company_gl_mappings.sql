-- Migration 202607311600: Create company_gl_mappings table
--
-- Purpose-based GL account mapping per company. Avoids heuristics or hardcoded account numbers
-- by explicitly registering mapping purposes (e.g. DEFERRED_REVENUE, RECOGNIZED_REVENUE, AP_CONTROL, AR_CONTROL).

CREATE TABLE IF NOT EXISTS company_gl_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL DEFAULT COALESCE(public.current_company_id(), '11111111-1111-1111-1111-111111111111'::uuid) REFERENCES companies(id) ON DELETE CASCADE,
  purpose VARCHAR(50) NOT NULL,
  account_code VARCHAR(50) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_company_gl_mapping_purpose UNIQUE (company_id, purpose)
);

ALTER TABLE company_gl_mappings ALTER COLUMN company_id SET DEFAULT COALESCE(public.current_company_id(), '11111111-1111-1111-1111-111111111111'::uuid);

-- Register with company_scoped_tables
INSERT INTO company_scoped_tables (table_name)
VALUES ('company_gl_mappings')
ON CONFLICT (table_name) DO NOTHING;


