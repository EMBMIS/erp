import { useMemo, useState } from 'react'
import { EyeIcon, TruckIcon, CheckCircleIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, DataTable, RowAction, StatusBadge, Money, Code, DateText, ConfirmDialog, Segmented, Field, Textarea,
  notify,
} from '../../components/ui'

/**
 * Customer deliveries — purchase orders that ship to a customer, and the two
 * handover steps the sales side owns: delivered to the customer, and the
 * customer confirming receipt.
 *
 * `CustomerDeliveriesTable` is shared with the "Customer deliveries" tab of
 * the delivery schedules list. The page below is the stand-alone view over
 * /purchase-orders/delivery-tracking (managers and admins).
 */
const STATUS_LABEL = {
  SENT_TO_SUPPLIER: 'Sent to supplier',
  CONFIRMED: 'Supplier confirmed',
  PREPARING_DELIVERY: 'Preparing',
  IN_TRANSIT: 'In transit',
  DELIVERED: 'Delivered to warehouse',
  GOODS_READY_FOR_RECEIPT: 'Ready for receipt',
  READY_FOR_CUSTOMER_DELIVERY: 'Ready for customer',
  DELIVERED_TO_CUSTOMER: 'Delivered to customer',
  CUSTOMER_CONFIRMED: 'Customer confirmed',
  DELIVERY_REJECTED: 'Delivery rejected',
}
const label = (s) => STATUS_LABEL[s] || String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())

const SALES = ['READY_FOR_CUSTOMER_DELIVERY', 'DELIVERED_TO_CUSTOMER', 'CUSTOMER_CONFIRMED']

const QUICK = {
  all: { label: 'All', test: () => true },
  ready: { label: 'Ready for customer', test: (o) => o.status === 'READY_FOR_CUSTOMER_DELIVERY' },
  delivered: { label: 'Awaiting confirmation', test: (o) => o.status === 'DELIVERED_TO_CUSTOMER' },
  confirmed: { label: 'Confirmed', test: (o) => o.status === 'CUSTOMER_CONFIRMED' },
}

