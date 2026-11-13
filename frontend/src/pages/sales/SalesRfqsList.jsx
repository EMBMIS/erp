import { useMemo, useState } from 'react'
import { PlusIcon, EyeIcon, PencilSquareIcon, TrashIcon, DocumentTextIcon, ArrowDownTrayIcon, CheckCircleIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useAuth } from '../../contexts/AuthContext'
import {
  PageHeader, Button, DataTable, RowAction, BulkAction, StatusBadge, Money, Num, Code, DateText, ConfirmDialog,
  Segmented, InlineNotice, Stat, exportCsv, notify,
} from '../../components/ui'

/**
 * RFQs to suppliers raised from sales — asking a supplier to price goods a
 * customer wants. One list, loaded in one request (up to LIMIT); the old
 * status / priority / type / overdue dropdowns are column filters and quick views.
 */
const LIMIT = 1000
const CLOSED = new Set(['COMPLETED', 'CANCELLED'])
const humanize = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
const intentOf = (s) => (/^PENDING/.test(s) ? 'warning' : /RESPONDED$|APPROVED/.test(s) ? 'success' : /^SENT/.test(s) ? 'info' : undefined)
const PENDING = new Set(['PENDING_DUAL_APPROVAL', 'PENDING_SALES_APPROVAL', 'PENDING_PROCUREMENT_APPROVAL'])

const QUICK = {
  all: { label: 'All', test: () => true },
  drafts: { label: 'Drafts', test: (r) => r.status === 'DRAFT' },
  waiting: { label: 'Waiting approval', test: (r) => PENDING.has(r.status) && r.overall_approval_status !== 'FULLY_APPROVED' },
  ready: { label: 'Ready to send', test: (r) => r.status === 'APPROVED' || (PENDING.has(r.status) && r.overall_approval_status === 'FULLY_APPROVED') },
  out: { label: 'With supplier', test: (r) => r.status === 'SENT' || r.status === 'PARTIALLY_RESPONDED' },
  responded: { label: 'Responded', test: (r) => r.status === 'RESPONDED' || r.status === 'SUPPLIER_RESPONDED' },
  overdue: { label: 'Overdue', test: (r) => Boolean(r.is_overdue) },
}

