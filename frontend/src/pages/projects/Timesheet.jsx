import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { PlusIcon, TrashIcon, PencilSquareIcon, ChevronLeftIcon, ChevronRightIcon, LockClosedIcon } from '@heroicons/react/20/solid'
import { projectsAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { useCompany } from '../../contexts/CompanyContext'
import {
  PageHeader, Button, IconButton, Stat, Badge, Code, Dialog, ConfirmDialog, Field, Input, Select, Textarea, Checkbox,
  FormSection, InlineNotice, ErrorSummary, ErrorState, SkeletonRows, formatDate, formatMoney, formatNumber, notify,
} from '../../components/ui'

const DAY_MS = 24 * 60 * 60 * 1000
const TIME_KEY = ['project-time']

/**
 * Local calendar date as YYYY-MM-DD.
 *
 * Deliberately not `toISOString().slice(0,10)`: that converts to UTC first, so
 * a user east of Greenwich gets the *previous* day for anything at local
 * midnight — which is exactly what the week grid is built from. Every day would
 * land in the wrong column. Formatting from the local components avoids the
 * conversion entirely.
 */
const iso = (d) => {
  const date = new Date(d)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Monday of the week containing `d`. Weeks start Monday, not Sunday. */
function weekStart(d) {
  const date = new Date(d)
  date.setHours(0, 0, 0, 0)
  const offset = (date.getDay() + 6) % 7
  return new Date(date.getTime() - offset * DAY_MS)
}

const DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const hrs = (v) => formatNumber(v, Number(v) % 1 ? 2 : 0)

/**
 * A personal weekly timesheet.
 *
 * Scoped to the signed-in user by default — the backend does the same, because
 * "what did I log" is the question this screen answers and returning everyone's
 * hours would be both wrong and unreadable.
 *
 * Invoiced entries are shown but locked. The backend refuses to change them
 * (an hour on an invoice the customer has seen cannot quietly move), so showing
 * an edit control that always fails would be worse than showing none.
 */
export default function Timesheet() {
  const { currency } = useCompany()
  const [anchor, setAnchor] = useState(() => weekStart(new Date()))
  const [logOpen, setLogOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [removing, setRemoving] = useState(null)

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => new Date(anchor.getTime() + i * DAY_MS)), [anchor])
  const from = iso(days[0])
  const to = iso(days[6])

  const timeParams = { from_date: from, to_date: to, limit: 500 }
  const { data: timeData, loading, error, refetch } = useResource([...TIME_KEY, timeParams], () => projectsAPI.listTime(timeParams))
  const { data: projectData } = useResource(['projects', 'list', { open_only: true }], () => projectsAPI.list({ open_only: true }), { retry: false })
  const entries = useMemo(() => (Array.isArray(timeData) ? timeData : []), [timeData])
  const projects = Array.isArray(projectData) ? projectData : []

  const remove = useResourceMutation((e) => projectsAPI.deleteTime(e.id), {
    invalidates: [TIME_KEY, ['projects']],
    onSuccess: () => { notify.success('Time entry deleted'); setRemoving(null) },
  })

  const byDay = useMemo(() => {
    const map = new Map(days.map((d) => [iso(d), []]))
    for (const e of entries) {
      const key = iso(e.entry_date)
      if (map.has(key)) map.get(key).push(e)
    }
    return map
  }, [entries, days])

  const totals = entries.reduce(
    (acc, e) => ({
      hours: acc.hours + Number(e.hours || 0),
      billable: acc.billable + (e.billable ? Number(e.hours || 0) : 0),
      unbilled: acc.unbilled + (e.billable && !e.invoice_id ? Number(e.hours || 0) : 0),
      value: acc.value + (e.billable ? Number(e.hours || 0) * Number(e.hourly_rate || 0) : 0),
    }),
    { hours: 0, billable: 0, unbilled: 0, value: 0 },
  )

  const isThisWeek = iso(weekStart(new Date())) === from
  const shiftWeek = (weeks) => setAnchor((a) => new Date(a.getTime() + weeks * 7 * DAY_MS))
  const todayKey = iso(new Date())
  const known = !loading && !error

  return (
    <>
      <PageHeader
        title="Timesheet"
        description={`${formatDate(days[0])} — ${formatDate(days[6])}`}
        secondary={
          <span className="inline-flex items-center gap-1">
            <IconButton icon={ChevronLeftIcon} label="Previous week" onClick={() => shiftWeek(-1)} />
            <Button variant="ghost" onClick={() => setAnchor(weekStart(new Date()))} disabled={isThisWeek}>This week</Button>
            <IconButton icon={ChevronRightIcon} label="Next week" onClick={() => shiftWeek(1)} />
          </span>
        }
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setLogOpen(true)}>Log time</Button>}
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Hours" loading={loading} value={known ? hrs(totals.hours) : '—'} reason="Logged this week" />
        <Stat label="Billable" loading={loading} value={known ? hrs(totals.billable) : '—'} reason={known && totals.hours > 0 ? `${((totals.billable / totals.hours) * 100).toFixed(0)}% of logged time` : undefined} />
        <Stat label="Unbilled" loading={loading} value={known ? hrs(totals.unbilled) : '—'} reason="Billable but not yet invoiced" />
        <Stat label="Value" loading={loading} value={known ? formatMoney(totals.value, currency || 'USD', 2) : '—'} reason="Billable hours at their logged rate" />
      </div>

      {/* Day-by-day, because a timesheet is read one day at a time. */}
      {loading ? <SkeletonRows rows={6} columns={3} /> : error ? <ErrorState what="This week's time" error={error} onRetry={refetch} /> : (
        <div className="space-y-3">
          {days.map((day, idx) => {
            const key = iso(day)
            const dayEntries = byDay.get(key) || []
            const dayHours = dayEntries.reduce((s, e) => s + Number(e.hours || 0), 0)
            const isToday = key === todayKey
            if (!dayEntries.length && idx >= 5) return null

            return (
              <section key={key} aria-label={`${DAY_LABELS[idx]} ${formatDate(day)}`} className={clsx('overflow-hidden rounded-lg border bg-surface', isToday ? 'border-ink-400' : 'border-ink-200')}>
                <header className="flex items-center justify-between gap-3 border-b border-ink-200 bg-sunken px-4 py-2">
                  <span className="flex items-baseline gap-2">
                    <span className="text-sm font-medium text-fg">{DAY_LABELS[idx]}</span>
                    <span className="text-xs text-ink-500">{formatDate(day)}</span>
                    {isToday && <Badge>Today</Badge>}
                  </span>
                  <span className={clsx('text-sm tabular-nums', dayHours > 0 ? 'font-medium text-fg' : 'text-ink-400')}>{dayHours > 0 ? `${hrs(dayHours)} h` : '—'}</span>
                </header>

                {dayEntries.length === 0 ? (
                  <p className="px-4 py-3 text-xs text-ink-500">Nothing logged.</p>
                ) : (
                  <ul className="divide-y divide-ink-100">
                    {dayEntries.map((e) => (
                      <li key={e.id} className="group flex items-center gap-3 px-4 py-2.5">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-fg">
                            {e.project_name} <Code className="ms-1 text-ink-500">{e.project_code}</Code>
                          </p>
                          <p className="mt-0.5 truncate text-xs text-ink-500">
                            {[e.task_name, e.description].filter(Boolean).join(' · ') || 'No description'}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <span className="text-sm font-medium tabular-nums text-fg">{hrs(e.hours)} h</span>
                          <span className="block text-xs text-ink-500">
                            {!e.billable ? 'Non-billable' : e.invoice_id ? (
                              <span className="inline-flex items-center gap-1"><LockClosedIcon className="h-3 w-3" aria-hidden="true" /> Invoiced</span>
                            ) : 'Unbilled'}
                          </span>
                        </div>
                        <div className="flex w-16 shrink-0 items-center justify-end gap-1">
                          {e.invoice_id ? (
                            // Locked by the backend once invoiced — see the note above.
                            <span className="text-xs text-ink-400" title="Invoiced time cannot be changed">—</span>
                          ) : (
                            <>
                              <IconButton size="sm" icon={PencilSquareIcon} label={`Edit ${hrs(e.hours)} hours on ${e.project_name}`} onClick={() => setEditing(e)} />
                              <IconButton size="sm" icon={TrashIcon} label={`Delete ${hrs(e.hours)} hours on ${e.project_name}`} onClick={() => setRemoving(e)} />
                            </>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )
          })}
        </div>
      )}

      {logOpen && <TimeEntryDialog projects={projects} defaultDate={isThisWeek ? todayKey : from} onClose={() => setLogOpen(false)} />}
      {editing && <TimeEntryDialog projects={projects} entry={editing} onClose={() => setEditing(null)} />}
      {removing && (
        <ConfirmDialog
          open
          onClose={() => setRemoving(null)}
          onConfirm={() => remove.mutate(removing)}
          title={`Delete ${hrs(removing.hours)} hours on ${removing.project_name}?`}
          consequence="The entry leaves your timesheet and will not be billed."
          reversible={false}
          confirmLabel="Delete entry"
          busy={remove.isPending}
        />
      )}
    </>
  )
}

function TimeEntryDialog({ projects, entry, defaultDate, onClose }) {
  const isEdit = Boolean(entry)
  const [form, setForm] = useState({
    project_id: entry?.project_id || '',
    task_id: entry?.task_id || '',
    entry_date: entry?.entry_date ? iso(entry.entry_date) : (defaultDate || iso(new Date())),
    hours: entry?.hours != null ? String(entry.hours) : '',
    description: entry?.description || '',
    billable: entry ? entry.billable !== false : true,
  })
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const touch = (k) => () => setTouched((t) => ({ ...t, [k]: true }))

  const selected = projects.find((p) => p.id === form.project_id)
  const isInternal = selected?.billing_type === 'INTERNAL'

  // Tasks come from the project detail — there is no standalone task list
  // endpoint, and the project payload already carries them.
  const { data: projectDetail } = useResource(['projects', form.project_id], () => projectsAPI.get(form.project_id), { enabled: Boolean(form.project_id), retry: false })
  const tasks = form.project_id ? projectDetail?.tasks || [] : []

  const save = useResourceMutation(
    (payload) => (isEdit ? projectsAPI.updateTime(entry.id, payload) : projectsAPI.logTime(payload)),
    { invalidates: [TIME_KEY, ['projects']], onSuccess: (_d, p) => { notify.success(isEdit ? 'Time entry updated' : `${p.hours} hours logged`); onClose() } },
  )

  const h = Number(form.hours)
  const errors = {
    'te-project': !form.project_id ? 'Choose a project.' : null,
    'te-hours': !(h > 0) || h > 24 ? 'Hours must be between 0 and 24.' : null,
  }
  const blocking = Object.values(errors).some(Boolean)
  const show = (k, id) => ((touched[k] || submitted) ? errors[id] : null)

  const submit = () => {
    setSubmitted(true)
    if (blocking) return
    if (isEdit) {
      save.mutate({ entry_date: form.entry_date, hours: h, description: form.description || null, billable: form.billable, task_id: form.task_id || null })
    } else {
      save.mutate({ project_id: form.project_id, task_id: form.task_id || undefined, entry_date: form.entry_date, hours: h, description: form.description || undefined, billable: form.billable })
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={isEdit ? 'Edit time entry' : 'Log time'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} loading={save.isPending}>{isEdit ? 'Save changes' : 'Log time'}</Button></>}
    >
      <div className="space-y-4">
        {submitted && blocking && <ErrorSummary errors={errors} />}
        <FormSection>
          <Field label="Project" required id="te-project" error={show('project', 'te-project')} help={isEdit ? 'An entry cannot move between projects.' : undefined} className="sm:col-span-2">
            <Select value={form.project_id} disabled={isEdit} onBlur={touch('project')} onChange={(e) => setForm((f) => ({ ...f, project_id: e.target.value, task_id: '' }))}>
              <option value="">Select a project</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.project_code} · {p.name}</option>)}
            </Select>
          </Field>
          {tasks.length > 0 && (
            <Field label="Task" optional id="te-task" className="sm:col-span-2">
              <Select value={form.task_id} onChange={set('task_id')}>
                <option value="">None</option>
                {tasks.map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}
              </Select>
            </Field>
          )}
          <Field label="Date" id="te-date">
            <Input type="date" value={form.entry_date} onChange={set('entry_date')} />
          </Field>
          <Field label="Hours" required id="te-hours" error={show('hours', 'te-hours')}>
            <Input type="number" step="0.25" min="0" max="24" inputMode="decimal" value={form.hours} onChange={set('hours')} onBlur={touch('hours')} />
          </Field>
          <Field label="What did you work on?" optional id="te-desc" className="sm:col-span-2">
            <Textarea rows={2} value={form.description} onChange={set('description')} />
          </Field>
          <Checkbox
            className="sm:col-span-2"
            label="Billable"
            description={isInternal ? 'Internal projects never bill.' : undefined}
            checked={isInternal ? false : form.billable}
            disabled={isInternal}
            onChange={(e) => setForm((f) => ({ ...f, billable: e.target.checked }))}
          />
        </FormSection>
        {!isEdit && selected && !isInternal && (
          <InlineNotice>Billed at the project&rsquo;s current rate, which is stored on the entry now. Changing the project rate later will not reprice hours already logged.</InlineNotice>
        )}
      </div>
    </Dialog>
  )
}
