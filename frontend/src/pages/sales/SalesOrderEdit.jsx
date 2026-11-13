import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useRecordTitle } from '../../components/shell/ShellContext'
import { isEditable, isInvoiced, getSalesOrderStatusLabel } from '../../constants/salesOrderStatus'
import { PageHeader, Button, StatusBadge, Code, SkeletonDetail, ErrorState, InlineNotice, notify } from '../../components/ui'
import { SalesOrderForm } from './SalesOrderCreate'

/**
 * Edit a sales order — the New sales order form, filled from the record.
 * Orders that have moved stock or been invoiced cannot be edited; the page
 * says why instead of showing a form that the server would refuse.
 */
const day = (v) => (v ? String(v).split('T')[0] : '')
const str = (v) => (v == null ? '' : String(Number(v)))

export default function SalesOrderEdit() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data: order, loading, error, refetch } = useResource(keys.salesOrder(id), ({ signal }) => api.get(`/sales-orders/${id}`, { signal }), { enabled: Boolean(id) })
  const [state, setState] = useState(null) // { form, lines }
  const [serverError, setServerError] = useState(null)
  useRecordTitle(order?.so_number, { subtitle: order?.customer_name })

  // Fill the form once, from the first copy of the order that arrives.
  useEffect(() => {
    if (!order || state) return
    const form = Object.fromEntries(Object.keys(SalesOrderForm.EMPTY).map((k) => [k, order[k] ?? SalesOrderForm.EMPTY[k]]))
    form.order_date = day(order.order_date)
    form.delivery_date = day(order.delivery_date)
    const lines = (order.items || []).map((it) => ({
      ...it,
      _key: it.id || `${Math.random()}`,
      inventory_item_id: it.inventory_item_id || '',
      item_description: it.item_description || '',
      quantity: str(it.quantity),
      unit_price: str(it.unit_price),
      discount_amount: Number(it.discount_amount) ? str(it.discount_amount) : '',
      requested_delivery_date: day(it.requested_delivery_date),
    }))
    setState({ form, lines: lines.length ? lines : [SalesOrderForm.blankLine()] })
  }, [order, state])

  const setForm = (patch) => setState((s) => ({ ...s, form: { ...s.form, ...patch } }))
  const setLines = (next) => setState((s) => ({ ...s, lines: typeof next === 'function' ? next(s.lines) : next }))
  const update = useResourceMutation((payload) => api.put(`/sales-orders/${id}`, payload), { invalidates: [['sales-orders'], keys.salesOrder(id)], silent: true })

  const save = async (payload) => {
    setServerError(null)
    try {
      await update.mutateAsync(payload)
      notify.success(`${order.so_number} saved`)
      navigate(`/sales/sales-orders/${id}`)
    } catch (err) {
      const d = err?.response?.data || {}
      setServerError({ message: d.error || err.message, reference: d.error_id })
    }
  }

  if (loading || (order && !state && isEditable(order.status))) return <SkeletonDetail />
  if (error || !order) {
    return <ErrorState what="Sales order" error={error || { response: { status: 404, data: { error: 'No sales order with this id is visible to you.' } } }} onRetry={refetch} />
  }

  const header = (
    <PageHeader
      title={<>Edit <Code className="text-[1em]">{order.so_number}</Code></>}
      status={<StatusBadge status={order.status} label={getSalesOrderStatusLabel(order.status)} />}
      meta={<span>{order.customer_name}</span>}
    />
  )

  if (!isEditable(order.status)) {
    return (
      <div className="mx-auto max-w-5xl space-y-5">
        {header}
        <InlineNotice tone="warn" title="This order can no longer be edited" action={<Button size="sm" to={`/sales/sales-orders/${id}`}>Back to the order</Button>}>
          It is {getSalesOrderStatusLabel(order.status).toLowerCase()}.
          {isInvoiced(order.status) ? ' It has been invoiced and posted to the general ledger.' : ' Stock has already moved against it, or it is closed.'}
        </InlineNotice>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      {header}
      <SalesOrderForm
        form={state.form}
        setForm={setForm}
        lines={state.lines}
        setLines={setLines}
        onSubmit={save}
        saving={update.isPending}
        serverError={serverError}
        mode="edit"
        cancelTo={`/sales/sales-orders/${id}`}
        submitLabel="Save changes"
      />
    </div>
  )
}
