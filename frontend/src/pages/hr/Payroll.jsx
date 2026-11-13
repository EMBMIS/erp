import { useMemo, useState } from 'react'
import { PlusIcon, BanknotesIcon, CheckCircleIcon, BookOpenIcon, EyeIcon } from '@heroicons/react/20/solid'
import { hrAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import {
  PageHeader, Button, DataTable, RowAction, StatusBadge, Money, Num, Code, Dialog, Sheet, ConfirmDialog, Field, Input,
  Select, InlineNotice, DescriptionList, SkeletonRows, ErrorState, notify,
} from '../../components/ui'

/**
 * Payroll — monthly runs, from calculation to the ledger to the bank.
 *
 *   Draft      calculated; nothing posted
 *   Processed  approved by someone other than the person who ran it
 *   Posted     accrued to the general ledger
 *   Paid       net pay settled from cash
 *
 * Each step after the draft writes to the books, so each one asks first.
 */
const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const humanize = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
// PROCESSED is this module's word for "approved"; the badge takes the canonical tone.
const badge = (status) => <StatusBadge status={status === 'PROCESSED' ? 'APPROVED' : status} label={humanize(status)} />
const KEY = ['hr-payroll']

const STEPS = {
  approve: {
    when: 'DRAFT', icon: CheckCircleIcon, verb: 'Approve',
    consequence: 'The run is locked for posting. Separation of duties applies: the person who ran it cannot approve it.',
    done: (r) => `${r.run_number} approved`,
  },
  post: {
    when: 'PROCESSED', icon: BookOpenIcon, verb: 'Post to GL',
    consequence: 'Salary expense and the payroll liability are accrued to the general ledger for the period.',
    done: (r) => `${r.run_number} accrued to the general ledger`,
  },
  pay: {
    when: 'POSTED', icon: BanknotesIcon, verb: 'Pay',
    consequence: 'Net pay is settled from cash and the liability is cleared.',
    done: (r) => `${r.run_number} paid — net settled from cash`,
  },
}

export default function Payroll() {
  const [runOpen, setRunOpen] = useState(false)
  const [detail, setDetail] = useState(null)
  const [step, setStep] = useState(null) // { kind, run }

  const { data, loading, error, refetch } = useResource(KEY, () => hrAPI.listPayroll())
  const runs = useMemo(() => (Array.isArray(data) ? data : []), [data])

  const opts = { invalidates: [KEY], silent: true }
  const approve = useResourceMutation((r) => hrAPI.approvePayroll(r.id), opts)
  const post = useResourceMutation((r) => hrAPI.postPayroll(r.id), opts)
  const pay = useResourceMutation((r) => hrAPI.payPayroll(r.id), opts)
  const mutations = { approve, post, pay }

  const doStep = async () => {
    const { kind, run } = step
    try {
      await mutations[kind].mutateAsync(run)
      notify.success(STEPS[kind].done(run))
      setStep(null)
    } catch (err) {
      notify.error(err?.response?.data?.error || err?.message || `Could not ${STEPS[kind].verb.toLowerCase()} ${run.run_number}`)
    }
  }

  const columns = useMemo(() => [
    { id: 'run', header: 'Run', accessor: 'run_number', width: 160, mobile: 'title', cell: (r) => <Code>{r.run_number}</Code> },
    { id: 'period', header: 'Period', accessor: (r) => `${r.period_year}-${String(r.period_month).padStart(2, '0')}`, width: 160, mobile: 'subtitle', cell: (r) => `${MONTHS[r.period_month] || '—'} ${r.period_year || ''}` },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 130, mobile: 'meta', cell: (r) => badge(r.status) },
    { id: 'employees', header: 'Employees', accessor: (r) => Number(r.item_count), align: 'right', width: 110, cell: (r) => <Num value={r.item_count} /> },
    { id: 'gross', header: 'Gross', accessor: (r) => Number(r.total_gross), align: 'right', width: 150, cell: (r) => <Money amount={r.total_gross} /> },
    { id: 'net', header: 'Net', accessor: (r) => Number(r.total_net), align: 'right', width: 150, mobile: 'trailing', cell: (r) => <Money amount={r.total_net} className="font-medium" /> },
  ], [])

  const current = step && STEPS[step.kind]

  return (
    <>
      <PageHeader
        title="Payroll"
        description="Monthly payroll runs: calculated, approved, posted to the general ledger, then paid."
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setRunOpen(true)}>Run payroll</Button>}
      />

      <DataTable
        viewKey="hr.payroll"
        caption="Payroll runs"
        noun="payroll run"
        rows={runs}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        onRowClick={(r) => setDetail(r)}
        defaultSort={{ id: 'period', dir: 'desc' }}
        searchPlaceholder="Search run or period"
        rowActions={(r) => (
          <>
            <RowAction icon={EyeIcon} label={`Payslips in ${r.run_number}`} onClick={() => setDetail(r)} />
            {Object.entries(STEPS).filter(([, s]) => s.when === r.status).map(([kind, s]) => (
              <RowAction key={kind} icon={s.icon} label={`${s.verb} ${r.run_number}`} onClick={() => setStep({ kind, run: r })} />
            ))}
          </>
        )}
        empty={{
          icon: BanknotesIcon,
          title: 'No payroll runs yet',
          description: 'Run payroll for a month to calculate gross and net pay for every active employee. Nothing is posted until the run is approved and posted.',
          action: <Button variant="primary" icon={PlusIcon} onClick={() => setRunOpen(true)}>Run payroll</Button>,
        }}
      />

      {runOpen && <RunPayrollDialog onClose={() => setRunOpen(false)} />}
      {detail && <PayslipSheet run={detail} onClose={() => setDetail(null)} onStep={(kind) => setStep({ kind, run: detail })} />}
      {step && (
        <ConfirmDialog
          open
          onClose={() => setStep(null)}
          onConfirm={doStep}
          title={`${current.verb} ${step.run.run_number}?`}
          consequence={`${MONTHS[step.run.period_month] || ''} ${step.run.period_year || ''}: ${current.consequence}`}
          reversible={false}
          tone="primary"
          confirmLabel={`${current.verb} ${step.run.run_number}`}
          busy={mutations[step.kind].isPending}
        />
      )}
    </>
  )
}

