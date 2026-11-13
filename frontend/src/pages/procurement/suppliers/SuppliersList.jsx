import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PlusIcon, EyeIcon, TrashIcon, CubeIcon, BuildingOfficeIcon, ArrowDownTrayIcon, SparklesIcon } from '@heroicons/react/20/solid'
import api from '../../../services/api'
import { useResource, useResourceMutation } from '../../../hooks/useResource'
import { keys } from '../../../services/queryKeys'
import {
  PageHeader, Button, DataTable, RowAction, BulkAction, Badge, StatusBadge, Money, Code, ConfirmDialog,
  Segmented, InlineNotice, exportCsv, formatMoney, notify,
} from '../../../components/ui'

/**
 * Suppliers — the directory, with each supplier's delivery risk alongside.
 *
 * Risk comes from GET /supplier-risk (the same assessment Simeli answers
 * from) and is joined onto the rows by supplier id, so it can be sorted and
 * filtered like any other column instead of living in a separate panel.
 */
const LIMIT = 1000
const BAND_TONE = { HIGH: 'risk', MEDIUM: 'warn', LOW: 'ink', NONE: 'ok' }
const ask = (q) => `/ai/chat?q=${encodeURIComponent(q)}`

const QUICK = {
  all: { label: 'All', test: () => true },
  active: { label: 'Active', test: (s) => s.status === 'ACTIVE' },
  waiting: { label: 'Waiting approval', test: (s) => s.status === 'PENDING_APPROVAL' || s.status === 'PENDING_SUPPLIER_CONFIRMATION' },
  uncertified: { label: 'Not certified', test: (s) => s.status === 'ACTIVE' && s.certification_status !== 'CERTIFIED' },
  risk: { label: 'At risk', test: (s) => s.risk && (s.risk.band === 'HIGH' || s.risk.band === 'MEDIUM') },
}

