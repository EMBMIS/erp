-- chk_journal_source_type_valid is an allowlist (see 202608061500 and
-- earlier). services/fxRevaluationService.js posts unrealized FX gain/loss
-- on open foreign-currency AR/AP balances at period end with sourceType
-- 'FX_REVALUATION', so it can be distinguished from ordinary manual entries
-- and from the realized FX leg already posted by
-- FinancialPostingService.postCashPayment (which stays 'BANK_TRANSACTION').

ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS chk_journal_source_type_valid;
ALTER TABLE journal_entries ADD CONSTRAINT chk_journal_source_type_valid CHECK (
  source_type IN (
    'MANUAL', 'SALES_ORDER', 'PURCHASE_ORDER', 'INVENTORY_ADJUSTMENT', 'DEPRECIATION',
    'PAYROLL', 'BANK_TRANSACTION', 'FIXED_ASSET', 'AUTOMATED', 'GOODS_ISSUE', 'GOODS_RECEIPT',
    'WORK_ORDER_ISSUE', 'WORK_ORDER_COMPLETION', 'WORK_ORDER_VARIANCE', 'INTERCOMPANY',
    'ASSET_REVALUATION', 'AI_CONTINUOUS_CLOSE', 'YEAR_END_CLOSE', 'GR_IR_CLEARING',
    'SALES_CREDIT_NOTE', 'LANDED_COST', 'REVENUE_SCHEDULE', 'PROJECT_BILLING', 'DIRECT_INVOICE',
    'PROJECT_MILESTONE', 'FX_REVALUATION'
  )
);
