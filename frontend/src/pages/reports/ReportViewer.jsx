import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { PlayIcon, ArrowDownTrayIcon, PencilSquareIcon, PlusIcon, TrashIcon, DocumentChartBarIcon } from '@heroicons/react/20/solid'
import { reportsAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useRecordTitle } from '../../components/shell/ShellContext'
import {
  PageHeader, Button, IconButton, Menu, DataTable, StatusBadge, Badge, DateText, Num, Card, Tabs, EmptyState,
  ErrorState, InlineNotice, SkeletonDetail, Dialog, Field, Input, Select, Textarea, Checkbox, notify, describeError,
} from '../../components/ui'

// The formats the export endpoint serves. PDF and HTML open in a tab; CSV and
// JSON download.
const FORMATS = [
  { key: 'pdf', label: 'PDF' },
  { key: 'csv', label: 'CSV' },
  { key: 'json', label: 'JSON' },
  { key: 'html', label: 'HTML' },
]

/** Render one cell the way the PDF renderer does, so exports and screen agree. */
const formatCell = (v) => {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2)
  if (typeof v === 'object') return JSON.stringify(v)
  const s = String(v)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s.split('T')[0]
  return s
}

const isNumeric = (v) =>
  typeof v === 'number' || (typeof v === 'string' && /^-?[\d,]+(\.\d+)?$/.test(v.trim()))