function PayslipSheet({ run, onClose, onStep }) {
  const { data: detail, loading, error, refetch } = useResource([...KEY, run.id], () => hrAPI.getPayroll(run.id))
  const items = Array.isArray(detail?.items) ? detail.items : []
  const status = detail?.status || run.status
  const next = Object.entries(STEPS).find(([, s]) => s.when === status)

  return (
    <Sheet
      open
      onClose={onClose}
      width="lg"
      title={`${run.run_number} — payslips`}
      description={`${MONTHS[run.period_month] || ''} ${run.period_year || ''}`}
      footer={next ? <Button variant="primary" icon={next[1].icon} onClick={() => onStep(next[0])}>{next[1].verb}</Button> : null}
    >
      {loading ? <SkeletonRows rows={5} columns={3} className="p-4" /> : error ? <ErrorState compact what="This payroll run" error={error} onRetry={refetch} className="p-4" /> : (
        <div className="space-y-5 p-4">
          <DescriptionList
            columns={3}
            items={[
              { label: 'Status', value: badge(status) },
              { label: 'Gross', value: <Money amount={detail?.total_gross ?? run.total_gross} /> },
              { label: 'Net', value: <Money amount={detail?.total_net ?? run.total_net} className="font-semibold" /> },
            ]}
          />
          <DataTable
            caption="Payslips"
            noun="payslip"
            rows={items}
            search={items.length > 12}
            showCount={false}
            columns={[
              { id: 'employee', header: 'Employee', accessor: 'employee_name', mobile: 'title' },
              { id: 'gross', header: 'Gross', accessor: (i) => Number(i.gross_salary), align: 'right', width: 120, cell: (i) => <Money amount={i.gross_salary} />, footer: (rows) => <Money amount={rows.reduce((s, i) => s + (Number(i.gross_salary) || 0), 0)} /> },
              { id: 'deductions', header: 'Deductions', accessor: (i) => Number(i.deductions), align: 'right', width: 120, cell: (i) => <Money amount={i.deductions} />, footer: (rows) => <Money amount={rows.reduce((s, i) => s + (Number(i.deductions) || 0), 0)} /> },
              { id: 'net', header: 'Net', accessor: (i) => Number(i.net_salary), align: 'right', width: 120, mobile: 'trailing', cell: (i) => <Money amount={i.net_salary} className="font-medium" />, footer: (rows) => <Money amount={rows.reduce((s, i) => s + (Number(i.net_salary) || 0), 0)} /> },
            ]}
            empty={{ title: 'No payslips on this run', description: 'Payslips are created for every active employee when the run is calculated.' }}
          />
        </div>
      )}
    </Sheet>
  )
}

function RunPayrollDialog({ onClose }) {
  const now = new Date()
  const [form, setForm] = useState({ period_year: String(now.getFullYear()), period_month: String(now.getMonth() + 1), deduction_rate: '0' })
  const [serverError, setServerError] = useState(null)
  const create = useResourceMutation((payload) => hrAPI.createPayroll(payload), { invalidates: [KEY], silent: true })

  const errors = {
    year: !(Number(form.period_year) >= 2000 && Number(form.period_year) <= 2100) ? 'Enter a four-digit year.' : null,
    rate: !(Number(form.deduction_rate) >= 0 && Number(form.deduction_rate) <= 100) ? 'Between 0 and 100.' : null,
  }

  const submit = async () => {
    if (errors.year || errors.rate) return
    setServerError(null)
    try {
      const d = await create.mutateAsync({
        period_year: Number(form.period_year),
        period_month: Number(form.period_month),
        deduction_rate: Number(form.deduction_rate || 0),
      })
      notify.success(`Payroll processed for ${d?.employees_processed ?? 0} employees`)
      onClose()
    } catch (err) {
      setServerError(err?.response?.data?.error || err?.message || 'Failed to run payroll')
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Run payroll"
      description="Monthly gross is the annual base salary ÷ 12 for each active employee. The run is created as a draft; nothing is posted yet."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending}>Run payroll</Button>
        </>
      }
    >
      <div className="space-y-4">
        {serverError && <InlineNotice tone="risk" title="Payroll was not run">{serverError}</InlineNotice>}
        <div className="grid grid-cols-2 gap-4">
          <Field label="Month" id="month">
            <Select value={form.period_month} onChange={(e) => setForm((f) => ({ ...f, period_month: e.target.value }))}>
              {MONTHS.slice(1).map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </Select>
          </Field>
          <Field label="Year" id="year" error={errors.year}>
            <Input type="number" value={form.period_year} onChange={(e) => setForm((f) => ({ ...f, period_year: e.target.value }))} />
          </Field>
        </div>
        <Field label="Deduction rate" help="Percent of gross withheld from each payslip." id="deduction-rate" error={errors.rate}>
          <Input type="number" step="0.1" min="0" max="100" numeric suffix="%" value={form.deduction_rate} onChange={(e) => setForm((f) => ({ ...f, deduction_rate: e.target.value }))} />
        </Field>
      </div>
    </Dialog>
  )
}
