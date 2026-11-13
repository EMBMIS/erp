import { useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  CheckCircleIcon, PaperAirplaneIcon, PencilSquareIcon, InboxArrowDownIcon, ChatBubbleLeftRightIcon, ArrowPathIcon, DocumentPlusIcon,
} from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useRecordTitle } from '../../components/shell/ShellContext'
import {
  PageHeader, Button, Menu, StatusBadge, Money, Num, Code, DateText, ConfirmDialog, Dialog, DetailLayout, SummaryStrip,
  Tabs, Card, DescriptionList, Timeline, RelatedPanel, DataTable, SkeletonDetail, ErrorState, InlineNotice,
  Field, Input, Select, Textarea, EmptyState, daysFrom, formatDate, notify,
} from '../../components/ui'

const humanize = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
const intentOf = (s) => (/^PENDING/.test(s) ? 'warning' : /RESPONDED$|APPROVED/.test(s) ? 'success' : /^SENT/.test(s) ? 'info' : undefined)
const PENDING = ['PENDING_DUAL_APPROVAL', 'PENDING_SALES_APPROVAL', 'PENDING_PROCUREMENT_APPROVAL']
const STATUSES = ['DRAFT', 'SENT', 'RESPONDED', 'PARTIALLY_RESPONDED', 'EXPIRED', 'CANCELLED', 'COMPLETED']
const BLANK_RESPONSE = { supplier_total_amount: '', supplier_currency: 'USD', supplier_validity_days: '', supplier_comments: '', supplier_alternative_items: '' }
const BLANK_COMM = { communication_type: 'MANUAL_NOTE', direction: 'OUTBOUND', subject: '', message_content: '' }

