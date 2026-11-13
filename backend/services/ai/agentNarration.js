/**
 * Agent narration — turning a tool stream into an investigation.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The agent loop already emits everything that happens: tool_call, tool_result,
 * step_end, awaiting_confirmation. What it emits is accurate and completely
 * unreadable — `get_ar_aging`, `detect_amount_anomalies`, `forecast_cash_flow`
 * are function names, and a product surface that shows function names is a
 * debug console.
 *
 * The obvious alternative is to have the model narrate itself: ask it for a
 * plan, print the plan. That is worse, because the plan is then a *claim* about
 * what happened rather than a record of it. A model that says "reviewing
 * receivables" and then calls no tool at all produces a UI that is confidently
 * wrong, and nothing in the system can tell.
 *
 * So the narration is derived, never generated. Every stage the user sees is a
 * classification of a tool call that actually executed, and every number beside
 * it is counted out of that tool's actual result. If Simeli did not call a tool,
 * no stage appears. If a tool returned nothing, the count is zero and says so.
 *
 * TWO THINGS ARE EXPORTED
 * ---------------------------------------------------------------------------
 *   meta(name)            what a tool is, in business terms:
 *                         { module, stage, verb, noun, kind }
 *   digest(name, result)  what a tool found, counted from its own return value:
 *                         { count, unit, headline, records[], figures[] }
 *
 * Both are best-effort and both degrade to something honest. An unknown tool
 * (user-authored, MCP, a connector) gets a neutral module and a verb built from
 * its own name rather than being hidden.
 */

// ---------------------------------------------------------------------------
// Stages. The loop the product presents, in order.
//
// These are not arbitrary labels: each one is reachable only from evidence.
// `investigate` needs a read tool to have run. `discover` needs a tool whose
// job is finding things. `propose` needs a draft to exist. `await_approval` is
// the agent's own pause. `execute` is a tool that ran after a human approved.
// ---------------------------------------------------------------------------
const STAGES = [
  { key: 'understand',     label: 'Understand',     hint: 'Reading the question against the ERP schema' },
  { key: 'investigate',    label: 'Investigate',    hint: 'Pulling the records that bear on it' },
  { key: 'reason',         label: 'Reason',         hint: 'Working out what the records mean' },
  { key: 'discover',       label: 'Discover',       hint: 'Naming what is actually driving it' },
  { key: 'propose',        label: 'Propose',        hint: 'Drafting something that would change it' },
  { key: 'simulate',       label: 'Simulate',       hint: 'Projecting the effect before committing' },
  { key: 'await_approval', label: 'Await approval', hint: 'Waiting for a person to decide' },
  { key: 'execute',        label: 'Execute',        hint: 'Carrying out what was approved' },
  { key: 'verify',         label: 'Verify',         hint: 'Checking the result landed' },
  { key: 'report',         label: 'Report',         hint: 'Writing up what happened' },
];

const STAGE_INDEX = Object.fromEntries(STAGES.map((s, i) => [s.key, i]));

