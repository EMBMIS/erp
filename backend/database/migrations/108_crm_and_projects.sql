-- 108 — Lightweight CRM and simple billable projects.
--
-- Scoped for a 10–500 person company: a salesperson tracking deals and a
-- consultant billing time, not Salesforce and not MS Project. The test applied
-- to every column here was "would a 50-person company fill this in on day one?"
-- — anything that failed was left out.
--
-- Two things this deliberately does NOT have, because they are what make CRMs
-- unusable at this size: custom-field builders, and configurable pipeline
-- stages. A fixed six-stage pipeline is a feature — it means the reports work
-- out of the box and two people describing the same deal agree on what stage
-- it is in.
--
-- Idempotent.

-- ===========================================================================
-- CRM
-- ===========================================================================

-- Contacts: real people.
--
-- Today `customers` carries primary_contact_* and secondary_contact_* inline,
-- which caps a customer at exactly two contacts and makes "who did we speak to"
-- unanswerable. Those columns are left alone (existing screens read them); this
-- table is additive and is where new contacts should go.
CREATE TABLE IF NOT EXISTS contacts (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  first_name     VARCHAR(80)  NOT NULL,
  last_name      VARCHAR(80),
  email          VARCHAR(160),
  phone          VARCHAR(40),
  job_title      VARCHAR(120),

  -- Nullable: a lead is a real contact before they are ever a customer, and
  -- forcing a customer record first is the friction that stops people using it.
  customer_id    UUID REFERENCES customers(id),

  owner_id       UUID REFERENCES users(id),
  notes          TEXT,
  status         VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
                 CHECK (status IN ('ACTIVE', 'INACTIVE')),

  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_contacts_customer ON contacts (customer_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_owner    ON contacts (owner_id)    WHERE deleted_at IS NULL;
-- Case-insensitive email lookup: "do we already know this person?" is the most
-- common question asked of a CRM, and duplicate contacts are its most common
-- failure.
CREATE INDEX IF NOT EXISTS idx_contacts_email    ON contacts (LOWER(email)) WHERE email IS NOT NULL AND deleted_at IS NULL;

-- Deals: the pipeline.
CREATE TABLE IF NOT EXISTS deals (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_number         VARCHAR(30) NOT NULL UNIQUE,
  title               VARCHAR(200) NOT NULL,

  customer_id         UUID REFERENCES customers(id),
  contact_id          UUID REFERENCES contacts(id),

  value               DECIMAL(15,2) NOT NULL DEFAULT 0,
  currency            VARCHAR(3) NOT NULL DEFAULT 'USD',

  -- Fixed pipeline. NEW → QUALIFIED → PROPOSAL → NEGOTIATION → WON | LOST.
  stage               VARCHAR(20) NOT NULL DEFAULT 'NEW'
                      CHECK (stage IN ('NEW','QUALIFIED','PROPOSAL','NEGOTIATION','WON','LOST')),

  -- Defaulted per stage by the model rather than typed by hand. A forecast built
  -- from numbers salespeople invent is worse than one built from stage averages,
  -- because it looks precise.
  probability         INTEGER NOT NULL DEFAULT 10 CHECK (probability BETWEEN 0 AND 100),

  expected_close_date DATE,
  owner_id            UUID REFERENCES users(id),
  source              VARCHAR(60),

  closed_at           TIMESTAMPTZ,
  lost_reason         TEXT,
  -- Set when a won deal is turned into a real order, so the pipeline can be
  -- reconciled against actual revenue.
  sales_order_id      UUID REFERENCES sales_orders(id),

  notes               TEXT,
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_deals_open ON deals (stage, expected_close_date)
  WHERE deleted_at IS NULL AND stage NOT IN ('WON','LOST');
CREATE INDEX IF NOT EXISTS idx_deals_owner    ON deals (owner_id)    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deals_customer ON deals (customer_id) WHERE deleted_at IS NULL;

-- Activities: calls, emails, meetings, notes and follow-up reminders.
CREATE TABLE IF NOT EXISTS activities (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  activity_type VARCHAR(20) NOT NULL DEFAULT 'TASK'
                CHECK (activity_type IN ('CALL','EMAIL','MEETING','TASK','NOTE')),
  subject       VARCHAR(200) NOT NULL,
  notes         TEXT,

  -- A NOTE records something that happened; the others can be scheduled. Both
  -- live in one table so a contact's history is a single ordered list.
  due_date      DATE,
  completed_at  TIMESTAMPTZ,

  contact_id    UUID REFERENCES contacts(id),
  deal_id       UUID REFERENCES deals(id) ON DELETE CASCADE,
  customer_id   UUID REFERENCES customers(id),

  owner_id      UUID REFERENCES users(id),
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_activities_due ON activities (due_date)
  WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_activities_deal    ON activities (deal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_contact ON activities (contact_id, created_at DESC);

-- ===========================================================================
-- Projects
-- ===========================================================================

CREATE TABLE IF NOT EXISTS projects (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_code    VARCHAR(30) NOT NULL UNIQUE,
  name            VARCHAR(200) NOT NULL,
  description     TEXT,

  customer_id     UUID REFERENCES customers(id),

  -- How the project earns. TIME_AND_MATERIALS bills logged hours;
  -- FIXED_PRICE bills an agreed sum but still tracks time so margin is visible;
  -- INTERNAL never bills (overhead, R&D) but still absorbs cost.
  billing_type    VARCHAR(20) NOT NULL DEFAULT 'TIME_AND_MATERIALS'
                  CHECK (billing_type IN ('TIME_AND_MATERIALS','FIXED_PRICE','INTERNAL')),

  -- Default rate for billable time. Overridable per person and per entry, since
  -- a junior and a principal on the same project do not bill the same.
  default_hourly_rate DECIMAL(15,2),
  fixed_price     DECIMAL(15,2),
  budget_hours    DECIMAL(12,2),
  currency        VARCHAR(3) NOT NULL DEFAULT 'USD',

  status          VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('PLANNED','ACTIVE','ON_HOLD','COMPLETED','CANCELLED')),

  start_date      DATE,
  end_date        DATE,
  manager_id      UUID REFERENCES users(id),

  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_projects_customer ON projects (customer_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_projects_status   ON projects (status)      WHERE deleted_at IS NULL;

-- Tasks: a flat checklist, deliberately. No dependencies, no Gantt, no critical
-- path — a 50-person company wants to know what is left to do, and every team
-- that has been handed a dependency graph has quietly stopped updating it.
CREATE TABLE IF NOT EXISTS project_tasks (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            VARCHAR(200) NOT NULL,
  description     TEXT,

  status          VARCHAR(20) NOT NULL DEFAULT 'TODO'
                  CHECK (status IN ('TODO','IN_PROGRESS','DONE','CANCELLED')),

  assignee_id     UUID REFERENCES users(id),
  estimated_hours DECIMAL(10,2),
  due_date        DATE,
  completed_at    TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_project_tasks_project ON project_tasks (project_id, status);

-- Time entries: the unit that becomes revenue.
CREATE TABLE IF NOT EXISTS time_entries (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id    UUID NOT NULL REFERENCES projects(id),
  task_id       UUID REFERENCES project_tasks(id) ON DELETE SET NULL,

  user_id       UUID REFERENCES users(id),
  employee_id   UUID REFERENCES employees(id),

  entry_date    DATE NOT NULL,
  hours         DECIMAL(8,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  description   TEXT,

  billable      BOOLEAN NOT NULL DEFAULT true,
  -- Captured per entry rather than read from the project at invoicing time:
  -- rates change, and time logged last quarter must bill at last quarter's rate.
  hourly_rate   DECIMAL(15,2),

  -- Set once the entry has been billed. Locking on invoice is what stops the
  -- same hour being billed twice — the single most damaging bug this table
  -- could have, because the customer sees it.
  invoice_id    UUID REFERENCES customer_invoices(id),
  invoiced_at   TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_time_entries_project ON time_entries (project_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_time_entries_user    ON time_entries (user_id, entry_date);
-- Drives both the billing run and the unbilled-revenue agent.
CREATE INDEX IF NOT EXISTS idx_time_entries_unbilled
  ON time_entries (project_id, entry_date)
  WHERE billable = true AND invoice_id IS NULL;

-- ---------------------------------------------------------------------------
-- Wire up the dangling project dimension.
--
-- journal_entry_items.project_id has existed as an unconstrained UUID with no
-- table behind it and no rows using it. Now that projects exist, give it a real
-- foreign key so project P&L is answerable and a typo cannot post cost to a
-- project that does not exist.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_journal_entry_items_project'
  ) THEN
    ALTER TABLE journal_entry_items
      ADD CONSTRAINT fk_journal_entry_items_project
      FOREIGN KEY (project_id) REFERENCES projects(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_journal_entry_items_project
  ON journal_entry_items (project_id) WHERE project_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Number generators (advisory-locked, matching the rest of this codebase)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_deal_number()
 RETURNS text LANGUAGE plpgsql AS $function$
DECLARE next_number INTEGER;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('generate_deal_number'));
    SELECT COALESCE(MAX(
        CASE WHEN deal_number ~ '^DEAL-[0-9]+$'
             THEN SUBSTRING(deal_number FROM '\-([0-9]+)$')::INTEGER ELSE 0 END
    ), 0) + 1 INTO next_number FROM deals;
    RETURN 'DEAL-' || LPAD(next_number::TEXT, 6, '0');
END;
$function$;

CREATE OR REPLACE FUNCTION public.generate_project_code()
 RETURNS text LANGUAGE plpgsql AS $function$
DECLARE next_number INTEGER;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('generate_project_code'));
    SELECT COALESCE(MAX(
        CASE WHEN project_code ~ '^PRJ-[0-9]+$'
             THEN SUBSTRING(project_code FROM '\-([0-9]+)$')::INTEGER ELSE 0 END
    ), 0) + 1 INTO next_number FROM projects;
    RETURN 'PRJ-' || LPAD(next_number::TEXT, 4, '0');
END;
$function$;
