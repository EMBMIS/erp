import { useMemo, useState } from 'react'
import { PlusIcon, EyeIcon, PencilSquareIcon, TrashIcon, DocumentTextIcon, ArrowDownTrayIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useAuth } from '../../contexts/AuthContext'
import {
  PageHeader, Button, DataTable, RowAction, StatusBadge, Money, Num, Code, DateText, ConfirmDialog,
  Segmented, InlineNotice, Stat, exportCsv, daysFrom, notify,
} from '../../components/ui'

/**
 * Sales quotations — every offer made to a customer, as one working list.
 *
 * Loaded in one request (up to LIMIT) so sorting, filtering and saved views
 * work across the whole set. The old status / priority / customer / expiry
 * dropdowns are now column filters and quick views.
 */
const LIMIT = 1000
const CLOSED = new Set(['ACCEPTED', 'REJECTED', 'CANCELLED'])
const intentOf = (s) => (/^PENDING/.test(s) ? 'warning' : /RESPONDED$|APPROVED/.test(s) ? 'success' : /^SENT/.test(s) ? 'info' : undefined)
const humanize = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
const isQuotationExpired = (q) => !CLOSED.has(q.status) && q.valid_until && daysFrom(q.valid_until) < 0

const QUICK = {
  all: { label: 'All', test: () => true },
  drafts: { label: 'Drafts', test: (q) => q.status === 'DRAFT' },
  waiting: { label: 'Waiting approval', test: (q) => q.status === 'PENDING_APPROVAL' || q.status === 'PENDING_SEND_APPROVAL' },
  ready: { label: 'Ready to send', test: (q) => q.status === 'APPROVED' || q.status === 'APPROVED_FOR_SEND' },
  sent: { label: 'With customer', test: (q) => q.status === 'SENT' },
  accepted: { label: 'Accepted', test: (q) => q.status === 'ACCEPTED' },
  expired: { label: 'Expired', test: (q) => q.status === 'EXPIRED' || isQuotationExpired(q) },
}

