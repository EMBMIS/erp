import {
  HomeIcon, EnvelopeIcon, CubeIcon, ShoppingCartIcon, BanknotesIcon, UsersIcon, SparklesIcon,
  WrenchScrewdriverIcon, UserGroupIcon, BriefcaseIcon, ChartBarIcon, Squares2X2Icon,
  InboxStackIcon, CheckBadgeIcon, LightBulbIcon, CpuChipIcon, Cog6ToothIcon, PresentationChartLineIcon,
} from '@heroicons/react/24/outline'

/**
 * The navigation model.
 *
 * Two layers, as before:
 *
 * 1. `navigationSections` is the AUTHORING model — every screen, grouped the
 *    way the routes were built. Item and child `name`s are also identities:
 *    module gating (admin → Modules) matches them against `nav_section` and
 *    module names stored in the database, and `area` decides which roles see
 *    a section at all (constants/permissions.js). Do not rename an entry
 *    without renaming its module row.
 *
 * 2. `RAIL` is how people WORK, and what the shell draws:
 *      Operate     the departments a business runs in
 *      Act         what is waiting on me, and how I ask
 *      Understand  numbers, reports, findings
 *      Build       applications, agents, automation
 *    Each rail entry names the authoring items it is projected from, so role
 *    gating and module toggles carry through untouched: a rail entry whose
 *    sources were all filtered out disappears.
 *
 * `maturity` labels features that are not production-ready (see
 * ERP_HONEST_AUDIT.md and docs/design/HANDOFF.md). They show in the rail and on
 * the page, so nobody discovers it by losing work.
 */
