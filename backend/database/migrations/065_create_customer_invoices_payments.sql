-- Customer Invoices Table
CREATE TABLE customer_invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_number VARCHAR(50) UNIQUE NOT NULL,
    customer_id UUID NOT NULL REFERENCES customers(id),
    sales_order_id UUID REFERENCES sales_orders(id),
    journal_entry_id UUID REFERENCES journal_entries(id),
    
    -- Invoice details
    invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date DATE NOT NULL,
    payment_terms VARCHAR(50),
    currency VARCHAR(3) DEFAULT 'USD',
    
    -- Amounts
    subtotal DECIMAL(15,2) NOT NULL DEFAULT 0,
    tax_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
    discount_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
    total_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
    paid_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
    outstanding_amount DECIMAL(15,2) GENERATED ALWAYS AS (total_amount - paid_amount) STORED,
    
    -- Status and workflow
    status VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
    -- DRAFT, PENDING_APPROVAL, APPROVED, SENT, PAID, PARTIALLY_PAID, OVERDUE, CANCELLED
    
    -- Metadata
    description TEXT,
    notes TEXT,
    internal_notes TEXT,
    
    -- Audit fields
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE,
    deleted_by UUID REFERENCES users(id)
);

-- Customer Invoice Items Table
CREATE TABLE customer_invoice_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
    
    -- Item details
    line_number INTEGER NOT NULL,
    item_description TEXT NOT NULL,
    quantity DECIMAL(15,4) NOT NULL,
    unit_of_measure VARCHAR(20),
    unit_price DECIMAL(15,4) NOT NULL,
    discount_percentage DECIMAL(5,2) DEFAULT 0,
    discount_amount DECIMAL(15,2) DEFAULT 0,
    line_total DECIMAL(15,2) NOT NULL,
    
    -- Tax information
    tax_code VARCHAR(20),
    tax_rate DECIMAL(5,4) DEFAULT 0,
    tax_amount DECIMAL(15,2) DEFAULT 0,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Customer Payments Table
CREATE TABLE customer_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_number VARCHAR(50) UNIQUE NOT NULL,
    customer_id UUID NOT NULL REFERENCES customers(id),
    journal_entry_id UUID REFERENCES journal_entries(id),
    
    -- Payment details
    payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
    payment_method VARCHAR(30) NOT NULL,
    -- CASH, CHECK, BANK_TRANSFER, CREDIT_CARD, ACH, WIRE_TRANSFER
    
    reference_number VARCHAR(100),
    bank_account_id UUID, -- For future bank account integration
    
    -- Amount
    payment_amount DECIMAL(15,2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'USD',
    exchange_rate DECIMAL(10,6) DEFAULT 1.0,
    
    -- Status and workflow
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    -- PENDING, CLEARED, BOUNCED, CANCELLED
    
    -- Metadata
    description TEXT,
    notes TEXT,
    
    -- Audit fields
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE,
    deleted_by UUID REFERENCES users(id)
);

-- Payment Allocations Table (to track which invoices payments are applied to)
CREATE TABLE customer_payment_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES customer_payments(id) ON DELETE CASCADE,
    invoice_id UUID NOT NULL REFERENCES customer_invoices(id),
    
    allocation_amount DECIMAL(15,2) NOT NULL,
    allocation_date DATE NOT NULL DEFAULT CURRENT_DATE,
    
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT chk_positive_allocation CHECK (allocation_amount > 0)
);

-- Invoice Status History Table
CREATE TABLE customer_invoice_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
    from_status VARCHAR(30),
    to_status VARCHAR(30) NOT NULL,
    changed_by UUID REFERENCES users(id),
    status_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    reason TEXT
);

-- Payment Status History Table
CREATE TABLE customer_payment_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES customer_payments(id) ON DELETE CASCADE,
    from_status VARCHAR(30),
    to_status VARCHAR(30) NOT NULL,
    changed_by UUID REFERENCES users(id),
    status_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    reason TEXT
);

