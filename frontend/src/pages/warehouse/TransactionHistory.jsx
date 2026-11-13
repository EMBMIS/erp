import { useMemo, useState } from 'react'
import { ChevronLeftIcon, ChevronRightIcon, ClockIcon, XMarkIcon, ArrowDownTrayIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, DataTable, StatusBadge, Badge, Code, Num, Money, DateText, Field, Input, Select, Sheet, DescriptionList,
  ErrorState, SkeletonRows, exportCsv,
} from '../../components/ui'
import { asList, TX_TYPES } from './warehouseData'

const PAGE = 20
const BLANK = { transaction_type: '', status: '', date_from: '', date_to: '', reference_document: '' }
const STATUSES = [['POSTED', 'Posted'], ['PENDING_APPROVAL', 'Pending approval'], ['DRAFT', 'Draft'], ['REJECTED', 'Rejected'], ['CANCELLED', 'Cancelled']]

/** One transaction, opened from the list: header facts and every line with where it moved. */
function TransactionSheet({ id, onClose }) {
  const { data: tx, loading, error, refetch } = useResource(['warehouse-transactions', 'detail', id], ({ signal }) => api.get(`/warehouse/transactions/${id}`, { signal }), { enabled: Boolean(id) })
  const lines = asList(tx?.items)
  const where = (code, name, bin) => (code || name ? <span>{name || code}{bin && <Code className="ml-1 text-ink-500">{bin}</Code>}</span> : <span className="text-ink-400">—</span>)
  return (
    <Sheet open={Boolean(id)} onClose={onClose} title={tx ? `${TX_TYPES[tx.transaction_type]?.label || tx.transaction_type} ${tx.transaction_number || ''}` : 'Transaction'} description={tx?.reference_document ? `Reference ${tx.reference_document}` : undefined} width="lg">
      {loading ? <SkeletonRows rows={5} columns={3} /> : error ? <ErrorState what="Transaction" error={error} onRetry={refetch} compact /> : tx ? (
        <div className="space-y-5">
          <DescriptionList
            items={[
              { label: 'Status', value: <StatusBadge status={tx.status} /> },
              { label: 'Date', value: <DateText value={tx.transaction_date || tx.created_at} withTime /> },
              { label: 'Created by', value: tx.created_by_name },
              { label: 'Approved by', value: tx.approved_by_name },
              { label: 'Total quantity', value: <Num value={tx.total_quantity} /> },
              { label: 'Total value', value: <Money amount={tx.total_value} /> },
              { label: 'Notes', value: tx.notes, wide: true },
            ]}
          />
          <div>
            <h3 className="mb-2 text-sm font-semibold text-fg">Lines</h3>
            {!lines.length ? <p className="text-sm text-ink-500">No lines recorded.</p> : (
              <ul className="divide-y divide-ink-100 rounded-lg border border-ink-200">
                {lines.map((l) => (
                  <li key={l.id} className="space-y-1 px-3 py-2.5 text-sm">
                    <p className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate font-medium text-fg">{l.item_name || l.item_master_name || 'Item'}</span>
                      <Num value={l.quantity} unit={l.unit_of_measure} />
                    </p>
                    <p className="flex flex-wrap gap-x-4 text-xs text-ink-500">
                      <span>From {where(l.source_location_code, l.source_location_name, l.source_bin_code)}</span>
                      <span>To {where(l.destination_location_code, l.destination_location_name, l.destination_bin_code)}</span>
                      {l.reason_code && <span>Reason {l.reason_code.toLowerCase().replace(/_/g, ' ')}</span>}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </Sheet>
  )
}

/**
 * Transaction history — every posted, pending and cancelled movement.
 * Filters go to the server (type, status, dates, reference) and the list
 * pages 20 at a time, as before; a row opens the full transaction.
 */
export default function TransactionHistory() {
  const [filters, setFilters] = useState(BLANK)
  const [offset, setOffset] = useState(0)
  const [open, setOpen] = useState(null)
  const set = (k, v) => { setFilters((f) => ({ ...f, [k]: v })); setOffset(0) }

  const queryParams = { ...filters, limit: PAGE, offset }
  const { data, loading, error, refetch } = useResource(keys.warehouseTransactions(queryParams), ({ signal }) => api.get('/warehouse/transactions', { params: queryParams, signal }))
  const rows = asList(data)
  const filtered = Object.values(filters).some(Boolean)

  const columns = useMemo(() => [
    { id: 'type', header: 'Type', accessor: 'transaction_type', width: 160, mobile: 'meta', cell: (t) => <span className="flex items-center gap-2"><Badge mono>{t.transaction_type}</Badge><span className="truncate text-ink-700">{TX_TYPES[t.transaction_type]?.short}</span></span> },
    { id: 'ref', header: 'Reference', accessor: (t) => t.reference_document || t.transaction_number, width: 190, mobile: 'title', cell: (t) => <Code>{t.reference_document || t.transaction_number || `${t.transaction_type}-${String(t.id).slice(0, 8)}`}</Code> },
    { id: 'status', header: 'Status', accessor: 'status', width: 160, cell: (t) => <StatusBadge status={t.status} /> },
    { id: 'items', header: 'Items', accessor: (t) => (t.items || [])[0]?.item_name, minWidth: 200, mobile: 'subtitle', cell: (t) => { const it = t.items || []; return it.length ? `${it[0].item_name || 'Item'}${it.length > 1 ? ` +${it.length - 1} more` : ''}` : <span className="text-ink-400">—</span> } },
    { id: 'qty', header: 'Quantity', accessor: (t) => Number(t.total_quantity), align: 'right', width: 110, mobile: 'trailing', cell: (t) => <Num value={t.total_quantity} /> },
    { id: 'value', header: 'Value', accessor: (t) => Number(t.total_value), align: 'right', width: 130, cell: (t) => <Money amount={t.total_value} /> },
    { id: 'created', header: 'Created', accessor: 'created_at', width: 170, cell: (t) => <DateText value={t.created_at} withTime /> },
  ], [])

  return (
    <div className="space-y-4">
      <PageHeader
        title="Transaction history"
        description="Every warehouse movement — receipts, issues, returns, transfers and adjustments."
        secondary={<Button icon={ArrowDownTrayIcon} disabled={!rows.length} onClick={() => exportCsv(rows, columns, 'warehouse-transactions.csv')}>Export page</Button>}
      />

      <div className="grid grid-cols-1 gap-3 rounded-lg border border-ink-200 bg-surface p-4 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="Type" id="transaction-type">
          <Select value={filters.transaction_type} onChange={(e) => set('transaction_type', e.target.value)}>
            <option value="">All types</option>
            {Object.entries(TX_TYPES).map(([k, t]) => <option key={k} value={k}>{t.label} ({k})</option>)}
          </Select>
        </Field>
        <Field label="Status" id="status">
          <Select value={filters.status} onChange={(e) => set('status', e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Field>
        <Field label="Reference" id="reference-document">
          <Input value={filters.reference_document} onChange={(e) => set('reference_document', e.target.value)} placeholder="PO, SO or document number" />
        </Field>
        <Field label="From" id="date-from">
          <Input type="date" value={filters.date_from} onChange={(e) => set('date_from', e.target.value)} />
        </Field>
        <Field label="To" id="date-to" labelAction={filtered ? <Button size="xs" variant="ghost" icon={XMarkIcon} onClick={() => { setFilters(BLANK); setOffset(0) }}>Clear all</Button> : null}>
          <Input type="date" value={filters.date_to} onChange={(e) => set('date_to', e.target.value)} />
        </Field>
      </div>

      <DataTable
        viewKey="warehouse.transactions.history"
        caption="Warehouse transactions"
        noun="transaction"
        rows={rows}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        search={false}
        showCount={false}
        onRowClick={(t) => setOpen(t.id)}
        empty={{
          icon: ClockIcon,
          title: filtered ? 'No transaction matches these filters' : 'No transactions yet',
          description: filtered ? 'Widen the dates or clear a filter.' : 'Receipts, issues, returns, transfers and adjustments appear here once posted.',
          action: filtered ? <Button onClick={() => { setFilters(BLANK); setOffset(0) }}>Clear filters</Button> : <Button variant="primary" to="/warehouse/transactions">New transaction</Button>,
        }}
      />

      {(offset > 0 || rows.length === PAGE) && (
        <nav aria-label="Pages" className="flex items-center justify-between gap-3">
          <span className="text-xs text-ink-500">Showing {offset + 1}–{offset + rows.length}</span>
          <span className="flex gap-2">
            <Button size="lg" icon={ChevronLeftIcon} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Button>
            <Button size="lg" iconRight={ChevronRightIcon} disabled={rows.length < PAGE} onClick={() => setOffset(offset + PAGE)}>Next</Button>
          </span>
        </nav>
      )}

      <TransactionSheet id={open} onClose={() => setOpen(null)} />
    </div>
  )
}