export default function ReportViewer() {
  const { id } = useParams()
  const [values, setValues] = useState({})
  const [result, setResult] = useState(null)
  const [runError, setRunError] = useState(null)
  const [tab, setTab] = useState('results')
  const [editOpen, setEditOpen] = useState(false)

  const reportKey = [...keys.reports(), id]
  const { data: report, loading, error, refetch } = useResource(reportKey, () => reportsAPI.get(id), { enabled: !!id })
  useRecordTitle(report?.name)

  // Seed the parameter form with each declared default, so a report with
  // sensible defaults runs on the first click without any typing.
  useEffect(() => {
    if (!report) return
    const seeded = {}
    ;(report.parameters || []).forEach((p) => { seeded[p.name] = p.default ?? '' })
    setValues(seeded)
  }, [report])

  const runsKey = [...reportKey, 'runs']
  const runs = useResource(runsKey, () => reportsAPI.runs(id, { limit: 25 }), { enabled: !!id && tab === 'history' })

  const runReport = useResourceMutation((params) => reportsAPI.run(id, params), { invalidates: [runsKey, keys.reports()], silent: true })

  const run = async () => {
    setRunError(null)
    setTab('results')
    try {
      setResult(await runReport.mutateAsync(values))
    } catch (e) {
      setResult(null)
      setRunError(e)
    }
  }

  const exportAs = (format) => {
    // A plain link rather than an XHR: the browser streams the file straight to
    // disk, so a large export never passes through JavaScript memory. The
    // session cookie goes with it.
    window.open(reportsAPI.exportUrl(id, format, values), '_blank', 'noopener')
  }

  const resultRows = useMemo(() => (result?.rows || []).map((r, i) => ({ ...r, __row: i })), [result])
  const resultColumns = useMemo(() => {
    const cols = result?.columns || []
    return cols.map((c, i) => {
      const numeric = resultRows.slice(0, 20).some((r) => isNumeric(r[c]))
      return {
        id: `c${i}`,
        header: c,
        accessor: (r) => r[c],
        align: numeric ? 'right' : undefined,
        mobile: i === 0 ? 'title' : i === 1 ? 'subtitle' : i === cols.length - 1 && numeric ? 'trailing' : undefined,
        cell: (r) => <span className={numeric ? 'tabular-nums' : undefined}>{formatCell(r[c])}</span>,
        exportValue: (r) => formatCell(r[c]),
      }
    })
  }, [result, resultRows])

  if (loading) return <SkeletonDetail />
  if (error || !report) {
    return <ErrorState what="This report" error={error || { response: { status: 404, data: { error: 'This report does not exist or is not shared with you.' } } }} onRetry={refetch} />
  }

  const params = report.parameters || []

  const runColumns = [
    { id: 'when', header: 'When', accessor: 'run_at', width: 180, mobile: 'title', cell: (h) => <DateText value={h.run_at} withTime /> },
    {
      id: 'status', header: 'Status', accessor: 'status', width: 280, mobile: 'meta', filter: 'select',
      cell: (h) => (
        <span className="block min-w-0">
          <StatusBadge status={h.status === 'SUCCESS' ? 'DONE' : h.status === 'TRUNCATED' ? 'WARNING' : h.status} label={h.status === 'SUCCESS' ? 'Succeeded' : h.status === 'TRUNCATED' ? 'Truncated' : undefined} />
          {h.error && <span className="mt-0.5 block truncate text-xs text-risk-600" title={h.error}>{h.error}</span>}
        </span>
      ),
    },
    { id: 'rows', header: 'Rows', accessor: (h) => (h.row_count == null ? null : Number(h.row_count)), align: 'right', width: 100, mobile: 'trailing', cell: (h) => <Num value={h.row_count} /> },
    { id: 'duration', header: 'Duration', accessor: (h) => Number(h.duration_ms), align: 'right', width: 110, cell: (h) => <Num value={h.duration_ms} unit="ms" /> },
    { id: 'by', header: 'By', accessor: (h) => (h.schedule_id ? 'Scheduled' : [h.first_name, h.last_name].filter(Boolean).join(' ') || null), mobile: 'subtitle', cell: (h) => (h.schedule_id ? 'Scheduled' : [h.first_name, h.last_name].filter(Boolean).join(' ') || '—') },
  ]

  return (
    <div className="space-y-5">
      <PageHeader
        title={report.name}
        badge={report.is_system ? <Badge tone="ink">System</Badge> : null}
        description={report.description || (report.report_type === 'BUILTIN' ? 'Packaged report' : 'Saved query')}
        meta={
          <>
            <span>{report.report_type === 'BUILTIN' ? 'Packaged' : 'Query'}</span>
            <span>{report.is_shared ? 'Shared with everyone' : 'Only you'}</span>
            {report.category && <span className="font-mono uppercase">{report.category}</span>}
          </>
        }
        secondary={
          <>
            {/* System reports cannot be edited — the backend refuses. */}
            {!report.is_system && <Button icon={PencilSquareIcon} onClick={() => setEditOpen(true)}>Edit</Button>}
            <Menu
              label="Export"
              trigger={<Button icon={ArrowDownTrayIcon}>Export</Button>}
              items={FORMATS.map((f) => ({ label: f.label, onSelect: () => exportAs(f.key), hint: f.key === 'pdf' || f.key === 'html' ? 'opens' : 'downloads' }))}
            />
          </>
        }
        primary={<Button variant="primary" icon={PlayIcon} onClick={run} loading={runReport.isPending}>Run</Button>}
      />

      {params.length > 0 && (
        <Card title="Parameters" description="Bound as values when the report runs, and passed to exports.">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {params.map((p) => (
              <Field key={p.name} label={p.label || p.name} required={!!p.required}>
                {p.type === 'boolean' ? (
                  <Select value={String(values[p.name] ?? '')} onChange={(e) => setValues({ ...values, [p.name]: e.target.value })}>
                    <option value="">—</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </Select>
                ) : (
                  <Input
                    type={p.type === 'date' ? 'date' : p.type === 'number' ? 'number' : 'text'}
                    numeric={p.type === 'number'}
                    value={values[p.name] ?? ''}
                    onChange={(e) => setValues({ ...values, [p.name]: e.target.value })}
                  />
                )}
              </Field>
            ))}
          </div>
        </Card>
      )}

      <Tabs
        value={tab}
        onChange={setTab}
        label="Report sections"
        tabs={[{ id: 'results', label: 'Results', count: result ? result.row_count : undefined }, { id: 'history', label: 'Run history' }]}
      >
        {(t) => (t === 'results' ? (
          <div className="space-y-3">
            {runError && <ErrorState what="The report run" error={runError} onRetry={run} compact />}
            {result && (
              <>
                <p className="text-sm text-ink-600">
                  <Num value={result.row_count} /> {result.row_count === 1 ? 'row' : 'rows'}
                  <span className="text-ink-500"> · <Num value={result.duration_ms} unit="ms" /></span>
                </p>
                {result.truncated && (
                  <InlineNotice tone="warn" title="This report hit the row limit">
                    What you see is a truncated result set — narrow it with parameters or a tighter filter to be sure you are seeing everything.
                  </InlineNotice>
                )}
                {result.redacted_columns?.length > 0 && (
                  <InlineNotice tone="ink">Redacted for privacy: {result.redacted_columns.join(', ')}</InlineNotice>
                )}
                <DataTable
                  caption={`${report.name} results`}
                  noun="row"
                  rowKey={(r) => r.__row}
                  rows={resultRows}
                  columns={resultColumns}
                  search={resultRows.length > 10}
                  showCount={false}
                  height={560}
                  empty={{ title: 'No rows matched', description: params.length ? 'Change the parameters and run it again.' : 'The query ran and returned nothing.' }}
                />
              </>
            )}
            {!result && !runError && (
              <Card>
                <EmptyState
                  icon={DocumentChartBarIcon}
                  title="Not run yet"
                  description={params.length > 0 ? 'Fill in the parameters above and run it.' : 'Run it to see the results.'}
                  action={<Button variant="primary" icon={PlayIcon} onClick={run} loading={runReport.isPending}>Run</Button>}
                  compact
                />
              </Card>
            )}
          </div>
        ) : (
          <DataTable
            caption="Run history"
            noun="run"
            rows={Array.isArray(runs.data) ? runs.data : []}
            columns={runColumns}
            loading={runs.loading}
            error={runs.error}
            onRetry={runs.refetch}
            search={false}
            defaultSort={{ id: 'when', dir: 'desc' }}
            empty={{ title: 'No runs recorded', description: 'Every run — by hand, by a schedule or by a dashboard — is recorded here with its row count and duration.' }}
          />
        ))}
      </Tabs>

      {editOpen && <EditReportDialog report={report} invalidates={[reportKey, keys.reports()]} onClose={() => setEditOpen(false)} />}
    </div>
  )
}

