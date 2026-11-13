-- 092 — Allow GOODS_ISSUE / GOODS_RECEIPT as journal-entry source types.
--
-- Inventory now recognizes Cost of Goods Sold on a goods issue (Dr 5100 / Cr
-- 1130) valued at moving-average cost. That journal entry's source_type is
-- GOODS_ISSUE, which the existing chk_journal_source_type_valid constraint did
-- not permit. This widens the allowlist. Idempotent.

ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS chk_journal_source_type_valid;
ALTER TABLE journal_entries ADD CONSTRAINT chk_journal_source_type_valid
  CHECK (source_type::text = ANY (ARRAY[
    'MANUAL','SALES_ORDER','PURCHASE_ORDER','INVENTORY_ADJUSTMENT',
    'DEPRECIATION','PAYROLL','BANK_TRANSACTION','FIXED_ASSET','AUTOMATED',
    'GOODS_ISSUE','GOODS_RECEIPT'
  ]::text[]));