// ---------------------------------------------------------------------------
// Tool metadata.
//
// `verb` is present-tense and specific, because it is shown while the tool is
// still running: "Reviewing receivables", not "Get AR aging". `noun` names what
// the tool returns and is what the activity tree counts ("38 invoices").
//
// `kind`:
//   read     pulls records                       → investigate
//   analyse  computes over records                → discover
//   project  forecasts or backtests               → simulate
//   draft    creates a DRAFT record               → propose
//   act      has an effect beyond a draft         → execute
//   build    extends the ERP itself               → propose
//   render   produces a chart or a document       → report
// ---------------------------------------------------------------------------
const TOOL_META = {
  // --- Finance: ledgers, receivables, payables -----------------------------
  get_trial_balance:            { module: 'Finance', area: 'General ledger', kind: 'read',    verb: 'Reading the trial balance',         noun: 'accounts' },
  get_ar_aging:                 { module: 'Finance', area: 'Receivables',    kind: 'read',    verb: 'Reviewing receivables',             noun: 'invoices' },
  get_ap_aging:                 { module: 'Finance', area: 'Payables',       kind: 'read',    verb: 'Checking supplier obligations',     noun: 'bills' },
  get_financial_summary:        { module: 'Finance', area: 'Reporting',      kind: 'read',    verb: 'Reading the financial summary',     noun: 'figures' },
  get_revenue_by_month:         { module: 'Finance', area: 'Revenue',        kind: 'read',    verb: 'Pulling revenue by month',          noun: 'months' },
  get_expense_by_supplier:      { module: 'Finance', area: 'Spend',          kind: 'read',    verb: 'Breaking spend down by supplier',   noun: 'suppliers' },
  get_gl_account_balance:       { module: 'Finance', area: 'General ledger', kind: 'read',    verb: 'Reading an account balance',        noun: 'entries' },
  get_period_status:            { module: 'Finance', area: 'Close',          kind: 'read',    verb: 'Checking the period status',        noun: 'periods' },
  list_recent_journal_entries:  { module: 'Finance', area: 'General ledger', kind: 'read',    verb: 'Reading recent journal entries',    noun: 'entries' },
  plan_supplier_payment_run:    { module: 'Finance', area: 'Payables',       kind: 'project', verb: 'Planning the supplier payment run', noun: 'bills' },
  preview_dunning_reminders:    { module: 'Finance', area: 'Collections',    kind: 'read',    verb: 'Previewing collection reminders',   noun: 'reminders' },
  preview_due_recurring_invoices:{ module: 'Finance', area: 'Billing',       kind: 'read',    verb: 'Previewing recurring invoices due', noun: 'invoices' },
  get_invoice_pdf_link:         { module: 'Finance', area: 'Billing',        kind: 'read',    verb: 'Locating the invoice document',     noun: 'documents' },
  suggest_gl_accounts:          { module: 'Finance', area: 'General ledger', kind: 'analyse', verb: 'Matching to GL accounts',           noun: 'suggestions' },
  suggest_journal_entry:        { module: 'Finance', area: 'General ledger', kind: 'analyse', verb: 'Composing a journal entry',         noun: 'lines' },
  suggest_bank_reconciliation_matches: { module: 'Finance', area: 'Banking', kind: 'analyse', verb: 'Matching bank lines to the ledger', noun: 'matches' },
  three_way_match_invoice:      { module: 'Finance', area: 'Payables',       kind: 'analyse', verb: 'Running the three-way match',       noun: 'exceptions' },
  get_invoice_match_exceptions: { module: 'Finance', area: 'Payables',       kind: 'analyse', verb: 'Listing match exceptions',          noun: 'exceptions' },
  detect_amount_anomalies:      { module: 'Finance', area: 'General ledger', kind: 'analyse', verb: 'Testing postings for outliers',     noun: 'anomalies' },
  forecast_profit_and_loss:     { module: 'Finance', area: 'Forecasting',    kind: 'project', verb: 'Projecting profit and loss',        noun: 'months' },
  forecast_cash_flow:           { module: 'Finance', area: 'Forecasting',    kind: 'project', verb: 'Projecting cash flow',              noun: 'periods' },
  backtest_profit_and_loss_forecast: { module: 'Finance', area: 'Forecasting', kind: 'project', verb: 'Backtesting the forecast method', noun: 'months' },
  auto_reconcile_bank_account:  { module: 'Finance', area: 'Banking',        kind: 'act',     verb: 'Reconciling the bank account',      noun: 'matches' },

  // --- Sales and CRM --------------------------------------------------------
  list_sales_orders:            { module: 'Sales', area: 'Orders',      kind: 'read', verb: 'Reading sales orders',       noun: 'orders' },
  search_customers:             { module: 'Sales', area: 'Customers',   kind: 'read', verb: 'Looking up customers',       noun: 'customers' },
  list_sales_contracts:         { module: 'Sales', area: 'Contracts',   kind: 'read', verb: 'Reading sales contracts',    noun: 'contracts' },
  list_sales_quotations:        { module: 'Sales', area: 'Quotations',  kind: 'read', verb: 'Reading quotations',         noun: 'quotations' },
  list_sales_rfqs:              { module: 'Sales', area: 'RFQs',        kind: 'read', verb: 'Reading RFQs',               noun: 'RFQs' },
  search_similar_sales_orders:  { module: 'Sales', area: 'Orders',      kind: 'analyse', verb: 'Finding comparable orders', noun: 'orders' },

  // --- Procurement ----------------------------------------------------------
  list_purchase_orders:            { module: 'Procurement', area: 'Purchase orders', kind: 'read',    verb: 'Reading purchase orders',        noun: 'orders' },
  search_similar_purchase_orders:  { module: 'Procurement', area: 'Purchase orders', kind: 'analyse', verb: 'Finding comparable orders',      noun: 'orders' },
  get_purchase_order_pdf_link:     { module: 'Procurement', area: 'Purchase orders', kind: 'read',    verb: 'Locating the order document',    noun: 'documents' },
  create_purchase_requisition_draft:{ module: 'Procurement', area: 'Requisitions',   kind: 'draft',   verb: 'Drafting a requisition',         noun: 'requisitions' },

  // --- Inventory and warehouse ---------------------------------------------
  list_low_stock_items:           { module: 'Inventory', area: 'Stock',     kind: 'read',    verb: 'Checking stock levels',           noun: 'items' },
  list_in_transit_transfers:      { module: 'Inventory', area: 'Transfers', kind: 'read',    verb: 'Reading transfers in transit',    noun: 'transfers' },
  search_similar_inventory_items: { module: 'Inventory', area: 'Items',     kind: 'analyse', verb: 'Finding comparable items',        noun: 'items' },
  predict_inventory_reorders:     { module: 'Inventory', area: 'Planning',  kind: 'project', verb: 'Projecting reorder points',       noun: 'items' },
  recommend_reorder_points:       { module: 'Inventory', area: 'Planning',  kind: 'project', verb: 'Recommending reorder points',     noun: 'items' },
  run_reorder_check:              { module: 'Inventory', area: 'Planning',  kind: 'act',     verb: 'Running the reorder check',       noun: 'items' },
  record_stocktake_count:         { module: 'Inventory', area: 'Stocktake', kind: 'act',     verb: 'Recording a stocktake count',     noun: 'counts' },

  // --- Manufacturing --------------------------------------------------------
  list_work_orders:          { module: 'Manufacturing', area: 'Work orders', kind: 'read',    verb: 'Reading work orders',        noun: 'work orders' },
  explode_bill_of_material:  { module: 'Manufacturing', area: 'BOM',         kind: 'analyse', verb: 'Exploding the bill of material', noun: 'components' },
  run_mrp:                   { module: 'Manufacturing', area: 'Planning',    kind: 'project', verb: 'Running material planning',  noun: 'requirements' },

  // --- HR -------------------------------------------------------------------
  list_employees:      { module: 'HR', area: 'People',  kind: 'read', verb: 'Reading the employee register', noun: 'employees' },
  get_payroll_summary: { module: 'HR', area: 'Payroll', kind: 'read', verb: 'Reading the payroll summary',   noun: 'periods' },

  // --- Assets and contracts -------------------------------------------------
  list_fixed_assets: { module: 'Finance', area: 'Fixed assets', kind: 'read', verb: 'Reading the asset register', noun: 'assets' },

  // --- Governance: findings, approvals, audit -------------------------------
  run_findings_scan:        { module: 'Governance', area: 'Findings',  kind: 'analyse', verb: 'Scanning for anomalies',        noun: 'findings' },
  list_open_findings:       { module: 'Governance', area: 'Findings',  kind: 'read',    verb: 'Reading open findings',         noun: 'findings' },
  find_duplicate_records:   { module: 'Governance', area: 'Findings',  kind: 'analyse', verb: 'Searching for duplicates',      noun: 'duplicates' },
  list_my_pending_approvals:{ module: 'Governance', area: 'Approvals', kind: 'read',    verb: 'Reading pending approvals',     noun: 'approvals' },
  get_audit_trail:          { module: 'Governance', area: 'Audit',     kind: 'read',    verb: 'Reading the audit trail',       noun: 'events' },
  analyze_audit_trail:      { module: 'Governance', area: 'Audit',     kind: 'analyse', verb: 'Analysing the audit trail',     noun: 'patterns' },
  list_my_notifications:    { module: 'Governance', area: 'Inbox',     kind: 'read',    verb: 'Reading notifications',         noun: 'notifications' },
  list_webhook_subscriptions:{ module: 'Platform', area: 'Integrations', kind: 'read',  verb: 'Reading webhook subscriptions', noun: 'subscriptions' },

  // --- Autonomous agents ----------------------------------------------------
  list_autonomous_agents: { module: 'Platform', area: 'Agents', kind: 'read',    verb: 'Reading configured agents',   noun: 'agents' },
  get_agent_activity:     { module: 'Platform', area: 'Agents', kind: 'read',    verb: 'Reading agent activity',      noun: 'runs' },
  list_agent_escalations: { module: 'Platform', area: 'Agents', kind: 'read',    verb: 'Reading agent escalations',   noun: 'escalations' },
  run_agent_dry_run:      { module: 'Platform', area: 'Agents', kind: 'project', verb: 'Dry-running an agent',        noun: 'steps' },

  // --- Data, charts, documents, search -------------------------------------
  query_erp_data:         { module: 'Data', area: 'Query',     kind: 'read',    verb: 'Querying the ERP',              noun: 'rows' },
  suggest_visualization:  { module: 'Data', area: 'Charts',    kind: 'analyse', verb: 'Choosing how to plot it',       noun: 'options' },
  generate_chart:         { module: 'Data', area: 'Charts',    kind: 'render',  verb: 'Drawing the chart',             noun: 'series' },
  search_documents:       { module: 'Data', area: 'Knowledge', kind: 'read',    verb: 'Searching documents',           noun: 'documents' },
  get_ai_usage_summary:   { module: 'Platform', area: 'Usage', kind: 'read',    verb: 'Reading AI usage',              noun: 'periods' },
  web_search:             { module: 'External', area: 'Web',   kind: 'read',    verb: 'Searching the web',             noun: 'results' },

  // --- CRM ------------------------------------------------------------------
  list_deals:           { module: 'CRM', area: 'Pipeline',   kind: 'read',    verb: 'Reading the pipeline',          noun: 'deals' },
  get_deal:             { module: 'CRM', area: 'Deals',      kind: 'read',    verb: 'Opening the deal',              noun: 'deals' },
  get_deal_history:     { module: 'CRM', area: 'Deals',      kind: 'read',    verb: 'Tracing how the deal moved',    noun: 'stage changes' },
  get_sales_pipeline:   { module: 'CRM', area: 'Pipeline',   kind: 'analyse', verb: 'Weighing the pipeline',         noun: 'stages' },
  search_contacts:      { module: 'CRM', area: 'Contacts',   kind: 'read',    verb: 'Looking up contacts',           noun: 'contacts' },
  list_crm_activities:  { module: 'CRM', area: 'Activities', kind: 'read',    verb: 'Reading follow-ups',            noun: 'activities' },
  create_crm_activity:  { module: 'CRM', area: 'Activities', kind: 'draft',   verb: 'Scheduling a follow-up',        noun: 'activities' },
  move_deal_stage:      { module: 'CRM', area: 'Deals',      kind: 'act',     verb: 'Moving the deal',               noun: 'deals' },

  // --- Projects -------------------------------------------------------------
  list_projects:             { module: 'Projects', area: 'Portfolio',    kind: 'read',    verb: 'Reading the portfolio',        noun: 'projects' },
  get_project:               { module: 'Projects', area: 'Projects',     kind: 'read',    verb: 'Opening the project',          noun: 'projects' },
  get_project_profitability: { module: 'Projects', area: 'Profitability',kind: 'analyse', verb: 'Working out what it earned',   noun: 'figures' },
  get_project_budget:        { module: 'Projects', area: 'Budget',       kind: 'analyse', verb: 'Checking it against budget',   noun: 'lines' },
  list_time_entries:         { module: 'Projects', area: 'Time',         kind: 'read',    verb: 'Reading logged time',          noun: 'entries' },
  preview_project_billing:   { module: 'Projects', area: 'Billing',      kind: 'project', verb: 'Previewing what would bill',   noun: 'entries' },
  get_project_milestones:    { module: 'Projects', area: 'Milestones',   kind: 'read',    verb: 'Reading milestones',           noun: 'milestones' },
  get_resource_load:         { module: 'Projects', area: 'Resourcing',   kind: 'analyse', verb: 'Checking who is committed',    noun: 'people' },
  create_project_task:       { module: 'Projects', area: 'Tasks',        kind: 'draft',   verb: 'Adding a task',                noun: 'tasks' },
  log_time_entry:            { module: 'Projects', area: 'Time',         kind: 'draft',   verb: 'Logging time',                 noun: 'entries' },

  // --- Operations reads that were missing -----------------------------------
  get_budget_vs_actual:     { module: 'Finance',     area: 'Budget',     kind: 'analyse', verb: 'Comparing against budget',   noun: 'lines' },
  list_delivery_schedules:  { module: 'Sales',       area: 'Deliveries', kind: 'read',    verb: 'Reading delivery schedules', noun: 'deliveries' },
  list_contracts:           { module: 'Sales',       area: 'Contracts',  kind: 'read',    verb: 'Reading contracts',          noun: 'contracts' },

  // --- Grounding ------------------------------------------------------------
  resolve_entity:     { module: 'Data',       area: 'Lookup', kind: 'read', verb: 'Finding the right record',     noun: 'matches' },
  describe_schema:    { module: 'Data',       area: 'Schema', kind: 'read', verb: 'Reading what the tables hold', noun: 'tables' },
  read_attachment:    { module: 'Data',       area: 'Attachments', kind: 'read', verb: 'Reading the attached file', noun: 'files' },
  list_writable_tables:{ module: 'Data',       area: 'Database',    kind: 'read', verb: 'Listing writable tables',        noun: 'tables' },
  write_database:     { module: 'Data',       area: 'Database',    kind: 'act',  verb: 'Writing a database record',      noun: 'records' },
  get_record_history: { module: 'Governance', area: 'Audit',  kind: 'read', verb: 'Reading what happened to it',  noun: 'events' },

  // --- Explaining change ----------------------------------------------------
  compare_periods:   { module: 'Finance', area: 'Variance', kind: 'analyse', verb: 'Decomposing the change',    noun: 'contributors' },
  explain_revenue:   { module: 'Sales',   area: 'Revenue',  kind: 'analyse', verb: 'Splitting the change in sales into customers', noun: 'customers' },
  prepare_revenue_follow_ups: { module: 'Sales', area: 'Revenue', kind: 'draft', verb: 'Putting the follow-up calls on their owners\' lists', noun: 'calls' },
  explain_spend:     { module: 'Procurement', area: 'Spend', kind: 'analyse', verb: 'Splitting the change in spending into suppliers', noun: 'suppliers' },
  prepare_spend_follow_ups: { module: 'Procurement', area: 'Spend', kind: 'draft', verb: 'Drafting the re-quotes and asking the owners', noun: 'follow-ups' },
  explain_margin:    { module: 'Finance', area: 'Margin',   kind: 'analyse', verb: 'Splitting the margin change into causes', noun: 'drivers' },
  get_cash_movement: { module: 'Finance', area: 'Cash',     kind: 'read',    verb: 'Measuring cash in and out', noun: 'periods' },
  explain_delivery_risk: { module: 'Sales', area: 'Deliveries', kind: 'analyse', verb: 'Tracing what holds up the delivery', noun: 'orders' },
  check_supplier_bill: { module: 'Finance', area: 'Payables', kind: 'analyse', verb: 'Checking the bill against the supplier\'s other bills, the order, the receipts and the payments', noun: 'bills' },
  hold_supplier_payment: { module: 'Finance', area: 'Payables', kind: 'act', verb: 'Holding payment on the bill', noun: 'bills' },
  release_supplier_payment_hold: { module: 'Finance', area: 'Payables', kind: 'act', verb: 'Releasing the payment hold', noun: 'bills' },
  check_delivery_promise: { module: 'Sales', area: 'Deliveries', kind: 'analyse', verb: 'Checking what is free on the day, what is short and who can bring it in time', noun: 'lines' },
  list_orders_landed_short: { module: 'Sales', area: 'Orders', kind: 'analyse', verb: 'Reading the orders that landed short, and checking each again', noun: 'orders' },
  draft_order_watch_purchase_order: { module: 'Procurement', area: 'Purchase orders', kind: 'draft', verb: 'Drafting the purchase order the order watch proposed', noun: 'orders' },
  show_order_chain: { module: 'Sales', area: 'Orders', kind: 'analyse', verb: 'Reading the customer, stock, supplier, invoice and margin behind the order', noun: 'orders' },
  plan_delivery_recovery: { module: 'Sales', area: 'Deliveries', kind: 'analyse', verb: 'Measuring what would make the order hold', noun: 'plans' },
  approve_delivery_recovery: { module: 'Sales', area: 'Deliveries', kind: 'act', verb: 'Carrying out the approved plan', noun: 'plans' },
  map_process_flow: { module: 'Sales', area: 'Process', kind: 'analyse', verb: 'Timing every step from quote to cash and requisition to payment', noun: 'steps' },
  watch_production_lines: { module: 'Manufacturing', area: 'Lines', kind: 'analyse', verb: 'Measuring each line against its norm', noun: 'lines' },
  what_matters_now: { module: 'Operations', area: 'Today', kind: 'analyse', verb: 'Running every watcher and ranking what needs a person', noun: 'items' },
  map_the_business: { module: 'Operations', area: 'Business map', kind: 'analyse', verb: 'Reading every part of the business and tracing what connects them', noun: 'parts' },
  what_built_apps_flag: { module: 'Operations', area: 'Built in Sandbox', kind: 'analyse', verb: 'Reading what you built and tying it to the orders and suppliers it reaches', noun: 'records' },
  what_simeli_noticed: { module: 'Operations', area: 'Today', kind: 'analyse', verb: 'Comparing what the watch finds now with what it showed you before', noun: 'items' },
  explain_cash_outlook: { module: 'Finance', area: 'Cash', kind: 'analyse', verb: 'Projecting cash week by week, with orders and bills not yet invoiced', noun: 'weeks' },
  send_cash_reminders: { module: 'Finance', area: 'Receivables', kind: 'act', verb: 'Sending the payment reminders', noun: 'invoices' },
  map_what_the_business_runs_on: { module: 'Operations', area: 'Infrastructure', kind: 'analyse', verb: 'Mapping the lines, sites and systems the orders depend on', noun: 'dependencies' },
  what_if_it_stops: { module: 'Operations', area: 'Infrastructure', kind: 'analyse', verb: 'Tracing every order twice, with and without it', noun: 'orders' },
  read_warehouse_twin: { module: 'Inventory', area: 'Warehouse', kind: 'analyse', verb: 'Walking the warehouse bay by bay', noun: 'bays' },
  monitor_supplier_risk: { module: 'Procurement', area: 'Suppliers', kind: 'analyse', verb: 'Reading each supplier\'s delivery record', noun: 'suppliers' },
  plan_replenishment: { module: 'Inventory', area: 'Planning', kind: 'analyse', verb: 'Reading stock, demand, supplier terms and budget', noun: 'items' },
  recall_supplier_precedent: { module: 'Procurement', area: 'Suppliers', kind: 'analyse', verb: 'Reading what was done the last times this supplier was late', noun: 'decisions' },
  explain_pending_decisions: { module: 'Approvals', area: 'Decisions', kind: 'analyse', verb: 'Walking each pending decision to what it holds up', noun: 'decisions' },
  explain_people_coverage: { module: 'HR', area: 'People', kind: 'analyse', verb: 'Matching who decides what against who is away when', noun: 'people' },
  act_on_people_coverage: { module: 'HR', area: 'People', kind: 'act', verb: 'Carrying out the confirmed cover', noun: 'proposals' },
  build_in_sandbox: { module: 'Platform', area: 'Sandbox', kind: 'draft', verb: 'Designing it in Sandbox and rehearsing it on the real schema', noun: 'capabilities' },
  explain_agent_track_record: { module: 'Platform', area: 'Agents', kind: 'analyse', verb: 'Measuring what people approved, changed and rejected of each agent\'s work', noun: 'agents' },
  grant_earned_authority: { module: 'Platform', area: 'Agents', kind: 'act', verb: 'Changing the agent\'s authority as confirmed', noun: 'proposals' },

  // --- Writes ---------------------------------------------------------------
  create_customer_invoice_draft: { module: 'Finance',     area: 'Billing',    kind: 'draft', verb: 'Drafting an invoice',    noun: 'invoices' },
  create_journal_entry_draft:    { module: 'Finance',     area: 'General ledger', kind: 'draft', verb: 'Drafting a journal entry', noun: 'entries' },
  create_sales_quotation_draft:  { module: 'Sales',       area: 'Quotations', kind: 'draft', verb: 'Drafting a quotation',   noun: 'quotations' },
  create_rfq_draft:              { module: 'Procurement', area: 'RFQs',       kind: 'draft', verb: 'Drafting a request for quotation', noun: 'RFQs' },
  prepare_margin_follow_ups:     { module: 'Finance',     area: 'Margin',     kind: 'draft', verb: 'Drafting the margin follow-ups for their owners', noun: 'follow-ups' },
  create_purchase_order_draft:   { module: 'Procurement', area: 'Purchase orders', kind: 'draft', verb: 'Drafting a purchase order', noun: 'orders' },

  // --- Building and testing tools -------------------------------------------
  try_tool:   { module: 'Platform', area: 'Extensions', kind: 'project', verb: 'Trying a tool before saving it', noun: 'results' },
  build_tool: { module: 'Platform', area: 'Extensions', kind: 'build',   verb: 'Building a new tool',            noun: 'tools' },
  build_agent:{ module: 'Platform', area: 'Agents',     kind: 'build',   verb: 'Building an agent',              noun: 'agents' },

  // --- Presentation ---------------------------------------------------------
  show_data:    { module: 'Data', area: 'Records', kind: 'render', verb: 'Showing the rows',   noun: 'rows' },
  render_chart: { module: 'Data', area: 'Charts',  kind: 'render', verb: 'Drawing the chart',  noun: 'series' },
};

