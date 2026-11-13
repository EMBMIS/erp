import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PlusIcon, EyeIcon, TrashIcon, TruckIcon, CheckCircleIcon, ShoppingCartIcon, ArrowTopRightOnSquareIcon, ArrowDownTrayIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useAuth } from '../../contexts/AuthContext'
import {
  PageHeader, Button, DataTable, RowAction, StatusBadge, Badge, Code, DateText, Num, ConfirmDialog, Segmented, Tabs,
  Stat, Sheet, DescriptionList, Timeline, InlineNotice, SkeletonRows, ErrorState, exportCsv, daysFrom, notify,
} from '../../components/ui'
import { CustomerDeliveriesTable } from './SalesDeliveryTracking'

/**
 * Delivery schedules — when and how goods leave for the customer.
 *
 * Two lists: schedules raised from sales orders (shipped from stock, or
 * dropshipped through an automatic purchase order), and supplier orders
 * shipping straight to a customer, which need the sales side's handover.
 * A schedule opens in a side sheet (also reachable as ?schedule=<id>).
 */
const LIMIT = 1000
const humanize = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
const DONE = new Set(['DELIVERED', 'CANCELLED', 'FAILED'])
const isOverdue = (d) => d.delivery_date && !DONE.has(d.status) && daysFrom(d.delivery_date) < 0
const PRIORITY_TONE = { URGENT: 'risk', HIGH: 'warn' }
const needsPo = (d) => (d.fulfillment_type === 'PURCHASE_ORDER' || d.fulfillment_type === 'HYBRID') && d.status === 'SCHEDULED' && !d.purchase_order_created
const poId = (d) => d.purchase_order_id || d.auto_purchase_order_id

const QUICK = {
  open: { label: 'Open', test: (d) => !DONE.has(d.status) },
  scheduled: { label: 'Scheduled', test: (d) => d.status === 'SCHEDULED' },
  ready: { label: 'Ready to ship', test: (d) => d.status === 'READY_TO_SHIP' },
  transit: { label: 'In transit', test: (d) => d.status === 'IN_TRANSIT' },
  overdue: { label: 'Overdue', test: isOverdue },
  delivered: { label: 'Delivered', test: (d) => d.status === 'DELIVERED' },
  all: { label: 'All', test: () => true },
}
const CUSTOMER_PO = ['SENT_TO_SUPPLIER', 'CONFIRMED', 'PREPARING_DELIVERY', 'IN_TRANSIT', 'DELIVERED', 'GOODS_READY_FOR_RECEIPT', 'READY_FOR_CUSTOMER_DELIVERY', 'DELIVERED_TO_CUSTOMER', 'CUSTOMER_CONFIRMED']

