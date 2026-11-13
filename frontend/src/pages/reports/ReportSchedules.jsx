import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { PlusIcon, TrashIcon, PauseIcon, PlayIcon, ClockIcon } from '@heroicons/react/20/solid'
import { reportsAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, DataTable, RowAction, StatusBadge, Badge, DateText, Stat, Num, ConfirmDialog, Dialog,
  Field, Input, Select, InlineNotice, ErrorSummary, notify, describeError, formatDate,
} from '../../components/ui'

// Kept in step with the CHECK constraint on report_schedules.format and the
// allowlist in routes/reports.js. HTML arrives as the mail body; the rest are
// attachments.
const FORMATS = ['PDF', 'CSV', 'JSON', 'HTML']

// The backend's floor is 300 seconds and it says why: anything faster mails
// people faster than they can read. Offering shorter intervals here would only
// produce a rejection.
const INTERVALS = [
  { seconds: 300, label: 'Every 5 minutes' },
  { seconds: 3600, label: 'Hourly' },
  { seconds: 21600, label: 'Every 6 hours' },
  { seconds: 86400, label: 'Daily' },
  { seconds: 604800, label: 'Weekly' },
  { seconds: 2592000, label: 'Every 30 days' },
]

const intervalLabel = (s) => INTERVALS.find((i) => i.seconds === Number(s))?.label || `Every ${Number(s)} seconds`

const SCHEDULES_KEY = [...keys.reports(), 'schedules']

export default function ReportSchedules() {
  const [createOpen, setCreateOpen] = useState(false)
  const [confirm, setConfirm] = useState(null)

  // The list endpoint returns the scheduler's state beside the rows, outside
  // `data`, so the envelope is read here rather than unwrapped.
  const { data, loading, error, refetch } = useResource(SCHEDULES_KEY, async () => {
    const res = await reportsAPI.listSchedules()
    const body = res?.data || {}
    if (body.success === false) throw Object.assign(new Error(body.error || 'The schedules did not load.'), { errorId: body.error_id })
    return { data: { schedules: body.data || [], scheduler: body.scheduler || null } }
  })
  const schedules = useMemo(() => data?.schedules || [], [data])
  const scheduler = data?.scheduler

  const invalidates = [SCHEDULES_KEY]
  const toggle = useResourceMutation((s) => reportsAPI.updateSchedule(s.id, { enabled: !s.enabled }), { invalidates })
  const remove = useResourceMutation((id) => reportsAPI.deleteSchedule(id), { invalidates, silent: true })

  const columns = useMemo(() => [
    {
      id: 'name', header: 'Schedule', accessor: 'name', mobile: 'title', minWidth: 180,
      cell: (s) => <span className="font-medium text-fg">{s.name}</span>,
    },
    {
      id: 'report', header: 'Report', accessor: 'report_name', filter: 'text', mobile: 'subtitle', minWidth: 160,
      cell: (s) => <Link to={`/reports/${s.report_id}`} onClick={(e) => e.stopPropagation()} className="text-brand-600 hover:underline">{s.report_name}</Link>,
    },
    { id: 'status', header: 'Status', accessor: (s) => (s.enabled ? 'ACTIVE' : 'PAUSED'), filter: 'select', width: 110, mobile: 'meta', cell: (s) => <StatusBadge status={s.enabled ? 'ACTIVE' : 'PAUSED'} label={s.enabled ? 'Active' : 'Paused'} /> },
    { id: 'every', header: 'Every', accessor: (s) => Number(s.interval_seconds), width: 140, cell: (s) => intervalLabel(s.interval_seconds), exportValue: (s) => intervalLabel(s.interval_seconds) },
    { id: 'format', header: 'Format', accessor: 'format', filter: 'select', width: 90, cell: (s) => <Badge mono>{s.format}</Badge> },
    {
      id: 'recipients', header: 'Recipients', accessor: (s) => (s.recipients || []).join(', '), minWidth: 180, maxWidth: 320,
      cell: (s) => ((s.recipients || []).length === 0
        ? <span className="text-ink-500">Nobody — nothing is sent</span>
        : <span className="block truncate" title={(s.recipients || []).join(', ')}>{(s.recipients || []).join(', ')}</span>),
    },
    {
      id: 'next', header: 'Next run', accessor: (s) => (s.enabled ? s.next_run_at : null), width: 170, mobile: 'trailing',
      cell: (s) => (
        <span className="block">
          {s.enabled ? <DateText value={s.next_run_at} withTime /> : <span className="text-ink-400">—</span>}
          {s.last_run_at && <span className="block text-xs text-ink-500">Last {formatDate(s.last_run_at, { withTime: true })}</span>}
        </span>
      ),
    },
  ], [])

  const run = async () => {
    const s = confirm
    try {
      await remove.mutateAsync(s.id)
      setConfirm(null)
      notify.success(`${s.name} deleted`)
    } catch (e) {
      setConfirm(null)
      notify.error(`Not deleted — ${describeError(e).message}`)
    }
  }

  return (
    <>
      <PageHeader
        title="Scheduled reports"
        description="Reports mailed out on an interval."
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setCreateOpen(true)} kbd="N">New schedule</Button>}
      />

      {/* The scheduler is off unless REPORT_SCHEDULER_ENABLED is set. Saying so
          plainly is the difference between "my schedule is broken" and "the
          scheduler is not turned on in this environment". */}
      {scheduler && !scheduler.running && (
        <InlineNotice tone="warn" className="mb-4" title="The scheduler is not running in this environment">
          Nothing is being sent. Schedules saved here are kept and will start delivering once it is enabled.
        </InlineNotice>
      )}

      {scheduler?.running && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Delivered" value={<Num value={scheduler.sent} />} />
          <Stat label="Failures" value={<Num value={scheduler.failures} />} reason={Number(scheduler.failures) > 0 ? 'Check the run history of each report.' : undefined} />
          <Stat label="Ticks" value={<Num value={scheduler.ticks} />} />
          <Stat label="Last checked" value={scheduler.lastTickAt ? new Date(scheduler.lastTickAt).toLocaleTimeString() : '—'} />
        </div>
      )}

      <DataTable
        viewKey="reports.schedules"
        caption="Scheduled reports"
        noun="schedule"
        rows={schedules}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        rowHref={(s) => `/reports/${s.report_id}`}
        defaultSort={{ id: 'name', dir: 'asc' }}
        searchPlaceholder="Search schedules, reports, recipients"
        rowClassName={(s) => (s.enabled ? undefined : 'text-ink-500')}
        rowActions={(s) => (
          <>
            <RowAction icon={s.enabled ? PauseIcon : PlayIcon} label={s.enabled ? `Pause ${s.name}` : `Resume ${s.name}`} disabled={toggle.isPending} onClick={() => toggle.mutate(s)} />
            <RowAction icon={TrashIcon} tone="risk" label={`Delete ${s.name}`} onClick={() => setConfirm(s)} />
          </>
        )}
        empty={{
          icon: ClockIcon,
          title: 'No schedules yet',
          description: 'Pick a report and have it mailed out on an interval.',
          action: <Button variant="primary" icon={PlusIcon} onClick={() => setCreateOpen(true)}>New schedule</Button>,
        }}
      />

      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={run}
          title={`Delete ${confirm.name}?`}
          consequence={`${(confirm.recipients || []).length ? `${confirm.recipients.length} recipient${confirm.recipients.length === 1 ? '' : 's'} stop` : 'Nobody is mailed, but the schedule stops'} receiving ${confirm.report_name}. Pause it instead if you may want it back.`}
          confirmLabel={`Delete ${confirm.name}`}
          busy={remove.isPending}
        />
      )}

      {createOpen && <CreateScheduleDialog onClose={() => setCreateOpen(false)} invalidates={invalidates} />}
    </>
  )
}

