-- Add response token to sales_rfqs for supplier portal access
ALTER TABLE sales_rfqs ADD COLUMN response_token VARCHAR(64);

-- Add index for response token lookups
CREATE INDEX idx_sales_rfqs_response_token ON sales_rfqs(response_token);

-- Create sales_rfq_supplier_responses table
CREATE TABLE IF NOT EXISTS sales_rfq_supplier_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- INTEGER, not UUID: sales_rfqs.id is a SERIAL (see 034). This said UUID and
  -- so could never have been executed — on the original database the table
  -- already existed, CREATE TABLE IF NOT EXISTS silently did nothing, and the
  -- migration recorded itself as applied without running. The error only
  -- surfaces on a from-scratch build. INTEGER matches both sales_rfqs.id and
  -- the column that actually exists on the live database.
  sales_rfq_id INTEGER NOT NULL REFERENCES sales_rfqs(id),
  supplier_total_amount NUMERIC(12,2),
  supplier_currency VARCHAR(3) DEFAULT 'USD',
  supplier_validity_days INTEGER DEFAULT 30,
  supplier_comments TEXT,
  supplier_alternative_items TEXT,
  supplier_response_method VARCHAR(20) DEFAULT 'PORTAL',
  responded_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create sales_rfq_item_responses table
CREATE TABLE IF NOT EXISTS sales_rfq_item_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  response_id UUID NOT NULL REFERENCES sales_rfq_supplier_responses(id),
  -- INTEGER for the same reason: sales_rfq_items.id is a SERIAL too.
  sales_rfq_item_id INTEGER REFERENCES sales_rfq_items(id),
  item_name VARCHAR(255) NOT NULL,
  requested_quantity NUMERIC(10,3) NOT NULL,
  unit_of_measure VARCHAR(50) NOT NULL,
  quoted_unit_price NUMERIC(12,2) NOT NULL,
  quoted_total_price NUMERIC(12,2) NOT NULL,
  availability_status VARCHAR(20) DEFAULT 'AVAILABLE',
  lead_time_days INTEGER,
  supplier_notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Add indexes for performance
CREATE INDEX idx_sales_rfq_supplier_responses_sales_rfq_id ON sales_rfq_supplier_responses(sales_rfq_id);
CREATE INDEX idx_sales_rfq_item_responses_response_id ON sales_rfq_item_responses(response_id);
CREATE INDEX idx_sales_rfq_item_responses_sales_rfq_item_id ON sales_rfq_item_responses(sales_rfq_item_id);

-- Add constraint for availability status
ALTER TABLE sales_rfq_item_responses ADD CONSTRAINT sales_rfq_item_responses_availability_status_check 
CHECK (availability_status IN ('AVAILABLE', 'LIMITED', 'OUT_OF_STOCK', 'DISCONTINUED'));

-- Add constraint for response method
ALTER TABLE sales_rfq_supplier_responses ADD CONSTRAINT sales_rfq_supplier_responses_method_check 
CHECK (supplier_response_method IN ('PORTAL', 'EMAIL', 'PHONE', 'SYSTEM'));

-- Add notification type for Sales RFQ responses if not exists.
--
-- Guarded on the table existing, because it does not. `notification_types` is
-- created by no migration and by no schema file, and is absent from the
-- original database too — notification types are enforced as a CHECK
-- constraint on notifications.type (see 043), not as a lookup table. The
-- original EXCEPTION handler only caught unique_violation, so on any database
-- actually running this SQL it raised undefined_table and aborted the
-- migration; it survived only because this file was never executed.
--
-- Kept rather than deleted so the intent is still recorded if a
-- notification_types table is ever introduced.
DO $$
BEGIN
    IF to_regclass('public.notification_types') IS NOT NULL THEN
        INSERT INTO notification_types (type_name, description)
        VALUES ('SALES_RFQ_RESPONSE', 'Supplier has responded to Sales RFQ request')
        ON CONFLICT DO NOTHING;
    END IF;
END
$$;