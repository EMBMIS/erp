-- 102 — Re-assert advisory locks on the number generators that lost them.
--
-- Migrations 088 and 089 both added pg_advisory_xact_lock() to the MAX()+1
-- number generators, and schema_migrations records BOTH as applied. The live
-- database disagreed: generate_journal_entry_number, generate_asset_number,
-- generate_employee_number, generate_supplier_bill_number and
-- generate_supplier_payment_number all still ran unserialized. The live journal
-- function body was in fact migration 075's revision, not 088's.
--
-- Root cause (fixed separately in scripts/db-migrate.js): the runner used to
-- catch "already exists"-class errors, ROLL BACK the entire migration, and then
-- record it as applied — discarding every other statement in the file forever.
--
-- Impact of the missing locks: two concurrent inserts read the same MAX() and
-- compute the same number, so the second one dies on the UNIQUE constraint as a
-- user-facing 500. This is a load-dependent failure, invisible in single-user
-- testing, which is why it survived two migrations that "fixed" it.
--
-- Every function below preserves its existing body exactly and only adds the
-- lock. Idempotent: CREATE OR REPLACE, safe to re-run.

-- ---------------------------------------------------------------------------
-- Journal entries. Keeps 075's ambiguity fix (aliased local + use_column) AND
-- adds 088's intended lock. This is the one blocking real GL postings.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_journal_entry_number()
 RETURNS character varying
 LANGUAGE plpgsql
AS $function$
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
$function$;

-- ---------------------------------------------------------------------------
-- Fixed assets
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_asset_number()
 RETURNS text
 LANGUAGE plpgsql
AS $function$
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
$function$;

-- ---------------------------------------------------------------------------
-- Employees
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_employee_number()
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE
    next_number INTEGER;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('generate_employee_number'));
    SELECT COALESCE(MAX(
        CASE WHEN employee_number ~ '^EMP-[0-9]+$' THEN SUBSTRING(employee_number FROM '\-([0-9]+)$')::INTEGER ELSE 0 END
    ), 0) + 1 INTO next_number FROM employees;
    RETURN 'EMP-' || LPAD(next_number::TEXT, 4, '0');
END;
$function$;

-- ---------------------------------------------------------------------------
-- Supplier bills
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_supplier_bill_number()
 RETURNS text
 LANGUAGE plpgsql
AS $function$
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
$function$;

-- ---------------------------------------------------------------------------
-- Supplier payments
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_supplier_payment_number()
 RETURNS text
 LANGUAGE plpgsql
AS $function$
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
$function$;
