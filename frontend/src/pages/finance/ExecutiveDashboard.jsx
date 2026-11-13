import { Link } from 'react-router-dom'
import { ChevronRightIcon, PlusIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import {
  PageHeader, Button, Card, Stat, Money, Num, Variance, Badge, StatusBadge, InlineNotice, ErrorState,
  SkeletonRows, Provenance, Timeline, LineChart, Sparkline, formatMoney, formatNumber,
} from '../../components/ui'
import { AgingBar, ModuleLinks } from './FinanceParts'

/**
 * Finance — the module's overview. Five numbers (each with its trend and a link
 * to the records behind it), the cash forecast, the two sub-ledgers by age, the
 * profit and loss, the bank, the month-end gates and what needs attention.
 *
 * Every figure comes from a real endpoint; each source loads and fails on its
 * own, so one broken panel says so and leaves the rest of the screen working.
 * A figure the server could not give is "—", never a zero.
 */

const get = (path, params) => ({ signal }) => api.get(path, { params, signal })
// Endpoints that answer flat ({ success, summary } / { success, forecast_weeks }) with no
// `data` key: re-wrap so useResource hands over the whole body.
const raw = (path) => async ({ signal }) => ({ data: { success: true, data: (await api.get(path, { signal })).data } })
const list = (d) => (Array.isArray(d) ? d : d?.data || [])
const forbidden = (e) => e?.response?.status === 403
const money0 = (v) => formatMoney(v, 'USD', 0)
const humanize = (s) => String(s || '').toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

/** Change from the month before last to last month, or null when there is no basis. */
function lastChange(values) {
  const v = values.filter((n) => Number.isFinite(n))
  if (v.length < 2) return null
  const [a, b] = [v[v.length - 2], v[v.length - 1]]
  if (!a) return null
  return ((b - a) / Math.abs(a)) * 100
}

const AREAS = [
  { label: 'General ledger', description: 'Chart of accounts, journal entries, trial balance', to: '/finance/gl-overview' },
  { label: 'Receivables', description: 'Customer invoices, payments and credit notes', to: '/finance/ar-overview' },
  { label: 'Payables', description: 'Supplier invoices, payments and GR/IR', to: '/finance/ap-overview' },
  { label: 'Assets and cash', description: 'Fixed assets, bank reconciliation, cash forecast', to: '/finance/assets-cash-overview' },
  { label: 'Controlling', description: 'Cost centres, budgets and currencies', to: '/finance/controlling-overview' },
  { label: 'Reports', description: 'Balance sheet, income statement, cash flow, VAT', to: '/finance/reports-overview' },
]

/** A row of label and figure, figures right-aligned and tabular. */
function FigureRow({ label, children, strong }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="min-w-0 truncate text-sm text-ink-600">{label}</dt>
      <dd className={strong ? 'shrink-0 text-sm font-semibold tabular-nums text-fg' : 'shrink-0 text-sm tabular-nums text-ink-900'}>{children}</dd>
    </div>
  )
}

