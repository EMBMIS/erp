/**
 * ERP AI Tool Registry.
 *
 * A single, shared catalogue of ERP operations exposed to AI as function-calling
 * tools. Both the in-app function-calling agent (services/ai/agent.js) and the
 * MCP server (mcp/server.js) drive the exact same tools, so there is one source
 * of truth and one set of guardrails:
 *
 *   • Read tools query the ERP; write tools create records in a DRAFT / pending
 *     state that still flow through the normal DOA/approval machinery — AI
 *     proposes, humans approve.
 *   • There are NO destructive (delete/hard-modify) tools.
 *   • Every call is written to ai_audit_log (see migration 094).
 *
 * Each tool: { name, description, readOnly, inputSchema (JSON Schema), handler }.
 * A handler receives (args, ctx) where ctx = { userId, actor }.
 */

const { pool } = require('../../config/database');

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
const tools = [
  {
    name: 'get_trial_balance',
    description: 'Return the trial balance (all accounts with debit/credit balances) as of an optional date. Use to check the books balance or inspect account balances.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { as_of_date: { type: 'string', description: 'YYYY-MM-DD; defaults to today' } },
    },
    handler: async (args) => {
      const FinancialPostingService = require('../financialPostingService');
      const rows = await FinancialPostingService.getTrialBalance(args.as_of_date);
      const totalDebit = rows.reduce((s, r) => s + Number(r.debit_balance || r.debit || 0), 0);
      const totalCredit = rows.reduce((s, r) => s + Number(r.credit_balance || r.credit || 0), 0);
      return { as_of_date: args.as_of_date || new Date().toISOString().split('T')[0], accounts: rows, total_debit: totalDebit, total_credit: totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01 };
    },
  },
  {
    name: 'get_ar_aging',
    description: 'Accounts Receivable aging summary (current / 1-30 / 31-60 / 61-90 / 90+ days) plus the outstanding customer invoices.',
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const detail = await pool.query(`
        SELECT ci.invoice_number, ci.due_date, ci.outstanding_amount, ci.status, c.customer_name,
               GREATEST(0, (CURRENT_DATE - ci.due_date))::int AS days_overdue
        FROM customer_invoices ci LEFT JOIN customers c ON ci.customer_id = c.id
        WHERE ci.deleted_at IS NULL AND ci.status IN ('APPROVED','SENT','PARTIALLY_PAID','OVERDUE') AND ci.outstanding_amount > 0
        ORDER BY ci.due_date ASC`);
      const total = detail.rows.reduce((s, r) => s + Number(r.outstanding_amount || 0), 0);
      return { total_outstanding: total, open_invoices: detail.rows };
    },
  },
  {
    name: 'get_ap_aging',
    description: 'Accounts Payable aging: the outstanding supplier bills the company owes, with days overdue.',
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const detail = await pool.query(`
        SELECT si.bill_number, si.due_date, si.outstanding_amount, si.status, s.legal_name AS supplier_name,
               GREATEST(0, (CURRENT_DATE - si.due_date))::int AS days_overdue
        FROM supplier_invoices si LEFT JOIN suppliers s ON si.supplier_id = s.id
        WHERE si.deleted_at IS NULL AND si.status IN ('APPROVED','PARTIALLY_PAID','OVERDUE') AND si.outstanding_amount > 0
        ORDER BY si.due_date ASC`).catch(() => ({ rows: [] }));
      const total = detail.rows.reduce((s, r) => s + Number(r.outstanding_amount || 0), 0);
      return { total_outstanding: total, open_bills: detail.rows };
    },
  },
  {
    name: 'plan_supplier_payment_run',
    description:
      'Recommend which open supplier bills to pay now within a cash budget. Prices every early-payment discount in the bill terms (e.g. "2/10 Net 30") as an annualised return, pays discounts beating the hurdle rate first, then overdue bills, then bills due within the horizon. Returns discounts captured and discounts at risk. Advisory only — pays nothing.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        cash_available: { type: 'number', description: 'cash budget for this run; omit for unlimited' },
        hurdle_rate: { type: 'number', description: 'minimum annualised % return to take a discount (default 10)' },
        horizon_days: { type: 'number', description: 'also pay bills due within this many days (default 7)' },
      },
    },
    handler: async (args) =>
      require('../paymentRunOptimizer').buildPaymentRun({
        cashAvailable: Number.isFinite(args.cash_available) ? Math.max(args.cash_available, 0) : null,
        hurdleRate: Number.isFinite(args.hurdle_rate) ? Math.max(args.hurdle_rate, 0) : 10,
        horizonDays: Math.min(Math.max(args.horizon_days ?? 7, 0), 365),
      }),
  },
  {
    name: 'list_low_stock_items',
    description: 'List inventory items at or below their reorder point — i.e. candidates for replenishment.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'max rows, default 50' } } },
    handler: async (args) => {
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 50, 1), 200);
      const r = await pool.query(`
        SELECT ii.id, i.name AS item_name, i.item_code, ii.current_stock_quantity, ii.reorder_point, ii.minimum_stock_level, ii.unit_price
        FROM inventory_items ii JOIN items i ON ii.item_master_id = i.id
        WHERE ii.reorder_point IS NOT NULL AND ii.current_stock_quantity <= ii.reorder_point
        ORDER BY (ii.reorder_point - ii.current_stock_quantity) DESC
        LIMIT $1`, [limit]);
      return { count: r.rows.length, items: r.rows };
    },
  },
  {
    name: 'list_sales_orders',
    description: 'List sales orders, optionally filtered by status. Useful for O2C pipeline questions.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' }, limit: { type: 'number', description: 'default 25' } },
    },
    handler: async (args) => {
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 25, 1), 200);
      const params = [];
      let where = 'WHERE so.deleted_at IS NULL';
      if (args.status) { params.push(args.status); where += ` AND so.status = $${params.length}`; }
      params.push(limit);
      const r = await pool.query(`
        SELECT so.id, so.so_number, so.status, so.total_amount, so.order_date, c.customer_name
        FROM sales_orders so LEFT JOIN customers c ON so.customer_id = c.id
        ${where} ORDER BY so.order_date DESC LIMIT $${params.length}`, params);
      return { count: r.rows.length, sales_orders: r.rows };
    },
  },
  {
    name: 'list_purchase_orders',
    description: 'List purchase orders, optionally filtered by status. Useful for P2P pipeline questions.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' }, limit: { type: 'number', description: 'default 25' } },
    },
    handler: async (args) => {
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 25, 1), 200);
      const params = [];
      let where = 'WHERE 1=1';
      if (args.status) { params.push(args.status); where += ` AND po.status = $${params.length}`; }
      params.push(limit);
      const r = await pool.query(`
        SELECT po.id, po.po_number, po.status, po.total_amount, s.legal_name AS supplier_name
        FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id
        ${where} ORDER BY po.created_at DESC LIMIT $${params.length}`, params);
      return { count: r.rows.length, purchase_orders: r.rows };
    },
  },
  {
    name: 'search_customers',
    description: 'Search customers by name. Returns id, name, credit limit and current balance (credit exposure).',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'name fragment' }, limit: { type: 'number' } },
    },
    handler: async (args) => {
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 100);
      const like = `%${args.query || ''}%`;
      const r = await pool.query(`
        SELECT id, customer_name, credit_limit, current_balance
        FROM customers WHERE deleted_at IS NULL AND customer_name ILIKE $1
        ORDER BY customer_name LIMIT $2`, [like, limit]);
      return { count: r.rows.length, customers: r.rows };
    },
  },
  {
    name: 'get_financial_summary',
    description: 'A one-shot snapshot: total AR outstanding, total AP outstanding, and count of low-stock items. Good for a "how is the business doing" overview.',
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const ar = await pool.query("SELECT COALESCE(SUM(outstanding_amount),0) t FROM customer_invoices WHERE deleted_at IS NULL AND outstanding_amount > 0").catch(() => ({ rows: [{ t: 0 }] }));
      const ap = await pool.query("SELECT COALESCE(SUM(outstanding_amount),0) t FROM supplier_invoices WHERE deleted_at IS NULL AND outstanding_amount > 0").catch(() => ({ rows: [{ t: 0 }] }));
      const low = await pool.query("SELECT COUNT(*)::int c FROM inventory_items WHERE reorder_point IS NOT NULL AND current_stock_quantity <= reorder_point").catch(() => ({ rows: [{ c: 0 }] }));
      return { accounts_receivable_outstanding: Number(ar.rows[0].t), accounts_payable_outstanding: Number(ap.rows[0].t), low_stock_item_count: low.rows[0].c };
    },
  },
  {
    name: 'preview_dunning_reminders',
    description: 'Dry-run the accounts-receivable dunning process: shows which overdue customer invoices WOULD receive a payment-reminder email and at what escalation level, without sending anything. Use this to answer "which customers are overdue" or "what reminders would go out".',
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const { runDunning } = require('../dunningService');
      const result = await runDunning({ dryRun: true });
      return { would_notify: result.details.length, details: result.details };
    },
  },
  {
    name: 'run_findings_scan',
    description: 'Run the statistical anomaly scan (duplicate invoices, weekend postings, round-number outliers, stockout risk, overdue supplier deliveries) and return newly-found issues. Safe to re-run — already-open findings for the same issue are not duplicated.',
    readOnly: false,
    highImpact: true, // notifies managers — worth a confirmation outside full-auto mode
    min_role: 'MANAGER',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const { runFindingsScan } = require('../ai/findingsScan');
      return runFindingsScan();
    },
  },
  {
    name: 'list_open_findings',
    description: 'List currently open AI findings (anomalies the scan has flagged) — duplicate invoices, weekend postings, round-number outliers, stockout risk, overdue supplier deliveries.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { severity: { type: 'string', description: 'LOW, MEDIUM, or HIGH' } },
    },
    handler: async (args) => {
      const params = ['OPEN'];
      let where = 'WHERE status = $1';
      if (args.severity) { params.push(args.severity); where += ` AND severity = $${params.length}`; }
      const r = await pool.query(`SELECT * FROM ai_findings ${where} ORDER BY created_at DESC LIMIT 50`, params);
      return { count: r.rows.length, findings: r.rows };
    },
  },
  {
    name: 'generate_mail_branding',
    description:
      'Design the company\'s outgoing email look from a logo image: a vision model reads the logo\'s colors and '
      + 'builds an HTML email template around them (header, footer, brand colors). From then on every mailbox in '
      + 'the company sends through this design automatically — the logo travels with each email as an inline '
      + 'image, not a link. The logo must already be attached to this conversation (ask the person to attach the '
      + 'logo photo first, then call this with its name). Replaces any existing design for the company; there is '
      + 'no per-mailbox design, one design serves every mailbox.',
    readOnly: false,
    highImpact: true, // changes what every mailbox in the company sends, standing until someone changes it again
    min_role: 'ADMIN',
    inputSchema: {
      type: 'object',
      properties: {
        logo_attachment: { type: 'string', description: 'Name (or id) of the logo image already attached to this conversation. Omit for the most recently attached file.' },
      },
    },
    handler: async (args, ctx) => {
      const attachments = require('./attachments');
      const mailBrandingService = require('../mailBrandingService');
      if (!ctx.companyId) return { error: 'No company context — cannot set a company-wide design here.' };

      const found = await attachments.preview({ sessionId: ctx.sessionId, userId: ctx.userId, id: args.logo_attachment })
        .catch(() => null);
      // preview() looks up by exact id; a name (the common case — "the logo I
      // just attached") needs the same fuzzy lookup read_attachment uses.
      let file = found;
      if (!file) {
        const record = await attachments.read({ sessionId: ctx.sessionId, userId: ctx.userId, idOrName: args.logo_attachment });
        if (record) file = await attachments.preview({ sessionId: ctx.sessionId, userId: ctx.userId, id: record.id });
      }
      if (!file?.buffer) {
        return { error: 'No logo image found in this conversation\'s attachments. Ask the person to attach the logo photo, then call this again.' };
      }

      const branding = await mailBrandingService.generateFromLogo({
        companyId: ctx.companyId, buffer: file.buffer, contentType: file.mime, userId: ctx.userId,
      });
      return {
        applied: true,
        palette: branding.palette,
        note: 'Every mailbox in this company now sends through this design. Reachable/editable later at Admin > Mail Design.',
      };
    },
  },
  {
    name: 'list_my_pending_approvals',
    description: 'List approval-chain steps currently awaiting a decision from the current user (by role or specific assignment).',
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    handler: async (args, ctx) => {
      const ApprovalChain = require('../../models/ApprovalChain');
      const userRow = await pool.query('SELECT role FROM users WHERE id = $1', [ctx.userId]);
      const pending = await ApprovalChain.findPendingForUser(ctx.userId, userRow.rows[0]?.role || 'ADMIN');
      return { count: pending.length, pending };
    },
  },
  {
    name: 'list_webhook_subscriptions',
    description: 'List registered webhook subscriptions for external integrations (URL, subscribed event types, delivery status).',
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const { pool } = require('../../config/database');
      const r = await pool.query('SELECT id, url, event_types, status, last_delivery_at, last_delivery_status FROM webhook_subscriptions ORDER BY created_at DESC');
      return { count: r.rows.length, subscriptions: r.rows };
    },
  },
  {
    name: 'get_audit_trail',
    description: 'View the unified audit trail (who changed what, when) across sales orders, invoices, payments, journal entries, contracts, quotations, RFQs, warehouse transactions, and AI actions. Filter by entity_type and/or entity_id to trace one record\'s history, or omit both for recent global activity.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', description: 'e.g. SALES_ORDER, CUSTOMER_INVOICE, JOURNAL_ENTRY, AI_ACTION' },
        entity_id: { type: 'string' },
        limit: { type: 'number', description: 'default 20' },
      },
    },
    handler: async (args) => {
      const { getAuditTrail } = require('../auditTrailService');
      const companyScope = require('../companyScope');
      const companyContext = require('../companyContext');
      // Every *_status_history source this feed unions is scoped to a company
      // by joining back to the record it belongs to (see
      // auditTrailService.js) — company_id is required, not optional, or a
      // model asked "what changed on order X" would happily read another
      // company's history too.
      const companyId = companyScope.currentCompanyId() || (await companyContext.getDefaultCompanyId());
      const entries = await getAuditTrail({
        entity_type: args.entity_type, entity_id: args.entity_id, limit: args.limit || 20, company_id: companyId,
      });
      return { count: entries.length, entries };
    },
  },
  {
    name: 'preview_due_recurring_invoices',
    description: 'Dry-run recurring invoice schedules: shows which standing billing arrangements are due to invoice today, without creating anything.',
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const { runDueSchedules } = require('../recurringInvoiceService');
      const result = await runDueSchedules(null, { dryRun: true });
      return { due_count: result.created.length, due: result.created };
    },
  },
  {
    name: 'list_in_transit_transfers',
    description: 'List inventory transfers currently IN_TRANSIT between warehouses/storage locations (dispatched but not yet received).',
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const InventoryTransfer = require('../../models/InventoryTransfer');
      const rows = await InventoryTransfer.findAll({ status: 'IN_TRANSIT' });
      return { count: rows.length, transfers: rows };
    },
  },
  {
    name: 'record_stocktake_count',
    description: 'Record a physical stock count (cycle count / stocktake) for one inventory item. Updates stock to the counted quantity and posts the variance to the GL at moving-average cost (Dr/Cr Inventory vs COGS). Variances over $1000 require manager approval before posting; smaller ones post immediately.',
    readOnly: false,
    highImpact: true, // can post a real GL variance entry immediately (not just a draft)
    min_role: 'MANAGER',
    inputSchema: {
      type: 'object',
      properties: {
        inventory_item_id: { type: 'string' },
        item_name: { type: 'string', description: 'display name for the audit trail' },
        unit_of_measure: { type: 'string' },
        physical_quantity: { type: 'number', description: 'the actual counted quantity' },
        reason_code: { type: 'string', description: 'e.g. CYCLE_COUNT, ANNUAL_STOCKTAKE, DAMAGE' },
      },
      required: ['inventory_item_id', 'item_name', 'physical_quantity'],
    },
    handler: async (args, ctx) => {
      const WarehouseTransaction = require('../../models/WarehouseTransaction');
      return WarehouseTransaction.create(
        { transaction_type: 'SA', created_by: ctx.userId, processed_by: ctx.userId, notes: 'Recorded via AI tool' },
        [{
          inventory_item_id: args.inventory_item_id,
          item_name: args.item_name,
          unit_of_measure: args.unit_of_measure || 'PCS',
          physical_quantity: args.physical_quantity,
          reason_code: args.reason_code || 'CYCLE_COUNT',
        }]
      );
    },
  },
  {
    name: 'auto_reconcile_bank_account',
    description: 'Auto-match unreconciled bank statement lines on an account against customer/supplier payments (unambiguous amount+date matches only) and mark them reconciled. Ambiguous or unmatched lines are left for manual review — never guesses.',
    readOnly: false,
    highImpact: true, // flips real reconciliation state on real bank_transactions rows
    min_role: 'MANAGER',
    inputSchema: {
      type: 'object',
      properties: { bank_account_id: { type: 'string', description: 'the bank account UUID to reconcile' } },
      required: ['bank_account_id'],
    },
    handler: async (args, ctx) => {
      const BankTransaction = require('../../models/BankTransaction');
      return BankTransaction.autoReconcile(args.bank_account_id, ctx.userId);
    },
  },
  {
    name: 'run_reorder_check',
    description: 'MRP-lite: scan inventory for items at or below their reorder point and draft a purchase requisition for each (quantity sized to the max stock level). Set dry_run=true to preview without creating anything. Items that already have an open PR are skipped automatically. Creates DRAFT PRs only — a human must still approve them.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: { dry_run: { type: 'boolean', description: 'true = preview only, do not create PRs' } },
    },
    handler: async (args, ctx) => {
      const { runReorderCheck } = require('../reorderService');
      return runReorderCheck(ctx.userId, { dryRun: args.dry_run === true });
    },
  },
  // --- Write tool (DRAFT / proposal only) --------------------------------------
  {
    name: 'create_purchase_requisition_draft',
    description: 'Create a DRAFT purchase requisition (a purchase request) for review. This does NOT approve or order anything — it creates a draft a human must approve through the normal DOA workflow. Use when the user asks the AI to start a purchase.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'short title / justification' },
        notes: { type: 'string' },
      },
      required: ['title'],
    },
    handler: async (args, ctx) => {
      // Minimal, schema-tolerant draft insert. Kept intentionally simple: it
      // creates a header a human then fills in and submits for approval.
      const cols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='purchase_requisitions'");
      const names = new Set(cols.rows.map((c) => c.column_name));
      if (!names.has('id') || !names.has('status')) throw new Error('purchase_requisitions table not available');
      const fields = ['status'];
      const vals = ['DRAFT'];
      const ph = ['$1'];
      const push = (col, val) => { if (names.has(col)) { fields.push(col); vals.push(val); ph.push(`$${vals.length}`); } };
      push('title', args.title);
      push('description', args.notes || args.title);
      push('notes', args.notes || null);
      push('created_by', ctx.userId);
      push('requested_by', ctx.userId);
      const r = await pool.query(
        `INSERT INTO purchase_requisitions (${fields.join(',')}) VALUES (${ph.join(',')}) RETURNING id, status`,
        vals
      );
      return { created: true, purchase_requisition_id: r.rows[0].id, status: r.rows[0].status, note: 'Created as DRAFT — requires human approval.' };
    },
  },

  // --- Web search (a real callable tool, not a pre-routed branch) -------------
  {
    name: 'web_search',
    description: 'Search the public web for current information not in the ERP — market prices, supplier/competitor info, regulations, definitions, news. Use alongside ERP data tools when a question needs both (e.g. "compare our last purchase price for copper wire against the current market price").',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        max_results: { type: 'number', description: 'default 5' },
      },
      required: ['query'],
    },
    handler: async (args) => {
      const WebSearchAgent = require('../webSearchAgent');
      const agent = new WebSearchAgent();
      const result = await agent.search(args.query, { maxResults: args.max_results || 5 });
      if (!result.success) return { success: false, error: result.error || 'Web search unavailable' };
      return {
        success: true,
        answer: result.answer,
        results: (result.results || []).slice(0, args.max_results || 5).map((r) => ({ title: r.title, url: r.url, content: r.content })),
      };
    },
  },

  // --- Analytics / reporting ---------------------------------------------------
  {
    name: 'get_revenue_by_month',
    description: 'Monthly revenue (sum of posted customer-invoice totals) for a given year — the basis for a revenue trend chart or "how did we do this year" question.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { year: { type: 'number', description: 'defaults to current year' } } },
    handler: async (args) => {
      const year = args.year || new Date().getFullYear();
      const r = await pool.query(`
        SELECT EXTRACT(MONTH FROM invoice_date)::int AS month, COALESCE(SUM(total_amount),0)::numeric AS revenue, COUNT(*)::int AS invoice_count
        FROM customer_invoices
        WHERE deleted_at IS NULL AND status NOT IN ('DRAFT','CANCELLED') AND EXTRACT(YEAR FROM invoice_date) = $1
        GROUP BY month ORDER BY month`, [year]);
      return { year, months: r.rows.map((row) => ({ month: row.month, revenue: Number(row.revenue), invoice_count: row.invoice_count })) };
    },
  },
  {
    name: 'get_expense_by_supplier',
    description: 'Total spend per supplier (sum of supplier-invoice totals), highest first. Good for "who are we spending the most with" or supplier-concentration questions.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'default 20' } } },
    handler: async (args) => {
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 100);
      const r = await pool.query(`
        SELECT s.legal_name AS supplier_name, COALESCE(SUM(si.total_amount),0)::numeric AS total_spend, COUNT(*)::int AS invoice_count
        FROM supplier_invoices si LEFT JOIN suppliers s ON si.supplier_id = s.id
        WHERE si.deleted_at IS NULL AND si.status NOT IN ('DRAFT','CANCELLED')
        GROUP BY s.legal_name ORDER BY total_spend DESC LIMIT $1`, [limit]).catch(() => ({ rows: [] }));
      return { count: r.rows.length, suppliers: r.rows.map((row) => ({ ...row, total_spend: Number(row.total_spend) })) };
    },
  },
  {
    name: 'get_gl_account_balance',
    description: 'Current balance of a specific GL account by its code (e.g. "1130" for Inventory, "5100" for COGS) — sum of posted journal-entry lines.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { account_code: { type: 'string' } }, required: ['account_code'] },
    handler: async (args) => {
      const r = await pool.query(`
        SELECT coa.account_code, coa.account_name, coa.account_type,
               COALESCE(SUM(jel.debit_amount),0)::numeric AS total_debit,
               COALESCE(SUM(jel.credit_amount),0)::numeric AS total_credit
        FROM chart_of_accounts coa
        LEFT JOIN journal_entry_items jel ON jel.account_id = coa.id
        LEFT JOIN journal_entries je ON jel.journal_entry_id = je.id AND je.status = 'POSTED' AND je.deleted_at IS NULL
        WHERE coa.account_code = $1
        GROUP BY coa.account_code, coa.account_name, coa.account_type`, [args.account_code]).catch(() => ({ rows: [] }));
      if (!r.rows.length) return { found: false, account_code: args.account_code };
      const row = r.rows[0];
      const debit = Number(row.total_debit), credit = Number(row.total_credit);
      const isDebitNormal = ['ASSET', 'EXPENSE'].includes((row.account_type || '').toUpperCase());
      return { found: true, account_code: row.account_code, account_name: row.account_name, account_type: row.account_type, balance: isDebitNormal ? debit - credit : credit - debit };
    },
  },
  {
    name: 'get_period_status',
    description: 'Check whether a given accounting period (year/month) is OPEN or CLOSED — needed before answering "can we still post to March" type questions.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { period_year: { type: 'number' }, period_month: { type: 'number', description: '1-12; omit to list the whole year' } },
      required: ['period_year'],
    },
    handler: async (args) => {
      const params = [args.period_year];
      let where = 'WHERE period_year = $1';
      if (args.period_month) { params.push(args.period_month); where += ` AND period_month = $${params.length}`; }
      const r = await pool.query(`SELECT period_year, period_month, status, closed_at FROM accounting_periods ${where} ORDER BY period_month`, params);
      return { count: r.rows.length, periods: r.rows };
    },
  },
  {
    name: 'list_recent_journal_entries',
    description: 'List recent journal entries, optionally filtered by status (DRAFT/POSTED) — useful for reviewing recent GL activity or finding unposted entries.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' }, limit: { type: 'number', description: 'default 25' } },
    },
    handler: async (args) => {
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 25, 1), 200);
      const params = [];
      let where = 'WHERE deleted_at IS NULL';
      if (args.status) { params.push(args.status); where += ` AND status = $${params.length}`; }
      params.push(limit);
      const r = await pool.query(`
        SELECT id, journal_number, entry_date, description, source_type, status, total_debit, total_credit
        FROM journal_entries ${where} ORDER BY entry_date DESC, created_at DESC LIMIT $${params.length}`, params);
      return { count: r.rows.length, entries: r.rows };
    },
  },

  // --- HR / payroll -------------------------------------------------------------
  {
    name: 'list_employees',
    description: 'List employees, optionally filtered by department or status. Returns headcount-level detail (no salary unless asked for specifically via a narrower question).',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { department: { type: 'string' }, status: { type: 'string' }, limit: { type: 'number', description: 'default 50' } },
    },
    handler: async (args) => {
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 50, 1), 300);
      const params = [];
      let where = 'WHERE deleted_at IS NULL';
      if (args.department) { params.push(args.department); where += ` AND department = $${params.length}`; }
      if (args.status) { params.push(args.status); where += ` AND status = $${params.length}`; }
      params.push(limit);
      const r = await pool.query(`
        SELECT id, employee_number, first_name, last_name, department, position, hire_date, status
        FROM employees ${where} ORDER BY last_name LIMIT $${params.length}`, params);
      return { count: r.rows.length, employees: r.rows };
    },
  },
  {
    name: 'get_payroll_summary',
    description: 'Summary of a payroll run (or the most recent one) — total gross, deductions, net, and status.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { period_year: { type: 'number' }, period_month: { type: 'number' } },
    },
    handler: async (args) => {
      const params = [];
      let where = 'WHERE deleted_at IS NULL';
      if (args.period_year) { params.push(args.period_year); where += ` AND period_year = $${params.length}`; }
      if (args.period_month) { params.push(args.period_month); where += ` AND period_month = $${params.length}`; }
      const r = await pool.query(`
        SELECT run_number, period_year, period_month, status, total_gross, total_deductions, total_net
        FROM payroll_runs ${where} ORDER BY period_year DESC, period_month DESC LIMIT 12`, params);
      return { count: r.rows.length, runs: r.rows };
    },
  },

  // --- Fixed assets --------------------------------------------------------------
  {
    name: 'list_fixed_assets',
    description: 'List fixed assets with book value and accumulated depreciation, optionally filtered by status or category.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' }, category: { type: 'string' }, limit: { type: 'number', description: 'default 50' } },
    },
    handler: async (args) => {
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 50, 1), 300);
      const params = [];
      let where = 'WHERE deleted_at IS NULL';
      if (args.status) { params.push(args.status); where += ` AND status = $${params.length}`; }
      if (args.category) { params.push(args.category); where += ` AND category = $${params.length}`; }
      params.push(limit);
      const r = await pool.query(`
        SELECT id, asset_number, name, category, acquisition_cost, accumulated_depreciation, book_value, status
        FROM fixed_assets ${where} ORDER BY acquisition_date DESC LIMIT $${params.length}`, params);
      const totalBookValue = r.rows.reduce((s, row) => s + Number(row.book_value || 0), 0);
      return { count: r.rows.length, total_book_value: totalBookValue, assets: r.rows };
    },
  },

  // --- Sales documents (contracts / quotations / RFQs) ---------------------------
  {
    name: 'list_sales_contracts',
    description: 'List sales/supplier contracts, optionally filtered by status. Includes value, term dates, and auto-renewal flag.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'number', description: 'default 25' } } },
    handler: async (args) => {
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 25, 1), 200);
      const params = [];
      let where = 'WHERE deleted_at IS NULL';
      if (args.status) { params.push(args.status); where += ` AND status = $${params.length}`; }
      params.push(limit);
      const r = await pool.query(`
        SELECT id, contract_number, contract_name, customer_name, supplier_name, contract_value, currency, start_date, end_date, status, auto_renewal
        FROM sales_contracts ${where} ORDER BY end_date ASC LIMIT $${params.length}`, params);
      return { count: r.rows.length, contracts: r.rows };
    },
  },
  {
    name: 'list_sales_quotations',
    description: 'List sales quotations, optionally filtered by status. Useful for pipeline/conversion questions ("how many quotes are outstanding").',
    readOnly: true,
    inputSchema: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'number', description: 'default 25' } } },
    handler: async (args) => {
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 25, 1), 200);
      const params = [];
      let where = 'WHERE deleted_at IS NULL';
      if (args.status) { params.push(args.status); where += ` AND status = $${params.length}`; }
      params.push(limit);
      const r = await pool.query(`
        SELECT id, quotation_number, customer_name, quotation_date, valid_until, total_amount, status, converted_to_so
        FROM sales_quotations ${where} ORDER BY quotation_date DESC LIMIT $${params.length}`, params);
      return { count: r.rows.length, quotations: r.rows };
    },
  },
  {
    name: 'list_sales_rfqs',
    description: 'List supplier RFQs (request for quotation), optionally filtered by status.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'number', description: 'default 25' } } },
    handler: async (args) => {
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 25, 1), 200);
      const params = [];
      let where = 'WHERE deleted_at IS NULL';
      if (args.status) { params.push(args.status); where += ` AND status = $${params.length}`; }
      params.push(limit);
      const r = await pool.query(`
        SELECT id, rfq_title, supplier_name, response_deadline, supplier_total_amount, supplier_currency, status
        FROM sales_rfqs ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
      return { count: r.rows.length, rfqs: r.rows };
    },
  },

  // --- Notifications ---------------------------------------------------------------
  {
    name: 'list_my_notifications',
    description: 'List the current user\'s notifications (approvals, AI findings, reminders), optionally unread-only.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { unread_only: { type: 'boolean' }, limit: { type: 'number', description: 'default 20' } } },
    handler: async (args, ctx) => {
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 100);
      const params = [ctx.userId];
      let where = 'WHERE user_id = $1';
      if (args.unread_only) where += ' AND is_read = false';
      params.push(limit);
      const r = await pool.query(`
        SELECT id, type, title, message, is_read, created_at
        FROM notifications ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
      return { count: r.rows.length, notifications: r.rows };
    },
  },

  // --- Document generation (returns a link the user/UI can open, not raw bytes) --
  {
    name: 'get_invoice_pdf_link',
    description: 'Get a printable-PDF download link for a customer invoice. Returns a URL the user can open — does not attempt to embed the PDF itself in chat.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { invoice_id: { type: 'string' } }, required: ['invoice_id'] },
    handler: async (args) => {
      const r = await pool.query('SELECT id, invoice_number FROM customer_invoices WHERE id = $1 AND deleted_at IS NULL', [args.invoice_id]);
      if (!r.rows.length) return { found: false };
      return { found: true, invoice_number: r.rows[0].invoice_number, pdf_url: `/api/customer-invoices/${r.rows[0].id}/pdf` };
    },
  },
  {
    name: 'get_purchase_order_pdf_link',
    description: 'Get a printable-PDF download link for a purchase order.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { purchase_order_id: { type: 'string' } }, required: ['purchase_order_id'] },
    handler: async (args) => {
      const r = await pool.query('SELECT id, po_number FROM purchase_orders WHERE id = $1', [args.purchase_order_id]);
      if (!r.rows.length) return { found: false };
      return { found: true, po_number: r.rows[0].po_number, pdf_url: `/api/purchase-orders/${r.rows[0].id}/pdf` };
    },
  },

  // -------------------------------------------------------------------------
  // Forecasting & anomaly detection
  //
  // These return statistical results computed from posted entries, including an
  // explicit signal when there is not enough history. The agent must relay that
  // rather than presenting a weak projection as fact.
  // -------------------------------------------------------------------------
  {
    name: 'forecast_profit_and_loss',
    description:
      'Forecast revenue, expenses and profit for the coming months from posted journal entries, using a least-squares trend with a 95% confidence interval. Returns sufficient_data:false and a caveat when history is too short — say so rather than presenting the numbers as a reliable forecast.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        horizon: { type: 'number', description: 'months to project (default 3, max 12)' },
        months: { type: 'number', description: 'months of history to fit on (default 24)' },
      },
    },
    handler: async (args) =>
      require('./forecasting').forecastProfitAndLoss({
        horizon: Math.min(args.horizon || 3, 12),
        months: Math.min(args.months || 24, 60),
      }),
  },
  {
    name: 'forecast_cash_flow',
    description:
      'Project cash over a horizon from real invoice due dates: opening cash, receivables due in, payables due out, and a risk flag. Flags when the projection depends on collecting already-overdue invoices. For where cash dips week by week, why, and what lifts it, use explain_cash_outlook instead.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { horizon_days: { type: 'number', description: 'days ahead (default 90)' } },
    },
    handler: async (args) =>
      require('./forecasting').forecastCashFlow({ horizonDays: Math.min(args.horizon_days || 90, 365) }),
  },
  {
    name: 'detect_amount_anomalies',
    description:
      'Find journal postings whose amount is unusual for the GL account it hit, using robust median/MAD statistics. Check analysis_ran: false means no account had enough history to test, which is NOT a clean result.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        months: { type: 'number', description: 'lookback window (default 12)' },
        threshold: { type: 'number', description: 'sigmas before flagging (default 4)' },
      },
    },
    handler: async (args) =>
      require('./forecasting').detectAmountAnomalies({
        months: Math.min(args.months || 12, 60),
        threshold: args.threshold || 4,
      }),
  },
  {
    name: 'backtest_profit_and_loss_forecast',
    description:
      'Measure how accurate forecast_profit_and_loss actually is: refits the same trend as of months_back months ago using only history that existed then, and compares that projection to what actually posted since. Returns per-month predicted vs actual (revenue, expense, profit) and an overall MAPE — this is the forecast method\'s own track record, not a new prediction. Returns sufficient_data:false when there is not enough history before or after the cutoff to run a meaningful backtest; relay that as "not enough history to validate," never silently omit it.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        months_back: { type: 'number', description: 'how many months ago to pretend was "today" (default 6, max 24)' },
        horizon: { type: 'number', description: 'months the refit projects forward from the cutoff (default 3, max 12)' },
      },
    },
    handler: async (args) =>
      require('./forecasting').backtestProfitAndLossForecast({
        months_back: Math.min(args.months_back || 6, 24),
        horizon: Math.min(args.horizon || 3, 12),
      }),
  },

  // -------------------------------------------------------------------------
  // Duplicate detection
  // -------------------------------------------------------------------------
  {
    name: 'find_duplicate_records',
    description:
      'Detect probable duplicate suppliers, customers or supplier invoices (fuzzy name matching that ignores legal suffixes, shared email addresses, and repeated invoice references/amounts). Duplicate suppliers and bills are the direct cause of duplicate payments. Returns ranked suggestions for a human to merge — it never merges anything.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        entity: {
          type: 'string',
          enum: ['all', 'suppliers', 'customers', 'supplier_invoices'],
          description: 'what to scan (default all)',
        },
      },
    },
    handler: async (args) => {
      const dd = require('./duplicateDetection');
      switch (args.entity) {
        case 'suppliers': return dd.findDuplicateSuppliers();
        case 'customers': return dd.findDuplicateCustomers();
        case 'supplier_invoices': return dd.findDuplicateSupplierInvoices();
        default: return dd.scanAll();
      }
    },
  },

  // -------------------------------------------------------------------------
  // GL coding assistance
  // -------------------------------------------------------------------------
  {
    name: 'suggest_gl_accounts',
    description:
      'Suggest which GL account a transaction should be coded to, learned from this company\'s own posted history (what this supplier was coded to before, and how similar descriptions were coded). Falls back to an AI suggestion constrained to the real chart of accounts. Says plainly when there is no basis.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'the transaction narrative' },
        supplier_id: { type: 'string', description: 'optional supplier UUID — the strongest signal' },
        amount: { type: 'number' },
      },
      required: ['description'],
    },
    handler: async (args) => require('./journalSuggestions').suggestAccounts(args),
  },
  {
    name: 'suggest_journal_entry',
    description:
      'Propose a complete, balanced DRAFT journal entry for a transaction, with the debit account inferred from posting history. Returns a proposal only — it does not create or post anything.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        amount: { type: 'number' },
        supplier_id: { type: 'string' },
        entry_date: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['description', 'amount'],
    },
    handler: async (args) => require('./journalSuggestions').suggestJournalEntry(args),
  },

  // -------------------------------------------------------------------------
  // Invoice / bank matching
  // -------------------------------------------------------------------------
  {
    name: 'three_way_match_invoice',
    description:
      'Check a supplier invoice against its purchase order and the goods actually received, listing every discrepancy (amount variance, under-receipt, no goods receipt, supplier mismatch). Use before approving a bill for payment.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { supplier_invoice_id: { type: 'string', description: 'UUID of the supplier invoice' } },
      required: ['supplier_invoice_id'],
    },
    handler: async (args) => require('./invoiceMatching').threeWayMatch(args.supplier_invoice_id),
  },
  {
    name: 'get_invoice_match_exceptions',
    description:
      'List open supplier bills that do NOT cleanly match their PO and goods receipt — the accounts-payable exception worklist, showing which bills are blocked from payment and why.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    handler: async (args) =>
      require('./invoiceMatching').matchExceptionReport({ limit: Math.min(args.limit || 50, 200) }),
  },
  {
    name: 'suggest_bank_reconciliation_matches',
    description:
      'Rank likely matches between unreconciled bank transactions and open invoices, explaining each (amount agreement, document number quoted in the narrative, counterparty name). Flags ambiguous cases where two candidates score alike. Advisory only — it does not reconcile anything; use auto_reconcile_bank_account to actually apply unambiguous matches.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        bank_account_id: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    handler: async (args) =>
      require('./invoiceMatching').suggestBankMatches({
        bankAccountId: args.bank_account_id,
        limit: Math.min(args.limit || 25, 100),
      }),
  },

  // -------------------------------------------------------------------------
  // Natural-language reporting
  // -------------------------------------------------------------------------
  {
    name: 'query_erp_data',
    description:
      'Answer an ad-hoc reporting question by generating and running a read-only SQL query over the ERP reporting tables. Use this when no dedicated tool covers the question — e.g. an unusual grouping, filter or comparison. The query is validated against a table allowlist and executed read-only; credential columns are never returned. Prefer a dedicated tool when one exists, since those are exact.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'the business question in plain language' },
      },
      required: ['question'],
    },
    handler: async (args) => {
      const result = await require('./nlQuery').ask(args.question, { explain: false });
      // Keep tool output small: the agent gets the rows, not a megabyte of them.
      if (result.rows && result.rows.length > 100) {
        return { ...result, rows: result.rows.slice(0, 100), note: `Showing the first 100 of ${result.row_count} rows.` };
      }
      return result;
    },
  },

  // -------------------------------------------------------------------------
  // Chart generation (NL → chart spec → frontend renders Recharts inline)
  // -------------------------------------------------------------------------
  {
    name: 'generate_chart',
    description:
      'Create a live chart (line, bar, or pie) from a business question in plain language — e.g. "monthly revenue trend", "top 10 customers by sales", "AR aging breakdown". Generates safe read-only SQL, executes it, picks the best chart type from the actual column names and data, and returns a structured chart specification the chat UI renders inline as a Recharts chart. Prefer this over query_erp_data when the user clearly wants a visual.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The business question to chart, in plain language' },
        chart_type: { type: 'string', enum: ['line', 'bar', 'pie'], description: 'Optional chart type hint — omit to auto-detect' },
      },
      required: ['question'],
    },
    handler: async (args) => {
      const { ask } = require('./chartGenerator');
      const result = await ask(args.question, { chart_type: args.chart_type });
      if (result.error) return { error: result.error, chart_spec: null };
      // Store as an artifact so the chat UI renders it via the document/artifact pipeline.
      const { saveDocument } = require('../pdf/documentStore');
      const doc = await saveDocument(
        Buffer.from(JSON.stringify(result.chart_spec), 'utf8'),
        {
          title: result.chart_spec?.title || 'Chart',
          kind: 'artifact',
          contentType: 'chart',
          metadata: {
            chart_type: result.chart_spec?.chart_type,
            sql: result.sql,
          },
        }
      );
      const { artifactResult } = require('./artifactTools');
      return artifactResult(doc);
    },
  },
  {
    name: 'show_data',
    description:
      'Put part of a tool result in front of the reader, in the answer itself.\n\n'
      + 'You do not need this to make data available — every tool you call and everything it returns is already '
      + 'under a dropdown the reader can open. This is about emphasis: use it when a specific set of rows or figures '
      + 'IS the answer, and the reader should not have to go looking for it.\n\n'
      + 'Use it sparingly. Two or three rows that settle the question are worth showing; forty rows they did not ask '
      + 'for are worth leaving in the dropdown. If your sentence already contains the number, you probably do not need '
      + 'this at all.\n\n'
      + 'It takes a reference, never values: name a tool that ran this turn and which fields matter, and the numbers '
      + 'are read out of that stored result.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        from_tool: { type: 'string', description: 'A tool that already ran this turn' },
        as: { type: 'string', enum: ['table', 'figures'], description: 'figures for a scalar summary, table for rows. Default table.' },
        path: { type: 'string', description: 'Field holding the rows, e.g. "open_invoices". Omit to find them automatically.' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Which columns to show, in order. Omit for all.' },
        limit: { type: 'number', description: 'Rows to show, 1-25. Default 8.' },
        title: { type: 'string', description: 'Short heading — what the reader is looking at' },
        note: { type: 'string', description: 'One line on why this matters' },
      },
      required: ['from_tool'],
    },
    handler: async (args, ctx) => require('./dataSurfacing').show(args, ctx),
  },
  {
    name: 'render_chart',
    description:
      'Draw a chart you design yourself. Unlike generate_chart, which picks one of three preset types, this renders whatever '
      + 'visual you specify: several layers at once (an area under a line, bars beside it, a dashed forecast segment), reference '
      + 'lines, shaded x-ranges, annotations on particular points, a right-hand axis for a second scale.\n\n'
      + 'YOU DO NOT SUPPLY THE DATA. There is no data field. Give a "source" — either { query: "monthly revenue for 12 months" }, '
      + 'which is turned into safe read-only SQL and executed, or { from_tool: "get_ar_aging", path: "open_invoices" } to chart '
      + 'rows a tool already returned this turn. The rows are fetched and attached for you.\n\n'
      + 'Compose with layers. A cash forecast is: an area under the actuals, a solid line over them, a dashed line for the '
      + 'projected months (use "from"/"to" to limit a layer to part of the x range), a band shading the projection, and an '
      + 'annotation on the month that matters.\n\n'
      + 'Reference lines: prefer { agg: "avg"|"median"|"min"|"max", field: "..." }, which is computed from the real rows. A fixed '
      + '{ value: N } is only accepted with a "note" saying where the number came from — a threshold you invent is a claim about '
      + 'the company\'s finances.\n\n'
      + 'The result includes "warnings" listing anything that was dropped and the columns that actually exist. If there are '
      + 'warnings, fix the specification and call this again before answering — the user sees the chart you leave behind.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short chart title' },
        subtitle: { type: 'string', description: 'Optional line under the title — what the reader should take from it' },
        source: {
          type: 'object',
          description: 'Where the rows come from. Exactly one of query or from_tool.',
          properties: {
            query: { type: 'string', description: 'A business question, executed as read-only SQL' },
            from_tool: { type: 'string', description: 'Name of a tool that already ran this turn' },
            path: { type: 'string', description: 'Field inside that tool result holding the rows, e.g. "open_invoices"' },
          },
        },
        x: {
          type: 'object',
          properties: {
            field: { type: 'string', description: 'Column for the x axis' },
            label: { type: 'string' },
            type: { type: 'string', enum: ['category', 'temporal', 'quantitative'] },
          },
          required: ['field'],
        },
        y: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            zero: { type: 'boolean', description: 'Start the axis at zero. Default true — a truncated axis exaggerates a change.' },
            format: { type: 'string', enum: ['number', 'compact', 'percent'] },
          },
        },
        layers: {
          type: 'array',
          description: 'Drawn in order, back to front. Several layers may share a field.',
          items: {
            type: 'object',
            properties: {
              mark: { type: 'string', enum: ['line', 'area', 'bar', 'point', 'step'] },
              field: { type: 'string', description: 'Numeric column this layer draws' },
              label: { type: 'string', description: 'Legend label' },
              tone: { type: 'string', enum: ['blue', 'cyan', 'violet', 'magenta', 'indigo', 'green', 'amber', 'rose', 'slate'] },
              dashed: { type: 'boolean', description: 'Dashed stroke — conventionally, projected rather than actual' },
              points: { type: 'boolean', description: 'Mark each data point' },
              opacity: { type: 'number' },
              from: { description: 'Limit this layer to x values from here onward' },
              to: { description: 'Limit this layer to x values up to here' },
              axis: { type: 'string', enum: ['left', 'right'], description: 'Right for a second, differently-scaled series' },
              stack: { type: 'string', description: 'Bars sharing a stack name are stacked together' },
            },
            required: ['mark', 'field'],
          },
        },
        rules: {
          type: 'array',
          description: 'Horizontal reference lines.',
          items: {
            type: 'object',
            properties: {
              agg: { type: 'string', enum: ['avg', 'median', 'min', 'max', 'sum', 'first', 'last'] },
              field: { type: 'string', description: 'Column to aggregate, when agg is given' },
              value: { type: 'number', description: 'A fixed value — requires note' },
              label: { type: 'string' },
              note: { type: 'string', description: 'Where a fixed value came from. Required for value; optional for agg.' },
              tone: { type: 'string', enum: ['blue', 'cyan', 'violet', 'magenta', 'indigo', 'green', 'amber', 'rose', 'slate'] },
            },
          },
        },
        bands: {
          type: 'array',
          description: 'Shaded x ranges — a projection window, a closed period, a campaign.',
          items: {
            type: 'object',
            properties: {
              from: { description: 'x value the band starts at' },
              to: { description: 'x value the band ends at' },
              label: { type: 'string' },
              tone: { type: 'string' },
            },
            required: ['from', 'to'],
          },
        },
        annotations: {
          type: 'array',
          description: 'A note pinned to one point.',
          items: {
            type: 'object',
            properties: {
              x: { description: 'x value to pin to' },
              field: { type: 'string', description: 'Which series the note sits on' },
              text: { type: 'string' },
              tone: { type: 'string' },
            },
            required: ['x', 'text'],
          },
        },
        views: {
          type: 'array',
          description:
            'Alternative presentations of the SAME rows, offered to the reader as chips they can switch between — '
            + '"Actual vs budget", "By region", "Cumulative". Each carries its own layers/rules/bands/annotations and is '
            + 'checked against the same columns. Use this when one question genuinely has more than one useful view; do not '
            + 'pad a chart with views nobody asked for.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Chip text' },
              subtitle: { type: 'string' },
              layers: { type: 'array', items: { type: 'object' } },
              rules: { type: 'array', items: { type: 'object' } },
              bands: { type: 'array', items: { type: 'object' } },
              annotations: { type: 'array', items: { type: 'object' } },
            },
            required: ['label', 'layers'],
          },
        },
        stacked: { type: 'boolean' },
        legend: { type: 'boolean' },
        height: { type: 'number', description: 'Pixels, 160-520' },
      },
      required: ['source', 'x', 'layers'],
    },
    handler: async (args, ctx) => require('./chartAuthoring').render(args, ctx),
  },
  {
    name: 'suggest_visualization',
    description:
      'Given column names and a few sample rows of data, suggest the best chart type and axis mapping to visualise it. Returns { chart_type, x_key, y_keys, title }. Use this AFTER query_erp_data when you want to suggest a chart for data you already have; use generate_chart when the user asks for a chart up front and you need to both query AND visualise in one step.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The original business question the data answers' },
        columns: { type: 'array', items: { type: 'string' }, description: 'Column names from the query result' },
        sample_rows: { type: 'array', items: { type: 'object' }, description: 'First 3-5 rows of the query result' },
        chart_type: { type: 'string', enum: ['line', 'bar', 'pie'], description: 'Optional hint' },
      },
      required: ['question', 'columns', 'sample_rows'],
    },
    handler: async (args) => {
      const { inferChartSpec } = require('./chartGenerator');
      return inferChartSpec(args.question, args.columns, args.sample_rows, args.chart_type);
    },
  },
  {
    name: 'search_documents',
    description:
      'Semantic search over free text this ERP has indexed: sales/supplier contract terms and conditions, uploaded knowledge-base documents, generated PDF text, and past chat messages (this conversation and every other user\'s, company-scoped). This is NOT a search over the whole ERP — it does not see structured tables (use query_erp_data for that) and it only covers content that has actually been indexed. ' +
      'If nothing has been indexed yet, this returns indexed:false with a note rather than a real result, so never report a plain "no results" as if a genuine search ran — check the indexed field first. An administrator can index or re-index via POST /api/ai-tools/reindex-documents.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for, in plain language' },
        source_type: { type: 'string', description: 'Optional: restrict to "sales_contract", "generated_document", "kb_document", or "chat_message"' },
        limit: { type: 'number', description: 'Max chunks to return (default 8, max 50)' },
      },
      required: ['query'],
    },
    handler: async (args) =>
      require('./documentSearch').search(args.query, {
        limit: args.limit,
        source_type: args.source_type || undefined,
      }),
  },

  // -------------------------------------------------------------------------
  // Record-level similarity search (migration 202608070200 — pgvector(384)
  // columns, HNSW-indexed, searched with the <=> operator; see
  // services/ai/embeddings.js)
  // -------------------------------------------------------------------------
  {
    name: 'search_similar_purchase_orders',
    description:
      'Semantic similarity search over purchase orders (supplier, line items, terms) ranked by cosine similarity. Use to find POs like a described one — e.g. "other orders from this supplier for similar parts" or spotting a possible duplicate PO before creating a new one. Only searches POs that have been embedded (see backend/scripts/backfill-embeddings.js) — an empty result may mean nothing matched, not that nothing was indexed.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for, in plain language' },
        limit: { type: 'number', description: 'Max results (default 10, max 50)' },
      },
      required: ['query'],
    },
    handler: async (args) => {
      const { generateEmbedding, toVectorLiteral } = require('./embeddings');
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
      const vector = toVectorLiteral(await generateEmbedding(args.query));
      const { rows } = await pool.query(
        `SELECT po.id, po.po_number, po.status, po.currency, po.total_amount, po.po_date,
                s.legal_name AS supplier_name, 1 - (po.embedding <=> $1::vector) AS score
           FROM purchase_orders po
           LEFT JOIN suppliers s ON s.id = po.supplier_id
          WHERE po.embedding IS NOT NULL
          ORDER BY po.embedding <=> $1::vector ASC
          LIMIT $2`,
        [vector, limit]
      );
      return { query: args.query, count: rows.length, results: rows };
    },
  },
  {
    name: 'search_similar_sales_orders',
    description:
      'Semantic similarity search over sales orders (customer, line items, notes) ranked by cosine similarity. Use to find SOs like a described one — e.g. recurring orders from the same customer or a possible duplicate order. Only searches SOs that have been embedded — an empty result may mean nothing matched, not that nothing was indexed.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for, in plain language' },
        limit: { type: 'number', description: 'Max results (default 10, max 50)' },
      },
      required: ['query'],
    },
    handler: async (args) => {
      const { generateEmbedding, toVectorLiteral } = require('./embeddings');
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
      const vector = toVectorLiteral(await generateEmbedding(args.query));
      const { rows } = await pool.query(
        `SELECT id, so_number, customer_name, status, currency, total_amount, order_date,
                1 - (embedding <=> $1::vector) AS score
           FROM sales_orders
          WHERE embedding IS NOT NULL AND deleted_at IS NULL
          ORDER BY embedding <=> $1::vector ASC
          LIMIT $2`,
        [vector, limit]
      );
      return { query: args.query, count: rows.length, results: rows };
    },
  },
  {
    name: 'search_similar_inventory_items',
    description:
      'Semantic similarity search over stocked inventory items (item name/description/category, condition) ranked by cosine similarity. Use to find items like a described one, or spot a likely duplicate stock record. Only searches items that have been embedded — an empty result may mean nothing matched, not that nothing was indexed.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for, in plain language' },
        limit: { type: 'number', description: 'Max results (default 10, max 50)' },
      },
      required: ['query'],
    },
    handler: async (args) => {
      const { generateEmbedding, toVectorLiteral } = require('./embeddings');
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
      const vector = toVectorLiteral(await generateEmbedding(args.query));
      const { rows } = await pool.query(
        `SELECT ii.id, im.item_code, im.name, im.description, im.category,
                ii.status, ii.current_stock_quantity, 1 - (ii.embedding <=> $1::vector) AS score
           FROM inventory_items ii
           LEFT JOIN items im ON im.id = ii.item_master_id
          WHERE ii.embedding IS NOT NULL
          ORDER BY ii.embedding <=> $1::vector ASC
          LIMIT $2`,
        [vector, limit]
      );
      return { query: args.query, count: rows.length, results: rows };
    },
  },

  // -------------------------------------------------------------------------
  // AI usage / cost
  // -------------------------------------------------------------------------
  {
    name: 'get_ai_usage_summary',
    description:
      'Report how much the AI agent has actually cost to run: real token usage and estimated USD cost, aggregated by day or by user. IMPORTANT: estimated_cost_usd is null (never 0) for any model whose price is not in the known pricing table — that means the cost genuinely could not be estimated, not that it was free. If a returned summary includes calls_without_cost_estimate > 0, or a "note" field, always relay that caveat to the user rather than silently reporting the estimated total as if it covered every call.',
    readOnly: true,
    min_role: 'MANAGER',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'lookback window in days (default 30)' },
        group_by: { type: 'string', enum: ['day', 'user'], description: 'default "day"' },
      },
    },
    handler: async (args) => {
      const days = Math.min(Math.max(parseInt(args.days, 10) || 30, 1), 365);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      return require('./usageTracking').getUsageSummary({ since, groupBy: args.group_by });
    },
  },

  // -------------------------------------------------------------------------
  // Audit-trail / controls analysis
  // -------------------------------------------------------------------------
  {
    name: 'analyze_audit_trail',
    description:
      'Run internal-control tests over the audit trail: segregation-of-duties breaches (same person created and approved), amounts sized just under approval thresholds, off-hours and weekend postings, backdated entries, round-number amounts, and a Benford\'s-law screen. These are INDICATORS with innocent explanations, never proof of wrongdoing — always relay the innocent_explanation and disclaimer alongside any finding, and never assert that a named person did something wrong.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { months: { type: 'number', description: 'lookback window (default 12)' } },
    },
    handler: async (args) =>
      require('./auditAnalysis').analyzeAuditTrail({ months: Math.min(args.months || 12, 60) }),
  },

  // -------------------------------------------------------------------------
  // Predictive inventory
  // -------------------------------------------------------------------------
  {
    name: 'predict_inventory_reorders',
    description:
      'Predict when each inventory item will run out and when an order must be placed, from real goods-issue consumption and supplier lead times. Returns days of cover, projected stockout date, a demand- and volatility-based reorder point, and an order-by date, ranked by urgency (STOCKED_OUT/CRITICAL/ORDER_NOW/PLAN). Richer than list_low_stock_items, which only compares stock to a static threshold. Items lacking movement history are marked sufficient_history:false — do not present those figures as forecasts.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        months: { type: 'number', description: 'months of consumption history (default 6)' },
        horizon_days: { type: 'number', description: 'planning horizon (default 90)' },
      },
    },
    handler: async (args) =>
      require('./demandForecast').predictReorders({
        months: Math.min(args.months || 6, 36),
        horizonDays: Math.min(args.horizon_days || 90, 365),
      }),
  },
  // -------------------------------------------------------------------------
  // Manufacturing
  // -------------------------------------------------------------------------
  {
    name: 'list_work_orders',
    description:
      'List manufacturing work orders with their status, quantities produced/scrapped and accumulated work-in-progress value.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] },
      },
    },
    handler: async (args) => {
      const orders = await require('../../models/WorkOrder').findAll({ status: args.status });
      return { count: orders.length, work_orders: orders };
    },
  },
  {
    name: 'explode_bill_of_material',
    description:
      'Expand a bill of material to the total quantity of every component needed to build a given quantity of an item, including sub-assemblies and scrap allowances. Use to answer "what do we need to build N of these?".',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: 'UUID of the item to build' },
        quantity: { type: 'number' },
      },
      required: ['item_id'],
    },
    handler: async (args) =>
      require('../../models/BillOfMaterial').explode(args.item_id, args.quantity || 1),
  },
  {
    name: 'run_mrp',
    description:
      'Run material requirements planning: nets demand from sales orders and reorder points against stock and existing orders, explodes bills of material level by level, and returns what must be made or bought. Returns proposals only — it does not create work orders or requisitions.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        horizon_days: { type: 'number', description: 'demand horizon (default 90)' },
      },
    },
    handler: async (args) =>
      require('../mrpService').runMrp({
        horizonDays: Math.min(args.horizon_days || 90, 365),
        // Never persist from the conversational surface: a planning run invoked
        // by chat should not leave rows behind for someone else to act on.
        persist: false,
      }),
  },

  // -------------------------------------------------------------------------
  // Autonomous agent oversight
  //
  // The chat agent can inspect what the unattended agents have been doing and
  // what they are waiting on, but cannot enable one or widen its authority —
  // granting autonomy is a human administrative act, deliberately kept off the
  // conversational surface where prompt injection could reach it.
  // -------------------------------------------------------------------------
  {
    name: 'list_autonomous_agents',
    description:
      'List the autonomous background agents, their mode (observe/propose/act), whether they are enabled, their authority limits and the outcome of their last run.',
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const list = await require('../agents').listAgents();
      return {
        agents: list.map((a) => ({
          agent_key: a.agent_key,
          name: a.display_name,
          domain: a.domain,
          enabled: a.enabled,
          mode: a.mode,
          authority: a.authority_description,
          last_run_at: a.last_run_at,
          last_status: a.last_status,
          last_summary: a.last_summary,
        })),
      };
    },
  },
  {
    name: 'get_agent_activity',
    description:
      'Recent autonomous agent runs, with what each one observed, actioned, escalated or failed. Use to answer "what have the agents been doing?" or to explain why something was changed automatically.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        agent_key: { type: 'string', description: 'optional — restrict to one agent' },
        limit: { type: 'number' },
      },
    },
    handler: async (args) => {
      const agentsSvc = require('../agents');
      const runs = await agentsSvc.listRuns({ agentKey: args.agent_key, limit: Math.min(args.limit || 20, 50) });
      return { runs };
    },
  },
  {
    name: 'list_agent_escalations',
    description:
      'Items an autonomous agent decided it was NOT authorised to handle and passed to a human — e.g. a payment above its limit or an ambiguous bank match. These are waiting on a person, so surface them when asked what needs attention.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['OPEN', 'APPROVED', 'REJECTED'] } },
    },
    handler: async (args) => {
      const escalations = await require('../agents').listEscalations({ status: args.status || 'OPEN' });
      return { count: escalations.length, escalations };
    },
  },
  {
    name: 'run_agent_dry_run',
    description:
      'Execute an autonomous agent in DRY RUN mode: it detects and reports exactly what it would do, without changing anything. Safe to call to preview an agent\'s behaviour. It cannot perform real actions through this tool.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { agent_key: { type: 'string' } },
      required: ['agent_key'],
    },
    handler: async (args, ctx) => {
      // Hard-coded dryRun — this tool is never a route to real action.
      const result = await require('../agents').runAgent(args.agent_key, {
        trigger: 'manual',
        triggeredBy: ctx.userId || null,
        dryRun: true,
        force: true,
      });
      const detail = result.run_id ? await require('../agents').getRun(result.run_id) : null;
      return {
        ...result,
        would_do: (detail?.actions || []).map((a) => ({
          decision: a.decision,
          action: a.action_type,
          entity: a.entity_label,
          amount: a.amount,
          rationale: a.rationale,
        })),
      };
    },
  },
  {
    name: 'recommend_reorder_points',
    description:
      'Identify inventory items whose configured reorder point disagrees materially with observed demand — either too low (risking stockouts before replenishment arrives) or too high (tying up working capital in dead stock).',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { months: { type: 'number', description: 'months of history (default 6)' } },
    },
    handler: async (args) =>
      require('./demandForecast').reorderPointRecommendations({ months: Math.min(args.months || 6, 36) }),
  },
];

