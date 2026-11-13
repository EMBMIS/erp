-- Depreciation methods on the asset register.
--
-- 068 created `depreciation_method` as a free VARCHAR with no constraint, and
-- the model ignored it entirely — every asset was charged straight-line
-- whatever it said. Both halves are fixed: the model now dispatches on the
-- method (services/financeCalc.js), and the column is constrained to the
-- methods that dispatch actually handles. An unconstrained column here is how
-- an asset ends up carrying a method nothing can charge, discovered at a
-- period close.

-- Acceleration factor for declining balance. NULL means the method's own
-- default (200% for DOUBLE_DECLINING, 150% for DECLINING_BALANCE), so existing
-- rows need no backfill and the default stays in one place — the code.
ALTER TABLE fixed_assets
  ADD COLUMN IF NOT EXISTS declining_balance_factor DECIMAL(4,2);

-- Normalise anything already stored before constraining, so the constraint can
-- be added without a manual data fix. Unrecognised values become STRAIGHT_LINE,
-- which is what the code was charging them anyway — this changes no numbers.
UPDATE fixed_assets
   SET depreciation_method = UPPER(TRIM(depreciation_method))
 WHERE depreciation_method IS DISTINCT FROM UPPER(TRIM(depreciation_method));

UPDATE fixed_assets
   SET depreciation_method = 'STRAIGHT_LINE'
 WHERE depreciation_method IS NULL
    OR depreciation_method NOT IN
       ('STRAIGHT_LINE', 'DECLINING_BALANCE', 'DOUBLE_DECLINING', 'SUM_OF_YEARS_DIGITS');

ALTER TABLE fixed_assets DROP CONSTRAINT IF EXISTS chk_fixed_asset_depreciation_method;
ALTER TABLE fixed_assets ADD CONSTRAINT chk_fixed_asset_depreciation_method
CHECK (depreciation_method IN (
  'STRAIGHT_LINE', 'DECLINING_BALANCE', 'DOUBLE_DECLINING', 'SUM_OF_YEARS_DIGITS'
));

ALTER TABLE fixed_assets DROP CONSTRAINT IF EXISTS chk_fixed_asset_declining_factor;
ALTER TABLE fixed_assets ADD CONSTRAINT chk_fixed_asset_declining_factor
CHECK (declining_balance_factor IS NULL
       OR (declining_balance_factor > 0 AND declining_balance_factor <= 5));

COMMENT ON COLUMN fixed_assets.depreciation_method IS
  'STRAIGHT_LINE | DECLINING_BALANCE | DOUBLE_DECLINING | SUM_OF_YEARS_DIGITS — charged by services/financeCalc.depreciationForPeriod';
COMMENT ON COLUMN fixed_assets.declining_balance_factor IS
  'Acceleration factor for declining balance; NULL uses the method default (2.0 double, 1.5 declining)';
COMMENT ON TABLE fixed_assets IS 'Fixed asset register with straight-line and accelerated depreciation';
