import { useMemo, useState } from 'react'
import { PlusIcon, EyeIcon, TrashIcon, DocumentChartBarIcon, ClockIcon, Squares2X2Icon } from '@heroicons/react/20/solid'
import { reportsAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, DataTable, RowAction, Badge, DateText, ConfirmDialog, Dialog, Segmented,
  Field, Input, Select, Textarea, Checkbox, ErrorSummary, InlineNotice, useFieldValidation, notify, describeError,
} from '../../components/ui'

/**
 * Reports — the saved-report library: packaged reports and saved queries
 * that can be run, exported, scheduled and placed on dashboards.
 */

// Categories the picker offers. Free text is still accepted by the backend —
// this is a shortlist, not a constraint, so an unfamiliar category coming back
// from the server still displays correctly.
const CATEGORIES = ['GENERAL', 'FINANCE', 'SALES', 'PROCUREMENT', 'INVENTORY', 'HR', 'PROJECTS']

const humanize = (s) => String(s || '').toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

export default function Reports() {
  const [category, setCategory] = useState('all')
  const [createOpen, setCreateOpen] = useState(false)
  const [confirm, setConfirm] = useState(null)

  const { data, loading, error, refetch } = useResource(keys.reports(), () => reportsAPI.list())
  const reports = useMemo(() => (Array.isArray(data) ? data : []), [data])

  const remove = useResourceMutation((id) => reportsAPI.remove(id), { invalidates: [keys.reports()], silent: true })

  // Quick views follow the categories actually present, so a custom category
  // the server returns is reachable too.
  const present = useMemo(() => [...new Set(reports.map((r) => r.category || 'GENERAL'))].sort(), [reports])
  const quick = [{ value: 'all', label: `All ${reports.length || ''}`.trim() }, ...present.map((c) => ({ value: c, label: `${humanize(c)} ${reports.filter((r) => (r.category || 'GENERAL') === c).length}` }))]

  const columns = useMemo(() => [
    {
      id: 'name', header: 'Report', accessor: 'name', mobile: 'title', minWidth: 220, maxWidth: 420,
      cell: (r) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium text-fg">{r.name}</span>
          {r.description && <span className="block truncate text-xs text-ink-500">{r.description}</span>}
        </span>
      ),
    },
    { id: 'category', header: 'Category', accessor: (r) => r.category || 'GENERAL', filter: 'select', width: 140, mobile: 'subtitle', cell: (r) => humanize(r.category || 'GENERAL') },
    {
      id: 'type', header: 'Type', accessor: (r) => (r.report_type === 'BUILTIN' ? 'Packaged' : 'Query'), filter: 'select', width: 150,
      cell: (r) => (
        <span className="flex items-center gap-1.5">
          {r.report_type === 'BUILTIN' ? 'Packaged' : 'Query'}
          {r.is_system && <Badge tone="ink">System</Badge>}
        </span>
      ),
    },
    { id: 'sharing', header: 'Visible to', accessor: (r) => (r.is_shared ? 'Everyone' : 'Only you'), filter: 'select', width: 120, mobile: 'meta' },
    {
      id: 'lastRun', header: 'Last run', accessor: 'last_run_at', width: 140, mobile: 'trailing',
      cell: (r) => (r.last_run_at ? <DateText value={r.last_run_at} /> : <span className="text-ink-500">Never run</span>),
    },
  ], [])

  const run = async () => {
    const r = confirm
    try {
      await remove.mutateAsync(r.id)
      setConfirm(null)
      notify.success(`${r.name} deleted`)
    } catch (e) {
      setConfirm(null)
      notify.error(`Not deleted — ${describeError(e).message}`)
    }
  }

  return (
    <>
      <PageHeader
        title="Reports"
        description="Saved queries you can run, export and schedule."
        secondary={
          <>
            <Button icon={Squares2X2Icon} to="/reports/dashboards">Dashboards</Button>
            <Button icon={ClockIcon} to="/reports/schedules">Schedules</Button>
          </>
        }
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setCreateOpen(true)} kbd="N">New report</Button>}
      />

      <DataTable
        viewKey="reports.library"
        caption="Reports"
        noun="report"
        rows={reports}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        rowHref={(r) => `/reports/${r.id}`}
        externalFilter={category === 'all' ? undefined : (r) => (r.category || 'GENERAL') === category}
        defaultSort={{ id: 'name', dir: 'asc' }}
        searchPlaceholder="Search reports"
        toolbarStart={present.length > 1 ? <Segmented label="Category" value={category} onChange={setCategory} options={quick} className="max-w-full overflow-x-auto" /> : null}
        rowActions={(r) => (
          <>
            <RowAction icon={EyeIcon} label={`Open ${r.name}`} to={`/reports/${r.id}`} />
            {/* System reports have no delete — the backend refuses, so offering
                the button would only produce an error. */}
            <RowAction icon={TrashIcon} tone="risk" label={`Delete ${r.name}`} disabled={r.is_system} reason="System reports cannot be deleted" onClick={() => setConfirm(r)} />
          </>
        )}
        empty={{
          icon: DocumentChartBarIcon,
          title: 'No reports yet',
          description: 'Start from one of the packaged reports — trial balance, aged receivables, sales by customer — or write your own query.',
          action: <Button variant="primary" icon={PlusIcon} onClick={() => setCreateOpen(true)}>New report</Button>,
        }}
      />

      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={run}
          title={`Delete ${confirm.name}?`}
          consequence="The report leaves the library for everyone who could see it. Its run history is kept."
          confirmLabel={`Delete ${confirm.name}`}
          busy={remove.isPending}
        />
      )}

      {createOpen && <CreateReportDialog onClose={() => setCreateOpen(false)} />}
    </>
  )
}