// Tools whose names are not in the table but whose prefix says what they do.
// Ordered: the first match wins, so the more specific prefixes come first.
const PREFIX_RULES = [
  ['generate_',  { module: 'Data',     area: 'Documents', kind: 'render',  verb: 'Producing a document', noun: 'documents' }],
  ['latex_to_',  { module: 'Data',     area: 'Documents', kind: 'render',  verb: 'Producing a document', noun: 'documents' }],
  ['build_',     { module: 'Platform', area: 'Extensions',kind: 'build',   verb: 'Building an extension',noun: 'items' }],
  ['try_',       { module: 'Platform', area: 'Extensions',kind: 'project', verb: 'Testing before saving',noun: 'results' }],
  ['propose_',   { module: 'Platform', area: 'Automation',kind: 'draft',   verb: 'Proposing a task',     noun: 'tasks' }],
  ['forecast_',  { module: 'Data',     area: 'Forecasting',kind: 'project',verb: 'Projecting forward',   noun: 'periods' }],
  ['predict_',   { module: 'Data',     area: 'Forecasting',kind: 'project',verb: 'Projecting forward',   noun: 'periods' }],
  ['simulate_',  { module: 'Data',     area: 'Scenarios', kind: 'project', verb: 'Simulating a scenario',noun: 'outcomes' }],
  ['detect_',    { module: 'Governance', area: 'Findings',kind: 'analyse', verb: 'Testing for anomalies',noun: 'anomalies' }],
  ['analyze_',   { module: 'Data',     area: 'Analysis',  kind: 'analyse', verb: 'Analysing',            noun: 'results' }],
  ['analyse_',   { module: 'Data',     area: 'Analysis',  kind: 'analyse', verb: 'Analysing',            noun: 'results' }],
  ['suggest_',   { module: 'Data',     area: 'Analysis',  kind: 'analyse', verb: 'Working out a suggestion', noun: 'suggestions' }],
  ['search_',    { module: 'Data',     area: 'Search',    kind: 'read',    verb: 'Searching',            noun: 'results' }],
  ['create_',    { module: 'Data',     area: 'Records',   kind: 'draft',   verb: 'Drafting a record',    noun: 'records' }],
  ['record_',    { module: 'Data',     area: 'Records',   kind: 'act',     verb: 'Recording',            noun: 'records' }],
  ['run_',       { module: 'Data',     area: 'Processes', kind: 'act',     verb: 'Running a process',    noun: 'results' }],
  ['list_',      { module: 'Data',     area: 'Records',   kind: 'read',    verb: 'Reading records',      noun: 'records' }],
  ['get_',       { module: 'Data',     area: 'Records',   kind: 'read',    verb: 'Reading records',      noun: 'records' }],
];

