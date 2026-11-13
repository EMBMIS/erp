-- 138 — `posting_key`: opt-in, database-enforced idempotency for GL postings.
--
-- THE RACE THIS CLOSES
-- ===========================================================================
-- Several posting paths guard against double-posting like this:
--
--     SELECT id FROM journal_entries WHERE source_type=$1 AND source_id=$2
--     if (found) return found
--     ... create the entry ...
--
-- Check-then-act. Two requests posting the same document at the same moment
-- both run the SELECT before either INSERTs, both find nothing, and both post.
-- Revenue recognised twice, in the ledger, under concurrency only — so it
-- appears in production and never in testing. Only the database can settle it,
-- because only the database sees both transactions.
--
-- WHY NOT JUST MAKE (source_type, source_id) UNIQUE
-- ===========================================================================
-- Because that pair is legitimately many-to-one, and assuming otherwise breaks
-- correct behaviour:
--
--   • DEPRECIATION + asset_id recurs every period. An asset depreciated over
--     five years is supposed to have sixty entries.
--   • PURCHASE_ORDER + po_id covers both the PO's own posting and every
--     supplier invoice raised against it — partial billing is normal.
--
-- A blanket unique index rejects all of those. (It was tried, in the first
-- draft of this migration, and immediately failed the fixed-asset and P2P
-- tests — which were right and the index was wrong.)
--
-- WHAT THIS DOES INSTEAD
-- ===========================================================================
-- Adds a nullable `posting_key` that a caller sets when — and only when — it
-- means "this exact posting must happen at most once". NULL is the default and
-- carries no constraint, so every legitimately-repeating posting is unaffected
-- and no existing caller has to change.
--
-- The key names the posting, not the document, which is what makes it precise:
--
--     SALES_ORDER_REVENUE:<sales_order_id>
--     DEPRECIATION:<asset_id>:<year>-<month>
--     PO_EXPENSE:<purchase_order_id>
--
-- Note the depreciation key includes the period. That closes a second bug this
-- work uncovered: FixedAsset.runDepreciation had no period guard at all, so
-- running the month-end depreciation job twice posted the same month twice,
-- with nothing to prevent it. Keying by period makes the second run a no-op
-- rather than a correction someone has to find and reverse.
--
-- Reversal stays possible: soft-deleted rows are excluded, so reversing an
-- entry frees its key for a corrected repost.
--
-- Idempotent.

ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS posting_key VARCHAR(200);

COMMENT ON COLUMN journal_entries.posting_key IS
  'Optional idempotency key naming this specific posting (not the source document). '
  'Set it when a posting must happen at most once; leave NULL for postings that '
  'legitimately recur, such as periodic depreciation or partial supplier billing.';

-- Report collisions before trying to build the index, naming the journal
-- entries involved. CREATE UNIQUE INDEX would fail on its own, but with a
-- message about an index rather than about the documents that need attention.
DO $$
DECLARE
  dup RECORD;
  found_any BOOLEAN := false;
BEGIN
  FOR dup IN
    SELECT posting_key, COUNT(*) AS n,
           STRING_AGG(journal_number, ', ' ORDER BY created_at) AS entries
      FROM journal_entries
     WHERE posting_key IS NOT NULL AND deleted_at IS NULL
     GROUP BY posting_key
    HAVING COUNT(*) > 1
  LOOP
    found_any := true;
    RAISE WARNING 'Duplicate postings for key %: % entries (%).', dup.posting_key, dup.n, dup.entries;
  END LOOP;

  IF found_any THEN
    RAISE EXCEPTION
      'Cannot enforce posting-key uniqueness: duplicates already exist. See the warnings above.';
  END IF;
END $$;

-- Drop the over-broad index from this migration's first draft, if a database
-- somewhere already applied it.
DROP INDEX IF EXISTS uq_journal_entries_source;

CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_entries_posting_key
  ON journal_entries (posting_key)
  WHERE posting_key IS NOT NULL AND deleted_at IS NULL;

COMMENT ON INDEX uq_journal_entries_posting_key IS
  'At most one live journal entry per posting key. Application code checks first for a '
  'friendly answer; this is what actually prevents the double-post under concurrency.';
