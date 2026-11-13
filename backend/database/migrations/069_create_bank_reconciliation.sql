-- Bank accounts and statement lines for bank reconciliation.
-- A bank account is linked to a GL cash account (e.g. 1110). Statement lines
-- (bank_transactions) are marked reconciled as they are matched to the book;
-- the reconciliation summary compares the GL cash balance (book) against the
-- cleared balance (opening + reconciled lines).

CREATE TABLE IF NOT EXISTS bank_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_name VARCHAR(255) NOT NULL,
    bank_name VARCHAR(255),
    account_number VARCHAR(100),
    currency VARCHAR(3) DEFAULT 'USD',
    gl_account_id UUID REFERENCES chart_of_accounts(id),   -- linked cash GL account
    opening_balance DECIMAL(15,2) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',           -- ACTIVE, CLOSED

    notes TEXT,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS bank_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bank_account_id UUID NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
    transaction_date DATE NOT NULL DEFAULT CURRENT_DATE,
    description TEXT,
    reference VARCHAR(100),

    -- Signed amount: positive = deposit/inflow, negative = withdrawal/outflow
    amount DECIMAL(15,2) NOT NULL,

    is_reconciled BOOLEAN NOT NULL DEFAULT false,
    reconciled_at TIMESTAMP WITH TIME ZONE,
    reconciled_by UUID REFERENCES users(id),

    -- Optional link to the book record this line matches
    matched_type VARCHAR(30),   -- CUSTOMER_PAYMENT, SUPPLIER_PAYMENT, JOURNAL, MANUAL
    matched_id UUID,

    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_bank_accounts_status ON bank_accounts(status);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_account ON bank_transactions(bank_account_id);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_reconciled ON bank_transactions(is_reconciled);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_date ON bank_transactions(transaction_date);

ALTER TABLE bank_accounts DROP CONSTRAINT IF EXISTS chk_bank_account_status;
ALTER TABLE bank_accounts ADD CONSTRAINT chk_bank_account_status CHECK (status IN ('ACTIVE', 'CLOSED'));

DROP TRIGGER IF EXISTS bank_accounts_updated_at ON bank_accounts;
CREATE TRIGGER bank_accounts_updated_at
    BEFORE UPDATE ON bank_accounts
    FOR EACH ROW EXECUTE FUNCTION update_sales_order_timestamp();

COMMENT ON TABLE bank_accounts IS 'Bank accounts linked to GL cash accounts';
COMMENT ON TABLE bank_transactions IS 'Bank statement lines with reconciliation status';
