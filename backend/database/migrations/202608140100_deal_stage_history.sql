-- Deal stage history — CRM pipeline audit trail.
--
-- deals.stage changes today with no record of when or by whom, unlike almost
-- every other stateful entity in this codebase (PO, PR, credit notes, work
-- orders, ... all have a *_status_history table). A sales manager cannot
-- answer "how long did this deal sit in PROPOSAL" or "who moved it to
-- NEGOTIATION" — this closes that gap for deals specifically (PHASE3_TEN_TENTHS
-- CRM item: "stage history").

CREATE TABLE IF NOT EXISTS deal_stage_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id       UUID NOT NULL REFERENCES deals(id),
  from_stage    TEXT,
  to_stage      TEXT NOT NULL,
  changed_by    UUID REFERENCES users(id),
  reason        TEXT,
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS deal_stage_history_deal_idx ON deal_stage_history (deal_id);
CREATE INDEX IF NOT EXISTS deal_stage_history_changed_at_idx ON deal_stage_history (changed_at);
