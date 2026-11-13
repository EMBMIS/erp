-- Create procurement system tables
-- Migration 018: Comprehensive procurement module

-- 1. SUPPLIERS TABLE
CREATE TABLE suppliers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_code VARCHAR(50) UNIQUE NOT NULL,
    legal_name VARCHAR(255) NOT NULL,
    trade_name VARCHAR(255),
    email VARCHAR(255),
    phone VARCHAR(50),
    address TEXT,
    country VARCHAR(100),
    city VARCHAR(100),
    postal_code VARCHAR(20),
    
    -- Supplier classification
    supplier_type VARCHAR(50) DEFAULT 'TRANSACTIONAL' CHECK (supplier_type IN ('TRANSACTIONAL', 'STRATEGIC', 'PREFERRED')),
    certification_status VARCHAR(50) DEFAULT 'PENDING' CHECK (certification_status IN ('PENDING', 'CERTIFIED', 'DECLINED', 'SUSPENDED')),
    
    -- Payment terms
    payment_terms VARCHAR(100) DEFAULT '30 DAYS NET',
    currency VARCHAR(3) DEFAULT 'USD',
    
    -- Status and audit
    status VARCHAR(50) DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'SUSPENDED', 'INACTIVE')),
    created_by UUID REFERENCES users(id),
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. CONTRACTS TABLE
CREATE TABLE contracts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_number VARCHAR(50) UNIQUE NOT NULL,
    contract_name VARCHAR(255) NOT NULL,
    supplier_id UUID REFERENCES suppliers(id) ON DELETE RESTRICT,
    
    -- Contract details
    contract_type VARCHAR(50) DEFAULT 'PURCHASE' CHECK (contract_type IN ('PURCHASE', 'SERVICE', 'FRAMEWORK')),
    start_date DATE,
    end_date DATE,
    
    -- Terms
    payment_terms VARCHAR(100),
    incoterms VARCHAR(20),
    currency VARCHAR(3) DEFAULT 'USD',
    
    -- Contract document
    attachment_url TEXT,
    
    -- Status and workflow
    status VARCHAR(50) DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SENT_TO_SUPPLIER', 'UNDER_REVIEW', 'ACTIVE', 'EXPIRED', 'TERMINATED')),
    
    -- Instructions for supplier
    supplier_instructions TEXT,
    
    -- Audit trail
    created_by UUID REFERENCES users(id),
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. CONTRACT ITEMS TABLE (Items covered by the contract)
CREATE TABLE contract_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id UUID REFERENCES contracts(id) ON DELETE CASCADE,
    item_id UUID REFERENCES items(id) ON DELETE RESTRICT,
    
    -- Pricing
    unit_price DECIMAL(15,4),
    currency VARCHAR(3) DEFAULT 'USD',
    
    -- Lead time
    lead_time_days INTEGER DEFAULT 30,
    
    -- Minimum order quantity
    moq DECIMAL(12,4) DEFAULT 1,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(contract_id, item_id)
);

