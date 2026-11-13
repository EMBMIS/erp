import { useMemo, useState } from 'react'
import { PlusIcon, CheckCircleIcon, PaperAirplaneIcon, BookOpenIcon, ArrowDownTrayIcon, ReceiptRefundIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useI18n } from '../../contexts/I18nContext'
import {
  PageHeader, Button, DataTable, RowAction, BulkAction, StatusBadge, Badge, Money, Code, DateText, Segmented,
  ConfirmDialog, Dialog, Field, Select, Textarea, ErrorSummary, InlineNotice, DocumentLink,
  exportCsv, notify, formatMoney,
} from '../../components/ui'

/**
 * Credit notes — sales credit memos for returns, damage, price adjustments
 * and goodwill. A note is drafted against an invoice, submitted, approved,
 * then posted: posting reverses the revenue and, for a stock return, puts the
 * items back on the shelf. The list shows the newest 100 (the endpoint's cap).
 */
const REASONS = [
  { value: 'RETURN', label: 'Return' },
  { value: 'DAMAGE', label: 'Damage' },
  { value: 'PRICE_ADJUSTMENT', label: 'Price adjustment' },
  { value: 'GOODWILL', label: 'Goodwill' },
]
const reasonLabel = (r) => REASONS.find((x) => x.value === r)?.label || r || '—'
const EMPTY = { customer_invoice_id: '', customer_id: '', reason: '', return_type: 'CREDIT_ONLY', notes: '', items: [] }

// A posted credit note reverses revenue and (optionally) returns stock — both
// flow through the ledger, so every derived financial report is invalidated
// alongside the credit notes list itself.
const CREDIT_NOTE_INVALIDATES = [['credit-notes'], ['trial-balance'], ['balance-sheet'], ['income-statement'], ['journal-entries']]

const QUICK = {
  all: { label: 'All', test: () => true },
  draft: { label: 'Drafts', test: (n) => n.status === 'DRAFT' },
  waiting: { label: 'Waiting approval', test: (n) => n.status === 'PENDING_APPROVAL' },
  toPost: { label: 'To post', test: (n) => n.status === 'APPROVED' },
  posted: { label: 'Posted', test: (n) => n.status === 'POSTED' },
}

