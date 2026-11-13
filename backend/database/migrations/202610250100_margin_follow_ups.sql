-- The follow-ups the margin analysis proposes, as records that wait on their owner.
--
-- "What is hurting our margins?" (services/marginDrivers.js) ends in three kinds
-- of follow-up: re-quote an item that costs more to buy (an RFQ, which already
-- exists), require approval for a product discounted past its usual level, and
-- open a quality review on a work centre scrapping more than it used to. The
-- last two had nowhere to live. These tables are that place.
--
--   sales_discount_rules   "HF-20 discounts above 10% are approved by <person>".
--                          PROPOSED until a manager who did not propose it makes
--                          it ACTIVE; while ACTIVE, a sales order that discounts
--                          the item further can only be approved by the rule's
--                          approver (or an admin). See models/SalesOrder.js.
--   quality_reviews        "Scrap on line 2 is 4.1% against 1.9%": OPEN on the
--                          work centre, with the evidence, until production
--                          closes it with what they found.

CREATE TABLE IF NOT EXISTS sales_discount_rules (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_id           UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  max_discount_pct  NUMERIC(5,2) NOT NULL CHECK (max_discount_pct >= 0 AND max_discount_pct < 100),
  approver_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'PROPOSED'
                    CHECK (status IN ('PROPOSED', 'ACTIVE', 'DECLINED', 'RETIRED')),
  reason            TEXT,
  evidence          JSONB,
  source            VARCHAR(30) NOT NULL DEFAULT 'margin_analysis',
  proposed_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  proposed_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at        TIMESTAMPTZ,
  decline_reason    TEXT
);

-- One live rule per product: a second proposal for the same item is the same proposal.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_discount_rules_live
  ON sales_discount_rules (company_id, item_id) WHERE status IN ('PROPOSED', 'ACTIVE');

CREATE TABLE IF NOT EXISTS quality_reviews (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  review_number     VARCHAR(30) NOT NULL,
  work_center_id    UUID REFERENCES work_centers(id) ON DELETE SET NULL,
  title             VARCHAR(255) NOT NULL,
  finding           TEXT,
  evidence          JSONB,
  status            VARCHAR(20) NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN', 'CLOSED')),
  outcome           TEXT,
  source            VARCHAR(30) NOT NULL DEFAULT 'margin_analysis',
  opened_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  opened_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  closed_at         TIMESTAMPTZ,
  CONSTRAINT uq_quality_reviews_number UNIQUE (company_id, review_number)
);

-- One open review per work centre: the scrap is one problem until someone closes it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_quality_reviews_open
  ON quality_reviews (company_id, work_center_id) WHERE status = 'OPEN';

-- Company isolation, same policy text and FORCE as every company-scoped table.
INSERT INTO company_scoped_tables (table_name)
VALUES ('sales_discount_rules'), ('quality_reviews')
ON CONFLICT (table_name) DO NOTHING;

ALTER TABLE sales_discount_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_discount_rules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_isolation ON sales_discount_rules;
CREATE POLICY company_isolation ON sales_discount_rules
  USING (company_id = public.current_company_id())
  WITH CHECK (company_id = public.current_company_id());

ALTER TABLE quality_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_reviews FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_isolation ON quality_reviews;
CREATE POLICY company_isolation ON quality_reviews
  USING (company_id = public.current_company_id())
  WITH CHECK (company_id = public.current_company_id());

DO $$
DECLARE
  default_id UUID;
  role_name  TEXT;
BEGIN
  SELECT id INTO default_id FROM companies ORDER BY created_at ASC LIMIT 1;
  IF default_id IS NULL THEN
    default_id := '11111111-1111-1111-1111-111111111111'::uuid;
  END IF;
  EXECUTE format(
    'ALTER TABLE sales_discount_rules ALTER COLUMN company_id SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)',
    default_id
  );
  EXECUTE format(
    'ALTER TABLE quality_reviews ALTER COLUMN company_id SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)',
    default_id
  );

  FOR role_name IN
    SELECT DISTINCT g.grantee FROM information_schema.role_table_grants g
     WHERE g.table_name = 'app_notifications' AND g.privilege_type = 'INSERT'
       AND g.grantee <> 'PUBLIC'
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON sales_discount_rules TO %I', role_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON quality_reviews TO %I', role_name);
  END LOOP;
END $$;
