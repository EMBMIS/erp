-- Sales RFQs (Request for Quotations to Suppliers) Migration
-- Creates tables for managing RFQ requests from sales teams to suppliers

-- Main Sales RFQs table
CREATE TABLE IF NOT EXISTS sales_rfqs (
    id SERIAL PRIMARY KEY,
    rfq_number VARCHAR(50) UNIQUE NOT NULL,
    rfq_title VARCHAR(255) NOT NULL,
    supplier_id UUID REFERENCES suppliers(id),
    supplier_name VARCHAR(255), -- For non-registered suppliers
    supplier_email VARCHAR(255),
    supplier_contact_person VARCHAR(255),
    supplier_phone VARCHAR(50),
    
    -- Request details
    request_type VARCHAR(50) DEFAULT 'TRADING' CHECK (request_type IN ('TRADING', 'INTERNAL_USE', 'RESALE')),
    required_delivery_date DATE,
    delivery_location VARCHAR(500),
    delivery_terms VARCHAR(255),
    payment_terms VARCHAR(255),
    
    -- Status and workflow
    status VARCHAR(50) DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SENT', 'RESPONDED', 'PARTIALLY_RESPONDED', 'EXPIRED', 'CANCELLED', 'COMPLETED')),
    priority VARCHAR(20) DEFAULT 'MEDIUM' CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT')),
    
    -- Response tracking
    response_deadline DATE,
    response_received_at TIMESTAMP,
    supplier_response_method VARCHAR(50) CHECK (supplier_response_method IN ('SYSTEM', 'EMAIL', 'PHONE', 'MANUAL_ENTRY')),
    
    -- Additional information
    special_requirements TEXT,
    terms_and_conditions TEXT,
    internal_notes TEXT,
    attachment_urls TEXT[], -- Array of document URLs
    
    -- Linking
    linked_customer_id UUID REFERENCES customers(id), -- If RFQ is for specific customer
    linked_sales_quotation_id INTEGER, -- Will link to sales quotations when created
    source_document_type VARCHAR(50), -- 'SALES_INQUIRY', 'INTERNAL_REQUEST', 'CUSTOMER_QUOTE'
    source_document_id INTEGER,
    
    -- Supplier response data
    supplier_total_amount DECIMAL(15,2),
    supplier_currency VARCHAR(10) DEFAULT 'USD',
    supplier_validity_days INTEGER,
    supplier_comments TEXT,
    supplier_alternative_items TEXT,
    
    -- Audit fields
    created_by UUID NOT NULL REFERENCES users(id),
    updated_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

-- Sales RFQ Items table
CREATE TABLE IF NOT EXISTS sales_rfq_items (
    id SERIAL PRIMARY KEY,
    sales_rfq_id INTEGER NOT NULL REFERENCES sales_rfqs(id) ON DELETE CASCADE,
    line_number INTEGER NOT NULL,
    
    -- Item information
    item_id UUID REFERENCES items(id), -- Reference to master items
    item_name VARCHAR(255) NOT NULL,
    item_description TEXT,
    item_specification TEXT,
    
    -- Request details
    requested_quantity DECIMAL(15,3) NOT NULL,
    unit_of_measure VARCHAR(50) NOT NULL,
    estimated_unit_price DECIMAL(15,4), -- Internal estimate
    
    -- Supplier response
    quoted_unit_price DECIMAL(15,4),
    quoted_total_price DECIMAL(15,2),
    supplier_lead_time_days INTEGER,
    supplier_minimum_order_quantity DECIMAL(15,3),
    supplier_item_code VARCHAR(100),
    supplier_brand VARCHAR(100),
    supplier_availability_status VARCHAR(50),
    supplier_item_notes TEXT,
    
    -- Alternative options from supplier
    supplier_alternative_item_name VARCHAR(255),
    supplier_alternative_unit_price DECIMAL(15,4),
    supplier_alternative_description TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Sales RFQ Status History table
CREATE TABLE IF NOT EXISTS sales_rfq_status_history (
    id SERIAL PRIMARY KEY,
    sales_rfq_id INTEGER NOT NULL REFERENCES sales_rfqs(id) ON DELETE CASCADE,
    status VARCHAR(50) NOT NULL,
    previous_status VARCHAR(50),
    changed_by UUID NOT NULL REFERENCES users(id),
    change_reason TEXT,
    changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Sales RFQ Communication Log table
CREATE TABLE IF NOT EXISTS sales_rfq_communications (
    id SERIAL PRIMARY KEY,
    sales_rfq_id INTEGER NOT NULL REFERENCES sales_rfqs(id) ON DELETE CASCADE,
    communication_type VARCHAR(50) NOT NULL CHECK (communication_type IN ('EMAIL_SENT', 'EMAIL_RECEIVED', 'PHONE_CALL', 'SYSTEM_MESSAGE', 'MANUAL_NOTE')),
    direction VARCHAR(20) CHECK (direction IN ('INBOUND', 'OUTBOUND')),
    subject VARCHAR(255),
    message_content TEXT,
    sender_name VARCHAR(255),
    sender_email VARCHAR(255),
    recipient_name VARCHAR(255),
    recipient_email VARCHAR(255),
    attachment_urls TEXT[],
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_sales_rfqs_supplier_id ON sales_rfqs(supplier_id);
CREATE INDEX IF NOT EXISTS idx_sales_rfqs_status ON sales_rfqs(status);
CREATE INDEX IF NOT EXISTS idx_sales_rfqs_created_at ON sales_rfqs(created_at);
CREATE INDEX IF NOT EXISTS idx_sales_rfqs_response_deadline ON sales_rfqs(response_deadline);
CREATE INDEX IF NOT EXISTS idx_sales_rfqs_required_delivery_date ON sales_rfqs(required_delivery_date);
CREATE INDEX IF NOT EXISTS idx_sales_rfqs_deleted_at ON sales_rfqs(deleted_at) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sales_rfq_items_rfq_id ON sales_rfq_items(sales_rfq_id);
CREATE INDEX IF NOT EXISTS idx_sales_rfq_items_item_id ON sales_rfq_items(item_id);

CREATE INDEX IF NOT EXISTS idx_sales_rfq_status_history_rfq_id ON sales_rfq_status_history(sales_rfq_id);
CREATE INDEX IF NOT EXISTS idx_sales_rfq_status_history_changed_at ON sales_rfq_status_history(changed_at);

CREATE INDEX IF NOT EXISTS idx_sales_rfq_communications_rfq_id ON sales_rfq_communications(sales_rfq_id);
CREATE INDEX IF NOT EXISTS idx_sales_rfq_communications_created_at ON sales_rfq_communications(created_at);

-- Create trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_sales_rfqs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_sales_rfqs_updated_at_trigger
    BEFORE UPDATE ON sales_rfqs
    FOR EACH ROW
    EXECUTE FUNCTION update_sales_rfqs_updated_at();

CREATE TRIGGER update_sales_rfq_items_updated_at_trigger
    BEFORE UPDATE ON sales_rfq_items
    FOR EACH ROW
    EXECUTE FUNCTION update_sales_rfqs_updated_at();

-- Function to generate RFQ number
CREATE OR REPLACE FUNCTION generate_sales_rfq_number()
RETURNS TEXT AS $$
DECLARE
    next_number INTEGER;
    rfq_number TEXT;
BEGIN
    -- Get the next sequence number
    SELECT COALESCE(MAX(CAST(SUBSTRING(rfq_number FROM 'SRFQ-(.*)') AS INTEGER)), 0) + 1
    INTO next_number
    FROM sales_rfqs
    WHERE rfq_number ~ '^SRFQ-[0-9]+$';
    
    -- Format as SRFQ-000001
    rfq_number := 'SRFQ-' || LPAD(next_number::TEXT, 6, '0');
    
    RETURN rfq_number;
END;
$$ LANGUAGE plpgsql;