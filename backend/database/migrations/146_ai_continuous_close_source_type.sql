-- 146 — allow the AI continuous-close agent's source type on journal entries.
--
-- The agent (services/ai/continuousCloseAgent.js) creates DRAFT correcting
-- entries with source_type 'AI_CONTINUOUS_CLOSE' so the AI layer's postings
-- are identifiable and reportable. The original constraint predates the
-- agent and rejected that value, which made every proposed correction fail
-- at insert time.

ALTER TABLE journal_entries DROP CONSTRAINT chk_journal_source_type_valid;
ALTER TABLE journal_entries ADD CONSTRAINT chk_journal_source_type_valid CHECK (
  source_type IN (
    'MANUAL','SALES_ORDER','PURCHASE_ORDER','INVENTORY_ADJUSTMENT','DEPRECIATION',
    'PAYROLL','BANK_TRANSACTION','FIXED_ASSET','AUTOMATED','GOODS_ISSUE',
    'GOODS_RECEIPT','WORK_ORDER_ISSUE','WORK_ORDER_COMPLETION','WORK_ORDER_VARIANCE',
    'INTERCOMPANY','ASSET_REVALUATION','AI_CONTINUOUS_CLOSE'
  )
);