export function CustomerDeliveriesTable({ orders, loading, error, onRetry, viewKey = 'sales.customer-deliveries', invalidates = [['purchase-orders'], ['delivery-tracking']] }) {
  const [quick, setQuick] = useState('all')
  const [handover, setHandover] = useState(null) // { order, status }
  const [notes, setNotes] = useState('')
  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, orders.filter(q.test).length])), [orders])

  const mutate = useResourceMutation(({ id, status, notes: n }) => api.post(`/purchase-orders/${id}/customer-handover`, { status, notes: n }), { invalidates, silent: true })

  const open = (order, status) => { setNotes(''); setHandover({ order, status }) }
  const run = async () => {
    const { order, status } = handover
    try {
      await mutate.mutateAsync({ id: order.id, status, notes })
      notify.success(status === 'DELIVERED_TO_CUSTOMER' ? `${order.po_number} delivered to ${order.customer_name || 'the customer'}` : `${order.po_number} confirmed as received`)
      setHandover(null)
    } catch (e) {
      const d = e?.response?.data || {}
      notify.error(`${order.po_number} was not updated: ${d.error || e.message}`)
      setHandover(null)
    }
  }

  const columns = useMemo(() => [
    { id: 'po', header: 'Purchase order', accessor: 'po_number', width: 150, mobile: 'title', cell: (o) => <Code>{o.po_number}</Code> },
    { id: 'customer', header: 'Customer', accessor: (o) => o.customer_name || '', filter: 'text', minWidth: 160, mobile: 'subtitle', cell: (o) => o.customer_name || '—' },
    {
      id: 'supplier', header: 'Supplier', accessor: 'supplier_name', filter: 'text', minWidth: 160,
      cell: (o) => (
        <span className="block min-w-0">
          <span className="block truncate">{o.supplier_name || '—'}</span>
          {o.supplier_code && <span className="block truncate font-mono text-2xs text-ink-500">{o.supplier_code}</span>}
        </span>
      ),
    },
    { id: 'status', header: 'Status', accessor: (o) => label(o.status), filter: 'select', width: 190, mobile: 'meta', cell: (o) => <StatusBadge status={o.status} label={label(o.status)} /> },
    { id: 'due', header: 'Due', accessor: 'delivery_date', width: 120, cell: (o) => <DateText value={o.delivery_date} /> },
    { id: 'supplierDelivered', header: 'Supplier delivered', accessor: 'delivery_confirmed_at', width: 150, defaultHidden: true, cell: (o) => <DateText value={o.delivery_confirmed_at} /> },
    { id: 'total', header: 'Amount', accessor: (o) => Number(o.total_amount), align: 'right', width: 130, mobile: 'trailing', cell: (o) => <Money amount={o.total_amount} currency={o.currency} /> },
  ], [])

  return (
    <>
      <DataTable
        viewKey={viewKey}
        caption="Customer deliveries"
        noun="delivery"
        rows={orders}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={onRetry}
        rowHref={(o) => `/procurement/purchase-orders/${o.id}`}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'due', dir: 'asc' }}
        searchPlaceholder="Search order, customer, supplier"
        toolbarStart={
          <Segmented
            label="Show"
            value={quick}
            onChange={setQuick}
            options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))}
            className="max-w-full overflow-x-auto"
          />
        }
        rowActions={(o) => (
          <>
            <RowAction icon={EyeIcon} label={`Open ${o.po_number}`} to={`/procurement/purchase-orders/${o.id}`} />
            {o.status === 'READY_FOR_CUSTOMER_DELIVERY' && <RowAction icon={TruckIcon} label={`Mark ${o.po_number} delivered to the customer`} onClick={() => open(o, 'DELIVERED_TO_CUSTOMER')} />}
            {o.status === 'DELIVERED_TO_CUSTOMER' && <RowAction icon={CheckCircleIcon} label={`Confirm the customer received ${o.po_number}`} onClick={() => open(o, 'CUSTOMER_CONFIRMED')} />}
          </>
        )}
        empty={{
          icon: TruckIcon,
          title: 'No customer deliveries',
          description: 'Purchase orders raised to fulfil a sales order appear here once the supplier is shipping.',
        }}
      />

      {handover && (
        <ConfirmDialog
          open
          onClose={() => setHandover(null)}
          onConfirm={run}
          title={handover.status === 'DELIVERED_TO_CUSTOMER' ? `Mark ${handover.order.po_number} delivered?` : `Confirm ${handover.order.po_number} was received?`}
          consequence={handover.status === 'DELIVERED_TO_CUSTOMER'
            ? `Records that the goods were handed to ${handover.order.customer_name || 'the customer'}${handover.order.delivery_address ? ` at ${handover.order.delivery_address.replace(/\n/g, ', ')}` : ''}. The customer then confirms receipt.`
            : `Records that ${handover.order.customer_name || 'the customer'} confirmed receipt. This completes the order.`}
          reversible={false}
          confirmLabel={handover.status === 'DELIVERED_TO_CUSTOMER' ? 'Mark delivered' : 'Confirm receipt'}
          tone="primary"
          busy={mutate.isPending}
        >
          <Field label="Handover notes" optional help="Who received it, condition, anything the customer said.">
            <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </ConfirmDialog>
      )}
    </>
  )
}

export default function SalesDeliveryTracking() {
  const params = { sales_delivery: 'true' }
  const { data, loading, error, refetch } = useResource(keys.deliveryTracking(params), ({ signal }) => api.get('/purchase-orders/delivery-tracking', { params, signal }))
  const orders = useMemo(() => (Array.isArray(data) ? data : []).filter((po) =>
    SALES.includes(po.status) || po.source_type?.includes('sales_order') || po.source_type?.includes('contract_sales') || po.sales_order_id
  ), [data])

  return (
    <>
      <PageHeader title="Customer deliveries" description="Supplier orders shipping to your customers, and their handover." />
      <CustomerDeliveriesTable orders={orders} loading={loading} error={error} onRetry={refetch} />
    </>
  )
}
