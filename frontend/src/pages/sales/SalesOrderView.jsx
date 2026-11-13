import { useMemo, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { PencilSquareIcon, PrinterIcon, TruckIcon, XMarkIcon, SparklesIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useRecordTitle } from '../../components/shell/ShellContext'
import { getSalesOrderStatusLabel, isTerminal, isEditable, isInvoiced } from '../../constants/salesOrderStatus'
import { useDeliveryRisk, DeliveryChain, RecoveryPlans, ShipFrom, penaltyText } from '../../components/sales/DeliveryRisk'
import OrderChain from '../../components/sales/OrderChain'
import PromiseCheck from '../../components/sales/PromiseCheck'
import OrderWatch from '../../components/sales/OrderWatch'
import {
  PageHeader, Button, Menu, StatusBadge, Badge, Money, Num, Code, DateText, ConfirmDialog, DetailLayout, SummaryStrip,
  Tabs, Card, DescriptionList, Timeline, RelatedPanel, DataTable, SkeletonDetail, ErrorState, InlineNotice,
  daysFrom, formatDate, notify,
} from '../../components/ui'

const humanize = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
const PRIORITY_TONE = { URGENT: 'risk', HIGH: 'warn', NORMAL: 'ink', LOW: 'ink' }
const DELIVERED = new Set(['DELIVERED', 'WAITING_CUSTOMER_DELIVERY_CONFIRMATION', 'COMPLETED'])
const VERDICT = {
  uncovered: { label: 'No supply', tone: 'risk' },
  late: { label: 'Late', tone: 'risk' },
  at_risk: { label: 'At risk', tone: 'warn' },
  unknown_item: { label: 'Unmatched item', tone: 'warn' },
  on_track: { label: 'On track', tone: 'ok' },
  covered: { label: 'In stock', tone: 'ok' },
}
const NEEDS_RECOVERY = new Set(['late', 'uncovered', 'at_risk'])
const ask = (q) => `/ai/chat?q=${encodeURIComponent(q)}`

/** Can this order ship on time? Traced across stock, production and supply by the delivery-risk service. */
function DeliveryOutlookCard({ salesOrderId }) {
  // `v` bumps after a ship-from change or an approved plan, so the trace is read again.
  const [v0, setV] = useState(0)
  const { loading, data, error } = useDeliveryRisk({ sales_order_id: salesOrderId, ...(v0 ? { v: v0 } : {}) })
  const reload = () => setV((n) => n + 1)
  const order = data?.orders?.[0]
  const v = order ? VERDICT[order.verdict] || VERDICT.at_risk : null
  return (
    <Card title="Delivery outlook" actions={v ? <Badge tone={v.tone}>{v.label}{order.days_late ? ` +${order.days_late}d` : ''}</Badge> : null}>
      {error ? (
        <p className="text-sm text-ink-600">{error}</p>
      ) : loading && !data ? (
        <p className="text-sm text-ink-500">Tracing stock, production and supply…</p>
      ) : !order ? (
        <p className="text-sm text-ink-600">{data?.note || 'Nothing open on this order to trace.'}</p>
      ) : (
        <div className="space-y-2 text-sm text-ink-800">
          <p>
            Promised {formatDate(order.due_date)}
            {order.projected_date ? ` · projected ${formatDate(order.projected_date)}` : order.verdict === 'uncovered' ? ' · no date possible from current supply' : ''}
            {order.value_at_risk ? <> · <Money amount={order.value_at_risk} currency={order.currency} digits={0} /> at risk</> : null}
            {penaltyText(order) ? <> · <span className="text-risk-700">{penaltyText(order)}</span></> : null}
          </p>
          <ShipFrom order={order} onChanged={reload} />
          {order.chain?.length ? <DeliveryChain chain={order.chain} /> : <p className="text-ink-600">Every line is covered by stock or by supply that lands in time.</p>}
          {order.proposals?.length > 0 && (
            <div>
              <p className="label-mono mt-2">Simeli proposes · you decide</p>
              <ul className="mt-1 space-y-1">
                {order.proposals.map((p) => (
                  <li key={p.label} className="flex items-start justify-between gap-3">
                    <span className="min-w-0">{p.label}</span>
                    <Link to={ask(p.tool ? `${p.label} (for ${order.so_number}) — draft it for my approval.` : `Help me with this for ${order.so_number}: ${p.label}.`)} className="shrink-0 text-brand-700 hover:underline">{p.tool ? 'Draft' : 'Ask'}</Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {NEEDS_RECOVERY.has(order.verdict) && <RecoveryPlans order={order} onApproved={reload} />}
          <Link to={ask(`Why is ${order.so_number} for ${order.customer_name} ${order.verdict === 'covered' || order.verdict === 'on_track' ? 'on track' : 'going to be late'}, and what can we do?`)} className="inline-flex items-center gap-1 text-brand-700 hover:underline">
            <SparklesIcon className="h-4 w-4" aria-hidden="true" /> Ask Simeli why
          </Link>
        </div>
      )}
    </Card>
  )
}

/**
 * A sales order, on the record pattern: five facts, lines, deliveries and
 * details in tabs, status history and related records beside them.
 *
 * Status advances only through real operations (approval, customer
 * acceptance, production, goods issue, delivery, invoicing). Cancelling is
 * the one manual step, and it asks for a reason.
 */
export default function SalesOrderView() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [tab, setTab] = useState('lines')
  const [confirm, setConfirm] = useState(false)

  const { data: so, loading, error, refetch } = useResource(keys.salesOrder(id), ({ signal }) => api.get(`/sales-orders/${id}`, { signal }), { enabled: Boolean(id) })
  const { data: historyData } = useResource(['sales-orders', id, 'status-history'], ({ signal }) => api.get(`/sales-orders/${id}/status-history`, { signal }), { enabled: Boolean(id) })
  const dsParams = { sales_order_id: id }
  const { data: dsData, loading: dsLoading } = useResource(keys.deliverySchedules(dsParams), ({ signal }) => api.get('/delivery-schedules', { params: dsParams, signal }), { enabled: Boolean(id) })
  const history = Array.isArray(historyData) ? historyData : []
  const schedules = useMemo(() => (Array.isArray(dsData) ? dsData : []), [dsData])
  const lines = useMemo(() => (Array.isArray(so?.items) ? so.items : []), [so])
  useRecordTitle(so?.so_number, { subtitle: so?.customer_name })

  const cancel = useResourceMutation((reason) => api.post(`/sales-orders/${id}/cancel`, { reason }), { invalidates: [keys.salesOrder(id), ['sales-orders']], silent: true })

  const currency = so?.currency || 'USD'
  const lineColumns = useMemo(() => [
    { id: 'n', header: '#', accessor: (l) => l.line_number, width: 44, align: 'right', cell: (l) => <span className="font-mono text-2xs text-ink-400">{l.line_number}</span> },
    {
      id: 'item', header: 'Item', accessor: 'item_name', minWidth: 200, wrap: true, mobile: 'title',
      cell: (l) => (
        <span>
          <span className="block">{l.item_name}</span>
          {(l.item_code || l.item_description) && <span className="block text-2xs text-ink-500">{l.item_code && <span className="font-mono">{l.item_code}</span>}{l.item_code && l.item_description && ' · '}{l.item_description}</span>}
        </span>
      ),
    },
    { id: 'qty', header: 'Qty', accessor: (l) => Number(l.quantity), align: 'right', width: 110, mobile: 'subtitle', cell: (l) => <Num value={l.quantity} digits={Number(l.quantity) % 1 ? 2 : 0} unit={l.unit_of_measure} /> },
    { id: 'price', header: 'Unit price', accessor: (l) => Number(l.unit_price), align: 'right', width: 120, cell: (l) => <Money amount={l.unit_price} currency={currency} /> },
    { id: 'disc', header: 'Discount', accessor: (l) => Number(l.discount_amount), align: 'right', width: 100, defaultHidden: !lines.some((l) => Number(l.discount_amount)), cell: (l) => (Number(l.discount_amount) ? <Money amount={l.discount_amount} currency={currency} /> : '—') },
    { id: 'total', header: 'Line total', accessor: (l) => Number(l.line_total), align: 'right', width: 130, mobile: 'trailing', cell: (l) => <Money amount={l.line_total} currency={currency} />, footer: () => <Money amount={so?.subtotal} currency={currency} /> },
    { id: 'delivered', header: 'Delivered', accessor: (l) => Number(l.quantity_delivered) || 0, align: 'right', width: 100, cell: (l) => <span className="tabular-nums">{Number(l.quantity_delivered) || 0} / {Number(l.quantity)}{Number(l.quantity_delivered) >= Number(l.quantity) && <span className="ml-1 text-ok-600" aria-label="complete">✓</span>}</span> },
  ], [currency, so?.subtotal, lines])

  const scheduleColumns = useMemo(() => [
    { id: 'no', header: 'Delivery', accessor: 'schedule_number', width: 150, mobile: 'title', cell: (d) => <Code>{d.schedule_number}</Code> },
    { id: 'date', header: 'Date', accessor: 'delivery_date', width: 120, mobile: 'subtitle', cell: (d) => <DateText value={d.delivery_date} /> },
    { id: 'status', header: 'Status', accessor: 'status', width: 140, mobile: 'meta', cell: (d) => <StatusBadge status={d.status} /> },
    { id: 'how', header: 'Fulfilment', accessor: (d) => humanize(d.fulfillment_type), width: 120 },
    { id: 'qty', header: 'Qty', accessor: (d) => Number(d.total_ordered_quantity) || 0, align: 'right', width: 100, mobile: 'trailing', cell: (d) => <span className="tabular-nums">{Number(d.total_delivered_quantity) || 0} / {Number(d.total_ordered_quantity) || 0}</span> },
    { id: 'track', header: 'Tracking', accessor: 'tracking_number', width: 140, cell: (d) => (d.tracking_number ? <Code>{d.tracking_number}</Code> : '—') },
  ], [])

  if (loading) return <SkeletonDetail />
  if (error || !so) {
    return <ErrorState what="Sales order" error={error || { response: { status: 404, data: { error: 'No sales order with this id is visible to you.' } } }} onRetry={refetch} />
  }

  const editable = isEditable(so.status)
  const due = daysFrom(so.delivery_date)
  const late = so.delivery_date && !isTerminal(so.status) && !DELIVERED.has(so.status) && due < 0
  const ordered = lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0)
  const deliveredQty = lines.reduce((s, l) => s + (Number(l.quantity_delivered) || 0), 0)
  const canSchedule = so.status === 'CONFIRMED'

  const doCancel = async (reason) => {
    try {
      await cancel.mutateAsync(reason)
      setConfirm(false)
      notify.success(`${so.so_number} cancelled`)
    } catch (e) {
      setConfirm(false)
      const d = e?.response?.data || {}
      notify.error(`${so.so_number} was not cancelled: ${d.error || e.message}`)
    }
  }

  const primary = editable
    ? <Button variant="primary" icon={PencilSquareIcon} to={`/sales/sales-orders/${id}/edit`}>Edit order</Button>
    : canSchedule ? <Button variant="primary" icon={TruckIcon} to={`/sales/delivery-schedules/create?sales_order_id=${id}`}>Schedule delivery</Button> : null
  const secondary = (
    <>
      {editable && canSchedule && <Button icon={TruckIcon} to={`/sales/delivery-schedules/create?sales_order_id=${id}`}>Schedule delivery</Button>}
      <Button icon={PrinterIcon} onClick={() => window.print()}>Print</Button>
      <Menu
        items={[
          { label: 'Ask Simeli about this order', icon: SparklesIcon, onSelect: () => navigate(ask(`Review sales order ${so.so_number} for ${so.customer_name}: anything unusual about price, quantity or timing?`)) },
          ...(!isTerminal(so.status) ? [{ divider: true }, { label: 'Cancel order', tone: 'risk', icon: XMarkIcon, onSelect: () => setConfirm(true) }] : []),
        ]}
      />
    </>
  )

  const events = history.map((h) => ({
    title: h.from_status ? `${getSalesOrderStatusLabel(h.from_status)} → ${getSalesOrderStatusLabel(h.to_status)}` : getSalesOrderStatusLabel(h.to_status),
    actor: h.changed_by_name,
    at: h.status_date || h.created_at,
    tone: ['CANCELLED', 'REJECTED', 'CUSTOMER_REJECTED', 'DELIVERY_ISSUE_REPORTED'].includes(h.to_status) ? 'risk' : h.to_status === 'COMPLETED' || h.to_status === 'DELIVERED' ? 'ok' : 'brand',
    note: h.reason,
  })).sort((a, b) => new Date(b.at) - new Date(a.at))

  const notice = so.status === 'CANCELLED' || so.status === 'REJECTED' || so.status === 'CUSTOMER_REJECTED' ? (
    <InlineNotice tone="risk" title={getSalesOrderStatusLabel(so.status)}>
      {so.rejection_reason || history.find((h) => h.to_status === so.status)?.reason || 'No reason was recorded.'}
    </InlineNotice>
  ) : so.status === 'DELIVERY_ISSUE_REPORTED' ? (
    <InlineNotice tone="warn" title="The customer reported a delivery issue">{so.customer_delivery_notes || 'No details were given.'}</InlineNotice>
  ) : isInvoiced(so.status) ? (
    <InlineNotice tone="ink">Completed and invoiced. The order is now a financial record and can no longer be edited.</InlineNotice>
  ) : null

  const header = (
    <PageHeader
      title={<Code className="text-[1em]">{so.so_number}</Code>}
      status={<StatusBadge status={so.status} label={getSalesOrderStatusLabel(so.status)} />}
      meta={
        <>
          {so.customer_id ? <Link to={`/sales/customers/${so.customer_id}`} className="hover:underline">{so.customer_name}</Link> : <span>{so.customer_name}</span>}
          <span>Raised by {so.created_by_name || '—'} · <DateText value={so.created_at} /></span>
          {so.reference_number && <span>Ref <span className="font-mono">{so.reference_number}</span></span>}
        </>
      }
      secondary={secondary}
      primary={primary}
    />
  )

  return (
    <>
      <DetailLayout
        header={header}
        notice={<>{notice}<OrderWatch salesOrderId={id} number={so.so_number} /></>}
        summary={
          <SummaryStrip
            facts={[
              { label: 'Total', value: <Money amount={so.total_amount} currency={currency} />, hint: Number(so.tax_amount) ? `incl. ${new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(so.tax_amount))} tax` : 'no tax' },
              { label: 'Customer', value: so.customer_name || '—', hint: so.customer_email || undefined, to: so.customer_id ? `/sales/customers/${so.customer_id}` : undefined },
              { label: 'Delivery', value: <DateText value={so.delivery_date} />, hint: late ? `▲ ${Math.abs(due)} days late` : due != null && !isTerminal(so.status) && !DELIVERED.has(so.status) ? (due === 0 ? 'today' : due > 0 ? `in ${due} days` : `${Math.abs(due)} days ago`) : undefined },
              { label: 'Delivered', value: ordered ? `${Math.round((deliveredQty / ordered) * 100)}%` : '—', hint: `${schedules.length} delivery schedule${schedules.length === 1 ? '' : 's'}` },
              { label: 'Priority', value: so.priority ? <Badge tone={PRIORITY_TONE[so.priority] || 'ink'}>{humanize(so.priority)}</Badge> : '—', hint: so.approved_by_name ? `approved by ${so.approved_by_name}` : undefined },
            ]}
          />
        }
        aside={
          <>
            <OrderChain salesOrderId={id} soNumber={so.so_number} />
            {!isTerminal(so.status) && !DELIVERED.has(so.status) && <PromiseCheck salesOrderId={id} number={so.so_number} />}
            {!isTerminal(so.status) && <DeliveryOutlookCard salesOrderId={id} />}
            <Card title="History" padded>
              <Timeline events={events} />
            </Card>
            <RelatedPanel
              groups={[
                { label: 'Customer', items: so.customer_id ? [{ label: so.customer_name, to: `/sales/customers/${so.customer_id}` }] : [] },
                { label: 'Delivery schedules', items: schedules.map((d) => ({ label: d.schedule_number, sublabel: humanize(d.status) })) },
              ]}
            />
          </>
        }
      >
        <Tabs
          value={tab}
          onChange={setTab}
          label="Sales order sections"
          tabs={[{ id: 'lines', label: 'Lines', count: lines.length }, { id: 'deliveries', label: 'Deliveries', count: schedules.length }, { id: 'details', label: 'Details' }, { id: 'notes', label: 'Notes' }]}
        >
          {(t) => (
            <>
              {t === 'lines' && (
                <DataTable caption="Order lines" noun="line" rows={lines} columns={lineColumns} search={lines.length > 12} showCount={false} empty={{ title: 'No lines on this order', description: 'Lines are added when the order is raised or edited.' }} />
              )}
              {t === 'deliveries' && (
                <DataTable
                  caption="Delivery schedules for this order"
                  noun="delivery"
                  rows={schedules}
                  columns={scheduleColumns}
                  loading={dsLoading}
                  search={false}
                  showCount={false}
                  empty={{
                    icon: TruckIcon,
                    title: 'No deliveries scheduled',
                    description: canSchedule ? 'Plan when and how the goods leave: from stock or shipped direct by a supplier.' : 'A delivery can be scheduled once the order is confirmed.',
                    action: canSchedule ? <Button variant="primary" icon={TruckIcon} to={`/sales/delivery-schedules/create?sales_order_id=${id}`}>Schedule delivery</Button> : null,
                  }}
                />
              )}
              {t === 'details' && (
                <Card>
                  <DescriptionList
                    items={[
                      { label: 'Order date', value: <DateText value={so.order_date} /> },
                      { label: 'Delivery date', value: <DateText value={so.delivery_date} /> },
                      { label: 'Customer reference', value: so.reference_number },
                      { label: 'Payment terms', value: so.payment_terms ? humanize(so.payment_terms) : null },
                      { label: 'Shipping method', value: so.shipping_method },
                      { label: 'Currency', value: <Code>{currency}</Code> },
                      { label: 'Subtotal', value: <Money amount={so.subtotal} currency={currency} /> },
                      { label: 'Discount', value: Number(so.discount_amount) ? <Money amount={so.discount_amount} currency={currency} /> : null },
                      { label: 'Tax', value: <Money amount={so.tax_amount} currency={currency} /> },
                      { label: 'Total', value: <Money amount={so.total_amount} currency={currency} className="font-semibold" /> },
                      { label: 'Customer email', value: so.customer_email },
                      { label: 'Customer phone', value: so.customer_phone },
                      { label: 'Deliver to', value: so.delivery_address ? <span className="whitespace-pre-line">{so.delivery_address}</span> : null, wide: true },
                    ]}
                  />
                </Card>
              )}
              {t === 'notes' && (
                <Card>
                  <DescriptionList
                    columns={1}
                    items={[
                      { label: 'Notes for the customer', value: so.notes ? <span className="whitespace-pre-line">{so.notes}</span> : null },
                      { label: 'Delivery instructions', value: so.delivery_instructions ? <span className="whitespace-pre-line">{so.delivery_instructions}</span> : null },
                      { label: 'Internal notes', value: so.internal_notes?.trim() ? <span className="whitespace-pre-line">{so.internal_notes.trim()}</span> : null },
                    ]}
                  />
                </Card>
              )}
            </>
          )}
        </Tabs>
      </DetailLayout>

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={doCancel}
        title={`Cancel ${so.so_number}?`}
        consequence={`The order stops here and cannot be reopened. ${so.customer_name || 'The customer'} is not told automatically.`}
        reversible={false}
        confirmLabel={`Cancel ${so.so_number}`}
        tone="danger"
        requireReason
        reasonHelp="At least three characters. Recorded in the order's history."
        busy={cancel.isPending}
      />
    </>
  )
}
