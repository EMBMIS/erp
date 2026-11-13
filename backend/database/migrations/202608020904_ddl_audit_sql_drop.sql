-- 202608020904 - DDL audit: capture DROP statements via the sql_drop event.
--
-- Empirically verified on this build: at ddl_command_end,
-- pg_event_trigger_ddl_commands() returns ZERO rows for DROP TABLE (and other
-- DROP commands) — dropped objects are only exposed by the sql_drop event via
-- pg_event_trigger_dropped_objects(). The ddl_command_end trigger therefore
-- records CREATE/ALTER/... while this second trigger records every DROP, so
-- schema changes of both kinds land in audit_ddl_log.

CREATE OR REPLACE FUNCTION fn_log_sql_drop()
RETURNS event_trigger
LANGUAGE plpgsql
AS $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT * FROM pg_event_trigger_dropped_objects() LOOP
        INSERT INTO audit_ddl_log (ddl_tag, object_type, object_identity,
                                   session_role, database_name)
        VALUES (TG_TAG, r.object_type, r.object_identity,
                session_user, current_database());
    END LOOP;
END;
$$;

DROP EVENT TRIGGER IF EXISTS trg_audit_sql_drop;
CREATE EVENT TRIGGER trg_audit_sql_drop
    ON sql_drop
    EXECUTE FUNCTION fn_log_sql_drop();