-- 4. DELEGATION OF FINANCIAL AUTHORITY (DOFA) TABLE
CREATE TABLE delegation_of_authority (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cost_center VARCHAR(100),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    
    -- Authority limits
    min_amount DECIMAL(15,2) DEFAULT 0,
    max_amount DECIMAL(15,2),
    currency VARCHAR(3) DEFAULT 'USD',
    
    -- Scope
    applies_to VARCHAR(50) DEFAULT 'ALL' CHECK (applies_to IN ('ALL', 'PR', 'PO', 'CONTRACT')),
    
    -- Status
    is_active BOOLEAN DEFAULT TRUE,
    effective_from DATE DEFAULT CURRENT_DATE,
    effective_until DATE,
    
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5. PURCHASE REQUISITIONS TABLE
CREATE TABLE purchase_requisitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pr_number VARCHAR(50) UNIQUE NOT NULL,
    
    -- Request details
    cost_center VARCHAR(100),
    requested_by UUID REFERENCES users(id),
    
    -- Items can be from inventory or free-text description
    item_id UUID REFERENCES items(id), -- Optional: if item exists in inventory
    item_description TEXT, -- For items not in inventory
    unit_of_measure VARCHAR(50),
    quantity DECIMAL(12,4) NOT NULL,
    
    -- Pricing (optional - may be filled during RFQ)
    estimated_unit_price DECIMAL(15,4),
    currency VARCHAR(3) DEFAULT 'USD',
    
    -- Supplier recommendation
    recommended_supplier_id UUID REFERENCES suppliers(id),
    supplier_recommendation_text TEXT, -- Free text for supplier suggestions
    
    -- Attachments
    attachments JSONB DEFAULT '[]', -- Array of file URLs/paths
    
    -- Approval workflow
    status VARCHAR(50) DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'DECLINED', 'CANCELLED')),
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMP WITH TIME ZONE,
    decline_reason TEXT,
    
    -- Audit
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 6. REQUEST FOR QUOTATIONS TABLE
CREATE TABLE request_for_quotations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rfq_number VARCHAR(50) UNIQUE NOT NULL,
    purchase_requisition_id UUID REFERENCES purchase_requisitions(id),
    
    -- RFQ details
    title VARCHAR(255) NOT NULL,
    description TEXT,
    response_deadline DATE,
    
    -- Items (can have multiple line items)
    currency VARCHAR(3) DEFAULT 'USD',
    
    -- Status
    status VARCHAR(50) DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SENT', 'RESPONSES_RECEIVED', 'EVALUATED', 'SUPPLIER_SELECTED', 'CLOSED')),
    
    -- Winner selection
    winning_supplier_id UUID REFERENCES suppliers(id),
    selection_reason TEXT,
    
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 7. RFQ LINE ITEMS TABLE
CREATE TABLE rfq_line_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rfq_id UUID REFERENCES request_for_quotations(id) ON DELETE CASCADE,
    
    -- Item details
    item_id UUID REFERENCES items(id), -- Optional
    item_description TEXT NOT NULL,
    unit_of_measure VARCHAR(50),
    quantity DECIMAL(12,4) NOT NULL,
    
    -- Specifications
    specifications TEXT,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 8. RFQ SUPPLIERS TABLE (Suppliers invited to quote)
CREATE TABLE rfq_suppliers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rfq_id UUID REFERENCES request_for_quotations(id) ON DELETE CASCADE,
    supplier_id UUID REFERENCES suppliers(id) ON DELETE CASCADE,
    
    -- Invitation details
    invited_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    response_received_at TIMESTAMP WITH TIME ZONE,
    
    -- Response status
    response_status VARCHAR(50) DEFAULT 'INVITED' CHECK (response_status IN ('INVITED', 'RESPONDED', 'DECLINED', 'NO_RESPONSE')),
    
    UNIQUE(rfq_id, supplier_id)
);

-- 9. RFQ QUOTATIONS TABLE (Supplier responses)
CREATE TABLE rfq_quotations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rfq_id UUID REFERENCES request_for_quotations(id) ON DELETE CASCADE,
    supplier_id UUID REFERENCES suppliers(id) ON DELETE CASCADE,
    rfq_line_item_id UUID REFERENCES rfq_line_items(id) ON DELETE CASCADE,
    
    -- Quotation details
    unit_price DECIMAL(15,4) NOT NULL,
    currency VARCHAR(3) DEFAULT 'USD',
    lead_time_days INTEGER,
    delivery_terms VARCHAR(255),
    
    -- Additional terms
    payment_terms VARCHAR(100),
    validity_days INTEGER DEFAULT 30,
    notes TEXT,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(rfq_id, supplier_id, rfq_line_item_id)
);