export default function CreditNotesList() {
  const { t } = useI18n()
  const [quick, setQuick] = useState('all')
  const [showCreate, setShowCreate] = useState(false)
  const [postFor, setPostFor] = useState(null)

  const { data, loading, error, refetch } = useResource(
    keys.creditNotes('sales'),
    ({ signal }) => api.get('/credit-notes/sales', { signal }),
    { staleTime: 0 }
  )
  const notes = useMemo(() => (Array.isArray(data) ? data : []), [data])
  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, notes.filter(q.test).length])), [notes])

  const postNote = useResourceMutation((id) => api.post(`/credit-notes/sales/${id}/post`), { invalidates: CREDIT_NOTE_INVALIDATES })
  const submitNote = useResourceMutation((id) => api.post(`/credit-notes/sales/${id}/submit-for-approval`), { invalidates: [['credit-notes']] })
  const approveNote = useResourceMutation((id) => api.post(`/credit-notes/sales/${id}/approve`), { invalidates: [['credit-notes']] })

  const columns = useMemo(() => [
    { id: 'number', header: 'Credit note', accessor: 'credit_note_number', cell: (n) => <Code>{n.credit_note_number}</Code>, width: 160, mobile: 'title' },
    { id: 'reason', header: 'Reason', accessor: (n) => reasonLabel(n.reason), filter: 'select', width: 150, mobile: 'subtitle' },
    {
      id: 'type', header: 'Type', accessor: (n) => (n.return_type === 'STOCK_RETURN' ? 'Stock return' : 'Credit only'), filter: 'select', width: 130,
      cell: (n) => (n.return_type === 'STOCK_RETURN' ? <Badge glyph="square">Stock return</Badge> : <span className="text-ink-600">Credit only</span>),
    },
    { id: 'invoice', header: 'Invoice', accessor: 'customer_invoice_id', width: 120, cell: (n) => (n.customer_invoice_id ? <DocumentLink type="customer_invoice" id={n.customer_invoice_id}>Open invoice</DocumentLink> : <span className="text-ink-400">—</span>) },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 170, mobile: 'meta', cell: (n) => <StatusBadge status={n.status} /> },
    { id: 'date', header: 'Date', accessor: 'credit_date', width: 120, cell: (n) => <DateText value={n.credit_date} /> },
    {
      id: 'total', header: 'Total', accessor: (n) => Number(n.total_amount), align: 'right', filter: 'number', width: 130, mobile: 'trailing',
      cell: (n) => <Money amount={n.total_amount} currency={n.currency} />, exportValue: (n) => n.total_amount,
      footer: (rows) => <Money amount={rows.reduce((s, r) => s + (Number(r.total_amount) || 0), 0)} />,
    },
    { id: 'notes', header: 'Notes', accessor: 'notes', defaultHidden: true, minWidth: 200 },
  ], [])

  const run = async (mutation, n) => {
    try { await mutation.mutateAsync(n.id) } catch { /* useResourceMutation surfaced the error */ }
  }

  return (
    <>
      <PageHeader
        title={t('ui.creditNotes')}
        description="Sales credit memos: returns, damage, price adjustments and goodwill. Drafted, approved, then posted to the ledger."
        secondary={<Button icon={ArrowDownTrayIcon} disabled={!notes.length} onClick={() => exportCsv(notes.filter(QUICK[quick].test), columns, 'credit-notes.csv')}>Export</Button>}
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setShowCreate(true)}>{t('ui.newCreditNote')}</Button>}
      />

      {notes.length >= 100 && (
        <InlineNotice tone="warn" className="mb-3" title="Showing the newest 100 credit notes">
          Older notes are still in the ledger.
        </InlineNotice>
      )}

      <DataTable
        viewKey="finance.credit-notes"
        caption={t('ui.creditNotes')}
        noun="credit note"
        rows={notes}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'date', dir: 'desc' }}
        searchPlaceholder="Search number, reason, notes"
        toolbarStart={<Segmented label="Show" value={quick} onChange={setQuick} options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))} className="max-w-full overflow-x-auto" />}
        selectable
        bulkActions={(sel) => <BulkAction icon={ArrowDownTrayIcon} onClick={() => exportCsv(sel, columns, 'credit-notes-selected.csv')}>Export {sel.length}</BulkAction>}
        rowActions={(n) => (
          <>
            {n.status === 'DRAFT' && <RowAction icon={PaperAirplaneIcon} label={`Submit ${n.credit_note_number} for approval`} disabled={submitNote.isPending} onClick={() => run(submitNote, n)} />}
            {n.status === 'PENDING_APPROVAL' && <RowAction icon={CheckCircleIcon} label={`Approve ${n.credit_note_number}`} disabled={approveNote.isPending} onClick={() => run(approveNote, n)} />}
            {n.status === 'APPROVED' && <RowAction icon={BookOpenIcon} label={`Post ${n.credit_note_number} to the ledger`} onClick={() => setPostFor(n)} />}
          </>
        )}
        empty={{
          icon: ReceiptRefundIcon,
          title: 'No credit notes yet',
          description: 'A credit note reduces what a customer owes on an approved invoice: for a return, damage, a price adjustment or goodwill.',
          action: <Button variant="primary" icon={PlusIcon} onClick={() => setShowCreate(true)}>{t('ui.newCreditNote')}</Button>,
        }}
      />

      {showCreate && <CreateCreditNoteDialog onClose={() => setShowCreate(false)} />}

      {postFor && (
        <ConfirmDialog
          open
          tone="primary"
          onClose={() => setPostFor(null)}
          title={`Post ${postFor.credit_note_number}?`}
          consequence={`Revenue of ${formatMoney(postFor.total_amount, postFor.currency || 'USD')} is reversed in the ledger${postFor.return_type === 'STOCK_RETURN' ? ' and the returned items go back into stock' : ''}. A posted note cannot be edited.`}
          confirmLabel="Post credit note"
          busy={postNote.isPending}
          onConfirm={async () => {
            try {
              await postNote.mutateAsync(postFor.id)
              notify.success(`${postFor.credit_note_number} posted`)
              setPostFor(null)
            } catch { /* surfaced by the mutation */ }
          }}
        />
      )}
    </>
  )
}

