-- Backfill the manufacturing GL accounts (1135 Work In Progress, 5150
-- Manufacturing Variance) for every company that is missing them.
--
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- Migration 105 (manufacturing_mrp) seeded these two accounts, but with a
-- bare `WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE account_code
-- = '1135')` — no company_id filter, and migrations run exactly once. So it
-- inserted 1135/5150 for whichever single company existed at the time the
-- migration ran, and the moment that row existed anywhere, the NOT EXISTS
-- check was permanently true — every company created afterward got neither
-- account, silently.
--
-- Every other backfill for this class of bug (202608120500, then
-- 202608160300 for tenants that predated even that) reseeded the FULL
-- standard chart, but neither one's account list included 1135/5150 — they
-- were never part of "the standard chart" those migrations copied, because
-- migration 105 had (incorrectly) already handled them "globally". Both
-- routes/auth.js's seedFinanceMasterData() at signup and this migration's
-- account list have now been corrected (see models/ChartOfAccounts.js) to
-- include them; this migration is the one-time catch-up for every company
-- that signed up, or was backfilled by 202608160300, before that fix.
--
-- Symptom without this: WorkOrder.postJournal's material-issue posting
-- (Dr Work In Progress / Cr Inventory) throws "Manufacturing GL accounts
-- missing (need 1135 and 1130)" for any company other than the one that
-- happened to get 1135 from migration 105 — "Issue materials" on a RELEASED
-- work order fails with an HTTP 400 regardless of component stock on hand.
--
-- Idempotent (ON CONFLICT DO NOTHING); no-ops on a fresh database with no
-- companies yet.

INSERT INTO chart_of_accounts
  (company_id, account_code, account_name, account_type, account_subtype,
   account_level, is_header, normal_balance, status, created_by,
   allow_manual_posting, balance_sheet_section, current_balance)
SELECT c.id, v.account_code, v.account_name, v.account_type, v.account_subtype,
       v.account_level, v.is_header, v.normal_balance, v.status,
       COALESCE((SELECT uc.user_id FROM user_companies uc
                  WHERE uc.company_id = c.id AND uc.is_primary
                  ORDER BY uc.created_at LIMIT 1),
                (SELECT id FROM users ORDER BY created_at LIMIT 1)),
       v.allow_manual_posting, v.balance_sheet_section, 0
  FROM companies c
 CROSS JOIN (VALUES
    ('1135', 'Work In Progress', 'ASSET', 'CURRENT_ASSET', 3, false, 'DEBIT', 'ACTIVE', true, 'CURRENT_ASSETS'),
    ('5150', 'Manufacturing Variance', 'EXPENSE', 'COST_OF_SALES', 3, false, 'DEBIT', 'ACTIVE', true, 'EXPENSES')
 ) AS v(account_code, account_name, account_type, account_subtype, account_level,
        is_header, normal_balance, status, allow_manual_posting, balance_sheet_section)
 WHERE c.deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM users)
ON CONFLICT (company_id, account_code) DO NOTHING;
