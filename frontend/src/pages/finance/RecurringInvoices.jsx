import { useMemo, useState } from 'react'
import { PlusIcon, PlayIcon, PauseIcon, StopIcon, ArrowPathRoundedSquareIcon, ArrowDownTrayIcon } from '@heroicons/react/20/solid'
import { recurringInvoicesAPI, customersAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { useI18n } from '../../contexts/I18nContext'
import {
  PageHeader, Button, DataTable, RowAction, StatusBadge, Badge, Money, Num, DateText, Stat, Segmented,
  ConfirmDialog, Dialog, Field, Input, Select, Combobox, FormSection, ErrorSummary, InlineNotice, ErrorState,
  exportCsv, notify, useDraft, formatMoney,
} from '../../components/ui'

/**
 * Recurring invoices — retainers and subscriptions billed on a schedule.
 *
 * Billing runs are previewed before they happen: generating invoices is much
 * easier to check first than to unpick afterwards, so "Run billing" is a dry
 * run and the real one is a second, deliberate step from the preview.
 */
const FREQUENCIES = [
  { value: 'MONTHLY', label: 'Monthly', perMonth: 1 },
  { value: 'QUARTERLY', label: 'Quarterly', perMonth: 1 / 3 },
  { value: 'ANNUALLY', label: 'Annually', perMonth: 1 / 12 },
]
const freqLabel = (f) => FREQUENCIES.find((x) => x.value === f)?.label || f
const gross = (s) => Number(s.amount || 0) + Number(s.tax_amount || 0)
const isDue = (s) => s.status === 'ACTIVE' && s.next_run_date && new Date(s.next_run_date) <= new Date()

const QUICK = {
  all: { label: 'All', test: () => true },
  active: { label: 'Active', test: (s) => s.status === 'ACTIVE' },
  due: { label: 'Due now', test: isDue },
  paused: { label: 'Paused', test: (s) => s.status === 'PAUSED' },
  cancelled: { label: 'Cancelled', test: (s) => s.status === 'CANCELLED' },
}

export default function RecurringInvoices() {
  const { t } = useI18n()
  const [quick, setQuick] = useState('all')
  const [createOpen, setCreateOpen] = useState(false)
  const [preview, setPreview] = useState(null)
  const [cancelFor, setCancelFor] = useState(null)

  const { data, loading, error, refetch } = useResource(['recurring-invoices', {}], () => recurringInvoicesAPI.list({}))
  const schedules = useMemo(() => (Array.isArray(data) ? data : []), [data])
  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, schedules.filter(q.test).length])), [schedules])

  const invalidates = [['recurring-invoices'], ['customer-invoices']]
  const setStatus = useResourceMutation(({ id, status }) => recurringInvoicesAPI.setStatus(id, status), { invalidates, silent: true })
  // The run endpoint answers flat ({ success, checked, created, errors }).
  const dryRun = useResourceMutation(async () => ({ data: { success: true, data: (await recurringInvoicesAPI.run(true)).data } }), { silent: true })
  const liveRun = useResourceMutation(async () => ({ data: { success: true, data: (await recurringInvoicesAPI.run(false)).data } }), { invalidates, silent: true })

  const active = schedules.filter((s) => s.status === 'ACTIVE')
  const dueNow = schedules.filter(isDue)
  // Quarterly and annual schedules are divided down so the figure is
  // comparable across frequencies rather than summing unlike terms.
  const monthly = active.reduce((sum, s) => sum + gross(s) * (FREQUENCIES.find((f) => f.value === s.frequency)?.perMonth ?? 1 / 12), 0)

  const changeStatus = async (s, status) => {
    try {
      await setStatus.mutateAsync({ id: s.id, status })
      if (status === 'CANCELLED') setCancelFor(null)
    } catch (e) {
      notify.error(`Schedule not updated: ${e?.response?.data?.error || e.message}`)
    }
  }

  const runPreview = async () => {
    try {
      setPreview(await dryRun.mutateAsync())
    } catch (e) {
      notify.error(`Could not check what is due: ${e?.response?.data?.error || e.message}`)
    }
  }

  const runLive = async () => {
    try {
      const res = await liveRun.mutateAsync()
      // `created` is the list of what was billed, not a count.
      const n = (res?.created || []).length
      notify.success(`${n} invoice${n === 1 ? '' : 's'} generated`)
      setPreview(null)
    } catch (e) {
      notify.error(`The billing run failed: ${e?.response?.data?.error || e.message}`)
    }
  }

  const columns = useMemo(() => [
    { id: 'customer', header: 'Customer', accessor: 'customer_name', filter: 'text', minWidth: 180, maxWidth: 260, mobile: 'title', cell: (s) => <span className="block truncate font-medium">{s.customer_name}</span> },
    { id: 'description', header: 'Description', accessor: 'description', minWidth: 200, maxWidth: 320, mobile: 'subtitle', cell: (s) => <span className="block truncate text-ink-700">{s.description}</span> },
    {
      id: 'amount', header: 'Per invoice', accessor: gross, align: 'right', filter: 'number', width: 150, mobile: 'trailing',
      cell: (s) => (
        <span className="block">
          <Money amount={gross(s)} currency={s.currency} />
          {Number(s.tax_amount) > 0 && <span className="block text-2xs text-ink-500">incl. <Money amount={s.tax_amount} currency={s.currency} /> tax</span>}
        </span>
      ),
      exportValue: gross,
    },
    { id: 'frequency', header: 'Every', accessor: (s) => freqLabel(s.frequency), filter: 'select', width: 110 },
    {
      id: 'next', header: 'Next invoice', accessor: 'next_run_date', width: 150, mobile: 'meta',
      cell: (s) => (
        <span className="flex items-center gap-1.5">
          <DateText value={s.next_run_date} />
          {isDue(s) && <Badge tone="warn" glyph="clock">Due</Badge>}
        </span>
      ),
    },
    { id: 'billed', header: 'Billed', accessor: (s) => Number(s.occurrences_run) || 0, align: 'right', width: 90, cell: (s) => <span className="tabular-nums">{s.occurrences_run ?? 0}{s.max_occurrences ? <span className="text-ink-500"> / {s.max_occurrences}</span> : ''}</span> },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 120, cell: (s) => <StatusBadge status={s.status} /> },
    { id: 'currency', header: 'Currency', accessor: 'currency', width: 90, defaultHidden: true },
  ], [])

  return (
    <>
      <PageHeader
        title={t('ui.recurringInvoices')}
        description="Retainers and subscriptions billed on a schedule. Run billing to see what is due before anything is invoiced."
        secondary={
          <>
            <Button icon={ArrowDownTrayIcon} disabled={!schedules.length} onClick={() => exportCsv(schedules.filter(QUICK[quick].test), columns, 'recurring-invoices.csv')}>Export</Button>
            <Button icon={PlayIcon} loading={dryRun.isPending} onClick={runPreview}>Run billing</Button>
          </>
        }
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setCreateOpen(true)}>New schedule</Button>}
      />

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Active schedules" value={<Num value={active.length} />} loading={loading} onClick={() => setQuick('active')} />
        <Stat label="Due now" value={<Num value={dueNow.length} />} loading={loading} onClick={() => setQuick('due')} reason={dueNow.length ? 'Waiting for a billing run.' : undefined} />
        <Stat label="Recurring revenue" value={<Money amount={monthly} digits={0} />} loading={loading} footnote="Per month, normalised across frequencies" />
      </div>

      <DataTable
        viewKey="finance.recurring-invoices"
        caption={t('ui.recurringInvoices')}
        noun="schedule"
        rows={schedules}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'next', dir: 'asc' }}
        searchPlaceholder="Search customer, description"
        rowClassName={(s) => (s.status === 'CANCELLED' ? 'text-ink-500' : undefined)}
        toolbarStart={<Segmented label="Show" value={quick} onChange={setQuick} options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))} className="max-w-full overflow-x-auto" />}
        rowActions={(s) => (
          <>
            {s.status === 'ACTIVE' && <RowAction icon={PauseIcon} label={`Pause billing for ${s.customer_name}`} onClick={() => changeStatus(s, 'PAUSED')} />}
            {s.status === 'PAUSED' && <RowAction icon={PlayIcon} label={`Resume billing for ${s.customer_name}`} onClick={() => changeStatus(s, 'ACTIVE')} />}
            {s.status !== 'CANCELLED' && <RowAction icon={StopIcon} tone="risk" label={`Cancel the schedule for ${s.customer_name}`} onClick={() => setCancelFor(s)} />}
          </>
        )}
        empty={{
          icon: ArrowPathRoundedSquareIcon,
          title: 'No recurring schedules yet',
          description: 'A schedule invoices a customer the same amount every month, quarter or year until you stop it.',
          action: <Button variant="primary" icon={PlusIcon} onClick={() => setCreateOpen(true)}>New schedule</Button>,
        }}
      />

      {createOpen && <CreateScheduleDialog onClose={() => setCreateOpen(false)} />}
      {preview && <BillingRunDialog preview={preview} onClose={() => setPreview(null)} onConfirm={runLive} running={liveRun.isPending} />}

      {cancelFor && (
        <ConfirmDialog
          open
          onClose={() => setCancelFor(null)}
          title={`Cancel the schedule for ${cancelFor.customer_name}?`}
          consequence={`"${cancelFor.description}" will not be invoiced again. Invoices already generated stay. This cannot be undone; pause it instead if billing may resume.`}
          confirmLabel="Cancel schedule"
          busy={setStatus.isPending}
          onConfirm={() => changeStatus(cancelFor, 'CANCELLED')}
        />
      )}
    </>
  )
}

