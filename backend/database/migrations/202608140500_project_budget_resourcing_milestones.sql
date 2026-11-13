-- Projects: 4 -> 10 (PHASE3_TEN_TENTHS_PROMPT.md item 4).
--
-- Adds the four things the module was missing: a real approval gate on
-- timesheets before they can be billed, a dollar budget with PO commitment
-- tracking and an estimate-at-completion forecast, per-employee resource
-- loading against capacity, and milestone-based revenue recognition that
-- posts to the GL independently of time billing.
--
-- Idempotent.

-- ===========================================================================
-- Timesheet approval
-- ===========================================================================
--
-- Every time entry starts PENDING. Billing (TimeEntries.billProject) and the
-- billing preview now only consider APPROVED, unbilled, billable hours — an
-- unapproved hour cannot reach an invoice. Approval requires a distinct user
-- from whoever logged the time (SoD, same pattern as credit-note approval).
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20)
  NOT NULL DEFAULT 'PENDING' CHECK (approval_status IN ('PENDING','APPROVED','REJECTED'));
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id);
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_time_entries_pending_approval
  ON time_entries (project_id, approval_status) WHERE approval_status = 'PENDING';

-- ===========================================================================
-- Budgeting and commitment tracking
-- ===========================================================================
--
-- budget_hours already existed (hours only). budget_amount is the dollar
-- budget a project is managed against — the number that actually answers
-- "are we going to blow this project's budget."
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_amount DECIMAL(15,2);

-- A PO raised against a project is a real commitment before a single dollar
-- posts to the GL (which only happens at goods receipt / supplier invoice).
-- Without this column, "commitment tracking" is impossible — a project's
-- true exposure is invisible until an invoice lands.
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_project ON purchase_orders (project_id) WHERE project_id IS NOT NULL;

-- Every customer invoice for a project's work is now tagged directly, rather
-- than derived by joining through time_entries.invoice_id — which missed
-- milestone invoices entirely, since those have no time entries behind them.
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id);
CREATE INDEX IF NOT EXISTS idx_customer_invoices_project ON customer_invoices (project_id) WHERE project_id IS NOT NULL;

-- ===========================================================================
-- Resource loading
-- ===========================================================================
--
-- Standard weekly capacity per employee. Defaults to a 40-hour week;
-- overridable for part-timers. Nullable so "unknown" is distinguishable from
-- "zero capacity."
ALTER TABLE employees ADD COLUMN IF NOT EXISTS weekly_capacity_hours DECIMAL(6,2) DEFAULT 40;

-- An allocation of an employee's time to a project over a date range,
-- expressed as hours per week. Deliberately not a daily calendar — a
-- resourcing view answers "is anyone overcommitted this month," not "what is
-- Priya doing at 2pm on Tuesday."
CREATE TABLE IF NOT EXISTS project_assignments (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id               UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  employee_id              UUID NOT NULL REFERENCES employees(id),
  allocation_hours_per_week DECIMAL(6,2) NOT NULL CHECK (allocation_hours_per_week > 0),
  start_date               DATE NOT NULL,
  end_date                 DATE,

  created_by                UUID REFERENCES users(id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_project_assignments_employee ON project_assignments (employee_id, start_date);
CREATE INDEX IF NOT EXISTS idx_project_assignments_project  ON project_assignments (project_id);

-- ===========================================================================
-- Milestone billing / revenue recognition
-- ===========================================================================
--
-- A milestone is achieved (the deliverable happened), then billed (an
-- invoice is raised and posted to the GL for that milestone's amount) as two
-- distinct steps, mirroring the same achieved-then-posted separation the
-- credit-note and depreciation flows use elsewhere in this codebase — the
-- event that earns revenue and the act of billing it are not required to be
-- the same moment.
CREATE TABLE IF NOT EXISTS project_milestones (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name           VARCHAR(200) NOT NULL,
  amount         DECIMAL(15,2) NOT NULL CHECK (amount > 0),
  target_date    DATE,

  status         VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING','ACHIEVED','BILLED','CANCELLED')),
  achieved_at    TIMESTAMPTZ,
  achieved_by    UUID REFERENCES users(id),
  invoice_id     UUID REFERENCES customer_invoices(id),
  billed_at      TIMESTAMPTZ,

  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_project_milestones_project ON project_milestones (project_id, status);
