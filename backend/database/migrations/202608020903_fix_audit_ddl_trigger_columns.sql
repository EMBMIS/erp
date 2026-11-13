-- 202608020903 - DDL audit trigger: populate session_role / database_name.
--
-- The trigger body introduced in 202608020902 inserts only
-- (ddl_tag, object_type, object_identity), but audit_ddl_log declares
-- session_role and database_name NOT NULL, so every DDL statement failed
-- with a not-null violation. Populate them from session_user /
-- current_database().

CREATE OR REPLACE FUNCTION fn_log_ddl_event()
RETURNS event_trigger
LANGUAGE plpgsql
AS $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
        INSERT INTO audit_ddl_log (ddl_tag, object_type, object_identity,
                                   session_role, database_name)
        VALUES (TG_TAG,
                COALESCE(r.object_type, 'unknown'),
                COALESCE(r.object_identity, TG_TAG || ' (no object identity)'),
                session_user, current_database());
    END LOOP;
END;
$$;