-- Indexes for performance
CREATE INDEX idx_customer_invoices_customer ON customer_invoices(customer_id);
CREATE INDEX idx_customer_invoices_status ON customer_invoices(status);
CREATE INDEX idx_customer_invoices_due_date ON customer_invoices(due_date);
CREATE INDEX idx_customer_invoices_sales_order ON customer_invoices(sales_order_id);
CREATE INDEX idx_customer_invoices_journal_entry ON customer_invoices(journal_entry_id);
CREATE INDEX idx_customer_invoices_deleted_at ON customer_invoices(deleted_at);

CREATE INDEX idx_customer_invoice_items_invoice ON customer_invoice_items(invoice_id);

CREATE INDEX idx_customer_payments_customer ON customer_payments(customer_id);
CREATE INDEX idx_customer_payments_status ON customer_payments(status);
CREATE INDEX idx_customer_payments_date ON customer_payments(payment_date);
CREATE INDEX idx_customer_payments_method ON customer_payments(payment_method);
CREATE INDEX idx_customer_payments_journal_entry ON customer_payments(journal_entry_id);
CREATE INDEX idx_customer_payments_deleted_at ON customer_payments(deleted_at);

CREATE INDEX idx_payment_allocations_payment ON customer_payment_allocations(payment_id);
CREATE INDEX idx_payment_allocations_invoice ON customer_payment_allocations(invoice_id);

CREATE INDEX idx_invoice_status_history_invoice ON customer_invoice_status_history(invoice_id);
CREATE INDEX idx_invoice_status_history_date ON customer_invoice_status_history(status_date);

CREATE INDEX idx_payment_status_history_payment ON customer_payment_status_history(payment_id);
CREATE INDEX idx_payment_status_history_date ON customer_payment_status_history(status_date);

-- Constraints
ALTER TABLE customer_invoices ADD CONSTRAINT chk_invoice_status_valid 
CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PAID', 'PARTIALLY_PAID', 'OVERDUE', 'CANCELLED'));

ALTER TABLE customer_invoices ADD CONSTRAINT chk_invoice_amounts_positive 
CHECK (subtotal >= 0 AND tax_amount >= 0 AND total_amount >= 0 AND paid_amount >= 0);

ALTER TABLE customer_invoices ADD CONSTRAINT chk_due_date_after_invoice_date 
CHECK (due_date >= invoice_date);

ALTER TABLE customer_payments ADD CONSTRAINT chk_payment_status_valid 
CHECK (status IN ('PENDING', 'CLEARED', 'BOUNCED', 'CANCELLED'));

ALTER TABLE customer_payments ADD CONSTRAINT chk_payment_method_valid 
CHECK (payment_method IN ('CASH', 'CHECK', 'BANK_TRANSFER', 'CREDIT_CARD', 'ACH', 'WIRE_TRANSFER'));

ALTER TABLE customer_payments ADD CONSTRAINT chk_payment_amount_positive 
CHECK (payment_amount > 0);

-- Functions for number generation
CREATE OR REPLACE FUNCTION generate_invoice_number() RETURNS TEXT AS $$
DECLARE
    year_part TEXT;
    next_number INTEGER;
    new_number TEXT;
BEGIN
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
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION generate_payment_number() RETURNS TEXT AS $$
DECLARE
    year_part TEXT;
    next_number INTEGER;
    new_number TEXT;
BEGIN
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
$$ LANGUAGE plpgsql;

-- Triggers for updated_at timestamps
CREATE TRIGGER customer_invoices_updated_at
    BEFORE UPDATE ON customer_invoices
    FOR EACH ROW
    EXECUTE FUNCTION update_sales_order_timestamp();

CREATE TRIGGER customer_payments_updated_at
    BEFORE UPDATE ON customer_payments
    FOR EACH ROW
    EXECUTE FUNCTION update_sales_order_timestamp();

-- Comments for documentation
COMMENT ON TABLE customer_invoices IS 'Customer invoices generated from sales orders with payment tracking';
COMMENT ON TABLE customer_invoice_items IS 'Line items for customer invoices';
COMMENT ON TABLE customer_payments IS 'Customer payments received with bank reconciliation support';
COMMENT ON TABLE customer_payment_allocations IS 'Allocation of payments to specific invoices for AR tracking';