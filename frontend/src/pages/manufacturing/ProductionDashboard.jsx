import { Link } from 'react-router-dom'
import { ChevronRightIcon, ClipboardDocumentListIcon } from '@heroicons/react/20/solid'
import api, { auditTrailAPI, kpiSeriesAPI } from '../../services/api'
import { useResource } from '../../hooks/useResource'
import {
  PageHeader, Button, Card, Stat, StatusBadge, Money, Num, Variance, Code, DateText, ErrorState, SkeletonRows, Timeline,
  LineChart, formatMoney, formatNumber,
} from '../../components/ui'
import LineWatchModule from '../../components/manufacturing/LineWatch'
import RunsOnModule from '../../components/operations/RunsOn'

/**
 * Manufacturing — the module's overview.
 *
 * OEE is computed, never stored: availability (hours booked against the
 * capacity of the centres that booked them), performance (planned hours
 * against actual) and quality (good units against units produced). Each is
 * null when its inputs are missing, and a null propagates to the overall
 * figure instead of quietly inflating it: an OEE of 100% because nothing was
 * booked is worse than none. The same rule runs through the rest — an on-time
 * rate with no completions behind it is "—", not a number.
 */
const pct = (v, digits = 1) => (v == null || !Number.isFinite(Number(v)) ? '—' : `${(Number(v) * 100).toFixed(digits)}%`)
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const humanize = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
const rows = (d) => (Array.isArray(d) ? d : d?.data || d?.rows || [])
// /manufacturing/analytics answers without the { success, data } envelope.
const raw = (path, params) => async ({ signal }) => ({ data: { success: true, data: (await api.get(path, { params, signal })).data } })

