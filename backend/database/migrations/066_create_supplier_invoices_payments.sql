-- Accounts Payable: Supplier Invoices (Bills) and Supplier Payments
-- Mirrors the Accounts Receivable design (migration 065). The AP liability is
-- already posted to the GL when a purchase order is completed (Dr Inventory/
-- COGS / Cr Accounts Payable 2110); a supplier bill records the vendor's own
-- document against that payable, and a supplier payment clears it
-- (Dr Accounts Payable 2110 / Cr Cash 1110).

-- Supplier Invoices (Bills) Table
CREATE TABLE IF NOT EXISTS supplier_invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_number VARCHAR(50) UNIQUE NOT NULL,          -- internal number (BILL-YYYY-######)
    supplier_invoice_number VARCHAR(100),             -- the vendor's own invoice number
    supplier_id UUID NOT NULL REFERENCES suppliers(id),
    purchase_order_id UUID REFERENCES purchase_orders(id),
    journal_entry_id UUID REFERENCES journal_entries(id),

    -- Invoice details
    invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date DATE NOT NULL,
    payment_terms VARCHAR(100),
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
    -- DRAFT, PENDING_APPROVAL, APPROVED, PAID, PARTIALLY_PAID, OVERDUE, CANCELLED

    description TEXT,
    notes TEXT,
    internal_notes TEXT,

    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE,
    deleted_by UUID REFERENCES users(id)
);

-- Supplier Invoice Items Table
CREATE TABLE IF NOT EXISTS supplier_invoice_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_id UUID NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
    line_number INTEGER NOT NULL,
    item_description TEXT NOT NULL,
    quantity DECIMAL(15,4) NOT NULL,
    unit_of_measure VARCHAR(20),
    unit_price DECIMAL(15,4) NOT NULL,
    discount_percentage DECIMAL(5,2) DEFAULT 0,
    discount_amount DECIMAL(15,2) DEFAULT 0,
    line_total DECIMAL(15,2) NOT NULL,
    tax_code VARCHAR(20),
    tax_rate DECIMAL(5,4) DEFAULT 0,
    tax_amount DECIMAL(15,2) DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Supplier Payments Table
CREATE TABLE IF NOT EXISTS supplier_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_number VARCHAR(50) UNIQUE NOT NULL,       -- SPY-YYYY-######
    supplier_id UUID NOT NULL REFERENCES suppliers(id),
    journal_entry_id UUID REFERENCES journal_entries(id),

    payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
    payment_method VARCHAR(30) NOT NULL,
    reference_number VARCHAR(100),
    bank_account_id UUID,

    payment_amount DECIMAL(15,2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'USD',
    exchange_rate DECIMAL(10,6) DEFAULT 1.0,

    status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    -- PENDING, CLEARED, BOUNCED, CANCELLED

    description TEXT,
    notes TEXT,

    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE,
    deleted_by UUID REFERENCES users(id)
);

-- Supplier Payment Allocations Table
CREATE TABLE IF NOT EXISTS supplier_payment_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES supplier_payments(id) ON DELETE CASCADE,
    bill_id UUID NOT NULL REFERENCES supplier_invoices(id),
    allocation_amount DECIMAL(15,2) NOT NULL,
    allocation_date DATE NOT NULL DEFAULT CURRENT_DATE,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_positive_supplier_allocation CHECK (allocation_amount > 0)
);

-- Status History Tables
CREATE TABLE IF NOT EXISTS supplier_invoice_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_id UUID NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
    from_status VARCHAR(30),
    to_status VARCHAR(30) NOT NULL,
    changed_by UUID REFERENCES users(id),
    status_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    reason TEXT
);

