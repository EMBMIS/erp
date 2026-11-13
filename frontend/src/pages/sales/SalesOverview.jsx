import { Link } from 'react-router-dom'
import { ChevronRightIcon, PlusIcon } from '@heroicons/react/20/solid'
import api, {
  auditTrailAPI, customerInvoicesAPI, customersAPI, deliverySchedulesAPI,
  financeAPI, salesContractsAPI, salesOrdersAPI, salesQuotationsAPI, salesRfqsAPI,
} from '../../services/api'
import { useResource } from '../../hooks/useResource'
import ProcessFlow from '../../components/process/ProcessFlow'
import RevenueDrivers from '../../components/sales/RevenueDrivers'
import {
  PageHeader, Button, Card, Stat, StatusBadge, Badge, Money, Num, Code, ErrorState, SkeletonRows, Timeline,
  LineChart, Sparkline, Distribution, formatMoney, formatNumber, DateText,
} from '../../components/ui'

/**
 * Sales — the module's overview.
 *
 * The pipeline is the spine: RFQ → quotation → order → delivery → invoice.
 * Two things this screen is careful about:
 *
 * 1. Scope. Sales orders are isolated per user server-side (findAll and
 *    getStats filter on created_by). Quotations, contracts, RFQs and
 *    deliveries are company-wide, so the order figures are labelled "yours".
 * 2. Delivery success is not on-time rate. delivery_schedules has a planned
 *    date and a status but no actual delivery date, so the figure is the
 *    share of concluded deliveries that ended DELIVERED rather than FAILED or
 *    CANCELLED. Deliveries past their date are counted separately.
 *
 * A figure the server could not give is shown as "—", never as zero.
 */

const RECENT_ROWS = 5
const HORIZON_DAYS = 14
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const has = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))
const rows = (d) => (Array.isArray(d) ? d : d?.data || d?.rows || [])
const humanize = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
const pct = (v, digits = 1) => (has(v) ? `${Number(v).toFixed(digits)}%` : '—')

const ORDER_STATUSES = [['draft_orders', 'Draft'], ['confirmed_orders', 'Confirmed'], ['delivered_orders', 'Delivered', 'ok']]
const CONTRACT_STATUSES = [['draft_contracts', 'Draft'], ['active_contracts', 'Active', 'ok'], ['expiring_soon', 'Expiring soon', 'warn'], ['expired_contracts', 'Expired', 'risk']]
const DELIVERY_STATUSES = [['scheduled_deliveries', 'Scheduled'], ['in_transit_deliveries', 'In transit'], ['delivered_deliveries', 'Delivered', 'ok'], ['failed_deliveries', 'Failed', 'risk'], ['cancelled_deliveries', 'Cancelled']]
const toItems = (stats, vocab, to) => vocab.map(([key, label, tone]) => ({ label, value: n(stats?.[key]), tone, to })).filter((i) => i.value > 0)

