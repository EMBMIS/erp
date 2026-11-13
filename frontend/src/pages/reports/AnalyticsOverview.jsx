import { Link } from 'react-router-dom'
import { ChevronRightIcon, ExclamationTriangleIcon } from '@heroicons/react/20/solid'
import api, { reportsAPI } from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, Card, Stat, Num, Variance, Badge, StatusBadge, ErrorState, EmptyState, SkeletonRows,
  LineChart, DateText, relativeTime, formatNumber,
} from '../../components/ui'

/**
 * Analytics — the reporting module's own overview.
 *
 * THIS SCREEN COUNTS RUNS, NOT VIEWS
 * ---------------------------------------------------------------------------
 * Nothing in this system records that somebody looked at a report. What is
 * recorded is that one was executed, by hand or by a schedule, with its row
 * count, duration and outcome. A dashboard left open all day produces no
 * runs; a nightly schedule nobody reads produces hundreds. Labelling runs as
 * "views" would rank automated schedules above the reports people open.
 *
 * FAILURES GET THEIR OWN CARD
 * ---------------------------------------------------------------------------
 * A reporting overview that counts only successes is the best hiding place in
 * an ERP for a nightly report that broke three weeks ago. Failed runs are a
 * headline number here, and the reports behind them are named.
 */

const humanize = (s) => String(s || '').toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
const n = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

function monthShort(key) {
  const [y, m] = String(key || '').split('-').map(Number)
  if (!Number.isInteger(y) || !Number.isInteger(m)) return String(key || '—')
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
}

/** An interval in seconds, said the way a person would say it. */
function cadence(seconds) {
  const s = n(seconds)
  if (!s) return '—'
  if (s % 604800 === 0) return s === 604800 ? 'Weekly' : `Every ${s / 604800} weeks`
  if (s % 86400 === 0) return s === 86400 ? 'Daily' : `Every ${s / 86400} days`
  if (s % 3600 === 0) return s === 3600 ? 'Hourly' : `Every ${s / 3600} hours`
  return `Every ${Math.round(s / 60)} min`
}

