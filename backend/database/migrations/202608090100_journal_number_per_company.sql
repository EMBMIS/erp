-- generate_journal_entry_number() (schema.sql) computes the next number by
-- scanning journal_entries for the current year's highest existing number.
-- journal_entries is RLS-forced on company_id = current_company_id(), so
-- under real multi-company isolation that scan only ever sees the CALLING
-- company's own rows — which is correct and desired (each tenant's document
-- numbering should be independent, not a shared global sequence two
-- unrelated companies silently contend over). But the unique constraint on
-- journal_number was still GLOBAL, so two different companies computing
-- "next number after MY highest" from their own disjoint views could both
-- land on the same value and collide on insert with 23505 — surfaced by
-- tests/consolidation.test.js once RLS was genuinely enforced (see
-- services/intercompanyService.js's fixes in the same change).
--
-- The fix is the constraint, not the function: scope uniqueness to
-- (company_id, journal_number), matching what the generator already
-- (correctly, via RLS) computes per company.
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_journal_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_company_journal_number_key
  ON journal_entries (company_id, journal_number);
