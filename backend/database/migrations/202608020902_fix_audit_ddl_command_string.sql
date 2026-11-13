-- 202608020902 - Fix DDL audit trigger (three problems found at apply time).
--
-- 1. pg_event_trigger_ddl_commands() exposes the executed statement as the
--    pseudo-type pg_ddl_command, which cannot be INSERTed directly ("cannot
--    display a value of type pg_ddl_command").
-- 2. This PostgreSQL 17.6 build has NO pg_get_ddl_command_string() (checked
--    pg_proc: only pg_ddl_command_in/out/recv/send exist), so the statement
--    text cannot be recovered at all.
-- 3. The live event trigger fires on EVERY ddl_command_end, including ALTER
--    TABLE on audit_ddl_log itself — so the trigger must be dropped BEFORE
--    the table is altered, or the trigger's own INSERT fails mid-change and
--    rolls the migration back.
--
-- Resolution: the audit_ddl_log `command` column is dropped and the trigger
-- logs the full pgaudit-equivalent statement metadata that IS available:
-- ddl_tag (e.g. CREATE TABLE / ALTER TABLE / DROP TABLE), object_type and
-- object_identity (schema-qualified object name), plus the session role and
-- database. This matches pgaudit's DDL-logging granularity minus the raw
-- statement text, which this build cannot produce.

-- 1. Disarm the trigger first (its function still references `command`, which
--    still exists at this point, so even a self-firing drop is harmless).
DROP EVENT TRIGGER IF EXISTS trg_audit_ddl;

-- 2. Now the table can be altered without the trigger firing mid-change.
ALTER TABLE audit_ddl_log DROP COLUMN IF EXISTS command;

-- 3. Replace the function body.
CREATE OR REPLACE FUNCTION fn_log_ddl_event()
RETURNS event_trigger
LANGUAGE plpgsql
AS $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
        INSERT INTO audit_ddl_log (ddl_tag, object_type, object_identity)
        VALUES (TG_TAG, r.object_type, r.object_identity);
    END LOOP;
END;
$$;

-- 4. Re-arm the trigger.
CREATE EVENT TRIGGER trg_audit_ddl
    ON ddl_command_end
    EXECUTE FUNCTION fn_log_ddl_event();
