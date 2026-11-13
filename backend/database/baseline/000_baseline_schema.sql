--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14 (Debian 16.14-1.pgdg12+1)
-- Dumped by pg_dump version 16.14 (Debian 16.14-1.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "public";


--
-- Name: EXTENSION "pg_trgm"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "pg_trgm" IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "public";


--
-- Name: EXTENSION "pgcrypto"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "pgcrypto" IS 'cryptographic functions';


--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "public";


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA "public";


--
-- Name: EXTENSION "vector"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "vector" IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: clean_chat_memory(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."clean_chat_memory"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    -- Keep only the last 10 interactions per user
    DELETE FROM chat_memory 
    WHERE user_id = NEW.user_id 
    AND deleted_at IS NULL
    AND id NOT IN (
        SELECT id FROM chat_memory 
        WHERE user_id = NEW.user_id 
        AND deleted_at IS NULL
        ORDER BY created_at DESC 
        LIMIT 10
    );
    
    RETURN NEW;
END;
$$;


--
-- Name: coa_sync_status_active(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."coa_sync_status_active"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
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
$$;


--
-- Name: company_isolation_status(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."company_isolation_status"() RETURNS TABLE("connected_as" "name", "application_role" "name", "policies_active" boolean, "role_bypasses_rls" boolean, "isolated" boolean, "company_count" integer, "advice" "text")
    LANGUAGE "sql" STABLE
    AS $$
  SELECT
    current_user,
    cfg.application_role,
    public.company_policies_active(),
    public.role_bypasses_rls(),
    public.multi_company_enabled(),
    (SELECT COUNT(*)::int FROM companies WHERE deleted_at IS NULL),
    CASE
      WHEN NOT public.company_policies_active() THEN
        'Single-company mode: isolation policies are not active. This is correct and safe while only one company exists.'
      WHEN public.role_bypasses_rls() THEN
        format('Isolation policies are active, but this connection is %I, which bypasses row-level security and therefore sees every company. Expected application role is %s.',
               current_user, COALESCE(cfg.application_role::text, '(not recorded)'))
      WHEN cfg.application_role IS NOT NULL AND cfg.application_role <> current_user THEN
        format('Isolation is in effect for this connection (%I), though the recorded application role is %I.', current_user, cfg.application_role)
      ELSE
        format('Company isolation is in effect on this connection (%I).', current_user)
    END
  FROM company_isolation_config cfg WHERE cfg.id;
$$;


--
-- Name: company_policies_active(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."company_policies_active"() RETURNS boolean
    LANGUAGE "sql" STABLE
    AS $$
  SELECT COALESCE(
    (SELECT bool_and(c.relrowsecurity AND c.relforcerowsecurity)
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN (SELECT table_name FROM company_scoped_tables)),
    false);
$$;


--
-- Name: current_company_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."current_company_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE
    AS $$
  SELECT NULLIF(current_setting('app.current_company_id', true), '')::uuid;
$$;


--
-- Name: disable_multi_company(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."disable_multi_company"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  t TEXT;
  n INT := 0;
BEGIN
  IF (SELECT COUNT(*) FROM companies WHERE deleted_at IS NULL) > 1 THEN
    RAISE EXCEPTION 'Cannot disable company isolation while % companies exist — every user would immediately see every company''s data.',
      (SELECT COUNT(*) FROM companies WHERE deleted_at IS NULL);
  END IF;

  FOR t IN SELECT table_name FROM company_scoped_tables ORDER BY table_name LOOP
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
    n := n + 1;
  END LOOP;

  RETURN format('Row-level company isolation disabled on %s tables.', n);
END $$;


--
-- Name: enable_multi_company(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."enable_multi_company"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF public.role_bypasses_rls() THEN
    RAISE EXCEPTION
      'Refusing to enable company isolation from role % — it bypasses row-level security. Either connect as the unprivileged application role, or name that role explicitly: SELECT enable_multi_company(''your_app_role'');',
      current_user;
  END IF;
  RETURN public.enable_multi_company(current_user::name);
END $$;


--
-- Name: enable_multi_company("name"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."enable_multi_company"("app_role" "name") RETURNS "text"
    LANGUAGE "plpgsql"
    AS $_$
DECLARE
  t TEXT;
  n INT := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    RAISE EXCEPTION 'Role % does not exist. Create the application role before enabling company isolation (see migration 111 for the required grants).', app_role;
  END IF;

  IF NOT (SELECT rolcanlogin FROM pg_roles WHERE rolname = app_role) THEN
    RAISE EXCEPTION 'Role % cannot log in, so it cannot be the application role.', app_role;
  END IF;

  -- The check that matters. A role with BYPASSRLS would sail through every
  -- policy below while the system reported itself isolated.
  IF public.role_bypasses_rls(app_role) THEN
    RAISE EXCEPTION
      'Role % is a superuser or holds BYPASSRLS (possibly inherited from a group), so row-level security would not restrict it. Company isolation would be reported as active while isolating nothing. Use a role without those attributes.',
      app_role;
  END IF;

  FOR t IN SELECT table_name FROM company_scoped_tables ORDER BY table_name LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE so that the owner is covered too, for any path that does connect
    -- as the owner.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS company_isolation ON %I', t);
    EXECUTE format($p$
      CREATE POLICY company_isolation ON %I
        USING (company_id = public.current_company_id())
        WITH CHECK (company_id = public.current_company_id())
    $p$, t);
    n := n + 1;
  END LOOP;

  UPDATE company_isolation_config
     SET application_role = app_role,
         enabled_at = CURRENT_TIMESTAMP,
         enabled_by = current_user
   WHERE id;

  RETURN format(
    'Company isolation enabled on %s tables, enforced for role %I. Point the application''s connection at %I — a connection as %I or any other superuser is NOT isolated.',
    n, app_role, app_role, current_user);
END $_$;


--
-- Name: fn_guard_closed_period_posting(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."fn_guard_closed_period_posting"() RETURNS "trigger"
    LANGUAGE "plpgsql"
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


--
-- Name: fn_log_ddl_event(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."fn_log_ddl_event"() RETURNS "event_trigger"
    LANGUAGE "plpgsql"
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


--
-- Name: fn_log_sql_drop(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."fn_log_sql_drop"() RETURNS "event_trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT * FROM pg_event_trigger_dropped_objects() LOOP
        INSERT INTO audit_ddl_log (ddl_tag, object_type, object_identity, session_role, database_name)
        VALUES (TG_TAG,
                COALESCE(r.object_type, 'unknown'),
                COALESCE(r.object_identity, TG_TAG || ' (no object identity)'),
                session_user,
                current_database());
    END LOOP;
END;
$$;


--
-- Name: generate_asset_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."generate_asset_number"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $_$
DECLARE
    year_part TEXT;
    next_number INTEGER;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('generate_asset_number'));
    year_part := EXTRACT(YEAR FROM CURRENT_DATE)::TEXT;
    SELECT COALESCE(MAX(
        CASE WHEN asset_number ~ ('^FA-' || year_part || '-[0-9]+$')
             THEN SUBSTRING(asset_number FROM ('\-([0-9]+)$'))::INTEGER ELSE 0 END
    ), 0) + 1 INTO next_number FROM fixed_assets;
    RETURN 'FA-' || year_part || '-' || LPAD(next_number::TEXT, 6, '0');
END;
$_$;


--
-- Name: generate_bom_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."generate_bom_number"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $_$
DECLARE
    next_number INTEGER;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('generate_bom_number'));
    SELECT COALESCE(MAX(
        CASE WHEN bom_number ~ '^BOM-[0-9]+$'
             THEN SUBSTRING(bom_number FROM '\-([0-9]+)$')::INTEGER ELSE 0 END
    ), 0) + 1 INTO next_number FROM bills_of_material;
    RETURN 'BOM-' || LPAD(next_number::TEXT, 6, '0');
END;
$_$;


--
-- Name: generate_contract_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."generate_contract_number"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    RETURN 'CNT-' || TO_CHAR(CURRENT_DATE, 'YYYY') || '-' || LPAD(nextval('contract_number_seq')::TEXT, 4, '0');
END;
$$;


--
-- Name: generate_cost_center_code(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."generate_cost_center_code"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $_$
DECLARE
    next_number INTEGER;
BEGIN
    SELECT COALESCE(MAX(
        CASE WHEN code ~ '^CC-[0-9]+$' THEN SUBSTRING(code FROM '\-([0-9]+)$')::INTEGER ELSE 0 END
    ), 0) + 1 INTO next_number FROM cost_centers;
    RETURN 'CC-' || LPAD(next_number::TEXT, 4, '0');
END;
$_$;


--
-- Name: generate_deal_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."generate_deal_number"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $_$
DECLARE next_number INTEGER;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('generate_deal_number'));
    SELECT COALESCE(MAX(
        CASE WHEN deal_number ~ '^DEAL-[0-9]+$'
             THEN SUBSTRING(deal_number FROM '\-([0-9]+)$')::INTEGER ELSE 0 END
    ), 0) + 1 INTO next_number FROM deals;
    RETURN 'DEAL-' || LPAD(next_number::TEXT, 6, '0');
END;
$_$;


--
-- Name: generate_employee_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."generate_employee_number"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $_$
DECLARE
    next_number INTEGER;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('generate_employee_number'));
    SELECT COALESCE(MAX(
        CASE WHEN employee_number ~ '^EMP-[0-9]+$' THEN SUBSTRING(employee_number FROM '\-([0-9]+)$')::INTEGER ELSE 0 END
    ), 0) + 1 INTO next_number FROM employees;
    RETURN 'EMP-' || LPAD(next_number::TEXT, 4, '0');
END;
$_$;


--
-- Name: generate_intercompany_reference(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."generate_intercompany_reference"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $_$
DECLARE next_number INTEGER;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('generate_intercompany_reference'));
    SELECT COALESCE(MAX(
        CASE WHEN reference ~ '^IC-[0-9]+$'
             THEN SUBSTRING(reference FROM '\-([0-9]+)$')::INTEGER ELSE 0 END
    ), 0) + 1 INTO next_number FROM intercompany_transactions;
    RETURN 'IC-' || LPAD(next_number::TEXT, 6, '0');
END;
$_$;


--
-- Name: generate_inventory_code(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."generate_inventory_code"() RETURNS character varying
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    next_number BIGINT;
    code_length INTEGER;
    formatted_number VARCHAR(50);
BEGIN
    -- Get next sequence value
    SELECT nextval('inventory_code_seq') INTO next_number;
    
    -- Determine required padding based on number size
    IF next_number <= 99999999 THEN
        code_length := 8;
    ELSIF next_number <= 999999999 THEN
        code_length := 9;
    ELSIF next_number <= 9999999999 THEN
        code_length := 10;
    ELSIF next_number <= 99999999999 THEN
        code_length := 11;
    ELSE
        code_length := 12; -- Support up to 12 digits
    END IF;
    
    -- Format number with leading zeros
    formatted_number := LPAD(next_number::TEXT, code_length, '0');
    
    -- Return INV- prefix with formatted number
    RETURN 'INV-' || formatted_number;
END;
$$;


--
-- Name: FUNCTION "generate_inventory_code"(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION "public"."generate_inventory_code"() IS 'Function to generate INV-XXXXXXXX codes with auto-expanding length';


--
-- Name: generate_invoice_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."generate_invoice_number"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $_$
DECLARE
    year_part TEXT;
    next_number INTEGER;
    new_number TEXT;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('generate_invoice_number'));
    year_part := EXTRACT(YEAR FROM CURRENT_DATE)::TEXT;
    
    SELECT COALESCE(MAX(
        CASE 
            WHEN invoice_number ~ ('^INV-' || year_part || '-[0-9]+$')
            THEN SUBSTRING(invoice_number FROM ('\-([0-9]+)$'))::INTEGER
            ELSE 0
        END
    ), 0) + 1 INTO next_number
    FROM customer_invoices;
    
    new_number := 'INV-' || year_part || '-' || LPAD(next_number::TEXT, 6, '0');
    
    RETURN new_number;
END;
$_$;


--
-- Name: generate_journal_entry_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."generate_journal_entry_number"() RETURNS character varying
    LANGUAGE "plpgsql"
    AS $$
#variable_conflict use_column
DECLARE
    next_number INTEGER;
    year_suffix VARCHAR(4);
    v_journal_number VARCHAR(50);
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('generate_journal_entry_number'));

    year_suffix := TO_CHAR(CURRENT_DATE, 'YYYY');

    SELECT COALESCE(MAX(CAST(SUBSTRING(je.journal_number FROM 'JE-' || year_suffix || '-(\d+)') AS INTEGER)), 0) + 1
    INTO next_number
    FROM journal_entries je
    WHERE je.journal_number LIKE 'JE-' || year_suffix || '-%';

    v_journal_number := 'JE-' || year_suffix || '-' || LPAD(next_number::TEXT, 6, '0');

    RETURN v_journal_number;
END;
$$;


--
-- Name: generate_payment_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."generate_payment_number"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $_$
DECLARE
    year_part TEXT;
    next_number INTEGER;
    new_number TEXT;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('generate_payment_number'));
    year_part := EXTRACT(YEAR FROM CURRENT_DATE)::TEXT;
    
    SELECT COALESCE(MAX(
        CASE 
            WHEN payment_number ~ ('^PAY-' || year_part || '-[0-9]+$')
            THEN SUBSTRING(payment_number FROM ('\-([0-9]+)$'))::INTEGER
            ELSE 0
        END
    ), 0) + 1 INTO next_number
    FROM customer_payments;
    
    new_number := 'PAY-' || year_part || '-' || LPAD(next_number::TEXT, 6, '0');
    
    RETURN new_number;
END;
$_$;


--
-- Name: generate_po_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."generate_po_number"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    RETURN 'PO-' || TO_CHAR(CURRENT_DATE, 'YYYY') || '-' || LPAD(nextval('po_number_seq')::TEXT, 4, '0');
END;
$$;


--
-- Name: generate_pr_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."generate_pr_number"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    RETURN 'PR-' || TO_CHAR(CURRENT_DATE, 'YYYY') || '-' || LPAD(nextval('pr_number_seq')::TEXT, 4, '0');
END;
$$;


--
-- Name: generate_procurement_rfq_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."generate_procurement_rfq_number"() RETURNS character varying
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    next_number INTEGER;
    rfq_number VARCHAR(50);
BEGIN
    SELECT nextval('procurement_rfq_seq') INTO next_number;
    rfq_number := 'RFQ-' || TO_CHAR(EXTRACT(YEAR FROM CURRENT_DATE), 'FM0000') || '-' || LPAD(next_number::TEXT, 4, '0');
    RETURN rfq_number;
END;
$$;


--
-- Name: generate_project_code(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."generate_project_code"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $_$
DECLARE next_number INTEGER;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('generate_project_code'));
    SELECT COALESCE(MAX(
        CASE WHEN project_code ~ '^PRJ-[0-9]+$'
             THEN SUBSTRING(project_code FROM '\-([0-9]+)$')::INTEGER ELSE 0 END
    ), 0) + 1 INTO next_number FROM projects;
    RETURN 'PRJ-' || LPAD(next_number::TEXT, 4, '0');
END;
$_$;


--
-- Name: generate_rfq_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."generate_rfq_number"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    RETURN 'RFQ-' || TO_CHAR(CURRENT_DATE, 'YYYY') || '-' || LPAD(nextval('rfq_number_seq')::TEXT, 4, '0');
END;
$$;


--
-- Name: generate_sales_rfq_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."generate_sales_rfq_number"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $_$
DECLARE
    next_number INTEGER;
    new_rfq_number TEXT;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('generate_sales_rfq_number'));
    -- Get the next sequence number by explicitly referencing the table column
    SELECT COALESCE(MAX(CAST(SUBSTRING(sales_rfqs.rfq_number FROM 'SRFQ-(.*)') AS INTEGER)), 0) + 1
    INTO next_number
    FROM sales_rfqs
    WHERE sales_rfqs.rfq_number ~ '^SRFQ-[0-9]+$';
    
    -- Format as SRFQ-000001
    new_rfq_number := 'SRFQ-' || LPAD(next_number::TEXT, 6, '0');
    
    RETURN new_rfq_number;
END;
$_$;


--
-- Name: generate_supplier_bill_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."generate_supplier_bill_number"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $_$
DECLARE
    year_part TEXT;
    next_number INTEGER;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('generate_supplier_bill_number'));
    year_part := EXTRACT(YEAR FROM CURRENT_DATE)::TEXT;
    SELECT COALESCE(MAX(
        CASE WHEN bill_number ~ ('^BILL-' || year_part || '-[0-9]+$')
             THEN SUBSTRING(bill_number FROM ('\-([0-9]+)$'))::INTEGER ELSE 0 END
    ), 0) + 1 INTO next_number FROM supplier_invoices;
    RETURN 'BILL-' || year_part || '-' || LPAD(next_number::TEXT, 6, '0');
END;
$_$;


--
-- Name: generate_supplier_code(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."generate_supplier_code"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    RETURN 'SUP-' || LPAD(nextval('supplier_code_seq')::TEXT, 6, '0');
END;
$$;


--
-- Name: generate_supplier_payment_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."generate_supplier_payment_number"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $_$
DECLARE
    year_part TEXT;
    next_number INTEGER;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('generate_supplier_payment_number'));
    year_part := EXTRACT(YEAR FROM CURRENT_DATE)::TEXT;
    SELECT COALESCE(MAX(
        CASE WHEN payment_number ~ ('^SPY-' || year_part || '-[0-9]+$')
             THEN SUBSTRING(payment_number FROM ('\-([0-9]+)$'))::INTEGER ELSE 0 END
    ), 0) + 1 INTO next_number FROM supplier_payments;
    RETURN 'SPY-' || year_part || '-' || LPAD(next_number::TEXT, 6, '0');
END;
$_$;


--
-- Name: generate_transfer_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."generate_transfer_number"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $_$
DECLARE
    year_part TEXT;
    next_number INTEGER;
BEGIN
    year_part := EXTRACT(YEAR FROM CURRENT_DATE)::TEXT;
    PERFORM pg_advisory_xact_lock(hashtext('generate_transfer_number'));
    SELECT COALESCE(MAX(
        CASE WHEN transfer_number ~ ('^XFER-' || year_part || '-[0-9]+$')
             THEN SUBSTRING(transfer_number FROM ('\-([0-9]+)$'))::INTEGER ELSE 0 END
    ), 0) + 1 INTO next_number FROM inventory_transfers;
    RETURN 'XFER-' || year_part || '-' || LPAD(next_number::TEXT, 6, '0');
END;
$_$;


--
-- Name: generate_warehouse_transaction_number(character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."generate_warehouse_transaction_number"("transaction_type" character varying) RETURNS character varying
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    next_val INTEGER;
    year_part VARCHAR(4);
    type_prefix VARCHAR(2);
BEGIN
    -- Get next sequence value
    SELECT nextval('warehouse_transaction_number_seq') INTO next_val;
    
    -- Get current year
    SELECT EXTRACT(YEAR FROM CURRENT_DATE)::VARCHAR INTO year_part;
    
    -- Return formatted transaction number
    RETURN transaction_type || '-' || year_part || '-' || LPAD(next_val::VARCHAR, 6, '0');
END;
$$;


--
-- Name: generate_work_order_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."generate_work_order_number"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $_$
DECLARE
    year_part TEXT;
    next_number INTEGER;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('generate_work_order_number'));
    year_part := EXTRACT(YEAR FROM CURRENT_DATE)::TEXT;
    SELECT COALESCE(MAX(
        CASE WHEN wo_number ~ ('^WO-' || year_part || '-[0-9]+$')
             THEN SUBSTRING(wo_number FROM '\-([0-9]+)$')::INTEGER ELSE 0 END
    ), 0) + 1 INTO next_number FROM work_orders;
    RETURN 'WO-' || year_part || '-' || LPAD(next_number::TEXT, 6, '0');
END;
$_$;


--
-- Name: guard_company_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."guard_company_insert"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF (SELECT COUNT(*) FROM companies WHERE deleted_at IS NULL) < 1 THEN
    RETURN NEW;  -- first company, nothing to isolate from
  END IF;

  IF NOT public.company_policies_active() THEN
    RAISE EXCEPTION
      'Refusing to create a second company while isolation policies are off — both companies would share every table with nothing separating them. Run SELECT enable_multi_company(''your_app_role''); first.';
  END IF;

  IF public.role_bypasses_rls() THEN
    RAISE EXCEPTION
      'Refusing to create a second company from role %, which bypasses row-level security. Create it from the application''s own (unprivileged) connection, so the boundary is exercised by the same role that will enforce it.',
      current_user;
  END IF;

  RETURN NEW;
END $$;


--
-- Name: multi_company_enabled(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."multi_company_enabled"() RETURNS boolean
    LANGUAGE "sql" STABLE
    AS $$
  SELECT public.company_policies_active() AND NOT public.role_bypasses_rls();
$$;


--
-- Name: FUNCTION "multi_company_enabled"(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION "public"."multi_company_enabled"() IS 'True only when the isolation policies are active AND the connecting role is actually subject to them. A superuser connection reports false, because it is not isolated.';


--
-- Name: role_bypasses_rls(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."role_bypasses_rls"() RETURNS boolean
    LANGUAGE "sql" STABLE
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_roles r
     WHERE (r.rolsuper OR r.rolbypassrls)
       AND pg_has_role(current_user, r.oid, 'USAGE')
  );
$$;


--
-- Name: role_bypasses_rls("name"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."role_bypasses_rls"("target" "name") RETURNS boolean
    LANGUAGE "sql" STABLE
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_roles r
     WHERE (r.rolsuper OR r.rolbypassrls)
       AND pg_has_role(target, r.oid, 'USAGE')
  );
$$;


--
-- Name: set_procurement_rfq_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."set_procurement_rfq_number"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    IF NEW.rfq_number IS NULL OR NEW.rfq_number = '' THEN
        NEW.rfq_number := generate_procurement_rfq_number();
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: set_warehouse_transaction_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."set_warehouse_transaction_number"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    -- Only set transaction number if it's not already set
    IF NEW.transaction_number IS NULL OR NEW.transaction_number = '' THEN
        NEW.transaction_number := generate_warehouse_transaction_number(NEW.transaction_type);
    END IF;
    
    -- Update updated_at timestamp
    NEW.updated_at := CURRENT_TIMESTAMP;
    
    RETURN NEW;
END;
$$;


--
-- Name: update_sales_order_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."update_sales_order_timestamp"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;


--
-- Name: update_sales_rfqs_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."update_sales_rfqs_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;


--
-- Name: update_storage_capacity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."update_storage_capacity"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    -- Update bin capacity if bin_id is specified
    IF NEW.bin_id IS NOT NULL THEN
        UPDATE bins 
        SET 
            current_mass_used = COALESCE((
                SELECT SUM(ism.quantity_in_location * COALESCE(i.mass_per_uom, 0))
                FROM inventory_storage_mappings ism
                JOIN inventory_items ii ON ism.inventory_item_id = ii.id
                JOIN items i ON ii.item_master_id = i.id
                WHERE ism.bin_id = NEW.bin_id
            ), 0),
            current_volume_used = COALESCE((
                SELECT SUM(ism.quantity_in_location * COALESCE(i.volume_per_uom, 0))
                FROM inventory_storage_mappings ism
                JOIN inventory_items ii ON ism.inventory_item_id = ii.id
                JOIN items i ON ii.item_master_id = i.id
                WHERE ism.bin_id = NEW.bin_id
            ), 0)
        WHERE id = NEW.bin_id;
    END IF;
    
    -- Update storage location capacity
    UPDATE storage_locations 
    SET 
        current_mass_used = COALESCE((
            SELECT SUM(ism.quantity_in_location * COALESCE(i.mass_per_uom, 0))
            FROM inventory_storage_mappings ism
            JOIN inventory_items ii ON ism.inventory_item_id = ii.id
            JOIN items i ON ii.item_master_id = i.id
            WHERE ism.storage_location_id = NEW.storage_location_id
        ), 0),
        current_volume_used = COALESCE((
            SELECT SUM(ism.quantity_in_location * COALESCE(i.volume_per_uom, 0))
            FROM inventory_storage_mappings ism
            JOIN inventory_items ii ON ism.inventory_item_id = ii.id
            JOIN items i ON ii.item_master_id = i.id
            WHERE ism.storage_location_id = NEW.storage_location_id
        ), 0)
    WHERE id = NEW.storage_location_id;
    
    RETURN NEW;
END;
$$;


--
-- Name: update_storage_capacity_on_delete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."update_storage_capacity_on_delete"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    -- Update bin capacity if bin_id was specified
    IF OLD.bin_id IS NOT NULL THEN
        UPDATE bins 
        SET 
            current_mass_used = COALESCE((
                SELECT SUM(ism.quantity_in_location * COALESCE(i.mass_per_uom, 0))
                FROM inventory_storage_mappings ism
                JOIN inventory_items ii ON ism.inventory_item_id = ii.id
                JOIN items i ON ii.item_master_id = i.id
                WHERE ism.bin_id = OLD.bin_id
            ), 0),
            current_volume_used = COALESCE((
                SELECT SUM(ism.quantity_in_location * COALESCE(i.volume_per_uom, 0))
                FROM inventory_storage_mappings ism
                JOIN inventory_items ii ON ism.inventory_item_id = ii.id
                JOIN items i ON ii.item_master_id = i.id
                WHERE ism.bin_id = OLD.bin_id
            ), 0)
        WHERE id = OLD.bin_id;
    END IF;
    
    -- Update storage location capacity
    UPDATE storage_locations 
    SET 
        current_mass_used = COALESCE((
            SELECT SUM(ism.quantity_in_location * COALESCE(i.mass_per_uom, 0))
            FROM inventory_storage_mappings ism
            JOIN inventory_items ii ON ism.inventory_item_id = ii.id
            JOIN items i ON ii.item_master_id = i.id
            WHERE ism.storage_location_id = OLD.storage_location_id
        ), 0),
        current_volume_used = COALESCE((
            SELECT SUM(ism.quantity_in_location * COALESCE(i.volume_per_uom, 0))
            FROM inventory_storage_mappings ism
            JOIN inventory_items ii ON ism.inventory_item_id = ii.id
            JOIN items i ON ii.item_master_id = i.id
            WHERE ism.storage_location_id = OLD.storage_location_id
        ), 0)
    WHERE id = OLD.storage_location_id;
    
    RETURN OLD;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;


--
-- Name: update_warehouse_transaction_item_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."update_warehouse_transaction_item_timestamp"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    NEW.updated_at := CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = "heap";

--
-- Name: accounting_periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."accounting_periods" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "period_year" integer NOT NULL,
    "period_month" integer NOT NULL,
    "status" character varying(10) DEFAULT 'OPEN'::character varying NOT NULL,
    "closed_by" "uuid",
    "closed_at" timestamp with time zone,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    "closing_entry_id" "uuid",
    CONSTRAINT "chk_period_month" CHECK ((("period_month" >= 1) AND ("period_month" <= 12))),
    CONSTRAINT "chk_period_status" CHECK ((("status")::"text" = ANY (ARRAY[('OPEN'::character varying)::"text", ('CLOSED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."accounting_periods" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "accounting_periods"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."accounting_periods" IS 'Monthly accounting periods; CLOSED periods lock GL postings';


--
-- Name: COLUMN "accounting_periods"."closing_entry_id"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."accounting_periods"."closing_entry_id" IS 'The journal entry that closed this period (P&L → Retained Earnings). NULL while open or before the first automated close.';


--
-- Name: activities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."activities" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "activity_type" character varying(20) DEFAULT 'TASK'::character varying NOT NULL,
    "subject" character varying(200) NOT NULL,
    "notes" "text",
    "due_date" "date",
    "completed_at" timestamp with time zone,
    "contact_id" "uuid",
    "deal_id" "uuid",
    "customer_id" "uuid",
    "owner_id" "uuid",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    "lead_id" "uuid",
    CONSTRAINT "activities_activity_type_check" CHECK ((("activity_type")::"text" = ANY (ARRAY[('CALL'::character varying)::"text", ('EMAIL'::character varying)::"text", ('MEETING'::character varying)::"text", ('TASK'::character varying)::"text", ('NOTE'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."activities" FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN "activities"."lead_id"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."activities"."lead_id" IS 'Optional lead this activity is logged against (calls, emails, notes during qualification) — counted as an engagement signal by services/crm/leadScoring.js.';


--
-- Name: agent_blueprint_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."agent_blueprint_versions" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "blueprint_id" "uuid" NOT NULL,
    "version" integer NOT NULL,
    "snapshot" "jsonb" NOT NULL,
    "note" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: agent_blueprints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."agent_blueprints" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "agent_key" character varying(80) NOT NULL,
    "display_name" character varying(160) NOT NULL,
    "description" "text",
    "domain" character varying(40) DEFAULT 'DATA'::character varying NOT NULL,
    "trigger_type" character varying(16) DEFAULT 'manual'::character varying NOT NULL,
    "event_key" character varying(80),
    "schedule_seconds" integer,
    "steps" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "config" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "config_schema" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "source_prompt" "text",
    "version" integer DEFAULT 1 NOT NULL,
    "created_by" "uuid",
    "updated_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "kind" character varying(16) DEFAULT 'pipeline'::character varying NOT NULL,
    "goal" "text",
    "provider" character varying(24) DEFAULT 'anthropic'::character varying,
    "model" character varying(80),
    "effort" character varying(12) DEFAULT 'high'::character varying,
    "credential_id" "uuid",
    "allowed_tools" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "max_iterations" integer DEFAULT 20 NOT NULL,
    "memory_enabled" boolean DEFAULT true NOT NULL,
    "escalation_rules" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "agent_blueprints_agent_key_check" CHECK ((("agent_key")::"text" ~ '^[a-z][a-z0-9_]{2,79}$'::"text")),
    CONSTRAINT "agent_blueprints_effort_check" CHECK ((("effort")::"text" = ANY (ARRAY[('low'::character varying)::"text", ('medium'::character varying)::"text", ('high'::character varying)::"text", ('xhigh'::character varying)::"text", ('max'::character varying)::"text"]))),
    CONSTRAINT "agent_blueprints_kind_check" CHECK ((("kind")::"text" = ANY (ARRAY[('ai'::character varying)::"text", ('pipeline'::character varying)::"text"]))),
    CONSTRAINT "agent_blueprints_kind_requirements" CHECK ((((("kind")::"text" = 'ai'::"text") AND ("goal" IS NOT NULL) AND ("length"("btrim"("goal")) > 0)) OR ((("kind")::"text" = 'pipeline'::"text") AND ("jsonb_array_length"("steps") > 0)))),
    CONSTRAINT "agent_blueprints_max_iterations_check" CHECK ((("max_iterations" >= 1) AND ("max_iterations" <= 100))),
    CONSTRAINT "agent_blueprints_provider_check" CHECK ((("provider")::"text" = ANY (ARRAY[('anthropic'::character varying)::"text", ('openai'::character varying)::"text"]))),
    CONSTRAINT "agent_blueprints_trigger_type_check" CHECK ((("trigger_type")::"text" = ANY (ARRAY[('schedule'::character varying)::"text", ('event'::character varying)::"text", ('manual'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."agent_blueprints" FORCE ROW LEVEL SECURITY;


--
-- Name: agent_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."agent_credentials" (
    "agent_key" character varying(80) NOT NULL,
    "credential_id" "uuid" NOT NULL,
    "granted_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL
);

ALTER TABLE ONLY "public"."agent_credentials" FORCE ROW LEVEL SECURITY;


--
-- Name: agent_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."agent_definitions" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "agent_key" character varying(80) NOT NULL,
    "display_name" character varying(160) NOT NULL,
    "description" "text",
    "domain" character varying(40) NOT NULL,
    "mode" character varying(16) DEFAULT 'observe'::character varying NOT NULL,
    "enabled" boolean DEFAULT false NOT NULL,
    "schedule_seconds" integer,
    "next_run_at" timestamp with time zone,
    "last_run_at" timestamp with time zone,
    "authority" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "config" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "failure_count" integer DEFAULT 0 NOT NULL,
    "last_error" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "agent_definitions_mode_check" CHECK ((("mode")::"text" = ANY (ARRAY[('observe'::character varying)::"text", ('propose'::character varying)::"text", ('act'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."agent_definitions" FORCE ROW LEVEL SECURITY;


--
-- Name: agent_escalations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."agent_escalations" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "run_id" "uuid",
    "agent_key" character varying(80) NOT NULL,
    "reason" character varying(40) NOT NULL,
    "title" character varying(200) NOT NULL,
    "detail" "text" NOT NULL,
    "proposed_action" character varying(60),
    "entity_type" character varying(60),
    "entity_id" "uuid",
    "amount" numeric(15,2),
    "currency" character varying(3),
    "status" character varying(20) DEFAULT 'OPEN'::character varying NOT NULL,
    "resolved_by" "uuid",
    "resolved_at" timestamp with time zone,
    "resolution_note" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "agent_escalations_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('OPEN'::character varying)::"text", ('APPROVED'::character varying)::"text", ('REJECTED'::character varying)::"text", ('EXPIRED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."agent_escalations" FORCE ROW LEVEL SECURITY;


--
-- Name: agent_memory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."agent_memory" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "agent_key" character varying(80) NOT NULL,
    "key" character varying(160) NOT NULL,
    "value" "jsonb" NOT NULL,
    "note" "text",
    "run_id" "uuid",
    "hit_count" integer DEFAULT 0 NOT NULL,
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL
);

ALTER TABLE ONLY "public"."agent_memory" FORCE ROW LEVEL SECURITY;


--
-- Name: agent_paused_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."agent_paused_runs" (
    "id" "uuid" NOT NULL,
    "user_id" character varying(100) NOT NULL,
    "state" "jsonb" NOT NULL,
    "pending_tools" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL
);

ALTER TABLE ONLY "public"."agent_paused_runs" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "agent_paused_runs"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."agent_paused_runs" IS 'Agent runs suspended awaiting human confirmation. Short-lived: deleted on resume, swept after expires_at. Replaces a process-local Map that could not survive a restart or work behind more than one instance.';


--
-- Name: agent_run_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."agent_run_actions" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "run_id" "uuid" NOT NULL,
    "agent_key" character varying(80) NOT NULL,
    "sequence" integer NOT NULL,
    "action_type" character varying(60) NOT NULL,
    "entity_type" character varying(60),
    "entity_id" "uuid",
    "entity_label" character varying(200),
    "amount" numeric(15,2),
    "currency" character varying(3),
    "decision" character varying(24) NOT NULL,
    "rationale" "text" NOT NULL,
    "outcome" "jsonb",
    "error" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "agent_run_actions_decision_check" CHECK ((("decision")::"text" = ANY (ARRAY[('acted'::character varying)::"text", ('proposed'::character varying)::"text", ('escalated'::character varying)::"text", ('skipped'::character varying)::"text", ('failed'::character varying)::"text", ('observed'::character varying)::"text"])))
);


--
-- Name: agent_run_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."agent_run_messages" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "run_id" "uuid" NOT NULL,
    "agent_key" character varying(80) NOT NULL,
    "sequence" integer NOT NULL,
    "role" character varying(16) NOT NULL,
    "content" "text",
    "tool_name" character varying(80),
    "tool_input" "jsonb",
    "tool_output" "jsonb",
    "verdict" character varying(16),
    "tokens_in" integer,
    "tokens_out" integer,
    "duration_ms" integer,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "agent_run_messages_role_check" CHECK ((("role")::"text" = ANY (ARRAY[('system'::character varying)::"text", ('user'::character varying)::"text", ('assistant'::character varying)::"text", ('tool'::character varying)::"text", ('thinking'::character varying)::"text", ('error'::character varying)::"text"])))
);


--
-- Name: agent_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."agent_runs" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "agent_id" "uuid" NOT NULL,
    "agent_key" character varying(80) NOT NULL,
    "trigger" character varying(24) DEFAULT 'schedule'::character varying NOT NULL,
    "triggered_by" "uuid",
    "status" character varying(20) DEFAULT 'RUNNING'::character varying NOT NULL,
    "mode" character varying(16) NOT NULL,
    "dry_run" boolean DEFAULT false NOT NULL,
    "observations" integer DEFAULT 0 NOT NULL,
    "actions_taken" integer DEFAULT 0 NOT NULL,
    "escalations" integer DEFAULT 0 NOT NULL,
    "errors" integer DEFAULT 0 NOT NULL,
    "summary" "text",
    "error" "text",
    "started_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "finished_at" timestamp with time zone,
    "duration_ms" integer,
    "tokens_in" integer DEFAULT 0 NOT NULL,
    "tokens_out" integer DEFAULT 0 NOT NULL,
    "iterations" integer DEFAULT 0 NOT NULL,
    "model" character varying(80),
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "agent_runs_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('RUNNING'::character varying)::"text", ('SUCCEEDED'::character varying)::"text", ('FAILED'::character varying)::"text", ('PARTIAL'::character varying)::"text", ('SKIPPED'::character varying)::"text"]))),
    CONSTRAINT "agent_runs_trigger_check" CHECK ((("trigger")::"text" = ANY (ARRAY[('schedule'::character varying)::"text", ('manual'::character varying)::"text", ('event'::character varying)::"text", ('chain'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."agent_runs" FORCE ROW LEVEL SECURITY;


--
-- Name: ai_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ai_audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "actor" character varying(50) DEFAULT 'ai-agent'::character varying NOT NULL,
    "user_id" "uuid",
    "tool_name" character varying(100) NOT NULL,
    "arguments" "jsonb",
    "read_only" boolean DEFAULT true NOT NULL,
    "success" boolean DEFAULT true NOT NULL,
    "result_summary" "text",
    "error" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL
);

ALTER TABLE ONLY "public"."ai_audit_log" FORCE ROW LEVEL SECURITY;


--
-- Name: ai_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ai_credentials" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "name" character varying(80) NOT NULL,
    "description" "text",
    "provider" character varying(24) DEFAULT 'http'::character varying NOT NULL,
    "secret_cipher" "text" NOT NULL,
    "secret_iv" character varying(32) NOT NULL,
    "secret_tag" character varying(32) NOT NULL,
    "key_id" character varying(16) DEFAULT 'v1'::character varying NOT NULL,
    "hint" character varying(8),
    "base_url" "text",
    "allowed_hosts" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "last_used_at" timestamp with time zone,
    "use_count" integer DEFAULT 0 NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "ai_credentials_name_check" CHECK ((("name")::"text" ~ '^[a-zA-Z][a-zA-Z0-9_ -]{1,79}$'::"text")),
    CONSTRAINT "ai_credentials_provider_check" CHECK ((("provider")::"text" = ANY (ARRAY[('anthropic'::character varying)::"text", ('openai'::character varying)::"text", ('http'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."ai_credentials" FORCE ROW LEVEL SECURITY;


--
-- Name: ai_feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ai_feedback" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "feedback_type" "text" NOT NULL,
    "source" "text" NOT NULL,
    "source_id" "text",
    "field_name" "text",
    "original_value" "text",
    "corrected_value" "text",
    "notes" "text",
    "rating" integer,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "ai_feedback_feedback_type_check" CHECK (("feedback_type" = ANY (ARRAY['REJECTION'::"text", 'CORRECTION'::"text", 'OVERRIDE'::"text", 'RATING'::"text"]))),
    CONSTRAINT "ai_feedback_rating_check" CHECK ((("rating" >= 1) AND ("rating" <= 5)))
);

ALTER TABLE ONLY "public"."ai_feedback" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "ai_feedback"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."ai_feedback" IS 'User feedback on AI suggestions: rejections, corrections, overrides, and ratings. Used to measure and improve AI quality.';


--
-- Name: ai_finding_suppressions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ai_finding_suppressions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), '11111111-1111-1111-1111-111111111111'::"uuid") NOT NULL,
    "finding_type" character varying(50) NOT NULL,
    "entity_type" character varying(50),
    "entity_id" "uuid",
    "dismissed_by" "uuid",
    "reason" "text",
    "suppressed_until" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY "public"."ai_finding_suppressions" FORCE ROW LEVEL SECURITY;


--
-- Name: ai_findings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ai_findings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "finding_type" character varying(50) NOT NULL,
    "severity" character varying(10) DEFAULT 'MEDIUM'::character varying NOT NULL,
    "entity_type" character varying(50),
    "entity_id" "uuid",
    "title" character varying(255) NOT NULL,
    "description" "text",
    "data" "jsonb",
    "status" character varying(20) DEFAULT 'OPEN'::character varying NOT NULL,
    "acknowledged_by" "uuid",
    "acknowledged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    "proposed_journal_entry_id" "uuid",
    "dismiss_reason" "text",
    "resolved_at" timestamp with time zone,
    CONSTRAINT "ai_findings_severity_check" CHECK ((("severity")::"text" = ANY (ARRAY[('LOW'::character varying)::"text", ('MEDIUM'::character varying)::"text", ('HIGH'::character varying)::"text"]))),
    CONSTRAINT "ai_findings_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('OPEN'::character varying)::"text", ('ACKNOWLEDGED'::character varying)::"text", ('DISMISSED'::character varying)::"text", ('RESOLVED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."ai_findings" FORCE ROW LEVEL SECURITY;


--
-- Name: ai_learned_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ai_learned_preferences" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    "field_name" character varying(120) NOT NULL,
    "corrected_value" "text" NOT NULL,
    "original_value" "text",
    "notes" "text",
    "occurrences" integer DEFAULT 1 NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY "public"."ai_learned_preferences" FORCE ROW LEVEL SECURITY;


--
-- Name: ai_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ai_settings" (
    "id" boolean DEFAULT true NOT NULL,
    "model" character varying(80),
    "response_style" character varying(24) DEFAULT 'balanced'::character varying NOT NULL,
    "default_agent_mode" character varying(24) DEFAULT 'accept_edits'::character varying NOT NULL,
    "max_steps" integer DEFAULT 8 NOT NULL,
    "role_permissions" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "extra" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "updated_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "ai_settings_default_agent_mode_check" CHECK ((("default_agent_mode")::"text" = ANY (ARRAY[('manual'::character varying)::"text", ('accept_edits'::character varying)::"text", ('auto'::character varying)::"text", ('bypass'::character varying)::"text"]))),
    CONSTRAINT "ai_settings_id_check" CHECK ("id"),
    CONSTRAINT "ai_settings_max_steps_check" CHECK ((("max_steps" >= 1) AND ("max_steps" <= 30))),
    CONSTRAINT "ai_settings_response_style_check" CHECK ((("response_style")::"text" = ANY (ARRAY[('concise'::character varying)::"text", ('balanced'::character varying)::"text", ('detailed'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."ai_settings" FORCE ROW LEVEL SECURITY;


--
-- Name: ai_tool_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ai_tool_settings" (
    "tool_name" character varying(64) NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "defaults" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "min_role" character varying(32),
    "updated_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "auto_approve" boolean DEFAULT false NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL
);

ALTER TABLE ONLY "public"."ai_tool_settings" FORCE ROW LEVEL SECURITY;


--
-- Name: ai_tool_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ai_tool_versions" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "tool_id" "uuid" NOT NULL,
    "version" integer NOT NULL,
    "snapshot" "jsonb" NOT NULL,
    "note" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL
);

ALTER TABLE ONLY "public"."ai_tool_versions" FORCE ROW LEVEL SECURITY;


--
-- Name: ai_tools; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ai_tools" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "name" character varying(64) NOT NULL,
    "display_name" character varying(160),
    "description" "text" NOT NULL,
    "input_schema" "jsonb" DEFAULT '{"type": "object", "properties": {}}'::"jsonb" NOT NULL,
    "output_schema" "jsonb",
    "implementation" "text" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "timeout_ms" integer DEFAULT 5000 NOT NULL,
    "allowed_tools" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "allow_sql" boolean DEFAULT true NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "created_by" "uuid",
    "updated_by" "uuid",
    "run_count" integer DEFAULT 0 NOT NULL,
    "error_count" integer DEFAULT 0 NOT NULL,
    "last_run_at" timestamp with time zone,
    "last_error" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "ai_tools_name_check" CHECK ((("name")::"text" ~ '^[a-z][a-z0-9_]{2,63}$'::"text")),
    CONSTRAINT "ai_tools_timeout_ms_check" CHECK ((("timeout_ms" >= 100) AND ("timeout_ms" <= 30000)))
);

ALTER TABLE ONLY "public"."ai_tools" FORCE ROW LEVEL SECURITY;


--
-- Name: ai_usage_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ai_usage_log" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid",
    "actor" "text",
    "model" "text" NOT NULL,
    "prompt_tokens" integer,
    "completion_tokens" integer,
    "total_tokens" integer,
    "estimated_cost_usd" numeric(10,6),
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL
);

ALTER TABLE ONLY "public"."ai_usage_log" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "ai_usage_log"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."ai_usage_log" IS 'One row per model call (not per tool call) from the AI agent, with actual token usage and an estimated USD cost where the model''s price is known. See services/ai/usageTracking.js.';


--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."api_keys" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" character varying(100) NOT NULL,
    "key_prefix" character varying(12) NOT NULL,
    "key_hash" character varying(128) NOT NULL,
    "scopes" "text"[] DEFAULT ARRAY['read'::"text"] NOT NULL,
    "role" character varying(20) DEFAULT 'USER'::character varying NOT NULL,
    "status" character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    "created_by" "uuid",
    "last_used_at" timestamp with time zone,
    "expires_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "api_keys_role_check" CHECK ((("role")::"text" = ANY (ARRAY[('USER'::character varying)::"text", ('MANAGER'::character varying)::"text", ('ADMIN'::character varying)::"text"]))),
    CONSTRAINT "api_keys_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('ACTIVE'::character varying)::"text", ('REVOKED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."api_keys" FORCE ROW LEVEL SECURITY;


--
-- Name: approval_chain_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."approval_chain_steps" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "template_id" "uuid" NOT NULL,
    "step_number" integer NOT NULL,
    "min_amount" numeric(15,2) DEFAULT 0 NOT NULL,
    "approver_role" character varying(20) NOT NULL,
    "approver_user_id" "uuid",
    CONSTRAINT "approval_chain_steps_approver_role_check" CHECK ((("approver_role")::"text" = ANY (ARRAY[('USER'::character varying)::"text", ('MANAGER'::character varying)::"text", ('ADMIN'::character varying)::"text", ('FINANCE_USER'::character varying)::"text", ('FINANCE_MANAGER'::character varying)::"text"])))
);


--
-- Name: approval_chain_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."approval_chain_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" character varying(100) NOT NULL,
    "document_type" character varying(50) NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL
);

ALTER TABLE ONLY "public"."approval_chain_templates" FORCE ROW LEVEL SECURITY;


--
-- Name: approval_delegations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."approval_delegations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "delegator_id" "uuid" NOT NULL,
    "delegate_id" "uuid" NOT NULL,
    "start_date" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "end_date" timestamp with time zone,
    "status" character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "approval_delegations_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('ACTIVE'::character varying)::"text", ('CANCELLED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."approval_delegations" FORCE ROW LEVEL SECURITY;


--
-- Name: approval_request_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."approval_request_steps" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "step_number" integer NOT NULL,
    "approver_role" character varying(20) NOT NULL,
    "approver_user_id" "uuid",
    "status" character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    "decided_by" "uuid",
    "decided_at" timestamp with time zone,
    "comments" "text",
    CONSTRAINT "approval_request_steps_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('PENDING'::character varying)::"text", ('APPROVED'::character varying)::"text", ('REJECTED'::character varying)::"text", ('SKIPPED'::character varying)::"text"])))
);


--
-- Name: approval_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."approval_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "template_id" "uuid" NOT NULL,
    "document_type" character varying(50) NOT NULL,
    "document_id" "uuid" NOT NULL,
    "requested_by" "uuid",
    "amount" numeric(15,2) NOT NULL,
    "currency" character varying(3) DEFAULT 'USD'::character varying NOT NULL,
    "status" character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    "current_step" integer DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "completed_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "approval_requests_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('PENDING'::character varying)::"text", ('APPROVED'::character varying)::"text", ('REJECTED'::character varying)::"text", ('CANCELLED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."approval_requests" FORCE ROW LEVEL SECURITY;


--
-- Name: attendance_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."attendance_records" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "employee_id" "uuid" NOT NULL,
    "record_date" "date" NOT NULL,
    "clock_in" timestamp with time zone,
    "clock_out" timestamp with time zone,
    "hours_worked" numeric(5,2) GENERATED ALWAYS AS (
CASE
    WHEN (("clock_in" IS NOT NULL) AND ("clock_out" IS NOT NULL)) THEN (EXTRACT(epoch FROM ("clock_out" - "clock_in")) / 3600.0)
    ELSE NULL::numeric
END) STORED,
    "status" "text" DEFAULT 'PRESENT'::"text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "attendance_records_status_check" CHECK (("status" = ANY (ARRAY['PRESENT'::"text", 'ABSENT'::"text", 'LATE'::"text", 'HALF_DAY'::"text"])))
);


--
-- Name: TABLE "attendance_records"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."attendance_records" IS 'Daily attendance — clock-in/out with computed hours. Feeds into payroll for hourly employees.';


--
-- Name: audit_chain; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."audit_chain" (
    "id" bigint NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "text",
    "from_status" "text",
    "to_status" "text",
    "changed_by" "uuid",
    "reason" "text",
    "occurred_at" timestamp with time zone NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    "prev_hash" character(64) NOT NULL,
    "hash" character(64) NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY "public"."audit_chain" FORCE ROW LEVEL SECURITY;


--
-- Name: audit_chain_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."audit_chain_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_chain_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."audit_chain_id_seq" OWNED BY "public"."audit_chain"."id";


--
-- Name: audit_ddl_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."audit_ddl_log" (
    "id" bigint NOT NULL,
    "ddl_tag" "text" NOT NULL,
    "object_type" "text" NOT NULL,
    "object_identity" "text" NOT NULL,
    "session_role" "text" NOT NULL,
    "database_name" "text" NOT NULL,
    "occurred_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: audit_ddl_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."audit_ddl_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_ddl_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."audit_ddl_log_id_seq" OWNED BY "public"."audit_ddl_log"."id";


--
-- Name: auto_purchase_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."auto_purchase_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sales_order_id" "uuid" NOT NULL,
    "delivery_schedule_id" "uuid",
    "purchase_order_id" "uuid" NOT NULL,
    "supplier_id" "uuid" NOT NULL,
    "created_reason" character varying(50) NOT NULL,
    "total_amount" numeric(12,2),
    "currency" character varying(3) DEFAULT 'USD'::character varying,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL
);

ALTER TABLE ONLY "public"."auto_purchase_orders" FORCE ROW LEVEL SECURITY;


--
-- Name: background_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."background_tasks" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "title" "text" NOT NULL,
    "description" "text" NOT NULL,
    "status" "text" DEFAULT 'queued'::"text" NOT NULL,
    "created_by" "uuid",
    "session_id" "text",
    "mode" "text" DEFAULT 'accept_edits'::"text" NOT NULL,
    "steps_log" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "tools_used" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "pending_tools" "jsonb",
    "result_summary" "text",
    "error" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "started_at" timestamp with time zone,
    "finished_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "background_tasks_status_check" CHECK (("status" = ANY (ARRAY['queued'::"text", 'running'::"text", 'done'::"text", 'blocked'::"text", 'failed'::"text"])))
);

ALTER TABLE ONLY "public"."background_tasks" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "background_tasks"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."background_tasks" IS 'One-time, throwaway agent sub-runs the chat agent proposes for separable work — always confirmed before starting, capped so it cannot self-escalate past what a human approved. See services/ai/backgroundTasks.js.';


--
-- Name: bank_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."bank_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "account_name" character varying(255) NOT NULL,
    "bank_name" character varying(255),
    "account_number" character varying(100),
    "currency" character varying(3) DEFAULT 'USD'::character varying,
    "gl_account_id" "uuid",
    "opening_balance" numeric(15,2) DEFAULT 0 NOT NULL,
    "status" character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    "notes" "text",
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "chk_bank_account_status" CHECK ((("status")::"text" = ANY (ARRAY[('ACTIVE'::character varying)::"text", ('CLOSED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."bank_accounts" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "bank_accounts"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."bank_accounts" IS 'Bank accounts linked to GL cash accounts';


--
-- Name: bank_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."bank_transactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "bank_account_id" "uuid" NOT NULL,
    "transaction_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "description" "text",
    "reference" character varying(100),
    "amount" numeric(15,2) NOT NULL,
    "is_reconciled" boolean DEFAULT false NOT NULL,
    "reconciled_at" timestamp with time zone,
    "reconciled_by" "uuid",
    "matched_type" character varying(30),
    "matched_id" "uuid",
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL
);

ALTER TABLE ONLY "public"."bank_transactions" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "bank_transactions"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."bank_transactions" IS 'Bank statement lines with reconciliation status';


--
-- Name: bills_of_material; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."bills_of_material" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "bom_number" character varying(30) NOT NULL,
    "item_id" "uuid" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "description" "text",
    "output_quantity" numeric(15,4) DEFAULT 1 NOT NULL,
    "unit_of_measure" character varying(20),
    "status" character varying(20) DEFAULT 'DRAFT'::character varying NOT NULL,
    "effective_from" "date",
    "effective_to" "date",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "deleted_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "bills_of_material_output_quantity_check" CHECK (("output_quantity" > (0)::numeric)),
    CONSTRAINT "bills_of_material_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('DRAFT'::character varying)::"text", ('ACTIVE'::character varying)::"text", ('OBSOLETE'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."bills_of_material" FORCE ROW LEVEL SECURITY;


--
-- Name: bins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."bins" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "code" character varying(8) NOT NULL,
    "description" character varying(255) NOT NULL,
    "max_volume_capacity" numeric(12,6) NOT NULL,
    "storage_location_id" "uuid",
    "is_active" boolean DEFAULT true,
    "user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "status" character varying(20) DEFAULT 'DRAFT'::character varying,
    "decline_reason" "text",
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "declined_by" "uuid",
    "declined_at" timestamp with time zone,
    "max_mass_capacity" numeric(10,3) DEFAULT NULL::numeric NOT NULL,
    "current_mass_used" numeric(10,3) DEFAULT 0 NOT NULL,
    "current_volume_used" numeric(12,6) DEFAULT 0 NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "bins_code_format_check" CHECK ((("code")::"text" ~ '^[0-9]{8}$'::"text")),
    CONSTRAINT "bins_positive_volume_capacity_check" CHECK (("max_volume_capacity" > (0)::numeric)),
    CONSTRAINT "bins_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('DRAFT'::character varying)::"text", ('PENDING_APPROVAL'::character varying)::"text", ('ACTIVE'::character varying)::"text", ('DECLINED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."bins" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "bins"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."bins" IS 'Smallest physical storage units within storage locations with capacity constraints';


--
-- Name: COLUMN "bins"."code"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."bins"."code" IS 'Unique 8-digit bin code in format WWRRSSBB (Warehouse, Row, Shelf, Bin)';


--
-- Name: COLUMN "bins"."description"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."bins"."description" IS 'Human-readable description of the bin location';


--
-- Name: COLUMN "bins"."max_volume_capacity"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."bins"."max_volume_capacity" IS 'Maximum volume capacity in m³';


--
-- Name: COLUMN "bins"."status"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."bins"."status" IS 'Approval status: DRAFT, PENDING_APPROVAL, ACTIVE, DECLINED';


--
-- Name: COLUMN "bins"."decline_reason"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."bins"."decline_reason" IS 'Reason for declining the bin request';


--
-- Name: COLUMN "bins"."approved_by"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."bins"."approved_by" IS 'User ID who approved this bin';


--
-- Name: COLUMN "bins"."approved_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."bins"."approved_at" IS 'Timestamp when bin was approved';


--
-- Name: COLUMN "bins"."declined_by"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."bins"."declined_by" IS 'User ID who declined this bin';


--
-- Name: COLUMN "bins"."declined_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."bins"."declined_at" IS 'Timestamp when bin was declined';


--
-- Name: COLUMN "bins"."max_mass_capacity"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."bins"."max_mass_capacity" IS 'Maximum mass capacity in kg';


--
-- Name: COLUMN "bins"."current_mass_used"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."bins"."current_mass_used" IS 'Current mass used in kg';


--
-- Name: COLUMN "bins"."current_volume_used"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."bins"."current_volume_used" IS 'Current volume used in m³';


--
-- Name: bom_components; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."bom_components" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "bom_id" "uuid" NOT NULL,
    "component_item_id" "uuid" NOT NULL,
    "line_number" integer DEFAULT 1 NOT NULL,
    "quantity_per" numeric(15,4) NOT NULL,
    "unit_of_measure" character varying(20),
    "scrap_percent" numeric(6,3) DEFAULT 0 NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "bom_component_not_self" CHECK (("component_item_id" IS NOT NULL)),
    CONSTRAINT "bom_components_quantity_per_check" CHECK (("quantity_per" > (0)::numeric)),
    CONSTRAINT "bom_components_scrap_percent_check" CHECK ((("scrap_percent" >= (0)::numeric) AND ("scrap_percent" < (100)::numeric)))
);


--
-- Name: bom_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."bom_operations" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "bom_id" "uuid" NOT NULL,
    "operation_number" integer NOT NULL,
    "work_center_id" "uuid" NOT NULL,
    "description" character varying(200) NOT NULL,
    "setup_hours" numeric(10,4) DEFAULT 0 NOT NULL,
    "run_hours_per_unit" numeric(10,6) DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "bom_operations_run_hours_per_unit_check" CHECK (("run_hours_per_unit" >= (0)::numeric)),
    CONSTRAINT "bom_operations_setup_hours_check" CHECK (("setup_hours" >= (0)::numeric))
);


--
-- Name: budget_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."budget_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "budget_id" "uuid" NOT NULL,
    "account_id" "uuid" NOT NULL,
    "cost_center_id" "uuid",
    "annual_amount" numeric(15,2) DEFAULT 0 NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: budgets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."budgets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" character varying(255) NOT NULL,
    "fiscal_year" integer NOT NULL,
    "status" character varying(20) DEFAULT 'DRAFT'::character varying NOT NULL,
    "notes" "text",
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "chk_budget_status" CHECK ((("status")::"text" = ANY (ARRAY[('DRAFT'::character varying)::"text", ('APPROVED'::character varying)::"text", ('CLOSED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."budgets" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "budgets"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."budgets" IS 'Annual budgets; lines target GL accounts and optionally cost centers';


--
-- Name: business_type_default_modules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."business_type_default_modules" (
    "business_type_code" "text" NOT NULL,
    "module_key" "text" NOT NULL
);


--
-- Name: business_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."business_types" (
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "category" "text" NOT NULL,
    "description" "text"
);


--
-- Name: chart_of_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."chart_of_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "account_code" character varying(20) NOT NULL,
    "account_name" character varying(255) NOT NULL,
    "account_type" character varying(50) NOT NULL,
    "account_subtype" character varying(100),
    "parent_account_id" "uuid",
    "account_level" integer DEFAULT 1 NOT NULL,
    "is_header" boolean DEFAULT false,
    "is_active" boolean DEFAULT true,
    "normal_balance" character varying(10) NOT NULL,
    "current_balance" numeric(15,2) DEFAULT 0.00,
    "beginning_balance" numeric(15,2) DEFAULT 0.00,
    "allow_manual_posting" boolean DEFAULT true,
    "require_department" boolean DEFAULT false,
    "require_project" boolean DEFAULT false,
    "require_cost_center" boolean DEFAULT false,
    "balance_sheet_section" character varying(100),
    "income_statement_section" character varying(100),
    "cash_flow_section" character varying(100),
    "description" "text",
    "tax_code" character varying(20),
    "currency" character varying(3) DEFAULT 'USD'::character varying,
    "bank_name" character varying(255),
    "bank_account_number" character varying(100),
    "bank_routing_number" character varying(50),
    "status" character varying(50) DEFAULT 'PENDING_APPROVAL'::character varying NOT NULL,
    "created_by" "uuid" NOT NULL,
    "updated_by" "uuid",
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    "is_intercompany" boolean DEFAULT false NOT NULL,
    CONSTRAINT "chk_account_code_format" CHECK ((("account_code")::"text" ~ '^[0-9A-Z]{3,20}$'::"text")),
    CONSTRAINT "chk_account_level_positive" CHECK ((("account_level" > 0) AND ("account_level" <= 10))),
    CONSTRAINT "chk_account_type_valid" CHECK ((("account_type")::"text" = ANY (ARRAY[('ASSET'::character varying)::"text", ('LIABILITY'::character varying)::"text", ('EQUITY'::character varying)::"text", ('REVENUE'::character varying)::"text", ('EXPENSE'::character varying)::"text"]))),
    CONSTRAINT "chk_header_no_manual_posting" CHECK ((NOT (("is_header" = true) AND ("allow_manual_posting" = true)))),
    CONSTRAINT "chk_normal_balance_valid" CHECK ((("normal_balance")::"text" = ANY (ARRAY[('DEBIT'::character varying)::"text", ('CREDIT'::character varying)::"text"]))),
    CONSTRAINT "chk_parent_not_self" CHECK (("parent_account_id" <> "id")),
    CONSTRAINT "chk_status_valid" CHECK ((("status")::"text" = ANY (ARRAY[('PENDING_APPROVAL'::character varying)::"text", ('APPROVED'::character varying)::"text", ('ACTIVE'::character varying)::"text", ('INACTIVE'::character varying)::"text", ('CLOSED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."chart_of_accounts" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "chart_of_accounts"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."chart_of_accounts" IS 'Central chart of accounts for general ledger with hierarchical structure and approval workflow';


--
-- Name: chart_of_accounts_status_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."chart_of_accounts_status_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "account_id" "uuid" NOT NULL,
    "from_status" character varying(50),
    "to_status" character varying(50) NOT NULL,
    "status_date" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "changed_by" "uuid",
    "reason" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: TABLE "chart_of_accounts_status_history"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."chart_of_accounts_status_history" IS 'Audit trail for chart of accounts status changes';


--
-- Name: chat_memory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."chat_memory" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "user_message" "text" NOT NULL,
    "ai_response" "text" NOT NULL,
    "response_type" character varying(20) DEFAULT 'chat'::character varying NOT NULL,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" timestamp without time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL
);

ALTER TABLE ONLY "public"."chat_memory" FORCE ROW LEVEL SECURITY;


--
-- Name: companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."companies" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "company_code" character varying(20) NOT NULL,
    "name" character varying(200) NOT NULL,
    "legal_name" character varying(200),
    "base_currency" character varying(3) DEFAULT 'USD'::character varying NOT NULL,
    "tax_number" character varying(60),
    "registration_number" character varying(60),
    "address_line1" character varying(200),
    "address_line2" character varying(200),
    "city" character varying(100),
    "state" character varying(100),
    "postal_code" character varying(20),
    "country_code" character(2),
    "locale" character varying(10) DEFAULT 'en-US'::character varying NOT NULL,
    "timezone" character varying(60) DEFAULT 'UTC'::character varying NOT NULL,
    "fiscal_year_start_month" smallint DEFAULT 1 NOT NULL,
    "parent_company_id" "uuid",
    "is_default" boolean DEFAULT false NOT NULL,
    "status" character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "deleted_at" timestamp with time zone,
    "costing_method" "text" DEFAULT 'FIFO'::"text" NOT NULL,
    "ownership_percentage" numeric(5,2) DEFAULT 100 NOT NULL,
    "business_type_code" "text",
    CONSTRAINT "companies_costing_method_check" CHECK (("costing_method" = ANY (ARRAY['FIFO'::"text", 'WEIGHTED_AVERAGE'::"text", 'STANDARD'::"text"]))),
    CONSTRAINT "companies_fiscal_year_start_month_check" CHECK ((("fiscal_year_start_month" >= 1) AND ("fiscal_year_start_month" <= 12))),
    CONSTRAINT "companies_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('ACTIVE'::character varying)::"text", ('INACTIVE'::character varying)::"text"])))
);


--
-- Name: TABLE "companies"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."companies" IS 'Legal entities. Multi-company isolation is enforced by row-level security and is off until enable_multi_company() is run; a trigger refuses to create a second company before then.';


--
-- Name: COLUMN "companies"."costing_method"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."companies"."costing_method" IS 'Inventory costing method for this company: FIFO (first-in-first-out), WEIGHTED_AVERAGE (moving average), or STANDARD (fixed standard cost).';


--
-- Name: company_gl_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."company_gl_mappings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), '11111111-1111-1111-1111-111111111111'::"uuid") NOT NULL,
    "purpose" character varying(50) NOT NULL,
    "account_code" character varying(50) NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE ONLY "public"."company_gl_mappings" FORCE ROW LEVEL SECURITY;


--
-- Name: company_isolation_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."company_isolation_config" (
    "id" boolean DEFAULT true NOT NULL,
    "application_role" "name",
    "enabled_at" timestamp with time zone,
    "enabled_by" "name",
    CONSTRAINT "company_isolation_config_id_check" CHECK ("id")
);


--
-- Name: company_modules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."company_modules" (
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    "module_key" "text" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY "public"."company_modules" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "company_modules"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."company_modules" IS 'Per-company module on/off switch. Company-scoped (RLS). Seeded from the company''s business_type defaults at signup; freely editable afterward via the modules settings page.';


--
-- Name: company_scoped_tables; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."company_scoped_tables" (
    "table_name" "text" NOT NULL
);


--
-- Name: company_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."company_subscriptions" (
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    "plan_code" "text" NOT NULL,
    "status" "text" DEFAULT 'ACTIVE'::"text" NOT NULL,
    "stripe_customer_id" "text",
    "stripe_subscription_id" "text",
    "current_period_end" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "company_subscriptions_status_check" CHECK (("status" = ANY (ARRAY['ACTIVE'::"text", 'PAST_DUE'::"text", 'CANCELLED'::"text"])))
);

ALTER TABLE ONLY "public"."company_subscriptions" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "company_subscriptions"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."company_subscriptions" IS 'Which plan a company is on. Company-scoped (RLS). stripe_* columns are NULL until the company actually pays.';


--
-- Name: connector_oauth_pending; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."connector_oauth_pending" (
    "state" character varying(64) NOT NULL,
    "connector_id" "uuid" NOT NULL,
    "code_verifier" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "expires_at" timestamp with time zone NOT NULL
);


--
-- Name: connectors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."connectors" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "provider" character varying(60) NOT NULL,
    "label" character varying(160),
    "client_id" "text",
    "client_secret_cipher" "text",
    "client_secret_iv" character varying(32),
    "client_secret_tag" character varying(32),
    "access_token_cipher" "text",
    "access_token_iv" character varying(32),
    "access_token_tag" character varying(32),
    "refresh_token_cipher" "text",
    "refresh_token_iv" character varying(32),
    "refresh_token_tag" character varying(32),
    "access_token_expires_at" timestamp with time zone,
    "scope" "text",
    "account_info" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status" character varying(20) DEFAULT 'pending_auth'::character varying NOT NULL,
    "last_error" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "connectors_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('pending_auth'::character varying)::"text", ('connected'::character varying)::"text", ('disconnected'::character varying)::"text", ('error'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."connectors" FORCE ROW LEVEL SECURITY;


--
-- Name: contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."contacts" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "first_name" character varying(80) NOT NULL,
    "last_name" character varying(80),
    "email" character varying(160),
    "phone" character varying(40),
    "job_title" character varying(120),
    "customer_id" "uuid",
    "owner_id" "uuid",
    "notes" "text",
    "status" character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "deleted_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "contacts_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('ACTIVE'::character varying)::"text", ('INACTIVE'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."contacts" FORCE ROW LEVEL SECURITY;


--
-- Name: contract_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."contract_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "contract_id" "uuid",
    "item_id" "uuid",
    "unit_price" numeric(15,4),
    "currency" character varying(3) DEFAULT 'USD'::character varying,
    "lead_time_days" integer DEFAULT 30,
    "moq" numeric(12,4) DEFAULT 1,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "quantity" numeric(14,4),
    "status" character varying(30) DEFAULT 'ACTIVE'::character varying,
    "delivery_schedule" "text",
    "specifications" "text",
    "amendment_reason" "text",
    "amendment_requested_by" "uuid",
    "amendment_requested_at" timestamp with time zone,
    "created_by" "uuid",
    "company_approved_by" "uuid",
    "company_approved_at" timestamp with time zone,
    "supplier_approved_by" "uuid",
    "supplier_approved_at" timestamp with time zone
);


--
-- Name: contract_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."contract_number_seq"
    START WITH 1000
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contracts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."contracts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "contract_number" character varying(50) NOT NULL,
    "contract_name" character varying(255) NOT NULL,
    "supplier_id" "uuid",
    "contract_type" character varying(50) DEFAULT 'PURCHASE'::character varying,
    "start_date" "date",
    "end_date" "date",
    "payment_terms" character varying(100),
    "incoterms" character varying(20),
    "currency" character varying(3) DEFAULT 'USD'::character varying,
    "attachment_url" "text",
    "status" character varying(50) DEFAULT 'DRAFT'::character varying,
    "supplier_instructions" "text",
    "created_by" "uuid",
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "digital_contract_required" boolean DEFAULT false,
    "contract_file_path" character varying(500),
    "contract_file_name" character varying(255),
    "contract_file_size" integer,
    "contract_file_type" character varying(100),
    "uploaded_at" timestamp without time zone,
    "uploaded_by" "uuid",
    "title" character varying(255),
    "contract_value" numeric(15,2),
    "description" "text",
    "terms" "text",
    "document_url" "text",
    "sent_to_supplier_at" timestamp with time zone,
    "supplier_response_due" timestamp with time zone,
    "supplier_accepted_at" timestamp with time zone,
    "supplier_declined_at" timestamp with time zone,
    "supplier_response_token" character varying(255),
    "procurement_validation_notes" "text",
    "signed_at" timestamp with time zone,
    "signed_by" "uuid",
    "final_approved_at" timestamp with time zone,
    "supplier_response_token_expires_at" timestamp with time zone,
    "supplier_response_token_used_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    "sla_requirements" "text",
    "renewal_terms" "text",
    "termination_clause" "text",
    "compliance_requirements" "text",
    "risk_assessment" "text",
    "notes" "text",
    CONSTRAINT "contracts_contract_type_check" CHECK ((("contract_type")::"text" = ANY (ARRAY[('PURCHASE'::character varying)::"text", ('SERVICE'::character varying)::"text", ('FRAMEWORK'::character varying)::"text"]))),
    CONSTRAINT "contracts_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('DRAFT'::character varying)::"text", ('PENDING_APPROVAL'::character varying)::"text", ('SENT_TO_SUPPLIER'::character varying)::"text", ('SUPPLIER_ACCEPTED'::character varying)::"text", ('SUPPLIER_DECLINED'::character varying)::"text", ('EXPIRED'::character varying)::"text", ('UNDER_REVIEW'::character varying)::"text", ('SIGNED'::character varying)::"text", ('ACTIVE'::character varying)::"text", ('TERMINATED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."contracts" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "contracts"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."contracts" IS 'Contracts with suppliers defining terms and pricing';


--
-- Name: conversation_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."conversation_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "content" "text",
    "tool_calls" "jsonb",
    "tool_results" "jsonb",
    "artifacts" "jsonb",
    "token_count" integer,
    "model" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "conversation_messages_role_check" CHECK (("role" = ANY (ARRAY['system'::"text", 'user'::"text", 'assistant'::"text", 'tool'::"text"])))
);


--
-- Name: TABLE "conversation_messages"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."conversation_messages" IS 'Full message records including tool calls, results, artifacts, and token counts.';


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."conversations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    "title" "text",
    "session_id" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY "public"."conversations" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "conversations"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."conversations" IS 'Persistent AI chat conversations scoped by user and company.';


--
-- Name: cost_centers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."cost_centers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" character varying(20) NOT NULL,
    "name" character varying(255) NOT NULL,
    "description" "text",
    "manager_id" "uuid",
    "status" character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "chk_cost_center_status" CHECK ((("status")::"text" = ANY (ARRAY[('ACTIVE'::character varying)::"text", ('INACTIVE'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."cost_centers" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "cost_centers"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."cost_centers" IS 'Cost centers for expense allocation and budgeting';


--
-- Name: cost_layers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."cost_layers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "inventory_item_id" "uuid" NOT NULL,
    "receipt_id" "uuid",
    "warehouse_transaction_id" "uuid",
    "receipt_type" "text" DEFAULT 'GOODS_RECEIPT'::"text" NOT NULL,
    "quantity" numeric(15,4) NOT NULL,
    "unit_cost" numeric(15,4) NOT NULL,
    "remaining_quantity" numeric(15,4) DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "created_by" "uuid",
    CONSTRAINT "cost_layers_quantity_check" CHECK (("quantity" > (0)::numeric)),
    CONSTRAINT "cost_layers_receipt_type_check" CHECK (("receipt_type" = ANY (ARRAY['GOODS_RECEIPT'::"text", 'STOCK_ADJUSTMENT'::"text", 'INITIAL'::"text", 'TRANSFER_IN'::"text"]))),
    CONSTRAINT "cost_layers_remaining_quantity_check" CHECK (("remaining_quantity" >= (0)::numeric)),
    CONSTRAINT "cost_layers_unit_cost_check" CHECK (("unit_cost" >= (0)::numeric))
);


--
-- Name: TABLE "cost_layers"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."cost_layers" IS 'Per-receipt cost layers enabling weighted-average cost calculation and COGS traceability';


--
-- Name: COLUMN "cost_layers"."remaining_quantity"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."cost_layers"."remaining_quantity" IS 'Quantity from this layer still in stock (not yet issued/consumed). Decremented on goods issue in FIFO order.';


--
-- Name: currencies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."currencies" (
    "code" character varying(3) NOT NULL,
    "name" character varying(100) NOT NULL,
    "symbol" character varying(8),
    "is_base" boolean DEFAULT false NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: TABLE "currencies"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."currencies" IS 'Currency master with a single base currency';


--
-- Name: customer_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."customer_audit_log" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "action" character varying(50) NOT NULL,
    "field_changed" character varying(100),
    "old_value" "text",
    "new_value" "text",
    "changed_by" "uuid" NOT NULL,
    "changed_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "notes" "text"
);


--
-- Name: TABLE "customer_audit_log"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."customer_audit_log" IS 'Audit trail for customer changes - tracks all modifications for compliance and history';


--
-- Name: customer_invoice_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."customer_invoice_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "invoice_id" "uuid" NOT NULL,
    "line_number" integer NOT NULL,
    "item_description" "text" NOT NULL,
    "quantity" numeric(15,4) NOT NULL,
    "unit_of_measure" character varying(20),
    "unit_price" numeric(15,4) NOT NULL,
    "discount_percentage" numeric(5,2) DEFAULT 0,
    "discount_amount" numeric(15,2) DEFAULT 0,
    "line_total" numeric(15,2) NOT NULL,
    "tax_code" character varying(20),
    "tax_rate" numeric(5,4) DEFAULT 0,
    "tax_amount" numeric(15,2) DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: TABLE "customer_invoice_items"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."customer_invoice_items" IS 'Line items for customer invoices';


--
-- Name: customer_invoice_status_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."customer_invoice_status_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "invoice_id" "uuid" NOT NULL,
    "from_status" character varying(30),
    "to_status" character varying(30) NOT NULL,
    "changed_by" "uuid",
    "status_date" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "reason" "text"
);


--
-- Name: customer_invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."customer_invoices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "invoice_number" character varying(50) NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "sales_order_id" "uuid",
    "journal_entry_id" "uuid",
    "invoice_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "due_date" "date" NOT NULL,
    "payment_terms" character varying(50),
    "currency" character varying(3) DEFAULT 'USD'::character varying,
    "subtotal" numeric(15,2) DEFAULT 0 NOT NULL,
    "tax_amount" numeric(15,2) DEFAULT 0 NOT NULL,
    "discount_amount" numeric(15,2) DEFAULT 0 NOT NULL,
    "total_amount" numeric(15,2) DEFAULT 0 NOT NULL,
    "paid_amount" numeric(15,2) DEFAULT 0 NOT NULL,
    "outstanding_amount" numeric(15,2) GENERATED ALWAYS AS (("total_amount" - "paid_amount")) STORED,
    "status" character varying(30) DEFAULT 'DRAFT'::character varying NOT NULL,
    "description" "text",
    "notes" "text",
    "internal_notes" "text",
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" timestamp with time zone,
    "deleted_by" "uuid",
    "exchange_rate" numeric(18,8) DEFAULT 1 NOT NULL,
    "base_amount" numeric(15,2),
    "recurring_schedule_id" "uuid",
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "chk_due_date_after_invoice_date" CHECK (("due_date" >= "invoice_date")),
    CONSTRAINT "chk_invoice_amounts_positive" CHECK ((("subtotal" >= (0)::numeric) AND ("tax_amount" >= (0)::numeric) AND ("total_amount" >= (0)::numeric) AND ("paid_amount" >= (0)::numeric))),
    CONSTRAINT "chk_invoice_status_valid" CHECK ((("status")::"text" = ANY (ARRAY[('DRAFT'::character varying)::"text", ('PENDING_APPROVAL'::character varying)::"text", ('APPROVED'::character varying)::"text", ('SENT'::character varying)::"text", ('PAID'::character varying)::"text", ('PARTIALLY_PAID'::character varying)::"text", ('OVERDUE'::character varying)::"text", ('CANCELLED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."customer_invoices" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "customer_invoices"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."customer_invoices" IS 'Customer invoices generated from sales orders with payment tracking';


--
-- Name: customer_payment_allocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."customer_payment_allocations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "payment_id" "uuid" NOT NULL,
    "invoice_id" "uuid" NOT NULL,
    "allocation_amount" numeric(15,2) NOT NULL,
    "allocation_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chk_positive_allocation" CHECK (("allocation_amount" > (0)::numeric))
);


--
-- Name: TABLE "customer_payment_allocations"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."customer_payment_allocations" IS 'Allocation of payments to specific invoices for AR tracking';


--
-- Name: customer_payment_status_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."customer_payment_status_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "payment_id" "uuid" NOT NULL,
    "from_status" character varying(30),
    "to_status" character varying(30) NOT NULL,
    "changed_by" "uuid",
    "status_date" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "reason" "text"
);


--
-- Name: customer_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."customer_payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "payment_number" character varying(50) NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "journal_entry_id" "uuid",
    "payment_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "payment_method" character varying(30) NOT NULL,
    "reference_number" character varying(100),
    "bank_account_id" "uuid",
    "payment_amount" numeric(15,2) NOT NULL,
    "currency" character varying(3) DEFAULT 'USD'::character varying,
    "exchange_rate" numeric(10,6) DEFAULT 1.0,
    "status" character varying(30) DEFAULT 'PENDING'::character varying NOT NULL,
    "description" "text",
    "notes" "text",
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" timestamp with time zone,
    "deleted_by" "uuid",
    "base_amount" numeric(15,2),
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "chk_payment_amount_positive" CHECK (("payment_amount" > (0)::numeric)),
    CONSTRAINT "chk_payment_method_valid" CHECK ((("payment_method")::"text" = ANY (ARRAY[('CASH'::character varying)::"text", ('CHECK'::character varying)::"text", ('BANK_TRANSFER'::character varying)::"text", ('CREDIT_CARD'::character varying)::"text", ('ACH'::character varying)::"text", ('WIRE_TRANSFER'::character varying)::"text"]))),
    CONSTRAINT "chk_payment_status_valid" CHECK ((("status")::"text" = ANY (ARRAY[('PENDING'::character varying)::"text", ('CLEARED'::character varying)::"text", ('BOUNCED'::character varying)::"text", ('CANCELLED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."customer_payments" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "customer_payments"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."customer_payments" IS 'Customer payments received with bank reconciliation support';


--
-- Name: customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."customers" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "customer_code" character varying(20) NOT NULL,
    "customer_name" character varying(255) NOT NULL,
    "legal_entity_name" character varying(255),
    "customer_type" character varying(50) DEFAULT 'INDIVIDUAL'::character varying,
    "primary_email" character varying(255),
    "secondary_email" character varying(255),
    "phone" character varying(50),
    "mobile" character varying(50),
    "fax" character varying(50),
    "website" character varying(255),
    "billing_address_line1" character varying(255),
    "billing_address_line2" character varying(255),
    "billing_city" character varying(100),
    "billing_state" character varying(100),
    "billing_country" character varying(100),
    "billing_postal_code" character varying(20),
    "shipping_address_line1" character varying(255),
    "shipping_address_line2" character varying(255),
    "shipping_city" character varying(100),
    "shipping_state" character varying(100),
    "shipping_country" character varying(100),
    "shipping_postal_code" character varying(20),
    "use_billing_as_shipping" boolean DEFAULT true,
    "currency" character varying(3) DEFAULT 'USD'::character varying,
    "credit_limit" numeric(15,2) DEFAULT 0,
    "current_balance" numeric(15,2) DEFAULT 0,
    "credit_days" integer DEFAULT 30,
    "payment_terms" character varying(100),
    "tax_number" character varying(100),
    "vat_number" character varying(100),
    "tax_exempt" boolean DEFAULT false,
    "tax_rate" numeric(5,2) DEFAULT 0,
    "primary_contact_name" character varying(255),
    "primary_contact_title" character varying(100),
    "primary_contact_email" character varying(255),
    "primary_contact_phone" character varying(50),
    "secondary_contact_name" character varying(255),
    "secondary_contact_title" character varying(100),
    "secondary_contact_email" character varying(255),
    "secondary_contact_phone" character varying(50),
    "status" character varying(20) DEFAULT 'ACTIVE'::character varying,
    "customer_category" character varying(50),
    "customer_group" character varying(50),
    "sales_rep_id" "uuid",
    "credit_risk_level" character varying(20) DEFAULT 'LOW'::character varying,
    "credit_check_required" boolean DEFAULT false,
    "notes" "text",
    "internal_notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" timestamp with time zone,
    "deleted_by" "uuid",
    "email" character varying(255),
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "customers_code_format_check" CHECK ((("customer_code")::"text" ~ '^[A-Z0-9-]{3,20}$'::"text")),
    CONSTRAINT "customers_credit_risk_level_check" CHECK ((("credit_risk_level")::"text" = ANY (ARRAY[('LOW'::character varying)::"text", ('MEDIUM'::character varying)::"text", ('HIGH'::character varying)::"text", ('BLOCKED'::character varying)::"text"]))),
    CONSTRAINT "customers_customer_type_check" CHECK ((("customer_type")::"text" = ANY (ARRAY[('INDIVIDUAL'::character varying)::"text", ('COMPANY'::character varying)::"text", ('GOVERNMENT'::character varying)::"text", ('NON_PROFIT'::character varying)::"text"]))),
    CONSTRAINT "customers_email_format_check" CHECK ((("primary_email" IS NULL) OR (("primary_email")::"text" ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'::"text"))),
    CONSTRAINT "customers_positive_credit_limit_check" CHECK (("credit_limit" >= (0)::numeric)),
    CONSTRAINT "customers_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('ACTIVE'::character varying)::"text", ('INACTIVE'::character varying)::"text", ('BLOCKED'::character varying)::"text", ('PENDING_APPROVAL'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."customers" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "customers"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."customers" IS 'Customer master data for sales module - stores all customer information including addresses, contacts, financial terms, and risk profiles';


--
-- Name: COLUMN "customers"."customer_code"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."customers"."customer_code" IS 'Unique customer identifier code (e.g., CUST-001)';


--
-- Name: COLUMN "customers"."legal_entity_name"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."customers"."legal_entity_name" IS 'Official legal name if different from customer_name';


--
-- Name: COLUMN "customers"."use_billing_as_shipping"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."customers"."use_billing_as_shipping" IS 'Whether to use billing address as shipping address';


--
-- Name: COLUMN "customers"."credit_limit"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."customers"."credit_limit" IS 'Maximum credit amount allowed for this customer';


--
-- Name: COLUMN "customers"."current_balance"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."customers"."current_balance" IS 'Current outstanding balance';


--
-- Name: COLUMN "customers"."credit_days"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."customers"."credit_days" IS 'Number of days for payment terms';


--
-- Name: COLUMN "customers"."credit_risk_level"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."customers"."credit_risk_level" IS 'Risk assessment level for credit decisions';


--
-- Name: COLUMN "customers"."internal_notes"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."customers"."internal_notes" IS 'Internal notes not visible to customer';


--
-- Name: dashboard_widgets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."dashboard_widgets" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "dashboard_id" "uuid" NOT NULL,
    "report_id" "uuid",
    "title" character varying(200),
    "widget_type" character varying(20) DEFAULT 'TABLE'::character varying NOT NULL,
    "position_x" smallint DEFAULT 0 NOT NULL,
    "position_y" smallint DEFAULT 0 NOT NULL,
    "width" smallint DEFAULT 6 NOT NULL,
    "height" smallint DEFAULT 4 NOT NULL,
    "config" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "chk_widget_source" CHECK (((("widget_type")::"text" = 'TEXT'::"text") OR ("report_id" IS NOT NULL))),
    CONSTRAINT "dashboard_widgets_height_check" CHECK ((("height" >= 1) AND ("height" <= 20))),
    CONSTRAINT "dashboard_widgets_position_x_check" CHECK ((("position_x" >= 0) AND ("position_x" <= 11))),
    CONSTRAINT "dashboard_widgets_widget_type_check" CHECK ((("widget_type")::"text" = ANY (ARRAY[('TABLE'::character varying)::"text", ('BAR'::character varying)::"text", ('LINE'::character varying)::"text", ('PIE'::character varying)::"text", ('METRIC'::character varying)::"text", ('TEXT'::character varying)::"text"]))),
    CONSTRAINT "dashboard_widgets_width_check" CHECK ((("width" >= 1) AND ("width" <= 12)))
);


--
-- Name: dashboards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."dashboards" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "name" character varying(200) NOT NULL,
    "description" "text",
    "owner_id" "uuid",
    "is_shared" boolean DEFAULT false NOT NULL,
    "is_default" boolean DEFAULT false NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "deleted_at" timestamp with time zone
);

ALTER TABLE ONLY "public"."dashboards" FORCE ROW LEVEL SECURITY;


--
-- Name: deals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."deals" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "deal_number" character varying(30) NOT NULL,
    "title" character varying(200) NOT NULL,
    "customer_id" "uuid",
    "contact_id" "uuid",
    "value" numeric(15,2) DEFAULT 0 NOT NULL,
    "currency" character varying(3) DEFAULT 'USD'::character varying NOT NULL,
    "stage" character varying(20) DEFAULT 'NEW'::character varying NOT NULL,
    "probability" integer DEFAULT 10 NOT NULL,
    "expected_close_date" "date",
    "owner_id" "uuid",
    "source" character varying(60),
    "closed_at" timestamp with time zone,
    "lost_reason" "text",
    "sales_order_id" "uuid",
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "deleted_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "deals_probability_check" CHECK ((("probability" >= 0) AND ("probability" <= 100))),
    CONSTRAINT "deals_stage_check" CHECK ((("stage")::"text" = ANY (ARRAY[('NEW'::character varying)::"text", ('QUALIFIED'::character varying)::"text", ('PROPOSAL'::character varying)::"text", ('NEGOTIATION'::character varying)::"text", ('WON'::character varying)::"text", ('LOST'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."deals" FORCE ROW LEVEL SECURITY;


--
-- Name: delegation_of_authority; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."delegation_of_authority" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "cost_center" character varying(100),
    "user_id" "uuid",
    "min_amount" numeric(15,2) DEFAULT 0,
    "max_amount" numeric(15,2),
    "currency" character varying(3) DEFAULT 'USD'::character varying,
    "applies_to" character varying(50) DEFAULT 'ALL'::character varying,
    "is_active" boolean DEFAULT true,
    "effective_from" "date" DEFAULT CURRENT_DATE,
    "effective_until" "date",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "delegation_of_authority_applies_to_check" CHECK ((("applies_to")::"text" = ANY (ARRAY[('SALES_CONTRACT'::character varying)::"text", ('CONTRACTS'::character varying)::"text", ('CERTIFICATION'::character varying)::"text", ('SALES_RFQ'::character varying)::"text", ('SALES_QUOTATION'::character varying)::"text", ('SALES_ORDER'::character varying)::"text", ('PURCHASE_REQUISITIONS'::character varying)::"text", ('PO'::character varying)::"text", ('SUPPLIERS'::character varying)::"text", ('SUPPLIER_APPROVAL'::character varying)::"text", ('SUPPLIER_CERTIFICATION'::character varying)::"text", ('CONTRACT_APPROVAL'::character varying)::"text", ('PURCHASE_REQUISITION'::character varying)::"text", ('RFQ_APPROVAL'::character varying)::"text", ('PURCHASE_ORDER'::character varying)::"text", ('SALES_RFQ_SALES_APPROVAL'::character varying)::"text", ('SALES_RFQ_PROCUREMENT_APPROVAL'::character varying)::"text", ('PURCHASE_ORDER_SALES_APPROVAL'::character varying)::"text", ('PURCHASE_ORDER_PROCUREMENT_APPROVAL'::character varying)::"text", ('DELIVERY_SCHEDULING'::character varying)::"text", ('DELIVERY_POSTPONEMENT'::character varying)::"text", ('DROPSHIP_AUTHORIZATION'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."delegation_of_authority" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "delegation_of_authority"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."delegation_of_authority" IS 'Financial approval authority by user and cost center';


--
-- Name: delivery_exceptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."delivery_exceptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "delivery_schedule_id" "uuid" NOT NULL,
    "exception_type" character varying(100) NOT NULL,
    "exception_date" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "description" "text" NOT NULL,
    "resolution" "text",
    "delay_minutes" integer,
    "additional_cost" numeric(15,2),
    "status" character varying(50) DEFAULT 'OPEN'::character varying NOT NULL,
    "resolved_at" timestamp with time zone,
    "resolved_by" "uuid",
    "photos" "text"[],
    "documents" "text"[],
    "created_by" "uuid" NOT NULL,
    "updated_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: TABLE "delivery_exceptions"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."delivery_exceptions" IS 'Tracking of delivery issues and exceptions';


--
-- Name: delivery_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."delivery_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "delivery_schedule_id" "uuid" NOT NULL,
    "sales_order_item_id" "uuid",
    "item_code" character varying(100),
    "item_name" character varying(255) NOT NULL,
    "item_description" "text",
    "ordered_quantity" numeric(15,3) NOT NULL,
    "delivered_quantity" numeric(15,3) DEFAULT 0,
    "remaining_quantity" numeric(15,3) NOT NULL,
    "unit_of_measure" character varying(20) NOT NULL,
    "package_type" character varying(100),
    "package_count" integer DEFAULT 1,
    "weight_kg" numeric(10,3),
    "dimensions_cm" character varying(100),
    "status" character varying(50) DEFAULT 'PENDING'::character varying NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "fulfillment_method" character varying(20) DEFAULT 'INVENTORY'::character varying,
    "supplier_id" "uuid",
    "purchase_order_item_id" "uuid",
    "inventory_reserved_quantity" numeric(10,3) DEFAULT 0,
    "dropship_quantity" numeric(10,3) DEFAULT 0,
    CONSTRAINT "chk_delivery_delivered_qty_positive" CHECK (("delivered_quantity" >= (0)::numeric)),
    CONSTRAINT "chk_delivery_ordered_qty_positive" CHECK (("ordered_quantity" > (0)::numeric)),
    CONSTRAINT "chk_delivery_remaining_qty_positive" CHECK (("remaining_quantity" >= (0)::numeric)),
    CONSTRAINT "delivery_items_fulfillment_method_check" CHECK ((("fulfillment_method")::"text" = ANY (ARRAY[('INVENTORY'::character varying)::"text", ('DROPSHIP'::character varying)::"text"])))
);


--
-- Name: TABLE "delivery_items"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."delivery_items" IS 'Individual items within each delivery schedule';


--
-- Name: delivery_route_stops; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."delivery_route_stops" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "delivery_route_id" "uuid" NOT NULL,
    "delivery_schedule_id" "uuid" NOT NULL,
    "stop_order" integer NOT NULL,
    "estimated_arrival_time" timestamp with time zone,
    "actual_arrival_time" timestamp with time zone,
    "estimated_departure_time" timestamp with time zone,
    "actual_departure_time" timestamp with time zone,
    "status" character varying(50) DEFAULT 'PENDING'::character varying NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chk_delivery_stop_order_positive" CHECK (("stop_order" > 0))
);


--
-- Name: TABLE "delivery_route_stops"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."delivery_route_stops" IS 'Individual stops within delivery routes';


--
-- Name: delivery_routes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."delivery_routes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "route_number" character varying(50) NOT NULL,
    "route_name" character varying(255),
    "route_date" "date" NOT NULL,
    "start_location" "text",
    "end_location" "text",
    "estimated_distance_km" numeric(8,2),
    "estimated_duration_minutes" integer,
    "driver_name" character varying(255),
    "driver_phone" character varying(50),
    "vehicle_number" character varying(100),
    "vehicle_type" character varying(100),
    "status" character varying(50) DEFAULT 'PLANNED'::character varying NOT NULL,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "notes" "text",
    "created_by" "uuid" NOT NULL,
    "updated_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL
);

ALTER TABLE ONLY "public"."delivery_routes" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "delivery_routes"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."delivery_routes" IS 'Optimized delivery routes grouping multiple deliveries';


--
-- Name: delivery_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."delivery_schedules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "schedule_number" character varying(50) NOT NULL,
    "sales_order_id" "uuid" NOT NULL,
    "sales_order_number" character varying(50) NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "customer_name" character varying(255) NOT NULL,
    "delivery_date" "date" NOT NULL,
    "delivery_time_from" time without time zone,
    "delivery_time_to" time without time zone,
    "delivery_address" "text" NOT NULL,
    "delivery_instructions" "text",
    "shipping_method" character varying(100),
    "contact_person" character varying(255),
    "contact_phone" character varying(50),
    "contact_email" character varying(255),
    "status" character varying(50) DEFAULT 'SCHEDULED'::character varying NOT NULL,
    "priority" character varying(20) DEFAULT 'NORMAL'::character varying,
    "driver_name" character varying(255),
    "vehicle_number" character varying(100),
    "tracking_number" character varying(100),
    "estimated_delivery_time" timestamp with time zone,
    "actual_delivery_time" timestamp with time zone,
    "delivered_by" character varying(255),
    "received_by" character varying(255),
    "delivery_signature" "text",
    "delivery_photo" "text",
    "notes" "text",
    "internal_notes" "text",
    "special_instructions" "text",
    "created_by" "uuid" NOT NULL,
    "updated_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" timestamp with time zone,
    "fulfillment_type" character varying(20) DEFAULT 'INVENTORY'::character varying,
    "supplier_id" "uuid",
    "auto_purchase_order_id" "uuid",
    "dropship_notes" "text",
    "estimated_supplier_delivery_date" "date",
    "supplier_tracking_number" character varying(100),
    "workflow_status" character varying(20) DEFAULT 'PLANNING'::character varying,
    "original_delivery_date" "date",
    "postponement_count" integer DEFAULT 0,
    "postponement_reason" "text",
    "postponed_by" "uuid",
    "postponed_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "delivery_schedules_fulfillment_type_check" CHECK ((("fulfillment_type")::"text" = ANY (ARRAY[('INVENTORY'::character varying)::"text", ('DROPSHIP'::character varying)::"text", ('HYBRID'::character varying)::"text"]))),
    CONSTRAINT "delivery_schedules_workflow_status_check" CHECK ((("workflow_status")::"text" = ANY (ARRAY[('PLANNING'::character varying)::"text", ('PO_CREATED'::character varying)::"text", ('INVENTORY_RESERVED'::character varying)::"text", ('GOODS_ISSUED'::character varying)::"text", ('READY_TO_SHIP'::character varying)::"text", ('SHIPPED'::character varying)::"text", ('DELIVERED'::character varying)::"text", ('COMPLETED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."delivery_schedules" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "delivery_schedules"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."delivery_schedules" IS 'Scheduled deliveries for sales orders with tracking and status management';


--
-- Name: delivery_status_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."delivery_status_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "delivery_schedule_id" "uuid" NOT NULL,
    "from_status" character varying(50),
    "to_status" character varying(50) NOT NULL,
    "status_date" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "location" character varying(255),
    "latitude" numeric(10,8),
    "longitude" numeric(11,8),
    "changed_by" "uuid" NOT NULL,
    "reason" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: TABLE "delivery_status_history"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."delivery_status_history" IS 'Audit trail for delivery status changes with location tracking';


--
-- Name: document_embeddings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."document_embeddings" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "source_type" "text" NOT NULL,
    "source_id" "text" NOT NULL,
    "chunk_index" integer DEFAULT 0 NOT NULL,
    "chunk_text" "text" NOT NULL,
    "embedding" "public"."vector"(384) NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL
);

ALTER TABLE ONLY "public"."document_embeddings" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "document_embeddings"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."document_embeddings" IS 'Chunked text + embeddings for free-text search over contract terms and generated documents. No pgvector: embedding is a plain float4[], ranked in application code. See services/ai/documentSearch.js.';


--
-- Name: COLUMN "document_embeddings"."embedding"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."document_embeddings"."embedding" IS 'pgvector(384) — all-MiniLM-L6-v2 via services/ai/localEmbeddings.js, run in-process (no external API). Searched with the <=> cosine-distance operator; see services/ai/documentSearch.js#search.';


--
-- Name: email_verification_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."email_verification_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "token_hash" "text" NOT NULL,
    "used" boolean DEFAULT false NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: employees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."employees" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "employee_number" character varying(20) NOT NULL,
    "first_name" character varying(100) NOT NULL,
    "last_name" character varying(100) NOT NULL,
    "email" character varying(255),
    "department" character varying(100),
    "position" character varying(100),
    "cost_center_id" "uuid",
    "hire_date" "date",
    "base_salary" numeric(15,2) DEFAULT 0 NOT NULL,
    "currency" character varying(3) DEFAULT 'USD'::character varying,
    "status" character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" timestamp with time zone,
    "housing_allowance" numeric(15,2) DEFAULT 0 NOT NULL,
    "transport_allowance" numeric(15,2) DEFAULT 0 NOT NULL,
    "other_allowance" numeric(15,2) DEFAULT 0 NOT NULL,
    "user_id" "uuid",
    "hourly_cost_rate" numeric(15,2),
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    "bank_account_number" character varying(100),
    "tax_id" character varying(50),
    "address" "text",
    "filing_status" "text" DEFAULT 'SINGLE'::"text" NOT NULL,
    CONSTRAINT "chk_employee_status" CHECK ((("status")::"text" = ANY (ARRAY[('ACTIVE'::character varying)::"text", ('ON_LEAVE'::character varying)::"text", ('TERMINATED'::character varying)::"text"]))),
    CONSTRAINT "employees_filing_status_check" CHECK (("filing_status" = ANY (ARRAY['SINGLE'::"text", 'MARRIED_JOINT'::"text", 'HEAD_OF_HOUSEHOLD'::"text"])))
);

ALTER TABLE ONLY "public"."employees" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "employees"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."employees" IS 'Employee master for HR and payroll';


--
-- Name: COLUMN "employees"."user_id"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."employees"."user_id" IS 'Login this employee record belongs to. Lets time logged by a user be costed against their salary.';


--
-- Name: COLUMN "employees"."hourly_cost_rate"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."employees"."hourly_cost_rate" IS 'Internal cost of one hour of this employee''s time. Seeded from base_salary/2080; excludes employer taxes and benefits, so it understates true cost until set explicitly.';


--
-- Name: COLUMN "employees"."filing_status"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."employees"."filing_status" IS 'W-4 filing status, drives federal withholding bracket selection (services/payrollTaxService.js).';


--
-- Name: exchange_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."exchange_rates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "from_currency" character varying(3) NOT NULL,
    "to_currency" character varying(3) NOT NULL,
    "rate" numeric(18,8) NOT NULL,
    "rate_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chk_rate_positive" CHECK (("rate" > (0)::numeric))
);


--
-- Name: TABLE "exchange_rates"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."exchange_rates" IS 'Dated exchange rates (1 from = rate to)';


--
-- Name: fixed_asset_depreciation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."fixed_asset_depreciation" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "asset_id" "uuid" NOT NULL,
    "period_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "depreciation_amount" numeric(15,2) NOT NULL,
    "accumulated_after" numeric(15,2) NOT NULL,
    "journal_entry_id" "uuid",
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: TABLE "fixed_asset_depreciation"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."fixed_asset_depreciation" IS 'Per-period depreciation entries posted to the GL';


--
-- Name: fixed_asset_revaluations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."fixed_asset_revaluations" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "asset_id" "uuid" NOT NULL,
    "revaluation_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "carrying_amount_before" numeric(15,2) NOT NULL,
    "revalued_amount" numeric(15,2) NOT NULL,
    "adjustment" numeric(15,2) NOT NULL,
    "to_equity" numeric(15,2) DEFAULT 0 NOT NULL,
    "to_profit_or_loss" numeric(15,2) DEFAULT 0 NOT NULL,
    "method" character varying(20) DEFAULT 'REVALUATION'::character varying NOT NULL,
    "basis" "text",
    "journal_entry_id" "uuid",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "fixed_asset_revaluations_method_check" CHECK ((("method")::"text" = ANY (ARRAY[('REVALUATION'::character varying)::"text", ('IMPAIRMENT'::character varying)::"text"]))),
    CONSTRAINT "fixed_asset_revaluations_revalued_amount_check" CHECK (("revalued_amount" >= (0)::numeric))
);


--
-- Name: TABLE "fixed_asset_revaluations"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."fixed_asset_revaluations" IS 'Per-asset revaluation history. Required to apply IAS 16: a decrease is charged against that asset''s own accumulated surplus before it can hit profit or loss.';


--
-- Name: fixed_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."fixed_assets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "asset_number" character varying(50) NOT NULL,
    "name" character varying(255) NOT NULL,
    "description" "text",
    "category" character varying(100),
    "acquisition_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "acquisition_cost" numeric(15,2) NOT NULL,
    "salvage_value" numeric(15,2) DEFAULT 0 NOT NULL,
    "useful_life_years" integer DEFAULT 5 NOT NULL,
    "depreciation_method" character varying(30) DEFAULT 'STRAIGHT_LINE'::character varying NOT NULL,
    "accumulated_depreciation" numeric(15,2) DEFAULT 0 NOT NULL,
    "book_value" numeric(15,2) GENERATED ALWAYS AS (("acquisition_cost" - "accumulated_depreciation")) STORED,
    "last_depreciation_date" "date",
    "status" character varying(30) DEFAULT 'ACTIVE'::character varying NOT NULL,
    "location" character varying(255),
    "serial_number" character varying(100),
    "supplier_id" "uuid",
    "notes" "text",
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" timestamp with time zone,
    "deleted_by" "uuid",
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    "declining_balance_factor" numeric(4,2),
    CONSTRAINT "chk_fixed_asset_amounts" CHECK ((("acquisition_cost" >= (0)::numeric) AND ("salvage_value" >= (0)::numeric) AND ("useful_life_years" > 0))),
    CONSTRAINT "chk_fixed_asset_declining_factor" CHECK ((("declining_balance_factor" IS NULL) OR (("declining_balance_factor" > (0)::numeric) AND ("declining_balance_factor" <= (5)::numeric)))),
    CONSTRAINT "chk_fixed_asset_depreciation_method" CHECK ((("depreciation_method")::"text" = ANY (ARRAY[('STRAIGHT_LINE'::character varying)::"text", ('DECLINING_BALANCE'::character varying)::"text", ('DOUBLE_DECLINING'::character varying)::"text", ('SUM_OF_YEARS_DIGITS'::character varying)::"text"]))),
    CONSTRAINT "chk_fixed_asset_status_valid" CHECK ((("status")::"text" = ANY (ARRAY[('ACTIVE'::character varying)::"text", ('FULLY_DEPRECIATED'::character varying)::"text", ('DISPOSED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."fixed_assets" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "fixed_assets"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."fixed_assets" IS 'Fixed asset register with straight-line and accelerated depreciation';


--
-- Name: COLUMN "fixed_assets"."depreciation_method"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."fixed_assets"."depreciation_method" IS 'STRAIGHT_LINE | DECLINING_BALANCE | DOUBLE_DECLINING | SUM_OF_YEARS_DIGITS — charged by services/financeCalc.depreciationForPeriod';


--
-- Name: COLUMN "fixed_assets"."declining_balance_factor"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."fixed_assets"."declining_balance_factor" IS 'Acceleration factor for declining balance; NULL uses the method default (2.0 double, 1.5 declining)';


--
-- Name: generated_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."generated_documents" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "title" character varying(200) NOT NULL,
    "kind" character varying(40) DEFAULT 'report'::character varying NOT NULL,
    "template_key" character varying(64),
    "file_name" character varying(255) NOT NULL,
    "storage_path" "text" NOT NULL,
    "byte_size" integer DEFAULT 0 NOT NULL,
    "sha256" character varying(64),
    "created_by" "uuid",
    "agent_run_id" "uuid",
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "content_type" character varying(20) DEFAULT 'pdf'::character varying NOT NULL,
    "language" character varying(40)
);

ALTER TABLE ONLY "public"."generated_documents" FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN "generated_documents"."content_type"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."generated_documents"."content_type" IS 'pdf | html | svg | markdown | code — what kind of artifact this row is. Existing rows are all pdf.';


--
-- Name: goods_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."goods_receipts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "po_id" "uuid",
    "po_line_item_id" "uuid",
    "quantity_received" numeric(12,4) NOT NULL,
    "condition_grade" character varying(50) DEFAULT 'NEW'::character varying,
    "batch_lot_number" character varying(100),
    "serial_numbers" "jsonb" DEFAULT '[]'::"jsonb",
    "expiry_date" "date",
    "received_date" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "storage_location_id" "uuid",
    "bin_id" "uuid",
    "notes" "text",
    "received_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "goods_receipts_condition_grade_check" CHECK ((("condition_grade")::"text" = ANY (ARRAY[('NEW'::character varying)::"text", ('USED'::character varying)::"text", ('REFURBISHED'::character varying)::"text", ('DAMAGED'::character varying)::"text"]))),
    CONSTRAINT "goods_receipts_quantity_positive" CHECK (("quantity_received" > (0)::numeric))
);

ALTER TABLE ONLY "public"."goods_receipts" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "goods_receipts"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."goods_receipts" IS 'Records of goods received against purchase orders with inventory integration';


--
-- Name: COLUMN "goods_receipts"."quantity_received"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."goods_receipts"."quantity_received" IS 'Quantity of goods received for this receipt';


--
-- Name: COLUMN "goods_receipts"."condition_grade"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."goods_receipts"."condition_grade" IS 'Physical condition of received goods (NEW, USED, REFURBISHED, DAMAGED)';


--
-- Name: COLUMN "goods_receipts"."batch_lot_number"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."goods_receipts"."batch_lot_number" IS 'Manufacturer batch or lot number for traceability';


--
-- Name: COLUMN "goods_receipts"."serial_numbers"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."goods_receipts"."serial_numbers" IS 'Array of serial numbers for serialized items';


--
-- Name: COLUMN "goods_receipts"."expiry_date"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."goods_receipts"."expiry_date" IS 'Expiration date for perishable goods';


--
-- Name: COLUMN "goods_receipts"."storage_location_id"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."goods_receipts"."storage_location_id" IS 'Where the goods were stored upon receipt';


--
-- Name: COLUMN "goods_receipts"."bin_id"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."goods_receipts"."bin_id" IS 'Specific bin where goods were placed';


--
-- Name: COLUMN "goods_receipts"."notes"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."goods_receipts"."notes" IS 'Additional notes about the receipt (damage, discrepancies, etc.)';


--
-- Name: COLUMN "goods_receipts"."received_by"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."goods_receipts"."received_by" IS 'User who received and processed the goods';


--
-- Name: intercompany_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."intercompany_transactions" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "reference" character varying(40) NOT NULL,
    "from_company_id" "uuid" NOT NULL,
    "to_company_id" "uuid" NOT NULL,
    "transaction_type" character varying(30) DEFAULT 'TRANSFER'::character varying NOT NULL,
    "amount" numeric(15,2) NOT NULL,
    "currency" character varying(3) DEFAULT 'USD'::character varying NOT NULL,
    "exchange_rate" numeric(18,8) DEFAULT 1 NOT NULL,
    "transaction_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "description" "text",
    "from_journal_entry_id" "uuid",
    "to_journal_entry_id" "uuid",
    "status" character varying(20) DEFAULT 'DRAFT'::character varying NOT NULL,
    "eliminated_at" timestamp with time zone,
    "eliminated_in_period" character varying(7),
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "chk_intercompany_both_legs" CHECK (((("status")::"text" <> 'POSTED'::"text") OR (("from_journal_entry_id" IS NOT NULL) AND ("to_journal_entry_id" IS NOT NULL)))),
    CONSTRAINT "chk_intercompany_distinct" CHECK (("from_company_id" <> "to_company_id")),
    CONSTRAINT "intercompany_transactions_amount_check" CHECK (("amount" > (0)::numeric)),
    CONSTRAINT "intercompany_transactions_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('DRAFT'::character varying)::"text", ('POSTED'::character varying)::"text", ('ELIMINATED'::character varying)::"text", ('CANCELLED'::character varying)::"text"]))),
    CONSTRAINT "intercompany_transactions_transaction_type_check" CHECK ((("transaction_type")::"text" = ANY (ARRAY[('TRANSFER'::character varying)::"text", ('SALE'::character varying)::"text", ('LOAN'::character varying)::"text", ('RECHARGE'::character varying)::"text", ('ALLOCATION'::character varying)::"text"])))
);


--
-- Name: TABLE "intercompany_transactions"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."intercompany_transactions" IS 'Links the two journal entries of a transaction between group companies, so intercompany balances can be identified and eliminated on consolidation.';


--
-- Name: inventory_code_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."inventory_code_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: SEQUENCE "inventory_code_seq"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON SEQUENCE "public"."inventory_code_seq" IS 'Sequence for generating unique inventory codes';


--
-- Name: inventory_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."inventory_items" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "item_master_id" "uuid" NOT NULL,
    "current_stock_quantity" numeric(12,4) DEFAULT 0 NOT NULL,
    "minimum_stock_level" numeric(12,4),
    "maximum_stock_level" numeric(12,4),
    "reorder_point" numeric(12,4),
    "unit_price" numeric(12,2),
    "currency" character varying(3) DEFAULT 'USD'::character varying,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "status" character varying(20) DEFAULT 'PENDING_APPROVAL'::character varying NOT NULL,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "decline_reason" "text",
    "condition_grade" character varying(1),
    "condition_notes" "text",
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    "embedding" "public"."vector"(384),
    "embedding_generated_at" timestamp with time zone,
    CONSTRAINT "inventory_items_condition_grade_check" CHECK ((("condition_grade")::"text" = ANY (ARRAY[('A'::character varying)::"text", ('B'::character varying)::"text", ('C'::character varying)::"text", ('D'::character varying)::"text"]))),
    CONSTRAINT "inventory_items_current_stock_quantity_check" CHECK (("current_stock_quantity" >= (0)::numeric)),
    CONSTRAINT "inventory_items_positive_max_stock_check" CHECK ((("maximum_stock_level" IS NULL) OR ("maximum_stock_level" >= (0)::numeric))),
    CONSTRAINT "inventory_items_positive_price_check" CHECK ((("unit_price" IS NULL) OR ("unit_price" > (0)::numeric))),
    CONSTRAINT "inventory_items_positive_reorder_check" CHECK ((("minimum_stock_level" IS NULL) OR ("minimum_stock_level" >= (0)::numeric))),
    CONSTRAINT "inventory_items_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('PENDING_APPROVAL'::character varying)::"text", ('APPROVED'::character varying)::"text", ('DECLINED'::character varying)::"text"]))),
    CONSTRAINT "inventory_items_stock_level_logic_check" CHECK ((("minimum_stock_level" IS NULL) OR ("maximum_stock_level" IS NULL) OR ("minimum_stock_level" <= "maximum_stock_level")))
);

ALTER TABLE ONLY "public"."inventory_items" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "inventory_items"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."inventory_items" IS 'Inventory items extending approved item masters with inventory-specific data';


--
-- Name: COLUMN "inventory_items"."item_master_id"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."inventory_items"."item_master_id" IS 'Reference to approved item master record';


--
-- Name: COLUMN "inventory_items"."current_stock_quantity"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."inventory_items"."current_stock_quantity" IS 'Current stock quantity - updated only via stock transactions';


--
-- Name: COLUMN "inventory_items"."minimum_stock_level"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."inventory_items"."minimum_stock_level" IS 'Minimum stock level that triggers alerts (requires approval)';


--
-- Name: COLUMN "inventory_items"."maximum_stock_level"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."inventory_items"."maximum_stock_level" IS 'Maximum stock level for inventory planning (requires approval)';


--
-- Name: COLUMN "inventory_items"."reorder_point"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."inventory_items"."reorder_point" IS 'Stock quantity that triggers replenishment orders';


--
-- Name: COLUMN "inventory_items"."unit_price"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."inventory_items"."unit_price" IS 'Unit price for this inventory item';


--
-- Name: COLUMN "inventory_items"."currency"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."inventory_items"."currency" IS 'Currency for unit price (e.g., USD, EUR)';


--
-- Name: COLUMN "inventory_items"."status"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."inventory_items"."status" IS 'Approval status: PENDING_APPROVAL, APPROVED, DECLINED';


--
-- Name: COLUMN "inventory_items"."approved_by"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."inventory_items"."approved_by" IS 'Manager who approved/declined the inventory item';


--
-- Name: COLUMN "inventory_items"."approved_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."inventory_items"."approved_at" IS 'Timestamp when the inventory item was approved';


--
-- Name: COLUMN "inventory_items"."decline_reason"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."inventory_items"."decline_reason" IS 'Reason for declining the inventory item';


--
-- Name: COLUMN "inventory_items"."condition_grade"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."inventory_items"."condition_grade" IS 'Item condition grade: A (Excellent/New), B (Good), C (Fair), D (Poor)';


--
-- Name: COLUMN "inventory_items"."condition_notes"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."inventory_items"."condition_notes" IS 'Additional notes about the item condition';


--
-- Name: COLUMN "inventory_items"."embedding"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."inventory_items"."embedding" IS 'pgvector(384) — all-MiniLM-L6-v2 via services/ai/localEmbeddings.js, run in-process (no external API). Searched with the <=> cosine-distance operator. NULL until backfilled.';


--
-- Name: inventory_storage_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."inventory_storage_mappings" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "inventory_item_id" "uuid" NOT NULL,
    "storage_location_id" "uuid" NOT NULL,
    "bin_id" "uuid",
    "quantity_in_location" numeric(12,4) DEFAULT 0 NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "status" character varying(50) DEFAULT 'PENDING_APPROVAL'::character varying,
    CONSTRAINT "inventory_storage_mappings_positive_quantity_check" CHECK (("quantity_in_location" >= (0)::numeric))
);


--
-- Name: TABLE "inventory_storage_mappings"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."inventory_storage_mappings" IS 'Many-to-many mapping of inventory items to storage locations and bins';


--
-- Name: COLUMN "inventory_storage_mappings"."inventory_item_id"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."inventory_storage_mappings"."inventory_item_id" IS 'Reference to inventory item';


--
-- Name: COLUMN "inventory_storage_mappings"."storage_location_id"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."inventory_storage_mappings"."storage_location_id" IS 'Reference to storage location';


--
-- Name: COLUMN "inventory_storage_mappings"."bin_id"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."inventory_storage_mappings"."bin_id" IS 'Optional reference to specific bin within location';


--
-- Name: COLUMN "inventory_storage_mappings"."quantity_in_location"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."inventory_storage_mappings"."quantity_in_location" IS 'Quantity stored in this specific location/bin';


--
-- Name: COLUMN "inventory_storage_mappings"."status"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."inventory_storage_mappings"."status" IS 'Status of the storage assignment: PENDING_APPROVAL, APPROVED, DECLINED';


--
-- Name: inventory_transfers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."inventory_transfers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "transfer_number" character varying(50) NOT NULL,
    "inventory_item_id" "uuid" NOT NULL,
    "quantity" numeric(15,4) NOT NULL,
    "source_storage_location_id" "uuid" NOT NULL,
    "source_bin_id" "uuid",
    "destination_storage_location_id" "uuid" NOT NULL,
    "destination_bin_id" "uuid",
    "status" character varying(20) DEFAULT 'IN_TRANSIT'::character varying NOT NULL,
    "notes" "text",
    "dispatched_by" "uuid",
    "dispatched_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "received_by" "uuid",
    "received_at" timestamp with time zone,
    "cancelled_by" "uuid",
    "cancelled_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "inventory_transfers_quantity_check" CHECK (("quantity" > (0)::numeric)),
    CONSTRAINT "inventory_transfers_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('IN_TRANSIT'::character varying)::"text", ('RECEIVED'::character varying)::"text", ('CANCELLED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."inventory_transfers" FORCE ROW LEVEL SECURITY;


--
-- Name: items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."items" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "item_code" character varying(50) NOT NULL,
    "name" character varying(255) NOT NULL,
    "description" "text",
    "stock_code" character varying(3) NOT NULL,
    "status" character varying(20) DEFAULT 'DRAFT'::character varying NOT NULL,
    "criticality" character varying(10) DEFAULT 'LOW'::character varying NOT NULL,
    "unit_of_measure" character varying(20) DEFAULT 'pcs'::character varying NOT NULL,
    "unspsc_code" character varying(8),
    "manufacturer" character varying(255),
    "manufacturer_part_number" character varying(100),
    "item_category" character varying(100),
    "serial_number" character varying(100),
    "equipment_tag" character varying(50),
    "has_contract" boolean DEFAULT false,
    "contract_number" character varying(50),
    "has_barcode" boolean DEFAULT false,
    "barcode" character varying(100),
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "is_stock_item" boolean DEFAULT true NOT NULL,
    "planned_stock" boolean DEFAULT false NOT NULL,
    "decline_reason" "text",
    "approved_item_code" character varying(50),
    "user_id" "uuid",
    "volume" numeric(12,6),
    "mass" numeric(10,3),
    "mass_per_uom" numeric(10,6),
    "volume_per_uom" numeric(10,6),
    "sku" character varying(100),
    "category" character varying(100),
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "items_criticality_check" CHECK ((("criticality")::"text" = ANY (ARRAY[('LOW'::character varying)::"text", ('MEDIUM'::character varying)::"text", ('HIGH'::character varying)::"text"]))),
    CONSTRAINT "items_positive_mass_check" CHECK ((("mass" IS NULL) OR ("mass" > (0)::numeric))),
    CONSTRAINT "items_positive_mass_per_uom_check" CHECK ((("mass_per_uom" IS NULL) OR ("mass_per_uom" > (0)::numeric))),
    CONSTRAINT "items_positive_volume_check" CHECK ((("volume" IS NULL) OR ("volume" > (0)::numeric))),
    CONSTRAINT "items_positive_volume_per_uom_check" CHECK ((("volume_per_uom" IS NULL) OR ("volume_per_uom" > (0)::numeric))),
    CONSTRAINT "items_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('DRAFT'::character varying)::"text", ('PENDING_REVIEW'::character varying)::"text", ('APPROVED'::character varying)::"text"]))),
    CONSTRAINT "items_stock_code_check" CHECK ((("stock_code")::"text" = ANY (ARRAY[('ST1'::character varying)::"text", ('ST2'::character varying)::"text", ('NS3'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."items" FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN "items"."decline_reason"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."items"."decline_reason" IS 'Reason for declining the item master during approval process';


--
-- Name: COLUMN "items"."approved_item_code"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."items"."approved_item_code" IS 'Final inventory code assigned after approval (INV-XXXXXXXX format)';


--
-- Name: COLUMN "items"."user_id"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."items"."user_id" IS 'References the user who created/owns this item';


--
-- Name: COLUMN "items"."volume"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."items"."volume" IS 'Total volume in cubic meters (6 decimal precision)';


--
-- Name: COLUMN "items"."mass"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."items"."mass" IS 'Item mass in kilograms (kg) for warehouse capacity calculation';


--
-- Name: COLUMN "items"."mass_per_uom"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."items"."mass_per_uom" IS 'Mass per unit of measure in kilograms (kg) - used for accurate inventory calculations';


--
-- Name: COLUMN "items"."volume_per_uom"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."items"."volume_per_uom" IS 'Volume per unit of measure in cubic meters (6 decimal precision)';


--
-- Name: journal_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."journal_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "journal_number" character varying(50) NOT NULL,
    "entry_date" "date" NOT NULL,
    "posting_date" "date" NOT NULL,
    "period_year" integer NOT NULL,
    "period_month" integer NOT NULL,
    "source_type" character varying(100) NOT NULL,
    "source_id" "uuid",
    "source_document" character varying(100),
    "description" "text" NOT NULL,
    "reference" character varying(255),
    "total_debit" numeric(15,2) DEFAULT 0.00 NOT NULL,
    "total_credit" numeric(15,2) DEFAULT 0.00 NOT NULL,
    "status" character varying(50) DEFAULT 'DRAFT'::character varying NOT NULL,
    "requires_approval" boolean DEFAULT false,
    "is_reversing_entry" boolean DEFAULT false,
    "original_entry_id" "uuid",
    "currency" character varying(3) DEFAULT 'USD'::character varying,
    "exchange_rate" numeric(10,6) DEFAULT 1.000000,
    "batch_id" character varying(100),
    "external_reference" character varying(255),
    "notes" "text",
    "created_by" "uuid" NOT NULL,
    "updated_by" "uuid",
    "approved_by" "uuid",
    "posted_by" "uuid",
    "approved_at" timestamp with time zone,
    "posted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    "posting_key" character varying(200),
    CONSTRAINT "chk_journal_balance" CHECK (("total_debit" = "total_credit")),
    CONSTRAINT "chk_journal_currency_valid" CHECK ((("currency")::"text" ~ '^[A-Z]{3}$'::"text")),
    CONSTRAINT "chk_journal_exchange_rate_positive" CHECK (("exchange_rate" > (0)::numeric)),
    CONSTRAINT "chk_journal_period_month_valid" CHECK ((("period_month" >= 1) AND ("period_month" <= 12))),
    CONSTRAINT "chk_journal_period_year_valid" CHECK ((("period_year" >= 2020) AND ("period_year" <= 2100))),
    CONSTRAINT "chk_journal_source_type_valid" CHECK ((("source_type")::"text" = ANY (ARRAY[('MANUAL'::character varying)::"text", ('SALES_ORDER'::character varying)::"text", ('PURCHASE_ORDER'::character varying)::"text", ('INVENTORY_ADJUSTMENT'::character varying)::"text", ('DEPRECIATION'::character varying)::"text", ('PAYROLL'::character varying)::"text", ('BANK_TRANSACTION'::character varying)::"text", ('FIXED_ASSET'::character varying)::"text", ('AUTOMATED'::character varying)::"text", ('GOODS_ISSUE'::character varying)::"text", ('GOODS_RECEIPT'::character varying)::"text", ('WORK_ORDER_ISSUE'::character varying)::"text", ('WORK_ORDER_COMPLETION'::character varying)::"text", ('WORK_ORDER_VARIANCE'::character varying)::"text", ('INTERCOMPANY'::character varying)::"text", ('ASSET_REVALUATION'::character varying)::"text", ('AI_CONTINUOUS_CLOSE'::character varying)::"text", ('YEAR_END_CLOSE'::character varying)::"text", ('GR_IR_CLEARING'::character varying)::"text", ('SALES_CREDIT_NOTE'::character varying)::"text", ('LANDED_COST'::character varying)::"text", ('REVENUE_SCHEDULE'::character varying)::"text", ('PROJECT_BILLING'::character varying)::"text", ('DIRECT_INVOICE'::character varying)::"text"]))),
    CONSTRAINT "chk_journal_status_valid" CHECK ((("status")::"text" = ANY (ARRAY[('DRAFT'::character varying)::"text", ('PENDING_APPROVAL'::character varying)::"text", ('APPROVED'::character varying)::"text", ('POSTED'::character varying)::"text", ('REJECTED'::character varying)::"text", ('REVERSED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."journal_entries" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "journal_entries"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."journal_entries" IS 'General ledger journal entries with approval workflow and automated posting';


--
-- Name: COLUMN "journal_entries"."posting_key"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."journal_entries"."posting_key" IS 'Optional idempotency key naming this specific posting (not the source document). Set it when a posting must happen at most once; leave NULL for postings that legitimately recur, such as periodic depreciation or partial supplier billing.';


--
-- Name: journal_entry_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."journal_entry_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "journal_entry_id" "uuid" NOT NULL,
    "line_number" integer NOT NULL,
    "account_id" "uuid" NOT NULL,
    "account_code" character varying(20) NOT NULL,
    "account_name" character varying(255) NOT NULL,
    "debit_amount" numeric(15,2) DEFAULT 0.00,
    "credit_amount" numeric(15,2) DEFAULT 0.00,
    "department_id" "uuid",
    "project_id" "uuid",
    "cost_center_id" "uuid",
    "description" "text",
    "reference" character varying(255),
    "currency" character varying(3) DEFAULT 'USD'::character varying,
    "exchange_rate" numeric(10,6) DEFAULT 1.000000,
    "original_amount" numeric(15,2),
    "original_currency" character varying(3),
    "allocation_percentage" numeric(5,2),
    "allocation_basis" character varying(100),
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chk_journal_item_allocation_valid" CHECK ((("allocation_percentage" IS NULL) OR (("allocation_percentage" > (0)::numeric) AND ("allocation_percentage" <= (100)::numeric)))),
    CONSTRAINT "chk_journal_item_amounts_valid" CHECK (((("debit_amount" > (0)::numeric) AND ("credit_amount" = (0)::numeric)) OR (("credit_amount" > (0)::numeric) AND ("debit_amount" = (0)::numeric)))),
    CONSTRAINT "chk_journal_item_line_positive" CHECK (("line_number" > 0))
);


--
-- Name: TABLE "journal_entry_items"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."journal_entry_items" IS 'Individual line items within journal entries with dimensional analysis';


--
-- Name: journal_entry_status_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."journal_entry_status_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "journal_entry_id" "uuid" NOT NULL,
    "from_status" character varying(50),
    "to_status" character varying(50) NOT NULL,
    "status_date" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "changed_by" "uuid",
    "reason" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: TABLE "journal_entry_status_history"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."journal_entry_status_history" IS 'Audit trail for journal entry status changes';


--
-- Name: kb_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."kb_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    "title" character varying(255) NOT NULL,
    "file_name" "text",
    "source_format" "text" DEFAULT 'text'::"text" NOT NULL,
    "body" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "error_message" "text",
    "chunk_count" integer DEFAULT 0 NOT NULL,
    "uploaded_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "kb_documents_source_format_check" CHECK (("source_format" = ANY (ARRAY['text'::"text", 'markdown'::"text", 'html'::"text", 'pdf'::"text"]))),
    CONSTRAINT "kb_documents_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'indexed'::"text", 'failed'::"text"])))
);

ALTER TABLE ONLY "public"."kb_documents" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "kb_documents"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."kb_documents" IS 'Company-uploaded knowledge base documents (policies, procedures) — metadata + extracted plain text. Chunks/embeddings live in document_embeddings under source_type = ''kb_document''. See services/ai/knowledgeBase.js.';


--
-- Name: landed_cost_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."landed_cost_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "voucher_id" "uuid" NOT NULL,
    "goods_receipt_id" "uuid",
    "inventory_item_id" "uuid",
    "allocated_amount" numeric(15,2) NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: landed_cost_vouchers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."landed_cost_vouchers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "voucher_number" character varying(50) NOT NULL,
    "posting_date" "date" NOT NULL,
    "total_landed_cost" numeric(15,2) NOT NULL,
    "allocation_method" character varying(20) DEFAULT 'VALUE'::character varying,
    "status" character varying(20) DEFAULT 'DRAFT'::character varying,
    "notes" "text",
    "journal_entry_id" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "landed_cost_vouchers_allocation_method_check" CHECK ((("allocation_method")::"text" = ANY (ARRAY[('VALUE'::character varying)::"text", ('WEIGHT'::character varying)::"text", ('VOLUME'::character varying)::"text", ('EQUAL'::character varying)::"text"]))),
    CONSTRAINT "landed_cost_vouchers_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('DRAFT'::character varying)::"text", ('POSTED'::character varying)::"text", ('CANCELLED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."landed_cost_vouchers" FORCE ROW LEVEL SECURITY;


--
-- Name: leads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."leads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lead_number" "text" NOT NULL,
    "company_name" "text",
    "contact_name" "text" NOT NULL,
    "email" "text",
    "phone" "text",
    "source" "text",
    "status" "text" DEFAULT 'NEW'::"text" NOT NULL,
    "potential_value" numeric(15,2),
    "ai_score" integer,
    "assigned_to" "uuid",
    "converted_to_customer_id" "uuid",
    "converted_to_quotation_id" "uuid",
    "notes" "text",
    "next_follow_up" "date",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "deleted_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    "updated_by" "uuid",
    CONSTRAINT "leads_ai_score_check" CHECK ((("ai_score" >= 0) AND ("ai_score" <= 100))),
    CONSTRAINT "leads_status_check" CHECK (("status" = ANY (ARRAY['NEW'::"text", 'CONTACTED'::"text", 'QUALIFIED'::"text", 'PROPOSAL_SENT'::"text", 'WON'::"text", 'LOST'::"text"])))
);

ALTER TABLE ONLY "public"."leads" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "leads"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."leads" IS 'CRM leads/opportunities pipeline — qualified leads feed into sales quotations. AI lead-scoring populates ai_score.';


--
-- Name: COLUMN "leads"."updated_by"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."leads"."updated_by" IS 'User who last updated this lead (routes/leads.js PATCH /:id). Nullable: rows updated before this column existed, or by a system process, have no attribution.';


--
-- Name: leave_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."leave_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "employee_id" "uuid" NOT NULL,
    "leave_type" "text" NOT NULL,
    "start_date" "date" NOT NULL,
    "end_date" "date" NOT NULL,
    "total_days" numeric(5,1) NOT NULL,
    "status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "reason" "text",
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "deleted_at" timestamp with time zone,
    CONSTRAINT "leave_dates_valid" CHECK (("end_date" >= "start_date")),
    CONSTRAINT "leave_requests_leave_type_check" CHECK (("leave_type" = ANY (ARRAY['ANNUAL'::"text", 'SICK'::"text", 'UNPAID'::"text", 'MATERNITY'::"text", 'PATERNITY'::"text", 'OTHER'::"text"]))),
    CONSTRAINT "leave_requests_status_check" CHECK (("status" = ANY (ARRAY['PENDING'::"text", 'APPROVED'::"text", 'REJECTED'::"text", 'CANCELLED'::"text"])))
);


--
-- Name: TABLE "leave_requests"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."leave_requests" IS 'Employee leave requests — approved leave feeds into payroll deductions.';


--
-- Name: loan_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."loan_schedules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), '11111111-1111-1111-1111-111111111111'::"uuid") NOT NULL,
    "loan_name" character varying(200) NOT NULL,
    "lender" character varying(200),
    "next_payment_date" "date" NOT NULL,
    "payment_amount" numeric(15,2) NOT NULL,
    "frequency" character varying(20) DEFAULT 'MONTHLY'::character varying NOT NULL,
    "remaining_payments" integer,
    "status" character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "deleted_at" timestamp with time zone,
    CONSTRAINT "loan_schedules_frequency_check" CHECK ((("frequency")::"text" = ANY (ARRAY[('WEEKLY'::character varying)::"text", ('BIWEEKLY'::character varying)::"text", ('MONTHLY'::character varying)::"text", ('QUARTERLY'::character varying)::"text"]))),
    CONSTRAINT "loan_schedules_payment_amount_check" CHECK (("payment_amount" > (0)::numeric)),
    CONSTRAINT "loan_schedules_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('ACTIVE'::character varying)::"text", ('PAID_OFF'::character varying)::"text", ('CANCELLED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."loan_schedules" FORCE ROW LEVEL SECURITY;


--
-- Name: mcp_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."mcp_connections" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "name" character varying(160) NOT NULL,
    "description" "text",
    "url_or_package" character varying(500) NOT NULL,
    "status" character varying(20) DEFAULT 'connected'::character varying NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "category" character varying(80),
    "tools_preview" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "endpoint_url" "text",
    "auth_type" character varying(20),
    "credential_id" "uuid",
    "tools_cache" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "tools_synced_at" timestamp with time zone,
    "last_error" "text",
    "slug" character varying(24),
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "mcp_connections_auth_type_check" CHECK ((("auth_type")::"text" = ANY (ARRAY[('none'::character varying)::"text", ('api_key'::character varying)::"text", ('oauth'::character varying)::"text"]))),
    CONSTRAINT "mcp_connections_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('pending_auth'::character varying)::"text", ('connected'::character varying)::"text", ('disconnected'::character varying)::"text", ('error'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."mcp_connections" FORCE ROW LEVEL SECURITY;


--
-- Name: mcp_oauth_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."mcp_oauth_grants" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "connection_id" "uuid" NOT NULL,
    "access_token_cipher" "text",
    "access_token_iv" character varying(32),
    "access_token_tag" character varying(32),
    "refresh_token_cipher" "text",
    "refresh_token_iv" character varying(32),
    "refresh_token_tag" character varying(32),
    "access_token_expires_at" timestamp with time zone,
    "authorization_endpoint" "text",
    "token_endpoint" "text" NOT NULL,
    "client_id" "text",
    "client_secret_cipher" "text",
    "client_secret_iv" character varying(32),
    "client_secret_tag" character varying(32),
    "scope" "text",
    "resource" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL
);

ALTER TABLE ONLY "public"."mcp_oauth_grants" FORCE ROW LEVEL SECURITY;


--
-- Name: mcp_oauth_pending; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."mcp_oauth_pending" (
    "state" character varying(64) NOT NULL,
    "connection_id" "uuid" NOT NULL,
    "code_verifier" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "expires_at" timestamp with time zone NOT NULL
);


--
-- Name: modules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."modules" (
    "key" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "is_core" boolean DEFAULT false NOT NULL,
    "nav_section" "text"
);


--
-- Name: TABLE "modules"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."modules" IS 'Toggleable feature areas. is_core=true modules are always on; others are governed by company_modules (per-tenant) seeded from business_type_default_modules at signup.';


--
-- Name: mrp_planned_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."mrp_planned_orders" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "run_id" "uuid" NOT NULL,
    "item_id" "uuid" NOT NULL,
    "order_type" character varying(20) NOT NULL,
    "quantity" numeric(15,4) NOT NULL,
    "required_by" "date",
    "bom_level" integer DEFAULT 0 NOT NULL,
    "gross_requirement" numeric(15,4) DEFAULT 0 NOT NULL,
    "on_hand" numeric(15,4) DEFAULT 0 NOT NULL,
    "net_requirement" numeric(15,4) DEFAULT 0 NOT NULL,
    "demand_source" character varying(40),
    "rationale" "text",
    "status" character varying(20) DEFAULT 'PLANNED'::character varying NOT NULL,
    "converted_to_id" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "mrp_planned_orders_order_type_check" CHECK ((("order_type")::"text" = ANY (ARRAY[('MAKE'::character varying)::"text", ('BUY'::character varying)::"text"]))),
    CONSTRAINT "mrp_planned_orders_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('PLANNED'::character varying)::"text", ('CONVERTED'::character varying)::"text", ('DISMISSED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."mrp_planned_orders" FORCE ROW LEVEL SECURITY;


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."notifications" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "type" character varying(50) NOT NULL,
    "title" character varying(255) NOT NULL,
    "message" "text" NOT NULL,
    "data" "jsonb",
    "is_read" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "read_at" timestamp with time zone,
    "user_id" "uuid",
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "notifications_type_check" CHECK ((("type")::"text" = ANY (ARRAY['item_master_submitted'::"text", 'item_master_approved'::"text", 'item_master_declined'::"text", 'inventory_item_submitted'::"text", 'inventory_item_approved'::"text", 'inventory_item_declined'::"text", 'storage_assignment_submitted'::"text", 'storage_assignment_approved'::"text", 'storage_assignment_declined'::"text", 'storage_location_submitted'::"text", 'storage_location_approved'::"text", 'storage_location_declined'::"text", 'bin_submitted'::"text", 'bin_approved'::"text", 'bin_declined'::"text", 'supplier_submitted'::"text", 'supplier_approved'::"text", 'supplier_declined'::"text", 'supplier_certified'::"text", 'supplier_decertified'::"text", 'supplier_partnership_accepted'::"text", 'supplier_partnership_declined'::"text", 'pr_submitted'::"text", 'pr_approved'::"text", 'pr_declined'::"text", 'rfq_sent'::"text", 'rfq_response_received'::"text", 'rfq_supplier_selected'::"text", 'po_submitted'::"text", 'po_approved'::"text", 'po_sent_to_supplier'::"text", 'po_confirmed'::"text", 'po_supplier_confirmed'::"text", 'po_supplier_rejected'::"text", 'po_items_received'::"text", 'po_delivery_verified'::"text", 'po_delivery_issue'::"text", 'po_delivered_to_customer'::"text", 'po_customer_confirmed'::"text", 'contract_created'::"text", 'contract_sent_to_supplier'::"text", 'contract_activated'::"text", 'contract_expiring'::"text", 'sales_quotation_submitted'::"text", 'sales_quotation_approved'::"text", 'SALES_CONTRACT_SUBMITTED'::"text", 'SALES_ORDER_APPROVED'::"text", 'SALES_ORDER_CUSTOMER_CONFIRMED'::"text", 'SALES_RFQ_PROCUREMENT_APPROVED'::"text", 'SALES_RFQ_SALES_APPROVED'::"text", 'SALES_RFQ_SENT_TO_SUPPLIER'::"text", 'AI_FINDING'::"text", 'SALES_ORDER_PENDING_APPROVAL'::"text", 'SALES_ORDER_REJECTED'::"text"])))
);

ALTER TABLE ONLY "public"."notifications" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "notifications"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."notifications" IS 'System notifications for approval/decline actions';


--
-- Name: COLUMN "notifications"."type"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."notifications"."type" IS 'Type of notification (approval, decline, approval_request, GENERAL)';


--
-- Name: COLUMN "notifications"."data"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."notifications"."data" IS 'JSON data containing context-specific information';


--
-- Name: COLUMN "notifications"."is_read"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."notifications"."is_read" IS 'Whether the notification has been read';


--
-- Name: COLUMN "notifications"."read_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."notifications"."read_at" IS 'Timestamp when notification was marked as read';


--
-- Name: COLUMN "notifications"."user_id"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."notifications"."user_id" IS 'References the user who should receive this notification';


--
-- Name: packing_lists; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."packing_lists" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "shipment_id" "uuid" NOT NULL,
    "item_id" "uuid" NOT NULL,
    "quantity_packed" numeric(15,4) NOT NULL,
    "box_number" integer DEFAULT 1,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: password_reset_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."password_reset_tokens" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "token_hash" character varying(64) NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "used" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: TABLE "password_reset_tokens"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."password_reset_tokens" IS 'Single-use, expiring tokens for the forgot-password flow. token_hash is sha256(token); the plaintext token only ever exists in the emailed link.';


--
-- Name: payroll_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."payroll_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "payroll_run_id" "uuid" NOT NULL,
    "employee_id" "uuid" NOT NULL,
    "employee_name" character varying(255),
    "gross_salary" numeric(15,2) DEFAULT 0 NOT NULL,
    "deductions" numeric(15,2) DEFAULT 0 NOT NULL,
    "net_salary" numeric(15,2) DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "federal_tax_withheld" numeric(15,2) DEFAULT 0 NOT NULL,
    "social_security_employee" numeric(15,2) DEFAULT 0 NOT NULL,
    "medicare_employee" numeric(15,2) DEFAULT 0 NOT NULL,
    "social_security_employer" numeric(15,2) DEFAULT 0 NOT NULL,
    "medicare_employer" numeric(15,2) DEFAULT 0 NOT NULL
);


--
-- Name: COLUMN "payroll_items"."social_security_employer"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."payroll_items"."social_security_employer" IS 'Employer-matched portion — a real cost to the company, not withheld from the employee, but not part of net pay either. Posted to its own payroll tax expense/payable line.';


--
-- Name: payroll_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."payroll_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "run_number" character varying(30) NOT NULL,
    "period_year" integer NOT NULL,
    "period_month" integer NOT NULL,
    "status" character varying(20) DEFAULT 'DRAFT'::character varying NOT NULL,
    "total_gross" numeric(15,2) DEFAULT 0 NOT NULL,
    "total_deductions" numeric(15,2) DEFAULT 0 NOT NULL,
    "total_net" numeric(15,2) DEFAULT 0 NOT NULL,
    "journal_entry_id" "uuid",
    "notes" "text",
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    "employer_payroll_tax" numeric(15,2) DEFAULT 0 NOT NULL,
    CONSTRAINT "chk_payroll_month" CHECK ((("period_month" >= 1) AND ("period_month" <= 12))),
    CONSTRAINT "chk_payroll_run_status" CHECK ((("status")::"text" = ANY (ARRAY[('DRAFT'::character varying)::"text", ('PROCESSED'::character varying)::"text", ('POSTED'::character varying)::"text", ('PAID'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."payroll_runs" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "payroll_runs"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."payroll_runs" IS 'Monthly payroll runs posted to the GL';


--
-- Name: COLUMN "payroll_runs"."employer_payroll_tax"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."payroll_runs"."employer_payroll_tax" IS 'Sum of employer-matched FICA across the run — a real additional expense to the company, posted as its own journal entry line by PayrollRun.post(), separate from gross wages.';


--
-- Name: pdf_template_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."pdf_template_versions" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "template_id" "uuid" NOT NULL,
    "version" integer NOT NULL,
    "snapshot" "jsonb" NOT NULL,
    "note" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: pdf_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."pdf_templates" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "key" character varying(64) NOT NULL,
    "name" character varying(160) NOT NULL,
    "description" "text",
    "page_size" character varying(12) DEFAULT 'A4'::character varying NOT NULL,
    "orientation" character varying(10) DEFAULT 'portrait'::character varying NOT NULL,
    "margin" integer DEFAULT 50 NOT NULL,
    "header" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "footer" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "colors" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "fonts" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "sections" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "is_builtin" boolean DEFAULT false NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "created_by" "uuid",
    "updated_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "pdf_templates_key_check" CHECK ((("key")::"text" ~ '^[a-z][a-z0-9_]{2,63}$'::"text")),
    CONSTRAINT "pdf_templates_margin_check" CHECK ((("margin" >= 10) AND ("margin" <= 150))),
    CONSTRAINT "pdf_templates_orientation_check" CHECK ((("orientation")::"text" = ANY (ARRAY[('portrait'::character varying)::"text", ('landscape'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."pdf_templates" FORCE ROW LEVEL SECURITY;


--
-- Name: period_close_checklist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."period_close_checklist" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "period_id" "uuid" NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    "check_key" character varying(80) NOT NULL,
    "check_name" character varying(200) NOT NULL,
    "severity" character varying(10) NOT NULL,
    "passed" boolean NOT NULL,
    "owner" character varying(120) NOT NULL,
    "signed_by" "uuid",
    "signed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "period_close_checklist_severity_check" CHECK ((("severity")::"text" = ANY (ARRAY[('BLOCKING'::character varying)::"text", ('WARNING'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."period_close_checklist" FORCE ROW LEVEL SECURITY;


--
-- Name: plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."plans" (
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "price_cents" integer DEFAULT 0 NOT NULL,
    "billing_interval" "text",
    "max_seats" integer,
    "max_ai_messages_per_month" integer,
    "max_embedding_calls_per_month" integer,
    "features" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "stripe_price_id" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    CONSTRAINT "plans_billing_interval_check" CHECK (("billing_interval" = ANY (ARRAY['month'::"text", 'year'::"text"])))
);


--
-- Name: TABLE "plans"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."plans" IS 'Global plan catalogue (free/pro/enterprise) — what each tier costs and allows.';


--
-- Name: po_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."po_number_seq"
    START WITH 1000
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pr_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."pr_number_seq"
    START WITH 1000
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: price_list_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."price_list_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "price_list_id" "uuid" NOT NULL,
    "item_id" "uuid" NOT NULL,
    "min_quantity" numeric(15,4) DEFAULT 1.0,
    "unit_price" numeric(15,4) NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: price_lists; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."price_lists" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" character varying(255) NOT NULL,
    "code" character varying(50) NOT NULL,
    "currency" character varying(10) DEFAULT 'USD'::character varying,
    "customer_id" "uuid",
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL
);

ALTER TABLE ONLY "public"."price_lists" FORCE ROW LEVEL SECURITY;


--
-- Name: procurement_rfq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."procurement_rfq_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: project_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."project_tasks" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "name" character varying(200) NOT NULL,
    "description" "text",
    "status" character varying(20) DEFAULT 'TODO'::character varying NOT NULL,
    "assignee_id" "uuid",
    "estimated_hours" numeric(10,2),
    "due_date" "date",
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "project_tasks_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('TODO'::character varying)::"text", ('IN_PROGRESS'::character varying)::"text", ('DONE'::character varying)::"text", ('CANCELLED'::character varying)::"text"])))
);


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."projects" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "project_code" character varying(30) NOT NULL,
    "name" character varying(200) NOT NULL,
    "description" "text",
    "customer_id" "uuid",
    "billing_type" character varying(20) DEFAULT 'TIME_AND_MATERIALS'::character varying NOT NULL,
    "default_hourly_rate" numeric(15,2),
    "fixed_price" numeric(15,2),
    "budget_hours" numeric(12,2),
    "currency" character varying(3) DEFAULT 'USD'::character varying NOT NULL,
    "status" character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    "start_date" "date",
    "end_date" "date",
    "manager_id" "uuid",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "deleted_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "projects_billing_type_check" CHECK ((("billing_type")::"text" = ANY (ARRAY[('TIME_AND_MATERIALS'::character varying)::"text", ('FIXED_PRICE'::character varying)::"text", ('INTERNAL'::character varying)::"text"]))),
    CONSTRAINT "projects_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('PLANNED'::character varying)::"text", ('ACTIVE'::character varying)::"text", ('ON_HOLD'::character varying)::"text", ('COMPLETED'::character varying)::"text", ('CANCELLED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."projects" FORCE ROW LEVEL SECURITY;


--
-- Name: purchase_order_line_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."purchase_order_line_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "po_id" "uuid",
    "item_id" "uuid",
    "item_description" "text" NOT NULL,
    "unit_of_measure" character varying(50),
    "quantity" numeric(12,4) NOT NULL,
    "unit_price" numeric(15,4) NOT NULL,
    "line_total" numeric(15,2) GENERATED ALWAYS AS (("quantity" * "unit_price")) STORED,
    "requested_delivery_date" "date",
    "quantity_received" numeric(12,4) DEFAULT 0,
    "quantity_remaining" numeric(12,4) GENERATED ALWAYS AS (("quantity" - "quantity_received")) STORED,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: purchase_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."purchase_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "po_number" character varying(50) NOT NULL,
    "purchase_requisition_id" "uuid",
    "rfq_id" "uuid",
    "contract_id" "uuid",
    "supplier_id" "uuid" NOT NULL,
    "po_date" "date" DEFAULT CURRENT_DATE,
    "delivery_date" "date",
    "payment_terms" character varying(100),
    "incoterms" character varying(20),
    "currency" character varying(3) DEFAULT 'USD'::character varying,
    "subtotal" numeric(15,2) DEFAULT 0,
    "tax_amount" numeric(15,2) DEFAULT 0,
    "total_amount" numeric(15,2) DEFAULT 0,
    "status" character varying(50) DEFAULT 'DRAFT'::character varying,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "supplier_confirmed_at" timestamp with time zone,
    "supplier_rejected_at" timestamp with time zone,
    "rejection_reason" "text",
    "supplier_delivery_token" character varying(255),
    "supplier_delivery_due" timestamp without time zone,
    "delivery_confirmed_at" timestamp without time zone,
    "delivery_confirmed_by" "uuid",
    "delivery_notes" "text",
    "verification_notes" "text",
    "verified_at" timestamp without time zone,
    "verified_by" "uuid",
    "delivery_address" "text",
    "storage_location_id" "uuid",
    "source_type" character varying(50),
    "sales_order_id" "uuid",
    "sales_rfq_id" integer,
    "customer_confirmation_notes" "text",
    "handover_notes" "text",
    "handover_at" timestamp with time zone,
    "handover_by" "uuid",
    "supplier_delivery_token_expires_at" timestamp with time zone,
    "supplier_delivery_token_used_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    "rejected_by" "uuid",
    "rejected_at" timestamp with time zone,
    "embedding" "public"."vector"(384),
    "embedding_generated_at" timestamp with time zone,
    CONSTRAINT "purchase_orders_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('DRAFT'::character varying)::"text", ('PENDING_APPROVAL'::character varying)::"text", ('APPROVED'::character varying)::"text", ('SENT_TO_SUPPLIER'::character varying)::"text", ('CONFIRMED'::character varying)::"text", ('PREPARING_DELIVERY'::character varying)::"text", ('IN_TRANSIT'::character varying)::"text", ('DELIVERED'::character varying)::"text", ('GOODS_READY_FOR_RECEIPT'::character varying)::"text", ('READY_FOR_CUSTOMER_DELIVERY'::character varying)::"text", ('DELIVERED_TO_CUSTOMER'::character varying)::"text", ('WAITING_CUSTOMER_DELIVERY_CONFIRMATION'::character varying)::"text", ('CUSTOMER_CONFIRMED'::character varying)::"text", ('DELIVERY_ISSUE_REPORTED'::character varying)::"text", ('PARTIALLY_RECEIVED'::character varying)::"text", ('FULLY_RECEIVED'::character varying)::"text", ('COMPLETED'::character varying)::"text", ('CANCELLED'::character varying)::"text", ('REJECTED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."purchase_orders" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "purchase_orders"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."purchase_orders" IS 'Formal purchase orders sent to suppliers';


--
-- Name: COLUMN "purchase_orders"."supplier_confirmed_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."purchase_orders"."supplier_confirmed_at" IS 'Timestamp when supplier confirmed the purchase order';


--
-- Name: COLUMN "purchase_orders"."supplier_rejected_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."purchase_orders"."supplier_rejected_at" IS 'Timestamp when supplier rejected the purchase order';


--
-- Name: COLUMN "purchase_orders"."rejection_reason"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."purchase_orders"."rejection_reason" IS 'Reason provided by supplier for rejecting the purchase order';


--
-- Name: COLUMN "purchase_orders"."supplier_delivery_token"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."purchase_orders"."supplier_delivery_token" IS 'Secure token for supplier delivery status portal access';


--
-- Name: COLUMN "purchase_orders"."supplier_delivery_due"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."purchase_orders"."supplier_delivery_due" IS 'Expected delivery completion date';


--
-- Name: COLUMN "purchase_orders"."delivery_confirmed_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."purchase_orders"."delivery_confirmed_at" IS 'When supplier confirmed delivery completion';


--
-- Name: COLUMN "purchase_orders"."delivery_confirmed_by"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."purchase_orders"."delivery_confirmed_by" IS 'User who confirmed the delivery receipt';


--
-- Name: COLUMN "purchase_orders"."delivery_notes"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."purchase_orders"."delivery_notes" IS 'Supplier notes about delivery process';


--
-- Name: COLUMN "purchase_orders"."verification_notes"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."purchase_orders"."verification_notes" IS 'DoA verification notes after delivery';


--
-- Name: COLUMN "purchase_orders"."verified_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."purchase_orders"."verified_at" IS 'When DoA verified the delivery';


--
-- Name: COLUMN "purchase_orders"."verified_by"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."purchase_orders"."verified_by" IS 'DoA user who verified the delivery';


--
-- Name: COLUMN "purchase_orders"."delivery_address"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."purchase_orders"."delivery_address" IS 'Complete delivery address for supplier coordination';


--
-- Name: COLUMN "purchase_orders"."storage_location_id"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."purchase_orders"."storage_location_id" IS 'Reference to designated storage location for received goods';


--
-- Name: COLUMN "purchase_orders"."rejected_by"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."purchase_orders"."rejected_by" IS 'Manager/Admin user who rejected the purchase order during approval';


--
-- Name: COLUMN "purchase_orders"."rejected_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."purchase_orders"."rejected_at" IS 'When the purchase order was rejected';


--
-- Name: COLUMN "purchase_orders"."embedding"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."purchase_orders"."embedding" IS 'pgvector(384) — all-MiniLM-L6-v2 via services/ai/localEmbeddings.js, run in-process (no external API). Searched with the <=> cosine-distance operator. NULL until backfilled — see backend/scripts/backfill-embeddings.js.';


--
-- Name: purchase_requisitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."purchase_requisitions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "pr_number" character varying(50) NOT NULL,
    "cost_center" character varying(100),
    "requested_by" "uuid",
    "item_id" "uuid",
    "item_description" "text",
    "unit_of_measure" character varying(50),
    "quantity" numeric(12,4) NOT NULL,
    "estimated_unit_price" numeric(15,4),
    "currency" character varying(3) DEFAULT 'USD'::character varying,
    "recommended_supplier_id" "uuid",
    "supplier_recommendation_text" "text",
    "attachments" "jsonb" DEFAULT '[]'::"jsonb",
    "status" character varying(50) DEFAULT 'DRAFT'::character varying,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "decline_reason" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "purchase_requisitions_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('DRAFT'::character varying)::"text", ('SUBMITTED'::character varying)::"text", ('PENDING_APPROVAL'::character varying)::"text", ('APPROVED'::character varying)::"text", ('DECLINED'::character varying)::"text", ('CANCELLED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."purchase_requisitions" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "purchase_requisitions"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."purchase_requisitions" IS 'Internal requests for materials or services';


--
-- Name: recurring_invoice_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."recurring_invoice_schedules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "sales_contract_id" "uuid",
    "description" character varying(255) NOT NULL,
    "amount" numeric(15,2) NOT NULL,
    "tax_amount" numeric(15,2) DEFAULT 0 NOT NULL,
    "currency" character varying(3) DEFAULT 'USD'::character varying NOT NULL,
    "frequency" character varying(20) NOT NULL,
    "next_run_date" "date" NOT NULL,
    "last_run_date" "date",
    "occurrences_run" integer DEFAULT 0 NOT NULL,
    "max_occurrences" integer,
    "status" character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "recurring_invoice_schedules_amount_check" CHECK (("amount" > (0)::numeric)),
    CONSTRAINT "recurring_invoice_schedules_frequency_check" CHECK ((("frequency")::"text" = ANY (ARRAY[('MONTHLY'::character varying)::"text", ('QUARTERLY'::character varying)::"text", ('ANNUALLY'::character varying)::"text"]))),
    CONSTRAINT "recurring_invoice_schedules_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('ACTIVE'::character varying)::"text", ('PAUSED'::character varying)::"text", ('CANCELLED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."recurring_invoice_schedules" FORCE ROW LEVEL SECURITY;


--
-- Name: report_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."report_definitions" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "name" character varying(200) NOT NULL,
    "description" "text",
    "category" character varying(40) DEFAULT 'GENERAL'::character varying NOT NULL,
    "report_type" character varying(20) DEFAULT 'QUERY'::character varying NOT NULL,
    "sql_text" "text",
    "builtin_key" character varying(60),
    "parameters" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "visualization" "jsonb" DEFAULT '{"type": "table"}'::"jsonb" NOT NULL,
    "owner_id" "uuid",
    "is_shared" boolean DEFAULT false NOT NULL,
    "is_system" boolean DEFAULT false NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "deleted_at" timestamp with time zone,
    CONSTRAINT "chk_report_definition_body" CHECK ((((("report_type")::"text" = 'QUERY'::"text") AND ("sql_text" IS NOT NULL) AND ("length"("btrim"("sql_text")) > 0)) OR ((("report_type")::"text" = 'BUILTIN'::"text") AND ("builtin_key" IS NOT NULL)))),
    CONSTRAINT "report_definitions_report_type_check" CHECK ((("report_type")::"text" = ANY (ARRAY[('QUERY'::character varying)::"text", ('BUILTIN'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."report_definitions" FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN "report_definitions"."sql_text"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."report_definitions"."sql_text" IS 'Validated against the nlQuery allowlist gauntlet on save AND on every run. Run-time validation is not redundant: rows can reach this table without passing through the save path.';


--
-- Name: report_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."report_runs" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "report_id" "uuid" NOT NULL,
    "schedule_id" "uuid",
    "status" character varying(20) DEFAULT 'SUCCESS'::character varying NOT NULL,
    "row_count" integer,
    "duration_ms" integer,
    "error" "text",
    "parameter_values" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "delivered_to" "text"[],
    "run_by" "uuid",
    "run_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "report_runs_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('SUCCESS'::character varying)::"text", ('FAILED'::character varying)::"text", ('TRUNCATED'::character varying)::"text"])))
);


--
-- Name: report_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."report_schedules" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "report_id" "uuid" NOT NULL,
    "name" character varying(200),
    "interval_seconds" integer NOT NULL,
    "next_run_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "last_run_at" timestamp with time zone,
    "parameter_values" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "format" character varying(10) DEFAULT 'CSV'::character varying NOT NULL,
    "recipients" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "report_schedules_format_check" CHECK ((("format")::"text" = ANY (ARRAY[('CSV'::character varying)::"text", ('JSON'::character varying)::"text", ('HTML'::character varying)::"text", ('PDF'::character varying)::"text"]))),
    CONSTRAINT "report_schedules_interval_seconds_check" CHECK (("interval_seconds" >= 300))
);

ALTER TABLE ONLY "public"."report_schedules" FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN "report_schedules"."format"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."report_schedules"."format" IS 'CSV | JSON | HTML | PDF — HTML is sent as the mail body, the rest as attachments';


--
-- Name: request_for_quotations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."request_for_quotations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "rfq_number" character varying(50) NOT NULL,
    "purchase_requisition_id" "uuid",
    "title" character varying(255) NOT NULL,
    "description" "text",
    "response_deadline" "date",
    "currency" character varying(3) DEFAULT 'USD'::character varying,
    "status" character varying(50) DEFAULT 'DRAFT'::character varying,
    "winning_supplier_id" "uuid",
    "selection_reason" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "request_for_quotations_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('DRAFT'::character varying)::"text", ('PENDING_APPROVAL'::character varying)::"text", ('SENT'::character varying)::"text", ('RESPONSES_RECEIVED'::character varying)::"text", ('EVALUATED'::character varying)::"text", ('SUPPLIER_SELECTED'::character varying)::"text", ('CLOSED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."request_for_quotations" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "request_for_quotations"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."request_for_quotations" IS 'RFQs sent to suppliers for competitive bidding';


--
-- Name: COLUMN "request_for_quotations"."status"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."request_for_quotations"."status" IS 'RFQ Status: DRAFT -> PENDING_APPROVAL -> SENT -> RESPONSES_RECEIVED -> EVALUATED -> SUPPLIER_SELECTED -> CLOSED';


--
-- Name: revenue_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."revenue_schedules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sales_order_id" "uuid",
    "customer_invoice_id" "uuid",
    "period_date" "date" NOT NULL,
    "amount" numeric(15,2) NOT NULL,
    "status" character varying(20) DEFAULT 'SCHEDULED'::character varying,
    "journal_entry_id" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "revenue_schedules_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('SCHEDULED'::character varying)::"text", ('RECOGNIZED'::character varying)::"text", ('CANCELLED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."revenue_schedules" FORCE ROW LEVEL SECURITY;


--
-- Name: rfq_line_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."rfq_line_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "rfq_id" "uuid",
    "item_id" "uuid",
    "item_description" "text" NOT NULL,
    "unit_of_measure" character varying(50),
    "quantity" numeric(12,4) NOT NULL,
    "specifications" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: TABLE "rfq_line_items"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."rfq_line_items" IS 'Line items for procurement RFQs';


--
-- Name: rfq_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."rfq_number_seq"
    START WITH 1000
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rfq_quotations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."rfq_quotations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "rfq_id" "uuid",
    "supplier_id" "uuid",
    "rfq_line_item_id" "uuid",
    "unit_price" numeric(15,4) NOT NULL,
    "currency" character varying(3) DEFAULT 'USD'::character varying,
    "lead_time_days" integer,
    "delivery_terms" character varying(255),
    "payment_terms" character varying(100),
    "validity_days" integer DEFAULT 30,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: rfq_suppliers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."rfq_suppliers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "rfq_id" "uuid",
    "supplier_id" "uuid",
    "invited_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "response_received_at" timestamp with time zone,
    "response_status" character varying(50) DEFAULT 'INVITED'::character varying,
    CONSTRAINT "rfq_suppliers_response_status_check" CHECK ((("response_status")::"text" = ANY (ARRAY[('INVITED'::character varying)::"text", ('RESPONDED'::character varying)::"text", ('DECLINED'::character varying)::"text", ('NO_RESPONSE'::character varying)::"text"])))
);


--
-- Name: rfqs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."rfqs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "rfq_number" character varying(50) NOT NULL,
    "rfq_title" character varying(255) NOT NULL,
    "supplier_id" "uuid",
    "supplier_name" character varying(255),
    "supplier_email" character varying(255),
    "supplier_contact_person" character varying(255),
    "supplier_phone" character varying(50),
    "request_type" character varying(50) DEFAULT 'PROCUREMENT'::character varying,
    "required_delivery_date" timestamp without time zone,
    "delivery_location" "text",
    "delivery_terms" character varying(50),
    "payment_terms" character varying(255),
    "status" character varying(50) DEFAULT 'DRAFT'::character varying,
    "priority" character varying(20) DEFAULT 'MEDIUM'::character varying,
    "response_deadline" timestamp without time zone,
    "response_received_at" timestamp without time zone,
    "supplier_response_method" character varying(50) DEFAULT 'SYSTEM'::character varying,
    "special_requirements" "text",
    "terms_and_conditions" "text",
    "internal_notes" "text",
    "attachment_urls" "jsonb" DEFAULT '[]'::"jsonb",
    "budget_amount" numeric(15,2),
    "currency" character varying(10) DEFAULT 'USD'::character varying,
    "purchase_requisition_id" "uuid",
    "source_document_type" character varying(50),
    "source_document_id" "uuid",
    "supplier_total_amount" numeric(15,2),
    "supplier_currency" character varying(10) DEFAULT 'USD'::character varying,
    "supplier_validity_days" integer,
    "supplier_comments" "text",
    "supplier_alternative_items" "jsonb" DEFAULT '[]'::"jsonb",
    "approval_status" character varying(50) DEFAULT 'PENDING'::character varying,
    "approved_by" "uuid",
    "approved_at" timestamp without time zone,
    "approval_notes" "text",
    "created_by" "uuid" NOT NULL,
    "updated_by" "uuid",
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" timestamp without time zone,
    "response_token" character varying(255),
    "sent_at" timestamp without time zone,
    "response_token_expires_at" timestamp with time zone,
    "response_token_used_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "rfqs_approval_status_check" CHECK ((("approval_status")::"text" = ANY (ARRAY[('PENDING'::character varying)::"text", ('APPROVED'::character varying)::"text", ('DECLINED'::character varying)::"text", ('CANCELLED'::character varying)::"text"]))),
    CONSTRAINT "rfqs_priority_check" CHECK ((("priority")::"text" = ANY (ARRAY[('LOW'::character varying)::"text", ('MEDIUM'::character varying)::"text", ('HIGH'::character varying)::"text", ('URGENT'::character varying)::"text"]))),
    CONSTRAINT "rfqs_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('DRAFT'::character varying)::"text", ('SENT'::character varying)::"text", ('RESPONDED'::character varying)::"text", ('AWARDED'::character varying)::"text", ('CANCELLED'::character varying)::"text", ('EXPIRED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."rfqs" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "rfqs"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."rfqs" IS 'Procurement Request for Quotations - separate from sales RFQs';


--
-- Name: COLUMN "rfqs"."rfq_number"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."rfqs"."rfq_number" IS 'Auto-generated RFQ number: RFQ-YYYY-NNNN';


--
-- Name: COLUMN "rfqs"."request_type"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."rfqs"."request_type" IS 'Type of procurement request: PROCUREMENT, SERVICES, etc.';


--
-- Name: COLUMN "rfqs"."response_token"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."rfqs"."response_token" IS 'Unique token for external supplier access to respond';


--
-- Name: sales_contract_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sales_contract_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sales_contract_id" "uuid" NOT NULL,
    "line_number" integer NOT NULL,
    "inventory_item_id" "uuid",
    "item_code" character varying(100),
    "item_name" character varying(255) NOT NULL,
    "item_description" "text",
    "unit_price" numeric(15,4) NOT NULL,
    "currency" character varying(3) DEFAULT 'USD'::character varying NOT NULL,
    "unit_of_measure" character varying(20) NOT NULL,
    "minimum_quantity" numeric(15,3),
    "maximum_quantity" numeric(15,3),
    "annual_quantity_limit" numeric(15,3),
    "volume_discount_tiers" "jsonb",
    "price_escalation_clause" "text",
    "price_review_frequency_months" integer,
    "lead_time_days" integer,
    "delivery_terms" character varying(255),
    "technical_specifications" "text",
    "quality_requirements" "text",
    "packaging_requirements" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chk_sc_min_max_quantity" CHECK ((("minimum_quantity" IS NULL) OR ("maximum_quantity" IS NULL) OR ("minimum_quantity" <= "maximum_quantity"))),
    CONSTRAINT "chk_sc_unit_price_positive" CHECK (("unit_price" >= (0)::numeric))
);


--
-- Name: TABLE "sales_contract_items"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."sales_contract_items" IS 'Individual items and pricing within sales contracts';


--
-- Name: sales_contract_renewals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sales_contract_renewals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "original_contract_id" "uuid" NOT NULL,
    "new_contract_id" "uuid",
    "renewal_type" character varying(50) NOT NULL,
    "renewal_date" "date" NOT NULL,
    "previous_end_date" "date" NOT NULL,
    "new_end_date" "date" NOT NULL,
    "price_adjustment_percentage" numeric(5,2) DEFAULT 0,
    "terms_changed" boolean DEFAULT false,
    "changes_description" "text",
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: TABLE "sales_contract_renewals"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."sales_contract_renewals" IS 'History of contract renewals and extensions';


--
-- Name: sales_contract_status_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sales_contract_status_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sales_contract_id" "uuid" NOT NULL,
    "from_status" character varying(50),
    "to_status" character varying(50) NOT NULL,
    "status_date" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "changed_by" "uuid",
    "reason" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: TABLE "sales_contract_status_history"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."sales_contract_status_history" IS 'Tracks status changes for sales contracts';


--
-- Name: sales_contract_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sales_contract_usage" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sales_contract_id" "uuid" NOT NULL,
    "sales_contract_item_id" "uuid" NOT NULL,
    "reference_type" character varying(50) NOT NULL,
    "reference_id" "uuid" NOT NULL,
    "reference_number" character varying(100),
    "quantity_used" numeric(15,3) NOT NULL,
    "unit_price_used" numeric(15,4) NOT NULL,
    "total_value" numeric(15,2) NOT NULL,
    "usage_date" "date" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chk_sc_usage_price_positive" CHECK (("unit_price_used" >= (0)::numeric)),
    CONSTRAINT "chk_sc_usage_quantity_positive" CHECK (("quantity_used" > (0)::numeric))
);


--
-- Name: TABLE "sales_contract_usage"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."sales_contract_usage" IS 'Tracking of contract usage in quotations, sales orders, and invoices';


--
-- Name: sales_contracts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sales_contracts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "contract_number" character varying(50) NOT NULL,
    "contract_name" character varying(255) NOT NULL,
    "customer_id" "uuid",
    "customer_name" character varying(255),
    "supplier_id" "uuid",
    "supplier_name" character varying(255),
    "contract_type" character varying(50) DEFAULT 'SALES'::character varying NOT NULL,
    "contract_value" numeric(15,2),
    "currency" character varying(3) DEFAULT 'USD'::character varying NOT NULL,
    "payment_terms" character varying(100),
    "incoterms" character varying(20),
    "start_date" "date" NOT NULL,
    "end_date" "date" NOT NULL,
    "auto_renewal" boolean DEFAULT false,
    "renewal_period_months" integer DEFAULT 12,
    "default_lead_time_days" integer,
    "delivery_terms" character varying(255),
    "delivery_location" "text",
    "status" character varying(50) DEFAULT 'DRAFT'::character varying NOT NULL,
    "approval_status" character varying(50) DEFAULT 'PENDING'::character varying,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "signed_contract_url" "text",
    "contract_attachment_urls" "text"[],
    "terms_and_conditions" "text",
    "special_conditions" "text",
    "expiry_notification_sent" boolean DEFAULT false,
    "days_before_expiry_notification" integer DEFAULT 30,
    "linked_rfq_id" "uuid",
    "linked_quotation_id" "uuid",
    "notes" "text",
    "internal_notes" "text",
    "created_by" "uuid" NOT NULL,
    "updated_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" timestamp with time zone,
    "submitted_for_approval_by" "uuid",
    "submitted_for_approval_at" timestamp without time zone,
    "approval_notes" "text",
    "rejection_reason" "text",
    "rejected_by" "uuid",
    "rejected_at" timestamp without time zone,
    "sent_to_customer_at" timestamp without time zone,
    "sent_by" "uuid",
    "customer_response_token" character varying(255),
    "customer_signed_at" timestamp without time zone,
    "customer_signature_data" "text",
    "fully_executed_at" timestamp without time zone,
    "customer_response_date" timestamp without time zone,
    "customer_response_action" character varying(20),
    "customer_response_comments" "text",
    "customer_response_name" character varying(255),
    "customer_response_email" character varying(255),
    "customer_response_token_expires_at" timestamp with time zone,
    "customer_response_token_used_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "chk_sc_contract_dates" CHECK (("end_date" >= "start_date")),
    CONSTRAINT "sales_contracts_approval_status_check" CHECK ((("approval_status")::"text" = ANY (ARRAY[('PENDING'::character varying)::"text", ('APPROVED'::character varying)::"text", ('REJECTED'::character varying)::"text"]))),
    CONSTRAINT "sales_contracts_customer_response_action_check" CHECK (((("customer_response_action")::"text" = ANY (ARRAY[('ACCEPT'::character varying)::"text", ('REJECT'::character varying)::"text"])) OR ("customer_response_action" IS NULL))),
    CONSTRAINT "sales_contracts_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('DRAFT'::character varying)::"text", ('PENDING_APPROVAL'::character varying)::"text", ('APPROVED'::character varying)::"text", ('SENT_TO_CUSTOMER'::character varying)::"text", ('ACTIVE'::character varying)::"text", ('CUSTOMER_REJECTED'::character varying)::"text", ('CUSTOMER_SIGNED'::character varying)::"text", ('FULLY_EXECUTED'::character varying)::"text", ('REJECTED'::character varying)::"text", ('CANCELLED'::character varying)::"text", ('EXPIRED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."sales_contracts" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "sales_contracts"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."sales_contracts" IS 'Sales contracts for long-term agreements with customers and suppliers';


--
-- Name: COLUMN "sales_contracts"."submitted_for_approval_by"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_contracts"."submitted_for_approval_by" IS 'User who submitted contract for approval';


--
-- Name: COLUMN "sales_contracts"."submitted_for_approval_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_contracts"."submitted_for_approval_at" IS 'Timestamp when contract was submitted for approval';


--
-- Name: COLUMN "sales_contracts"."approval_notes"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_contracts"."approval_notes" IS 'Notes added during approval process';


--
-- Name: COLUMN "sales_contracts"."rejection_reason"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_contracts"."rejection_reason" IS 'Reason for contract rejection';


--
-- Name: COLUMN "sales_contracts"."rejected_by"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_contracts"."rejected_by" IS 'User who rejected the contract';


--
-- Name: COLUMN "sales_contracts"."rejected_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_contracts"."rejected_at" IS 'Timestamp when contract was rejected';


--
-- Name: COLUMN "sales_contracts"."sent_to_customer_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_contracts"."sent_to_customer_at" IS 'Timestamp when contract was sent to customer';


--
-- Name: COLUMN "sales_contracts"."sent_by"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_contracts"."sent_by" IS 'User who sent contract to customer';


--
-- Name: COLUMN "sales_contracts"."customer_response_token"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_contracts"."customer_response_token" IS 'Token for customer contract signing';


--
-- Name: COLUMN "sales_contracts"."customer_signed_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_contracts"."customer_signed_at" IS 'Timestamp when customer signed the contract';


--
-- Name: COLUMN "sales_contracts"."customer_signature_data"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_contracts"."customer_signature_data" IS 'Customer signature data (base64 or signature info)';


--
-- Name: COLUMN "sales_contracts"."fully_executed_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_contracts"."fully_executed_at" IS 'Timestamp when contract became fully executed';


--
-- Name: sales_credit_note_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sales_credit_note_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "credit_note_id" "uuid" NOT NULL,
    "customer_invoice_item_id" "uuid",
    "inventory_item_id" "uuid",
    "item_code" "text",
    "item_name" "text" NOT NULL,
    "quantity" numeric(12,4) DEFAULT 1 NOT NULL,
    "unit_price" numeric(15,2) DEFAULT 0 NOT NULL,
    "line_total" numeric(15,2) DEFAULT 0 NOT NULL,
    "return_to_stock" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: sales_credit_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sales_credit_notes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "credit_note_number" "text" NOT NULL,
    "customer_invoice_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "credit_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "reason" "text" NOT NULL,
    "return_type" "text",
    "subtotal" numeric(15,2) DEFAULT 0 NOT NULL,
    "tax_amount" numeric(15,2) DEFAULT 0 NOT NULL,
    "total_amount" numeric(15,2) DEFAULT 0 NOT NULL,
    "status" "text" DEFAULT 'DRAFT'::"text" NOT NULL,
    "notes" "text",
    "approved_by" "uuid",
    "posted_by" "uuid",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "deleted_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "sales_credit_notes_return_type_check" CHECK (("return_type" = ANY (ARRAY['STOCK_RETURN'::"text", 'CREDIT_ONLY'::"text"]))),
    CONSTRAINT "sales_credit_notes_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'PENDING_APPROVAL'::"text", 'APPROVED'::"text", 'POSTED'::"text", 'CANCELLED'::"text"])))
);

ALTER TABLE ONLY "public"."sales_credit_notes" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "sales_credit_notes"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."sales_credit_notes" IS 'Credit memos against customer invoices — returns, adjustments, goodwill. Stock returns reverse COGS through cost layers.';


--
-- Name: sales_order_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sales_order_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sales_order_id" "uuid" NOT NULL,
    "line_number" integer NOT NULL,
    "inventory_item_id" "uuid",
    "item_code" character varying(100),
    "item_name" character varying(255) NOT NULL,
    "item_description" "text",
    "quantity" numeric(15,3) NOT NULL,
    "unit_of_measure" character varying(20) NOT NULL,
    "unit_price" numeric(15,4) NOT NULL,
    "discount_percentage" numeric(5,2) DEFAULT 0,
    "discount_amount" numeric(15,2) DEFAULT 0,
    "line_total" numeric(15,2) NOT NULL,
    "requested_delivery_date" "date",
    "promised_delivery_date" "date",
    "quantity_reserved" numeric(15,3) DEFAULT 0,
    "quantity_delivered" numeric(15,3) DEFAULT 0,
    "quantity_invoiced" numeric(15,3) DEFAULT 0,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chk_quantity_positive" CHECK (("quantity" > (0)::numeric)),
    CONSTRAINT "chk_unit_price_positive" CHECK (("unit_price" >= (0)::numeric))
);


--
-- Name: TABLE "sales_order_items"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."sales_order_items" IS 'Individual line items within sales orders';


--
-- Name: sales_order_status_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sales_order_status_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sales_order_id" "uuid" NOT NULL,
    "from_status" character varying(50),
    "to_status" character varying(50) NOT NULL,
    "status_date" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "changed_by" "uuid",
    "reason" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: TABLE "sales_order_status_history"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."sales_order_status_history" IS 'Audit trail for sales order status changes';


--
-- Name: sales_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sales_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "so_number" character varying(50) NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "customer_name" character varying(255) NOT NULL,
    "order_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "delivery_date" "date",
    "reference_number" character varying(100),
    "currency" character varying(3) DEFAULT 'USD'::character varying NOT NULL,
    "subtotal" numeric(15,2) DEFAULT 0,
    "tax_amount" numeric(15,2) DEFAULT 0,
    "discount_amount" numeric(15,2) DEFAULT 0,
    "total_amount" numeric(15,2) DEFAULT 0,
    "status" character varying(50) DEFAULT 'DRAFT'::character varying NOT NULL,
    "priority" character varying(20) DEFAULT 'NORMAL'::character varying,
    "requires_approval" boolean DEFAULT false,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "approval_notes" "text",
    "delivery_address" "text",
    "delivery_instructions" "text",
    "shipping_method" character varying(100),
    "notes" "text",
    "internal_notes" "text",
    "payment_terms" character varying(100),
    "delivery_terms" character varying(100),
    "created_by" "uuid" NOT NULL,
    "updated_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" timestamp with time zone,
    "approval_status" character varying(50) DEFAULT 'PENDING_APPROVAL'::character varying,
    "approval_required_amount" numeric(12,2),
    "approval_requested_by" "uuid",
    "approval_requested_at" timestamp without time zone,
    "rejected_by" "uuid",
    "rejected_at" timestamp without time zone,
    "rejection_reason" "text",
    "customer_response_token" character varying(255),
    "customer_response_date" timestamp without time zone,
    "customer_response_action" character varying(20),
    "customer_response_comments" "text",
    "customer_response_name" character varying(255),
    "customer_response_email" character varying(255),
    "customer_delivery_token" character varying(255),
    "customer_delivery_confirmed_at" timestamp with time zone,
    "customer_delivery_issue_reported_at" timestamp with time zone,
    "customer_delivery_notes" "text",
    "customer_response_token_expires_at" timestamp with time zone,
    "customer_response_token_used_at" timestamp with time zone,
    "customer_delivery_token_expires_at" timestamp with time zone,
    "customer_delivery_token_used_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    "embedding" "public"."vector"(384),
    "embedding_generated_at" timestamp with time zone,
    CONSTRAINT "sales_orders_approval_status_check" CHECK ((("approval_status")::"text" = ANY (ARRAY[('PENDING_APPROVAL'::character varying)::"text", ('APPROVED'::character varying)::"text", ('REJECTED'::character varying)::"text"]))),
    CONSTRAINT "sales_orders_customer_response_action_check" CHECK (((("customer_response_action")::"text" = ANY (ARRAY[('ACCEPT'::character varying)::"text", ('REJECT'::character varying)::"text"])) OR ("customer_response_action" IS NULL))),
    CONSTRAINT "sales_orders_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('DRAFT'::character varying)::"text", ('PENDING_APPROVAL'::character varying)::"text", ('APPROVED'::character varying)::"text", ('SENT_TO_CUSTOMER'::character varying)::"text", ('CONFIRMED'::character varying)::"text", ('CUSTOMER_ACCEPTED'::character varying)::"text", ('CUSTOMER_REJECTED'::character varying)::"text", ('IN_PRODUCTION'::character varying)::"text", ('GOODS_ISSUED'::character varying)::"text", ('READY_FOR_DELIVERY'::character varying)::"text", ('SHIPPED'::character varying)::"text", ('DELIVERED'::character varying)::"text", ('WAITING_CUSTOMER_DELIVERY_CONFIRMATION'::character varying)::"text", ('DELIVERY_ISSUE_REPORTED'::character varying)::"text", ('COMPLETED'::character varying)::"text", ('CANCELLED'::character varying)::"text", ('REJECTED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."sales_orders" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "sales_orders"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."sales_orders" IS 'Sales Orders - formal agreements to supply goods or services to customers';


--
-- Name: COLUMN "sales_orders"."embedding"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_orders"."embedding" IS 'pgvector(384) — all-MiniLM-L6-v2 via services/ai/localEmbeddings.js, run in-process (no external API). Searched with the <=> cosine-distance operator. NULL until backfilled.';


--
-- Name: sales_quotation_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sales_quotation_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sales_quotation_id" "uuid" NOT NULL,
    "line_number" integer NOT NULL,
    "inventory_item_id" "uuid",
    "item_code" character varying(100),
    "item_name" character varying(255) NOT NULL,
    "item_description" "text",
    "quantity" numeric(15,3) NOT NULL,
    "unit_of_measure" character varying(20) NOT NULL,
    "unit_price" numeric(15,4) NOT NULL,
    "discount_percentage" numeric(5,2) DEFAULT 0,
    "discount_amount" numeric(15,2) DEFAULT 0,
    "line_total" numeric(15,2) NOT NULL,
    "estimated_delivery_date" "date",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "sourcing_type" character varying(20) DEFAULT 'STOCK'::character varying,
    "source_bin_id" "uuid",
    "linked_sales_rfq_id" integer,
    "supplier_id" "uuid",
    "supplier_name" character varying(255),
    "estimated_supplier_cost" numeric(12,2),
    "margin_percentage" numeric(5,2),
    "margin_amount" numeric(12,2),
    CONSTRAINT "chk_sq_quantity_positive" CHECK (("quantity" > (0)::numeric)),
    CONSTRAINT "chk_sq_unit_price_positive" CHECK (("unit_price" >= (0)::numeric)),
    CONSTRAINT "sales_quotation_items_sourcing_type_check" CHECK ((("sourcing_type")::"text" = ANY (ARRAY[('STOCK'::character varying)::"text", ('SUPPLIER'::character varying)::"text"])))
);


--
-- Name: TABLE "sales_quotation_items"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."sales_quotation_items" IS 'Individual line items within sales quotations';


--
-- Name: COLUMN "sales_quotation_items"."sourcing_type"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_quotation_items"."sourcing_type" IS 'Whether item is sourced from stock or supplier';


--
-- Name: COLUMN "sales_quotation_items"."source_bin_id"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_quotation_items"."source_bin_id" IS 'Bin ID when sourcing from stock';


--
-- Name: COLUMN "sales_quotation_items"."linked_sales_rfq_id"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_quotation_items"."linked_sales_rfq_id" IS 'Reference to sales RFQ when sourcing from supplier';


--
-- Name: COLUMN "sales_quotation_items"."supplier_id"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_quotation_items"."supplier_id" IS 'Supplier ID when sourcing from supplier';


--
-- Name: COLUMN "sales_quotation_items"."supplier_name"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_quotation_items"."supplier_name" IS 'Supplier name for display';


--
-- Name: COLUMN "sales_quotation_items"."estimated_supplier_cost"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_quotation_items"."estimated_supplier_cost" IS 'Expected cost from supplier';


--
-- Name: COLUMN "sales_quotation_items"."margin_percentage"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_quotation_items"."margin_percentage" IS 'Profit margin percentage';


--
-- Name: COLUMN "sales_quotation_items"."margin_amount"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_quotation_items"."margin_amount" IS 'Profit margin amount';


--
-- Name: sales_quotation_status_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sales_quotation_status_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sales_quotation_id" "uuid" NOT NULL,
    "from_status" character varying(50),
    "to_status" character varying(50) NOT NULL,
    "status_date" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "changed_by" "uuid",
    "reason" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: TABLE "sales_quotation_status_history"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."sales_quotation_status_history" IS 'Audit trail for sales quotation status changes';


--
-- Name: COLUMN "sales_quotation_status_history"."changed_by"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_quotation_status_history"."changed_by" IS 'User who made the status change. NULL for customer responses.';


--
-- Name: sales_quotations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sales_quotations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "quotation_number" character varying(50) NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "customer_name" character varying(255) NOT NULL,
    "quotation_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "valid_until" "date" NOT NULL,
    "reference_number" character varying(100),
    "currency" character varying(3) DEFAULT 'USD'::character varying NOT NULL,
    "subtotal" numeric(15,2) DEFAULT 0,
    "tax_amount" numeric(15,2) DEFAULT 0,
    "discount_amount" numeric(15,2) DEFAULT 0,
    "total_amount" numeric(15,2) DEFAULT 0,
    "status" character varying(50) DEFAULT 'DRAFT'::character varying NOT NULL,
    "priority" character varying(20) DEFAULT 'NORMAL'::character varying,
    "converted_to_so" boolean DEFAULT false,
    "sales_order_id" "uuid",
    "converted_at" timestamp with time zone,
    "converted_by" "uuid",
    "delivery_address" "text",
    "delivery_terms" character varying(100),
    "estimated_delivery_days" integer,
    "notes" "text",
    "internal_notes" "text",
    "terms_and_conditions" "text",
    "payment_terms" character varying(100),
    "created_by" "uuid" NOT NULL,
    "updated_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" timestamp with time zone,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "rejected_by" "uuid",
    "rejected_at" timestamp with time zone,
    "rejection_reason" "text",
    "send_requested_by" "uuid",
    "send_requested_at" timestamp with time zone,
    "send_approved_by" "uuid",
    "send_approved_at" timestamp with time zone,
    "customer_response_token" character varying(255),
    "customer_responded_at" timestamp with time zone,
    "customer_response_notes" "text",
    "sent_to_customer_at" timestamp with time zone,
    "sent_by" "uuid",
    "accepted_at" timestamp without time zone,
    "customer_response_token_expires_at" timestamp with time zone,
    "customer_response_token_used_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "chk_valid_until_after_quotation_date" CHECK (("valid_until" >= "quotation_date"))
);

ALTER TABLE ONLY "public"."sales_quotations" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "sales_quotations"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."sales_quotations" IS 'Sales Quotations - formal offers to customers with prices, delivery dates, and terms';


--
-- Name: COLUMN "sales_quotations"."approved_by"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_quotations"."approved_by" IS 'User who approved the quotation';


--
-- Name: COLUMN "sales_quotations"."approved_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_quotations"."approved_at" IS 'Timestamp when quotation was approved';


--
-- Name: COLUMN "sales_quotations"."rejected_by"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_quotations"."rejected_by" IS 'User who rejected the quotation';


--
-- Name: COLUMN "sales_quotations"."rejected_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_quotations"."rejected_at" IS 'Timestamp when customer rejected the quotation';


--
-- Name: COLUMN "sales_quotations"."rejection_reason"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_quotations"."rejection_reason" IS 'Reason for quotation rejection';


--
-- Name: COLUMN "sales_quotations"."send_requested_by"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_quotations"."send_requested_by" IS 'User who requested to send quotation to customer';


--
-- Name: COLUMN "sales_quotations"."send_requested_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_quotations"."send_requested_at" IS 'Timestamp when send was requested';


--
-- Name: COLUMN "sales_quotations"."send_approved_by"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_quotations"."send_approved_by" IS 'User who approved sending to customer';


--
-- Name: COLUMN "sales_quotations"."send_approved_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_quotations"."send_approved_at" IS 'Timestamp when send was approved';


--
-- Name: COLUMN "sales_quotations"."customer_response_token"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_quotations"."customer_response_token" IS 'Unique token for customer response';


--
-- Name: COLUMN "sales_quotations"."customer_responded_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_quotations"."customer_responded_at" IS 'Timestamp when customer responded';


--
-- Name: COLUMN "sales_quotations"."customer_response_notes"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_quotations"."customer_response_notes" IS 'Customer notes when accepting/rejecting quotation';


--
-- Name: COLUMN "sales_quotations"."sent_to_customer_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_quotations"."sent_to_customer_at" IS 'Timestamp when quotation was sent to customer';


--
-- Name: COLUMN "sales_quotations"."sent_by"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_quotations"."sent_by" IS 'User who sent quotation to customer';


--
-- Name: COLUMN "sales_quotations"."accepted_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sales_quotations"."accepted_at" IS 'Timestamp when customer accepted the quotation';


--
-- Name: sales_rfq_communications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sales_rfq_communications" (
    "id" integer NOT NULL,
    "sales_rfq_id" integer NOT NULL,
    "communication_type" character varying(50) NOT NULL,
    "direction" character varying(20),
    "subject" character varying(255),
    "message_content" "text",
    "sender_name" character varying(255),
    "sender_email" character varying(255),
    "recipient_name" character varying(255),
    "recipient_email" character varying(255),
    "attachment_urls" "text"[],
    "created_by" "uuid",
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sales_rfq_communications_communication_type_check" CHECK ((("communication_type")::"text" = ANY (ARRAY[('EMAIL_SENT'::character varying)::"text", ('EMAIL_RECEIVED'::character varying)::"text", ('PHONE_CALL'::character varying)::"text", ('SYSTEM_MESSAGE'::character varying)::"text", ('MANUAL_NOTE'::character varying)::"text"]))),
    CONSTRAINT "sales_rfq_communications_direction_check" CHECK ((("direction")::"text" = ANY (ARRAY[('INBOUND'::character varying)::"text", ('OUTBOUND'::character varying)::"text"])))
);


--
-- Name: sales_rfq_communications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."sales_rfq_communications_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sales_rfq_communications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."sales_rfq_communications_id_seq" OWNED BY "public"."sales_rfq_communications"."id";


--
-- Name: sales_rfq_item_responses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sales_rfq_item_responses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "response_id" "uuid" NOT NULL,
    "sales_rfq_item_id" integer,
    "item_name" character varying(255) NOT NULL,
    "requested_quantity" numeric(10,3) NOT NULL,
    "unit_of_measure" character varying(50) NOT NULL,
    "quoted_unit_price" numeric(12,2) NOT NULL,
    "quoted_total_price" numeric(12,2) NOT NULL,
    "availability_status" character varying(20) DEFAULT 'AVAILABLE'::character varying,
    "lead_time_days" integer,
    "supplier_notes" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: sales_rfq_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sales_rfq_items" (
    "id" integer NOT NULL,
    "sales_rfq_id" integer NOT NULL,
    "line_number" integer NOT NULL,
    "item_id" "uuid",
    "item_name" character varying(255) NOT NULL,
    "item_description" "text",
    "item_specification" "text",
    "requested_quantity" numeric(15,3) NOT NULL,
    "unit_of_measure" character varying(50) NOT NULL,
    "estimated_unit_price" numeric(15,4),
    "quoted_unit_price" numeric(15,4),
    "quoted_total_price" numeric(15,2),
    "supplier_lead_time_days" integer,
    "supplier_minimum_order_quantity" numeric(15,3),
    "supplier_item_code" character varying(100),
    "supplier_brand" character varying(100),
    "supplier_availability_status" character varying(50),
    "supplier_item_notes" "text",
    "supplier_alternative_item_name" character varying(255),
    "supplier_alternative_unit_price" numeric(15,4),
    "supplier_alternative_description" "text",
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: sales_rfq_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."sales_rfq_items_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sales_rfq_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."sales_rfq_items_id_seq" OWNED BY "public"."sales_rfq_items"."id";


--
-- Name: sales_rfq_status_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sales_rfq_status_history" (
    "id" integer NOT NULL,
    "sales_rfq_id" integer NOT NULL,
    "status" character varying(50) NOT NULL,
    "previous_status" character varying(50),
    "changed_by" "uuid" NOT NULL,
    "change_reason" "text",
    "changed_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: sales_rfq_status_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."sales_rfq_status_history_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sales_rfq_status_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."sales_rfq_status_history_id_seq" OWNED BY "public"."sales_rfq_status_history"."id";


--
-- Name: sales_rfq_supplier_responses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sales_rfq_supplier_responses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sales_rfq_id" integer NOT NULL,
    "supplier_total_amount" numeric(12,2),
    "supplier_currency" character varying(3) DEFAULT 'USD'::character varying,
    "supplier_validity_days" integer DEFAULT 30,
    "supplier_comments" "text",
    "supplier_alternative_items" "text",
    "supplier_response_method" character varying(20) DEFAULT 'PORTAL'::character varying,
    "responded_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: sales_rfqs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sales_rfqs" (
    "id" integer NOT NULL,
    "rfq_number" character varying(50) NOT NULL,
    "rfq_title" character varying(255) NOT NULL,
    "supplier_id" "uuid",
    "supplier_name" character varying(255),
    "supplier_email" character varying(255),
    "supplier_contact_person" character varying(255),
    "supplier_phone" character varying(50),
    "request_type" character varying(50) DEFAULT 'TRADING'::character varying,
    "required_delivery_date" "date",
    "delivery_location" character varying(500),
    "delivery_terms" character varying(255),
    "payment_terms" character varying(255),
    "status" character varying(50) DEFAULT 'DRAFT'::character varying,
    "priority" character varying(20) DEFAULT 'MEDIUM'::character varying,
    "response_deadline" "date",
    "response_received_at" timestamp without time zone,
    "supplier_response_method" character varying(50),
    "special_requirements" "text",
    "terms_and_conditions" "text",
    "internal_notes" "text",
    "attachment_urls" "text"[],
    "linked_customer_id" "uuid",
    "linked_sales_quotation_id" integer,
    "source_document_type" character varying(50),
    "source_document_id" integer,
    "supplier_total_amount" numeric(15,2),
    "supplier_currency" character varying(10) DEFAULT 'USD'::character varying,
    "supplier_validity_days" integer,
    "supplier_comments" "text",
    "supplier_alternative_items" "text",
    "created_by" "uuid" NOT NULL,
    "updated_by" "uuid",
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" timestamp without time zone,
    "sales_approval_status" character varying(20) DEFAULT 'PENDING'::character varying,
    "sales_approved_by" "uuid",
    "sales_approved_at" timestamp with time zone,
    "sales_approval_notes" "text",
    "procurement_approval_status" character varying(20) DEFAULT 'PENDING'::character varying,
    "procurement_approved_by" "uuid",
    "procurement_approved_at" timestamp with time zone,
    "procurement_approval_notes" "text",
    "overall_approval_status" character varying(20) DEFAULT 'PENDING'::character varying,
    "response_token" character varying(64),
    "sent_at" timestamp without time zone,
    "response_token_expires_at" timestamp with time zone,
    "response_token_used_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "sales_rfqs_overall_approval_status_check" CHECK ((("overall_approval_status")::"text" = ANY (ARRAY[('PENDING'::character varying)::"text", ('SALES_APPROVED'::character varying)::"text", ('PROCUREMENT_APPROVED'::character varying)::"text", ('FULLY_APPROVED'::character varying)::"text", ('REJECTED'::character varying)::"text"]))),
    CONSTRAINT "sales_rfqs_priority_check" CHECK ((("priority")::"text" = ANY (ARRAY[('LOW'::character varying)::"text", ('MEDIUM'::character varying)::"text", ('HIGH'::character varying)::"text", ('URGENT'::character varying)::"text"]))),
    CONSTRAINT "sales_rfqs_procurement_approval_status_check" CHECK ((("procurement_approval_status")::"text" = ANY (ARRAY[('PENDING'::character varying)::"text", ('APPROVED'::character varying)::"text", ('REJECTED'::character varying)::"text"]))),
    CONSTRAINT "sales_rfqs_request_type_check" CHECK ((("request_type")::"text" = ANY (ARRAY[('TRADING'::character varying)::"text", ('INTERNAL_USE'::character varying)::"text", ('RESALE'::character varying)::"text"]))),
    CONSTRAINT "sales_rfqs_sales_approval_status_check" CHECK ((("sales_approval_status")::"text" = ANY (ARRAY[('PENDING'::character varying)::"text", ('APPROVED'::character varying)::"text", ('REJECTED'::character varying)::"text"]))),
    CONSTRAINT "sales_rfqs_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('DRAFT'::character varying)::"text", ('PENDING_SALES_APPROVAL'::character varying)::"text", ('PENDING_PROCUREMENT_APPROVAL'::character varying)::"text", ('PENDING_DUAL_APPROVAL'::character varying)::"text", ('APPROVED'::character varying)::"text", ('SENT'::character varying)::"text", ('RESPONDED'::character varying)::"text", ('PARTIALLY_RESPONDED'::character varying)::"text", ('COMPLETED'::character varying)::"text", ('CANCELLED'::character varying)::"text", ('REJECTED'::character varying)::"text"]))),
    CONSTRAINT "sales_rfqs_supplier_response_method_check" CHECK ((("supplier_response_method")::"text" = ANY (ARRAY[('SYSTEM'::character varying)::"text", ('EMAIL'::character varying)::"text", ('PHONE'::character varying)::"text", ('MANUAL_ENTRY'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."sales_rfqs" FORCE ROW LEVEL SECURITY;


--
-- Name: sales_rfqs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."sales_rfqs_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sales_rfqs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."sales_rfqs_id_seq" OWNED BY "public"."sales_rfqs"."id";


--
-- Name: shipments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."shipments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "shipment_number" character varying(50) NOT NULL,
    "sales_order_id" "uuid",
    "carrier_name" character varying(100),
    "tracking_number" character varying(100),
    "shipping_status" character varying(30) DEFAULT 'PREPARING'::character varying,
    "ship_date" "date",
    "delivery_date" "date",
    "proof_of_delivery" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "shipments_shipping_status_check" CHECK ((("shipping_status")::"text" = ANY (ARRAY[('PREPARING'::character varying)::"text", ('SHIPPED'::character varying)::"text", ('IN_TRANSIT'::character varying)::"text", ('DELIVERED'::character varying)::"text", ('RETURNED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."shipments" FORCE ROW LEVEL SECURITY;


--
-- Name: stocktake_sheet_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."stocktake_sheet_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sheet_id" "uuid" NOT NULL,
    "inventory_item_id" "uuid" NOT NULL,
    "book_quantity" numeric(15,4) DEFAULT 0 NOT NULL,
    "counted_quantity" numeric(15,4),
    "variance" numeric(15,4) GENERATED ALWAYS AS ((COALESCE("counted_quantity", "book_quantity") - "book_quantity")) STORED,
    "unit_cost" numeric(15,4) DEFAULT 0 NOT NULL,
    "variance_value" numeric(15,2) GENERATED ALWAYS AS (((COALESCE("counted_quantity", "book_quantity") - "book_quantity") * "unit_cost")) STORED,
    "status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "stocktake_sheet_items_status_check" CHECK (("status" = ANY (ARRAY['PENDING'::"text", 'COUNTED'::"text", 'ADJUSTED'::"text", 'SKIPPED'::"text"])))
);


--
-- Name: TABLE "stocktake_sheet_items"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."stocktake_sheet_items" IS 'Per-item lines on a stocktake sheet — book quantity, counted quantity, and computed variance';


--
-- Name: stocktake_sheets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."stocktake_sheets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sheet_number" "text" NOT NULL,
    "status" "text" DEFAULT 'DRAFT'::"text" NOT NULL,
    "location_id" "uuid",
    "notes" "text",
    "counted_by" "uuid",
    "reviewed_by" "uuid",
    "counted_at" timestamp with time zone,
    "posted_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "deleted_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "stocktake_sheets_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'IN_PROGRESS'::"text", 'COUNTED'::"text", 'REVIEWED'::"text", 'POSTED'::"text", 'CANCELLED'::"text"])))
);

ALTER TABLE ONLY "public"."stocktake_sheets" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "stocktake_sheets"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."stocktake_sheets" IS 'Stocktake / cycle count documents with status workflow';


--
-- Name: storage_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."storage_locations" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "code" character varying(10) NOT NULL,
    "name" character varying(255) NOT NULL,
    "country" character varying(100) NOT NULL,
    "city" character varying(100) NOT NULL,
    "address" "text" NOT NULL,
    "postal_code" character varying(20) NOT NULL,
    "description" "text",
    "is_active" boolean DEFAULT true,
    "user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "status" character varying(20) DEFAULT 'DRAFT'::character varying,
    "decline_reason" "text",
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "declined_by" "uuid",
    "declined_at" timestamp with time zone,
    "max_mass_capacity" numeric(12,3) DEFAULT NULL::numeric,
    "max_volume_capacity" numeric(15,6) DEFAULT NULL::numeric,
    "current_mass_used" numeric(12,3) DEFAULT 0 NOT NULL,
    "current_volume_used" numeric(15,6) DEFAULT 0 NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "storage_locations_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('DRAFT'::character varying)::"text", ('PENDING_APPROVAL'::character varying)::"text", ('ACTIVE'::character varying)::"text", ('DECLINED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."storage_locations" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "storage_locations"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."storage_locations" IS 'Geographic storage locations with full address details';


--
-- Name: COLUMN "storage_locations"."code"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."storage_locations"."code" IS 'Unique short code, typically city-based (e.g., BRG, LON)';


--
-- Name: COLUMN "storage_locations"."name"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."storage_locations"."name" IS 'Full name of the storage location';


--
-- Name: COLUMN "storage_locations"."country"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."storage_locations"."country" IS 'Country where the storage location is situated';


--
-- Name: COLUMN "storage_locations"."city"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."storage_locations"."city" IS 'City where the storage location is situated';


--
-- Name: COLUMN "storage_locations"."address"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."storage_locations"."address" IS 'Full street address of the storage location';


--
-- Name: COLUMN "storage_locations"."postal_code"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."storage_locations"."postal_code" IS 'Postal or ZIP code';


--
-- Name: COLUMN "storage_locations"."description"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."storage_locations"."description" IS 'Additional notes or details about the location';


--
-- Name: COLUMN "storage_locations"."status"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."storage_locations"."status" IS 'Approval status: DRAFT, PENDING_APPROVAL, ACTIVE, DECLINED';


--
-- Name: COLUMN "storage_locations"."decline_reason"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."storage_locations"."decline_reason" IS 'Reason for declining the storage location request';


--
-- Name: COLUMN "storage_locations"."approved_by"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."storage_locations"."approved_by" IS 'User ID who approved this storage location';


--
-- Name: COLUMN "storage_locations"."approved_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."storage_locations"."approved_at" IS 'Timestamp when storage location was approved';


--
-- Name: COLUMN "storage_locations"."declined_by"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."storage_locations"."declined_by" IS 'User ID who declined this storage location';


--
-- Name: COLUMN "storage_locations"."declined_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."storage_locations"."declined_at" IS 'Timestamp when storage location was declined';


--
-- Name: COLUMN "storage_locations"."max_mass_capacity"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."storage_locations"."max_mass_capacity" IS 'Maximum mass capacity in kilograms';


--
-- Name: COLUMN "storage_locations"."max_volume_capacity"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."storage_locations"."max_volume_capacity" IS 'Maximum volume capacity in cubic meters (6 decimal precision)';


--
-- Name: COLUMN "storage_locations"."current_mass_used"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."storage_locations"."current_mass_used" IS 'Current mass utilization in kilograms';


--
-- Name: COLUMN "storage_locations"."current_volume_used"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."storage_locations"."current_volume_used" IS 'Current volume utilization in cubic meters (6 decimal precision)';


--
-- Name: supplier_bank_detail_changes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."supplier_bank_detail_changes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), '11111111-1111-1111-1111-111111111111'::"uuid") NOT NULL,
    "supplier_id" "uuid" NOT NULL,
    "changed_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "changed_by" "uuid",
    "field_name" character varying(50) NOT NULL,
    "old_value" "text",
    "new_value" "text"
);

ALTER TABLE ONLY "public"."supplier_bank_detail_changes" FORCE ROW LEVEL SECURITY;


--
-- Name: supplier_code_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."supplier_code_seq"
    START WITH 1000
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: supplier_debit_note_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."supplier_debit_note_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "debit_note_id" "uuid" NOT NULL,
    "supplier_invoice_item_id" "uuid",
    "inventory_item_id" "uuid",
    "item_code" "text",
    "item_name" "text" NOT NULL,
    "quantity" numeric(12,4) DEFAULT 1 NOT NULL,
    "unit_price" numeric(15,2) DEFAULT 0 NOT NULL,
    "line_total" numeric(15,2) DEFAULT 0 NOT NULL,
    "return_to_supplier" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: supplier_debit_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."supplier_debit_notes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "debit_note_number" "text" NOT NULL,
    "supplier_invoice_id" "uuid" NOT NULL,
    "supplier_id" "uuid" NOT NULL,
    "debit_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "reason" "text" NOT NULL,
    "return_type" "text",
    "subtotal" numeric(15,2) DEFAULT 0 NOT NULL,
    "tax_amount" numeric(15,2) DEFAULT 0 NOT NULL,
    "total_amount" numeric(15,2) DEFAULT 0 NOT NULL,
    "status" "text" DEFAULT 'DRAFT'::"text" NOT NULL,
    "notes" "text",
    "approved_by" "uuid",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "deleted_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "supplier_debit_notes_return_type_check" CHECK (("return_type" = ANY (ARRAY['STOCK_RETURN'::"text", 'DEBIT_ONLY'::"text"]))),
    CONSTRAINT "supplier_debit_notes_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'PENDING_APPROVAL'::"text", 'APPROVED'::"text", 'POSTED'::"text", 'CANCELLED'::"text"])))
);

ALTER TABLE ONLY "public"."supplier_debit_notes" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "supplier_debit_notes"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."supplier_debit_notes" IS 'Debit memos against supplier invoices — returns, price adjustments. Mirror of sales credit notes for AP side.';


--
-- Name: supplier_invoice_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."supplier_invoice_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "bill_id" "uuid" NOT NULL,
    "line_number" integer NOT NULL,
    "item_description" "text" NOT NULL,
    "quantity" numeric(15,4) NOT NULL,
    "unit_of_measure" character varying(20),
    "unit_price" numeric(15,4) NOT NULL,
    "discount_percentage" numeric(5,2) DEFAULT 0,
    "discount_amount" numeric(15,2) DEFAULT 0,
    "line_total" numeric(15,2) NOT NULL,
    "tax_code" character varying(20),
    "tax_rate" numeric(5,4) DEFAULT 0,
    "tax_amount" numeric(15,2) DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: supplier_invoice_status_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."supplier_invoice_status_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "bill_id" "uuid" NOT NULL,
    "from_status" character varying(30),
    "to_status" character varying(30) NOT NULL,
    "changed_by" "uuid",
    "status_date" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "reason" "text"
);


--
-- Name: supplier_invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."supplier_invoices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "bill_number" character varying(50) NOT NULL,
    "supplier_invoice_number" character varying(100),
    "supplier_id" "uuid" NOT NULL,
    "purchase_order_id" "uuid",
    "journal_entry_id" "uuid",
    "invoice_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "due_date" "date" NOT NULL,
    "payment_terms" character varying(100),
    "currency" character varying(3) DEFAULT 'USD'::character varying,
    "subtotal" numeric(15,2) DEFAULT 0 NOT NULL,
    "tax_amount" numeric(15,2) DEFAULT 0 NOT NULL,
    "discount_amount" numeric(15,2) DEFAULT 0 NOT NULL,
    "total_amount" numeric(15,2) DEFAULT 0 NOT NULL,
    "paid_amount" numeric(15,2) DEFAULT 0 NOT NULL,
    "outstanding_amount" numeric(15,2) GENERATED ALWAYS AS (("total_amount" - "paid_amount")) STORED,
    "status" character varying(30) DEFAULT 'DRAFT'::character varying NOT NULL,
    "description" "text",
    "notes" "text",
    "internal_notes" "text",
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" timestamp with time zone,
    "deleted_by" "uuid",
    "exchange_rate" numeric(18,8) DEFAULT 1 NOT NULL,
    "base_amount" numeric(15,2),
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "chk_supplier_invoice_amounts_positive" CHECK ((("subtotal" >= (0)::numeric) AND ("tax_amount" >= (0)::numeric) AND ("total_amount" >= (0)::numeric) AND ("paid_amount" >= (0)::numeric))),
    CONSTRAINT "chk_supplier_invoice_status_valid" CHECK ((("status")::"text" = ANY (ARRAY[('DRAFT'::character varying)::"text", ('PENDING_APPROVAL'::character varying)::"text", ('APPROVED'::character varying)::"text", ('PAID'::character varying)::"text", ('PARTIALLY_PAID'::character varying)::"text", ('OVERDUE'::character varying)::"text", ('CANCELLED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."supplier_invoices" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "supplier_invoices"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."supplier_invoices" IS 'Supplier invoices (vendor bills) — Accounts Payable';


--
-- Name: supplier_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."supplier_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "supplier_id" "uuid" NOT NULL,
    "item_id" "uuid" NOT NULL,
    "unit_price" numeric(15,2),
    "currency" character varying(10) DEFAULT 'USD'::character varying,
    "minimum_order_quantity" integer DEFAULT 1,
    "lead_time_days" integer,
    "is_preferred" boolean DEFAULT false,
    "notes" "text",
    "status" character varying(50) DEFAULT 'ACTIVE'::character varying,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "supplier_confirmed" boolean DEFAULT false,
    "supplier_confirmed_at" timestamp without time zone,
    "confirmation_token" character varying(255),
    "confirmation_requested_at" timestamp without time zone,
    "supplier_rejection_reason" "text",
    "confirmation_token_expires_at" timestamp with time zone,
    "confirmation_token_used_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "supplier_items_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('ACTIVE'::character varying)::"text", ('INACTIVE'::character varying)::"text", ('PENDING_SUPPLIER_CONFIRMATION'::character varying)::"text", ('SUPPLIER_REJECTED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."supplier_items" FORCE ROW LEVEL SECURITY;


--
-- Name: supplier_payment_allocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."supplier_payment_allocations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "payment_id" "uuid" NOT NULL,
    "bill_id" "uuid" NOT NULL,
    "allocation_amount" numeric(15,2) NOT NULL,
    "allocation_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chk_positive_supplier_allocation" CHECK (("allocation_amount" > (0)::numeric))
);


--
-- Name: supplier_payment_status_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."supplier_payment_status_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "payment_id" "uuid" NOT NULL,
    "from_status" character varying(30),
    "to_status" character varying(30) NOT NULL,
    "changed_by" "uuid",
    "status_date" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "reason" "text"
);


--
-- Name: supplier_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."supplier_payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "payment_number" character varying(50) NOT NULL,
    "supplier_id" "uuid" NOT NULL,
    "journal_entry_id" "uuid",
    "payment_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "payment_method" character varying(30) NOT NULL,
    "reference_number" character varying(100),
    "bank_account_id" "uuid",
    "payment_amount" numeric(15,2) NOT NULL,
    "currency" character varying(3) DEFAULT 'USD'::character varying,
    "exchange_rate" numeric(10,6) DEFAULT 1.0,
    "status" character varying(30) DEFAULT 'PENDING'::character varying NOT NULL,
    "description" "text",
    "notes" "text",
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" timestamp with time zone,
    "deleted_by" "uuid",
    "base_amount" numeric(15,2),
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "chk_supplier_payment_amount_positive" CHECK (("payment_amount" > (0)::numeric)),
    CONSTRAINT "chk_supplier_payment_method_valid" CHECK ((("payment_method")::"text" = ANY (ARRAY[('CASH'::character varying)::"text", ('CHECK'::character varying)::"text", ('BANK_TRANSFER'::character varying)::"text", ('CREDIT_CARD'::character varying)::"text", ('ACH'::character varying)::"text", ('WIRE_TRANSFER'::character varying)::"text"]))),
    CONSTRAINT "chk_supplier_payment_status_valid" CHECK ((("status")::"text" = ANY (ARRAY[('PENDING'::character varying)::"text", ('CLEARED'::character varying)::"text", ('BOUNCED'::character varying)::"text", ('CANCELLED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."supplier_payments" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "supplier_payments"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."supplier_payments" IS 'Payments made to suppliers with allocation to bills';


--
-- Name: suppliers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."suppliers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "supplier_code" character varying(50) NOT NULL,
    "legal_name" character varying(255) NOT NULL,
    "trade_name" character varying(255),
    "email" character varying(255),
    "phone" character varying(50),
    "address" "text",
    "country" character varying(100),
    "city" character varying(100),
    "postal_code" character varying(20),
    "supplier_type" character varying(50) DEFAULT 'TRANSACTIONAL'::character varying,
    "certification_status" character varying(50) DEFAULT 'PENDING'::character varying,
    "payment_terms" character varying(100) DEFAULT '30 DAYS NET'::character varying,
    "currency" character varying(3) DEFAULT 'USD'::character varying,
    "status" character varying(50) DEFAULT 'ACTIVE'::character varying,
    "created_by" "uuid",
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "partnership_status" character varying(50) DEFAULT 'PENDING'::character varying,
    "partnership_accepted_at" timestamp with time zone,
    "partnership_declined_at" timestamp with time zone,
    "decline_reason" "text",
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    "bank_account_number" character varying(100),
    "bank_name" character varying(100),
    "tax_id" character varying(50),
    CONSTRAINT "suppliers_certification_status_check" CHECK ((("certification_status")::"text" = ANY (ARRAY[('PENDING'::character varying)::"text", ('CERTIFIED'::character varying)::"text", ('DECLINED'::character varying)::"text", ('SUSPENDED'::character varying)::"text"]))),
    CONSTRAINT "suppliers_partnership_status_check" CHECK ((("partnership_status")::"text" = ANY (ARRAY[('PENDING'::character varying)::"text", ('ACCEPTED'::character varying)::"text", ('DECLINED'::character varying)::"text"]))),
    CONSTRAINT "suppliers_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('DRAFT'::character varying)::"text", ('PENDING_APPROVAL'::character varying)::"text", ('PENDING_SUPPLIER_CONFIRMATION'::character varying)::"text", ('ACTIVE'::character varying)::"text", ('INACTIVE'::character varying)::"text", ('DECLINED'::character varying)::"text"]))),
    CONSTRAINT "suppliers_supplier_type_check" CHECK ((("supplier_type")::"text" = ANY (ARRAY[('TRANSACTIONAL'::character varying)::"text", ('STRATEGIC'::character varying)::"text", ('PREFERRED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."suppliers" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "suppliers"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."suppliers" IS 'Registered suppliers for procurement activities';


--
-- Name: COLUMN "suppliers"."partnership_status"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."suppliers"."partnership_status" IS 'Supplier partnership acceptance status (PENDING, ACCEPTED, DECLINED)';


--
-- Name: COLUMN "suppliers"."partnership_accepted_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."suppliers"."partnership_accepted_at" IS 'Timestamp when supplier accepted partnership';


--
-- Name: COLUMN "suppliers"."partnership_declined_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."suppliers"."partnership_declined_at" IS 'Timestamp when supplier declined partnership';


--
-- Name: COLUMN "suppliers"."decline_reason"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."suppliers"."decline_reason" IS 'Reason provided by supplier for declining partnership';


--
-- Name: CONSTRAINT "suppliers_status_check" ON "suppliers"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON CONSTRAINT "suppliers_status_check" ON "public"."suppliers" IS 'Allowed supplier statuses including two-step approval process';


--
-- Name: tax_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."tax_codes" (
    "code" "text" NOT NULL,
    "jurisdiction_code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "tax_type" "text" NOT NULL,
    "category" "text" NOT NULL,
    "rate_percent" numeric(6,3) NOT NULL,
    "effective_from" "date" DEFAULT CURRENT_DATE NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    CONSTRAINT "tax_codes_rate_percent_check" CHECK (("rate_percent" >= (0)::numeric)),
    CONSTRAINT "tax_codes_tax_type_check" CHECK (("tax_type" = ANY (ARRAY['VAT'::"text", 'GST'::"text", 'SALES_TAX'::"text", 'WHT'::"text"])))
);


--
-- Name: tax_jurisdictions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."tax_jurisdictions" (
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "country_code" "text" NOT NULL,
    "region_code" "text",
    "tax_system" "text" NOT NULL,
    CONSTRAINT "tax_jurisdictions_tax_system_check" CHECK (("tax_system" = ANY (ARRAY['VAT'::"text", 'GST'::"text", 'SALES_TAX'::"text"])))
);


--
-- Name: tax_payment_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."tax_payment_schedules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), '11111111-1111-1111-1111-111111111111'::"uuid") NOT NULL,
    "tax_type" character varying(100) NOT NULL,
    "next_due_date" "date" NOT NULL,
    "amount" numeric(15,2) NOT NULL,
    "frequency" character varying(20) DEFAULT 'MONTHLY'::character varying NOT NULL,
    "status" character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "deleted_at" timestamp with time zone,
    CONSTRAINT "tax_payment_schedules_amount_check" CHECK (("amount" > (0)::numeric)),
    CONSTRAINT "tax_payment_schedules_frequency_check" CHECK ((("frequency")::"text" = ANY (ARRAY[('MONTHLY'::character varying)::"text", ('QUARTERLY'::character varying)::"text", ('ANNUALLY'::character varying)::"text"]))),
    CONSTRAINT "tax_payment_schedules_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('ACTIVE'::character varying)::"text", ('PAID'::character varying)::"text", ('CANCELLED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."tax_payment_schedules" FORCE ROW LEVEL SECURITY;


--
-- Name: time_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."time_entries" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "task_id" "uuid",
    "user_id" "uuid",
    "employee_id" "uuid",
    "entry_date" "date" NOT NULL,
    "hours" numeric(8,2) NOT NULL,
    "description" "text",
    "billable" boolean DEFAULT true NOT NULL,
    "hourly_rate" numeric(15,2),
    "invoice_id" "uuid",
    "invoiced_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "time_entries_hours_check" CHECK ((("hours" > (0)::numeric) AND ("hours" <= (24)::numeric)))
);

ALTER TABLE ONLY "public"."time_entries" FORCE ROW LEVEL SECURITY;


--
-- Name: uom_conversions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."uom_conversions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "item_id" "uuid",
    "from_uom" character varying(50) NOT NULL,
    "to_uom" character varying(50) NOT NULL,
    "conversion_factor" numeric(15,6) NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "uom_conversions_conversion_factor_check" CHECK (("conversion_factor" > (0)::numeric))
);

ALTER TABLE ONLY "public"."uom_conversions" FORCE ROW LEVEL SECURITY;


--
-- Name: usage_counters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."usage_counters" (
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    "period_month" "date" NOT NULL,
    "metric" "text" NOT NULL,
    "count" integer DEFAULT 0 NOT NULL
);

ALTER TABLE ONLY "public"."usage_counters" FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE "usage_counters"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."usage_counters" IS 'Count-based monthly usage per metric (e.g. embedding_calls) — separate from ai_usage_log''s dollar-cost tracking, since local embeddings have no dollar cost.';


--
-- Name: user_companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."user_companies" (
    "user_id" "uuid" NOT NULL,
    "company_id" "uuid" NOT NULL,
    "role" character varying(30),
    "is_primary" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."users" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "email" character varying(255) NOT NULL,
    "password_hash" character varying(255) NOT NULL,
    "first_name" character varying(100) NOT NULL,
    "last_name" character varying(100) NOT NULL,
    "role" character varying(20) DEFAULT 'USER'::character varying NOT NULL,
    "is_active" boolean DEFAULT true,
    "last_login" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" timestamp with time zone,
    "email_verified" boolean DEFAULT false NOT NULL,
    "must_change_password" boolean DEFAULT false NOT NULL,
    CONSTRAINT "users_role_check" CHECK ((("role")::"text" = ANY (ARRAY[('ADMIN'::character varying)::"text", ('MANAGER'::character varying)::"text", ('USER'::character varying)::"text", ('FINANCE_MANAGER'::character varying)::"text", ('FINANCE_USER'::character varying)::"text"])))
);


--
-- Name: TABLE "users"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."users" IS 'System users with authentication and role-based access';


--
-- Name: COLUMN "users"."password_hash"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."users"."password_hash" IS 'Bcrypt hashed password';


--
-- Name: COLUMN "users"."role"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."users"."role" IS 'User role: ADMIN, MANAGER, or USER';


--
-- Name: COLUMN "users"."is_active"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."users"."is_active" IS 'Whether the user account is active';


--
-- Name: COLUMN "users"."deleted_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."users"."deleted_at" IS 'Soft delete marker — set instead of removing the row so history/FKs stay intact';


--
-- Name: COLUMN "users"."email_verified"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."users"."email_verified" IS 'True for every account that existed before migration 202608071700 (grandfathered); new signups start false until they click the verification link.';


--
-- Name: warehouse_transaction_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."warehouse_transaction_audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "warehouse_transaction_id" "uuid" NOT NULL,
    "action" character varying(50) NOT NULL,
    "previous_status" character varying(20),
    "new_status" character varying(20),
    "field_changed" character varying(100),
    "old_value" "text",
    "new_value" "text",
    "user_id" "uuid" NOT NULL,
    "user_agent" "text",
    "ip_address" "inet",
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: warehouse_transaction_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."warehouse_transaction_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "warehouse_transaction_id" "uuid" NOT NULL,
    "inventory_item_id" "uuid",
    "item_name" character varying(255) NOT NULL,
    "item_description" "text",
    "quantity" numeric(15,4) NOT NULL,
    "received_quantity" numeric(15,4),
    "issued_quantity" numeric(15,4),
    "return_quantity" numeric(15,4),
    "transfer_quantity" numeric(15,4),
    "physical_quantity" numeric(15,4),
    "adjustment_quantity" numeric(15,4),
    "unit_of_measure" character varying(10) DEFAULT 'PCS'::character varying NOT NULL,
    "unit_cost" numeric(15,4) DEFAULT 0,
    "total_cost" numeric(15,2) DEFAULT 0,
    "source_storage_location_id" "uuid",
    "source_bin_id" "uuid",
    "destination_storage_location_id" "uuid",
    "destination_bin_id" "uuid",
    "condition" character varying(20),
    "reason_code" character varying(50) NOT NULL,
    "batch_number" character varying(50),
    "expiry_date" "date",
    "serial_number" character varying(100),
    "notes" "text",
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "warehouse_transaction_items_condition_check" CHECK ((("condition")::"text" = ANY (ARRAY[('GOOD'::character varying)::"text", ('DAMAGED'::character varying)::"text", ('EXPIRED'::character varying)::"text", ('DEFECTIVE'::character varying)::"text"])))
);


--
-- Name: warehouse_transaction_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."warehouse_transaction_number_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: warehouse_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."warehouse_transactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "transaction_number" character varying(20) NOT NULL,
    "transaction_type" character varying(10) NOT NULL,
    "transaction_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "reference_document" character varying(50),
    "reference_type" character varying(20),
    "reference_id" "uuid",
    "return_type" character varying(20),
    "transfer_type" character varying(20),
    "adjustment_type" character varying(50),
    "cost_center" character varying(50),
    "job_reference" character varying(100),
    "status" character varying(20) DEFAULT 'POSTED'::character varying NOT NULL,
    "requires_approval" boolean DEFAULT false,
    "approved_by" "uuid",
    "approved_at" timestamp without time zone,
    "total_quantity" numeric(15,4) DEFAULT 0,
    "total_value" numeric(15,2) DEFAULT 0,
    "notes" "text",
    "created_by" "uuid" NOT NULL,
    "processed_by" "uuid",
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "warehouse_transactions_adjustment_type_check" CHECK ((("adjustment_type")::"text" = ANY (ARRAY[('PHYSICAL_COUNT'::character varying)::"text", ('DAMAGE'::character varying)::"text", ('LOSS'::character varying)::"text", ('FOUND'::character varying)::"text", ('CORRECTION'::character varying)::"text"]))),
    CONSTRAINT "warehouse_transactions_reference_type_check" CHECK ((("reference_type")::"text" = ANY (ARRAY[('PO'::character varying)::"text", ('SO'::character varying)::"text", ('WO'::character varying)::"text", ('MANUAL'::character varying)::"text"]))),
    CONSTRAINT "warehouse_transactions_return_type_check" CHECK ((("return_type")::"text" = ANY (ARRAY[('supplier'::character varying)::"text", ('customer'::character varying)::"text", ('internal'::character varying)::"text"]))),
    CONSTRAINT "warehouse_transactions_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('DRAFT'::character varying)::"text", ('POSTED'::character varying)::"text", ('PENDING_APPROVAL'::character varying)::"text", ('APPROVED'::character varying)::"text", ('REJECTED'::character varying)::"text", ('CANCELLED'::character varying)::"text"]))),
    CONSTRAINT "warehouse_transactions_transaction_type_check" CHECK ((("transaction_type")::"text" = ANY (ARRAY[('GR'::character varying)::"text", ('GI'::character varying)::"text", ('GE'::character varying)::"text", ('GT'::character varying)::"text", ('SA'::character varying)::"text"]))),
    CONSTRAINT "warehouse_transactions_transfer_type_check" CHECK ((("transfer_type")::"text" = ANY (ARRAY[('intra-warehouse'::character varying)::"text", ('inter-warehouse'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."warehouse_transactions" FORCE ROW LEVEL SECURITY;


--
-- Name: webhook_delivery_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."webhook_delivery_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "subscription_id" "uuid",
    "event_type" character varying(100) NOT NULL,
    "payload" "jsonb" NOT NULL,
    "response_status" integer,
    "error" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: webhook_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."webhook_subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "url" "text" NOT NULL,
    "event_types" "text"[] NOT NULL,
    "secret" character varying(64) NOT NULL,
    "status" character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    "created_by" "uuid",
    "last_delivery_at" timestamp with time zone,
    "last_delivery_status" integer,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "webhook_subscriptions_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('ACTIVE'::character varying)::"text", ('DISABLED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."webhook_subscriptions" FORCE ROW LEVEL SECURITY;


--
-- Name: work_centers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."work_centers" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "code" character varying(30) NOT NULL,
    "name" character varying(120) NOT NULL,
    "description" "text",
    "cost_center_id" "uuid",
    "daily_capacity_hours" numeric(10,2) DEFAULT 8 NOT NULL,
    "efficiency_pct" numeric(5,2) DEFAULT 100 NOT NULL,
    "hourly_rate" numeric(15,4) DEFAULT 0 NOT NULL,
    "status" character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "deleted_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "work_centers_daily_capacity_hours_check" CHECK (("daily_capacity_hours" > (0)::numeric)),
    CONSTRAINT "work_centers_efficiency_pct_check" CHECK ((("efficiency_pct" > (0)::numeric) AND ("efficiency_pct" <= (200)::numeric))),
    CONSTRAINT "work_centers_hourly_rate_check" CHECK (("hourly_rate" >= (0)::numeric)),
    CONSTRAINT "work_centers_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('ACTIVE'::character varying)::"text", ('INACTIVE'::character varying)::"text", ('MAINTENANCE'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."work_centers" FORCE ROW LEVEL SECURITY;


--
-- Name: work_order_components; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."work_order_components" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "work_order_id" "uuid" NOT NULL,
    "component_item_id" "uuid" NOT NULL,
    "line_number" integer DEFAULT 1 NOT NULL,
    "quantity_required" numeric(15,4) NOT NULL,
    "quantity_issued" numeric(15,4) DEFAULT 0 NOT NULL,
    "unit_cost" numeric(15,4) DEFAULT 0 NOT NULL,
    "issued_value" numeric(15,2) DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "unit_of_measure" character varying(20)
);


--
-- Name: work_order_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."work_order_operations" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "work_order_id" "uuid" NOT NULL,
    "operation_number" integer NOT NULL,
    "work_center_id" "uuid" NOT NULL,
    "description" character varying(200) NOT NULL,
    "setup_hours" numeric(10,4) DEFAULT 0 NOT NULL,
    "run_hours_per_unit" numeric(10,6) DEFAULT 0 NOT NULL,
    "planned_hours" numeric(12,4) DEFAULT 0 NOT NULL,
    "actual_hours" numeric(12,4) DEFAULT 0 NOT NULL,
    "hourly_rate" numeric(15,4) DEFAULT 0 NOT NULL,
    "status" character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    "scheduled_start" timestamp with time zone,
    "scheduled_end" timestamp with time zone,
    "actual_start" timestamp with time zone,
    "actual_end" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "work_order_operations_actual_hours_check" CHECK (("actual_hours" >= (0)::numeric)),
    CONSTRAINT "work_order_operations_planned_hours_check" CHECK (("planned_hours" >= (0)::numeric)),
    CONSTRAINT "work_order_operations_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('PENDING'::character varying)::"text", ('IN_PROGRESS'::character varying)::"text", ('COMPLETED'::character varying)::"text", ('SKIPPED'::character varying)::"text"])))
);


--
-- Name: work_order_time_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."work_order_time_entries" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "operation_id" "uuid" NOT NULL,
    "work_order_id" "uuid" NOT NULL,
    "hours" numeric(10,4) NOT NULL,
    "entry_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "employee_id" "uuid",
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "work_order_time_entries_hours_check" CHECK (("hours" > (0)::numeric))
);


--
-- Name: work_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."work_orders" (
    "id" "uuid" DEFAULT "public"."uuid_generate_v4"() NOT NULL,
    "wo_number" character varying(30) NOT NULL,
    "item_id" "uuid" NOT NULL,
    "bom_id" "uuid",
    "quantity_ordered" numeric(15,4) NOT NULL,
    "quantity_produced" numeric(15,4) DEFAULT 0 NOT NULL,
    "quantity_scrapped" numeric(15,4) DEFAULT 0 NOT NULL,
    "status" character varying(24) DEFAULT 'DRAFT'::character varying NOT NULL,
    "planned_start_date" "date",
    "planned_end_date" "date",
    "actual_start_date" "date",
    "actual_end_date" "date",
    "wip_value" numeric(15,2) DEFAULT 0 NOT NULL,
    "completed_value" numeric(15,2) DEFAULT 0 NOT NULL,
    "storage_location_id" "uuid",
    "sales_order_id" "uuid",
    "source" character varying(20) DEFAULT 'MANUAL'::character varying NOT NULL,
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "deleted_at" timestamp with time zone,
    "company_id" "uuid" DEFAULT COALESCE("public"."current_company_id"(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::"uuid") NOT NULL,
    CONSTRAINT "work_orders_quantity_ordered_check" CHECK (("quantity_ordered" > (0)::numeric)),
    CONSTRAINT "work_orders_source_check" CHECK ((("source")::"text" = ANY (ARRAY[('MANUAL'::character varying)::"text", ('MRP'::character varying)::"text", ('SALES_ORDER'::character varying)::"text"]))),
    CONSTRAINT "work_orders_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('DRAFT'::character varying)::"text", ('RELEASED'::character varying)::"text", ('IN_PROGRESS'::character varying)::"text", ('COMPLETED'::character varying)::"text", ('CANCELLED'::character varying)::"text"])))
);

ALTER TABLE ONLY "public"."work_orders" FORCE ROW LEVEL SECURITY;


--
-- Name: audit_chain id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."audit_chain" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."audit_chain_id_seq"'::"regclass");


--
-- Name: audit_ddl_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."audit_ddl_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."audit_ddl_log_id_seq"'::"regclass");


--
-- Name: sales_rfq_communications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_rfq_communications" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."sales_rfq_communications_id_seq"'::"regclass");


--
-- Name: sales_rfq_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_rfq_items" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."sales_rfq_items_id_seq"'::"regclass");


--
-- Name: sales_rfq_status_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_rfq_status_history" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."sales_rfq_status_history_id_seq"'::"regclass");


--
-- Name: sales_rfqs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_rfqs" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."sales_rfqs_id_seq"'::"regclass");


--
-- Name: accounting_periods accounting_periods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."accounting_periods"
    ADD CONSTRAINT "accounting_periods_pkey" PRIMARY KEY ("id");


--
-- Name: activities activities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."activities"
    ADD CONSTRAINT "activities_pkey" PRIMARY KEY ("id");


--
-- Name: agent_blueprint_versions agent_blueprint_versions_blueprint_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_blueprint_versions"
    ADD CONSTRAINT "agent_blueprint_versions_blueprint_id_version_key" UNIQUE ("blueprint_id", "version");


--
-- Name: agent_blueprint_versions agent_blueprint_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_blueprint_versions"
    ADD CONSTRAINT "agent_blueprint_versions_pkey" PRIMARY KEY ("id");


--
-- Name: agent_blueprints agent_blueprints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_blueprints"
    ADD CONSTRAINT "agent_blueprints_pkey" PRIMARY KEY ("id");


--
-- Name: agent_credentials agent_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_credentials"
    ADD CONSTRAINT "agent_credentials_pkey" PRIMARY KEY ("company_id", "agent_key", "credential_id");


--
-- Name: agent_definitions agent_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_definitions"
    ADD CONSTRAINT "agent_definitions_pkey" PRIMARY KEY ("id");


--
-- Name: agent_escalations agent_escalations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_escalations"
    ADD CONSTRAINT "agent_escalations_pkey" PRIMARY KEY ("id");


--
-- Name: agent_memory agent_memory_agent_key_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_memory"
    ADD CONSTRAINT "agent_memory_agent_key_key_key" UNIQUE ("agent_key", "key");


--
-- Name: agent_memory agent_memory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_memory"
    ADD CONSTRAINT "agent_memory_pkey" PRIMARY KEY ("id");


--
-- Name: agent_paused_runs agent_paused_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_paused_runs"
    ADD CONSTRAINT "agent_paused_runs_pkey" PRIMARY KEY ("id");


--
-- Name: agent_run_actions agent_run_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_run_actions"
    ADD CONSTRAINT "agent_run_actions_pkey" PRIMARY KEY ("id");


--
-- Name: agent_run_messages agent_run_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_run_messages"
    ADD CONSTRAINT "agent_run_messages_pkey" PRIMARY KEY ("id");


--
-- Name: agent_runs agent_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_runs"
    ADD CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id");


--
-- Name: ai_audit_log ai_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_audit_log"
    ADD CONSTRAINT "ai_audit_log_pkey" PRIMARY KEY ("id");


--
-- Name: ai_credentials ai_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_credentials"
    ADD CONSTRAINT "ai_credentials_pkey" PRIMARY KEY ("id");


--
-- Name: ai_feedback ai_feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_feedback"
    ADD CONSTRAINT "ai_feedback_pkey" PRIMARY KEY ("id");


--
-- Name: ai_finding_suppressions ai_finding_suppressions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_finding_suppressions"
    ADD CONSTRAINT "ai_finding_suppressions_pkey" PRIMARY KEY ("id");


--
-- Name: ai_findings ai_findings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_findings"
    ADD CONSTRAINT "ai_findings_pkey" PRIMARY KEY ("id");


--
-- Name: ai_learned_preferences ai_learned_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_learned_preferences"
    ADD CONSTRAINT "ai_learned_preferences_pkey" PRIMARY KEY ("id");


--
-- Name: ai_settings ai_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_settings"
    ADD CONSTRAINT "ai_settings_pkey" PRIMARY KEY ("company_id");


--
-- Name: ai_tool_settings ai_tool_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_tool_settings"
    ADD CONSTRAINT "ai_tool_settings_pkey" PRIMARY KEY ("company_id", "tool_name");


--
-- Name: ai_tool_versions ai_tool_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_tool_versions"
    ADD CONSTRAINT "ai_tool_versions_pkey" PRIMARY KEY ("id");


--
-- Name: ai_tool_versions ai_tool_versions_tool_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_tool_versions"
    ADD CONSTRAINT "ai_tool_versions_tool_id_version_key" UNIQUE ("tool_id", "version");


--
-- Name: ai_tools ai_tools_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_tools"
    ADD CONSTRAINT "ai_tools_pkey" PRIMARY KEY ("id");


--
-- Name: ai_usage_log ai_usage_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_usage_log"
    ADD CONSTRAINT "ai_usage_log_pkey" PRIMARY KEY ("id");


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id");


--
-- Name: approval_chain_steps approval_chain_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."approval_chain_steps"
    ADD CONSTRAINT "approval_chain_steps_pkey" PRIMARY KEY ("id");


--
-- Name: approval_chain_steps approval_chain_steps_template_id_step_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."approval_chain_steps"
    ADD CONSTRAINT "approval_chain_steps_template_id_step_number_key" UNIQUE ("template_id", "step_number");


--
-- Name: approval_chain_templates approval_chain_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."approval_chain_templates"
    ADD CONSTRAINT "approval_chain_templates_pkey" PRIMARY KEY ("id");


--
-- Name: approval_delegations approval_delegations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."approval_delegations"
    ADD CONSTRAINT "approval_delegations_pkey" PRIMARY KEY ("id");


--
-- Name: approval_request_steps approval_request_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."approval_request_steps"
    ADD CONSTRAINT "approval_request_steps_pkey" PRIMARY KEY ("id");


--
-- Name: approval_request_steps approval_request_steps_request_id_step_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."approval_request_steps"
    ADD CONSTRAINT "approval_request_steps_request_id_step_number_key" UNIQUE ("request_id", "step_number");


--
-- Name: approval_requests approval_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."approval_requests"
    ADD CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id");


--
-- Name: attendance_records attendance_records_employee_id_record_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."attendance_records"
    ADD CONSTRAINT "attendance_records_employee_id_record_date_key" UNIQUE ("employee_id", "record_date");


--
-- Name: attendance_records attendance_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."attendance_records"
    ADD CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id");


--
-- Name: audit_chain audit_chain_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."audit_chain"
    ADD CONSTRAINT "audit_chain_pkey" PRIMARY KEY ("id");


--
-- Name: audit_ddl_log audit_ddl_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."audit_ddl_log"
    ADD CONSTRAINT "audit_ddl_log_pkey" PRIMARY KEY ("id");


--
-- Name: auto_purchase_orders auto_purchase_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."auto_purchase_orders"
    ADD CONSTRAINT "auto_purchase_orders_pkey" PRIMARY KEY ("id");


--
-- Name: background_tasks background_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."background_tasks"
    ADD CONSTRAINT "background_tasks_pkey" PRIMARY KEY ("id");


--
-- Name: bank_accounts bank_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bank_accounts"
    ADD CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id");


--
-- Name: bank_transactions bank_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bank_transactions"
    ADD CONSTRAINT "bank_transactions_pkey" PRIMARY KEY ("id");


--
-- Name: bills_of_material bills_of_material_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bills_of_material"
    ADD CONSTRAINT "bills_of_material_pkey" PRIMARY KEY ("id");


--
-- Name: bins bins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bins"
    ADD CONSTRAINT "bins_pkey" PRIMARY KEY ("id");


--
-- Name: bom_components bom_components_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bom_components"
    ADD CONSTRAINT "bom_components_pkey" PRIMARY KEY ("id");


--
-- Name: bom_operations bom_operations_bom_id_operation_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bom_operations"
    ADD CONSTRAINT "bom_operations_bom_id_operation_number_key" UNIQUE ("bom_id", "operation_number");


--
-- Name: bom_operations bom_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bom_operations"
    ADD CONSTRAINT "bom_operations_pkey" PRIMARY KEY ("id");


--
-- Name: budget_lines budget_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."budget_lines"
    ADD CONSTRAINT "budget_lines_pkey" PRIMARY KEY ("id");


--
-- Name: budgets budgets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."budgets"
    ADD CONSTRAINT "budgets_pkey" PRIMARY KEY ("id");


--
-- Name: business_type_default_modules business_type_default_modules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."business_type_default_modules"
    ADD CONSTRAINT "business_type_default_modules_pkey" PRIMARY KEY ("business_type_code", "module_key");


--
-- Name: business_types business_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."business_types"
    ADD CONSTRAINT "business_types_pkey" PRIMARY KEY ("code");


--
-- Name: chart_of_accounts chart_of_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."chart_of_accounts"
    ADD CONSTRAINT "chart_of_accounts_pkey" PRIMARY KEY ("id");


--
-- Name: chart_of_accounts_status_history chart_of_accounts_status_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."chart_of_accounts_status_history"
    ADD CONSTRAINT "chart_of_accounts_status_history_pkey" PRIMARY KEY ("id");


--
-- Name: chat_memory chat_memory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."chat_memory"
    ADD CONSTRAINT "chat_memory_pkey" PRIMARY KEY ("id");


--
-- Name: companies companies_company_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."companies"
    ADD CONSTRAINT "companies_company_code_key" UNIQUE ("company_code");


--
-- Name: companies companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."companies"
    ADD CONSTRAINT "companies_pkey" PRIMARY KEY ("id");


--
-- Name: company_gl_mappings company_gl_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."company_gl_mappings"
    ADD CONSTRAINT "company_gl_mappings_pkey" PRIMARY KEY ("id");


--
-- Name: company_isolation_config company_isolation_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."company_isolation_config"
    ADD CONSTRAINT "company_isolation_config_pkey" PRIMARY KEY ("id");


--
-- Name: company_modules company_modules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."company_modules"
    ADD CONSTRAINT "company_modules_pkey" PRIMARY KEY ("company_id", "module_key");


--
-- Name: company_scoped_tables company_scoped_tables_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."company_scoped_tables"
    ADD CONSTRAINT "company_scoped_tables_pkey" PRIMARY KEY ("table_name");


--
-- Name: company_subscriptions company_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."company_subscriptions"
    ADD CONSTRAINT "company_subscriptions_pkey" PRIMARY KEY ("company_id");


--
-- Name: connector_oauth_pending connector_oauth_pending_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."connector_oauth_pending"
    ADD CONSTRAINT "connector_oauth_pending_pkey" PRIMARY KEY ("state");


--
-- Name: connectors connectors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."connectors"
    ADD CONSTRAINT "connectors_pkey" PRIMARY KEY ("id");


--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_pkey" PRIMARY KEY ("id");


--
-- Name: contract_items contract_items_contract_id_item_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contract_items"
    ADD CONSTRAINT "contract_items_contract_id_item_id_key" UNIQUE ("contract_id", "item_id");


--
-- Name: contract_items contract_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contract_items"
    ADD CONSTRAINT "contract_items_pkey" PRIMARY KEY ("id");


--
-- Name: contracts contracts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contracts"
    ADD CONSTRAINT "contracts_pkey" PRIMARY KEY ("id");


--
-- Name: conversation_messages conversation_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."conversation_messages"
    ADD CONSTRAINT "conversation_messages_pkey" PRIMARY KEY ("id");


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_pkey" PRIMARY KEY ("id");


--
-- Name: conversations conversations_user_id_session_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_user_id_session_id_key" UNIQUE ("user_id", "session_id");


--
-- Name: cost_centers cost_centers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cost_centers"
    ADD CONSTRAINT "cost_centers_pkey" PRIMARY KEY ("id");


--
-- Name: cost_layers cost_layers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cost_layers"
    ADD CONSTRAINT "cost_layers_pkey" PRIMARY KEY ("id");


--
-- Name: currencies currencies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."currencies"
    ADD CONSTRAINT "currencies_pkey" PRIMARY KEY ("code");


--
-- Name: customer_audit_log customer_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_audit_log"
    ADD CONSTRAINT "customer_audit_log_pkey" PRIMARY KEY ("id");


--
-- Name: customer_invoice_items customer_invoice_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_invoice_items"
    ADD CONSTRAINT "customer_invoice_items_pkey" PRIMARY KEY ("id");


--
-- Name: customer_invoice_status_history customer_invoice_status_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_invoice_status_history"
    ADD CONSTRAINT "customer_invoice_status_history_pkey" PRIMARY KEY ("id");


--
-- Name: customer_invoices customer_invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_invoices"
    ADD CONSTRAINT "customer_invoices_pkey" PRIMARY KEY ("id");


--
-- Name: customer_payment_allocations customer_payment_allocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_payment_allocations"
    ADD CONSTRAINT "customer_payment_allocations_pkey" PRIMARY KEY ("id");


--
-- Name: customer_payment_status_history customer_payment_status_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_payment_status_history"
    ADD CONSTRAINT "customer_payment_status_history_pkey" PRIMARY KEY ("id");


--
-- Name: customer_payments customer_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_payments"
    ADD CONSTRAINT "customer_payments_pkey" PRIMARY KEY ("id");


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_pkey" PRIMARY KEY ("id");


--
-- Name: dashboard_widgets dashboard_widgets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."dashboard_widgets"
    ADD CONSTRAINT "dashboard_widgets_pkey" PRIMARY KEY ("id");


--
-- Name: dashboards dashboards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."dashboards"
    ADD CONSTRAINT "dashboards_pkey" PRIMARY KEY ("id");


--
-- Name: deals deals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."deals"
    ADD CONSTRAINT "deals_pkey" PRIMARY KEY ("id");


--
-- Name: delegation_of_authority delegation_of_authority_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delegation_of_authority"
    ADD CONSTRAINT "delegation_of_authority_pkey" PRIMARY KEY ("id");


--
-- Name: delivery_exceptions delivery_exceptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_exceptions"
    ADD CONSTRAINT "delivery_exceptions_pkey" PRIMARY KEY ("id");


--
-- Name: delivery_items delivery_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_items"
    ADD CONSTRAINT "delivery_items_pkey" PRIMARY KEY ("id");


--
-- Name: delivery_route_stops delivery_route_stops_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_route_stops"
    ADD CONSTRAINT "delivery_route_stops_pkey" PRIMARY KEY ("id");


--
-- Name: delivery_routes delivery_routes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_routes"
    ADD CONSTRAINT "delivery_routes_pkey" PRIMARY KEY ("id");


--
-- Name: delivery_schedules delivery_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_schedules"
    ADD CONSTRAINT "delivery_schedules_pkey" PRIMARY KEY ("id");


--
-- Name: delivery_status_history delivery_status_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_status_history"
    ADD CONSTRAINT "delivery_status_history_pkey" PRIMARY KEY ("id");


--
-- Name: document_embeddings document_embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."document_embeddings"
    ADD CONSTRAINT "document_embeddings_pkey" PRIMARY KEY ("id");


--
-- Name: email_verification_tokens email_verification_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."email_verification_tokens"
    ADD CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id");


--
-- Name: employees employees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."employees"
    ADD CONSTRAINT "employees_pkey" PRIMARY KEY ("id");


--
-- Name: exchange_rates exchange_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."exchange_rates"
    ADD CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id");


--
-- Name: fixed_asset_depreciation fixed_asset_depreciation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."fixed_asset_depreciation"
    ADD CONSTRAINT "fixed_asset_depreciation_pkey" PRIMARY KEY ("id");


--
-- Name: fixed_asset_revaluations fixed_asset_revaluations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."fixed_asset_revaluations"
    ADD CONSTRAINT "fixed_asset_revaluations_pkey" PRIMARY KEY ("id");


--
-- Name: fixed_assets fixed_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."fixed_assets"
    ADD CONSTRAINT "fixed_assets_pkey" PRIMARY KEY ("id");


--
-- Name: generated_documents generated_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."generated_documents"
    ADD CONSTRAINT "generated_documents_pkey" PRIMARY KEY ("id");


--
-- Name: goods_receipts goods_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."goods_receipts"
    ADD CONSTRAINT "goods_receipts_pkey" PRIMARY KEY ("id");


--
-- Name: intercompany_transactions intercompany_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."intercompany_transactions"
    ADD CONSTRAINT "intercompany_transactions_pkey" PRIMARY KEY ("id");


--
-- Name: intercompany_transactions intercompany_transactions_reference_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."intercompany_transactions"
    ADD CONSTRAINT "intercompany_transactions_reference_key" UNIQUE ("reference");


--
-- Name: inventory_items inventory_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."inventory_items"
    ADD CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id");


--
-- Name: inventory_items inventory_items_unique_item_per_user; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."inventory_items"
    ADD CONSTRAINT "inventory_items_unique_item_per_user" UNIQUE ("item_master_id", "user_id");


--
-- Name: inventory_storage_mappings inventory_storage_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."inventory_storage_mappings"
    ADD CONSTRAINT "inventory_storage_mappings_pkey" PRIMARY KEY ("id");


--
-- Name: inventory_transfers inventory_transfers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."inventory_transfers"
    ADD CONSTRAINT "inventory_transfers_pkey" PRIMARY KEY ("id");


--
-- Name: items items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."items"
    ADD CONSTRAINT "items_pkey" PRIMARY KEY ("id");


--
-- Name: journal_entries journal_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."journal_entries"
    ADD CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id");


--
-- Name: journal_entry_items journal_entry_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."journal_entry_items"
    ADD CONSTRAINT "journal_entry_items_pkey" PRIMARY KEY ("id");


--
-- Name: journal_entry_status_history journal_entry_status_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."journal_entry_status_history"
    ADD CONSTRAINT "journal_entry_status_history_pkey" PRIMARY KEY ("id");


--
-- Name: kb_documents kb_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."kb_documents"
    ADD CONSTRAINT "kb_documents_pkey" PRIMARY KEY ("id");


--
-- Name: landed_cost_items landed_cost_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."landed_cost_items"
    ADD CONSTRAINT "landed_cost_items_pkey" PRIMARY KEY ("id");


--
-- Name: landed_cost_vouchers landed_cost_vouchers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."landed_cost_vouchers"
    ADD CONSTRAINT "landed_cost_vouchers_pkey" PRIMARY KEY ("id");


--
-- Name: leads leads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "leads_pkey" PRIMARY KEY ("id");


--
-- Name: leave_requests leave_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."leave_requests"
    ADD CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id");


--
-- Name: loan_schedules loan_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."loan_schedules"
    ADD CONSTRAINT "loan_schedules_pkey" PRIMARY KEY ("id");


--
-- Name: mcp_connections mcp_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."mcp_connections"
    ADD CONSTRAINT "mcp_connections_pkey" PRIMARY KEY ("id");


--
-- Name: mcp_oauth_grants mcp_oauth_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."mcp_oauth_grants"
    ADD CONSTRAINT "mcp_oauth_grants_pkey" PRIMARY KEY ("id");


--
-- Name: mcp_oauth_pending mcp_oauth_pending_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."mcp_oauth_pending"
    ADD CONSTRAINT "mcp_oauth_pending_pkey" PRIMARY KEY ("state");


--
-- Name: modules modules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."modules"
    ADD CONSTRAINT "modules_pkey" PRIMARY KEY ("key");


--
-- Name: mrp_planned_orders mrp_planned_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."mrp_planned_orders"
    ADD CONSTRAINT "mrp_planned_orders_pkey" PRIMARY KEY ("id");


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");


--
-- Name: packing_lists packing_lists_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."packing_lists"
    ADD CONSTRAINT "packing_lists_pkey" PRIMARY KEY ("id");


--
-- Name: password_reset_tokens password_reset_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."password_reset_tokens"
    ADD CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id");


--
-- Name: password_reset_tokens password_reset_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."password_reset_tokens"
    ADD CONSTRAINT "password_reset_tokens_token_hash_key" UNIQUE ("token_hash");


--
-- Name: payroll_items payroll_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payroll_items"
    ADD CONSTRAINT "payroll_items_pkey" PRIMARY KEY ("id");


--
-- Name: payroll_runs payroll_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payroll_runs"
    ADD CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id");


--
-- Name: pdf_template_versions pdf_template_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."pdf_template_versions"
    ADD CONSTRAINT "pdf_template_versions_pkey" PRIMARY KEY ("id");


--
-- Name: pdf_template_versions pdf_template_versions_template_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."pdf_template_versions"
    ADD CONSTRAINT "pdf_template_versions_template_id_version_key" UNIQUE ("template_id", "version");


--
-- Name: pdf_templates pdf_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."pdf_templates"
    ADD CONSTRAINT "pdf_templates_pkey" PRIMARY KEY ("id");


--
-- Name: period_close_checklist period_close_checklist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."period_close_checklist"
    ADD CONSTRAINT "period_close_checklist_pkey" PRIMARY KEY ("id");


--
-- Name: plans plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."plans"
    ADD CONSTRAINT "plans_pkey" PRIMARY KEY ("code");


--
-- Name: price_list_items price_list_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."price_list_items"
    ADD CONSTRAINT "price_list_items_pkey" PRIMARY KEY ("id");


--
-- Name: price_lists price_lists_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."price_lists"
    ADD CONSTRAINT "price_lists_pkey" PRIMARY KEY ("id");


--
-- Name: project_tasks project_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_tasks"
    ADD CONSTRAINT "project_tasks_pkey" PRIMARY KEY ("id");


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_pkey" PRIMARY KEY ("id");


--
-- Name: purchase_order_line_items purchase_order_line_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."purchase_order_line_items"
    ADD CONSTRAINT "purchase_order_line_items_pkey" PRIMARY KEY ("id");


--
-- Name: purchase_orders purchase_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id");


--
-- Name: purchase_orders purchase_orders_supplier_delivery_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_supplier_delivery_token_key" UNIQUE ("supplier_delivery_token");


--
-- Name: purchase_requisitions purchase_requisitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."purchase_requisitions"
    ADD CONSTRAINT "purchase_requisitions_pkey" PRIMARY KEY ("id");


--
-- Name: recurring_invoice_schedules recurring_invoice_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."recurring_invoice_schedules"
    ADD CONSTRAINT "recurring_invoice_schedules_pkey" PRIMARY KEY ("id");


--
-- Name: report_definitions report_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."report_definitions"
    ADD CONSTRAINT "report_definitions_pkey" PRIMARY KEY ("id");


--
-- Name: report_runs report_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."report_runs"
    ADD CONSTRAINT "report_runs_pkey" PRIMARY KEY ("id");


--
-- Name: report_schedules report_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."report_schedules"
    ADD CONSTRAINT "report_schedules_pkey" PRIMARY KEY ("id");


--
-- Name: request_for_quotations request_for_quotations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."request_for_quotations"
    ADD CONSTRAINT "request_for_quotations_pkey" PRIMARY KEY ("id");


--
-- Name: revenue_schedules revenue_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."revenue_schedules"
    ADD CONSTRAINT "revenue_schedules_pkey" PRIMARY KEY ("id");


--
-- Name: rfq_line_items rfq_line_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."rfq_line_items"
    ADD CONSTRAINT "rfq_line_items_pkey" PRIMARY KEY ("id");


--
-- Name: rfq_quotations rfq_quotations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."rfq_quotations"
    ADD CONSTRAINT "rfq_quotations_pkey" PRIMARY KEY ("id");


--
-- Name: rfq_quotations rfq_quotations_rfq_id_supplier_id_rfq_line_item_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."rfq_quotations"
    ADD CONSTRAINT "rfq_quotations_rfq_id_supplier_id_rfq_line_item_id_key" UNIQUE ("rfq_id", "supplier_id", "rfq_line_item_id");


--
-- Name: rfq_suppliers rfq_suppliers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."rfq_suppliers"
    ADD CONSTRAINT "rfq_suppliers_pkey" PRIMARY KEY ("id");


--
-- Name: rfq_suppliers rfq_suppliers_rfq_id_supplier_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."rfq_suppliers"
    ADD CONSTRAINT "rfq_suppliers_rfq_id_supplier_id_key" UNIQUE ("rfq_id", "supplier_id");


--
-- Name: rfqs rfqs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."rfqs"
    ADD CONSTRAINT "rfqs_pkey" PRIMARY KEY ("id");


--
-- Name: rfqs rfqs_response_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."rfqs"
    ADD CONSTRAINT "rfqs_response_token_key" UNIQUE ("response_token");


--
-- Name: rfqs rfqs_rfq_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."rfqs"
    ADD CONSTRAINT "rfqs_rfq_number_key" UNIQUE ("rfq_number");


--
-- Name: sales_contract_items sales_contract_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_contract_items"
    ADD CONSTRAINT "sales_contract_items_pkey" PRIMARY KEY ("id");


--
-- Name: sales_contract_renewals sales_contract_renewals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_contract_renewals"
    ADD CONSTRAINT "sales_contract_renewals_pkey" PRIMARY KEY ("id");


--
-- Name: sales_contract_status_history sales_contract_status_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_contract_status_history"
    ADD CONSTRAINT "sales_contract_status_history_pkey" PRIMARY KEY ("id");


--
-- Name: sales_contract_usage sales_contract_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_contract_usage"
    ADD CONSTRAINT "sales_contract_usage_pkey" PRIMARY KEY ("id");


--
-- Name: sales_contracts sales_contracts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_contracts"
    ADD CONSTRAINT "sales_contracts_pkey" PRIMARY KEY ("id");


--
-- Name: sales_credit_note_items sales_credit_note_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_credit_note_items"
    ADD CONSTRAINT "sales_credit_note_items_pkey" PRIMARY KEY ("id");


--
-- Name: sales_credit_notes sales_credit_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_credit_notes"
    ADD CONSTRAINT "sales_credit_notes_pkey" PRIMARY KEY ("id");


--
-- Name: sales_order_items sales_order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_order_items"
    ADD CONSTRAINT "sales_order_items_pkey" PRIMARY KEY ("id");


--
-- Name: sales_order_status_history sales_order_status_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_order_status_history"
    ADD CONSTRAINT "sales_order_status_history_pkey" PRIMARY KEY ("id");


--
-- Name: sales_orders sales_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_orders"
    ADD CONSTRAINT "sales_orders_pkey" PRIMARY KEY ("id");


--
-- Name: sales_quotation_items sales_quotation_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_quotation_items"
    ADD CONSTRAINT "sales_quotation_items_pkey" PRIMARY KEY ("id");


--
-- Name: sales_quotation_status_history sales_quotation_status_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_quotation_status_history"
    ADD CONSTRAINT "sales_quotation_status_history_pkey" PRIMARY KEY ("id");


--
-- Name: sales_quotations sales_quotations_customer_response_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_quotations"
    ADD CONSTRAINT "sales_quotations_customer_response_token_key" UNIQUE ("customer_response_token");


--
-- Name: sales_quotations sales_quotations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_quotations"
    ADD CONSTRAINT "sales_quotations_pkey" PRIMARY KEY ("id");


--
-- Name: sales_rfq_communications sales_rfq_communications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_rfq_communications"
    ADD CONSTRAINT "sales_rfq_communications_pkey" PRIMARY KEY ("id");


--
-- Name: sales_rfq_item_responses sales_rfq_item_responses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_rfq_item_responses"
    ADD CONSTRAINT "sales_rfq_item_responses_pkey" PRIMARY KEY ("id");


--
-- Name: sales_rfq_items sales_rfq_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_rfq_items"
    ADD CONSTRAINT "sales_rfq_items_pkey" PRIMARY KEY ("id");


--
-- Name: sales_rfq_status_history sales_rfq_status_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_rfq_status_history"
    ADD CONSTRAINT "sales_rfq_status_history_pkey" PRIMARY KEY ("id");


--
-- Name: sales_rfq_supplier_responses sales_rfq_supplier_responses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_rfq_supplier_responses"
    ADD CONSTRAINT "sales_rfq_supplier_responses_pkey" PRIMARY KEY ("id");


--
-- Name: sales_rfqs sales_rfqs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_rfqs"
    ADD CONSTRAINT "sales_rfqs_pkey" PRIMARY KEY ("id");


--
-- Name: shipments shipments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."shipments"
    ADD CONSTRAINT "shipments_pkey" PRIMARY KEY ("id");


--
-- Name: stocktake_sheet_items stocktake_sheet_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."stocktake_sheet_items"
    ADD CONSTRAINT "stocktake_sheet_items_pkey" PRIMARY KEY ("id");


--
-- Name: stocktake_sheets stocktake_sheets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."stocktake_sheets"
    ADD CONSTRAINT "stocktake_sheets_pkey" PRIMARY KEY ("id");


--
-- Name: storage_locations storage_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."storage_locations"
    ADD CONSTRAINT "storage_locations_pkey" PRIMARY KEY ("id");


--
-- Name: supplier_bank_detail_changes supplier_bank_detail_changes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_bank_detail_changes"
    ADD CONSTRAINT "supplier_bank_detail_changes_pkey" PRIMARY KEY ("id");


--
-- Name: supplier_debit_note_items supplier_debit_note_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_debit_note_items"
    ADD CONSTRAINT "supplier_debit_note_items_pkey" PRIMARY KEY ("id");


--
-- Name: supplier_debit_notes supplier_debit_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_debit_notes"
    ADD CONSTRAINT "supplier_debit_notes_pkey" PRIMARY KEY ("id");


--
-- Name: supplier_invoice_items supplier_invoice_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_invoice_items"
    ADD CONSTRAINT "supplier_invoice_items_pkey" PRIMARY KEY ("id");


--
-- Name: supplier_invoice_status_history supplier_invoice_status_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_invoice_status_history"
    ADD CONSTRAINT "supplier_invoice_status_history_pkey" PRIMARY KEY ("id");


--
-- Name: supplier_invoices supplier_invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_invoices"
    ADD CONSTRAINT "supplier_invoices_pkey" PRIMARY KEY ("id");


--
-- Name: supplier_items supplier_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_items"
    ADD CONSTRAINT "supplier_items_pkey" PRIMARY KEY ("id");


--
-- Name: supplier_items supplier_items_supplier_id_item_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_items"
    ADD CONSTRAINT "supplier_items_supplier_id_item_id_key" UNIQUE ("supplier_id", "item_id");


--
-- Name: supplier_payment_allocations supplier_payment_allocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_payment_allocations"
    ADD CONSTRAINT "supplier_payment_allocations_pkey" PRIMARY KEY ("id");


--
-- Name: supplier_payment_status_history supplier_payment_status_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_payment_status_history"
    ADD CONSTRAINT "supplier_payment_status_history_pkey" PRIMARY KEY ("id");


--
-- Name: supplier_payments supplier_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_payments"
    ADD CONSTRAINT "supplier_payments_pkey" PRIMARY KEY ("id");


--
-- Name: suppliers suppliers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."suppliers"
    ADD CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id");


--
-- Name: tax_codes tax_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tax_codes"
    ADD CONSTRAINT "tax_codes_pkey" PRIMARY KEY ("code");


--
-- Name: tax_jurisdictions tax_jurisdictions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tax_jurisdictions"
    ADD CONSTRAINT "tax_jurisdictions_pkey" PRIMARY KEY ("code");


--
-- Name: tax_payment_schedules tax_payment_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tax_payment_schedules"
    ADD CONSTRAINT "tax_payment_schedules_pkey" PRIMARY KEY ("id");


--
-- Name: time_entries time_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id");


--
-- Name: delivery_route_stops unique_delivery_route_stop_order; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_route_stops"
    ADD CONSTRAINT "unique_delivery_route_stop_order" UNIQUE ("delivery_route_id", "stop_order");


--
-- Name: uom_conversions unique_item_uom_pair; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."uom_conversions"
    ADD CONSTRAINT "unique_item_uom_pair" UNIQUE ("item_id", "from_uom", "to_uom");


--
-- Name: journal_entry_items unique_journal_entry_line; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."journal_entry_items"
    ADD CONSTRAINT "unique_journal_entry_line" UNIQUE ("journal_entry_id", "line_number");


--
-- Name: price_list_items unique_price_list_item_tier; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."price_list_items"
    ADD CONSTRAINT "unique_price_list_item_tier" UNIQUE ("price_list_id", "item_id", "min_quantity");


--
-- Name: sales_contract_items unique_sc_line_number; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_contract_items"
    ADD CONSTRAINT "unique_sc_line_number" UNIQUE ("sales_contract_id", "line_number");


--
-- Name: sales_order_items unique_so_line_number; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_order_items"
    ADD CONSTRAINT "unique_so_line_number" UNIQUE ("sales_order_id", "line_number");


--
-- Name: sales_quotation_items unique_sq_line_number; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_quotation_items"
    ADD CONSTRAINT "unique_sq_line_number" UNIQUE ("sales_quotation_id", "line_number");


--
-- Name: uom_conversions uom_conversions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."uom_conversions"
    ADD CONSTRAINT "uom_conversions_pkey" PRIMARY KEY ("id");


--
-- Name: accounting_periods uq_accounting_period; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."accounting_periods"
    ADD CONSTRAINT "uq_accounting_period" UNIQUE ("period_year", "period_month");


--
-- Name: ai_learned_preferences uq_ai_learned_pref_company_field; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_learned_preferences"
    ADD CONSTRAINT "uq_ai_learned_pref_company_field" UNIQUE ("company_id", "field_name");


--
-- Name: company_gl_mappings uq_company_gl_mapping_purpose; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."company_gl_mappings"
    ADD CONSTRAINT "uq_company_gl_mapping_purpose" UNIQUE ("company_id", "purpose");


--
-- Name: exchange_rates uq_exchange_rate; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."exchange_rates"
    ADD CONSTRAINT "uq_exchange_rate" UNIQUE ("from_currency", "to_currency", "rate_date");


--
-- Name: period_close_checklist uq_period_close_checklist; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."period_close_checklist"
    ADD CONSTRAINT "uq_period_close_checklist" UNIQUE ("period_id", "check_key");


--
-- Name: usage_counters usage_counters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_counters"
    ADD CONSTRAINT "usage_counters_pkey" PRIMARY KEY ("company_id", "period_month", "metric");


--
-- Name: user_companies user_companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."user_companies"
    ADD CONSTRAINT "user_companies_pkey" PRIMARY KEY ("user_id", "company_id");


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");


--
-- Name: warehouse_transaction_audit_log warehouse_transaction_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."warehouse_transaction_audit_log"
    ADD CONSTRAINT "warehouse_transaction_audit_log_pkey" PRIMARY KEY ("id");


--
-- Name: warehouse_transaction_items warehouse_transaction_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."warehouse_transaction_items"
    ADD CONSTRAINT "warehouse_transaction_items_pkey" PRIMARY KEY ("id");


--
-- Name: warehouse_transactions warehouse_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."warehouse_transactions"
    ADD CONSTRAINT "warehouse_transactions_pkey" PRIMARY KEY ("id");


--
-- Name: webhook_delivery_log webhook_delivery_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."webhook_delivery_log"
    ADD CONSTRAINT "webhook_delivery_log_pkey" PRIMARY KEY ("id");


--
-- Name: webhook_subscriptions webhook_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."webhook_subscriptions"
    ADD CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id");


--
-- Name: work_centers work_centers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_centers"
    ADD CONSTRAINT "work_centers_pkey" PRIMARY KEY ("id");


--
-- Name: work_order_components work_order_components_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_order_components"
    ADD CONSTRAINT "work_order_components_pkey" PRIMARY KEY ("id");


--
-- Name: work_order_operations work_order_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_order_operations"
    ADD CONSTRAINT "work_order_operations_pkey" PRIMARY KEY ("id");


--
-- Name: work_order_operations work_order_operations_work_order_id_operation_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_order_operations"
    ADD CONSTRAINT "work_order_operations_work_order_id_operation_number_key" UNIQUE ("work_order_id", "operation_number");


--
-- Name: work_order_time_entries work_order_time_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_order_time_entries"
    ADD CONSTRAINT "work_order_time_entries_pkey" PRIMARY KEY ("id");


--
-- Name: work_orders work_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_pkey" PRIMARY KEY ("id");


--
-- Name: agent_blueprints_company_agent_key_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "agent_blueprints_company_agent_key_key" ON "public"."agent_blueprints" USING "btree" ("company_id", "agent_key");


--
-- Name: ai_credentials_company_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ai_credentials_company_name_key" ON "public"."ai_credentials" USING "btree" ("company_id", "name");


--
-- Name: bills_of_material_company_bom_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "bills_of_material_company_bom_number_key" ON "public"."bills_of_material" USING "btree" ("company_id", "bom_number");


--
-- Name: bins_company_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "bins_company_code_key" ON "public"."bins" USING "btree" ("company_id", "code");


--
-- Name: chart_of_accounts_company_account_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "chart_of_accounts_company_account_code_key" ON "public"."chart_of_accounts" USING "btree" ("company_id", "account_code");


--
-- Name: contracts_company_contract_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "contracts_company_contract_number_key" ON "public"."contracts" USING "btree" ("company_id", "contract_number");


--
-- Name: cost_centers_company_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "cost_centers_company_code_key" ON "public"."cost_centers" USING "btree" ("company_id", "code");


--
-- Name: customer_invoices_company_invoice_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "customer_invoices_company_invoice_number_key" ON "public"."customer_invoices" USING "btree" ("company_id", "invoice_number");


--
-- Name: customer_payments_company_payment_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "customer_payments_company_payment_number_key" ON "public"."customer_payments" USING "btree" ("company_id", "payment_number");


--
-- Name: customers_company_customer_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "customers_company_customer_code_key" ON "public"."customers" USING "btree" ("company_id", "customer_code");


--
-- Name: deals_company_deal_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "deals_company_deal_number_key" ON "public"."deals" USING "btree" ("company_id", "deal_number");


--
-- Name: delivery_routes_company_route_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "delivery_routes_company_route_number_key" ON "public"."delivery_routes" USING "btree" ("company_id", "route_number");


--
-- Name: delivery_schedules_company_schedule_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "delivery_schedules_company_schedule_number_key" ON "public"."delivery_schedules" USING "btree" ("company_id", "schedule_number");


--
-- Name: employees_company_employee_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "employees_company_employee_number_key" ON "public"."employees" USING "btree" ("company_id", "employee_number");


--
-- Name: fixed_assets_company_asset_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "fixed_assets_company_asset_number_key" ON "public"."fixed_assets" USING "btree" ("company_id", "asset_number");


--
-- Name: idx_accounting_periods_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_accounting_periods_company" ON "public"."accounting_periods" USING "btree" ("company_id");


--
-- Name: idx_accounting_periods_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_accounting_periods_status" ON "public"."accounting_periods" USING "btree" ("status");


--
-- Name: idx_activities_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_activities_company" ON "public"."activities" USING "btree" ("company_id");


--
-- Name: idx_activities_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_activities_contact" ON "public"."activities" USING "btree" ("contact_id", "created_at" DESC);


--
-- Name: idx_activities_deal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_activities_deal" ON "public"."activities" USING "btree" ("deal_id", "created_at" DESC);


--
-- Name: idx_activities_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_activities_due" ON "public"."activities" USING "btree" ("due_date") WHERE ("completed_at" IS NULL);


--
-- Name: idx_activities_lead; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_activities_lead" ON "public"."activities" USING "btree" ("lead_id") WHERE ("lead_id" IS NOT NULL);


--
-- Name: idx_agent_blueprints_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_agent_blueprints_company" ON "public"."agent_blueprints" USING "btree" ("company_id");


--
-- Name: idx_agent_credentials_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_agent_credentials_company" ON "public"."agent_credentials" USING "btree" ("company_id");


--
-- Name: idx_agent_definitions_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_agent_definitions_company" ON "public"."agent_definitions" USING "btree" ("company_id");


--
-- Name: idx_agent_definitions_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_agent_definitions_due" ON "public"."agent_definitions" USING "btree" ("next_run_at") WHERE ("enabled" = true);


--
-- Name: idx_agent_escalations_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_agent_escalations_company" ON "public"."agent_escalations" USING "btree" ("company_id");


--
-- Name: idx_agent_escalations_dedupe; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "idx_agent_escalations_dedupe" ON "public"."agent_escalations" USING "btree" ("agent_key", "entity_type", "entity_id", "proposed_action") WHERE (("status")::"text" = 'OPEN'::"text");


--
-- Name: idx_agent_escalations_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_agent_escalations_open" ON "public"."agent_escalations" USING "btree" ("status", "created_at" DESC);


--
-- Name: idx_agent_memory_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_agent_memory_agent" ON "public"."agent_memory" USING "btree" ("agent_key", "updated_at" DESC);


--
-- Name: idx_agent_memory_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_agent_memory_company" ON "public"."agent_memory" USING "btree" ("company_id");


--
-- Name: idx_agent_paused_runs_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_agent_paused_runs_company" ON "public"."agent_paused_runs" USING "btree" ("company_id");


--
-- Name: idx_agent_paused_runs_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_agent_paused_runs_expiry" ON "public"."agent_paused_runs" USING "btree" ("expires_at");


--
-- Name: idx_agent_paused_runs_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_agent_paused_runs_user" ON "public"."agent_paused_runs" USING "btree" ("user_id", "created_at" DESC);


--
-- Name: idx_agent_run_actions_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_agent_run_actions_entity" ON "public"."agent_run_actions" USING "btree" ("entity_type", "entity_id");


--
-- Name: idx_agent_run_actions_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_agent_run_actions_run" ON "public"."agent_run_actions" USING "btree" ("run_id", "sequence");


--
-- Name: idx_agent_run_actions_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_agent_run_actions_type" ON "public"."agent_run_actions" USING "btree" ("action_type", "created_at" DESC);


--
-- Name: idx_agent_run_messages_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_agent_run_messages_run" ON "public"."agent_run_messages" USING "btree" ("run_id", "sequence");


--
-- Name: idx_agent_runs_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_agent_runs_agent" ON "public"."agent_runs" USING "btree" ("agent_id", "started_at" DESC);


--
-- Name: idx_agent_runs_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_agent_runs_company" ON "public"."agent_runs" USING "btree" ("company_id");


--
-- Name: idx_agent_runs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_agent_runs_status" ON "public"."agent_runs" USING "btree" ("status", "started_at" DESC);


--
-- Name: idx_ai_audit_log_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_audit_log_company" ON "public"."ai_audit_log" USING "btree" ("company_id");


--
-- Name: idx_ai_audit_log_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_audit_log_created" ON "public"."ai_audit_log" USING "btree" ("created_at" DESC);


--
-- Name: idx_ai_audit_log_tool; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_audit_log_tool" ON "public"."ai_audit_log" USING "btree" ("tool_name");


--
-- Name: idx_ai_audit_log_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_audit_log_user" ON "public"."ai_audit_log" USING "btree" ("user_id");


--
-- Name: idx_ai_credentials_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_credentials_company" ON "public"."ai_credentials" USING "btree" ("company_id");


--
-- Name: idx_ai_feedback_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_feedback_company" ON "public"."ai_feedback" USING "btree" ("company_id");


--
-- Name: idx_ai_feedback_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_feedback_source" ON "public"."ai_feedback" USING "btree" ("source", "created_at" DESC);


--
-- Name: idx_ai_feedback_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_feedback_user" ON "public"."ai_feedback" USING "btree" ("user_id", "created_at" DESC);


--
-- Name: idx_ai_finding_suppressions_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_finding_suppressions_lookup" ON "public"."ai_finding_suppressions" USING "btree" ("company_id", "finding_type", "entity_type", "entity_id");


--
-- Name: idx_ai_findings_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_findings_company" ON "public"."ai_findings" USING "btree" ("company_id");


--
-- Name: idx_ai_findings_dedup_open; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "idx_ai_findings_dedup_open" ON "public"."ai_findings" USING "btree" ("company_id", "finding_type", "entity_type", "entity_id") WHERE (("status")::"text" = 'OPEN'::"text");


--
-- Name: idx_ai_findings_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_findings_status" ON "public"."ai_findings" USING "btree" ("status");


--
-- Name: idx_ai_findings_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_findings_type" ON "public"."ai_findings" USING "btree" ("finding_type");


--
-- Name: idx_ai_learned_pref_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_learned_pref_company" ON "public"."ai_learned_preferences" USING "btree" ("company_id");


--
-- Name: idx_ai_tool_settings_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_tool_settings_company" ON "public"."ai_tool_settings" USING "btree" ("company_id");


--
-- Name: idx_ai_tool_versions_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_tool_versions_company" ON "public"."ai_tool_versions" USING "btree" ("company_id");


--
-- Name: idx_ai_tools_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_tools_company" ON "public"."ai_tools" USING "btree" ("company_id");


--
-- Name: idx_ai_tools_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_tools_enabled" ON "public"."ai_tools" USING "btree" ("enabled", "name");


--
-- Name: idx_ai_usage_log_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_usage_log_created_at" ON "public"."ai_usage_log" USING "btree" ("created_at");


--
-- Name: idx_ai_usage_log_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_usage_log_user_created" ON "public"."ai_usage_log" USING "btree" ("user_id", "created_at");


--
-- Name: idx_api_keys_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_api_keys_company" ON "public"."api_keys" USING "btree" ("company_id");


--
-- Name: idx_api_keys_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "idx_api_keys_hash" ON "public"."api_keys" USING "btree" ("key_hash");


--
-- Name: idx_api_keys_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_api_keys_status" ON "public"."api_keys" USING "btree" ("status");


--
-- Name: idx_approval_chain_templates_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_approval_chain_templates_company" ON "public"."approval_chain_templates" USING "btree" ("company_id");


--
-- Name: idx_approval_delegations_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_approval_delegations_active" ON "public"."approval_delegations" USING "btree" ("status", "start_date", "end_date") WHERE (("status")::"text" = 'ACTIVE'::"text");


--
-- Name: idx_approval_delegations_delegator; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_approval_delegations_delegator" ON "public"."approval_delegations" USING "btree" ("delegator_id");


--
-- Name: idx_approval_request_steps_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_approval_request_steps_pending" ON "public"."approval_request_steps" USING "btree" ("approver_role", "status") WHERE (("status")::"text" = 'PENDING'::"text");


--
-- Name: idx_approval_requests_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_approval_requests_company" ON "public"."approval_requests" USING "btree" ("company_id");


--
-- Name: idx_approval_requests_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_approval_requests_document" ON "public"."approval_requests" USING "btree" ("document_type", "document_id");


--
-- Name: idx_approval_requests_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_approval_requests_status" ON "public"."approval_requests" USING "btree" ("status");


--
-- Name: idx_asset_revaluations_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_asset_revaluations_asset" ON "public"."fixed_asset_revaluations" USING "btree" ("asset_id", "revaluation_date" DESC);


--
-- Name: idx_attendance_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_attendance_employee" ON "public"."attendance_records" USING "btree" ("employee_id", "record_date");


--
-- Name: idx_audit_chain_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_audit_chain_entity" ON "public"."audit_chain" USING "btree" ("entity_type", "entity_id");


--
-- Name: idx_audit_chain_occurred; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_audit_chain_occurred" ON "public"."audit_chain" USING "btree" ("occurred_at");


--
-- Name: idx_auto_purchase_orders_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_auto_purchase_orders_company" ON "public"."auto_purchase_orders" USING "btree" ("company_id");


--
-- Name: idx_auto_purchase_orders_delivery_schedule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_auto_purchase_orders_delivery_schedule" ON "public"."auto_purchase_orders" USING "btree" ("delivery_schedule_id");


--
-- Name: idx_auto_purchase_orders_sales_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_auto_purchase_orders_sales_order" ON "public"."auto_purchase_orders" USING "btree" ("sales_order_id");


--
-- Name: idx_auto_purchase_orders_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_auto_purchase_orders_supplier" ON "public"."auto_purchase_orders" USING "btree" ("supplier_id");


--
-- Name: idx_background_tasks_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_background_tasks_company" ON "public"."background_tasks" USING "btree" ("company_id");


--
-- Name: idx_background_tasks_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_background_tasks_session" ON "public"."background_tasks" USING "btree" ("session_id", "created_at" DESC);


--
-- Name: idx_background_tasks_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_background_tasks_status" ON "public"."background_tasks" USING "btree" ("status");


--
-- Name: idx_bank_accounts_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bank_accounts_company" ON "public"."bank_accounts" USING "btree" ("company_id");


--
-- Name: idx_bank_accounts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bank_accounts_status" ON "public"."bank_accounts" USING "btree" ("status");


--
-- Name: idx_bank_transactions_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bank_transactions_account" ON "public"."bank_transactions" USING "btree" ("bank_account_id");


--
-- Name: idx_bank_transactions_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bank_transactions_company" ON "public"."bank_transactions" USING "btree" ("company_id");


--
-- Name: idx_bank_transactions_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bank_transactions_date" ON "public"."bank_transactions" USING "btree" ("transaction_date");


--
-- Name: idx_bank_transactions_reconciled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bank_transactions_reconciled" ON "public"."bank_transactions" USING "btree" ("is_reconciled");


--
-- Name: idx_bills_of_material_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bills_of_material_company" ON "public"."bills_of_material" USING "btree" ("company_id");


--
-- Name: idx_bins_approved_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bins_approved_by" ON "public"."bins" USING "btree" ("approved_by");


--
-- Name: idx_bins_capacity_volume; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bins_capacity_volume" ON "public"."bins" USING "btree" ("max_volume_capacity");


--
-- Name: idx_bins_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bins_code" ON "public"."bins" USING "btree" ("code");


--
-- Name: idx_bins_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bins_company" ON "public"."bins" USING "btree" ("company_id");


--
-- Name: idx_bins_is_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bins_is_active" ON "public"."bins" USING "btree" ("is_active");


--
-- Name: idx_bins_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bins_status" ON "public"."bins" USING "btree" ("status");


--
-- Name: idx_bins_storage_location_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bins_storage_location_id" ON "public"."bins" USING "btree" ("storage_location_id");


--
-- Name: idx_bins_storage_location_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bins_storage_location_status" ON "public"."bins" USING "btree" ("storage_location_id", "status");


--
-- Name: idx_bins_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bins_user_id" ON "public"."bins" USING "btree" ("user_id");


--
-- Name: idx_bom_components_bom; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bom_components_bom" ON "public"."bom_components" USING "btree" ("bom_id", "line_number");


--
-- Name: idx_bom_components_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bom_components_item" ON "public"."bom_components" USING "btree" ("component_item_id");


--
-- Name: idx_bom_one_active_per_item; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "idx_bom_one_active_per_item" ON "public"."bills_of_material" USING "btree" ("item_id") WHERE ((("status")::"text" = 'ACTIVE'::"text") AND ("deleted_at" IS NULL));


--
-- Name: idx_bom_operations_bom; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bom_operations_bom" ON "public"."bom_operations" USING "btree" ("bom_id", "operation_number");


--
-- Name: idx_bom_operations_wc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bom_operations_wc" ON "public"."bom_operations" USING "btree" ("work_center_id");


--
-- Name: idx_budget_lines_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_budget_lines_account" ON "public"."budget_lines" USING "btree" ("account_id");


--
-- Name: idx_budget_lines_budget; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_budget_lines_budget" ON "public"."budget_lines" USING "btree" ("budget_id");


--
-- Name: idx_budgets_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_budgets_company" ON "public"."budgets" USING "btree" ("company_id");


--
-- Name: idx_budgets_year; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_budgets_year" ON "public"."budgets" USING "btree" ("fiscal_year");


--
-- Name: idx_chart_of_accounts_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_chart_of_accounts_active" ON "public"."chart_of_accounts" USING "btree" ("is_active");


--
-- Name: idx_chart_of_accounts_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_chart_of_accounts_code" ON "public"."chart_of_accounts" USING "btree" ("account_code");


--
-- Name: idx_chart_of_accounts_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_chart_of_accounts_company" ON "public"."chart_of_accounts" USING "btree" ("company_id");


--
-- Name: idx_chart_of_accounts_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_chart_of_accounts_created_by" ON "public"."chart_of_accounts" USING "btree" ("created_by");


--
-- Name: idx_chart_of_accounts_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_chart_of_accounts_deleted_at" ON "public"."chart_of_accounts" USING "btree" ("deleted_at");


--
-- Name: idx_chart_of_accounts_level; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_chart_of_accounts_level" ON "public"."chart_of_accounts" USING "btree" ("account_level");


--
-- Name: idx_chart_of_accounts_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_chart_of_accounts_parent" ON "public"."chart_of_accounts" USING "btree" ("parent_account_id");


--
-- Name: idx_chart_of_accounts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_chart_of_accounts_status" ON "public"."chart_of_accounts" USING "btree" ("status");


--
-- Name: idx_chart_of_accounts_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_chart_of_accounts_type" ON "public"."chart_of_accounts" USING "btree" ("account_type");


--
-- Name: idx_chart_status_history_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_chart_status_history_account" ON "public"."chart_of_accounts_status_history" USING "btree" ("account_id");


--
-- Name: idx_chart_status_history_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_chart_status_history_date" ON "public"."chart_of_accounts_status_history" USING "btree" ("status_date");


--
-- Name: idx_chat_memory_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_chat_memory_company" ON "public"."chat_memory" USING "btree" ("company_id");


--
-- Name: idx_chat_memory_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_chat_memory_created_at" ON "public"."chat_memory" USING "btree" ("created_at");


--
-- Name: idx_chat_memory_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_chat_memory_deleted_at" ON "public"."chat_memory" USING "btree" ("deleted_at");


--
-- Name: idx_chat_memory_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_chat_memory_user_id" ON "public"."chat_memory" USING "btree" ("user_id");


--
-- Name: idx_cm_conversation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_cm_conversation" ON "public"."conversation_messages" USING "btree" ("conversation_id", "created_at");


--
-- Name: idx_companies_one_default; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "idx_companies_one_default" ON "public"."companies" USING "btree" ("is_default") WHERE ("is_default" = true);


--
-- Name: idx_company_modules_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_company_modules_company" ON "public"."company_modules" USING "btree" ("company_id");


--
-- Name: idx_connectors_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_connectors_company" ON "public"."connectors" USING "btree" ("company_id");


--
-- Name: idx_connectors_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_connectors_provider" ON "public"."connectors" USING "btree" ("provider");


--
-- Name: idx_connectors_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_connectors_status" ON "public"."connectors" USING "btree" ("status");


--
-- Name: idx_contacts_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contacts_company" ON "public"."contacts" USING "btree" ("company_id");


--
-- Name: idx_contacts_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contacts_customer" ON "public"."contacts" USING "btree" ("customer_id") WHERE ("deleted_at" IS NULL);


--
-- Name: idx_contacts_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contacts_email" ON "public"."contacts" USING "btree" ("lower"(("email")::"text")) WHERE (("email" IS NOT NULL) AND ("deleted_at" IS NULL));


--
-- Name: idx_contacts_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contacts_owner" ON "public"."contacts" USING "btree" ("owner_id") WHERE ("deleted_at" IS NULL);


--
-- Name: idx_contract_items_contract_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contract_items_contract_id" ON "public"."contract_items" USING "btree" ("contract_id");


--
-- Name: idx_contract_items_item_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contract_items_item_id" ON "public"."contract_items" USING "btree" ("item_id");


--
-- Name: idx_contracts_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contracts_company" ON "public"."contracts" USING "btree" ("company_id");


--
-- Name: idx_contracts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contracts_status" ON "public"."contracts" USING "btree" ("status");


--
-- Name: idx_contracts_status_sent_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contracts_status_sent_supplier" ON "public"."contracts" USING "btree" ("status", "sent_to_supplier_at");


--
-- Name: idx_contracts_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contracts_supplier" ON "public"."contracts" USING "btree" ("supplier_id");


--
-- Name: idx_contracts_supplier_response_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contracts_supplier_response_due" ON "public"."contracts" USING "btree" ("supplier_response_due");


--
-- Name: idx_contracts_supplier_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contracts_supplier_token" ON "public"."contracts" USING "btree" ("supplier_response_token");


--
-- Name: idx_conversations_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_conversations_user" ON "public"."conversations" USING "btree" ("user_id", "updated_at" DESC);


--
-- Name: idx_cost_centers_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_cost_centers_company" ON "public"."cost_centers" USING "btree" ("company_id");


--
-- Name: idx_cost_centers_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_cost_centers_status" ON "public"."cost_centers" USING "btree" ("status");


--
-- Name: idx_cost_layers_inv_item_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_cost_layers_inv_item_created" ON "public"."cost_layers" USING "btree" ("inventory_item_id", "created_at") WHERE ("remaining_quantity" > (0)::numeric);


--
-- Name: idx_cost_layers_receipt; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_cost_layers_receipt" ON "public"."cost_layers" USING "btree" ("receipt_id");


--
-- Name: idx_cost_layers_warehouse_txn; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_cost_layers_warehouse_txn" ON "public"."cost_layers" USING "btree" ("warehouse_transaction_id");


--
-- Name: idx_customer_audit_log_changed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customer_audit_log_changed_at" ON "public"."customer_audit_log" USING "btree" ("changed_at");


--
-- Name: idx_customer_audit_log_customer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customer_audit_log_customer_id" ON "public"."customer_audit_log" USING "btree" ("customer_id");


--
-- Name: idx_customer_invoice_items_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customer_invoice_items_invoice" ON "public"."customer_invoice_items" USING "btree" ("invoice_id");


--
-- Name: idx_customer_invoices_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customer_invoices_company" ON "public"."customer_invoices" USING "btree" ("company_id");


--
-- Name: idx_customer_invoices_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customer_invoices_customer" ON "public"."customer_invoices" USING "btree" ("customer_id");


--
-- Name: idx_customer_invoices_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customer_invoices_deleted_at" ON "public"."customer_invoices" USING "btree" ("deleted_at");


--
-- Name: idx_customer_invoices_due_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customer_invoices_due_date" ON "public"."customer_invoices" USING "btree" ("due_date");


--
-- Name: idx_customer_invoices_dupe_scan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customer_invoices_dupe_scan" ON "public"."customer_invoices" USING "btree" ("customer_id", "total_amount", "invoice_date") WHERE ("deleted_at" IS NULL);


--
-- Name: idx_customer_invoices_journal_entry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customer_invoices_journal_entry" ON "public"."customer_invoices" USING "btree" ("journal_entry_id");


--
-- Name: idx_customer_invoices_sales_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customer_invoices_sales_order" ON "public"."customer_invoices" USING "btree" ("sales_order_id");


--
-- Name: idx_customer_invoices_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customer_invoices_status" ON "public"."customer_invoices" USING "btree" ("status");


--
-- Name: idx_customer_payments_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customer_payments_company" ON "public"."customer_payments" USING "btree" ("company_id");


--
-- Name: idx_customer_payments_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customer_payments_customer" ON "public"."customer_payments" USING "btree" ("customer_id");


--
-- Name: idx_customer_payments_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customer_payments_date" ON "public"."customer_payments" USING "btree" ("payment_date");


--
-- Name: idx_customer_payments_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customer_payments_deleted_at" ON "public"."customer_payments" USING "btree" ("deleted_at");


--
-- Name: idx_customer_payments_journal_entry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customer_payments_journal_entry" ON "public"."customer_payments" USING "btree" ("journal_entry_id");


--
-- Name: idx_customer_payments_method; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customer_payments_method" ON "public"."customer_payments" USING "btree" ("payment_method");


--
-- Name: idx_customer_payments_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customer_payments_status" ON "public"."customer_payments" USING "btree" ("status");


--
-- Name: idx_customers_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customers_company" ON "public"."customers" USING "btree" ("company_id");


--
-- Name: idx_customers_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customers_created_by" ON "public"."customers" USING "btree" ("created_by");


--
-- Name: idx_customers_credit_risk; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customers_credit_risk" ON "public"."customers" USING "btree" ("credit_risk_level");


--
-- Name: idx_customers_customer_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customers_customer_code" ON "public"."customers" USING "btree" ("customer_code");


--
-- Name: idx_customers_customer_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customers_customer_name" ON "public"."customers" USING "btree" ("customer_name");


--
-- Name: idx_customers_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customers_deleted_at" ON "public"."customers" USING "btree" ("deleted_at");


--
-- Name: idx_customers_legal_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customers_legal_name_trgm" ON "public"."customers" USING "gin" ("legal_entity_name" "public"."gin_trgm_ops");


--
-- Name: idx_customers_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customers_name_trgm" ON "public"."customers" USING "gin" ("customer_name" "public"."gin_trgm_ops");


--
-- Name: idx_customers_sales_rep; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customers_sales_rep" ON "public"."customers" USING "btree" ("sales_rep_id");


--
-- Name: idx_customers_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_customers_status" ON "public"."customers" USING "btree" ("status");


--
-- Name: idx_dashboard_widgets_dashboard; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_dashboard_widgets_dashboard" ON "public"."dashboard_widgets" USING "btree" ("dashboard_id");


--
-- Name: idx_deals_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_deals_company" ON "public"."deals" USING "btree" ("company_id");


--
-- Name: idx_deals_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_deals_customer" ON "public"."deals" USING "btree" ("customer_id") WHERE ("deleted_at" IS NULL);


--
-- Name: idx_deals_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_deals_open" ON "public"."deals" USING "btree" ("stage", "expected_close_date") WHERE (("deleted_at" IS NULL) AND (("stage")::"text" <> ALL (ARRAY[('WON'::character varying)::"text", ('LOST'::character varying)::"text"])));


--
-- Name: idx_deals_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_deals_owner" ON "public"."deals" USING "btree" ("owner_id") WHERE ("deleted_at" IS NULL);


--
-- Name: idx_delegation_of_authority_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_delegation_of_authority_company" ON "public"."delegation_of_authority" USING "btree" ("company_id");


--
-- Name: idx_delivery_exceptions_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_delivery_exceptions_date" ON "public"."delivery_exceptions" USING "btree" ("exception_date");


--
-- Name: idx_delivery_exceptions_schedule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_delivery_exceptions_schedule" ON "public"."delivery_exceptions" USING "btree" ("delivery_schedule_id");


--
-- Name: idx_delivery_exceptions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_delivery_exceptions_status" ON "public"."delivery_exceptions" USING "btree" ("status");


--
-- Name: idx_delivery_exceptions_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_delivery_exceptions_type" ON "public"."delivery_exceptions" USING "btree" ("exception_type");


--
-- Name: idx_delivery_items_sales_order_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_delivery_items_sales_order_item" ON "public"."delivery_items" USING "btree" ("sales_order_item_id");


--
-- Name: idx_delivery_items_schedule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_delivery_items_schedule" ON "public"."delivery_items" USING "btree" ("delivery_schedule_id");


--
-- Name: idx_delivery_items_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_delivery_items_status" ON "public"."delivery_items" USING "btree" ("status");


--
-- Name: idx_delivery_route_stops_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_delivery_route_stops_order" ON "public"."delivery_route_stops" USING "btree" ("delivery_route_id", "stop_order");


--
-- Name: idx_delivery_route_stops_route; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_delivery_route_stops_route" ON "public"."delivery_route_stops" USING "btree" ("delivery_route_id");


--
-- Name: idx_delivery_route_stops_schedule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_delivery_route_stops_schedule" ON "public"."delivery_route_stops" USING "btree" ("delivery_schedule_id");


--
-- Name: idx_delivery_routes_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_delivery_routes_company" ON "public"."delivery_routes" USING "btree" ("company_id");


--
-- Name: idx_delivery_routes_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_delivery_routes_date" ON "public"."delivery_routes" USING "btree" ("route_date");


--
-- Name: idx_delivery_routes_driver; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_delivery_routes_driver" ON "public"."delivery_routes" USING "btree" ("driver_name");


--
-- Name: idx_delivery_routes_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_delivery_routes_status" ON "public"."delivery_routes" USING "btree" ("status");


--
-- Name: idx_delivery_schedules_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_delivery_schedules_company" ON "public"."delivery_schedules" USING "btree" ("company_id");


--
-- Name: idx_delivery_schedules_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_delivery_schedules_created_by" ON "public"."delivery_schedules" USING "btree" ("created_by");


--
-- Name: idx_delivery_schedules_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_delivery_schedules_customer" ON "public"."delivery_schedules" USING "btree" ("customer_id");


--
-- Name: idx_delivery_schedules_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_delivery_schedules_date" ON "public"."delivery_schedules" USING "btree" ("delivery_date");


--
-- Name: idx_delivery_schedules_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_delivery_schedules_deleted_at" ON "public"."delivery_schedules" USING "btree" ("deleted_at");


--
-- Name: idx_delivery_schedules_sales_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_delivery_schedules_sales_order" ON "public"."delivery_schedules" USING "btree" ("sales_order_id");


--
-- Name: idx_delivery_schedules_schedule_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_delivery_schedules_schedule_number" ON "public"."delivery_schedules" USING "btree" ("schedule_number");


--
-- Name: idx_delivery_schedules_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_delivery_schedules_status" ON "public"."delivery_schedules" USING "btree" ("status");


--
-- Name: idx_delivery_schedules_tracking; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_delivery_schedules_tracking" ON "public"."delivery_schedules" USING "btree" ("tracking_number");


--
-- Name: idx_delivery_status_history_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_delivery_status_history_date" ON "public"."delivery_status_history" USING "btree" ("status_date");


--
-- Name: idx_delivery_status_history_schedule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_delivery_status_history_schedule" ON "public"."delivery_status_history" USING "btree" ("delivery_schedule_id");


--
-- Name: idx_document_embeddings_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_document_embeddings_company" ON "public"."document_embeddings" USING "btree" ("company_id");


--
-- Name: idx_document_embeddings_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_document_embeddings_source" ON "public"."document_embeddings" USING "btree" ("source_type", "source_id");


--
-- Name: idx_document_embeddings_vector; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_document_embeddings_vector" ON "public"."document_embeddings" USING "hnsw" ("embedding" "public"."vector_cosine_ops");


--
-- Name: idx_dofa_cost_center; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_dofa_cost_center" ON "public"."delegation_of_authority" USING "btree" ("cost_center");


--
-- Name: idx_dofa_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_dofa_user" ON "public"."delegation_of_authority" USING "btree" ("user_id");


--
-- Name: idx_email_verification_tokens_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_email_verification_tokens_hash" ON "public"."email_verification_tokens" USING "btree" ("token_hash");


--
-- Name: idx_employees_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_employees_company" ON "public"."employees" USING "btree" ("company_id");


--
-- Name: idx_employees_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_employees_status" ON "public"."employees" USING "btree" ("status");


--
-- Name: idx_employees_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "idx_employees_user" ON "public"."employees" USING "btree" ("user_id") WHERE (("user_id" IS NOT NULL) AND ("deleted_at" IS NULL));


--
-- Name: idx_exchange_rates_pair; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_exchange_rates_pair" ON "public"."exchange_rates" USING "btree" ("from_currency", "to_currency", "rate_date" DESC);


--
-- Name: idx_fa_depreciation_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_fa_depreciation_asset" ON "public"."fixed_asset_depreciation" USING "btree" ("asset_id");


--
-- Name: idx_fixed_assets_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_fixed_assets_category" ON "public"."fixed_assets" USING "btree" ("category");


--
-- Name: idx_fixed_assets_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_fixed_assets_company" ON "public"."fixed_assets" USING "btree" ("company_id");


--
-- Name: idx_fixed_assets_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_fixed_assets_deleted_at" ON "public"."fixed_assets" USING "btree" ("deleted_at");


--
-- Name: idx_fixed_assets_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_fixed_assets_status" ON "public"."fixed_assets" USING "btree" ("status");


--
-- Name: idx_generated_documents_creator; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_generated_documents_creator" ON "public"."generated_documents" USING "btree" ("created_by", "created_at" DESC);


--
-- Name: idx_generated_documents_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_generated_documents_run" ON "public"."generated_documents" USING "btree" ("agent_run_id");


--
-- Name: idx_goods_receipts_bin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_goods_receipts_bin" ON "public"."goods_receipts" USING "btree" ("bin_id");


--
-- Name: idx_goods_receipts_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_goods_receipts_company" ON "public"."goods_receipts" USING "btree" ("company_id");


--
-- Name: idx_goods_receipts_line_item_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_goods_receipts_line_item_id" ON "public"."goods_receipts" USING "btree" ("po_line_item_id");


--
-- Name: idx_goods_receipts_po_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_goods_receipts_po_id" ON "public"."goods_receipts" USING "btree" ("po_id");


--
-- Name: idx_goods_receipts_received_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_goods_receipts_received_by" ON "public"."goods_receipts" USING "btree" ("received_by");


--
-- Name: idx_goods_receipts_received_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_goods_receipts_received_date" ON "public"."goods_receipts" USING "btree" ("received_date");


--
-- Name: idx_goods_receipts_storage_location; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_goods_receipts_storage_location" ON "public"."goods_receipts" USING "btree" ("storage_location_id");


--
-- Name: idx_intercompany_from; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_intercompany_from" ON "public"."intercompany_transactions" USING "btree" ("from_company_id", "transaction_date");


--
-- Name: idx_intercompany_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_intercompany_open" ON "public"."intercompany_transactions" USING "btree" ("status") WHERE (("status")::"text" = 'POSTED'::"text");


--
-- Name: idx_intercompany_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_intercompany_to" ON "public"."intercompany_transactions" USING "btree" ("to_company_id", "transaction_date");


--
-- Name: idx_inventory_items_approved_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_inventory_items_approved_by" ON "public"."inventory_items" USING "btree" ("approved_by");


--
-- Name: idx_inventory_items_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_inventory_items_company" ON "public"."inventory_items" USING "btree" ("company_id");


--
-- Name: idx_inventory_items_condition_grade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_inventory_items_condition_grade" ON "public"."inventory_items" USING "btree" ("condition_grade");


--
-- Name: idx_inventory_items_current_stock; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_inventory_items_current_stock" ON "public"."inventory_items" USING "btree" ("current_stock_quantity");


--
-- Name: idx_inventory_items_embedding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_inventory_items_embedding" ON "public"."inventory_items" USING "hnsw" ("embedding" "public"."vector_cosine_ops");


--
-- Name: idx_inventory_items_item_master_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_inventory_items_item_master_id" ON "public"."inventory_items" USING "btree" ("item_master_id");


--
-- Name: idx_inventory_items_reorder_point; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_inventory_items_reorder_point" ON "public"."inventory_items" USING "btree" ("reorder_point");


--
-- Name: idx_inventory_items_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_inventory_items_status" ON "public"."inventory_items" USING "btree" ("status");


--
-- Name: idx_inventory_items_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_inventory_items_user_id" ON "public"."inventory_items" USING "btree" ("user_id");


--
-- Name: idx_inventory_storage_mappings_bin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_inventory_storage_mappings_bin_id" ON "public"."inventory_storage_mappings" USING "btree" ("bin_id");


--
-- Name: idx_inventory_storage_mappings_inventory_item_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_inventory_storage_mappings_inventory_item_id" ON "public"."inventory_storage_mappings" USING "btree" ("inventory_item_id");


--
-- Name: idx_inventory_storage_mappings_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_inventory_storage_mappings_status" ON "public"."inventory_storage_mappings" USING "btree" ("status");


--
-- Name: idx_inventory_storage_mappings_storage_location_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_inventory_storage_mappings_storage_location_id" ON "public"."inventory_storage_mappings" USING "btree" ("storage_location_id");


--
-- Name: idx_inventory_storage_mappings_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_inventory_storage_mappings_user_id" ON "public"."inventory_storage_mappings" USING "btree" ("user_id");


--
-- Name: idx_inventory_transfers_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_inventory_transfers_company" ON "public"."inventory_transfers" USING "btree" ("company_id");


--
-- Name: idx_inventory_transfers_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_inventory_transfers_item" ON "public"."inventory_transfers" USING "btree" ("inventory_item_id");


--
-- Name: idx_inventory_transfers_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_inventory_transfers_status" ON "public"."inventory_transfers" USING "btree" ("status");


--
-- Name: idx_invoice_status_history_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_invoice_status_history_date" ON "public"."customer_invoice_status_history" USING "btree" ("status_date");


--
-- Name: idx_invoice_status_history_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_invoice_status_history_invoice" ON "public"."customer_invoice_status_history" USING "btree" ("invoice_id");


--
-- Name: idx_items_approved_item_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_items_approved_item_code" ON "public"."items" USING "btree" ("approved_item_code") WHERE ("approved_item_code" IS NOT NULL);


--
-- Name: idx_items_barcode; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_items_barcode" ON "public"."items" USING "btree" ("barcode");


--
-- Name: idx_items_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_items_company" ON "public"."items" USING "btree" ("company_id");


--
-- Name: idx_items_contract_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_items_contract_number" ON "public"."items" USING "btree" ("contract_number");


--
-- Name: idx_items_criticality; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_items_criticality" ON "public"."items" USING "btree" ("criticality");


--
-- Name: idx_items_decline_reason; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_items_decline_reason" ON "public"."items" USING "btree" ("decline_reason") WHERE ("decline_reason" IS NOT NULL);


--
-- Name: idx_items_equipment_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_items_equipment_tag" ON "public"."items" USING "btree" ("equipment_tag");


--
-- Name: idx_items_is_stock_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_items_is_stock_item" ON "public"."items" USING "btree" ("is_stock_item");


--
-- Name: idx_items_item_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_items_item_category" ON "public"."items" USING "btree" ("item_category");


--
-- Name: idx_items_item_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_items_item_code" ON "public"."items" USING "btree" ("item_code");


--
-- Name: idx_items_manufacturer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_items_manufacturer" ON "public"."items" USING "btree" ("manufacturer");


--
-- Name: idx_items_manufacturer_part_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_items_manufacturer_part_number" ON "public"."items" USING "btree" ("manufacturer_part_number");


--
-- Name: idx_items_mass; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_items_mass" ON "public"."items" USING "btree" ("mass");


--
-- Name: idx_items_mass_per_uom; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_items_mass_per_uom" ON "public"."items" USING "btree" ("mass_per_uom");


--
-- Name: idx_items_planned_stock; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_items_planned_stock" ON "public"."items" USING "btree" ("planned_stock");


--
-- Name: idx_items_serial_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_items_serial_number" ON "public"."items" USING "btree" ("serial_number");


--
-- Name: idx_items_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_items_status" ON "public"."items" USING "btree" ("status");


--
-- Name: idx_items_stock_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_items_stock_code" ON "public"."items" USING "btree" ("stock_code");


--
-- Name: idx_items_unspsc_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_items_unspsc_code" ON "public"."items" USING "btree" ("unspsc_code");


--
-- Name: idx_items_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_items_user_id" ON "public"."items" USING "btree" ("user_id");


--
-- Name: idx_items_volume; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_items_volume" ON "public"."items" USING "btree" ("volume");


--
-- Name: idx_items_volume_per_uom; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_items_volume_per_uom" ON "public"."items" USING "btree" ("volume_per_uom");


--
-- Name: idx_journal_entries_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_journal_entries_batch" ON "public"."journal_entries" USING "btree" ("batch_id");


--
-- Name: idx_journal_entries_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_journal_entries_company" ON "public"."journal_entries" USING "btree" ("company_id");


--
-- Name: idx_journal_entries_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_journal_entries_created_by" ON "public"."journal_entries" USING "btree" ("created_by");


--
-- Name: idx_journal_entries_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_journal_entries_date" ON "public"."journal_entries" USING "btree" ("entry_date");


--
-- Name: idx_journal_entries_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_journal_entries_deleted_at" ON "public"."journal_entries" USING "btree" ("deleted_at");


--
-- Name: idx_journal_entries_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_journal_entries_number" ON "public"."journal_entries" USING "btree" ("journal_number");


--
-- Name: idx_journal_entries_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_journal_entries_period" ON "public"."journal_entries" USING "btree" ("period_year", "period_month");


--
-- Name: idx_journal_entries_posting_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_journal_entries_posting_date" ON "public"."journal_entries" USING "btree" ("posting_date");


--
-- Name: idx_journal_entries_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_journal_entries_source" ON "public"."journal_entries" USING "btree" ("source_type", "source_id");


--
-- Name: idx_journal_entries_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_journal_entries_status" ON "public"."journal_entries" USING "btree" ("status");


--
-- Name: idx_journal_entry_items_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_journal_entry_items_account" ON "public"."journal_entry_items" USING "btree" ("account_id");


--
-- Name: idx_journal_entry_items_cost_center; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_journal_entry_items_cost_center" ON "public"."journal_entry_items" USING "btree" ("cost_center_id");


--
-- Name: idx_journal_entry_items_department; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_journal_entry_items_department" ON "public"."journal_entry_items" USING "btree" ("department_id");


--
-- Name: idx_journal_entry_items_entry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_journal_entry_items_entry" ON "public"."journal_entry_items" USING "btree" ("journal_entry_id");


--
-- Name: idx_journal_entry_items_line; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_journal_entry_items_line" ON "public"."journal_entry_items" USING "btree" ("journal_entry_id", "line_number");


--
-- Name: idx_journal_entry_items_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_journal_entry_items_project" ON "public"."journal_entry_items" USING "btree" ("project_id");


--
-- Name: idx_journal_status_history_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_journal_status_history_date" ON "public"."journal_entry_status_history" USING "btree" ("status_date");


--
-- Name: idx_journal_status_history_entry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_journal_status_history_entry" ON "public"."journal_entry_status_history" USING "btree" ("journal_entry_id");


--
-- Name: idx_kb_documents_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_kb_documents_company" ON "public"."kb_documents" USING "btree" ("company_id");


--
-- Name: idx_kb_documents_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_kb_documents_status" ON "public"."kb_documents" USING "btree" ("status");


--
-- Name: idx_landed_cost_vouchers_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_landed_cost_vouchers_company" ON "public"."landed_cost_vouchers" USING "btree" ("company_id");


--
-- Name: idx_landed_cost_vouchers_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_landed_cost_vouchers_status" ON "public"."landed_cost_vouchers" USING "btree" ("status");


--
-- Name: idx_leads_assigned; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_leads_assigned" ON "public"."leads" USING "btree" ("assigned_to") WHERE ("deleted_at" IS NULL);


--
-- Name: idx_leads_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_leads_company" ON "public"."leads" USING "btree" ("company_id");


--
-- Name: idx_leads_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_leads_status" ON "public"."leads" USING "btree" ("status") WHERE ("deleted_at" IS NULL);


--
-- Name: idx_leave_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_leave_employee" ON "public"."leave_requests" USING "btree" ("employee_id", "start_date");


--
-- Name: idx_leave_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_leave_status" ON "public"."leave_requests" USING "btree" ("status") WHERE ("deleted_at" IS NULL);


--
-- Name: idx_loan_schedules_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_loan_schedules_due" ON "public"."loan_schedules" USING "btree" ("next_payment_date") WHERE ((("status")::"text" = 'ACTIVE'::"text") AND ("deleted_at" IS NULL));


--
-- Name: idx_mcp_connections_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_mcp_connections_company" ON "public"."mcp_connections" USING "btree" ("company_id");


--
-- Name: idx_mcp_connections_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_mcp_connections_status" ON "public"."mcp_connections" USING "btree" ("status");


--
-- Name: idx_mcp_oauth_grants_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_mcp_oauth_grants_company" ON "public"."mcp_oauth_grants" USING "btree" ("company_id");


--
-- Name: idx_mrp_planned_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_mrp_planned_open" ON "public"."mrp_planned_orders" USING "btree" ("status", "required_by");


--
-- Name: idx_mrp_planned_orders_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_mrp_planned_orders_company" ON "public"."mrp_planned_orders" USING "btree" ("company_id");


--
-- Name: idx_mrp_planned_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_mrp_planned_run" ON "public"."mrp_planned_orders" USING "btree" ("run_id", "bom_level");


--
-- Name: idx_notifications_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_notifications_company" ON "public"."notifications" USING "btree" ("company_id");


--
-- Name: idx_notifications_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_notifications_created_at" ON "public"."notifications" USING "btree" ("created_at" DESC);


--
-- Name: idx_notifications_is_read; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_notifications_is_read" ON "public"."notifications" USING "btree" ("is_read");


--
-- Name: idx_notifications_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_notifications_type" ON "public"."notifications" USING "btree" ("type");


--
-- Name: idx_notifications_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_notifications_user_id" ON "public"."notifications" USING "btree" ("user_id");


--
-- Name: idx_password_reset_tokens_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_password_reset_tokens_expires_at" ON "public"."password_reset_tokens" USING "btree" ("expires_at");


--
-- Name: idx_password_reset_tokens_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_password_reset_tokens_token_hash" ON "public"."password_reset_tokens" USING "btree" ("token_hash");


--
-- Name: idx_password_reset_tokens_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_password_reset_tokens_user_id" ON "public"."password_reset_tokens" USING "btree" ("user_id");


--
-- Name: idx_payment_allocations_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_payment_allocations_invoice" ON "public"."customer_payment_allocations" USING "btree" ("invoice_id");


--
-- Name: idx_payment_allocations_payment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_payment_allocations_payment" ON "public"."customer_payment_allocations" USING "btree" ("payment_id");


--
-- Name: idx_payment_status_history_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_payment_status_history_date" ON "public"."customer_payment_status_history" USING "btree" ("status_date");


--
-- Name: idx_payment_status_history_payment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_payment_status_history_payment" ON "public"."customer_payment_status_history" USING "btree" ("payment_id");


--
-- Name: idx_payroll_items_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_payroll_items_run" ON "public"."payroll_items" USING "btree" ("payroll_run_id");


--
-- Name: idx_payroll_runs_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_payroll_runs_company" ON "public"."payroll_runs" USING "btree" ("company_id");


--
-- Name: idx_payroll_runs_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_payroll_runs_period" ON "public"."payroll_runs" USING "btree" ("period_year", "period_month");


--
-- Name: idx_pdf_templates_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_pdf_templates_company" ON "public"."pdf_templates" USING "btree" ("company_id");


--
-- Name: idx_period_close_checklist_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_period_close_checklist_company" ON "public"."period_close_checklist" USING "btree" ("company_id");


--
-- Name: idx_period_close_checklist_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_period_close_checklist_period" ON "public"."period_close_checklist" USING "btree" ("period_id");


--
-- Name: idx_po_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_po_status" ON "public"."purchase_orders" USING "btree" ("status");


--
-- Name: idx_po_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_po_supplier" ON "public"."purchase_orders" USING "btree" ("supplier_id");


--
-- Name: idx_pr_requested_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_pr_requested_by" ON "public"."purchase_requisitions" USING "btree" ("requested_by");


--
-- Name: idx_pr_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_pr_status" ON "public"."purchase_requisitions" USING "btree" ("status");


--
-- Name: idx_price_list_items_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_price_list_items_lookup" ON "public"."price_list_items" USING "btree" ("price_list_id", "item_id");


--
-- Name: idx_price_lists_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_price_lists_company" ON "public"."price_lists" USING "btree" ("company_id");


--
-- Name: idx_price_lists_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_price_lists_customer" ON "public"."price_lists" USING "btree" ("customer_id");


--
-- Name: idx_project_tasks_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_project_tasks_project" ON "public"."project_tasks" USING "btree" ("project_id", "status");


--
-- Name: idx_projects_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_projects_company" ON "public"."projects" USING "btree" ("company_id");


--
-- Name: idx_projects_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_projects_customer" ON "public"."projects" USING "btree" ("customer_id") WHERE ("deleted_at" IS NULL);


--
-- Name: idx_projects_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_projects_status" ON "public"."projects" USING "btree" ("status") WHERE ("deleted_at" IS NULL);


--
-- Name: idx_purchase_orders_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_purchase_orders_company" ON "public"."purchase_orders" USING "btree" ("company_id");


--
-- Name: idx_purchase_orders_delivery_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_purchase_orders_delivery_status" ON "public"."purchase_orders" USING "btree" ("status") WHERE (("status")::"text" = ANY (ARRAY[('SENT_TO_SUPPLIER'::character varying)::"text", ('CONFIRMED'::character varying)::"text", ('PREPARING_DELIVERY'::character varying)::"text", ('IN_TRANSIT'::character varying)::"text", ('DELIVERED'::character varying)::"text", ('VERIFIED'::character varying)::"text"]));


--
-- Name: idx_purchase_orders_delivery_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_purchase_orders_delivery_token" ON "public"."purchase_orders" USING "btree" ("supplier_delivery_token");


--
-- Name: idx_purchase_orders_embedding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_purchase_orders_embedding" ON "public"."purchase_orders" USING "hnsw" ("embedding" "public"."vector_cosine_ops");


--
-- Name: idx_purchase_orders_storage_location; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_purchase_orders_storage_location" ON "public"."purchase_orders" USING "btree" ("storage_location_id");


--
-- Name: idx_purchase_requisitions_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_purchase_requisitions_company" ON "public"."purchase_requisitions" USING "btree" ("company_id");


--
-- Name: idx_recurring_invoice_schedules_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_recurring_invoice_schedules_company" ON "public"."recurring_invoice_schedules" USING "btree" ("company_id");


--
-- Name: idx_recurring_invoice_schedules_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_recurring_invoice_schedules_due" ON "public"."recurring_invoice_schedules" USING "btree" ("next_run_date") WHERE (("status")::"text" = 'ACTIVE'::"text");


--
-- Name: idx_report_definitions_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_report_definitions_owner" ON "public"."report_definitions" USING "btree" ("owner_id") WHERE ("deleted_at" IS NULL);


--
-- Name: idx_report_definitions_shared; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_report_definitions_shared" ON "public"."report_definitions" USING "btree" ("is_shared") WHERE ("deleted_at" IS NULL);


--
-- Name: idx_report_runs_report; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_report_runs_report" ON "public"."report_runs" USING "btree" ("report_id", "run_at" DESC);


--
-- Name: idx_report_schedules_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_report_schedules_due" ON "public"."report_schedules" USING "btree" ("next_run_at") WHERE ("enabled" = true);


--
-- Name: idx_request_for_quotations_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_request_for_quotations_company" ON "public"."request_for_quotations" USING "btree" ("company_id");


--
-- Name: idx_revenue_schedules_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_revenue_schedules_period" ON "public"."revenue_schedules" USING "btree" ("period_date", "status");


--
-- Name: idx_rfq_line_items_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_rfq_line_items_item" ON "public"."rfq_line_items" USING "btree" ("item_id");


--
-- Name: idx_rfq_line_items_rfq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_rfq_line_items_rfq" ON "public"."rfq_line_items" USING "btree" ("rfq_id");


--
-- Name: idx_rfq_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_rfq_status" ON "public"."request_for_quotations" USING "btree" ("status");


--
-- Name: idx_rfqs_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_rfqs_company" ON "public"."rfqs" USING "btree" ("company_id");


--
-- Name: idx_rfqs_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_rfqs_created_by" ON "public"."rfqs" USING "btree" ("created_by");


--
-- Name: idx_rfqs_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_rfqs_deleted_at" ON "public"."rfqs" USING "btree" ("deleted_at");


--
-- Name: idx_rfqs_response_deadline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_rfqs_response_deadline" ON "public"."rfqs" USING "btree" ("response_deadline");


--
-- Name: idx_rfqs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_rfqs_status" ON "public"."rfqs" USING "btree" ("status");


--
-- Name: idx_rfqs_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_rfqs_supplier" ON "public"."rfqs" USING "btree" ("supplier_id");


--
-- Name: idx_sales_contract_items_contract; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_contract_items_contract" ON "public"."sales_contract_items" USING "btree" ("sales_contract_id");


--
-- Name: idx_sales_contract_items_inventory; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_contract_items_inventory" ON "public"."sales_contract_items" USING "btree" ("inventory_item_id");


--
-- Name: idx_sales_contract_items_line; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_contract_items_line" ON "public"."sales_contract_items" USING "btree" ("sales_contract_id", "line_number");


--
-- Name: idx_sales_contract_status_history_contract_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_contract_status_history_contract_id" ON "public"."sales_contract_status_history" USING "btree" ("sales_contract_id");


--
-- Name: idx_sales_contract_status_history_status_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_contract_status_history_status_date" ON "public"."sales_contract_status_history" USING "btree" ("status_date");


--
-- Name: idx_sales_contracts_approval_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_contracts_approval_status" ON "public"."sales_contracts" USING "btree" ("approval_status");


--
-- Name: idx_sales_contracts_approved_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_contracts_approved_at" ON "public"."sales_contracts" USING "btree" ("approved_at") WHERE ("approved_at" IS NOT NULL);


--
-- Name: idx_sales_contracts_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_contracts_company" ON "public"."sales_contracts" USING "btree" ("company_id");


--
-- Name: idx_sales_contracts_contract_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_contracts_contract_number" ON "public"."sales_contracts" USING "btree" ("contract_number");


--
-- Name: idx_sales_contracts_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_contracts_created_by" ON "public"."sales_contracts" USING "btree" ("created_by");


--
-- Name: idx_sales_contracts_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_contracts_customer" ON "public"."sales_contracts" USING "btree" ("customer_id");


--
-- Name: idx_sales_contracts_customer_response_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_contracts_customer_response_token" ON "public"."sales_contracts" USING "btree" ("customer_response_token") WHERE ("customer_response_token" IS NOT NULL);


--
-- Name: idx_sales_contracts_dates; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_contracts_dates" ON "public"."sales_contracts" USING "btree" ("start_date", "end_date");


--
-- Name: idx_sales_contracts_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_contracts_deleted_at" ON "public"."sales_contracts" USING "btree" ("deleted_at");


--
-- Name: idx_sales_contracts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_contracts_status" ON "public"."sales_contracts" USING "btree" ("status");


--
-- Name: idx_sales_contracts_submitted_approval; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_contracts_submitted_approval" ON "public"."sales_contracts" USING "btree" ("submitted_for_approval_at") WHERE ("submitted_for_approval_at" IS NOT NULL);


--
-- Name: idx_sales_contracts_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_contracts_supplier" ON "public"."sales_contracts" USING "btree" ("supplier_id");


--
-- Name: idx_sales_contracts_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_contracts_type" ON "public"."sales_contracts" USING "btree" ("contract_type");


--
-- Name: idx_sales_credit_notes_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_credit_notes_company" ON "public"."sales_credit_notes" USING "btree" ("company_id");


--
-- Name: idx_sales_order_items_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_order_items_item" ON "public"."sales_order_items" USING "btree" ("inventory_item_id");


--
-- Name: idx_sales_order_items_line; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_order_items_line" ON "public"."sales_order_items" USING "btree" ("sales_order_id", "line_number");


--
-- Name: idx_sales_order_items_so; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_order_items_so" ON "public"."sales_order_items" USING "btree" ("sales_order_id");


--
-- Name: idx_sales_orders_approval_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_orders_approval_status" ON "public"."sales_orders" USING "btree" ("approval_status");


--
-- Name: idx_sales_orders_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_orders_company" ON "public"."sales_orders" USING "btree" ("company_id");


--
-- Name: idx_sales_orders_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_orders_created_by" ON "public"."sales_orders" USING "btree" ("created_by");


--
-- Name: idx_sales_orders_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_orders_customer" ON "public"."sales_orders" USING "btree" ("customer_id");


--
-- Name: idx_sales_orders_customer_response_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_orders_customer_response_token" ON "public"."sales_orders" USING "btree" ("customer_response_token");


--
-- Name: idx_sales_orders_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_orders_date" ON "public"."sales_orders" USING "btree" ("order_date");


--
-- Name: idx_sales_orders_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_orders_deleted_at" ON "public"."sales_orders" USING "btree" ("deleted_at");


--
-- Name: idx_sales_orders_embedding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_orders_embedding" ON "public"."sales_orders" USING "hnsw" ("embedding" "public"."vector_cosine_ops");


--
-- Name: idx_sales_orders_so_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_orders_so_number" ON "public"."sales_orders" USING "btree" ("so_number");


--
-- Name: idx_sales_orders_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_orders_status" ON "public"."sales_orders" USING "btree" ("status");


--
-- Name: idx_sales_quotation_items_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_quotation_items_item" ON "public"."sales_quotation_items" USING "btree" ("inventory_item_id");


--
-- Name: idx_sales_quotation_items_line; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_quotation_items_line" ON "public"."sales_quotation_items" USING "btree" ("sales_quotation_id", "line_number");


--
-- Name: idx_sales_quotation_items_linked_sales_rfq_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_quotation_items_linked_sales_rfq_id" ON "public"."sales_quotation_items" USING "btree" ("linked_sales_rfq_id") WHERE ("linked_sales_rfq_id" IS NOT NULL);


--
-- Name: idx_sales_quotation_items_quotation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_quotation_items_quotation" ON "public"."sales_quotation_items" USING "btree" ("sales_quotation_id");


--
-- Name: idx_sales_quotation_items_source_bin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_quotation_items_source_bin_id" ON "public"."sales_quotation_items" USING "btree" ("source_bin_id") WHERE ("source_bin_id" IS NOT NULL);


--
-- Name: idx_sales_quotation_items_sourcing_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_quotation_items_sourcing_type" ON "public"."sales_quotation_items" USING "btree" ("sourcing_type");


--
-- Name: idx_sales_quotation_items_supplier_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_quotation_items_supplier_id" ON "public"."sales_quotation_items" USING "btree" ("supplier_id") WHERE ("supplier_id" IS NOT NULL);


--
-- Name: idx_sales_quotations_approved_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_quotations_approved_by" ON "public"."sales_quotations" USING "btree" ("approved_by");


--
-- Name: idx_sales_quotations_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_quotations_company" ON "public"."sales_quotations" USING "btree" ("company_id");


--
-- Name: idx_sales_quotations_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_quotations_created_by" ON "public"."sales_quotations" USING "btree" ("created_by");


--
-- Name: idx_sales_quotations_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_quotations_customer" ON "public"."sales_quotations" USING "btree" ("customer_id");


--
-- Name: idx_sales_quotations_customer_response; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_quotations_customer_response" ON "public"."sales_quotations" USING "btree" ("accepted_at", "rejected_at") WHERE (("accepted_at" IS NOT NULL) OR ("rejected_at" IS NOT NULL));


--
-- Name: idx_sales_quotations_customer_response_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_quotations_customer_response_token" ON "public"."sales_quotations" USING "btree" ("customer_response_token");


--
-- Name: idx_sales_quotations_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_quotations_date" ON "public"."sales_quotations" USING "btree" ("quotation_date");


--
-- Name: idx_sales_quotations_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_quotations_deleted_at" ON "public"."sales_quotations" USING "btree" ("deleted_at");


--
-- Name: idx_sales_quotations_quotation_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_quotations_quotation_number" ON "public"."sales_quotations" USING "btree" ("quotation_number");


--
-- Name: idx_sales_quotations_rejected_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_quotations_rejected_by" ON "public"."sales_quotations" USING "btree" ("rejected_by");


--
-- Name: idx_sales_quotations_sales_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_quotations_sales_order" ON "public"."sales_quotations" USING "btree" ("sales_order_id");


--
-- Name: idx_sales_quotations_send_approved_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_quotations_send_approved_by" ON "public"."sales_quotations" USING "btree" ("send_approved_by");


--
-- Name: idx_sales_quotations_send_requested_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_quotations_send_requested_by" ON "public"."sales_quotations" USING "btree" ("send_requested_by");


--
-- Name: idx_sales_quotations_sent_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_quotations_sent_by" ON "public"."sales_quotations" USING "btree" ("sent_by");


--
-- Name: idx_sales_quotations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_quotations_status" ON "public"."sales_quotations" USING "btree" ("status");


--
-- Name: idx_sales_quotations_valid_until; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_quotations_valid_until" ON "public"."sales_quotations" USING "btree" ("valid_until");


--
-- Name: idx_sales_rfq_communications_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_rfq_communications_created_at" ON "public"."sales_rfq_communications" USING "btree" ("created_at");


--
-- Name: idx_sales_rfq_communications_rfq_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_rfq_communications_rfq_id" ON "public"."sales_rfq_communications" USING "btree" ("sales_rfq_id");


--
-- Name: idx_sales_rfq_items_item_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_rfq_items_item_id" ON "public"."sales_rfq_items" USING "btree" ("item_id");


--
-- Name: idx_sales_rfq_items_rfq_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_rfq_items_rfq_id" ON "public"."sales_rfq_items" USING "btree" ("sales_rfq_id");


--
-- Name: idx_sales_rfq_status_history_changed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_rfq_status_history_changed_at" ON "public"."sales_rfq_status_history" USING "btree" ("changed_at");


--
-- Name: idx_sales_rfq_status_history_rfq_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_rfq_status_history_rfq_id" ON "public"."sales_rfq_status_history" USING "btree" ("sales_rfq_id");


--
-- Name: idx_sales_rfqs_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_rfqs_company" ON "public"."sales_rfqs" USING "btree" ("company_id");


--
-- Name: idx_sales_rfqs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_rfqs_created_at" ON "public"."sales_rfqs" USING "btree" ("created_at");


--
-- Name: idx_sales_rfqs_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_rfqs_deleted_at" ON "public"."sales_rfqs" USING "btree" ("deleted_at") WHERE ("deleted_at" IS NULL);


--
-- Name: idx_sales_rfqs_overall_approval; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_rfqs_overall_approval" ON "public"."sales_rfqs" USING "btree" ("overall_approval_status");


--
-- Name: idx_sales_rfqs_procurement_approval; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_rfqs_procurement_approval" ON "public"."sales_rfqs" USING "btree" ("procurement_approval_status", "procurement_approved_by");


--
-- Name: idx_sales_rfqs_required_delivery_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_rfqs_required_delivery_date" ON "public"."sales_rfqs" USING "btree" ("required_delivery_date");


--
-- Name: idx_sales_rfqs_response_deadline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_rfqs_response_deadline" ON "public"."sales_rfqs" USING "btree" ("response_deadline");


--
-- Name: idx_sales_rfqs_response_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_rfqs_response_token" ON "public"."sales_rfqs" USING "btree" ("response_token");


--
-- Name: idx_sales_rfqs_sales_approval; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_rfqs_sales_approval" ON "public"."sales_rfqs" USING "btree" ("sales_approval_status", "sales_approved_by");


--
-- Name: idx_sales_rfqs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_rfqs_status" ON "public"."sales_rfqs" USING "btree" ("status");


--
-- Name: idx_sales_rfqs_supplier_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sales_rfqs_supplier_id" ON "public"."sales_rfqs" USING "btree" ("supplier_id");


--
-- Name: idx_sc_renewals_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sc_renewals_date" ON "public"."sales_contract_renewals" USING "btree" ("renewal_date");


--
-- Name: idx_sc_renewals_new; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sc_renewals_new" ON "public"."sales_contract_renewals" USING "btree" ("new_contract_id");


--
-- Name: idx_sc_renewals_original; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sc_renewals_original" ON "public"."sales_contract_renewals" USING "btree" ("original_contract_id");


--
-- Name: idx_sc_status_history_contract; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sc_status_history_contract" ON "public"."sales_contract_status_history" USING "btree" ("sales_contract_id");


--
-- Name: idx_sc_status_history_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sc_status_history_date" ON "public"."sales_contract_status_history" USING "btree" ("status_date");


--
-- Name: idx_sc_usage_contract; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sc_usage_contract" ON "public"."sales_contract_usage" USING "btree" ("sales_contract_id");


--
-- Name: idx_sc_usage_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sc_usage_date" ON "public"."sales_contract_usage" USING "btree" ("usage_date");


--
-- Name: idx_sc_usage_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sc_usage_item" ON "public"."sales_contract_usage" USING "btree" ("sales_contract_item_id");


--
-- Name: idx_sc_usage_reference; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sc_usage_reference" ON "public"."sales_contract_usage" USING "btree" ("reference_type", "reference_id");


--
-- Name: idx_scn_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_scn_invoice" ON "public"."sales_credit_notes" USING "btree" ("customer_invoice_id");


--
-- Name: idx_scn_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_scn_status" ON "public"."sales_credit_notes" USING "btree" ("status") WHERE ("deleted_at" IS NULL);


--
-- Name: idx_sdn_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sdn_invoice" ON "public"."supplier_debit_notes" USING "btree" ("supplier_invoice_id");


--
-- Name: idx_sdn_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sdn_status" ON "public"."supplier_debit_notes" USING "btree" ("status") WHERE ("deleted_at" IS NULL);


--
-- Name: idx_shipments_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_shipments_company" ON "public"."shipments" USING "btree" ("company_id");


--
-- Name: idx_shipments_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_shipments_order" ON "public"."shipments" USING "btree" ("sales_order_id");


--
-- Name: idx_shipments_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_shipments_status" ON "public"."shipments" USING "btree" ("shipping_status");


--
-- Name: idx_so_status_history_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_so_status_history_date" ON "public"."sales_order_status_history" USING "btree" ("status_date");


--
-- Name: idx_so_status_history_so; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_so_status_history_so" ON "public"."sales_order_status_history" USING "btree" ("sales_order_id");


--
-- Name: idx_sq_status_history_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sq_status_history_date" ON "public"."sales_quotation_status_history" USING "btree" ("status_date");


--
-- Name: idx_sq_status_history_quotation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sq_status_history_quotation" ON "public"."sales_quotation_status_history" USING "btree" ("sales_quotation_id");


--
-- Name: idx_stocktake_items_sheet; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_stocktake_items_sheet" ON "public"."stocktake_sheet_items" USING "btree" ("sheet_id");


--
-- Name: idx_stocktake_items_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "idx_stocktake_items_unique" ON "public"."stocktake_sheet_items" USING "btree" ("sheet_id", "inventory_item_id");


--
-- Name: idx_stocktake_sheets_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_stocktake_sheets_company" ON "public"."stocktake_sheets" USING "btree" ("company_id");


--
-- Name: idx_stocktake_sheets_location; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_stocktake_sheets_location" ON "public"."stocktake_sheets" USING "btree" ("location_id") WHERE ("deleted_at" IS NULL);


--
-- Name: idx_storage_locations_approved_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_storage_locations_approved_by" ON "public"."storage_locations" USING "btree" ("approved_by");


--
-- Name: idx_storage_locations_city; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_storage_locations_city" ON "public"."storage_locations" USING "btree" ("city");


--
-- Name: idx_storage_locations_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_storage_locations_code" ON "public"."storage_locations" USING "btree" ("code");


--
-- Name: idx_storage_locations_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_storage_locations_company" ON "public"."storage_locations" USING "btree" ("company_id");


--
-- Name: idx_storage_locations_country; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_storage_locations_country" ON "public"."storage_locations" USING "btree" ("country");


--
-- Name: idx_storage_locations_is_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_storage_locations_is_active" ON "public"."storage_locations" USING "btree" ("is_active");


--
-- Name: idx_storage_locations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_storage_locations_status" ON "public"."storage_locations" USING "btree" ("status");


--
-- Name: idx_storage_locations_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_storage_locations_user_id" ON "public"."storage_locations" USING "btree" ("user_id");


--
-- Name: idx_supplier_bank_changes_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_supplier_bank_changes_supplier" ON "public"."supplier_bank_detail_changes" USING "btree" ("supplier_id", "changed_at" DESC);


--
-- Name: idx_supplier_debit_notes_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_supplier_debit_notes_company" ON "public"."supplier_debit_notes" USING "btree" ("company_id");


--
-- Name: idx_supplier_invoice_items_bill; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_supplier_invoice_items_bill" ON "public"."supplier_invoice_items" USING "btree" ("bill_id");


--
-- Name: idx_supplier_invoices_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_supplier_invoices_company" ON "public"."supplier_invoices" USING "btree" ("company_id");


--
-- Name: idx_supplier_invoices_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_supplier_invoices_deleted_at" ON "public"."supplier_invoices" USING "btree" ("deleted_at");


--
-- Name: idx_supplier_invoices_due_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_supplier_invoices_due_date" ON "public"."supplier_invoices" USING "btree" ("due_date");


--
-- Name: idx_supplier_invoices_dupe_scan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_supplier_invoices_dupe_scan" ON "public"."supplier_invoices" USING "btree" ("supplier_id", "total_amount", "invoice_date") WHERE ("deleted_at" IS NULL);


--
-- Name: idx_supplier_invoices_po; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_supplier_invoices_po" ON "public"."supplier_invoices" USING "btree" ("purchase_order_id");


--
-- Name: idx_supplier_invoices_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_supplier_invoices_status" ON "public"."supplier_invoices" USING "btree" ("status");


--
-- Name: idx_supplier_invoices_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_supplier_invoices_supplier" ON "public"."supplier_invoices" USING "btree" ("supplier_id");


--
-- Name: idx_supplier_items_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_supplier_items_company" ON "public"."supplier_items" USING "btree" ("company_id");


--
-- Name: idx_supplier_items_item_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_supplier_items_item_id" ON "public"."supplier_items" USING "btree" ("item_id");


--
-- Name: idx_supplier_items_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_supplier_items_status" ON "public"."supplier_items" USING "btree" ("status");


--
-- Name: idx_supplier_items_supplier_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_supplier_items_supplier_id" ON "public"."supplier_items" USING "btree" ("supplier_id");


--
-- Name: idx_supplier_pay_alloc_bill; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_supplier_pay_alloc_bill" ON "public"."supplier_payment_allocations" USING "btree" ("bill_id");


--
-- Name: idx_supplier_pay_alloc_payment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_supplier_pay_alloc_payment" ON "public"."supplier_payment_allocations" USING "btree" ("payment_id");


--
-- Name: idx_supplier_payments_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_supplier_payments_company" ON "public"."supplier_payments" USING "btree" ("company_id");


--
-- Name: idx_supplier_payments_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_supplier_payments_deleted_at" ON "public"."supplier_payments" USING "btree" ("deleted_at");


--
-- Name: idx_supplier_payments_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_supplier_payments_status" ON "public"."supplier_payments" USING "btree" ("status");


--
-- Name: idx_supplier_payments_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_supplier_payments_supplier" ON "public"."supplier_payments" USING "btree" ("supplier_id");


--
-- Name: idx_suppliers_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_suppliers_code" ON "public"."suppliers" USING "btree" ("supplier_code");


--
-- Name: idx_suppliers_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_suppliers_company" ON "public"."suppliers" USING "btree" ("company_id");


--
-- Name: idx_suppliers_legal_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_suppliers_legal_name_trgm" ON "public"."suppliers" USING "gin" ("legal_name" "public"."gin_trgm_ops");


--
-- Name: idx_suppliers_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_suppliers_status" ON "public"."suppliers" USING "btree" ("status");


--
-- Name: idx_suppliers_trade_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_suppliers_trade_name_trgm" ON "public"."suppliers" USING "gin" ("trade_name" "public"."gin_trgm_ops");


--
-- Name: idx_tax_codes_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_tax_codes_lookup" ON "public"."tax_codes" USING "btree" ("jurisdiction_code", "tax_type", "category", "effective_from" DESC);


--
-- Name: idx_tax_payment_schedules_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_tax_payment_schedules_due" ON "public"."tax_payment_schedules" USING "btree" ("next_due_date") WHERE ((("status")::"text" = 'ACTIVE'::"text") AND ("deleted_at" IS NULL));


--
-- Name: idx_time_entries_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_time_entries_company" ON "public"."time_entries" USING "btree" ("company_id");


--
-- Name: idx_time_entries_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_time_entries_project" ON "public"."time_entries" USING "btree" ("project_id", "entry_date");


--
-- Name: idx_time_entries_unbilled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_time_entries_unbilled" ON "public"."time_entries" USING "btree" ("project_id", "entry_date") WHERE (("billable" = true) AND ("invoice_id" IS NULL));


--
-- Name: idx_time_entries_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_time_entries_user" ON "public"."time_entries" USING "btree" ("user_id", "entry_date");


--
-- Name: idx_uom_conversions_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_uom_conversions_company" ON "public"."uom_conversions" USING "btree" ("company_id");


--
-- Name: idx_uom_conversions_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_uom_conversions_item" ON "public"."uom_conversions" USING "btree" ("item_id");


--
-- Name: idx_user_companies_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_user_companies_company" ON "public"."user_companies" USING "btree" ("company_id");


--
-- Name: idx_users_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_users_created_at" ON "public"."users" USING "btree" ("created_at" DESC);


--
-- Name: idx_users_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_users_deleted_at" ON "public"."users" USING "btree" ("deleted_at");


--
-- Name: idx_users_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_users_email" ON "public"."users" USING "btree" ("email");


--
-- Name: idx_users_is_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_users_is_active" ON "public"."users" USING "btree" ("is_active");


--
-- Name: idx_users_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_users_role" ON "public"."users" USING "btree" ("role");


--
-- Name: idx_warehouse_transaction_audit_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_warehouse_transaction_audit_created" ON "public"."warehouse_transaction_audit_log" USING "btree" ("created_at");


--
-- Name: idx_warehouse_transaction_audit_transaction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_warehouse_transaction_audit_transaction" ON "public"."warehouse_transaction_audit_log" USING "btree" ("warehouse_transaction_id");


--
-- Name: idx_warehouse_transaction_audit_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_warehouse_transaction_audit_user" ON "public"."warehouse_transaction_audit_log" USING "btree" ("user_id");


--
-- Name: idx_warehouse_transaction_items_dest_location; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_warehouse_transaction_items_dest_location" ON "public"."warehouse_transaction_items" USING "btree" ("destination_storage_location_id");


--
-- Name: idx_warehouse_transaction_items_inventory; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_warehouse_transaction_items_inventory" ON "public"."warehouse_transaction_items" USING "btree" ("inventory_item_id");


--
-- Name: idx_warehouse_transaction_items_source_location; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_warehouse_transaction_items_source_location" ON "public"."warehouse_transaction_items" USING "btree" ("source_storage_location_id");


--
-- Name: idx_warehouse_transaction_items_transaction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_warehouse_transaction_items_transaction" ON "public"."warehouse_transaction_items" USING "btree" ("warehouse_transaction_id");


--
-- Name: idx_warehouse_transactions_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_warehouse_transactions_company" ON "public"."warehouse_transactions" USING "btree" ("company_id");


--
-- Name: idx_warehouse_transactions_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_warehouse_transactions_created_by" ON "public"."warehouse_transactions" USING "btree" ("created_by");


--
-- Name: idx_warehouse_transactions_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_warehouse_transactions_date" ON "public"."warehouse_transactions" USING "btree" ("transaction_date");


--
-- Name: idx_warehouse_transactions_reference; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_warehouse_transactions_reference" ON "public"."warehouse_transactions" USING "btree" ("reference_document", "reference_type");


--
-- Name: idx_warehouse_transactions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_warehouse_transactions_status" ON "public"."warehouse_transactions" USING "btree" ("status");


--
-- Name: idx_warehouse_transactions_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_warehouse_transactions_type" ON "public"."warehouse_transactions" USING "btree" ("transaction_type");


--
-- Name: idx_webhook_delivery_log_sub; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_webhook_delivery_log_sub" ON "public"."webhook_delivery_log" USING "btree" ("subscription_id");


--
-- Name: idx_webhook_subscriptions_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_webhook_subscriptions_company" ON "public"."webhook_subscriptions" USING "btree" ("company_id");


--
-- Name: idx_webhook_subscriptions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_webhook_subscriptions_status" ON "public"."webhook_subscriptions" USING "btree" ("status");


--
-- Name: idx_wo_components_wo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_wo_components_wo" ON "public"."work_order_components" USING "btree" ("work_order_id", "line_number");


--
-- Name: idx_wo_operations_load; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_wo_operations_load" ON "public"."work_order_operations" USING "btree" ("work_center_id", "status") WHERE (("status")::"text" = ANY (ARRAY[('PENDING'::character varying)::"text", ('IN_PROGRESS'::character varying)::"text"]));


--
-- Name: idx_wo_operations_wo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_wo_operations_wo" ON "public"."work_order_operations" USING "btree" ("work_order_id", "operation_number");


--
-- Name: idx_wo_time_entries_op; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_wo_time_entries_op" ON "public"."work_order_time_entries" USING "btree" ("operation_id");


--
-- Name: idx_wo_time_entries_wo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_wo_time_entries_wo" ON "public"."work_order_time_entries" USING "btree" ("work_order_id", "entry_date");


--
-- Name: idx_work_centers_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_work_centers_company" ON "public"."work_centers" USING "btree" ("company_id");


--
-- Name: idx_work_centers_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_work_centers_status" ON "public"."work_centers" USING "btree" ("status") WHERE ("deleted_at" IS NULL);


--
-- Name: idx_work_orders_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_work_orders_company" ON "public"."work_orders" USING "btree" ("company_id");


--
-- Name: idx_work_orders_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_work_orders_item" ON "public"."work_orders" USING "btree" ("item_id");


--
-- Name: idx_work_orders_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_work_orders_status" ON "public"."work_orders" USING "btree" ("status", "planned_start_date");


--
-- Name: inventory_transfers_company_transfer_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "inventory_transfers_company_transfer_number_key" ON "public"."inventory_transfers" USING "btree" ("company_id", "transfer_number");


--
-- Name: items_company_item_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "items_company_item_code_key" ON "public"."items" USING "btree" ("company_id", "item_code");


--
-- Name: journal_entries_company_journal_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "journal_entries_company_journal_number_key" ON "public"."journal_entries" USING "btree" ("company_id", "journal_number");


--
-- Name: journal_entries_company_posting_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "journal_entries_company_posting_key" ON "public"."journal_entries" USING "btree" ("company_id", "posting_key") WHERE (("posting_key" IS NOT NULL) AND ("deleted_at" IS NULL));


--
-- Name: landed_cost_vouchers_company_voucher_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "landed_cost_vouchers_company_voucher_number_key" ON "public"."landed_cost_vouchers" USING "btree" ("company_id", "voucher_number");


--
-- Name: leads_company_lead_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "leads_company_lead_number_key" ON "public"."leads" USING "btree" ("company_id", "lead_number");


--
-- Name: mcp_oauth_grants_company_connection_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "mcp_oauth_grants_company_connection_id_key" ON "public"."mcp_oauth_grants" USING "btree" ("company_id", "connection_id");


--
-- Name: payroll_runs_company_run_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "payroll_runs_company_run_number_key" ON "public"."payroll_runs" USING "btree" ("company_id", "run_number");


--
-- Name: price_lists_company_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "price_lists_company_code_key" ON "public"."price_lists" USING "btree" ("company_id", "code");


--
-- Name: projects_company_project_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "projects_company_project_code_key" ON "public"."projects" USING "btree" ("company_id", "project_code");


--
-- Name: purchase_orders_company_po_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "purchase_orders_company_po_number_key" ON "public"."purchase_orders" USING "btree" ("company_id", "po_number");


--
-- Name: purchase_requisitions_company_pr_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "purchase_requisitions_company_pr_number_key" ON "public"."purchase_requisitions" USING "btree" ("company_id", "pr_number");


--
-- Name: request_for_quotations_company_rfq_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "request_for_quotations_company_rfq_number_key" ON "public"."request_for_quotations" USING "btree" ("company_id", "rfq_number");


--
-- Name: sales_contracts_company_contract_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "sales_contracts_company_contract_number_key" ON "public"."sales_contracts" USING "btree" ("company_id", "contract_number");


--
-- Name: sales_credit_notes_company_credit_note_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "sales_credit_notes_company_credit_note_number_key" ON "public"."sales_credit_notes" USING "btree" ("company_id", "credit_note_number");


--
-- Name: sales_orders_company_so_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "sales_orders_company_so_number_key" ON "public"."sales_orders" USING "btree" ("company_id", "so_number");


--
-- Name: sales_quotations_company_quotation_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "sales_quotations_company_quotation_number_key" ON "public"."sales_quotations" USING "btree" ("company_id", "quotation_number");


--
-- Name: sales_rfqs_company_rfq_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "sales_rfqs_company_rfq_number_key" ON "public"."sales_rfqs" USING "btree" ("company_id", "rfq_number");


--
-- Name: shipments_company_shipment_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "shipments_company_shipment_number_key" ON "public"."shipments" USING "btree" ("company_id", "shipment_number");


--
-- Name: stocktake_sheets_company_sheet_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "stocktake_sheets_company_sheet_number_key" ON "public"."stocktake_sheets" USING "btree" ("company_id", "sheet_number");


--
-- Name: storage_locations_company_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "storage_locations_company_code_key" ON "public"."storage_locations" USING "btree" ("company_id", "code");


--
-- Name: supplier_debit_notes_company_debit_note_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "supplier_debit_notes_company_debit_note_number_key" ON "public"."supplier_debit_notes" USING "btree" ("company_id", "debit_note_number");


--
-- Name: supplier_invoices_company_bill_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "supplier_invoices_company_bill_number_key" ON "public"."supplier_invoices" USING "btree" ("company_id", "bill_number");


--
-- Name: supplier_payments_company_payment_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "supplier_payments_company_payment_number_key" ON "public"."supplier_payments" USING "btree" ("company_id", "payment_number");


--
-- Name: suppliers_company_supplier_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "suppliers_company_supplier_code_key" ON "public"."suppliers" USING "btree" ("company_id", "supplier_code");


--
-- Name: uq_agent_definitions_company_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "uq_agent_definitions_company_key" ON "public"."agent_definitions" USING "btree" ("company_id", "agent_key");


--
-- Name: uq_ai_tools_company_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "uq_ai_tools_company_name" ON "public"."ai_tools" USING "btree" ("company_id", "name");


--
-- Name: uq_journal_entries_posting_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "uq_journal_entries_posting_key" ON "public"."journal_entries" USING "btree" ("posting_key") WHERE (("posting_key" IS NOT NULL) AND ("deleted_at" IS NULL));


--
-- Name: INDEX "uq_journal_entries_posting_key"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX "public"."uq_journal_entries_posting_key" IS 'At most one live journal entry per posting key. Application code checks first for a friendly answer; this is what actually prevents the double-post under concurrency.';


--
-- Name: uq_mcp_connections_company_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "uq_mcp_connections_company_slug" ON "public"."mcp_connections" USING "btree" ("company_id", "slug") WHERE ("slug" IS NOT NULL);


--
-- Name: uq_pdf_templates_company_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "uq_pdf_templates_company_key" ON "public"."pdf_templates" USING "btree" ("company_id", "key");


--
-- Name: users_email_active_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "users_email_active_key" ON "public"."users" USING "btree" ("email") WHERE ("deleted_at" IS NULL);


--
-- Name: warehouse_transactions_company_transaction_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "warehouse_transactions_company_transaction_number_key" ON "public"."warehouse_transactions" USING "btree" ("company_id", "transaction_number");


--
-- Name: work_centers_company_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "work_centers_company_code_key" ON "public"."work_centers" USING "btree" ("company_id", "code");


--
-- Name: work_orders_company_wo_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "work_orders_company_wo_number_key" ON "public"."work_orders" USING "btree" ("company_id", "wo_number");


--
-- Name: bank_accounts bank_accounts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bank_accounts_updated_at" BEFORE UPDATE ON "public"."bank_accounts" FOR EACH ROW EXECUTE FUNCTION "public"."update_sales_order_timestamp"();


--
-- Name: budgets budgets_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "budgets_updated_at" BEFORE UPDATE ON "public"."budgets" FOR EACH ROW EXECUTE FUNCTION "public"."update_sales_order_timestamp"();


--
-- Name: chart_of_accounts chart_of_accounts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "chart_of_accounts_updated_at" BEFORE UPDATE ON "public"."chart_of_accounts" FOR EACH ROW EXECUTE FUNCTION "public"."update_sales_order_timestamp"();


--
-- Name: chart_of_accounts_status_history chart_status_history_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "chart_status_history_updated_at" BEFORE UPDATE ON "public"."chart_of_accounts_status_history" FOR EACH ROW EXECUTE FUNCTION "public"."update_sales_order_timestamp"();


--
-- Name: cost_centers cost_centers_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "cost_centers_updated_at" BEFORE UPDATE ON "public"."cost_centers" FOR EACH ROW EXECUTE FUNCTION "public"."update_sales_order_timestamp"();


--
-- Name: customer_invoices customer_invoices_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "customer_invoices_updated_at" BEFORE UPDATE ON "public"."customer_invoices" FOR EACH ROW EXECUTE FUNCTION "public"."update_sales_order_timestamp"();


--
-- Name: customer_payments customer_payments_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "customer_payments_updated_at" BEFORE UPDATE ON "public"."customer_payments" FOR EACH ROW EXECUTE FUNCTION "public"."update_sales_order_timestamp"();


--
-- Name: delivery_exceptions delivery_exceptions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "delivery_exceptions_updated_at" BEFORE UPDATE ON "public"."delivery_exceptions" FOR EACH ROW EXECUTE FUNCTION "public"."update_sales_order_timestamp"();


--
-- Name: delivery_items delivery_items_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "delivery_items_updated_at" BEFORE UPDATE ON "public"."delivery_items" FOR EACH ROW EXECUTE FUNCTION "public"."update_sales_order_timestamp"();


--
-- Name: delivery_route_stops delivery_route_stops_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "delivery_route_stops_updated_at" BEFORE UPDATE ON "public"."delivery_route_stops" FOR EACH ROW EXECUTE FUNCTION "public"."update_sales_order_timestamp"();


--
-- Name: delivery_routes delivery_routes_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "delivery_routes_updated_at" BEFORE UPDATE ON "public"."delivery_routes" FOR EACH ROW EXECUTE FUNCTION "public"."update_sales_order_timestamp"();


--
-- Name: delivery_schedules delivery_schedules_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "delivery_schedules_updated_at" BEFORE UPDATE ON "public"."delivery_schedules" FOR EACH ROW EXECUTE FUNCTION "public"."update_sales_order_timestamp"();


--
-- Name: employees employees_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "employees_updated_at" BEFORE UPDATE ON "public"."employees" FOR EACH ROW EXECUTE FUNCTION "public"."update_sales_order_timestamp"();


--
-- Name: fixed_assets fixed_assets_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "fixed_assets_updated_at" BEFORE UPDATE ON "public"."fixed_assets" FOR EACH ROW EXECUTE FUNCTION "public"."update_sales_order_timestamp"();


--
-- Name: journal_entries journal_entries_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "journal_entries_updated_at" BEFORE UPDATE ON "public"."journal_entries" FOR EACH ROW EXECUTE FUNCTION "public"."update_sales_order_timestamp"();


--
-- Name: journal_entry_items journal_entry_items_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "journal_entry_items_updated_at" BEFORE UPDATE ON "public"."journal_entry_items" FOR EACH ROW EXECUTE FUNCTION "public"."update_sales_order_timestamp"();


--
-- Name: payroll_runs payroll_runs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "payroll_runs_updated_at" BEFORE UPDATE ON "public"."payroll_runs" FOR EACH ROW EXECUTE FUNCTION "public"."update_sales_order_timestamp"();


--
-- Name: sales_contract_items sales_contract_items_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "sales_contract_items_updated_at" BEFORE UPDATE ON "public"."sales_contract_items" FOR EACH ROW EXECUTE FUNCTION "public"."update_sales_order_timestamp"();


--
-- Name: sales_contracts sales_contracts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "sales_contracts_updated_at" BEFORE UPDATE ON "public"."sales_contracts" FOR EACH ROW EXECUTE FUNCTION "public"."update_sales_order_timestamp"();


--
-- Name: sales_order_items sales_order_items_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "sales_order_items_updated_at" BEFORE UPDATE ON "public"."sales_order_items" FOR EACH ROW EXECUTE FUNCTION "public"."update_sales_order_timestamp"();


--
-- Name: sales_orders sales_orders_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "sales_orders_updated_at" BEFORE UPDATE ON "public"."sales_orders" FOR EACH ROW EXECUTE FUNCTION "public"."update_sales_order_timestamp"();


--
-- Name: sales_quotation_items sales_quotation_items_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "sales_quotation_items_updated_at" BEFORE UPDATE ON "public"."sales_quotation_items" FOR EACH ROW EXECUTE FUNCTION "public"."update_sales_order_timestamp"();


--
-- Name: sales_quotations sales_quotations_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "sales_quotations_updated_at" BEFORE UPDATE ON "public"."sales_quotations" FOR EACH ROW EXECUTE FUNCTION "public"."update_sales_order_timestamp"();


--
-- Name: supplier_invoices supplier_invoices_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "supplier_invoices_updated_at" BEFORE UPDATE ON "public"."supplier_invoices" FOR EACH ROW EXECUTE FUNCTION "public"."update_sales_order_timestamp"();


--
-- Name: supplier_payments supplier_payments_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "supplier_payments_updated_at" BEFORE UPDATE ON "public"."supplier_payments" FOR EACH ROW EXECUTE FUNCTION "public"."update_sales_order_timestamp"();


--
-- Name: chart_of_accounts trg_coa_sync_status_active; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trg_coa_sync_status_active" BEFORE INSERT OR UPDATE ON "public"."chart_of_accounts" FOR EACH ROW EXECUTE FUNCTION "public"."coa_sync_status_active"();


--
-- Name: journal_entries trg_guard_closed_period_posting; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trg_guard_closed_period_posting" BEFORE INSERT OR UPDATE ON "public"."journal_entries" FOR EACH ROW EXECUTE FUNCTION "public"."fn_guard_closed_period_posting"();


--
-- Name: companies trg_guard_company_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trg_guard_company_insert" BEFORE INSERT ON "public"."companies" FOR EACH ROW EXECUTE FUNCTION "public"."guard_company_insert"();


--
-- Name: chat_memory trigger_clean_chat_memory; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trigger_clean_chat_memory" AFTER INSERT ON "public"."chat_memory" FOR EACH ROW EXECUTE FUNCTION "public"."clean_chat_memory"();


--
-- Name: rfqs trigger_set_procurement_rfq_number; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trigger_set_procurement_rfq_number" BEFORE INSERT ON "public"."rfqs" FOR EACH ROW EXECUTE FUNCTION "public"."set_procurement_rfq_number"();


--
-- Name: warehouse_transactions trigger_set_warehouse_transaction_number; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trigger_set_warehouse_transaction_number" BEFORE INSERT OR UPDATE ON "public"."warehouse_transactions" FOR EACH ROW EXECUTE FUNCTION "public"."set_warehouse_transaction_number"();


--
-- Name: inventory_storage_mappings trigger_update_storage_capacity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trigger_update_storage_capacity" AFTER INSERT OR UPDATE ON "public"."inventory_storage_mappings" FOR EACH ROW EXECUTE FUNCTION "public"."update_storage_capacity"();


--
-- Name: inventory_storage_mappings trigger_update_storage_capacity_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trigger_update_storage_capacity_delete" AFTER DELETE ON "public"."inventory_storage_mappings" FOR EACH ROW EXECUTE FUNCTION "public"."update_storage_capacity_on_delete"();


--
-- Name: warehouse_transaction_items trigger_update_warehouse_transaction_item_timestamp; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trigger_update_warehouse_transaction_item_timestamp" BEFORE UPDATE ON "public"."warehouse_transaction_items" FOR EACH ROW EXECUTE FUNCTION "public"."update_warehouse_transaction_item_timestamp"();


--
-- Name: bins update_bins_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_bins_updated_at" BEFORE UPDATE ON "public"."bins" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: customers update_customers_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_customers_updated_at" BEFORE UPDATE ON "public"."customers" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: inventory_items update_inventory_items_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_inventory_items_updated_at" BEFORE UPDATE ON "public"."inventory_items" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: inventory_storage_mappings update_inventory_storage_mappings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_inventory_storage_mappings_updated_at" BEFORE UPDATE ON "public"."inventory_storage_mappings" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: items update_items_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_items_updated_at" BEFORE UPDATE ON "public"."items" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: sales_rfq_items update_sales_rfq_items_updated_at_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_sales_rfq_items_updated_at_trigger" BEFORE UPDATE ON "public"."sales_rfq_items" FOR EACH ROW EXECUTE FUNCTION "public"."update_sales_rfqs_updated_at"();


--
-- Name: sales_rfqs update_sales_rfqs_updated_at_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_sales_rfqs_updated_at_trigger" BEFORE UPDATE ON "public"."sales_rfqs" FOR EACH ROW EXECUTE FUNCTION "public"."update_sales_rfqs_updated_at"();


--
-- Name: storage_locations update_storage_locations_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_storage_locations_updated_at" BEFORE UPDATE ON "public"."storage_locations" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: users update_users_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_users_updated_at" BEFORE UPDATE ON "public"."users" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: accounting_periods accounting_periods_closed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."accounting_periods"
    ADD CONSTRAINT "accounting_periods_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id");


--
-- Name: accounting_periods accounting_periods_closing_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."accounting_periods"
    ADD CONSTRAINT "accounting_periods_closing_entry_id_fkey" FOREIGN KEY ("closing_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE SET NULL;


--
-- Name: activities activities_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."activities"
    ADD CONSTRAINT "activities_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id");


--
-- Name: activities activities_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."activities"
    ADD CONSTRAINT "activities_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: activities activities_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."activities"
    ADD CONSTRAINT "activities_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id");


--
-- Name: activities activities_deal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."activities"
    ADD CONSTRAINT "activities_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;


--
-- Name: activities activities_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."activities"
    ADD CONSTRAINT "activities_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id");


--
-- Name: activities activities_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."activities"
    ADD CONSTRAINT "activities_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id");


--
-- Name: agent_blueprint_versions agent_blueprint_versions_blueprint_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_blueprint_versions"
    ADD CONSTRAINT "agent_blueprint_versions_blueprint_id_fkey" FOREIGN KEY ("blueprint_id") REFERENCES "public"."agent_blueprints"("id") ON DELETE CASCADE;


--
-- Name: agent_blueprint_versions agent_blueprint_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_blueprint_versions"
    ADD CONSTRAINT "agent_blueprint_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: agent_blueprints agent_blueprints_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_blueprints"
    ADD CONSTRAINT "agent_blueprints_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: agent_blueprints agent_blueprints_credential_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_blueprints"
    ADD CONSTRAINT "agent_blueprints_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "public"."ai_credentials"("id");


--
-- Name: agent_blueprints agent_blueprints_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_blueprints"
    ADD CONSTRAINT "agent_blueprints_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");


--
-- Name: agent_credentials agent_credentials_credential_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_credentials"
    ADD CONSTRAINT "agent_credentials_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "public"."ai_credentials"("id") ON DELETE CASCADE;


--
-- Name: agent_credentials agent_credentials_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_credentials"
    ADD CONSTRAINT "agent_credentials_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id");


--
-- Name: agent_escalations agent_escalations_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_escalations"
    ADD CONSTRAINT "agent_escalations_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id");


--
-- Name: agent_escalations agent_escalations_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_escalations"
    ADD CONSTRAINT "agent_escalations_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE SET NULL;


--
-- Name: agent_memory agent_memory_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_memory"
    ADD CONSTRAINT "agent_memory_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE SET NULL;


--
-- Name: agent_run_actions agent_run_actions_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_run_actions"
    ADD CONSTRAINT "agent_run_actions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE CASCADE;


--
-- Name: agent_run_messages agent_run_messages_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_run_messages"
    ADD CONSTRAINT "agent_run_messages_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE CASCADE;


--
-- Name: agent_runs agent_runs_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_runs"
    ADD CONSTRAINT "agent_runs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agent_definitions"("id") ON DELETE CASCADE;


--
-- Name: agent_runs agent_runs_triggered_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_runs"
    ADD CONSTRAINT "agent_runs_triggered_by_fkey" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id");


--
-- Name: ai_audit_log ai_audit_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_audit_log"
    ADD CONSTRAINT "ai_audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id");


--
-- Name: ai_credentials ai_credentials_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_credentials"
    ADD CONSTRAINT "ai_credentials_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: ai_feedback ai_feedback_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_feedback"
    ADD CONSTRAINT "ai_feedback_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id");


--
-- Name: ai_finding_suppressions ai_finding_suppressions_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_finding_suppressions"
    ADD CONSTRAINT "ai_finding_suppressions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;


--
-- Name: ai_finding_suppressions ai_finding_suppressions_dismissed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_finding_suppressions"
    ADD CONSTRAINT "ai_finding_suppressions_dismissed_by_fkey" FOREIGN KEY ("dismissed_by") REFERENCES "public"."users"("id");


--
-- Name: ai_findings ai_findings_acknowledged_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_findings"
    ADD CONSTRAINT "ai_findings_acknowledged_by_fkey" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id");


--
-- Name: ai_findings ai_findings_proposed_journal_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_findings"
    ADD CONSTRAINT "ai_findings_proposed_journal_entry_id_fkey" FOREIGN KEY ("proposed_journal_entry_id") REFERENCES "public"."journal_entries"("id");


--
-- Name: ai_learned_preferences ai_learned_preferences_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_learned_preferences"
    ADD CONSTRAINT "ai_learned_preferences_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;


--
-- Name: ai_learned_preferences ai_learned_preferences_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_learned_preferences"
    ADD CONSTRAINT "ai_learned_preferences_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: ai_settings ai_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_settings"
    ADD CONSTRAINT "ai_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");


--
-- Name: ai_tool_settings ai_tool_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_tool_settings"
    ADD CONSTRAINT "ai_tool_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");


--
-- Name: ai_tool_versions ai_tool_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_tool_versions"
    ADD CONSTRAINT "ai_tool_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: ai_tool_versions ai_tool_versions_tool_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_tool_versions"
    ADD CONSTRAINT "ai_tool_versions_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "public"."ai_tools"("id") ON DELETE CASCADE;


--
-- Name: ai_tools ai_tools_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_tools"
    ADD CONSTRAINT "ai_tools_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: ai_tools ai_tools_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_tools"
    ADD CONSTRAINT "ai_tools_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");


--
-- Name: ai_usage_log ai_usage_log_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_usage_log"
    ADD CONSTRAINT "ai_usage_log_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE SET NULL;


--
-- Name: ai_usage_log ai_usage_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_usage_log"
    ADD CONSTRAINT "ai_usage_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id");


--
-- Name: api_keys api_keys_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "api_keys_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: api_keys api_keys_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "api_keys_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: approval_chain_steps approval_chain_steps_approver_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."approval_chain_steps"
    ADD CONSTRAINT "approval_chain_steps_approver_user_id_fkey" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id");


--
-- Name: approval_chain_steps approval_chain_steps_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."approval_chain_steps"
    ADD CONSTRAINT "approval_chain_steps_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "public"."approval_chain_templates"("id") ON DELETE CASCADE;


--
-- Name: approval_chain_templates approval_chain_templates_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."approval_chain_templates"
    ADD CONSTRAINT "approval_chain_templates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: approval_delegations approval_delegations_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."approval_delegations"
    ADD CONSTRAINT "approval_delegations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: approval_delegations approval_delegations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."approval_delegations"
    ADD CONSTRAINT "approval_delegations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: approval_delegations approval_delegations_delegate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."approval_delegations"
    ADD CONSTRAINT "approval_delegations_delegate_id_fkey" FOREIGN KEY ("delegate_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


--
-- Name: approval_delegations approval_delegations_delegator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."approval_delegations"
    ADD CONSTRAINT "approval_delegations_delegator_id_fkey" FOREIGN KEY ("delegator_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


--
-- Name: approval_request_steps approval_request_steps_approver_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."approval_request_steps"
    ADD CONSTRAINT "approval_request_steps_approver_user_id_fkey" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id");


--
-- Name: approval_request_steps approval_request_steps_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."approval_request_steps"
    ADD CONSTRAINT "approval_request_steps_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id");


--
-- Name: approval_request_steps approval_request_steps_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."approval_request_steps"
    ADD CONSTRAINT "approval_request_steps_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."approval_requests"("id") ON DELETE CASCADE;


--
-- Name: approval_requests approval_requests_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."approval_requests"
    ADD CONSTRAINT "approval_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id");


--
-- Name: approval_requests approval_requests_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."approval_requests"
    ADD CONSTRAINT "approval_requests_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "public"."approval_chain_templates"("id");


--
-- Name: attendance_records attendance_records_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."attendance_records"
    ADD CONSTRAINT "attendance_records_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id");


--
-- Name: audit_chain audit_chain_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."audit_chain"
    ADD CONSTRAINT "audit_chain_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: auto_purchase_orders auto_purchase_orders_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."auto_purchase_orders"
    ADD CONSTRAINT "auto_purchase_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: auto_purchase_orders auto_purchase_orders_delivery_schedule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."auto_purchase_orders"
    ADD CONSTRAINT "auto_purchase_orders_delivery_schedule_id_fkey" FOREIGN KEY ("delivery_schedule_id") REFERENCES "public"."delivery_schedules"("id");


--
-- Name: auto_purchase_orders auto_purchase_orders_purchase_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."auto_purchase_orders"
    ADD CONSTRAINT "auto_purchase_orders_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id");


--
-- Name: auto_purchase_orders auto_purchase_orders_sales_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."auto_purchase_orders"
    ADD CONSTRAINT "auto_purchase_orders_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id");


--
-- Name: auto_purchase_orders auto_purchase_orders_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."auto_purchase_orders"
    ADD CONSTRAINT "auto_purchase_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id");


--
-- Name: background_tasks background_tasks_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."background_tasks"
    ADD CONSTRAINT "background_tasks_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: bank_accounts bank_accounts_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bank_accounts"
    ADD CONSTRAINT "bank_accounts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: bank_accounts bank_accounts_gl_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bank_accounts"
    ADD CONSTRAINT "bank_accounts_gl_account_id_fkey" FOREIGN KEY ("gl_account_id") REFERENCES "public"."chart_of_accounts"("id");


--
-- Name: bank_accounts bank_accounts_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bank_accounts"
    ADD CONSTRAINT "bank_accounts_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");


--
-- Name: bank_transactions bank_transactions_bank_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bank_transactions"
    ADD CONSTRAINT "bank_transactions_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE CASCADE;


--
-- Name: bank_transactions bank_transactions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bank_transactions"
    ADD CONSTRAINT "bank_transactions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: bank_transactions bank_transactions_reconciled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bank_transactions"
    ADD CONSTRAINT "bank_transactions_reconciled_by_fkey" FOREIGN KEY ("reconciled_by") REFERENCES "public"."users"("id");


--
-- Name: bills_of_material bills_of_material_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bills_of_material"
    ADD CONSTRAINT "bills_of_material_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: bills_of_material bills_of_material_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bills_of_material"
    ADD CONSTRAINT "bills_of_material_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id");


--
-- Name: bins bins_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bins"
    ADD CONSTRAINT "bins_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id");


--
-- Name: bins bins_declined_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bins"
    ADD CONSTRAINT "bins_declined_by_fkey" FOREIGN KEY ("declined_by") REFERENCES "public"."users"("id");


--
-- Name: bins bins_storage_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bins"
    ADD CONSTRAINT "bins_storage_location_id_fkey" FOREIGN KEY ("storage_location_id") REFERENCES "public"."storage_locations"("id") ON DELETE CASCADE;


--
-- Name: bins bins_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bins"
    ADD CONSTRAINT "bins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


--
-- Name: bom_components bom_components_bom_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bom_components"
    ADD CONSTRAINT "bom_components_bom_id_fkey" FOREIGN KEY ("bom_id") REFERENCES "public"."bills_of_material"("id") ON DELETE CASCADE;


--
-- Name: bom_components bom_components_component_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bom_components"
    ADD CONSTRAINT "bom_components_component_item_id_fkey" FOREIGN KEY ("component_item_id") REFERENCES "public"."items"("id");


--
-- Name: bom_operations bom_operations_bom_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bom_operations"
    ADD CONSTRAINT "bom_operations_bom_id_fkey" FOREIGN KEY ("bom_id") REFERENCES "public"."bills_of_material"("id") ON DELETE CASCADE;


--
-- Name: bom_operations bom_operations_work_center_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bom_operations"
    ADD CONSTRAINT "bom_operations_work_center_id_fkey" FOREIGN KEY ("work_center_id") REFERENCES "public"."work_centers"("id");


--
-- Name: budget_lines budget_lines_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."budget_lines"
    ADD CONSTRAINT "budget_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."chart_of_accounts"("id");


--
-- Name: budget_lines budget_lines_budget_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."budget_lines"
    ADD CONSTRAINT "budget_lines_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE CASCADE;


--
-- Name: budget_lines budget_lines_cost_center_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."budget_lines"
    ADD CONSTRAINT "budget_lines_cost_center_id_fkey" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_centers"("id");


--
-- Name: budgets budgets_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."budgets"
    ADD CONSTRAINT "budgets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: budgets budgets_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."budgets"
    ADD CONSTRAINT "budgets_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");


--
-- Name: business_type_default_modules business_type_default_modules_business_type_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."business_type_default_modules"
    ADD CONSTRAINT "business_type_default_modules_business_type_code_fkey" FOREIGN KEY ("business_type_code") REFERENCES "public"."business_types"("code") ON DELETE CASCADE;


--
-- Name: business_type_default_modules business_type_default_modules_module_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."business_type_default_modules"
    ADD CONSTRAINT "business_type_default_modules_module_key_fkey" FOREIGN KEY ("module_key") REFERENCES "public"."modules"("key") ON DELETE CASCADE;


--
-- Name: chart_of_accounts chart_of_accounts_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."chart_of_accounts"
    ADD CONSTRAINT "chart_of_accounts_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id");


--
-- Name: chart_of_accounts chart_of_accounts_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."chart_of_accounts"
    ADD CONSTRAINT "chart_of_accounts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: chart_of_accounts chart_of_accounts_parent_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."chart_of_accounts"
    ADD CONSTRAINT "chart_of_accounts_parent_account_id_fkey" FOREIGN KEY ("parent_account_id") REFERENCES "public"."chart_of_accounts"("id");


--
-- Name: chart_of_accounts_status_history chart_of_accounts_status_history_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."chart_of_accounts_status_history"
    ADD CONSTRAINT "chart_of_accounts_status_history_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE CASCADE;


--
-- Name: chart_of_accounts_status_history chart_of_accounts_status_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."chart_of_accounts_status_history"
    ADD CONSTRAINT "chart_of_accounts_status_history_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id");


--
-- Name: chart_of_accounts chart_of_accounts_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."chart_of_accounts"
    ADD CONSTRAINT "chart_of_accounts_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");


--
-- Name: companies companies_base_currency_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."companies"
    ADD CONSTRAINT "companies_base_currency_fkey" FOREIGN KEY ("base_currency") REFERENCES "public"."currencies"("code");


--
-- Name: companies companies_business_type_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."companies"
    ADD CONSTRAINT "companies_business_type_code_fkey" FOREIGN KEY ("business_type_code") REFERENCES "public"."business_types"("code");


--
-- Name: companies companies_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."companies"
    ADD CONSTRAINT "companies_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: companies companies_parent_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."companies"
    ADD CONSTRAINT "companies_parent_company_id_fkey" FOREIGN KEY ("parent_company_id") REFERENCES "public"."companies"("id");


--
-- Name: company_gl_mappings company_gl_mappings_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."company_gl_mappings"
    ADD CONSTRAINT "company_gl_mappings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;


--
-- Name: company_modules company_modules_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."company_modules"
    ADD CONSTRAINT "company_modules_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;


--
-- Name: company_modules company_modules_module_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."company_modules"
    ADD CONSTRAINT "company_modules_module_key_fkey" FOREIGN KEY ("module_key") REFERENCES "public"."modules"("key") ON DELETE CASCADE;


--
-- Name: company_subscriptions company_subscriptions_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."company_subscriptions"
    ADD CONSTRAINT "company_subscriptions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;


--
-- Name: company_subscriptions company_subscriptions_plan_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."company_subscriptions"
    ADD CONSTRAINT "company_subscriptions_plan_code_fkey" FOREIGN KEY ("plan_code") REFERENCES "public"."plans"("code");


--
-- Name: connector_oauth_pending connector_oauth_pending_connector_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."connector_oauth_pending"
    ADD CONSTRAINT "connector_oauth_pending_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE CASCADE;


--
-- Name: connectors connectors_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."connectors"
    ADD CONSTRAINT "connectors_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: contacts contacts_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: contacts contacts_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id");


--
-- Name: contacts contacts_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id");


--
-- Name: contract_items contract_items_amendment_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contract_items"
    ADD CONSTRAINT "contract_items_amendment_requested_by_fkey" FOREIGN KEY ("amendment_requested_by") REFERENCES "public"."users"("id");


--
-- Name: contract_items contract_items_company_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contract_items"
    ADD CONSTRAINT "contract_items_company_approved_by_fkey" FOREIGN KEY ("company_approved_by") REFERENCES "public"."users"("id");


--
-- Name: contract_items contract_items_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contract_items"
    ADD CONSTRAINT "contract_items_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE CASCADE;


--
-- Name: contract_items contract_items_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contract_items"
    ADD CONSTRAINT "contract_items_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: contract_items contract_items_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contract_items"
    ADD CONSTRAINT "contract_items_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE RESTRICT;


--
-- Name: contract_items contract_items_supplier_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contract_items"
    ADD CONSTRAINT "contract_items_supplier_approved_by_fkey" FOREIGN KEY ("supplier_approved_by") REFERENCES "public"."users"("id");


--
-- Name: contracts contracts_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contracts"
    ADD CONSTRAINT "contracts_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id");


--
-- Name: contracts contracts_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contracts"
    ADD CONSTRAINT "contracts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: contracts contracts_signed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contracts"
    ADD CONSTRAINT "contracts_signed_by_fkey" FOREIGN KEY ("signed_by") REFERENCES "public"."users"("id");


--
-- Name: contracts contracts_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contracts"
    ADD CONSTRAINT "contracts_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE RESTRICT;


--
-- Name: contracts contracts_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contracts"
    ADD CONSTRAINT "contracts_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id");


--
-- Name: conversation_messages conversation_messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."conversation_messages"
    ADD CONSTRAINT "conversation_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;


--
-- Name: conversations conversations_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: conversations conversations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id");


--
-- Name: cost_centers cost_centers_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cost_centers"
    ADD CONSTRAINT "cost_centers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: cost_centers cost_centers_manager_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cost_centers"
    ADD CONSTRAINT "cost_centers_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id");


--
-- Name: cost_centers cost_centers_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cost_centers"
    ADD CONSTRAINT "cost_centers_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");


--
-- Name: cost_layers cost_layers_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cost_layers"
    ADD CONSTRAINT "cost_layers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: cost_layers cost_layers_inventory_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cost_layers"
    ADD CONSTRAINT "cost_layers_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE CASCADE;


--
-- Name: cost_layers cost_layers_receipt_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cost_layers"
    ADD CONSTRAINT "cost_layers_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE SET NULL;


--
-- Name: cost_layers cost_layers_warehouse_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cost_layers"
    ADD CONSTRAINT "cost_layers_warehouse_transaction_id_fkey" FOREIGN KEY ("warehouse_transaction_id") REFERENCES "public"."warehouse_transactions"("id") ON DELETE SET NULL;


--
-- Name: customer_audit_log customer_audit_log_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_audit_log"
    ADD CONSTRAINT "customer_audit_log_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id");


--
-- Name: customer_audit_log customer_audit_log_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_audit_log"
    ADD CONSTRAINT "customer_audit_log_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: customer_invoice_items customer_invoice_items_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_invoice_items"
    ADD CONSTRAINT "customer_invoice_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."customer_invoices"("id") ON DELETE CASCADE;


--
-- Name: customer_invoice_status_history customer_invoice_status_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_invoice_status_history"
    ADD CONSTRAINT "customer_invoice_status_history_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id");


--
-- Name: customer_invoice_status_history customer_invoice_status_history_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_invoice_status_history"
    ADD CONSTRAINT "customer_invoice_status_history_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."customer_invoices"("id") ON DELETE CASCADE;


--
-- Name: customer_invoices customer_invoices_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_invoices"
    ADD CONSTRAINT "customer_invoices_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: customer_invoices customer_invoices_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_invoices"
    ADD CONSTRAINT "customer_invoices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id");


--
-- Name: customer_invoices customer_invoices_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_invoices"
    ADD CONSTRAINT "customer_invoices_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id");


--
-- Name: customer_invoices customer_invoices_journal_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_invoices"
    ADD CONSTRAINT "customer_invoices_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id");


--
-- Name: customer_invoices customer_invoices_recurring_schedule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_invoices"
    ADD CONSTRAINT "customer_invoices_recurring_schedule_id_fkey" FOREIGN KEY ("recurring_schedule_id") REFERENCES "public"."recurring_invoice_schedules"("id");


--
-- Name: customer_invoices customer_invoices_sales_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_invoices"
    ADD CONSTRAINT "customer_invoices_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id");


--
-- Name: customer_invoices customer_invoices_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_invoices"
    ADD CONSTRAINT "customer_invoices_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");


--
-- Name: customer_payment_allocations customer_payment_allocations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_payment_allocations"
    ADD CONSTRAINT "customer_payment_allocations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: customer_payment_allocations customer_payment_allocations_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_payment_allocations"
    ADD CONSTRAINT "customer_payment_allocations_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."customer_invoices"("id");


--
-- Name: customer_payment_allocations customer_payment_allocations_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_payment_allocations"
    ADD CONSTRAINT "customer_payment_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."customer_payments"("id") ON DELETE CASCADE;


--
-- Name: customer_payment_status_history customer_payment_status_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_payment_status_history"
    ADD CONSTRAINT "customer_payment_status_history_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id");


--
-- Name: customer_payment_status_history customer_payment_status_history_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_payment_status_history"
    ADD CONSTRAINT "customer_payment_status_history_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."customer_payments"("id") ON DELETE CASCADE;


--
-- Name: customer_payments customer_payments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_payments"
    ADD CONSTRAINT "customer_payments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: customer_payments customer_payments_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_payments"
    ADD CONSTRAINT "customer_payments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id");


--
-- Name: customer_payments customer_payments_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_payments"
    ADD CONSTRAINT "customer_payments_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id");


--
-- Name: customer_payments customer_payments_journal_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_payments"
    ADD CONSTRAINT "customer_payments_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id");


--
-- Name: customer_payments customer_payments_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_payments"
    ADD CONSTRAINT "customer_payments_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");


--
-- Name: customers customers_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: customers customers_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id");


--
-- Name: customers customers_sales_rep_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_sales_rep_id_fkey" FOREIGN KEY ("sales_rep_id") REFERENCES "public"."users"("id");


--
-- Name: customers customers_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");


--
-- Name: dashboard_widgets dashboard_widgets_dashboard_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."dashboard_widgets"
    ADD CONSTRAINT "dashboard_widgets_dashboard_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "public"."dashboards"("id") ON DELETE CASCADE;


--
-- Name: dashboard_widgets dashboard_widgets_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."dashboard_widgets"
    ADD CONSTRAINT "dashboard_widgets_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "public"."report_definitions"("id") ON DELETE CASCADE;


--
-- Name: dashboards dashboards_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."dashboards"
    ADD CONSTRAINT "dashboards_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: dashboards dashboards_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."dashboards"
    ADD CONSTRAINT "dashboards_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: dashboards dashboards_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."dashboards"
    ADD CONSTRAINT "dashboards_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id");


--
-- Name: deals deals_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."deals"
    ADD CONSTRAINT "deals_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id");


--
-- Name: deals deals_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."deals"
    ADD CONSTRAINT "deals_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: deals deals_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."deals"
    ADD CONSTRAINT "deals_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id");


--
-- Name: deals deals_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."deals"
    ADD CONSTRAINT "deals_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id");


--
-- Name: deals deals_sales_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."deals"
    ADD CONSTRAINT "deals_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id");


--
-- Name: delegation_of_authority delegation_of_authority_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delegation_of_authority"
    ADD CONSTRAINT "delegation_of_authority_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: delegation_of_authority delegation_of_authority_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delegation_of_authority"
    ADD CONSTRAINT "delegation_of_authority_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


--
-- Name: delivery_exceptions delivery_exceptions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_exceptions"
    ADD CONSTRAINT "delivery_exceptions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: delivery_exceptions delivery_exceptions_delivery_schedule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_exceptions"
    ADD CONSTRAINT "delivery_exceptions_delivery_schedule_id_fkey" FOREIGN KEY ("delivery_schedule_id") REFERENCES "public"."delivery_schedules"("id");


--
-- Name: delivery_exceptions delivery_exceptions_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_exceptions"
    ADD CONSTRAINT "delivery_exceptions_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id");


--
-- Name: delivery_exceptions delivery_exceptions_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_exceptions"
    ADD CONSTRAINT "delivery_exceptions_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");


--
-- Name: delivery_items delivery_items_delivery_schedule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_items"
    ADD CONSTRAINT "delivery_items_delivery_schedule_id_fkey" FOREIGN KEY ("delivery_schedule_id") REFERENCES "public"."delivery_schedules"("id") ON DELETE CASCADE;


--
-- Name: delivery_items delivery_items_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_items"
    ADD CONSTRAINT "delivery_items_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id");


--
-- Name: delivery_route_stops delivery_route_stops_delivery_route_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_route_stops"
    ADD CONSTRAINT "delivery_route_stops_delivery_route_id_fkey" FOREIGN KEY ("delivery_route_id") REFERENCES "public"."delivery_routes"("id") ON DELETE CASCADE;


--
-- Name: delivery_route_stops delivery_route_stops_delivery_schedule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_route_stops"
    ADD CONSTRAINT "delivery_route_stops_delivery_schedule_id_fkey" FOREIGN KEY ("delivery_schedule_id") REFERENCES "public"."delivery_schedules"("id");


--
-- Name: delivery_routes delivery_routes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_routes"
    ADD CONSTRAINT "delivery_routes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: delivery_routes delivery_routes_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_routes"
    ADD CONSTRAINT "delivery_routes_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");


--
-- Name: delivery_schedules delivery_schedules_auto_purchase_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_schedules"
    ADD CONSTRAINT "delivery_schedules_auto_purchase_order_id_fkey" FOREIGN KEY ("auto_purchase_order_id") REFERENCES "public"."purchase_orders"("id");


--
-- Name: delivery_schedules delivery_schedules_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_schedules"
    ADD CONSTRAINT "delivery_schedules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: delivery_schedules delivery_schedules_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_schedules"
    ADD CONSTRAINT "delivery_schedules_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id");


--
-- Name: delivery_schedules delivery_schedules_postponed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_schedules"
    ADD CONSTRAINT "delivery_schedules_postponed_by_fkey" FOREIGN KEY ("postponed_by") REFERENCES "public"."users"("id");


--
-- Name: delivery_schedules delivery_schedules_sales_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_schedules"
    ADD CONSTRAINT "delivery_schedules_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id");


--
-- Name: delivery_schedules delivery_schedules_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_schedules"
    ADD CONSTRAINT "delivery_schedules_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id");


--
-- Name: delivery_schedules delivery_schedules_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_schedules"
    ADD CONSTRAINT "delivery_schedules_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");


--
-- Name: delivery_status_history delivery_status_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_status_history"
    ADD CONSTRAINT "delivery_status_history_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id");


--
-- Name: delivery_status_history delivery_status_history_delivery_schedule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_status_history"
    ADD CONSTRAINT "delivery_status_history_delivery_schedule_id_fkey" FOREIGN KEY ("delivery_schedule_id") REFERENCES "public"."delivery_schedules"("id") ON DELETE CASCADE;


--
-- Name: email_verification_tokens email_verification_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."email_verification_tokens"
    ADD CONSTRAINT "email_verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


--
-- Name: employees employees_cost_center_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."employees"
    ADD CONSTRAINT "employees_cost_center_id_fkey" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_centers"("id");


--
-- Name: employees employees_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."employees"
    ADD CONSTRAINT "employees_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: employees employees_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."employees"
    ADD CONSTRAINT "employees_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");


--
-- Name: employees employees_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."employees"
    ADD CONSTRAINT "employees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id");


--
-- Name: exchange_rates exchange_rates_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."exchange_rates"
    ADD CONSTRAINT "exchange_rates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: exchange_rates exchange_rates_from_currency_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."exchange_rates"
    ADD CONSTRAINT "exchange_rates_from_currency_fkey" FOREIGN KEY ("from_currency") REFERENCES "public"."currencies"("code");


--
-- Name: exchange_rates exchange_rates_to_currency_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."exchange_rates"
    ADD CONSTRAINT "exchange_rates_to_currency_fkey" FOREIGN KEY ("to_currency") REFERENCES "public"."currencies"("code");


--
-- Name: fixed_asset_depreciation fixed_asset_depreciation_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."fixed_asset_depreciation"
    ADD CONSTRAINT "fixed_asset_depreciation_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."fixed_assets"("id") ON DELETE CASCADE;


--
-- Name: fixed_asset_depreciation fixed_asset_depreciation_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."fixed_asset_depreciation"
    ADD CONSTRAINT "fixed_asset_depreciation_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: fixed_asset_depreciation fixed_asset_depreciation_journal_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."fixed_asset_depreciation"
    ADD CONSTRAINT "fixed_asset_depreciation_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id");


--
-- Name: fixed_asset_revaluations fixed_asset_revaluations_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."fixed_asset_revaluations"
    ADD CONSTRAINT "fixed_asset_revaluations_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."fixed_assets"("id") ON DELETE CASCADE;


--
-- Name: fixed_asset_revaluations fixed_asset_revaluations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."fixed_asset_revaluations"
    ADD CONSTRAINT "fixed_asset_revaluations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: fixed_asset_revaluations fixed_asset_revaluations_journal_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."fixed_asset_revaluations"
    ADD CONSTRAINT "fixed_asset_revaluations_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id");


--
-- Name: fixed_assets fixed_assets_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."fixed_assets"
    ADD CONSTRAINT "fixed_assets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: fixed_assets fixed_assets_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."fixed_assets"
    ADD CONSTRAINT "fixed_assets_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id");


--
-- Name: fixed_assets fixed_assets_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."fixed_assets"
    ADD CONSTRAINT "fixed_assets_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id");


--
-- Name: fixed_assets fixed_assets_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."fixed_assets"
    ADD CONSTRAINT "fixed_assets_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");


--
-- Name: accounting_periods fk_accounting_periods_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."accounting_periods"
    ADD CONSTRAINT "fk_accounting_periods_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: activities fk_activities_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."activities"
    ADD CONSTRAINT "fk_activities_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: agent_blueprints fk_agent_blueprints_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_blueprints"
    ADD CONSTRAINT "fk_agent_blueprints_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: agent_credentials fk_agent_credentials_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_credentials"
    ADD CONSTRAINT "fk_agent_credentials_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: agent_definitions fk_agent_definitions_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_definitions"
    ADD CONSTRAINT "fk_agent_definitions_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: agent_escalations fk_agent_escalations_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_escalations"
    ADD CONSTRAINT "fk_agent_escalations_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: agent_memory fk_agent_memory_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_memory"
    ADD CONSTRAINT "fk_agent_memory_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: agent_paused_runs fk_agent_paused_runs_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_paused_runs"
    ADD CONSTRAINT "fk_agent_paused_runs_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: agent_runs fk_agent_runs_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."agent_runs"
    ADD CONSTRAINT "fk_agent_runs_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: ai_audit_log fk_ai_audit_log_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_audit_log"
    ADD CONSTRAINT "fk_ai_audit_log_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: ai_credentials fk_ai_credentials_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_credentials"
    ADD CONSTRAINT "fk_ai_credentials_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: ai_feedback fk_ai_feedback_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_feedback"
    ADD CONSTRAINT "fk_ai_feedback_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: ai_findings fk_ai_findings_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_findings"
    ADD CONSTRAINT "fk_ai_findings_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: ai_settings fk_ai_settings_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_settings"
    ADD CONSTRAINT "fk_ai_settings_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;


--
-- Name: ai_tool_settings fk_ai_tool_settings_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_tool_settings"
    ADD CONSTRAINT "fk_ai_tool_settings_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: ai_tool_versions fk_ai_tool_versions_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_tool_versions"
    ADD CONSTRAINT "fk_ai_tool_versions_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: ai_tools fk_ai_tools_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_tools"
    ADD CONSTRAINT "fk_ai_tools_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: ai_usage_log fk_ai_usage_log_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_usage_log"
    ADD CONSTRAINT "fk_ai_usage_log_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: api_keys fk_api_keys_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "fk_api_keys_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: approval_chain_templates fk_approval_chain_templates_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."approval_chain_templates"
    ADD CONSTRAINT "fk_approval_chain_templates_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: approval_requests fk_approval_requests_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."approval_requests"
    ADD CONSTRAINT "fk_approval_requests_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: auto_purchase_orders fk_auto_purchase_orders_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."auto_purchase_orders"
    ADD CONSTRAINT "fk_auto_purchase_orders_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: background_tasks fk_background_tasks_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."background_tasks"
    ADD CONSTRAINT "fk_background_tasks_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: bank_accounts fk_bank_accounts_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bank_accounts"
    ADD CONSTRAINT "fk_bank_accounts_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: bank_transactions fk_bank_transactions_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bank_transactions"
    ADD CONSTRAINT "fk_bank_transactions_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: bills_of_material fk_bills_of_material_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bills_of_material"
    ADD CONSTRAINT "fk_bills_of_material_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: bins fk_bins_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bins"
    ADD CONSTRAINT "fk_bins_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: budgets fk_budgets_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."budgets"
    ADD CONSTRAINT "fk_budgets_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: chart_of_accounts fk_chart_of_accounts_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."chart_of_accounts"
    ADD CONSTRAINT "fk_chart_of_accounts_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: chat_memory fk_chat_memory_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."chat_memory"
    ADD CONSTRAINT "fk_chat_memory_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: connectors fk_connectors_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."connectors"
    ADD CONSTRAINT "fk_connectors_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: contacts fk_contacts_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "fk_contacts_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: contracts fk_contracts_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contracts"
    ADD CONSTRAINT "fk_contracts_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: conversations fk_conversations_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "fk_conversations_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: cost_centers fk_cost_centers_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cost_centers"
    ADD CONSTRAINT "fk_cost_centers_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: customer_invoices fk_customer_invoices_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_invoices"
    ADD CONSTRAINT "fk_customer_invoices_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: customer_payments fk_customer_payments_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_payments"
    ADD CONSTRAINT "fk_customer_payments_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: customers fk_customers_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "fk_customers_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: dashboards fk_dashboards_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."dashboards"
    ADD CONSTRAINT "fk_dashboards_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: deals fk_deals_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."deals"
    ADD CONSTRAINT "fk_deals_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: delegation_of_authority fk_delegation_of_authority_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delegation_of_authority"
    ADD CONSTRAINT "fk_delegation_of_authority_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: delivery_routes fk_delivery_routes_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_routes"
    ADD CONSTRAINT "fk_delivery_routes_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: delivery_schedules fk_delivery_schedules_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."delivery_schedules"
    ADD CONSTRAINT "fk_delivery_schedules_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: document_embeddings fk_document_embeddings_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."document_embeddings"
    ADD CONSTRAINT "fk_document_embeddings_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: employees fk_employees_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."employees"
    ADD CONSTRAINT "fk_employees_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: fixed_assets fk_fixed_assets_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."fixed_assets"
    ADD CONSTRAINT "fk_fixed_assets_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: generated_documents fk_generated_documents_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."generated_documents"
    ADD CONSTRAINT "fk_generated_documents_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: goods_receipts fk_goods_receipts_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."goods_receipts"
    ADD CONSTRAINT "fk_goods_receipts_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: inventory_items fk_inventory_items_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."inventory_items"
    ADD CONSTRAINT "fk_inventory_items_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: inventory_transfers fk_inventory_transfers_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."inventory_transfers"
    ADD CONSTRAINT "fk_inventory_transfers_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: items fk_items_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."items"
    ADD CONSTRAINT "fk_items_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: journal_entries fk_journal_entries_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."journal_entries"
    ADD CONSTRAINT "fk_journal_entries_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: journal_entry_items fk_journal_entry_items_project; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."journal_entry_items"
    ADD CONSTRAINT "fk_journal_entry_items_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id");


--
-- Name: leads fk_leads_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "fk_leads_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: mcp_connections fk_mcp_connections_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."mcp_connections"
    ADD CONSTRAINT "fk_mcp_connections_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: mcp_oauth_grants fk_mcp_oauth_grants_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."mcp_oauth_grants"
    ADD CONSTRAINT "fk_mcp_oauth_grants_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: mrp_planned_orders fk_mrp_planned_orders_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."mrp_planned_orders"
    ADD CONSTRAINT "fk_mrp_planned_orders_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: notifications fk_notifications_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "fk_notifications_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: payroll_runs fk_payroll_runs_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payroll_runs"
    ADD CONSTRAINT "fk_payroll_runs_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: pdf_templates fk_pdf_templates_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."pdf_templates"
    ADD CONSTRAINT "fk_pdf_templates_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: purchase_orders fk_po_sales_order; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "fk_po_sales_order" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id");


--
-- Name: purchase_orders fk_po_sales_rfq; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "fk_po_sales_rfq" FOREIGN KEY ("sales_rfq_id") REFERENCES "public"."sales_rfqs"("id");


--
-- Name: projects fk_projects_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "fk_projects_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: purchase_orders fk_purchase_orders_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "fk_purchase_orders_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: purchase_requisitions fk_purchase_requisitions_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."purchase_requisitions"
    ADD CONSTRAINT "fk_purchase_requisitions_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: recurring_invoice_schedules fk_recurring_invoice_schedules_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."recurring_invoice_schedules"
    ADD CONSTRAINT "fk_recurring_invoice_schedules_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: report_definitions fk_report_definitions_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."report_definitions"
    ADD CONSTRAINT "fk_report_definitions_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: report_schedules fk_report_schedules_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."report_schedules"
    ADD CONSTRAINT "fk_report_schedules_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: request_for_quotations fk_request_for_quotations_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."request_for_quotations"
    ADD CONSTRAINT "fk_request_for_quotations_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: rfqs fk_rfqs_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."rfqs"
    ADD CONSTRAINT "fk_rfqs_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: sales_contracts fk_sales_contracts_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_contracts"
    ADD CONSTRAINT "fk_sales_contracts_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: sales_credit_notes fk_sales_credit_notes_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_credit_notes"
    ADD CONSTRAINT "fk_sales_credit_notes_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: sales_orders fk_sales_orders_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_orders"
    ADD CONSTRAINT "fk_sales_orders_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: sales_quotations fk_sales_quotations_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_quotations"
    ADD CONSTRAINT "fk_sales_quotations_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: sales_rfqs fk_sales_rfqs_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_rfqs"
    ADD CONSTRAINT "fk_sales_rfqs_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: stocktake_sheets fk_stocktake_sheets_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."stocktake_sheets"
    ADD CONSTRAINT "fk_stocktake_sheets_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: storage_locations fk_storage_locations_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."storage_locations"
    ADD CONSTRAINT "fk_storage_locations_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: supplier_debit_notes fk_supplier_debit_notes_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_debit_notes"
    ADD CONSTRAINT "fk_supplier_debit_notes_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: supplier_invoices fk_supplier_invoices_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_invoices"
    ADD CONSTRAINT "fk_supplier_invoices_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: supplier_items fk_supplier_items_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_items"
    ADD CONSTRAINT "fk_supplier_items_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: supplier_payments fk_supplier_payments_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_payments"
    ADD CONSTRAINT "fk_supplier_payments_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: suppliers fk_suppliers_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."suppliers"
    ADD CONSTRAINT "fk_suppliers_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: time_entries fk_time_entries_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "fk_time_entries_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: warehouse_transactions fk_warehouse_transactions_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."warehouse_transactions"
    ADD CONSTRAINT "fk_warehouse_transactions_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: webhook_subscriptions fk_webhook_subscriptions_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."webhook_subscriptions"
    ADD CONSTRAINT "fk_webhook_subscriptions_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: work_centers fk_work_centers_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_centers"
    ADD CONSTRAINT "fk_work_centers_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: work_orders fk_work_orders_company; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "fk_work_orders_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: generated_documents generated_documents_agent_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."generated_documents"
    ADD CONSTRAINT "generated_documents_agent_run_id_fkey" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE SET NULL;


--
-- Name: generated_documents generated_documents_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."generated_documents"
    ADD CONSTRAINT "generated_documents_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: generated_documents generated_documents_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."generated_documents"
    ADD CONSTRAINT "generated_documents_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: goods_receipts goods_receipts_bin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."goods_receipts"
    ADD CONSTRAINT "goods_receipts_bin_id_fkey" FOREIGN KEY ("bin_id") REFERENCES "public"."bins"("id");


--
-- Name: goods_receipts goods_receipts_po_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."goods_receipts"
    ADD CONSTRAINT "goods_receipts_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE CASCADE;


--
-- Name: goods_receipts goods_receipts_po_line_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."goods_receipts"
    ADD CONSTRAINT "goods_receipts_po_line_item_id_fkey" FOREIGN KEY ("po_line_item_id") REFERENCES "public"."purchase_order_line_items"("id") ON DELETE CASCADE;


--
-- Name: goods_receipts goods_receipts_received_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."goods_receipts"
    ADD CONSTRAINT "goods_receipts_received_by_fkey" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id");


--
-- Name: goods_receipts goods_receipts_storage_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."goods_receipts"
    ADD CONSTRAINT "goods_receipts_storage_location_id_fkey" FOREIGN KEY ("storage_location_id") REFERENCES "public"."storage_locations"("id");


--
-- Name: intercompany_transactions intercompany_transactions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."intercompany_transactions"
    ADD CONSTRAINT "intercompany_transactions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: intercompany_transactions intercompany_transactions_from_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."intercompany_transactions"
    ADD CONSTRAINT "intercompany_transactions_from_company_id_fkey" FOREIGN KEY ("from_company_id") REFERENCES "public"."companies"("id");


--
-- Name: intercompany_transactions intercompany_transactions_from_journal_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."intercompany_transactions"
    ADD CONSTRAINT "intercompany_transactions_from_journal_entry_id_fkey" FOREIGN KEY ("from_journal_entry_id") REFERENCES "public"."journal_entries"("id");


--
-- Name: intercompany_transactions intercompany_transactions_to_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."intercompany_transactions"
    ADD CONSTRAINT "intercompany_transactions_to_company_id_fkey" FOREIGN KEY ("to_company_id") REFERENCES "public"."companies"("id");


--
-- Name: intercompany_transactions intercompany_transactions_to_journal_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."intercompany_transactions"
    ADD CONSTRAINT "intercompany_transactions_to_journal_entry_id_fkey" FOREIGN KEY ("to_journal_entry_id") REFERENCES "public"."journal_entries"("id");


--
-- Name: inventory_items inventory_items_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."inventory_items"
    ADD CONSTRAINT "inventory_items_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;


--
-- Name: inventory_items inventory_items_item_master_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."inventory_items"
    ADD CONSTRAINT "inventory_items_item_master_id_fkey" FOREIGN KEY ("item_master_id") REFERENCES "public"."items"("id") ON DELETE CASCADE;


--
-- Name: inventory_items inventory_items_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."inventory_items"
    ADD CONSTRAINT "inventory_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


--
-- Name: inventory_storage_mappings inventory_storage_mappings_bin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."inventory_storage_mappings"
    ADD CONSTRAINT "inventory_storage_mappings_bin_id_fkey" FOREIGN KEY ("bin_id") REFERENCES "public"."bins"("id") ON DELETE SET NULL;


--
-- Name: inventory_storage_mappings inventory_storage_mappings_inventory_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."inventory_storage_mappings"
    ADD CONSTRAINT "inventory_storage_mappings_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE CASCADE;


--
-- Name: inventory_storage_mappings inventory_storage_mappings_storage_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."inventory_storage_mappings"
    ADD CONSTRAINT "inventory_storage_mappings_storage_location_id_fkey" FOREIGN KEY ("storage_location_id") REFERENCES "public"."storage_locations"("id") ON DELETE CASCADE;


--
-- Name: inventory_storage_mappings inventory_storage_mappings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."inventory_storage_mappings"
    ADD CONSTRAINT "inventory_storage_mappings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


--
-- Name: inventory_transfers inventory_transfers_cancelled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."inventory_transfers"
    ADD CONSTRAINT "inventory_transfers_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id");


--
-- Name: inventory_transfers inventory_transfers_destination_bin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."inventory_transfers"
    ADD CONSTRAINT "inventory_transfers_destination_bin_id_fkey" FOREIGN KEY ("destination_bin_id") REFERENCES "public"."bins"("id");


--
-- Name: inventory_transfers inventory_transfers_destination_storage_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."inventory_transfers"
    ADD CONSTRAINT "inventory_transfers_destination_storage_location_id_fkey" FOREIGN KEY ("destination_storage_location_id") REFERENCES "public"."storage_locations"("id");


--
-- Name: inventory_transfers inventory_transfers_dispatched_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."inventory_transfers"
    ADD CONSTRAINT "inventory_transfers_dispatched_by_fkey" FOREIGN KEY ("dispatched_by") REFERENCES "public"."users"("id");


--
-- Name: inventory_transfers inventory_transfers_inventory_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."inventory_transfers"
    ADD CONSTRAINT "inventory_transfers_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id");


--
-- Name: inventory_transfers inventory_transfers_received_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."inventory_transfers"
    ADD CONSTRAINT "inventory_transfers_received_by_fkey" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id");


--
-- Name: inventory_transfers inventory_transfers_source_bin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."inventory_transfers"
    ADD CONSTRAINT "inventory_transfers_source_bin_id_fkey" FOREIGN KEY ("source_bin_id") REFERENCES "public"."bins"("id");


--
-- Name: inventory_transfers inventory_transfers_source_storage_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."inventory_transfers"
    ADD CONSTRAINT "inventory_transfers_source_storage_location_id_fkey" FOREIGN KEY ("source_storage_location_id") REFERENCES "public"."storage_locations"("id");


--
-- Name: items items_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."items"
    ADD CONSTRAINT "items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


--
-- Name: journal_entries journal_entries_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."journal_entries"
    ADD CONSTRAINT "journal_entries_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id");


--
-- Name: journal_entries journal_entries_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."journal_entries"
    ADD CONSTRAINT "journal_entries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: journal_entries journal_entries_original_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."journal_entries"
    ADD CONSTRAINT "journal_entries_original_entry_id_fkey" FOREIGN KEY ("original_entry_id") REFERENCES "public"."journal_entries"("id");


--
-- Name: journal_entries journal_entries_posted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."journal_entries"
    ADD CONSTRAINT "journal_entries_posted_by_fkey" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id");


--
-- Name: journal_entries journal_entries_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."journal_entries"
    ADD CONSTRAINT "journal_entries_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");


--
-- Name: journal_entry_items journal_entry_items_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."journal_entry_items"
    ADD CONSTRAINT "journal_entry_items_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."chart_of_accounts"("id");


--
-- Name: journal_entry_items journal_entry_items_journal_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."journal_entry_items"
    ADD CONSTRAINT "journal_entry_items_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE CASCADE;


--
-- Name: journal_entry_status_history journal_entry_status_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."journal_entry_status_history"
    ADD CONSTRAINT "journal_entry_status_history_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id");


--
-- Name: journal_entry_status_history journal_entry_status_history_journal_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."journal_entry_status_history"
    ADD CONSTRAINT "journal_entry_status_history_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE CASCADE;


--
-- Name: kb_documents kb_documents_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."kb_documents"
    ADD CONSTRAINT "kb_documents_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;


--
-- Name: kb_documents kb_documents_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."kb_documents"
    ADD CONSTRAINT "kb_documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id");


--
-- Name: landed_cost_items landed_cost_items_goods_receipt_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."landed_cost_items"
    ADD CONSTRAINT "landed_cost_items_goods_receipt_id_fkey" FOREIGN KEY ("goods_receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE SET NULL;


--
-- Name: landed_cost_items landed_cost_items_inventory_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."landed_cost_items"
    ADD CONSTRAINT "landed_cost_items_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE SET NULL;


--
-- Name: landed_cost_items landed_cost_items_voucher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."landed_cost_items"
    ADD CONSTRAINT "landed_cost_items_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "public"."landed_cost_vouchers"("id") ON DELETE CASCADE;


--
-- Name: landed_cost_vouchers landed_cost_vouchers_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."landed_cost_vouchers"
    ADD CONSTRAINT "landed_cost_vouchers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: landed_cost_vouchers landed_cost_vouchers_journal_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."landed_cost_vouchers"
    ADD CONSTRAINT "landed_cost_vouchers_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE SET NULL;


--
-- Name: leads leads_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "leads_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id");


--
-- Name: leads leads_converted_to_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "leads_converted_to_customer_id_fkey" FOREIGN KEY ("converted_to_customer_id") REFERENCES "public"."customers"("id");


--
-- Name: leads leads_converted_to_quotation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "leads_converted_to_quotation_id_fkey" FOREIGN KEY ("converted_to_quotation_id") REFERENCES "public"."sales_quotations"("id");


--
-- Name: leads leads_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "leads_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: leads leads_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "leads_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");


--
-- Name: leave_requests leave_requests_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."leave_requests"
    ADD CONSTRAINT "leave_requests_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id");


--
-- Name: leave_requests leave_requests_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."leave_requests"
    ADD CONSTRAINT "leave_requests_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: leave_requests leave_requests_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."leave_requests"
    ADD CONSTRAINT "leave_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id");


--
-- Name: loan_schedules loan_schedules_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."loan_schedules"
    ADD CONSTRAINT "loan_schedules_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;


--
-- Name: loan_schedules loan_schedules_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."loan_schedules"
    ADD CONSTRAINT "loan_schedules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: mcp_connections mcp_connections_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."mcp_connections"
    ADD CONSTRAINT "mcp_connections_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: mcp_connections mcp_connections_credential_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."mcp_connections"
    ADD CONSTRAINT "mcp_connections_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "public"."ai_credentials"("id");


--
-- Name: mcp_oauth_grants mcp_oauth_grants_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."mcp_oauth_grants"
    ADD CONSTRAINT "mcp_oauth_grants_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE CASCADE;


--
-- Name: mcp_oauth_pending mcp_oauth_pending_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."mcp_oauth_pending"
    ADD CONSTRAINT "mcp_oauth_pending_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE CASCADE;


--
-- Name: mrp_planned_orders mrp_planned_orders_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."mrp_planned_orders"
    ADD CONSTRAINT "mrp_planned_orders_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id");


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


--
-- Name: packing_lists packing_lists_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."packing_lists"
    ADD CONSTRAINT "packing_lists_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE CASCADE;


--
-- Name: packing_lists packing_lists_shipment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."packing_lists"
    ADD CONSTRAINT "packing_lists_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE CASCADE;


--
-- Name: password_reset_tokens password_reset_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."password_reset_tokens"
    ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


--
-- Name: payroll_items payroll_items_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payroll_items"
    ADD CONSTRAINT "payroll_items_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id");


--
-- Name: payroll_items payroll_items_payroll_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payroll_items"
    ADD CONSTRAINT "payroll_items_payroll_run_id_fkey" FOREIGN KEY ("payroll_run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE CASCADE;


--
-- Name: payroll_runs payroll_runs_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payroll_runs"
    ADD CONSTRAINT "payroll_runs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: payroll_runs payroll_runs_journal_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payroll_runs"
    ADD CONSTRAINT "payroll_runs_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id");


--
-- Name: payroll_runs payroll_runs_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payroll_runs"
    ADD CONSTRAINT "payroll_runs_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");


--
-- Name: pdf_template_versions pdf_template_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."pdf_template_versions"
    ADD CONSTRAINT "pdf_template_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: pdf_template_versions pdf_template_versions_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."pdf_template_versions"
    ADD CONSTRAINT "pdf_template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "public"."pdf_templates"("id") ON DELETE CASCADE;


--
-- Name: pdf_templates pdf_templates_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."pdf_templates"
    ADD CONSTRAINT "pdf_templates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: pdf_templates pdf_templates_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."pdf_templates"
    ADD CONSTRAINT "pdf_templates_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");


--
-- Name: period_close_checklist period_close_checklist_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."period_close_checklist"
    ADD CONSTRAINT "period_close_checklist_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;


--
-- Name: period_close_checklist period_close_checklist_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."period_close_checklist"
    ADD CONSTRAINT "period_close_checklist_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "public"."accounting_periods"("id") ON DELETE CASCADE;


--
-- Name: period_close_checklist period_close_checklist_signed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."period_close_checklist"
    ADD CONSTRAINT "period_close_checklist_signed_by_fkey" FOREIGN KEY ("signed_by") REFERENCES "public"."users"("id");


--
-- Name: price_list_items price_list_items_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."price_list_items"
    ADD CONSTRAINT "price_list_items_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE CASCADE;


--
-- Name: price_list_items price_list_items_price_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."price_list_items"
    ADD CONSTRAINT "price_list_items_price_list_id_fkey" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE CASCADE;


--
-- Name: price_lists price_lists_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."price_lists"
    ADD CONSTRAINT "price_lists_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: price_lists price_lists_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."price_lists"
    ADD CONSTRAINT "price_lists_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;


--
-- Name: project_tasks project_tasks_assignee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_tasks"
    ADD CONSTRAINT "project_tasks_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id");


--
-- Name: project_tasks project_tasks_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project_tasks"
    ADD CONSTRAINT "project_tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;


--
-- Name: projects projects_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: projects projects_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id");


--
-- Name: projects projects_manager_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id");


--
-- Name: purchase_order_line_items purchase_order_line_items_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."purchase_order_line_items"
    ADD CONSTRAINT "purchase_order_line_items_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id");


--
-- Name: purchase_order_line_items purchase_order_line_items_po_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."purchase_order_line_items"
    ADD CONSTRAINT "purchase_order_line_items_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE CASCADE;


--
-- Name: purchase_orders purchase_orders_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id");


--
-- Name: purchase_orders purchase_orders_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id");


--
-- Name: purchase_orders purchase_orders_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: purchase_orders purchase_orders_delivery_confirmed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_delivery_confirmed_by_fkey" FOREIGN KEY ("delivery_confirmed_by") REFERENCES "public"."users"("id");


--
-- Name: purchase_orders purchase_orders_handover_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_handover_by_fkey" FOREIGN KEY ("handover_by") REFERENCES "public"."users"("id");


--
-- Name: purchase_orders purchase_orders_purchase_requisition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_purchase_requisition_id_fkey" FOREIGN KEY ("purchase_requisition_id") REFERENCES "public"."purchase_requisitions"("id");


--
-- Name: purchase_orders purchase_orders_rejected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_rejected_by_fkey" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id");


--
-- Name: purchase_orders purchase_orders_rfq_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "public"."request_for_quotations"("id");


--
-- Name: purchase_orders purchase_orders_storage_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_storage_location_id_fkey" FOREIGN KEY ("storage_location_id") REFERENCES "public"."storage_locations"("id");


--
-- Name: purchase_orders purchase_orders_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id");


--
-- Name: purchase_orders purchase_orders_verified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id");


--
-- Name: purchase_requisitions purchase_requisitions_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."purchase_requisitions"
    ADD CONSTRAINT "purchase_requisitions_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id");


--
-- Name: purchase_requisitions purchase_requisitions_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."purchase_requisitions"
    ADD CONSTRAINT "purchase_requisitions_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id");


--
-- Name: purchase_requisitions purchase_requisitions_recommended_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."purchase_requisitions"
    ADD CONSTRAINT "purchase_requisitions_recommended_supplier_id_fkey" FOREIGN KEY ("recommended_supplier_id") REFERENCES "public"."suppliers"("id");


--
-- Name: purchase_requisitions purchase_requisitions_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."purchase_requisitions"
    ADD CONSTRAINT "purchase_requisitions_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id");


--
-- Name: recurring_invoice_schedules recurring_invoice_schedules_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."recurring_invoice_schedules"
    ADD CONSTRAINT "recurring_invoice_schedules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: recurring_invoice_schedules recurring_invoice_schedules_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."recurring_invoice_schedules"
    ADD CONSTRAINT "recurring_invoice_schedules_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id");


--
-- Name: recurring_invoice_schedules recurring_invoice_schedules_sales_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."recurring_invoice_schedules"
    ADD CONSTRAINT "recurring_invoice_schedules_sales_contract_id_fkey" FOREIGN KEY ("sales_contract_id") REFERENCES "public"."sales_contracts"("id");


--
-- Name: report_definitions report_definitions_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."report_definitions"
    ADD CONSTRAINT "report_definitions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: report_definitions report_definitions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."report_definitions"
    ADD CONSTRAINT "report_definitions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: report_definitions report_definitions_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."report_definitions"
    ADD CONSTRAINT "report_definitions_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id");


--
-- Name: report_runs report_runs_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."report_runs"
    ADD CONSTRAINT "report_runs_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "public"."report_definitions"("id") ON DELETE CASCADE;


--
-- Name: report_runs report_runs_run_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."report_runs"
    ADD CONSTRAINT "report_runs_run_by_fkey" FOREIGN KEY ("run_by") REFERENCES "public"."users"("id");


--
-- Name: report_runs report_runs_schedule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."report_runs"
    ADD CONSTRAINT "report_runs_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "public"."report_schedules"("id") ON DELETE SET NULL;


--
-- Name: report_schedules report_schedules_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."report_schedules"
    ADD CONSTRAINT "report_schedules_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: report_schedules report_schedules_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."report_schedules"
    ADD CONSTRAINT "report_schedules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: report_schedules report_schedules_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."report_schedules"
    ADD CONSTRAINT "report_schedules_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "public"."report_definitions"("id") ON DELETE CASCADE;


--
-- Name: request_for_quotations request_for_quotations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."request_for_quotations"
    ADD CONSTRAINT "request_for_quotations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: request_for_quotations request_for_quotations_purchase_requisition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."request_for_quotations"
    ADD CONSTRAINT "request_for_quotations_purchase_requisition_id_fkey" FOREIGN KEY ("purchase_requisition_id") REFERENCES "public"."purchase_requisitions"("id");


--
-- Name: request_for_quotations request_for_quotations_winning_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."request_for_quotations"
    ADD CONSTRAINT "request_for_quotations_winning_supplier_id_fkey" FOREIGN KEY ("winning_supplier_id") REFERENCES "public"."suppliers"("id");


--
-- Name: revenue_schedules revenue_schedules_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."revenue_schedules"
    ADD CONSTRAINT "revenue_schedules_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: revenue_schedules revenue_schedules_customer_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."revenue_schedules"
    ADD CONSTRAINT "revenue_schedules_customer_invoice_id_fkey" FOREIGN KEY ("customer_invoice_id") REFERENCES "public"."customer_invoices"("id") ON DELETE CASCADE;


--
-- Name: revenue_schedules revenue_schedules_journal_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."revenue_schedules"
    ADD CONSTRAINT "revenue_schedules_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE SET NULL;


--
-- Name: revenue_schedules revenue_schedules_sales_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."revenue_schedules"
    ADD CONSTRAINT "revenue_schedules_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE CASCADE;


--
-- Name: rfq_line_items rfq_line_items_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."rfq_line_items"
    ADD CONSTRAINT "rfq_line_items_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id");


--
-- Name: rfq_line_items rfq_line_items_rfq_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."rfq_line_items"
    ADD CONSTRAINT "rfq_line_items_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "public"."request_for_quotations"("id") ON DELETE CASCADE;


--
-- Name: rfq_quotations rfq_quotations_rfq_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."rfq_quotations"
    ADD CONSTRAINT "rfq_quotations_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "public"."request_for_quotations"("id") ON DELETE CASCADE;


--
-- Name: rfq_quotations rfq_quotations_rfq_line_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."rfq_quotations"
    ADD CONSTRAINT "rfq_quotations_rfq_line_item_id_fkey" FOREIGN KEY ("rfq_line_item_id") REFERENCES "public"."rfq_line_items"("id") ON DELETE CASCADE;


--
-- Name: rfq_quotations rfq_quotations_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."rfq_quotations"
    ADD CONSTRAINT "rfq_quotations_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE CASCADE;


--
-- Name: rfq_suppliers rfq_suppliers_rfq_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."rfq_suppliers"
    ADD CONSTRAINT "rfq_suppliers_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "public"."request_for_quotations"("id") ON DELETE CASCADE;


--
-- Name: rfq_suppliers rfq_suppliers_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."rfq_suppliers"
    ADD CONSTRAINT "rfq_suppliers_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE CASCADE;


--
-- Name: rfqs rfqs_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."rfqs"
    ADD CONSTRAINT "rfqs_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id");


--
-- Name: rfqs rfqs_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."rfqs"
    ADD CONSTRAINT "rfqs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: rfqs rfqs_purchase_requisition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."rfqs"
    ADD CONSTRAINT "rfqs_purchase_requisition_id_fkey" FOREIGN KEY ("purchase_requisition_id") REFERENCES "public"."purchase_requisitions"("id");


--
-- Name: rfqs rfqs_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."rfqs"
    ADD CONSTRAINT "rfqs_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id");


--
-- Name: rfqs rfqs_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."rfqs"
    ADD CONSTRAINT "rfqs_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");


--
-- Name: sales_contract_items sales_contract_items_inventory_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_contract_items"
    ADD CONSTRAINT "sales_contract_items_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id");


--
-- Name: sales_contract_items sales_contract_items_sales_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_contract_items"
    ADD CONSTRAINT "sales_contract_items_sales_contract_id_fkey" FOREIGN KEY ("sales_contract_id") REFERENCES "public"."sales_contracts"("id") ON DELETE CASCADE;


--
-- Name: sales_contract_renewals sales_contract_renewals_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_contract_renewals"
    ADD CONSTRAINT "sales_contract_renewals_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: sales_contract_renewals sales_contract_renewals_new_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_contract_renewals"
    ADD CONSTRAINT "sales_contract_renewals_new_contract_id_fkey" FOREIGN KEY ("new_contract_id") REFERENCES "public"."sales_contracts"("id");


--
-- Name: sales_contract_renewals sales_contract_renewals_original_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_contract_renewals"
    ADD CONSTRAINT "sales_contract_renewals_original_contract_id_fkey" FOREIGN KEY ("original_contract_id") REFERENCES "public"."sales_contracts"("id");


--
-- Name: sales_contract_status_history sales_contract_status_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_contract_status_history"
    ADD CONSTRAINT "sales_contract_status_history_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id");


--
-- Name: sales_contract_status_history sales_contract_status_history_sales_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_contract_status_history"
    ADD CONSTRAINT "sales_contract_status_history_sales_contract_id_fkey" FOREIGN KEY ("sales_contract_id") REFERENCES "public"."sales_contracts"("id") ON DELETE CASCADE;


--
-- Name: sales_contract_usage sales_contract_usage_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_contract_usage"
    ADD CONSTRAINT "sales_contract_usage_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: sales_contract_usage sales_contract_usage_sales_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_contract_usage"
    ADD CONSTRAINT "sales_contract_usage_sales_contract_id_fkey" FOREIGN KEY ("sales_contract_id") REFERENCES "public"."sales_contracts"("id");


--
-- Name: sales_contract_usage sales_contract_usage_sales_contract_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_contract_usage"
    ADD CONSTRAINT "sales_contract_usage_sales_contract_item_id_fkey" FOREIGN KEY ("sales_contract_item_id") REFERENCES "public"."sales_contract_items"("id");


--
-- Name: sales_contracts sales_contracts_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_contracts"
    ADD CONSTRAINT "sales_contracts_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id");


--
-- Name: sales_contracts sales_contracts_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_contracts"
    ADD CONSTRAINT "sales_contracts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: sales_contracts sales_contracts_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_contracts"
    ADD CONSTRAINT "sales_contracts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id");


--
-- Name: sales_contracts sales_contracts_rejected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_contracts"
    ADD CONSTRAINT "sales_contracts_rejected_by_fkey" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id");


--
-- Name: sales_contracts sales_contracts_sent_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_contracts"
    ADD CONSTRAINT "sales_contracts_sent_by_fkey" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id");


--
-- Name: sales_contracts sales_contracts_submitted_for_approval_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_contracts"
    ADD CONSTRAINT "sales_contracts_submitted_for_approval_by_fkey" FOREIGN KEY ("submitted_for_approval_by") REFERENCES "public"."users"("id");


--
-- Name: sales_contracts sales_contracts_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_contracts"
    ADD CONSTRAINT "sales_contracts_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id");


--
-- Name: sales_contracts sales_contracts_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_contracts"
    ADD CONSTRAINT "sales_contracts_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");


--
-- Name: sales_credit_note_items sales_credit_note_items_credit_note_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_credit_note_items"
    ADD CONSTRAINT "sales_credit_note_items_credit_note_id_fkey" FOREIGN KEY ("credit_note_id") REFERENCES "public"."sales_credit_notes"("id") ON DELETE CASCADE;


--
-- Name: sales_credit_note_items sales_credit_note_items_customer_invoice_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_credit_note_items"
    ADD CONSTRAINT "sales_credit_note_items_customer_invoice_item_id_fkey" FOREIGN KEY ("customer_invoice_item_id") REFERENCES "public"."customer_invoice_items"("id");


--
-- Name: sales_credit_note_items sales_credit_note_items_inventory_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_credit_note_items"
    ADD CONSTRAINT "sales_credit_note_items_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id");


--
-- Name: sales_credit_notes sales_credit_notes_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_credit_notes"
    ADD CONSTRAINT "sales_credit_notes_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id");


--
-- Name: sales_credit_notes sales_credit_notes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_credit_notes"
    ADD CONSTRAINT "sales_credit_notes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: sales_credit_notes sales_credit_notes_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_credit_notes"
    ADD CONSTRAINT "sales_credit_notes_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id");


--
-- Name: sales_credit_notes sales_credit_notes_customer_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_credit_notes"
    ADD CONSTRAINT "sales_credit_notes_customer_invoice_id_fkey" FOREIGN KEY ("customer_invoice_id") REFERENCES "public"."customer_invoices"("id");


--
-- Name: sales_credit_notes sales_credit_notes_posted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_credit_notes"
    ADD CONSTRAINT "sales_credit_notes_posted_by_fkey" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id");


--
-- Name: sales_order_items sales_order_items_inventory_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_order_items"
    ADD CONSTRAINT "sales_order_items_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id");


--
-- Name: sales_order_items sales_order_items_sales_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_order_items"
    ADD CONSTRAINT "sales_order_items_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE CASCADE;


--
-- Name: sales_order_status_history sales_order_status_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_order_status_history"
    ADD CONSTRAINT "sales_order_status_history_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id");


--
-- Name: sales_order_status_history sales_order_status_history_sales_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_order_status_history"
    ADD CONSTRAINT "sales_order_status_history_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE CASCADE;


--
-- Name: sales_orders sales_orders_approval_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_orders"
    ADD CONSTRAINT "sales_orders_approval_requested_by_fkey" FOREIGN KEY ("approval_requested_by") REFERENCES "public"."users"("id");


--
-- Name: sales_orders sales_orders_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_orders"
    ADD CONSTRAINT "sales_orders_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id");


--
-- Name: sales_orders sales_orders_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_orders"
    ADD CONSTRAINT "sales_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: sales_orders sales_orders_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_orders"
    ADD CONSTRAINT "sales_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id");


--
-- Name: sales_orders sales_orders_rejected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_orders"
    ADD CONSTRAINT "sales_orders_rejected_by_fkey" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id");


--
-- Name: sales_orders sales_orders_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_orders"
    ADD CONSTRAINT "sales_orders_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");


--
-- Name: sales_quotation_items sales_quotation_items_inventory_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_quotation_items"
    ADD CONSTRAINT "sales_quotation_items_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id");


--
-- Name: sales_quotation_items sales_quotation_items_linked_sales_rfq_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_quotation_items"
    ADD CONSTRAINT "sales_quotation_items_linked_sales_rfq_id_fkey" FOREIGN KEY ("linked_sales_rfq_id") REFERENCES "public"."sales_rfqs"("id");


--
-- Name: sales_quotation_items sales_quotation_items_sales_quotation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_quotation_items"
    ADD CONSTRAINT "sales_quotation_items_sales_quotation_id_fkey" FOREIGN KEY ("sales_quotation_id") REFERENCES "public"."sales_quotations"("id") ON DELETE CASCADE;


--
-- Name: sales_quotation_items sales_quotation_items_source_bin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_quotation_items"
    ADD CONSTRAINT "sales_quotation_items_source_bin_id_fkey" FOREIGN KEY ("source_bin_id") REFERENCES "public"."bins"("id");


--
-- Name: sales_quotation_items sales_quotation_items_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_quotation_items"
    ADD CONSTRAINT "sales_quotation_items_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id");


--
-- Name: sales_quotation_status_history sales_quotation_status_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_quotation_status_history"
    ADD CONSTRAINT "sales_quotation_status_history_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id");


--
-- Name: sales_quotation_status_history sales_quotation_status_history_sales_quotation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_quotation_status_history"
    ADD CONSTRAINT "sales_quotation_status_history_sales_quotation_id_fkey" FOREIGN KEY ("sales_quotation_id") REFERENCES "public"."sales_quotations"("id") ON DELETE CASCADE;


--
-- Name: sales_quotations sales_quotations_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_quotations"
    ADD CONSTRAINT "sales_quotations_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id");


--
-- Name: sales_quotations sales_quotations_converted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_quotations"
    ADD CONSTRAINT "sales_quotations_converted_by_fkey" FOREIGN KEY ("converted_by") REFERENCES "public"."users"("id");


--
-- Name: sales_quotations sales_quotations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_quotations"
    ADD CONSTRAINT "sales_quotations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: sales_quotations sales_quotations_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_quotations"
    ADD CONSTRAINT "sales_quotations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id");


--
-- Name: sales_quotations sales_quotations_rejected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_quotations"
    ADD CONSTRAINT "sales_quotations_rejected_by_fkey" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id");


--
-- Name: sales_quotations sales_quotations_sales_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_quotations"
    ADD CONSTRAINT "sales_quotations_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id");


--
-- Name: sales_quotations sales_quotations_send_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_quotations"
    ADD CONSTRAINT "sales_quotations_send_approved_by_fkey" FOREIGN KEY ("send_approved_by") REFERENCES "public"."users"("id");


--
-- Name: sales_quotations sales_quotations_send_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_quotations"
    ADD CONSTRAINT "sales_quotations_send_requested_by_fkey" FOREIGN KEY ("send_requested_by") REFERENCES "public"."users"("id");


--
-- Name: sales_quotations sales_quotations_sent_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_quotations"
    ADD CONSTRAINT "sales_quotations_sent_by_fkey" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id");


--
-- Name: sales_quotations sales_quotations_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_quotations"
    ADD CONSTRAINT "sales_quotations_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");


--
-- Name: sales_rfq_communications sales_rfq_communications_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_rfq_communications"
    ADD CONSTRAINT "sales_rfq_communications_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: sales_rfq_communications sales_rfq_communications_sales_rfq_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_rfq_communications"
    ADD CONSTRAINT "sales_rfq_communications_sales_rfq_id_fkey" FOREIGN KEY ("sales_rfq_id") REFERENCES "public"."sales_rfqs"("id") ON DELETE CASCADE;


--
-- Name: sales_rfq_item_responses sales_rfq_item_responses_response_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_rfq_item_responses"
    ADD CONSTRAINT "sales_rfq_item_responses_response_id_fkey" FOREIGN KEY ("response_id") REFERENCES "public"."sales_rfq_supplier_responses"("id");


--
-- Name: sales_rfq_items sales_rfq_items_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_rfq_items"
    ADD CONSTRAINT "sales_rfq_items_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id");


--
-- Name: sales_rfq_items sales_rfq_items_sales_rfq_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_rfq_items"
    ADD CONSTRAINT "sales_rfq_items_sales_rfq_id_fkey" FOREIGN KEY ("sales_rfq_id") REFERENCES "public"."sales_rfqs"("id") ON DELETE CASCADE;


--
-- Name: sales_rfq_status_history sales_rfq_status_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_rfq_status_history"
    ADD CONSTRAINT "sales_rfq_status_history_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id");


--
-- Name: sales_rfq_status_history sales_rfq_status_history_sales_rfq_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_rfq_status_history"
    ADD CONSTRAINT "sales_rfq_status_history_sales_rfq_id_fkey" FOREIGN KEY ("sales_rfq_id") REFERENCES "public"."sales_rfqs"("id") ON DELETE CASCADE;


--
-- Name: sales_rfqs sales_rfqs_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_rfqs"
    ADD CONSTRAINT "sales_rfqs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: sales_rfqs sales_rfqs_linked_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_rfqs"
    ADD CONSTRAINT "sales_rfqs_linked_customer_id_fkey" FOREIGN KEY ("linked_customer_id") REFERENCES "public"."customers"("id");


--
-- Name: sales_rfqs sales_rfqs_procurement_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_rfqs"
    ADD CONSTRAINT "sales_rfqs_procurement_approved_by_fkey" FOREIGN KEY ("procurement_approved_by") REFERENCES "public"."users"("id");


--
-- Name: sales_rfqs sales_rfqs_sales_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_rfqs"
    ADD CONSTRAINT "sales_rfqs_sales_approved_by_fkey" FOREIGN KEY ("sales_approved_by") REFERENCES "public"."users"("id");


--
-- Name: sales_rfqs sales_rfqs_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_rfqs"
    ADD CONSTRAINT "sales_rfqs_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id");


--
-- Name: sales_rfqs sales_rfqs_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sales_rfqs"
    ADD CONSTRAINT "sales_rfqs_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");


--
-- Name: shipments shipments_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."shipments"
    ADD CONSTRAINT "shipments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: shipments shipments_sales_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."shipments"
    ADD CONSTRAINT "shipments_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE CASCADE;


--
-- Name: stocktake_sheet_items stocktake_sheet_items_inventory_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."stocktake_sheet_items"
    ADD CONSTRAINT "stocktake_sheet_items_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE CASCADE;


--
-- Name: stocktake_sheet_items stocktake_sheet_items_sheet_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."stocktake_sheet_items"
    ADD CONSTRAINT "stocktake_sheet_items_sheet_id_fkey" FOREIGN KEY ("sheet_id") REFERENCES "public"."stocktake_sheets"("id") ON DELETE CASCADE;


--
-- Name: stocktake_sheets stocktake_sheets_counted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."stocktake_sheets"
    ADD CONSTRAINT "stocktake_sheets_counted_by_fkey" FOREIGN KEY ("counted_by") REFERENCES "public"."users"("id");


--
-- Name: stocktake_sheets stocktake_sheets_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."stocktake_sheets"
    ADD CONSTRAINT "stocktake_sheets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: stocktake_sheets stocktake_sheets_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."stocktake_sheets"
    ADD CONSTRAINT "stocktake_sheets_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."storage_locations"("id") ON DELETE SET NULL;


--
-- Name: stocktake_sheets stocktake_sheets_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."stocktake_sheets"
    ADD CONSTRAINT "stocktake_sheets_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id");


--
-- Name: storage_locations storage_locations_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."storage_locations"
    ADD CONSTRAINT "storage_locations_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id");


--
-- Name: storage_locations storage_locations_declined_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."storage_locations"
    ADD CONSTRAINT "storage_locations_declined_by_fkey" FOREIGN KEY ("declined_by") REFERENCES "public"."users"("id");


--
-- Name: storage_locations storage_locations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."storage_locations"
    ADD CONSTRAINT "storage_locations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


--
-- Name: supplier_bank_detail_changes supplier_bank_detail_changes_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_bank_detail_changes"
    ADD CONSTRAINT "supplier_bank_detail_changes_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id");


--
-- Name: supplier_bank_detail_changes supplier_bank_detail_changes_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_bank_detail_changes"
    ADD CONSTRAINT "supplier_bank_detail_changes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;


--
-- Name: supplier_bank_detail_changes supplier_bank_detail_changes_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_bank_detail_changes"
    ADD CONSTRAINT "supplier_bank_detail_changes_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE CASCADE;


--
-- Name: supplier_debit_note_items supplier_debit_note_items_debit_note_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_debit_note_items"
    ADD CONSTRAINT "supplier_debit_note_items_debit_note_id_fkey" FOREIGN KEY ("debit_note_id") REFERENCES "public"."supplier_debit_notes"("id") ON DELETE CASCADE;


--
-- Name: supplier_debit_note_items supplier_debit_note_items_inventory_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_debit_note_items"
    ADD CONSTRAINT "supplier_debit_note_items_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id");


--
-- Name: supplier_debit_note_items supplier_debit_note_items_supplier_invoice_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_debit_note_items"
    ADD CONSTRAINT "supplier_debit_note_items_supplier_invoice_item_id_fkey" FOREIGN KEY ("supplier_invoice_item_id") REFERENCES "public"."supplier_invoice_items"("id");


--
-- Name: supplier_debit_notes supplier_debit_notes_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_debit_notes"
    ADD CONSTRAINT "supplier_debit_notes_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id");


--
-- Name: supplier_debit_notes supplier_debit_notes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_debit_notes"
    ADD CONSTRAINT "supplier_debit_notes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: supplier_debit_notes supplier_debit_notes_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_debit_notes"
    ADD CONSTRAINT "supplier_debit_notes_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id");


--
-- Name: supplier_debit_notes supplier_debit_notes_supplier_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_debit_notes"
    ADD CONSTRAINT "supplier_debit_notes_supplier_invoice_id_fkey" FOREIGN KEY ("supplier_invoice_id") REFERENCES "public"."supplier_invoices"("id");


--
-- Name: supplier_invoice_items supplier_invoice_items_bill_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_invoice_items"
    ADD CONSTRAINT "supplier_invoice_items_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE CASCADE;


--
-- Name: supplier_invoice_status_history supplier_invoice_status_history_bill_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_invoice_status_history"
    ADD CONSTRAINT "supplier_invoice_status_history_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE CASCADE;


--
-- Name: supplier_invoice_status_history supplier_invoice_status_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_invoice_status_history"
    ADD CONSTRAINT "supplier_invoice_status_history_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id");


--
-- Name: supplier_invoices supplier_invoices_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_invoices"
    ADD CONSTRAINT "supplier_invoices_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: supplier_invoices supplier_invoices_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_invoices"
    ADD CONSTRAINT "supplier_invoices_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id");


--
-- Name: supplier_invoices supplier_invoices_journal_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_invoices"
    ADD CONSTRAINT "supplier_invoices_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id");


--
-- Name: supplier_invoices supplier_invoices_purchase_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_invoices"
    ADD CONSTRAINT "supplier_invoices_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id");


--
-- Name: supplier_invoices supplier_invoices_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_invoices"
    ADD CONSTRAINT "supplier_invoices_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id");


--
-- Name: supplier_invoices supplier_invoices_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_invoices"
    ADD CONSTRAINT "supplier_invoices_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");


--
-- Name: supplier_items supplier_items_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_items"
    ADD CONSTRAINT "supplier_items_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: supplier_items supplier_items_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_items"
    ADD CONSTRAINT "supplier_items_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE CASCADE;


--
-- Name: supplier_items supplier_items_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_items"
    ADD CONSTRAINT "supplier_items_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE CASCADE;


--
-- Name: supplier_payment_allocations supplier_payment_allocations_bill_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_payment_allocations"
    ADD CONSTRAINT "supplier_payment_allocations_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "public"."supplier_invoices"("id");


--
-- Name: supplier_payment_allocations supplier_payment_allocations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_payment_allocations"
    ADD CONSTRAINT "supplier_payment_allocations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: supplier_payment_allocations supplier_payment_allocations_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_payment_allocations"
    ADD CONSTRAINT "supplier_payment_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."supplier_payments"("id") ON DELETE CASCADE;


--
-- Name: supplier_payment_status_history supplier_payment_status_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_payment_status_history"
    ADD CONSTRAINT "supplier_payment_status_history_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id");


--
-- Name: supplier_payment_status_history supplier_payment_status_history_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_payment_status_history"
    ADD CONSTRAINT "supplier_payment_status_history_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."supplier_payments"("id") ON DELETE CASCADE;


--
-- Name: supplier_payments supplier_payments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_payments"
    ADD CONSTRAINT "supplier_payments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: supplier_payments supplier_payments_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_payments"
    ADD CONSTRAINT "supplier_payments_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id");


--
-- Name: supplier_payments supplier_payments_journal_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_payments"
    ADD CONSTRAINT "supplier_payments_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id");


--
-- Name: supplier_payments supplier_payments_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_payments"
    ADD CONSTRAINT "supplier_payments_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id");


--
-- Name: supplier_payments supplier_payments_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."supplier_payments"
    ADD CONSTRAINT "supplier_payments_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");


--
-- Name: suppliers suppliers_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."suppliers"
    ADD CONSTRAINT "suppliers_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id");


--
-- Name: suppliers suppliers_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."suppliers"
    ADD CONSTRAINT "suppliers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: tax_codes tax_codes_jurisdiction_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tax_codes"
    ADD CONSTRAINT "tax_codes_jurisdiction_code_fkey" FOREIGN KEY ("jurisdiction_code") REFERENCES "public"."tax_jurisdictions"("code");


--
-- Name: tax_payment_schedules tax_payment_schedules_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tax_payment_schedules"
    ADD CONSTRAINT "tax_payment_schedules_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;


--
-- Name: tax_payment_schedules tax_payment_schedules_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tax_payment_schedules"
    ADD CONSTRAINT "tax_payment_schedules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: time_entries time_entries_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id");


--
-- Name: time_entries time_entries_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."customer_invoices"("id");


--
-- Name: time_entries time_entries_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id");


--
-- Name: time_entries time_entries_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."project_tasks"("id") ON DELETE SET NULL;


--
-- Name: time_entries time_entries_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id");


--
-- Name: uom_conversions uom_conversions_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."uom_conversions"
    ADD CONSTRAINT "uom_conversions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: uom_conversions uom_conversions_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."uom_conversions"
    ADD CONSTRAINT "uom_conversions_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE CASCADE;


--
-- Name: usage_counters usage_counters_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_counters"
    ADD CONSTRAINT "usage_counters_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;


--
-- Name: user_companies user_companies_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."user_companies"
    ADD CONSTRAINT "user_companies_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;


--
-- Name: user_companies user_companies_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."user_companies"
    ADD CONSTRAINT "user_companies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


--
-- Name: warehouse_transaction_audit_log warehouse_transaction_audit_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."warehouse_transaction_audit_log"
    ADD CONSTRAINT "warehouse_transaction_audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id");


--
-- Name: warehouse_transaction_audit_log warehouse_transaction_audit_log_warehouse_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."warehouse_transaction_audit_log"
    ADD CONSTRAINT "warehouse_transaction_audit_log_warehouse_transaction_id_fkey" FOREIGN KEY ("warehouse_transaction_id") REFERENCES "public"."warehouse_transactions"("id") ON DELETE CASCADE;


--
-- Name: warehouse_transaction_items warehouse_transaction_items_destination_bin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."warehouse_transaction_items"
    ADD CONSTRAINT "warehouse_transaction_items_destination_bin_id_fkey" FOREIGN KEY ("destination_bin_id") REFERENCES "public"."bins"("id");


--
-- Name: warehouse_transaction_items warehouse_transaction_items_destination_storage_location_i_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."warehouse_transaction_items"
    ADD CONSTRAINT "warehouse_transaction_items_destination_storage_location_i_fkey" FOREIGN KEY ("destination_storage_location_id") REFERENCES "public"."storage_locations"("id");


--
-- Name: warehouse_transaction_items warehouse_transaction_items_inventory_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."warehouse_transaction_items"
    ADD CONSTRAINT "warehouse_transaction_items_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id");


--
-- Name: warehouse_transaction_items warehouse_transaction_items_source_bin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."warehouse_transaction_items"
    ADD CONSTRAINT "warehouse_transaction_items_source_bin_id_fkey" FOREIGN KEY ("source_bin_id") REFERENCES "public"."bins"("id");


--
-- Name: warehouse_transaction_items warehouse_transaction_items_source_storage_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."warehouse_transaction_items"
    ADD CONSTRAINT "warehouse_transaction_items_source_storage_location_id_fkey" FOREIGN KEY ("source_storage_location_id") REFERENCES "public"."storage_locations"("id");


--
-- Name: warehouse_transaction_items warehouse_transaction_items_warehouse_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."warehouse_transaction_items"
    ADD CONSTRAINT "warehouse_transaction_items_warehouse_transaction_id_fkey" FOREIGN KEY ("warehouse_transaction_id") REFERENCES "public"."warehouse_transactions"("id") ON DELETE CASCADE;


--
-- Name: warehouse_transactions warehouse_transactions_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."warehouse_transactions"
    ADD CONSTRAINT "warehouse_transactions_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id");


--
-- Name: warehouse_transactions warehouse_transactions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."warehouse_transactions"
    ADD CONSTRAINT "warehouse_transactions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: warehouse_transactions warehouse_transactions_processed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."warehouse_transactions"
    ADD CONSTRAINT "warehouse_transactions_processed_by_fkey" FOREIGN KEY ("processed_by") REFERENCES "public"."users"("id");


--
-- Name: webhook_delivery_log webhook_delivery_log_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."webhook_delivery_log"
    ADD CONSTRAINT "webhook_delivery_log_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."webhook_subscriptions"("id");


--
-- Name: webhook_subscriptions webhook_subscriptions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."webhook_subscriptions"
    ADD CONSTRAINT "webhook_subscriptions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: work_centers work_centers_cost_center_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_centers"
    ADD CONSTRAINT "work_centers_cost_center_id_fkey" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_centers"("id");


--
-- Name: work_centers work_centers_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_centers"
    ADD CONSTRAINT "work_centers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: work_order_components work_order_components_component_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_order_components"
    ADD CONSTRAINT "work_order_components_component_item_id_fkey" FOREIGN KEY ("component_item_id") REFERENCES "public"."items"("id");


--
-- Name: work_order_components work_order_components_work_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_order_components"
    ADD CONSTRAINT "work_order_components_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE CASCADE;


--
-- Name: work_order_operations work_order_operations_work_center_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_order_operations"
    ADD CONSTRAINT "work_order_operations_work_center_id_fkey" FOREIGN KEY ("work_center_id") REFERENCES "public"."work_centers"("id");


--
-- Name: work_order_operations work_order_operations_work_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_order_operations"
    ADD CONSTRAINT "work_order_operations_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE CASCADE;


--
-- Name: work_order_time_entries work_order_time_entries_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_order_time_entries"
    ADD CONSTRAINT "work_order_time_entries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: work_order_time_entries work_order_time_entries_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_order_time_entries"
    ADD CONSTRAINT "work_order_time_entries_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id");


--
-- Name: work_order_time_entries work_order_time_entries_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_order_time_entries"
    ADD CONSTRAINT "work_order_time_entries_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "public"."work_order_operations"("id") ON DELETE CASCADE;


--
-- Name: work_order_time_entries work_order_time_entries_work_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_order_time_entries"
    ADD CONSTRAINT "work_order_time_entries_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE CASCADE;


--
-- Name: work_orders work_orders_bom_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_bom_id_fkey" FOREIGN KEY ("bom_id") REFERENCES "public"."bills_of_material"("id");


--
-- Name: work_orders work_orders_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: work_orders work_orders_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id");


--
-- Name: work_orders work_orders_sales_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id");


--
-- Name: work_orders work_orders_storage_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_storage_location_id_fkey" FOREIGN KEY ("storage_location_id") REFERENCES "public"."storage_locations"("id");


--
-- Name: accounting_periods; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."accounting_periods" ENABLE ROW LEVEL SECURITY;

--
-- Name: activities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."activities" ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_blueprints; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."agent_blueprints" ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_credentials; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."agent_credentials" ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_definitions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."agent_definitions" ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_escalations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."agent_escalations" ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_memory; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."agent_memory" ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_paused_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."agent_paused_runs" ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."agent_runs" ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_audit_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."ai_audit_log" ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_credentials; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."ai_credentials" ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_feedback; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."ai_feedback" ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_finding_suppressions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."ai_finding_suppressions" ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_findings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."ai_findings" ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_learned_preferences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."ai_learned_preferences" ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."ai_settings" ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_tool_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."ai_tool_settings" ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_tool_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."ai_tool_versions" ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_tools; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."ai_tools" ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_usage_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."ai_usage_log" ENABLE ROW LEVEL SECURITY;

--
-- Name: api_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."api_keys" ENABLE ROW LEVEL SECURITY;

--
-- Name: approval_chain_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."approval_chain_templates" ENABLE ROW LEVEL SECURITY;

--
-- Name: approval_delegations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."approval_delegations" ENABLE ROW LEVEL SECURITY;

--
-- Name: approval_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."approval_requests" ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_chain; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."audit_chain" ENABLE ROW LEVEL SECURITY;

--
-- Name: auto_purchase_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."auto_purchase_orders" ENABLE ROW LEVEL SECURITY;

--
-- Name: background_tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."background_tasks" ENABLE ROW LEVEL SECURITY;

--
-- Name: bank_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."bank_accounts" ENABLE ROW LEVEL SECURITY;

--
-- Name: bank_transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."bank_transactions" ENABLE ROW LEVEL SECURITY;

--
-- Name: bills_of_material; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."bills_of_material" ENABLE ROW LEVEL SECURITY;

--
-- Name: bins; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."bins" ENABLE ROW LEVEL SECURITY;

--
-- Name: budgets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."budgets" ENABLE ROW LEVEL SECURITY;

--
-- Name: chart_of_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."chart_of_accounts" ENABLE ROW LEVEL SECURITY;

--
-- Name: chat_memory; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."chat_memory" ENABLE ROW LEVEL SECURITY;

--
-- Name: company_gl_mappings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."company_gl_mappings" ENABLE ROW LEVEL SECURITY;

--
-- Name: accounting_periods company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."accounting_periods" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: activities company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."activities" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: agent_blueprints company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."agent_blueprints" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: agent_credentials company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."agent_credentials" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: agent_definitions company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."agent_definitions" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: agent_escalations company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."agent_escalations" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: agent_memory company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."agent_memory" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: agent_paused_runs company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."agent_paused_runs" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: agent_runs company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."agent_runs" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: ai_audit_log company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."ai_audit_log" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: ai_credentials company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."ai_credentials" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: ai_feedback company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."ai_feedback" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: ai_finding_suppressions company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."ai_finding_suppressions" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: ai_findings company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."ai_findings" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: ai_learned_preferences company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."ai_learned_preferences" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: ai_settings company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."ai_settings" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: ai_tool_settings company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."ai_tool_settings" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: ai_tool_versions company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."ai_tool_versions" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: ai_tools company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."ai_tools" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: ai_usage_log company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."ai_usage_log" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: api_keys company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."api_keys" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: approval_chain_templates company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."approval_chain_templates" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: approval_delegations company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."approval_delegations" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: approval_requests company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."approval_requests" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: audit_chain company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."audit_chain" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: auto_purchase_orders company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."auto_purchase_orders" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: background_tasks company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."background_tasks" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: bank_accounts company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."bank_accounts" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: bank_transactions company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."bank_transactions" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: bills_of_material company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."bills_of_material" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: bins company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."bins" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: budgets company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."budgets" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: chart_of_accounts company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."chart_of_accounts" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: chat_memory company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."chat_memory" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: company_gl_mappings company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."company_gl_mappings" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: company_modules company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."company_modules" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: company_subscriptions company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."company_subscriptions" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: connectors company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."connectors" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: contacts company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."contacts" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: contracts company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."contracts" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: conversations company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."conversations" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: cost_centers company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."cost_centers" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: customer_invoices company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."customer_invoices" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: customer_payments company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."customer_payments" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: customers company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."customers" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: dashboards company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."dashboards" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: deals company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."deals" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: delegation_of_authority company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."delegation_of_authority" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: delivery_routes company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."delivery_routes" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: delivery_schedules company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."delivery_schedules" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: document_embeddings company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."document_embeddings" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: employees company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."employees" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: fixed_assets company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."fixed_assets" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: generated_documents company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."generated_documents" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: goods_receipts company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."goods_receipts" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: inventory_items company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."inventory_items" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: inventory_transfers company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."inventory_transfers" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: items company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."items" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: journal_entries company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."journal_entries" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: kb_documents company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."kb_documents" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: landed_cost_vouchers company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."landed_cost_vouchers" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: leads company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."leads" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: loan_schedules company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."loan_schedules" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: mcp_connections company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."mcp_connections" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: mcp_oauth_grants company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."mcp_oauth_grants" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: mrp_planned_orders company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."mrp_planned_orders" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: notifications company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."notifications" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: payroll_runs company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."payroll_runs" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: pdf_templates company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."pdf_templates" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: period_close_checklist company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."period_close_checklist" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: price_lists company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."price_lists" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: projects company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."projects" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: purchase_orders company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."purchase_orders" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: purchase_requisitions company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."purchase_requisitions" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: recurring_invoice_schedules company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."recurring_invoice_schedules" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: report_definitions company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."report_definitions" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: report_schedules company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."report_schedules" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: request_for_quotations company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."request_for_quotations" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: revenue_schedules company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."revenue_schedules" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: rfqs company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."rfqs" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: sales_contracts company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."sales_contracts" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: sales_credit_notes company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."sales_credit_notes" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: sales_orders company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."sales_orders" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: sales_quotations company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."sales_quotations" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: sales_rfqs company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."sales_rfqs" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: shipments company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."shipments" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: stocktake_sheets company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."stocktake_sheets" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: storage_locations company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."storage_locations" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: supplier_bank_detail_changes company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."supplier_bank_detail_changes" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: supplier_debit_notes company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."supplier_debit_notes" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: supplier_invoices company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."supplier_invoices" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: supplier_items company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."supplier_items" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: supplier_payments company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."supplier_payments" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: suppliers company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."suppliers" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: tax_payment_schedules company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."tax_payment_schedules" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: time_entries company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."time_entries" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: uom_conversions company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."uom_conversions" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: usage_counters company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."usage_counters" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: warehouse_transactions company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."warehouse_transactions" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: webhook_subscriptions company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."webhook_subscriptions" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: work_centers company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."work_centers" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: work_orders company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_isolation" ON "public"."work_orders" USING (("company_id" = "public"."current_company_id"())) WITH CHECK (("company_id" = "public"."current_company_id"()));


--
-- Name: company_modules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."company_modules" ENABLE ROW LEVEL SECURITY;

--
-- Name: company_subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."company_subscriptions" ENABLE ROW LEVEL SECURITY;

--
-- Name: connectors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."connectors" ENABLE ROW LEVEL SECURITY;

--
-- Name: contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."contacts" ENABLE ROW LEVEL SECURITY;

--
-- Name: contracts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."contracts" ENABLE ROW LEVEL SECURITY;

--
-- Name: conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."conversations" ENABLE ROW LEVEL SECURITY;

--
-- Name: cost_centers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."cost_centers" ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_invoices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."customer_invoices" ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."customer_payments" ENABLE ROW LEVEL SECURITY;

--
-- Name: customers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."customers" ENABLE ROW LEVEL SECURITY;

--
-- Name: dashboards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."dashboards" ENABLE ROW LEVEL SECURITY;

--
-- Name: deals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."deals" ENABLE ROW LEVEL SECURITY;

--
-- Name: delegation_of_authority; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."delegation_of_authority" ENABLE ROW LEVEL SECURITY;

--
-- Name: delivery_routes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."delivery_routes" ENABLE ROW LEVEL SECURITY;

--
-- Name: delivery_schedules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."delivery_schedules" ENABLE ROW LEVEL SECURITY;

--
-- Name: document_embeddings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."document_embeddings" ENABLE ROW LEVEL SECURITY;

--
-- Name: employees; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."employees" ENABLE ROW LEVEL SECURITY;

--
-- Name: fixed_assets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."fixed_assets" ENABLE ROW LEVEL SECURITY;

--
-- Name: generated_documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."generated_documents" ENABLE ROW LEVEL SECURITY;

--
-- Name: goods_receipts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."goods_receipts" ENABLE ROW LEVEL SECURITY;

--
-- Name: inventory_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."inventory_items" ENABLE ROW LEVEL SECURITY;

--
-- Name: inventory_transfers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."inventory_transfers" ENABLE ROW LEVEL SECURITY;

--
-- Name: items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."items" ENABLE ROW LEVEL SECURITY;

--
-- Name: journal_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."journal_entries" ENABLE ROW LEVEL SECURITY;

--
-- Name: kb_documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."kb_documents" ENABLE ROW LEVEL SECURITY;

--
-- Name: landed_cost_vouchers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."landed_cost_vouchers" ENABLE ROW LEVEL SECURITY;

--
-- Name: leads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."leads" ENABLE ROW LEVEL SECURITY;

--
-- Name: loan_schedules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."loan_schedules" ENABLE ROW LEVEL SECURITY;

--
-- Name: mcp_connections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."mcp_connections" ENABLE ROW LEVEL SECURITY;

--
-- Name: mcp_oauth_grants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."mcp_oauth_grants" ENABLE ROW LEVEL SECURITY;

--
-- Name: mrp_planned_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."mrp_planned_orders" ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;

--
-- Name: payroll_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."payroll_runs" ENABLE ROW LEVEL SECURITY;

--
-- Name: pdf_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."pdf_templates" ENABLE ROW LEVEL SECURITY;

--
-- Name: period_close_checklist; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."period_close_checklist" ENABLE ROW LEVEL SECURITY;

--
-- Name: price_lists; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."price_lists" ENABLE ROW LEVEL SECURITY;

--
-- Name: projects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."projects" ENABLE ROW LEVEL SECURITY;

--
-- Name: purchase_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."purchase_orders" ENABLE ROW LEVEL SECURITY;

--
-- Name: purchase_requisitions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."purchase_requisitions" ENABLE ROW LEVEL SECURITY;

--
-- Name: recurring_invoice_schedules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."recurring_invoice_schedules" ENABLE ROW LEVEL SECURITY;

--
-- Name: report_definitions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."report_definitions" ENABLE ROW LEVEL SECURITY;

--
-- Name: report_schedules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."report_schedules" ENABLE ROW LEVEL SECURITY;

--
-- Name: request_for_quotations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."request_for_quotations" ENABLE ROW LEVEL SECURITY;

--
-- Name: revenue_schedules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."revenue_schedules" ENABLE ROW LEVEL SECURITY;

--
-- Name: rfqs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."rfqs" ENABLE ROW LEVEL SECURITY;

--
-- Name: sales_contracts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."sales_contracts" ENABLE ROW LEVEL SECURITY;

--
-- Name: sales_credit_notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."sales_credit_notes" ENABLE ROW LEVEL SECURITY;

--
-- Name: sales_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."sales_orders" ENABLE ROW LEVEL SECURITY;

--
-- Name: sales_quotations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."sales_quotations" ENABLE ROW LEVEL SECURITY;

--
-- Name: sales_rfqs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."sales_rfqs" ENABLE ROW LEVEL SECURITY;

--
-- Name: shipments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."shipments" ENABLE ROW LEVEL SECURITY;

--
-- Name: stocktake_sheets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."stocktake_sheets" ENABLE ROW LEVEL SECURITY;

--
-- Name: storage_locations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."storage_locations" ENABLE ROW LEVEL SECURITY;

--
-- Name: supplier_bank_detail_changes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."supplier_bank_detail_changes" ENABLE ROW LEVEL SECURITY;

--
-- Name: supplier_debit_notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."supplier_debit_notes" ENABLE ROW LEVEL SECURITY;

--
-- Name: supplier_invoices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."supplier_invoices" ENABLE ROW LEVEL SECURITY;

--
-- Name: supplier_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."supplier_items" ENABLE ROW LEVEL SECURITY;

--
-- Name: supplier_payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."supplier_payments" ENABLE ROW LEVEL SECURITY;

--
-- Name: suppliers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."suppliers" ENABLE ROW LEVEL SECURITY;

--
-- Name: tax_payment_schedules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."tax_payment_schedules" ENABLE ROW LEVEL SECURITY;

--
-- Name: time_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."time_entries" ENABLE ROW LEVEL SECURITY;

--
-- Name: uom_conversions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."uom_conversions" ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_counters; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."usage_counters" ENABLE ROW LEVEL SECURITY;

--
-- Name: warehouse_transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."warehouse_transactions" ENABLE ROW LEVEL SECURITY;

--
-- Name: webhook_subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."webhook_subscriptions" ENABLE ROW LEVEL SECURITY;

--
-- Name: work_centers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."work_centers" ENABLE ROW LEVEL SECURITY;

--
-- Name: work_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."work_orders" ENABLE ROW LEVEL SECURITY;

--
-- Name: trg_audit_ddl; Type: EVENT TRIGGER; Schema: -; Owner: -
--

CREATE EVENT TRIGGER "trg_audit_ddl" ON "ddl_command_end"
   EXECUTE FUNCTION "public"."fn_log_ddl_event"();


--
-- Name: trg_audit_sql_drop; Type: EVENT TRIGGER; Schema: -; Owner: -
--

CREATE EVENT TRIGGER "trg_audit_sql_drop" ON "sql_drop"
   EXECUTE FUNCTION "public"."fn_log_sql_drop"();


--
-- PostgreSQL database dump complete
--




-- ---------------------------------------------------------------------
-- Global reference data.
--
-- Rows, not schema, and deliberately so: these are the tables the tenancy
-- guard classifies as GLOBAL ("identical for every tenant"). Without the
-- currency list in particular, a fresh database cannot create a company at
-- all - companies.base_currency has a foreign key to currencies.
--
-- No tenant data is included. Only the eight global tables.
-- ---------------------------------------------------------------------

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14 (Debian 16.14-1.pgdg12+1)
-- Dumped by pg_dump version 16.14 (Debian 16.14-1.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: business_types; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO "public"."business_types" VALUES ('product_ecommerce', 'Product / E-commerce / Retail', 'Product', 'Sells physical or digital products directly to customers.');
INSERT INTO "public"."business_types" VALUES ('wholesale_distribution', 'Wholesale / Distribution', 'Product', 'Sells large quantities to other businesses.');
INSERT INTO "public"."business_types" VALUES ('manufacturing', 'Manufacturing', 'Product', 'Produces goods from raw materials or components.');
INSERT INTO "public"."business_types" VALUES ('professional_services', 'Professional Services', 'Service', 'Sells expertise or labor — consulting, legal, agencies, repair.');
INSERT INTO "public"."business_types" VALUES ('healthcare', 'Healthcare', 'Service', 'Clinics, telemedicine, diagnostics, medical devices.');
INSERT INTO "public"."business_types" VALUES ('education', 'Education / EdTech', 'Service', 'Courses, tutoring, learning platforms, institutions.');
INSERT INTO "public"."business_types" VALUES ('saas', 'SaaS', 'Software', 'Software sold by subscription.');
INSERT INTO "public"."business_types" VALUES ('enterprise_software', 'Enterprise Software', 'Software', 'ERP, CRM, HR, payroll and similar business software vendors.');
INSERT INTO "public"."business_types" VALUES ('ai_ml', 'Artificial Intelligence', 'Software', 'Models, AI agents, AI infrastructure, computer vision, voice AI.');
INSERT INTO "public"."business_types" VALUES ('cybersecurity', 'Cybersecurity', 'Software', 'Endpoint protection, identity, threat intel, security consulting.');
INSERT INTO "public"."business_types" VALUES ('marketplace', 'Marketplace', 'Platform', 'Connects buyers and sellers; commission or listing-fee revenue.');
INSERT INTO "public"."business_types" VALUES ('consumer_internet', 'Consumer Internet / Media', 'Platform', 'Social, streaming, gaming, news, creator platforms.');
INSERT INTO "public"."business_types" VALUES ('logistics', 'Logistics & Transportation', 'Operations', 'Shipping, trucking, warehousing, delivery, fleet management.');
INSERT INTO "public"."business_types" VALUES ('construction_realestate', 'Construction & Real Estate', 'Operations', 'Development, architecture, construction, property management.');
INSERT INTO "public"."business_types" VALUES ('agriculture', 'Agriculture / AgTech', 'Operations', 'Farming, livestock, agricultural technology.');
INSERT INTO "public"."business_types" VALUES ('energy', 'Energy', 'Operations', 'Oil & gas, renewables, storage, distribution.');
INSERT INTO "public"."business_types" VALUES ('industrial', 'Industrial & Infrastructure', 'Operations', 'Mining, heavy machinery, industrial automation.');
INSERT INTO "public"."business_types" VALUES ('robotics_hardware', 'Robotics & Hardware', 'Operations', 'Industrial, warehouse, and consumer robotics and devices.');
INSERT INTO "public"."business_types" VALUES ('biotechnology', 'Biotechnology', 'Operations', 'Gene editing, drug discovery, synthetic biology.');
INSERT INTO "public"."business_types" VALUES ('fintech', 'Finance (FinTech)', 'Finance', 'Payments, lending, investment platforms, insurance.');
INSERT INTO "public"."business_types" VALUES ('hospitality_tourism', 'Hospitality & Tourism', 'Consumer', 'Hotels, restaurants, travel, events.');
INSERT INTO "public"."business_types" VALUES ('advertising_marketing', 'Advertising & Marketing', 'Consumer', 'Agencies, SEO, influencer and affiliate marketing.');
INSERT INTO "public"."business_types" VALUES ('telecommunications', 'Telecommunications', 'Consumer', 'Internet, mobile, satellite, fiber providers.');
INSERT INTO "public"."business_types" VALUES ('government_nonprofit', 'Government & Nonprofit', 'Public', 'Public sector, defense, charities, NGOs, social enterprise.');


--
-- Data for Name: modules; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO "public"."modules" VALUES ('inventory', 'Inventory', 'Stock, warehouses, transfers, stocktakes.', false, 'Inventory');
INSERT INTO "public"."modules" VALUES ('procurement', 'Procurement', 'Suppliers, purchase requisitions, RFQs, purchase orders.', false, 'Procurement');
INSERT INTO "public"."modules" VALUES ('sales', 'Sales', 'Customers, sales orders, quotations, delivery scheduling.', false, 'Sales');
INSERT INTO "public"."modules" VALUES ('manufacturing', 'Manufacturing', 'Work orders, bills of material, MRP, work centers.', false, 'Manufacturing');
INSERT INTO "public"."modules" VALUES ('crm', 'CRM', 'Leads, deal pipeline, contacts, activities.', false, 'CRM');
INSERT INTO "public"."modules" VALUES ('projects', 'Projects', 'Project tracking and timesheets.', false, 'Projects');
INSERT INTO "public"."modules" VALUES ('hr', 'HR & Payroll', 'Employees, leave, attendance, payroll.', false, 'HR & Payroll');
INSERT INTO "public"."modules" VALUES ('finance', 'Finance', 'General ledger, AR/AP, assets, controlling, financial reports.', true, 'General Ledger');
INSERT INTO "public"."modules" VALUES ('reporting', 'Reporting', 'Cross-module reports and dashboards.', true, 'Reporting');
INSERT INTO "public"."modules" VALUES ('ai_assistant', 'AI Assistant', 'Chat, document search, autonomous agents.', true, 'Simeli AI');
INSERT INTO "public"."modules" VALUES ('admin', 'Administration', 'Users, approvals, delegation of authority, audit trail, billing.', true, NULL);
INSERT INTO "public"."modules" VALUES ('barcode_scanning', 'Barcode Scanning', 'Camera-based barcode scan-to-lookup and scan-to-receive.', false, NULL);


--
-- Data for Name: business_type_default_modules; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO "public"."business_type_default_modules" VALUES ('product_ecommerce', 'inventory');
INSERT INTO "public"."business_type_default_modules" VALUES ('product_ecommerce', 'procurement');
INSERT INTO "public"."business_type_default_modules" VALUES ('product_ecommerce', 'sales');
INSERT INTO "public"."business_type_default_modules" VALUES ('product_ecommerce', 'crm');
INSERT INTO "public"."business_type_default_modules" VALUES ('wholesale_distribution', 'inventory');
INSERT INTO "public"."business_type_default_modules" VALUES ('wholesale_distribution', 'procurement');
INSERT INTO "public"."business_type_default_modules" VALUES ('wholesale_distribution', 'sales');
INSERT INTO "public"."business_type_default_modules" VALUES ('wholesale_distribution', 'barcode_scanning');
INSERT INTO "public"."business_type_default_modules" VALUES ('manufacturing', 'inventory');
INSERT INTO "public"."business_type_default_modules" VALUES ('manufacturing', 'procurement');
INSERT INTO "public"."business_type_default_modules" VALUES ('manufacturing', 'sales');
INSERT INTO "public"."business_type_default_modules" VALUES ('manufacturing', 'manufacturing');
INSERT INTO "public"."business_type_default_modules" VALUES ('manufacturing', 'crm');
INSERT INTO "public"."business_type_default_modules" VALUES ('manufacturing', 'projects');
INSERT INTO "public"."business_type_default_modules" VALUES ('professional_services', 'crm');
INSERT INTO "public"."business_type_default_modules" VALUES ('professional_services', 'projects');
INSERT INTO "public"."business_type_default_modules" VALUES ('professional_services', 'sales');
INSERT INTO "public"."business_type_default_modules" VALUES ('healthcare', 'crm');
INSERT INTO "public"."business_type_default_modules" VALUES ('healthcare', 'projects');
INSERT INTO "public"."business_type_default_modules" VALUES ('healthcare', 'hr');
INSERT INTO "public"."business_type_default_modules" VALUES ('healthcare', 'inventory');
INSERT INTO "public"."business_type_default_modules" VALUES ('healthcare', 'procurement');
INSERT INTO "public"."business_type_default_modules" VALUES ('education', 'crm');
INSERT INTO "public"."business_type_default_modules" VALUES ('education', 'projects');
INSERT INTO "public"."business_type_default_modules" VALUES ('education', 'hr');
INSERT INTO "public"."business_type_default_modules" VALUES ('saas', 'crm');
INSERT INTO "public"."business_type_default_modules" VALUES ('saas', 'projects');
INSERT INTO "public"."business_type_default_modules" VALUES ('saas', 'sales');
INSERT INTO "public"."business_type_default_modules" VALUES ('enterprise_software', 'crm');
INSERT INTO "public"."business_type_default_modules" VALUES ('enterprise_software', 'projects');
INSERT INTO "public"."business_type_default_modules" VALUES ('enterprise_software', 'sales');
INSERT INTO "public"."business_type_default_modules" VALUES ('ai_ml', 'crm');
INSERT INTO "public"."business_type_default_modules" VALUES ('ai_ml', 'projects');
INSERT INTO "public"."business_type_default_modules" VALUES ('cybersecurity', 'crm');
INSERT INTO "public"."business_type_default_modules" VALUES ('cybersecurity', 'projects');
INSERT INTO "public"."business_type_default_modules" VALUES ('marketplace', 'crm');
INSERT INTO "public"."business_type_default_modules" VALUES ('marketplace', 'sales');
INSERT INTO "public"."business_type_default_modules" VALUES ('consumer_internet', 'crm');
INSERT INTO "public"."business_type_default_modules" VALUES ('consumer_internet', 'projects');
INSERT INTO "public"."business_type_default_modules" VALUES ('logistics', 'inventory');
INSERT INTO "public"."business_type_default_modules" VALUES ('logistics', 'procurement');
INSERT INTO "public"."business_type_default_modules" VALUES ('logistics', 'sales');
INSERT INTO "public"."business_type_default_modules" VALUES ('logistics', 'projects');
INSERT INTO "public"."business_type_default_modules" VALUES ('logistics', 'barcode_scanning');
INSERT INTO "public"."business_type_default_modules" VALUES ('construction_realestate', 'projects');
INSERT INTO "public"."business_type_default_modules" VALUES ('construction_realestate', 'procurement');
INSERT INTO "public"."business_type_default_modules" VALUES ('construction_realestate', 'crm');
INSERT INTO "public"."business_type_default_modules" VALUES ('agriculture', 'inventory');
INSERT INTO "public"."business_type_default_modules" VALUES ('agriculture', 'procurement');
INSERT INTO "public"."business_type_default_modules" VALUES ('agriculture', 'sales');
INSERT INTO "public"."business_type_default_modules" VALUES ('energy', 'inventory');
INSERT INTO "public"."business_type_default_modules" VALUES ('energy', 'procurement');
INSERT INTO "public"."business_type_default_modules" VALUES ('energy', 'projects');
INSERT INTO "public"."business_type_default_modules" VALUES ('industrial', 'inventory');
INSERT INTO "public"."business_type_default_modules" VALUES ('industrial', 'procurement');
INSERT INTO "public"."business_type_default_modules" VALUES ('industrial', 'manufacturing');
INSERT INTO "public"."business_type_default_modules" VALUES ('industrial', 'projects');
INSERT INTO "public"."business_type_default_modules" VALUES ('industrial', 'barcode_scanning');
INSERT INTO "public"."business_type_default_modules" VALUES ('robotics_hardware', 'inventory');
INSERT INTO "public"."business_type_default_modules" VALUES ('robotics_hardware', 'procurement');
INSERT INTO "public"."business_type_default_modules" VALUES ('robotics_hardware', 'manufacturing');
INSERT INTO "public"."business_type_default_modules" VALUES ('robotics_hardware', 'crm');
INSERT INTO "public"."business_type_default_modules" VALUES ('robotics_hardware', 'projects');
INSERT INTO "public"."business_type_default_modules" VALUES ('biotechnology', 'inventory');
INSERT INTO "public"."business_type_default_modules" VALUES ('biotechnology', 'procurement');
INSERT INTO "public"."business_type_default_modules" VALUES ('biotechnology', 'projects');
INSERT INTO "public"."business_type_default_modules" VALUES ('fintech', 'crm');
INSERT INTO "public"."business_type_default_modules" VALUES ('fintech', 'projects');
INSERT INTO "public"."business_type_default_modules" VALUES ('hospitality_tourism', 'crm');
INSERT INTO "public"."business_type_default_modules" VALUES ('hospitality_tourism', 'sales');
INSERT INTO "public"."business_type_default_modules" VALUES ('hospitality_tourism', 'projects');
INSERT INTO "public"."business_type_default_modules" VALUES ('advertising_marketing', 'crm');
INSERT INTO "public"."business_type_default_modules" VALUES ('advertising_marketing', 'projects');
INSERT INTO "public"."business_type_default_modules" VALUES ('telecommunications', 'crm');
INSERT INTO "public"."business_type_default_modules" VALUES ('telecommunications', 'sales');
INSERT INTO "public"."business_type_default_modules" VALUES ('telecommunications', 'projects');
INSERT INTO "public"."business_type_default_modules" VALUES ('government_nonprofit', 'crm');
INSERT INTO "public"."business_type_default_modules" VALUES ('government_nonprofit', 'projects');
INSERT INTO "public"."business_type_default_modules" VALUES ('government_nonprofit', 'procurement');


--
-- Data for Name: company_scoped_tables; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO "public"."company_scoped_tables" VALUES ('auto_purchase_orders');
INSERT INTO "public"."company_scoped_tables" VALUES ('bins');
INSERT INTO "public"."company_scoped_tables" VALUES ('chart_of_accounts');
INSERT INTO "public"."company_scoped_tables" VALUES ('contracts');
INSERT INTO "public"."company_scoped_tables" VALUES ('customer_invoices');
INSERT INTO "public"."company_scoped_tables" VALUES ('customer_payments');
INSERT INTO "public"."company_scoped_tables" VALUES ('customers');
INSERT INTO "public"."company_scoped_tables" VALUES ('delegation_of_authority');
INSERT INTO "public"."company_scoped_tables" VALUES ('delivery_routes');
INSERT INTO "public"."company_scoped_tables" VALUES ('delivery_schedules');
INSERT INTO "public"."company_scoped_tables" VALUES ('goods_receipts');
INSERT INTO "public"."company_scoped_tables" VALUES ('inventory_items');
INSERT INTO "public"."company_scoped_tables" VALUES ('items');
INSERT INTO "public"."company_scoped_tables" VALUES ('journal_entries');
INSERT INTO "public"."company_scoped_tables" VALUES ('purchase_orders');
INSERT INTO "public"."company_scoped_tables" VALUES ('purchase_requisitions');
INSERT INTO "public"."company_scoped_tables" VALUES ('request_for_quotations');
INSERT INTO "public"."company_scoped_tables" VALUES ('rfqs');
INSERT INTO "public"."company_scoped_tables" VALUES ('sales_contracts');
INSERT INTO "public"."company_scoped_tables" VALUES ('sales_orders');
INSERT INTO "public"."company_scoped_tables" VALUES ('sales_quotations');
INSERT INTO "public"."company_scoped_tables" VALUES ('sales_rfqs');
INSERT INTO "public"."company_scoped_tables" VALUES ('storage_locations');
INSERT INTO "public"."company_scoped_tables" VALUES ('suppliers');
INSERT INTO "public"."company_scoped_tables" VALUES ('warehouse_transactions');
INSERT INTO "public"."company_scoped_tables" VALUES ('supplier_invoices');
INSERT INTO "public"."company_scoped_tables" VALUES ('supplier_payments');
INSERT INTO "public"."company_scoped_tables" VALUES ('fixed_assets');
INSERT INTO "public"."company_scoped_tables" VALUES ('bank_accounts');
INSERT INTO "public"."company_scoped_tables" VALUES ('bank_transactions');
INSERT INTO "public"."company_scoped_tables" VALUES ('cost_centers');
INSERT INTO "public"."company_scoped_tables" VALUES ('budgets');
INSERT INTO "public"."company_scoped_tables" VALUES ('employees');
INSERT INTO "public"."company_scoped_tables" VALUES ('payroll_runs');
INSERT INTO "public"."company_scoped_tables" VALUES ('accounting_periods');
INSERT INTO "public"."company_scoped_tables" VALUES ('inventory_transfers');
INSERT INTO "public"."company_scoped_tables" VALUES ('recurring_invoice_schedules');
INSERT INTO "public"."company_scoped_tables" VALUES ('approval_chain_templates');
INSERT INTO "public"."company_scoped_tables" VALUES ('approval_requests');
INSERT INTO "public"."company_scoped_tables" VALUES ('bills_of_material');
INSERT INTO "public"."company_scoped_tables" VALUES ('work_orders');
INSERT INTO "public"."company_scoped_tables" VALUES ('mrp_planned_orders');
INSERT INTO "public"."company_scoped_tables" VALUES ('contacts');
INSERT INTO "public"."company_scoped_tables" VALUES ('deals');
INSERT INTO "public"."company_scoped_tables" VALUES ('activities');
INSERT INTO "public"."company_scoped_tables" VALUES ('projects');
INSERT INTO "public"."company_scoped_tables" VALUES ('ai_audit_log');
INSERT INTO "public"."company_scoped_tables" VALUES ('api_keys');
INSERT INTO "public"."company_scoped_tables" VALUES ('webhook_subscriptions');
INSERT INTO "public"."company_scoped_tables" VALUES ('agent_runs');
INSERT INTO "public"."company_scoped_tables" VALUES ('ai_findings');
INSERT INTO "public"."company_scoped_tables" VALUES ('agent_definitions');
INSERT INTO "public"."company_scoped_tables" VALUES ('agent_escalations');
INSERT INTO "public"."company_scoped_tables" VALUES ('time_entries');
INSERT INTO "public"."company_scoped_tables" VALUES ('chat_memory');
INSERT INTO "public"."company_scoped_tables" VALUES ('notifications');
INSERT INTO "public"."company_scoped_tables" VALUES ('supplier_items');
INSERT INTO "public"."company_scoped_tables" VALUES ('report_definitions');
INSERT INTO "public"."company_scoped_tables" VALUES ('report_schedules');
INSERT INTO "public"."company_scoped_tables" VALUES ('dashboards');
INSERT INTO "public"."company_scoped_tables" VALUES ('ai_tools');
INSERT INTO "public"."company_scoped_tables" VALUES ('ai_tool_versions');
INSERT INTO "public"."company_scoped_tables" VALUES ('ai_credentials');
INSERT INTO "public"."company_scoped_tables" VALUES ('ai_tool_settings');
INSERT INTO "public"."company_scoped_tables" VALUES ('agent_memory');
INSERT INTO "public"."company_scoped_tables" VALUES ('generated_documents');
INSERT INTO "public"."company_scoped_tables" VALUES ('pdf_templates');
INSERT INTO "public"."company_scoped_tables" VALUES ('ai_settings');
INSERT INTO "public"."company_scoped_tables" VALUES ('mcp_connections');
INSERT INTO "public"."company_scoped_tables" VALUES ('connectors');
INSERT INTO "public"."company_scoped_tables" VALUES ('ai_usage_log');
INSERT INTO "public"."company_scoped_tables" VALUES ('ai_feedback');
INSERT INTO "public"."company_scoped_tables" VALUES ('stocktake_sheets');
INSERT INTO "public"."company_scoped_tables" VALUES ('sales_credit_notes');
INSERT INTO "public"."company_scoped_tables" VALUES ('leads');
INSERT INTO "public"."company_scoped_tables" VALUES ('conversations');
INSERT INTO "public"."company_scoped_tables" VALUES ('supplier_debit_notes');
INSERT INTO "public"."company_scoped_tables" VALUES ('agent_paused_runs');
INSERT INTO "public"."company_scoped_tables" VALUES ('work_centers');
INSERT INTO "public"."company_scoped_tables" VALUES ('document_embeddings');
INSERT INTO "public"."company_scoped_tables" VALUES ('agent_blueprints');
INSERT INTO "public"."company_scoped_tables" VALUES ('background_tasks');
INSERT INTO "public"."company_scoped_tables" VALUES ('mcp_oauth_grants');
INSERT INTO "public"."company_scoped_tables" VALUES ('agent_credentials');
INSERT INTO "public"."company_scoped_tables" VALUES ('landed_cost_vouchers');
INSERT INTO "public"."company_scoped_tables" VALUES ('price_lists');
INSERT INTO "public"."company_scoped_tables" VALUES ('shipments');
INSERT INTO "public"."company_scoped_tables" VALUES ('uom_conversions');
INSERT INTO "public"."company_scoped_tables" VALUES ('revenue_schedules');
INSERT INTO "public"."company_scoped_tables" VALUES ('company_gl_mappings');
INSERT INTO "public"."company_scoped_tables" VALUES ('ai_finding_suppressions');
INSERT INTO "public"."company_scoped_tables" VALUES ('supplier_bank_detail_changes');
INSERT INTO "public"."company_scoped_tables" VALUES ('loan_schedules');
INSERT INTO "public"."company_scoped_tables" VALUES ('tax_payment_schedules');
INSERT INTO "public"."company_scoped_tables" VALUES ('period_close_checklist');
INSERT INTO "public"."company_scoped_tables" VALUES ('audit_chain');
INSERT INTO "public"."company_scoped_tables" VALUES ('approval_delegations');
INSERT INTO "public"."company_scoped_tables" VALUES ('ai_learned_preferences');
INSERT INTO "public"."company_scoped_tables" VALUES ('kb_documents');
INSERT INTO "public"."company_scoped_tables" VALUES ('company_modules');
INSERT INTO "public"."company_scoped_tables" VALUES ('company_subscriptions');
INSERT INTO "public"."company_scoped_tables" VALUES ('usage_counters');


--
-- Data for Name: currencies; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO "public"."currencies" VALUES ('USD', 'US Dollar', '$', true, true, '2026-07-22 08:38:21.969408+00', '2026-07-22 08:38:21.969408+00');
INSERT INTO "public"."currencies" VALUES ('AED', 'UAE Dirham', 'د.إ', false, true, '2026-07-22 08:38:21.969408+00', '2026-07-22 08:38:21.969408+00');
INSERT INTO "public"."currencies" VALUES ('EUR', 'Euro', '€', false, true, '2026-07-22 08:38:21.969408+00', '2026-07-22 08:38:21.969408+00');
INSERT INTO "public"."currencies" VALUES ('AZN', 'Azerbaijani Manat', '₼', false, true, '2026-07-22 08:38:21.969408+00', '2026-07-22 08:38:21.969408+00');
INSERT INTO "public"."currencies" VALUES ('GBP', 'British Pound', '£', false, true, '2026-07-22 08:38:21.969408+00', '2026-07-22 08:38:21.969408+00');


--
-- Data for Name: exchange_rates; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO "public"."exchange_rates" VALUES ('1ef8af54-2e1b-47f2-80ce-59d45d82c00d', 'USD', 'EUR', 0.86693000, '2026-08-08', NULL, '2026-08-08 20:38:17.935096+00');
INSERT INTO "public"."exchange_rates" VALUES ('c10e9983-a0a2-4fd7-a01a-f62de5d38257', 'USD', 'GBP', 0.74352000, '2026-08-08', NULL, '2026-08-08 20:38:17.946901+00');


--
-- Data for Name: plans; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO "public"."plans" VALUES ('free', 'Free', 0, NULL, 3, 200, 500, '["Up to 3 users", "200 AI messages/month", "500 embedding/search calls/month", "All core ERP modules", "Community support"]', NULL, true);
INSERT INTO "public"."plans" VALUES ('pro', 'Pro', 4900, 'month', 25, 5000, 20000, '["Up to 25 users", "5,000 AI messages/month", "20,000 embedding/search calls/month", "All modules incl. AI agents", "Priority email support"]', NULL, true);
INSERT INTO "public"."plans" VALUES ('enterprise', 'Enterprise', 0, NULL, NULL, NULL, NULL, '["Unlimited users", "Unlimited AI usage", "Unlimited embedding/search calls", "Dedicated support", "Custom SLAs"]', NULL, true);


--
-- Data for Name: tax_jurisdictions; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO "public"."tax_jurisdictions" VALUES ('DE', 'Germany', 'DE', NULL, 'VAT');
INSERT INTO "public"."tax_jurisdictions" VALUES ('FR', 'France', 'FR', NULL, 'VAT');
INSERT INTO "public"."tax_jurisdictions" VALUES ('GB', 'United Kingdom', 'GB', NULL, 'VAT');
INSERT INTO "public"."tax_jurisdictions" VALUES ('IE', 'Ireland', 'IE', NULL, 'VAT');
INSERT INTO "public"."tax_jurisdictions" VALUES ('ES', 'Spain', 'ES', NULL, 'VAT');
INSERT INTO "public"."tax_jurisdictions" VALUES ('IT', 'Italy', 'IT', NULL, 'VAT');
INSERT INTO "public"."tax_jurisdictions" VALUES ('NL', 'Netherlands', 'NL', NULL, 'VAT');
INSERT INTO "public"."tax_jurisdictions" VALUES ('AE', 'United Arab Emirates', 'AE', NULL, 'VAT');
INSERT INTO "public"."tax_jurisdictions" VALUES ('SA', 'Saudi Arabia', 'SA', NULL, 'VAT');
INSERT INTO "public"."tax_jurisdictions" VALUES ('IN', 'India', 'IN', NULL, 'GST');
INSERT INTO "public"."tax_jurisdictions" VALUES ('AU', 'Australia', 'AU', NULL, 'GST');
INSERT INTO "public"."tax_jurisdictions" VALUES ('SG', 'Singapore', 'SG', NULL, 'GST');
INSERT INTO "public"."tax_jurisdictions" VALUES ('CA', 'Canada (federal GST)', 'CA', NULL, 'GST');
INSERT INTO "public"."tax_jurisdictions" VALUES ('JP', 'Japan', 'JP', NULL, 'VAT');
INSERT INTO "public"."tax_jurisdictions" VALUES ('US-CA', 'California', 'US', 'CA', 'SALES_TAX');
INSERT INTO "public"."tax_jurisdictions" VALUES ('US-NY', 'New York (state)', 'US', 'NY', 'SALES_TAX');
INSERT INTO "public"."tax_jurisdictions" VALUES ('US-TX', 'Texas', 'US', 'TX', 'SALES_TAX');
INSERT INTO "public"."tax_jurisdictions" VALUES ('US-FL', 'Florida', 'US', 'FL', 'SALES_TAX');
INSERT INTO "public"."tax_jurisdictions" VALUES ('US-WA', 'Washington', 'US', 'WA', 'SALES_TAX');


--
-- Data for Name: tax_codes; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO "public"."tax_codes" VALUES ('DE-VAT-STD', 'DE', 'Germany VAT standard', 'VAT', 'STANDARD', 19.000, '2026-08-08', true);
INSERT INTO "public"."tax_codes" VALUES ('DE-VAT-RED', 'DE', 'Germany VAT reduced', 'VAT', 'REDUCED', 7.000, '2026-08-08', true);
INSERT INTO "public"."tax_codes" VALUES ('FR-VAT-STD', 'FR', 'France VAT standard', 'VAT', 'STANDARD', 20.000, '2026-08-08', true);
INSERT INTO "public"."tax_codes" VALUES ('FR-VAT-RED', 'FR', 'France VAT reduced', 'VAT', 'REDUCED', 5.500, '2026-08-08', true);
INSERT INTO "public"."tax_codes" VALUES ('GB-VAT-STD', 'GB', 'UK VAT standard', 'VAT', 'STANDARD', 20.000, '2026-08-08', true);
INSERT INTO "public"."tax_codes" VALUES ('GB-VAT-RED', 'GB', 'UK VAT reduced', 'VAT', 'REDUCED', 5.000, '2026-08-08', true);
INSERT INTO "public"."tax_codes" VALUES ('IE-VAT-STD', 'IE', 'Ireland VAT standard', 'VAT', 'STANDARD', 23.000, '2026-08-08', true);
INSERT INTO "public"."tax_codes" VALUES ('ES-VAT-STD', 'ES', 'Spain VAT standard', 'VAT', 'STANDARD', 21.000, '2026-08-08', true);
INSERT INTO "public"."tax_codes" VALUES ('IT-VAT-STD', 'IT', 'Italy VAT standard', 'VAT', 'STANDARD', 22.000, '2026-08-08', true);
INSERT INTO "public"."tax_codes" VALUES ('NL-VAT-STD', 'NL', 'Netherlands VAT standard', 'VAT', 'STANDARD', 21.000, '2026-08-08', true);
INSERT INTO "public"."tax_codes" VALUES ('AE-VAT-STD', 'AE', 'UAE VAT standard', 'VAT', 'STANDARD', 5.000, '2026-08-08', true);
INSERT INTO "public"."tax_codes" VALUES ('SA-VAT-STD', 'SA', 'Saudi Arabia VAT standard', 'VAT', 'STANDARD', 15.000, '2026-08-08', true);
INSERT INTO "public"."tax_codes" VALUES ('IN-GST-STD', 'IN', 'India GST standard slab', 'GST', 'STANDARD', 18.000, '2026-08-08', true);
INSERT INTO "public"."tax_codes" VALUES ('AU-GST-STD', 'AU', 'Australia GST', 'GST', 'STANDARD', 10.000, '2026-08-08', true);
INSERT INTO "public"."tax_codes" VALUES ('SG-GST-STD', 'SG', 'Singapore GST', 'GST', 'STANDARD', 9.000, '2026-08-08', true);
INSERT INTO "public"."tax_codes" VALUES ('CA-GST-STD', 'CA', 'Canada federal GST', 'GST', 'STANDARD', 5.000, '2026-08-08', true);
INSERT INTO "public"."tax_codes" VALUES ('JP-VAT-STD', 'JP', 'Japan consumption tax', 'VAT', 'STANDARD', 10.000, '2026-08-08', true);
INSERT INTO "public"."tax_codes" VALUES ('US-CA-SALES-STD', 'US-CA', 'California state sales tax', 'SALES_TAX', 'STANDARD', 7.250, '2026-08-08', true);
INSERT INTO "public"."tax_codes" VALUES ('US-NY-SALES-STD', 'US-NY', 'New York state sales tax', 'SALES_TAX', 'STANDARD', 4.000, '2026-08-08', true);
INSERT INTO "public"."tax_codes" VALUES ('US-TX-SALES-STD', 'US-TX', 'Texas state sales tax', 'SALES_TAX', 'STANDARD', 6.250, '2026-08-08', true);
INSERT INTO "public"."tax_codes" VALUES ('US-FL-SALES-STD', 'US-FL', 'Florida state sales tax', 'SALES_TAX', 'STANDARD', 6.000, '2026-08-08', true);
INSERT INTO "public"."tax_codes" VALUES ('US-WA-SALES-STD', 'US-WA', 'Washington state sales tax', 'SALES_TAX', 'STANDARD', 6.500, '2026-08-08', true);
INSERT INTO "public"."tax_codes" VALUES ('DE-WHT-SERVICES', 'DE', 'Germany WHT — services', 'WHT', 'SERVICES', 15.000, '2026-08-08', true);
INSERT INTO "public"."tax_codes" VALUES ('DE-WHT-DIVIDENDS', 'DE', 'Germany WHT — dividends', 'WHT', 'DIVIDENDS', 26.375, '2026-08-08', true);
INSERT INTO "public"."tax_codes" VALUES ('GB-WHT-INTEREST', 'GB', 'UK WHT — interest', 'WHT', 'INTEREST', 20.000, '2026-08-08', true);
INSERT INTO "public"."tax_codes" VALUES ('IN-WHT-SERVICES', 'IN', 'India WHT (TDS) — services', 'WHT', 'SERVICES', 10.000, '2026-08-08', true);
INSERT INTO "public"."tax_codes" VALUES ('IN-WHT-ROYALTIES', 'IN', 'India WHT (TDS) — royalties', 'WHT', 'ROYALTIES', 10.000, '2026-08-08', true);
INSERT INTO "public"."tax_codes" VALUES ('AE-WHT-SERVICES', 'AE', 'UAE WHT — services', 'WHT', 'SERVICES', 0.000, '2026-08-08', true);


--
-- PostgreSQL database dump complete
--


