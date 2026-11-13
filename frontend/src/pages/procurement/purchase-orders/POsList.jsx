import { useMemo, useState } from 'react'
import { PlusIcon, EyeIcon, PaperAirplaneIcon, CheckCircleIcon, TrashIcon, DocumentTextIcon, ArrowDownTrayIcon } from '@heroicons/react/20/solid'
import api from '../../../services/api'
import { useResource, useResourceMutation } from '../../../hooks/useResource'
import { keys } from '../../../services/queryKeys'
import {
  PageHeader, Button, DataTable, RowAction, BulkAction, StatusBadge, Money, Code, DateText, ConfirmDialog,
  Segmented, InlineNotice, exportCsv, daysFrom, notify,
} from '../../../components/ui'

/**
 * Purchase orders — every PO the user can see, as one working list.
 *
 * Loaded in one request (up to LIMIT) so sorting, filtering and saved views
 * work across the whole set rather than one server page at a time. When the
 * cap is reached the page says so instead of silently showing a partial list.
 */
const LIMIT = 1000
const DONE = new Set(['FULLY_RECEIVED', 'CUSTOMER_CONFIRMED', 'DELIVERED_TO_CUSTOMER', 'CANCELLED', 'CLOSED', 'REJECTED'])
const OPEN = new Set(['APPROVED', 'SENT_TO_SUPPLIER', 'CONFIRMED', 'PREPARING_DELIVERY', 'IN_TRANSIT', 'DELIVERED', 'GOODS_READY_FOR_RECEIPT', 'PARTIALLY_RECEIVED', 'READY_FOR_CUSTOMER_DELIVERY'])

const isLate = (po) => po.delivery_date && !DONE.has(po.status) && po.status !== 'DRAFT' && daysFrom(po.delivery_date) < 0

const QUICK = {
  all: { label: 'All', test: () => true },
  drafts: { label: 'Drafts', test: (po) => po.status === 'DRAFT' },
  waiting: { label: 'Waiting approval', test: (po) => po.status === 'PENDING_APPROVAL' },
  open: { label: 'Open', test: (po) => OPEN.has(po.status) },
  late: { label: 'Late', test: isLate },
}

