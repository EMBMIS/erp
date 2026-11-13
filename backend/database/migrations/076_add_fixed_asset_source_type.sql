-- Allow FIXED_ASSET as a journal entry source_type (used by asset acquisition
-- and disposal postings). Without this the CHECK constraint rejects those
-- entries.

ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS chk_journal_source_type_valid;
ALTER TABLE journal_entries ADD CONSTRAINT chk_journal_source_type_valid
CHECK (source_type IN (
  'MANUAL', 'SALES_ORDER', 'PURCHASE_ORDER', 'INVENTORY_ADJUSTMENT',
  'DEPRECIATION', 'PAYROLL', 'BANK_TRANSACTION', 'FIXED_ASSET', 'AUTOMATED'
));
