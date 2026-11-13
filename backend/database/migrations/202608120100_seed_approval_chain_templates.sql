-- 202608120100 — Seed the approval chain templates the authority engine reads.
--
-- Migration 099 built the amount-banded approval engine and created its tables.
-- It never seeded a single template, and nothing since has either. That was
-- harmless for as long as nothing consulted the engine.
--
-- It stopped being harmless when `requires_approval` became server-derived
-- (models/JournalEntry.js). That code resolves a JOURNAL_ENTRY template, finds
-- none, and — correctly, deliberately — fails closed: every journal entry is
-- created PENDING_APPROVAL. With no template there is also no chain to approve
-- it through, so nothing can ever reach POSTED. An empty templates table
-- therefore does not mean "no approvals configured"; it means the general
-- ledger is frozen.
--
-- ===========================================================================
-- PER COMPANY, NOT ONCE
-- ===========================================================================
-- `approval_chain_templates` is company-scoped (migration 110). Seeding it
-- without naming a company inserts one set of rows carrying the column DEFAULT
-- — the default company — and every OTHER tenant is left with none, which for
-- this table means their ledger is frozen while the default company's works.
-- The first cut of this migration did exactly that: 1 company seeded, 82 not.
--
-- So the loop below is over companies, with company_id set explicitly. Explicit
-- rather than via set_config because migrations run on the owner connection
-- (see scripts/db-migrate.js), which bypasses RLS — meaning the policy would
-- not have caught the omission either.
--
-- The bands are DEFAULTS, not a policy. They exist so the system has a coherent
-- starting state instead of an unusable one. Tune them per company — the
-- amounts a business actually wants are a finance decision, not a schema one.
--
-- How to read a band: a step applies once the document amount reaches its
-- `min_amount`. A document below the lowest band needs no approval at all,
-- which is what keeps day-to-day work moving. See migration 099's header for
-- the worked escalation example.
--
-- Idempotent. Templates are matched on (company_id, document_type), steps on
-- (template_id, step_number), so re-running adds nothing and a company created
-- later can be seeded by re-applying.

DO $$
DECLARE
  co         RECORD;
  band       RECORD;
  tpl_id     UUID;
  seed_user  UUID;

  -- document_type -> template name
  doc_types CONSTANT TEXT[][] := ARRAY[
    ['JOURNAL_ENTRY',    'Journal Entry Approval'],
    ['PURCHASE_ORDER',   'Purchase Order Approval'],
    ['SALES_ORDER',      'Sales Order Approval'],
    ['SUPPLIER_INVOICE', 'Supplier Invoice Approval'],
    ['CUSTOMER_PAYMENT', 'Customer Payment Approval'],
    ['SUPPLIER_PAYMENT', 'Supplier Payment Approval'],
    ['CREDIT_NOTE',      'Credit Note Approval'],
    ['PAYROLL_RUN',      'Payroll Run Approval']
  ];
BEGIN
  -- Attribution only; the column is nullable and nothing depends on it.
  SELECT id INTO seed_user FROM users ORDER BY created_at LIMIT 1;

  FOR co IN SELECT id FROM companies WHERE deleted_at IS NULL LOOP

    FOR i IN 1..array_length(doc_types, 1) LOOP
      INSERT INTO approval_chain_templates (name, document_type, is_active, created_by, company_id)
      SELECT doc_types[i][2], doc_types[i][1], true, seed_user, co.id
       WHERE NOT EXISTS (
         SELECT 1 FROM approval_chain_templates
          WHERE document_type = doc_types[i][1] AND company_id = co.id
       );
    END LOOP;

    -- Steps, per document type.
    --
    -- Money leaving the company (payments, credit notes) and anything touching
    -- the ledger escalates to a finance role first, then ADMIN. What the
    -- company buys and sells escalates through MANAGER instead — the same
    -- separation the permission matrix in middleware/rbac.js draws, where
    -- finance authority and commercial authority are deliberately distinct.
    --
    -- PAYROLL_RUN starts at 0: a payroll run always requires approval whatever
    -- its size, because "small enough not to matter" is not a meaningful
    -- category for payroll.
    FOR band IN
      SELECT * FROM (VALUES
        ('JOURNAL_ENTRY',    1, 1000::DECIMAL,   'FINANCE_MANAGER'),
        ('JOURNAL_ENTRY',    2, 25000::DECIMAL,  'ADMIN'),

        ('PURCHASE_ORDER',   1, 1000::DECIMAL,   'MANAGER'),
        ('PURCHASE_ORDER',   2, 25000::DECIMAL,  'ADMIN'),

        ('SALES_ORDER',      1, 5000::DECIMAL,   'MANAGER'),
        ('SALES_ORDER',      2, 50000::DECIMAL,  'ADMIN'),

        ('SUPPLIER_INVOICE', 1, 1000::DECIMAL,   'FINANCE_MANAGER'),
        ('SUPPLIER_INVOICE', 2, 25000::DECIMAL,  'ADMIN'),

        ('CUSTOMER_PAYMENT', 1, 5000::DECIMAL,   'FINANCE_MANAGER'),
        ('CUSTOMER_PAYMENT', 2, 50000::DECIMAL,  'ADMIN'),

        ('SUPPLIER_PAYMENT', 1, 5000::DECIMAL,   'FINANCE_MANAGER'),
        ('SUPPLIER_PAYMENT', 2, 50000::DECIMAL,  'ADMIN'),

        ('CREDIT_NOTE',      1, 500::DECIMAL,    'FINANCE_MANAGER'),
        ('CREDIT_NOTE',      2, 10000::DECIMAL,  'ADMIN'),

        ('PAYROLL_RUN',      1, 0::DECIMAL,      'FINANCE_MANAGER'),
        ('PAYROLL_RUN',      2, 100000::DECIMAL, 'ADMIN')
      ) AS v(document_type, step_number, min_amount, approver_role)
    LOOP
      SELECT id INTO tpl_id
        FROM approval_chain_templates
       WHERE document_type = band.document_type AND company_id = co.id
       LIMIT 1;

      CONTINUE WHEN tpl_id IS NULL;

      INSERT INTO approval_chain_steps (template_id, step_number, min_amount, approver_role)
      SELECT tpl_id, band.step_number, band.min_amount, band.approver_role
       WHERE NOT EXISTS (
         SELECT 1 FROM approval_chain_steps
          WHERE template_id = tpl_id AND step_number = band.step_number
       );
    END LOOP;

  END LOOP;
END $$;

COMMENT ON TABLE approval_chain_templates IS
  'Amount-banded approval chains per document type, per company. Seeded with defaults by migration 202608120100 — an EMPTY set for a company freezes that company''s general ledger, because server-derived requires_approval fails closed when no template resolves.';
