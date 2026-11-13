// The guard: a new table cannot quietly skip the tenant boundary.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// The tenancy work is only correct as of today. The failure mode from here is
// not that something breaks — it is that four parallel workstreams add tables
// for five months without company_id, nothing fails, and the gap is discovered
// when a second tenant is onboarded and their data appears in someone else's
// reports.
//
// That is exactly how the boundary got to 90% built and stuck there: migrations
// 110 through 141 each added tables, some scoped and some not, and nothing
// anywhere objected.
//
// So every base table must be one of two things, deliberately:
//
//   • scoped — it carries company_id, NOT NULL, defaulting from the session
//   • exempt — it is named in EXEMPT below, WITH A REASON
//
// A new table that is neither fails this test. The fix is one line in either
// direction, and the point is that it has to be a decision someone writes down
// rather than an omission nobody notices.
//
// Run on its own:  node --test tests/tenancyGuard.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { pool } = require('../config/database');

let dbAvailable = false;

before(async () => {
  try {
    await pool.query('SELECT 1');
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// Tables that legitimately carry no company_id, and why.
//
// Three valid reasons, and only three:
//
//   CHILD     — reaches its company through a parent row. A separate column on
//               the child is a column that can disagree with its header, and
//               there is no meaningful reading of "this invoice line belongs to
//               a different company than the invoice".
//   GLOBAL    — reference data shared by every tenant (currencies, FX rates).
//   PLATFORM  — infrastructure that sits outside or above tenancy.
//
// "I forgot" is not on the list. If a table is here it should be obvious from
// its name which reason applies; where it is not, it is spelled out.
// ---------------------------------------------------------------------------
const EXEMPT = {
  // ---- GLOBAL: the application platform's design layer ---------------------
  //
  // An application DEFINITION belongs to no company. It is a design, installable
  // by any number of them, and the whole point of the split is that the design
  // and the data have different owners: `app_company_instances` and
  // `app_instance_tables` — and every generated table they name — ARE
  // company-scoped and carry the standard policy.
  //
  // Visibility of a private design is enforced above the database, in
  // services/platform/registry.js (`listForCompany` and `assertVisible`): a
  // company sees one only if it authored it or holds an instance of it. Adding
  // company_id here would be the wrong answer to the right question — it would
  // mean copying the design per company, which is the shared-table problem
  // wearing different clothes.
  applications: 'GLOBAL — an application design belongs to no company; its data lives in app_company_instances',
  application_versions: 'GLOBAL — CHILD of applications, which is itself global',

  // ---- CHILD: line items and detail rows -----------------------------------
  bom_components: 'CHILD of bills_of_material',
  bom_operations: 'CHILD of bills_of_material',
  budget_lines: 'CHILD of budgets',
  contract_items: 'CHILD of contracts',
  customer_invoice_items: 'CHILD of customer_invoices',
  customer_payment_allocations: 'CHILD of customer_payments',
  dashboard_widgets: 'CHILD of dashboards',
  delivery_items: 'CHILD of delivery_schedules',
  delivery_route_stops: 'CHILD of delivery_routes',
  delivery_exceptions: 'CHILD of delivery_schedules',
  journal_entry_items: 'CHILD of journal_entries',
  payroll_items: 'CHILD of payroll_runs',
  project_tasks: 'CHILD of projects',
  purchase_order_line_items: 'CHILD of purchase_orders',
  rfq_line_items: 'CHILD of request_for_quotations',
  rfq_quotations: 'CHILD of request_for_quotations',
  rfq_suppliers: 'CHILD of request_for_quotations',
  sales_contract_items: 'CHILD of sales_contracts',
  sales_contract_renewals: 'CHILD of sales_contracts',
  sales_contract_usage: 'CHILD of sales_contracts',
  sales_credit_note_items: 'CHILD of sales_credit_notes',
  sales_order_items: 'CHILD of sales_orders',
  sales_quotation_items: 'CHILD of sales_quotations',
  sales_rfq_items: 'CHILD of sales_rfqs',
  sales_rfq_item_responses: 'CHILD of sales_rfq_items',
  sales_rfq_communications: 'CHILD of sales_rfqs',
  sales_rfq_supplier_responses: 'CHILD of sales_rfqs',
  stocktake_sheet_items: 'CHILD of stocktake_sheets',
  supplier_debit_note_items: 'CHILD of supplier_debit_notes',
  supplier_invoice_items: 'CHILD of supplier_invoices',
  supplier_payment_allocations: 'CHILD of supplier_payments',
  warehouse_transaction_items: 'CHILD of warehouse_transactions',
  work_order_components: 'CHILD of work_orders',
  work_order_operations: 'CHILD of work_orders',
  work_order_time_entries: 'CHILD of work_order_operations',
  cost_layers: 'CHILD of inventory_items',
  inventory_storage_mappings: 'CHILD of inventory_items',
  fixed_asset_depreciation: 'CHILD of fixed_assets',
  fixed_asset_revaluations: 'CHILD of fixed_assets',
  conversation_messages: 'CHILD of conversations',
  agent_run_actions: 'CHILD of agent_runs',
  agent_run_messages: 'CHILD of agent_runs',
  agent_blueprint_versions: 'CHILD of agent_blueprints',
  approval_chain_steps: 'CHILD of approval_chain_templates',
  approval_request_steps: 'CHILD of approval_requests',
  pdf_template_versions: 'CHILD of pdf_templates',
  report_runs: 'CHILD of report_definitions',
  webhook_delivery_log: 'CHILD of webhook_subscriptions',
  landed_cost_items: 'CHILD of landed_cost_vouchers',
  packing_lists: 'CHILD of shipments',
  price_list_items: 'CHILD of price_lists',
  project_assignments: 'CHILD of projects',
  project_milestones: 'CHILD of projects',
  conversation_attachments: 'CHILD of conversations',
  serial_lot_units: 'CHILD of inventory_items',
  serial_lot_movements: 'CHILD of serial_lot_units, itself a CHILD of inventory_items',
  deal_stage_history: 'CHILD of deals',
  password_reset_tokens: 'CHILD of users',
  email_verification_tokens: 'CHILD of users',


  // ---- CHILD: audit and status-history trails ------------------------------
  chart_of_accounts_status_history: 'CHILD of chart_of_accounts',
  customer_audit_log: 'CHILD of customers',
  customer_invoice_status_history: 'CHILD of customer_invoices',
  customer_payment_status_history: 'CHILD of customer_payments',
  delivery_status_history: 'CHILD of delivery_schedules',
  journal_entry_status_history: 'CHILD of journal_entries',
  sales_contract_status_history: 'CHILD of sales_contracts',
  sales_order_status_history: 'CHILD of sales_orders',
  sales_quotation_status_history: 'CHILD of sales_quotations',
  sales_rfq_status_history: 'CHILD of sales_rfqs',
  supplier_invoice_status_history: 'CHILD of supplier_invoices',
  supplier_payment_status_history: 'CHILD of supplier_payments',
  warehouse_transaction_audit_log: 'CHILD of warehouse_transactions',
  budget_status_history: 'CHILD of budgets',
  contract_status_history: 'CHILD of contracts',
  credit_note_status_history: 'CHILD of sales_credit_notes',
  fixed_asset_status_history: 'CHILD of fixed_assets',
  payroll_run_status_history: 'CHILD of payroll_runs',
  purchase_order_status_history: 'CHILD of purchase_orders',
  purchase_requisition_status_history: 'CHILD of purchase_requisitions',
  warehouse_transaction_status_history: 'CHILD of warehouse_transactions',
  work_order_status_history: 'CHILD of work_orders',

  // ---- GLOBAL: shared reference data ---------------------------------------
  currencies: 'GLOBAL — ISO currency list, identical for every tenant',
  exchange_rates: 'GLOBAL — market rates are not tenant-specific',
  business_types: 'GLOBAL — the fixed catalogue of business-type presets, identical for every tenant',
  modules: 'GLOBAL — the fixed registry of toggleable feature areas, identical for every tenant',
  business_type_default_modules: 'GLOBAL — join of business_types and modules, identical for every tenant',
  plans: 'GLOBAL — the fixed catalogue of pricing plans, identical for every tenant',
  tax_jurisdictions: 'GLOBAL — country/region tax jurisdictions, identical for every tenant',
  tax_codes: 'GLOBAL — VAT/GST/sales-tax/WHT rates by jurisdiction, identical for every tenant',

  // ---- PLATFORM: outside or above tenancy ----------------------------------
  companies: 'PLATFORM — the tenant registry itself',
  user_companies: 'PLATFORM — maps users to tenants; its company_id is the grant, not the owner',
  users: 'PLATFORM — a user may belong to several tenants, via user_companies',
  company_scoped_tables: 'PLATFORM — the register of what is scoped',
  company_isolation_config: 'PLATFORM — records which role isolation protects',
  schema_migrations: 'PLATFORM — migration bookkeeping',
  intercompany_transactions: 'PLATFORM — spans two companies by definition (from/to columns)',
  connector_oauth_pending: 'PLATFORM — short-lived pre-auth state, keyed by single-use nonce',
  mcp_oauth_pending: 'PLATFORM — short-lived pre-auth state, keyed by single-use nonce',
  // Schema changes apply to the whole database, not to one tenant's rows, so
  // there is no company this belongs to. Scoping it would also be the wrong
  // shape: a DDL record attributed to whichever tenant happened to be in
  // session when a migration ran would be actively misleading.
  audit_ddl_log: 'PLATFORM — DDL applies database-wide, not per tenant',
  system_secrets: 'PLATFORM — deployment-wide secrets (the platform owner\'s AI provider key), see migration 202610100100',
  // mailboxes is deliberately not row-level isolated (202608280901): the
  // inbound webhook resolves an address before any company context exists.
  // Its boundary is the explicit company_id filter in mailboxService.js and
  // routes/mailboxes.js; redirects reach a company only through that row.
  mailbox_redirects: 'PLATFORM — inbound address map consulted before company context exists; resolves to a mailbox (202609010100)',
  app_marketplace_listings: 'GLOBAL — the marketplace is shared across tenants by design; publisher_company_id names the publisher (202609050400)',
};

test('every table is either company-scoped or explicitly exempt', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const { rows } = await pool.query(`
    SELECT t.table_name,
           EXISTS (SELECT 1 FROM information_schema.columns c
                    WHERE c.table_name = t.table_name AND c.table_schema = 'public'
                      AND c.column_name = 'company_id') AS scoped
      FROM information_schema.tables t
     WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
     ORDER BY t.table_name`);

  const undeclared = rows
    .filter((r) => !r.scoped && !EXEMPT[r.table_name])
    .map((r) => r.table_name);

  assert.deepEqual(undeclared, [],
    'These tables carry no company_id and are not declared exempt. Under multi-tenancy every '
    + 'row in them is visible to every tenant. Either add company_id (see migration 140 for the '
    + 'pattern), or add the table to EXEMPT in this file with the reason it does not need one.');
});

test('the exempt list has no stale entries', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  // An exemption for a table that has since been scoped, renamed or dropped is
  // a comment that has stopped being true — and the next person reads it as a
  // decision someone made rather than as debris.
  const { rows } = await pool.query(`
    SELECT t.table_name,
           EXISTS (SELECT 1 FROM information_schema.columns c
                    WHERE c.table_name = t.table_name AND c.table_schema = 'public'
                      AND c.column_name = 'company_id') AS scoped
      FROM information_schema.tables t
     WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'`);

  const actual = new Map(rows.map((r) => [r.table_name, r.scoped]));
  const stale = [];

  for (const table of Object.keys(EXEMPT)) {
    if (!actual.has(table)) {
      stale.push(`${table} (no longer exists)`);
    } else if (actual.get(table) && table !== 'user_companies') {
      // user_companies is scoped AND exempt, deliberately: it has a company_id
      // whose meaning is "the company being granted", not "the owner".
      stale.push(`${table} (is now scoped — remove the exemption)`);
    }
  }

  assert.deepEqual(stale, [], 'stale entries in the EXEMPT list');
});

test('every exemption gives a recognised reason', () => {
  // Free-text reasons drift into "TODO" and "not sure". Three prefixes, checked.
  const bad = Object.entries(EXEMPT)
    .filter(([, reason]) => !/^(CHILD|GLOBAL|PLATFORM)\b/.test(reason))
    .map(([table, reason]) => `${table}: ${reason}`);

  assert.deepEqual(bad, [],
    'an exemption must start with CHILD, GLOBAL or PLATFORM and say what it is a child of / why it is shared');
});

test('a CHILD exemption names a parent that is itself scoped', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  // The whole argument for exempting a child is that it inherits its company
  // from its parent. If the parent is unscoped too, the chain reaches nothing
  // and both tables are simply unprotected.
  const { rows } = await pool.query(`
    SELECT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
     WHERE c.table_schema = 'public' AND c.column_name = 'company_id'
       AND tb.table_type = 'BASE TABLE'`);
  const scoped = new Set(rows.map((r) => r.table_name));

  const broken = [];
  for (const [table, reason] of Object.entries(EXEMPT)) {
    const match = reason.match(/^CHILD of (\w+)/);
    if (!match) continue;
    const parent = match[1];
    if (!scoped.has(parent) && !EXEMPT[parent]) {
      broken.push(`${table} → ${parent} (parent is neither scoped nor exempt)`);
    }
  }

  assert.deepEqual(broken, [], 'these child tables inherit from a parent that is not itself scoped');
});