const VERDICT = {
  uncovered: ['No supply', 'risk'], late: ['Late', 'risk'], at_risk: ['At risk', 'warn'],
  unknown_item: ['Unmatched item', 'warn'], on_track: ['On track', 'ok'], covered: ['In stock', 'ok'],
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

export default function SalesOverview() {
  const trendsQ = useResource(['finance', 'kpi-trends', 24], () => financeAPI.getKpiTrends(24))
  const rfqsQ = useResource(['sales-rfqs-stats'], () => salesRfqsAPI.stats())
  const quotesQ = useResource(['sales-quotations-stats'], () => salesQuotationsAPI.stats())
  const ordersQ = useResource(['sales-orders', 'stats'], () => salesOrdersAPI.stats())
  const deliveriesQ = useResource(['delivery-schedules-stats'], () => deliverySchedulesAPI.stats())
  const contractsQ = useResource(['sales-contracts-stats'], () => salesContractsAPI.stats())
  const customersQ = useResource(['customers', 'stats'], () => customersAPI.stats())
  const invoicesQ = useResource(['customer-invoices', 'stats'], () => customerInvoicesAPI.stats())
  const recentQuotesQ = useResource(['sales-quotations', { limit: RECENT_ROWS }], () => salesQuotationsAPI.list({ limit: RECENT_ROWS }))
  // Capped scan, aggregated client-side into top customers; the card says so.
  const orderRowsQ = useResource(['sales-orders', { limit: 500 }], () => salesOrdersAPI.list({ limit: 500 }))
  const activityQ = useResource(['sales', 'activity'], () => auditTrailAPI.list({ limit: 6, entity_type: 'SALES_ORDER,SALES_QUOTATION,SALES_CONTRACT,SALES_RFQ,DELIVERY_SCHEDULE,CUSTOMER_INVOICE' }))
  const findingsQ = useResource(['sales', 'findings'], ({ signal }) => api.get('/ai-findings?status=OPEN&entity_type=CUSTOMER_INVOICE', { signal }))
  const riskQ = useResource(['delivery-risk', { horizon_days: HORIZON_DAYS }], ({ signal }) => api.get('/delivery-risk', { params: { horizon_days: HORIZON_DAYS }, signal }))

  const trends = Array.isArray(trendsQ.data) ? trendsQ.data : []
  const rfqs = rfqsQ.data || {}
  const quotes = quotesQ.data || {}
  const orders = ordersQ.data || {}
  const deliveries = deliveriesQ.data || {}
  const contracts = contractsQ.data || {}
  const customers = customersQ.data || {}
  const invoices = invoicesQ.data || {}
  const orderRows = rows(orderRowsQ.data)
  const recentQuotes = rows(recentQuotesQ.data).slice(0, RECENT_ROWS)
  const recentOrders = orderRows.slice(0, RECENT_ROWS)
  const activity = rows(activityQ.data)
  const findings = rows(findingsQ.data)
  const risk = riskQ.data || {}
  const riskOrders = risk.orders || []

  // Revenue: the last twelve months of the series.
  const last12 = trends.slice(-12)
  const revenue = last12.map((m) => n(m.revenue))
  const latestRevenue = trends.length ? trends[trends.length - 1].revenue : null
  const prevRevenue = trends.length > 1 ? n(trends[trends.length - 2].revenue) : null
  const revenueChange = prevRevenue ? ((n(latestRevenue) - prevRevenue) / Math.abs(prevRevenue)) * 100 : null
  const revenuePoints = last12.map((m) => {
    const mo = Number(String(m.month).slice(5, 7))
    return { x: `${MONTHS[mo - 1] || m.month} ${String(m.month).slice(2, 4)}`, y: n(m.revenue) }
  })

  const stages = [
    { label: 'RFQs to suppliers', count: rfqs.total_rfqs, value: rfqs.total_quoted_value, scope: 'Company', to: '/sales/rfqs', q: rfqsQ },
    { label: 'Quotations', count: quotes.total_quotations, value: quotes.total_value, scope: 'Company', to: '/sales/quotations', q: quotesQ },
    { label: 'Sales orders', count: orders.total_orders, value: orders.total_value, scope: 'Yours', to: '/sales/sales-orders', q: ordersQ },
    { label: 'Delivered', count: deliveries.delivered_deliveries, value: null, scope: 'Company', to: '/sales/delivery-schedules', q: deliveriesQ },
    { label: 'Invoiced', count: invoices.total_invoices, value: invoices.total_invoiced, scope: 'Company', to: '/finance/customer-invoices', q: invoicesQ },
  ]
  const quoteConversion = n(quotes.total_quotations) > 0 && has(quotes.converted_quotations) ? (n(quotes.converted_quotations) / n(quotes.total_quotations)) * 100 : null

  const byCustomer = new Map()
  for (const r of orderRows) {
    const name = r.customer_name || 'Unnamed customer'
    byCustomer.set(name, (byCustomer.get(name) || 0) + n(r.total_amount))
  }
  const topCustomers = [...byCustomer.entries()].map(([label, value]) => ({ label, value })).filter((c) => c.value > 0).sort((a, b) => b.value - a.value).slice(0, 5)

  const winRate = has(quotes.acceptance_rate) ? Number(quotes.acceptance_rate) : null
  const deliverySuccess = has(deliveries.delivery_success_rate) ? Number(deliveries.delivery_success_rate) : null
  const overdue = n(deliveries.overdue_deliveries)

  return (
    <div className="space-y-5">
      <PageHeader
        title="Sales"
        description="The pipeline from RFQ to invoice, what is at risk, and what moved recently."
        secondary={
          <>
            <Button variant="ghost" to="/sales/sales-orders/create">New sales order</Button>
          </>
        }
        primary={<Button variant="primary" icon={PlusIcon} to="/sales/quotations/create">New quotation</Button>}
      />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
        <Stat
          label="Revenue this month"
          loading={trendsQ.loading}
          value={trendsQ.error ? '—' : <Money amount={latestRevenue} digits={0} />}
          delta={revenue.filter((v) => v !== 0).length >= 2 ? <Sparkline values={revenue} width={72} height={24} label="Revenue, last 12 months" /> : null}
          reason={trendsQ.error ? 'Revenue figures are not available to you.' : revenueChange == null ? 'Needs two months of posted revenue to compare.' : `${revenueChange >= 0 ? 'Up' : 'Down'} ${Math.abs(revenueChange).toFixed(1)}% on last month.`}
          to="/finance/reports/income-statement"
        />
        <Stat
          label="Quotations"
          loading={quotesQ.loading}
          value={quotesQ.error ? '—' : <Num value={quotes.total_quotations} />}
          reason={quotesQ.error ? 'Not available.' : `${formatMoney(quotes.total_value, 'USD', 0)} quoted.`}
          to="/sales/quotations"
        />
        <Stat
          label="Win rate"
          loading={quotesQ.loading}
          value={pct(winRate)}
          reason={quotesQ.error ? 'Not available.' : `${formatNumber(quotes.accepted_quotations)} won, ${formatNumber(quotes.rejected_quotations)} lost.`}
          to="/sales/quotations"
        />
        <Stat
          label="Your sales orders"
          loading={ordersQ.loading}
          value={ordersQ.error ? '—' : <Num value={orders.total_orders} />}
          reason={ordersQ.error ? 'Not available.' : `${formatMoney(orders.total_value, 'USD', 0)} ordered. Orders you raised only.`}
          to="/sales/sales-orders"
        />
        <Stat
          label="Delivery success"
          loading={deliveriesQ.loading}
          value={pct(deliverySuccess)}
          reason={deliveriesQ.error ? 'Not available.' : overdue > 0 ? `${formatNumber(overdue)} running past their date.` : 'Concluded deliveries that arrived. Nothing past its date.'}
          to="/sales/delivery-schedules"
        />
      </div>

      <RevenueDrivers />

      <ProcessFlow flow="order_to_cash" />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-5">
        <Card
          title="Pipeline"
          description="Each stage counts a different record, so stage sizes are not conversion rates."
          className="lg:col-span-2"
          padded={false}
          actions={quoteConversion != null ? <span className="text-right text-xs text-ink-600">Quotes converted <span className="font-semibold tabular-nums text-fg">{pct(quoteConversion)}</span></span> : null}
        >
          <table className="w-full text-sm">
            <caption className="sr-only">Sales pipeline by stage</caption>
            <thead>
              <tr className="border-b border-ink-200 text-left">
                <th scope="col" className="label-mono px-4 py-2 font-normal">Stage</th>
                <th scope="col" className="label-mono px-2 py-2 text-right font-normal">Records</th>
                <th scope="col" className="label-mono px-4 py-2 text-right font-normal">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {stages.map((s) => (
                <tr key={s.label}>
                  <th scope="row" className="px-4 py-2.5 text-left font-normal">
                    <Link to={s.to} className="text-ink-900 hover:underline">{s.label}</Link>
                    <span className="ml-2 text-xs text-ink-500">{s.scope}</span>
                  </th>
                  <td className="px-2 py-2.5 text-right">{s.q.loading ? <span className="skeleton inline-block h-4 w-8" /> : s.q.error ? '—' : <Num value={s.count} />}</td>
                  <td className="px-4 py-2.5 text-right">{s.q.loading ? <span className="skeleton inline-block h-4 w-16" /> : s.q.error || s.value == null ? <span className="text-ink-400">—</span> : <Money amount={s.value} digits={0} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Revenue" description="Posted revenue by month, last 12 months" className="lg:col-span-3">
          {trendsQ.loading ? <SkeletonRows rows={4} columns={1} /> : trendsQ.error ? (
            <ErrorState compact what="Revenue trend" error={trendsQ.error} onRetry={trendsQ.refetch} />
          ) : revenuePoints.length >= 2 && revenue.some((v) => v !== 0) ? (
            <LineChart title="Revenue by month" points={revenuePoints} format={(v) => formatMoney(v, 'USD', 0)} />
          ) : <Empty>The trend needs at least two months of posted revenue.</Empty>}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card title="Top customers" description={`By order value${orderRows.length >= 500 ? ', most recent 500 orders' : ''}, your orders`} actions={<Button size="xs" variant="ghost" to="/sales/customers">All</Button>}>
          {orderRowsQ.loading ? <SkeletonRows rows={3} columns={2} /> : orderRowsQ.error ? <ErrorState compact what="Orders" error={orderRowsQ.error} onRetry={orderRowsQ.refetch} />
            : <Distribution items={topCustomers} format={(v) => formatMoney(v, 'USD', 0)} emptyText="No orders to rank customers by yet." />}
          {!customersQ.loading && !customersQ.error && has(customers.total_customers) && (
            <p className="mt-3 text-xs text-ink-500">{formatNumber(customers.active_customers)} active of {formatNumber(customers.total_customers)} customers.</p>
          )}
        </Card>
        <Card title="Contracts" description={has(contracts.total_contracts) ? `${formatNumber(contracts.total_contracts)} in total` : undefined} actions={<Button size="xs" variant="ghost" to="/sales/contracts">All</Button>}>
          {contractsQ.loading ? <SkeletonRows rows={3} columns={2} /> : contractsQ.error ? <ErrorState compact what="Contracts" error={contractsQ.error} onRetry={contractsQ.refetch} />
            : <Distribution items={toItems(contracts, CONTRACT_STATUSES, '/sales/contracts')} emptyText="No contracts recorded yet." />}
        </Card>
        <Card title="Your orders by status" actions={<Button size="xs" variant="ghost" to="/sales/sales-orders">All</Button>}>
          {ordersQ.loading ? <SkeletonRows rows={3} columns={2} /> : ordersQ.error ? <ErrorState compact what="Orders" error={ordersQ.error} onRetry={ordersQ.refetch} />
            : <Distribution items={toItems(orders, ORDER_STATUSES, '/sales/sales-orders')} emptyText="No orders recorded yet." />}
        </Card>
        <Card title="Deliveries" description="Delivery success counts delivered against failed or cancelled." actions={<Button size="xs" variant="ghost" to="/sales/delivery-schedules">All</Button>}>
          {deliveriesQ.loading ? <SkeletonRows rows={3} columns={2} /> : deliveriesQ.error ? <ErrorState compact what="Deliveries" error={deliveriesQ.error} onRetry={deliveriesQ.refetch} />
            : <Distribution items={toItems(deliveries, DELIVERY_STATUSES, '/sales/delivery-schedules')} emptyText="No deliveries recorded yet." />}
        </Card>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
        <ListCard
          title="Deliveries at risk"
          description={`Orders due in the next ${HORIZON_DAYS} days that will slip or depend on slipping supply`}
          loading={riskQ.loading}
          error={riskQ.error}
          onRetry={riskQ.refetch}
          empty={n(risk.summary?.orders_checked) ? `All ${formatNumber(risk.summary.orders_checked)} orders due in the next ${HORIZON_DAYS} days are covered by stock or on-time supply.` : `No orders are due in the next ${HORIZON_DAYS} days.`}
          action={<Button size="xs" variant="ghost" to="/sales/delivery-scheduling">Plan</Button>}
        >
          {riskOrders.length > 0 && riskOrders.slice(0, 6).map((o) => {
            const [label, tone] = VERDICT[o.verdict] || VERDICT.at_risk
            return (
              <Row key={o.sales_order_id} to={`/sales/sales-orders/${o.sales_order_id}`} aside={<Badge tone={tone}>{label}{o.days_late ? ` +${o.days_late}d` : ''}</Badge>}>
                <span className="block truncate text-sm text-ink-900"><Code>{o.so_number}</Code> · {o.customer_name}</span>
                <span className="block truncate text-xs text-ink-500">Due <DateText value={o.due_date} />{o.cause ? ` · ${o.cause}` : ''}</span>
              </Row>
            )
          })}
        </ListCard>
        <ListCard title="Recent quotations" loading={recentQuotesQ.loading} error={recentQuotesQ.error} onRetry={recentQuotesQ.refetch} empty="No quotations raised yet." action={<Button size="xs" variant="ghost" to="/sales/quotations">All</Button>}>
          {recentQuotes.length > 0 && recentQuotes.map((q) => (
            <Row key={q.id} to={`/sales/quotations/${q.id}`} aside={<span className="shrink-0 text-right"><Money amount={q.total_amount} currency={q.currency} digits={0} className="block text-sm" /><StatusBadge status={q.status} /></span>}>
              <Code className="block truncate">{q.quotation_number || '—'}</Code>
              <span className="block truncate text-xs text-ink-500">{q.customer_name || 'No customer'}</span>
            </Row>
          ))}
        </ListCard>
        <ListCard title="Your recent sales orders" loading={orderRowsQ.loading} error={orderRowsQ.error} onRetry={orderRowsQ.refetch} empty="No sales orders raised yet." action={<Button size="xs" variant="ghost" to="/sales/sales-orders">All</Button>}>
          {recentOrders.length > 0 && recentOrders.map((o) => (
            <Row key={o.id} to={`/sales/sales-orders/${o.id}`} aside={<span className="shrink-0 text-right"><Money amount={o.total_amount} currency={o.currency} digits={0} className="block text-sm" /><StatusBadge status={o.status} /></span>}>
              <Code className="block truncate">{o.so_number || '—'}</Code>
              <span className="block truncate text-xs text-ink-500">{o.customer_name || 'No customer'}</span>
            </Row>
          ))}
        </ListCard>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <Card title="Activity" description="Status changes on sales documents">
          {activityQ.loading ? <SkeletonRows rows={3} columns={1} /> : activityQ.error ? <ErrorState compact what="Activity" error={activityQ.error} onRetry={activityQ.refetch} /> : (
            <Timeline
              empty="No activity recorded yet."
              events={activity.map((r, i) => ({ id: `${r.entity_type}-${r.entity_id}-${i}`, title: `${humanize(r.entity_type)} → ${humanize(r.to_status)}`, actor: r.changed_by_name || 'System', at: r.occurred_at }))}
            />
          )}
        </Card>
        <ListCard
          title="Simeli findings"
          description="Open findings on customer invoices"
          loading={findingsQ.loading}
          error={findingsQ.error}
          onRetry={findingsQ.refetch}
          empty="Simeli has not flagged anything in the pipeline."
          action={<Button size="xs" variant="ghost" to="/ai/findings">All</Button>}
        >
          {findings.length > 0 && findings.slice(0, 4).map((f) => (
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
