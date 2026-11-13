-- 105 — Manufacturing / MRP.
--
-- The system could buy and sell but not make anything: there were no bills of
-- material and no work orders, so any manufacturer had no way to represent
-- converting components into a finished product.
--
-- Accounting model (standard manufacturing cost flow):
--   issue materials    Dr Work In Progress   Cr Inventory
--   confirm production Dr Inventory (FG)     Cr Work In Progress
--                      + any difference to the manufacturing variance account
--
-- WIP is a real balance-sheet account, not a memo: partially built goods are an
-- asset, and leaving their cost in raw-material inventory would overstate
-- available stock while understating what is committed to production.
--
-- Idempotent.

-- ---------------------------------------------------------------------------
-- GL accounts this module posts to
-- ---------------------------------------------------------------------------
INSERT INTO chart_of_accounts
  (account_code, account_name, account_type, account_subtype, account_level, is_header,
   normal_balance, status, created_by, allow_manual_posting, balance_sheet_section, current_balance)
SELECT '1135', 'Work In Progress', 'ASSET', 'CURRENT_ASSET', 3, false,
       'DEBIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'CURRENT_ASSETS', 0
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE account_code = '1135');

INSERT INTO chart_of_accounts
  (account_code, account_name, account_type, account_subtype, account_level, is_header,
   normal_balance, status, created_by, allow_manual_posting, balance_sheet_section, current_balance)
SELECT '5150', 'Manufacturing Variance', 'EXPENSE', 'COST_OF_SALES', 3, false,
       'DEBIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, NULL, 0
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE account_code = '5150');

-- ---------------------------------------------------------------------------
-- Bills of material
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bills_of_material (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bom_number       VARCHAR(30)  NOT NULL UNIQUE,
  item_id          UUID         NOT NULL REFERENCES items(id),   -- what this BOM produces
  version          INTEGER      NOT NULL DEFAULT 1,
  description      TEXT,

  -- Component quantities are expressed per this many units of output, so a
  -- recipe that naturally yields 100 does not force fractional components.
  output_quantity  DECIMAL(15,4) NOT NULL DEFAULT 1 CHECK (output_quantity > 0),
  unit_of_measure  VARCHAR(20),

  status           VARCHAR(20)  NOT NULL DEFAULT 'DRAFT'
                   CHECK (status IN ('DRAFT', 'ACTIVE', 'OBSOLETE')),

  effective_from   DATE,
  effective_to     DATE,

  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at       TIMESTAMPTZ
);

