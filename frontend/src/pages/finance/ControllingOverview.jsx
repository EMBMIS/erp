import { Link } from 'react-router-dom'
import { ChevronRightIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { PageHeader, Button, Card, Stat, Num, StatusBadge, formatNumber } from '../../components/ui'

/**
 * Controlling — budgets, cost centers, currencies and the period calendar.
 * The counts come from the same lists those screens show.
 */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function AreaLinks({ items }) {
  return (
    <Card title="In this area" padded={false}>
      <ul className="divide-y divide-ink-100">
        {items.map((it) => (
          <li key={it.to}>
            <Link to={it.to} className="flex items-center gap-3 px-4 py-3 hover:bg-ink-50">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-fg">{it.name}</span>
                <span className="block text-xs text-ink-500">{it.description}</span>
              </span>
              {it.stat && <span className="shrink-0 text-right text-xs tabular-nums text-ink-600">{it.stat}</span>}
              <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  )
}

const list = (d) => (Array.isArray(d) ? d : [])

export default function ControllingOverview() {
  const { data: budgets, loading: bLoading, error: bError } = useResource(['budgets'], ({ signal }) => api.get('/budgets', { signal }))
  const { data: centers, loading: cLoading, error: cError } = useResource(['cost-centers'], ({ signal }) => api.get('/cost-centers', { signal }))
  const { data: periods, loading: pLoading, error: pError } = useResource(['accounting-periods', 'all'], ({ signal }) => api.get('/accounting-periods', { signal }))

  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1
  const current = list(periods).find((p) => Number(p.period_year) === year && Number(p.period_month) === month)
  const closedThisYear = list(periods).filter((p) => Number(p.period_year) === year && p.status === 'CLOSED').length
  const activeCenters = list(centers).filter((c) => c.status === 'ACTIVE').length
  const thisYearBudgets = list(budgets).filter((b) => Number(b.fiscal_year) === year).length
  const count = (d, err) => (err ? null : d ? list(d).length : null)

  return (
    <div className="space-y-5">
      <PageHeader
        title="Controlling"
        description="Budgets, cost centers, currencies and the accounting period calendar."
        primary={<Button variant="primary" to="/finance/budgets">Open budgets</Button>}
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Budgets" value={<Num value={count(budgets, bError)} />} loading={bLoading} reason={bError ? 'Did not load' : `${formatNumber(thisYearBudgets)} for FY${year}`} to="/finance/budgets" />
        <Stat label="Cost centers" value={<Num value={count(centers, cError)} />} loading={cLoading} reason={cError ? 'Did not load' : `${formatNumber(activeCenters)} active`} to="/finance/cost-centers" />
        <Stat
          label={`${MONTHS[month - 1]} ${year}`}
          value={pError ? <span className="text-ink-400">—</span> : <StatusBadge status={current?.status || 'OPEN'} />}
          loading={pLoading}
          reason={pError ? 'Did not load' : `${formatNumber(closedThisYear)} of 12 months closed this year`}
          to="/finance/periods"
        />
      </div>

      <AreaLinks
        items={[
          { name: 'Budgets', description: 'Annual budgets and budget against actual', to: '/finance/budgets', stat: count(budgets, bError) != null ? `${formatNumber(count(budgets, bError))} budgets` : null },
          { name: 'Cost centers', description: 'Departments that carry cost', to: '/finance/cost-centers', stat: count(centers, cError) != null ? `${formatNumber(count(centers, cError))} centers` : null },
          { name: 'Currencies & FX', description: 'Currencies, rates and conversion', to: '/finance/currencies' },
          { name: 'Accounting periods', description: 'Open and close months', to: '/finance/periods', stat: pError ? null : `${formatNumber(closedThisYear)} closed in ${year}` },
          { name: 'Chart of accounts', description: 'Ledger accounts and structure', to: '/finance/chart-of-accounts' },
        ]}
      />
    </div>
  )
}
