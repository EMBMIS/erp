-- Migration 144: Add company_id scoping to newly added primary tables & register them in company_scoped_tables
DO $$
DECLARE
  default_id UUID;
  tbl TEXT;
  tables TEXT[] := ARRAY['landed_cost_vouchers', 'price_lists', 'shipments', 'uom_conversions'];
BEGIN
  SELECT id INTO default_id FROM companies ORDER BY created_at ASC LIMIT 1;
  IF default_id IS NULL THEN
    default_id := '11111111-1111-1111-1111-111111111111'::uuid;
  END IF;

  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id)', tbl);
    EXECUTE format('UPDATE %I SET company_id = %L WHERE company_id IS NULL', tbl, default_id);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN company_id SET NOT NULL', tbl);
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN company_id SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)',
      tbl, default_id
    );
  END LOOP;
END $$;

INSERT INTO company_scoped_tables (table_name)
VALUES ('landed_cost_vouchers'), ('price_lists'), ('shipments'), ('uom_conversions')
ON CONFLICT (table_name) DO NOTHING;