// Tool groups defined in their own modules, so this file does not become the
// only place a tool can live. They are appended before `byName` is built, which
// is what makes them indistinguishable from the definitions above at call time.
tools.push(...require('./pdfTools').pdfTools);
tools.push(...require('./artifactTools').artifactTools);
tools.push(...require('./externalTools').externalTools);
tools.push(...require('./metaTools').metaTools);
// CRM and Projects — two modules the agent could not see at all until these.
tools.push(...require('./crmProjectTools').crmProjectTools);
// Entity resolution and record history: naming things, and what happened to them.
tools.push(...require('./groundingTools').groundingTools);
// Why a number moved, decomposed from the ledger rather than guessed at.
tools.push(...require('./varianceTools').varianceTools);
// Why gross margin moved: purchase price, discounting, scrap, mix — and the RFQ it can draft.
tools.push(...require('./marginTools').marginTools);
// Why sales moved: customer by customer — lapsed, buying less, price or volume — and the calls their owners make.
tools.push(...require('./revenueTools').revenueTools);
// Why spending moved: supplier by supplier — price, volume, bills with no order — and the re-quotes and questions it prepares.
tools.push(...require('./spendTools').spendTools);
// Why a delivery will be late: order -> stock -> work order / purchase order -> cause.
tools.push(...require('./deliveryRiskTools').deliveryRiskTools);
// One order and everything behind it: customer credit, stock, supplier, PO, invoice, margin.
tools.push(...require('./orderChainTools').orderChainTools);
// Can we ship this on that day: per line free, short, first day in full, and the supplier who lands in time.
tools.push(...require('./promiseTools').promiseTools);
// Orders checked the moment they land: which came in short, and the purchase order a person drafts from it.
tools.push(...require('./orderWatchTools').orderWatchTools);
// An invoice arrives twice: the same supplier's other bills, the order, the receipts, the payments — and the hold a person places.
tools.push(...require('./billedTwiceTools').billedTwiceTools);
// Which steps of order to cash and procure to pay move, which are stuck, and on what.
tools.push(...require('./processFlowTools').processFlowTools);
// Which line slowed, what it costs, which orders it puts at risk.
tools.push(...require('./lineWatchTools').lineWatchTools);
// Where cash dips in the next 13 weeks, why, and the reminders a person sends to lift it.
tools.push(...require('./cashOutlookTools').cashOutlookTools);
// Which suppliers are a risk, why, and which orders their lateness reaches.
tools.push(...require('./supplierRiskTools').supplierRiskTools);
// What we did the last times a supplier was late, whether it worked, and the split order to repeat it.
tools.push(...require('./supplierMemoryTools').supplierMemoryTools);
// An item running low: when it runs out, who can bring more in time, how many, budget left, who approves.
tools.push(...require('./replenishmentTools').replenishmentTools);
// Every bay, how long it lasts, and the orders a short one puts at risk.
tools.push(...require('./warehouseTwinTools').warehouseTwinTools);
// What is waiting on a person, what it is worth, what it is holding up.
tools.push(...require('./decisionTools').decisionTools);
// Who the business waits on, who is away when, and what an absence holds up.
tools.push(...require('./peopleCoverageTools').peopleCoverageTools);
// What the business runs on — lines, sites, systems, equipment — and what stops if one of them does.
tools.push(...require('./runsOnTools').runsOnTools);
// What needs a person today: every watcher run as the asker, one problem shown once, most money first.
tools.push(...require('./whatMattersTools').whatMattersTools);
// What the company built in Sandbox, read as part of the business and tied to what it reaches.
tools.push(...require('./builtSignalsTools').builtSignalsTools);
// The whole business on one map: every part, what depends on what, and the problem that crosses the most of it.
tools.push(...require('./businessMapTools').businessMapTools);
// The write surface: drafts and follow-ups, never approvals or postings.
tools.push(...require('./actionTools').actionTools);
// Files a person brought into one conversation.
tools.push(...require('./attachments').attachmentTools);
// Generic writes to any business table, gated like every other write.
tools.push(...require('./databaseWriteTools').databaseWriteTools);
// Counterfactual decisions: courses of action applied to the real ledger inside
// a rolled-back transaction, so the outcome is measured rather than predicted.
tools.push(...require('./counterfactualTools').counterfactualTools);
// Generated applications: what this company had built for itself, and the
// records inside it. Read-only, and answered as the person asking — a question
// put to Simeli is not a way to read past your own permissions, and there is
// deliberately no tool here that writes an application record or deploys one.
tools.push(...require('./platformTools').platformTools);
// Sandbox: a capability described in a sentence, designed and rehearsed as a
// draft for an administrator (or requested of one). Deploying stays in the Studio.
tools.push(...require('./sandboxBuildTools').sandboxBuildTools);
// Agents earn authority from measured outcomes: what people approved, changed or
// rejected of their work. Granting stays a manager's confirmation.
tools.push(...require('./agentTrackRecordTools').agentTrackRecordTools);

