-- 099 — Generic, configurable N-step approval chains (ERP-Roadmap P2 #7).
--
-- This is deliberately ADDITIVE, not a replacement for the existing
-- DelegationOfAuthority (DOA) single-tier amount-band checks that sales and
-- procurement currently use and depend on — replacing those in place would
-- risk regressing working, tested approval paths for no immediate benefit.
-- Instead this is a new, opt-in engine any document type can be wired into
-- going forward: define a template of amount-banded steps (escalation tiers),
-- and a request against that template walks through only the steps whose
-- band the amount actually crosses, in order.
--
-- Example: a template with steps (min_amount=0, role=MANAGER) and
-- (min_amount=5000, role=ADMIN) means a $300 request needs only MANAGER
-- approval, but a $6000 request needs MANAGER approval THEN ADMIN approval,
-- sequentially — that's the "N-step" and "escalation" behavior.
-- Idempotent.

CREATE TABLE IF NOT EXISTS approval_chain_templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(100) NOT NULL,
  document_type VARCHAR(50)  NOT NULL, -- e.g. 'PURCHASE_ORDER', 'JOURNAL_ENTRY', 'CUSTOM'
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS approval_chain_steps (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id   UUID NOT NULL REFERENCES approval_chain_templates(id) ON DELETE CASCADE,
  step_number   INTEGER NOT NULL,
  min_amount    DECIMAL(15,2) NOT NULL DEFAULT 0, -- this step is required once the request amount >= min_amount
  approver_role VARCHAR(20) NOT NULL CHECK (approver_role IN ('USER','MANAGER','ADMIN','FINANCE_USER','FINANCE_MANAGER')),
  approver_user_id UUID REFERENCES users(id), -- optional: a SPECIFIC approver instead of any user with the role
  UNIQUE (template_id, step_number)
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id   UUID NOT NULL REFERENCES approval_chain_templates(id),
  document_type VARCHAR(50) NOT NULL,
  document_id   UUID NOT NULL,
  requested_by  UUID REFERENCES users(id),
  amount        DECIMAL(15,2) NOT NULL,
  currency      VARCHAR(3) NOT NULL DEFAULT 'USD',
  status        VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  current_step  INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
CREATE INDEX IF NOT EXISTS idx_approval_requests_document ON approval_requests(document_type, document_id);

CREATE TABLE IF NOT EXISTS approval_request_steps (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    UUID NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  step_number   INTEGER NOT NULL,
  approver_role VARCHAR(20) NOT NULL,
  approver_user_id UUID REFERENCES users(id),
  status        VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','SKIPPED')),
  decided_by    UUID REFERENCES users(id),
  decided_at    TIMESTAMPTZ,
  comments      TEXT,
  UNIQUE (request_id, step_number)
);

CREATE INDEX IF NOT EXISTS idx_approval_request_steps_pending
  ON approval_request_steps(approver_role, status) WHERE status = 'PENDING';
