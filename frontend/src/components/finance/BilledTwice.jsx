import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { DocumentDuplicateIcon, HandRaisedIcon, SparklesIcon, CheckCircleIcon } from '@heroicons/react/20/solid'

import { supplierInvoicesAPI } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { Card, Badge, Button, ConfirmDialog, Field, Input, notify } from '../ui'

/**
 * An invoice arrives twice — and is not paid twice.
 *
 * The same check Simeli answers "is INV-7731 a duplicate?" from
 * (GET /api/supplier-invoices/billed-twice, services/billedTwice.js): each bill
 * that looks like a second copy, or bills more than was received, comes back
 * with the chain of evidence — the bill, the order it matches and what was
 * already billed on it, the goods received once, the earlier bill and when it
 * was paid. Nothing here changes anything until a finance manager, manager or
 * admin places the hold; then no payment can be allocated to the bill and the
 * payment run leaves it out.
 */

const HOLDERS = new Set(['ADMIN', 'MANAGER', 'FINANCE_MANAGER'])

const VERDICT = {
  duplicate: { label: 'Second copy', tone: 'risk' },
  overbilled: { label: 'Billed beyond receipt', tone: 'risk' },
  possible_duplicate: { label: 'Same amount', tone: 'warn' },
  clear: { label: 'No duplicate', tone: 'ok' },
}

const LAYER = { finance: 'Finance', procurement: 'Procurement', warehouse: 'Warehouse' }
const TONE = { risk: 'text-risk-700', warn: 'text-warn-700' }

const ask = (q) => `/ai/chat?q=${encodeURIComponent(q)}`

function recordHref(r) {
  if (!r?.id) return null
  if (r.type === 'purchase_order') return `/procurement/purchase-orders/${r.id}`
  if (r.type === 'supplier_invoice') return `/finance/supplier-invoices?invoice=${r.id}`
  return null
}

function money(v, cur) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD' }).format(v || 0)
  } catch {
    return `${Number(v || 0).toFixed(2)} ${cur || ''}`
  }
}

