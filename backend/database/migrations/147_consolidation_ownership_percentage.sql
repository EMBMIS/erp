-- Task 16 (F1 real consolidation): ownership percentage for NCI accounting.
-- parent_company_id already exists; this is the ownership share of the parent
-- in the subsidiary. Defaults to 100 (wholly owned); partly-owned subsidiaries
-- produce a Non-Controlling Interest split in the consolidated statements.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS ownership_percentage NUMERIC(5, 2) NOT NULL DEFAULT 100;

-- Backfill: any company with a parent that has no explicit share is wholly owned.
UPDATE companies
   SET ownership_percentage = 100
 WHERE ownership_percentage IS NULL;
