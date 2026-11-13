import { useMemo, useState } from 'react'
import { PlusIcon, EyeIcon, PencilSquareIcon, TrashIcon, UsersIcon, ArrowDownTrayIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useAuth } from '../../contexts/AuthContext'
import {
  PageHeader, Button, DataTable, RowAction, StatusBadge, Badge, Money, Code, ConfirmDialog, Segmented,
  InlineNotice, Stat, Num, exportCsv, notify,
} from '../../components/ui'

/**
 * Customers — the accounts you sell to, as one working list.
 *
 * Loaded in one request (up to LIMIT) so search, sort, filters and saved views
 * work across the whole set. Status quick views replace the old filter panel.
 */
const LIMIT = 1000
const humanize = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
const RISK_TONE = { LOW: 'ok', MEDIUM: 'warn', HIGH: 'risk', BLOCKED: 'risk' }

const QUICK = {
  all: { label: 'All', test: () => true },
  active: { label: 'Active', test: (c) => c.status === 'ACTIVE' },
  waiting: { label: 'Pending approval', test: (c) => c.status === 'PENDING_APPROVAL' },
  risk: { label: 'High risk', test: (c) => c.credit_risk_level === 'HIGH' || c.credit_risk_level === 'BLOCKED' },
  blocked: { label: 'Blocked or inactive', test: (c) => c.status === 'BLOCKED' || c.status === 'INACTIVE' },
}

