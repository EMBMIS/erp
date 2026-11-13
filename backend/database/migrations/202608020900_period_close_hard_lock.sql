-- 202608020900 - Period close: hard DB lock + sign-off checklist (ROADMAP Task 17)
--
-- A close that can't refuse isn't a close. This migration makes the refusal
-- structural:
--
--   1. period_close_checklist  - the pre-close checklist persisted per period
--      close: named owner + sign-off per check, so a close is auditable.
--   2. fn_guard_closed_period_posting - THE HARD LOCK. Any INSERT or UPDATE
--      touching journal_entries whose (period_year, period_month) matches a
--      CLOSED accounting_periods row is refused AT THE DATABASE, no matter
--      which code path attempts it (model, route, script, raw SQL). This is
--      the layer the UI lock in JournalEntry.create() cannot replace: it also
--      covers direct updates (e.g. flipping status to POSTED) on rows dated
--      into a closed period.
--   3. Seeds AR_CONTROL / AP_CONTROL / INVENTORY_CONTROL control-account
--      mappings for every existing company so the sub-ledger <-> GL tie
--      checks have a target account to compare against.

CREATE TABLE IF NOT EXISTS period_close_checklist (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    period_id   UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE CASCADE,
    company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    check_key   VARCHAR(80)  NOT NULL,
    check_name  VARCHAR(200) NOT NULL,
    severity    VARCHAR(10)  NOT NULL CHECK (severity IN ('BLOCKING', 'WARNING')),
    passed      BOOLEAN      NOT NULL,
    owner       VARCHAR(120) NOT NULL,
    signed_by   UUID REFERENCES users(id),
    signed_at   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_period_close_checklist UNIQUE (period_id, check_key)
);

CREATE INDEX IF NOT EXISTS idx_period_close_checklist_period  ON period_close_checklist(period_id);
CREATE INDEX IF NOT EXISTS idx_period_close_checklist_company ON period_close_checklist(company_id);

INSERT INTO company_scoped_tables (table_name) VALUES ('period_close_checklist')
ON CONFLICT (table_name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- HARD LOCK: no posting into a CLOSED period, enforced at the database layer.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_guard_closed_period_posting()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    period_status VARCHAR(10);
    period_key    TEXT;
BEGIN
    IF NEW.period_year IS NULL OR NEW.period_month IS NULL THEN
        RETURN NEW;
    END IF;

    period_key := NEW.period_year || '-' || LPAD(NEW.period_month::TEXT, 2, '0');

    SELECT status INTO period_status
      FROM accounting_periods
     WHERE period_year  = NEW.period_year
       AND period_month = NEW.period_month
       AND (NEW.company_id IS NULL OR company_id = NEW.company_id)
     LIMIT 1;

    IF period_status = 'CLOSED' THEN
        RAISE EXCEPTION
            'PZ-4001: posting into CLOSED accounting period % is refused at the database layer. Reopen the period (with a documented reason) before posting or modifying entries dated in it.',
            period_key
            USING ERRCODE = 'P0001',
                  HINT = 'journal_entries is protected by trigger fn_guard_closed_period_posting';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_closed_period_posting ON journal_entries;
CREATE TRIGGER trg_guard_closed_period_posting
    BEFORE INSERT OR UPDATE ON journal_entries
    FOR EACH ROW
    EXECUTE FUNCTION fn_guard_closed_period_posting();

-- ---------------------------------------------------------------------------
-- Seed control-account mappings (idempotent). Explicit configuration already
-- present in company_gl_mappings is never overwritten.
-- ---------------------------------------------------------------------------
INSERT INTO company_gl_mappings (company_id, purpose, account_code)
SELECT c.id, m.purpose, m.account_code
  FROM companies c
 CROSS JOIN (VALUES ('AR_CONTROL', '1200'),
                    ('AP_CONTROL', '2110'),
                    ('INVENTORY_CONTROL', '1130')) AS m(purpose, account_code)
 WHERE c.deleted_at IS NULL
ON CONFLICT (company_id, purpose) DO NOTHING;