function CreateCreditNoteDialog({ onClose }) {
  const [form, setForm] = useState(EMPTY)
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)

  // The backend filters customer_invoices by exact status (=), so a
  // comma-joined filter never matches. Credit notes can be raised against
  // APPROVED or PARTIALLY_PAID invoices, so fetch both and merge.
  const approved = useResource(keys.customerInvoices('APPROVED'), ({ signal }) => api.get('/customer-invoices', { params: { status: 'APPROVED' }, signal }))
  const partial = useResource(keys.customerInvoices('PARTIALLY_PAID'), ({ signal }) => api.get('/customer-invoices', { params: { status: 'PARTIALLY_PAID' }, signal }))
  const invoices = [...(approved.data || []), ...(partial.data || [])]
  const invoicesLoading = approved.loading || partial.loading

  const createNote = useResourceMutation((payload) => api.post('/credit-notes/sales', payload), { invalidates: [['credit-notes']] })

  const errors = {
    'cn-invoice': !form.customer_invoice_id ? 'Choose the invoice to credit.' : null,
    'cn-reason': !form.reason ? 'Choose a reason.' : null,
  }
  const show = (id) => (touched[id] || submitted ? errors[id] : null)
  const blur = (id) => () => setTouched((x) => ({ ...x, [id]: true }))

  const submit = async (e) => {
    e?.preventDefault()
    setSubmitted(true)
    if (errors['cn-invoice'] || errors['cn-reason']) return
    try {
      await createNote.mutateAsync(form)
      onClose()
    } catch {
      // useResourceMutation already surfaced the error.
    }
  }

  return (
    <Dialog
      open
      size="lg"
      onClose={createNote.isPending ? undefined : onClose}
      title="New sales credit note"
      description="Saved as a draft. It changes nothing in the ledger until it is approved and posted."
      footer={
        <>
          <Button onClick={onClose} disabled={createNote.isPending}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={createNote.isPending}>Create draft</Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {submitted && <ErrorSummary errors={errors} />}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Customer invoice" required error={show('cn-invoice')} help={!invoicesLoading && !invoices.length ? 'No approved or partly paid invoices to credit.' : 'Approved or partly paid invoices.'}>
            <Select
              id="cn-invoice"
              value={form.customer_invoice_id}
              disabled={invoicesLoading}
              onBlur={blur('cn-invoice')}
              onChange={(e) => {
                const inv = invoices.find((i) => i.id === e.target.value)
                setForm({ ...form, customer_invoice_id: e.target.value, customer_id: inv?.customer_id || '' })
              }}
            >
              <option value="">{invoicesLoading ? 'Loading invoices…' : 'Choose an invoice…'}</option>
              {invoices.map((i) => (
                <option key={i.id} value={i.id}>{i.invoice_number} · {i.customer_name} · {formatMoney(i.outstanding_amount || i.total_amount, i.currency || 'USD')}</option>
              ))}
            </Select>
          </Field>
          <Field label="Reason" required error={show('cn-reason')}>
            <Select id="cn-reason" value={form.reason} onBlur={blur('cn-reason')} onChange={(e) => setForm({ ...form, reason: e.target.value })}>
              <option value="">Choose…</option>
              {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </Select>
          </Field>
        </div>
        <fieldset>
          <legend className="mb-1 text-sm font-medium text-ink-800">What happens to the goods</legend>
          <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
            <label className="flex items-center gap-2 text-sm text-ink-800">
              <input type="radio" name="cn-return-type" value="CREDIT_ONLY" checked={form.return_type === 'CREDIT_ONLY'} onChange={(e) => setForm({ ...form, return_type: e.target.value })} className="h-4 w-4 accent-brand-600" />
              Credit only
            </label>
            <label className="flex items-center gap-2 text-sm text-ink-800">
              <input type="radio" name="cn-return-type" value="STOCK_RETURN" checked={form.return_type === 'STOCK_RETURN'} onChange={(e) => setForm({ ...form, return_type: e.target.value })} className="h-4 w-4 accent-brand-600" />
              Stock return (puts items back)
            </label>
          </div>
        </fieldset>
        <Field label="Notes" optional>
          <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
      </form>
    </Dialog>
  )
}
