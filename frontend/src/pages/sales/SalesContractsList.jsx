import { useMemo, useState } from 'react'
import { PlusIcon, EyeIcon, PencilSquareIcon, TrashIcon, DocumentTextIcon, ArrowDownTrayIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useAuth } from '../../contexts/AuthContext'
import {
  PageHeader, Button, DataTable, RowAction, StatusBadge, Money, Num, Code, DateText, ConfirmDialog,
  Segmented, InlineNotice, Stat, exportCsv, notify,
} from '../../components/ui'

/**
 * Sales contracts — long-term price and quantity agreements with customers
 * (and the supplier side of back-to-back deals). One list, loaded in one
 * request (up to LIMIT); the old dropdowns are column filters and quick views.
 */
const LIMIT = 1000
const humanize = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
const intentOf = (s) => (/^PENDING/.test(s) ? 'warning' : /APPROVED/.test(s) ? 'success' : /^SENT/.test(s) ? 'info' : undefined)

const QUICK = {
  all: { label: 'All', test: () => true },
  drafts: { label: 'Drafts', test: (c) => c.status === 'DRAFT' },
  waiting: { label: 'Waiting approval', test: (c) => c.status === 'PENDING_APPROVAL' },
  customer: { label: 'With customer', test: (c) => c.status === 'SENT_TO_CUSTOMER' },
  active: { label: 'Active', test: (c) => c.status === 'ACTIVE' },
  expiring: { label: 'Expiring soon', test: (c) => Boolean(c.expiring_soon) },
}

