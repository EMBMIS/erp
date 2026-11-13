-- 202608071600 — Real plans, subscriptions and usage limits.
--
-- Replaces routes/saas-billing.js's hardcoded "Enterprise Organization /
-- ENTERPRISE_SUITE / 50 seats" response with a real plan a company is
-- actually on. Every company gets 'free' at signup (register-company) —
-- the whole point of "SaaS with a free tier" is that free is a real,
-- persisted plan with real limits, not a demo screen.
--
-- Three tables:
--   plans               — GLOBAL reference data (not company-scoped): what
--                          each tier costs and allows.
--   company_subscriptions — COMPANY-SCOPED: which plan a company is on, its
--                          Stripe identifiers (null until they actually pay),
--                          and the current billing period.
--   usage_counters       — COMPANY-SCOPED: count-based monthly usage per
--                          metric (e.g. embedding calls), separate from
--                          ai_usage_log (migration 129) which tracks
--                          dollar-cost LLM spend — local embeddings have no
--                          dollar cost, so they need their own counter, not
--                          a cost estimate that would always read zero.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS plans (
  code                          TEXT PRIMARY KEY,
  name                          TEXT NOT NULL,
  price_cents                   INT NOT NULL DEFAULT 0,
  billing_interval              TEXT CHECK (billing_interval IN ('month', 'year')),
  max_seats                     INT,               -- NULL = unlimited
  max_ai_messages_per_month     INT,               -- NULL = unlimited
  max_embedding_calls_per_month INT,               -- NULL = unlimited
  features                      JSONB NOT NULL DEFAULT '[]',
  stripe_price_id               TEXT,              -- NULL for the free plan
  is_active                     BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS company_subscriptions (
  company_id              UUID PRIMARY KEY
                            DEFAULT COALESCE(current_company_id(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::uuid)
                            REFERENCES companies(id) ON DELETE CASCADE,
  plan_code               TEXT NOT NULL REFERENCES plans(code),
  status                  TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAST_DUE', 'CANCELLED')),
  stripe_customer_id      TEXT,
  stripe_subscription_id  TEXT,
  current_period_end      TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS usage_counters (
  company_id    UUID NOT NULL
                  DEFAULT COALESCE(current_company_id(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::uuid)
                  REFERENCES companies(id) ON DELETE CASCADE,
  period_month  DATE NOT NULL,   -- first-of-month; monthly counters
  metric        TEXT NOT NULL,   -- 'embedding_calls', etc.
  count         INT NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, period_month, metric)
);

INSERT INTO company_scoped_tables (table_name) VALUES
  ('company_subscriptions'), ('usage_counters')
ON CONFLICT DO NOTHING;

INSERT INTO plans (code, name, price_cents, billing_interval, max_seats, max_ai_messages_per_month, max_embedding_calls_per_month, features, stripe_price_id) VALUES
  ('free', 'Free', 0, NULL, 3, 200, 500,
   '["Up to 3 users","200 AI messages/month","500 embedding/search calls/month","All core ERP modules","Community support"]'::jsonb,
   NULL),
  ('pro', 'Pro', 4900, 'month', 25, 5000, 20000,
   '["Up to 25 users","5,000 AI messages/month","20,000 embedding/search calls/month","All modules incl. AI agents","Priority email support"]'::jsonb,
   NULL),
  ('enterprise', 'Enterprise', 0, NULL, NULL, NULL, NULL,
   '["Unlimited users","Unlimited AI usage","Unlimited embedding/search calls","Dedicated support","Custom SLAs"]'::jsonb,
   NULL)
ON CONFLICT (code) DO NOTHING;

-- Every existing company (the pre-existing single-tenant install) starts on
-- Enterprise — it already has full, unmetered usage today, and dropping it to
-- Free on migration would be a surprise downgrade, not a bug fix.
INSERT INTO company_subscriptions (company_id, plan_code, status)
  SELECT id, 'enterprise', 'ACTIVE' FROM companies
ON CONFLICT (company_id) DO NOTHING;

COMMENT ON TABLE plans IS 'Global plan catalogue (free/pro/enterprise) — what each tier costs and allows.';
COMMENT ON TABLE company_subscriptions IS 'Which plan a company is on. Company-scoped (RLS). stripe_* columns are NULL until the company actually pays.';
COMMENT ON TABLE usage_counters IS 'Count-based monthly usage per metric (e.g. embedding_calls) — separate from ai_usage_log''s dollar-cost tracking, since local embeddings have no dollar cost.';
