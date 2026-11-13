import { useMemo, useState } from 'react'
import { TruckIcon, EyeIcon, ClipboardDocumentCheckIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import {
  PageHeader, Button, DataTable, RowAction, StatusBadge, Money, Code, DateText, Dialog, Field, Textarea, Segmented,
  InlineNotice, daysFrom, relativeTime, describeError, notify,
} from '../../components/ui'

/**
 * Delivery tracking — purchase orders between "sent to supplier" and
 * "ready for receipt". A delivered order is verified here: accepted, accepted
 * with issues, or rejected back to the supplier. Each outcome emails the
 * supplier, so issues and rejections need a note saying what was wrong.
 */
const STATUSES = [
  { value: 'ALL', label: 'All' },
  { value: 'SENT_TO_SUPPLIER', label: 'Sent' },
  { value: 'CONFIRMED', label: 'Confirmed' },
  { value: 'PREPARING_DELIVERY', label: 'Preparing' },
  { value: 'IN_TRANSIT', label: 'In transit' },
  { value: 'DELIVERED', label: 'Delivered' },
  { value: 'GOODS_READY_FOR_RECEIPT', label: 'Ready for receipt' },
]
const DONE = new Set(['DELIVERED', 'GOODS_READY_FOR_RECEIPT', 'COMPLETED'])
const canVerify = (o) => o.status === 'DELIVERED' && !o.verified_at
const isLate = (o) => o.delivery_date && !DONE.has(o.status) && daysFrom(o.delivery_date) < 0

const OUTCOMES = {
  verified: { verified: true, label: 'Accept delivery', done: 'accepted', needsNote: false },
  accept_with_issues: { verified: 'accept_with_issues', label: 'Accept with issues', done: 'accepted with issues', needsNote: true },
  reject: { verified: false, label: 'Reject delivery', done: 'rejected — the supplier must re-deliver', needsNote: true },
}

export default function DeliveryTrackingHub() {
  const [status, setStatus] = useState('ALL')
  const [verifying, setVerifying] = useState(null)

  const params = status !== 'ALL' ? { status } : {}
  const { data, loading, error, refetch } = useResource(['purchase-orders', 'delivery-tracking', params], ({ signal }) => api.get('/purchase-orders/delivery-tracking', { params, signal }))
  const orders = useMemo(() => (Array.isArray(data) ? data : []), [data])
  const waiting = orders.filter(canVerify).length

  const verify = useResourceMutation(
    ({ orderId, verified, verification_notes }) => api.post(`/purchase-orders/${orderId}/verify-delivery`, { verified, verification_notes }),
    { invalidates: [['purchase-orders', 'delivery-tracking']], silent: true }
  )

  const columns = useMemo(() => [
    { id: 'po', header: 'PO', accessor: 'po_number', cell: (o) => <Code>{o.po_number}</Code>, width: 150, mobile: 'title' },
    { id: 'supplier', header: 'Supplier', accessor: 'supplier_name', filter: 'text', minWidth: 180, mobile: 'subtitle' },
    { id: 'status', header: 'Status', accessor: 'status', cell: (o) => <StatusBadge status={o.status} />, width: 190, mobile: 'meta' },
    {
      id: 'due', header: 'Due', accessor: 'delivery_date', width: 160,
      cell: (o) => (
        <span className="flex items-center gap-1.5">
          <DateText value={o.delivery_date} />
          {isLate(o) && <span className="font-mono text-2xs text-risk-600" title="Delivery date has passed">▲ {Math.abs(daysFrom(o.delivery_date))}d late</span>}
        </span>
      ),
    },
    { id: 'location', header: 'Deliver to', accessor: 'storage_location_name', width: 170, cell: (o) => o.storage_location_name || <span className="text-ink-400">—</span> },
    {
      id: 'progress', header: 'Latest', accessor: (o) => o.verified_at || o.delivery_confirmed_at, width: 220, wrap: true,
      cell: (o) => {
        if (o.verified_at) return <span className="text-sm"><span className="text-ink-900">Verified {relativeTime(o.verified_at)}</span>{o.verification_notes && <span className="block truncate text-xs text-ink-500">“{o.verification_notes}”</span>}</span>
        if (o.delivery_confirmed_at) return <span className="text-sm"><span className="text-ink-900">Supplier confirmed {relativeTime(o.delivery_confirmed_at)}</span>{o.delivery_notes && <span className="block truncate text-xs text-ink-500">“{o.delivery_notes}”</span>}</span>
        return <span className="text-ink-400">—</span>
      },
    },
    { id: 'total', header: 'Total', accessor: (o) => Number(o.total_amount), align: 'right', width: 140, mobile: 'trailing', cell: (o) => <Money amount={o.total_amount} currency={o.currency} /> },
  ], [])

  return (
    <>
      <PageHeader
        title="Delivery tracking"
        description="Orders on their way from suppliers. Verify each delivery when it arrives."
      />

      {waiting > 0 && (
        <InlineNotice tone="warn" className="mb-3" title={`${waiting} deliver${waiting === 1 ? 'y' : 'ies'} waiting for verification`}>
          Goods cannot be received into stock until the delivery is verified.
        </InlineNotice>
      )}

      <DataTable
        viewKey="procurement.delivery-tracking"
        caption="Deliveries"
        noun="order"
        rows={orders}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        rowHref={(o) => `/procurement/purchase-orders/${o.id}`}
        defaultSort={{ id: 'due', dir: 'asc' }}
        searchPlaceholder="Search PO, supplier"
        toolbarStart={<Segmented label="Status" value={status} onChange={setStatus} options={STATUSES} className="max-w-full overflow-x-auto [&>button]:shrink-0 [&>button]:whitespace-nowrap" />}
        rowActions={(o) => (
          <>
            <RowAction icon={EyeIcon} label={`Open ${o.po_number}`} to={`/procurement/purchase-orders/${o.id}`} />
            {canVerify(o) && <RowAction icon={ClipboardDocumentCheckIcon} label={`Verify delivery of ${o.po_number}`} onClick={() => setVerifying(o)} />}
          </>
        )}
        empty={{
          icon: TruckIcon,
          title: status === 'ALL' ? 'Nothing in delivery' : 'No orders at this stage',
          description: status === 'ALL' ? 'Orders appear here once they are sent to the supplier.' : 'Choose another stage, or All.',
          action: <Button to="/procurement/purchase-orders">Purchase orders</Button>,
        }}
      />

      {verifying && (
        <VerifyDialog
          order={verifying}
          busy={verify.isPending}
          onClose={() => setVerifying(null)}
          onSubmit={async (kind, notes) => {
            const o = OUTCOMES[kind]
            try {
              await verify.mutateAsync({ orderId: verifying.id, verified: o.verified, verification_notes: notes })
              notify.success(`${verifying.po_number} ${o.done}. The supplier has been emailed.`)
              setVerifying(null)
            } catch (e) {
              notify.error(`${verifying.po_number} was not verified: ${describeError(e).message}`)
            }
          }}
        />
      )}
    </>
  )
}

function VerifyDialog({ order, busy, onClose, onSubmit }) {
  const [notes, setNotes] = useState('')
  const [tried, setTried] = useState(null)
  const missing = tried && OUTCOMES[tried].needsNote && notes.trim().length < 3
  const go = (kind) => {
    setTried(kind)
    if (OUTCOMES[kind].needsNote && notes.trim().length < 3) return
    onSubmit(kind, notes.trim())
  }
  return (
    <Dialog
      open
      onClose={busy ? undefined : onClose}
      title={`Verify delivery of ${order.po_number}`}
      description={`${order.supplier_name || 'The supplier'} marked this order delivered. Whatever you choose is emailed to them.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="destructive" onClick={() => go('reject')} disabled={busy}>Reject delivery</Button>
          <Button onClick={() => go('accept_with_issues')} disabled={busy}>Accept with issues</Button>
          <Button variant="primary" onClick={() => go('verified')} loading={busy && tried === 'verified'} disabled={busy}>Accept delivery</Button>
        </>
      }
    >
      <Field
        label="Notes"
        optional={!tried || !OUTCOMES[tried].needsNote}
        help="Required if you accept with issues or reject: say what was wrong, so the supplier can put it right."
        error={missing ? 'Say what was wrong with the delivery.' : null}
        id="verification-notes-optional"
      >
        <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Damaged cartons, short quantity, wrong item…" data-autofocus />
      </Field>
    </Dialog>
  )
}