export const navigationSections = [
  {
    section: 'Overview',
    items: [
      { name: 'Dashboard', href: '/' },
      { name: 'Mail', href: '/mail' },
    ],
  },
  {
    section: 'Operations',
    items: [
      {
        name: 'Inventory',
        children: [
          { name: 'Inventory Overview', href: '/inventory' },
          { name: 'Inventory Items', href: '/inventory/items' },
          { name: 'Item Master', href: '/items' },
          { name: 'Warehouse', href: '/warehouse', maturity: 'preview' },
          { name: 'Warehouse Transactions', href: '/warehouse/transactions' },
          { name: 'Inventory Transfers', href: '/warehouse/transfers' },
          { name: 'Stocktake / Counting', href: '/stocktake' },
          { name: 'Barcode Scanning', href: '/inventory/barcode-scanner' },
        ],
      },
      {
        name: 'Procurement',
        children: [
          { name: 'Procurement Dashboard', href: '/procurement' },
          { name: 'Purchase Orders', href: '/procurement/purchase-orders' },
          { name: 'Purchase Requisitions', href: '/procurement/purchase-requisitions' },
          { name: 'Request for Quotations', href: '/procurement/rfqs' },
          { name: 'Suppliers', href: '/procurement/suppliers' },
          { name: 'Contracts', href: '/procurement/contracts' },
        ],
      },
      {
        name: 'Sales',
        children: [
          { name: 'Sales Overview', href: '/sales/overview' },
          { name: 'Sales Orders', href: '/sales/sales-orders' },
          { name: 'Sales Quotations', href: '/sales/quotations' },
          { name: 'Customers', href: '/sales/customers' },
          { name: 'Sales Contracts', href: '/sales/contracts' },
          { name: 'RFQ to Suppliers', href: '/sales/rfqs' },
          { name: 'Delivery Schedules', href: '/sales/delivery-schedules' },
        ],
      },
      {
        name: 'Manufacturing',
        children: [
          { name: 'Manufacturing Overview', href: '/manufacturing' },
          { name: 'Work Orders', href: '/manufacturing/work-orders' },
          { name: 'Bills of Material', href: '/manufacturing/boms' },
          { name: 'MRP II Workbench', href: '/manufacturing/mrp-workbench' },
          { name: 'Work Centers & Routing', href: '/manufacturing/work-centers' },
        ],
      },
    ],
  },
  {
    section: 'Customers & Delivery',
    items: [
      {
        name: 'CRM',
        children: [
          { name: 'CRM Overview', href: '/crm/overview' },
          { name: 'Leads', href: '/crm/leads' },
          { name: 'Deal Pipeline', href: '/crm/pipeline' },
          { name: 'Contacts', href: '/crm/contacts' },
          { name: 'Activities', href: '/crm/activities' },
        ],
      },
      {
        name: 'Projects',
        children: [
          { name: 'Projects Overview', href: '/projects/overview' },
          { name: 'All Projects', href: '/projects' },
          { name: 'My Timesheet', href: '/projects/timesheet' },
        ],
      },
    ],
  },
  {
    section: 'Financials',
    area: 'finance',
    items: [
      { name: 'Finance Overview', href: '/finance/overview' },
      {
        name: 'General Ledger',
        children: [
          { name: 'Chart of Accounts', href: '/finance/chart-of-accounts' },
          { name: 'Journal Entries', href: '/finance/journal-entries' },
        ],
      },
      {
        name: 'Receivables (AR)',
        children: [
          { name: 'Customer Invoices', href: '/finance/customer-invoices' },
          { name: 'Recurring Invoices', href: '/finance/recurring-invoices' },
          { name: 'Payments Received', href: '/finance/customer-payments' },
        ],
      },
      {
        name: 'Payables (AP)',
        children: [
          { name: 'Supplier Invoices', href: '/finance/supplier-invoices' },
          { name: 'Credit Notes', href: '/finance/credit-notes' },
          { name: 'Supplier Payments', href: '/finance/supplier-payments' },
        ],
      },
      {
        name: 'Assets & Cash',
        children: [
          { name: 'Fixed Assets', href: '/finance/fixed-assets' },
          { name: 'Bank Reconciliation', href: '/finance/bank' },
          { name: 'Cash Flow Forecast', href: '/finance/cash-forecast' },
        ],
      },
      {
        name: 'Controlling',
        children: [
          { name: 'Cost Centers', href: '/finance/cost-centers' },
          { name: 'Budgets', href: '/finance/budgets' },
          { name: 'Currencies & FX', href: '/finance/currencies' },
          { name: 'Accounting Periods', href: '/finance/periods', maturity: 'beta' },
        ],
      },
      {
        name: 'Reports',
        children: [
          { name: 'Trial Balance', href: '/finance/reports/trial-balance' },
          { name: 'Balance Sheet', href: '/finance/reports/balance-sheet' },
          { name: 'Income Statement', href: '/finance/reports/income-statement' },
          { name: 'Cash Flow Statement', href: '/finance/reports/cash-flow-statement' },
          { name: 'Aging (AR/AP)', href: '/finance/reports/aging' },
          { name: 'GR/IR Aging', href: '/finance/gr-ir-aging' },
          { name: 'VAT Return', href: '/finance/reports/vat' },
          { name: 'Year-End Close Wizard', href: '/finance/year-end-close', maturity: 'beta' },
        ],
      },
    ],
  },
  {
    section: 'Human Resources',
    area: 'hr',
    items: [
      {
        name: 'HR & Payroll',
        children: [
          { name: 'HR Overview', href: '/hr/overview' },
          { name: 'Employees', href: '/hr/employees' },
          { name: 'Leave & Attendance', href: '/hr/leave-attendance' },
          { name: 'Payroll', href: '/hr/payroll' },
        ],
      },
    ],
  },
  {
    section: 'Intelligence',
    items: [
      {
        name: 'Analytics',
        children: [
          { name: 'Analytics Overview', href: '/analytics/overview' },
          { name: 'All Reports', href: '/reports' },
          { name: 'Dashboards', href: '/reports/dashboards' },
          { name: 'Scheduled Reports', href: '/reports/schedules' },
        ],
      },
      {
        name: 'Simeli AI',
        children: [
          { name: 'AI Chat', href: '/ai/chat' },
          { name: 'Simeli Overview', href: '/ai/overview' },
          { name: 'Decision Simulator', href: '/ai/decisions', maturity: 'preview' },
          { name: 'Business Intelligence', href: '/ai/business-intelligence', maturity: 'beta' },
          { name: 'Transaction Analysis', href: '/ai/transaction-analysis', maturity: 'beta' },
          { name: 'AI Anomaly Resolution', href: '/ai/findings', maturity: 'beta' },
          { name: 'Autonomous Agents', href: '/agents', maturity: 'beta' },
          { name: 'Build an Agent', href: '/ai/agents/new', maturity: 'beta' },
          { name: 'Tool Library', href: '/ai/tools' },
          { name: 'Documents & Templates', href: '/ai/documents' },
          { name: 'Knowledge Base', href: '/ai/knowledge-base' },
          { name: 'AI Governance', href: '/ai/governance' },
          { name: 'AI Settings', href: '/ai/settings' },
        ],
      },
    ],
  },
  {
    section: 'Applications',
    items: [
      {
        name: 'Applications',
        children: [
          { name: 'All Applications', href: '/applications' },
          { name: 'Capability Studio', href: '/studio', maturity: 'beta' },
          { name: 'Opportunities', href: '/capability-opportunities', maturity: 'beta' },
          { name: 'Marketplace', href: '/marketplace', maturity: 'preview' },
        ],
      },
    ],
  },
  {
    section: 'Governance',
    area: 'approvals',
    items: [
      {
        name: 'Delegation of Authority',
        children: [
          { name: 'Approval Inbox', href: '/approvals/unified' },
          { name: 'DOA Overview', href: '/doa/overview' },
          { name: 'DOA Management', href: '/delegation-of-authority' },
          { name: 'Approval Simulator', href: '/approvals/simulate' },
          { name: 'Audit Trail', href: '/admin/audit-trail' },
        ],
      },
    ],
  },
  {
    section: 'Administration',
    area: 'admin',
    items: [
      {
        name: 'Admin',
        children: [
          { name: 'Settings Overview', href: '/admin/overview' },
          { name: 'User Management', href: '/admin/users' },
          { name: 'Modules', href: '/admin/modules' },
          { name: 'Integrations', href: '/admin/integrations' },
          { name: 'AI Gateway', href: '/admin/gateway' },
          { name: 'Mailboxes', href: '/admin/mailboxes' },
          { name: 'Mail Design', href: '/admin/mail-design' },
          { name: 'App Statistics', href: '/admin/statistics', ownerOnly: true },
        ],
      },
    ],
  },
]

