-- Fix delegation_of_authority rows whose cost_center was seeded as the
-- literal string 'ALL' instead of NULL.
--
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- ApprovalRulesEngine.matchConditions treats an EMPTY cost_center as a
-- wildcard ("rule.cost_center is a wildcard when empty"):
--
--   const ruleCc = rule.cost_center || rule.costCenterId || null;
--   const ctxCc = context.costCenter || context.cost_center || null;
--   if (ruleCc && ctxCc && String(ruleCc) !== String(ctxCc)) return false;
--
-- Both routes/auth.js's signup starter grant and migrations 026/035 seeded
-- rows with cost_center = 'ALL' (a real, truthy string) instead of NULL. For
-- any transaction that actually carries a cost center — purchase
-- requisitions, journal entries — ruleCc='ALL' and ctxCc='CC-1000' (say) are
-- both truthy and unequal, so the condition is FALSE and the row never
-- matches. A grant that was meant to authorize everything, for every
-- amount, in every cost center, silently authorized nothing for any
-- transaction that had a real cost center attached.
--
-- This is the more foundational cause behind approvals randomly failing to
-- route (including the "Journal Entry auto-rejects" class of bug, and the
-- Delegation of Authority screen showing almost no working coverage even
-- where a general "All Transactions" grant appears to exist): the DoA rows
-- were there, they just could never actually match. Both the seed statement
-- in routes/auth.js and this backfill are now fixed to use NULL for "any
-- cost center" so the wildcard genuinely behaves like one.
--
-- Idempotent: a plain UPDATE ... WHERE, safe to run more than once.

UPDATE delegation_of_authority
   SET cost_center = NULL
 WHERE cost_center = 'ALL';
