import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api, { journalEntriesAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, Field, Input, FormSection, ErrorSummary, LineItemEditor, InlineNotice, Money, useDraft, notify,
} from '../../components/ui'

/**
 * New journal entry.
 *
 * Lines are a sheet: Tab across, Enter down, paste rows from a spreadsheet
 * (account code, debit, credit, note — account codes are matched to the chart).
 * The balance updates as you type and the entry cannot be saved unbalanced.
 * Payload and rules are the same as before; the form also autosaves locally.
 */
const LEDGER_INVALIDATES = [['journal-entries'], ['journal-entries', 'stats'], ['trial-balance'], ['balance-sheet'], ['income-statement']]
const today = () => new Date().toLocaleDateString('en-CA')
const line = () => ({ _key: `${Date.now()}-${Math.random()}`, account_id: '', debit: '', credit: '', description: '' })
const INITIAL = { entryDate: today(), description: '', reference: '', items: [line(), line()] }

export default function JournalEntryForm() {
  const navigate = useNavigate()
  const { value, setValue, restored, savedAt, clear, discard } = useDraft('journal-entry:new', INITIAL)
  const { entryDate, description, reference, items } = value
  const set = (patch) => setValue((v) => ({ ...v, ...patch }))
  const [submitted, setSubmitted] = useState(false)
  const [touched, setTouched] = useState({})

  const { data: accountsData } = useResource(keys.chartOfAccounts({}), ({ signal }) => api.get('/chart-of-accounts', { signal }))
  const accounts = useMemo(() => (Array.isArray(accountsData) ? accountsData : []), [accountsData])
  const accountOptions = useMemo(() => accounts.map((a) => ({ value: a.id, label: `${a.account_code} · ${a.account_name}` })), [accounts])

  const create = useResourceMutation((data) => journalEntriesAPI.create(data), { invalidates: LEDGER_INVALIDATES, silent: true })
  const [serverError, setServerError] = useState(null)

  const totals = useMemo(() => items.reduce((t, i) => ({ d: t.d + (parseFloat(i.debit) || 0), c: t.c + (parseFloat(i.credit) || 0) }), { d: 0, c: 0 }), [items])
  const diff = totals.d - totals.c
  const balanced = Math.abs(diff) <= 0.01 && totals.d > 0

  const { headErrors, lineErrors } = useMemo(() => {
    const h = {}
    const l = {}
    if (!entryDate) h.entry_date = 'Choose the date the entry belongs to.'
    if (!description.trim()) h.je_description = 'Say what this entry is for — it appears on every report line.'
    items.forEach((it, i) => {
      const e = {}
      const d = parseFloat(it.debit) || 0
      const c = parseFloat(it.credit) || 0
      const blank = !it.account_id && !d && !c && !it.description
      if (blank && items.length > 2) return
      if (!it.account_id) e.account_id = 'Choose an account'
      if (d > 0 && c > 0) e.credit = 'Debit or credit, not both'
      if (d <= 0 && c <= 0) e.debit = 'Enter a debit or a credit'
      if (Object.keys(e).length) l[i] = e
    })
    return { headErrors: h, lineErrors: l }
  }, [entryDate, description, items])

  const shownHead = submitted ? headErrors : Object.fromEntries(Object.entries(headErrors).filter(([k]) => touched[k]))
  const summary = submitted
    ? [
        ...Object.entries(headErrors).map(([id, message]) => ({ id, message })),
        ...Object.entries(lineErrors).flatMap(([i, e]) => Object.values(e).map((m) => ({ id: 'je-lines', message: `Line ${Number(i) + 1}: ${m.toLowerCase()}` }))),
        ...(!balanced && !Object.keys(lineErrors).length ? [{ id: 'je-lines', message: totals.d === 0 ? 'Enter at least one debit and one credit.' : `Debits and credits differ by ${new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(Math.abs(diff))}. Adjust a line so they match.` }] : []),
      ]
    : []

  const save = async (e) => {
    e?.preventDefault()
    setSubmitted(true)
    setServerError(null)
    if (Object.keys(headErrors).length || Object.keys(lineErrors).length || !balanced) return
    const used = items.filter((it) => it.account_id || parseFloat(it.debit) || parseFloat(it.credit))
    try {
      await create.mutateAsync({
        entry_date: entryDate,
        description: description.trim(),
        reference: reference.trim() || undefined,
        items: used.map((it) => {
          const d = parseFloat(it.debit || 0)
          const c = parseFloat(it.credit || 0)
          return { account_id: it.account_id, debit_amount: d > 0 ? d : undefined, credit_amount: c > 0 ? c : undefined, description: it.description.trim() || undefined }
        }),
      })
      clear()
      notify.success('Journal entry saved as a draft')
      navigate('/finance/journal-entries')
    } catch (err) {
      const d = err?.response?.data || {}
      setServerError({ message: d.error || err.message, reference: d.error_id })
    }
  }

  return (
    <form onSubmit={save} noValidate className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="New journal entry"
        description="A manual entry to the general ledger. Debits must equal credits."
        meta={savedAt ? <span aria-live="polite">Draft saved in this browser {new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> : null}
      />
      {restored && (
        <InlineNotice tone="ink" title="Picked up where you left off" action={<Button size="sm" variant="ghost" onClick={discard}>Start over</Button>}>
          This entry was restored from a draft saved in this browser.
        </InlineNotice>
      )}
      {serverError && (
        <InlineNotice tone="risk" title="The entry was not saved">
          {serverError.message} Your lines are still here.{serverError.reference && <> Reference <span className="font-mono">{serverError.reference}</span>.</>}
        </InlineNotice>
      )}
      <ErrorSummary errors={summary} />

      <FormSection title="Entry" columns={3}>
        <Field label="Date" required error={shownHead.entry_date} id="entry_date">
          <Input type="date" value={entryDate} onChange={(e) => set({ entryDate: e.target.value })} onBlur={() => setTouched((t) => ({ ...t, entry_date: true }))} />
        </Field>
        <Field label="Description" required error={shownHead.je_description} className="sm:col-span-2" id="je_description">
          <Input value={description} onChange={(e) => set({ description: e.target.value })} onBlur={() => setTouched((t) => ({ ...t, je_description: true }))} placeholder="What is this entry for?" />
        </Field>
        <Field label="Reference" optional help="An invoice, contract or ticket number." id="reference">
          <Input value={reference} onChange={(e) => set({ reference: e.target.value })} className="font-mono" />
        </Field>
      </FormSection>

      <section aria-labelledby="je-lines-h" id="je-lines" tabIndex={-1} className="space-y-2">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="je-lines-h" className="text-sm font-semibold text-fg">Lines</h2>
            <p className="text-xs text-ink-500">Paste from a spreadsheet as: account code ⇥ debit ⇥ credit ⇥ note.</p>
          </div>
          <p role="status" aria-live="polite" className={balanced ? 'flex items-center gap-1.5 text-sm font-medium text-ok-600' : 'flex items-center gap-1.5 text-sm font-medium text-risk-600'}>
            <span aria-hidden="true">{balanced ? '✓' : '▲'}</span>
            {balanced ? 'Balanced' : totals.d === 0 && totals.c === 0 ? 'Nothing entered yet' : <>Out of balance by <Money amount={Math.abs(diff)} /></>}
          </p>
        </div>
        <LineItemEditor
          label="Journal lines"
          rows={items}
          onChange={(rows) => set({ items: rows })}
          newRow={line}
          minRows={1}
          errors={submitted ? lineErrors : {}}
          transform={(row, key, val) => {
            // One side per line: typing a debit clears the credit and vice versa.
            if (key === 'debit' && val) return { ...row, credit: '' }
            if (key === 'credit' && val) return { ...row, debit: '' }
            if (key === 'account_id' && val && !accounts.some((a) => a.id === val)) {
              const byCode = accounts.find((a) => String(a.account_code) === String(val).trim())
              return byCode ? { ...row, account_id: byCode.id } : row
            }
            return row
          }}
          columns={[
            { key: 'account_id', header: 'Account', type: 'select', options: accountOptions, minWidth: 260, required: true, placeholder: 'Choose an account' },
            { key: 'debit', header: 'Debit', type: 'money', width: 140, total: true },
            { key: 'credit', header: 'Credit', type: 'money', width: 140, total: true },
            { key: 'description', header: 'Line note', type: 'text', minWidth: 200, placeholder: 'Optional' },
          ]}
        />
        {accounts.length === 0 && (
          <InlineNotice tone="warn">No ledger accounts are visible to you. Set up the chart of accounts before posting entries.</InlineNotice>
        )}
      </section>

      <div className="sticky bottom-0 z-10 -mx-4 border-t border-ink-200 bg-canvas/95 px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <p className="mr-auto text-sm text-ink-600">
            Debits <Money amount={totals.d} className="font-semibold text-fg" /> · Credits <Money amount={totals.c} className="font-semibold text-fg" />
          </p>
          <Button variant="ghost" onClick={() => navigate('/finance/journal-entries')}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>Save entry</Button>
        </div>
      </div>
    </form>
  )
}