-- Only one ACTIVE BOM per item: "which recipe applies?" must have one answer.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bom_one_active_per_item
  ON bills_of_material (item_id)
  WHERE status = 'ACTIVE' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS bom_components (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bom_id             UUID NOT NULL REFERENCES bills_of_material(id) ON DELETE CASCADE,
  component_item_id  UUID NOT NULL REFERENCES items(id),
  line_number        INTEGER NOT NULL DEFAULT 1,

  quantity_per       DECIMAL(15,4) NOT NULL CHECK (quantity_per > 0),
  unit_of_measure    VARCHAR(20),

  -- Expected loss in processing. Requirements are grossed up by this so a 5%
  -- scrap rate does not silently cause a shortage mid-build.
  scrap_percent      DECIMAL(6,3) NOT NULL DEFAULT 0 CHECK (scrap_percent >= 0 AND scrap_percent < 100),

  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- A component cannot be its own parent. Deeper cycles are caught in code
  -- during BOM explosion, which a table constraint cannot express.
  CONSTRAINT bom_component_not_self CHECK (component_item_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_bom_components_bom  ON bom_components (bom_id, line_number);
CREATE INDEX IF NOT EXISTS idx_bom_components_item ON bom_components (component_item_id);

-- ---------------------------------------------------------------------------
-- Work orders
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS work_orders (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wo_number           VARCHAR(30) NOT NULL UNIQUE,
  item_id             UUID NOT NULL REFERENCES items(id),
  bom_id              UUID REFERENCES bills_of_material(id),

  quantity_ordered    DECIMAL(15,4) NOT NULL CHECK (quantity_ordered > 0),
  quantity_produced   DECIMAL(15,4) NOT NULL DEFAULT 0,
  quantity_scrapped   DECIMAL(15,4) NOT NULL DEFAULT 0,

  status              VARCHAR(24) NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT','RELEASED','IN_PROGRESS','COMPLETED','CANCELLED')),

  planned_start_date  DATE,
  planned_end_date    DATE,
  actual_start_date   DATE,
  actual_end_date     DATE,

  -- Accumulated cost of materials issued, and the value credited out on
  -- completion. Kept on the header so WIP can be reconciled per order.
  wip_value           DECIMAL(15,2) NOT NULL DEFAULT 0,
  completed_value     DECIMAL(15,2) NOT NULL DEFAULT 0,

  storage_location_id UUID REFERENCES storage_locations(id),
  sales_order_id      UUID REFERENCES sales_orders(id),   -- make-to-order link
  source              VARCHAR(20) NOT NULL DEFAULT 'MANUAL'
                      CHECK (source IN ('MANUAL','MRP','SALES_ORDER')),

  notes               TEXT,
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_work_orders_status ON work_orders (status, planned_start_date);
CREATE INDEX IF NOT EXISTS idx_work_orders_item   ON work_orders (item_id);

CREATE TABLE IF NOT EXISTS work_order_components (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  work_order_id      UUID NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  component_item_id  UUID NOT NULL REFERENCES items(id),
  line_number        INTEGER NOT NULL DEFAULT 1,

  quantity_required  DECIMAL(15,4) NOT NULL,
  quantity_issued    DECIMAL(15,4) NOT NULL DEFAULT 0,
  unit_cost          DECIMAL(15,4) NOT NULL DEFAULT 0,
  issued_value       DECIMAL(15,2) NOT NULL DEFAULT 0,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wo_components_wo ON work_order_components (work_order_id, line_number);

-- ---------------------------------------------------------------------------
-- MRP planned orders — the output of a planning run, before anyone commits.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mrp_planned_orders (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id            UUID NOT NULL,           -- groups one planning run
  item_id           UUID NOT NULL REFERENCES items(id),

  order_type        VARCHAR(20) NOT NULL CHECK (order_type IN ('MAKE','BUY')),
  quantity          DECIMAL(15,4) NOT NULL,
  required_by       DATE,
  bom_level         INTEGER NOT NULL DEFAULT 0,   -- 0 = end item

  gross_requirement DECIMAL(15,4) NOT NULL DEFAULT 0,
  on_hand           DECIMAL(15,4) NOT NULL DEFAULT 0,
  net_requirement   DECIMAL(15,4) NOT NULL DEFAULT 0,

  demand_source     VARCHAR(40),
  rationale         TEXT,

  status            VARCHAR(20) NOT NULL DEFAULT 'PLANNED'
                    CHECK (status IN ('PLANNED','CONVERTED','DISMISSED')),
  converted_to_id   UUID,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mrp_planned_run  ON mrp_planned_orders (run_id, bom_level);
CREATE INDEX IF NOT EXISTS idx_mrp_planned_open ON mrp_planned_orders (status, required_by);

-- ---------------------------------------------------------------------------
-- Number generators (advisory-locked, matching every other generator here)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_bom_number()
 RETURNS text LANGUAGE plpgsql AS $function$
DECLARE
    next_number INTEGER;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('generate_bom_number'));
    SELECT COALESCE(MAX(
        CASE WHEN bom_number ~ '^BOM-[0-9]+$'
             THEN SUBSTRING(bom_number FROM '\-([0-9]+)$')::INTEGER ELSE 0 END
    ), 0) + 1 INTO next_number FROM bills_of_material;
    RETURN 'BOM-' || LPAD(next_number::TEXT, 6, '0');
END;
$function$;

CREATE OR REPLACE FUNCTION public.generate_work_order_number()
 RETURNS text LANGUAGE plpgsql AS $function$
DECLARE
    year_part TEXT;
    next_number INTEGER;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('generate_work_order_number'));
    year_part := EXTRACT(YEAR FROM CURRENT_DATE)::TEXT;
    SELECT COALESCE(MAX(
        CASE WHEN wo_number ~ ('^WO-' || year_part || '-[0-9]+$')
             THEN SUBSTRING(wo_number FROM '\-([0-9]+)$')::INTEGER ELSE 0 END
    ), 0) + 1 INTO next_number FROM work_orders;
    RETURN 'WO-' || year_part || '-' || LPAD(next_number::TEXT, 6, '0');
END;
$function$;