export default function SalesRfqsList() {
  const { user } = useAuth()
  const canDelete = user?.role === 'MANAGER' || user?.role === 'ADMIN'
  const [quick, setQuick] = useState('all')
  const [confirm, setConfirm] = useState(null) // { kind: 'submit' | 'delete', rfqs }

  const params = { limit: LIMIT }
  const { data, loading, error, refetch } = useResource(keys.salesRfqs(params), ({ signal }) => api.get('/sales-rfqs', { params, signal }))
  const rfqs = useMemo(() => (Array.isArray(data) ? data : data?.data || []), [data])
  const { data: stats, loading: statsLoading } = useResource(['sales-rfqs-stats'], ({ signal }) => api.get('/sales-rfqs/stats', { signal }))

  const invalidates = [['sales-rfqs'], ['sales-rfqs-stats']]
  const submit = useResourceMutation((id) => api.post(`/sales-rfqs/${id}/send`, { send_method: 'EMAIL' }), { invalidates, silent: true })
  const remove = useResourceMutation((id) => api.delete(`/sales-rfqs/${id}`), { invalidates, silent: true })

  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, rfqs.filter(q.test).length])), [rfqs])

  const columns = useMemo(() => [
    { id: 'number', header: 'RFQ', accessor: 'rfq_number', cell: (r) => <Code>{r.rfq_number}</Code>, width: 150, mobile: 'title' },
    { id: 'title', header: 'Title', accessor: 'rfq_title', filter: 'text', minWidth: 180, maxWidth: 300, mobile: 'subtitle', cell: (r) => <span className="block truncate">{r.rfq_title || '—'}</span> },
    {
      id: 'supplier', header: 'Supplier', accessor: (r) => r.supplier_company_name || r.supplier_name, filter: 'text', minWidth: 160, maxWidth: 260,
      cell: (r) => (
        <span className="block min-w-0">
          <span className="block truncate">{r.supplier_company_name || r.supplier_name || '—'}</span>
          {r.supplier_contact_person && <span className="block truncate text-2xs text-ink-500">{r.supplier_contact_person}</span>}
        </span>
      ),
    },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', cell: (r) => <StatusBadge status={r.status} intent={intentOf(r.status)} />, mobile: 'meta', width: 210 },
    {
      id: 'deadline', header: 'Response due', accessor: 'response_deadline', width: 160,
      cell: (r) => (
        <span className="flex items-center gap-1.5">
          <DateText value={r.response_deadline} />
          {r.is_overdue && <span className="font-mono text-2xs text-risk-600" title="The response deadline has passed">▲ overdue</span>}
        </span>
      ),
    },
    {
      id: 'quoted', header: 'Quoted', accessor: (r) => (r.supplier_total_amount == null ? null : Number(r.supplier_total_amount)), align: 'right', filter: 'number', width: 140, mobile: 'trailing',
      cell: (r) => (r.supplier_total_amount ? <Money amount={r.supplier_total_amount} currency={r.supplier_currency || 'USD'} /> : <span className="text-xs text-ink-500">No response</span>),
      exportValue: (r) => r.supplier_total_amount,
    },
    { id: 'lines', header: 'Lines', accessor: (r) => (r.item_count == null ? null : Number(r.item_count)), align: 'right', width: 80, cell: (r) => <Num value={r.item_count} /> },
    { id: 'priority', header: 'Priority', accessor: 'priority', filter: 'select', width: 100, cell: (r) => (r.priority ? humanize(r.priority) : '—') },
    { id: 'type', header: 'Type', accessor: 'request_type', filter: 'select', width: 120, defaultHidden: true, cell: (r) => (r.request_type ? humanize(r.request_type) : '—') },
    { id: 'delivery', header: 'Needed by', accessor: 'required_delivery_date', width: 120, defaultHidden: true, cell: (r) => <DateText value={r.required_delivery_date} /> },
    { id: 'responded', header: 'Response received', accessor: 'response_received_at', width: 150, defaultHidden: true, cell: (r) => <DateText value={r.response_received_at} /> },
    { id: 'created', header: 'Raised', accessor: 'created_at', cell: (r) => <DateText value={r.created_at} />, width: 120, defaultHidden: true },
  ], [])

  const run = async () => {
    const { kind, rfqs: targets } = confirm
    const fn = kind === 'submit' ? submit : remove
    let ok = 0
    const failed = []
    for (const r of targets) {
      try { await fn.mutateAsync(r.id); ok += 1 } catch (e) { failed.push(`${r.rfq_number}: ${e?.response?.data?.error || e.message}`) }
    }
    setConfirm(null)
    const verb = kind === 'submit' ? 'submitted for approval' : 'deleted'
    if (ok) notify.success(ok === 1 ? `${targets[0].rfq_number} ${verb}` : `${ok} RFQs ${verb}`)
    if (failed.length) notify.error(`Not done — ${failed.join('; ')}`)
  }

  const confirmCopy = confirm && (() => {
    const n = confirm.rfqs.length
    const what = n === 1 ? confirm.rfqs[0].rfq_number : `${n} RFQs`
    if (confirm.kind === 'submit') return { title: `Submit ${what} for approval?`, consequence: 'Sales and procurement both approve an RFQ before it is emailed to the supplier.', label: `Submit ${what}`, tone: 'primary' }
    return { title: `Delete ${what}?`, consequence: 'The RFQ and its lines are removed from every list. The supplier is not told.', label: `Delete ${what}`, tone: 'danger', confirmText: n === 1 ? confirm.rfqs[0].rfq_number : undefined }
  })()

  const s = stats || {}
  const count = (v) => (v != null ? Number(v).toLocaleString() : '—')
  return (
    <>
      <PageHeader
        title="RFQs to suppliers"
        description="Ask a supplier to price what a customer wants — approved by sales and procurement, then sent, answered and turned into a purchase order."
        secondary={<Button icon={ArrowDownTrayIcon} onClick={() => exportCsv(rfqs.filter(QUICK[quick].test), columns, 'sales-rfqs.csv')} disabled={!rfqs.length}>Export</Button>}
        primary={<Button variant="primary" icon={PlusIcon} to="/sales/rfqs/create" kbd="N">New RFQ</Button>}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="RFQs" loading={statsLoading} value={count(s.total_rfqs)} onClick={() => setQuick('all')} />
        <Stat label="With supplier" loading={statsLoading} value={count(s.sent_rfqs)} onClick={() => setQuick('out')} />
        <Stat label="Responded" loading={statsLoading} value={count(s.responded_rfqs)} reason={s.partially_responded_rfqs ? `${count(s.partially_responded_rfqs)} partly` : undefined} onClick={() => setQuick('responded')} />
        <Stat label="Overdue" loading={statsLoading} value={count(s.overdue_rfqs)} onClick={() => setQuick('overdue')} />
      </div>

      {rfqs.length >= LIMIT && (
        <InlineNotice tone="warn" className="mb-3" title={`Showing the first ${LIMIT.toLocaleString()} RFQs`}>
          Use the column filters or search to narrow the list. Older RFQs are still in the system.
        </InlineNotice>
      )}

      <DataTable
        viewKey="sales.rfqs"
        caption="RFQs to suppliers"
        noun="RFQ"
        rows={rfqs}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        rowHref={(r) => `/sales/rfqs/${r.id}`}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'deadline', dir: 'desc' }}
        searchPlaceholder="Search RFQ, title, supplier"
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
        isRowSelectable={(r) => r.status === 'DRAFT'}
        bulkActions={(sel, clear) => (
          <>
            <BulkAction tone="primary" icon={CheckCircleIcon} onClick={() => { setConfirm({ kind: 'submit', rfqs: sel }); clear() }}>Submit {sel.length} for approval</BulkAction>
            <BulkAction icon={ArrowDownTrayIcon} onClick={() => exportCsv(sel, columns, 'sales-rfqs-selected.csv')}>Export</BulkAction>
          </>
        )}
        rowActions={(r) => (
          <>
            <RowAction icon={EyeIcon} label={`Open ${r.rfq_number}`} to={`/sales/rfqs/${r.id}`} />
            {r.status === 'DRAFT' && <RowAction icon={CheckCircleIcon} label={`Submit ${r.rfq_number} for approval`} onClick={() => setConfirm({ kind: 'submit', rfqs: [r] })} />}
            {!CLOSED.has(r.status) && <RowAction icon={PencilSquareIcon} label={`Edit ${r.rfq_number}`} to={`/sales/rfqs/${r.id}/edit`} />}
            {canDelete && <RowAction icon={TrashIcon} tone="risk" label={`Delete ${r.rfq_number}`} onClick={() => setConfirm({ kind: 'delete', rfqs: [r] })} />}
          </>
        )}
        empty={{
          icon: DocumentTextIcon,
          title: 'No RFQs to suppliers yet',
          description: 'Raise one when a customer wants goods you do not stock — or import the lines from a confirmed sales order.',
          action: <Button variant="primary" icon={PlusIcon} to="/sales/rfqs/create">New RFQ</Button>,
        }}
      />

      {confirmCopy && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={run}
          title={confirmCopy.title}
          consequence={confirmCopy.consequence}
          confirmLabel={confirmCopy.label}
          confirmText={confirmCopy.confirmText}
          tone={confirmCopy.tone}
          busy={submit.isPending || remove.isPending}
        />
      )}
    </>
  )
}
