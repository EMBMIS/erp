import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { PlusIcon, EyeIcon, CheckCircleIcon, TruckIcon, ArrowTopRightOnSquareIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, DataTable, RowAction, StatusBadge, Code, DateText, Money, Num, Stat, Tabs, ConfirmDialog,
  Field, Input, Select, Textarea, Combobox, FormSection, ErrorSummary, LineItemEditor, InlineNotice, daysFrom, notify,
} from '../../components/ui'
import { ScheduleSheet } from './DeliverySchedulesList'

/**
 * Delivery scheduling.
 *
 *   /sales/delivery-schedules/create   Schedule a delivery for a confirmed
 *                                      sales order: per line, ship from stock
 *                                      or dropship from a supplier (which
 *                                      raises the purchase orders automatically).
 *   /sales/delivery-scheduling         The planning view: confirmed orders with
 *                                      nothing scheduled, what ships next, and
 *                                      the purchase orders raised for deliveries.
 *
 * The planning view previously crashed on load: its stats read a helper
 * before the helper was defined (temporal dead zone).
 */
const list = (d) => (Array.isArray(d) ? d : d?.data || [])
const humanize = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
const supplierName = (s) => s.legal_name || s.company_name || s.trade_name || s.supplier_code
const CONFIRMED = { status: 'CONFIRMED' }
const SALES_SOURCED = { source_type: 'sales' }
const isSalesPo = (po) => po.sales_order_id || po.source_type === 'delivery_schedule' || po.source_type?.includes('sales')
const toItem = (it, source) => ({
  _key: it.id || `${Math.random()}`,
  sales_order_item_id: it.id,
  item_code: it.item_code,
  item_name: it.item_name,
  unit_of_measure: it.unit_of_measure || it.unit || 'units',
  ordered: Number(it.quantity) || 0,
  quantity_to_deliver: String(Number(it.quantity) || ''),
  fulfillment_type: source === 'inventory' ? 'INVENTORY' : 'DROPSHIP',
  supplier_id: '',
  unit_cost: '',
})

function validate(form, items) {
  const e = {}
  if (!form.sales_order_id) e.sales_order_id = 'Choose the confirmed sales order to deliver.'
  if (!form.scheduled_date) e.scheduled_date = 'Set the delivery date.'
  const lineErrors = {}
  const real = items.filter((i) => i.item_name)
  items.forEach((it, i) => {
    if (!it.item_name) return
    const le = {}
    const q = parseFloat(it.quantity_to_deliver)
    if (!(q > 0)) le.quantity_to_deliver = 'Quantity above zero'
    else if (it.ordered && q > it.ordered) le.quantity_to_deliver = `At most ${it.ordered}`
    if (it.fulfillment_type === 'DROPSHIP' && !it.supplier_id) le.supplier_id = 'Choose the supplier'
    if (it.fulfillment_type === 'DROPSHIP' && !(parseFloat(it.unit_cost) > 0)) le.unit_cost = 'Cost above zero'
    if (Object.keys(le).length) lineErrors[i] = le
  })
  if (form.sales_order_id && !real.length) e.items = 'Keep at least one line from the order.'
  return { e, lineErrors }
}

