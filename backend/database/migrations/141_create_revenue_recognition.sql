-- Migration 141: Create Revenue Recognition Schedules Table (ASC 606 / IFRS 15)
CREATE TABLE IF NOT EXISTS revenue_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id UUID REFERENCES sales_orders(id) ON DELETE CASCADE,
  customer_invoice_id UUID REFERENCES customer_invoices(id) ON DELETE CASCADE,
  period_date DATE NOT NULL,
  amount NUMERIC(15, 2) NOT NULL,
  status VARCHAR(20) DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED', 'RECOGNIZED', 'CANCELLED')),
  journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_revenue_schedules_period ON revenue_schedules(period_date, status);