export default function CustomersList() {
  const { user } = useAuth()
  const canDelete = ['MANAGER', 'ADMIN'].includes(user?.role)
  const [quick, setQuick] = useState('all')
  const [confirm, setConfirm] = useState(null) // customer to delete

  const params = { limit: LIMIT, offset: 0 }
  const { data, loading, error, refetch } = useResource(keys.customers(params), ({ signal }) => api.get('/customers', { params, signal }))
  const customers = useMemo(() => (Array.isArray(data) ? data : data?.data || []), [data])
  const { data: stats, loading: statsLoading } = useResource(['customers', 'stats'], ({ signal }) => api.get('/customers/stats', { signal }))

  const remove = useResourceMutation((id) => api.delete(`/customers/${id}`), { invalidates: [['customers']], silent: true })

  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, customers.filter(q.test).length])), [customers])

  const columns = useMemo(() => [
    { id: 'code', header: 'Code', accessor: 'customer_code', cell: (c) => <Code>{c.customer_code || '—'}</Code>, width: 120, mobile: 'meta' },
    {
      id: 'name', header: 'Customer', accessor: 'customer_name', filter: 'text', minWidth: 180, maxWidth: 320, mobile: 'title',
      cell: (c) => (
        <span className="block min-w-0">
          <span className="block truncate">{c.customer_name}</span>
          {c.legal_entity_name && c.legal_entity_name !== c.customer_name && <span className="block truncate text-2xs text-ink-500">{c.legal_entity_name}</span>}
        </span>
      ),
    },
    { id: 'type', header: 'Type', accessor: (c) => humanize(c.customer_type), filter: 'select', width: 100, defaultHidden: true },
    {
      id: 'contact', header: 'Contact', accessor: (c) => c.primary_email || c.phone || '', filter: 'text', minWidth: 160, mobile: 'subtitle',
      cell: (c) => (
        <span className="block min-w-0">
          <span className="block truncate">{c.primary_email || '—'}</span>
          {c.phone && <span className="block truncate text-2xs text-ink-500">{c.phone}</span>}
        </span>
      ),
    },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', cell: (c) => <StatusBadge status={c.status} />, width: 110 },
    { id: 'risk', header: 'Credit risk', accessor: 'credit_risk_level', filter: 'select', width: 100, cell: (c) => (c.credit_risk_level ? <Badge tone={RISK_TONE[c.credit_risk_level] || 'ink'}>{humanize(c.credit_risk_level)}</Badge> : '—') },
    { id: 'limit', header: 'Credit limit', accessor: (c) => Number(c.credit_limit), align: 'right', filter: 'number', width: 120, cell: (c) => (Number(c.credit_limit) ? <Money amount={c.credit_limit} currency={c.currency} digits={0} /> : '—'), exportValue: (c) => c.credit_limit },
    { id: 'balance', header: 'Balance', accessor: (c) => Number(c.current_balance), align: 'right', filter: 'number', width: 120, mobile: 'trailing', cell: (c) => <Money amount={c.current_balance} currency={c.currency} />, exportValue: (c) => c.current_balance },
    { id: 'openOrders', header: 'Open orders', accessor: (c) => Number(c.active_orders_count) || 0, align: 'right', width: 110, defaultHidden: true },
    { id: 'rep', header: 'Sales rep', accessor: 'sales_rep_name', filter: 'text', width: 140, defaultHidden: true },
    { id: 'country', header: 'Country', accessor: 'billing_country', filter: 'select', width: 120, defaultHidden: true },
    { id: 'currency', header: 'Currency', accessor: 'currency', filter: 'select', width: 90, defaultHidden: true },
  ], [])

  const runDelete = async () => {
    const c = confirm
    try {
      await remove.mutateAsync(c.id)
      notify.success(`${c.customer_name} deleted`)
    } catch (e) {
      const d = e?.response?.data || {}
      notify.error(`${c.customer_name} was not deleted: ${d.error || e.message}`)
    }
    setConfirm(null)
  }

  return (
    <>
      <PageHeader
        title="Customers"
        description="The accounts you sell to: contacts, addresses, credit terms and balances."
        secondary={<Button icon={ArrowDownTrayIcon} onClick={() => exportCsv(customers.filter(QUICK[quick].test), columns, 'customers.csv')} disabled={!customers.length}>Export</Button>}
        primary={<Button variant="primary" icon={PlusIcon} to="/sales/customers/create" kbd="N">New customer</Button>}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Customers" value={stats ? <Num value={stats.total_customers} /> : '—'} loading={statsLoading} reason={stats ? `${Number(stats.active_customers) || 0} active, ${Number(stats.inactive_customers) || 0} inactive.` : undefined} />
        <Stat label="High risk" value={stats ? <Num value={stats.high_risk_customers} /> : '—'} loading={statsLoading} reason={stats ? `${Number(stats.blocked_customers) || 0} blocked.` : undefined} onClick={() => setQuick('risk')} />
        <Stat label="Credit extended" value={stats ? <Money amount={stats.total_credit_limit} digits={0} /> : '—'} loading={statsLoading} reason="Sum of credit limits." />
        <Stat label="Outstanding" value={stats ? <Money amount={stats.total_outstanding_balance} digits={0} /> : '—'} loading={statsLoading} reason="Sum of customer balances." />
      </div>

      {customers.length >= LIMIT && (
        <InlineNotice tone="warn" className="mb-3" title={`Showing the first ${LIMIT.toLocaleString()} customers`}>
          Use search or a quick view to narrow the list. Other customers are still in the system.
        </InlineNotice>
      )}

      <DataTable
        viewKey="sales.customers"
        caption="Customers"
        noun="customer"
        rows={customers}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        rowHref={(c) => `/sales/customers/${c.id}`}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'name', dir: 'asc' }}
        searchPlaceholder="Search name, code, email"
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
            <RowAction icon={EyeIcon} label={`Open ${c.customer_name}`} to={`/sales/customers/${c.id}`} />
            <RowAction icon={PencilSquareIcon} label={`Edit ${c.customer_name}`} to={`/sales/customers/${c.id}/edit`} />
            <RowAction icon={TrashIcon} tone="risk" label={`Delete ${c.customer_name}`} onClick={() => setConfirm(c)} disabled={!canDelete} reason={canDelete ? undefined : 'Only managers and admins can delete customers.'} />
          </>
        )}
        empty={{
          icon: UsersIcon,
          title: 'No customers yet',
          description: 'Customers you add here can be quoted, sold to and invoiced.',
          action: <Button variant="primary" icon={PlusIcon} to="/sales/customers/create">New customer</Button>,
        }}
      />

      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={runDelete}
          title={`Delete ${confirm.customer_name}?`}
          consequence="The customer disappears from lists and pickers, so nobody can quote or sell to them. Existing orders and invoices keep their reference. There is no undo in the app."
          reversible={false}
          confirmLabel={`Delete ${confirm.customer_name}`}
          confirmText={confirm.customer_code || confirm.customer_name}
          tone="danger"
          busy={remove.isPending}
        />
      )}
    </>
  )
}
