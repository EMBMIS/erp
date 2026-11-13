import { useMemo, useState } from 'react'
import { PlusIcon, EyeIcon, PencilSquareIcon, TrashIcon, ShoppingCartIcon, ArrowDownTrayIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useAuth } from '../../contexts/AuthContext'
import { getSalesOrderStatusLabel, isTerminal, isEditable } from '../../constants/salesOrderStatus'
import {
  PageHeader, Button, DataTable, RowAction, StatusBadge, Badge, Money, Code, DateText, ConfirmDialog, Segmented,
  InlineNotice, exportCsv, daysFrom, notify,
} from '../../components/ui'

/**
 * Sales orders — every order you raised, as one working list.
 *
 * Orders are scoped to the person who raised them on the server, so the list
 * says so. Loaded in one request (up to LIMIT) so sorting, filtering and saved
 * views work across the whole set. "Open" replaces the old hide-completed toggle.
 */
const LIMIT = 1000
const DELIVERED = new Set(['DELIVERED', 'WAITING_CUSTOMER_DELIVERY_CONFIRMATION', 'COMPLETED'])
const isLate = (o) => o.delivery_date && !isTerminal(o.status) && !DELIVERED.has(o.status) && daysFrom(o.delivery_date) < 0
const PRIORITY_TONE = { URGENT: 'risk', HIGH: 'warn', NORMAL: 'ink', LOW: 'ink' }
const humanize = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())

const QUICK = {
  open: { label: 'Open', test: (o) => !isTerminal(o.status) },
  drafts: { label: 'Drafts', test: (o) => o.status === 'DRAFT' },
  waiting: { label: 'Waiting approval', test: (o) => o.status === 'PENDING_APPROVAL' },
  late: { label: 'Late', test: isLate },
  done: { label: 'Completed', test: (o) => o.status === 'COMPLETED' },
  all: { label: 'All', test: () => true },
}