export default function SalesContractsList() {
  const { user } = useAuth()
  const canDelete = user?.role === 'MANAGER' || user?.role === 'ADMIN'
  const [quick, setQuick] = useState('all')
  const [confirm, setConfirm] = useState(null)

  const params = { limit: LIMIT }
  const { data, loading, error, refetch } = useResource(keys.salesContracts(params), ({ signal }) => api.get('/sales-contracts', { params, signal }))
  const contracts = useMemo(() => (Array.isArray(data) ? data : data?.data || []), [data])
  const { data: stats, loading: statsLoading } = useResource(['sales-contracts-stats'], ({ signal }) => api.get('/sales-contracts/stats', { signal }))
  const remove = useResourceMutation((id) => api.delete(`/sales-contracts/${id}`), { invalidates: [['sales-contracts'], ['sales-contracts-stats']], silent: true })

  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, contracts.filter(q.test).length])), [contracts])

  const columns = useMemo(() => [
    { id: 'number', header: 'Contract', accessor: 'contract_number', cell: (c) => <Code>{c.contract_number}</Code>, width: 140, mobile: 'title' },
    { id: 'name', header: 'Name', accessor: 'contract_name', filter: 'text', minWidth: 150, maxWidth: 300, mobile: 'subtitle', cell: (c) => <span className="block truncate">{c.contract_name || '—'}</span> },
    {
      id: 'party', header: 'Party', accessor: (c) => c.customer_name || c.supplier_name, filter: 'text', minWidth: 150, maxWidth: 260,
      cell: (c) => (
        <span className="block min-w-0">
          <span className="block truncate">{c.customer_name || c.supplier_name || '—'}</span>
          <span className="block text-2xs text-ink-500">{c.customer_id ? 'Customer' : c.supplier_id ? 'Supplier' : ''}</span>
        </span>
      ),
    },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', cell: (c) => <StatusBadge status={c.status} intent={intentOf(c.status)} />, mobile: 'meta', width: 130 },
    { id: 'approval', header: 'Approval', accessor: 'approval_status', filter: 'select', width: 120, cell: (c) => (c.approval_status ? <StatusBadge status={c.approval_status} /> : <span className="text-ink-400">—</span>) },
    {
      id: 'period', header: 'Ends', accessor: 'end_date', width: 130,
      cell: (c) => (
        <span className="flex items-center gap-1.5" title={c.start_date ? `Runs from ${new Date(c.start_date).toLocaleDateString()}` : undefined}>
          <DateText value={c.end_date} />
          {c.expiring_soon && <span className="font-mono text-2xs text-warn-700" title="Within the expiry notice period">▲</span>}
        </span>
      ),
    },
    {
      id: 'value', header: 'Value', accessor: (c) => (c.contract_value == null ? null : Number(c.contract_value)), align: 'right', filter: 'number', width: 130, mobile: 'trailing',
      cell: (c) => <Money amount={c.contract_value} currency={c.currency || 'USD'} />,
      exportValue: (c) => c.contract_value,
    },
    { id: 'lines', header: 'Lines', accessor: (c) => (c.item_count == null ? null : Number(c.item_count)), align: 'right', width: 80, defaultHidden: true, cell: (c) => <Num value={c.item_count} /> },
    { id: 'type', header: 'Type', accessor: 'contract_type', filter: 'select', width: 110, defaultHidden: true, cell: (c) => (c.contract_type ? humanize(c.contract_type) : '—') },
    { id: 'currency', header: 'Currency', accessor: 'currency', width: 90, defaultHidden: true, filter: 'select' },
    { id: 'created', header: 'Created', accessor: 'created_at', cell: (c) => <DateText value={c.created_at} />, width: 120, defaultHidden: true },
  ], [])

  const doDelete = async () => {
    const c = confirm
    try {
      await remove.mutateAsync(c.id)
      setConfirm(null)
      notify.success(`${c.contract_number} deleted`)
    } catch (e) {
      setConfirm(null)
      const d = e?.response?.data || {}
      notify.error(`${c.contract_number} was not deleted: ${d.error || e.message}${d.error_id ? ` (reference ${d.error_id})` : ''}`)
    }
  }

  const s = stats || {}
  const count = (v) => (v != null ? Number(v).toLocaleString() : '—')
  return (
    <>
      <PageHeader
        title="Sales contracts"
        description="Agreed prices and quantities over a period — drafted, approved, accepted by the customer, then active until they expire."
        secondary={<Button icon={ArrowDownTrayIcon} onClick={() => exportCsv(contracts.filter(QUICK[quick].test), columns, 'sales-contracts.csv')} disabled={!contracts.length}>Export</Button>}
        primary={<Button variant="primary" icon={PlusIcon} to="/sales/contracts/create" kbd="N">New contract</Button>}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Active" loading={statsLoading} value={count(s.active_contracts)} reason={s.total_contracts != null ? `of ${count(s.total_contracts)} contracts` : undefined} onClick={() => setQuick('active')} />
        <Stat label="Waiting approval" loading={statsLoading} value={count(s.pending_approval)} onClick={() => setQuick('waiting')} />
        <Stat label="Expiring soon" loading={statsLoading} value={count(s.expiring_soon)} reason="Within each contract's notice period" onClick={() => setQuick('expiring')} />
        <Stat label="Contract value" loading={statsLoading} value={<Money amount={s.total_contract_value} />} footnote="Sum of all contracts; currencies are not converted" />
      </div>

      {contracts.length >= LIMIT && (
        <InlineNotice tone="warn" className="mb-3" title={`Showing the first ${LIMIT.toLocaleString()} contracts`}>
          Use the column filters or search to narrow the list. Older contracts are still in the system.
        </InlineNotice>
      )}

      <DataTable
        viewKey="sales.contracts"
        caption="Sales contracts"
        noun="contract"
        rows={contracts}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        rowHref={(c) => `/sales/contracts/${c.id}`}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'created', dir: 'desc' }}
        searchPlaceholder="Search contract, name, party"
        toolbarStart={
          <Segmented
            label="Show"
            value={quick}
            onChange={setQuick}
            options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))}
            className="max-w-full overflow-x-auto"
          />
        }
        rowActions={(c) => (
          <>
            <RowAction icon={EyeIcon} label={`Open ${c.contract_number}`} to={`/sales/contracts/${c.id}`} />
            {c.status === 'DRAFT' && <RowAction icon={PencilSquareIcon} label={`Edit ${c.contract_number}`} to={`/sales/contracts/${c.id}/edit`} />}
            {canDelete && <RowAction icon={TrashIcon} tone="risk" label={`Delete ${c.contract_number}`} onClick={() => setConfirm(c)} />}
          </>
        )}
        empty={{
          icon: DocumentTextIcon,
          title: 'No sales contracts yet',
          description: 'A contract fixes prices and quantities with a customer for a period. Draft one, send it for approval, then to the customer.',
          action: <Button variant="primary" icon={PlusIcon} to="/sales/contracts/create">New contract</Button>,
        }}
      />

      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={doDelete}
          title={`Delete ${confirm.contract_number}?`}
          consequence={`${confirm.contract_name || 'The contract'} and its lines are removed from every list. If the customer already has it, tell them separately.`}
          confirmLabel={`Delete ${confirm.contract_number}`}
          confirmText={confirm.contract_number}
          tone="danger"
          busy={remove.isPending}
        />
      )}
    </>
  )
}
