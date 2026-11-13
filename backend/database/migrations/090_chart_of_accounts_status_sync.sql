-- 090 — Keep chart_of_accounts.status and .is_active in lockstep.
--
-- The codebase checks account usability inconsistently: newer finance code uses
-- `status = 'ACTIVE'`, older/report code uses `is_active = true`. They are
-- currently consistent, but nothing enforces that, so a future write to one flag
-- and not the other would silently make an account "active" to one query and
-- "inactive" to another. This trigger makes them a single source of truth:
--   * when `status` changes, `is_active` is derived from it;
--   * when only `is_active` changes, `status` is set to ACTIVE/INACTIVE to match.
-- `status` is the richer, authoritative field (it also carries PENDING_APPROVAL,
-- APPROVED, CLOSED), so it wins when both are touched.
-- Idempotent.

-- One-time reconciliation of any existing drift.
UPDATE chart_of_accounts SET is_active = (status = 'ACTIVE')
WHERE is_active IS DISTINCT FROM (status = 'ACTIVE');

CREATE OR REPLACE FUNCTION coa_sync_status_active()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Derive is_active from status on insert (status is the source of truth).
    NEW.is_active := (NEW.status = 'ACTIVE');
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      NEW.is_active := (NEW.status = 'ACTIVE');
    ELSIF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
      NEW.status := CASE WHEN NEW.is_active THEN 'ACTIVE' ELSE 'INACTIVE' END;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_coa_sync_status_active ON chart_of_accounts;
CREATE TRIGGER trg_coa_sync_status_active
  BEFORE INSERT OR UPDATE ON chart_of_accounts
  FOR EACH ROW EXECUTE FUNCTION coa_sync_status_active();
