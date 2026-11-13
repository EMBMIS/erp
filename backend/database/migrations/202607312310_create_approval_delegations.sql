-- Approval engine: delegation-while-absent support.
--
-- Lets a DoA approver (delegator) hand their approval authority to another
-- user (delegate) for a bounded period. The approval rules engine resolves an
-- active delegation to the delegate and records the original approver, so
-- approvals continue while the principal is out of office.

CREATE TABLE IF NOT EXISTS approval_delegations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delegator_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delegate_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  end_date      TIMESTAMPTZ,
  status        VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE', 'CANCELLED')),
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_approval_delegations_delegator
  ON approval_delegations(delegator_id);

CREATE INDEX IF NOT EXISTS idx_approval_delegations_active
  ON approval_delegations(status, start_date, end_date)
  WHERE status = 'ACTIVE';
