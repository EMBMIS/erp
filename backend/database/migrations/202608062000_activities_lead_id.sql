-- 202608062000 — Let activities attach to a lead.
--
-- activities (135_phase4_depth.sql, models/Crm.js) already attaches to a
-- contact, a deal, or a customer via nullable FK columns. leads (also
-- 135_phase4_depth.sql) is a separate, newer pipeline with no such link, so
-- "how engaged is this lead" has never been answerable from the schema —
-- there was nothing to count. AI lead scoring (services/crm/leadScoring.js)
-- needs that signal, so this adds the same kind of nullable FK the other
-- three attachment points already use.
--
-- Idempotent.

ALTER TABLE activities ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES leads(id);

CREATE INDEX IF NOT EXISTS idx_activities_lead ON activities (lead_id) WHERE lead_id IS NOT NULL;

COMMENT ON COLUMN activities.lead_id IS
  'Optional lead this activity is logged against (calls, emails, notes during qualification) — counted as an engagement signal by services/crm/leadScoring.js.';
