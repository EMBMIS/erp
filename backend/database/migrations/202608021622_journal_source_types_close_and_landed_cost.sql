-- chk_journal_source_type_valid is an allowlist (see 107, 113, 146). Five
-- posting paths already in the codebase use source_type values that were
-- never added to it, so each fails at insert time with a generic check-
-- constraint error the moment it's actually exercised:
--   YEAR_END_CLOSE   — routes/accounting-periods.js POST /close,
--                       routes/financial-reports.js POST /year-end-close
--   GR_IR_CLEARING   — routes/financial-reports.js POST /gr-ir-clear
--   SALES_CREDIT_NOTE — routes/credit-notes.js (sales credit note posting)
--   LANDED_COST      — services/landedCostService.js
--   REVENUE_SCHEDULE — services/revenueRecognitionService.js

ALTER TABLE journal_entries DROP CONSTRAINT chk_journal_source_type_valid;
ALTER TABLE journal_entries ADD CONSTRAINT chk_journal_source_type_valid CHECK (
  source_type IN (
    'MANUAL','SALES_ORDER','PURCHASE_ORDER','INVENTORY_ADJUSTMENT','DEPRECIATION',
    'PAYROLL','BANK_TRANSACTION','FIXED_ASSET','AUTOMATED','GOODS_ISSUE',
    'GOODS_RECEIPT','WORK_ORDER_ISSUE','WORK_ORDER_COMPLETION','WORK_ORDER_VARIANCE',
    'INTERCOMPANY','ASSET_REVALUATION','AI_CONTINUOUS_CLOSE',
    'YEAR_END_CLOSE','GR_IR_CLEARING','SALES_CREDIT_NOTE','LANDED_COST','REVENUE_SCHEDULE'
  )
);
