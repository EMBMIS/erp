import axios from 'axios'

export const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api'

// Enhanced axios configuration with timeout and retry logic
const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000, // 30 second timeout
  headers: {
    'Content-Type': 'application/json',
  },
})

// Retry logic for failed requests
const retryRequest = async (config, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await api.request(config)
    } catch (error) {
      const isConnectionError = 
        error.code === 'ECONNABORTED' ||
        error.code === 'NETWORK_ERROR' ||
        error.message?.includes('Network Error') ||
        error.message?.includes('timeout') ||
        !error.response

      if (isConnectionError && attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 5000) // Exponential backoff, max 5s
        console.log(`🔄 Retrying API request (${attempt}/${maxRetries}) in ${delay}ms...`)
        await new Promise(resolve => setTimeout(resolve, delay))
        continue
      }
      
      throw error
    }
  }
}

api.interceptors.request.use(
  (config) => {
    // Add auth token if available
    const token = localStorage.getItem('token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }

    // Which company this request acts for. Sent on every request rather than
    // per call site, because a request that omits it falls back to the user's
    // default company — so a screen that forgot the header would silently show
    // the wrong company's data instead of failing. The server re-checks the
    // user's access to whatever is named here; this header is a request, not a
    // grant.
    const companyId = localStorage.getItem('qira.companyId')
    if (companyId) {
      config.headers['X-Company-Id'] = companyId
    }

    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

api.interceptors.response.use(
  (response) => {
    return response
  },
  async (error) => {
    const originalRequest = error.config

    // A request the app cancelled itself (React Query unmounting a screen,
    // a superseded search) is not a lost connection. Retrying it re-sends a
    // request nobody wants, and logging it says the network is down when it
    // is not.
    if (axios.isCancel(error) || error.code === 'ERR_CANCELED') {
      return Promise.reject(error)
    }
    
    // Enhanced error handling with retry for connection issues
    const isConnectionError = 
      error.code === 'ECONNABORTED' ||
      error.code === 'NETWORK_ERROR' ||
      error.message?.includes('Network Error') ||
      error.message?.includes('timeout') ||
      !error.response

    if (isConnectionError && !originalRequest._retry) {
      originalRequest._retry = true
      console.log('🔄 Connection error detected, attempting retry...')
      try {
        return await retryRequest(originalRequest, 2)
      } catch (retryError) {
        console.error('❌ All retry attempts failed:', retryError.message)
        error.message = 'Connection lost. Please check your internet connection or try again.'
      }
    }
    
    console.error('API Error:', error)
    
    // Handle token expiration
    if (error.response?.status === 401) {
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      // Redirect to the login page only when the 401 came from somewhere
      // else. A failed login attempt is also a 401 — redirecting then would
      // yank the user off the form, which must be allowed to show "invalid
      // credentials" instead.
      //
      // The app is served under vite's base path in production ('/platform/'),
      // so the login page URL is BASE_URL + 'login'. A hardcoded '/login'
      // redirect lands on the embmis-web landing site (Next.js) as a 404.
      const loginPath = `${import.meta.env.BASE_URL}login`
      // The SSO probe (/auth/session) is expected to 401 for every visitor
      // without the shared cookie. Redirecting on it bounced logged-out
      // people off every public page — supplier and customer response links,
      // forgot-password, the legal pages — to the login form.
      const isSessionProbe = /\/auth\/session$/.test(error.config?.url || '')
      if (window.location.pathname !== loginPath && !isSessionProbe) {
        // Come back to the same screen after signing in again. Forms autosave
        // their drafts (components/ui/useDraft), so nothing typed is lost.
        const here = window.location.pathname + window.location.search
        window.location.href = `${loginPath}?redirect_uri=${encodeURIComponent(here)}`
      }
    }
    
    return Promise.reject(error)
  }
)

export const itemsAPI = {
  getAll: (params = {}) => api.get('/items', { params }),
  getById: (id) => api.get(`/items/${id}`),
  create: (data) => api.post('/items', data),
  update: (id, data) => api.put(`/items/${id}`, data),
  delete: (id) => api.delete(`/items/${id}`),
  approve: (id) => api.post(`/items/${id}/approve`),
  decline: (id, reason) => api.post(`/items/${id}/decline`, { reason }),
  getStats: () => api.get('/items/stats'),
  generateDescription: (name) => api.post('/items/ai/describe', { name }),
  getSuggestions: (name, description) => api.post('/items/ai/suggest', { name, description }),
  parseNLInput: (input) => api.post('/items/ai/parse', { input }),
  generateComprehensive: (name, description) => api.post('/items/ai/comprehensive', { name, description }),
}

export const notificationsAPI = {
  getAll: (params = {}) => api.get('/notifications', { params }),
  getUnreadCount: () => api.get('/notifications/unread-count'),
  markAsRead: (id) => api.put(`/notifications/${id}/read`),
  markAllAsRead: () => api.put('/notifications/mark-all-read'),
  delete: (id) => api.delete(`/notifications/${id}`),
  deleteAll: () => api.delete('/notifications'),
}

export const authAPI = {
  login: (credentials) => api.post('/auth/login', credentials),
  session: () => api.get('/auth/session'),
  googleLogin: (credential) => api.post('/auth/google', { credential }),
  register: (userData) => api.post('/auth/register', userData),
  registerCompany: (data) => api.post('/auth/register-company', data),
  suggestBusinessType: (description) => api.post('/auth/suggest-business-type', { description }),
  verifyEmail: (token) => api.post('/auth/verify-email', { token }),
  resendVerification: (email) => api.post('/auth/resend-verification', { email }),
  logout: () => api.post('/auth/logout'),
  getProfile: () => api.get('/auth/me'),
  updateProfile: (profileData) => api.put('/auth/profile', profileData),
  changePassword: (passwordData) => api.put('/auth/change-password', passwordData),
  verifyToken: () => api.get('/auth/verify'),
  forgotPassword: (email) => api.post('/auth/forgot-password', { email }),
  resetPassword: (token, new_password) => api.post('/auth/reset-password', { token, new_password }),
}

// Monthly count/value series behind the KPI cards. One request for however
// many entities a screen needs — see routes/kpi-series.js for the whitelist.
export const kpiSeriesAPI = {
  get: (entities, months = 12) =>
    api.get('/kpi-series', { params: { entities: entities.join(','), months } })
}

export const warehouseTransactionsAPI = {
  list: (params = {}) => api.get('/warehouse/transactions', { params }),
  stats: () => api.get('/warehouse/transactions/stats')
}

export const inventoryItemsAPI = {
  // Where the stock is, how it moved, what it is made of, how accurate the
  // book is and how fast it turns — one round trip for the overview.
  analytics: (months = 12, slowDays = 90) =>
    api.get('/inventory-items/analytics', { params: { months, slow_days: slowDays } }),
  getAll: (params = {}) => api.get('/inventory-items', { params }),
  getById: (id) => api.get(`/inventory-items/${id}`),
  create: (data) => api.post('/inventory-items', data),
  update: (id, data) => api.put(`/inventory-items/${id}`, data),
  delete: (id) => api.delete(`/inventory-items/${id}`),
  getStats: () => api.get('/inventory-items/stats'),
  getAvailableItemMasters: () => api.get('/inventory-items/available-masters'),
  getStorageMappings: (id) => api.get(`/inventory-items/${id}/storage-mappings`),
  addStorageMapping: (id, data) => api.post(`/inventory-items/${id}/storage-mapping`, data),
  removeStorageMapping: (id, mappingId) => api.delete(`/inventory-items/${id}/storage-mapping/${mappingId}`),
  
  // Approval workflow
  getPendingApprovals: () => api.get('/inventory-items/pending-approvals'),
  approve: (id, data) => api.post(`/inventory-items/${id}/approve`, data),
  decline: (id, data) => api.post(`/inventory-items/${id}/decline`, data),
  
  // Storage assignment approval workflow
  getPendingStorageAssignments: () => api.get('/inventory-items/storage-assignments/pending'),
  approveStorageAssignment: (mappingId) => api.post(`/inventory-items/storage-assignments/${mappingId}/approve`),
  declineStorageAssignment: (mappingId) => api.post(`/inventory-items/storage-assignments/${mappingId}/decline`),

  // Barcode scanning (requires the 'barcode_scanning' module)
  lookupBarcode: (code) => api.get(`/inventory-items/barcode/${encodeURIComponent(code)}`),
}

export const storageLocationsAPI = {
  getAll: (params = {}) => api.get('/storage-locations', { params }),
  getById: (id) => api.get(`/storage-locations/${id}`),
  create: (data) => api.post('/storage-locations', data),
  update: (id, data) => api.put(`/storage-locations/${id}`, data),
  delete: (id) => api.delete(`/storage-locations/${id}`),
  getApproved: (params = {}) => api.get('/storage-locations', { params: { ...params, status: 'APPROVED' } }),
}

export const binsAPI = {
  getAll: (params = {}) => api.get('/bins', { params }),
  getById: (id) => api.get(`/bins/${id}`),
  create: (data) => api.post('/bins', data),
  update: (id, data) => api.put(`/bins/${id}`, data),
  delete: (id) => api.delete(`/bins/${id}`),
  getByStorageLocation: (storageLocationId, params = {}) => 
    api.get('/bins', { params: { ...params, storage_location_id: storageLocationId, status: 'APPROVED' } }),
}

export const chartOfAccountsAPI = {
  getAll: (params = {}) => api.get('/chart-of-accounts', { params }),
  getById: (id) => api.get(`/chart-of-accounts/${id}`),
  create: (data) => api.post('/chart-of-accounts', data),
  update: (id, data) => api.put(`/chart-of-accounts/${id}`, data),
  delete: (id) => api.delete(`/chart-of-accounts/${id}`),
  updateStatus: (id, status, reason = '') => api.put(`/chart-of-accounts/${id}/status`, { status, reason }),
  getHierarchy: (parentId = null) => api.get('/chart-of-accounts/hierarchy', { params: { parent_id: parentId } }),
  getStats: () => api.get('/chart-of-accounts/stats')
}

export const journalEntriesAPI = {
  getAll: (params = {}) => api.get('/journal-entries', { params }),
  getById: (id) => api.get(`/journal-entries/${id}`),
  create: (data) => api.post('/journal-entries', data),
  update: (id, data) => api.put(`/journal-entries/${id}`, data),
  delete: (id) => api.delete(`/journal-entries/${id}`),
  updateStatus: (id, status, reason = '') => api.put(`/journal-entries/${id}/status`, { status, reason }),
  post: (id) => api.post(`/journal-entries/${id}/post`),
  reverse: (id, reason) => api.post(`/journal-entries/${id}/reverse`, { reason }),
  getStats: () => api.get('/journal-entries/stats')
}

export const financialReportsAPI = {
  getTrialBalance: (params = {}) => api.get('/financial-reports/trial-balance', { params }),
  getBalanceSheet: (params = {}) => api.get('/financial-reports/balance-sheet', { params }),
  getIncomeStatement: (params = {}) => api.get('/financial-reports/income-statement', { params }),
  getCashFlow: (params = {}) => api.get('/financial-reports/cash-flow', { params }),
  getArAging: () => api.get('/financial-reports/ar-aging'),
  getApAging: () => api.get('/financial-reports/ap-aging'),
  getVatSummary: (params = {}) => api.get('/financial-reports/vat-summary', { params })
}

// Finance dashboards and statements (routes/finance.js).
//
// Distinct from financialReportsAPI: that wraps routes/financial-reports.js,
// which serves the formal statements. These are the dashboard/summary shapes the
// finance screens render. Both are now auth-gated server-side, which is why
// these have to go through `api` — the screens used a bare fetch() and so sent
// neither the bearer token nor X-Company-Id.
export const financeAPI = {
  getDashboard: () => api.get('/finance/dashboard'),
  // Month-by-month P&L movement off the posted journal — the series the
  // finance KPI cards draw, which the point-in-time balances cannot provide.
  getKpiTrends: (months = 12) => api.get('/finance/kpi-trends', { params: { months } }),
  getBalanceSheet: (params = {}) => api.get('/finance/balance-sheet', { params }),
  getIncomeStatement: (params = {}) => api.get('/finance/income-statement', { params }),
  getTrialBalance: (params = {}) => api.get('/finance/trial-balance', { params }),
  getJournalDashboard: (params = {}) => api.get('/finance/journal-dashboard', { params }),
  // Aging summary used by the AR/AP module overviews. Lives on the reports
  // API too; mirrored here because the overviews read from financeAPI.
  getArAging: () => api.get('/financial-reports/ar-aging'),
  getApAging: () => api.get('/financial-reports/ap-aging')
}

// Per-module AI analysis (routes/ai-modules.js).
// Simeli's own module overview: findings, agent runs, escalations, knowledge.
export const simeliAPI = {
  overview: (months = 12) => api.get('/ai-analytics/overview', { params: { months } }),
}

export const aiModulesAPI = {
  optimizeWarehouse: () => api.get('/ai-modules/warehouse/optimize-operations'),
  predictPicking: (payload = {}) => api.post('/ai-modules/warehouse/predict-picking', payload)
}

export const healthAPI = {
  check: () => api.get('/health'),
  dbPool: () => api.get('/health/db-pool')
}

// Accounts Receivable — customer invoices
export const customerInvoicesAPI = {
  list: (params = {}) => api.get('/customer-invoices', { params }),
  stats: () => api.get('/customer-invoices/stats'),
  get: (id) => api.get(`/customer-invoices/${id}`),
  createFromSalesOrder: (salesOrderId) => api.post(`/customer-invoices/from-sales-order/${salesOrderId}`),
  downloadEInvoice: (id) => api.get(`/customer-invoices/${id}/e-invoice`, { responseType: 'blob' }),
  updateStatus: (id, status, reason) => api.patch(`/customer-invoices/${id}/status`, { status, reason })
}

// Accounts Receivable — customer payments
export const customerPaymentsAPI = {
  list: (params = {}) => api.get('/customer-payments', { params }),
  get: (id) => api.get(`/customer-payments/${id}`),
  create: (payload) => api.post('/customer-payments', payload)
}

export const salesOrdersAPI = {
  list: (params = {}) => api.get('/sales-orders', { params }),
  // NOTE: both of these are scoped to the caller's own orders server-side
  // (SalesOrder.findAll / getStats apply `created_by = <user>`), unlike the
  // quotation, contract, RFQ and delivery stats beside them, which are
  // company-wide. Anything that puts them in one picture has to say so.
  stats: () => api.get('/sales-orders/stats')
}

// Accounts Payable — supplier invoices (vendor bills)
export const supplierInvoicesAPI = {
  list: (params = {}) => api.get('/supplier-invoices', { params }),
  stats: () => api.get('/supplier-invoices/stats'),
  paymentRun: (params = {}, config = {}) => api.get('/supplier-invoices/payment-run', { params, ...config }),
  get: (id) => api.get(`/supplier-invoices/${id}`),
  createFromPurchaseOrder: (poId, payload = {}) => api.post(`/supplier-invoices/from-purchase-order/${poId}`, payload),
  updateStatus: (id, status, reason) => api.patch(`/supplier-invoices/${id}/status`, { status, reason }),
  billedTwiceScan: (params = {}) => api.get('/supplier-invoices/billed-twice', { params }),
  billedTwice: (id) => api.get(`/supplier-invoices/${id}/billed-twice`),
  holdPayment: (id, reason) => api.post(`/supplier-invoices/${id}/payment-hold`, { reason }),
  releasePaymentHold: (id) => api.delete(`/supplier-invoices/${id}/payment-hold`)
}

// Accounts Payable — supplier payments
export const supplierPaymentsAPI = {
  list: (params = {}) => api.get('/supplier-payments', { params }),
  get: (id) => api.get(`/supplier-payments/${id}`),
  create: (payload) => api.post('/supplier-payments', payload)
}

export const purchaseOrdersAPI = {
  list: (params = {}) => api.get('/purchase-orders', { params }),
  stats: () => api.get('/purchase-orders/stats'),
  // Spend by supplier and category, on-time delivery, committed spend by month.
  // Scoped to the caller's own orders server-side, same as list and stats.
  analytics: (months = 24) => api.get('/purchase-orders/analytics', { params: { months } })
}

// The rest of procure-to-pay. Each answers a /stats shape of counts by status.
export const purchaseRequisitionsAPI = {
  list: (params = {}) => api.get('/purchase-requisitions', { params }),
  stats: () => api.get('/purchase-requisitions/stats')
}

export const procurementRfqsAPI = {
  list: (params = {}) => api.get('/request-for-quotations', { params }),
  stats: () => api.get('/request-for-quotations/stats'),
  savings: (days = 365) => api.get('/request-for-quotations/savings', { params: { days } })
}

export const suppliersAPI = {
  list: (params = {}) => api.get('/suppliers', { params }),
  stats: () => api.get('/suppliers/stats')
}

export const goodsReceiptsAPI = {
  list: (params = {}) => api.get('/goods-receipts', { params }),
  summary: () => api.get('/goods-receipts/summary')
}

// Accounting periods (period close / GL lock)
export const accountingPeriodsAPI = {
  list: (params = {}) => api.get('/accounting-periods', { params }),
  // Where a month stands against the ten pre-close gates, without closing it.
  preCloseChecks: (year, month) => api.get(`/accounting-periods/${year}/${month}/pre-close-checks`),
  close: (year, month, notes) => api.post('/accounting-periods/close', { year, month, notes }),
  reopen: (year, month, notes) => api.post('/accounting-periods/reopen', { year, month, notes })
}

// HR & Payroll
export const hrAPI = {
  // The module overview in one request.
  analytics: (months = 12) => api.get('/hr/analytics', { params: { months } }),

  listEmployees: (params = {}) => api.get('/hr/employees', { params }),
  employeeStats: () => api.get('/hr/employees/stats'),
  createEmployee: (payload) => api.post('/hr/employees', payload),
  updateEmployee: (id, payload) => api.put(`/hr/employees/${id}`, payload),
  listPayroll: () => api.get('/hr/payroll'),
  getPayroll: (id) => api.get(`/hr/payroll/${id}`),
  createPayroll: (payload) => api.post('/hr/payroll', payload),
  approvePayroll: (id) => api.post(`/hr/payroll/${id}/approve`),
  postPayroll: (id) => api.post(`/hr/payroll/${id}/post`),
  payPayroll: (id) => api.post(`/hr/payroll/${id}/pay`)
}

// Multi-currency / FX
export const currenciesAPI = {
  list: () => api.get('/currencies'),
  add: (payload) => api.post('/currencies', payload),
  listRates: (params = {}) => api.get('/currencies/rates', { params }),
  addRate: (payload) => api.post('/currencies/rates', payload),
  convert: (params) => api.get('/currencies/convert', { params })
}

// Cost centers
export const costCentersAPI = {
  list: (params = {}) => api.get('/cost-centers', { params }),
  create: (payload) => api.post('/cost-centers', payload),
  update: (id, payload) => api.put(`/cost-centers/${id}`, payload)
}

// Budgets
export const budgetsAPI = {
  list: () => api.get('/budgets'),
  get: (id) => api.get(`/budgets/${id}`),
  create: (payload) => api.post('/budgets', payload),
  addLine: (id, payload) => api.post(`/budgets/${id}/lines`, payload),
  vsActual: (id) => api.get(`/budgets/${id}/vs-actual`)
}

// Chart of accounts (for pickers)
export const chartOfAccountsPickerAPI = {
  list: (params = {}) => api.get('/chart-of-accounts', { params })
}

// Bank reconciliation
export const bankAPI = {
  listAccounts: () => api.get('/bank/accounts'),
  createAccount: (payload) => api.post('/bank/accounts', payload),
  getSummary: (id) => api.get(`/bank/accounts/${id}/summary`),
  listTransactions: (id, params = {}) => api.get(`/bank/accounts/${id}/transactions`, { params }),
  addTransaction: (id, payload) => api.post(`/bank/accounts/${id}/transactions`, payload),
  reconcile: (txnId, payload = {}) => api.patch(`/bank/transactions/${txnId}/reconcile`, payload),
  suggestions: (txnId) => api.get(`/bank/transactions/${txnId}/suggestions`)
}

// Fixed Assets register + depreciation
export const fixedAssetsAPI = {
  list: (params = {}) => api.get('/fixed-assets', { params }),
  stats: () => api.get('/fixed-assets/stats'),
  get: (id) => api.get(`/fixed-assets/${id}`),
  create: (payload) => api.post('/fixed-assets', payload),
  depreciate: (id, payload = {}) => api.post(`/fixed-assets/${id}/depreciate`, payload),
  runDepreciationAll: (payload = {}) => api.post('/fixed-assets/run-depreciation', payload),
  dispose: (id, reason, proceeds = 0) => api.patch(`/fixed-assets/${id}/dispose`, { reason, proceeds })
}

// Fixed asset revaluation (IAS 16)
export const fixedAssetRevaluationAPI = {
  revalue: (id, payload) => api.post(`/fixed-assets/${id}/revalue`, payload),
  history: (id) => api.get(`/fixed-assets/${id}/revaluations`)
}

// The rest of the sales pipeline. Each of these answers a /stats shape with
// counts by status and a value total, which is what the module overview reads.
export const salesQuotationsAPI = {
  list: (params = {}) => api.get('/sales-quotations', { params }),
  stats: () => api.get('/sales-quotations/stats')
}

export const salesContractsAPI = {
  list: (params = {}) => api.get('/sales-contracts', { params }),
  stats: () => api.get('/sales-contracts/stats')
}

export const salesRfqsAPI = {
  list: (params = {}) => api.get('/sales-rfqs', { params }),
  stats: () => api.get('/sales-rfqs/stats')
}

export const deliverySchedulesAPI = {
  list: (params = {}) => api.get('/delivery-schedules', { params }),
  stats: () => api.get('/delivery-schedules/stats')
}

export const customersAPI = {
  getAll: (params = {}) => api.get('/customers', { params }),
  get: (id) => api.get(`/customers/${id}`),
  stats: () => api.get('/customers/stats')
}

// CRM: contacts, deals, activities
export const crmAPI = {
  // The module overview in one request.
  analytics: (months = 12) => api.get('/crm/analytics', { params: { months } }),

  listContacts: (params = {}) => api.get('/crm/contacts', { params }),
  getContact: (id) => api.get(`/crm/contacts/${id}`),
  createContact: (payload) => api.post('/crm/contacts', payload),
  updateContact: (id, payload) => api.put(`/crm/contacts/${id}`, payload),
  deleteContact: (id) => api.delete(`/crm/contacts/${id}`),
  // Called as the form is filled, so a duplicate is caught while it is being
  // typed rather than found months later.
  checkDuplicate: (params) => api.get('/crm/contacts/check-duplicate', { params }),

  listDeals: (params = {}) => api.get('/crm/deals', { params }),
  getDeal: (id) => api.get(`/crm/deals/${id}`),
  createDeal: (payload) => api.post('/crm/deals', payload),
  updateDeal: (id, payload) => api.put(`/crm/deals/${id}`, payload),
  moveStage: (id, payload) => api.post(`/crm/deals/${id}/stage`, payload),
  pipeline: (params = {}) => api.get('/crm/deals/pipeline', { params }),

  // Import is two calls on purpose: analyse proposes, commit writes what a
  // person approved. See services/ai/crmImport.js for why.
  analyseImport: (file) => {
    const form = new FormData();
    form.append('file', file);
    return api.post('/crm/import/analyse', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
  commitImport: (payload) => api.post('/crm/import/commit', payload),

  listActivities: (params = {}) => api.get('/crm/activities', { params }),
  createActivity: (payload) => api.post('/crm/activities', payload),
  completeActivity: (id) => api.post(`/crm/activities/${id}/complete`)
}

// Projects: work breakdown, time tracking, billing
export const projectsAPI = {
  // The module overview in one request. Everything else here is a single
  // resource; this is the aggregate the overview screen is built from.
  analytics: (months = 12) => api.get('/projects/analytics', { params: { months } }),

  list: (params = {}) => api.get('/projects', { params }),
  get: (id) => api.get(`/projects/${id}`),
  create: (payload) => api.post('/projects', payload),
  update: (id, payload) => api.put(`/projects/${id}`, payload),
  pnl: (id) => api.get(`/projects/${id}/pnl`),

  createTask: (payload) => api.post('/projects/tasks', payload),
  updateTask: (id, payload) => api.put(`/projects/tasks/${id}`, payload),

  listTime: (params = {}) => api.get('/projects/time-entries', { params }),
  logTime: (payload) => api.post('/projects/time-entries', payload),
  updateTime: (id, payload) => api.put(`/projects/time-entries/${id}`, payload),
  deleteTime: (id) => api.delete(`/projects/time-entries/${id}`),

  // Preview before billing: the only realistic point at which a wrong entry
  // gets caught before the customer sees it.
  billingPreview: (id, params = {}) => api.get(`/projects/${id}/billing-preview`, { params }),
  bill: (id, payload = {}) => api.post(`/projects/${id}/bill`, payload)
}

// Companies and intercompany
export const companiesAPI = {
  mine: () => api.get('/companies/mine'),
  list: (params = {}) => api.get('/companies', { params }),
  get: (id) => api.get(`/companies/${id}`),
  create: (payload) => api.post('/companies', payload),
  update: (id, payload) => api.put(`/companies/${id}`, payload),
  isolationStatus: () => api.get('/companies/isolation-status'),
  assignUser: (id, payload) => api.post(`/companies/${id}/users`, payload),

  listIntercompany: (params = {}) => api.get('/companies/intercompany/transactions', { params }),
  postIntercompany: (payload) => api.post('/companies/intercompany/transactions', payload),
  reconciliation: (params = {}) => api.get('/companies/intercompany/reconciliation', { params }),
  eliminate: (payload) => api.post('/companies/intercompany/eliminate', payload)
}

// Reporting: saved reports, dashboards, schedules
export const reportsAPI = {
  // The module overview in one request.
  analytics: (months = 12) => api.get('/reports/analytics', { params: { months } }),

  list: (params = {}) => api.get('/reports', { params }),
  builtins: () => api.get('/reports/builtins'),
  schema: () => api.get('/reports/schema'),
  get: (id) => api.get(`/reports/${id}`),
  create: (payload) => api.post('/reports', payload),
  update: (id, payload) => api.put(`/reports/${id}`, payload),
  remove: (id) => api.delete(`/reports/${id}`),
  run: (id, parameters = {}) => api.post(`/reports/${id}/run`, { parameters }),
  runs: (id, params = {}) => api.get(`/reports/${id}/runs`, { params }),
  // A URL rather than a request: the browser downloads it directly, so a large
  // export never passes through JavaScript memory.
  exportUrl: (id, format = 'csv', parameters = {}) => {
    const query = new URLSearchParams({ format, ...parameters }).toString()
    return `${API_BASE_URL}/reports/${id}/export?${query}`
  },

  listDashboards: () => api.get('/reports/dashboards'),
  getDashboard: (id) => api.get(`/reports/dashboards/${id}`),
  renderDashboard: (id, params = {}) => api.get(`/reports/dashboards/${id}/render`, { params }),
  createDashboard: (payload) => api.post('/reports/dashboards', payload),
  updateDashboard: (id, payload) => api.put(`/reports/dashboards/${id}`, payload),
  deleteDashboard: (id) => api.delete(`/reports/dashboards/${id}`),
  addWidget: (id, payload) => api.post(`/reports/dashboards/${id}/widgets`, payload),
  updateWidget: (widgetId, payload) => api.put(`/reports/dashboards/widgets/${widgetId}`, payload),
  removeWidget: (widgetId) => api.delete(`/reports/dashboards/widgets/${widgetId}`),

  listSchedules: () => api.get('/reports/schedules'),
  createSchedule: (payload) => api.post('/reports/schedules', payload),
  updateSchedule: (id, payload) => api.put(`/reports/schedules/${id}`, payload),
  deleteSchedule: (id) => api.delete(`/reports/schedules/${id}`)
}

// Recurring billing: schedules that generate customer invoices on an interval
export const recurringInvoicesAPI = {
  list: (params = {}) => api.get('/recurring-invoices', { params }),
  create: (payload) => api.post('/recurring-invoices', payload),
  setStatus: (id, status) => api.patch(`/recurring-invoices/${id}`, { status }),
  // dry_run reports what would be billed without creating anything.
  run: (dryRun = false) => api.post('/recurring-invoices/run', { dry_run: dryRun })
}

// Stock movement between storage locations, with an in-transit stage
export const inventoryTransfersAPI = {
  list: (params = {}) => api.get('/inventory-transfers', { params }),
  get: (id) => api.get(`/inventory-transfers/${id}`),
  create: (payload) => api.post('/inventory-transfers', payload),
  receive: (id, payload = {}) => api.post(`/inventory-transfers/${id}/receive`, payload),
  cancel: (id, reason) => api.post(`/inventory-transfers/${id}/cancel`, { reason })
}

// Governance: who changed what, and when
export const auditTrailAPI = {
  list: (params = {}) => api.get('/audit-trail', { params }),
  entityTypes: () => api.get('/audit-trail/entity-types')
}

// User administration (admin only)
export const usersAPI = {
  list: () => api.get('/users'),
  invite: (payload) => api.post('/users/invite', payload),
  updateRole: (id, role) => api.put(`/users/${id}/role`, { role }),
  deactivate: (id) => api.put(`/users/${id}/deactivate`),
  activate: (id) => api.put(`/users/${id}/activate`),
  remove: (id) => api.delete(`/users/${id}`)
}

// Company/user mailboxes on embmis.com (admin manages provisioning; anyone
// with access to a mailbox reads/sends through it).
export const mailboxesAPI = {
  list: () => api.get('/mailboxes'),
  mine: () => api.get('/mailboxes/mine'),
  createForUser: (userId) => api.post(`/mailboxes/users/${userId}`),
  messages: (mailboxId, folder = 'INBOX', opts = {}) =>
    api.get(`/mailboxes/${mailboxId}/messages`, { params: { folder, ...opts } }),
  message: (mailboxId, messageId) => api.get(`/mailboxes/${mailboxId}/messages/${messageId}`),
  downloadAttachment: (mailboxId, messageId, attachmentId) =>
    api.get(`/mailboxes/${mailboxId}/messages/${messageId}/attachments/${attachmentId}`, { responseType: 'blob' }),
  // `payload` is always FormData (Mailbox.jsx compose sends attachments in
  // the same request). The `api` instance defaults every request to
  // Content-Type: application/json (see the axios.create() above), which
  // would otherwise ship this FormData body as JSON and the backend's
  // multer would never see a boundary to parse it with — same fix as the
  // other multipart call sites in this file (knowledge-base upload) and in
  // AIChat.jsx: force 'multipart/form-data' so axios lets the browser set
  // the real header (with boundary) instead of keeping the default.
  send: (mailboxId, payload) =>
    api.post(`/mailboxes/${mailboxId}/messages`, payload, { headers: { 'Content-Type': 'multipart/form-data' } }),
  saveDraft: (mailboxId, payload) =>
    api.post(`/mailboxes/${mailboxId}/drafts`, payload, { headers: { 'Content-Type': 'multipart/form-data' } }),
  update: (mailboxId, messageId, patch) => api.patch(`/mailboxes/${mailboxId}/messages/${messageId}`, patch),
  remove: (mailboxId, messageId) => api.delete(`/mailboxes/${mailboxId}/messages/${messageId}`),
}

// AI-generated mail branding (Admin > Mail Design): one design per company,
// built from a logo photo by a vision model — see backend/routes/mailBranding.js.
export const mailBrandingAPI = {
  get: () => api.get('/mail-branding'),
  generate: (formData) => api.post('/mail-branding/generate', formData, { headers: { 'Content-Type': 'multipart/form-data' } }),
  redesign: (instruction) => api.post('/mail-branding/redesign', { instruction }),
  updateTemplate: (htmlTemplate) => api.patch('/mail-branding', { html_template: htmlTemplate }),
  remove: () => api.delete('/mail-branding'),
}

// Integrations (admin only): machine credentials and outbound event delivery
export const apiKeysAPI = {
  list: () => api.get('/api-keys'),
  // The plaintext key is returned by this call and never again — it is only
  // ever stored hashed.
  create: (payload) => api.post('/api-keys', payload),
  revoke: (id) => api.delete(`/api-keys/${id}`)
}

export const webhooksAPI = {
  list: () => api.get('/webhooks'),
  eventTypes: () => api.get('/webhooks/event-types'),
  create: (payload) => api.post('/webhooks', payload),
  update: (id, payload) => api.patch(`/webhooks/${id}`, payload),
  remove: (id) => api.delete(`/webhooks/${id}`)
}

// Manufacturing: bills of material, work orders, MRP
export const manufacturingAPI = {
  // Production and scrap, OEE and its three factors, work-centre load, top
  // products, material consumption, MRP shortages and the open order list.
  analytics: (months = 12) => api.get('/manufacturing/analytics', { params: { months } }),
  listBoms: (params = {}) => api.get('/manufacturing/boms', { params }),
  getBom: (id) => api.get(`/manufacturing/boms/${id}`),
  createBom: (payload) => api.post('/manufacturing/boms', payload),
  addBomComponent: (id, payload) => api.post(`/manufacturing/boms/${id}/components`, payload),
  activateBom: (id) => api.post(`/manufacturing/boms/${id}/activate`),
  explodeBom: (itemId, quantity = 1) =>
    api.get(`/manufacturing/boms/explode/${itemId}`, { params: { quantity } }),

  listWorkOrders: (params = {}) => api.get('/manufacturing/work-orders', { params }),
  getWorkOrder: (id) => api.get(`/manufacturing/work-orders/${id}`),
  createWorkOrder: (payload) => api.post('/manufacturing/work-orders', payload),
  releaseWorkOrder: (id) => api.post(`/manufacturing/work-orders/${id}/release`),
  issueMaterials: (id, issues) => api.post(`/manufacturing/work-orders/${id}/issue-materials`, { issues }),
  confirmProduction: (id, payload) => api.post(`/manufacturing/work-orders/${id}/confirm`, payload),
  cancelWorkOrder: (id, reason) => api.post(`/manufacturing/work-orders/${id}/cancel`, { reason }),

  runMrp: (payload = {}) => api.post('/manufacturing/mrp/run', payload),
  listPlannedOrders: (params = {}) => api.get('/manufacturing/mrp/planned-orders', { params }),
  convertPlannedOrder: (id) => api.post(`/manufacturing/mrp/planned-orders/${id}/convert`)
}

// Autonomous agents: control plane, run history, escalations
export const agentsAPI = {
  list: () => api.get('/agents'),
  sync: () => api.post('/agents/sync'),
  configure: (key, payload) => api.put(`/agents/${key}/config`, payload),
  // dry_run defaults to true server-side; pass false deliberately to let it act.
  run: (key, payload = {}) => api.post(`/agents/${key}/run`, payload),
  listRuns: (params = {}) => api.get('/agents/runs', { params }),
  getRun: (id) => api.get(`/agents/runs/${id}`),
  listEscalations: (params = {}) => api.get('/agents/escalations', { params }),
  resolveEscalation: (id, decision, note) =>
    api.post(`/agents/escalations/${id}/resolve`, { decision, note }),
  schedulerStatus: () => api.get('/agents/scheduler/status'),
  schedulerTick: () => api.post('/agents/scheduler/tick'),
  // What each agent's work came to, and the authority that record has earned.
  trackRecord: (params = {}) => api.get('/agents/track-record', { params }),
  grantEarned: (proposalId) => api.post('/agents/track-record/grant', { proposal_id: proposalId }),

  // User-built agents. `list()` above returns every agent's operational state;
  // these return the declaration — the goal, the tools, the steps.
  listBlueprints: () => api.get('/agents/blueprints'),
  getBlueprint: (key) => api.get(`/agents/blueprints/${key}`),
  createBlueprint: (payload) => api.post('/agents/blueprints', payload),
  updateBlueprint: (key, payload) => api.put(`/agents/blueprints/${key}`, payload),
  updateBlueprintConfig: (key, config) => api.put(`/agents/blueprints/${key}/config`, { config }),
  deleteBlueprint: (key) => api.delete(`/agents/blueprints/${key}`),
  blueprintVersions: (key) => api.get(`/agents/blueprints/${key}/versions`),
  rollbackBlueprint: (key, version) => api.post(`/agents/blueprints/${key}/rollback`, { version }),
  exportBlueprint: (key) => api.get(`/agents/blueprints/${key}/export`),
  importBlueprint: (payload) => api.post('/agents/blueprints/import', payload),

  // What the agent thought, as opposed to what it did.
  runTranscript: (runId) => api.get(`/agents/runs/${runId}/transcript`),
  listMemory: (key) => api.get(`/agents/blueprints/${key}/memory`),
  deleteMemory: (key, memoryKey) => api.delete(`/agents/blueprints/${key}/memory/${encodeURIComponent(memoryKey)}`),

  emitEvent: (key, payload) => api.post(`/agents/events/${key}`, { payload }),
  eventListeners: (key) => api.get(`/agents/events/${key}/listeners`)
}

// Custom AI tools: the tool library and its test bench
export const aiToolsAPI = {
  catalog: () => api.get('/ai-tools/catalog'),
  list: () => api.get('/ai-tools'),
  get: (idOrName) => api.get(`/ai-tools/${idOrName}`),
  create: (payload) => api.post('/ai-tools', payload),
  update: (idOrName, payload) => api.put(`/ai-tools/${idOrName}`, payload),
  setEnabled: (idOrName, enabled) => api.patch(`/ai-tools/${idOrName}/enabled`, { enabled }),
  remove: (idOrName) => api.delete(`/ai-tools/${idOrName}`),
  versions: (idOrName) => api.get(`/ai-tools/${idOrName}/versions`),
  rollback: (idOrName, version) => api.post(`/ai-tools/${idOrName}/rollback`, { version }),
  // Runs unsaved code against real data — the point of the builder is that
  // nobody has to guess what a tool does before the AI can call it.
  test: (payload) => api.post('/ai-tools/test', payload),
  lint: (implementation) => api.post('/ai-tools/lint', { implementation }),
  exportTool: (idOrName) => api.get(`/ai-tools/${idOrName}/export`),
  importTool: (payload) => api.post('/ai-tools/import', payload),
  updateSettings: (name, payload) => api.put(`/ai-tools/${name}/settings`, payload)
}

// Drafting an agent or a tool from a plain-English description. Neither call
// saves anything — they return a draft for a person to review, which is then
// created through agentsAPI.createBlueprint / aiToolsAPI.create.
export const aiBuilderAPI = {
  generateAgent: (description) => api.post('/ai/generate-agent', { description }),
  generateTool: (description) => api.post('/ai/generate-tool', { description })
}

// MCP server discovery and connections. `connect` records the server and its
// endpoint; it is syncTools that performs the real handshake and is the only
// thing that makes a server's tools callable by the assistant.
export const mcpAPI = {
  catalog: () => api.get('/ai/mcp-catalog'),
  discover: (query) => api.post('/ai/discover-mcp', { query }),
  connect: (payload) => api.post('/ai/connect-mcp', payload),
  connections: () => api.get('/ai/mcp-connections'),
  setApiKey: (id, apiKey) => api.post(`/ai/mcp-connections/${id}/api-key`, { api_key: apiKey }),
  authorizeUrl: (id) => api.post(`/ai/mcp-connections/${id}/oauth/authorize-url`),
  syncTools: (id) => api.post(`/ai/mcp-connections/${id}/sync-tools`),
  disconnect: (id) => api.delete(`/ai/mcp-connections/${id}`)
}

// Native OAuth connectors: Google, Microsoft, Salesforce, Xero and the rest.
// Not MCP — these call each vendor's REST API with an OAuth app the operator
// registers, which is how consumer AI products implement the same thing.
export const connectorsAPI = {
  providers: () => api.get('/connectors/providers'),
  list: () => api.get('/connectors'),
  get: (id) => api.get(`/connectors/${id}`),
  create: (payload) => api.post('/connectors', payload),
  authorizeUrl: (id) => api.post(`/connectors/${id}/authorize-url`),
  disconnect: (id) => api.post(`/connectors/${id}/disconnect`),
  remove: (id) => api.delete(`/connectors/${id}`)
}

// Global AI configuration
export const aiSettingsAPI = {
  get: () => api.get('/ai-settings'),
  update: (payload) => api.put('/ai-settings', payload),
  listTools: () => api.get('/ai-settings/tools'),
  updateTool: (name, payload) => api.put(`/ai-settings/tools/${name}`, payload)
}

// Credential vault. No endpoint returns a secret — by design, there is no way
// to read one back, only to replace it.
export const aiCredentialsAPI = {
  status: () => api.get('/ai-credentials/status'),
  list: () => api.get('/ai-credentials'),
  create: (payload) => api.post('/ai-credentials', payload),
  update: (idOrName, payload) => api.put(`/ai-credentials/${idOrName}`, payload),
  remove: (idOrName) => api.delete(`/ai-credentials/${idOrName}`),
  forAgent: (agentKey) => api.get(`/ai-credentials/agent/${agentKey}`),
  grant: (agentKey, credentialId) => api.post(`/ai-credentials/agent/${agentKey}/grant`, { credential_id: credentialId }),
  revoke: (agentKey, credentialId) => api.post(`/ai-credentials/agent/${agentKey}/revoke`, { credential_id: credentialId })
}

// PDF templates and generated documents
export const pdfTemplatesAPI = {
  list: () => api.get('/pdf-templates'),
  get: (key) => api.get(`/pdf-templates/${key}`),
  create: (payload) => api.post('/pdf-templates', payload),
  update: (key, payload) => api.put(`/pdf-templates/${key}`, payload),
  remove: (key) => api.delete(`/pdf-templates/${key}`),
  versions: (key) => api.get(`/pdf-templates/${key}/versions`),
  rollback: (key, version) => api.post(`/pdf-templates/${key}/rollback`, { version }),
  // Returns the PDF bytes rather than JSON, so the caller gets a blob to show
  // in an object tag instead of persisting a draft nobody asked to keep.
  preview: (key, payload = {}) =>
    api.post(`/pdf-templates/${key}/preview`, payload, { responseType: 'blob' })
}

export const aiDocumentsAPI = {
  list: (params = {}) => api.get('/ai-documents', { params }),
  download: (id) => api.get(`/ai-documents/${id}/download`, { responseType: 'blob' }),
  saveToDrive: (id, folderId) => api.post(`/ai-documents/${id}/save-to-drive`, folderId ? { folder_id: folderId } : {}),
}

// Knowledge base — documents the AI chat automatically retrieves context from (RAG)
export const knowledgeBaseAPI = {
  list: () => api.get('/knowledge-base'),
  uploadFile: (file, title) => {
    const form = new FormData()
    form.append('file', file)
    if (title) form.append('title', title)
    return api.post('/knowledge-base/upload', form, { headers: { 'Content-Type': 'multipart/form-data' } })
  },
  uploadText: (title, content, format = 'text') =>
    api.post('/knowledge-base/upload', { title, content, format }),
  remove: (id) => api.delete(`/knowledge-base/${id}`),
  reindex: () => api.post('/knowledge-base/reindex'),
}

// Business-type-driven module (feature area) toggles. Not to be confused with
// /modules (schema-discovery API) — this is /company-modules.
// Fired on `window` whenever a company module is toggled, so the sidebar
// (which reads its gating once on mount — see Layout.jsx) can refetch and
// show the change immediately instead of waiting for a full page reload.
export const COMPANY_MODULES_CHANGED_EVENT = 'embmis:company-modules-changed'

// Pinning from the Apps launcher has to reach the rail without a reload; the
// two are in different trees, so the window is the only thing they share.
export const RAIL_CHANGED_EVENT = 'embmis:rail-changed'

export const companyModulesAPI = {
  list: () => api.get('/company-modules'),
  listEnabled: () => api.get('/company-modules/enabled'),
  listBusinessTypes: () => api.get('/company-modules/business-types'),
  setEnabled: (key, enabled) =>
    api.put(`/company-modules/${key}`, { enabled }).then((res) => {
      window.dispatchEvent(new CustomEvent(COMPANY_MODULES_CHANGED_EVENT, { detail: { key, enabled } }))
      return res
    }),
}

export const decisionsAPI = {
  list: (params = {}) => api.get('/decisions', { params }),
  get: (id) => api.get(`/decisions/${id}`),
  baseline: () => api.get('/decisions/baseline'),
  simulate: (payload) => api.post('/decisions/simulate', payload, { timeout: 90000 }),
}

// ---------------------------------------------------------------------------
// The application platform.
//
// Three groups, matching the three server mounts, and the split is the security
// model rather than an organising convenience:
//
//   platformAPI   the catalogue, the Studio, and the generic runtime for an
//                 employee. Uses the ordinary bearer token and X-Company-Id.
//   portalAPI     the same runtime for someone OUTSIDE the company. Its own
//                 token, kept under its own storage key, and deliberately not
//                 sent through the shared `api` instance — a portal session
//                 must never travel to an internal endpoint, and an employee's
//                 token must never travel to a portal one.
// ---------------------------------------------------------------------------
/**
 * Read a Studio server-sent-event stream.
 *
 * The Studio's long operations (design, iterate) report their steps as they
 * happen so the screen is never blank while a model thinks. `onStep` is called
 * for each one; the promise resolves with the same payload the non-streaming
 * route would have returned, or rejects with the failure the server reported.
 *
 * fetch rather than the axios client, because axios buffers a whole response
 * before resolving — the one thing a progress stream must not do. And fetch
 * rather than EventSource, because EventSource cannot send an Authorization
 * header and the requirement text is too long for a query string.
 */
async function streamStudio(path, payload, onStep, signal) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(localStorage.getItem('token') ? { Authorization: `Bearer ${localStorage.getItem('token')}` } : {}),
      ...(localStorage.getItem('qira.companyId') ? { 'X-Company-Id': localStorage.getItem('qira.companyId') } : {}),
    },
    body: JSON.stringify(payload),
  })
  if (!response.ok || !response.body) {
    // A failure BEFORE the stream opened is a normal HTTP error with a JSON
    // body (401, 403, a proxy error). One after it opened arrives as an event.
    const body = await response.json().catch(() => null)
    throw new Error(body?.error || `That request failed (${response.status}).`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result
  let settled = false

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // SSE frames are separated by a blank line; a partial frame stays in the
    // buffer until the rest of it arrives.
    const frames = buffer.split('\n\n')
    buffer = frames.pop() || ''
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      let event
      try { event = JSON.parse(line.slice(5).trim()) } catch { continue }
      if (event.type === 'step') onStep?.(event)
      else if (event.type === 'done') { result = event.data; settled = true }
      else if (event.type === 'error') {
        const error = new Error(event.error)
        error.code = event.code
        error.detail = event.detail
        throw error
      }
    }
  }
  // A stream that ends without either a result or an error is a dropped
  // connection, not a success — say so rather than resolving with nothing.
  if (!settled) throw new Error('The connection dropped before that finished. Reload to see whether it completed.')
  return result
}

export const platformAPI = {
  // catalogue
  listApplications: () => api.get('/platform/applications'),
  getApplication: (appKey) => api.get(`/platform/applications/${appKey}`),
  getVersion: (appKey, versionId) => api.get(`/platform/applications/${appKey}/versions/${versionId}`),
  listTables: (appKey) => api.get(`/platform/applications/${appKey}/tables`),
  listDeployments: (appKey) => api.get(`/platform/applications/${appKey}/deployments`),
  listEvents: (appKey, params = {}) => api.get(`/platform/applications/${appKey}/events`, { params }),
  navigation: () => api.get('/platform/applications/navigation'),
  catalogue: () => api.get('/platform/applications/catalogue'),
  canonicalEntities: () => api.get('/platform/applications/canonical-entities'),
  // No uninstall: an application is switched off, never removed. Disabling
  // is reversible and keeps every record — see the platform docs.
  disable: (appKey, reason = null) => api.post(`/platform/applications/${appKey}/disable`, { reason }),
  enable: (appKey) => api.post(`/platform/applications/${appKey}/enable`),

  // deployment
  planDeployment: (appKey, versionId) => api.post(`/platform/applications/${appKey}/deployments`, { versionId }),
  approveDeployment: (deploymentId, acknowledge) =>
    api.post(`/platform/applications/deployments/${deploymentId}/approve`, { acknowledge }),
  applyDeployment: (deploymentId) => api.post(`/platform/applications/deployments/${deploymentId}/apply`),

  // roles
  listRoles: (appKey) => api.get(`/platform/applications/${appKey}/roles`),
  assignRole: (appKey, payload) => api.post(`/platform/applications/${appKey}/roles`, payload),
  revokeRole: (appKey, assignmentId) => api.delete(`/platform/applications/${appKey}/roles/${assignmentId}`),

  // the shell's own screens
  companyHome: () => api.get('/platform/shell/company-home', { timeout: 45000 }),
  myWork: () => api.get('/platform/shell/my-work', { timeout: 45000 }),
  // The rail: which applications this person keeps to hand.
  rail: () => api.get('/platform/shell/rail'),
  setRail: (pinned) => api.put('/platform/shell/rail', { pinned }),
  resetRail: () => api.delete('/platform/shell/rail'),

  // the marketplace — applications one company built, offered to the rest
  marketplace: () => api.get('/platform/marketplace'),
  publishedListings: () => api.get('/platform/marketplace/published'),
  publishApp: (appKey, payload) => api.post(`/platform/marketplace/${appKey}`, payload),
  withdrawApp: (appKey) => api.delete(`/platform/marketplace/${appKey}`),
  installFromMarketplace: (appKey) =>
    api.post(`/platform/marketplace/${appKey}/install`, {}, { timeout: 180000 }),

  // the application directory — every application this company runs, built-in
  // and built-here, and the one switch that turns either kind off.
  directory: () => api.get('/platform/apps-directory'),
  directoryHome: () => api.get('/platform/apps-directory/home', { timeout: 45000 }),
  setAppEnabled: (appKey, enabled, reason = null) =>
    api.post(`/platform/apps-directory/${appKey}/enabled`, { enabled, reason }),

  // studio — generation can take a while when a model is designing
  studioContext: () => api.get('/platform/studio/context'),
  listSessions: () => api.get('/platform/studio/sessions'),
  startSession: (payload) => api.post('/platform/studio/sessions', payload, { timeout: 180000 }),
  // The same build, reported step by step. `onStep` is called as each phase
  // starts and finishes; the promise resolves with the same payload
  // startSession would have returned. Uses fetch rather than the axios client
  // because axios buffers the whole response before resolving, which is the
  // one thing a progress stream must not do.
  startSessionStream: (payload, onStep, signal) =>
    streamStudio('/platform/studio/sessions/stream', payload, onStep, signal),
  iterateStream: (sessionId, instruction, onStep, signal) =>
    streamStudio(`/platform/studio/sessions/${sessionId}/iterate/stream`, { instruction }, onStep, signal),

  getSession: (sessionId) => api.get(`/platform/studio/sessions/${sessionId}`),
  iterate: (sessionId, instruction) =>
    api.post(`/platform/studio/sessions/${sessionId}/iterate`, { instruction }, { timeout: 180000 }),
  validateSession: (sessionId) => api.post(`/platform/studio/sessions/${sessionId}/validate`, {}, { timeout: 120000 }),
  previewSession: (sessionId) => api.get(`/platform/studio/sessions/${sessionId}/preview`, { timeout: 120000 }),
  deploySession: (sessionId, acknowledge = null) =>
    api.post(`/platform/studio/sessions/${sessionId}/deploy`, { acknowledge }, { timeout: 180000 }),
  rollbackSession: (sessionId, versionId, acknowledge = null) =>
    api.post(`/platform/studio/sessions/${sessionId}/rollback`, { versionId, acknowledge }, { timeout: 180000 }),

  // runtime (internal side)
  shell: (appKey, surface) => api.get(`/platform/apps/${appKey}`, { params: surface ? { surface } : {} }),
  page: (appKey, pageKey, params = {}) =>
    api.get(`/platform/apps/${appKey}/pages/${pageKey}`, {
      params: { ...params, filters: params.filters ? JSON.stringify(params.filters) : undefined },
    }),
  listRecords: (appKey, entityKey, params = {}) =>
    api.get(`/platform/apps/${appKey}/entities/${entityKey}`, {
      params: { ...params, filters: params.filters ? JSON.stringify(params.filters) : undefined },
    }),
  getRecord: (appKey, entityKey, id) => api.get(`/platform/apps/${appKey}/entities/${entityKey}/${id}`),
  createRecord: (appKey, entityKey, values) => api.post(`/platform/apps/${appKey}/entities/${entityKey}`, { values }),
  updateRecord: (appKey, entityKey, id, values) =>
    api.patch(`/platform/apps/${appKey}/entities/${entityKey}/${id}`, { values }),
  deleteRecord: (appKey, entityKey, id) => api.delete(`/platform/apps/${appKey}/entities/${entityKey}/${id}`),
  canonical: (appKey, entityKey, params = {}) => api.get(`/platform/apps/${appKey}/canonical/${entityKey}`, { params }),
  metrics: (appKey, keys) => api.get(`/platform/apps/${appKey}/metrics`, { params: keys ? { keys: keys.join(',') } : {} }),
  query: (appKey, queryKey) => api.get(`/platform/apps/${appKey}/queries/${queryKey}`),
  transitions: (appKey, entityKey, id) => api.get(`/platform/apps/${appKey}/entities/${entityKey}/${id}/transitions`),
  transition: (appKey, entityKey, id, transitionKey, reason) =>
    api.post(`/platform/apps/${appKey}/entities/${entityKey}/${id}/transitions/${transitionKey}`, { reason }),
  history: (appKey, entityKey, id) => api.get(`/platform/apps/${appKey}/entities/${entityKey}/${id}/history`),
  comments: (appKey, entityKey, id) => api.get(`/platform/apps/${appKey}/entities/${entityKey}/${id}/comments`),
  addComment: (appKey, entityKey, id, payload) =>
    api.post(`/platform/apps/${appKey}/entities/${entityKey}/${id}/comments`, payload),
  activity: (appKey, entityKey, id) => api.get(`/platform/apps/${appKey}/entities/${entityKey}/${id}/activity`),
  attachments: (appKey, entityKey, id) => api.get(`/platform/apps/${appKey}/entities/${entityKey}/${id}/attachments`),
  uploadAttachment: (appKey, entityKey, id, file, visibility) => {
    const form = new FormData()
    form.append('file', file)
    if (visibility) form.append('visibility', visibility)
    return api.post(`/platform/apps/${appKey}/entities/${entityKey}/${id}/attachments`, form, {
      headers: { 'Content-Type': 'multipart/form-data' }, timeout: 120000,
    })
  },
  attachmentUrl: (appKey, entityKey, id, attachmentId) =>
    `${API_BASE_URL}/platform/apps/${appKey}/entities/${entityKey}/${id}/attachments/${attachmentId}`,
  notifications: (appKey) => api.get(`/platform/apps/${appKey}/notifications`),

  // portal identities (administered from inside the company)
  listIdentities: (params = {}) => api.get('/platform/portal-identities', { params }),
  inviteIdentity: (payload) => api.post('/platform/portal-identities', payload),
  anchors: (kind, search) => api.get(`/platform/portal-identities/anchors/${kind}`, { params: { search } }),
  memberships: (identityId) => api.get(`/platform/portal-identities/${identityId}/memberships`),
  grantMembership: (identityId, payload) => api.post(`/platform/portal-identities/${identityId}/memberships`, payload),
  revokeMembership: (membershipId) => api.delete(`/platform/portal-identities/memberships/${membershipId}`),
  revokeIdentity: (identityId) => api.post(`/platform/portal-identities/${identityId}/revoke`),

  // discovery
  opportunities: (params = {}) => api.get('/platform/opportunities', { params }),
  scanOpportunities: () => api.post('/platform/opportunities/scan', {}, { timeout: 120000 }),
  dismissOpportunity: (id) => api.post(`/platform/opportunities/${id}/dismiss`),
  acceptOpportunity: (id) => api.post(`/platform/opportunities/${id}/accept`, {}, { timeout: 180000 }),
  requestCapability: (body) => api.post('/platform/opportunities/request', body, { timeout: 180000 }),
}

/**
 * The portal client.
 *
 * A separate axios instance with no interceptors, because the shared one adds
 * the employee's token and the company header — neither of which belongs on a
 * portal request, and the second of which a portal caller must not be able to
 * influence at all.
 */
export const PORTAL_TOKEN_KEY = 'embmis:portal-token'

const portalClient = axios.create({ baseURL: API_BASE_URL, timeout: 30000 })
portalClient.interceptors.request.use((config) => {
  const token = localStorage.getItem(PORTAL_TOKEN_KEY)
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

export const portalAPI = {
  login: (payload) => portalClient.post('/platform/portal/login', payload),
  acceptInvite: (payload) => portalClient.post('/platform/portal/accept-invite', payload),
  logout: () => portalClient.post('/platform/portal/logout'),
  me: () => portalClient.get('/platform/portal/me'),
  shell: (appKey, surface) => portalClient.get(`/platform/portal/apps/${appKey}`, { params: surface ? { surface } : {} }),
  page: (appKey, pageKey, params = {}) =>
    portalClient.get(`/platform/portal/apps/${appKey}/pages/${pageKey}`, {
      params: { ...params, filters: params.filters ? JSON.stringify(params.filters) : undefined },
    }),
  listRecords: (appKey, entityKey, params = {}) =>
    portalClient.get(`/platform/portal/apps/${appKey}/entities/${entityKey}`, {
      params: { ...params, filters: params.filters ? JSON.stringify(params.filters) : undefined },
    }),
  getRecord: (appKey, entityKey, id) => portalClient.get(`/platform/portal/apps/${appKey}/entities/${entityKey}/${id}`),
  createRecord: (appKey, entityKey, values) =>
    portalClient.post(`/platform/portal/apps/${appKey}/entities/${entityKey}`, { values }),
  updateRecord: (appKey, entityKey, id, values) =>
    portalClient.patch(`/platform/portal/apps/${appKey}/entities/${entityKey}/${id}`, { values }),
  canonical: (appKey, entityKey, params = {}) =>
    portalClient.get(`/platform/portal/apps/${appKey}/canonical/${entityKey}`, { params }),
  transitions: (appKey, entityKey, id) =>
    portalClient.get(`/platform/portal/apps/${appKey}/entities/${entityKey}/${id}/transitions`),
  transition: (appKey, entityKey, id, transitionKey, reason) =>
    portalClient.post(`/platform/portal/apps/${appKey}/entities/${entityKey}/${id}/transitions/${transitionKey}`, { reason }),
  comments: (appKey, entityKey, id) =>
    portalClient.get(`/platform/portal/apps/${appKey}/entities/${entityKey}/${id}/comments`),
  addComment: (appKey, entityKey, id, payload) =>
    portalClient.post(`/platform/portal/apps/${appKey}/entities/${entityKey}/${id}/comments`, payload),
  attachments: (appKey, entityKey, id) =>
    portalClient.get(`/platform/portal/apps/${appKey}/entities/${entityKey}/${id}/attachments`),
  attachmentUrl: (appKey, entityKey, id, attachmentId) =>
    `${API_BASE_URL}/platform/portal/apps/${appKey}/entities/${entityKey}/${id}/attachments/${attachmentId}`,
  uploadAttachment: (appKey, entityKey, id, file) => {
    const form = new FormData()
    form.append('file', file)
    return portalClient.post(`/platform/portal/apps/${appKey}/entities/${entityKey}/${id}/attachments`, form, {
      headers: { 'Content-Type': 'multipart/form-data' }, timeout: 120000,
    })
  },
  notifications: (appKey) => portalClient.get(`/platform/portal/apps/${appKey}/notifications`),
}

export default api
