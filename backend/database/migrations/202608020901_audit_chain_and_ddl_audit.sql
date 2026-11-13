-- 202608020901 - Tamper-evident audit chain + DDL audit (ROADMAP Task 18)
--
-- pgaudit availability check (PostgreSQL 17.6 local build):
--   SELECT name FROM pg_available_extensions WHERE name = 'pgaudit';
-- returns nothing - pgaudit is NOT bundled with this PostgreSQL distribution
-- (only pgcrypto, plpgsql, pg_trgm, uuid-ossp are installed) and cannot be
-- CREATE EXTENSION'd. The closest working equivalent, with zero extension
-- dependency, is a DDL event trigger: every ddl_command_end fires
-- fn_log_ddl_event(), which records the statement into audit_ddl_log. Schema
-- changes therefore land in an append-only log exactly like pgaudit's
-- ddl-logging mode would, and the same chain verifier can be pointed at it.
--
-- Row-level protection is provided by audit_chain: every appended record
-- stores prev_hash + hash (SHA-256 over the record fields plus the previous
-- record's hash). services/auditTrailService.verifyAuditChain() walks the
-- whole log, recomputes each hash and reports the FIRST row where the chain
-- breaks - so a direct UPDATE or DELETE via SQL is detected, not just
-- prevented at the UI.

CREATE TABLE IF NOT EXISTS audit_chain (
    id          BIGSERIAL PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id   TEXT,
    from_status TEXT,
    to_status   TEXT,
    changed_by  UUID,
    reason      TEXT,
    occurred_at TIMESTAMPTZ NOT NULL,
    company_id  UUID REFERENCES companies(id),
    prev_hash   CHAR(64) NOT NULL,
    hash        CHAR(64) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_chain_occurred ON audit_chain(occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_chain_entity   ON audit_chain(entity_type, entity_id);

-- DDL audit log: every schema change, recorded by the event trigger below.
CREATE TABLE IF NOT EXISTS audit_ddl_log (
    id              BIGSERIAL PRIMARY KEY,
    ddl_tag         TEXT NOT NULL,
    object_type     TEXT NOT NULL,
    object_identity TEXT NOT NULL,
    command         TEXT NOT NULL,
    session_role    TEXT NOT NULL,
    database_name   TEXT NOT NULL,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE FUNCTION fn_log_ddl_event()
RETURNS event_trigger
LANGUAGE plpgsql
AS $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
        INSERT INTO audit_ddl_log (ddl_tag, object_type, object_identity, command)
        VALUES (TG_TAG, r.object_type, r.object_identity, r.command);
    END LOOP;
END;
$$;

-- Created LAST so nothing in this migration logs itself. Statements inside a
-- transaction that rolls back roll the log row back with them (PostgreSQL DDL
-- is transactional) - a property shared with pgaudit's transactional mode.
DROP EVENT TRIGGER IF EXISTS trg_audit_ddl;
CREATE EVENT TRIGGER trg_audit_ddl
    ON ddl_command_end
    EXECUTE FUNCTION fn_log_ddl_event();
