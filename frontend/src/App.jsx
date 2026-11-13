import React, { Suspense, lazy } from 'react'
import { BrowserRouter as Router, Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom'
import { ToastHost } from './components/ui/Toast'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from './contexts/AuthContext'
import { CompanyProvider, useCompany } from './contexts/CompanyContext'
import { I18nProvider } from './contexts/I18nContext'
import ProtectedRoute from './components/ProtectedRoute'
import { platformAPI } from './services/api'
// The shell is its own chunk: the sign-in screen does not need it.
const Layout = lazy(() => import('./components/Layout'))
import ErrorBoundary from './components/ErrorBoundary'
import CookieConsent from './components/CookieConsent'
import { useI18n } from './contexts/I18nContext'


const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
});

function PageLoader() {
  const { t } = useI18n()
  return (
    <div className="mx-auto max-w-[1400px] space-y-4 px-4 py-6 sm:px-6" role="status" aria-live="polite">
      <span className="sr-only">{t('ui.loadingPage')}</span>
      <span className="skeleton block h-3 w-40" />
      <span className="skeleton block h-7 w-72" />
      <span className="skeleton block h-64 w-full" style={{ borderRadius: 10 }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The ten pre-inbox approval dashboards were collapsed into the single
// Approval Inbox (Task 14). Their URLs keep working by redirecting to
// /approvals/unified — ?tab selects the approval type, and ?id deep-links to
// the exact row that the old per-item detail pages showed.
// ---------------------------------------------------------------------------
function RedirectToInbox({ tab }) {
  const params = useParams();
  const id = params.id ? '&id=' + encodeURIComponent(params.id) : '';
  return <Navigate to={'/approvals/unified?tab=' + tab + id} replace />;
}


// ---------------------------------------------------------------------------
// Every page below is lazy. The <Suspense> boundary and this PageLoader were
// already here, wrapping all 159 routes â€” but nothing was lazy, so the
// fallback could never render and the boundary did nothing. All 164 page
// modules were static imports, which is to say the entire ~84k-LOC application
// was parsed and evaluated before the login screen could paint.
//
// Only what genuinely renders on first paint stays eager: Login, and the
// Layout/ProtectedRoute shell that wraps every authenticated route. Lazy-
// loading those would trade a smaller bundle for a spinner on literally every
// navigation, which is the wrong side of that trade.
// ---------------------------------------------------------------------------
const NotFound = lazy(() => import('./pages/NotFound'))
const SystemReference = lazy(() => import('./pages/system/SystemReference'))

// The application platform. Six routes cover every generated application there
// will ever be: the Studio designs them, Applications lists them, AppRuntime
// renders any of them, and the portal serves the external side of any of them.
// Adding an application adds no route here — that is the whole claim.
const Studio = lazy(() => import('./pages/platform/Studio'))
const Applications = lazy(() => import('./pages/platform/Applications'))
const ApplicationDetail = lazy(() => import('./pages/platform/ApplicationDetail'))
const Marketplace = lazy(() => import('./pages/platform/Marketplace'))
const Opportunities = lazy(() => import('./pages/platform/Opportunities'))
const AppRuntime = lazy(() => import('./pages/platform/AppRuntime'))
const PortalLogin = lazy(() => import('./pages/platform/Portal').then((m) => ({ default: m.PortalLogin })))
const PortalAcceptInvite = lazy(() => import('./pages/platform/Portal').then((m) => ({ default: m.PortalAcceptInvite })))
const PortalShell = lazy(() => import('./pages/platform/Portal').then((m) => ({ default: m.PortalShell })))
const PrivacyPolicy = lazy(() => import('./pages/PrivacyPolicy'))
const TermsOfService = lazy(() => import('./pages/TermsOfService'))
const ItemsList = lazy(() => import('./pages/ItemsList'))
const ItemCreate = lazy(() => import('./pages/ItemCreate'))
const ItemEdit = lazy(() => import('./pages/ItemEdit'))
const ItemView = lazy(() => import('./pages/ItemView'))
const Inventory = lazy(() => import('./pages/Inventory'))
const Home = lazy(() => import('./pages/home/Home'))
// Signed-in people never need these, so they stay out of the first download.
const Login = lazy(() => import('./pages/Login'))
const Signup = lazy(() => import('./pages/Signup'))
const VerifyEmail = lazy(() => import('./pages/VerifyEmail'))
const MyWork = lazy(() => import('./pages/MyWork'))
const StorageLocationsList = lazy(() => import('./pages/warehouse/StorageLocationsList'))
const StorageLocationCreate = lazy(() => import('./pages/warehouse/StorageLocationCreate'))
const StorageLocationView = lazy(() => import('./pages/warehouse/StorageLocationView'))
const StorageLocationEdit = lazy(() => import('./pages/warehouse/StorageLocationEdit'))
const StorageLocationInventoryApprovals = lazy(() => import('./pages/warehouse/StorageLocationInventoryApprovals'))
const BinsList = lazy(() => import('./pages/warehouse/BinsList'))
const BinCreate = lazy(() => import('./pages/warehouse/BinCreate'))
const BinView = lazy(() => import('./pages/warehouse/BinView'))
const BinEdit = lazy(() => import('./pages/warehouse/BinEdit'))
const WarehouseMain = lazy(() => import('./pages/warehouse/WarehouseMain'))
const WarehouseCapacityManagement = lazy(() => import('./pages/warehouse/WarehouseCapacityManagement'))
const WarehouseTransactions = lazy(() => import('./pages/warehouse/WarehouseTransactions'))
const TransactionHistory = lazy(() => import('./pages/warehouse/TransactionHistory'))
const GoodsReceipt = lazy(() => import('./pages/warehouse/transactions/GoodsReceipt'))
const GoodsIssue = lazy(() => import('./pages/warehouse/transactions/GoodsIssue'))
const GoodsReturn = lazy(() => import('./pages/warehouse/transactions/GoodsReturn'))
const GoodsTransfer = lazy(() => import('./pages/warehouse/transactions/GoodsTransfer'))
const StockAdjustment = lazy(() => import('./pages/warehouse/transactions/StockAdjustment'))
const InventoryItemsList = lazy(() => import('./pages/inventory/InventoryItemsList'))
const BarcodeScanner = lazy(() => import('./pages/inventory/BarcodeScanner'))
const InventoryItemCreate = lazy(() => import('./pages/inventory/InventoryItemCreate'))
const InventoryItemView = lazy(() => import('./pages/inventory/InventoryItemView'))
const InventoryItemEdit = lazy(() => import('./pages/inventory/InventoryItemEdit'))
const SupplierApprovals = lazy(() => import('./pages/procurement/approvals/SupplierApprovals'))
const SupplierCertifications = lazy(() => import('./pages/procurement/approvals/SupplierCertifications'))
const ContractApprovals = lazy(() => import('./pages/procurement/approvals/ContractApprovals'))
const PurchaseRequisitionApprovals = lazy(() => import('./pages/procurement/approvals/PurchaseRequisitionApprovals'))
const RFQApprovals = lazy(() => import('./pages/procurement/approvals/RFQApprovals'))
const PurchaseOrderApprovals = lazy(() => import('./pages/procurement/approvals/PurchaseOrderApprovals'))

// Procurement Components
const ProcurementMain = lazy(() => import('./pages/procurement/ProcurementMain'))
const SuppliersList = lazy(() => import('./pages/procurement/suppliers/SuppliersList'))
const SupplierCreate = lazy(() => import('./pages/procurement/suppliers/SupplierCreate'))
const PurchaseRequisitionsList = lazy(() => import('./pages/procurement/purchase-requisitions/PurchaseRequisitionsList'))
const PurchaseRequisitionCreate = lazy(() => import('./pages/procurement/purchase-requisitions/PurchaseRequisitionCreate'))
const PurchaseRequisitionView = lazy(() => import('./pages/procurement/purchase-requisitions/PurchaseRequisitionView'))
const RFQsList = lazy(() => import('./pages/procurement/rfqs/RFQsList'))
const RFQCreate = lazy(() => import('./pages/procurement/rfqs/RFQCreate'))
const RFQView = lazy(() => import('./pages/procurement/rfqs/RFQView'))
const POsList = lazy(() => import('./pages/procurement/purchase-orders/POsList'))
const POCreate = lazy(() => import('./pages/procurement/purchase-orders/POCreate'))
const POView = lazy(() => import('./pages/procurement/purchase-orders/POView'))
const GoodsReceiptCreate = lazy(() => import('./pages/procurement/goods-receipts/GoodsReceiptCreate'))
const GoodsReceiptHistory = lazy(() => import('./pages/finance/GoodsReceiptHistory'))
const ContractsList = lazy(() => import('./pages/procurement/contracts/ContractsList'))
const ContractCreate = lazy(() => import('./pages/procurement/contracts/ContractCreate'))
const ContractView = lazy(() => import('./pages/procurement/contracts/ContractView'))
const ProcurementReview = lazy(() => import('./pages/procurement/contracts/ProcurementReview'))
const SupplierView = lazy(() => import('./pages/procurement/suppliers/SupplierView'))
const PartnershipInvitation = lazy(() => import('./pages/supplier-portal/PartnershipInvitation'))
const ThankYou = lazy(() => import('./pages/supplier-portal/ThankYou'))
const RFQResponse = lazy(() => import('./pages/supplier-portal/RFQResponse'))
const DeliveryStatus = lazy(() => import('./pages/supplier-portal/DeliveryStatus'))
const DeliveryTrackingHub = lazy(() => import('./pages/procurement/DeliveryTrackingHub'))
const SupplierItemConfirmation = lazy(() => import('./pages/supplier/SupplierItemConfirmation'))
const SupplierContractResponse = lazy(() => import('./pages/supplier/SupplierContractResponse'))
const SupplierRFQResponse = lazy(() => import('./pages/supplier/SupplierRFQResponse'))
const SalesRfqResponse = lazy(() => import('./pages/supplier-portal/SalesRfqResponse'))
const SupplierPortalDashboard = lazy(() => import('./pages/supplier-portal/SupplierPortalDashboard'))

// Sales Components
const CustomersList = lazy(() => import('./pages/sales/CustomersList'))
const CustomerCreate = lazy(() => import('./pages/sales/CustomerCreate'))
const CustomerEdit = lazy(() => import('./pages/sales/CustomerEdit'))
const CustomerView = lazy(() => import('./pages/sales/CustomerView'))
const SalesOverview = lazy(() => import('./pages/sales/SalesOverview'))
const SalesOrdersList = lazy(() => import('./pages/sales/SalesOrdersList'))
const SalesOrderCreate = lazy(() => import('./pages/sales/SalesOrderCreate'))
const SalesOrderView = lazy(() => import('./pages/sales/SalesOrderView'))
const SalesOrderEdit = lazy(() => import('./pages/sales/SalesOrderEdit'))
const SalesQuotationsList = lazy(() => import('./pages/sales/SalesQuotationsList'))
const SalesQuotationCreate = lazy(() => import('./pages/sales/SalesQuotationCreate'))
const SalesQuotationView = lazy(() => import('./pages/sales/SalesQuotationView'))
const SalesQuotationEdit = lazy(() => import('./pages/sales/SalesQuotationEdit'))
const SalesContractsList = lazy(() => import('./pages/sales/SalesContractsList'))
const SalesContractCreate = lazy(() => import('./pages/sales/SalesContractCreate'))
const SalesContractView = lazy(() => import('./pages/sales/SalesContractView'))
const SalesContractEdit = lazy(() => import('./pages/sales/SalesContractEdit'))
const SalesRfqsList = lazy(() => import('./pages/sales/SalesRfqsList'))
const SalesRfqCreate = lazy(() => import('./pages/sales/SalesRfqCreate'))
const SalesRfqView = lazy(() => import('./pages/sales/SalesRfqView'))
const SalesRfqEdit = lazy(() => import('./pages/sales/SalesRfqEdit'))
const DeliveryScheduling = lazy(() => import('./pages/sales/DeliveryScheduling'))
const DeliverySchedulesList = lazy(() => import('./pages/sales/DeliverySchedulesList'))

// DOA Management
const DelegationOfAuthorityManagement = lazy(() => import('./pages/DelegationOfAuthorityManagement'))
const UnifiedApprovalPortal = lazy(() => import('./pages/UnifiedApprovalPortal'))
const ApprovalSimulator = lazy(() => import('./pages/ApprovalSimulator'))

// Customer Response
const CustomerQuotationResponse = lazy(() => import('./pages/CustomerQuotationResponse'))
const CustomerContractResponse = lazy(() => import('./pages/CustomerContractResponse'))
const CustomerOrderResponse = lazy(() => import('./pages/CustomerOrderResponse'))
const CustomerDeliveryConfirmation = lazy(() => import('./pages/CustomerDeliveryConfirmation'))
const DeliveryConfirmationSuccess = lazy(() => import('./pages/DeliveryConfirmationSuccess'))

// Finance Components
const ChartOfAccountsList = lazy(() => import('./pages/finance/ChartOfAccountsList'))
const ChartOfAccountsCreate = lazy(() => import('./pages/ChartOfAccountsCreate'))
const FinanceDashboard = lazy(() => import('./pages/finance/FinanceDashboard'))
const JournalEntriesList = lazy(() => import('./pages/finance/JournalEntriesList'))
const JournalEntriesDashboard = lazy(() => import('./pages/finance/JournalEntriesDashboard'))
const JournalEntryForm = lazy(() => import('./pages/finance/JournalEntryForm'))
const TrialBalance = lazy(() => import('./pages/finance/TrialBalance'))
const BalanceSheet = lazy(() => import('./pages/finance/BalanceSheet'))
const EnhancedBalanceSheet = lazy(() => import('./pages/finance/EnhancedBalanceSheet'))
const IncomeStatement = lazy(() => import('./pages/finance/IncomeStatement'))
const EnhancedIncomeStatement = lazy(() => import('./pages/finance/EnhancedIncomeStatement'))
const FinancialReports = lazy(() => import('./pages/finance/FinancialReports'))

// AI Components
const AIChat = lazy(() => import('./pages/ai/AIChat'))
const BusinessIntelligence = lazy(() => import('./pages/ai/BusinessIntelligence'))
const TransactionAnalysis = lazy(() => import('./pages/ai/TransactionAnalysis'))
const CustomerInvoices = lazy(() => import('./pages/finance/CustomerInvoices'))
const CustomerPayments = lazy(() => import('./pages/finance/CustomerPayments'))
const SupplierInvoices = lazy(() => import('./pages/finance/SupplierInvoices'))
const SupplierPayments = lazy(() => import('./pages/finance/SupplierPayments'))
const AgingReport = lazy(() => import('./pages/finance/AgingReport'))
const CashFlowStatement = lazy(() => import('./pages/finance/CashFlowStatement'))
const VatReport = lazy(() => import('./pages/finance/VatReport'))
const FixedAssets = lazy(() => import('./pages/finance/FixedAssets'))
const BankReconciliation = lazy(() => import('./pages/finance/BankReconciliation'))
const CostCenters = lazy(() => import('./pages/finance/CostCenters'))
const Budgets = lazy(() => import('./pages/finance/Budgets'))
const Currencies = lazy(() => import('./pages/finance/Currencies'))
const HrOverview = lazy(() => import('./pages/hr/HrOverview'))
const Employees = lazy(() => import('./pages/hr/Employees'))
const Payroll = lazy(() => import('./pages/hr/Payroll'))
const ExecutiveDashboard = lazy(() => import('./pages/finance/ExecutiveDashboard'))
const ArOverview = lazy(() => import('./pages/finance/ArOverview'))
const ApOverview = lazy(() => import('./pages/finance/ApOverview'))
const AssetsCashOverview = lazy(() => import('./pages/finance/AssetsCashOverview'))
const ControllingOverview = lazy(() => import('./pages/finance/ControllingOverview'))
const GlOverview = lazy(() => import('./pages/finance/GlOverview'))
const FinanceReportsOverview = lazy(() => import('./pages/finance/ReportsOverview'))
const AccountingPeriods = lazy(() => import('./pages/finance/AccountingPeriods'))
const Pipeline = lazy(() => import('./pages/crm/Pipeline'))
const Contacts = lazy(() => import('./pages/crm/Contacts'))
const ImportContacts = lazy(() => import('./pages/crm/ImportContacts'))
const Activities = lazy(() => import('./pages/crm/Activities'))
const ProjectsOverview = lazy(() => import('./pages/projects/ProjectsOverview'))
const Projects = lazy(() => import('./pages/projects/Projects'))
const ProjectDetail = lazy(() => import('./pages/projects/ProjectDetail'))
const Timesheet = lazy(() => import('./pages/projects/Timesheet'))
const WorkOrders = lazy(() => import('./pages/manufacturing/WorkOrders'))
const BillsOfMaterial = lazy(() => import('./pages/manufacturing/BillsOfMaterial'))
const ProductionDashboard = lazy(() => import('./pages/manufacturing/ProductionDashboard'))
const MRPWorkbench = lazy(() => import('./pages/manufacturing/MRPWorkbench'))
const WorkCenterDashboard = lazy(() => import('./pages/manufacturing/WorkCenterDashboard'))
const Reports = lazy(() => import('./pages/reports/Reports'))
const ReportViewer = lazy(() => import('./pages/reports/ReportViewer'))
const ReportSchedules = lazy(() => import('./pages/reports/ReportSchedules'))
const Agents = lazy(() => import('./pages/agents/Agents'))
const AgentBuilder = lazy(() => import('./pages/ai/AgentBuilder'))
const ToolLibrary = lazy(() => import('./pages/ai/ToolLibrary'))
const AISettings = lazy(() => import('./pages/ai/AISettings'))
const PdfTemplates = lazy(() => import('./pages/ai/PdfTemplates'))
const KnowledgeBase = lazy(() => import('./pages/ai/KnowledgeBase'))
// Named exports from one module, so they get one lazy wrapper each rather than
// a shared one â€” React.lazy resolves a default export, hence the re-map.
const DashboardList = lazy(() => import('./pages/reports/Dashboards').then((m) => ({ default: m.DashboardList })))
const DashboardView = lazy(() => import('./pages/reports/Dashboards').then((m) => ({ default: m.DashboardView })))
const RecurringInvoices = lazy(() => import('./pages/finance/RecurringInvoices'))
const InventoryTransfers = lazy(() => import('./pages/warehouse/InventoryTransfers'))
const StocktakeSheetsList = lazy(() => import('./pages/warehouse/StocktakeSheetsList'))
const StocktakeCountEntry = lazy(() => import('./pages/warehouse/StocktakeCountEntry'))
const AIGovernance = lazy(() => import('./pages/ai/AIGovernance'))
const AIFindingsDashboard = lazy(() => import('./pages/ai/AIFindingsDashboard'))
const DecisionSimulator = lazy(() => import('./pages/ai/DecisionSimulator'))
const CashFlowForecast = lazy(() => import('./pages/finance/CashFlowForecast'))
const CreditNotesList = lazy(() => import('./pages/finance/CreditNotesList'))
const GrIrAging = lazy(() => import('./pages/finance/GrIrAging'))
const YearEndClose = lazy(() => import('./pages/finance/YearEndClose'))
const CrmOverview = lazy(() => import('./pages/crm/CrmOverview'))
const LeadsList = lazy(() => import('./pages/crm/LeadsList'))
const LeaveAttendance = lazy(() => import('./pages/hr/LeaveAttendance'))
const AuditTrail = lazy(() => import('./pages/admin/AuditTrail'))
import LiveNotificationToast from './components/LiveNotificationToast'
const Integrations = lazy(() => import('./pages/admin/Integrations'))
const AIGateway = lazy(() => import('./pages/admin/AIGateway'))
const Modules = lazy(() => import('./pages/admin/Modules'))
const AdminOverview = lazy(() => import('./pages/admin/AdminOverview'))
const AnalyticsOverview = lazy(() => import('./pages/reports/AnalyticsOverview'))
const QiraAiOverview = lazy(() => import('./pages/ai/QiraAiOverview'))
const DoaOverview = lazy(() => import('./pages/DoaOverview'))
const UserManagement = lazy(() => import('./pages/admin/UserManagement'))
const Mailboxes = lazy(() => import('./pages/admin/Mailboxes'))
const MailDesign = lazy(() => import('./pages/admin/MailDesign'))
const Mailbox = lazy(() => import('./pages/Mailbox'))
const AppStatistics = lazy(() => import('./pages/admin/AppStatistics'))
const ForgotPassword = lazy(() => import('./pages/auth/ForgotPassword'))
const ResetPassword = lazy(() => import('./pages/auth/ResetPassword'))



/**
 * Feeds the active company's currency and locale into the i18n provider.
 *
 * A separate component because it has to sit *inside* CompanyProvider to read
 * the context, and I18nProvider has to sit inside it in turn â€” a company's
 * configured locale is the default for anyone who has not chosen their own.
 */
function LocalisedApp({ children }) {
  const { currency, locale } = useCompany()
  return (
    <I18nProvider companyCurrency={currency} companyLocale={locale}>
      {children}
    </I18nProvider>
  )
}

/**
 * One boundary around every route.
 *
 * A render error anywhere below here would otherwise unmount the entire app and
 * leave a white page — no nav, no way back short of a manual reload. Keyed on
 * the pathname so the error belongs to the screen that threw it: navigate away
 * and the boundary remounts clean instead of following you around the app.
 */
function RoutedBoundary({ children }) {
  const location = useLocation()
  return <ErrorBoundary key={location.pathname}>{children}</ErrorBoundary>
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
    {/* PROD is a Vite compile-time constant (false in dev, dropped by
        dead-code elimination in prod), same mechanism vite.config.js uses
        for `base` — the ERP is served under /platform in production only;
        `npm run dev` keeps routing at plain localhost:3000/. */}
    <Router basename={import.meta.env.BASE_URL === '/' ? undefined : import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <AuthProvider>
       <CompanyProvider>
        <LocalisedApp>
        <div className="App">
          <RoutedBoundary>
          <Suspense fallback={<PageLoader />}>
          <Routes>
            {/* Public routes */}
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />
            <Route path="/verify-email" element={<VerifyEmail />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />

            {/* Legal — public, reachable from the cookie banner and the auth
                footer, without an account. */}
            <Route path="/privacy" element={<PrivacyPolicy />} />
            <Route path="/terms" element={<TermsOfService />} />

            {/* Supplier Portal - Public routes */}
            <Route path="/supplier-portal/partnership/:supplierId" element={<PartnershipInvitation />} />
            <Route path="/supplier-portal/rfq/respond/:token" element={<RFQResponse />} />
            <Route path="/supplier-portal/delivery/:token" element={<DeliveryStatus />} />
            <Route path="/supplier-portal/thank-you" element={<ThankYou />} />
            
            {/* Supplier Portal Sales RFQ Response */}
            <Route path="/supplier/sales-rfq-response/:token" element={<SalesRfqResponse />} />
            
            {/* Supplier Portal Dashboard - Public route */}
            <Route path="/supplier-portal/dashboard/:supplierId" element={<SupplierPortalDashboard />} />
            
            {/* Supplier Confirmation - Public route */}
            <Route path="/supplier/confirm-items/:token" element={<SupplierItemConfirmation />} />
            
            {/* Supplier Contract Response - Public route */}
            <Route path="/supplier/contract-response/:token" element={<SupplierContractResponse />} />
            
            {/* Supplier RFQ Response - Public route */}
            <Route path="/supplier/rfq-response/:token" element={<SupplierRFQResponse />} />
            
            {/* Customer Quotation Response - Public route */}
            <Route path="/quotation-response/:token" element={<CustomerQuotationResponse />} />
            
            {/* Customer Contract Response - Public route */}
            <Route path="/contract-response/:token" element={<CustomerContractResponse />} />
            
            {/* Customer Order Response - Public route */}
            <Route path="/order-response/:token" element={<CustomerOrderResponse />} />
            
            {/* The generated-application portal. Public in the sense that it
                is outside the employee session entirely: it authenticates
                against app_external_identities with its own token, so an
                employee's credentials are never in play and a portal session
                can never reach an internal endpoint. */}
            <Route path="/portal/login" element={<PortalLogin />} />
            <Route path="/portal/accept-invite" element={<PortalAcceptInvite />} />
            <Route path="/portal/*" element={<PortalShell />} />

            {/* Customer Delivery Confirmation - Public routes */}
            <Route path="/delivery-confirmation/:token" element={<CustomerDeliveryConfirmation />} />
            <Route path="/delivery-confirmation/success" element={<DeliveryConfirmationSuccess />} />
            
            {/* Protected routes */}
            <Route path="/system" element={
              <ProtectedRoute>
                <Layout>
                  <SystemReference />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/my-work" element={
              <ProtectedRoute>
                <Layout>
                  <MyWork />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/" element={
              <ProtectedRoute>
                <Layout>
                  <Home />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/mail" element={
              <ProtectedRoute>
                <Layout>
                  <Mailbox />
                </Layout>
              </ProtectedRoute>
            } />
            {/* The sidebar's "Dashboard" item links to "/", but that's not
                obvious from the URL alone — "/dashboard" is the natural guess
                for anyone typing or bookmarking it, so alias it here rather
                than let it 404. */}
            <Route path="/dashboard" element={<Navigate to="/" replace />} />

            {/* DOA Management routes */}
            <Route path="/delegation-of-authority" element={
              <ProtectedRoute>
                <Layout>
                  <DelegationOfAuthorityManagement />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/approvals/sales" element={
              <ProtectedRoute requiredRole="MANAGER">
                <Layout>
                  <RedirectToInbox tab="sales-quotations" />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Unified Approval Portal — the one inbox (Tasks 14-15) */}
            <Route path="/approvals/unified" element={
              <ProtectedRoute>
                <Layout>
                  <UnifiedApprovalPortal />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/approvals/simulate" element={
              <ProtectedRoute requiredRole="MANAGER">
                <Layout>
                  <ApprovalSimulator />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/inventory" element={
              <ProtectedRoute>
                <Layout>
                  <Inventory />
                </Layout>
              </ProtectedRoute>
            } />
            
            {/* Inventory Items routes */}
            <Route path="/inventory/items" element={
              <ProtectedRoute>
                <Layout>
                  <InventoryItemsList />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/inventory/barcode-scanner" element={
              <ProtectedRoute>
                <Layout>
                  <BarcodeScanner />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/inventory/items/create" element={
              <ProtectedRoute>
                <Layout>
                  <InventoryItemCreate />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/inventory/items/:id/edit" element={
              <ProtectedRoute>
                <Layout>
                  <InventoryItemEdit />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/inventory/items/:id" element={
              <ProtectedRoute>
                <Layout>
                  <InventoryItemView />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/items" element={
              <ProtectedRoute>
                <Layout>
                  <ItemsList />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/items/create" element={
              <ProtectedRoute>
                <Layout>
                  <ItemCreate />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/items/:id/edit" element={
              <ProtectedRoute>
                <Layout>
                  <ItemEdit />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/items/:id/view" element={
              <ProtectedRoute>
                <Layout>
                  <ItemView />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/approvals/inventory" element={
              <ProtectedRoute requiredRole="MANAGER">
                <Layout>
                  <RedirectToInbox tab="inventory-items" />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/approvals/items" element={
              <ProtectedRoute requiredRole="MANAGER">
                <Layout>
                  <RedirectToInbox tab="items" />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/approvals/items/:id" element={
              <ProtectedRoute requiredRole="MANAGER">
                <Layout>
                  <RedirectToInbox tab="items" />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/approvals/storage-locations" element={
              <ProtectedRoute requiredRole="MANAGER">
                <Layout>
                  <RedirectToInbox tab="storage-locations" />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/approvals/bins" element={
              <ProtectedRoute requiredRole="MANAGER">
                <Layout>
                  <RedirectToInbox tab="bins" />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/approvals/inventory-items" element={
              <ProtectedRoute requiredRole="MANAGER">
                <Layout>
                  <RedirectToInbox tab="inventory-items" />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/approvals/inventory-items/:id" element={
              <ProtectedRoute requiredRole="MANAGER">
                <Layout>
                  <RedirectToInbox tab="inventory-items" />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/approvals/item-assignments" element={
              <ProtectedRoute requiredRole="MANAGER">
                <Layout>
                  <RedirectToInbox tab="item-assignments" />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/approvals/procurement" element={
              <ProtectedRoute requiredRole="MANAGER">
                <Layout>
                  <RedirectToInbox tab="purchase-orders" />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/approvals/procurement/suppliers" element={
              <ProtectedRoute requiredRole="MANAGER">
                <Layout>
                  <SupplierApprovals />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/approvals/procurement/certifications" element={
              <ProtectedRoute requiredRole="MANAGER">
                <Layout>
                  <SupplierCertifications />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/approvals/procurement/contracts" element={
              <ProtectedRoute requiredRole="MANAGER">
                <Layout>
                  <ContractApprovals />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/approvals/procurement/purchase-requisitions" element={
              <ProtectedRoute requiredRole="MANAGER">
                <Layout>
                  <PurchaseRequisitionApprovals />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/approvals/procurement/rfqs" element={
              <ProtectedRoute requiredRole="MANAGER">
                <Layout>
                  <RFQApprovals />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/approvals/purchase-orders" element={
              <ProtectedRoute requiredRole="MANAGER">
                <Layout>
                  <PurchaseOrderApprovals />
                </Layout>
              </ProtectedRoute>
            } />
            
            {/* Warehouse routes */}
            <Route path="/warehouse" element={
              <ProtectedRoute>
                <Layout>
                  <WarehouseMain />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/warehouse/storage-locations" element={
              <ProtectedRoute>
                <Layout>
                  <StorageLocationsList />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/warehouse/storage-locations/create" element={
              <ProtectedRoute>
                <Layout>
                  <StorageLocationCreate />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/warehouse/storage-locations/:id" element={
              <ProtectedRoute>
                <Layout>
                  <StorageLocationView />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/warehouse/storage-locations/:id/edit" element={
              <ProtectedRoute>
                <Layout>
                  <StorageLocationEdit />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/warehouse/storage-locations/:id/inventory-approvals" element={
              <ProtectedRoute requiredRole="MANAGER">
                <Layout>
                  <StorageLocationInventoryApprovals />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/warehouse/bins" element={
              <ProtectedRoute>
                <Layout>
                  <BinsList />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/warehouse/bins/create" element={
              <ProtectedRoute>
                <Layout>
                  <BinCreate />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/warehouse/bins/:id" element={
              <ProtectedRoute>
                <Layout>
                  <BinView />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/warehouse/bins/:id/edit" element={
              <ProtectedRoute>
                <Layout>
                  <BinEdit />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/warehouse/capacity" element={
              <ProtectedRoute>
                <Layout>
                  <WarehouseCapacityManagement />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Warehouse Transactions routes */}
            <Route path="/warehouse/transactions" element={
              <ProtectedRoute>
                <Layout>
                  <WarehouseTransactions />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/warehouse/transactions/history" element={
              <ProtectedRoute>
                <Layout>
                  <TransactionHistory />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/warehouse/transactions/goods-receipt" element={
              <ProtectedRoute>
                <Layout>
                  <GoodsReceipt />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/warehouse/transactions/goods-issue" element={
              <ProtectedRoute>
                <Layout>
                  <GoodsIssue />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/warehouse/transactions/goods-return" element={
              <ProtectedRoute>
                <Layout>
                  <GoodsReturn />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/warehouse/transactions/goods-transfer" element={
              <ProtectedRoute>
                <Layout>
                  <GoodsTransfer />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/warehouse/transactions/stock-adjustment" element={
              <ProtectedRoute>
                <Layout>
                  <StockAdjustment />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Procurement routes */}
            <Route path="/procurement" element={
              <ProtectedRoute>
                <Layout>
                  <ProcurementMain />
                </Layout>
              </ProtectedRoute>
            } />


            {/* Suppliers routes */}
            <Route path="/procurement/suppliers" element={
              <ProtectedRoute>
                <Layout>
                  <SuppliersList />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/procurement/suppliers/create" element={
              <ProtectedRoute>
                <Layout>
                  <SupplierCreate />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/procurement/suppliers/:id" element={
              <ProtectedRoute>
                <Layout>
                  <SupplierView />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Purchase Requisitions routes */}
            <Route path="/procurement/purchase-requisitions" element={
              <ProtectedRoute>
                <Layout>
                  <PurchaseRequisitionsList />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/procurement/purchase-requisitions/create" element={
              <ProtectedRoute>
                <Layout>
                  <PurchaseRequisitionCreate />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/procurement/purchase-requisitions/:id" element={
              <ProtectedRoute>
                <Layout>
                  <PurchaseRequisitionView />
                </Layout>
              </ProtectedRoute>
            } />

            {/* RFQs routes */}
            <Route path="/procurement/rfqs" element={
              <ProtectedRoute>
                <Layout>
                  <RFQsList />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/procurement/rfqs/create" element={
              <ProtectedRoute>
                <Layout>
                  <RFQCreate />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/procurement/rfqs/:id" element={
              <ProtectedRoute>
                <Layout>
                  <RFQView />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Purchase Orders routes */}
            <Route path="/procurement/purchase-orders" element={
              <ProtectedRoute>
                <Layout>
                  <POsList />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/procurement/purchase-orders/create" element={
              <ProtectedRoute>
                <Layout>
                  <POCreate />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/procurement/purchase-orders/:id" element={
              <ProtectedRoute>
                <Layout>
                  <POView />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Delivery Tracking Hub */}
            <Route path="/procurement/delivery-tracking" element={
              <ProtectedRoute requiredRole="MANAGER">
                <Layout>
                  <DeliveryTrackingHub />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Goods Receipts routes */}
            <Route path="/procurement/goods-receipts" element={
              <ProtectedRoute>
                <Layout>
                  <GoodsReceiptHistory />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/procurement/goods-receipts/create" element={
              <ProtectedRoute>
                <Layout>
                  <GoodsReceiptCreate />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Contracts routes */}
            <Route path="/procurement/contracts" element={
              <ProtectedRoute>
                <Layout>
                  <ContractsList />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/procurement/contracts/create" element={
              <ProtectedRoute>
                <Layout>
                  <ContractCreate />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/procurement/contracts/:id" element={
              <ProtectedRoute>
                <Layout>
                  <ContractView />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/procurement/contracts-review" element={
              <ProtectedRoute requiredRole="MANAGER">
                <Layout>
                  <ProcurementReview />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Sales routes */}
            <Route path="/sales/customers" element={
              <ProtectedRoute>
                <Layout>
                  <CustomersList />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/sales/customers/create" element={
              <ProtectedRoute>
                <Layout>
                  <CustomerCreate />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/sales/customers/:id/edit" element={
              <ProtectedRoute>
                <Layout>
                  <CustomerEdit />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/sales/customers/:id" element={
              <ProtectedRoute>
                <Layout>
                  <CustomerView />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Sales Orders routes */}
            <Route path="/sales/overview" element={
              <ProtectedRoute>
                <Layout>
                  <SalesOverview />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/sales/sales-orders" element={
              <ProtectedRoute>
                <Layout>
                  <SalesOrdersList />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/sales/sales-orders/create" element={
              <ProtectedRoute>
                <Layout>
                  <SalesOrderCreate />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/sales/sales-orders/:id/edit" element={
              <ProtectedRoute>
                <Layout>
                  <SalesOrderEdit />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/sales/sales-orders/:id" element={
              <ProtectedRoute>
                <Layout>
                  <SalesOrderView />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Sales Quotations routes */}
            <Route path="/sales/quotations" element={
              <ProtectedRoute>
                <Layout>
                  <SalesQuotationsList />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/sales/quotations/create" element={
              <ProtectedRoute>
                <Layout>
                  <SalesQuotationCreate />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/sales/quotations/:id/edit" element={
              <ProtectedRoute>
                <Layout>
                  <SalesQuotationEdit />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/sales/quotations/:id" element={
              <ProtectedRoute>
                <Layout>
                  <SalesQuotationView />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Sales Contracts routes */}
            <Route path="/sales/contracts" element={
              <ProtectedRoute>
                <Layout>
                  <SalesContractsList />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/sales/contracts/create" element={
              <ProtectedRoute>
                <Layout>
                  <SalesContractCreate />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/sales/contracts/:id/edit" element={
              <ProtectedRoute>
                <Layout>
                  <SalesContractEdit />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/sales/contracts/:id" element={
              <ProtectedRoute>
                <Layout>
                  <SalesContractView />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Sales RFQs routes */}
            <Route path="/sales/rfqs" element={
              <ProtectedRoute>
                <Layout>
                  <SalesRfqsList />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/sales/rfqs/create" element={
              <ProtectedRoute>
                <Layout>
                  <SalesRfqCreate />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/sales/rfqs/:id/edit" element={
              <ProtectedRoute>
                <Layout>
                  <SalesRfqEdit />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/sales/rfqs/:id" element={
              <ProtectedRoute>
                <Layout>
                  <SalesRfqView />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Delivery Scheduling routes */}
            <Route path="/sales/delivery-scheduling" element={
              <ProtectedRoute>
                <Layout>
                  <DeliveryScheduling />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/sales/delivery-schedules" element={
              <ProtectedRoute>
                <Layout>
                  <DeliverySchedulesList />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/sales/delivery-schedules/create" element={
              <ProtectedRoute>
                <Layout>
                  <DeliveryScheduling />
                </Layout>
              </ProtectedRoute>
            } />
            
            {/* Finance routes */}
            <Route path="/finance/dashboard" element={
              <ProtectedRoute>
                <Layout>
                  <FinanceDashboard />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/finance/chart-of-accounts" element={
              <ProtectedRoute>
                <Layout>
                  <ChartOfAccountsList />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/finance/chart-of-accounts/create" element={
              <ProtectedRoute>
                <Layout>
                  <ChartOfAccountsCreate />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/finance/journal-entries" element={
              <ProtectedRoute>
                <Layout>
                  <JournalEntriesList />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/finance/journal-entries/create" element={
              <ProtectedRoute>
                <Layout>
                  <JournalEntryForm />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/finance/reports/trial-balance" element={
              <ProtectedRoute>
                <Layout>
                  <TrialBalance />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/finance/reports/balance-sheet" element={
              <ProtectedRoute>
                <Layout>
                  <EnhancedBalanceSheet />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/finance/reports/income-statement" element={
              <ProtectedRoute>
                <Layout>
                  <EnhancedIncomeStatement />
                </Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/finance/journal-dashboard" element={
              <ProtectedRoute>
                <Layout>
                  <JournalEntriesDashboard />
                </Layout>
              </ProtectedRoute>
            } />
            
            
            <Route path="/finance/reports" element={
              <ProtectedRoute>
                <Layout>
                  <FinancialReports />
                </Layout>
              </ProtectedRoute>
            } />
            
            {/* AI Chat route */}
            <Route path="/ai/chat" element={
              <ProtectedRoute>
                <Layout>
                  <AIChat />
                </Layout>
              </ProtectedRoute>
            } />

            {/* AI Business Intelligence */}
            <Route path="/ai/business-intelligence" element={
              <ProtectedRoute>
                <Layout>
                  <BusinessIntelligence />
                </Layout>
              </ProtectedRoute>
            } />

            {/* AI Transaction Analysis */}
            <Route path="/ai/transaction-analysis" element={
              <ProtectedRoute>
                <Layout>
                  <TransactionAnalysis />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Accounts Receivable â€” Customer Invoices */}
            <Route path="/finance/customer-invoices" element={
              <ProtectedRoute>
                <Layout>
                  <CustomerInvoices />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Accounts Receivable â€” Customer Payments */}
            <Route path="/finance/customer-payments" element={
              <ProtectedRoute>
                <Layout>
                  <CustomerPayments />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Accounts Payable â€” Supplier Invoices */}
            <Route path="/finance/supplier-invoices" element={
              <ProtectedRoute>
                <Layout>
                  <SupplierInvoices />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Accounts Payable â€” Supplier Payments */}
            <Route path="/finance/supplier-payments" element={
              <ProtectedRoute>
                <Layout>
                  <SupplierPayments />
                </Layout>
              </ProtectedRoute>
            } />

            {/* AR/AP Aging report */}
            <Route path="/finance/reports/aging" element={
              <ProtectedRoute>
                <Layout>
                  <AgingReport />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Cash flow statement (indirect method, ties to trial balance) */}
            <Route path="/finance/reports/cash-flow-statement" element={
              <ProtectedRoute>
                <Layout>
                  <CashFlowStatement />
                </Layout>
              </ProtectedRoute>
            } />

            {/* VAT return summary */}
            <Route path="/finance/reports/vat" element={
              <ProtectedRoute>
                <Layout>
                  <VatReport />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Fixed Assets */}
            <Route path="/finance/fixed-assets" element={
              <ProtectedRoute>
                <Layout>
                  <FixedAssets />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Bank Reconciliation */}
            <Route path="/finance/bank" element={
              <ProtectedRoute>
                <Layout>
                  <BankReconciliation />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Cash Flow Forecast (AI behaviour-based P10/P50/P90) */}
            <Route path="/finance/cash-forecast" element={
              <ProtectedRoute>
                <Layout>
                  <CashFlowForecast />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Cost Centers */}
            <Route path="/finance/cost-centers" element={
              <ProtectedRoute>
                <Layout>
                  <CostCenters />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Budgets */}
            <Route path="/finance/budgets" element={
              <ProtectedRoute>
                <Layout>
                  <Budgets />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Currencies & FX */}
            <Route path="/finance/currencies" element={
              <ProtectedRoute>
                <Layout>
                  <Currencies />
                </Layout>
              </ProtectedRoute>
            } />

            {/* HR â€” Employees */}
            <Route path="/hr/overview" element={
              <ProtectedRoute>
                <Layout>
                  <HrOverview />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/hr/employees" element={
              <ProtectedRoute>
                <Layout>
                  <Employees />
                </Layout>
              </ProtectedRoute>
            } />

            {/* HR â€” Payroll */}
            <Route path="/hr/leave-attendance" element={
              <ProtectedRoute>
                <Layout>
                  <LeaveAttendance />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/hr/payroll" element={
              <ProtectedRoute>
                <Layout>
                  <Payroll />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Finance Overview (executive dashboard) */}
            <Route path="/finance/overview" element={
              <ProtectedRoute>
                <Layout>
                  <ExecutiveDashboard />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Financial module overviews */}
            <Route path="/finance/gl-overview" element={
              <ProtectedRoute>
                <Layout>
                  <GlOverview />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/finance/ar-overview" element={
              <ProtectedRoute>
                <Layout>
                  <ArOverview />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/finance/ap-overview" element={
              <ProtectedRoute>
                <Layout>
                  <ApOverview />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/finance/assets-cash-overview" element={
              <ProtectedRoute>
                <Layout>
                  <AssetsCashOverview />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/finance/controlling-overview" element={
              <ProtectedRoute>
                <Layout>
                  <ControllingOverview />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/finance/reports-overview" element={
              <ProtectedRoute>
                <Layout>
                  <FinanceReportsOverview />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Manufacturing â€” production, bills of material and MRP */}
            <Route path="/manufacturing" element={
              <ProtectedRoute>
                <Layout>
                  <ProductionDashboard />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/manufacturing/overview" element={<Navigate to="/manufacturing" replace />} />
            <Route path="/manufacturing/work-orders" element={
              <ProtectedRoute>
                <Layout>
                  <WorkOrders />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/manufacturing/boms" element={
              <ProtectedRoute>
                <Layout>
                  <BillsOfMaterial />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/manufacturing/mrp-workbench" element={
              <ProtectedRoute>
                <Layout>
                  <MRPWorkbench />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/manufacturing/work-centers" element={
              <ProtectedRoute>
                <Layout>
                  <WorkCenterDashboard />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Reporting â€” saved reports, exports and scheduled distribution.
                "schedules" is declared before ":id" so it is not read as a
                report id. */}
            {/* Intelligence — Analytics and Simeli AI overviews */}
            <Route path="/analytics/overview" element={
              <ProtectedRoute>
                <Layout>
                  <AnalyticsOverview />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/ai/overview" element={
              <ProtectedRoute>
                <Layout>
                  <QiraAiOverview />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Governance — Delegation of Authority overview */}
            <Route path="/doa/overview" element={
              <ProtectedRoute>
                <Layout>
                  <DoaOverview />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/reports" element={
              <ProtectedRoute>
                <Layout>
                  <Reports />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/reports/schedules" element={
              <ProtectedRoute>
                <Layout>
                  <ReportSchedules />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/reports/dashboards" element={
              <ProtectedRoute>
                <Layout>
                  <DashboardList />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/reports/dashboards/:id" element={
              <ProtectedRoute>
                <Layout>
                  <DashboardView />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/reports/:id" element={
              <ProtectedRoute>
                <Layout>
                  <ReportViewer />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Administration â€” governance and integrations */}
            <Route path="/admin/audit-trail" element={
              <ProtectedRoute>
                <Layout>
                  <AuditTrail />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/admin/integrations" element={
              <ProtectedRoute>
                <Layout>
                  <Integrations />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/admin/gateway" element={
              <ProtectedRoute requiredRole="MANAGER">
                <Layout>
                  <AIGateway />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/admin/modules" element={
              <ProtectedRoute>
                <Layout>
                  <Modules />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/admin/overview" element={
              <ProtectedRoute>
                <Layout>
                  <AdminOverview />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/admin/users" element={
              <ProtectedRoute requiredRole="ADMIN">
                <Layout>
                  <UserManagement />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/admin/mailboxes" element={
              <ProtectedRoute requiredRole="ADMIN">
                <Layout>
                  <Mailboxes />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/admin/mail-design" element={
              <ProtectedRoute requiredRole="ADMIN">
                <Layout>
                  <MailDesign />
                </Layout>
              </ProtectedRoute>
            } />
            {/* ownerOnly, not requiredRole="ADMIN": request counters and table
                sizes describe the instance, not a tenant, so a customer's own
                administrator must not see them. Mirrors requirePlatformOwner on
                the endpoint. */}
            <Route path="/admin/statistics" element={
              <ProtectedRoute ownerOnly>
                <Layout>
                  <AppStatistics />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/warehouse/transfers" element={
              <ProtectedRoute>
                <Layout>
                  <InventoryTransfers />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/stocktake" element={
              <ProtectedRoute>
                <Layout>
                  <StocktakeSheetsList />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/stocktake/:id" element={
              <ProtectedRoute>
                <Layout>
                  <StocktakeCountEntry />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/finance/credit-notes" element={
              <ProtectedRoute>
                <Layout>
                  <CreditNotesList />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/finance/gr-ir-aging" element={
              <ProtectedRoute>
                <Layout>
                  <GrIrAging />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/finance/year-end-close" element={
              <ProtectedRoute>
                <Layout>
                  <YearEndClose />
                </Layout>
              </ProtectedRoute>
            } />

            <Route path="/finance/recurring-invoices" element={
              <ProtectedRoute>
                <Layout>
                  <RecurringInvoices />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Autonomous agents â€” control plane, escalations and run history */}
            <Route path="/agents" element={
              <ProtectedRoute>
                <Layout>
                  <Agents />
                </Layout>
              </ProtectedRoute>
            } />

            {/* The meta-layer: building agents and tools, not just running them.
                /ai/agents/new is declared before /ai/agents/:key so "new" is not
                read as the key of an agent that does not exist. */}
            <Route path="/ai/agents/new" element={
              <ProtectedRoute>
                <Layout>
                  <AgentBuilder />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/ai/agents/:key" element={
              <ProtectedRoute>
                <Layout>
                  <AgentBuilder />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/ai/tools" element={
              <ProtectedRoute>
                <Layout>
                  <ToolLibrary />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/ai/documents" element={
              <ProtectedRoute>
                <Layout>
                  <PdfTemplates />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/ai/knowledge-base" element={
              <ProtectedRoute>
                <Layout>
                  <KnowledgeBase />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/ai/governance" element={
              <ProtectedRoute>
                <Layout>
                  <AIGovernance />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/ai/findings" element={
              <ProtectedRoute>
                <Layout>
                  <AIFindingsDashboard />
                </Layout>
              </ProtectedRoute>
            } />
            {/* Counterfactual decisions — courses of action measured against the
                real ledger inside a rolled-back transaction. */}
            <Route path="/ai/decisions" element={
              <ProtectedRoute>
                <Layout>
                  <DecisionSimulator />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/ai/settings" element={
              <ProtectedRoute>
                <Layout>
                  <AISettings />
                </Layout>
              </ProtectedRoute>
            } />

            {/* CRM â€” contacts, pipeline and activities */}
            <Route path="/crm" element={
              <ProtectedRoute>
                <Layout>
                  <Pipeline />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/crm/overview" element={
              <ProtectedRoute>
                <Layout>
                  <CrmOverview />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/crm/leads" element={
              <ProtectedRoute>
                <Layout>
                  <LeadsList />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/crm/pipeline" element={
              <ProtectedRoute>
                <Layout>
                  <Pipeline />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/crm/contacts" element={
              <ProtectedRoute>
                <Layout>
                  <Contacts />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/crm/import" element={
              <ProtectedRoute>
                <Layout>
                  <ImportContacts />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/crm/activities" element={
              <ProtectedRoute>
                <Layout>
                  <Activities />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Projects, time tracking and billing */}
            <Route path="/projects/overview" element={
              <ProtectedRoute>
                <Layout>
                  <ProjectsOverview />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/projects" element={
              <ProtectedRoute>
                <Layout>
                  <Projects />
                </Layout>
              </ProtectedRoute>
            } />
            {/* Static segment declared before /:id so it is not read as an id. */}
            <Route path="/projects/timesheet" element={
              <ProtectedRoute>
                <Layout>
                  <Timesheet />
                </Layout>
              </ProtectedRoute>
            } />
            <Route path="/projects/:id" element={
              <ProtectedRoute>
                <Layout>
                  <ProjectDetail />
                </Layout>
              </ProtectedRoute>
            } />

            {/* Accounting Periods (period close) */}
            <Route path="/finance/periods" element={
              <ProtectedRoute>
                <Layout>
                  <AccountingPeriods />
                </Layout>
              </ProtectedRoute>
            } />

            {/* ---------------------------------------------------------------
                The application platform, internal side.

                `/apps/:appKey/*` is the ONLY route a generated application
                needs. Supplier Quality, Customer Warranty and an application
                nobody has designed yet all render through the same component,
                from the specification the server sends. There is no per-
                application page here and there is not meant to be.
                --------------------------------------------------------------- */}
            {/* ONE route with an optional parameter, not two routes.
                Two separate <Route> declarations are two different matches, so
                the navigate() from /studio to /studio/:sessionId that happens
                the moment a build finishes UNMOUNTED the Studio and remounted
                it — throwing away its state, including the build progress the
                user was watching. The panel vanished for a frame and the empty
                "nothing built yet" state flashed in its place. */}
            <Route path="/studio/:sessionId?" element={
              <ProtectedRoute><Layout><Studio /></Layout></ProtectedRoute>
            } />
            <Route path="/applications" element={
              <ProtectedRoute><Layout><Applications /></Layout></ProtectedRoute>
            } />
            <Route path="/marketplace" element={
              <ProtectedRoute><Layout><Marketplace /></Layout></ProtectedRoute>
            } />
            <Route path="/applications/:appKey" element={
              <ProtectedRoute><Layout><ApplicationDetail /></Layout></ProtectedRoute>
            } />
            <Route path="/capability-opportunities" element={
              <ProtectedRoute><Layout><Opportunities /></Layout></ProtectedRoute>
            } />
            <Route path="/apps/:appKey" element={
              <ProtectedRoute><Layout><AppRuntime client={platformAPI} basePath="/apps" /></Layout></ProtectedRoute>
            } />
            <Route path="/apps/:appKey/:pageKey" element={
              <ProtectedRoute><Layout><AppRuntime client={platformAPI} basePath="/apps" /></Layout></ProtectedRoute>
            } />
            <Route path="/apps/:appKey/:pageKey/:recordId" element={
              <ProtectedRoute><Layout><AppRuntime client={platformAPI} basePath="/apps" /></Layout></ProtectedRoute>
            } />

            {/* Anything unmatched. Must stay last: React Router picks the best
                match, but keeping it here also keeps it obvious that nothing
                below it can ever run. Rendered inside Layout so someone who
                mistypes a URL keeps their navigation instead of being dropped
                onto a bare page. */}
            <Route path="*" element={
              <Layout>
                <NotFound />
              </Layout>
            } />

          </Routes>
          </Suspense>
          </RoutedBoundary>

          {/* First-visit cookie consent. Sits above every route, public or
              authenticated, because the choice belongs to the person, not the
              session. */}
          <CookieConsent />

          <ToastHost />
        </div>
        </LocalisedApp>
       </CompanyProvider>
      </AuthProvider>
    </Router>
    </QueryClientProvider>
  )
}

export default App