function EditReportDialog({ report, invalidates, onClose }) {
  const [form, setForm] = useState({
    name: report.name,
    description: report.description || '',
    sql_text: report.sql_text || '',
    is_shared: report.is_shared,
  })
  const [params, setParams] = useState(report.parameters || [])
  const [serverError, setServerError] = useState(null)
  const [nameTouched, setNameTouched] = useState(false)

  const update = useResourceMutation((payload) => reportsAPI.update(report.id, payload), { invalidates, silent: true })
  const nameError = nameTouched && !form.name.trim() ? 'Give the report a name.' : null

  const save = async () => {
    setNameTouched(true)
    if (!form.name.trim()) return
    setServerError(null)
    const payload = {
      name: form.name,
      description: form.description || null,
      is_shared: form.is_shared,
      parameters: params,
    }
    // Only query reports have editable SQL; sending it for a packaged report
    // would overwrite the builtin key's report with a null query.
    if (report.report_type === 'QUERY') payload.sql_text = form.sql_text
    try {
      await update.mutateAsync(payload)
      notify.success('Report saved')
      onClose()
    } catch (e) {
      setServerError(describeError(e).message)
    }
  }

  const addParam = () => setParams([...params, { name: '', label: '', type: 'text', default: null, required: false }])
  const setParam = (i, patch) => setParams(params.map((p, j) => (i === j ? { ...p, ...patch } : p)))

  return (
    <Dialog
      open
      onClose={onClose}
      title="Edit report"
      size="xl"
      footer={
        <>
          <Button onClick={onClose} disabled={update.isPending}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={update.isPending}>Save</Button>
        </>
      }
    >
      <div className="space-y-4">
        {serverError && <InlineNotice tone="risk" title="Not saved">{serverError}</InlineNotice>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name" required error={nameError}>
            <Input value={form.name} onBlur={() => setNameTouched(true)} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Description" optional>
            <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
        </div>
        <Checkbox label="Share with everyone" checked={form.is_shared} onChange={(e) => setForm({ ...form, is_shared: e.target.checked })} />

        {report.report_type === 'QUERY' && (
          <Field label="SQL" help="Re-validated on save and again on every run.">
            <Textarea value={form.sql_text} onChange={(e) => setForm({ ...form, sql_text: e.target.value })} rows={10} spellCheck={false} className="font-mono text-xs" />
          </Field>
        )}

        <section aria-labelledby="report-params">
          <div className="mb-2 flex items-center justify-between">
            <h3 id="report-params" className="text-sm font-medium text-ink-800">Parameters</h3>
            <Button size="sm" variant="ghost" icon={PlusIcon} onClick={addParam}>Add parameter</Button>
          </div>
          {params.length === 0 ? (
            <p className="text-xs text-ink-500">None. A <code className="font-mono">:name</code> in the SQL must have a matching parameter declared here, or the report will not run.</p>
          ) : (
            <div className="space-y-2">
              {params.map((p, i) => (
                <div key={i} className="grid grid-cols-2 items-end gap-2 rounded-md border border-ink-200 p-2 sm:grid-cols-[8rem_minmax(0,1fr)_7rem_7rem_auto_auto]">
                  <Field label="Name"><Input size="sm" className="font-mono" value={p.name} onChange={(e) => setParam(i, { name: e.target.value })} /></Field>
                  <Field label="Label"><Input size="sm" value={p.label || ''} onChange={(e) => setParam(i, { label: e.target.value })} /></Field>
                  <Field label="Type">
                    <Select size="sm" value={p.type} onChange={(e) => setParam(i, { type: e.target.value })}>
                      {['text', 'number', 'date', 'boolean'].map((ty) => <option key={ty} value={ty}>{ty}</option>)}
                    </Select>
                  </Field>
                  <Field label="Default"><Input size="sm" value={p.default ?? ''} onChange={(e) => setParam(i, { default: e.target.value || null })} /></Field>
                  <Checkbox label="Required" className="pb-1.5" checked={p.required === true} onChange={(e) => setParam(i, { required: e.target.checked })} />
                  <IconButton icon={TrashIcon} label={`Remove parameter ${p.name || i + 1}`} onClick={() => setParams(params.filter((_, j) => j !== i))} />
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </Dialog>
  )
}
