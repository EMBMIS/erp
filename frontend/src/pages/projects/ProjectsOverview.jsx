import { Link } from 'react-router-dom'
import { ChevronRightIcon, ClockIcon } from '@heroicons/react/20/solid'
import api, { projectsAPI } from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { useCompany } from '../../contexts/CompanyContext'
import {
  PageHeader, Button, Card, Stat, StatusBadge, Money, DateText, ErrorState, SkeletonRows,
  LineChart, BarChart, Distribution, formatMoney, formatNumber, relativeTime,
} from '../../components/ui'

/**
 * Projects — the module's overview.
 *
 * HEALTH IS DERIVED, AND IT IS THE POINT OF THE SCREEN
 * ---------------------------------------------------------------------------
 * No column records whether a project is in trouble. The band each project
 * falls into comes from budget consumed against budget available, where spend
 * counts purchase orders raised as well as time booked.
 *
 * Projects with no budget set land in their own band rather than being scored
 * as healthy: a portfolio where half the work is untracked and the rest is fine
 * is not a healthy portfolio.
 *
 * EVERY RATE IS NULL WHEN ITS DENOMINATOR IS EMPTY
 * ---------------------------------------------------------------------------
 * On-time completion with nothing completed, utilisation with no budget,
 * progress with no tasks. Each renders as an em dash with a line saying what is
 * missing. A zero in any of those places reads as a measurement and is not one.
 */

const STATUSES = [['PLANNED', 'In planning'], ['ACTIVE', 'In progress'], ['ON_HOLD', 'On hold'], ['COMPLETED', 'Completed'], ['CANCELLED', 'Cancelled']]
const HEALTH = [['HEALTHY', 'Healthy', 'ok'], ['AT_RISK', 'At risk', 'warn'], ['CRITICAL', 'Critical', 'risk'], ['UNTRACKED', 'No budget set', 'ink'], ['NOT_STARTED', 'Not started', 'ink']]
const TASK_STATES = [['DONE', 'Completed'], ['IN_PROGRESS', 'In progress'], ['TODO', 'To do'], ['CANCELLED', 'Cancelled']]

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const pct = (v, digits = 0) => (v == null || !Number.isFinite(Number(v)) ? '—' : `${(Number(v) * 100).toFixed(digits)}%`)
const humanize = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
const rows = (d) => (Array.isArray(d) ? d : d?.data || d?.rows || [])
const monthShort = (key) => {
  const [y, m] = String(key || '').split('-').map(Number)
  return Number.isInteger(y) && Number.isInteger(m) ? new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: '2-digit' }) : String(key || '—')
}
const healthOf = (p) => {
  if (!p.budget) return { label: 'No budget', status: 'DRAFT' }
  const r = n(p.spent) / n(p.budget)
  return r > 1 ? { label: 'Critical', status: 'OVERDUE' } : r > 0.85 ? { label: 'At risk', status: 'ATTENTION' } : { label: 'Healthy', status: 'ACTIVE' }
}

function ListCard({ title, description, action, loading, error, onRetry, empty, children }) {
  return (
    <Card title={title} description={description} actions={action} padded={false}>
      {loading ? <SkeletonRows rows={3} columns={2} /> : error ? <ErrorState compact what={title} error={error} onRetry={onRetry} className="px-4" />
        : children ? <ul className="divide-y divide-ink-100">{children}</ul> : <p className="px-4 py-4 text-sm text-ink-600">{empty}</p>}
    </Card>
  )
}

function Row({ to, children, aside }) {
  const body = (
    <>
      <span className="min-w-0 flex-1">{children}</span>
      {aside}
      {to && <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />}
    </>
  )
  return <li>{to ? <Link to={to} className="flex items-center gap-3 px-4 py-2.5 hover:bg-ink-50">{body}</Link> : <div className="flex items-center gap-3 px-4 py-2.5">{body}</div>}</li>
}

const Empty = ({ children }) => <p className="text-sm text-ink-600">{children}</p>

