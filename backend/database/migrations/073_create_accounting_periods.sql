-- Accounting periods for period-close / GL locking.
-- When a period is CLOSED, JournalEntry.create refuses to post any entry dated
-- into that period, protecting closed books from back-dated changes.

CREATE TABLE IF NOT EXISTS accounting_periods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    period_year INTEGER NOT NULL,
    period_month INTEGER NOT NULL,          -- 1-12
    status VARCHAR(10) NOT NULL DEFAULT 'OPEN',  -- OPEN, CLOSED
    closed_by UUID REFERENCES users(id),
    closed_at TIMESTAMP WITH TIME ZONE,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_accounting_period UNIQUE (period_year, period_month),
    CONSTRAINT chk_period_month CHECK (period_month BETWEEN 1 AND 12),
    CONSTRAINT chk_period_status CHECK (status IN ('OPEN', 'CLOSED'))
);

CREATE INDEX IF NOT EXISTS idx_accounting_periods_status ON accounting_periods(status);

COMMENT ON TABLE accounting_periods IS 'Monthly accounting periods; CLOSED periods lock GL postings';
