import { useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { PlusIcon, TrashIcon, Squares2X2Icon, EyeIcon, ArrowPathIcon } from '@heroicons/react/20/solid'
import { reportsAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useRecordTitle } from '../../components/shell/ShellContext'
import {
  PageHeader, Button, IconButton, Menu, DataTable, RowAction, Badge, Card, EmptyState, ErrorState, SkeletonDetail,
  ConfirmDialog, Dialog, Field, Input, Select, Textarea, Checkbox, InlineNotice, Num, notify, describeError,
} from '../../components/ui'

// Matches the widget_type CHECK constraint. Chart types render as a horizontal
// bar comparison of the first label column against the first numeric column —
// enough to read a shape without pulling in a charting dependency.
const WIDGET_TYPES = [
  { key: 'METRIC', label: 'Single number', hint: 'The first value of the first row' },
  { key: 'TABLE', label: 'Table', hint: 'The rows as they come back' },
  { key: 'BAR', label: 'Bar comparison', hint: 'First text column against first number column' },
  { key: 'TEXT', label: 'Note', hint: 'Free text, no report' },
]

// Tailwind only ships classes it can see written out, so each span is spelled.
const SPAN = {
  1: 'lg:col-span-1', 2: 'lg:col-span-2', 3: 'lg:col-span-3', 4: 'lg:col-span-4', 5: 'lg:col-span-5', 6: 'lg:col-span-6',
  7: 'lg:col-span-7', 8: 'lg:col-span-8', 9: 'lg:col-span-9', 10: 'lg:col-span-10', 11: 'lg:col-span-11', 12: 'lg:col-span-12',
}

/** First column whose sampled values are all numeric. */
const firstNumericColumn = (columns, rows) =>
  columns.find((c) => rows.length > 0 && rows.slice(0, 20).every((r) => {
    const v = r[c]
    return v === null || v === undefined || v === '' || !isNaN(Number(v))
  }))

const firstTextColumn = (columns, rows, exclude) =>
  columns.find((c) => c !== exclude && rows.some((r) => isNaN(Number(r[c])))) || columns[0]

const isNum = (v) => v !== null && v !== undefined && v !== '' && !isNaN(Number(v))

const DASHBOARDS_KEY = keys.dashboards()

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function DashboardList() {
  const [createOpen, setCreateOpen] = useState(false)
  const { data, loading, error, refetch } = useResource(DASHBOARDS_KEY, () => reportsAPI.listDashboards())
  const dashboards = useMemo(() => (Array.isArray(data) ? data : []), [data])

  const columns = useMemo(() => [
    {
      id: 'name', header: 'Dashboard', accessor: 'name', mobile: 'title', minWidth: 220, maxWidth: 420,
      cell: (d) => (
        <span className="block min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="truncate font-medium text-fg">{d.name}</span>
            {d.is_default && <Badge tone="ink">Default</Badge>}
          </span>
          {d.description && <span className="block truncate text-xs text-ink-500">{d.description}</span>}
        </span>
      ),
    },
    { id: 'widgets', header: 'Widgets', accessor: (d) => Number(d.widget_count) || 0, align: 'right', width: 100, mobile: 'trailing', cell: (d) => <Num value={d.widget_count} /> },
    { id: 'sharing', header: 'Visible to', accessor: (d) => (d.is_shared ? 'Everyone' : 'Only you'), filter: 'select', width: 130, mobile: 'subtitle' },
  ], [])

  return (
    <>
      <PageHeader
        title="Dashboards"
        description="Arrangements of saved reports. A dashboard holds no data of its own — each widget runs a saved report."
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setCreateOpen(true)} kbd="N">New dashboard</Button>}
      />
      <DataTable
        viewKey="reports.dashboards"
        caption="Dashboards"
        noun="dashboard"
        rows={dashboards}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        rowHref={(d) => `/reports/dashboards/${d.id}`}
        defaultSort={{ id: 'name', dir: 'asc' }}
        searchPlaceholder="Search dashboards"
        rowActions={(d) => <RowAction icon={EyeIcon} label={`Open ${d.name}`} to={`/reports/dashboards/${d.id}`} />}
        empty={{
          icon: Squares2X2Icon,
          title: 'No dashboards yet',
          description: 'A dashboard holds no data of its own — each widget runs a saved report, so what it shows is always what that report says.',
          action: <Button variant="primary" icon={PlusIcon} onClick={() => setCreateOpen(true)}>New dashboard</Button>,
        }}
      />
      {createOpen && <CreateDashboardDialog onClose={() => setCreateOpen(false)} />}
    </>
  )
}

