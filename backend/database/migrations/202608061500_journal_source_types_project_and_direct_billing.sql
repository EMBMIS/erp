-- CustomerInvoice.postRevenueJournal has always hardcoded source_type =
-- 'SALES_ORDER' and description "Revenue recognition - Sales Order ..." --
-- correct for its real sales-order-triggered caller (createFromSalesOrder),
-- but two OTHER callers pass a synthetic { id: null, so_number: ... } object
-- to reuse the same posting logic for invoices that are not sales orders at
-- all: CustomerInvoice.createStandalone (recurring/direct-bill invoices) and
-- Project.billProject (time-and-materials project billing, added
-- 2026-08-06). Both have been posting real, POSTED journal entries mislabeled
-- as SALES_ORDER, with a description that literally says "Sales Order" for
-- an invoice that has none -- corrupting any report or reconciliation that
-- groups revenue by source_type. Not a crash, a silent misattribution.
--
-- Widens the CHECK constraint so postRevenueJournal's now-added sourceType
-- parameter can report PROJECT_BILLING and DIRECT_INVOICE honestly instead
-- of reusing SALES_ORDER for documents that aren't one.

ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS chk_journal_source_type_valid;
ALTER TABLE journal_entries ADD CONSTRAINT chk_journal_source_type_valid CHECK (
  source_type IN (
    'MANUAL', 'SALES_ORDER', 'PURCHASE_ORDER', 'INVENTORY_ADJUSTMENT', 'DEPRECIATION',
    'PAYROLL', 'BANK_TRANSACTION', 'FIXED_ASSET', 'AUTOMATED', 'GOODS_ISSUE', 'GOODS_RECEIPT',
    'WORK_ORDER_ISSUE', 'WORK_ORDER_COMPLETION', 'WORK_ORDER_VARIANCE', 'INTERCOMPANY',
    'ASSET_REVALUATION', 'AI_CONTINUOUS_CLOSE', 'YEAR_END_CLOSE', 'GR_IR_CLEARING',
    'SALES_CREDIT_NOTE', 'LANDED_COST', 'REVENUE_SCHEDULE', 'PROJECT_BILLING', 'DIRECT_INVOICE'
  )
);
