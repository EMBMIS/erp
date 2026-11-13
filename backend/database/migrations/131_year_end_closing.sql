-- 131 — Year-end close automation.
--
-- Adds a closing_entry_id column to accounting_periods so each closed period
-- links to the journal entry that zeroed P&L accounts into Retained Earnings (3200).
-- This makes the close auditable and enables reversal on reopen.

ALTER TABLE accounting_periods
  ADD COLUMN IF NOT EXISTS closing_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL;

COMMENT ON COLUMN accounting_periods.closing_entry_id IS
  'The journal entry that closed this period (P&L → Retained Earnings). NULL while open or before the first automated close.';