/** pick: limit a source item's children to these names (in this order). */
export const RAIL = [
  {
    group: 'Operate',
    items: [
      { key: 'home', label: 'Home', icon: HomeIcon, href: '/', exact: true, always: true },
      { key: 'sales', label: 'Sales', icon: ShoppingCartIcon, href: '/sales/overview', match: ['/sales'], sources: ['Sales'] },
      { key: 'procurement', label: 'Procurement', icon: InboxStackIcon, href: '/procurement', match: ['/procurement'], sources: ['Procurement'] },
      { key: 'inventory', label: 'Inventory', icon: CubeIcon, href: '/inventory', match: ['/inventory', '/items', '/warehouse', '/stocktake'], sources: ['Inventory'] },
      { key: 'manufacturing', label: 'Manufacturing', icon: WrenchScrewdriverIcon, href: '/manufacturing', match: ['/manufacturing'], sources: ['Manufacturing'] },
      { key: 'finance', label: 'Finance', icon: BanknotesIcon, href: '/finance/overview', match: ['/finance'], sources: ['Finance Overview', 'General Ledger', 'Receivables (AR)', 'Payables (AP)', 'Assets & Cash', 'Controlling'] },
      { key: 'crm', label: 'CRM', icon: UserGroupIcon, href: '/crm/overview', match: ['/crm'], sources: ['CRM'] },
      { key: 'projects', label: 'Projects', icon: BriefcaseIcon, href: '/projects/overview', match: ['/projects'], sources: ['Projects'] },
      { key: 'hr', label: 'People', icon: UsersIcon, href: '/hr/overview', match: ['/hr'], sources: ['HR & Payroll'] },
    ],
  },
  {
    group: 'Act',
    items: [
      { key: 'work', label: 'My work', icon: CheckBadgeIcon, href: '/my-work', match: ['/my-work'], always: true, badge: 'work' },
      { key: 'approvals', label: 'Approvals', icon: InboxStackIcon, href: '/approvals/unified', match: ['/approvals'], sources: ['Delegation of Authority'], pick: ['Approval Inbox', 'Approval Simulator'] },
      { key: 'mail', label: 'Mail', icon: EnvelopeIcon, href: '/mail', match: ['/mail'], sources: ['Mail'] },
      { key: 'simeli', label: 'Ask Simeli', icon: SparklesIcon, href: '/ai/chat', match: ['/ai/chat'], sources: ['Simeli AI'], pick: ['AI Chat'], leaf: true },
    ],
  },
  {
    group: 'Understand',
    items: [
      { key: 'reports', label: 'Reports', icon: PresentationChartLineIcon, href: '/analytics/overview', match: ['/analytics', '/reports'], sources: ['Analytics', 'Reports'] },
      { key: 'insights', label: 'Insights', icon: LightBulbIcon, href: '/ai/overview', match: ['/ai/overview', '/ai/business-intelligence', '/ai/transaction-analysis', '/ai/findings', '/ai/decisions'], sources: ['Simeli AI'], pick: ['Simeli Overview', 'Business Intelligence', 'Transaction Analysis', 'AI Anomaly Resolution', 'Decision Simulator'] },
    ],
  },
  {
    group: 'Build',
    items: [
      { key: 'applications', label: 'Applications', icon: Squares2X2Icon, href: '/applications', match: ['/applications', '/studio', '/capability-opportunities', '/marketplace'], sources: ['Applications'] },
      { key: 'agents', label: 'Agents & tools', icon: CpuChipIcon, href: '/agents', match: ['/agents', '/ai/agents', '/ai/tools', '/ai/documents', '/ai/knowledge-base'], sources: ['Simeli AI'], pick: ['Autonomous Agents', 'Build an Agent', 'Tool Library', 'Documents & Templates', 'Knowledge Base'] },
      // Deployed applications are appended here at runtime (one entry each).
    ],
  },
]

