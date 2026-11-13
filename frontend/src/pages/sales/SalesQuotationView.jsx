import { useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { CheckCircleIcon, PaperAirplaneIcon, PencilSquareIcon, ArrowRightIcon, PrinterIcon, SparklesIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useRecordTitle } from '../../components/shell/ShellContext'
import {
  PageHeader, Button, Menu, StatusBadge, Money, Num, Code, DateText, ConfirmDialog, DetailLayout, SummaryStrip,
  Tabs, Card, DescriptionList, Timeline, RelatedPanel, DataTable, SkeletonDetail, ErrorState, InlineNotice,
  daysFrom, formatDate, formatMoney, notify,
} from '../../components/ui'
import PromiseCheck from '../../components/sales/PromiseCheck'

const intentOf = (s) => (/^PENDING/.test(s) ? 'warning' : /RESPONDED$|APPROVED/.test(s) ? 'success' : /^SENT/.test(s) ? 'info' : undefined)
const humanize = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
const CLOSED = new Set(['ACCEPTED', 'REJECTED', 'CANCELLED'])

/** A sales quotation on the shared record pattern: five facts, lines, terms, history, related records. */
export default function SalesQuotationView() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [confirm, setConfirm] = useState(null)
  const [tab, setTab] = useState('lines')

  const { data: q, loading, error, refetch } = useResource(keys.salesQuotation(id), ({ signal }) => api.get(`/sales-quotations/${id}`, { signal }), { enabled: !!id })
  const { data: historyData, loading: historyLoading } = useResource([...keys.salesQuotation(id), 'status-history'], ({ signal }) => api.get(`/sales-quotations/${id}/status-history`, { signal }), { enabled: !!id })
  const history = useMemo(() => (Array.isArray(historyData) ? historyData : []), [historyData])
  useRecordTitle(q?.quotation_number, { subtitle: q?.customer_name })

  const invalidates = [keys.salesQuotation(id), ['sales-quotations'], ['sales-quotations-stats']]
  const opts = { invalidates, silent: true }
  const requestApproval = useResourceMutation(() => api.post(`/sales-quotations/${id}/request-approval`), opts)
  const requestSend = useResourceMutation(() => api.post(`/sales-quotations/${id}/request-send`), opts)
  const send = useResourceMutation(() => api.post(`/sales-quotations/${id}/send`), opts)
  const convert = useResourceMutation(() => api.post(`/sales-quotations/${id}/convert-to-sales-order`), { invalidates: [...invalidates, ['sales-orders']], silent: true })

  if (loading) return <SkeletonDetail />
  if (error || !q) {
    return (
      <ErrorState
        what="Sales quotation"
        error={error || { response: { status: 404, data: { error: 'No quotation with this id is visible to you.' } } }}
        onRetry={refetch}
      />
    )
  }

  const currency = q.currency || 'USD'
  const lines = Array.isArray(q.items) ? q.items : []
  const expired = !CLOSED.has(q.status) && q.valid_until && daysFrom(q.valid_until) < 0
  const validIn = daysFrom(q.valid_until)
  const canConvert = q.status === 'ACCEPTED' && !q.converted_to_so
  const canEdit = !CLOSED.has(q.status)
  const fail = (verb, e) => {
    const d = e?.response?.data || {}
    notify.error(`${q.quotation_number} was not ${verb}: ${d.error || e.message}${d.error_id ? ` (reference ${d.error_id})` : ''}`)
  }

  const doIt = async (kind) => {
    try {
      if (kind === 'approval') {
        await requestApproval.mutateAsync()
        notify.success(`${q.quotation_number} sent for approval`)
      } else if (kind === 'requestSend') {
        const result = await requestSend.mutateAsync()
        notify.success(result?.requiresApproval ? `Approval to send ${q.quotation_number} requested` : `${q.quotation_number} sent to ${q.customer_name || 'the customer'}`)
      } else if (kind === 'send') {
        await send.mutateAsync()
        notify.success(`${q.quotation_number} sent to ${q.customer_name || 'the customer'}`)
      }
      setConfirm(null)
    } catch (e) {
      setConfirm(null)
      fail({ approval: 'sent for approval', requestSend: 'sent', send: 'sent' }[kind], e)
    }
  }

  // Converting creates a new record and opens it; nothing is lost, so it runs on one click.
  const doConvert = async () => {
    try {
      const result = await convert.mutateAsync()
      const so = result?.id ? result : result?.data
      notify.success(`${q.quotation_number} converted to sales order${so?.so_number ? ` ${so.so_number}` : ''}`)
      if (so?.id) navigate(`/sales/sales-orders/${so.id}`)
    } catch (e) {
      fail('converted', e)
    }
  }

  const CONFIRMS = {
    approval: { title: `Send ${q.quotation_number} for approval?`, consequence: 'It goes to the approver whose limit covers this total. It is then ready to send to the customer.', label: 'Send for approval' },
    requestSend: { title: `Send ${q.quotation_number} to ${q.customer_name || 'the customer'}?`, consequence: 'If your approval limit covers this total it is emailed to the customer now; otherwise a manager is asked to approve sending it first.', label: 'Request send' },
    send: { title: `Send ${q.quotation_number} to ${q.customer_name || 'the customer'}?`, consequence: `The customer receives the quotation by email${q.customer_email ? ` at ${q.customer_email}` : ''} and can accept or decline it.`, label: `Send ${q.quotation_number}` },
  }

  // One primary action for where this quotation is in its life.
  let primary = null
  const secondary = []
  if (q.status === 'DRAFT') {
    primary = <Button variant="primary" icon={CheckCircleIcon} onClick={() => setConfirm('approval')}>Send for approval</Button>
    secondary.push(<Button key="rs" icon={PaperAirplaneIcon} onClick={() => setConfirm('requestSend')}>Request send to customer</Button>)
  }
  if (q.status === 'APPROVED' || q.status === 'PENDING_APPROVAL') primary = <Button variant="primary" icon={PaperAirplaneIcon} onClick={() => setConfirm('requestSend')}>Request send to customer</Button>
  if (q.status === 'APPROVED_FOR_SEND') primary = <Button variant="primary" icon={PaperAirplaneIcon} onClick={() => setConfirm('send')}>Send to customer</Button>
  if (canConvert) primary = <Button variant="primary" icon={ArrowRightIcon} onClick={doConvert} loading={convert.isPending}>Convert to Sales Order</Button>
  if (canEdit) secondary.push(<Button key="edit" icon={PencilSquareIcon} to={`/sales/quotations/${id}/edit`}>Edit</Button>)

  const more = [
    { label: 'Print', icon: PrinterIcon, onSelect: () => window.print() },
    { label: 'Ask Simeli about this quotation', icon: SparklesIcon, onSelect: () => navigate(`/ai/chat?q=${encodeURIComponent(`Review sales quotation ${q.quotation_number} for ${q.customer_name}: are the prices, discounts and margins reasonable?`)}`) },
  ]

  const events = history.map((h, i) => ({
    id: h.id || i,
    title: h.from_status ? `${humanize(h.from_status)} → ${humanize(h.to_status)}` : humanize(h.to_status),
    actor: h.changed_by_name,
    at: h.status_date || h.changed_at || h.created_at,
    note: h.reason,
    tone: h.to_status === 'ACCEPTED' || h.to_status === 'APPROVED' ? 'ok' : h.to_status === 'REJECTED' ? 'risk' : h.to_status === 'SENT' ? 'brand' : 'ink',
  }))
  if (!events.length && q.created_at) events.push({ id: 'created', title: 'Created', actor: q.created_by_name, at: q.created_at, tone: 'ink' })

  const lineColumns = [
    { id: 'n', header: '#', accessor: (l) => lines.indexOf(l) + 1, width: 44, align: 'right', cell: (l) => <span className="font-mono text-2xs text-ink-400">{lines.indexOf(l) + 1}</span> },
    {
      id: 'item', header: 'Item', accessor: 'item_name', minWidth: 220, wrap: true, mobile: 'title',
      cell: (l) => (
        <span>
          <span className="block">{l.item_name}</span>
          {(l.item_code || l.item_description) && <span className="block text-2xs text-ink-500">{[l.item_code && <Code key="c">{l.item_code}</Code>, l.item_description].filter(Boolean).reduce((a, b) => [a, ' · ', b])}</span>}
        </span>
      ),
    },
    { id: 'qty', header: 'Qty', accessor: (l) => Number(l.quantity), align: 'right', width: 110, cell: (l) => <Num value={l.quantity} digits={Number(l.quantity) % 1 ? 2 : 0} unit={l.unit_of_measure} />, mobile: 'subtitle' },
    { id: 'price', header: 'Unit price', accessor: (l) => Number(l.unit_price), align: 'right', width: 130, cell: (l) => <Money amount={l.unit_price} currency={currency} /> },
    { id: 'disc', header: 'Discount', accessor: (l) => Number(l.discount_amount) || 0, align: 'right', width: 110, cell: (l) => (Number(l.discount_amount) ? <Money amount={l.discount_amount} currency={currency} /> : <span className="text-ink-400">—</span>) },
    { id: 'total', header: 'Line total', accessor: (l) => Number(l.line_total), align: 'right', width: 140, cell: (l) => <Money amount={l.line_total} currency={currency} />, mobile: 'trailing', footer: () => <Money amount={q.subtotal} currency={currency} /> },
    { id: 'source', header: 'Source', accessor: (l) => (l.sourcing_type === 'SUPPLIER' ? l.supplier_name || 'Supplier' : 'Stock'), width: 160, cell: (l) => (l.sourcing_type === 'SUPPLIER' ? <span className="block truncate">{l.supplier_name || 'Supplier'}</span> : <span className="text-ink-600">Stock</span>) },
    { id: 'margin', header: 'Margin', accessor: (l) => (l.margin_percentage == null ? null : Number(l.margin_percentage)), align: 'right', width: 100, defaultHidden: true, cell: (l) => (l.margin_percentage == null ? <span className="text-ink-400">—</span> : <span className="tabular-nums">{Number(l.margin_percentage).toFixed(1)}%</span>) },
    { id: 'due', header: 'Delivery', accessor: 'estimated_delivery_date', width: 120, defaultHidden: true, cell: (l) => <DateText value={l.estimated_delivery_date} /> },
  ]

  const header = (
    <PageHeader
      title={<Code className="text-[1em]">{q.quotation_number}</Code>}
      status={<StatusBadge status={q.status} intent={intentOf(q.status)} />}
      meta={
        <>
          <span>{q.customer_name}</span>
          <span>Raised by {q.created_by_name || '—'} · <DateText value={q.created_at || q.quotation_date} /></span>
          {q.reference_number && <span>Ref {q.reference_number}</span>}
        </>
      }
      secondary={<>{secondary}<Menu items={more} /></>}
      primary={primary}
    />
  )

  const statusNote = {
    PENDING_APPROVAL: ['warn', 'Waiting for approval', 'An approver must approve this quotation before it goes to the customer.'],
    PENDING_SEND_APPROVAL: ['warn', 'Waiting for approval to send', 'A manager has been asked to approve sending this quotation to the customer.'],
    SENT: ['ink', 'With the customer', 'Sent to the customer. Waiting for them to accept or decline.'],
    REJECTED: ['risk', 'Declined by the customer', 'The customer declined this quotation. Raise a new one if they still need the goods.'],
  }[q.status]
  const notice = (
    <>
      {expired && <InlineNotice tone="risk" title="This quotation has expired">It was valid until {formatDate(q.valid_until)}. Extend the validity date before sending it again.</InlineNotice>}
      {q.converted_to_so && (
        <InlineNotice tone="ok" title="Converted to a sales order" action={q.sales_order_id ? <Button size="sm" to={`/sales/sales-orders/${q.sales_order_id}`}>Open sales order</Button> : null}>
          This quotation is now a sales order; changes belong there.
        </InlineNotice>
      )}
      {canConvert && <InlineNotice tone="ok" title="Accepted by the customer">Convert it to a sales order to start fulfilment.</InlineNotice>}
      {statusNote && <InlineNotice tone={statusNote[0]} title={statusNote[1]}>{statusNote[2]}</InlineNotice>}
    </>
  )

  return (
    <>
      <DetailLayout
        header={header}
        notice={expired || q.converted_to_so || canConvert || statusNote ? <div className="space-y-2">{notice}</div> : null}
        summary={
          <SummaryStrip
            facts={[
              { label: 'Total', value: <Money amount={q.total_amount} currency={currency} />, hint: Number(q.tax_amount) ? `incl. ${formatMoney(q.tax_amount, currency)} tax` : 'no tax' },
              { label: 'Customer', value: q.customer_name || '—', hint: q.customer_email, to: q.customer_id ? `/sales/customers/${q.customer_id}` : undefined },
              { label: 'Valid until', value: <DateText value={q.valid_until} />, hint: expired ? `▲ expired ${Math.abs(validIn)} days ago` : validIn != null && !CLOSED.has(q.status) ? (validIn === 0 ? 'today' : `${validIn} days left`) : undefined },
              { label: 'Lines', value: `${lines.length}`, hint: q.estimated_delivery_days ? `delivery in ${q.estimated_delivery_days} days` : undefined },
              { label: 'Priority', value: q.priority ? humanize(q.priority) : '—' },
            ]}
          />
        }
        aside={
          <>
            {!CLOSED.has(q.status) && !q.converted_to_so && <PromiseCheck quotationId={id} number={q.quotation_number} />}
            <Card title="History" padded>
              {historyLoading ? <p className="text-sm text-ink-500">Loading…</p> : <Timeline events={events} />}
            </Card>
            <RelatedPanel
              groups={[
                { label: 'Customer', items: q.customer_id ? [{ label: q.customer_name || 'Customer', to: `/sales/customers/${q.customer_id}`, sublabel: q.customer_phone }] : [] },
                { label: 'Sales order', items: q.sales_order_id ? [{ label: q.so_number || 'Sales order', to: `/sales/sales-orders/${q.sales_order_id}` }] : [] },
              ]}
            />
          </>
        }
      >
        <Tabs
          value={tab}
          onChange={setTab}
          label="Quotation sections"
          tabs={[{ id: 'lines', label: 'Lines', count: lines.length }, { id: 'details', label: 'Details' }, { id: 'terms', label: 'Terms and notes' }]}
        >
          {(t) => (
            <>
              {t === 'lines' && (
                <DataTable caption="Quotation lines" noun="line" rows={lines} columns={lineColumns} search={lines.length > 12} showCount={false} empty={{ title: 'No lines on this quotation', description: 'Edit the quotation to add the goods you are offering.' }} />
              )}
              {t === 'details' && (
                <Card>
                  <DescriptionList
                    items={[
                      { label: 'Quotation date', value: <DateText value={q.quotation_date} /> },
                      { label: 'Valid until', value: <DateText value={q.valid_until} /> },
                      { label: 'Reference', value: q.reference_number || null },
                      { label: 'Currency', value: <Code>{currency}</Code> },
                      { label: 'Subtotal', value: <Money amount={q.subtotal} currency={currency} /> },
                      { label: 'Tax', value: <Money amount={q.tax_amount} currency={currency} /> },
                      { label: 'Total', value: <Money amount={q.total_amount} currency={currency} className="font-semibold" /> },
                      { label: 'Payment terms', value: q.payment_terms ? (/^\d+$/.test(String(q.payment_terms)) ? `${q.payment_terms} days` : q.payment_terms) : null },
                      { label: 'Estimated delivery', value: q.estimated_delivery_days ? `${q.estimated_delivery_days} days` : null },
                      { label: 'Delivery terms', value: q.delivery_terms || null },
                      { label: 'Customer email', value: q.customer_email || null },
                      { label: 'Customer phone', value: q.customer_phone || null },
                      { label: 'Delivery address', value: q.delivery_address || null, wide: true },
                    ]}
                  />
                </Card>
              )}
              {t === 'terms' && (
                <Card>
                  <DescriptionList
                    columns={1}
                    items={[
                      { label: 'Terms and conditions', value: q.terms_and_conditions ? <span className="whitespace-pre-wrap">{q.terms_and_conditions}</span> : null, wide: true },
                      { label: 'Notes to the customer', value: q.notes ? <span className="whitespace-pre-wrap">{q.notes}</span> : null, wide: true },
                      { label: 'Internal notes', value: q.internal_notes ? <span className="whitespace-pre-wrap">{q.internal_notes}</span> : null, wide: true },
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
          onConfirm={() => doIt(confirm)}
          title={CONFIRMS[confirm].title}
          consequence={CONFIRMS[confirm].consequence}
          confirmLabel={CONFIRMS[confirm].label}
          tone="primary"
          busy={requestApproval.isPending || requestSend.isPending || send.isPending}
        />
      )}
    </>
  )
}
