import { useMemo, useState } from 'react'
import { PlusIcon, EyeIcon, CheckCircleIcon, TrashIcon, ClipboardDocumentListIcon, ArrowDownTrayIcon } from '@heroicons/react/20/solid'
import api from '../../../services/api'
import { useAuth } from '../../../contexts/AuthContext'
import { useResource, useResourceMutation } from '../../../hooks/useResource'
import { keys } from '../../../services/queryKeys'
import {
  PageHeader, Button, DataTable, RowAction, BulkAction, StatusBadge, Code, DateText, ConfirmDialog,
  Segmented, InlineNotice, exportCsv, daysFrom, notify,
} from '../../../components/ui'

/**
 * Requests for quotation — competitive quotes from suppliers before an order.
 */
const LIMIT = 1000
const OPEN = new Set(['SENT', 'RESPONSES_RECEIVED'])
const QUICK = {
  all: { label: 'All', test: () => true },
  drafts: { label: 'Drafts', test: (r) => r.status === 'DRAFT' },
  waiting: { label: 'Waiting approval', test: (r) => r.status === 'PENDING_APPROVAL' },
  out: { label: 'Out with suppliers', test: (r) => OPEN.has(r.status) },
  decide: { label: 'To decide', test: (r) => r.status === 'RESPONSES_RECEIVED' || r.status === 'EVALUATED' },
  done: { label: 'Awarded or closed', test: (r) => ['SUPPLIER_SELECTED', 'COMPLETED', 'CLOSED'].includes(r.status) },
}
const overdue = (r) => OPEN.has(r.status) && r.response_deadline && daysFrom(r.response_deadline) < 0

