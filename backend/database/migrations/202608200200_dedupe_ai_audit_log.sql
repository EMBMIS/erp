-- One-time cleanup: delete exact-duplicate ai_audit_log rows created by the
-- anthropicAdapter streaming bug fixed in the same PR (a text block before a
-- tool_use block pointed input_json_delta at the wrong array slot, silently
-- dropping the tool's arguments; the tool then ran empty-handed, didn't
-- satisfy the request, and the model retried the same call every step up to
-- the step budget). That fix stops NEW duplicates; this migration clears the
-- ones already written (reported: 90+ "AI Action — get financial summary"
-- rows, all attributed to one user, all within the same second, identical
-- payload) so the Audit Trail stops showing them.
--
-- A "duplicate" here is same actor/user/company/tool/arguments/success/
-- result/error, created within the same second — the same signature the bug
-- report used to identify them. Keeps the earliest row of each group
-- (audit-preserving: one real record of the action survives) and deletes the
-- rest. Legitimate rapid-fire identical calls are not expected to exist —
-- every real invocation carries a distinct arguments/result payload in
-- practice — but the one-second window (rather than exact-timestamp) is
-- deliberately used since that's what made these duplicates visually
-- identical in the Audit Trail in the first place.
--
-- Idempotent: a second run finds nothing left to delete.

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY company_id, actor, user_id, tool_name, arguments,
                        read_only, success, result_summary, error,
                        date_trunc('second', created_at)
           ORDER BY created_at ASC, id ASC
         ) AS rn
    FROM ai_audit_log
)
DELETE FROM ai_audit_log
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