CREATE TABLE IF NOT EXISTS supplier_payment_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES supplier_payments(id) ON DELETE CASCADE,
    from_status VARCHAR(30),
    to_status VARCHAR(30) NOT NULL,
    changed_by UUID REFERENCES users(id),
    status_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    reason TEXT
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_supplier ON supplier_invoices(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_status ON supplier_invoices(status);
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_due_date ON supplier_invoices(due_date);
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_po ON supplier_invoices(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_deleted_at ON supplier_invoices(deleted_at);
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_items_bill ON supplier_invoice_items(bill_id);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_supplier ON supplier_payments(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_status ON supplier_payments(status);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_deleted_at ON supplier_payments(deleted_at);
CREATE INDEX IF NOT EXISTS idx_supplier_pay_alloc_payment ON supplier_payment_allocations(payment_id);
CREATE INDEX IF NOT EXISTS idx_supplier_pay_alloc_bill ON supplier_payment_allocations(bill_id);

-- Constraints
ALTER TABLE supplier_invoices DROP CONSTRAINT IF EXISTS chk_supplier_invoice_status_valid;
ALTER TABLE supplier_invoices ADD CONSTRAINT chk_supplier_invoice_status_valid
CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PAID', 'PARTIALLY_PAID', 'OVERDUE', 'CANCELLED'));

ALTER TABLE supplier_invoices DROP CONSTRAINT IF EXISTS chk_supplier_invoice_amounts_positive;
ALTER TABLE supplier_invoices ADD CONSTRAINT chk_supplier_invoice_amounts_positive
CHECK (subtotal >= 0 AND tax_amount >= 0 AND total_amount >= 0 AND paid_amount >= 0);

ALTER TABLE supplier_payments DROP CONSTRAINT IF EXISTS chk_supplier_payment_status_valid;
ALTER TABLE supplier_payments ADD CONSTRAINT chk_supplier_payment_status_valid
CHECK (status IN ('PENDING', 'CLEARED', 'BOUNCED', 'CANCELLED'));

ALTER TABLE supplier_payments DROP CONSTRAINT IF EXISTS chk_supplier_payment_method_valid;
ALTER TABLE supplier_payments ADD CONSTRAINT chk_supplier_payment_method_valid
CHECK (payment_method IN ('CASH', 'CHECK', 'BANK_TRANSFER', 'CREDIT_CARD', 'ACH', 'WIRE_TRANSFER'));

ALTER TABLE supplier_payments DROP CONSTRAINT IF EXISTS chk_supplier_payment_amount_positive;
ALTER TABLE supplier_payments ADD CONSTRAINT chk_supplier_payment_amount_positive
CHECK (payment_amount > 0);

-- Number generation functions
CREATE OR REPLACE FUNCTION generate_supplier_bill_number() RETURNS TEXT AS $$
DECLARE
    year_part TEXT;
    next_number INTEGER;
BEGIN
    year_part := EXTRACT(YEAR FROM CURRENT_DATE)::TEXT;
    SELECT COALESCE(MAX(
        CASE WHEN bill_number ~ ('^BILL-' || year_part || '-[0-9]+$')
             THEN SUBSTRING(bill_number FROM ('\-([0-9]+)$'))::INTEGER ELSE 0 END
    ), 0) + 1 INTO next_number FROM supplier_invoices;
    RETURN 'BILL-' || year_part || '-' || LPAD(next_number::TEXT, 6, '0');
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION generate_supplier_payment_number() RETURNS TEXT AS $$
DECLARE
    year_part TEXT;
    next_number INTEGER;
BEGIN
    year_part := EXTRACT(YEAR FROM CURRENT_DATE)::TEXT;
    SELECT COALESCE(MAX(
        CASE WHEN payment_number ~ ('^SPY-' || year_part || '-[0-9]+$')
             THEN SUBSTRING(payment_number FROM ('\-([0-9]+)$'))::INTEGER ELSE 0 END
    ), 0) + 1 INTO next_number FROM supplier_payments;
    RETURN 'SPY-' || year_part || '-' || LPAD(next_number::TEXT, 6, '0');
END;
$$ LANGUAGE plpgsql;

-- updated_at triggers (reuse existing timestamp trigger function)
DROP TRIGGER IF EXISTS supplier_invoices_updated_at ON supplier_invoices;
CREATE TRIGGER supplier_invoices_updated_at
    BEFORE UPDATE ON supplier_invoices
    FOR EACH ROW EXECUTE FUNCTION update_sales_order_timestamp();

DROP TRIGGER IF EXISTS supplier_payments_updated_at ON supplier_payments;
CREATE TRIGGER supplier_payments_updated_at
    BEFORE UPDATE ON supplier_payments
    FOR EACH ROW EXECUTE FUNCTION update_sales_order_timestamp();

COMMENT ON TABLE supplier_invoices IS 'Supplier invoices (vendor bills) — Accounts Payable';
COMMENT ON TABLE supplier_payments IS 'Payments made to suppliers with allocation to bills';
