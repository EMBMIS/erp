-- routes/contracts.js POST / builds an INSERT statement that has referenced
-- title, contract_value, description, terms, document_url,
-- digital_contract_required, and the contract_file_* upload columns since at
-- least the file-upload feature was added -- but no migration ever created
-- any of them on the `contracts` table (created in 018_create_procurement_tables.sql
-- with only contract_number/contract_name/supplier_id/contract_type/dates/
-- payment_terms/incoterms/currency/status/supplier_instructions). The result:
-- POST /contracts has been unconditionally throwing "column ... does not
-- exist" on every single call -- a contract could never be created through
-- the UI. Confirmed live: a real POST with a real supplier_id 500'd with
-- "Failed to create contract" before this migration.
--
-- The same missing `contract_value` column is also why GET /contracts/stats
-- (handled inline in the `/:id` route via `if (req.params.id === 'stats')`,
-- since no dedicated /stats route was ever registered) 500'd on every call --
-- its SUM(contract_value) hit the same missing column. That handler's logic
-- is otherwise correct and needs no code change, only this schema fix.
--
-- ContractView.jsx separately reads sla_requirements, renewal_terms,
-- termination_clause, compliance_requirements, risk_assessment, and notes --
-- none of which ever existed either, so a contract's detail page has always
-- rendered blank for all six of those fields. Adding them here too since
-- they're the same class of gap on the same table.
--
-- All additions are nullable/defaulted so this is safe to run against a
-- database that already has any of these columns from an untracked ad-hoc
-- change (IF NOT EXISTS throughout).

ALTER TABLE contracts ADD COLUMN IF NOT EXISTS title VARCHAR(255);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS contract_value NUMERIC(14,2);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS terms TEXT;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS document_url TEXT;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS digital_contract_required BOOLEAN DEFAULT FALSE;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS contract_file_path TEXT;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS contract_file_name VARCHAR(255);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS contract_file_size INTEGER;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS contract_file_type VARCHAR(100);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS uploaded_by UUID REFERENCES users(id);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS sla_requirements TEXT;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS renewal_terms TEXT;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS termination_clause TEXT;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS compliance_requirements TEXT;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS risk_assessment TEXT;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS notes TEXT;

-- Backfill title from the existing NOT NULL contract_name for any
-- pre-existing rows, so old contracts don't show a blank title.
UPDATE contracts SET title = contract_name WHERE title IS NULL;
