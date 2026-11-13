import { useMemo, useState } from 'react'
import { ArrowDownTrayIcon, ClipboardDocumentListIcon, ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/20/solid'
import { auditTrailAPI } from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { PageHeader, Button, DataTable, StatusBadge, Code, DateText, Field, Input, Select } from '../../components/ui'

/**
 * Audit trail — every status change across the system, in one feed. Limited
 * to managers and administrators on the server.
 */

const PAGE_SIZE = 100
const label = (s) => String(s || '').replace(/_/g, ' ').toLowerCase()
const sentence = (s) => label(s).replace(/^./, (c) => c.toUpperCase())

// Exported from what is on screen rather than re-queried: the export should be
// the thing that was looked at, filters and all. Cells that a spreadsheet
// would read as a formula are neutralised.
function exportEntries(entries) {
  const columns = ['occurred_at', 'entity_type', 'entity_id', 'from_status', 'to_status', 'changed_by_name', 'reason']
  const escape = (v) => {
    if (v === null || v === undefined) return ''
    let s = String(v)
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
    if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`
    return s
  }
  const csv = [columns.join(','), ...entries.map((e) => columns.map((c) => escape(e[c])).join(','))].join('\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `audit-trail-${new Date().toISOString().split('T')[0]}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

export default function AuditTrail() {
  const [page, setPage] = useState(0)
  const [filters, setFilters] = useState({ entity_type: '', date_from: '', date_to: '' })
  const setFilter = (patch) => { setFilters((f) => ({ ...f, ...patch })); setPage(0) }

  const params = { limit: PAGE_SIZE, offset: page * PAGE_SIZE }
  if (filters.entity_type) params.entity_type = filters.entity_type
  if (filters.date_from) params.date_from = filters.date_from
  if (filters.date_to) params.date_to = filters.date_to

  const { data, loading, error, refetch, isPlaceholderData } = useResource(keys.auditTrail(params), () => auditTrailAPI.list(params), { placeholderData: (prev) => prev })
  const entries = useMemo(() => (Array.isArray(data) ? data.map((e, i) => ({ ...e, __key: `${e.entity_type}-${e.entity_id}-${e.occurred_at}-${i}` })) : []), [data])
  const types = useResource(['audit-trail', 'entity-types'], () => auditTrailAPI.entityTypes())
  const entityTypes = Array.isArray(types.data) ? types.data : []

  const columns = useMemo(() => [
    { id: 'when', header: 'When', accessor: 'occurred_at', width: 180, mobile: 'trailing', cell: (e) => <DateText value={e.occurred_at} withTime /> },
    {
      id: 'what', header: 'What', accessor: (e) => sentence(e.entity_type), filter: 'select', mobile: 'title', minWidth: 180,
      cell: (e) => (
        <span className="block min-w-0">
          <span className="block truncate text-fg">{sentence(e.entity_type)}</span>
          {e.entity_id && <Code className="block text-2xs text-ink-500">{String(e.entity_id).slice(0, 8)}</Code>}
        </span>
      ),
    },
    {
      id: 'change', header: 'Change', accessor: (e) => e.to_status, filter: 'select', minWidth: 240, mobile: 'meta',
      cell: (e) => (
        <span className="flex items-center gap-1.5 whitespace-nowrap text-xs">
          {e.from_status && <><span className="text-ink-500">{label(e.from_status)}</span><span className="text-ink-400" aria-label="to">→</span></>}
          {e.to_status ? <StatusBadge status={e.to_status} /> : <span className="text-ink-400">—</span>}
        </span>
      ),
    },
    { id: 'who', header: 'Who', accessor: 'changed_by_name', filter: 'select', width: 160, mobile: 'subtitle', cell: (e) => e.changed_by_name || <span className="text-ink-400">—</span> },
    { id: 'reason', header: 'Reason', accessor: 'reason', minWidth: 200, cell: (e) => (e.reason ? <span className="block truncate" title={e.reason}>{e.reason}</span> : <span className="text-ink-400">—</span>) },
  ], [])

  const filtered = filters.entity_type || filters.date_from || filters.date_to

  return (
    <>
      <PageHeader
        title="Audit trail"
        description="Every status change across the system, in one feed."
        secondary={<Button icon={ArrowDownTrayIcon} onClick={() => exportEntries(entries)} disabled={!entries.length}>Export this page</Button>}
      />

      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Record type">
          <Select value={filters.entity_type} onChange={(e) => setFilter({ entity_type: e.target.value })}>
            <option value="">Everything</option>
            {entityTypes.map((t) => <option key={t} value={t}>{sentence(t)}</option>)}
          </Select>
        </Field>
        <Field label="From">
          <Input type="date" value={filters.date_from} onChange={(e) => setFilter({ date_from: e.target.value })} />
        </Field>
        <Field label="To">
          <Input type="date" value={filters.date_to} onChange={(e) => setFilter({ date_to: e.target.value })} />
        </Field>
      </div>

      <DataTable
        viewKey="admin.audit-trail"
        caption="Audit trail"
        noun="change"
        rowKey={(e) => e.__key}
        rows={entries}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        defaultSort={{ id: 'when', dir: 'desc' }}
        searchPlaceholder="Search this page"
        empty={{
          icon: ClipboardDocumentListIcon,
          title: filtered ? 'Nothing recorded for these filters' : 'Nothing recorded yet',
          description: filtered ? 'Widen the dates or choose Everything.' : 'Status changes appear here as records are submitted, approved, posted or cancelled.',
        }}
      />

      {/* The endpoint returns a page, not a total, so paging is offered by
          whether this page came back full rather than by a page count. */}
      <nav aria-label="Pages" className="mt-3 flex items-center justify-between">
        <Button size="sm" icon={ChevronLeftIcon} onClick={() => setPage((p) => p - 1)} disabled={page === 0 || loading}>Previous</Button>
        <span className="text-xs text-ink-500">Page {page + 1}{isPlaceholderData ? ' · loading…' : ''}</span>
        <Button size="sm" iconRight={ChevronRightIcon} onClick={() => setPage((p) => p + 1)} disabled={entries.length < PAGE_SIZE || loading}>Next</Button>
      </nav>
    </>
  )
}
