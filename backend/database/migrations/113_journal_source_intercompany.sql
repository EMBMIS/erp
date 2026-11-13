-- 113 — Allow intercompany and asset-revaluation journal source types.
--
-- chk_journal_source_type_valid is an allowlist (see 107), so a new posting
-- path is rejected at write time until named here. Adding both now:
--
--   INTERCOMPANY  — the paired due-to/due-from legs posted in two companies.
--                   Kept distinct from MANUAL so consolidation can find the
--                   entries it needs to eliminate without parsing descriptions.
--                   An intercompany balance that cannot be identified is one
--                   that cannot be eliminated, and it inflates group assets and
--                   liabilities by the same amount every period.
--
--   ASSET_REVALUATION — upward revaluations credit equity while downward ones
--                   hit the P&L, so they are not DEPRECIATION and should not be
--                   counted with it when analysing depreciation expense.
--
-- Idempotent.

DO $$
BEGIN
  ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS chk_journal_source_type_valid;
  ALTER TABLE journal_entries ADD CONSTRAINT chk_journal_source_type_valid
    CHECK (source_type::text = ANY (ARRAY[
      'MANUAL','SALES_ORDER','PURCHASE_ORDER','INVENTORY_ADJUSTMENT','DEPRECIATION',
      'PAYROLL','BANK_TRANSACTION','FIXED_ASSET','AUTOMATED','GOODS_ISSUE','GOODS_RECEIPT',
      'WORK_ORDER_ISSUE','WORK_ORDER_COMPLETION','WORK_ORDER_VARIANCE',
      'INTERCOMPANY','ASSET_REVALUATION'
    ]::text[]));
END $$;

-- ---------------------------------------------------------------------------
-- Revaluation surplus.
--
-- Under IAS 16 an upward revaluation goes to other comprehensive income and
-- accumulates in equity, not to profit. Booking it as income would let a
-- company report a gain by re-estimating what it already owns.
-- ---------------------------------------------------------------------------
INSERT INTO chart_of_accounts
  (account_code, account_name, account_type, account_subtype, account_level,
   is_header, normal_balance, status, created_by, allow_manual_posting,
   balance_sheet_section)
SELECT v.code, v.name, v.type, v.subtype, 3, false, v.normal, 'ACTIVE',
       (SELECT id FROM users ORDER BY created_at LIMIT 1), false, v.section
  FROM (VALUES
    ('3200', 'Revaluation Surplus',        'EQUITY',  'RESERVES',        'CREDIT', 'EQUITY'),
    ('5850', 'Impairment Loss on Assets',  'EXPENSE', 'OPERATING_EXPENSE','DEBIT',  NULL)
  ) AS v(code, name, type, subtype, normal, section)
 WHERE EXISTS (SELECT 1 FROM users)
   AND NOT EXISTS (SELECT 1 FROM chart_of_accounts coa WHERE coa.account_code = v.code);

-- ---------------------------------------------------------------------------
-- Revaluation history.
--
-- Needed because the accounting for a revaluation depends on what came before
-- it: a downward revaluation is charged against any surplus previously
-- recognised for that same asset, and only the excess goes to the P&L. Without
-- a per-asset history that rule cannot be applied.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fixed_asset_revaluations (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  asset_id           UUID NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,

  revaluation_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  carrying_amount_before DECIMAL(15,2) NOT NULL,
  revalued_amount    DECIMAL(15,2) NOT NULL CHECK (revalued_amount >= 0),
  -- Positive for an increase, negative for a decrease.
  adjustment         DECIMAL(15,2) NOT NULL,

  -- How the adjustment was split. Upward: surplus to equity, but first
  -- reversing any prior impairment through the P&L. Downward: against surplus
  -- first, then impairment expense.
  to_equity          DECIMAL(15,2) NOT NULL DEFAULT 0,
  to_profit_or_loss  DECIMAL(15,2) NOT NULL DEFAULT 0,

  method             VARCHAR(20) NOT NULL DEFAULT 'REVALUATION'
                     CHECK (method IN ('REVALUATION','IMPAIRMENT')),
  basis              TEXT,
  journal_entry_id   UUID REFERENCES journal_entries(id),

  created_by         UUID REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_asset_revaluations_asset
  ON fixed_asset_revaluations (asset_id, revaluation_date DESC);

COMMENT ON TABLE fixed_asset_revaluations IS
  'Per-asset revaluation history. Required to apply IAS 16: a decrease is charged against that asset''s own accumulated surplus before it can hit profit or loss.';
