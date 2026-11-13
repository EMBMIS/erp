-- Migration 202607311530: Add company_id to revenue_schedules and register in company_scoped_tables
DO $$
DECLARE
  default_id UUID;
BEGIN
  SELECT id INTO default_id FROM companies ORDER BY created_at ASC LIMIT 1;
  IF default_id IS NULL THEN
    default_id := '11111111-1111-1111-1111-111111111111'::uuid;
  END IF;

  ALTER TABLE revenue_schedules ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
  EXECUTE format('UPDATE revenue_schedules SET company_id = %L WHERE company_id IS NULL', default_id);
  ALTER TABLE revenue_schedules ALTER COLUMN company_id SET NOT NULL;
  EXECUTE format(
    'ALTER TABLE revenue_schedules ALTER COLUMN company_id SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)',
    default_id
  );
END $$;

INSERT INTO company_scoped_tables (table_name)
VALUES ('revenue_schedules')
ON CONFLICT (table_name) DO NOTHING;