const RULES = {
  name: (v) => (!String(v || '').trim() ? 'Give the report a name.' : null),
  builtin_key: (v, all) => (all.mode === 'BUILTIN' && !v ? 'Pick a packaged report to start from.' : null),
  sql_text: (v, all) => (all.mode === 'QUERY' && !String(v || '').trim() ? 'A query report needs SQL.' : null),
}

function CreateReportDialog({ onClose }) {
  const [form, setForm] = useState({ mode: 'BUILTIN', name: '', description: '', category: 'GENERAL', builtin_key: '', sql_text: '', is_shared: false })
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState(null)
  const { errors, onBlur, validateAll } = useFieldValidation(form, RULES)
  const set = (patch) => setForm((f) => ({ ...f, ...patch }))

  const { data: builtinData, error: builtinError } = useResource(['reports', 'builtins'], () => reportsAPI.builtins())
  const { data: schema } = useResource(['reports', 'schema'], () => reportsAPI.schema())
  const builtins = Array.isArray(builtinData) ? builtinData : []
  const tables = schema?.tables || []
  const maxRows = schema?.max_rows ?? null

  const create = useResourceMutation((payload) => reportsAPI.create(payload), { invalidates: [keys.reports()], silent: true })

  const save = async () => {
    const found = validateAll()
    setSubmitted(true)
    if (Object.keys(found).length) return
    setServerError(null)
    try {
      await create.mutateAsync({
        name: form.name.trim(),
        description: form.description || null,
        category: form.category,
        report_type: form.mode,
        builtin_key: form.mode === 'BUILTIN' ? form.builtin_key : undefined,
        sql_text: form.mode === 'QUERY' ? form.sql_text : undefined,
        is_shared: form.is_shared,
      })
      notify.success(`${form.name.trim()} created`)
      onClose()
    } catch (e) {
      // The backend explains exactly why a query was rejected (which table is
      // not on the allowlist, which statement type is refused) — far more
      // useful than anything this form could invent.
      setServerError(describeError(e).message)
    }
  }

  const shown = errors

  return (
    <Dialog
      open
      onClose={onClose}
      title="New report"
      size="lg"
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={create.isPending}>Create report</Button>
        </>
      }
    >
      <div className="space-y-4">
        {submitted && <ErrorSummary errors={Object.fromEntries(Object.entries(errors).map(([k, v]) => [`report-${k}`, v]))} />}
        {serverError && <InlineNotice tone="risk" title="The report was not created">{serverError}</InlineNotice>}

        <Segmented
          label="Start from"
          size="md"
          value={form.mode}
          onChange={(mode) => set({ mode })}
          options={[{ value: 'BUILTIN', label: 'A packaged report' }, { value: 'QUERY', label: 'A query I write' }]}
        />

        {form.mode === 'BUILTIN' ? (
          <Field label="Packaged report" required id="report-builtin_key" error={shown.builtin_key} help={builtinError ? 'The packaged report catalogue did not load.' : 'Packaged reports have their SQL fixed in the application, so they cannot be edited into something else.'}>
            <Select
              value={form.builtin_key}
              onBlur={onBlur('builtin_key')}
              onChange={(e) => set({ builtin_key: e.target.value, name: form.name || builtins.find((b) => b.key === e.target.value)?.name || '' })}
            >
              <option value="">Choose…</option>
              {builtins.map((b) => <option key={b.key} value={b.key}>{b.name}</option>)}
            </Select>
          </Field>
        ) : (
          <Field
            label="SQL"
            required
            id="report-sql_text"
            error={shown.sql_text}
            help={<>Read-only. Use <code className="font-mono">:name</code> for parameters — they are bound as values, never pasted into the query.{maxRows != null && <> Results are capped at {maxRows.toLocaleString()} rows.</>}</>}
          >
            <Textarea
              value={form.sql_text}
              onBlur={onBlur('sql_text')}
              onChange={(e) => set({ sql_text: e.target.value })}
              rows={8}
              spellCheck={false}
              className="font-mono text-xs"
              placeholder={'SELECT customer_name, SUM(total_amount) AS revenue\nFROM customer_invoices\nWHERE invoice_date >= :from_date\nGROUP BY customer_name'}
            />
          </Field>
        )}
        {form.mode === 'QUERY' && tables.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-ink-600 hover:text-fg">{tables.length} tables available</summary>
            <div className="mt-2 flex flex-wrap gap-1">
              {tables.map((t) => <Badge key={t} mono>{t}</Badge>)}
            </div>
          </details>
        )}

        <Field label="Name" required id="report-name" error={shown.name}>
          <Input value={form.name} onBlur={onBlur('name')} onChange={(e) => set({ name: e.target.value })} placeholder="Aged receivables by region" />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Category">
            <Select value={form.category} onChange={(e) => set({ category: e.target.value })}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}
            </Select>
          </Field>
          <Field label="Description" optional>
            <Input value={form.description} onChange={(e) => set({ description: e.target.value })} />
          </Field>
        </div>

        <Checkbox label="Share with everyone" description="Anyone in the company can find and run it. Otherwise only you can." checked={form.is_shared} onChange={(e) => set({ is_shared: e.target.checked })} />
      </div>
    </Dialog>
  )
}