const duration = (ms) => (n(ms) == null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`)

function ListRow({ to, title, sub, trailing }) {
  return (
    <li>
      <Link to={to} className="flex items-center gap-3 px-4 py-2.5 hover:bg-ink-50">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-fg">{title}</span>
          {sub && <span className="block truncate text-xs text-ink-500">{sub}</span>}
        </span>
        {trailing && <span className="shrink-0 text-right">{trailing}</span>}
        <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />
      </Link>
    </li>
  )
}

export default function AnalyticsOverview() {
  const analytics = useResource([...keys.reports(), 'analytics', 12], () => reportsAPI.analytics(12), { retry: false })
  const findingsQ = useResource(keys.aiFindings({ status: 'OPEN' }), () => api.get('/ai-findings?status=OPEN'), { retry: false })

  const a = analytics.data || {}
  const totals = a.totals || {}
  const categories = a.categories || []
  const byType = a.by_type || {}
  const dashboards = a.dashboards || []
  const recent = a.recent || []
  const schedules = a.schedules || []
  const failures = a.failures || []
  const series = a.series || []
  const findings = Array.isArray(findingsQ.data) ? findingsQ.data : []

  const runs = series.map((r) => n(r.runs))
  const prev = runs.length >= 2 ? runs[runs.length - 2] : null
  const last = runs.length ? runs[runs.length - 1] : null
  const change = prev ? ((last - prev) / Math.abs(prev)) * 100 : null
  const hasRuns = series.length >= 2 && runs.some((v) => v)

  const header = (
    <PageHeader
      title="Analytics"
      description="How reporting is used: what is defined, what runs, and what fails. Runs are counted, not views."
      primary={<Button variant="primary" to="/reports">Report library</Button>}
    />
  )

  return (
    <div className="space-y-5">
      {header}

      {analytics.loading ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {['Reports defined', 'Runs this month', 'Failed runs this month', 'Average run time'].map((l) => <Stat key={l} label={l} loading />)}
        </div>
      ) : analytics.error ? (
        <Card>
          <ErrorState what="Reporting analytics" error={analytics.error} onRetry={analytics.refetch} compact />
          <p className="px-4 pb-4 text-center text-xs text-ink-500">
            Nothing below is estimated in its place. The report library, dashboards and schedules still work — open them directly.
          </p>
        </Card>
      ) : (
        <>
          <section aria-label="Headline figures" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Reports defined" value={<Num value={totals.reports} />} reason={n(totals.shared) != null ? `${formatNumber(totals.shared)} shared with everyone` : undefined} to="/reports" />
            <Stat label="Runs this month" value={<Num value={totals.runs_mtd} />} delta={change != null ? <Variance value={change} label="vs last month" /> : null} to="/reports" />
            <Stat
              label="Failed runs this month"
              value={<Num value={totals.failed_mtd} />}
              reason={n(totals.failed_mtd) > 0
                ? (totals.success_rate == null ? 'See the reports behind them below.' : `${(totals.success_rate * 100).toFixed(1)}% of runs succeeded.`)
                : n(totals.failed_mtd) === 0 ? 'Everything that ran, ran clean.' : undefined}
            />
            <Stat label="Average run time" value={duration(totals.avg_duration_ms)} reason={totals.avg_duration_ms == null ? 'Nothing timed this month.' : 'Across every run this month.'} />
            <Stat label="Dashboards" value={<Num value={totals.dashboards} />} to="/reports/dashboards" />
            <Stat label="Schedules enabled" value={<Num value={totals.schedules} />} to="/reports/schedules" />
            <Stat label="People running reports" value={<Num value={totals.people_mtd} />} reason="Distinct people this month." />
            <Stat label="Report types" value={`${formatNumber(byType.BUILTIN)} / ${formatNumber(byType.QUERY)}`} reason="Packaged / custom query" />
          </section>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="min-w-0 space-y-4">
              <Card title="Runs per month" description="Runs, not views. Hover for a month, or show the table.">
                {hasRuns ? (
                  <LineChart points={series.map((r) => ({ x: monthShort(r.month), y: n(r.runs) || 0 }))} format={(v) => formatNumber(Math.round(v))} title="Report runs" height={220} />
                ) : (
                  <EmptyState title="No report has been run yet" description="Run a report from the library and it is counted here." compact />
                )}
              </Card>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card title="Recent reports" actions={<Link to="/reports" className="text-xs text-ink-600 hover:text-fg">All reports</Link>} padded={false}>
                  {recent.length ? (
                    <ul className="divide-y divide-ink-100">
                      {recent.map((r) => (
                        <ListRow
                          key={r.id}
                          to={`/reports/${r.id}`}
                          title={r.name}
                          sub={`${humanize(r.category)} · ${r.owner || '—'}`}
                          trailing={<span className="block text-xs text-ink-500">{r.last_run ? relativeTime(r.last_run) : 'never run'}</span>}
                        />
                      ))}
                    </ul>
                  ) : <p className="px-4 py-4 text-sm text-ink-600">No report has been defined yet.</p>}
                </Card>

                <Card title="Schedules" actions={<Link to="/reports/schedules" className="text-xs text-ink-600 hover:text-fg">All schedules</Link>} padded={false}>
                  {schedules.length ? (
                    <ul className="divide-y divide-ink-100">
                      {schedules.map((s) => (
                        <ListRow
                          key={s.id}
                          to="/reports/schedules"
                          title={s.name || s.report}
                          sub={`${cadence(s.interval_seconds)} · ${formatNumber(s.recipients)} ${n(s.recipients) === 1 ? 'recipient' : 'recipients'}`}
                          trailing={s.enabled ? <span className="block text-xs text-ink-500">next <DateText value={s.next_run_at} /></span> : <StatusBadge status="PAUSED" label="Paused" />}
                        />
                      ))}
                    </ul>
                  ) : <p className="px-4 py-4 text-sm text-ink-600">Nothing is scheduled.</p>}
                </Card>
              </div>

              <Card title="Reports by category" description="How many reports each category holds, and how often they ran this month." padded={false}>
                {categories.length ? (
                  <table className="w-full text-sm">
                    <thead className="text-xs text-ink-500">
                      <tr className="border-b border-ink-200 text-left">
                        <th scope="col" className="px-4 py-2 font-medium">Category</th>
                        <th scope="col" className="px-4 py-2 text-right font-medium">Reports</th>
                        <th scope="col" className="px-4 py-2 text-right font-medium">Runs this month</th>
                      </tr>
                    </thead>
                    <tbody>
                      {categories.map((c) => (
                        <tr key={c.category} className="border-b border-ink-100 last:border-0">
                          <td className="px-4 py-2 text-ink-800">{humanize(c.category)}</td>
                          <td className="px-4 py-2 text-right"><Num value={c.n} /></td>
                          <td className="px-4 py-2 text-right"><Num value={c.runs} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : <p className="px-4 py-4 text-sm text-ink-600">No report has been defined yet.</p>}
              </Card>

              <Card title="Dashboards" description="Ordered by how much is on them." actions={<Link to="/reports/dashboards" className="text-xs text-ink-600 hover:text-fg">All dashboards</Link>} padded={false}>
                {dashboards.length ? (
                  <ul className="divide-y divide-ink-100">
                    {dashboards.map((db) => (
                      <ListRow
                        key={db.id}
                        to={`/reports/dashboards/${db.id}`}
                        title={db.name}
                        sub={db.owner}
                        trailing={
                          <span className="flex items-center gap-2 text-xs text-ink-500">
                            {db.is_default ? <Badge>Default</Badge> : db.is_shared ? <Badge>Shared</Badge> : null}
                            <span className="tabular-nums">{formatNumber(db.widgets)} {n(db.widgets) === 1 ? 'widget' : 'widgets'}</span>
                          </span>
                        }
                      />
                    ))}
                  </ul>
                ) : <p className="px-4 py-4 text-sm text-ink-600">No dashboard has been created yet.</p>}
              </Card>
            </div>

            <aside className="min-w-0 space-y-4">
              <Card title="Failed runs" description="The reports behind this month's failures." padded={false}>
                {failures.length ? (
                  <ul className="divide-y divide-ink-100">
                    {failures.map((f) => (
                      <li key={f.id} className="flex items-start gap-2.5 px-4 py-2.5">
                        <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-risk-600" aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-fg">{f.report}</span>
                          <span className="block line-clamp-2 text-xs text-ink-600">{f.error || 'No error recorded'}</span>
                        </span>
                        <span className="shrink-0 text-xs text-ink-500">{relativeTime(f.run_at)}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="px-4 py-4 text-sm text-ink-600">Nothing has failed. Being empty is what this panel is for.</p>}
              </Card>
            </aside>
          </div>
        </>
      )}

      <Card title="Simeli findings" description="Open findings across the business." actions={<Link to="/ai-findings" className="text-xs text-ink-600 hover:text-fg">All findings</Link>} padded={false}>
        {findingsQ.loading ? <SkeletonRows rows={3} columns={2} /> : findingsQ.error ? (
          <ErrorState what="Simeli findings" error={findingsQ.error} onRetry={findingsQ.refetch} compact />
        ) : findings.length ? (
          <ul className="divide-y divide-ink-100">
            {findings.slice(0, 5).map((f) => (
              <ListRow
                key={f.id}
                to="/ai-findings"
                title={f.title}
                sub={f.description}
                trailing={f.severity ? <StatusBadge status={f.severity === 'HIGH' ? 'AT_RISK' : 'DRAFT'} label={humanize(f.severity)} /> : null}
              />
            ))}
          </ul>
        ) : <p className="px-4 py-4 text-sm text-ink-600">Simeli has not flagged anything across the business.</p>}
      </Card>
    </div>
  )
}
