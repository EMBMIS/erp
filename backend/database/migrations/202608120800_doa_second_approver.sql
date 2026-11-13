-- 202608120800 — DoA second approver (four-eyes co-signer) column.
--
-- C6 four-eyes governance: every delegation_of_authority record carries the
-- id of the distinct second approver who countersigned the grant. The engine
-- (services/authority.js, MODIFY_DOA) already REFUSES to create a DoA record
-- without a second approver distinct from the creator; this column is what
-- makes that signature storable and auditable. Before this migration the
-- value was accepted in the request body and silently dropped, so creation
-- from the UI could never succeed and nothing recorded who countersigned.
--
-- Nullable on purpose: legacy rows predate the requirement, and a bare
-- is_active toggle (activate/deactivate from the approvals list) must not
-- force a countersignature.

ALTER TABLE delegation_of_authority
  ADD COLUMN IF NOT EXISTS second_approver_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_doa_second_approver
  ON delegation_of_authority(second_approver_id);