function ScheduleDeliveryForm() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [form, setFormState] = useState({ sales_order_id: params.get('sales_order_id') || '', source_type: 'inventory', purchase_order_id: '', scheduled_date: '', notes: '' })
  const setForm = (patch) => setFormState((f) => ({ ...f, ...patch }))
  const [items, setItems] = useState([])
  const [loadedFor, setLoadedFor] = useState(null)
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState(null)

  const { data: soData, loading: soLoading } = useResource(keys.salesOrders(CONFIRMED), ({ signal }) => api.get('/sales-orders', { params: CONFIRMED, signal }))
  const { data: poData } = useResource(keys.purchaseOrders(SALES_SOURCED), ({ signal }) => api.get('/purchase-orders', { params: SALES_SOURCED, signal }))
  const { data: supData } = useResource(['suppliers', 'active'], ({ signal }) => api.get('/suppliers/active', { signal }))
  const { data: soItems, loading: itemsLoading } = useResource(['sales-orders', form.sales_order_id, 'items'], ({ signal }) => api.get(`/sales-orders/${form.sales_order_id}/items`, { signal }), { enabled: Boolean(form.sales_order_id) })
  const orders = list(soData)
  const pos = list(poData).filter(isSalesPo)
  const suppliers = list(supData)
  const order = orders.find((o) => o.id === form.sales_order_id)

  // Lines come from the chosen order, once per order.
  useEffect(() => {
    if (form.sales_order_id && Array.isArray(soItems) && loadedFor !== form.sales_order_id) {
      setItems(soItems.map((it) => toItem(it, form.source_type)))
      setLoadedFor(form.sales_order_id)
    }
  }, [soItems, form.sales_order_id, form.source_type, loadedFor])

  const { e: allErrors, lineErrors } = useMemo(() => validate(form, items), [form, items])
  const errors = submitted ? allErrors : Object.fromEntries(Object.entries(allErrors).filter(([k]) => touched[k]))
  const blur = (k) => () => setTouched((t) => ({ ...t, [k]: true }))

  const changeOrder = (id) => {
    setForm({ sales_order_id: id, purchase_order_id: '' })
    setItems([])
    setLoadedFor(null)
    blur('sales_order_id')()
  }
  const changeSource = (source) => {
    setForm({ source_type: source, purchase_order_id: '' })
    setItems((rows) => rows.map((it) => ({ ...it, fulfillment_type: source === 'inventory' ? 'INVENTORY' : 'DROPSHIP', supplier_id: source === 'inventory' ? '' : it.supplier_id, unit_cost: source === 'inventory' ? '' : it.unit_cost })))
  }
  // Picking a purchase order fills its supplier into the lines.
  const changePo = async (poId) => {
    setForm({ purchase_order_id: poId })
    if (!poId || !form.sales_order_id) return
    try {
      const res = await api.get(`/purchase-orders/${poId}`)
      const po = res.data?.success ? res.data.data : res.data
      setItems((rows) => rows.map((it) => ({ ...it, supplier_id: po?.supplier_id || it.supplier_id })))
    } catch {
      notify.error('The purchase order could not be read, so its supplier was not filled in.')
    }
  }

  const create = useResourceMutation(
    (body) => api.post(`/delivery-schedules/${form.sales_order_id}/create-hybrid`, body),
    { invalidates: [['delivery-schedules'], ['delivery-schedules-stats'], ['sales-orders'], ['purchase-orders']], silent: true }
  )

  const submit = async (ev) => {
    ev.preventDefault()
    setSubmitted(true)
    setServerError(null)
    if (Object.keys(allErrors).length || Object.keys(lineErrors).length) return
    const lines = items.filter((it) => it.item_name)
    const plan = {
      delivery_date: form.scheduled_date,
      delivery_address: order?.delivery_address,
      contact_person: order?.customer_name,
      notes: form.notes,
      items: lines.map((it) => ({
        sales_order_item_id: it.sales_order_item_id,
        item_code: it.item_code,
        item_name: it.item_name,
        ordered_quantity: parseFloat(it.quantity_to_deliver),
        unit_of_measure: it.unit_of_measure || 'units',
        fulfillment_method: it.fulfillment_type,
        supplier_id: it.fulfillment_type === 'DROPSHIP' ? it.supplier_id : null,
        unit_cost: it.fulfillment_type === 'DROPSHIP' ? parseFloat(it.unit_cost) : null,
      })),
    }
    try {
      const result = await create.mutateAsync({ deliveryPlan: plan, notes: form.notes })
      const pos = result?.created_purchase_orders || result?.auto_purchase_orders || []
      notify.success(`${result?.schedule_number || 'Delivery'} scheduled${pos.length ? `; ${pos.length} purchase order${pos.length === 1 ? '' : 's'} raised for dropship lines` : ''}`)
      navigate(result?.id ? `/sales/delivery-schedules?schedule=${result.id}` : '/sales/delivery-schedules')
    } catch (err) {
      const d = err?.response?.data || {}
      setServerError({ message: d.error || err.message, reference: d.error_id })
    }
  }

  const summaryErrors = submitted
    ? [
        ...Object.entries(allErrors).filter(([k]) => k !== 'items').map(([id, message]) => ({ id, message })),
        ...(allErrors.items ? [{ id: 'ds-lines', message: allErrors.items }] : []),
        ...Object.entries(lineErrors).flatMap(([i, le]) => Object.values(le).map((m) => ({ id: 'ds-lines', message: `Line ${Number(i) + 1}: ${m.toLowerCase()}` }))),
      ]
    : []

  return (
    <form onSubmit={submit} className="mx-auto max-w-5xl space-y-5" noValidate>
      <PageHeader title="Schedule delivery" description="Plan when a confirmed order leaves, and whether each line ships from stock or direct from a supplier." />
      {serverError && (
        <InlineNotice tone="risk" title="The delivery was not scheduled">
          {serverError.message} Nothing was lost — your entries are still here.{serverError.reference && <> Reference <span className="font-mono">{serverError.reference}</span>.</>}
        </InlineNotice>
      )}
      <ErrorSummary errors={summaryErrors} />

      <FormSection title="Order and date">
        <Field label="Sales order" required error={errors.sales_order_id} help={order ? `${order.customer_name} · deliver to ${order.delivery_address || 'the customer address on file'}` : 'Only confirmed orders can be scheduled.'} className="sm:col-span-2" id="sales_order_id">
          <Combobox
            value={form.sales_order_id}
            onChange={changeOrder}
            options={orders.map((o) => ({ value: o.id, label: o.customer_name || 'Customer', meta: o.so_number, description: o.delivery_date ? `wanted ${new Date(o.delivery_date).toLocaleDateString()}` : undefined }))}
            placeholder={soLoading ? 'Loading orders…' : 'Search by order or customer'}
            emptyText="No confirmed sales orders"
          />
        </Field>
        <Field label="Delivery date" required error={errors.scheduled_date} help={order?.delivery_date ? `The customer wants it by ${new Date(order.delivery_date).toLocaleDateString()}.` : undefined} id="scheduled_date">
          <Input type="date" value={form.scheduled_date} onChange={(e) => setForm({ scheduled_date: e.target.value })} onBlur={blur('scheduled_date')} />
        </Field>
        <Field label="Ship from" help="Sets every line; change single lines in the grid." id="source-type">
          <Select value={form.source_type} onChange={(e) => changeSource(e.target.value)}>
            <option value="inventory">Our stock</option>
            <option value="purchase_order">A supplier (dropship)</option>
          </Select>
        </Field>
        {form.source_type === 'purchase_order' && (
          <Field label="Existing purchase order" optional help="Fills its supplier into the lines." className="sm:col-span-2" id="purchase-order-optional">
            <Select value={form.purchase_order_id} onChange={(e) => changePo(e.target.value)}>
              <option value="">None — choose suppliers per line</option>
              {pos.map((po) => <option key={po.id} value={po.id}>{po.po_number} · {po.supplier_name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Notes" optional help="Delivery instructions for the driver or supplier." className="sm:col-span-2" id="notes">
          <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ notes: e.target.value })} />
        </Field>
      </FormSection>

      <section aria-labelledby="ds-lines-h" className="space-y-2" id="ds-lines" tabIndex={-1}>
        <div>
          <h2 id="ds-lines-h" className="text-sm font-semibold text-fg">Lines</h2>
          <p className="text-xs text-ink-500">Dropship lines need a supplier and a unit cost; a purchase order is raised for each supplier.</p>
        </div>
        {submitted && allErrors.items && <p className="text-xs text-risk-600" role="alert">{allErrors.items}</p>}
        {!form.sales_order_id ? (
          <p className="rounded-lg border border-dashed border-ink-300 px-4 py-6 text-center text-sm text-ink-600">Choose a sales order to load its lines.</p>
        ) : itemsLoading && !items.length ? (
          <p className="rounded-lg border border-ink-200 px-4 py-6 text-center text-sm text-ink-500">Loading the order's lines…</p>
        ) : (
          <LineItemEditor
            label="Delivery lines"
            rows={items}
            onChange={setItems}
            newRow={() => ({ _key: `${Math.random()}`, item_name: '', fulfillment_type: 'INVENTORY', quantity_to_deliver: '', supplier_id: '', unit_cost: '' })}
            errors={submitted ? lineErrors : {}}
            currency={order?.currency || 'USD'}
            transform={(row, key, val) => (key === 'fulfillment_type' && val === 'INVENTORY' ? { ...row, supplier_id: '', unit_cost: '' } : row)}
            columns={[
              { key: 'item_name', header: 'Item', type: 'readonly', minWidth: 200 },
              { key: 'ordered', header: 'Ordered', type: 'readonly', width: 90, align: 'right' },
              { key: 'quantity_to_deliver', header: 'Deliver', type: 'number', width: 90, required: true },
              { key: 'unit_of_measure', header: 'Unit', type: 'readonly', width: 70 },
              { key: 'fulfillment_type', header: 'Ship from', type: 'select', width: 130, options: [{ value: 'INVENTORY', label: 'Stock' }, { value: 'DROPSHIP', label: 'Dropship' }] },
              { key: 'supplier_id', header: 'Supplier', type: 'select', width: 190, placeholder: '—', options: suppliers.map((s) => ({ value: s.id, label: supplierName(s) })) },
              { key: 'unit_cost', header: 'Unit cost', type: 'money', width: 110 },
            ]}
          />
        )}
      </section>

      <div className="sticky bottom-0 z-10 -mx-4 border-t border-ink-200 bg-canvas/95 px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Button variant="ghost" onClick={() => navigate('/sales/delivery-schedules')} disabled={create.isPending}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={create.isPending}>Schedule delivery</Button>
        </div>
      </div>
    </form>
  )
}

function PlanningView() {
  const [tab, setTab] = useState('waiting')
  const [openId, setOpenId] = useState(null)
  const [confirm, setConfirm] = useState(null) // { kind: 'deliver' | 'approve', row }

  const { data: dsData, loading, error, refetch } = useResource(keys.deliverySchedules(), ({ signal }) => api.get('/delivery-schedules', { signal }))
  const { data: soData, loading: soLoading } = useResource(keys.salesOrders(CONFIRMED), ({ signal }) => api.get('/sales-orders', { params: CONFIRMED, signal }))
  const { data: poData, loading: poLoading } = useResource(keys.purchaseOrders(SALES_SOURCED), ({ signal }) => api.get('/purchase-orders', { params: SALES_SOURCED, signal }))
  const schedules = useMemo(() => list(dsData), [dsData])
  const orders = useMemo(() => list(soData), [soData])
  const pos = useMemo(() => list(poData).filter(isSalesPo), [poData])
  const scheduledOrderIds = useMemo(() => new Set(schedules.filter((s) => s.status !== 'CANCELLED').map((s) => s.sales_order_id)), [schedules])
  const waiting = useMemo(() => orders.filter((o) => !scheduledOrderIds.has(o.id)), [orders, scheduledOrderIds])
  const upcoming = useMemo(() => schedules.filter((s) => ['SCHEDULED', 'READY_TO_SHIP', 'IN_TRANSIT'].includes(s.status)), [schedules])
  const overdue = upcoming.filter((s) => s.delivery_date && daysFrom(s.delivery_date) < 0)
  const autoPos = pos.filter((p) => p.source_type === 'delivery_schedule')

  const invalidates = [['delivery-schedules'], ['delivery-schedules-stats'], ['sales-orders']]
  const deliver = useResourceMutation((id) => api.put(`/delivery-schedules/${id}/status`, { status: 'DELIVERED' }), { invalidates, silent: true })
  const approve = useResourceMutation((id) => api.post(`/purchase-orders/${id}/approve`, { approval_notes: 'Approved from delivery scheduling' }), { invalidates: [['purchase-orders']], silent: true })

  const run = async () => {
    const { kind, row } = confirm
    const name = kind === 'deliver' ? row.schedule_number : row.po_number
    try {
      if (kind === 'deliver') await deliver.mutateAsync(row.id)
      else await approve.mutateAsync(row.id)
      notify.success(`${name} ${kind === 'deliver' ? 'marked delivered' : 'approved'}`)
    } catch (e) {
      const d = e?.response?.data || {}
      notify.error(`${name}: ${d.error || e.message}`)
    }
    setConfirm(null)
  }

  const waitingCols = [
    { id: 'so', header: 'Sales order', accessor: 'so_number', width: 150, mobile: 'title', cell: (o) => <Code>{o.so_number}</Code> },
    { id: 'customer', header: 'Customer', accessor: 'customer_name', minWidth: 180, mobile: 'subtitle' },
    { id: 'wanted', header: 'Wanted by', accessor: 'delivery_date', width: 150, cell: (o) => <span className="flex items-center gap-1.5"><DateText value={o.delivery_date} />{o.delivery_date && daysFrom(o.delivery_date) < 0 && <span className="font-mono text-2xs text-risk-600">▲ {Math.abs(daysFrom(o.delivery_date))}d late</span>}</span> },
    { id: 'lines', header: 'Lines', accessor: (o) => Number(o.item_count) || 0, align: 'right', width: 70 },
    { id: 'total', header: 'Total', accessor: (o) => Number(o.total_amount), align: 'right', width: 130, mobile: 'trailing', cell: (o) => <Money amount={o.total_amount} currency={o.currency} /> },
  ]
  const scheduleCols = [
    { id: 'no', header: 'Schedule', accessor: 'schedule_number', width: 150, mobile: 'title', cell: (d) => <Code>{d.schedule_number}</Code> },
    { id: 'so', header: 'Sales order', accessor: (d) => d.sales_order_number || d.so_number, width: 150, cell: (d) => <Code className="text-ink-600">{d.sales_order_number || d.so_number || '—'}</Code> },
    { id: 'customer', header: 'Customer', accessor: 'customer_name', minWidth: 170, mobile: 'subtitle' },
    { id: 'date', header: 'Delivery', accessor: 'delivery_date', width: 150, cell: (d) => <span className="flex items-center gap-1.5"><DateText value={d.delivery_date} />{d.delivery_date && daysFrom(d.delivery_date) < 0 && <span className="font-mono text-2xs text-risk-600">▲ {Math.abs(daysFrom(d.delivery_date))}d late</span>}</span> },
    { id: 'how', header: 'Fulfilment', accessor: (d) => humanize(d.fulfillment_type), width: 120 },
    { id: 'status', header: 'Status', accessor: 'status', width: 140, mobile: 'meta', cell: (d) => <StatusBadge status={d.status} /> },
  ]
  const poCols = [
    { id: 'po', header: 'Purchase order', accessor: 'po_number', width: 150, mobile: 'title', cell: (p) => <Code>{p.po_number}</Code> },
    { id: 'supplier', header: 'Supplier', accessor: 'supplier_name', minWidth: 180, mobile: 'subtitle' },
    { id: 'source', header: 'Raised from', accessor: (p) => (p.source_type === 'delivery_schedule' ? 'Delivery schedule' : humanize(p.source_type) || 'Manual'), width: 170 },
    { id: 'status', header: 'Status', accessor: 'status', width: 170, mobile: 'meta', cell: (p) => <StatusBadge status={p.status} /> },
    { id: 'total', header: 'Total', accessor: (p) => Number(p.total_amount), align: 'right', width: 130, mobile: 'trailing', cell: (p) => <Money amount={p.total_amount} currency={p.currency} /> },
  ]

  return (
    <>
      <PageHeader
        title="Delivery scheduling"
        description="Confirmed orders that still need a delivery, what ships next, and purchase orders raised for dropship lines."
        secondary={<Button to="/sales/delivery-schedules">All schedules</Button>}
        primary={<Button variant="primary" icon={PlusIcon} to="/sales/delivery-schedules/create" kbd="N">Schedule delivery</Button>}
      />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Waiting for a schedule" value={<Num value={waiting.length} />} loading={soLoading || loading} reason="Confirmed orders with nothing scheduled." onClick={() => setTab('waiting')} />
        <Stat label="Shipping next" value={<Num value={upcoming.length} />} loading={loading} reason="Scheduled, ready or in transit." onClick={() => setTab('upcoming')} />
        <Stat label="Overdue" value={<Num value={overdue.length} />} loading={loading} reason="Past their date and not delivered." onClick={() => setTab('upcoming')} />
        <Stat label="Purchase orders from deliveries" value={<Num value={autoPos.length} />} loading={poLoading} reason={`${pos.length} purchase orders linked to sales in total.`} onClick={() => setTab('pos')} />
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        label="Planning lists"
        tabs={[{ id: 'waiting', label: 'Waiting for a schedule', count: waiting.length }, { id: 'upcoming', label: 'Shipping next', count: upcoming.length }, { id: 'pos', label: 'Purchase orders', count: pos.length }]}
      >
        {(t) => (
          <div className="pt-4">
            {t === 'waiting' && (
              <DataTable
                viewKey="sales.scheduling.waiting"
                caption="Confirmed orders waiting for a delivery schedule"
                noun="order"
                rows={waiting}
                columns={waitingCols}
                loading={soLoading || loading}
                rowHref={(o) => `/sales/sales-orders/${o.id}`}
                defaultSort={{ id: 'wanted', dir: 'asc' }}
                rowActions={(o) => (
                  <>
                    <RowAction icon={TruckIcon} label={`Schedule delivery for ${o.so_number}`} to={`/sales/delivery-schedules/create?sales_order_id=${o.id}`} />
                    <RowAction icon={EyeIcon} label={`Open ${o.so_number}`} to={`/sales/sales-orders/${o.id}`} />
                  </>
                )}
                empty={{ icon: TruckIcon, title: 'Every confirmed order has a delivery', description: 'Orders appear here once they are confirmed and nothing has been scheduled for them.' }}
              />
            )}
            {t === 'upcoming' && (
              <DataTable
                viewKey="sales.scheduling.upcoming"
                caption="Deliveries shipping next"
                noun="delivery"
                rows={upcoming}
                columns={scheduleCols}
                loading={loading}
                error={error}
                onRetry={refetch}
                onRowClick={(d) => setOpenId(d.id)}
                defaultSort={{ id: 'date', dir: 'asc' }}
                rowActions={(d) => (
                  <>
                    <RowAction icon={EyeIcon} label={`Open ${d.schedule_number}`} onClick={() => setOpenId(d.id)} />
                    {d.status === 'SCHEDULED' && <RowAction icon={CheckCircleIcon} label={`Mark ${d.schedule_number} delivered`} onClick={() => setConfirm({ kind: 'deliver', row: d })} />}
                  </>
                )}
                empty={{ icon: TruckIcon, title: 'Nothing is shipping', description: 'Scheduled deliveries appear here until they are delivered.', action: <Button variant="primary" icon={PlusIcon} to="/sales/delivery-schedules/create">Schedule delivery</Button> }}
              />
            )}
            {t === 'pos' && (
              <DataTable
                viewKey="sales.scheduling.pos"
                caption="Purchase orders linked to sales"
                noun="purchase order"
                rows={pos}
                columns={poCols}
                loading={poLoading}
                rowHref={(p) => `/procurement/purchase-orders/${p.id}`}
                defaultSort={{ id: 'po', dir: 'desc' }}
                rowActions={(p) => (
                  <>
                    <RowAction icon={ArrowTopRightOnSquareIcon} label={`Open ${p.po_number}`} to={`/procurement/purchase-orders/${p.id}`} />
                    {p.status === 'DRAFT' && <RowAction icon={CheckCircleIcon} label={`Approve ${p.po_number}`} onClick={() => setConfirm({ kind: 'approve', row: p })} />}
                  </>
                )}
                empty={{ title: 'No purchase orders linked to sales', description: 'Dropship lines on a delivery raise purchase orders here automatically.' }}
              />
            )}
          </div>
        )}
      </Tabs>

      {openId && <ScheduleSheet id={openId} onClose={() => setOpenId(null)} />}
      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={run}
          title={confirm.kind === 'deliver' ? `Mark ${confirm.row.schedule_number} delivered?` : `Approve ${confirm.row.po_number}?`}
          consequence={confirm.kind === 'deliver'
            ? 'Delivered quantities are booked against the sales order. Once every shipment is in, the customer is asked to confirm receipt.'
            : `This commits spend with ${confirm.row.supplier_name || 'the supplier'}. It can then be sent to the supplier.`}
          reversible={false}
          confirmLabel={confirm.kind === 'deliver' ? 'Mark delivered' : 'Approve'}
          tone="primary"
          busy={deliver.isPending || approve.isPending}
        />
      )}
    </>
  )
}

export default function DeliveryScheduling() {
  const { pathname } = useLocation()
  return pathname.endsWith('/create') ? <ScheduleDeliveryForm /> : <PlanningView />
}
