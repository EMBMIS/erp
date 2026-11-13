-- EMBMIS Gateway: every action an AI takes is checked before it happens.
--
-- ===========================================================================
-- WHAT THESE TABLES ARE FOR
-- ===========================================================================
-- Business OS never executes a gateway decision on the gateway's say-so alone
-- and never stores the gateway's data model. It stores two things:
--
--   gateway_tenants    the link from a company to its tenant in EMBMIS Gateway,
--                      including the "simeli" agent key the gateway issued for
--                      it. The key is a secret: it is encrypted with the same
--                      AES-256-GCM vault as every other stored credential
--                      (AI_VAULT_KEY) and never leaves through an API.
--
--   gateway_decisions  one row per verdict, as Business OS received it (or as
--                      it fell back to when the gateway could not be reached).
--                      This is what the Settings → AI Gateway page lists and
--                      what "Checked by EMBMIS Gateway: N allowed, M sent to
--                      you" counts. The gateway keeps the authoritative,
--                      hash-chained audit log; this is the local index into it.
--
-- Arguments are deliberately NOT stored: only the tool, the kind of action and
-- the amount. A decision log that copied every payload would become a second,
-- weaker copy of the data it is meant to protect.

CREATE TABLE IF NOT EXISTS gateway_tenants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Which gateway this link is for. If EMBMIS_GATEWAY_URL changes (a move, a
  -- new environment) the link is stale and is re-provisioned rather than
  -- trusted, because the key belongs to the old gateway's database.
  gateway_url   TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  project_id    TEXT,
  agent_id      TEXT,
  agent_name    TEXT NOT NULL DEFAULT 'simeli',

  key_cipher    TEXT NOT NULL,
  key_iv        TEXT NOT NULL,
  key_tag       TEXT NOT NULL,
  key_id        TEXT NOT NULL,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_gateway_tenants_company UNIQUE (company_id)
);

CREATE TABLE IF NOT EXISTS gateway_decisions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Who asked: 'simeli' for the chat assistant, 'agent:<key>' for an
  -- autonomous agent. user_id is whoever the work was done for, when known.
  source        TEXT NOT NULL,
  user_id       TEXT,

  tool_name     TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('READ', 'WRITE', 'PAYMENT')),
  amount        NUMERIC(18, 2),
  currency      TEXT,

  -- allow | deny | escalate: what the gateway said, or what the fail mode
  -- turned an unreachable gateway into.
  decision      TEXT NOT NULL CHECK (decision IN ('allow', 'deny', 'escalate')),
  code          TEXT NOT NULL,
  reason        TEXT,
  -- 'gateway' = the gateway answered. 'fallback' = it could not be reached (or
  -- answered with an error) and EMBMIS_GATEWAY_FAIL_MODE decided.
  origin        TEXT NOT NULL DEFAULT 'gateway' CHECK (origin IN ('gateway', 'fallback')),

  trace_id      TEXT,
  risk_score    INTEGER,
  risk_factors  JSONB NOT NULL DEFAULT '[]'::jsonb,
  matched_policy JSONB,
  audit_id      TEXT,
  audit_hash    TEXT,
  latency_ms    NUMERIC(10, 2),

  -- What a person answered when the decision was an escalation, and whether
  -- that answer reached the gateway's audit chain.
  outcome       TEXT CHECK (outcome IN ('approved', 'rejected')),
  resolved_by   TEXT,
  resolved_at   TIMESTAMPTZ,
  resolve_synced_at TIMESTAMPTZ,
  resolve_error TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_gateway_decisions_company_time
  ON gateway_decisions (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gateway_decisions_trace
  ON gateway_decisions (trace_id) WHERE trace_id IS NOT NULL;
-- Answers that still have to be delivered to the gateway.
CREATE INDEX IF NOT EXISTS idx_gateway_decisions_unsynced
  ON gateway_decisions (company_id) WHERE outcome IS NOT NULL AND resolve_synced_at IS NULL;

-- An autonomous agent's escalation remembers which gateway decision raised it,
-- so the person's answer can be reported to the gateway's audit chain.
ALTER TABLE agent_escalations ADD COLUMN IF NOT EXISTS gateway_trace_id TEXT;

-- Company isolation, same policy text and FORCE as every company-scoped table.
INSERT INTO company_scoped_tables (table_name)
VALUES ('gateway_tenants'), ('gateway_decisions')
ON CONFLICT (table_name) DO NOTHING;

ALTER TABLE gateway_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway_tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_isolation ON gateway_tenants;
CREATE POLICY company_isolation ON gateway_tenants
  USING (company_id = public.current_company_id())
  WITH CHECK (company_id = public.current_company_id());

ALTER TABLE gateway_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway_decisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_isolation ON gateway_decisions;
CREATE POLICY company_isolation ON gateway_decisions
  USING (company_id = public.current_company_id())
  WITH CHECK (company_id = public.current_company_id());

DO $$
DECLARE
  default_id UUID;
  role_name  TEXT;
BEGIN
  SELECT id INTO default_id FROM companies ORDER BY created_at ASC LIMIT 1;
  IF default_id IS NULL THEN
    default_id := '11111111-1111-1111-1111-111111111111'::uuid;
  END IF;
  EXECUTE format(
    'ALTER TABLE gateway_tenants ALTER COLUMN company_id SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)',
    default_id
  );
  EXECUTE format(
    'ALTER TABLE gateway_decisions ALTER COLUMN company_id SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)',
    default_id
  );

  FOR role_name IN
    SELECT DISTINCT g.grantee FROM information_schema.role_table_grants g
     WHERE g.table_name = 'app_notifications' AND g.privilege_type = 'INSERT'
       AND g.grantee <> 'PUBLIC'
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON gateway_tenants TO %I', role_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON gateway_decisions TO %I', role_name);
  END LOOP;
END $$;
