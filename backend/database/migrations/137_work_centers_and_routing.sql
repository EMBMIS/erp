-- 137 — Work centres and routing.
--
-- WHY THIS EXISTS
-- ===========================================================================
-- `GET /manufacturing/work-centers/capacity` has been shipping since the
-- manufacturing module landed, the sidebar links to "Work Centers & Routing",
-- and WorkCenterDashboard.jsx renders utilisation bars from it. None of it was
-- real: there is no `work_centers` table anywhere in migrations 001-136. The
-- route referenced an unimported `pool`, so it threw a ReferenceError, and the
-- `.catch()` behind it was meant to serve three hardcoded work centres ("CNC
-- Cutting Station", 80% utilised) as though they were the company's own.
--
-- That is worse than a missing feature. A capacity screen that always shows
-- plausible numbers is a screen people plan against, and it would have kept
-- showing 80% whether the shop floor was idle or on fire.
--
-- So the table is created here and the endpoint is rewritten to report what is
-- actually in it — including reporting nothing when nothing is set up.
--
-- WHAT ROUTING MEANS HERE
-- ===========================================================================
-- A BOM answers "what goes into this?". A routing answers "what has to happen
-- to it, where, and for how long?". Those are different questions and this
-- system only had the first, which is why work orders could be costed for
-- material but never for time.
--
-- Routing is defined once per BOM (`bom_operations`) and COPIED onto each work
-- order (`work_order_operations`) when the order is created. The copy is the
-- point: a work order released in March must keep the standard it was planned
-- against even after someone re-times the operation in April, or the variance
-- between planned and actual becomes meaningless.
--
-- Idempotent.

-- ---------------------------------------------------------------------------
-- Work centres — a place with finite capacity where work happens.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS work_centers (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code                 VARCHAR(30)  NOT NULL UNIQUE,
  name                 VARCHAR(120) NOT NULL,
  description          TEXT,

  -- Where the time is charged. Labour and machine time booked against this
  -- centre lands in this cost centre, so shop-floor time reaches the same
  -- controlling reports as every other cost.
  cost_center_id       UUID REFERENCES cost_centers(id),

  -- Nominal hours this centre can run in a working day, before efficiency.
  -- Two shifts of eight hours on three identical machines is 48.
  daily_capacity_hours DECIMAL(10,2) NOT NULL DEFAULT 8
                       CHECK (daily_capacity_hours > 0),

  -- What fraction of nominal capacity is really available, as a percentage.
  -- Accounts for changeover, maintenance and breaks. Effective capacity is
  -- daily_capacity_hours * efficiency_pct / 100 — kept as two separate numbers
  -- because planners need to see the haircut, not just the result.
  efficiency_pct       DECIMAL(5,2)  NOT NULL DEFAULT 100
                       CHECK (efficiency_pct > 0 AND efficiency_pct <= 200),

  -- Fully-loaded cost of an hour here (labour + machine + overhead). Used to
  -- value operation time on a work order.
  hourly_rate          DECIMAL(15,4) NOT NULL DEFAULT 0 CHECK (hourly_rate >= 0),

  status               VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE'
                       CHECK (status IN ('ACTIVE','INACTIVE','MAINTENANCE')),

  created_by           UUID REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_work_centers_status ON work_centers (status)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Standard routing, defined against a BOM.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bom_operations (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bom_id              UUID NOT NULL REFERENCES bills_of_material(id) ON DELETE CASCADE,
  operation_number    INTEGER NOT NULL,
  work_center_id      UUID NOT NULL REFERENCES work_centers(id),
  description         VARCHAR(200) NOT NULL,

  -- Setup is paid once per order; run time scales with quantity. Keeping them
  -- separate is what makes a batch of 1000 cost less per unit than a batch of
  -- 10, which is the whole reason anyone models routing.
  setup_hours         DECIMAL(10,4) NOT NULL DEFAULT 0 CHECK (setup_hours >= 0),
  run_hours_per_unit  DECIMAL(10,6) NOT NULL DEFAULT 0 CHECK (run_hours_per_unit >= 0),

  created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE (bom_id, operation_number)
);

CREATE INDEX IF NOT EXISTS idx_bom_operations_bom ON bom_operations (bom_id, operation_number);
CREATE INDEX IF NOT EXISTS idx_bom_operations_wc  ON bom_operations (work_center_id);

-- ---------------------------------------------------------------------------
-- The routing as it applies to one work order — a snapshot, not a reference.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS work_order_operations (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  work_order_id       UUID NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  operation_number    INTEGER NOT NULL,
  work_center_id      UUID NOT NULL REFERENCES work_centers(id),
  description         VARCHAR(200) NOT NULL,

  setup_hours         DECIMAL(10,4) NOT NULL DEFAULT 0,
  run_hours_per_unit  DECIMAL(10,6) NOT NULL DEFAULT 0,

  -- Total hours this operation is expected to consume for THIS order's
  -- quantity. Stored rather than derived so that capacity can be summed in a
  -- single scan, and so it survives a later change to the order quantity being
  -- reflected deliberately rather than silently.
  planned_hours       DECIMAL(12,4) NOT NULL DEFAULT 0 CHECK (planned_hours >= 0),
  actual_hours        DECIMAL(12,4) NOT NULL DEFAULT 0 CHECK (actual_hours >= 0),

  -- Rate copied from the work centre at planning time, for the same reason the
  -- hours are copied: the variance must be against the standard that was
  -- actually planned against.
  hourly_rate         DECIMAL(15,4) NOT NULL DEFAULT 0,

  status              VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','IN_PROGRESS','COMPLETED','SKIPPED')),

  scheduled_start     TIMESTAMPTZ,
  scheduled_end       TIMESTAMPTZ,
  actual_start        TIMESTAMPTZ,
  actual_end          TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE (work_order_id, operation_number)
);

CREATE INDEX IF NOT EXISTS idx_wo_operations_wo ON work_order_operations (work_order_id, operation_number);

-- The index behind the capacity query: find open operations for a centre.
CREATE INDEX IF NOT EXISTS idx_wo_operations_load
  ON work_order_operations (work_center_id, status)
  WHERE status IN ('PENDING','IN_PROGRESS');

-- ---------------------------------------------------------------------------
-- Time booked against an operation. One row per confirmation, never an
-- in-place update — actual_hours on the operation is the running total, and
-- this is the audit trail that explains it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS work_order_time_entries (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operation_id        UUID NOT NULL REFERENCES work_order_operations(id) ON DELETE CASCADE,
  work_order_id       UUID NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  hours               DECIMAL(10,4) NOT NULL CHECK (hours > 0),
  entry_date          DATE NOT NULL DEFAULT CURRENT_DATE,
  employee_id         UUID REFERENCES employees(id),
  notes               TEXT,
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wo_time_entries_op ON work_order_time_entries (operation_id);
CREATE INDEX IF NOT EXISTS idx_wo_time_entries_wo ON work_order_time_entries (work_order_id, entry_date);
