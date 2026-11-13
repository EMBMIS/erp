-- 097 — Recurring invoices (ERP-Roadmap P2 #8).
--
-- A recurring_invoice_schedules row represents a standing billing arrangement
-- (e.g. a monthly retainer under a sales contract) that generates a real
-- customer_invoice on each due date. Recurring journals (depreciation) already
-- exist elsewhere in this codebase — this is the sales-side equivalent.
-- Idempotent.

CREATE TABLE IF NOT EXISTS recurring_invoice_schedules (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       UUID NOT NULL REFERENCES customers(id),
  sales_contract_id UUID REFERENCES sales_contracts(id),
  description       VARCHAR(255) NOT NULL,
  amount            DECIMAL(15,2) NOT NULL CHECK (amount > 0),
  tax_amount        DECIMAL(15,2) NOT NULL DEFAULT 0,
  currency          VARCHAR(3) NOT NULL DEFAULT 'USD',
  frequency         VARCHAR(20) NOT NULL CHECK (frequency IN ('MONTHLY', 'QUARTERLY', 'ANNUALLY')),
  next_run_date     DATE NOT NULL,
  last_run_date     DATE,
  occurrences_run   INTEGER NOT NULL DEFAULT 0,
  max_occurrences   INTEGER, -- NULL = runs indefinitely until cancelled
  status            VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'CANCELLED')),
  notes             TEXT,
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_recurring_invoice_schedules_due
  ON recurring_invoice_schedules(next_run_date) WHERE status = 'ACTIVE';

-- Links a generated customer_invoice back to the schedule that produced it.
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS recurring_schedule_id UUID REFERENCES recurring_invoice_schedules(id);