-- 10. PURCHASE ORDERS TABLE
CREATE TABLE purchase_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    po_number VARCHAR(50) UNIQUE NOT NULL,
    
    -- References
    purchase_requisition_id UUID REFERENCES purchase_requisitions(id),
    rfq_id UUID REFERENCES request_for_quotations(id),
    contract_id UUID REFERENCES contracts(id), -- Optional: if based on contract
    supplier_id UUID REFERENCES suppliers(id) NOT NULL,
    
    -- PO details
    po_date DATE DEFAULT CURRENT_DATE,
    delivery_date DATE,
    
    -- Terms
    payment_terms VARCHAR(100),
    incoterms VARCHAR(20),
    currency VARCHAR(3) DEFAULT 'USD',
    
    -- Totals (calculated from line items)
    subtotal DECIMAL(15,2) DEFAULT 0,
    tax_amount DECIMAL(15,2) DEFAULT 0,
    total_amount DECIMAL(15,2) DEFAULT 0,
    
    -- Status and approvals
    status VARCHAR(50) DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT_TO_SUPPLIER', 'CONFIRMED', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED', 'CANCELLED')),
    
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMP WITH TIME ZONE,
    
    -- Audit
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 11. PURCHASE ORDER LINE ITEMS TABLE
CREATE TABLE purchase_order_line_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    po_id UUID REFERENCES purchase_orders(id) ON DELETE CASCADE,
    
    -- Item details
    item_id UUID REFERENCES items(id), -- Optional
    item_description TEXT NOT NULL,
    unit_of_measure VARCHAR(50),
    
    -- Quantities and pricing
    quantity DECIMAL(12,4) NOT NULL,
    unit_price DECIMAL(15,4) NOT NULL,
    line_total DECIMAL(15,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
    
    -- Delivery
    requested_delivery_date DATE,
    
    -- Status tracking
    quantity_received DECIMAL(12,4) DEFAULT 0,
    quantity_remaining DECIMAL(12,4) GENERATED ALWAYS AS (quantity - quantity_received) STORED,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX idx_suppliers_code ON suppliers(supplier_code);
CREATE INDEX idx_suppliers_status ON suppliers(status);
CREATE INDEX idx_contracts_supplier ON contracts(supplier_id);
CREATE INDEX idx_contracts_status ON contracts(status);
CREATE INDEX idx_pr_status ON purchase_requisitions(status);
CREATE INDEX idx_pr_requested_by ON purchase_requisitions(requested_by);
CREATE INDEX idx_rfq_status ON request_for_quotations(status);
CREATE INDEX idx_po_supplier ON purchase_orders(supplier_id);
CREATE INDEX idx_po_status ON purchase_orders(status);
CREATE INDEX idx_dofa_user ON delegation_of_authority(user_id);
CREATE INDEX idx_dofa_cost_center ON delegation_of_authority(cost_center);

-- Create sequences for auto-numbering
CREATE SEQUENCE supplier_code_seq START 1000;
CREATE SEQUENCE contract_number_seq START 1000;
CREATE SEQUENCE pr_number_seq START 1000;
CREATE SEQUENCE rfq_number_seq START 1000;
CREATE SEQUENCE po_number_seq START 1000;

-- Add functions to auto-generate numbers
CREATE OR REPLACE FUNCTION generate_supplier_code() RETURNS TEXT AS $$
BEGIN
    RETURN 'SUP-' || LPAD(nextval('supplier_code_seq')::TEXT, 6, '0');
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION generate_contract_number() RETURNS TEXT AS $$
BEGIN
    RETURN 'CNT-' || TO_CHAR(CURRENT_DATE, 'YYYY') || '-' || LPAD(nextval('contract_number_seq')::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION generate_pr_number() RETURNS TEXT AS $$
BEGIN
    RETURN 'PR-' || TO_CHAR(CURRENT_DATE, 'YYYY') || '-' || LPAD(nextval('pr_number_seq')::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION generate_rfq_number() RETURNS TEXT AS $$
BEGIN
    RETURN 'RFQ-' || TO_CHAR(CURRENT_DATE, 'YYYY') || '-' || LPAD(nextval('rfq_number_seq')::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION generate_po_number() RETURNS TEXT AS $$
BEGIN
    RETURN 'PO-' || TO_CHAR(CURRENT_DATE, 'YYYY') || '-' || LPAD(nextval('po_number_seq')::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;

-- Add comments for documentation
COMMENT ON TABLE suppliers IS 'Registered suppliers for procurement activities';
COMMENT ON TABLE contracts IS 'Contracts with suppliers defining terms and pricing';
COMMENT ON TABLE purchase_requisitions IS 'Internal requests for materials or services';
COMMENT ON TABLE request_for_quotations IS 'RFQs sent to suppliers for competitive bidding';
COMMENT ON TABLE purchase_orders IS 'Formal purchase orders sent to suppliers';
COMMENT ON TABLE delegation_of_authority IS 'Financial approval authority by user and cost center';