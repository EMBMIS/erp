-- 100 — AI findings: scheduled anomaly scan results (ERP-Roadmap AI P2 #4).
--
-- Turns AI-Insights from pull (a human asks a question) to push (the system
-- surfaces things worth looking at on its own). Deliberately rule-based/
-- statistical, not LLM-invented — per AI-Roadmap's explicit guidance to
-- "replace pure-LLM predictions with statistical baselines", every check here
-- is a real SQL query over real data (duplicate invoices, weekend postings,
-- round-number outliers, low stock, overdue POs), not a model guessing.
-- Idempotent.

CREATE TABLE IF NOT EXISTS ai_findings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_type VARCHAR(50) NOT NULL, -- e.g. DUPLICATE_INVOICE, WEEKEND_POSTING, ROUND_NUMBER_OUTLIER, STOCKOUT_RISK, SUPPLIER_DELAY_RISK
  severity     VARCHAR(10) NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN ('LOW','MEDIUM','HIGH')),
  entity_type  VARCHAR(50),
  entity_id    UUID,
  title        VARCHAR(255) NOT NULL,
  description  TEXT,
  data         JSONB,
  status       VARCHAR(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED','DISMISSED')),
  acknowledged_by UUID REFERENCES users(id),
  acknowledged_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_findings_status ON ai_findings(status);
CREATE INDEX IF NOT EXISTS idx_ai_findings_type ON ai_findings(finding_type);
-- Dedup guard: at most one OPEN finding per (type, entity) so re-running the
-- scan doesn't pile up duplicate findings for the same underlying issue.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_findings_dedup_open
  ON ai_findings(finding_type, entity_type, entity_id) WHERE status = 'OPEN';
