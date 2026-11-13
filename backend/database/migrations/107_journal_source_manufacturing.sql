-- 107 — Allow manufacturing journal source types.
--
-- chk_journal_source_type_valid is an allowlist, so the new manufacturing
-- postings (material issue, production completion, scrap variance) were
-- rejected until named here. That is the constraint doing its job: it caught a
-- new posting path at write time rather than letting an unrecognised source_type
-- into the ledger where reporting would silently ignore it.
--
-- Keeping the three separate rather than lumping them under one WORK_ORDER value
-- matters for analysis: "how much did we scrap this quarter" is a question about
-- WORK_ORDER_VARIANCE specifically, and it should be answerable without parsing
-- descriptions.
--
-- Idempotent.

DO $$
BEGIN
  ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS chk_journal_source_type_valid;
  ALTER TABLE journal_entries ADD CONSTRAINT chk_journal_source_type_valid
    CHECK (source_type::text = ANY (ARRAY[
      'MANUAL','SALES_ORDER','PURCHASE_ORDER','INVENTORY_ADJUSTMENT','DEPRECIATION',
      'PAYROLL','BANK_TRANSACTION','FIXED_ASSET','AUTOMATED','GOODS_ISSUE','GOODS_RECEIPT',
      'WORK_ORDER_ISSUE','WORK_ORDER_COMPLETION','WORK_ORDER_VARIANCE'
    ]::text[]));
END $$;
