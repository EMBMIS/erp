import { PlusIcon } from '@heroicons/react/20/solid'
import api, { fixedAssetsAPI, bankAPI } from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { PageHeader, Button, Card, Stat, Money, Num, Badge, SkeletonRows, LineChart, formatMoney } from '../../components/ui'
import { ModuleLinks } from './FinanceParts'

/**
 * Assets & cash — the fixed-asset register's value, the bank accounts being
 * reconciled, and where cash is heading. Figures come from
 * /fixed-assets/stats, /bank/accounts and the 13-week cash forecast.
 */

// The forecast endpoint answers flat, without a `data` key.
const raw = (path) => async ({ signal }) => ({ data: { success: true, data: (await api.get(path, { signal })).data } })

const MODULES = [
  { label: 'Fixed assets', description: 'Register, depreciate, dispose', to: '/finance/fixed-assets' },
  { label: 'Bank reconciliation', description: 'Accounts and statement matching', to: '/finance/bank' },
  { label: 'Cash flow forecast', description: '13 weeks, with a confidence band', to: '/finance/cash-forecast' },
  { label: 'Currencies', description: 'Exchange rates and conversion', to: '/finance/currencies' },
  { label: 'Chart of accounts', description: 'Balance sheet accounts', to: '/finance/chart-of-accounts' },
]

export default function AssetsCashOverview() {
  const { data: assets, loading: assetsLoading } = useResource(['fixed-assets', 'stats'], () => fixedAssetsAPI.stats())
  const { data: accounts, loading: accountsLoading } = useResource(keys.bankAccounts(), () => bankAPI.listAccounts())
  const { data: cash, loading: cashLoading } = useResource(keys.cashForecast(), raw('/financial-reports/cashflow-forecast'), { staleTime: 0 })
  const bankList = Array.isArray(accounts) ? accounts : []
  const weeks = cash?.forecast_weeks || []
  const last = weeks[weeks.length - 1]

  return (
    <>
      <PageHeader
        title="Assets & cash"
        description="Fixed assets, bank accounts and the cash position ahead."
        secondary={<Button to="/finance/bank">Reconcile bank</Button>}
        primary={<Button variant="primary" icon={PlusIcon} to="/finance/fixed-assets">Add asset</Button>}
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Fixed assets" value={<Num value={assets?.total_assets} />} loading={assetsLoading} to="/finance/fixed-assets" footnote={assets?.active_assets != null ? `${assets.active_assets} active` : undefined} />
        <Stat label="Net book value" value={<Money amount={assets?.total_book_value} digits={0} />} loading={assetsLoading} footnote="Cost less accumulated depreciation" />
        <Stat label="Bank accounts" value={<Num value={accounts ? bankList.length : null} />} loading={accountsLoading} to="/finance/bank" />
        <Stat label="Cash today" value={<Money amount={cash?.starting_cash} digits={0} />} loading={cashLoading} to="/finance/cash-forecast" footnote="Active bank balances" />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card
          title="Cash, next 13 weeks"
          description="Expected balance (P50), with the P10–P90 band"
          actions={<Button size="sm" variant="ghost" to="/finance/cash-forecast">Open forecast</Button>}
        >
          {cashLoading ? <SkeletonRows rows={4} columns={2} /> : weeks.some((w) => [w.p10, w.p50, w.p90].some((v) => Number(v) !== 0)) ? (
            <>
              <LineChart
                points={weeks.map((w) => ({ x: `W${w.week}`, y: Number(w.p50), lo: Number(w.p10), hi: Number(w.p90) }))}
                format={(v) => formatMoney(v, 'USD', 0)}
                threshold={0}
                thresholdLabel="Zero"
                height={200}
              />
              {last && Number(last.p10) < 0 && (
                <p className="mt-2 flex items-center gap-2 text-xs text-ink-600">
                  <Badge tone="warn" glyph="triangle">Watch</Badge>
                  The conservative case (P10) ends below zero in week {last.week}.
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-ink-600">No forecast yet. It appears once there are bank balances, open invoices or bills to project from.</p>
          )}
        </Card>
        <ModuleLinks items={MODULES} />
      </div>
    </>
  )
}
