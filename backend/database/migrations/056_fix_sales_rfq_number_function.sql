-- Fix ambiguous column reference in generate_sales_rfq_number function
-- The variable name rfq_number was conflicting with the column name

CREATE OR REPLACE FUNCTION generate_sales_rfq_number()
RETURNS TEXT AS $$
DECLARE
    next_number INTEGER;
    new_rfq_number TEXT;
BEGIN
    -- Get the next sequence number by explicitly referencing the table column
    SELECT COALESCE(MAX(CAST(SUBSTRING(sales_rfqs.rfq_number FROM 'SRFQ-(.*)') AS INTEGER)), 0) + 1
    INTO next_number
    FROM sales_rfqs
    WHERE sales_rfqs.rfq_number ~ '^SRFQ-[0-9]+$';
    
    -- Format as SRFQ-000001
    new_rfq_number := 'SRFQ-' || LPAD(next_number::TEXT, 6, '0');
    
    RETURN new_rfq_number;
END;
$$ LANGUAGE plpgsql;