const KIND_STAGE = {
  read:    'investigate',
  analyse: 'discover',
  project: 'simulate',
  draft:   'propose',
  build:   'propose',
  act:     'execute',
  render:  'report',
};

/**
 * Turn a snake_case tool name into something a person can read.
 * `list_low_stock_items` → `Low stock items`.
 */
function humanizeToolName(name) {
  const words = String(name || '').split('_').filter(Boolean);
  const verbs = new Set(['get', 'list', 'search', 'run', 'create', 'record', 'build', 'try', 'generate', 'detect', 'analyze', 'analyse', 'suggest', 'predict', 'forecast', 'simulate', 'propose']);
  const rest = verbs.has(words[0]) ? words.slice(1) : words;
  const text = (rest.length ? rest : words).join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * What a tool is, in business terms.
 *
 * Never returns undefined. An unknown tool — one a user authored, one reached
 * over MCP, one from a connector — is described from its own name rather than
 * dropped, because a step that silently does not appear is worse than a step
 * described roughly.
 */
function meta(name) {
  const known = TOOL_META[name];
  if (known) return { ...known, stage: KIND_STAGE[known.kind], name, known: true };

  for (const [prefix, rule] of PREFIX_RULES) {
    if (String(name || '').startsWith(prefix)) {
      return { ...rule, stage: KIND_STAGE[rule.kind], name, known: false, verb: `${rule.verb}: ${humanizeToolName(name).toLowerCase()}` };
    }
  }
  return {
    module: 'Data', area: 'Tools', kind: 'read', stage: 'investigate',
    verb: humanizeToolName(name) || 'Working', noun: 'results', name, known: false,
  };
}

// ---------------------------------------------------------------------------
// Result digests.
//
// A tool returns whatever its handler returns — there is no shared envelope,
// and there are 66 of them plus however many the user has authored. Rather than
// hand-writing an extractor per tool (which would rot the moment a handler
// changed a field name), the digest reads the shape:
//
//   * the longest array of objects in the result is the record list;
//   * scalar numeric fields at the top level are the headline figures;
//   * a field that looks like an identifier or a name labels each record.
//
// Everything is counted, never estimated. `count` is `array.length`. If there
// is no array, there is no count, and the caller shows the figures alone.
// ---------------------------------------------------------------------------

// Field names that identify a record, most specific first.
const LABEL_KEYS = [
  'invoice_number', 'bill_number', 'order_number', 'po_number', 'requisition_number',
  'quotation_number', 'contract_number', 'entry_number', 'document_number', 'reference',
  'customer_name', 'supplier_name', 'legal_name', 'employee_name', 'account_name',
  'item_name', 'item_code', 'sku', 'title', 'subject', 'name', 'label', 'code', 'id',
];

// Field names worth showing as a headline number. Matched as a substring, so
// `total_outstanding`, `outstanding_amount` and `amount` all qualify.
const FIGURE_HINTS = [
  'total', 'outstanding', 'amount', 'balance', 'value', 'count', 'days',
  'percent', 'rate', 'variance', 'gap', 'net', 'gross', 'quantity',
];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The longest array-of-objects anywhere in the result, with the key that held it. */
function findRecordList(result, depth = 0) {
  if (depth > 2 || !isPlainObject(result)) return null;
  let best = null;
  for (const [key, value] of Object.entries(result)) {
    if (Array.isArray(value) && value.length && isPlainObject(value[0])) {
      if (!best || value.length > best.rows.length) best = { key, rows: value };
    } else if (isPlainObject(value)) {
      const nested = findRecordList(value, depth + 1);
      if (nested && (!best || nested.rows.length > best.rows.length)) best = nested;
    }
  }
  return best;
}

function labelFor(row) {
  for (const key of LABEL_KEYS) {
    const v = row[key];
    if (v !== null && v !== undefined && String(v).trim() && String(v).length < 80) return String(v);
  }
  // Nothing recognisable — first short string field, or nothing.
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'string' && v.trim() && v.length < 60 && !k.endsWith('_at')) return v;
  }
  return null;
}

