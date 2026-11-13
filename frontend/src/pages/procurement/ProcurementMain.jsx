import { Link } from 'react-router-dom'
import { ChevronRightIcon, PlusIcon } from '@heroicons/react/20/solid'
import api, {
  auditTrailAPI, kpiSeriesAPI, procurementRfqsAPI, purchaseOrdersAPI, purchaseRequisitionsAPI, supplierInvoicesAPI,
} from '../../services/api'
import { useResource } from '../../hooks/useResource'
import ProcessFlow from '../../components/process/ProcessFlow'
import SpendDrivers from '../../components/procurement/SpendDrivers'
import {
  PageHeader, Button, Card, Stat, StatusBadge, Money, Code, Variance, Sparkline, LineChart, Distribution, SkeletonRows,
  EmptyState, InlineNotice, Badge, formatMoney, formatNumber, relativeTime,
} from '../../components/ui'

/**
 * Procurement — what is moving through procure-to-pay, and what needs a look.
 *
 * Every figure is the caller's own procurement (orders, requisitions and RFQs
 * are scoped per user server-side). A figure that could not be read says so
 * instead of showing zero.
 *
 * The pipeline counts cumulative reach, not current status: an RFQ that has
 * been closed still received its quotations, so each stage sums the statuses
 * at or beyond it. On-time delivery compares the promised delivery_date with
 * delivery_confirmed_at — two recorded facts.
 */
const RECENT = 5
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const rows = (d) => (Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [])
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthLabel = (m) => `${MONTHS[Number(String(m).slice(5, 7)) - 1]} ${String(m).slice(2, 4)}`
const humanize = (s) => String(s || '').toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
const unavailable = (e) => (e ? (e?.response?.status === 403 ? 'Not available for your role' : 'Could not be loaded') : null)

const PO_STATUSES = [
  ['draft', 'Draft'], ['pending_approval', 'Pending approval'], ['approved', 'Approved'], ['sent_to_supplier', 'Sent to supplier'],
  ['confirmed', 'Confirmed'], ['partially_received', 'Partially received'], ['fully_received', 'Fully received'],
]

/** One overview figure: its own request, so one failure does not blank the page. */
function useOverview(key, fn) {
  return useResource(['procurement-overview', key], () => fn(), { retry: false })
}

function ListCard({ title, to, loading, error, emptyText, children }) {
  return (
    <Card title={title} padded={false} actions={<Button size="sm" variant="ghost" to={to}>View all</Button>}>
      {loading ? <SkeletonRows rows={3} columns={2} /> : error ? <p className="px-4 py-3 text-sm text-ink-600">{unavailable(error)}.</p> : children?.length ? <ul className="divide-y divide-ink-100">{children}</ul> : <p className="px-4 py-3 text-sm text-ink-600">{emptyText}</p>}
    </Card>
  )
}

function Row({ to, title, subtitle, trailing, status }) {
  const Tag = to ? Link : 'div'
  return (
    <li>
      <Tag to={to} className="flex min-h-[48px] items-center gap-3 px-4 py-2.5 hover:bg-ink-50">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-fg">{title}</span>
          {subtitle && <span className="block truncate text-xs text-ink-500">{subtitle}</span>}
        </span>
        {status}
        {trailing && <span className="shrink-0 text-right text-sm tabular-nums">{trailing}</span>}
        {to && <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />}
      </Tag>
    </li>
  )
}

