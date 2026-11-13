/**
 * Centralized query key factory for React Query.
 *
 * Every key is a function so cache invalidation is predictable: call the
 * same fn with the same args to get the same key. Mutations invalidate
 * related keys via queryClient.invalidateQueries({ queryKey: keys.xxx() }).
 */

export const keys = {
  // Item master
  items: (filters) => ['items', filters],
  item: (id) => ['items', id],

  // Inventory
  inventoryItems: (filters) => ['inventory-items', filters],
  inventoryItem: (id) => ['inventory-items', id],

  // Warehouse
  storageLocations: (filters) => ['storage-locations', filters],
  storageLocation: (id) => ['storage-locations', id],
  storageLocationBins: (id) => ['storage-locations', id, 'bins'],
  storageLocationPendingApprovals: (id) => ['storage-locations', id, 'pending-approvals'],
  bins: (locationId) => ['bins', locationId],
  bin: (id) => ['bins', id],
  allBins: (filters) => ['bins', filters],
  binInventoryItems: (id) => ['bins', id, 'inventory-items'],
  stocktakeSheets: (filters) => ['stocktake-sheets', filters],
  stocktakeSheet: (id) => ['stocktake-sheets', id],
  warehouseTransactions: (filters) => ['warehouse-transactions', filters],

  // Procurement
  suppliers: (filters) => ['suppliers', filters],
  supplier: (id) => ['suppliers', id],
  supplierItems: (supplierId) => ['supplier-items', supplierId],
  purchaseOrders: (filters) => ['purchase-orders', filters],
  purchaseOrder: (id) => ['purchase-orders', id],
  poLineItems: (poId) => ['purchase-orders', poId, 'line-items'],
  purchaseRequisitions: (filters) => ['purchase-requisitions', filters],
  purchaseRequisition: (id) => ['purchase-requisitions', id],
  contracts: (filters) => ['contracts', filters],
  procurementContracts: (filters) => ['procurement-contracts', filters],
  procurementContract: (id) => ['procurement-contracts', id],
  rfqs: (filters) => ['rfqs', filters],
  rfq: (id) => ['rfqs', id],
  goodsReceipts: (filters) => ['goods-receipts', filters],
  goodsReceipt: (id) => ['goods-receipts', id],
  goodsReceiptLocations: () => ['goods-receipts', 'storage-locations'],
  goodsReceiptBins: (locationId) => ['goods-receipts', 'bins', locationId],
  procurementReview: (filters) => ['procurement-review', filters],
  rfqApprovals: (filters) => ['rfq-approvals', filters],

  // Sales
  customers: (filters) => ['customers', filters],
  customer: (id) => ['customers', id],
  salesOrders: (filters) => ['sales-orders', filters],
  salesOrder: (id) => ['sales-orders', id],
  salesQuotations: (filters) => ['sales-quotations', filters],
  salesQuotation: (id) => ['sales-quotations', id],
  salesContracts: (filters) => ['sales-contracts', filters],
  salesContract: (id) => ['sales-contracts', id],
  salesRfqs: (filters) => ['sales-rfqs', filters],
  salesRfq: (id) => ['sales-rfqs', id],
  deliverySchedules: (filters) => ['delivery-schedules', filters],
  deliverySchedule: (id) => ['delivery-schedules', id],
  deliveryTracking: (filters) => ['delivery-tracking', filters],


  // Finance
  chartOfAccounts: (filters) => ['chart-of-accounts', filters],
  chartOfAccountsStats: () => ['chart-of-accounts', 'stats'],
  journalEntries: (filters) => ['journal-entries', filters],
  journalEntry: (id) => ['journal-entries', id],
  journalEntriesStats: () => ['journal-entries', 'stats'],
  customerInvoices: (filters) => ['customer-invoices', filters],
  supplierInvoices: (filters) => ['supplier-invoices', filters],
  // Under 'supplier-invoices' so anything that invalidates bills re-plans the run.
  supplierPaymentRun: (params) => ['supplier-invoices', 'payment-run', params],
  trialBalance: (date) => ['trial-balance', date],
  balanceSheet: (date) => ['balance-sheet', date],
  // Drill-down: journal lines for one account, optionally bounded to a
  // report's date window — a statement line clicked open is a different view
  // than the same account with no date bound, so both key on the range.
  generalLedger: (accountId, from, to) => ['general-ledger', accountId, from, to],
  cashFlowStatement: (from, to) => ['cash-flow-statement', from, to],
  // Keyed on the full range: an income statement from Jan-Mar and one from
  // Jan-Jun are different reports, and sharing a key would show one period's
  // numbers under the other's label.
  incomeStatement: (from, to) => ['income-statement', from, to],
  creditNotes: (filters) => ['credit-notes', filters],
  grIrAging: () => ['gr-ir-aging'],
  yearEndPreview: (year) => ['year-end-preview', year],
  // FinancialReports.jsx switches between three report shapes on one screen;
  // keyed on both which report and its date range so switching tabs (or the
  // range) never shows the previous report's data under the new label.
  financialReport: (reportType, dateRange) => ['financial-report', reportType, dateRange],
  // 13-week cash flow forecast — a derived financial answer, so a stale
  // cached copy that misses a just-posted invoice is worse than a refetch.
  cashForecast: () => ['financial-report', 'cash-forecast'],
  fixedAssets: () => ['fixed-assets'],
  bankAccounts: () => ['bank-accounts'],
  budgets: () => ['budgets'],
  currencies: () => ['currencies'],

  // HR
  employees: () => ['employees'],
  payroll: () => ['payroll'],

  // Manufacturing
  workOrders: () => ['work-orders'],
  workOrder: (id) => ['work-orders', id],
  boms: () => ['boms'],
  // Capacity is keyed on the horizon: two horizons are two different answers,
  // and sharing a key would show last week's window under this month's label.
  workCenters: () => ['work-centers'],
  workCenterCapacity: (horizonDays) => ['work-centers', 'capacity', horizonDays],
  bomOperations: (bomId) => ['boms', bomId, 'operations'],
  workOrderOperations: (workOrderId) => ['work-orders', workOrderId, 'operations'],
  mrpPlannedOrders: () => ['mrp-planned-orders'],

  // HR
  leaveRequests: () => ['hr-leave'],
  attendance: () => ['hr-attendance'],
  hrEmployees: () => ['hr-employees'],

  // Admin / SaaS

  // Supplier portal — public, token-authenticated pages. Keyed on the token
  // (or supplierId) itself: two tokens are two different suppliers' answers,
  // and sharing a key would leak one supplier's data under another's token.
  supplierPortalDelivery: (token) => ['supplier-portal-delivery', token],
  supplierPortalPartnership: (supplierId) => ['supplier-portal-partnership', supplierId],
  supplierPortalRfq: (token) => ['supplier-portal-rfq', token],
  supplierPortalSalesRfq: (token) => ['supplier-portal-sales-rfq', token],
  supplierPortalDashboard: (supplierId) => ['supplier-portal-dashboard', supplierId],
  supplierContractResponse: (token) => ['supplier-contract-response', token],
  supplierItemConfirmation: (token) => ['supplier-item-confirmation', token],
  supplierRfqResponse: (token) => ['supplier-rfq-response', token],

  // CRM & Projects
  contacts: () => ['contacts'],
  deals: () => ['deals'],
  // Keyed on the status filter: two filters are two different answers, and
  // sharing a key would show the previous filter's rows under the new label.
  leads: (status) => ['leads', status || 'ALL'],
  projects: () => ['projects'],
  project: (id) => ['projects', id],

  // AI
  aiSettings: () => ['ai-settings'],
  aiTools: () => ['ai-tools'],
  aiDocuments: () => ['ai-documents'],
  aiCredentials: () => ['ai-credentials'],
  aiFindings: (filters) => ['ai-findings', filters],
  aiGovernanceUsage: () => ['ai-governance', 'usage'],
  aiGovernanceFeedback: () => ['ai-governance', 'feedback'],
  aiConversations: () => ['ai-conversations'],
  aiBackgroundTasks: () => ['ai-background-tasks'],
  businessInsights: () => ['business-insights'],
  businessCharts: () => ['business-charts'],
  transactionAnalysis: (tab) => ['transaction-analysis', tab],

  // Reports
  reports: () => ['reports'],
  dashboards: () => ['dashboards'],

  // Governance
  auditTrail: (filters) => ['audit-trail', filters],
  notifications: () => ['notifications'],
  approvalChains: () => ['approval-chains'],

  // Approval dashboards & queues
  binApprovals: (filters) => ['bin-approvals', filters],
  storageLocationApprovals: (filters) => ['storage-location-approvals', filters],
  itemAssignmentApprovals: () => ['item-assignment-approvals'],
  inventoryApprovalStats: () => ['inventory-approval-stats'],
  procurementApprovalStats: () => ['procurement-approval-stats'],
  salesApprovalDashboard: () => ['sales-approval-dashboard'],
  delegationOfAuthority: (filters) => ['delegation-of-authority', filters],
  delegationOfAuthorityStats: () => ['delegation-of-authority-stats'],
  unifiedApprovalStats: (dashboardType) => ['unified-approval-stats', dashboardType],
  unifiedApprovalItems: (dashboardType) => ['unified-approval-items', dashboardType],

  // Unified approval inbox — one key for the whole typed inbox: every type is
  // fetched together and filtered client-side, so any approve/decline
  // invalidates the single key.
  approvalInbox: () => ['approval-inbox'],

  // Approval-routing simulator. Keyed on the exact payload: two payloads are
  // two different chains, and sharing a key would show the previous amount's
  // chain under the new amount's label.
  approvalSimulation: (payload) => ['approval-simulation', payload],
  approvalSimulationConfig: () => ['approval-simulation-config'],

  // Admin application statistics (one payload, one key — the screen is a
  // single dashboard fetch, so there is nothing to invalidate piecemeal).
  appStats: () => ['app-stats'],

  // Public customer-portal pages (token-authenticated, not a logged-in session)
  customerContractResponse: (token) => ['customer-contract-response', token],
  customerOrderResponse: (token) => ['customer-order-response', token],
  customerQuotationResponse: (token) => ['customer-quotation-response', token],
  customerDeliveryConfirmation: (token) => ['customer-delivery-confirmation', token],
};