export const RAIL_FOOT = {
  key: 'settings', label: 'Settings', icon: Cog6ToothIcon, href: '/admin/overview',
  match: ['/admin', '/doa', '/delegation-of-authority', '/ai/governance', '/ai/settings', '/system'],
  sources: ['Admin', 'Delegation of Authority', 'Simeli AI'],
  pick: ['Settings Overview', 'User Management', 'Modules', 'Integrations', 'Mailboxes', 'Mail Design', 'SaaS Plan & Billing', 'App Statistics', 'DOA Overview', 'DOA Management', 'Audit Trail', 'AI Governance', 'AI Settings'],
  extra: [{ name: 'Design System', href: '/system' }],
  always: true,
}

export const icons = { ChartBarIcon }

/** Quick actions for the command palette. `area` gates them like sections. */
export const QUICK_ACTIONS = [
  { id: 'new-po', title: 'New purchase order', href: '/procurement/purchase-orders/create', keywords: 'create po buy order supplier', module: 'Procurement' },
  { id: 'new-pr', title: 'New purchase requisition', href: '/procurement/purchase-requisitions/create', keywords: 'request pr', module: 'Procurement' },
  { id: 'new-supplier', title: 'New supplier', href: '/procurement/suppliers/create', keywords: 'vendor create', module: 'Procurement' },
  { id: 'receive', title: 'Receive goods', href: '/warehouse/transactions/goods-receipt', keywords: 'goods receipt grn inbound', module: 'Inventory' },
  { id: 'issue', title: 'Issue goods', href: '/warehouse/transactions/goods-issue', keywords: 'goods issue outbound ship pick', module: 'Inventory' },
  { id: 'new-item', title: 'New item master', href: '/items/create', keywords: 'create product sku', module: 'Inventory' },
  { id: 'new-so', title: 'New sales order', href: '/sales/sales-orders/create', keywords: 'create so sell order customer', module: 'Sales' },
  { id: 'new-quote', title: 'New sales quotation', href: '/sales/quotations/create', keywords: 'quote proposal', module: 'Sales' },
  { id: 'new-customer', title: 'New customer', href: '/sales/customers/create', keywords: 'client account create', module: 'Sales' },
  { id: 'new-je', title: 'New journal entry', href: '/finance/journal-entries/create', keywords: 'je gl posting debit credit', module: 'Finance', area: 'finance' },
  { id: 'new-account', title: 'New ledger account', href: '/finance/chart-of-accounts/create', keywords: 'coa gl account', module: 'Finance', area: 'finance' },
  { id: 'approvals', title: 'Open approval inbox', href: '/approvals/unified', keywords: 'approve decline doa', module: 'Approvals', area: 'approvals' },
  { id: 'build-app', title: 'Build an application', href: '/studio', keywords: 'studio capability app create', module: 'Applications' },
]
