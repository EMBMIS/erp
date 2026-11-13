-- Fix asset revaluation posting to two real, previously-undetected gaps.
--
-- WHAT WAS WRONG
-- ---------------------------------------------------------------------------
-- Migration 113 intended to add a dedicated 'Revaluation Surplus' equity
-- account at code 3200 (IAS 16: an upward revaluation must credit equity, not
-- profit) plus 'Impairment Loss on Assets' at 5850. Its INSERT guarded each
-- row with `WHERE NOT EXISTS (... account_code = v.code)`. Account code 3200
-- was already taken — by 'Retained Earnings', seeded for every company by
-- models/ChartOfAccounts.js's STANDARD_ACCOUNTS (used at signup and by
-- 202608120500 for the default company) — so the 3200 row silently never
-- inserted. FixedAsset.revalue() has been crediting revaluation gains
-- straight into Retained Earnings ever since: an unrealized reserve
-- commingled with realized, distributable profit, for every company that has
-- ever run a revaluation.
--
-- Separately, 5850 (Impairment Loss on Assets) was inserted by 113 but only
-- for whichever single company was "current" when that migration ran
-- (company_id fell back to its then-hardcoded per-column default, before 140
-- made it dynamic) — never added to STANDARD_ACCOUNTS. Every company created
-- since (i.e. every real tenant signup) has no 5850 at all: a downward
-- revaluation that exceeds the asset's own prior surplus (an impairment)
-- hard-fails with "account 5850 ... missing or inactive" and can never post.
--
-- THE FIX
-- ---------------------------------------------------------------------------
-- 1. A new, uncontested code (3210) for Revaluation Surplus, backfilled to
--    every existing company.
-- 2. 5850 (Impairment Loss on Assets) backfilled to every existing company
--    that is missing it.
-- 3. Both added to models/ChartOfAccounts.js's STANDARD_ACCOUNTS so every
--    future signup gets them without a follow-up migration.
-- 4. FixedAsset.revalue() switched from account_code 3200 to 3210 for the
--    equity leg (see models/FixedAsset.js).
--
-- 3200 (Retained Earnings) itself is untouched — existing revaluation
-- postings already booked there are a historical fact, not something this
-- migration tries to retroactively repost.
--
-- Idempotent: ON CONFLICT (company_id, account_code) DO NOTHING.

INSERT INTO chart_of_accounts
  (company_id, account_code, account_name, account_type, account_subtype,
   account_level, is_header, normal_balance, status, created_by,
   allow_manual_posting, balance_sheet_section)
SELECT c.id, v.account_code, v.account_name, v.account_type, v.account_subtype,
       v.account_level, v.is_header, v.normal_balance, v.status,
       (SELECT id FROM users ORDER BY created_at LIMIT 1),
       v.allow_manual_posting, v.balance_sheet_section
  FROM companies c
 CROSS JOIN (VALUES
    ('3210', 'Revaluation Surplus',       'EQUITY',  'RESERVES',          3, false, 'CREDIT', 'ACTIVE', true, 'EQUITY'),
    ('5850', 'Impairment Loss on Assets', 'EXPENSE', 'OPERATING_EXPENSE', 3, false, 'DEBIT',  'ACTIVE', true, 'OPERATING_EXPENSES')
 ) AS v(account_code, account_name, account_type, account_subtype, account_level,
        is_header, normal_balance, status, allow_manual_posting, balance_sheet_section)
 WHERE c.deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM users)
ON CONFLICT (company_id, account_code) DO NOTHING;
