import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { useI18n } from '../../contexts/I18nContext'
import {
  PageHeader, Button, Card, Stat, Money, Num, ErrorState, SkeletonRows, Provenance, BarChart, Distribution,
  formatMoney,
} from '../../components/ui'
import { ModuleLinks } from './FinanceParts'
import MarginDrivers from '../../components/finance/MarginDrivers'
import CashOutlook from '../../components/finance/CashOutlook'

/**
 * Ledger position — the balances on the chart of accounts, by account type,
 * and the last 30 days of posted activity. One source: /finance/dashboard.
 * Balances are shown as the ledger holds them; a type with no active accounts
 * is absent rather than zero.
 */

const TYPE_LABEL = { ASSET: 'Assets', LIABILITY: 'Liabilities', EQUITY: 'Equity', REVENUE: 'Revenue', EXPENSE: 'Expenses' }
const money0 = (v) => formatMoney(v, 'USD', 0)
const dayLabel = (d) => new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

export default function FinanceDashboard() {
  const { t } = useI18n()
  const { data, loading, error, refetch } = useResource(['finance', 'dashboard'], ({ signal }) => api.get('/finance/dashboard', { signal }))

  const kpis = data?.kpis || {}
  const balanceSheet = Array.isArray(data?.balanceSheet) ? data.balanceSheet : []
  const incomeStatement = Array.isArray(data?.incomeStatement) ? data.incomeStatement : []
  const trends = Array.isArray(data?.accountTrends) ? data.accountTrends : []
  const all = [...balanceSheet, ...incomeStatement]
  const grand = all.reduce((s, a) => s + Math.abs(Number(a.total_balance) || 0), 0)
  const toItems = (rows) => rows.map((a) => ({
    label: TYPE_LABEL[a.account_type] || a.account_type,
    value: Math.abs(Number(a.total_balance) || 0),
    to: '/finance/chart-of-accounts',
  }))

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('ui.financialDashboard')}
        description={t('ui.currentLedgerPosition')}
        secondary={<Button to="/finance/reports-overview">{t('ui.financialReports')}</Button>}
        primary={<Button variant="primary" to="/finance/journal-entries/create">New journal entry</Button>}
      />

      {error ? (
        <ErrorState error={error} what="The ledger position" onRetry={refetch} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label={t('ui.totalAssets')} value={<Money amount={kpis.totalAssets} digits={0} />} loading={loading} footnote="Active, non-header asset accounts" to="/finance/reports/balance-sheet" />
            <Stat
              label={t('ui.netIncome2')}
              loading={loading}
              value={(
                <Provenance
                  method="Revenue less expenses, from the current balances of active, non-header revenue and expense accounts."
                  sources={[{ label: 'Revenue', value: money0(kpis.totalRevenue) }, { label: 'Expenses', value: money0(kpis.totalExpenses) }, { label: 'Open the income statement', to: '/finance/reports/income-statement' }]}
                >
                  <Money amount={kpis.netIncome} digits={0} />
                </Provenance>
              )}
            />
            <Stat label={t('ui.totalRevenue')} value={<Money amount={kpis.totalRevenue} digits={0} />} loading={loading} to="/finance/reports/income-statement" />
            <Stat label={t('ui.postedEntries30d')} value={<Num value={kpis.transactionCount} />} loading={loading} to="/finance/journal-entries" />
          </div>

          <MarginDrivers />

          <CashOutlook />

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Card title={t('ui.balanceSheetComposition')} description="Absolute balance by account type">
              {loading ? <SkeletonRows rows={3} columns={2} /> : (
                <Distribution items={toItems(balanceSheet)} format={money0} emptyText="No active balance-sheet accounts." />
              )}
            </Card>
            <Card title={t('ui.revenueVsExpenses')} description="Balances on revenue and expense accounts">
              {loading ? <SkeletonRows rows={2} columns={2} /> : (
                <Distribution items={toItems(incomeStatement)} format={money0} emptyText="No active revenue or expense accounts." />
              )}
            </Card>
          </div>

          <Card title={t('ui.accountActivityTrends')} description="Total debits posted per day, last 30 days">
            {loading ? <SkeletonRows rows={4} columns={3} /> : (
              <BarChart
                points={trends.map((r) => ({ x: dayLabel(r.date), y: Number(r.activity) || 0 }))}
                format={money0}
                title="Posted debits by day"
                emptyText="Nothing was posted in the last 30 days."
              />
            )}
          </Card>

          <Card title={t('ui.keyFinancialMetrics')} padded={false}>
            {loading ? <div className="p-4"><SkeletonRows rows={5} columns={4} /></div> : all.length === 0 ? (
              <p className="px-4 py-4 text-sm text-ink-600">No active accounts with balances yet. Add accounts in the chart of accounts.</p>
            ) : (
              <div className="overflow-x-auto ui-scroll">
                <table className="w-full min-w-[420px] text-sm">
                  <thead>
                    <tr className="border-b border-ink-200">
                      <th scope="col" className="label-mono px-4 py-2.5 text-left font-normal">{t('ui.account')}</th>
                      <th scope="col" className="label-mono px-4 py-2.5 text-right font-normal">{t('ui.balance')}</th>
                      <th scope="col" className="label-mono px-4 py-2.5 text-right font-normal">{t('ui.accounts')}</th>
                      <th scope="col" className="label-mono px-4 py-2.5 text-right font-normal">{t('ui.ofTotal')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {all.map((a) => {
                      const v = Math.abs(Number(a.total_balance) || 0)
                      return (
                        <tr key={a.account_type} className="border-b border-ink-100 last:border-0">
                          <td className="px-4 py-2 text-ink-900">{TYPE_LABEL[a.account_type] || a.account_type}</td>
                          <td className="px-4 py-2 text-right tabular-nums"><Money amount={v} digits={0} /></td>
                          <td className="px-4 py-2 text-right tabular-nums"><Num value={a.account_count} /></td>
                          <td className="px-4 py-2 text-right tabular-nums text-ink-700">{grand ? `${((v / grand) * 100).toFixed(1)}%` : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      <ModuleLinks
        items={[
          { label: t('ui.journalEntries'), description: t('ui.viewAndCreateTransactions'), to: '/finance/journal-entries' },
          { label: t('ui.financialReports'), description: t('ui.balanceSheetIncomeStatement'), to: '/finance/reports' },
          { label: t('ui.chartOfAccounts'), description: t('ui.manageAccountStructure'), to: '/finance/chart-of-accounts' },
          { label: t('ui.journalAnalytics'), description: t('ui.transactionInsights'), to: '/finance/journal-dashboard' },
        ]}
      />
    </div>
  )
}
