-- Counterfactual decision engine — measured branches, not predicted ones.
--
-- WHAT THIS STORES AND WHY IT IS NOT AN AI LOG
-- ===========================================================================
-- Every ERP on the market can tell you what happened. Several can now ask a
-- language model what it thinks should happen next. Neither of those is a
-- decision: the first is history and the second is an opinion with a citation
-- style.
--
-- This engine does the third thing. It takes one decision ("we have 180k of
-- cash and 340k of bills due in the next fortnight — which do we pay?"),
-- expands it into several candidate courses of action, and then APPLIES each
-- one to the real database inside a transaction that is guaranteed to roll
-- back. The resulting numbers — cash, working capital, AR/AP aging, stock
-- coverage, GL balance — are not forecasts. They are the ledger's own answer,
-- computed by the same SQL that computes the live figures, on a state that
-- briefly existed and was then discarded.
--
-- That is the property nobody outside this codebase can copy: it requires
-- owning the ledger, the constraints and the posting rules in one database.
-- A bolt-on AI layer can only ever guess at the second number.
--
--   ai_decision_runs      one question, its baseline state vector, the branch
--                         that won, and why.
--   ai_decision_branches  one candidate course of action: the effects applied,
--                         the state vector MEASURED after applying them, the
--                         deltas against baseline, constraint violations, and
--                         the score those produced.
--
-- Both tables are evidence, not proposals. Nothing here is executable: acting
-- on a chosen branch goes back through the ordinary draft/DOA/approval path
-- like any other write in this system. A branch that was measured is a fact
-- about the numbers; it is never an authorisation.

CREATE TABLE IF NOT EXISTS ai_decision_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id           UUID REFERENCES users(id) ON DELETE SET NULL,

  -- The question as the person asked it, and the scenario key that decided
  -- which effect primitives were in play (see services/ai/counterfactual/).
  question          TEXT NOT NULL,
  scenario          TEXT NOT NULL,
  horizon_days      INTEGER NOT NULL DEFAULT 30,

  -- Objective weights actually used for scoring this run. Stored because the
  -- ranking is only reproducible if the weights are: changing what the company
  -- optimises for changes which branch wins, and that must be visible.
  objective         JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- The measured state of the business BEFORE any branch was applied. Every
  -- delta in ai_decision_branches is against this vector.
  baseline          JSONB NOT NULL DEFAULT '{}'::jsonb,

  branch_count      INTEGER NOT NULL DEFAULT 0,
  chosen_branch_id  UUID,
  rationale         TEXT,

  -- observed  = branches were measured against the live ledger (the real thing)
  -- degraded  = the shadow transaction could not run; scores are unmeasured
  -- failed    = the run errored out; see `error`
  status            VARCHAR(20) NOT NULL DEFAULT 'observed',
  error             TEXT,

  duration_ms       INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_decision_run_status
    CHECK (status IN ('observed', 'degraded', 'failed'))
);

CREATE TABLE IF NOT EXISTS ai_decision_branches (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         UUID NOT NULL REFERENCES ai_decision_runs(id) ON DELETE CASCADE,
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  label          TEXT NOT NULL,
  summary        TEXT,

  -- The course of action: [{ effect, args, note }]. Only effects declared in
  -- services/ai/counterfactual/effects.js can appear here, and each one is a
  -- bounded SQL change applied inside the rolled-back transaction.
  effects        JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- What the ledger actually reported after those effects were applied, and
  -- the difference from the run's baseline. Measured, not modelled.
  measured       JSONB NOT NULL DEFAULT '{}'::jsonb,
  deltas         JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Hard rules the branch broke: negative cash, an unbalanced ledger, a
  -- stockout, a database constraint rejecting the write. A branch that breaks
  -- one is disqualified regardless of how well it scores.
  violations     JSONB NOT NULL DEFAULT '[]'::jsonb,

  score          NUMERIC(10,4),
  feasible       BOOLEAN NOT NULL DEFAULT TRUE,
  rank           INTEGER,

  -- Free-text reason the branch failed to apply at all (a constraint rejected
  -- it, an id did not resolve). A branch that cannot be applied is a real
  -- answer about that course of action, so it is kept rather than dropped.
  apply_error    TEXT,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_decision_runs_company_created
  ON ai_decision_runs (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_runs_user
  ON ai_decision_runs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_branches_run
  ON ai_decision_branches (run_id, rank NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_decision_branches_company
  ON ai_decision_branches (company_id);

-- chosen_branch_id points into the branch table; added after both tables exist
-- so the two-way reference does not depend on creation order.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_decision_run_chosen_branch'
  ) THEN
    ALTER TABLE ai_decision_runs
      ADD CONSTRAINT fk_decision_run_chosen_branch
      FOREIGN KEY (chosen_branch_id) REFERENCES ai_decision_branches(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- Company isolation, same shape as every other scoped table here: a default
-- that picks up the ambient company, and registration in company_scoped_tables
-- so enable_multi_company() covers these too.
DO $$
DECLARE
  default_id UUID;
BEGIN
  SELECT id INTO default_id FROM companies ORDER BY created_at ASC LIMIT 1;
  IF default_id IS NULL THEN
    default_id := '11111111-1111-1111-1111-111111111111'::uuid;
  END IF;

  EXECUTE format(
    'ALTER TABLE ai_decision_runs ALTER COLUMN company_id SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)',
    default_id
  );
  EXECUTE format(
    'ALTER TABLE ai_decision_branches ALTER COLUMN company_id SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)',
    default_id
  );
END $$;

INSERT INTO company_scoped_tables (table_name)
VALUES ('ai_decision_runs'), ('ai_decision_branches')
ON CONFLICT (table_name) DO NOTHING;

COMMENT ON TABLE ai_decision_runs IS
  'One counterfactual decision: the question, the measured baseline state vector, the branch that won and why. See services/ai/counterfactual/.';
COMMENT ON TABLE ai_decision_branches IS
  'One candidate course of action, applied to the real ledger inside a rolled-back transaction. `measured` is what the database reported, not a forecast.';
COMMENT ON COLUMN ai_decision_branches.measured IS
  'State vector observed after the branch effects were applied, computed by the same SQL that computes the live figures.';
COMMENT ON COLUMN ai_decision_branches.violations IS
  'Hard-rule breaks (negative cash, unbalanced ledger, stockout, rejected write). Any violation disqualifies the branch.';
