-- Migration 202608021030: bring approval_delegations inside the tenant boundary.
--
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- Delegation of authority is per-company by definition: "while I am away, X may
-- approve up to Y on my behalf" is a statement about one company's approval
-- rules. The table shipped with no company_id at all, so with isolation on,
-- every tenant would have seen — and been bound by — every other tenant's
-- delegations. That is an authority leak, not just a data leak: it decides who
-- may approve spend.
--
-- tests/tenancyGuard.test.js caught it, which is what that guard is for.
--
-- Idempotent.

DO $$
DECLARE
  default_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema = 'public' AND table_name = 'approval_delegations') THEN
    RETURN;
  END IF;

  SELECT id INTO default_id FROM companies ORDER BY created_at ASC LIMIT 1;
  IF default_id IS NULL THEN
    default_id := '11111111-1111-1111-1111-111111111111'::uuid;
  END IF;

  ALTER TABLE approval_delegations ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
  EXECUTE format('UPDATE approval_delegations SET company_id = %L WHERE company_id IS NULL', default_id);
  ALTER TABLE approval_delegations ALTER COLUMN company_id SET NOT NULL;
  EXECUTE format(
    'ALTER TABLE approval_delegations ALTER COLUMN company_id SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)',
    default_id
  );
END $$;

INSERT INTO company_scoped_tables (table_name)
VALUES ('approval_delegations')
ON CONFLICT (table_name) DO NOTHING;