function BillCheck({ r, canHold, onHold, onRelease }) {
  const v = VERDICT[r.verdict] || VERDICT.clear
  const hold = r.proposals.find((p) => p.action === 'hold_payment')
  const note = r.proposals.find((p) => p.action === 'ask_supplier')
  const ref = r.bill.vendor_ref || r.bill.bill_number
  return (
    <li className="rounded-md border border-ink-200 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link to={`/finance/supplier-invoices?invoice=${r.bill.id}`} className="font-mono text-xs font-medium text-fg hover:underline">{r.bill.bill_number}</Link>
        <span className="text-xs text-ink-600">{r.bill.supplier}</span>
        <Badge tone={v.tone}>{v.label}</Badge>
        {r.bill.payment_hold && <Badge tone="warn">Payment on hold</Badge>}
        {r.unpaid_at_stake > 0 && !r.bill.payment_hold && <span className="ml-auto font-mono text-xs text-risk-700">{money(r.unpaid_at_stake, r.bill.currency)} payable</span>}
      </div>
      <p className="mt-1.5 text-sm text-ink-800">{r.headline}</p>
      {r.chain.length > 1 && (
        <ol className="mt-2 space-y-1 border-l border-ink-200 pl-3">
          {r.chain.map((s, i) => {
            const href = recordHref(s.record)
            return (
              <li key={i} className={`text-xs ${TONE[s.tone] || 'text-ink-700'}`}>
                <span className="label-mono mr-1.5 text-ink-400">{LAYER[s.layer] || s.layer}</span>
                {href ? <Link to={href} className="hover:underline">{s.text}</Link> : s.text}
              </li>
            )
          })}
        </ol>
      )}
      {r.bill.payment_hold && r.bill.hold_reason && (
        <p className="mt-2 text-xs text-ink-600">Held{r.bill.held_by ? ` by ${r.bill.held_by}` : ''}: {r.bill.hold_reason}</p>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {hold && canHold && <Button size="sm" variant="primary" icon={HandRaisedIcon} onClick={() => onHold(r, hold)}>{hold.label}</Button>}
        {hold && !canHold && <span className="text-xs text-ink-500">Simeli proposes a payment hold — a finance manager, manager or admin approves it.</span>}
        {r.bill.payment_hold && canHold && <Button size="sm" onClick={() => onRelease(r)}>Release hold</Button>}
        {note && (
          <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard?.writeText(`${note.draft.subject}\n\n${note.draft.body}`); notify.success('Note to the supplier copied') }}>
            {note.label}
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={SparklesIcon} to={ask(`Is ${ref} from ${r.bill.supplier} a duplicate? Walk me through it.`)}>Ask Simeli</Button>
      </div>
    </li>
  )
}

/**
 * focusId set: the check for that one bill, always shown. Otherwise: every
 * open bill that looks billed twice, and every bill on hold — or nothing.
 */
export default function BilledTwice({ focusId, onChanged }) {
  const { user } = useAuth()
  const canHold = HOLDERS.has(String(user?.role || '').toUpperCase())
  const [state, setState] = useState({ loading: true, data: null, error: null })
  const [holding, setHolding] = useState(null)
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState('')

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }))
    try {
      const res = focusId ? await supplierInvoicesAPI.billedTwice(focusId) : await supplierInvoicesAPI.billedTwiceScan()
      setState({ loading: false, data: res.data?.data, error: null })
    } catch (e) {
      setState({ loading: false, data: null, error: e?.response?.status === 403 ? null : (e?.response?.data?.error || 'Could not check bills for duplicates.') })
    }
  }, [focusId])

  useEffect(() => { load() }, [load])

  const confirmHold = async () => {
    setBusy(true)
    try {
      const res = await supplierInvoicesAPI.holdPayment(holding.r.bill.id, reason || holding.p.args.reason)
      notify.success(res.data?.data?.message || 'Payment held')
      setHolding(null)
      await load()
      onChanged?.()
    } catch (e) {
      notify.error(`Not held: ${e?.response?.data?.error || e.message}`)
    } finally {
      setBusy(false)
    }
  }

  const release = async (r) => {
    try {
      const res = await supplierInvoicesAPI.releasePaymentHold(r.bill.id)
      notify.success(res.data?.data?.message || 'Hold released')
      await load()
      onChanged?.()
    } catch (e) {
      notify.error(`Not released: ${e?.response?.data?.error || e.message}`)
    }
  }

  const { loading, data, error } = state
  if (loading && !data) return null
  if (error) return null
  if (!data) return null

  const checks = focusId ? [data] : data.bills || []
  if (!focusId && !checks.length) return null

  return (
    <>
      <Card
        className="mb-4"
        eyebrow="Simeli · payables"
        title={focusId ? 'Is this bill billed twice?' : 'Bills that look billed twice'}
        description={focusId ? 'The supplier\'s other bills, the order, the goods received and what was paid.' : data.headline}
        actions={<DocumentDuplicateIcon className="h-4 w-4 text-ink-400" aria-hidden="true" />}
      >
        {focusId && data.verdict === 'clear' && !data.bill.payment_hold ? (
          <p className="flex items-center gap-2 text-sm text-ink-800"><CheckCircleIcon className="h-4 w-4 text-ok-600" aria-hidden="true" />{data.headline}</p>
        ) : (
          <ul className="space-y-2">
            {checks.map((r) => (
              <BillCheck key={r.bill.id} r={r} canHold={canHold} onHold={(rr, p) => { setReason(p.args.reason); setHolding({ r: rr, p }) }} onRelease={release} />
            ))}
          </ul>
        )}
        <p className="mt-3 text-2xs text-ink-500">
          Read from {focusId ? data.sources.join('; ') : 'this company\'s supplier bills, purchase orders, goods receipts and payments'}. Simeli proposes; nothing is held until a person approves.
        </p>
      </Card>

      <ConfirmDialog
        open={!!holding}
        onClose={() => setHolding(null)}
        onConfirm={confirmHold}
        title={holding ? holding.p.label : ''}
        consequence={holding ? `No payment can be allocated to ${holding.r.bill.bill_number} (${money(holding.r.bill.outstanding, holding.r.bill.currency)} outstanding), and the payment run leaves it out, until someone releases the hold.` : ''}
        reversible
        tone="primary"
        confirmLabel="Hold payment"
        busy={busy}
      >
        <Field label="Reason">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </>
  )
}
