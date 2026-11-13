-- 119 — Recalculate chart_of_accounts.current_balance from posted journal lines.
--
-- current_balance is a cached rollup. Every posting path is supposed to keep it
-- in step with the ledger, but a cache maintained by N call sites drifts the
-- moment one of them misses — and unlike a bad journal entry, drift here is
-- silent: the trial balance and balance sheet are computed from the LINES
-- (services/reportService.js BUILTINS.trial_balance, routes/financial-reports.js),
-- so they keep balancing while the account list, dashboards and any screen that
-- reads current_balance quietly disagree with them.
--
-- This restates the cache from the only thing that is authoritative: posted,
-- non-deleted journal entry lines, plus the account's opening balance.
--
-- Sign convention: journal lines are stored as raw debit/credit amounts, while
-- current_balance is held in the account's own normal-balance direction — a
-- credit-normal account with net credits carries a POSITIVE balance. Getting
-- this backwards is why a "fix" here can look plausible and invert every
-- liability on the balance sheet, so it is spelled out rather than implied.
--
-- Header accounts are excluded: they are rollup nodes that carry no postings of
-- their own, and writing a computed zero over whatever a report expects there
-- would be a different bug, not a fix.
--
-- Idempotent, and re-runnable as a repair any time drift is suspected. The
-- final predicate means a run that finds nothing wrong updates zero rows and
-- does not churn updated_at.

WITH posted_movement AS (
  SELECT jei.account_id,
         SUM(jei.debit_amount - jei.credit_amount) AS net_debit
    FROM journal_entry_items jei
    JOIN journal_entries je ON je.id = jei.journal_entry_id
   WHERE je.status = 'POSTED'
     AND je.deleted_at IS NULL
   GROUP BY jei.account_id
),
correct AS (
  SELECT coa.id,
         ROUND(
           COALESCE(coa.beginning_balance, 0)
           + CASE
               WHEN UPPER(COALESCE(coa.normal_balance, 'DEBIT')) = 'CREDIT'
               THEN -COALESCE(pm.net_debit, 0)
               ELSE  COALESCE(pm.net_debit, 0)
             END
         , 2) AS current_balance
    FROM chart_of_accounts coa
    LEFT JOIN posted_movement pm ON pm.account_id = coa.id
   WHERE coa.deleted_at IS NULL
     AND coa.is_header = false
)
UPDATE chart_of_accounts coa
   SET current_balance = correct.current_balance,
       updated_at      = CURRENT_TIMESTAMP
  FROM correct
 WHERE correct.id = coa.id
   AND coa.current_balance IS DISTINCT FROM correct.current_balance;
