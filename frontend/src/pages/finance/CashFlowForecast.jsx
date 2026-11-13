import { useMemo, useState } from 'react'
import { ArrowDownTrayIcon, ListBulletIcon, BanknotesIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useI18n } from '../../contexts/I18nContext'
import {
  PageHeader, Button, DataTable, RowAction, Money, Stat, Card, Sheet, Badge, InlineNotice, MaturityBadge, ErrorState, EmptyState,
  SkeletonRows, LineChart, Provenance, exportCsv, formatMoney, relativeTime,
} from '../../components/ui'
import CashOutlook from '../../components/finance/CashOutlook'

/**
 * 13-week cash flow forecast with P10/P50/P90 bands.
 *
 * Contract: GET /financial-reports/cashflow-forecast answers flat
 * { success, starting_cash, forecast_weeks: [{ week, date, p10, p50, p90,
 * expected_inflow, expected_outflow }], generated_at } — no nested `data`
 * key — so the body is re-wrapped before unwrap() sees it.
 *
 * Drivers: each week can show what moves it. The service exposes net inflow
 * and outflow totals today; the per-driver shape (AR/AP/payroll/recurring/
 * loan/tax) is shown when a week carries `drivers`:
 *   [{ category, label, amount, direction: 'inflow'|'outflow' }]
 * Until then the sheet shows the totals and says they are not per driver.
 */
const DRIVER_LABEL = { AR: 'AR collections', AP: 'AP payments', PAYROLL: 'Payroll', RECURRING: 'Recurring invoices', LOAN: 'Loan schedule', TAX: 'Tax payments' }
const driverLabel = (c) => DRIVER_LABEL[String(c || '').toUpperCase()] || c || 'Other'
const direction = (d) => d.direction || (Number(d.amount) >= 0 ? 'inflow' : 'outflow')

