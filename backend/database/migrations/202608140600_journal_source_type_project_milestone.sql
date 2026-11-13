-- chk_journal_source_type_valid is an allowlist (see 202608061500 and
-- earlier). Milestone billing (Project.js Milestones.bill, PHASE3 item 4)
-- reuses CustomerInvoice.postRevenueJournal with sourceType 'PROJECT_MILESTONE'
-- to distinguish milestone-triggered revenue recognition from ordinary
-- time-and-materials project billing (PROJECT_BILLING) in any report or
-- reconciliation grouped by source_type.

ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS chk_journal_source_type_valid;
ALTER TABLE journal_entries ADD CONSTRAINT chk_journal_source_type_valid CHECK (
  source_type IN (
    'MANUAL', 'SALES_ORDER', 'PURCHASE_ORDER', 'INVENTORY_ADJUSTMENT', 'DEPRECIATION',
    'PAYROLL', 'BANK_TRANSACTION', 'FIXED_ASSET', 'AUTOMATED', 'GOODS_ISSUE', 'GOODS_RECEIPT',
    'WORK_ORDER_ISSUE', 'WORK_ORDER_COMPLETION', 'WORK_ORDER_VARIANCE', 'INTERCOMPANY',
    'ASSET_REVALUATION', 'AI_CONTINUOUS_CLOSE', 'YEAR_END_CLOSE', 'GR_IR_CLEARING',
    'SALES_CREDIT_NOTE', 'LANDED_COST', 'REVENUE_SCHEDULE', 'PROJECT_BILLING', 'DIRECT_INVOICE',
    'PROJECT_MILESTONE'
  )
);