export default function ExecutiveDashboard() {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1

  const dash = useResource(['finance', 'dashboard'], get('/finance/dashboard'))
  const trends = useResource(['finance', 'kpi-trends', 12], get('/finance/kpi-trends', { months: 12 }))
  const ar = useResource(['customer-invoices', 'stats'], get('/customer-invoices/stats'))
  const ap = useResource(['supplier-invoices', 'stats'], get('/supplier-invoices/stats'))
  const arAging = useResource(['financial-reports', 'ar-aging'], raw('/financial-reports/ar-aging'))
  const apAging = useResource(['financial-reports', 'ap-aging'], raw('/financial-reports/ap-aging'))
  const forecast = useResource(['financial-reports', 'cashflow-forecast'], raw('/financial-reports/cashflow-forecast'))
  const banks = useResource(['bank-accounts'], get('/bank/accounts'))
  const firstBank = list(banks.data)[0]
  const bank = useResource(['bank-accounts', firstBank?.id, 'summary'], get(`/bank/accounts/${firstBank?.id}/summary`), { enabled: Boolean(firstBank?.id) })
  const close = useResource(['accounting-periods', 'pre-close', year, month], get(`/accounting-periods/${year}/${month}/pre-close-checks`), { retry: false })
  const activity = useResource(
    ['audit-trail', { limit: 6, scope: 'finance' }],
    get('/audit-trail', { limit: 6, entity_type: 'JOURNAL_ENTRY,CUSTOMER_INVOICE,CUSTOMER_PAYMENT,SUPPLIER_INVOICE,SUPPLIER_PAYMENT,CHART_OF_ACCOUNTS,FIXED_ASSET,BUDGET' }),
    { retry: (n, e) => !forbidden(e) && n < 2 }
  )
  const findings = useResource(['ai-findings', { status: 'OPEN', scope: 'finance' }], get('/ai-findings', { status: 'OPEN', entity_type: 'JOURNAL_ENTRY,CUSTOMER_INVOICE' }))

  const kpis = dash.data?.kpis || {}
  const months = Array.isArray(trends.data) ? trends.data : []
  const revenueSeries = months.map((m) => Number(m.revenue))
  const marginSeries = months.filter((m) => m.margin != null).map((m) => m.margin * 100)
  const weeks = Array.isArray(forecast.data?.forecast_weeks) ? forecast.data.forecast_weeks : []
  const startingCash = forecast.data?.starting_cash
  const breach = weeks.find((w) => Number(w.p50) < 0)
  const netMargin = Number(kpis.totalRevenue) > 0 ? (Number(kpis.netIncome) / Number(kpis.totalRevenue)) * 100 : null
  const arStats = ar.data || {}
  const apStats = ap.data || {}
  const checks = Array.isArray(close.data?.checks) ? close.data.checks : []
  const passed = checks.filter((c) => c.passed).length
  // A series of zeros is not a trend; it is an empty ledger. Draw nothing rather than a flat line that reads as "steady".
  const hasShape = (values) => values.filter((n) => Number.isFinite(n)).length >= 2 && values.some((n) => Number(n) !== 0)
  const flatForecast = !weeks.some((w) => [w.p10, w.p50, w.p90].some((v) => Number(v) !== 0))

  const attention = []
  if (Number(arStats.overdue_count) > 0) {
    attention.push({ tone: 'risk', label: `${formatNumber(arStats.overdue_count)} customer invoice${Number(arStats.overdue_count) === 1 ? ' is' : 's are'} overdue`, value: money0(arStats.overdue_amount), to: '/finance/reports/aging' })
  }
  if (breach) {
    attention.push({ tone: 'risk', label: `Expected cash goes below zero in week ${breach.week}`, value: money0(breach.p50), to: '/finance/cash-forecast' })
  }
  if (Number(bank.data?.unreconciled_count) > 0) {
    attention.push({ tone: 'warn', label: `${formatNumber(bank.data.unreconciled_count)} unmatched bank transaction${Number(bank.data.unreconciled_count) === 1 ? '' : 's'}`, value: money0(bank.data.unreconciled_amount), to: '/finance/bank' })
  }
  if (checks.length && passed < checks.length) {
    attention.push({ tone: 'warn', label: `${checks.length - passed} of ${checks.length} month-end gates still open`, value: `${Math.round((passed / checks.length) * 100)}%`, to: '/finance/periods' })
  }

  const openFindings = list(findings.data)
  const events = list(activity.data).map((row, i) => ({
    id: `${row.entity_type}-${row.entity_id}-${i}`,
    title: `${humanize(row.entity_type)} → ${humanize(row.to_status)}`,
    actor: row.changed_by_name || 'System',
    at: row.occurred_at,
  }))

  return (
    <div className="space-y-5">
      <PageHeader
        title="Finance"
        description="Where the ledger stands, what cash will do, and what needs a decision."
        secondary={<Button to="/finance/reports/trial-balance">Trial balance</Button>}
        primary={<Button variant="primary" icon={PlusIcon} to="/finance/journal-entries/create">New journal entry</Button>}
      />

      {dash.error && <ErrorState compact error={dash.error} what="The ledger totals" onRetry={dash.refetch} />}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat
          label="Revenue"
          value={<Money amount={dash.error ? null : kpis.totalRevenue} digits={0} />}
          loading={dash.loading}
          delta={lastChange(revenueSeries) == null ? null : <Variance value={lastChange(revenueSeries)} />}
          reason={lastChange(revenueSeries) == null ? 'Needs two months of posted revenue for a trend' : 'Last month against the month before'}
          footnote={hasShape(revenueSeries) ? <Sparkline values={revenueSeries} width={120} height={24} label="Posted revenue by month, last 12 months" /> : null}
          to="/finance/reports/income-statement"
        />
        <Stat
          label="Net margin"
          value={netMargin == null ? '—' : (
            <Provenance
              method="Net income divided by revenue, from the balances on the chart of accounts."
              sources={[{ label: 'Net income', value: money0(kpis.netIncome) }, { label: 'Revenue', value: money0(kpis.totalRevenue) }, { label: 'Open the income statement', to: '/finance/reports/income-statement' }]}
            >
              {`${netMargin.toFixed(1)}%`}
            </Provenance>
          )}
          loading={dash.loading}
          delta={marginSeries.length >= 2 ? <Variance value={marginSeries[marginSeries.length - 1] - marginSeries[marginSeries.length - 2]} format="number" /> : null}
          reason={netMargin == null ? 'No revenue posted, so no margin' : marginSeries.length >= 2 ? 'Points, last month against the month before' : null}
          footnote={hasShape(marginSeries) ? <Sparkline values={marginSeries} width={120} height={24} label="Net margin by month" /> : null}
        />
        <Stat
          label="Cash position"
          value={<Money amount={forecast.error ? null : startingCash} digits={0} />}
          loading={forecast.loading}
          reason={forecast.error ? 'The forecast did not load' : breach ? `Expected below zero in week ${breach.week}` : !weeks.length ? 'No forecast yet' : flatForecast ? 'No cash or open items to project' : `Positive across the ${weeks.length}-week forecast`}
          footnote={hasShape(weeks.map((w) => Number(w.p50))) ? <Sparkline values={weeks.map((w) => Number(w.p50))} width={120} height={24} label="Expected cash by week" /> : null}
          to="/finance/cash-forecast"
        />
        <Stat
          label="Receivables"
          value={<Money amount={ar.error ? null : arStats.total_outstanding} digits={0} />}
          loading={ar.loading}
          reason={Number(arStats.overdue_count) > 0 ? `${formatNumber(arStats.overdue_count)} overdue · ${money0(arStats.overdue_amount)}` : ar.data ? 'Nothing overdue' : null}
          to="/finance/customer-invoices"
        />
        <Stat
          label="Payables"
          value={<Money amount={ap.error ? null : (apStats.total_outstanding ?? apStats.total_unpaid)} digits={0} />}
          loading={ap.loading}
          reason={Number(apStats.overdue_amount) > 0 ? `${money0(apStats.overdue_amount)} overdue` : ap.data ? 'Owed to suppliers' : null}
          to="/finance/supplier-invoices"
        />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-5">
          <Card
            title="Cash forecast"
            description="Expected cash by week (P50), with the P10–P90 range shaded"
            actions={<Button size="sm" variant="ghost" to="/finance/cash-forecast">Details</Button>}
          >
            {forecast.loading ? <SkeletonRows rows={4} columns={3} /> : forecast.error ? (
              <ErrorState compact error={forecast.error} what="The cash forecast" onRetry={forecast.refetch} />
            ) : weeks.length < 2 || flatForecast ? (
              <p className="text-sm text-ink-600">Nothing to project: there is no bank balance and no open receivable or payable with a due date. The forecast fills in as invoices and bills are posted.</p>
            ) : (
              <>
                <LineChart
                  points={weeks.map((w) => ({ x: `W${w.week}`, y: Number(w.p50), lo: Number(w.p10), hi: Number(w.p90) }))}
                  format={money0}
                  threshold={0}
                  thresholdLabel="Zero"
                  title="Expected cash, next 13 weeks"
                />
                <p className="mt-2 text-sm text-ink-700">
                  {breach
                    ? <>Expected cash goes below zero in week {breach.week}{breach.date ? <> (week ending {breach.date})</> : null}.</>
                    : <>Expected cash stays positive across the {weeks.length}-week horizon.</>}
                </p>
              </>
            )}
          </Card>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Card title="Receivables by age" description="Open customer invoices, by days past due" actions={<Button size="sm" variant="ghost" to="/finance/reports/aging">Aging</Button>}>
              {arAging.loading ? <SkeletonRows rows={2} columns={3} /> : arAging.error ? (
                <ErrorState compact error={arAging.error} what="The receivables aging" onRetry={arAging.refetch} />
              ) : (
                <AgingBar summary={arAging.data?.summary} empty="No open receivables." note={arAging.data?.note} />
              )}
            </Card>
            <Card title="Payables by age" description="Open supplier invoices, by days past due" actions={<Button size="sm" variant="ghost" to="/finance/supplier-invoices">Bills</Button>}>
              {apAging.loading ? <SkeletonRows rows={2} columns={3} /> : apAging.error ? (
                <ErrorState compact error={apAging.error} what="The payables aging" onRetry={apAging.refetch} />
              ) : (
                <AgingBar summary={apAging.data?.summary} empty="No open payables." note={apAging.data?.note} />
              )}
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Card title="Profit and loss" description="Balances on revenue and expense accounts" actions={<Button size="sm" variant="ghost" to="/finance/reports/income-statement">Statement</Button>}>
              {dash.loading ? <SkeletonRows rows={4} columns={2} /> : dash.error ? <p className="text-sm text-ink-600">The ledger totals did not load.</p> : (
                <dl className="divide-y divide-ink-100">
                  <FigureRow label="Revenue"><Money amount={kpis.totalRevenue} /></FigureRow>
                  <FigureRow label="Expenses"><Money amount={kpis.totalExpenses} /></FigureRow>
                  <div className="border-t border-ink-300">
                    <FigureRow label="Net income" strong>
                      <Provenance
                        method="Revenue less expenses, from the current balances of active, non-header revenue and expense accounts."
                        sources={[{ label: 'Revenue', value: money0(kpis.totalRevenue) }, { label: 'Expenses', value: money0(kpis.totalExpenses) }]}
                      >
                        <Money amount={kpis.netIncome} />
                      </Provenance>
                    </FigureRow>
                  </div>
                  <FigureRow label="Posted entries, last 30 days"><Num value={kpis.transactionCount} /></FigureRow>
                </dl>
              )}
            </Card>

            <Card title="Bank and reconciliation" description={firstBank?.account_name || 'First bank account'} actions={<Button size="sm" variant="ghost" to="/finance/bank">Reconcile</Button>}>
              {banks.loading || (firstBank && bank.loading) ? <SkeletonRows rows={4} columns={2} /> : banks.error ? (
                <ErrorState compact error={banks.error} what="The bank accounts" onRetry={banks.refetch} />
              ) : !firstBank ? (
                <p className="text-sm text-ink-600">No bank account is set up yet. Add one under Bank to reconcile statements.</p>
              ) : bank.error ? (
                <ErrorState compact error={bank.error} what="The reconciliation summary" onRetry={bank.refetch} />
              ) : (
                <dl className="divide-y divide-ink-100">
                  <FigureRow label="Book balance" strong><Money amount={bank.data?.book_balance} /></FigureRow>
                  <FigureRow label="Statement balance"><Money amount={bank.data?.statement_balance} /></FigureRow>
                  <FigureRow label="Unmatched transactions"><Num value={bank.data?.unreconciled_count} /></FigureRow>
                  <FigureRow label="Reconciled">
                    {Number(bank.data?.total_lines) > 0
                      ? `${Math.round(((Number(bank.data.total_lines) - Number(bank.data.unreconciled_count || 0)) / Number(bank.data.total_lines)) * 100)}%`
                      : '—'}
                  </FigureRow>
                </dl>
              )}
            </Card>
          </div>

          <Card
            title="Month-end close"
            description={`Pre-close gates for ${now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`}
            actions={<Button size="sm" variant="ghost" to="/finance/periods">Periods</Button>}
            padded={false}
          >
            {close.loading ? <div className="p-4"><SkeletonRows rows={4} columns={2} /></div> : close.error ? (
              forbidden(close.error)
                ? <p className="p-4 text-sm text-ink-600">The pre-close gates are not available for your role.</p>
                : <div className="px-4"><ErrorState compact error={close.error} what="The pre-close checks" onRetry={close.refetch} /></div>
            ) : !checks.length ? (
              <p className="p-4 text-sm text-ink-600">The server returned no gates for this month.</p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {checks.map((c) => (
                  <li key={c.key} className="flex items-start justify-between gap-3 px-4 py-2.5" title={c.details || undefined}>
                    <span className="min-w-0 text-sm text-ink-900">{c.name}</span>
                    <StatusBadge status={c.passed ? 'COMPLETED' : c.severity === 'BLOCKING' ? 'BLOCKED' : 'PENDING'} label={c.passed ? 'Clear' : c.severity === 'BLOCKING' ? 'Blocking' : 'Pending'} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-5">
          <Card title="Needs attention" padded={false}>
            {attention.length === 0 ? (
              <p className="px-4 py-4 text-sm text-ink-600">Nothing needs a decision: no overdue invoices, no cash shortfall, no unmatched bank lines.{close.error ? ' The month-end gates did not load, so they are not counted here.' : ''}</p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {attention.map((a) => (
                  <li key={a.label}>
                    <Link to={a.to} className="flex items-center gap-3 px-4 py-2.5 hover:bg-ink-50">
                      <Badge tone={a.tone} glyph={a.tone === 'risk' ? 'triangle' : 'clock'} className="shrink-0">{a.tone === 'risk' ? 'Act' : 'Check'}</Badge>
                      <span className="min-w-0 flex-1 text-sm text-ink-900">{a.label}</span>
                      <span className="shrink-0 text-sm tabular-nums text-ink-700">{a.value}</span>
                      <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Simeli findings" description="Open findings on journals and invoices" actions={<Button size="sm" variant="ghost" to="/ai-findings">All</Button>} padded={false}>
            {findings.loading ? <div className="p-4"><SkeletonRows rows={3} columns={1} /></div> : findings.error ? (
              forbidden(findings.error)
                ? <p className="px-4 py-4 text-sm text-ink-600">Findings are not available for your role.</p>
                : <div className="px-4"><ErrorState compact error={findings.error} what="The findings" onRetry={findings.refetch} /></div>
            ) : openFindings.length === 0 ? (
              <p className="px-4 py-4 text-sm text-ink-600">Simeli has not flagged anything in the ledger.</p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {openFindings.slice(0, 4).map((f) => (
                  <li key={f.id}>
                    <Link to="/ai-findings" className="block px-4 py-2.5 hover:bg-ink-50">
                      <span className="flex items-center gap-2">
                        <Badge tone={f.severity === 'HIGH' ? 'risk' : f.severity === 'MEDIUM' ? 'warn' : 'ink'} className="shrink-0">{humanize(f.severity || 'LOW')}</Badge>
                        <span className="min-w-0 truncate text-sm font-medium text-fg">{f.title}</span>
                      </span>
                      {f.description && <span className="mt-0.5 block line-clamp-2 text-xs text-ink-600">{f.description}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Recent activity" description="Status changes on finance records">
            {activity.loading ? <SkeletonRows rows={4} columns={1} /> : activity.error ? (
              forbidden(activity.error)
                ? <InlineNotice>The audit trail is visible to managers and administrators.</InlineNotice>
                : <ErrorState compact error={activity.error} what="The activity" onRetry={activity.refetch} />
            ) : (
              <Timeline events={events} empty="No ledger activity recorded yet." />
            )}
          </Card>

          <ModuleLinks title="Finance areas" items={AREAS} />
        </div>
      </div>
    </div>
  )
}