function CreateDashboardDialog({ onClose }) {
  const navigate = useNavigate()
  const [form, setForm] = useState({ name: '', description: '', is_shared: false })
  const [touched, setTouched] = useState(false)
  const [serverError, setServerError] = useState(null)
  const create = useResourceMutation((payload) => reportsAPI.createDashboard(payload), { invalidates: [DASHBOARDS_KEY], silent: true })
  const nameError = touched && !form.name.trim() ? 'Give the dashboard a name.' : null

  const submit = async () => {
    setTouched(true)
    if (!form.name.trim()) return
    setServerError(null)
    try {
      const created = await create.mutateAsync({ ...form, name: form.name.trim() })
      notify.success('Dashboard created')
      navigate(`/reports/dashboards/${created?.id}`)
    } catch (e) {
      setServerError(describeError(e).message)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="New dashboard"
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending}>Create dashboard</Button>
        </>
      }
    >
      <div className="space-y-4">
        {serverError && <InlineNotice tone="risk" title="Not created">{serverError}</InlineNotice>}
        <Field label="Name" required error={nameError}>
          <Input value={form.name} onBlur={() => setTouched(true)} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Finance at a glance" />
        </Field>
        <Field label="Description" optional>
          <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <Checkbox label="Share with everyone" checked={form.is_shared} onChange={(e) => setForm({ ...form, is_shared: e.target.checked })} />
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export function DashboardView() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [addOpen, setAddOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState(null) // { kind: 'widget', widget } | { kind: 'dashboard' }

  // render() runs every widget's report, so this is both the layout and the
  // data in one call.
  const viewKey = [...DASHBOARDS_KEY, id, 'render']
  const { data: dashboard, loading, error, refetch, isFetching } = useResource(viewKey, () => reportsAPI.renderDashboard(id), { enabled: !!id })
  useRecordTitle(dashboard?.name)

  const removeWidget = useResourceMutation((widgetId) => reportsAPI.removeWidget(widgetId), { invalidates: [viewKey, DASHBOARDS_KEY], silent: true })
  const removeDashboard = useResourceMutation(() => reportsAPI.deleteDashboard(id), { invalidates: [DASHBOARDS_KEY], silent: true })

  if (loading) return <SkeletonDetail />
  if (error || !dashboard) {
    return <ErrorState what="This dashboard" error={error || { response: { status: 404, data: { error: 'This dashboard does not exist or is not shared with you.' } } }} onRetry={refetch} />
  }

  const widgets = dashboard.widgets || []

  const run = async () => {
    try {
      if (confirm.kind === 'widget') {
        await removeWidget.mutateAsync(confirm.widget.id)
        setConfirm(null)
      } else {
        await removeDashboard.mutateAsync()
        setConfirm(null)
        notify.success(`${dashboard.name} deleted`)
        navigate('/reports/dashboards')
      }
    } catch (e) {
      setConfirm(null)
      notify.error(`Not done — ${describeError(e).message}`)
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={dashboard.name}
        description={dashboard.description}
        meta={<span>{widgets.length} {widgets.length === 1 ? 'widget' : 'widgets'} · each runs its report when the dashboard opens</span>}
        secondary={
          <>
            <Button icon={ArrowPathIcon} onClick={() => refetch()} loading={isFetching && !loading}>Run again</Button>
            <Button onClick={() => setEditing(!editing)} aria-pressed={editing}>{editing ? 'Done arranging' : 'Arrange'}</Button>
            <Menu items={[{ label: 'Delete this dashboard', icon: TrashIcon, tone: 'risk', onSelect: () => setConfirm({ kind: 'dashboard' }) }]} />
          </>
        }
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setAddOpen(true)}>Add widget</Button>}
      />

      {widgets.length === 0 ? (
        <Card>
          <EmptyState
            icon={Squares2X2Icon}
            title="This dashboard is empty"
            description="Add a widget pointing at one of your saved reports."
            action={<Button variant="primary" icon={PlusIcon} onClick={() => setAddOpen(true)}>Add widget</Button>}
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          {widgets.map((w) => (
            <Card
              key={w.id}
              className={SPAN[Math.min(Math.max(Number(w.width) || 6, 1), 12)]}
              title={w.title || w.report_name || 'Note'}
              description={w.title && w.report_name ? w.report_name : undefined}
              padded={false}
              actions={editing ? <IconButton icon={TrashIcon} size="sm" label={`Remove ${w.title || w.report_name || 'note'}`} onClick={() => setConfirm({ kind: 'widget', widget: w })} /> : null}
            >
              <Widget widget={w} />
            </Card>
          ))}
        </div>
      )}

      {addOpen && <AddWidgetDialog dashboardId={id} invalidates={[viewKey, DASHBOARDS_KEY]} onClose={() => setAddOpen(false)} />}

      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={run}
          title={confirm.kind === 'widget' ? `Remove ${confirm.widget.title || confirm.widget.report_name || 'this note'}?` : `Delete ${dashboard.name}?`}
          consequence={confirm.kind === 'widget'
            ? 'The widget leaves this dashboard. The report it shows is not affected.'
            : 'The dashboard and its widget layout are deleted for everyone who could see it. Its reports are not affected.'}
          confirmLabel={confirm.kind === 'widget' ? 'Remove widget' : `Delete ${dashboard.name}`}
          busy={removeWidget.isPending || removeDashboard.isPending}
        />
      )}
    </div>
  )
}