export default function SuppliersList() {
  const navigate = useNavigate()
  const [quick, setQuick] = useState('all')
  const [confirm, setConfirm] = useState(null) // suppliers[]

  const params = { limit: LIMIT, offset: 0 }
  const { data, loading, error, refetch } = useResource(keys.suppliers(params), ({ signal }) => api.get('/suppliers', { params, signal }))
  const { data: riskData, error: riskError } = useResource(['supplier-risk', 'all'], ({ signal }) => api.get('/supplier-risk', { signal }), { retry: false })
  const riskById = useMemo(() => new Map((riskData?.suppliers || []).map((r) => [r.supplier_id, r])), [riskData])
  const suppliers = useMemo(() => (Array.isArray(data) ? data : data?.data || []).map((s) => ({ ...s, risk: riskById.get(s.id) || null })), [data, riskById])

  const remove = useResourceMutation((id) => api.delete(`/suppliers/${id}`), { invalidates: [['suppliers']], silent: true })

  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, suppliers.filter(q.test).length])), [suppliers])

  const columns = useMemo(() => [
    {
      id: 'name', header: 'Supplier', accessor: (s) => `${s.legal_name || ''} ${s.trade_name || ''}`, minWidth: 220, maxWidth: 320, mobile: 'title',
      cell: (s) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium text-fg">{s.legal_name}</span>
          {s.trade_name && s.trade_name !== s.legal_name && <span className="block truncate text-xs text-ink-500">Trading as {s.trade_name}</span>}
        </span>
      ),
    },
    { id: 'code', header: 'Code', accessor: 'supplier_code', cell: (s) => <Code>{s.supplier_code}</Code>, width: 140, mobile: 'subtitle' },
    { id: 'type', header: 'Type', accessor: 'supplier_type', filter: 'select', width: 140, cell: (s) => (s.supplier_type ? <Badge tone="ink">{s.supplier_type.charAt(0) + s.supplier_type.slice(1).toLowerCase()}</Badge> : '—') },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 180, mobile: 'meta', cell: (s) => <StatusBadge status={s.status} /> },
    { id: 'cert', header: 'Certification', accessor: 'certification_status', filter: 'select', width: 150, cell: (s) => (s.certification_status ? <StatusBadge status={s.certification_status === 'NOT_CERTIFIED' ? 'DECLINED' : s.certification_status} label={s.certification_status.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())} /> : '—') },
    {
      id: 'risk', header: 'Delivery risk', accessor: (s) => s.risk?.score ?? null, width: 170,
      cell: (s) => (s.risk ? (
        <span className="flex items-center gap-1.5" title={s.risk.headline}>
          <Badge tone={BAND_TONE[s.risk.band] || 'ink'}>{s.risk.band === 'NONE' ? 'No signal' : `${s.risk.band.charAt(0)}${s.risk.band.slice(1).toLowerCase()}`}</Badge>
          {s.risk.on_time_rate != null && <span className="text-xs tabular-nums text-ink-500">{s.risk.on_time_rate}% on time</span>}
        </span>
      ) : <span className="text-ink-400">—</span>),
      exportValue: (s) => s.risk?.band || '',
    },
    { id: 'exposure', header: 'Open exposure', accessor: (s) => s.risk?.open_exposure ?? null, align: 'right', width: 140, mobile: 'trailing', cell: (s) => <Money amount={s.risk ? s.risk.open_exposure : null} currency={s.risk?.currency || s.currency || 'USD'} digits={0} /> },
    { id: 'email', header: 'Email', accessor: 'email', width: 200, defaultHidden: true },
    { id: 'phone', header: 'Phone', accessor: 'phone', width: 140, defaultHidden: true },
    { id: 'country', header: 'Country', accessor: 'country', filter: 'select', width: 110 },
    { id: 'currency', header: 'Currency', accessor: 'currency', width: 90, defaultHidden: true },
  ], [])

  const run = async () => {
    const targets = confirm
    let ok = 0
    const failed = []
    for (const s of targets) {
      try { await remove.mutateAsync(s.id); ok += 1 } catch (e) { failed.push(`${s.supplier_code}: ${e?.response?.data?.error || e.message}`) }
    }
    setConfirm(null)
    if (ok) notify.success(ok === 1 ? `${targets[0].legal_name} deleted` : `${ok} suppliers deleted`)
    if (failed.length) notify.error(`Not deleted — ${failed.join('; ')}`)
  }

  const summary = riskData?.summary
  const hasActive = confirm?.some((s) => s.status === 'ACTIVE')

  return (
    <>
      <PageHeader
        title="Suppliers"
        description="Who you buy from — status, certification and how reliably each one delivers."
        secondary={
          <>
            <Button icon={SparklesIcon} to={ask('Which of our suppliers are a risk right now, and why?')}>Ask Simeli</Button>
            <Button icon={ArrowDownTrayIcon} onClick={() => exportCsv(suppliers.filter(QUICK[quick].test), columns, 'suppliers.csv')} disabled={!suppliers.length}>Export</Button>
          </>
        }
        primary={<Button variant="primary" icon={PlusIcon} to="/procurement/suppliers/create" kbd="N">New supplier</Button>}
      />

      {summary && (summary.high > 0 || summary.medium > 0) && (
        <InlineNotice
          tone="warn"
          className="mb-3"
          title={`${summary.high} high and ${summary.medium} medium delivery risk of ${summary.suppliers_watched} suppliers`}
          action={<Button size="sm" variant="ghost" onClick={() => setQuick('risk')}>Show them</Button>}
        >
          {summary.delayed ? `${summary.delayed} have overdue deliveries. ` : ''}
          {summary.open_exposure ? `${formatMoney(summary.open_exposure, riskData.currency || 'USD', 0)} is still to arrive` : ''}
          {summary.value_at_risk ? `; ${formatMoney(summary.value_at_risk, riskData.currency || 'USD', 0)} of customer orders depend on late suppliers.` : '.'}
        </InlineNotice>
      )}
      {riskError && (
        <InlineNotice tone="ink" className="mb-3" title="Delivery risk is not available">
          {riskError?.response?.data?.error || 'The risk assessment could not be read.'} The directory below is complete; only the risk columns are empty.
        </InlineNotice>
      )}

      <DataTable
        viewKey="procurement.suppliers"
        caption="Suppliers"
        noun="supplier"
        rows={suppliers}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        rowHref={(s) => `/procurement/suppliers/${s.id}`}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'name', dir: 'asc' }}
        searchPlaceholder="Search name, code, country"
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
        bulkActions={(sel, clear) => (
          <>
            <BulkAction icon={ArrowDownTrayIcon} onClick={() => exportCsv(sel, columns, 'suppliers-selected.csv')}>Export</BulkAction>
            <BulkAction tone="risk" icon={TrashIcon} onClick={() => { setConfirm(sel); clear() }}>Delete {sel.length}</BulkAction>
          </>
        )}
        rowActions={(s) => (
          <>
            <RowAction icon={EyeIcon} label={`Open ${s.legal_name}`} to={`/procurement/suppliers/${s.id}`} />
            <RowAction icon={CubeIcon} label={`Items ${s.legal_name} supplies`} onClick={() => navigate(`/procurement/suppliers/${s.id}?tab=items`)} />
            <RowAction icon={TrashIcon} tone="risk" label={`Delete ${s.legal_name}`} onClick={() => setConfirm([s])} />
          </>
        )}
        empty={{
          icon: BuildingOfficeIcon,
          title: 'No suppliers yet',
          description: 'Suppliers you add here, once approved, appear in requisitions, RFQs, contracts and purchase orders.',
          action: <Button variant="primary" icon={PlusIcon} to="/procurement/suppliers/create">New supplier</Button>,
        }}
      />

      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={run}
          title={confirm.length === 1 ? `Delete ${confirm[0].legal_name}?` : `Delete ${confirm.length} suppliers?`}
          consequence={hasActive
            ? 'At least one of these is active and may have contracts, purchase orders or catalogue items. A supplier that other records still refer to cannot be deleted; the server will say so.'
            : 'The supplier is removed from the directory and can no longer be chosen on requisitions, RFQs or orders.'}
          reversible={false}
          confirmLabel={confirm.length === 1 ? `Delete ${confirm[0].supplier_code}` : `Delete ${confirm.length}`}
          confirmText={confirm.length === 1 && confirm[0].status === 'ACTIVE' ? confirm[0].supplier_code : undefined}
          busy={remove.isPending}
        />
      )}
    </>
  )
}
