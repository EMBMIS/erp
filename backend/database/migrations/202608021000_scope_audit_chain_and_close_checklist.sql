-- Migration 202608021000: bring audit_chain and period_close_checklist inside
-- the tenant boundary.
--
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- Both tables were added by the period-close and audit-hash-chain work. Both
-- carry company_id, so they look scoped — but:
--
--   • audit_chain was never registered in company_scoped_tables, so
--     enable_multi_company() would not have created a policy on it. Its
--     company_id was also nullable with no default. The practical effect: with
--     isolation switched on, the tamper-evident audit trail would have been the
--     one table every tenant could read in full. The audit log is the last
--     place a cross-tenant read should be possible.
--
--   • period_close_checklist was registered and NOT NULL, but had no default,
--     so nothing supplied company_id on insert from a session that had one.
--
-- tests/tenancy.test.js caught all three of these, which is the entire reason
-- that guard exists — a new table that carries company_id but is not wired to
-- the session is invisible until a second tenant is onboarded.
--
-- Idempotent.

DO $$
DECLARE
  default_id UUID;
BEGIN
  SELECT id INTO default_id FROM companies ORDER BY created_at ASC LIMIT 1;
  IF default_id IS NULL THEN
    default_id := '11111111-1111-1111-1111-111111111111'::uuid;
  END IF;

  -- audit_chain: backfill, then make the column mandatory and session-defaulted.
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'audit_chain') THEN
    EXECUTE format('UPDATE audit_chain SET company_id = %L WHERE company_id IS NULL', default_id);
    ALTER TABLE audit_chain ALTER COLUMN company_id SET NOT NULL;
    EXECUTE format(
      'ALTER TABLE audit_chain ALTER COLUMN company_id SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)',
      default_id
    );
  END IF;

  -- period_close_checklist: already NOT NULL and registered; it only ever
  -- lacked the session default.
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'period_close_checklist') THEN
    EXECUTE format('UPDATE period_close_checklist SET company_id = %L WHERE company_id IS NULL', default_id);
    ALTER TABLE period_close_checklist ALTER COLUMN company_id SET NOT NULL;
    EXECUTE format(
      'ALTER TABLE period_close_checklist ALTER COLUMN company_id SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)',
      default_id
    );
  END IF;
END $$;

-- Register audit_chain so enable_multi_company() puts a policy on it.
INSERT INTO company_scoped_tables (table_name)
VALUES ('audit_chain'), ('period_close_checklist')
ON CONFLICT (table_name) DO NOTHING;
