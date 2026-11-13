-- FIX: generate_journal_entry_number() declared a PL/pgSQL variable named
-- "journal_number" that collides with the journal_entries.journal_number column,
-- causing "column reference journal_number is ambiguous" on EVERY call — which
-- made every GL posting (sales revenue, AP, depreciation, payroll, etc.) fail.
-- Rename the local variable and pin variable_conflict to be safe.

CREATE OR REPLACE FUNCTION generate_journal_entry_number()
RETURNS VARCHAR(50) AS $$
#variable_conflict use_column
DECLARE
    next_number INTEGER;
    year_suffix VARCHAR(4);
    v_journal_number VARCHAR(50);
BEGIN
    year_suffix := TO_CHAR(CURRENT_DATE, 'YYYY');

    SELECT COALESCE(MAX(CAST(SUBSTRING(journal_number FROM 'JE-' || year_suffix || '-(\d+)') AS INTEGER)), 0) + 1
    INTO next_number
    FROM journal_entries
    WHERE journal_number LIKE 'JE-' || year_suffix || '-%';

    v_journal_number := 'JE-' || year_suffix || '-' || LPAD(next_number::TEXT, 6, '0');

    RETURN v_journal_number;
END;
$$ LANGUAGE plpgsql;