export default function ProcurementMain() {
  const analytics = useOverview('analytics', () => purchaseOrdersAPI.analytics(24))
  const pos = useOverview('po-stats', () => purchaseOrdersAPI.stats())
  const prs = useOverview('pr-stats', () => purchaseRequisitionsAPI.stats())
  const rfqs = useOverview('rfq-stats', () => procurementRfqsAPI.stats())
  const savings = useOverview('savings', () => procurementRfqsAPI.savings(365))
  const invoices = useOverview('invoice-stats', () => supplierInvoicesAPI.stats())
  const recentPrs = useOverview('recent-prs', () => purchaseRequisitionsAPI.list({ limit: RECENT }))
  const recentPos = useOverview('recent-pos', () => purchaseOrdersAPI.list({ limit: RECENT }))
  const activity = useOverview('activity', () => auditTrailAPI.list({ limit: 6, entity_type: 'PURCHASE_ORDER,PURCHASE_REQUISITION,CONTRACT,SUPPLIER_INVOICE,SUPPLIER_PAYMENT' }))
  const findings = useOverview('findings', () => api.get('/ai-findings?status=OPEN&entity_type=PURCHASE_ORDER'))
  const series = useOverview('series', () => kpiSeriesAPI.get(['purchase_orders', 'purchase_requisitions', 'procurement_rfqs', 'suppliers'], 12))

  const a = analytics.data || {}
  const p = pos.data || {}
  const r = prs.data || {}
  const f = rfqs.data || {}
  const s = savings.data || {}
  const inv = invoices.data || {}
  const delivery = a.delivery || {}
  const kpi = series.data || {}

  const monthly = a.monthly_spend || []
  const spend = monthly.map((m) => num(m.spend))
  const spendNow = spend.length ? spend[spend.length - 1] : null
  const spendPrev = spend.length > 1 ? spend[spend.length - 2] : null
  const spendChange = spendPrev ? ((spendNow - spendPrev) / Math.abs(spendPrev)) * 100 : null
  const last12 = monthly.slice(-12)

  const activePos = num(p.approved) + num(p.sent_to_supplier) + num(p.confirmed) + num(p.partially_received)
  const openPrs = num(r.submitted) + num(r.pending_approval) + num(r.approved)
  const pendingRfqs = num(f.sent) + num(f.responses_received)
  const concluded = num(delivery.on_time) + num(delivery.late)
  const onTime = concluded > 0 ? (num(delivery.on_time) / concluded) * 100 : null
  const series12 = (name) => (kpi[name] || []).map((x) => num(x.count))
  const spark = (name) => { const v = series12(name); return v.some(Boolean) ? <Sparkline values={v} label={`${name.replace(/_/g, ' ')} per month`} /> : null }

  const pipeline = [
    { label: 'Requisitions', value: num(r.total), to: '/procurement/purchase-requisitions' },
    { label: 'RFQs sent', value: num(f.total) - num(f.draft), to: '/procurement/rfqs' },
    { label: 'Quotations in', value: num(f.responses_received) + num(f.evaluated) + num(f.supplier_selected) + num(f.closed), to: '/procurement/rfqs' },
    { label: 'Purchase orders raised', value: num(p.total) - num(p.draft), to: '/procurement/purchase-orders' },
    { label: 'Goods received', value: num(p.partially_received) + num(p.fully_received), to: '/procurement/goods-receipts' },
    { label: 'Supplier invoices', value: num(inv.total_bills ?? inv.total_invoices), to: '/finance/supplier-invoices' },
  ]

  const findingRows = rows(findings.data)
  const pendingApprovals = num(p.pending_approval) + num(r.pending_approval)

  return (
    <div className="space-y-5">
      <PageHeader
        title="Procurement"
        description="From requisition to supplier invoice — what is moving, and what needs a look."
        secondary={<><Button icon={PlusIcon} to="/procurement/purchase-requisitions/create">New requisition</Button><Button icon={PlusIcon} to="/procurement/rfqs/create">New RFQ</Button></>}
        primary={<Button variant="primary" icon={PlusIcon} to="/procurement/purchase-orders/create">New purchase order</Button>}
      />

      {pendingApprovals > 0 && (
        <InlineNotice tone="warn" title={`${formatNumber(pendingApprovals)} waiting for approval`} action={<Button size="sm" to="/approvals/unified">Open approvals</Button>}>
          {[num(p.pending_approval) && `${num(p.pending_approval)} purchase order${num(p.pending_approval) === 1 ? '' : 's'}`, num(r.pending_approval) && `${num(r.pending_approval)} requisition${num(r.pending_approval) === 1 ? '' : 's'}`].filter(Boolean).join(' and ')} cannot move on until approved.
        </InlineNotice>
      )}

      <section aria-label="Procurement figures" className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
        <Stat label="Spend this month" loading={analytics.loading} to="/procurement/purchase-orders"
          value={analytics.error ? '—' : formatMoney(spendNow)}
          delta={spendChange != null ? <Variance value={spendChange} goodWhen="down" label="vs last month" /> : null}
          reason={unavailable(analytics.error)} />
        <Stat label="Active purchase orders" loading={pos.loading} to="/procurement/purchase-orders"
          value={pos.error ? '—' : formatNumber(activePos)} delta={spark('purchase_orders')}
          reason={unavailable(pos.error) || `${formatMoney(p.total_value)} committed`} />
        <Stat label="Open requisitions" loading={prs.loading} to="/procurement/purchase-requisitions"
          value={prs.error ? '—' : formatNumber(openPrs)} delta={spark('purchase_requisitions')}
          reason={unavailable(prs.error) || (num(r.pending_approval) ? `${num(r.pending_approval)} awaiting approval` : r.total_estimated_value != null ? `${formatMoney(r.total_estimated_value)} estimated` : null)} />
        <Stat label="RFQs out" loading={rfqs.loading} to="/procurement/rfqs"
          value={rfqs.error ? '—' : formatNumber(pendingRfqs)} delta={spark('procurement_rfqs')}
          reason={unavailable(rfqs.error) || `${formatNumber(num(f.total))} raised in total`} />
        <Stat label="On-time delivery" loading={analytics.loading} to="/procurement/delivery-tracking"
          value={onTime == null ? '—' : `${onTime.toFixed(0)}%`}
          reason={unavailable(analytics.error) || (num(delivery.overdue) ? `${num(delivery.overdue)} past their date` : concluded ? `${concluded} deliveries concluded` : 'No confirmed deliveries yet')} />
        <Stat label="Sourcing savings" loading={savings.loading} to="/procurement/rfqs"
          value={savings.error || !num(s.baseline) ? '—' : formatMoney(s.savings)}
          reason={unavailable(savings.error) || (s.rate == null ? 'Needs two quotes on a line' : `${(s.rate * 100).toFixed(1)}% under the average quote, last 12 months`)} />
      </section>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          <Card title="Committed spend by month" description="Purchase order value by order month, last 12 months.">
            {analytics.loading ? <SkeletonRows rows={4} columns={1} /> : analytics.error ? <p className="text-sm text-ink-600">{unavailable(analytics.error)}.</p> : last12.some((m) => num(m.spend)) ? (
              <LineChart points={last12.map((m) => ({ x: monthLabel(m.month), y: num(m.spend) }))} format={(v) => formatMoney(v, 'USD', 0)} height={200} title="Spend" />
            ) : <EmptyState compact title="No spend yet" description="The trend appears once purchase orders are raised." />}
          </Card>

          <SpendDrivers />

          <ProcessFlow flow="procure_to_pay" />

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Card title="Procure to pay" description="Records that reached each stage or went past it.">
              {prs.loading || pos.loading || rfqs.loading ? <SkeletonRows rows={5} columns={2} /> : (
                <Distribution items={pipeline} emptyText="Nothing in the pipeline yet. Stages fill as requisitions, RFQs and orders are raised." />
              )}
            </Card>
            <Card title="Purchase orders by status">
              {pos.loading ? <SkeletonRows rows={5} columns={2} /> : pos.error ? <p className="text-sm text-ink-600">{unavailable(pos.error)}.</p> : (
                <Distribution items={PO_STATUSES.map(([k, label]) => ({ label, value: num(p[k]), to: '/procurement/purchase-orders' })).filter((x) => x.value)} emptyText="No purchase orders yet." />
              )}
            </Card>
            <Card title="Top suppliers by spend" description="Committed spend on your orders, last 24 months." actions={<Button size="sm" variant="ghost" to="/procurement/suppliers">All suppliers</Button>}>
              {analytics.loading ? <SkeletonRows rows={5} columns={2} /> : (
                <Distribution items={(a.spend_by_supplier || []).map((x) => ({ label: x.supplier, value: num(x.spend) }))} format={(v) => formatMoney(v, 'USD', 0)} emptyText="No committed orders to rank suppliers by yet." />
              )}
            </Card>
            <Card title="Spend by category" description="From the catalogue item on each line; free-text lines are uncategorised.">
              {analytics.loading ? <SkeletonRows rows={5} columns={2} /> : (
                <Distribution items={(a.spend_by_category || []).map((x) => ({ label: x.category, value: num(x.spend) }))} format={(v) => formatMoney(v, 'USD', 0)} emptyText="No spend to split yet." />
              )}
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <ListCard title="Recent requisitions" to="/procurement/purchase-requisitions" loading={recentPrs.loading} error={recentPrs.error} emptyText="No requisitions raised yet.">
              {rows(recentPrs.data).slice(0, RECENT).map((pr) => (
                <Row key={pr.id} to={`/procurement/purchase-requisitions/${pr.id}`} title={<Code>{pr.pr_number || '—'}</Code>} subtitle={pr.item_description || pr.item_name} status={<StatusBadge status={pr.status} />}
                  trailing={pr.estimated_unit_price != null ? <Money amount={num(pr.quantity) * num(pr.estimated_unit_price)} /> : null} />
              ))}
            </ListCard>
            <ListCard title="Recent purchase orders" to="/procurement/purchase-orders" loading={recentPos.loading} error={recentPos.error} emptyText="No purchase orders raised yet.">
              {rows(recentPos.data).slice(0, RECENT).map((po) => (
                <Row key={po.id} to={`/procurement/purchase-orders/${po.id}`} title={<Code>{po.po_number || '—'}</Code>} subtitle={po.supplier_name} status={<StatusBadge status={po.status} />} trailing={<Money amount={po.total_amount} currency={po.currency} />} />
              ))}
            </ListCard>
          </div>
        </div>

        <aside className="min-w-0 space-y-4">
          <ListCard title="Simeli findings" to="/ai-findings" loading={findings.loading} error={findings.error} emptyText="Simeli has not flagged anything in procurement.">
            {findingRows.slice(0, 5).map((x) => (
              <Row key={x.id} to="/ai-findings" title={x.title} subtitle={x.description} status={x.severity ? <Badge tone={x.severity === 'HIGH' ? 'risk' : x.severity === 'MEDIUM' ? 'warn' : 'ink'}>{humanize(x.severity)}</Badge> : null} />
            ))}
          </ListCard>
          <ListCard title="Recent activity" to="/admin/audit-trail" loading={activity.loading} error={activity.error} emptyText="No activity recorded yet.">
            {rows(activity.data).map((x, i) => (
              <Row key={`${x.entity_type}-${x.entity_id}-${i}`} title={`${humanize(x.entity_type)} → ${humanize(x.to_status)}`} subtitle={`${x.changed_by_name || 'System'} · ${relativeTime(x.occurred_at)}`} />
            ))}
          </ListCard>
          <nav aria-label="More procurement" className="rounded-lg border border-ink-200 bg-surface">
            <h2 className="label-mono border-b border-ink-200 px-4 py-2.5">Also here</h2>
            <ul className="divide-y divide-ink-100">
              {[
                ['Suppliers', '/procurement/suppliers'], ['Contracts', '/procurement/contracts'], ['Receive goods', '/procurement/goods-receipts/create'],
                ['Delivery tracking', '/procurement/delivery-tracking'], ['Supplier invoices', '/finance/supplier-invoices'],
              ].map(([label, to]) => <Row key={to} to={to} title={label} />)}
            </ul>
          </nav>
        </aside>
      </div>
    </div>
  )
}