function CreateScheduleDialog({ onClose, invalidates }) {
  const [form, setForm] = useState({ report_id: '', name: '', interval_seconds: 86400, format: 'PDF', recipients: '' })
  const [submitted, setSubmitted] = useState(false)
  const [touched, setTouched] = useState(false)
  const [serverError, setServerError] = useState(null)

  const { data: reportData, error: reportsError } = useResource(keys.reports(), () => reportsAPI.list())
  const reports = Array.isArray(reportData) ? reportData : []
  const create = useResourceMutation((payload) => reportsAPI.createSchedule(payload), { invalidates, silent: true })

  const reportError = (touched || submitted) && !form.report_id ? 'Pick the report to send.' : null

  const save = async () => {
    setSubmitted(true)
    if (!form.report_id) return
    const recipients = form.recipients.split(/[,;\s]+/).map((r) => r.trim()).filter(Boolean)
    setServerError(null)
    try {
      await create.mutateAsync({
        report_id: form.report_id,
        name: form.name || undefined,
        interval_seconds: Number(form.interval_seconds),
        format: form.format,
        recipients,
        parameter_values: {},
      })
      notify.success('Schedule created')
      onClose()
    } catch (e) {
      setServerError(describeError(e).message)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="New schedule"
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={create.isPending}>Create schedule</Button>
        </>
      }
    >
      <div className="space-y-4">
        {submitted && reportError && <ErrorSummary errors={{ 'schedule-report': reportError }} />}
        {serverError && <InlineNotice tone="risk" title="The schedule was not created">{serverError}</InlineNotice>}
        <Field label="Report" required id="schedule-report" error={reportError} help={reportsError ? 'The report list did not load.' : undefined}>
          <Select
            value={form.report_id}
            onBlur={() => setTouched(true)}
            onChange={(e) => {
              const r = reports.find((x) => x.id === e.target.value)
              setForm({ ...form, report_id: e.target.value, name: form.name || r?.name || '' })
            }}
          >
            <option value="">Choose…</option>
            {reports.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        </Field>
        <Field label="Name" optional help="Defaults to the report's name.">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Send">
            <Select value={form.interval_seconds} onChange={(e) => setForm({ ...form, interval_seconds: e.target.value })}>
              {INTERVALS.map((i) => <option key={i.seconds} value={i.seconds}>{i.label}</option>)}
            </Select>
          </Field>
          <Field label="Format">
            <Select value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value })}>
              {FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
            </Select>
          </Field>
        </div>
        <Field
          label="Recipients"
          optional
          help={`${form.format === 'HTML' ? 'Sent as the body of the email.' : `Attached as a .${form.format.toLowerCase()} file.`} Separate addresses with commas. Leave empty to record runs without mailing anyone.`}
        >
          <Input value={form.recipients} onChange={(e) => setForm({ ...form, recipients: e.target.value })} placeholder="finance@example.com, cfo@example.com" />
        </Field>
      </div>
    </Dialog>
  )
}
