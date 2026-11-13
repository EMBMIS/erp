-- Follow-up to 202608141000: the new tables' company_id columns were left
-- NOT NULL with no DEFAULT, unlike every other scoped table in this codebase
-- (which sets DEFAULT COALESCE(public.current_company_id(), <fallback>)).
-- Without it, any INSERT that (correctly, per convention — see deal_stage_history,
-- project_milestones) omits company_id and relies on the column default gets
-- company_id = NULL, which RLS's WITH CHECK rejects before the NOT NULL
-- constraint even gets a chance to produce a clearer error.
--
-- Idempotent.

DO $$
DECLARE
  default_id UUID;
  tbl TEXT;
  tables TEXT[] := ARRAY[
    'leave_accrual_policies', 'leave_balances', 'leave_balance_transactions',
    'employee_job_history', 'employee_documents'
  ];
BEGIN
  SELECT id INTO default_id FROM companies ORDER BY created_at ASC LIMIT 1;
  IF default_id IS NULL THEN
    default_id := '11111111-1111-1111-1111-111111111111'::uuid;
  END IF;

  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN company_id SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)',
      tbl, default_id
    );
  END LOOP;
END $$;
