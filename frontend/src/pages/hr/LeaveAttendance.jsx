import { useMemo, useState } from 'react'
import { CheckCircleIcon, CalendarDaysIcon, ClockIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { usePeopleCoverage, PEOPLE_COVERAGE_KEY } from '../../components/hr/PeopleCoverage'
import {
  PageHeader, Button, Card, DataTable, RowAction, StatusBadge, Num, DateText, Tabs, Field, Select, Input, Textarea,
  FormSection, ErrorSummary, InlineNotice,
} from '../../components/ui'

/**
 * Leave and attendance — clocking in and out, the last 30 days of attendance,
 * and leave requests with their approval.
 */
const EMPTY_LEAVE = { employee_id: '', leave_type: 'ANNUAL', start_date: '', end_date: '', reason: '' }
const LEAVE_TYPES = [['ANNUAL', 'Annual'], ['SICK', 'Sick'], ['UNPAID', 'Unpaid'], ['OTHER', 'Other']]
const humanize = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
const ATTENDANCE_STATE = { PRESENT: 'ACTIVE', LATE: 'ATTENTION', HALF_DAY: 'ATTENTION', ABSENT: 'OVERDUE' }
const person = (r) => [r.first_name, r.last_name].filter(Boolean).join(' ')
const time = (v) => (v ? new Date(v).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—')

export default function LeaveAttendance() {
  const [tab, setTab] = useState('attendance')
  const [lForm, setLForm] = useState(EMPTY_LEAVE)
  const [lSubmitted, setLSubmitted] = useState(false)
  const [aEmp, setAEmp] = useState('')

  const { data: leaveData, loading: leaveLoading, error: leaveError, refetch: refetchLeave } = useResource(keys.leaveRequests(), ({ signal }) => api.get('/hr/leave', { signal }))
  const leave = useMemo(() => (Array.isArray(leaveData) ? leaveData : []), [leaveData])

  const { data: attendanceData, loading: attendanceLoading, error: attendanceError, refetch: refetchAttendance } = useResource(
    keys.attendance(),
    ({ signal }) => api.get('/hr/attendance?date_from=' + new Date(new Date().setDate(new Date().getDate() - 30)).toISOString().slice(0, 10), { signal })
  )
  const attendance = useMemo(() => (Array.isArray(attendanceData) ? attendanceData : []), [attendanceData])

  const { data: employeesData } = useResource(keys.hrEmployees(), ({ signal }) => api.get('/hr/employees', { signal }))
  const employees = Array.isArray(employeesData) ? employeesData : []

  const leaveMutation = useResourceMutation((payload) => api.post('/hr/leave', payload), {
    invalidates: [keys.leaveRequests()],
    successMessage: 'Leave request submitted',
    onSuccess: () => { setLForm(EMPTY_LEAVE); setLSubmitted(false) },
  })
  const approveMutation = useResourceMutation((id) => api.patch(`/hr/leave/${id}`, { status: 'APPROVED' }), { invalidates: [keys.leaveRequests(), PEOPLE_COVERAGE_KEY], successMessage: 'Approved' })
  // What approving each pending request would do to the decisions waiting on that person (services/peopleCoverage.js).
  const { data: coverage } = usePeopleCoverage()
  const impactOf = useMemo(() => new Map((coverage?.leave_impact || []).filter((l) => l.leave_request_id).map((l) => [l.leave_request_id, l])), [coverage])
  const clockInMutation = useResourceMutation((employeeId) => api.post('/hr/attendance/clock-in', { employee_id: employeeId }), { invalidates: [keys.attendance()], successMessage: 'Clocked in' })
  const clockOutMutation = useResourceMutation((employeeId) => api.post('/hr/attendance/clock-out', { employee_id: employeeId }), { invalidates: [keys.attendance()], successMessage: 'Clocked out' })

  const leaveErrors = {
    'leave-employee': !lForm.employee_id ? 'Choose the employee taking leave.' : null,
    'leave-start': !lForm.start_date ? 'Enter the first day of leave.' : null,
    'leave-end': !lForm.end_date ? 'Enter the last day of leave.' : lForm.start_date && lForm.end_date < lForm.start_date ? 'The last day cannot be before the first.' : null,
  }
  const lErr = (k) => (lSubmitted ? leaveErrors[k] : null)

  const handleLeaveSubmit = (e) => {
    e.preventDefault()
    setLSubmitted(true)
    if (Object.values(leaveErrors).some(Boolean)) return
    leaveMutation.mutate(lForm)
  }

  const pending = leave.filter((l) => l.status === 'PENDING').length

  const attendanceColumns = useMemo(() => [
    { id: 'employee', header: 'Employee', accessor: person, filter: 'text', minWidth: 180, mobile: 'title' },
    { id: 'date', header: 'Date', accessor: 'record_date', width: 130, mobile: 'subtitle', cell: (r) => <DateText value={r.record_date} /> },
    { id: 'in', header: 'Clock in', accessor: 'clock_in', width: 110, cell: (r) => <span className="tabular-nums">{time(r.clock_in)}</span> },
    { id: 'out', header: 'Clock out', accessor: 'clock_out', width: 110, cell: (r) => <span className="tabular-nums">{time(r.clock_out)}</span> },
    { id: 'hours', header: 'Hours', accessor: (r) => (r.hours_worked != null ? Number(r.hours_worked) : null), align: 'right', width: 90, mobile: 'trailing', cell: (r) => <Num value={r.hours_worked} digits={1} /> },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 120, mobile: 'meta', cell: (r) => <StatusBadge status={ATTENDANCE_STATE[r.status] || r.status} label={humanize(r.status)} /> },
  ], [])

  const leaveColumns = useMemo(() => [
    { id: 'employee', header: 'Employee', accessor: person, filter: 'text', minWidth: 180, mobile: 'title' },
    { id: 'type', header: 'Type', accessor: 'leave_type', filter: 'select', width: 110, cell: (l) => humanize(l.leave_type) },
    {
      id: 'dates', header: 'Dates', accessor: 'start_date', width: 230, mobile: 'subtitle',
      cell: (l) => <span className="whitespace-nowrap"><DateText value={l.start_date} /> → <DateText value={l.end_date} /></span>,
    },
    { id: 'days', header: 'Days', accessor: (l) => Number(l.total_days), align: 'right', width: 80, mobile: 'trailing', cell: (l) => <Num value={l.total_days} digits={Number(l.total_days) % 1 ? 1 : 0} /> },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 120, mobile: 'meta', cell: (l) => <StatusBadge status={l.status} /> },
    { id: 'reason', header: 'Reason', accessor: 'reason', defaultHidden: true },
    {
      id: 'impact', header: 'If approved', accessor: (l) => impactOf.get(l.id)?.reason || '', minWidth: 260,
      cell: (l) => {
        const i = impactOf.get(l.id)
        if (l.status !== 'PENDING') return null
        return i ? <span className="text-xs text-warn-700">{i.reason.replace(/^[^:]*: /, '')}</span> : <span className="text-xs text-ink-600">Nothing waits on them</span>
      },
    },
  ], [impactOf])

  return (
    <>
      <PageHeader title="Leave and attendance" description="Clock in and out, the last 30 days of attendance, and leave requests waiting for approval." />

      <Tabs
        value={tab}
        onChange={setTab}
        label="Leave and attendance"
        tabs={[{ id: 'attendance', label: 'Attendance', count: attendance.length || undefined }, { id: 'leave', label: 'Leave requests', count: pending || undefined }]}
      >
        {(t) => (
          <div className="space-y-4 pt-4">
            {t === 'attendance' && (
              <>
                <Card title="Clock in or out" description="Records today's time for the chosen employee.">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                    <Field label="Employee" className="flex-1" id="clock-employee">
                      <Select value={aEmp} onChange={(e) => setAEmp(e.target.value)}>
                        <option value="">Select employee…</option>
                        {employees.map((e) => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}
                      </Select>
                    </Field>
                    <div className="flex gap-2">
                      <Button variant="primary" icon={ClockIcon} onClick={() => clockInMutation.mutate(aEmp)} disabled={!aEmp} loading={clockInMutation.isPending} title={!aEmp ? 'Choose an employee first' : undefined}>Clock in</Button>
                      <Button onClick={() => clockOutMutation.mutate(aEmp)} disabled={!aEmp} loading={clockOutMutation.isPending} title={!aEmp ? 'Choose an employee first' : undefined}>Clock out</Button>
                    </div>
                  </div>
                </Card>
                <DataTable
                  viewKey="hr.attendance"
                  caption="Attendance, last 30 days"
                  noun="record"
                  rows={attendance}
                  columns={attendanceColumns}
                  loading={attendanceLoading}
                  error={attendanceError}
                  onRetry={refetchAttendance}
                  defaultSort={{ id: 'date', dir: 'desc' }}
                  searchPlaceholder="Search employee"
                  empty={{ icon: ClockIcon, title: 'No attendance in the last 30 days', description: 'Choose an employee above and clock them in to start recording attendance.' }}
                />
              </>
            )}

            {t === 'leave' && (
              <>
                <form onSubmit={handleLeaveSubmit} noValidate className="space-y-3">
                  <ErrorSummary errors={lSubmitted ? leaveErrors : {}} />
                  <FormSection
                    title="Request leave"
                    description="Approval deducts the days from the employee's balance. Unpaid leave has no balance to check."
                    aside={<Button type="submit" variant="primary" icon={CalendarDaysIcon} loading={leaveMutation.isPending}>Submit request</Button>}
                  >
                    <Field label="Employee" required id="leave-employee" error={lErr('leave-employee')}>
                      <Select value={lForm.employee_id} onChange={(e) => setLForm({ ...lForm, employee_id: e.target.value })}>
                        <option value="">Select employee…</option>
                        {employees.map((e) => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}
                      </Select>
                    </Field>
                    <Field label="Type" id="leave-type">
                      <Select value={lForm.leave_type} onChange={(e) => setLForm({ ...lForm, leave_type: e.target.value })}>
                        {LEAVE_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </Select>
                    </Field>
                    <Field label="First day" required id="leave-start" error={lErr('leave-start')}>
                      <Input type="date" value={lForm.start_date} onChange={(e) => setLForm({ ...lForm, start_date: e.target.value })} />
                    </Field>
                    <Field label="Last day" required id="leave-end" error={lErr('leave-end')}>
                      <Input type="date" min={lForm.start_date || undefined} value={lForm.end_date} onChange={(e) => setLForm({ ...lForm, end_date: e.target.value })} />
                    </Field>
                    <Field label="Reason" optional id="leave-reason" className="sm:col-span-2">
                      <Textarea rows={2} value={lForm.reason} onChange={(e) => setLForm({ ...lForm, reason: e.target.value })} />
                    </Field>
                  </FormSection>
                </form>
                {pending > 0 && <InlineNotice tone="warn" title={`${pending} request${pending === 1 ? '' : 's'} waiting for approval`}>Approve from the row actions below.</InlineNotice>}
                <DataTable
                  viewKey="hr.leave"
                  caption="Leave requests"
                  noun="leave request"
                  rows={leave}
                  columns={leaveColumns}
                  loading={leaveLoading}
                  error={leaveError}
                  onRetry={refetchLeave}
                  defaultSort={{ id: 'dates', dir: 'desc' }}
                  searchPlaceholder="Search employee"
                  rowActions={(l) => l.status === 'PENDING' && (
                    <RowAction icon={CheckCircleIcon} label={`Approve leave for ${person(l)}`} onClick={() => { const i = impactOf.get(l.id); if (i && !window.confirm(`${i.reason}\n\nApprove anyway?`)) return; approveMutation.mutate(l.id) }} disabled={approveMutation.isPending} />
                  )}
                  empty={{ icon: CalendarDaysIcon, title: 'No leave requests', description: 'Requests submitted above appear here for approval.' }}
                />
              </>
            )}
          </div>
        )}
      </Tabs>
    </>
  )
}
