import { Link } from 'react-router-dom'
import { ChevronRightIcon, UsersIcon } from '@heroicons/react/20/solid'
import api, { auditTrailAPI, hrAPI } from '../../services/api'
import { useResource } from '../../hooks/useResource'
import PeopleCoverage from '../../components/hr/PeopleCoverage'
import {
  PageHeader, Button, Card, Stat, StatusBadge, Money, Num, DateText, ErrorState, SkeletonRows, Timeline, DescriptionList,
  LineChart, formatMoney, formatNumber,
} from '../../components/ui'

/**
 * HR and payroll — the module's overview.
 *
 * Three things a workforce dashboard conventionally shows are absent on
 * purpose, because this database does not hold them: employment type (status
 * is ACTIVE / ON_LEAVE / TERMINATED, a different question), gender (not
 * collected, and not to be guessed from names) and open positions (no
 * requisition table). In their place: the workforce by status, tenure from
 * hire dates, and leave waiting on an approval.
 */
const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const TENURE = [['UNDER_1', 'Under 1 year'], ['Y1_3', '1 to 3 years'], ['Y3_5', '3 to 5 years'], ['Y5_PLUS', 'Over 5 years'], ['UNKNOWN', 'No hire date']]
const pct = (v, digits = 1) => (v == null || !Number.isFinite(Number(v)) ? '—' : `${(Number(v) * 100).toFixed(digits)}%`)
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const humanize = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
const rows = (d) => (Array.isArray(d) ? d : d?.data || d?.rows || [])

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