function DriverList({ title, items, empty, sign }) {
  return (
    <div>
      <h3 className="label-mono mb-2">{title}</h3>
      {items.length ? (
        <ul className="divide-y divide-ink-100 rounded-lg border border-ink-200">
          {items.map((d, i) => (
            <li key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 truncate">{d.label || driverLabel(d.category)}{d.label && <span className="ml-2 text-xs text-ink-500">{driverLabel(d.category)}</span>}</span>
              <span className="tabular-nums">{sign}<Money amount={Math.abs(Number(d.amount))} digits={0} /></span>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-ink-500">{empty}</p>}
    </div>
  )
}

export default function CashFlowForecast() {
  const { t } = useI18n()
  const [weekFor, setWeekFor] = useState(null)

  const { data, loading, error, refetch, isFetching } = useResource(
    keys.cashForecast(),
    ({ signal }) => api.get('/financial-reports/cashflow-forecast', { signal })
      .then((res) => ({ data: { success: true, data: res.data } })),
    { staleTime: 0 }
  )
  const weeks = useMemo(() => (Array.isArray(data?.forecast_weeks) ? data.forecast_weeks : []), [data])
  const last = weeks[weeks.length - 1]
  const lowest = weeks.reduce((m, w) => (m == null || Number(w.p10) < Number(m.p10) ? w : m), null)

  const columns = useMemo(() => [
    { id: 'week', header: 'Week', accessor: (w) => Number(w.week), width: 90, mobile: 'title', cell: (w) => <span className="font-medium">Week {w.week}</span> },
    { id: 'date', header: 'Week ending', accessor: 'date', width: 130, mobile: 'subtitle' },
    { id: 'p10', header: 'P10', accessor: (w) => Number(w.p10), align: 'right', width: 130, cell: (w) => <Money amount={w.p10} digits={0} />, exportValue: (w) => w.p10 },
    { id: 'p50', header: 'P50 (expected)', accessor: (w) => Number(w.p50), align: 'right', width: 150, mobile: 'trailing', cell: (w) => <Money amount={w.p50} digits={0} className="font-semibold" />, exportValue: (w) => w.p50 },
    { id: 'p90', header: 'P90', accessor: (w) => Number(w.p90), align: 'right', width: 130, cell: (w) => <Money amount={w.p90} digits={0} />, exportValue: (w) => w.p90 },
    { id: 'in', header: 'Inflows', accessor: (w) => Number(w.expected_inflow), align: 'right', width: 130, cell: (w) => <Money amount={w.expected_inflow} digits={0} />, exportValue: (w) => w.expected_inflow },
    { id: 'out', header: 'Outflows', accessor: (w) => Number(w.expected_outflow), align: 'right', width: 130, cell: (w) => <Money amount={w.expected_outflow} digits={0} />, exportValue: (w) => w.expected_outflow },
    { id: 'net', header: 'Net', accessor: (w) => Number(w.expected_inflow || 0) - Number(w.expected_outflow || 0), align: 'right', width: 130, mobile: 'meta', cell: (w) => <Money amount={Number(w.expected_inflow || 0) - Number(w.expected_outflow || 0)} digits={0} signed /> },
  ], [])

  const drivers = Array.isArray(weekFor?.drivers) && weekFor.drivers.length ? weekFor.drivers : null

  return (
    <>
      <PageHeader
        title={t('ui.t13WeekCashFlowForecast')}
        badge={<MaturityBadge level="beta" title="Behaviour-based model; percentiles, not commitments" />}
        description="Expected cash balance for the next 13 weeks, with a P10 to P90 range from customer and supplier payment behaviour."
        meta={data?.generated_at ? <span>Generated {relativeTime(data.generated_at)}</span> : undefined}
        secondary={
          <>
            <Button icon={ArrowDownTrayIcon} disabled={!weeks.length} onClick={() => exportCsv(weeks, columns, 'cash-forecast.csv')}>Export</Button>
            <Button onClick={() => refetch()} loading={isFetching && !loading}>Refresh</Button>
          </>
        }
      />

      <CashOutlook className="mb-4" />

      {error ? (
        <ErrorState error={error} what="The cash flow forecast" onRetry={refetch} />
      ) : loading ? (
        <SkeletonRows rows={8} columns={6} />
      ) : !weeks.length ? (
        <Card>
          <EmptyState
            icon={BanknotesIcon}
            title="No forecast yet"
            description="The forecast projects from bank balances, open customer invoices and supplier bills. Add a bank account or record invoices and bills, then refresh."
            action={<Button to="/finance/bank">Open bank reconciliation</Button>}
          />
        </Card>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Cash today" value={<Money amount={data?.starting_cash} digits={0} />} footnote="Active bank balances" />
            <Stat label={`Expected, week ${last?.week}`} value={<Money amount={last?.p50} digits={0} />} footnote={last?.date ? `P50 · week ending ${last.date}` : 'P50'} />
            <Stat label={`Range, week ${last?.week}`} value={<span className="text-xl"><Money amount={last?.p10} digits={0} /> – <Money amount={last?.p90} digits={0} /></span>} footnote="P10 to P90" />
            <Stat
              label="Lowest point (P10)"
              value={<Money amount={lowest?.p10} digits={0} />}
              delta={lowest && Number(lowest.p10) < 0 ? <Badge tone="risk" glyph="triangle">Below zero</Badge> : null}
              footnote={lowest ? `Week ${lowest.week}${lowest.date ? ` · ${lowest.date}` : ''}` : undefined}
            />
          </div>

          <Card className="mb-4" title="Projected cash balance by week" description="Line: expected (P50). Band: P10 to P90." actions={<span className="text-xs text-ink-600"><Provenance method="Percentiles of a behaviour-based simulation over open invoices, bills and recurring items, starting from active bank balances." sources={[{ label: 'Cash today', value: formatMoney(data?.starting_cash, 'USD', 0) }]}>How this is calculated</Provenance></span>}>
            {!weeks.some((w) => [w.p10, w.p50, w.p90].some((v) => Number(v) !== 0)) ? (
              <p className="text-sm text-ink-600">Nothing to project: there is no bank balance and no open invoice, bill or recurring item with a due date. The forecast fills in as they are posted.</p>
            ) : (
            <LineChart
              points={weeks.map((w) => ({ x: `W${w.week}`, y: Number(w.p50), lo: Number(w.p10), hi: Number(w.p90) }))}
              format={(v) => formatMoney(v, 'USD', 0)}
              threshold={0}
              thresholdLabel="Zero"
              height={260}
              title="Expected cash (P50) with the P10–P90 range"
            />
            )}
          </Card>

          <DataTable
            viewKey="finance.cash-forecast"
            caption={t('ui.t13WeekCashFlowForecastWith')}
            noun="week"
            rowKey={(w) => w.week}
            rows={weeks}
            columns={columns}
            search={false}
            defaultSort={{ id: 'week', dir: 'asc' }}
            onRowClick={(w) => setWeekFor(w)}
            rowActions={(w) => <RowAction icon={ListBulletIcon} label={`What drives week ${w.week}`} onClick={() => setWeekFor(w)} />}
          />
        </>
      )}

      <Sheet
        open={Boolean(weekFor)}
        onClose={() => setWeekFor(null)}
        title={weekFor ? `Week ${weekFor.week}` : ''}
        description={weekFor?.date ? `Week ending ${weekFor.date}` : undefined}
      >
        {weekFor && (
          <div className="space-y-5">
            <dl className="grid grid-cols-3 gap-3">
              <div><dt className="label-mono">P10</dt><dd className="mt-1 text-sm font-medium"><Money amount={weekFor.p10} digits={0} /></dd></div>
              <div><dt className="label-mono">P50</dt><dd className="mt-1 text-sm font-semibold"><Money amount={weekFor.p50} digits={0} /></dd></div>
              <div><dt className="label-mono">P90</dt><dd className="mt-1 text-sm font-medium"><Money amount={weekFor.p90} digits={0} /></dd></div>
            </dl>
            {drivers ? (
              <>
                <DriverList title="Inflows" items={drivers.filter((d) => direction(d) === 'inflow')} empty="No inflow drivers reported for this week." sign="+" />
                <DriverList title="Outflows" items={drivers.filter((d) => direction(d) === 'outflow')} empty="No outflow drivers reported for this week." sign="−" />
              </>
            ) : (
              <>
                <dl className="divide-y divide-ink-100 rounded-lg border border-ink-200 text-sm">
                  <div className="flex items-center justify-between px-3 py-2"><dt>Collections (inflows)</dt><dd>+<Money amount={weekFor.expected_inflow} digits={0} /></dd></div>
                  <div className="flex items-center justify-between px-3 py-2"><dt>Disbursements (AP, payroll)</dt><dd>−<Money amount={weekFor.expected_outflow} digits={0} /></dd></div>
                </dl>
                <InlineNotice>These are this week's totals. The forecast service does not yet break them down by driver (AR, AP, payroll, recurring, loans, tax).</InlineNotice>
              </>
            )}
          </div>
        )}
      </Sheet>
    </>
  )
}
