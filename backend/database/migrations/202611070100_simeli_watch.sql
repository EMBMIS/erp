-- What Simeli has noticed, per person, so it can tell them before they ask.
--
-- "Simeli watches what is happening and surfaces what matters. One line slows
-- down, and it already knows what that will cost." The brief (services/
-- whatMattersNow.js) answers when someone asks. The watch (services/
-- simeliWatch.js) asks it for them on a schedule, as each person, and keeps
-- what it found here so it can say what is NEW, what got WORSE and what has
-- CLEARED since the last look — and notify only about the first two.
--
--   simeli_watch_items   One row per thing a person was shown: the line, the
--                        order, the supplier, the bill. OPEN while the watchers
--                        still find it; CLEARED (with when) once they stop.
--                        The money at stake is the person's own view of it:
--                        each sweep runs with their role, so a row never
--                        holds a number their role would not show them.
--   simeli_watch_sweeps  When each person was last watched, and what changed.
--
-- Nothing here changes a business record. The next step on each item is a
-- proposal that a person approves through the tool it names.

CREATE TABLE IF NOT EXISTS simeli_watch_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_key        VARCHAR(200) NOT NULL,
  area            VARCHAR(40) NOT NULL,
  severity        VARCHAR(10) NOT NULL CHECK (severity IN ('HIGH', 'MEDIUM')),
  title           TEXT NOT NULL,
  cause           TEXT,
  at_stake        NUMERIC(18,2) NOT NULL DEFAULT 0,
  first_at_stake  NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency        VARCHAR(3),
  stake_what      TEXT,
  record          JSONB,
  link            TEXT,
  next_step       JSONB,
  ask             TEXT,
  status          VARCHAR(10) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLEARED')),
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  worsened_at     TIMESTAMPTZ,
  worsened_note   TEXT,
  notified_at     TIMESTAMPTZ,
  cleared_at      TIMESTAMPTZ
);

-- One open row per person per problem: the same line is one thing until it clears.
CREATE UNIQUE INDEX IF NOT EXISTS uq_simeli_watch_items_open
  ON simeli_watch_items (company_id, user_id, item_key) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS idx_simeli_watch_items_feed
  ON simeli_watch_items (company_id, user_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS simeli_watch_sweeps (
  company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  swept_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  open_items   INTEGER NOT NULL DEFAULT 0,
  new_items    INTEGER NOT NULL DEFAULT 0,
  worse_items  INTEGER NOT NULL DEFAULT 0,
  cleared      INTEGER NOT NULL DEFAULT 0,
  headline     TEXT,
  checked      JSONB,
  PRIMARY KEY (company_id, user_id)
);

-- Company isolation, same policy text and FORCE as every company-scoped table.
INSERT INTO company_scoped_tables (table_name)
VALUES ('simeli_watch_items'), ('simeli_watch_sweeps')
ON CONFLICT (table_name) DO NOTHING;

ALTER TABLE simeli_watch_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE simeli_watch_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_isolation ON simeli_watch_items;
CREATE POLICY company_isolation ON simeli_watch_items
  USING (company_id = public.current_company_id())
  WITH CHECK (company_id = public.current_company_id());

ALTER TABLE simeli_watch_sweeps ENABLE ROW LEVEL SECURITY;
ALTER TABLE simeli_watch_sweeps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_isolation ON simeli_watch_sweeps;
CREATE POLICY company_isolation ON simeli_watch_sweeps
  USING (company_id = public.current_company_id())
  WITH CHECK (company_id = public.current_company_id());
