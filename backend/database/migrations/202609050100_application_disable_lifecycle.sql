-- An application is switched off, never removed.
--
-- ===========================================================================
-- WHY THERE IS NO UNINSTALL
-- ===========================================================================
-- Applications are global and their data is company-specific. Once those two
-- facts hold, "uninstall" has no honest meaning for either half:
--
--   • The DEFINITION is shared. Other companies run it, and a marketplace will
--     offer it to more. One company removing it is not a thing that can
--     happen — at most that company stops running it.
--
--   • The DATA is this company's. A company that switches off an application
--     has not asked for its findings, its attachments, its approval history or
--     its audit trail to be destroyed, and a product that reads "switch off"
--     as "drop eleven tables" will destroy someone's quarter exactly once
--     before nobody trusts it again.
--
-- So the lifecycle is disabled/enabled, and it is the same lifecycle for a
-- capability a company designed this morning and for Finance. Re-enabling is
-- the same instance, the same tables, the same rows, still there.
--
-- Deleting a company's application data is a separate, deliberate, destructive
-- operation. It is not this, and it is deliberately not built yet.
--
-- ===========================================================================
-- WHAT CHANGES
-- ===========================================================================
-- 'disabled' replaces two states that meant almost this and were never
-- distinguishable in practice:
--
--   'uninstalled'  the old name, which promised a removal that never happened
--   'paused'       declared in the original CHECK and never once written
--
-- Both migrate to 'disabled' and neither is allowed afterwards, so there is
-- one word for one state and no dead vocabulary for a later reader to wonder
-- about.

ALTER TABLE app_company_instances DROP CONSTRAINT IF EXISTS chk_app_instances_status;

UPDATE app_company_instances
   SET status = 'disabled'
 WHERE status IN ('uninstalled', 'paused');

ALTER TABLE app_company_instances
  ADD CONSTRAINT chk_app_instances_status
  CHECK (status IN ('installing', 'active', 'updating', 'disabled', 'failed'));

-- Why a company stopped running an application, and when. Kept on the instance
-- rather than left to the event log alone because the App Library shows it on
-- the row — "switched off by Rashad on 3 March" is the first question anyone
-- asks about a capability that has gone quiet, and it should not require
-- reading an audit trail to answer.
ALTER TABLE app_company_instances
  ADD COLUMN IF NOT EXISTS disabled_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS disabled_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS disabled_reason TEXT;

COMMENT ON COLUMN app_company_instances.status IS
  'installing | active | updating | disabled | failed. There is no uninstall: '
  'disabling stops the application for this company and keeps every row.';