export default function POsList() {
  const [quick, setQuick] = useState('all')
  const [confirm, setConfirm] = useState(null) // { kind, pos }

  const params = { limit: LIMIT, offset: 0 }
  const { data, loading, error, refetch } = useResource(keys.purchaseOrders(params), ({ signal }) => api.get('/purchase-orders', { params, signal }))
  const pos = useMemo(() => (Array.isArray(data) ? data : []), [data])

  const invalidates = [['purchase-orders']]
  const submit = useResourceMutation((id) => api.post(`/purchase-orders/${id}/submit-for-approval`), { invalidates, silent: true })
  const send = useResourceMutation((id) => api.post(`/purchase-orders/${id}/send-to-supplier`), { invalidates, silent: true })
  const remove = useResourceMutation((id) => api.delete(`/purchase-orders/${id}`), { invalidates, silent: true })

  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, pos.filter(q.test).length])), [pos])

  const columns = useMemo(() => [
    { id: 'po', header: 'PO', accessor: 'po_number', cell: (po) => <Code>{po.po_number}</Code>, width: 150, mobile: 'title' },
    {
      id: 'supplier', header: 'Supplier', accessor: (po) => po.supplier_name, filter: 'text', mobile: 'subtitle', minWidth: 180, maxWidth: 280,
      cell: (po) => (
        <span className="block min-w-0">
          <span className="block truncate">{po.supplier_name || '—'}</span>
          {po.supplier_code && <span className="block truncate font-mono text-2xs text-ink-500">{po.supplier_code}</span>}
        </span>
      ),
    },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', cell: (po) => <StatusBadge status={po.status} />, mobile: 'meta', width: 190 },
    {
      id: 'delivery', header: 'Delivery', accessor: 'delivery_date', width: 150,
      cell: (po) => (
        <span className="flex items-center gap-1.5">
          <DateText value={po.delivery_date} />
          {isLate(po) && <span className="font-mono text-2xs text-risk-600" title="Delivery date has passed">▲ {Math.abs(daysFrom(po.delivery_date))}d late</span>}
        </span>
      ),
    },
    { id: 'lines', header: 'Lines', accessor: (po) => Number(po.line_item_count) || 0, align: 'right', width: 80 },
    {
      id: 'total', header: 'Total', accessor: (po) => Number(po.total_amount), align: 'right', filter: 'number', width: 140, mobile: 'trailing',
      cell: (po) => <Money amount={po.total_amount} currency={po.currency} />,
      footer: (rows) => {
        const currencies = [...new Set(rows.map((r) => r.currency || 'USD'))]
        if (currencies.length !== 1) return <span className="text-xs font-normal text-ink-500">Mixed currencies</span>
        return <Money amount={rows.reduce((s, r) => s + (Number(r.total_amount) || 0), 0)} currency={currencies[0]} />
      },
      exportValue: (po) => po.total_amount,
    },
    { id: 'currency', header: 'Currency', accessor: 'currency', width: 90, defaultHidden: true, filter: 'select' },
    { id: 'source', header: 'Source', accessor: (po) => po.pr_number || po.rfq_number || po.contract_number || po.source_type, defaultHidden: true, cell: (po) => <Code className="text-ink-600">{po.pr_number || po.rfq_number || po.contract_number || (po.source_type || '').toLowerCase()}</Code> },
    { id: 'createdBy', header: 'Raised by', accessor: 'created_by_name', filter: 'text', width: 140 },
    { id: 'created', header: 'Raised', accessor: 'created_at', cell: (po) => <DateText value={po.created_at} />, width: 120 },
  ], [])

  const run = async () => {
    const { kind, pos: targets } = confirm
    const fn = kind === 'submit' ? submit : kind === 'send' ? send : remove
    let ok = 0
    const failed = []
    for (const po of targets) {
      try { await fn.mutateAsync(po.id); ok += 1 } catch (e) { failed.push(`${po.po_number}: ${e?.response?.data?.error || e.message}`) }
    }
    setConfirm(null)
    const verb = { submit: 'submitted for approval', send: 'sent to the supplier', delete: 'deleted' }[kind]
    if (ok) notify.success(ok === 1 ? `${targets[0].po_number} ${verb}` : `${ok} purchase orders ${verb}`)
    if (failed.length) notify.error(`Not done — ${failed.join('; ')}`)
  }

  const confirmCopy = confirm && (() => {
    const n = confirm.pos.length
    const what = n === 1 ? confirm.pos[0].po_number : `${n} purchase orders`
    if (confirm.kind === 'submit') return { title: `Submit ${what} for approval?`, consequence: 'Each goes to the approver whose limit covers its total. You cannot edit an order while it waits.', reversible: false, label: `Submit ${what}`, tone: 'primary' }
    if (confirm.kind === 'send') return { title: `Send ${what} to the supplier?`, consequence: 'The supplier receives the purchase order by email and can confirm or reject it.', reversible: false, label: `Send ${what}`, tone: 'primary' }
    return { title: `Delete ${what}?`, consequence: 'Drafts are removed with their lines. Nobody else has seen them yet.', reversible: false, label: `Delete ${what}`, tone: 'danger' }
  })()

  return (
    <>
      <PageHeader
        title="Purchase orders"
        description="Orders that commit spend with a supplier — from draft, through approval, to receipt."
        secondary={<Button icon={ArrowDownTrayIcon} onClick={() => exportCsv(pos.filter(QUICK[quick].test), columns, 'purchase-orders.csv')} disabled={!pos.length}>Export</Button>}
        primary={<Button variant="primary" icon={PlusIcon} to="/procurement/purchase-orders/create" kbd="N">New purchase order</Button>}
      />

      {pos.length >= LIMIT && (
        <InlineNotice tone="warn" className="mb-3" title={`Showing the first ${LIMIT.toLocaleString()} purchase orders`}>
          Use the status filter or search to narrow the list. Older orders are still in the system.
        </InlineNotice>
      )}

      <DataTable
        viewKey="procurement.purchase-orders"
        caption="Purchase orders"
        noun="purchase order"
        rows={pos}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        rowHref={(po) => `/procurement/purchase-orders/${po.id}`}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'created', dir: 'desc' }}
        searchPlaceholder="Search PO, supplier, person"
        toolbarStart={
          <Segmented
            label="Show"
            value={quick}
            onChange={setQuick}
            options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))}
            className="max-w-full overflow-x-auto"
          />
        }
        selectable
        isRowSelectable={(po) => po.status === 'DRAFT' || po.status === 'APPROVED'}
        bulkActions={(sel, clear) => {
          const drafts = sel.filter((p) => p.status === 'DRAFT')
          const approved = sel.filter((p) => p.status === 'APPROVED')
          return (
            <>
              {drafts.length > 0 && <BulkAction tone="primary" icon={CheckCircleIcon} onClick={() => { setConfirm({ kind: 'submit', pos: drafts }); clear() }}>Submit {drafts.length} for approval</BulkAction>}
              {approved.length > 0 && <BulkAction icon={PaperAirplaneIcon} onClick={() => { setConfirm({ kind: 'send', pos: approved }); clear() }}>Send {approved.length} to supplier</BulkAction>}
              <BulkAction icon={ArrowDownTrayIcon} onClick={() => exportCsv(sel, columns, 'purchase-orders-selected.csv')}>Export</BulkAction>
              {drafts.length > 0 && <BulkAction tone="risk" icon={TrashIcon} onClick={() => { setConfirm({ kind: 'delete', pos: drafts }); clear() }}>Delete {drafts.length}</BulkAction>}
            </>
          )
        }}
        rowActions={(po) => (
          <>
            <RowAction icon={EyeIcon} label={`Open ${po.po_number}`} to={`/procurement/purchase-orders/${po.id}`} />
            {po.status === 'DRAFT' && <RowAction icon={CheckCircleIcon} label={`Submit ${po.po_number} for approval`} onClick={() => setConfirm({ kind: 'submit', pos: [po] })} />}
            {po.status === 'APPROVED' && <RowAction icon={PaperAirplaneIcon} label={`Send ${po.po_number} to supplier`} onClick={() => setConfirm({ kind: 'send', pos: [po] })} />}
            {po.status === 'DRAFT' && <RowAction icon={TrashIcon} tone="risk" label={`Delete ${po.po_number}`} onClick={() => setConfirm({ kind: 'delete', pos: [po] })} />}
          </>
        )}
        empty={{
          icon: DocumentTextIcon,
          title: 'No purchase orders yet',
          description: 'A purchase order commits spend with a supplier. Raise one directly, or convert an approved requisition or RFQ.',
          action: <Button variant="primary" icon={PlusIcon} to="/procurement/purchase-orders/create">New purchase order</Button>,
        }}
      />

      {confirmCopy && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={run}
          title={confirmCopy.title}
          consequence={confirmCopy.consequence}
          reversible={confirmCopy.reversible}
          confirmLabel={confirmCopy.label}
          tone={confirmCopy.tone}
          busy={submit.isPending || send.isPending || remove.isPending}
        />
      )}
    </>
  )
}