/** One schedule, in a side sheet: what ships, where, and what happened to it. */
export function ScheduleSheet({ id, onClose }) {
  const { data: s, loading, error, refetch } = useResource(keys.deliverySchedule(id), ({ signal }) => api.get(`/delivery-schedules/${id}`, { signal }), { enabled: Boolean(id) })
  const { data: hist } = useResource([...keys.deliverySchedule(id), 'history'], ({ signal }) => api.get(`/delivery-schedules/${id}/status-history`, { signal }), { enabled: Boolean(id) })
  const items = Array.isArray(s?.items) ? s.items : []
  const events = (Array.isArray(hist) ? hist : []).map((h) => ({
    title: h.from_status ? `${humanize(h.from_status)} → ${humanize(h.to_status || h.status)}` : humanize(h.to_status || h.status),
    actor: h.changed_by_name,
    at: h.changed_at || h.status_date || h.created_at,
    tone: (h.to_status || h.status) === 'DELIVERED' ? 'ok' : ['FAILED', 'CANCELLED'].includes(h.to_status || h.status) ? 'risk' : 'brand',
    note: h.reason || h.notes,
  }))
  return (
    <Sheet open={Boolean(id)} onClose={onClose} title={s?.schedule_number || 'Delivery schedule'} description={s ? `${s.customer_name || ''}${s.so_number || s.sales_order_number ? ` · ${s.so_number || s.sales_order_number}` : ''}` : undefined} width="lg">
      {loading ? <SkeletonRows rows={6} columns={2} /> : error || !s ? (
        <ErrorState compact what="Delivery schedule" error={error || { response: { status: 404, data: { error: 'No delivery schedule with this id is visible to you.' } } }} onRetry={refetch} />
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={s.status} />
            {s.fulfillment_type && <Badge>{humanize(s.fulfillment_type)}</Badge>}
            {isOverdue(s) && <Badge tone="risk">▲ {Math.abs(daysFrom(s.delivery_date))}d late</Badge>}
          </div>
          <DescriptionList
            items={[
              { label: 'Delivery date', value: <DateText value={s.delivery_date} /> },
              { label: 'Priority', value: s.priority ? humanize(s.priority) : null },
              { label: 'Sales order', value: s.sales_order_id ? <Button variant="ghost" size="sm" to={`/sales/sales-orders/${s.sales_order_id}`}><Code>{s.so_number || s.sales_order_number || 'Open order'}</Code></Button> : null },
              { label: 'Purchase order', value: poId(s) ? <Button variant="ghost" size="sm" to={`/procurement/purchase-orders/${poId(s)}`}>Open purchase order</Button> : null },
              { label: 'Contact', value: [s.contact_person, s.contact_phone, s.contact_email].filter(Boolean).join(' · ') || null },
              { label: 'Driver / vehicle', value: [s.driver_name, s.vehicle_number].filter(Boolean).join(' · ') || null },
              { label: 'Tracking', value: s.tracking_number ? <Code>{s.tracking_number}</Code> : null },
              { label: 'Shipping method', value: s.shipping_method },
              { label: 'Deliver to', value: s.delivery_address ? <span className="whitespace-pre-line">{s.delivery_address}</span> : null, wide: true },
              { label: 'Notes', value: s.notes || null, wide: true },
            ]}
          />
          <section>
            <h3 className="mb-2 text-sm font-semibold text-fg">Items</h3>
            {items.length ? (
              <ul className="divide-y divide-ink-100 rounded-lg border border-ink-200">
                {items.map((it) => (
                  <li key={it.id} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0">
                      <span className="block truncate">{it.item_name}</span>
                      <span className="block text-2xs text-ink-500">{humanize(it.fulfillment_method || 'INVENTORY')}{it.status ? ` · ${humanize(it.status)}` : ''}</span>
                    </span>
                    <span className="shrink-0 text-right tabular-nums">
                      <Num value={it.delivered_quantity} /> / <Num value={it.ordered_quantity} unit={it.unit_of_measure} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-ink-500">No items on this schedule.</p>}
          </section>
          <section>
            <h3 className="mb-2 text-sm font-semibold text-fg">History</h3>
            <Timeline events={events} />
          </section>
        </div>
      )}
    </Sheet>
  )
}

export default function DeliverySchedulesList() {
  const { user } = useAuth()
  const canDelete = ['MANAGER', 'ADMIN'].includes(user?.role)
  const [search, setSearch] = useSearchParams()
  const openId = search.get('schedule')
  const setOpen = (id) => setSearch((p) => { const n = new URLSearchParams(p); if (id) n.set('schedule', id); else n.delete('schedule'); return n }, { replace: true })
  const [tab, setTab] = useState('schedules')
  const [quick, setQuick] = useState('open')
  const [confirm, setConfirm] = useState(null) // { kind, schedule }

  const params = { limit: LIMIT }
  const { data, loading, error, refetch } = useResource(keys.deliverySchedules(params), ({ signal }) => api.get('/delivery-schedules', { params, signal }))
  const schedules = useMemo(() => (Array.isArray(data) ? data : []), [data])
  const { data: stats, loading: statsLoading } = useResource(['delivery-schedules-stats'], ({ signal }) => api.get('/delivery-schedules/stats', { signal }))
  const { data: poData, loading: poLoading, error: poError, refetch: poRefetch } = useResource(['purchase-orders', 'delivery-tab'], ({ signal }) => api.get('/purchase-orders', { signal }), { enabled: tab === 'customer' })
  const customerPos = useMemo(() => (Array.isArray(poData) ? poData : []).filter((po) =>
    (po.source_type?.includes('sales_order') || po.source_type?.includes('contract_sales') || po.sales_order_id || ['READY_FOR_CUSTOMER_DELIVERY', 'DELIVERED_TO_CUSTOMER', 'CUSTOMER_CONFIRMED'].includes(po.status)) && CUSTOMER_PO.includes(po.status)
  ), [poData])

  const invalidates = [['delivery-schedules'], ['delivery-schedules-stats'], ['sales-orders']]
  const setStatus = useResourceMutation(({ id, status }) => api.put(`/delivery-schedules/${id}/status`, { status }), { invalidates, silent: true })
  const createPo = useResourceMutation((id) => api.post(`/delivery-schedules/${id}/create-purchase-order`), { invalidates: [...invalidates, ['purchase-orders']], silent: true })
  const remove = useResourceMutation((id) => api.delete(`/delivery-schedules/${id}`), { invalidates, silent: true })

  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, schedules.filter(q.test).length])), [schedules])

  const columns = useMemo(() => [
    { id: 'no', header: 'Schedule', accessor: 'schedule_number', width: 150, mobile: 'title', cell: (d) => <Code>{d.schedule_number}</Code> },
    { id: 'so', header: 'Sales order', accessor: (d) => d.sales_order_number || d.so_number, width: 130, cell: (d) => <Code className="text-ink-600">{d.sales_order_number || d.so_number || '—'}</Code> },
    { id: 'customer', header: 'Customer', accessor: 'customer_name', filter: 'text', minWidth: 170, maxWidth: 260, mobile: 'subtitle' },
    {
      id: 'date', header: 'Delivery', accessor: 'delivery_date', width: 150,
      cell: (d) => (
        <span className="flex items-center gap-1.5">
          <DateText value={d.delivery_date} />
          {isOverdue(d) && <span className="font-mono text-2xs text-risk-600" title="Delivery date has passed">▲ {Math.abs(daysFrom(d.delivery_date))}d late</span>}
        </span>
      ),
    },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 130, mobile: 'meta', cell: (d) => <StatusBadge status={d.status} /> },
    { id: 'qty', header: 'Delivered', accessor: (d) => Number(d.total_ordered_quantity) || 0, align: 'right', width: 110, mobile: 'trailing', cell: (d) => <span className="tabular-nums">{Number(d.total_delivered_quantity) || 0} / {Number(d.total_ordered_quantity) || 0}</span> },
    { id: 'lines', header: 'Lines', accessor: (d) => Number(d.item_count) || 0, align: 'right', width: 70, defaultHidden: true },
    { id: 'how', header: 'Fulfilment', accessor: (d) => humanize(d.fulfillment_type), filter: 'select', width: 110 },
    { id: 'priority', header: 'Priority', accessor: 'priority', filter: 'select', width: 90, defaultHidden: true, cell: (d) => (PRIORITY_TONE[d.priority] ? <Badge tone={PRIORITY_TONE[d.priority]}>{humanize(d.priority)}</Badge> : <span className="text-ink-600">{d.priority ? humanize(d.priority) : '—'}</span>) },
    { id: 'driver', header: 'Driver', accessor: 'driver_name', width: 130, defaultHidden: true },
    { id: 'tracking', header: 'Tracking', accessor: 'tracking_number', width: 140, defaultHidden: true, cell: (d) => (d.tracking_number ? <Code>{d.tracking_number}</Code> : '—') },
  ], [])

  const run = async () => {
    const { kind, schedule: d } = confirm
    try {
      if (kind === 'ship') await setStatus.mutateAsync({ id: d.id, status: 'IN_TRANSIT' })
      if (kind === 'deliver') await setStatus.mutateAsync({ id: d.id, status: 'DELIVERED' })
      if (kind === 'po') {
        const po = await createPo.mutateAsync(d.id)
        notify.success(`${po?.po_number || 'Purchase order'} created for ${d.schedule_number}`)
      }
      if (kind === 'delete') await remove.mutateAsync(d.id)
      if (kind !== 'po') notify.success(`${d.schedule_number} ${{ ship: 'marked in transit', deliver: 'marked delivered', delete: 'deleted' }[kind]}`)
    } catch (e) {
      const r = e?.response?.data || {}
      notify.error(`${d.schedule_number}: ${r.error || e.message}`)
    }
    setConfirm(null)
  }

  const COPY = confirm && {
    ship: { title: `Mark ${confirm.schedule.schedule_number} as shipped?`, consequence: `The delivery moves to In transit and the sales order to Shipped.`, label: 'Mark shipped', tone: 'primary' },
    deliver: { title: `Mark ${confirm.schedule.schedule_number} as delivered?`, consequence: 'Delivered quantities are booked. Once every shipment for the order is in, the customer is asked to confirm receipt.', label: 'Mark delivered', tone: 'primary' },
    po: { title: `Create a purchase order for ${confirm.schedule.schedule_number}?`, consequence: 'A purchase order is raised to the supplier for the dropship lines on this delivery.', label: 'Create purchase order', tone: 'primary' },
    delete: { title: `Delete ${confirm.schedule.schedule_number}?`, consequence: 'The schedule disappears from every list and its lines are no longer shipped. The sales order stays as it is. There is no undo in the app.', label: `Delete ${confirm.schedule.schedule_number}`, tone: 'danger', confirmText: confirm.schedule.schedule_number },
  }[confirm.kind]

  return (
    <>
      <PageHeader
        title="Delivery schedules"
        description="When and how goods leave for the customer — from stock, or shipped direct by a supplier."
        secondary={tab === 'schedules' ? <Button icon={ArrowDownTrayIcon} onClick={() => exportCsv(schedules.filter(QUICK[quick].test), columns, 'delivery-schedules.csv')} disabled={!schedules.length}>Export</Button> : null}
        primary={<Button variant="primary" icon={PlusIcon} to="/sales/delivery-schedules/create" kbd="N">Schedule delivery</Button>}
      />

      <Tabs
        value={tab}
        onChange={setTab}
        label="Delivery lists"
        className="space-y-4"
        tabs={[{ id: 'schedules', label: 'Schedules', count: schedules.length }, { id: 'customer', label: 'Customer deliveries' }]}
      >
        {(t) => (
          <div className="pt-4">
            {t === 'schedules' && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <Stat label="Due today" value={stats ? <Num value={stats.today_deliveries} /> : '—'} loading={statsLoading} reason={stats ? `${Number(stats.scheduled_deliveries) || 0} scheduled in total.` : undefined} />
                  <Stat label="In transit" value={stats ? <Num value={stats.in_transit_deliveries} /> : '—'} loading={statsLoading} onClick={() => setQuick('transit')} />
                  <Stat label="Overdue" value={stats ? <Num value={stats.overdue_deliveries} /> : '—'} loading={statsLoading} reason="Past their date and not delivered." onClick={() => setQuick('overdue')} />
                  <Stat label="Delivered" value={stats ? <Num value={stats.delivered_deliveries} /> : '—'} loading={statsLoading} reason={stats?.delivery_success_rate != null ? `${Number(stats.delivery_success_rate).toFixed(0)}% of concluded deliveries succeeded.` : 'No concluded deliveries yet.'} />
                </div>
                {schedules.length >= LIMIT && (
                  <InlineNotice tone="warn" title={`Showing the first ${LIMIT.toLocaleString()} schedules`}>Use search or a quick view to narrow the list.</InlineNotice>
                )}
                <DataTable
                  viewKey="sales.delivery-schedules"
                  caption="Delivery schedules"
                  noun="delivery schedule"
                  rows={schedules}
                  columns={columns}
                  loading={loading}
                  error={error}
                  onRetry={refetch}
                  onRowClick={(d) => setOpen(d.id)}
                  externalFilter={QUICK[quick].test}
                  defaultSort={{ id: 'date', dir: 'asc' }}
                  searchPlaceholder="Search schedule, order, customer"
                  toolbarStart={
                    <Segmented
                      label="Show"
                      value={quick}
                      onChange={setQuick}
                      options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))}
                      className="max-w-full overflow-x-auto"
                    />
                  }
                  rowActions={(d) => (
                    <>
                      <RowAction icon={EyeIcon} label={`Open ${d.schedule_number}`} onClick={() => setOpen(d.id)} />
                      {needsPo(d) && <RowAction icon={ShoppingCartIcon} label={`Create purchase order for ${d.schedule_number}`} onClick={() => setConfirm({ kind: 'po', schedule: d })} />}
                      {poId(d) && <RowAction icon={ArrowTopRightOnSquareIcon} label={`Open the purchase order for ${d.schedule_number}`} to={`/procurement/purchase-orders/${poId(d)}`} />}
                      {d.status === 'READY_TO_SHIP' && <RowAction icon={TruckIcon} label={`Mark ${d.schedule_number} shipped`} onClick={() => setConfirm({ kind: 'ship', schedule: d })} />}
                      {d.status === 'IN_TRANSIT' && <RowAction icon={CheckCircleIcon} label={`Mark ${d.schedule_number} delivered`} onClick={() => setConfirm({ kind: 'deliver', schedule: d })} />}
                      <RowAction icon={TrashIcon} tone="risk" label={`Delete ${d.schedule_number}`} onClick={() => setConfirm({ kind: 'delete', schedule: d })} disabled={!canDelete} reason={canDelete ? undefined : 'Only managers and admins can delete delivery schedules.'} />
                    </>
                  )}
                  empty={{
                    icon: TruckIcon,
                    title: 'No delivery schedules',
                    description: 'Schedule a delivery from a confirmed sales order to plan when the goods leave.',
                    action: <Button variant="primary" icon={PlusIcon} to="/sales/delivery-schedules/create">Schedule delivery</Button>,
                  }}
                />
              </div>
            )}
            {t === 'customer' && (
              <CustomerDeliveriesTable orders={customerPos} loading={poLoading} error={poError} onRetry={poRefetch} invalidates={[['purchase-orders']]} />
            )}
          </div>
        )}
      </Tabs>

      {openId && <ScheduleSheet id={openId} onClose={() => setOpen(null)} />}

      {COPY && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={run}
          title={COPY.title}
          consequence={COPY.consequence}
          reversible={false}
          confirmLabel={COPY.label}
          tone={COPY.tone}
          confirmText={COPY.confirmText}
          busy={setStatus.isPending || createPo.isPending || remove.isPending}
        />
      )}
    </>
  )
}
