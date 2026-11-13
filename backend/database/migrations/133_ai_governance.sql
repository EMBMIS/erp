-- 133 — AI governance: spend caps, default tool gating, feedback capture.
--
-- 1. company_id on ai_usage_log so spend caps can be enforced per-company.
-- 2. Default min_role = MANAGER for every write-capable and highImpact tool
--    so a fresh install doesn't expose destructive actions to every role.
-- 3. ai_feedback table for capturing user rejections, corrections, and
--    overrides — currently discarded signal.

-- Per-company spend tracking
ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE SET NULL;

-- -------------------------------------------------------------------
-- Default min_role for write/highImpact tools.
-- Insert only when no row exists yet for that tool, so an admin who
-- already tuned their settings is never overwritten.
-- -------------------------------------------------------------------
INSERT INTO ai_tool_settings (tool_name, min_role, enabled)
SELECT name, 'MANAGER', true
FROM (VALUES
  ('run_findings_scan'),
  ('record_stocktake_count'),
  ('auto_reconcile_bank_account'),
  ('enable_agent'),
  ('email_document'),
  ('call_external_api'),
  ('build_agent'),
  ('build_tool'),
  ('propose_background_task'),
  ('generate_po_pdf'),
  ('generate_quotation_pdf'),
  ('generate_payslip_pdf'),
  ('generate_invoice_pdf'),
  ('generate_pdf_report'),
  ('generate_custom_pdf'),
  ('generate_artifact'),
  ('execute_sandboxed_code')
) AS t(name)
WHERE NOT EXISTS (SELECT 1 FROM ai_tool_settings WHERE tool_name = t.name);

-- -------------------------------------------------------------------
-- AI feedback — persist signals the assistant currently discards.
-- One row per user action: reject an AI suggestion, correct an
-- extracted field, override a GL code. Reportable for tuning.
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_feedback (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id),
  feedback_type   TEXT NOT NULL CHECK (feedback_type IN ('REJECTION', 'CORRECTION', 'OVERRIDE', 'RATING')),
  source          TEXT NOT NULL,          -- e.g. 'invoice_intake', 'chat', 'journal_suggestion', 'approval_brief'
  source_id       TEXT,                   -- optional reference to the document/entity
  field_name      TEXT,                   -- which field was corrected (for CORRECTION type)
  original_value  TEXT,                   -- what the AI proposed
  corrected_value TEXT,                   -- what the user changed it to
  notes           TEXT,                   -- free-text user comment
  rating          INT CHECK (rating BETWEEN 1 AND 5), -- for RATING type
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_feedback_source ON ai_feedback (source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_feedback_user ON ai_feedback (user_id, created_at DESC);

COMMENT ON TABLE ai_feedback IS
  'User feedback on AI suggestions: rejections, corrections, overrides, and ratings. Used to measure and improve AI quality.';
