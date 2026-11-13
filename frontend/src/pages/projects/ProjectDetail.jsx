import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { PlusIcon, ClockIcon, DocumentTextIcon, LockClosedIcon } from '@heroicons/react/20/solid'
import { projectsAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { useCompany } from '../../contexts/CompanyContext'
import { useRecordTitle } from '../../components/shell/ShellContext'
import {
  PageHeader, Button, Card, DataTable, StatusBadge, Money, Num, Code, DateText, DetailLayout, SummaryStrip, Tabs,
  DescriptionList, Dialog, Field, Input, Textarea, FormSection, ErrorSummary, ErrorState, SkeletonDetail, InlineNotice,
  EmptyState, formatMoney, formatNumber, notify,
} from '../../components/ui'
import { LogTimeDialog, BillDialog } from './Projects'

const BILLING = { TIME_AND_MATERIALS: 'Time and materials', FIXED_PRICE: 'Fixed price', INTERNAL: 'Internal' }

const TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED']
const TASK_LABEL = { TODO: 'To do', IN_PROGRESS: 'In progress', DONE: 'Done', CANCELLED: 'Cancelled' }
const hrs = (v) => formatNumber(v, Number(v) % 1 ? 2 : 0)

/**
 * A single project: work breakdown, time logged against it, and its P&L.
 *
 * The three sit on one page deliberately. The breakdown says what was planned,
 * the time says what it took, and the P&L says what that was worth — reading
 * any one without the others is how a project ends up over budget and nobody
 * notices until it is invoiced.
 */
export default function ProjectDetail() {
  const { id } = useParams()
  const { currency } = useCompany()
  const [tab, setTab] = useState('tasks')
  const [taskOpen, setTaskOpen] = useState(false)
  const [logOpen, setLogOpen] = useState(false)
  const [billOpen, setBillOpen] = useState(false)

  // The P&L is a separate, heavier query; failing it should not blank the
  // whole page, so each read stands on its own.
  const { data: project, loading, error, refetch } = useResource(['projects', id], () => projectsAPI.get(id))
  const { data: pnl, error: pnlError, refetch: refetchPnl } = useResource(['projects', id, 'pnl'], () => projectsAPI.pnl(id), { retry: false })
  const timeParams = { project_id: id, all: 'true', limit: 500 }
  const { data: timeData, loading: timeLoading, error: timeError, refetch: refetchTime } = useResource(['project-time', timeParams], () => projectsAPI.listTime(timeParams))
  const entries = useMemo(() => (Array.isArray(timeData) ? timeData : []), [timeData])

  useRecordTitle(project?.project_code, { subtitle: project?.name })

  const updateTask = useResourceMutation(({ task, status }) => projectsAPI.updateTask(task.id, { status }), {
    invalidates: [['projects', id]],
    silent: true,
  })

  const c = project?.currency || currency
  const tasks = useMemo(() => project?.tasks || [], [project])

  const taskColumns = useMemo(() => [
    {
      id: 'name', header: 'Task', accessor: 'name', minWidth: 220, mobile: 'title',
      cell: (task) => (
        <span className="block min-w-0">
          <span className={task.status === 'DONE' ? 'block truncate text-ink-500 line-through' : 'block truncate'}>{task.name}</span>
          {task.description && <span className="block truncate text-2xs text-ink-500">{task.description}</span>}
        </span>
      ),
    },
    { id: 'assignee', header: 'Assignee', accessor: (task) => [task.assignee_first_name, task.assignee_last_name].filter(Boolean).join(' '), width: 160, mobile: 'subtitle', cell: (task) => [task.assignee_first_name, task.assignee_last_name].filter(Boolean).join(' ') || <span className="text-ink-400">—</span> },
    { id: 'estimate', header: 'Estimate', accessor: (task) => Number(task.estimated_hours) || null, align: 'right', width: 100, cell: (task) => (Number(task.estimated_hours) > 0 ? <Num value={task.estimated_hours} digits={Number(task.estimated_hours) % 1 ? 2 : 0} /> : <span className="text-ink-400">—</span>) },
    {
      id: 'logged', header: 'Logged', accessor: (task) => Number(task.hours_logged) || 0, align: 'right', width: 120, mobile: 'trailing',
      cell: (task) => {
        const est = Number(task.estimated_hours || 0)
        const logged = Number(task.hours_logged || 0)
        const over = est > 0 && logged > est
        return (
          <span className="tabular-nums">
            {hrs(logged)}
            {over && <span className="ml-1.5 font-mono text-2xs text-risk-600" title="Logged more than estimated">▲ +{hrs(logged - est)}</span>}
          </span>
        )
      },
    },
    { id: 'due', header: 'Due', accessor: 'due_date', width: 120, cell: (task) => <DateText value={task.due_date} /> },
    // Status is editable in place: moving a task on is the most common thing
    // done to it, and this saves opening a dialog to change one field.
    {
      id: 'status', header: 'Status', accessor: 'status', width: 150, mobile: 'meta',
      editable: { type: 'select', options: TASK_STATUSES.map((s) => ({ value: s, label: TASK_LABEL[s] })) },
      cell: (task) => <StatusBadge status={task.status} label={TASK_LABEL[task.status]} />,
    },
  ], [])

  const timeColumns = useMemo(() => [
    { id: 'date', header: 'Date', accessor: 'entry_date', width: 120, mobile: 'meta', cell: (e) => <DateText value={e.entry_date} /> },
    { id: 'who', header: 'Who', accessor: (e) => [e.first_name, e.last_name].filter(Boolean).join(' '), filter: 'select', width: 160, mobile: 'title' },
    { id: 'task', header: 'Task', accessor: 'task_name', width: 160, cell: (e) => e.task_name || <span className="text-ink-400">—</span> },
    { id: 'notes', header: 'Notes', accessor: 'description', minWidth: 200, mobile: 'subtitle', cell: (e) => <span className="truncate">{e.description || <span className="text-ink-400">—</span>}</span> },
    { id: 'hours', header: 'Hours', accessor: (e) => Number(e.hours) || 0, align: 'right', width: 90, cell: (e) => <Num value={e.hours} digits={Number(e.hours) % 1 ? 2 : 0} />, footer: (rows) => <Num value={rows.reduce((s, r) => s + (Number(r.hours) || 0), 0)} digits={2} /> },
    {
      id: 'value', header: 'Value', accessor: (e) => (e.billable ? Number(e.hours) * Number(e.hourly_rate || 0) : null), align: 'right', width: 150, mobile: 'trailing',
      cell: (e) => (e.billable ? (
        <span className="inline-flex items-center gap-1.5">
          {e.invoice_id && <LockClosedIcon className="h-3 w-3 text-ink-400" aria-label="Invoiced" />}
          <Money amount={Number(e.hours) * Number(e.hourly_rate || 0)} currency={c} />
        </span>
      ) : <span className="text-xs text-ink-500">Non-billable</span>),
    },
  ], [c])

  if (loading) return <SkeletonDetail />
  if (error || !project) {
    return (
      <>
        <PageHeader title="Project" />
        {error ? <ErrorState what="This project" error={error} onRetry={refetch} /> : (
          <EmptyState title="That project could not be found" description="It may have been removed, or the link is wrong." action={<Button to="/projects">All projects</Button>} />
        )}
      </>
    )
  }

  const done = tasks.filter((task) => task.status === 'DONE').length
  const usedPct = pnl?.hours?.budget_used_pct
  const unbilledHours = Number(pnl?.hours?.unbilled ?? project.hours_unbilled) || 0

  const header = (
    <PageHeader
      title={project.name}
      status={<StatusBadge status={project.status} />}
      meta={[project.project_code, project.customer_name, BILLING[project.billing_type] || project.billing_type].filter(Boolean).join(' · ')}
      secondary={
        <>
          <Button icon={DocumentTextIcon} onClick={() => setBillOpen(true)} disabled={!(unbilledHours > 0)} title={unbilledHours > 0 ? undefined : 'No unbilled time on this project'}>Bill</Button>
          <Button variant="ghost" icon={ClockIcon} to="/projects/timesheet">Timesheet</Button>
        </>
      }
      primary={<Button variant="primary" icon={ClockIcon} onClick={() => setLogOpen(true)}>Log time</Button>}
    />
  )

  return (
    <>
      <DetailLayout
        header={header}
        notice={pnl?.cost?.note ? <InlineNotice tone="warn" title="Check the cost figures">{pnl.cost.note}</InlineNotice> : pnlError ? <ErrorState compact what="Profit and loss" error={pnlError} onRetry={refetchPnl} /> : null}
        summary={
          <SummaryStrip
            facts={[
              { label: 'Revenue invoiced', value: <Money amount={pnl?.revenue?.invoiced} currency={c} />, hint: pnl ? `${pnl.revenue.invoice_count} invoice${pnl.revenue.invoice_count === 1 ? '' : 's'}` : undefined },
              { label: 'Cost', value: <Money amount={pnl?.cost?.total} currency={c} />, hint: pnl ? (Number(pnl.cost.other) > 0 ? `${formatMoney(pnl.cost.labour, c)} labour + ${formatMoney(pnl.cost.other, c)} other` : 'Labour only') : undefined },
              { label: 'Margin', value: <Money amount={pnl?.margin} currency={c} className={Number(pnl?.margin) < 0 ? 'text-risk-700' : ''} />, hint: pnl ? (pnl.margin_pct != null ? `${formatNumber(pnl.margin_pct, 1)}%` : 'No revenue invoiced yet') : undefined },
              { label: 'Unbilled', value: <Money amount={pnl?.revenue?.unbilled_wip} currency={c} />, hint: pnl ? `${hrs(pnl.hours.unbilled)} hours not yet invoiced` : undefined },
              { label: 'Budget', value: pnl?.hours?.budget != null ? `${hrs(pnl.hours.logged)} / ${hrs(pnl.hours.budget)} h` : '—', hint: usedPct != null ? (usedPct > 100 ? `▲ over by ${hrs(pnl.hours.logged - pnl.hours.budget)} h` : `${formatNumber(usedPct)}% used`) : 'No budget set' },
            ]}
          />
        }
        aside={
          <Card title="Project">
            <DescriptionList
              columns={1}
              items={[
                { label: 'Code', value: <Code>{project.project_code}</Code> },
                { label: 'Customer', value: project.customer_name },
                { label: 'Billing', value: BILLING[project.billing_type] || project.billing_type },
                { label: 'Hourly rate', value: project.default_hourly_rate != null ? <Money amount={project.default_hourly_rate} currency={c} /> : null },
                { label: 'Fixed price', value: project.fixed_price != null ? <Money amount={project.fixed_price} currency={c} /> : null },
                { label: 'Hours logged', value: pnl ? `${hrs(pnl.hours.logged)} h · ${hrs(pnl.hours.billable)} h billable` : null },
              ]}
            />
          </Card>
        }
      >
        <Tabs
          value={tab}
          onChange={setTab}
          label="Project sections"
          tabs={[{ id: 'tasks', label: 'Tasks', count: tasks.length }, { id: 'time', label: 'Time logged', count: entries.length }]}
        >
          {(t) => (
            <>
              {t === 'tasks' && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm text-ink-600">{tasks.length ? `${done} of ${tasks.length} complete` : 'No work breakdown yet'}</p>
                    <Button size="sm" icon={PlusIcon} onClick={() => setTaskOpen(true)}>Add task</Button>
                  </div>
                  <DataTable
                    viewKey="projects.tasks"
                    caption="Tasks"
                    noun="task"
                    rows={tasks}
                    columns={taskColumns}
                    search={tasks.length > 12}
                    showCount={false}
                    onCellEdit={async (task, colId, value) => {
                      if (colId !== 'status' || value === task.status) return
                      await updateTask.mutateAsync({ task, status: value })
                      notify.success(`${task.name} → ${TASK_LABEL[value] || value}`)
                    }}
                    empty={{ title: 'No tasks yet', description: 'Break the project into tasks so time can be logged against each one and overruns show early.', action: <Button variant="primary" icon={PlusIcon} onClick={() => setTaskOpen(true)}>Add task</Button> }}
                  />
                </div>
              )}
              {t === 'time' && (
                <DataTable
                  viewKey="projects.detail-time"
                  caption="Time logged"
                  noun="entry"
                  rows={entries}
                  columns={timeColumns}
                  loading={timeLoading}
                  error={timeError}
                  onRetry={refetchTime}
                  defaultSort={{ id: 'date', dir: 'desc' }}
                  empty={{ title: 'No time logged against this project', description: 'Log time here or from your timesheet.', action: <Button variant="primary" icon={ClockIcon} onClick={() => setLogOpen(true)}>Log time</Button> }}
                />
              )}
            </>
          )}
        </Tabs>
      </DetailLayout>

      {taskOpen && <TaskDialog projectId={id} onClose={() => setTaskOpen(false)} />}
      {logOpen && <LogTimeDialog project={project} onClose={() => setLogOpen(false)} />}
      {billOpen && <BillDialog project={project} onClose={() => setBillOpen(false)} />}
    </>
  )
}

