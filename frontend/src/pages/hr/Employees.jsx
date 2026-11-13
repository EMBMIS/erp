import { useMemo, useState } from 'react'
import { PlusIcon, UsersIcon, DocumentArrowDownIcon } from '@heroicons/react/20/solid'
import { hrAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import {
  PageHeader, Button, DataTable, StatusBadge, Money, Code, Dialog, Segmented, Field, Input, FormSection, ErrorSummary,
  InlineNotice, exportCsv, formatMoney, formatNumber, useDraft, notify,
} from '../../components/ui'

/**
 * Employees — the employee master that HR and payroll read from.
 *
 * The server caps a page at 200 rows; the list loads that page in one request
 * so sorting, filtering and saved views work across it, and says so when the
 * directory is larger than one page.
 */
const LIMIT = 200
const QUICK = {
  all: { label: 'All', test: () => true },
  ACTIVE: { label: 'Active', test: (e) => e.status === 'ACTIVE' },
  ON_LEAVE: { label: 'On leave', test: (e) => e.status === 'ON_LEAVE' },
  TERMINATED: { label: 'Left', test: (e) => e.status === 'TERMINATED' },
}
const INITIAL = { first_name: '', last_name: '', email: '', department: '', position: '', base_salary: '', housing_allowance: '0', transport_allowance: '0', other_allowance: '0' }
const name = (e) => [e.first_name, e.last_name].filter(Boolean).join(' ')

export default function Employees() {
  const [quick, setQuick] = useState('all')
  const [adding, setAdding] = useState(false)

  const params = { limit: LIMIT, offset: 0, sort_by: 'name', sort_dir: 'asc' }
  // The list endpoint answers { success, data: rows, total }. Keep the total
  // the server counted, so a directory larger than one page says so.
  const { data: listData, loading, error, refetch } = useResource(['hr-employees', params], async () => {
    const res = await hrAPI.listEmployees(params)
    const rows = res.data?.data || []
    return { data: { success: true, data: { rows, total: Number.isFinite(res.data?.total) ? res.data.total : rows.length } } }
  })
  const employees = useMemo(() => listData?.rows || [], [listData])
  const total = listData?.total || 0
  const { data: stats } = useResource(['hr-employees', 'stats'], () => hrAPI.employeeStats())
  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, employees.filter(q.test).length])), [employees])

  const columns = useMemo(() => [
    { id: 'number', header: 'Employee #', accessor: 'employee_number', width: 140, cell: (e) => <Code>{e.employee_number}</Code>, mobile: 'meta' },
    {
      id: 'name', header: 'Name', accessor: name, filter: 'text', minWidth: 200, mobile: 'title',
      cell: (e) => (
        <span className="block min-w-0">
          <span className="block truncate">{name(e) || '—'}</span>
          {e.email && <span className="block truncate text-2xs text-ink-500">{e.email}</span>}
        </span>
      ),
    },
    { id: 'department', header: 'Department', accessor: 'department', filter: 'select', width: 160, mobile: 'subtitle', cell: (e) => e.department || <span className="text-ink-400">—</span> },
    { id: 'position', header: 'Position', accessor: 'position', filter: 'text', width: 180, cell: (e) => e.position || <span className="text-ink-400">—</span> },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 120, cell: (e) => <StatusBadge status={e.status} /> },
    {
      id: 'salary', header: 'Base salary', accessor: (e) => Number(e.base_salary), align: 'right', filter: 'number', width: 140, mobile: 'trailing',
      cell: (e) => <Money amount={e.base_salary} currency={e.currency || 'USD'} digits={0} />, exportValue: (e) => e.base_salary,
    },
    { id: 'hired', header: 'Hired', accessor: 'hire_date', width: 120, defaultHidden: true },
  ], [])

  const meta = stats ? (
    <>
      <span><span className="tabular-nums text-fg">{formatNumber(stats.total_employees)}</span> employees</span>
      <span><span className="tabular-nums text-fg">{formatNumber(stats.active_employees)}</span> active</span>
      <span>Annual payroll <span className="tabular-nums text-fg">{formatMoney(stats.total_annual_payroll, 'USD', 0)}</span></span>
    </>
  ) : null

  return (
    <>
      <PageHeader
        title="Employees"
        description="The employee master for HR and payroll."
        meta={meta}
        secondary={<Button icon={DocumentArrowDownIcon} onClick={() => exportCsv(employees.filter(QUICK[quick].test), columns, 'employees.csv')} disabled={!employees.length}>Export</Button>}
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setAdding(true)}>Add employee</Button>}
      />

      {total > employees.length && (
        <InlineNotice tone="warn" className="mb-3" title={`Showing the first ${employees.length} of ${formatNumber(total)} employees`}>
          Use search and the column filters to narrow the list.
        </InlineNotice>
      )}

      <DataTable
        viewKey="hr.employees"
        caption="Employees"
        noun="employee"
        rows={employees}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'name', dir: 'asc' }}
        searchPlaceholder="Search name, email, department"
        toolbarStart={
          <Segmented
            label="Show"
            value={quick}
            onChange={setQuick}
            options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))}
            className="max-w-full overflow-x-auto"
          />
        }
        empty={{
          icon: UsersIcon,
          title: 'No employees yet',
          description: 'Add the people you employ. Payroll runs and leave requests are built from this list.',
          action: <Button variant="primary" icon={PlusIcon} onClick={() => setAdding(true)}>Add employee</Button>,
        }}
      />

      {adding && <AddEmployeeDialog onClose={() => setAdding(false)} />}
    </>
  )
}

