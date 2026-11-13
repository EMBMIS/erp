import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PlusIcon, InboxArrowDownIcon, ArrowDownTrayIcon, EyeIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useI18n } from '../../contexts/I18nContext'
import {
  PageHeader, Button, DataTable, RowAction, BulkAction, Num, Code, DateText, Badge, InlineNotice, exportCsv,
} from '../../components/ui'

/**
 * Goods receipt history — every receipt against a purchase order, across all
 * suppliers. Read without paging params, the endpoint returns every receipt
 * (its fetch-all contract), so sorting, filtering and search cover the whole
 * history rather than one server page.
 */
export default function GoodsReceiptHistory() {
  const { t } = useI18n()
  const [searchParams, setSearchParams] = useSearchParams()
  const focusId = searchParams.get('receipt')

  const { data, loading, error, refetch } = useResource(
    keys.goodsReceipts({ all: true }),
    ({ signal }) => api.get('/goods-receipts', { signal })
  )
  const rows = useMemo(() => (Array.isArray(data) ? data : []), [data])
  const focused = focusId ? rows.find((r) => String(r.id) === focusId) : null

  const columns = useMemo(() => [
    { id: 'received', header: 'Received', accessor: 'received_date', width: 120, mobile: 'meta', cell: (r) => <DateText value={r.received_date} /> },
    { id: 'po', header: 'PO', accessor: 'po_number', width: 150, mobile: 'title', cell: (r) => (r.po_number ? <Code>{r.po_number}</Code> : <span className="text-ink-400">—</span>) },
    { id: 'supplier', header: 'Supplier', accessor: 'supplier_name', filter: 'text', minWidth: 160, maxWidth: 240, mobile: 'subtitle', cell: (r) => <span className="block truncate">{r.supplier_name || '—'}</span> },
    {
      id: 'item', header: 'Item', accessor: (r) => r.item_description || r.item_name, minWidth: 200, maxWidth: 320,
      cell: (r) => (
        <span className="block min-w-0">
          <span className="block truncate">{r.item_description || r.item_name || '—'}</span>
          {r.item_code && <span className="block truncate font-mono text-2xs text-ink-500">{r.item_code}</span>}
        </span>
      ),
    },
    {
      id: 'quantity', header: 'Quantity', accessor: (r) => Number(r.quantity_received), align: 'right', filter: 'number', width: 130, mobile: 'trailing',
      cell: (r) => <Num value={r.quantity_received} digits={Number(r.quantity_received) % 1 ? 2 : 0} unit={r.unit_of_measure} />,
    },
    { id: 'condition', header: 'Condition', accessor: 'condition_grade', filter: 'select', width: 110, cell: (r) => (r.condition_grade ? <Badge mono>{r.condition_grade}</Badge> : <span className="text-ink-400">—</span>) },
    { id: 'location', header: 'Location', accessor: 'storage_location_name', width: 160, cell: (r) => (r.storage_location_name ? <span>{r.storage_location_name}{r.bin_code && <Code className="ml-1 text-ink-500">{r.bin_code}</Code>}</span> : <span className="text-ink-400">—</span>) },
    { id: 'batch', header: 'Batch / lot', accessor: 'batch_lot_number', width: 130, defaultHidden: true, cell: (r) => (r.batch_lot_number ? <Code>{r.batch_lot_number}</Code> : <span className="text-ink-400">—</span>) },
    { id: 'receivedBy', header: 'Received by', accessor: 'received_by_name', filter: 'text', width: 150 },
    { id: 'notes', header: 'Notes', accessor: 'notes', minWidth: 160, maxWidth: 300, cell: (r) => <span className="block truncate text-ink-600">{r.notes || '—'}</span> },
  ], [])

  return (
    <>
      <PageHeader
        title={t('ui.goodsReceiptHistory')}
        description={t('ui.goodsReceiptHistorySubtitle')}
        secondary={<Button icon={ArrowDownTrayIcon} disabled={!rows.length} onClick={() => exportCsv(rows, columns, 'goods-receipts.csv')}>Export</Button>}
        primary={<Button variant="primary" icon={PlusIcon} to="/procurement/goods-receipts/create" kbd="N">{t('ui.createReceipt')}</Button>}
      />

      {focusId && (
        <InlineNotice className="mb-3" title={focused ? `Showing the receipt for ${focused.po_number || 'one PO line'}` : 'Showing one receipt'} action={<Button size="sm" onClick={() => setSearchParams({})}>Show all receipts</Button>}>
          {!loading && !focused && 'That receipt is not in this list. It may have been removed.'}
        </InlineNotice>
      )}

      <DataTable
        viewKey="procurement.goods-receipts"
        caption={t('ui.goodsReceiptHistory')}
        noun="receipt"
        rows={rows}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        externalFilter={focusId ? (r) => String(r.id) === focusId : undefined}
        defaultSort={{ id: 'received', dir: 'desc' }}
        searchPlaceholder={t('ui.searchReceipts')}
        rowHref={(r) => (r.po_id ? `/procurement/purchase-orders/${r.po_id}` : undefined)}
        selectable
        bulkActions={(sel) => <BulkAction icon={ArrowDownTrayIcon} onClick={() => exportCsv(sel, columns, 'goods-receipts-selected.csv')}>Export {sel.length}</BulkAction>}
        rowActions={(r) => r.po_id && <RowAction icon={EyeIcon} label={`Open purchase order ${r.po_number || ''}`.trim()} to={`/procurement/purchase-orders/${r.po_id}`} />}
        empty={{
          icon: InboxArrowDownIcon,
          title: t('ui.noGoodsReceiptsYet'),
          description: t('ui.goodsReceiptsWillAppearHereOnceGoodsAreReceived'),
          action: <Button variant="primary" icon={PlusIcon} to="/procurement/goods-receipts/create">{t('ui.createTheFirstReceipt')}</Button>,
        }}
      />
    </>
  )
}