function TaskDialog({ projectId, onClose }) {
  const [form, setForm] = useState({ name: '', description: '', estimated_hours: '', due_date: '' })
  const [touched, setTouched] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const create = useResourceMutation((payload) => projectsAPI.createTask(payload), {
    invalidates: [['projects', projectId]],
    onSuccess: () => { notify.success('Task added'); onClose() },
  })
  const nameError = !form.name.trim() ? 'A task needs a name.' : null

  const submit = () => {
    setSubmitted(true)
    if (nameError) return
    create.mutate({
      project_id: projectId,
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      estimated_hours: form.estimated_hours ? Number(form.estimated_hours) : undefined,
      due_date: form.due_date || undefined,
    })
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add task"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} loading={create.isPending}>Add task</Button></>}
    >
      <div className="space-y-4">
        {submitted && nameError && <ErrorSummary errors={{ 'task-name': nameError }} />}
        <FormSection>
          <Field label="Name" required id="task-name" error={(touched || submitted) ? nameError : null} className="sm:col-span-2">
            <Input value={form.name} onChange={set('name')} onBlur={() => setTouched(true)} />
          </Field>
          <Field label="Notes" optional id="task-notes" className="sm:col-span-2">
            <Textarea rows={2} value={form.description} onChange={set('description')} />
          </Field>
          <Field label="Estimated hours" optional id="task-estimate">
            <Input type="number" step="0.25" min="0" inputMode="decimal" value={form.estimated_hours} onChange={set('estimated_hours')} />
          </Field>
          <Field label="Due date" optional id="task-due">
            <Input type="date" value={form.due_date} onChange={set('due_date')} />
          </Field>
        </FormSection>
      </div>
    </Dialog>
  )
}
