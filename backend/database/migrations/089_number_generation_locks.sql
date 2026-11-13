-- 089 — Concurrency-safe number generation.
-- Adds a transaction-level advisory lock to each MAX()+1 number generator so
-- two concurrent inserts cannot compute the same number (which otherwise
-- surfaces as a duplicate-key 500 under load). Mirrors the fix already applied
-- to generate_journal_entry_number in migration 088. Sequence-based generators
-- (PO, PR, RFQ, contract, warehouse) are already race-free and untouched.
-- Idempotent: CREATE OR REPLACE, safe to re-run.

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
$function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public.generate_invoice_number()
 RETURNS text
 LANGUAGE plpgsql
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.generate_payment_number()
 RETURNS text
 LANGUAGE plpgsql
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.generate_sales_rfq_number()
 RETURNS text
 LANGUAGE plpgsql
AS $function$
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
$function$
;

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
$function$
;

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
$function$
;

