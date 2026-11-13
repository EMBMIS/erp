-- Nearly every document-numbering and business-code column in this schema
-- was given a GLOBAL unique constraint instead of one scoped to
-- (company_id, code) — the same bug as journal_number, fixed in
-- 202608090100, but systemic: PO numbers, invoice numbers, customer/supplier/
-- item codes, and ~35 others. Two different companies on this platform
-- could not both use "PO-2026-000001", "CUST001", or account code "1000" —
-- exactly the conventional codes any real business would pick — and the
-- second company to do so would get a raw 23505 duplicate-key error instead
-- of a working signup. Found via a systematic scan for RLS-forced tables
-- (company-scoped) whose only unique constraint excludes company_id.
--
-- Excluded from this fix, deliberately:
--   api_keys.key_hash, purchase_orders.supplier_delivery_token,
--   rfqs.response_token, sales_quotations.customer_response_token —
--   cryptographic/security tokens, correctly globally unique regardless of
--   company (collision would mean the same secret material was generated
--   twice, not a business-code clash).
--   bills_of_material.item_id, employees.user_id — reference already
--   globally-unique UUID ids (items.id, users.id respectively), so per-row
--   uniqueness already implies per-company uniqueness; no fix needed.
--   employees.user_id specifically also encodes a product decision (can one
--   user be a distinct employee of two companies?) this migration does not
--   make.
--
-- Idempotent: every DROP is IF EXISTS, every CREATE is IF NOT EXISTS.

DO $$
DECLARE
  fixes CONSTANT text[][] := ARRAY[
    ['chart_of_accounts', 'chart_of_accounts_account_code_key', 'account_code'],
    ['bills_of_material', 'bills_of_material_bom_number_key', 'bom_number'],
    ['bins', 'bins_code_key', 'code'],
    ['contracts', 'contracts_contract_number_key', 'contract_number'],
    ['cost_centers', 'cost_centers_code_key', 'code'],
    ['customer_invoices', 'customer_invoices_invoice_number_key', 'invoice_number'],
    ['customer_payments', 'customer_payments_payment_number_key', 'payment_number'],
    ['customers', 'customers_customer_code_key', 'customer_code'],
    ['deals', 'deals_deal_number_key', 'deal_number'],
    ['delivery_routes', 'delivery_routes_route_number_key', 'route_number'],
    ['delivery_schedules', 'delivery_schedules_schedule_number_key', 'schedule_number'],
    ['employees', 'employees_employee_number_key', 'employee_number'],
    ['fixed_assets', 'fixed_assets_asset_number_key', 'asset_number'],
    ['inventory_transfers', 'inventory_transfers_transfer_number_key', 'transfer_number'],
    ['items', 'items_item_code_key', 'item_code'],
    ['landed_cost_vouchers', 'landed_cost_vouchers_voucher_number_key', 'voucher_number'],
    ['leads', 'leads_lead_number_key', 'lead_number'],
    ['payroll_runs', 'payroll_runs_run_number_key', 'run_number'],
    ['price_lists', 'price_lists_code_key', 'code'],
    ['projects', 'projects_project_code_key', 'project_code'],
    ['purchase_orders', 'purchase_orders_po_number_key', 'po_number'],
    ['purchase_requisitions', 'purchase_requisitions_pr_number_key', 'pr_number'],
    ['request_for_quotations', 'request_for_quotations_rfq_number_key', 'rfq_number'],
    ['sales_contracts', 'sales_contracts_contract_number_key', 'contract_number'],
    ['sales_credit_notes', 'sales_credit_notes_credit_note_number_key', 'credit_note_number'],
    ['sales_orders', 'sales_orders_so_number_key', 'so_number'],
    ['sales_quotations', 'sales_quotations_quotation_number_key', 'quotation_number'],
    ['sales_rfqs', 'sales_rfqs_rfq_number_key', 'rfq_number'],
    ['shipments', 'shipments_shipment_number_key', 'shipment_number'],
    ['stocktake_sheets', 'stocktake_sheets_sheet_number_key', 'sheet_number'],
    ['storage_locations', 'storage_locations_code_key', 'code'],
    ['supplier_debit_notes', 'supplier_debit_notes_debit_note_number_key', 'debit_note_number'],
    ['supplier_invoices', 'supplier_invoices_bill_number_key', 'bill_number'],
    ['supplier_payments', 'supplier_payments_payment_number_key', 'payment_number'],
    ['suppliers', 'suppliers_supplier_code_key', 'supplier_code'],
    ['warehouse_transactions', 'warehouse_transactions_transaction_number_key', 'transaction_number'],
    ['work_centers', 'work_centers_code_key', 'code'],
    ['work_orders', 'work_orders_wo_number_key', 'wo_number'],
    ['agent_blueprints', 'agent_blueprints_agent_key_key', 'agent_key'],
    ['mcp_oauth_grants', 'mcp_oauth_grants_connection_id_key', 'connection_id'],
    ['ai_credentials', 'ai_credentials_name_key', 'name']
  ];
  f text[];
  idx_name text;
BEGIN
  FOREACH f SLICE 1 IN ARRAY fixes LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', f[1], f[2]);
    idx_name := f[1] || '_company_' || f[3] || '_key';
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (company_id, %I)', idx_name, f[1], f[3]);
  END LOOP;
END $$;

-- ai_tool_settings.tool_name was the PRIMARY KEY itself (not just a unique
-- constraint), which is worse: only one company total could ever configure
-- the "web_search" tool. No table has a foreign key against it, so widening
-- the PK to (company_id, tool_name) is safe.
ALTER TABLE ai_tool_settings DROP CONSTRAINT IF EXISTS ai_tool_settings_pkey;
ALTER TABLE ai_tool_settings ADD CONSTRAINT ai_tool_settings_pkey PRIMARY KEY (company_id, tool_name);

-- journal_entries.posting_key: lower practical collision risk than the
-- others (callers key it off an already-global UUID, e.g.
-- IC_ELIM:REV:<tx.id>:<period> in services/intercompanyService.js), but the
-- same fix for consistency and defense-in-depth.
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS uq_journal_entries_posting_key;
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_company_posting_key
  ON journal_entries (company_id, posting_key) WHERE posting_key IS NOT NULL AND deleted_at IS NULL;
