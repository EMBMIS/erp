-- routes/contract-items.js was built against a `contract_items` schema that
-- was never actually migrated. The table as created has only id, contract_id,
-- item_id, unit_price, currency, lead_time_days, moq, created_at, updated_at
-- (confirmed live via information_schema.columns) -- but every handler in
-- this route file references a `status` column (even the plain GET / list
-- endpoint filters `ci.status = $2`), so every single endpoint in the file,
-- not just writes, has been throwing "column ... does not exist" on every
-- call. Found via a schema sweep comparing every INSERT/UPDATE in
-- routes/models/services against real table columns -- the same bug class as
-- 202608050200_contracts_missing_columns.sql, on a second table.
--
-- The practical impact is worse than it looks: ContractCreate.jsx (the only
-- real caller, confirmed by grep) calls POST /contract-items/bulk right after
-- creating a contract, to attach its line items. That endpoint's per-item
-- INSERT was wrapped in a try/catch that pushes failures into an `errors`
-- array and still returns HTTP 200 -- so every contract created through the
-- UI has silently ended up with zero line items, with no visible error to
-- the user. The 200-with-swallowed-errors response shape is a separate,
-- disclosed issue this migration does not change; fixing the schema is what
-- makes the inserts actually succeed.
--
-- Columns below come from every INSERT/UPDATE/SELECT in
-- routes/contract-items.js: quantity/status/delivery_schedule/specifications
-- (POST /, PUT /:id), amendment_reason/amendment_requested_by/
-- amendment_requested_at (POST /, POST /decline/:id), created_by (POST /,
-- POST /bulk), and company_approved_by/company_approved_at/
-- supplier_approved_by/supplier_approved_at (POST /approve/:id).
--
-- All additions are nullable/defaulted so this is safe to run against a
-- database that already has any of these columns from an untracked ad-hoc
-- change (IF NOT EXISTS throughout).

ALTER TABLE contract_items ADD COLUMN IF NOT EXISTS quantity NUMERIC(14,4);
ALTER TABLE contract_items ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'ACTIVE';
ALTER TABLE contract_items ADD COLUMN IF NOT EXISTS delivery_schedule TEXT;
ALTER TABLE contract_items ADD COLUMN IF NOT EXISTS specifications TEXT;
ALTER TABLE contract_items ADD COLUMN IF NOT EXISTS amendment_reason TEXT;
ALTER TABLE contract_items ADD COLUMN IF NOT EXISTS amendment_requested_by UUID REFERENCES users(id);
ALTER TABLE contract_items ADD COLUMN IF NOT EXISTS amendment_requested_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE contract_items ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);
ALTER TABLE contract_items ADD COLUMN IF NOT EXISTS company_approved_by UUID REFERENCES users(id);
ALTER TABLE contract_items ADD COLUMN IF NOT EXISTS company_approved_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE contract_items ADD COLUMN IF NOT EXISTS supplier_approved_by UUID REFERENCES users(id);
ALTER TABLE contract_items ADD COLUMN IF NOT EXISTS supplier_approved_at TIMESTAMP WITH TIME ZONE;

-- Backfill status for any pre-existing rows inserted before this column
-- existed, so old contract items don't silently vanish from status-filtered
-- list views (every GET endpoint in this file defaults to status='ACTIVE').
UPDATE contract_items SET status = 'ACTIVE' WHERE status IS NULL;