export default function SalesQuotationsList() {
  const { user } = useAuth()
  const canDelete = user?.role === 'MANAGER' || user?.role === 'ADMIN'
  const [quick, setQuick] = useState('all')
  const [confirm, setConfirm] = useState(null) // quotation to delete

  const params = { limit: LIMIT }
  const { data, loading, error, refetch } = useResource(keys.salesQuotations(params), ({ signal }) => api.get('/sales-quotations', { params, signal }))
  const quotations = useMemo(() => (Array.isArray(data) ? data : data?.data || []), [data])
  const { data: stats, loading: statsLoading } = useResource(['sales-quotations-stats'], ({ signal }) => api.get('/sales-quotations/stats', { signal }))

  const remove = useResourceMutation((id) => api.delete(`/sales-quotations/${id}`), { invalidates: [['sales-quotations'], ['sales-quotations-stats']], silent: true })

  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, quotations.filter(q.test).length])), [quotations])

  const columns = useMemo(() => [
    {
      id: 'number', header: 'Quotation', accessor: 'quotation_number', width: 160, mobile: 'title',
      cell: (q) => (
        <span className="block min-w-0">
          <Code>{q.quotation_number}</Code>
          {q.reference_number && <span className="block truncate text-2xs text-ink-500">Ref {q.reference_number}</span>}
        </span>
      ),
    },
    {
      id: 'customer', header: 'Customer', accessor: 'customer_name', filter: 'text', mobile: 'subtitle', minWidth: 180, maxWidth: 280,
      cell: (q) => (
        <span className="block min-w-0">
          <span className="block truncate">{q.customer_name || '—'}</span>
          {q.customer_email && <span className="block truncate text-2xs text-ink-500">{q.customer_email}</span>}
        </span>
      ),
    },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', cell: (q) => <StatusBadge status={q.status} intent={intentOf(q.status)} />, mobile: 'meta', width: 160 },
    { id: 'date', header: 'Quoted', accessor: 'quotation_date', cell: (q) => <DateText value={q.quotation_date} />, width: 120 },
    {
      id: 'valid', header: 'Valid until', accessor: 'valid_until', width: 140,
      cell: (q) => (
        <span className="flex items-center gap-1.5">
          <DateText value={q.valid_until} />
          {isQuotationExpired(q) && <span className="font-mono text-2xs text-risk-600" title="The validity date has passed">▲ expired</span>}
        </span>
      ),
    },
    { id: 'lines', header: 'Lines', accessor: (q) => (q.item_count == null ? null : Number(q.item_count)), align: 'right', width: 70, cell: (q) => <Num value={q.item_count} /> },
    {
      id: 'total', header: 'Total', accessor: (q) => Number(q.total_amount), align: 'right', filter: 'number', width: 140, mobile: 'trailing',
      cell: (q) => <Money amount={q.total_amount} currency={q.currency || 'USD'} />,
      footer: (rows) => {
        const currencies = [...new Set(rows.map((r) => r.currency || 'USD'))]
        if (currencies.length !== 1) return <span className="text-xs font-normal text-ink-500">Mixed currencies</span>
        return <Money amount={rows.reduce((s, r) => s + (Number(r.total_amount) || 0), 0)} currency={currencies[0]} />
      },
      exportValue: (q) => q.total_amount,
    },
    { id: 'priority', header: 'Priority', accessor: 'priority', filter: 'select', width: 100, defaultHidden: true, cell: (q) => (q.priority ? humanize(q.priority) : '—') },
    { id: 'currency', header: 'Currency', accessor: 'currency', width: 90, defaultHidden: true, filter: 'select' },
    { id: 'qty', header: 'Total qty', accessor: (q) => (q.total_quantity == null ? null : Number(q.total_quantity)), align: 'right', width: 100, defaultHidden: true, cell: (q) => <Num value={q.total_quantity} digits={Number(q.total_quantity) % 1 ? 2 : 0} /> },
    { id: 'createdBy', header: 'Raised by', accessor: 'created_by_name', filter: 'text', width: 140, defaultHidden: true },
    { id: 'created', header: 'Raised', accessor: 'created_at', cell: (q) => <DateText value={q.created_at} />, width: 120, defaultHidden: true },
  ], [])

  const doDelete = async () => {
    const q = confirm
    try {
      await remove.mutateAsync(q.id)
      setConfirm(null)
      notify.success(`${q.quotation_number} deleted`)
    } catch (e) {
      setConfirm(null)
      const d = e?.response?.data || {}
      notify.error(`${q.quotation_number} was not deleted: ${d.error || e.message}${d.error_id ? ` (reference ${d.error_id})` : ''}`)
    }
  }

  const s = stats || {}
  const rate = s.acceptance_rate
  return (
    <>
      <PageHeader
        title="Sales quotations"
        description="Offers to customers — from draft, through approval, to the customer's answer and the sales order."
        secondary={<Button icon={ArrowDownTrayIcon} onClick={() => exportCsv(quotations.filter(QUICK[quick].test), columns, 'sales-quotations.csv')} disabled={!quotations.length}>Export</Button>}
        primary={<Button variant="primary" icon={PlusIcon} to="/sales/quotations/create" kbd="N">New quotation</Button>}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Quotations" loading={statsLoading} value={s.total_quotations != null ? Number(s.total_quotations).toLocaleString() : '—'} onClick={() => setQuick('all')} />
        <Stat label="Accepted" loading={statsLoading} value={s.accepted_quotations != null ? Number(s.accepted_quotations).toLocaleString() : '—'} onClick={() => setQuick('accepted')} />
        <Stat label="Quoted value" loading={statsLoading} value={<Money amount={s.total_value} />} footnote="Sum of all quotation totals; currencies are not converted" />
        <Stat label="Acceptance rate" loading={statsLoading} value={rate != null && rate !== '' ? `${Number(rate).toLocaleString(undefined, { maximumFractionDigits: 1 })}%` : '—'} footnote="Accepted ÷ (accepted + rejected)" />
      </div>

      {quotations.length >= LIMIT && (
        <InlineNotice tone="warn" className="mb-3" title={`Showing the first ${LIMIT.toLocaleString()} quotations`}>
          Use the column filters or search to narrow the list. Older quotations are still in the system.
        </InlineNotice>
      )}

      <DataTable
        viewKey="sales.quotations"
        caption="Sales quotations"
        noun="quotation"
        rows={quotations}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        rowHref={(q) => `/sales/quotations/${q.id}`}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'date', dir: 'desc' }}
        searchPlaceholder="Search quotation, customer, reference"
        toolbarStart={
          <Segmented
            label="Show"
            value={quick}
            onChange={setQuick}
            options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))}
            className="max-w-full overflow-x-auto"
          />
        }
        rowActions={(q) => (
          <>
            <RowAction icon={EyeIcon} label={`Open ${q.quotation_number}`} to={`/sales/quotations/${q.id}`} />
            {!CLOSED.has(q.status) && <RowAction icon={PencilSquareIcon} label={`Edit ${q.quotation_number}`} to={`/sales/quotations/${q.id}/edit`} />}
            {canDelete && <RowAction icon={TrashIcon} tone="risk" label={`Delete ${q.quotation_number}`} onClick={() => setConfirm(q)} />}
          </>
        )}
        empty={{
          icon: DocumentTextIcon,
          title: 'No quotations yet',
          description: 'A quotation prices goods for a customer. Once accepted it converts into a sales order.',
          action: <Button variant="primary" icon={PlusIcon} to="/sales/quotations/create">New quotation</Button>,
        }}
      />

      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={doDelete}
          title={`Delete ${confirm.quotation_number}?`}
          consequence={`The quotation for ${confirm.customer_name || 'this customer'} and its lines are removed from every list.`}
          confirmLabel={`Delete ${confirm.quotation_number}`}
          confirmText={confirm.quotation_number}
          tone="danger"
          busy={remove.isPending}
        />
      )}
    </>
  )
}