const byName = new Map(tools.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// Audit logging
// ---------------------------------------------------------------------------
async function logToolCall({ actor, userId, toolName, args, readOnly, success, resultSummary, error }) {
  try {
    await pool.query(
      `INSERT INTO ai_audit_log (actor, user_id, tool_name, arguments, read_only, success, result_summary, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [actor || 'ai-agent', userId || null, toolName, args ? JSON.stringify(args) : null, !!readOnly, !!success,
       resultSummary ? String(resultSummary).slice(0, 2000) : null, error ? String(error).slice(0, 2000) : null]
    );
  } catch (_) { /* never let audit logging break a tool call */ }
}

// OpenAI-compatible tool specs (for chat.completions / responses tools param).
function getOpenAITools() {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

// MCP-compatible tool specs.
function getMcpTools() {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, readOnly: t.readOnly }));
}

/**
 * Turn a database error into something the model can act on.
 *
 * When Simeli passes a name where a tool wants an id — and it does, because a
 * person asks about "the Vestas deal", not about a UUID — Postgres answers
 * `invalid input syntax for type uuid: "Vestas"`. That is a true statement and
 * a useless one: it names no tool, no argument, and no way forward, so the run
 * either stalls or the model guesses again. The person meanwhile sees database
 * jargon in red inside their investigation.
 *
 * resolve_entity exists precisely for this — a name in, an id out — so the
 * error says which argument was wrong, what it should have been, and which
 * tool turns one into the other. Nothing is invented: the offending value is
 * the one Postgres quoted back, matched against the arguments actually sent.
 */
const TYPE_WORDS = { uuid: 'record id', date: 'date', timestamp: 'date and time', numeric: 'number', integer: 'whole number' };

function readable(err, toolName, args) {
  if (err?.code !== '22P02') return err;

  const m = /invalid input syntax for type (\w+): "([^"]*)"/.exec(err.message || '');
  if (!m) return err;
  const [, pgType, value] = m;
  const kind = TYPE_WORDS[pgType] || pgType;

  const argName = Object.keys(args || {}).find((k) => String(args[k]) === value);
  const where = argName ? `\`${argName}\`` : 'one of its arguments';

  const rewritten = new Error(
    `${toolName} needs a ${kind} for ${where}, and was given "${value}". `
    + (pgType === 'uuid'
      ? 'Call resolve_entity with that name first and pass the id it returns.'
      : `Pass a valid ${kind}.`)
  );
  rewritten.code = err.code;
  rewritten.cause = err;
  return rewritten;
}

// Execute a tool by name with audit logging + guardrails.
async function executeTool(name, args = {}, ctx = {}) {
  const tool = byName.get(name);
  if (!tool) {
    await logToolCall({ ...ctx, toolName: name, args, readOnly: true, success: false, error: 'unknown tool' });
    throw new Error(`Unknown tool: ${name}`);
  }
  try {
    const result = await tool.handler(args, ctx);
    await logToolCall({
      actor: ctx.actor, userId: ctx.userId, toolName: name, args,
      readOnly: tool.readOnly, success: true,
      resultSummary: typeof result === 'object' ? JSON.stringify(result).slice(0, 500) : String(result),
    });
    return result;
  } catch (err) {
    const shown = readable(err, name, args);
    await logToolCall({ actor: ctx.actor, userId: ctx.userId, toolName: name, args, readOnly: tool.readOnly, success: false, error: err.message });
    throw shown;
  }
}

module.exports = { tools, byName, executeTool, getOpenAITools, getMcpTools, logToolCall, readable };