/** Last full month against the one before, as a percentage. */
function monthChange(values) {
  const v = (values || []).map(Number).filter(Number.isFinite)
  if (v.length < 2 || !v[v.length - 2]) return null
  return ((v[v.length - 1] - v[v.length - 2]) / Math.abs(v[v.length - 2])) * 100
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

/** A label, a figure, and a hairline bar against the largest figure shown. */
function Bars({ items, format = (v) => formatNumber(v) }) {
  const peak = Math.max(...items.map((i) => n(i.value)), 0) || 1
  return (
    <ul className="space-y-2.5">
      {items.map((i) => (
        <li key={i.label}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-ink-800">{i.label}</span>
            <span className="shrink-0 tabular-nums font-medium text-fg">{i.display ?? format(i.value)}</span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-ink-100" aria-hidden="true">
            <div className="h-1 rounded-full bg-ink-500" style={{ width: `${Math.min(100, (n(i.value) / peak) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

export default function ProductionDashboard() {
  const { data: a, loading, error, refetch } = useResource(['manufacturing', 'analytics', 12], raw('/manufacturing/analytics', { months: 12 }))
  const { data: activityData, loading: activityLoading, error: activityError, refetch: refetchActivity } = useResource(['manufacturing', 'activity'], () => auditTrailAPI.list({ limit: 6, entity_type: 'WORK_ORDER' }))
  const { data: findingsData, loading: findingsLoading, error: findingsError, refetch: refetchFindings } = useResource(['manufacturing', 'findings'], ({ signal }) => api.get('/ai-findings?status=OPEN&entity_type=INVENTORY_ITEM', { signal }))
  const { data: kpi } = useResource(['manufacturing', 'kpi-series'], () => kpiSeriesAPI.get(['work_orders'], 12))

  const p = a?.production || {}
  const oee = a?.oee || {}
  const byStatus = a?.by_status || {}
  const series = a?.series || []
  const woSeries = kpi?.work_orders || []
  const activity = rows(activityData)
  const findings = rows(findingsData)
  const produced = series.map((r) => n(r.produced))
  const hasOutput = produced.some((v) => v !== 0)

  const header = (
    <PageHeader
      title="Manufacturing"
      description="What the floor made this year, what it cost, and what is short."
      primary={<Button variant="primary" icon={ClipboardDocumentListIcon} to="/manufacturing/work-orders">Work orders</Button>}
    />
  )

  if (error) {
    return (
      <>
        {header}
        <ErrorState what="Manufacturing figures" error={error} onRetry={refetch} />
      </>
    )
  }

  const statuses = ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'].filter((s) => n(byStatus[s]) > 0)
  const openOrders = a?.open_work_orders || []
  const shortages = a?.shortages || []
  const products = a?.top_products || []
  const centres = a?.work_centers || []
  const materials = a?.material_consumption || []

  return (
    <div className="space-y-5">
      {header}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Stat
          label="Produced this year"
          loading={loading}
          value={<Num value={p.produced} />}
          delta={monthChange(produced) != null ? <Variance value={monthChange(produced)} label="vs last month" /> : undefined}
          reason={n(p.scrapped) > 0 ? `${formatNumber(p.scrapped)} units scrapped (${pct(p.scrap_rate)}).` : 'Good units confirmed on completed orders. Nothing scrapped.'}
          to="/manufacturing/work-orders"
        />
        <Stat
          label="Production value"
          loading={loading}
          value={<Money amount={p.completed_value} digits={0} />}
          reason="Cost capitalised into stock from completed work orders."
          to="/manufacturing/work-orders"
        />
        <Stat
          label="Overall OEE"
          loading={loading}
          value={pct(oee.overall)}
          reason={oee.overall == null ? 'Needs booked operation hours and a completed order to measure against.' : 'Availability × performance × quality.'}
          to="/manufacturing/work-centers"
        />
        <Stat
          label="On-time completion"
          loading={loading}
          value={pct(p.on_time_rate)}
          reason={p.on_time_rate == null ? 'Nothing finished yet.' : `${formatNumber(p.finished)} orders finished.`}
          to="/manufacturing/work-orders"
        />
        <Stat
          label="Open work orders"
          loading={loading}
          value={<Num value={p.open_orders} />}
          reason={n(p.wip_value) > 0 ? `${formatMoney(p.wip_value, 'USD', 0)} committed to the floor.` : 'Released or on the floor. No material issued yet.'}
          to="/manufacturing/work-orders"
        />
      </div>

      <LineWatchModule />

      <RunsOnModule focus="lines" />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Output by month" description="Good units confirmed, last 12 months" className="lg:col-span-2">
          {loading ? <SkeletonRows rows={4} columns={1} /> : hasOutput ? (
            <LineChart title="Units produced per month" points={series.map((r) => ({ x: r.month, y: n(r.produced) }))} format={(v) => formatNumber(v)} />
          ) : (
            <p className="text-sm text-ink-600">
              Nothing has been confirmed as produced in the last 12 months.
              {woSeries.some((m) => n(m.count) > 0) && ` ${formatNumber(woSeries.reduce((s, m) => s + n(m.count), 0))} work orders were raised in that time.`}
            </p>
          )}
        </Card>
        <Card title="OEE breakdown" description="Overall OEE is the product of the three">
          {loading ? <SkeletonRows rows={3} columns={2} /> : oee.overall == null && oee.availability == null && oee.performance == null && oee.quality == null ? (
            <p className="text-sm text-ink-600">OEE needs booked operation hours and a completed order to measure against. Book time on a work order operation and it fills in.</p>
          ) : (
            <Bars
              items={[
                { label: 'Availability', value: n(oee.availability), display: pct(oee.availability) },
                { label: 'Performance', value: n(oee.performance), display: pct(oee.performance) },
                { label: 'Quality', value: n(oee.quality), display: pct(oee.quality) },
                { label: 'Overall', value: n(oee.overall), display: pct(oee.overall) },
              ]}
            />
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ListCard
          title="Open work orders"
          description="Released or on the floor"
          loading={loading}
          empty="Nothing is open on the floor."
          action={<Button size="xs" variant="ghost" to="/manufacturing/work-orders">All</Button>}
        >
          {openOrders.length > 0 && openOrders.map((wo) => {
            const progress = n(wo.quantity) > 0 ? n(wo.produced) / n(wo.quantity) : null
            return (
              <Row key={wo.wo_number} to="/manufacturing/work-orders" aside={<StatusBadge status={wo.status} />}>
                <span className="block truncate text-sm"><Code>{wo.wo_number}</Code> <span className="text-ink-700">{wo.product}</span></span>
                <span className="block text-xs text-ink-500 tabular-nums">
                  {formatNumber(wo.produced)} of {formatNumber(wo.quantity)} made{progress != null ? ` · ${pct(progress, 0)}` : ''}
                  {wo.planned_end_date && <> · due <DateText value={wo.planned_end_date} /></>}
                </span>
              </Row>
            )
          })}
        </ListCard>
        <ListCard
          title="Material shortages"
          description="Net requirements from the last MRP run"
          loading={loading}
          empty="The last MRP run found no net requirement. Run MRP again to refresh this."
          action={<Button size="xs" variant="ghost" to="/manufacturing/mrp-workbench">MRP</Button>}
        >
          {shortages.length > 0 && shortages.map((r) => (
            <Row key={r.item_code || r.item} to="/manufacturing/mrp-workbench" aside={<span className="shrink-0 text-sm font-medium tabular-nums text-risk-600">−{formatNumber(r.shortage)}</span>}>
              <span className="block truncate text-sm text-ink-900">{r.item}</span>
              <span className="block text-xs text-ink-500 tabular-nums">
                {formatNumber(r.available)} on hand of {formatNumber(r.required)} needed{r.required_by ? <> · by <DateText value={r.required_by} /></> : ''}
              </span>
            </Row>
          ))}
        </ListCard>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card title="Work orders by status">
          {loading ? <SkeletonRows rows={3} columns={2} /> : statuses.length ? (
            <ul className="space-y-2">
              {statuses.map((s) => (
                <li key={s} className="flex items-center justify-between gap-3 text-sm">
                  <StatusBadge status={s} />
                  <Num value={byStatus[s]} className="font-medium" />
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-ink-600">No work orders raised yet.</p>}
        </Card>
        <Card title="Top products" description="Units produced">
          {loading ? <SkeletonRows rows={3} columns={2} /> : products.length ? (
            <Bars items={products.map((r) => ({ label: r.product, value: r.produced }))} />
          ) : <p className="text-sm text-ink-600">Nothing has been produced yet.</p>}
        </Card>
        <Card title="Work centre performance" description="Planned hours against actual">
          {loading ? <SkeletonRows rows={3} columns={2} /> : centres.length ? (
            <Bars
              items={centres.map((r) => {
                const ratio = n(r.actual_hours) > 0 ? n(r.planned_hours) / n(r.actual_hours) : null
                return { label: r.work_center, value: ratio == null ? 0 : Math.min(ratio, 2), display: pct(ratio, 0) }
              })}
            />
          ) : <p className="text-sm text-ink-600">No operation time booked against a work centre yet.</p>}
        </Card>
        <Card title="Material consumption" description="Issued to work orders, by category">
          {loading ? <SkeletonRows rows={3} columns={2} /> : materials.some((m) => n(m.value) > 0) ? (
            <Bars items={materials.map((m) => ({ label: m.category || 'Uncategorised', value: m.value }))} format={(v) => formatMoney(v, 'USD', 0)} />
          ) : <p className="text-sm text-ink-600">No materials issued against a work order yet.</p>}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Recent activity" description="Work order status changes">
          {activityLoading ? <SkeletonRows rows={3} columns={1} /> : activityError ? <ErrorState compact what="Activity" error={activityError} onRetry={refetchActivity} /> : (
            <Timeline
              empty="No work order activity recorded yet."
              events={activity.map((r, i) => ({ id: `${r.entity_id}-${i}`, title: `${humanize(r.entity_type)} → ${humanize(r.to_status)}`, actor: r.changed_by_name || 'System', at: r.occurred_at }))}
            />
          )}
        </Card>
        <ListCard
          title="Simeli findings"
          description="Open findings on stock that production depends on"
          loading={findingsLoading}
          error={findingsError}
          onRetry={refetchFindings}
          empty="Simeli has not flagged anything on the floor."
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
