import { useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { ChevronRightIcon } from '@heroicons/react/20/solid'
import { JournalEntryLines } from '../../components/reports/GeneralLedgerDrilldown'
import { Card, Money, Sheet, InlineNotice, Dialog, Button, Field, Input, Select, ErrorSummary } from '../../components/ui'

/**
 * Small pieces shared by the receivables / payables / assets screens in this
 * folder: the aging bar, the "in this area" link list and the journal-lines
 * sheet, and the record-payment dialog. Kept here rather than in components/ui because they are finance
 * compositions, not design-system primitives.
 */

const BUCKETS = [
  { key: 'current_bucket', label: 'Current', fill: 'bg-ok-500' },
  { key: 'days_1_30', label: '1–30 days', fill: 'bg-ink-400' },
  { key: 'days_31_60', label: '31–60 days', fill: 'bg-warn-400' },
  { key: 'days_61_90', label: '61–90 days', fill: 'bg-warn-600' },
  { key: 'days_90_plus', label: '90+ days', fill: 'bg-risk-500' },
]

/**
 * AgingBar — one stacked bar of the outstanding balance by age, with the
 * buckets written out below it so the figures never depend on the colours.
 * `summary` is the aging endpoint's summary row (current_bucket, days_1_30…).
 */
export function AgingBar({ summary, empty, note, currency = 'USD' }) {
  if (!summary) {
    return <p className="text-sm text-ink-600">{note || 'The aging summary is not available.'}</p>
  }
  const total = BUCKETS.reduce((s, b) => s + (Number(summary[b.key]) || 0), 0)
  if (total <= 0) return <p className="text-sm text-ink-600">{empty}</p>
  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-sunken" aria-hidden="true">
        {BUCKETS.map((b) => {
          const w = ((Number(summary[b.key]) || 0) / total) * 100
          return w > 0 ? <span key={b.key} className={clsx('h-full', b.fill)} style={{ width: `${w}%` }} /> : null
        })}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-5">
        {BUCKETS.map((b) => (
          <div key={b.key} className="min-w-0">
            <dt className="flex items-center gap-1.5 text-xs text-ink-500">
              <span className={clsx('h-2 w-2 shrink-0 rounded-sm', b.fill)} aria-hidden="true" />
              {b.label}
            </dt>
            <dd className="mt-0.5 text-sm font-medium text-fg">
              <Money amount={summary[b.key]} currency={currency} digits={0} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** ModuleLinks — the screens that make up an area, as one quiet list. */
export function ModuleLinks({ title = 'In this area', items }) {
  return (
    <Card title={title} padded={false}>
      <ul className="divide-y divide-ink-100">
        {items.map((m) => (
          <li key={m.to + m.label}>
            <Link to={m.to} className="flex items-center gap-3 px-4 py-2.5 hover:bg-ink-50">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-fg">{m.label}</span>
                <span className="block truncate text-xs text-ink-500">{m.description}</span>
              </span>
              {m.aside}
              <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  )
}

/**
 * JournalLinesSheet — the posted journal lines behind one report row, in a
 * side sheet. Reuses the report drill-down's fetch (/journal-entries/:id).
 */
export function JournalLinesSheet({ open, onClose, title, description, journalEntryIds = [] }) {
  const ids = journalEntryIds.filter(Boolean)
  return (
    <Sheet open={open} onClose={onClose} title={title} description={description} width="lg">
      {ids.length === 0 ? (
        <InlineNotice>No journal entry is linked to this line yet.</InlineNotice>
      ) : (
        <div className="space-y-4">
          {ids.length > 1 && <p className="text-xs text-ink-500">{ids.length} journal entries. Each is listed below.</p>}
          {ids.map((id) => (
            <table key={id} className="w-full">
              <tbody>
                <JournalEntryLines journalEntryId={id} colSpan={1} />
              </tbody>
            </table>
          ))}
        </div>
      )}
    </Sheet>
  )
}

const PAYMENT_METHODS = ['BANK_TRANSFER', 'CASH', 'CHECK', 'CREDIT_CARD', 'ACH', 'WIRE_TRANSFER']

/**
 * RecordPaymentDialog — settle one invoice or bill. The amount defaults to the
 * outstanding balance and may not exceed it; the caller posts the payment.
 * onSubmit({ amount, method, reference }) returns a promise.
 */
export function RecordPaymentDialog({ open, onClose, title, description, outstanding, currency = 'USD', onSubmit, busy, submitLabel = 'Record payment' }) {
  const [amount, setAmount] = useState(() => (Number(outstanding) || 0).toFixed(2))
  const [method, setMethod] = useState('BANK_TRANSFER')
  const [reference, setReference] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  const amt = Number(amount)
  const amountError = !amt || amt <= 0
    ? 'Enter an amount greater than zero.'
    : amt - (Number(outstanding) || 0) > 0.01
      ? 'The amount is more than the outstanding balance.'
      : null
  const showError = (touched || submitted) ? amountError : null

  const submit = async (e) => {
    e?.preventDefault()
    setSubmitted(true)
    if (amountError) return
    await onSubmit({ amount: amt, method, reference: reference.trim() })
  }

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy}>{submitLabel}</Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {submitted && amountError && <ErrorSummary errors={{ 'payment-amount': amountError }} />}
        <p className="rounded-md bg-sunken px-3 py-2 text-sm text-ink-700">
          Outstanding balance <Money amount={outstanding} currency={currency} className="ml-1 font-semibold text-fg" />
        </p>
        <Field label="Amount" required error={showError} help="Defaults to the full outstanding balance.">
          <Input id="payment-amount" type="number" step="0.01" min="0" numeric value={amount} onChange={(e) => setAmount(e.target.value)} onBlur={() => setTouched(true)} />
        </Field>
        <Field label="Payment method" required>
          <Select value={method} onChange={(e) => setMethod(e.target.value)}>
            {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())}</option>)}
          </Select>
        </Field>
        <Field label="Reference" optional help="Cheque number or transfer reference.">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  )
}