/**
 * One widget's body.
 *
 * A widget whose report failed says so and names the error, rather than
 * rendering as empty — an empty panel and a broken panel look identical
 * otherwise, and only one of them means "there is nothing to report".
 */
function Widget({ widget }) {
  if (widget.widget_type === 'TEXT') {
    return (
      <div className="whitespace-pre-wrap p-4 text-sm text-ink-700">
        {widget.config?.text || <span className="text-ink-500">Empty note</span>}
      </div>
    )
  }

  if (widget.error) {
    return (
      <div className="p-4">
        <InlineNotice tone="risk" title="This widget could not be rendered">{widget.error}</InlineNotice>
      </div>
    )
  }

  const data = widget.data
  if (!data) return <p className="p-4 text-sm text-ink-500">No data came back for this widget.</p>

  const { columns = [], rows = [] } = data
  if (rows.length === 0) return <p className="p-6 text-center text-sm text-ink-500">No rows matched.</p>

  if (widget.widget_type === 'METRIC') {
    const col = widget.config?.column || firstNumericColumn(columns, rows) || columns[0]
    const v = rows[0][col]
    return (
      <div className="p-5">
        <p className="text-3xl font-semibold tabular-nums tracking-tight text-fg">{isNum(v) ? <Num value={v} digits={Number(v) % 1 ? 2 : 0} /> : String(v ?? '—')}</p>
        <p className="mt-1 font-mono text-2xs uppercase tracking-wide text-ink-500">{col}</p>
        {rows.length > 1 && <p className="mt-1 text-xs text-ink-500">First of {rows.length} rows</p>}
      </div>
    )
  }

  if (widget.widget_type === 'BAR' || widget.widget_type === 'LINE' || widget.widget_type === 'PIE') {
    const valueCol = widget.config?.value_column || firstNumericColumn(columns, rows)
    const labelCol = widget.config?.label_column || firstTextColumn(columns, rows, valueCol)
    if (!valueCol) return <p className="p-4 text-sm text-ink-500">This report has no numeric column to chart.</p>
    const top = rows.slice(0, 12)
    const max = Math.max(...top.map((r) => Math.abs(Number(r[valueCol]) || 0)), 1)
    // Every bar carries its own number, so the list doubles as the table view.
    return (
      <ul className="space-y-2 p-4" aria-label={`${valueCol} by ${labelCol}`}>
        {top.map((r, i) => (
          <li key={i}>
            <div className="mb-0.5 flex items-center justify-between gap-2 text-xs">
              <span className="truncate text-ink-700">{String(r[labelCol] ?? '—')}</span>
              <Num value={r[valueCol]} digits={Number(r[valueCol]) % 1 ? 2 : 0} className="text-ink-800" />
            </div>
            <div className="h-1.5 overflow-hidden rounded-sm bg-ink-100" aria-hidden="true">
              <div className="h-full rounded-sm bg-ink-700" style={{ width: `${Math.min(100, (Math.abs(Number(r[valueCol]) || 0) / max) * 100)}%` }} />
            </div>
          </li>
        ))}
        {rows.length > top.length && <li className="pt-1 text-xs text-ink-500">and {rows.length - top.length} more</li>}
      </ul>
    )
  }

  // TABLE
  return (
    <div className="max-h-72 overflow-auto ui-scroll">
      <table className="min-w-full text-xs">
        <thead className="sticky top-0 bg-sunken text-ink-600">
          <tr className="text-left">
            {columns.map((c) => <th key={c} scope="col" className={`whitespace-nowrap px-3 py-2 font-medium ${isNum(rows[0]?.[c]) ? 'text-right' : ''}`}>{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 100).map((r, i) => (
            <tr key={i} className="border-t border-ink-100">
              {columns.map((c) => (
                <td key={c} className={`whitespace-nowrap px-3 py-1.5 text-ink-800 ${isNum(r[c]) ? 'text-right tabular-nums' : ''}`}>
                  {r[c] === null || r[c] === undefined ? '' : String(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 100 && <p className="border-t border-ink-100 px-3 py-2 text-xs text-ink-500">Showing 100 of {rows.length} rows. Open the report for the rest.</p>}
    </div>
  )
}

function AddWidgetDialog({ dashboardId, invalidates, onClose }) {
  const [form, setForm] = useState({ report_id: '', title: '', widget_type: 'TABLE', width: 6, text: '' })
  const [touched, setTouched] = useState(false)
  const [serverError, setServerError] = useState(null)
  const { data: reportData, error: reportsError } = useResource(keys.reports(), () => reportsAPI.list())
  const reports = Array.isArray(reportData) ? reportData : []
  const add = useResourceMutation((payload) => reportsAPI.addWidget(dashboardId, payload), { invalidates, silent: true })

  const isText = form.widget_type === 'TEXT'
  const reportError = touched && !isText && !form.report_id ? 'Pick the report this widget shows.' : null

  const save = async () => {
    setTouched(true)
    if (!isText && !form.report_id) return
    setServerError(null)
    try {
      await add.mutateAsync({
        report_id: isText ? null : form.report_id,
        title: form.title || null,
        widget_type: form.widget_type,
        width: Number(form.width),
        height: 4,
        config: isText ? { text: form.text } : {},
      })
      onClose()
    } catch (e) {
      setServerError(describeError(e).message)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add widget"
      footer={
        <>
          <Button onClick={onClose} disabled={add.isPending}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={add.isPending}>Add widget</Button>
        </>
      }
    >
      <div className="space-y-4">
        {serverError && <InlineNotice tone="risk" title="Not added">{serverError}</InlineNotice>}
        <fieldset>
          <legend className="mb-1 text-sm font-medium text-ink-800">Type</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {WIDGET_TYPES.map((t) => (
              <label key={t.key} aria-label={t.label} className={`flex cursor-pointer items-start gap-2 rounded-md border p-2.5 ${form.widget_type === t.key ? 'border-ink-900 bg-sunken' : 'border-ink-200 hover:bg-ink-50'}`}>
                <input type="radio" name="widget-type" className="mt-0.5" checked={form.widget_type === t.key} onChange={() => setForm({ ...form, widget_type: t.key })} />
                <span>
                  <span className="block text-sm font-medium text-fg">{t.label}</span>
                  <span className="block text-xs text-ink-500">{t.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {isText ? (
          <Field label="Text">
            <Textarea value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} rows={4} />
          </Field>
        ) : (
          <Field label="Report" required error={reportError} help={reportsError ? 'The report list did not load.' : undefined}>
            <Select value={form.report_id} onBlur={() => setTouched(true)} onChange={(e) => setForm({ ...form, report_id: e.target.value })}>
              <option value="">Choose…</option>
              {reports.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>
          </Field>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Title" optional help="Defaults to the report's name.">
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label="Width">
            <Select value={form.width} onChange={(e) => setForm({ ...form, width: e.target.value })}>
              <option value={3}>Quarter</option>
              <option value={4}>Third</option>
              <option value={6}>Half</option>
              <option value={12}>Full width</option>
            </Select>
          </Field>
        </div>
      </div>
    </Dialog>
  )
}
