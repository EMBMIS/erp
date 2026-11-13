-- Migration 202608021200: give learned preferences a real table.
--
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- services/ai/preferenceLearningService.js wrote to `ai_settings (company_id,
-- key, value)`. ai_settings has no key or value column — it is one config row
-- per company (model, response_style, max_steps, ...). Every call to
-- recordOverride() therefore threw `column "key" does not exist`, which means
-- the override-learning feature had never executed successfully even once.
--
-- Preferences are a SET of rows per company, not a field on the single config
-- row, so they get their own table rather than being folded into ai_settings.extra.
--
-- `occurrences` is deliberate: a company that has corrected the same field
-- fifty times is expressing something much stronger than one that corrected it
-- once, and the prompt fragment can say so. Without it every correction looks
-- equally tentative.
--
-- Scoped from the start — see tests/tenancyGuard.test.js. A learned preference
-- is one company's accounting habit; leaking it across tenants would push one
-- customer's coding conventions onto another's books.

CREATE TABLE IF NOT EXISTS ai_learned_preferences (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  field_name      VARCHAR(120) NOT NULL,
  corrected_value TEXT NOT NULL,
  original_value  TEXT,
  notes           TEXT,
  occurrences     INTEGER NOT NULL DEFAULT 1,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_ai_learned_pref_company_field UNIQUE (company_id, field_name)
);

CREATE INDEX IF NOT EXISTS idx_ai_learned_pref_company
  ON ai_learned_preferences (company_id);

DO $$
DECLARE
  default_id UUID;
BEGIN
  SELECT id INTO default_id FROM companies ORDER BY created_at ASC LIMIT 1;
  IF default_id IS NULL THEN
    default_id := '11111111-1111-1111-1111-111111111111'::uuid;
  END IF;

  EXECUTE format(
    'ALTER TABLE ai_learned_preferences ALTER COLUMN company_id SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)',
    default_id
  );
END $$;

INSERT INTO company_scoped_tables (table_name)
VALUES ('ai_learned_preferences')
ON CONFLICT (table_name) DO NOTHING;