function AddEmployeeDialog({ onClose }) {
  const { value: form, setValue, restored, clear, discard } = useDraft('hr:employee:new', INITIAL)
  const set = (k) => (e) => setValue((f) => ({ ...f, [k]: e.target.value }))
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState(null)
  const create = useResourceMutation((payload) => hrAPI.createEmployee(payload), { invalidates: [['hr-employees']], silent: true })

  const errors = {
    first_name: !form.first_name.trim() ? 'Enter a first name.' : null,
    last_name: !form.last_name.trim() ? 'Enter a last name.' : null,
    email: form.email && !/^\S+@\S+\.\S+$/.test(form.email) ? 'Enter an email like name@company.com, or leave it blank.' : null,
    base_salary: form.base_salary !== '' && !(Number(form.base_salary) >= 0) ? 'Enter a number, or leave it blank.' : null,
  }
  const show = (k) => (submitted || touched[k] ? errors[k] : null)
  const blur = (k) => () => setTouched((t) => ({ ...t, [k]: true }))

  const submit = async () => {
    setSubmitted(true)
    if (Object.values(errors).some(Boolean)) return
    setServerError(null)
    try {
      await create.mutateAsync({
        first_name: form.first_name,
        last_name: form.last_name,
        email: form.email || undefined,
        department: form.department || undefined,
        position: form.position || undefined,
        base_salary: Number(form.base_salary || 0),
        housing_allowance: Number(form.housing_allowance || 0),
        transport_allowance: Number(form.transport_allowance || 0),
        other_allowance: Number(form.other_allowance || 0),
      })
      clear()
      notify.success(`${form.first_name} ${form.last_name} added`)
      onClose()
    } catch (err) {
      setServerError(err?.response?.data?.error || err?.message || 'Failed to add employee')
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Add employee"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending}>Add employee</Button>
        </>
      }
    >
      <div className="space-y-4">
        {restored && (
          <InlineNotice tone="ink" title="Restored your unsaved entry" action={<Button size="xs" variant="ghost" onClick={discard}>Start over</Button>}>
            This form keeps what you type until you save it.
          </InlineNotice>
        )}
        {serverError && <InlineNotice tone="risk" title="The employee was not added">{serverError}</InlineNotice>}
        <ErrorSummary errors={submitted ? Object.fromEntries(Object.entries(errors).filter(([, v]) => v).map(([k, v]) => [`emp-${k}`, v])) : {}} />
        <FormSection title="Person">
          <Field label="First name" required id="emp-first_name" error={show('first_name')}>
            <Input value={form.first_name} onChange={set('first_name')} onBlur={blur('first_name')} autoComplete="off" />
          </Field>
          <Field label="Last name" required id="emp-last_name" error={show('last_name')}>
            <Input value={form.last_name} onChange={set('last_name')} onBlur={blur('last_name')} autoComplete="off" />
          </Field>
          <Field label="Email" optional id="emp-email" error={show('email')} className="sm:col-span-2">
            <Input type="email" value={form.email} onChange={set('email')} onBlur={blur('email')} autoComplete="off" />
          </Field>
          <Field label="Department" optional id="emp-department">
            <Input value={form.department} onChange={set('department')} />
          </Field>
          <Field label="Position" optional id="emp-position">
            <Input value={form.position} onChange={set('position')} />
          </Field>
        </FormSection>
        <FormSection title="Pay" description="Monthly gross is the annual base salary ÷ 12, plus allowances.">
          <Field label="Annual base salary" id="emp-base_salary" error={show('base_salary')} className="sm:col-span-2">
            <Input type="number" step="0.01" min="0" numeric value={form.base_salary} onChange={set('base_salary')} onBlur={blur('base_salary')} />
          </Field>
          <Field label="Housing allowance" help="Per month" id="emp-housing_allowance">
            <Input type="number" step="0.01" min="0" numeric value={form.housing_allowance} onChange={set('housing_allowance')} />
          </Field>
          <Field label="Transport allowance" help="Per month" id="emp-transport_allowance">
            <Input type="number" step="0.01" min="0" numeric value={form.transport_allowance} onChange={set('transport_allowance')} />
          </Field>
          <Field label="Other allowance" help="Per month" id="emp-other_allowance">
            <Input type="number" step="0.01" min="0" numeric value={form.other_allowance} onChange={set('other_allowance')} />
          </Field>
        </FormSection>
      </div>
    </Dialog>
  )
}
