import { useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { CheckCircleIcon, PaperAirplaneIcon, TrashIcon, XMarkIcon, TruckIcon, InboxArrowDownIcon, SparklesIcon } from '@heroicons/react/20/solid'
import api from '../../../services/api'
import { useResource, useResourceMutation } from '../../../hooks/useResource'
import { keys } from '../../../services/queryKeys'
import { useAuth } from '../../../contexts/AuthContext'
import { useRecordTitle } from '../../../components/shell/ShellContext'
import {
  PageHeader, Button, Menu, StatusBadge, Money, Num, Code, DateText, ConfirmDialog, DetailLayout, SummaryStrip,
  Tabs, Card, DescriptionList, Timeline, RelatedPanel, DataTable, SkeletonDetail, ErrorState, InlineNotice,
  AiAnswer, daysFrom, formatDate, notify,
} from '../../../components/ui'

const humanize = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
const DONE = new Set(['FULLY_RECEIVED', 'CUSTOMER_CONFIRMED', 'DELIVERED_TO_CUSTOMER', 'CANCELLED', 'CLOSED', 'REJECTED'])

/**
 * A purchase order, on the record pattern every document shares:
 * five facts, tabs for the rest, what happened, what it links to, and the
 * checks that say what needs a look.
 */
export default function POView() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [confirm, setConfirm] = useState(null)
  const [tab, setTab] = useState('lines')

  const { data: po, loading, error, refetch } = useResource(keys.purchaseOrder(id), ({ signal }) => api.get(`/purchase-orders/${id}`, { signal }), { enabled: !!id })
  const { data: lineData, loading: linesLoading } = useResource([...keys.purchaseOrder(id), 'line-items'], ({ signal }) => api.get(`/purchase-orders/${id}/line-items`, { signal }), { enabled: !!id })
  const lines = useMemo(() => (Array.isArray(lineData) ? lineData : []), [lineData])
  useRecordTitle(po?.po_number, { subtitle: po?.supplier_name })

  const invalidates = [keys.purchaseOrder(id), ['purchase-orders']]
  const opts = { invalidates, silent: true }
  const submit = useResourceMutation(() => api.post(`/purchase-orders/${id}/submit-for-approval`), opts)
  const approve = useResourceMutation(() => api.post(`/purchase-orders/${id}/approve`, {}), opts)
  const reject = useResourceMutation((reason) => api.post(`/purchase-orders/${id}/reject`, { reason }), opts)
  const send = useResourceMutation(() => api.post(`/purchase-orders/${id}/send-to-supplier`), opts)
  const cancel = useResourceMutation(() => api.post(`/purchase-orders/${id}/cancel`), opts)
  const verify = useResourceMutation((verified) => api.post(`/purchase-orders/${id}/verify-delivery`, { verified }), opts)
  const remove = useResourceMutation(() => api.delete(`/purchase-orders/${id}`), { invalidates: [['purchase-orders']], silent: true })

  if (loading) return <SkeletonDetail />
  if (error || !po) {
    return (
      <ErrorState
        what={`Purchase order`}
        error={error || { response: { status: 404, data: { error: 'No purchase order with this id is visible to you.' } } }}
        onRetry={refetch}
      />
    )
  }

  const currency = po.currency || 'USD'
  const received = lines.filter((l) => Number(l.quantity_received) >= Number(l.quantity)).length
  const late = po.delivery_date && !DONE.has(po.status) && po.status !== 'DRAFT' && daysFrom(po.delivery_date) < 0
  const due = daysFrom(po.delivery_date)
  const isCreator = user?.id && po.created_by === user.id

  const doIt = async (kind, arg) => {
    const map = { submit, approve, reject, send, cancel, verify: verify, issue: verify, delete: remove }
    const verbs = {
      submit: 'submitted for approval', approve: 'approved', reject: 'rejected', send: 'sent to the supplier',
      cancel: 'cancelled', verify: 'marked as delivered complete', issue: 'returned to the supplier with an issue', delete: 'deleted',
    }
    try {
      await map[kind].mutateAsync(kind === 'verify' ? true : kind === 'issue' ? false : arg)
      setConfirm(null)
      if (kind === 'delete') {
        notify.success(`${po.po_number} deleted`)
        navigate('/procurement/purchase-orders')
      } else {
        notify.success(`${po.po_number} ${verbs[kind]}`)
      }
    } catch (e) {
      setConfirm(null)
      const d = e?.response?.data || {}
      notify.error(`${po.po_number} was not ${verbs[kind]}: ${d.error || e.message}${d.error_id ? ` (reference ${d.error_id})` : ''}`)
    }
  }

  const busy = [submit, approve, reject, send, cancel, verify, remove].some((x) => x.isPending)
  const CONFIRMS = {
    submit: { title: `Submit ${po.po_number} for approval?`, consequence: 'It goes to the approver whose limit covers this total. You cannot edit it while it waits.', label: `Submit ${po.po_number}`, tone: 'primary' },
    approve: { title: `Approve ${po.po_number}?`, consequence: `This commits spend of ${new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(po.total_amount) || 0)} with ${po.supplier_name}. It can then be sent to the supplier.`, label: `Approve ${po.po_number}`, tone: 'primary' },
    reject: { title: `Reject ${po.po_number}?`, consequence: `It returns to ${po.created_by_name || 'the requester'} as Rejected and cannot be resubmitted; a new order is needed.`, label: `Reject ${po.po_number}`, tone: 'danger', requireReason: true },
    send: { title: `Send ${po.po_number} to ${po.supplier_name}?`, consequence: 'The supplier receives the order by email and can confirm or reject it.', label: `Send ${po.po_number}`, tone: 'primary' },
    cancel: { title: `Cancel ${po.po_number}?`, consequence: 'The order stops here. If the supplier already has it, tell them separately.', label: `Cancel ${po.po_number}`, tone: 'danger' },
    verify: { title: `Confirm ${po.po_number} arrived complete?`, consequence: 'This makes the order available for goods receipt in the warehouse.', label: 'Confirm delivery', tone: 'primary' },
    issue: { title: `Report a delivery issue on ${po.po_number}?`, consequence: 'The order goes back to the supplier to resolve.', label: 'Report issue', tone: 'danger' },
    delete: { title: `Delete ${po.po_number}?`, consequence: 'The draft and its lines are removed. Nobody else has seen it yet.', label: `Delete ${po.po_number}`, tone: 'danger', confirmText: po.po_number },
  }

  // One primary action for where this order is in its life.
  let primary = null
  const secondary = []
  if (po.status === 'DRAFT') primary = <Button variant="primary" icon={CheckCircleIcon} onClick={() => setConfirm('submit')}>Submit for approval</Button>
  if (po.status === 'PENDING_APPROVAL') {
    primary = <Button variant="primary" icon={CheckCircleIcon} onClick={() => setConfirm('approve')} disabled={isCreator} title={isCreator ? 'You raised this order; someone else must approve it.' : undefined}>Approve</Button>
    secondary.push(<Button key="rej" variant="destructive" icon={XMarkIcon} onClick={() => setConfirm('reject')}>Reject</Button>)
  }
  if (po.status === 'APPROVED') primary = <Button variant="primary" icon={PaperAirplaneIcon} onClick={() => setConfirm('send')}>Send to supplier</Button>
  if (po.status === 'DELIVERED') {
    primary = <Button variant="primary" icon={TruckIcon} onClick={() => setConfirm('verify')}>Confirm delivery</Button>
    secondary.push(<Button key="iss" variant="destructive" onClick={() => setConfirm('issue')}>Report issue</Button>)
  }
  if (po.status === 'GOODS_READY_FOR_RECEIPT') primary = <Button variant="primary" icon={InboxArrowDownIcon} to="/warehouse/transactions/goods-receipt">Receive goods</Button>

  const more = [
    { label: 'Ask Simeli about this order', icon: SparklesIcon, onSelect: () => navigate(`/ai/chat?q=${encodeURIComponent(`Review purchase order ${po.po_number} from ${po.supplier_name}: anything unusual about price, quantity or timing?`)}`) },
    ...(['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(po.status) ? [{ divider: true }, { label: 'Cancel order', tone: 'risk', icon: XMarkIcon, onSelect: () => setConfirm('cancel') }] : []),
    ...(po.status === 'DRAFT' ? [{ label: 'Delete draft', tone: 'risk', icon: TrashIcon, onSelect: () => setConfirm('delete') }] : []),
  ]

  // History, from the order's own timestamps (the audit log is also shown when it has entries).
  const events = [
    po.handover_at && { title: 'Handed over', at: po.handover_at, tone: 'ok', note: po.handover_notes },
    po.verified_at && { title: 'Delivery verified', actor: null, at: po.verified_at, tone: 'ok', note: po.verification_notes },
    po.delivery_confirmed_at && { title: 'Supplier reported delivery', at: po.delivery_confirmed_at, tone: 'brand', note: po.delivery_notes },
    po.supplier_rejected_at && { title: 'Supplier declined the order', at: po.supplier_rejected_at, tone: 'risk' },
    po.supplier_confirmed_at && { title: 'Supplier confirmed', at: po.supplier_confirmed_at, tone: 'ok' },
    po.rejected_at && { title: 'Rejected', at: po.rejected_at, tone: 'risk', note: po.rejection_reason },
    po.approved_at && { title: 'Approved', actor: po.approved_by_name, at: po.approved_at, tone: 'ok' },
    { title: 'Raised', actor: po.created_by_name, at: po.created_at, tone: 'ink' },
  ].filter(Boolean).sort((a, b) => new Date(b.at) - new Date(a.at))

  // Checks: plain rules over this record. Labelled as such; Simeli can go deeper on request.
  const concluded = []
  if (late) concluded.push(`Delivery was due ${formatDate(po.delivery_date)} — ${Math.abs(due)} day${Math.abs(due) === 1 ? '' : 's'} ago — and nothing has been received.`)
  if (!linesLoading && lines.length === 0) concluded.push('This order has no lines, so its total cannot be checked against anything.')
  const zeroPriced = lines.filter((l) => !Number(l.unit_price))
  if (zeroPriced.length) concluded.push(`${zeroPriced.length} line${zeroPriced.length === 1 ? ' has' : 's have'} no unit price.`)
  const sum = lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unit_price) || 0), 0)
  if (lines.length && Math.abs(sum - Number(po.subtotal || 0)) > 0.01) concluded.push(`Lines add up to ${new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(sum)}, but the order's subtotal is ${new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(po.subtotal) || 0)}.`)
  if (po.status === 'PENDING_APPROVAL' && daysFrom(po.updated_at) < -3) concluded.push(`Waiting for approval for ${Math.abs(daysFrom(po.updated_at))} days.`)

  const lineColumns = [
    { id: 'n', header: '#', accessor: (l) => lines.indexOf(l) + 1, width: 44, align: 'right', cell: (l) => <span className="font-mono text-2xs text-ink-400">{lines.indexOf(l) + 1}</span> },
    {
      id: 'desc', header: 'Item', accessor: 'item_description', minWidth: 220, wrap: true, mobile: 'title',
      cell: (l) => (
        <span>
          <span className="block">{l.item_description}</span>
          {l.item_name && <span className="block font-mono text-2xs text-ink-500">{l.approved_item_code} · {l.item_name}</span>}
        </span>
      ),
    },
    { id: 'qty', header: 'Qty', accessor: (l) => Number(l.quantity), align: 'right', width: 110, cell: (l) => <Num value={l.quantity} digits={Number(l.quantity) % 1 ? 2 : 0} unit={l.unit_of_measure} />, mobile: 'subtitle' },
    { id: 'price', header: 'Unit price', accessor: (l) => Number(l.unit_price), align: 'right', width: 130, cell: (l) => <Money amount={l.unit_price} currency={currency} /> },
    { id: 'total', header: 'Line total', accessor: (l) => Number(l.quantity) * Number(l.unit_price), align: 'right', width: 140, cell: (l) => <Money amount={Number(l.quantity) * Number(l.unit_price)} currency={currency} />, mobile: 'trailing', footer: () => <Money amount={po.subtotal} currency={currency} /> },
    { id: 'recv', header: 'Received', accessor: (l) => Number(l.quantity_received) || 0, align: 'right', width: 120, cell: (l) => <span className="tabular-nums">{Number(l.quantity_received) || 0} / {Number(l.quantity)}{Number(l.quantity_received) >= Number(l.quantity) && <span className="ml-1 text-ok-600" aria-label="complete">✓</span>}</span> },
    { id: 'due', header: 'Due', accessor: 'requested_delivery_date', width: 120, cell: (l) => <DateText value={l.requested_delivery_date || po.delivery_date} />, defaultHidden: true },
  ]

  const header = (
    <PageHeader
      title={<Code className="text-[1em]">{po.po_number}</Code>}
      status={<StatusBadge status={po.status} />}
      meta={
        <>
          <span>{po.supplier_name}</span>
          <span>Raised by {po.created_by_name || '—'} · <DateText value={po.created_at} /></span>
          {po.source_type && <span className="font-mono uppercase">{po.source_type.replace(/_/g, ' ')}</span>}
        </>
      }
      secondary={<>{secondary}<Menu items={more} /></>}
      primary={primary}
    />
  )

  const notice = po.status === 'REJECTED' ? (
    <InlineNotice tone="risk" title={`Rejected${po.rejected_at ? ` on ${formatDate(po.rejected_at)}` : ''}`}>
      {po.rejection_reason || 'No reason was recorded.'} A rejected order is final; raise a new one if it is still needed.
    </InlineNotice>
  ) : po.status === 'PENDING_APPROVAL' && isCreator ? (
    <InlineNotice tone="ink">You raised this order, so separation of duties requires someone else to approve it.</InlineNotice>
  ) : null

  return (
    <>
      <DetailLayout
        header={header}
        notice={notice}
        summary={
          <SummaryStrip
            facts={[
              { label: 'Total', value: <Money amount={po.total_amount} currency={currency} />, hint: Number(po.tax_amount) ? `incl. ${new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(po.tax_amount))} tax` : 'excl. tax' },
              { label: 'Supplier', value: po.supplier_name || '—', hint: po.supplier_code, to: po.supplier_id ? `/procurement/suppliers/${po.supplier_id}` : undefined },
              { label: 'Delivery', value: <DateText value={po.delivery_date} />, hint: late ? `▲ ${Math.abs(due)} days late` : due != null && !DONE.has(po.status) ? (due === 0 ? 'today' : due > 0 ? `in ${due} days` : `${Math.abs(due)} days ago`) : undefined },
              { label: 'Received', value: linesLoading ? '…' : `${received} of ${lines.length} lines`, hint: po.storage_location_id ? 'to storage location on order' : undefined },
              { label: 'Approval', value: po.approved_by_name || (po.status === 'PENDING_APPROVAL' ? 'Waiting' : po.status === 'REJECTED' ? 'Rejected' : po.status === 'DRAFT' ? 'Not submitted' : '—'), hint: po.approved_at ? formatDate(po.approved_at) : undefined },
            ]}
          />
        }
        aside={
          <>
            <AiAnswer
              compact
              title="What needs a look"
              read={[{ label: po.po_number }, { label: `${lines.length} lines` }, ...(po.supplier_code ? [{ label: po.supplier_code, to: `/procurement/suppliers/${po.supplier_id}` }] : [])]}
              concluded={concluded}
              proposes={late ? [{ id: 'chase', title: 'Ask the supplier for a new delivery date', detail: 'Opens Simeli with this order loaded; nothing is sent until you approve it.', actionLabel: 'Prepare message', to: `/ai/chat?q=${encodeURIComponent(`Draft a polite email to ${po.supplier_name} asking for an updated delivery date for ${po.po_number}, which was due ${formatDate(po.delivery_date)}.`)}` }] : []}
              footnote="Rule-based checks on this record. Simeli read only what your role can see and acts only with your approval."
            />
            <Card title="History" padded>
              <Timeline events={events} />
            </Card>
            <RelatedPanel
              groups={[
                { label: 'Supplier', items: po.supplier_id ? [{ label: po.supplier_code || po.supplier_name, to: `/procurement/suppliers/${po.supplier_id}`, sublabel: po.supplier_name }] : [] },
                { label: 'Requisition', items: po.purchase_requisition_id ? [{ label: po.pr_number || 'Requisition', to: `/procurement/purchase-requisitions/${po.purchase_requisition_id}` }] : [] },
                { label: 'RFQ', items: po.rfq_id ? [{ label: po.rfq_number || 'RFQ', to: `/procurement/rfqs/${po.rfq_id}` }] : [] },
                { label: 'Contract', items: po.contract_id ? [{ label: po.contract_number || 'Contract', to: `/procurement/contracts/${po.contract_id}` }] : [] },
                { label: 'Sales order', items: po.sales_order_id ? [{ label: 'Sales order', to: `/sales/sales-orders/${po.sales_order_id}` }] : [] },
              ]}
            />
          </>
        }
      >
        <Tabs
          value={tab}
          onChange={setTab}
          label="Purchase order sections"
          tabs={[{ id: 'lines', label: 'Lines', count: lines.length }, { id: 'details', label: 'Details' }, { id: 'delivery', label: 'Delivery' }]}
        >
          {(t) => (
            <>
              {t === 'lines' && (
                <DataTable caption="Order lines" noun="line" rows={lines} columns={lineColumns} loading={linesLoading} search={lines.length > 12} showCount={false} empty={{ title: 'No lines on this order', description: 'Lines are added when the order is raised.' }} />
              )}
              {t === 'details' && (
                <Card>
                  <DescriptionList
                    items={[
                      { label: 'Order date', value: <DateText value={po.po_date} /> },
                      { label: 'Delivery date', value: <DateText value={po.delivery_date} /> },
                      { label: 'Payment terms', value: po.payment_terms ? humanize(po.payment_terms) : null },
                      { label: 'Incoterms', value: po.incoterms },
                      { label: 'Currency', value: <Code>{currency}</Code> },
                      { label: 'Subtotal', value: <Money amount={po.subtotal} currency={currency} /> },
                      { label: 'Tax', value: <Money amount={po.tax_amount} currency={currency} /> },
                      { label: 'Total', value: <Money amount={po.total_amount} currency={currency} className="font-semibold" /> },
                      { label: 'Ship to', value: po.delivery_address, wide: true },
                    ]}
                  />
                </Card>
              )}
              {t === 'delivery' && (
                <Card>
                  <DescriptionList
                    items={[
                      { label: 'Supplier confirmed', value: po.supplier_confirmed_at ? <DateText value={po.supplier_confirmed_at} withTime /> : 'Not yet' },
                      { label: 'Supplier reported delivery', value: po.delivery_confirmed_at ? <DateText value={po.delivery_confirmed_at} withTime /> : 'Not yet' },
                      { label: 'Delivery notes', value: po.delivery_notes, wide: true },
                      { label: 'Verified', value: po.verified_at ? <DateText value={po.verified_at} withTime /> : 'Not yet' },
                      { label: 'Verification notes', value: po.verification_notes, wide: true },
                    ]}
                  />
                </Card>
              )}
            </>
          )}
        </Tabs>
      </DetailLayout>

      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={(reason) => doIt(confirm, reason)}
          title={CONFIRMS[confirm].title}
          consequence={CONFIRMS[confirm].consequence}
          reversible={false}
          confirmLabel={CONFIRMS[confirm].label}
          tone={CONFIRMS[confirm].tone}
          requireReason={CONFIRMS[confirm].requireReason}
          reasonHelp={`${po.created_by_name || 'The requester'} sees this. Say what would make the order acceptable.`}
          confirmText={CONFIRMS[confirm].confirmText}
          busy={busy}
        />
      )}
    </>
  )
}