function BillingRunDialog({ preview, onClose, onConfirm, running }) {
  const checked = preview?.checked ?? 0
  // The dry run returns the schedules it would bill, each with the customer
  // and the amount — who gets invoiced for what, not just how many.
  const pending = preview?.created || []
  const errors = preview?.errors || []
  const total = pending.reduce((sum, p) => sum + Number(p.amount || 0), 0)

  return (
    <Dialog
      open
      onClose={running ? undefined : onClose}
      title="Billing run"
      description="Preview. Nothing has been invoiced yet."
      footer={
        <>
          <Button onClick={onClose} disabled={running}>Close</Button>
          {pending.length > 0 && (
            <Button variant="primary" onClick={onConfirm} loading={running}>
              Generate {pending.length} invoice{pending.length === 1 ? '' : 's'}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-ink-200 bg-ink-200">
          <div className="bg-surface px-4 py-3">
            <dt className="label-mono">Invoices to create</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums text-fg">{pending.length}</dd>
          </div>
          <div className="bg-surface px-4 py-3">
            <dt className="label-mono">Total to bill</dt>
            <dd className="mt-1 text-xl font-semibold text-fg"><Money amount={total} /></dd>
          </div>
        </dl>

        {pending.length > 0 && (
          <ul className="max-h-64 divide-y divide-ink-100 overflow-y-auto rounded-lg border border-ink-200">
            {pending.map((p) => (
              <li key={p.schedule_id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="block truncate text-fg">{p.customer_name}</span>
                  <span className="block text-xs text-ink-500">Due <DateText value={p.next_run_date} /></span>
                </span>
                <Money amount={p.amount} />
              </li>
            ))}
          </ul>
        )}

        {errors.length > 0 && (
          <InlineNotice tone="risk" title={`${errors.length} schedule${errors.length === 1 ? '' : 's'} could not be billed`}>
            <ul className="mt-1 space-y-0.5">
              {errors.map((e, i) => (
                <li key={i} className="text-xs">{e.customer_name ? `${e.customer_name}: ` : ''}{e.error || String(e)}</li>
              ))}
            </ul>
          </InlineNotice>
        )}

        {checked === 0 && <p className="text-sm text-ink-600">Nothing is due right now. Schedules are billed on or after their next invoice date.</p>}
      </div>
    </Dialog>
  )
}

const today = () => new Date().toISOString().split('T')[0]
const INITIAL = {
  customer_id: '', description: '', amount: '', tax_amount: '', currency: 'USD', frequency: 'MONTHLY',
  next_run_date: today(), max_occurrences: '', notes: '',
}

function CreateScheduleDialog({ onClose }) {
  const { value: form, setValue: setForm, restored, clear, discard } = useDraft('recurring-invoice:new', INITIAL)
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [failure, setFailure] = useState(null)

  const { data: customersData, loading: customersLoading, error: customersError, refetch } = useResource(['customers', { limit: 500 }], () => customersAPI.getAll({ limit: 500 }))
  const customers = Array.isArray(customersData) ? customersData : []
  const create = useResourceMutation((payload) => recurringInvoicesAPI.create(payload), { invalidates: [['recurring-invoices']], silent: true })

  const errors = {
    'ri-customer': !form.customer_id ? 'Pick a customer.' : null,
    'ri-description': !form.description.trim() ? 'Describe what is being billed.' : null,
    'ri-amount': !(Number(form.amount) > 0) ? 'The amount must be more than zero.' : null,
    'ri-currency': !/^[A-Z]{3}$/.test(form.currency) ? 'Use a three-letter currency code, e.g. USD.' : null,
  }
  const show = (id) => (touched[id] || submitted ? errors[id] : null)
  const blur = (id) => () => setTouched((x) => ({ ...x, [id]: true }))

  const save = async () => {
    setSubmitted(true)
    if (Object.values(errors).some(Boolean)) return
    setFailure(null)
    try {
      await create.mutateAsync({
        customer_id: form.customer_id,
        description: form.description.trim(),
        amount: Number(form.amount),
        tax_amount: Number(form.tax_amount) || 0,
        currency: form.currency,
        frequency: form.frequency,
        next_run_date: form.next_run_date,
        max_occurrences: form.max_occurrences ? Number(form.max_occurrences) : null,
        notes: form.notes || null,
      })
      clear()
      onClose()
    } catch (e) {
      setFailure(e?.response?.data?.error || e.message)
    }
  }

  const total = (Number(form.amount) || 0) + (Number(form.tax_amount) || 0)

  return (
    <Dialog
      open
      size="lg"
      onClose={create.isPending ? undefined : onClose}
      title="New recurring schedule"
      description="Each run raises one invoice for this customer, for this amount."
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={create.isPending}>Create schedule</Button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); save() }} className="space-y-5" noValidate>
        {restored && (
          <InlineNotice action={<Button size="sm" variant="ghost" onClick={discard}>Discard draft</Button>}>
            Restored from a draft saved in this browser.
          </InlineNotice>
        )}
        {submitted && <ErrorSummary errors={errors} />}
        {failure && <InlineNotice tone="risk" title="The schedule was not created">{failure}</InlineNotice>}

        <FormSection title="Who and what" columns={1}>
          <Field label="Customer" required error={show('ri-customer')}>
            {customersError ? (
              <ErrorState compact error={customersError} what="Customers" onRetry={refetch} />
            ) : (
              <Combobox
                id="ri-customer"
                value={form.customer_id}
                onChange={(v) => { set('customer_id')(v || ''); setTouched((x) => ({ ...x, 'ri-customer': true })) }}
                placeholder={customersLoading ? 'Loading customers…' : 'Search customers'}
                disabled={customersLoading}
                options={customers.map((c) => ({ value: c.id, label: c.customer_name, meta: c.customer_code }))}
              />
            )}
          </Field>
          <Field label="Description" required error={show('ri-description')} help="Appears on every invoice this schedule raises.">
            <Input id="ri-description" value={form.description} onChange={(e) => set('description')(e.target.value)} onBlur={blur('ri-description')} placeholder="Monthly support retainer" />
          </Field>
        </FormSection>

        <FormSection title="Amount" columns={3}>
          <Field label="Amount" required error={show('ri-amount')}>
            <Input id="ri-amount" type="number" step="0.01" min="0" numeric value={form.amount} onChange={(e) => set('amount')(e.target.value)} onBlur={blur('ri-amount')} />
          </Field>
          <Field label="Tax" optional>
            <Input type="number" step="0.01" min="0" numeric value={form.tax_amount} onChange={(e) => set('tax_amount')(e.target.value)} />
          </Field>
          <Field label="Currency" required error={show('ri-currency')}>
            <Input id="ri-currency" value={form.currency} maxLength={3} onChange={(e) => set('currency')(e.target.value.toUpperCase().slice(0, 3))} onBlur={blur('ri-currency')} />
          </Field>
        </FormSection>
        {total > 0 && <p className="-mt-2 text-xs text-ink-500">Each invoice: {formatMoney(total, /^[A-Z]{3}$/.test(form.currency) ? form.currency : 'USD')}</p>}

        <FormSection title="Schedule" columns={3}>
          <Field label="Every" required>
            <Select value={form.frequency} onChange={(e) => set('frequency')(e.target.value)}>
              {FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </Select>
          </Field>
          <Field label="First invoice" required>
            <Input type="date" value={form.next_run_date} onChange={(e) => set('next_run_date')(e.target.value)} />
          </Field>
          <Field label="Stop after" optional help="Number of invoices. Blank means never.">
            <Input type="number" min="1" numeric value={form.max_occurrences} onChange={(e) => set('max_occurrences')(e.target.value)} />
          </Field>
        </FormSection>

        <FormSection title="Notes" advanced columns={1}>
          <Field label="Internal notes" optional>
            <Input value={form.notes} onChange={(e) => set('notes')(e.target.value)} />
          </Field>
        </FormSection>
      </form>
    </Dialog>
  )
}
