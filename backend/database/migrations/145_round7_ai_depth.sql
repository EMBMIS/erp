-- 145 â€” Round 7 AI depth: actionable findings, fraud detectors, behaviour-based cash forecast.
--
-- Backing schema for ROADMAP_TO_10.md Round 7:
--   Task 19  continuous close findings become actionable (approve -> post draft JE,
--            dismiss -> record why and suppress re-raising for a window)
--   Task 20  vendor fraud detectors need bank/tax detail on suppliers & employees plus a
--            change-history table ("bank detail changed shortly before a payment")
--   Task 21  cash forecast adds loan schedules and tax payment schedules
--
-- Idempotent, follows the migration 140/144 conventions (company_id defaults resolve
-- from the session, tables register in company_scoped_tables).

-- ===========================================================================
-- 1. ai_findings: link a finding to its proposed correcting journal entry and
--    record how it was resolved.
-- ===========================================================================
ALTER TABLE ai_findings
  ADD COLUMN IF NOT EXISTS proposed_journal_entry_id UUID REFERENCES journal_entries(id);

ALTER TABLE ai_findings
  ADD COLUMN IF NOT EXISTS dismiss_reason TEXT;

ALTER TABLE ai_findings
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- Widen the status CHECK to admit RESOLVED (approve -> draft posted -> resolved).
ALTER TABLE ai_findings DROP CONSTRAINT IF EXISTS ai_findings_status_check;
ALTER TABLE ai_findings ADD CONSTRAINT ai_findings_status_check
  CHECK (status IN ('OPEN','ACKNOWLEDGED','DISMISSED','RESOLVED'));

-- ===========================================================================
-- 2. ai_finding_suppressions: dismissal is durable so the next sweep does not
--    re-raise the same issue. Suppressions expire (30 days by default) so a
--    genuinely recurring problem can surface again later.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS ai_finding_suppressions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL DEFAULT COALESCE(public.current_company_id(), '11111111-1111-1111-1111-111111111111'::uuid)
                   REFERENCES companies(id) ON DELETE CASCADE,
  finding_type     VARCHAR(50) NOT NULL,
  entity_type      VARCHAR(50),
  entity_id        UUID,
  dismissed_by     UUID REFERENCES users(id),
  reason           TEXT,
  suppressed_until TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_finding_suppressions_lookup
  ON ai_finding_suppressions (company_id, finding_type, entity_type, entity_id);

INSERT INTO company_scoped_tables (table_name)
VALUES ('ai_finding_suppressions')
ON CONFLICT (table_name) DO NOTHING;

-- ===========================================================================
-- 3. Vendor bank / tax detail on suppliers and employees, for the Task 20
--    "vendor shares bank account/tax id/address with an employee" detector.
-- ===========================================================================
ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS bank_account_number VARCHAR(100),
  ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100),
  ADD COLUMN IF NOT EXISTS tax_id VARCHAR(50);

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS bank_account_number VARCHAR(100),
  ADD COLUMN IF NOT EXISTS tax_id VARCHAR(50),
  ADD COLUMN IF NOT EXISTS address TEXT;

-- ===========================================================================
-- 4. supplier_bank_detail_changes: who changed which bank field, when. The
--    highest-value fraud detector is "bank detail changed shortly before a
--    payment" — this table is what makes that answerable.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS supplier_bank_detail_changes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL DEFAULT COALESCE(public.current_company_id(), '11111111-1111-1111-1111-111111111111'::uuid)
              REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  changed_by  UUID REFERENCES users(id),
  field_name  VARCHAR(50) NOT NULL,   -- e.g. bank_account_number, bank_name
  old_value   TEXT,
  new_value   TEXT
);

CREATE INDEX IF NOT EXISTS idx_supplier_bank_changes_supplier
  ON supplier_bank_detail_changes (supplier_id, changed_at DESC);

INSERT INTO company_scoped_tables (table_name)
VALUES ('supplier_bank_detail_changes')
ON CONFLICT (table_name) DO NOTHING;

-- ===========================================================================
-- 5. Cash forecast inputs that do not exist yet: loan schedules and tax
--    payment schedules (Task 21-A3).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS loan_schedules (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID NOT NULL DEFAULT COALESCE(public.current_company_id(), '11111111-1111-1111-1111-111111111111'::uuid)
                     REFERENCES companies(id) ON DELETE CASCADE,
  loan_name          VARCHAR(200) NOT NULL,
  lender             VARCHAR(200),
  next_payment_date  DATE NOT NULL,
  payment_amount     DECIMAL(15,2) NOT NULL CHECK (payment_amount > 0),
  frequency          VARCHAR(20) NOT NULL DEFAULT 'MONTHLY'
                     CHECK (frequency IN ('WEEKLY','BIWEEKLY','MONTHLY','QUARTERLY')),
  remaining_payments INTEGER,
  status             VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
                     CHECK (status IN ('ACTIVE','PAID_OFF','CANCELLED')),
  notes              TEXT,
  created_by         UUID REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_loan_schedules_due
  ON loan_schedules (next_payment_date) WHERE status = 'ACTIVE' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS tax_payment_schedules (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID NOT NULL DEFAULT COALESCE(public.current_company_id(), '11111111-1111-1111-1111-111111111111'::uuid)
               REFERENCES companies(id) ON DELETE CASCADE,
  tax_type     VARCHAR(100) NOT NULL,   -- e.g. VAT, PAYE, CORPORATE_INCOME_TAX
  next_due_date DATE NOT NULL,
  amount       DECIMAL(15,2) NOT NULL CHECK (amount > 0),
  frequency    VARCHAR(20) NOT NULL DEFAULT 'MONTHLY'
               CHECK (frequency IN ('MONTHLY','QUARTERLY','ANNUALLY')),
  status       VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
               CHECK (status IN ('ACTIVE','PAID','CANCELLED')),
  notes        TEXT,
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tax_payment_schedules_due
  ON tax_payment_schedules (next_due_date) WHERE status = 'ACTIVE' AND deleted_at IS NULL;

INSERT INTO company_scoped_tables (table_name)
VALUES ('loan_schedules'), ('tax_payment_schedules')
ON CONFLICT (table_name) DO NOTHING;

-- ===========================================================================
-- 6. Suspense account for AI-proposed correcting entries. The draft correcting
--    JE for a sub-ledger break moves the control account toward the sub-ledger
--    with the opposite leg on a suspense account, so the books balance and a
--    human reviews the entry before it is posted (Task 19: propose, don't post).
-- ===========================================================================
INSERT INTO chart_of_accounts
  (account_code, account_name, account_type, account_subtype, account_level,
   is_header, normal_balance, status, created_by, allow_manual_posting, balance_sheet_section)
SELECT '2126', 'AI Reconciliation Suspense', 'LIABILITY', 'CURRENT_LIABILITY', 3,
       false, 'CREDIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'CURRENT_LIABILITIES'
WHERE NOT EXISTS (
  SELECT 1 FROM chart_of_accounts
   WHERE account_code = '2126'
     AND company_id = COALESCE(public.current_company_id(), (SELECT id FROM companies WHERE is_default = true))
);

INSERT INTO company_gl_mappings (company_id, purpose, account_code)
SELECT id, 'RECON_SUSPENSE', '2126'
  FROM companies
 WHERE is_default = true
   AND NOT EXISTS (SELECT 1 FROM company_gl_mappings WHERE purpose = 'RECON_SUSPENSE');