export default function SalesOrdersList() {
  const { user } = useAuth()
  const canDelete = ['MANAGER', 'ADMIN'].includes(user?.role)
  const [quick, setQuick] = useState('open')
  const [confirm, setConfirm] = useState(null)

  const params = { limit: LIMIT, offset: 0 }
  const { data, loading, error, refetch } = useResource(keys.salesOrders(params), ({ signal }) => api.get('/sales-orders', { params, signal }))
  const orders = useMemo(() => (Array.isArray(data) ? data : data?.data || []), [data])

  const remove = useResourceMutation((id) => api.delete(`/sales-orders/${id}`), { invalidates: [['sales-orders']], silent: true })
  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, orders.filter(q.test).length])), [orders])

  const columns = useMemo(() => [
    { id: 'so', header: 'Order', accessor: 'so_number', cell: (o) => <Code>{o.so_number}</Code>, width: 150, mobile: 'title' },
    {
      id: 'customer', header: 'Customer', accessor: 'customer_name', filter: 'text', minWidth: 170, maxWidth: 240, mobile: 'subtitle',
      cell: (o) => (
        <span className="block min-w-0">
          <span className="block truncate">{o.customer_name || '—'}</span>
          {o.reference_number && <span className="block truncate font-mono text-2xs text-ink-500">{o.reference_number}</span>}
        </span>
      ),
    },
    { id: 'status', header: 'Status', accessor: (o) => getSalesOrderStatusLabel(o.status), filter: 'select', cell: (o) => <StatusBadge status={o.status} label={getSalesOrderStatusLabel(o.status)} />, mobile: 'meta', width: 150 },
    { id: 'priority', header: 'Priority', accessor: 'priority', filter: 'select', width: 90, cell: (o) => (PRIORITY_TONE[o.priority] && PRIORITY_TONE[o.priority] !== 'ink' ? <Badge tone={PRIORITY_TONE[o.priority]}>{humanize(o.priority)}</Badge> : <span className="text-ink-600">{o.priority ? humanize(o.priority) : '—'}</span>) },
    {
      id: 'delivery', header: 'Delivery', accessor: 'delivery_date', width: 150,
      cell: (o) => (
        <span className="flex items-center gap-1.5">
          <DateText value={o.delivery_date} />
          {isLate(o) && <span className="font-mono text-2xs text-risk-600" title="Delivery date has passed">▲ {Math.abs(daysFrom(o.delivery_date))}d late</span>}
        </span>
      ),
    },
    { id: 'lines', header: 'Lines', accessor: (o) => Number(o.item_count) || 0, align: 'right', width: 64, defaultHidden: true },
    {
      id: 'total', header: 'Total', accessor: (o) => Number(o.total_amount), align: 'right', filter: 'number', width: 140, mobile: 'trailing',
      cell: (o) => <Money amount={o.total_amount} currency={o.currency} />,
      footer: (rows) => {
        const currencies = [...new Set(rows.map((r) => r.currency || 'USD'))]
        if (currencies.length !== 1) return <span className="text-xs font-normal text-ink-500">Mixed currencies</span>
        return <Money amount={rows.reduce((s, r) => s + (Number(r.total_amount) || 0), 0)} currency={currencies[0]} />
      },
      exportValue: (o) => o.total_amount,
    },
    { id: 'ordered', header: 'Ordered', accessor: 'order_date', cell: (o) => <DateText value={o.order_date} />, width: 110 },
    { id: 'currency', header: 'Currency', accessor: 'currency', width: 90, defaultHidden: true, filter: 'select' },
    { id: 'createdBy', header: 'Raised by', accessor: 'created_by_name', width: 140, defaultHidden: true },
  ], [])

  const runDelete = async () => {
    const o = confirm
    try {
      await remove.mutateAsync(o.id)
      notify.success(`${o.so_number} deleted`)
    } catch (e) {
      const d = e?.response?.data || {}
      notify.error(`${o.so_number} was not deleted: ${d.error || e.message}`)
    }
    setConfirm(null)
  }

  return (
    <>
      <PageHeader
        title="Sales orders"
        description="Orders you raised for customers — from draft, through delivery, to invoice."
        secondary={<Button icon={ArrowDownTrayIcon} onClick={() => exportCsv(orders.filter(QUICK[quick].test), columns, 'sales-orders.csv')} disabled={!orders.length}>Export</Button>}
        primary={<Button variant="primary" icon={PlusIcon} to="/sales/sales-orders/create" kbd="N">New sales order</Button>}
      />

      {orders.length >= LIMIT && (
        <InlineNotice tone="warn" className="mb-3" title={`Showing the first ${LIMIT.toLocaleString()} sales orders`}>
          Use search or a quick view to narrow the list. Older orders are still in the system.
        </InlineNotice>
      )}

      <DataTable
        viewKey="sales.orders"
        caption="Sales orders"
        noun="sales order"
        rows={orders}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        rowHref={(o) => `/sales/sales-orders/${o.id}`}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'ordered', dir: 'desc' }}
        searchPlaceholder="Search order, customer, reference"
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
            <RowAction icon={EyeIcon} label={`Open ${o.so_number}`} to={`/sales/sales-orders/${o.id}`} />
            {isEditable(o.status) && <RowAction icon={PencilSquareIcon} label={`Edit ${o.so_number}`} to={`/sales/sales-orders/${o.id}/edit`} />}
            {isEditable(o.status) && <RowAction icon={TrashIcon} tone="risk" label={`Delete ${o.so_number}`} onClick={() => setConfirm(o)} disabled={!canDelete} reason={canDelete ? undefined : 'Only managers and admins can delete sales orders.'} />}
          </>
        )}
        empty={{
          icon: ShoppingCartIcon,
          title: quick === 'open' && orders.length ? 'No open orders' : 'No sales orders yet',
          description: quick === 'open' && orders.length ? 'Every order you raised is completed, cancelled or rejected. Choose All to see them.' : 'A sales order commits stock or production to a customer. Raise one directly, or convert an accepted quotation.',
          action: <Button variant="primary" icon={PlusIcon} to="/sales/sales-orders/create">New sales order</Button>,
        }}
      />

      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={runDelete}
          title={`Delete ${confirm.so_number}?`}
          consequence="The order and its lines disappear from every list. Delivery schedules already raised against it are not cancelled. There is no undo in the app."
          reversible={false}
          confirmLabel={`Delete ${confirm.so_number}`}
          confirmText={confirm.so_number}
          tone="danger"
          busy={remove.isPending}
        />
      )}
    </>
  )
}