function Bars({ items, format = (v) => formatNumber(v) }) {
  const peak = Math.max(...items.map((i) => n(i.value)), 0) || 1
  return (
    <ul className="space-y-2.5">
      {items.map((i) => (
        <li key={i.label}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-ink-800">{i.label}</span>
            <span className="shrink-0 font-medium tabular-nums text-fg">{i.display ?? format(i.value)}</span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-ink-100" aria-hidden="true">
            <div className="h-1 rounded-full bg-ink-500" style={{ width: `${Math.min(100, (n(i.value) / peak) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

const Empty = ({ children }) => <p className="text-sm text-ink-600">{children}</p>

export default function HrOverview() {
  const { data: a, loading, error, refetch } = useResource(['hr', 'analytics', 12], () => hrAPI.analytics(12))
  const { data: activityData, loading: activityLoading, error: activityError, refetch: refetchActivity } = useResource(['hr', 'activity'], () => auditTrailAPI.list({ limit: 6, entity_type: 'PAYROLL_RUN' }))
  const { data: findingsData, loading: findingsLoading, error: findingsError, refetch: refetchFindings } = useResource(['hr', 'findings'], ({ signal }) => api.get('/ai-findings?status=OPEN&entity_type=EMPLOYEE', { signal }))

  const header = (
    <PageHeader
      title="HR and payroll"
      description="Who works here, who is away, and what this period's payroll costs."
      primary={<Button variant="primary" icon={UsersIcon} to="/hr/employees">Employees</Button>}
    />
  )

  if (error) {
    return (
      <>
        {header}
        <ErrorState what="HR figures" error={error} onRetry={refetch} />
      </>
    )
  }

  const t = a?.totals || {}
  const att = a?.attendance || {}
  const payroll = a?.payroll
  const series = a?.series || []
  const departments = a?.departments || []
  const tenure = a?.tenure || {}
  const balances = a?.leave_balances || []
  const absence = a?.absence || []
  const hires = a?.recent_hires || []
  const upcoming = a?.upcoming_leave || []
  const activity = rows(activityData)
  const findings = rows(findingsData)
  const tenureItems = TENURE.filter(([k]) => n(tenure[k]) > 0).map(([k, label]) => ({ label, value: tenure[k] }))

  return (
    <div className="space-y-5">
      {header}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Stat
          label="Employees"
          loading={loading}
          value={<Num value={t.total} />}
          reason={n(t.total) ? `${formatNumber(t.active)} active, ${formatNumber(t.on_leave)} on leave.` : 'No one is on the employee master yet.'}
          to="/hr/employees"
        />
        <Stat
          label="New hires this month"
          loading={loading}
          value={<Num value={t.new_hires} />}
          reason={hires[0] ? `Most recent: ${[hires[0].first_name, hires[0].last_name].filter(Boolean).join(' ')}.` : 'Nobody with a hire date yet.'}
          to="/hr/employees"
        />
        <Stat
          label="Payroll this period"
          loading={loading}
          value={payroll ? <Money amount={payroll.gross} digits={0} /> : '—'}
          reason={payroll ? `${MONTHS[payroll.period_month] || ''} ${payroll.period_year} · ${humanize(payroll.status)} · net ${formatMoney(payroll.net, 'USD', 0)}.` : 'No payroll run yet.'}
          to="/hr/payroll"
        />
        <Stat
          label="Attendance this month"
          loading={loading}
          value={pct(t.attendance_rate)}
          reason={t.attendance_rate == null ? 'Nothing clocked this month.' : `Across ${formatNumber(t.attendance_recorded)} recorded days. Late counts as attending.`}
          to="/hr/leave-attendance"
        />
        <Stat
          label="Leave awaiting approval"
          loading={loading}
          value={<Num value={t.pending_leave} />}
          reason={n(t.pending_leave) ? 'Upcoming requests still pending.' : 'Nothing waiting.'}
          to="/hr/leave-attendance"
        />
      </div>

      <PeopleCoverage />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Headcount" description="Employees hired on or before each month, last 12 months" className="lg:col-span-2">
          {loading ? <SkeletonRows rows={4} columns={1} /> : series.some((r) => n(r.headcount) > 0) ? (
            <LineChart title="Headcount by month" points={series.map((r) => ({ x: r.month, y: n(r.headcount) }))} format={(v) => formatNumber(v)} />
          ) : <Empty>No employees with a hire date in this period.</Empty>}
        </Card>
        <Card title="Workforce by status">
          {loading ? <SkeletonRows rows={3} columns={2} /> : n(t.total) ? (
            <ul className="space-y-2">
              {['ACTIVE', 'ON_LEAVE', 'TERMINATED'].map((s) => (
                <li key={s} className="flex items-center justify-between gap-3 text-sm">
                  <StatusBadge status={s} label={s === 'TERMINATED' ? 'Left' : undefined} />
                  <Num value={a?.by_status?.[s]} className="font-medium" />
                </li>
              ))}
            </ul>
          ) : <Empty>No employees yet.</Empty>}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card title="By department">
          {loading ? <SkeletonRows rows={3} columns={2} /> : departments.length ? <Bars items={departments.map((d) => ({ label: d.department, value: d.n }))} /> : <Empty>No departments recorded.</Empty>}
        </Card>
        <Card title="Tenure" description="Current employees, from hire dates">
          {loading ? <SkeletonRows rows={3} columns={2} /> : tenureItems.length ? <Bars items={tenureItems} /> : <Empty>No current employees.</Empty>}
        </Card>
        <Card title="Leave balances" description="Days available, by type">
          {loading ? <SkeletonRows rows={3} columns={2} /> : balances.length ? <Bars items={balances.map((b) => ({ label: humanize(b.leave_type), value: b.days, display: `${formatNumber(b.days, 1)} d` }))} /> : <Empty>No leave accrued yet.</Empty>}
        </Card>
        <Card title="Attendance this month">
          {loading ? <SkeletonRows rows={3} columns={2} /> : n(att.recorded) ? (
            <DescriptionList
              items={[
                { label: 'Present', value: <Num value={att.present} /> },
                { label: 'Late', value: <Num value={att.late} /> },
                { label: 'Half day', value: <Num value={att.half_day} /> },
                { label: 'Absent', value: <Num value={att.absent} /> },
              ]}
            />
          ) : <Empty>Nothing clocked this month.</Empty>}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <ListCard title="Upcoming leave" description="Pending and approved, not yet over" loading={loading} empty="Nobody has leave coming up." action={<Button size="xs" variant="ghost" to="/hr/leave-attendance">All</Button>}>
          {upcoming.length > 0 && upcoming.map((l) => (
            <Row key={l.id} to="/hr/leave-attendance" aside={<StatusBadge status={l.status} />}>
              <span className="block truncate text-sm text-ink-900">{l.employee}</span>
              <span className="block text-xs text-ink-500">{humanize(l.leave_type)} · <DateText value={l.start_date} /> → <DateText value={l.end_date} /> · {formatNumber(l.total_days, Number(l.total_days) % 1 ? 1 : 0)} d</span>
            </Row>
          ))}
        </ListCard>
        <ListCard title="Recent hires" loading={loading} empty="No hires recorded." action={<Button size="xs" variant="ghost" to="/hr/employees">All</Button>}>
          {hires.length > 0 && hires.map((h) => (
            <Row key={h.id} to="/hr/employees" aside={<span className="shrink-0 text-xs text-ink-500"><DateText value={h.hire_date} /></span>}>
              <span className="block truncate text-sm text-ink-900">{[h.first_name, h.last_name].filter(Boolean).join(' ')}</span>
              <span className="block truncate text-xs text-ink-500">{[h.position, h.department].filter(Boolean).join(' · ') || '—'}</span>
            </Row>
          ))}
        </ListCard>
        <Card title="Absence this month" description="Leave taken, by type">
          {loading ? <SkeletonRows rows={3} columns={2} /> : absence.length ? <Bars items={absence.map((r) => ({ label: humanize(r.leave_type), value: r.days, display: `${formatNumber(r.days, 1)} d · ${formatNumber(r.n)} req.` }))} /> : <Empty>No leave taken this month.</Empty>}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Payroll activity" description="Status changes on payroll runs">
          {activityLoading ? <SkeletonRows rows={3} columns={1} /> : activityError ? <ErrorState compact what="Activity" error={activityError} onRetry={refetchActivity} /> : (
            <Timeline
              empty="No payroll activity recorded yet."
              events={activity.map((r, i) => ({ id: `${r.entity_id}-${i}`, title: `${humanize(r.entity_type)} → ${humanize(r.to_status)}`, actor: r.changed_by_name || 'System', at: r.occurred_at }))}
            />
          )}
        </Card>
        <ListCard
          title="Simeli findings"
          description="Open findings on employee records"
          loading={findingsLoading}
          error={findingsError}
          onRetry={refetchFindings}
          empty="Simeli has not flagged anything on the employee master."
          action={<Button size="xs" variant="ghost" to="/ai/findings">All</Button>}
        >
          {findings.length > 0 && findings.slice(0, 5).map((f) => (
            <Row key={f.id} to="/ai/findings" aside={f.severity ? <StatusBadge status={f.severity === 'HIGH' ? 'OVERDUE' : f.severity === 'MEDIUM' ? 'ATTENTION' : 'DRAFT'} label={humanize(f.severity)} /> : null}>
              <span className="block truncate text-sm text-ink-900">{f.title}</span>
              {f.description && <span className="block truncate text-xs text-ink-500">{f.description}</span>}
            </Row>
          ))}
        </ListCard>
      </div>
    </div>
  )
}