export default function ProjectsOverview() {
  const { currency = 'USD' } = useCompany() || {}
  // No audit-trail call here on purpose: nothing writes project status
  // history, so the trail has nothing to say about this module. The analytics
  // endpoint carries the module's own activity instead.
  const { data: a, loading, error, refetch } = useResource(['projects', 'analytics', 12], () => projectsAPI.analytics(12), { retry: false })
  const { data: findingsData, loading: findingsLoading, error: findingsError, refetch: refetchFindings } = useResource(
    ['projects', 'findings'],
    ({ signal }) => api.get('/ai-findings?status=OPEN&entity_type=PROJECT', { signal }),
  )
  const findings = rows(findingsData)

  const header = (
    <PageHeader
      title="Projects"
      description="The portfolio: what is running, whether it is within budget, and the time booked against it."
      primary={<Button variant="primary" icon={ClockIcon} to="/projects/timesheet">Log time</Button>}
    />
  )

  const findingsCard = (
    <ListCard
      title="Simeli findings"
      description="Open findings on projects"
      loading={findingsLoading}
      error={findingsError}
      onRetry={refetchFindings}
      empty="Simeli has not flagged anything across the portfolio."
      action={<Button size="xs" variant="ghost" to="/ai/findings">All</Button>}
    >
      {findings.length > 0 && findings.slice(0, 5).map((f) => (
        <Row key={f.id} to="/ai/findings" aside={f.severity ? <StatusBadge status={f.severity === 'HIGH' ? 'OVERDUE' : f.severity === 'MEDIUM' ? 'ATTENTION' : 'DRAFT'} label={humanize(f.severity)} /> : null}>
          <span className="block truncate text-sm text-ink-900">{f.title}</span>
          {f.description && <span className="block truncate text-xs text-ink-500">{f.description}</span>}
        </Row>
      ))}
    </ListCard>
  )

  if (error) {
    return (
      <div className="space-y-5">
        {header}
        <ErrorState what="Project figures" error={error} onRetry={refetch} />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">{findingsCard}</div>
      </div>
    )
  }

  const totals = a?.totals || {}
  const byStatus = a?.by_status || {}
  const valueByStatus = a?.value_by_status || {}
  const health = a?.health || {}
  const taskCounts = a?.tasks?.by_status || {}
  const hours = a?.hours || []
  const spend = a?.series || []
  const active = a?.active_projects || []
  const milestones = a?.milestones || []
  const activity = a?.activity || []

  const statusItems = STATUSES.map(([k, label]) => ({ label: `${label} · ${formatNumber(byStatus[k])}`, value: n(valueByStatus[k]), to: '/projects' })).filter((s) => s.value > 0)
  const healthItems = HEALTH.map(([k, label, tone]) => ({ label, value: n(health[k]), tone, to: '/projects' })).filter((s) => s.value > 0)
  const taskItems = TASK_STATES.map(([k, label]) => ({ label, value: n(taskCounts[k]), tone: k === 'DONE' ? 'ok' : 'ink' })).filter((s) => s.value > 0)

  return (
    <div className="space-y-5">
      {header}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Stat label="Active projects" loading={loading} value={formatNumber(totals.active)} reason={`${formatNumber(totals.total)} in all · ${formatNumber(totals.planned)} in planning · ${formatNumber(totals.on_hold)} on hold.`} to="/projects" />
        <Stat label="On-time completion" loading={loading} value={pct(totals.on_time_rate)} reason={totals.on_time_rate == null ? 'Nothing finished with a due date yet.' : `${formatNumber(totals.finished)} finished on schedule of ${formatNumber(totals.completed)} completed.`} />
        <Stat label="Budget used" loading={loading} value={pct(totals.budget_utilisation)} reason={totals.budget_utilisation == null ? 'No project carries a budget.' : `${formatMoney(totals.budget_spent, currency, 0)} of ${formatMoney(totals.budget_total, currency, 0)}.`} />
        <Stat label="Overdue tasks" loading={loading} value={formatNumber(totals.overdue_tasks)} reason={n(totals.overdue_tasks) > 0 ? 'Past their due date.' : 'Nothing past due.'} to="/projects" />
        <Stat label="Hours logged" loading={loading} value={totals.hours_logged == null ? '—' : `${formatNumber(Math.round(n(totals.hours_logged)))} h`} reason={a?.tasks?.total != null ? `Across ${formatNumber(a.tasks.total)} tasks.` : undefined} to="/projects/timesheet" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Spend against budget" description="Actual spend booked per month, last 12 months — time and purchase orders" className="lg:col-span-2">
          {loading ? <SkeletonRows rows={4} columns={1} /> : spend.length > 1 && spend.some((r) => n(r.actual)) ? (
            <LineChart title="Actual spend by month" points={spend.map((r) => ({ x: monthShort(r.month), y: n(r.actual) }))} format={(v) => formatMoney(v, currency, 0)} />
          ) : <Empty>Nothing booked against a project yet.</Empty>}
        </Card>
        <Card title="Project health" description="Budget consumed against budget available">
          {loading ? <SkeletonRows rows={4} columns={2} /> : <Distribution items={healthItems} emptyText="No projects raised yet." />}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Card title="Hours logged" description="Per month">
          {loading ? <SkeletonRows rows={4} columns={1} /> : (
            <BarChart title="Hours by month" points={hours.slice(-8).map((h) => ({ x: monthShort(h.month), y: n(h.hours) }))} format={(v) => `${formatNumber(Math.round(v))} h`} emptyText="No time booked against a project yet." />
          )}
        </Card>
        <Card title="Portfolio by status" description="Managed budget. Projects without one are counted but add nothing.">
          {loading ? <SkeletonRows rows={4} columns={2} /> : <Distribution items={statusItems} format={(v) => formatMoney(v, currency, 0)} emptyText="No project carries a budget yet." />}
        </Card>
        <Card title="Tasks">
          {loading ? <SkeletonRows rows={4} columns={2} /> : <Distribution items={taskItems} emptyText="No tasks yet." />}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ListCard title="Active projects" loading={loading} empty="No project is open." action={<Button size="xs" variant="ghost" to="/projects">All</Button>}>
          {active.length > 0 && active.map((p) => {
            const h = healthOf(p)
            return (
              <Row key={p.id} to={`/projects/${p.id}`} aside={<span className="shrink-0 text-right text-xs"><span className="block tabular-nums text-ink-700">{p.budget ? `${formatMoney(p.spent, currency, 0)} / ${formatMoney(p.budget, currency, 0)}` : '—'}</span><StatusBadge status={h.status} label={h.label} /></span>}>
                <span className="block truncate text-sm text-ink-900">{p.name}</span>
                <span className="block truncate text-xs text-ink-500">{[p.manager, p.progress == null ? 'No tasks' : `${pct(p.progress)} of tasks done`].filter(Boolean).join(' · ')}</span>
              </Row>
            )
          })}
        </ListCard>
        <ListCard title="Upcoming milestones" description="What fixed-price projects bill against" loading={loading} empty="Nothing scheduled.">
          {milestones.length > 0 && milestones.map((m) => (
            <Row key={m.id} aside={<span className="shrink-0 text-right text-xs"><Money amount={m.amount} currency={currency} digits={0} className="block font-medium" /><span className="text-ink-500">{m.target_date ? <DateText value={m.target_date} /> : 'No date'} · {humanize(m.status)}</span></span>}>
              <span className="block truncate text-sm text-ink-900">{m.name}</span>
              <span className="block truncate text-xs text-ink-500">{m.project}</span>
            </Row>
          ))}
        </ListCard>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ListCard title="Recent activity" description="Tasks, milestones and time" loading={loading} empty="Nothing has happened on a project yet.">
          {activity.length > 0 && activity.map((r, i) => (
            <Row key={`${r.kind}-${i}`} aside={<span className="shrink-0 text-xs text-ink-500">{relativeTime(r.occurred_at)}</span>}>
              <span className="block truncate text-sm text-ink-900">{r.subject}</span>
              <span className="block truncate text-xs text-ink-500">{[humanize(r.kind), r.context, r.state && humanize(r.state)].filter(Boolean).join(' · ')}</span>
            </Row>
          ))}
        </ListCard>
        {findingsCard}
      </div>
    </div>
  )
}
