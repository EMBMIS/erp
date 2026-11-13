-- 135 — Phase 4 functional depth: configurable costing, CRM leads, HR leave/attendance.
--
-- 1. costing_method on companies (FIFO / WEIGHTED_AVERAGE / STANDARD).
-- 2. leads table — CRM pipeline feeding into sales quotations.
-- 3. leave_requests + attendance_records — HR depth feeding payroll input.

-- -------------------------------------------------------------------
-- Configurable costing method per company
-- -------------------------------------------------------------------
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS costing_method TEXT NOT NULL DEFAULT 'FIFO'
  CHECK (costing_method IN ('FIFO', 'WEIGHTED_AVERAGE', 'STANDARD'));

COMMENT ON COLUMN companies.costing_method IS
  'Inventory costing method for this company: FIFO (first-in-first-out), WEIGHTED_AVERAGE (moving average), or STANDARD (fixed standard cost).';

-- -------------------------------------------------------------------
-- CRM leads — pipeline feeding into sales quotations
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_number     TEXT NOT NULL UNIQUE,
  company_name    TEXT,
  contact_name    TEXT NOT NULL,
  email           TEXT,
  phone           TEXT,
  source          TEXT,  -- e.g. 'WEBSITE', 'REFERRAL', 'TRADE_SHOW', 'COLD_CALL'
  status          TEXT NOT NULL DEFAULT 'NEW'
                  CHECK (status IN ('NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL_SENT', 'WON', 'LOST')),
  potential_value DECIMAL(15,2),
  ai_score        INTEGER CHECK (ai_score BETWEEN 0 AND 100), -- from AI lead-scoring
  assigned_to     UUID REFERENCES users(id),
  converted_to_customer_id UUID REFERENCES customers(id),
  converted_to_quotation_id UUID REFERENCES sales_quotations(id),
  notes           TEXT,
  next_follow_up  DATE,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_leads_status ON leads (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads (assigned_to) WHERE deleted_at IS NULL;

COMMENT ON TABLE leads IS
  'CRM leads/opportunities pipeline — qualified leads feed into sales quotations. AI lead-scoring populates ai_score.';

-- -------------------------------------------------------------------
-- HR leave requests
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leave_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID NOT NULL REFERENCES employees(id),
  leave_type      TEXT NOT NULL CHECK (leave_type IN ('ANNUAL', 'SICK', 'UNPAID', 'MATERNITY', 'PATERNITY', 'OTHER')),
  start_date      DATE NOT NULL,
  end_date        DATE NOT NULL,
  total_days      DECIMAL(5,1) NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  reason          TEXT,
  approved_by     UUID REFERENCES users(id),
  approved_at     TIMESTAMPTZ,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at      TIMESTAMPTZ,
  CONSTRAINT leave_dates_valid CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_leave_employee ON leave_requests (employee_id, start_date);
CREATE INDEX IF NOT EXISTS idx_leave_status ON leave_requests (status) WHERE deleted_at IS NULL;

-- -------------------------------------------------------------------
-- HR attendance records (clock-in/out)
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID NOT NULL REFERENCES employees(id),
  record_date     DATE NOT NULL,
  clock_in        TIMESTAMPTZ,
  clock_out       TIMESTAMPTZ,
  hours_worked    DECIMAL(5,2) GENERATED ALWAYS AS (
                    CASE WHEN clock_in IS NOT NULL AND clock_out IS NOT NULL
                      THEN EXTRACT(EPOCH FROM (clock_out - clock_in)) / 3600.0
                      ELSE NULL END
                  ) STORED,
  status          TEXT NOT NULL DEFAULT 'PRESENT'
                  CHECK (status IN ('PRESENT', 'ABSENT', 'LATE', 'HALF_DAY')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (employee_id, record_date)
);

CREATE INDEX IF NOT EXISTS idx_attendance_employee ON attendance_records (employee_id, record_date);

COMMENT ON TABLE leave_requests IS 'Employee leave requests — approved leave feeds into payroll deductions.';
COMMENT ON TABLE attendance_records IS 'Daily attendance — clock-in/out with computed hours. Feeds into payroll for hourly employees.';