/** A sales RFQ to a supplier, on the shared record pattern. */
export default function SalesRfqView() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [tab, setTab] = useState('lines')
  const [confirm, setConfirm] = useState(null) // 'submit' | 'send' | 'po'
  const [dialog, setDialog] = useState(null) // 'status' | 'response' | 'comm'
  const [statusForm, setStatusForm] = useState({ status: '', reason: '' })
  const [response, setResponse] = useState(BLANK_RESPONSE)
  const [comm, setComm] = useState(BLANK_COMM)
  const [formError, setFormError] = useState(null)

  const { data: rfq, loading, error, refetch } = useResource(keys.salesRfq(id), ({ signal }) => api.get(`/sales-rfqs/${id}`, { signal }), { enabled: !!id })
  const { data: historyData, loading: historyLoading } = useResource([...keys.salesRfq(id), 'status-history'], ({ signal }) => api.get(`/sales-rfqs/${id}/status-history`, { signal }), { enabled: !!id })
  const { data: commsData, loading: commsLoading } = useResource([...keys.salesRfq(id), 'communications'], ({ signal }) => api.get(`/sales-rfqs/${id}/communications`, { signal }), { enabled: !!id })
  const history = useMemo(() => (Array.isArray(historyData) ? historyData : []), [historyData])
  const comms = useMemo(() => (Array.isArray(commsData) ? commsData : []), [commsData])
  useRecordTitle(rfq?.rfq_number, { subtitle: rfq?.rfq_title })

  const invalidates = [keys.salesRfq(id), ['sales-rfqs'], ['sales-rfqs-stats']]
  const opts = { invalidates, silent: true }
  const submit = useResourceMutation(() => api.post(`/sales-rfqs/${id}/send`), opts)
  const sendToSupplier = useResourceMutation(() => api.post(`/sales-rfqs/${id}/send-to-supplier`), opts)
  const updateStatus = useResourceMutation((payload) => api.put(`/sales-rfqs/${id}/status`, payload), opts)
  const saveResponse = useResourceMutation((payload) => api.put(`/sales-rfqs/${id}/supplier-response`, payload), opts)
  const addComm = useResourceMutation((payload) => api.post(`/sales-rfqs/${id}/communications`, payload), opts)
  const createPo = useResourceMutation(() => api.post(`/sales-rfqs/${id}/create-purchase-order`), { invalidates: [...invalidates, ['purchase-orders']], silent: true })

  if (loading) return <SkeletonDetail />
  if (error || !rfq) {
    return <ErrorState what="RFQ to supplier" error={error || { response: { status: 404, data: { error: 'No RFQ with this id is visible to you.' } } }} onRetry={refetch} />
  }

  const items = Array.isArray(rfq.items) ? rfq.items : []
  const currency = rfq.supplier_currency || 'USD'
  const supplierName = rfq.supplier_company_name || rfq.supplier_name
  const fullyApproved = rfq.overall_approval_status === 'FULLY_APPROVED'
  const waiting = PENDING.includes(rfq.status) && !fullyApproved
  const canSend = (PENDING.includes(rfq.status) || rfq.status === 'APPROVED') && fullyApproved
  const canRecord = rfq.status === 'SENT' || rfq.status === 'PARTIALLY_RESPONDED'
  const hasResponse = rfq.status === 'SUPPLIER_RESPONDED' || Boolean(rfq.response_received_at)
  const due = daysFrom(rfq.response_deadline)
  const errText = (e) => { const d = e?.response?.data || {}; return `${d.error || e.message}${d.error_id ? ` (reference ${d.error_id})` : ''}` }

  const doConfirm = async () => {
    const kind = confirm
    try {
      if (kind === 'submit') { await submit.mutateAsync(); notify.success(`${rfq.rfq_number} submitted for approval`) }
      if (kind === 'send') { await sendToSupplier.mutateAsync(); notify.success(`${rfq.rfq_number} sent to ${supplierName || 'the supplier'}`) }
      if (kind === 'po') {
        const po = await createPo.mutateAsync()
        const created = po?.id ? po : po?.data
        notify.success(`Purchase order${created?.po_number ? ` ${created.po_number}` : ''} created from ${rfq.rfq_number}`)
        setConfirm(null)
        if (created?.id) navigate(`/procurement/purchase-orders/${created.id}`)
        return
      }
      setConfirm(null)
    } catch (e) {
      setConfirm(null)
      notify.error(`${rfq.rfq_number}: ${errText(e)}`)
    }
  }

  const openDialog = (kind) => {
    setFormError(null)
    if (kind === 'status') setStatusForm({ status: '', reason: '' })
    if (kind === 'response') setResponse({ ...BLANK_RESPONSE, supplier_currency: rfq.supplier_currency || 'USD' })
    if (kind === 'comm') setComm(BLANK_COMM)
    setDialog(kind)
  }
  const submitDialog = async (e) => {
    e?.preventDefault()
    setFormError(null)
    try {
      if (dialog === 'status') {
        if (!statusForm.status) { setFormError('Choose the new status.'); return }
        await updateStatus.mutateAsync(statusForm)
        notify.success(`${rfq.rfq_number} is now ${humanize(statusForm.status).toLowerCase()}`)
      }
      if (dialog === 'response') {
        await saveResponse.mutateAsync(response)
        notify.success(`Supplier response recorded on ${rfq.rfq_number}`)
      }
      if (dialog === 'comm') {
        if (!comm.message_content.trim()) { setFormError('Describe the communication.'); return }
        await addComm.mutateAsync(comm)
        notify.success('Communication logged')
      }
      setDialog(null)
    } catch (err) {
      setFormError(errText(err))
    }
  }
  const dialogBusy = updateStatus.isPending || saveResponse.isPending || addComm.isPending

  // One primary action for where this RFQ is in its life.
  let primary = null
  const secondary = []
  if (rfq.status === 'DRAFT') primary = <Button variant="primary" icon={CheckCircleIcon} onClick={() => setConfirm('submit')}>Submit for approval</Button>
  else if (canSend) primary = <Button variant="primary" icon={PaperAirplaneIcon} onClick={() => setConfirm('send')}>Send to supplier</Button>
  else if (canRecord) primary = <Button variant="primary" icon={InboxArrowDownIcon} onClick={() => openDialog('response')}>Record response</Button>
  else if (hasResponse) primary = <Button variant="primary" icon={DocumentPlusIcon} onClick={() => setConfirm('po')}>Create purchase order</Button>
  if (hasResponse && canRecord) secondary.push(<Button key="po" icon={DocumentPlusIcon} onClick={() => setConfirm('po')}>Create purchase order</Button>)
  secondary.push(<Button key="edit" icon={PencilSquareIcon} to={`/sales/rfqs/${id}/edit`}>Edit</Button>)
  const more = [
    { label: 'Log communication', icon: ChatBubbleLeftRightIcon, onSelect: () => openDialog('comm') },
    { label: 'Update status', icon: ArrowPathIcon, onSelect: () => openDialog('status') },
  ]

  const CONFIRMS = {
    submit: { title: `Submit ${rfq.rfq_number} for approval?`, consequence: 'Sales and procurement both approve it. Once both have, it can be sent to the supplier.', label: 'Submit for approval' },
    send: { title: `Send ${rfq.rfq_number} to ${supplierName || 'the supplier'}?`, consequence: `The supplier is emailed${rfq.supplier_email ? ` at ${rfq.supplier_email}` : ''} with a link to price the lines.`, label: 'Send to supplier' },
    po: { title: `Create a purchase order from ${rfq.rfq_number}?`, consequence: `A purchase order to ${supplierName || 'the supplier'} is raised from the latest supplier response. Only one purchase order can be created per RFQ.`, label: 'Create purchase order' },
  }

  const events = history.map((h, i) => ({
    id: h.id || i,
    title: humanize(h.status || h.to_status),
    actor: h.changed_by_name,
    at: h.changed_at || h.created_at,
    note: h.change_reason || h.reason,
    tone: /REJECT|CANCEL/.test(h.status) ? 'risk' : /RESPONDED|APPROVED|COMPLETED/.test(h.status) ? 'ok' : h.status === 'SENT' ? 'brand' : 'ink',
  }))
  if (!events.length && rfq.created_at) events.push({ id: 'created', title: 'Created', actor: rfq.created_by_name, at: rfq.created_at, tone: 'ink' })

  const lineColumns = [
    { id: 'n', header: '#', accessor: (l) => items.indexOf(l) + 1, width: 44, align: 'right', cell: (l) => <span className="font-mono text-2xs text-ink-400">{items.indexOf(l) + 1}</span> },
    {
      id: 'item', header: 'Item', accessor: 'item_name', minWidth: 220, wrap: true, mobile: 'title',
      cell: (l) => (
        <span>
          <span className="block">{l.item_name}</span>
          {l.item_description && <span className="block text-2xs text-ink-500">{l.item_description}</span>}
          {l.item_specification && <span className="block whitespace-pre-wrap text-2xs text-ink-400">{l.item_specification}</span>}
        </span>
      ),
    },
    { id: 'qty', header: 'Requested', accessor: (l) => Number(l.requested_quantity), align: 'right', width: 120, mobile: 'subtitle', cell: (l) => <Num value={l.requested_quantity} digits={Number(l.requested_quantity) % 1 ? 2 : 0} unit={l.unit_of_measure} /> },
    { id: 'est', header: 'Our estimate', accessor: (l) => (l.estimated_unit_price == null ? null : Number(l.estimated_unit_price)), align: 'right', width: 120, cell: (l) => <Money amount={l.estimated_unit_price} /> },
    { id: 'quoted', header: 'Quoted price', accessor: (l) => (l.quoted_unit_price == null ? null : Number(l.quoted_unit_price)), align: 'right', width: 120, cell: (l) => <Money amount={l.quoted_unit_price} currency={currency} /> },
    { id: 'qtotal', header: 'Quoted total', accessor: (l) => (l.quoted_total_price == null ? null : Number(l.quoted_total_price)), align: 'right', width: 130, mobile: 'trailing', cell: (l) => <Money amount={l.quoted_total_price} currency={currency} /> },
    { id: 'lead', header: 'Lead time', accessor: (l) => (l.supplier_lead_time_days == null ? null : Number(l.supplier_lead_time_days)), align: 'right', width: 100, cell: (l) => (l.supplier_lead_time_days ? <Num value={l.supplier_lead_time_days} unit="days" /> : <span className="text-ink-400">—</span>) },
    { id: 'code', header: 'Supplier code', accessor: 'supplier_item_code', width: 130, defaultHidden: true, cell: (l) => (l.supplier_item_code ? <Code>{l.supplier_item_code}</Code> : <span className="text-ink-400">—</span>) },
    { id: 'avail', header: 'Availability', accessor: 'supplier_availability_status', width: 130, defaultHidden: true, cell: (l) => (l.supplier_availability_status ? humanize(l.supplier_availability_status) : <span className="text-ink-400">—</span>) },
  ]

  const header = (
    <PageHeader
      title={rfq.rfq_title || <Code className="text-[1em]">{rfq.rfq_number}</Code>}
      status={<StatusBadge status={rfq.status} intent={intentOf(rfq.status)} />}
      meta={
        <>
          <Code>{rfq.rfq_number}</Code>
          <span>{supplierName || 'No supplier'}</span>
          <span>Raised by {rfq.created_by_name || '—'} · <DateText value={rfq.created_at} /></span>
        </>
      }
      secondary={<>{secondary}<Menu items={more} /></>}
      primary={primary}
    />
  )

  const notice = waiting ? (
    <InlineNotice tone="warn" title="Waiting for approval">
      Sales: {humanize(rfq.sales_approval_status || 'PENDING').toLowerCase()} · Procurement: {humanize(rfq.procurement_approval_status || 'PENDING').toLowerCase()}. It can be sent to the supplier once both approve.
    </InlineNotice>
  ) : rfq.is_overdue ? (
    <InlineNotice tone="risk" title="Response overdue">The supplier was due to answer by {formatDate(rfq.response_deadline)}. Log a follow-up or update the status.</InlineNotice>
  ) : null

  const tabs = [
    { id: 'lines', label: 'Lines', count: items.length },
    { id: 'details', label: 'Details' },
    { id: 'response', label: 'Supplier response' },
    { id: 'comms', label: 'Communications', count: comms.length },
  ]

  return (
    <>
      <DetailLayout
        header={header}
        notice={notice}
        summary={
          <SummaryStrip
            facts={[
              { label: 'Quoted', value: <Money amount={rfq.supplier_total_amount} currency={currency} />, hint: rfq.response_received_at ? `received ${formatDate(rfq.response_received_at)}` : 'no response yet' },
              { label: 'Supplier', value: supplierName || '—', hint: rfq.supplier_contact_person || rfq.supplier_email, to: rfq.supplier_id ? `/procurement/suppliers/${rfq.supplier_id}` : undefined },
              { label: 'Response due', value: <DateText value={rfq.response_deadline} />, hint: rfq.is_overdue ? `▲ ${Math.abs(due)} days overdue` : due != null && canRecord ? (due === 0 ? 'today' : due > 0 ? `in ${due} days` : `${Math.abs(due)} days ago`) : undefined },
              { label: 'Needed by', value: <DateText value={rfq.required_delivery_date} />, hint: rfq.delivery_location || undefined },
              { label: 'Priority', value: rfq.priority ? humanize(rfq.priority) : '—', hint: rfq.request_type ? humanize(rfq.request_type) : undefined },
            ]}
          />
        }
        aside={
          <>
            <Card title="History" padded>
              {historyLoading ? <p className="text-sm text-ink-500">Loading…</p> : <Timeline events={events} />}
            </Card>
            <RelatedPanel
              groups={[
                { label: 'Supplier', items: rfq.supplier_id ? [{ label: supplierName || 'Supplier', to: `/procurement/suppliers/${rfq.supplier_id}`, sublabel: rfq.supplier_email }] : [] },
                { label: 'Customer', items: rfq.linked_customer_id ? [{ label: rfq.customer_company_name || 'Customer', to: `/sales/customers/${rfq.linked_customer_id}` }] : [] },
                { label: 'Sales order', items: rfq.source_document_type === 'SALES_ORDER' && rfq.source_document_id ? [{ label: 'Source sales order', to: `/sales/sales-orders/${rfq.source_document_id}` }] : [] },
              ]}
            />
          </>
        }
      >
        <Tabs value={tab} onChange={setTab} label="RFQ sections" tabs={tabs}>
          {(t) => (
            <>
              {t === 'lines' && (
                <DataTable caption="RFQ lines" noun="line" rows={items} columns={lineColumns} search={items.length > 12} showCount={false} empty={{ title: 'No lines on this RFQ', description: 'Edit the RFQ to add what the supplier should price.' }} />
              )}
              {t === 'details' && (
                <Card>
                  <DescriptionList
                    items={[
                      { label: 'Request type', value: rfq.request_type ? humanize(rfq.request_type) : null },
                      { label: 'Required delivery', value: <DateText value={rfq.required_delivery_date} /> },
                      { label: 'Delivery location', value: rfq.delivery_location || null },
                      { label: 'Delivery terms', value: rfq.delivery_terms || null },
                      { label: 'Payment terms', value: rfq.payment_terms || null },
                      { label: 'Linked customer', value: rfq.customer_company_name || null },
                      { label: 'Supplier contact', value: [rfq.supplier_contact_person, rfq.supplier_email, rfq.supplier_phone].filter(Boolean).join(' · ') || null, wide: true },
                      { label: 'Special requirements', value: rfq.special_requirements ? <span className="whitespace-pre-wrap">{rfq.special_requirements}</span> : null, wide: true },
                      { label: 'Terms and conditions', value: rfq.terms_and_conditions ? <span className="whitespace-pre-wrap">{rfq.terms_and_conditions}</span> : null, wide: true },
                      { label: 'Internal notes', value: rfq.internal_notes ? <span className="whitespace-pre-wrap">{rfq.internal_notes}</span> : null, wide: true },
                      { label: 'Last updated', value: rfq.updated_at ? <><DateText value={rfq.updated_at} withTime />{rfq.updated_by_name ? ` by ${rfq.updated_by_name}` : ''}</> : null },
                    ]}
                  />
                </Card>
              )}
              {t === 'response' && (hasResponse || rfq.supplier_comments || rfq.supplier_alternative_items ? (
                <Card>
                  <DescriptionList
                    items={[
                      { label: 'Response received', value: rfq.response_received_at ? <DateText value={rfq.response_received_at} withTime /> : null },
                      { label: 'Quoted total', value: <Money amount={rfq.supplier_total_amount} currency={currency} /> },
                      { label: 'Validity', value: rfq.supplier_validity_days ? `${rfq.supplier_validity_days} days` : null },
                      { label: 'Currency', value: rfq.supplier_currency ? <Code>{rfq.supplier_currency}</Code> : null },
                      { label: 'Supplier comments', value: rfq.supplier_comments ? <span className="whitespace-pre-wrap">{rfq.supplier_comments}</span> : null, wide: true },
                      { label: 'Alternative items', value: rfq.supplier_alternative_items ? <span className="whitespace-pre-wrap">{rfq.supplier_alternative_items}</span> : null, wide: true },
                    ]}
                  />
                </Card>
              ) : (
                <EmptyState
                  compact
                  title="No supplier response yet"
                  description={canRecord ? 'When the supplier answers by email or phone, record their prices here. Answers through the supplier portal appear automatically.' : 'The supplier can respond once the RFQ is approved and sent.'}
                  action={canRecord ? <Button icon={InboxArrowDownIcon} onClick={() => openDialog('response')}>Record response</Button> : null}
                />
              ))}
              {t === 'comms' && (commsLoading ? <p className="text-sm text-ink-500">Loading…</p> : comms.length ? (
                <Card padded>
                  <Timeline
                    events={comms.map((c, i) => ({
                      id: c.id || i,
                      title: `${humanize(c.communication_type)}${c.direction ? ` · ${humanize(c.direction).toLowerCase()}` : ''}${c.subject ? ` — ${c.subject}` : ''}`,
                      actor: c.created_by_name,
                      at: c.created_at,
                      note: c.message_content,
                      tone: c.direction === 'INBOUND' ? 'brand' : 'ink',
                    }))}
                  />
                </Card>
              ) : (
                <EmptyState compact title="Nothing logged yet" description="Log calls, emails and notes with the supplier so the next person sees the whole conversation." action={<Button icon={ChatBubbleLeftRightIcon} onClick={() => openDialog('comm')}>Log communication</Button>} />
              ))}
            </>
          )}
        </Tabs>
      </DetailLayout>

      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={doConfirm}
          title={CONFIRMS[confirm].title}
          consequence={CONFIRMS[confirm].consequence}
          confirmLabel={CONFIRMS[confirm].label}
          tone="primary"
          busy={submit.isPending || sendToSupplier.isPending || createPo.isPending}
        />
      )}

      <Dialog
        open={dialog === 'status'}
        onClose={() => setDialog(null)}
        title={`Update status of ${rfq.rfq_number}`}
        description="For corrections the workflow does not cover. The change and reason are recorded in the history."
        footer={<><Button onClick={() => setDialog(null)} disabled={dialogBusy}>Cancel</Button><Button variant="primary" onClick={submitDialog} loading={dialogBusy}>Update status</Button></>}
      >
        <form onSubmit={submitDialog} className="space-y-3">
          {formError && <InlineNotice tone="risk">{formError}</InlineNotice>}
          <Field label="New status" required id="new-status">
            <Select value={statusForm.status} onChange={(e) => setStatusForm((f) => ({ ...f, status: e.target.value }))} data-autofocus>
              <option value="">Choose a status…</option>
              {STATUSES.map((s) => <option key={s} value={s} disabled={s === rfq.status}>{humanize(s)}</option>)}
            </Select>
          </Field>
          <Field label="Reason" optional help="Shown in the history." id="status-reason">
            <Textarea rows={3} value={statusForm.reason} onChange={(e) => setStatusForm((f) => ({ ...f, reason: e.target.value }))} />
          </Field>
        </form>
      </Dialog>

      <Dialog
        open={dialog === 'response'}
        onClose={() => setDialog(null)}
        title={`Record ${supplierName || 'supplier'}'s response`}
        description="For answers that came by email or phone rather than the supplier portal."
        footer={<><Button onClick={() => setDialog(null)} disabled={dialogBusy}>Cancel</Button><Button variant="primary" onClick={submitDialog} loading={dialogBusy}>Save response</Button></>}
      >
        <form onSubmit={submitDialog} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {formError && <InlineNotice tone="risk" className="sm:col-span-2">{formError}</InlineNotice>}
          <Field label="Total quoted" id="total-amount">
            <Input type="number" step="0.01" min="0" value={response.supplier_total_amount} onChange={(e) => setResponse((r) => ({ ...r, supplier_total_amount: e.target.value }))} data-autofocus />
          </Field>
          <Field label="Currency" id="response-currency">
            <Select value={response.supplier_currency} onChange={(e) => setResponse((r) => ({ ...r, supplier_currency: e.target.value }))}>
              {['USD', 'EUR', 'GBP', 'SAR'].map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
          <Field label="Valid for" optional id="validity-days">
            <Input type="number" min="0" value={response.supplier_validity_days} onChange={(e) => setResponse((r) => ({ ...r, supplier_validity_days: e.target.value }))} suffix="days" />
          </Field>
          <Field label="Supplier comments" optional className="sm:col-span-2" id="supplier-comments">
            <Textarea rows={3} value={response.supplier_comments} onChange={(e) => setResponse((r) => ({ ...r, supplier_comments: e.target.value }))} />
          </Field>
          <Field label="Alternative items" optional help="Anything the supplier offered instead." className="sm:col-span-2" id="alternative-items">
            <Textarea rows={2} value={response.supplier_alternative_items} onChange={(e) => setResponse((r) => ({ ...r, supplier_alternative_items: e.target.value }))} />
          </Field>
        </form>
      </Dialog>

      <Dialog
        open={dialog === 'comm'}
        onClose={() => setDialog(null)}
        title="Log communication"
        description={`A call, email or note with ${supplierName || 'the supplier'} about ${rfq.rfq_number}.`}
        footer={<><Button onClick={() => setDialog(null)} disabled={dialogBusy}>Cancel</Button><Button variant="primary" onClick={submitDialog} loading={dialogBusy}>Log it</Button></>}
      >
        <form onSubmit={submitDialog} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {formError && <InlineNotice tone="risk" className="sm:col-span-2">{formError}</InlineNotice>}
          <Field label="Type" id="communication-type">
            <Select value={comm.communication_type} onChange={(e) => setComm((c) => ({ ...c, communication_type: e.target.value }))}>
              <option value="EMAIL_SENT">Email sent</option>
              <option value="EMAIL_RECEIVED">Email received</option>
              <option value="PHONE_CALL">Phone call</option>
              <option value="SYSTEM_MESSAGE">System message</option>
              <option value="MANUAL_NOTE">Note</option>
            </Select>
          </Field>
          <Field label="Direction" id="direction">
            <Select value={comm.direction} onChange={(e) => setComm((c) => ({ ...c, direction: e.target.value }))}>
              <option value="OUTBOUND">Outbound — we contacted them</option>
              <option value="INBOUND">Inbound — they contacted us</option>
            </Select>
          </Field>
          <Field label="Subject" optional className="sm:col-span-2" id="subject">
            <Input value={comm.subject} onChange={(e) => setComm((c) => ({ ...c, subject: e.target.value }))} />
          </Field>
          <Field label="What was said" required className="sm:col-span-2" id="message-content">
            <Textarea rows={4} value={comm.message_content} onChange={(e) => setComm((c) => ({ ...c, message_content: e.target.value }))} />
          </Field>
        </form>
      </Dialog>
    </>
  )
}
