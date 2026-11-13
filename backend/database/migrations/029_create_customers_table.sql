-- Migration: Create customers table for sales module
-- Customer Master Data as per documentation requirements

CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Basic Customer Information
    customer_code VARCHAR(20) UNIQUE NOT NULL,
    customer_name VARCHAR(255) NOT NULL,
    legal_entity_name VARCHAR(255),
    customer_type VARCHAR(50) DEFAULT 'INDIVIDUAL' CHECK (customer_type IN ('INDIVIDUAL', 'COMPANY', 'GOVERNMENT', 'NON_PROFIT')),
    
    -- Contact Information
    primary_email VARCHAR(255),
    secondary_email VARCHAR(255),
    phone VARCHAR(50),
    mobile VARCHAR(50),
    fax VARCHAR(50),
    website VARCHAR(255),
    
    -- Billing Address
    billing_address_line1 VARCHAR(255),
    billing_address_line2 VARCHAR(255),
    billing_city VARCHAR(100),
    billing_state VARCHAR(100),
    billing_country VARCHAR(100),
    billing_postal_code VARCHAR(20),
    
    -- Shipping Address (can be different from billing)
    shipping_address_line1 VARCHAR(255),
    shipping_address_line2 VARCHAR(255),
    shipping_city VARCHAR(100),
    shipping_state VARCHAR(100),
    shipping_country VARCHAR(100),
    shipping_postal_code VARCHAR(20),
    use_billing_as_shipping BOOLEAN DEFAULT true,
    
    -- Financial Information
    currency VARCHAR(3) DEFAULT 'USD',
    credit_limit DECIMAL(15,2) DEFAULT 0,
    current_balance DECIMAL(15,2) DEFAULT 0,
    credit_days INTEGER DEFAULT 30,
    payment_terms VARCHAR(100),
    
    -- Tax Information
    tax_number VARCHAR(100),
    vat_number VARCHAR(100),
    tax_exempt BOOLEAN DEFAULT false,
    tax_rate DECIMAL(5,2) DEFAULT 0,
    
    -- Contact Persons
    primary_contact_name VARCHAR(255),
    primary_contact_title VARCHAR(100),
    primary_contact_email VARCHAR(255),
    primary_contact_phone VARCHAR(50),
    
    secondary_contact_name VARCHAR(255),
    secondary_contact_title VARCHAR(100),
    secondary_contact_email VARCHAR(255),
    secondary_contact_phone VARCHAR(50),
    
    -- Status and Classification
    status VARCHAR(20) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'BLOCKED', 'PENDING_APPROVAL')),
    customer_category VARCHAR(50), -- e.g., 'VIP', 'REGULAR', 'NEW'
    customer_group VARCHAR(50), -- e.g., 'RETAIL', 'WHOLESALE', 'CORPORATE'
    sales_rep_id UUID REFERENCES users(id),
    
    -- Risk Management
    credit_risk_level VARCHAR(20) DEFAULT 'LOW' CHECK (credit_risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'BLOCKED')),
    credit_check_required BOOLEAN DEFAULT false,
    
    -- Additional Information
    notes TEXT,
    internal_notes TEXT, -- Internal notes not visible to customer
    
    -- System fields
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Soft delete
    deleted_at TIMESTAMP WITH TIME ZONE,
    deleted_by UUID REFERENCES users(id)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_customers_customer_code ON customers(customer_code);
CREATE INDEX IF NOT EXISTS idx_customers_customer_name ON customers(customer_name);
CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
CREATE INDEX IF NOT EXISTS idx_customers_created_by ON customers(created_by);
CREATE INDEX IF NOT EXISTS idx_customers_sales_rep ON customers(sales_rep_id);
CREATE INDEX IF NOT EXISTS idx_customers_credit_risk ON customers(credit_risk_level);
CREATE INDEX IF NOT EXISTS idx_customers_deleted_at ON customers(deleted_at);

-- Add constraints
DO $$
BEGIN
    -- Ensure credit limit is non-negative
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_positive_credit_limit_check') THEN
        ALTER TABLE customers ADD CONSTRAINT customers_positive_credit_limit_check 
        CHECK (credit_limit >= 0);
    END IF;
    
    -- Ensure primary email is valid format (basic check)
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_email_format_check') THEN
        ALTER TABLE customers ADD CONSTRAINT customers_email_format_check 
        CHECK (primary_email IS NULL OR primary_email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$');
    END IF;
    
    -- Ensure customer code follows format (e.g., CUST-001, CUS001, etc.)
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_code_format_check') THEN
        ALTER TABLE customers ADD CONSTRAINT customers_code_format_check 
        CHECK (customer_code ~ '^[A-Z0-9-]{3,20}$');
    END IF;
END $$;

-- Create trigger for updated_at
DROP TRIGGER IF EXISTS update_customers_updated_at ON customers;
CREATE TRIGGER update_customers_updated_at 
    BEFORE UPDATE ON customers
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Add comments for documentation
COMMENT ON TABLE customers IS 'Customer master data for sales module - stores all customer information including addresses, contacts, financial terms, and risk profiles';
COMMENT ON COLUMN customers.customer_code IS 'Unique customer identifier code (e.g., CUST-001)';
COMMENT ON COLUMN customers.legal_entity_name IS 'Official legal name if different from customer_name';
COMMENT ON COLUMN customers.credit_limit IS 'Maximum credit amount allowed for this customer';
COMMENT ON COLUMN customers.current_balance IS 'Current outstanding balance';
COMMENT ON COLUMN customers.credit_days IS 'Number of days for payment terms';
COMMENT ON COLUMN customers.use_billing_as_shipping IS 'Whether to use billing address as shipping address';
COMMENT ON COLUMN customers.credit_risk_level IS 'Risk assessment level for credit decisions';
COMMENT ON COLUMN customers.internal_notes IS 'Internal notes not visible to customer';

-- Create customer_audit_log table for tracking changes
CREATE TABLE IF NOT EXISTS customer_audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    action VARCHAR(50) NOT NULL, -- 'CREATED', 'UPDATED', 'DELETED', 'STATUS_CHANGED'
    field_changed VARCHAR(100),
    old_value TEXT,
    new_value TEXT,
    changed_by UUID NOT NULL REFERENCES users(id),
    changed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_customer_audit_log_customer_id ON customer_audit_log(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_audit_log_changed_at ON customer_audit_log(changed_at);

COMMENT ON TABLE customer_audit_log IS 'Audit trail for customer changes - tracks all modifications for compliance and history';