export default function RFQsList() {
  const { user } = useAuth()
  const isManager = user && (user.role === 'MANAGER' || user.role === 'ADMIN')
  const [quick, setQuick] = useState('all')
  const [confirm, setConfirm] = useState(null) // { kind, rows }

  const params = { limit: LIMIT, offset: 0 }
  const { data, loading, error, refetch } = useResource(keys.rfqs(params), ({ signal }) => api.get('/request-for-quotations', { params, signal }))
  const rfqs = useMemo(() => (Array.isArray(data) ? data : []), [data])

  const invalidates = [['rfqs']]
  const submit = useResourceMutation((id) => api.post(`/request-for-quotations/${id}/submit`), { invalidates, silent: true })
  const remove = useResourceMutation((id) => api.delete(`/request-for-quotations/${id}`), { invalidates, silent: true })
  const canDelete = (r) => r.status === 'DRAFT' || isManager

  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, rfqs.filter(q.test).length])), [rfqs])

  const columns = useMemo(() => [
    { id: 'rfq', header: 'RFQ', accessor: 'rfq_number', width: 150, cell: (r) => <Code>{r.rfq_number}</Code>, mobile: 'meta' },
    {
      id: 'title', header: 'Title', accessor: (r) => `${r.title || ''} ${r.pr_number || ''}`, minWidth: 220, maxWidth: 360, mobile: 'title',
      cell: (r) => (
        <span className="block min-w-0">
          <span className="block truncate">{r.title || '—'}</span>
          {r.pr_number && <span className="block truncate font-mono text-2xs text-ink-500">from {r.pr_number}</span>}
        </span>
      ),
    },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 190, mobile: 'subtitle', cell: (r) => <StatusBadge status={r.status} /> },
    { id: 'responses', header: 'Responses', accessor: (r) => Number(r.response_count) || 0, align: 'right', width: 110, cell: (r) => <span className="tabular-nums">{Number(r.response_count) || 0} / {Number(r.supplier_count) || 0}</span>, mobile: 'trailing' },
    { id: 'lines', header: 'Lines', accessor: (r) => Number(r.line_item_count) || 0, align: 'right', width: 80, defaultHidden: true },
    {
      id: 'deadline', header: 'Responses due', accessor: 'response_deadline', width: 160,
      cell: (r) => (
        <span className="flex items-center gap-1.5">
          <DateText value={r.response_deadline} />
          {overdue(r) && <span className="font-mono text-2xs text-risk-600" title="Deadline has passed">▲ {Math.abs(daysFrom(r.response_deadline))}d</span>}
        </span>
      ),
    },
    { id: 'winner', header: 'Selected supplier', accessor: 'winning_supplier_name', width: 180, defaultHidden: true },
    { id: 'by', header: 'Created by', accessor: 'created_by_name', filter: 'text', width: 140 },
    { id: 'created', header: 'Created', accessor: 'created_at', width: 120, cell: (r) => <DateText value={r.created_at} /> },
  ], [])

  const run = async () => {
    const { kind, rows } = confirm
    const fn = kind === 'submit' ? submit : remove
    let ok = 0
    const failed = []
    for (const r of rows) {
      try { await fn.mutateAsync(r.id); ok += 1 } catch (e) { failed.push(`${r.rfq_number}: ${e?.response?.data?.error || e.message}`) }
    }
    setConfirm(null)
    const verb = kind === 'submit' ? 'submitted for approval' : 'deleted'
    if (ok) notify.success(ok === 1 ? `${rows[0].rfq_number} ${verb}` : `${ok} RFQs ${verb}`)
    if (failed.length) notify.error(`Not done — ${failed.join('; ')}`)
  }

  const copy = confirm && (() => {
    const n = confirm.rows.length
    const what = n === 1 ? confirm.rows[0].rfq_number : `${n} RFQs`
    if (confirm.kind === 'submit') return { title: `Submit ${what} for approval?`, consequence: 'Once approved it can be sent to the invited suppliers. You cannot change lines or suppliers while it waits.', label: `Submit ${what}`, tone: 'primary' }
    const sent = confirm.rows.some((r) => r.status !== 'DRAFT')
    return { title: `Delete ${what}?`, consequence: sent ? 'At least one has gone beyond draft; suppliers may already have it and quotes received are deleted with it.' : 'The draft, its lines and invited suppliers are removed.', label: `Delete ${what}`, tone: 'danger', confirmText: n === 1 && sent ? confirm.rows[0].rfq_number : undefined }
  })()

  return (
    <>
      <PageHeader
        title="Requests for quotation"
        description="Ask several suppliers to quote, compare, and award — before raising a purchase order."
        secondary={<Button icon={ArrowDownTrayIcon} onClick={() => exportCsv(rfqs.filter(QUICK[quick].test), columns, 'rfqs.csv')} disabled={!rfqs.length}>Export</Button>}
        primary={<Button variant="primary" icon={PlusIcon} to="/procurement/rfqs/create" kbd="N">New RFQ</Button>}
      />

      {rfqs.length >= LIMIT && (
        <InlineNotice tone="warn" className="mb-3" title={`Showing the newest ${LIMIT.toLocaleString()} RFQs`}>Use search or the column filters to narrow the list.</InlineNotice>
      )}

      <DataTable
        viewKey="procurement.rfqs"
        caption="Requests for quotation"
        noun="RFQ"
        rows={rfqs}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        rowHref={(r) => `/procurement/rfqs/${r.id}`}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'created', dir: 'desc' }}
        searchPlaceholder="Search RFQ, title, requisition"
        toolbarStart={
          <Segmented
            label="Show"
            value={quick}
            onChange={setQuick}
            options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))}
            className="max-w-full overflow-x-auto"
          />
        }
        selectable
        isRowSelectable={(r) => r.status === 'DRAFT' || isManager}
        bulkActions={(sel, clear) => {
          const drafts = sel.filter((r) => r.status === 'DRAFT')
          const deletable = sel.filter(canDelete)
          return (
            <>
              {drafts.length > 0 && <BulkAction tone="primary" icon={CheckCircleIcon} onClick={() => { setConfirm({ kind: 'submit', rows: drafts }); clear() }}>Submit {drafts.length} for approval</BulkAction>}
              <BulkAction icon={ArrowDownTrayIcon} onClick={() => exportCsv(sel, columns, 'rfqs-selected.csv')}>Export</BulkAction>
              {deletable.length > 0 && <BulkAction tone="risk" icon={TrashIcon} onClick={() => { setConfirm({ kind: 'delete', rows: deletable }); clear() }}>Delete {deletable.length}</BulkAction>}
            </>
          )
        }}
        rowActions={(r) => (
          <>
            <RowAction icon={EyeIcon} label={`Open ${r.rfq_number}`} to={`/procurement/rfqs/${r.id}`} />
            {r.status === 'DRAFT' && <RowAction icon={CheckCircleIcon} label={`Submit ${r.rfq_number} for approval`} onClick={() => setConfirm({ kind: 'submit', rows: [r] })} />}
            {canDelete(r) && <RowAction icon={TrashIcon} tone="risk" label={`Delete ${r.rfq_number}`} onClick={() => setConfirm({ kind: 'delete', rows: [r] })} />}
          </>
        )}
        empty={{
          icon: ClipboardDocumentListIcon,
          title: 'No RFQs yet',
          description: 'An RFQ invites suppliers to quote on your lines. Start one from scratch or from an approved requisition.',
          action: <Button variant="primary" icon={PlusIcon} to="/procurement/rfqs/create">New RFQ</Button>,
        }}
      />

      {copy && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={run}
          title={copy.title}
          consequence={copy.consequence}
          reversible={false}
          confirmLabel={copy.label}
          tone={copy.tone}
          confirmText={copy.confirmText}
          busy={submit.isPending || remove.isPending}
        />
      )}
    </>
  )
}