/** A secondary line for a record: the biggest number on it, if it has one. */
function detailFor(row) {
  let best = null;
  for (const [k, v] of Object.entries(row)) {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
    if (n === null || !Number.isFinite(n)) continue;
    if (!FIGURE_HINTS.some((h) => k.includes(h))) continue;
    if (!best || Math.abs(n) > Math.abs(best.value)) best = { key: k, value: n };
  }
  return best;
}

/**
 * What a tool found, counted from its own return value.
 *
 * @returns {{count?:number, unit?:string, headline?:string, records:Array, figures:Array, empty:boolean}}
 */
function digest(name, result) {
  const m = meta(name);
  const out = { module: m.module, area: m.area, records: [], figures: [], empty: false };

  if (result === null || result === undefined) { out.empty = true; return out; }

  // A tool may return a bare array.
  const body = Array.isArray(result) ? { items: result } : result;
  if (!isPlainObject(body)) {
    out.headline = String(body).slice(0, 200);
    return out;
  }

  const list = findRecordList(body);
  if (list) {
    out.count = list.rows.length;
    out.unit = m.noun;
    // A handful, not the whole set: this rides on an SSE frame and is rendered
    // as a preview the user can expand, not as the record list itself.
    out.records = list.rows.slice(0, 5).map((row) => {
      const detail = detailFor(row);
      return {
        label: labelFor(row),
        id: row.id ?? row.uuid ?? null,
        detail: detail ? { key: detail.key, value: detail.value } : null,
      };
    }).filter((r) => r.label || r.detail);
  }

  // Scalar figures at the top level — `total_outstanding: 32410` and friends.
  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (!FIGURE_HINTS.some((h) => key.includes(h))) continue;
    out.figures.push({ key, value });
    if (out.figures.length >= 4) break;
  }

  // Explicit booleans that mean "this did not really run" are worth surfacing:
  // several analysis tools return them instead of throwing, and a UI that shows
  // "0 anomalies" for "not enough history to test" is actively misleading.
  for (const key of ['analysis_ran', 'sufficient_data', 'success']) {
    if (body[key] === false) out.inconclusive = key;
  }

  if (out.count === undefined && !out.figures.length && out.inconclusive === undefined) {
    // Nothing countable came back. Say that rather than implying emptiness.
    const keys = Object.keys(body);
    out.empty = keys.length === 0;
    if (!out.empty) out.headline = `${keys.length} field${keys.length === 1 ? '' : 's'} returned`;
  }
  if (out.count === 0) out.empty = true;

  return out;
}

/**
 * The stage a run has reached, given everything that has happened so far.
 *
 * Monotonic: a run that has proposed something does not fall back to
 * "investigate" because it then reads one more record. The loop is a progress
 * indicator, and a progress indicator that goes backwards is noise.
 */
function stageFor(previousStage, event) {
  let next;
  if (event.type === 'awaiting_confirmation') next = 'await_approval';
  else if (event.type === 'final') next = 'report';
  else if (event.type === 'tool_call') next = meta(event.name).stage;
  else if (event.type === 'reason') next = 'reason';
  else return previousStage || 'understand';

  const a = STAGE_INDEX[previousStage] ?? -1;
  const b = STAGE_INDEX[next] ?? -1;
  return b >= a ? next : previousStage;
}

module.exports = { STAGES, meta, digest, stageFor, humanizeToolName };
