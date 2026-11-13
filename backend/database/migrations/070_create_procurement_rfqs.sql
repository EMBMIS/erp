-- Migration: Create Procurement RFQs table
-- This creates the missing 'rfqs' table for procurement purposes (separate from sales_rfqs)

CREATE TABLE IF NOT EXISTS rfqs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rfq_number VARCHAR(50) UNIQUE NOT NULL,
    rfq_title VARCHAR(255) NOT NULL,
    
    -- Supplier Information
    supplier_id UUID REFERENCES suppliers(id),
    supplier_name VARCHAR(255),
    supplier_email VARCHAR(255),
    supplier_contact_person VARCHAR(255),
    supplier_phone VARCHAR(50),
    
    -- RFQ Details
    request_type VARCHAR(50) DEFAULT 'PROCUREMENT', -- PROCUREMENT, SERVICES, etc.
    required_delivery_date TIMESTAMP,
    delivery_location TEXT,
    delivery_terms VARCHAR(50), -- FOB, CIF, DDP, etc.
    payment_terms VARCHAR(255),
    
    -- Status Management
    status VARCHAR(50) DEFAULT 'DRAFT' CHECK (status IN (
        'DRAFT',
        'SENT',
        'RESPONDED', 
        'AWARDED',
        'CANCELLED',
        'EXPIRED'
    )),
    priority VARCHAR(20) DEFAULT 'MEDIUM' CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT')),
    
    -- Response Management
    response_deadline TIMESTAMP,
    response_received_at TIMESTAMP,
    supplier_response_method VARCHAR(50) DEFAULT 'SYSTEM', -- SYSTEM, EMAIL, PHONE, MEETING
    
    -- Additional Information
    special_requirements TEXT,
    terms_and_conditions TEXT,
    internal_notes TEXT,
    attachment_urls JSONB DEFAULT '[]',
    
    -- Procurement-specific fields
    budget_amount DECIMAL(15,2),
    currency VARCHAR(10) DEFAULT 'USD',
    
    -- Source Information
    purchase_requisition_id UUID REFERENCES purchase_requisitions(id),
    source_document_type VARCHAR(50), -- PR, MANUAL, etc.
    source_document_id UUID,
    
    -- Supplier Response Data
    supplier_total_amount DECIMAL(15,2),
    supplier_currency VARCHAR(10) DEFAULT 'USD',
    supplier_validity_days INTEGER,
    supplier_comments TEXT,
    supplier_alternative_items JSONB DEFAULT '[]',
    
    -- Approval Workflow
    approval_status VARCHAR(50) DEFAULT 'PENDING' CHECK (approval_status IN (
        'PENDING',
        'APPROVED', 
        'DECLINED',
        'CANCELLED'
    )),
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMP,
    approval_notes TEXT,
    
    -- Timestamps and Audit
    created_by UUID REFERENCES users(id) NOT NULL,
    updated_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP,
    
    -- Response token for external supplier access
    response_token VARCHAR(255) UNIQUE,
    sent_at TIMESTAMP
);

-- Create sequence for RFQ numbers
CREATE SEQUENCE IF NOT EXISTS procurement_rfq_seq START 1;

-- Create function to generate RFQ numbers
CREATE OR REPLACE FUNCTION generate_procurement_rfq_number() 
RETURNS VARCHAR(50) AS $$
DECLARE
    next_number INTEGER;
    rfq_number VARCHAR(50);
BEGIN
    SELECT nextval('procurement_rfq_seq') INTO next_number;
    rfq_number := 'RFQ-' || TO_CHAR(EXTRACT(YEAR FROM CURRENT_DATE), 'FM0000') || '-' || LPAD(next_number::TEXT, 4, '0');
    RETURN rfq_number;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to auto-generate RFQ numbers
CREATE OR REPLACE FUNCTION set_procurement_rfq_number()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.rfq_number IS NULL OR NEW.rfq_number = '' THEN
        NEW.rfq_number := generate_procurement_rfq_number();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_set_procurement_rfq_number ON rfqs;
CREATE TRIGGER trigger_set_procurement_rfq_number
    BEFORE INSERT ON rfqs
    FOR EACH ROW
    EXECUTE FUNCTION set_procurement_rfq_number();

-- Create RFQ line items table
CREATE TABLE IF NOT EXISTS rfq_line_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rfq_id UUID REFERENCES rfqs(id) ON DELETE CASCADE,
    line_number INTEGER NOT NULL,
    
    -- Item Information
    item_id UUID REFERENCES items(id),
    item_name VARCHAR(255) NOT NULL,
    item_description TEXT,
    item_code VARCHAR(100),
    
    -- Quantity and Units
    requested_quantity DECIMAL(15,3) NOT NULL,
    unit_of_measure VARCHAR(50) NOT NULL,
    
    -- Specifications
    specifications JSONB DEFAULT '{}',
    quality_requirements TEXT,
    
    -- Supplier Response
    supplier_unit_price DECIMAL(15,4),
    supplier_total_price DECIMAL(15,2),
    supplier_delivery_time INTEGER, -- days
    supplier_item_notes TEXT,
    
    -- Status
    status VARCHAR(50) DEFAULT 'PENDING' CHECK (status IN (
        'PENDING',
        'QUOTED',
        'AWARDED', 
        'CANCELLED'
    )),
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(rfq_id, line_number)
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_rfqs_status ON rfqs(status);
CREATE INDEX IF NOT EXISTS idx_rfqs_supplier ON rfqs(supplier_id);
CREATE INDEX IF NOT EXISTS idx_rfqs_created_by ON rfqs(created_by);
CREATE INDEX IF NOT EXISTS idx_rfqs_response_deadline ON rfqs(response_deadline);
CREATE INDEX IF NOT EXISTS idx_rfqs_deleted_at ON rfqs(deleted_at);

CREATE INDEX IF NOT EXISTS idx_rfq_line_items_rfq ON rfq_line_items(rfq_id);
CREATE INDEX IF NOT EXISTS idx_rfq_line_items_item ON rfq_line_items(item_id);

-- Add comments for documentation
COMMENT ON TABLE rfqs IS 'Procurement Request for Quotations - separate from sales RFQs';
COMMENT ON TABLE rfq_line_items IS 'Line items for procurement RFQs';
COMMENT ON COLUMN rfqs.rfq_number IS 'Auto-generated RFQ number: RFQ-YYYY-NNNN';
COMMENT ON COLUMN rfqs.request_type IS 'Type of procurement request: PROCUREMENT, SERVICES, etc.';
COMMENT ON COLUMN rfqs.response_token IS 'Unique token for external supplier access to respond';