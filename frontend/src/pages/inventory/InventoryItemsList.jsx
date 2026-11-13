import { useMemo, useState } from 'react'
import { PlusIcon, EyeIcon, PencilSquareIcon, TrashIcon, CubeIcon, ArrowDownTrayIcon } from '@heroicons/react/20/solid'
import { inventoryItemsAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, DataTable, RowAction, BulkAction, StatusBadge, Badge, Money, Num, Code, Stat, Segmented,
  ConfirmDialog, exportCsv, notify,
} from '../../components/ui'

/**
 * Inventory items — what is on the shelves, what it is worth, and what needs
 * reordering. Stock status is shown as a word and a glyph, never colour alone.
 */
const qty = (i) => Number(i.current_stock_quantity) || 0
const reorder = (i) => (i.reorder_point == null ? null : Number(i.reorder_point))
const stockState = (i) => {
  if (qty(i) <= 0) return 'out'
  if (reorder(i) != null && qty(i) <= reorder(i)) return 'low'
  return 'ok'
}
const STOCK = {
  out: { label: 'Out of stock', tone: 'risk', glyph: 'triangle' },
  low: { label: 'Below reorder', tone: 'warn', glyph: 'triangle' },
  ok: { label: 'In stock', tone: 'ok', glyph: 'dot' },
}
const QUICK = {
  all: { label: 'All', test: () => true },
  out: { label: 'Out of stock', test: (i) => stockState(i) === 'out' },
  low: { label: 'Below reorder', test: (i) => stockState(i) === 'low' },
  pending: { label: 'Awaiting approval', test: (i) => i.status === 'PENDING_APPROVAL' },
}

export default function InventoryItemsList() {
  const [quick, setQuick] = useState('all')
  const [confirm, setConfirm] = useState(null)
  const params = { limit: 2000 }
  const { data, loading, error, refetch } = useResource(keys.inventoryItems(params), () => inventoryItemsAPI.getAll(params))
  const { data: stats, loading: statsLoading } = useResource(['inventory-items', 'stats'], () => inventoryItemsAPI.getStats())
  const items = useMemo(() => (Array.isArray(data) ? data : []), [data])
  const remove = useResourceMutation((id) => inventoryItemsAPI.delete(id), { invalidates: [['inventory-items']], silent: true })
  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, items.filter(q.test).length])), [items])

  const columns = useMemo(() => [
    {
      id: 'item', header: 'Item', accessor: (i) => i.item_name, minWidth: 220, maxWidth: 320, mobile: 'title',
      cell: (i) => (
        <span className="block min-w-0">
          <span className="block truncate">{i.item_name}</span>
          <span className="block truncate font-mono text-2xs text-ink-500">{i.approved_item_code || i.item_code}</span>
        </span>
      ),
      exportValue: (i) => i.item_name,
    },
    { id: 'code', header: 'Code', accessor: (i) => i.approved_item_code || i.item_code, defaultHidden: true, cell: (i) => <Code>{i.approved_item_code || i.item_code}</Code> },
    {
      id: 'stock', header: 'On hand', accessor: qty, align: 'right', width: 130, filter: 'number', mobile: 'trailing',
      cell: (i) => <Num value={qty(i)} digits={qty(i) % 1 ? 2 : 0} unit={i.unit_of_measure} />,
    },
    {
      id: 'state', header: 'Stock', accessor: (i) => STOCK[stockState(i)].label, filter: 'select', width: 150, mobile: 'meta',
      cell: (i) => { const s = STOCK[stockState(i)]; return <Badge tone={s.tone} glyph={s.glyph}>{s.label}</Badge> },
    },
    { id: 'reorder', header: 'Reorder at', accessor: reorder, align: 'right', width: 110, cell: (i) => (reorder(i) == null ? <span className="text-ink-400" title="No reorder point set">—</span> : <Num value={reorder(i)} />) },
    { id: 'minmax', header: 'Min / max', accessor: (i) => i.maximum_stock_level, align: 'right', width: 120, defaultHidden: true, cell: (i) => <span className="tabular-nums text-ink-600">{i.minimum_stock_level ?? '—'} / {i.maximum_stock_level ?? '—'}</span> },
    { id: 'price', header: 'Unit price', accessor: (i) => Number(i.unit_price), align: 'right', width: 120, filter: 'number', cell: (i) => <Money amount={i.unit_price} currency={i.currency} /> },
    {
      id: 'value', header: 'Stock value', accessor: (i) => qty(i) * (Number(i.unit_price) || 0), align: 'right', width: 130,
      cell: (i) => <Money amount={qty(i) * (Number(i.unit_price) || 0)} currency={i.currency} />,
      footer: (rows) => <Money amount={rows.reduce((s, i) => s + qty(i) * (Number(i.unit_price) || 0), 0)} currency="USD" />,
    },
    { id: 'criticality', header: 'Criticality', accessor: 'criticality', filter: 'select', width: 110, cell: (i) => (i.criticality ? <Badge tone={i.criticality === 'HIGH' ? 'warn' : 'ink'} mono>{i.criticality}</Badge> : '—') },
    { id: 'status', header: 'Approval', accessor: 'status', filter: 'select', width: 170, cell: (i) => <StatusBadge status={i.status} /> },
    { id: 'location', header: 'Location', accessor: (i) => i.storage_location_name || (Number(i.storage_locations_count) ? `${i.storage_locations_count} locations` : ''), width: 150, cell: (i) => (i.storage_location_name ? <span>{i.storage_location_name}{i.bin_code && <Code className="ml-1 text-ink-500">{i.bin_code}</Code>}</span> : Number(i.storage_locations_count) ? `${i.storage_locations_count} locations` : <span className="text-ink-400">Not assigned</span>) },
    { id: 'category', header: 'Category', accessor: 'item_category', filter: 'select', defaultHidden: true },
    { id: 'grade', header: 'Condition', accessor: 'condition_grade', width: 100, defaultHidden: true, cell: (i) => <Code>{i.condition_grade || 'A'}</Code> },
  ], [])

  const filtered = items.filter(QUICK[quick].test)

  return (
    <>
      <PageHeader
        title="Inventory items"
        description="Stock you hold, what it is worth, and what needs reordering."
        secondary={<Button icon={ArrowDownTrayIcon} disabled={!items.length} onClick={() => exportCsv(filtered, columns, 'inventory-items.csv')}>Export</Button>}
        primary={<Button variant="primary" icon={PlusIcon} to="/inventory/items/create" kbd="N">New inventory item</Button>}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Items" value={<Num value={stats?.total_items} />} loading={statsLoading} onClick={() => setQuick('all')} />
        <Stat label="Out of stock" value={<Num value={stats?.out_of_stock} />} loading={statsLoading} onClick={() => setQuick('out')} reason={Number(stats?.out_of_stock) ? 'Cannot be issued until received.' : undefined} />
        <Stat label="Below reorder point" value={<Num value={stats?.low_stock} />} loading={statsLoading} onClick={() => setQuick('low')} />
        <Stat label="Stock value" value={<Money amount={stats?.total_value} currency={stats?.currency || 'USD'} digits={0} />} loading={statsLoading} footnote="Quantity on hand × unit price" />
      </div>

      <DataTable
        viewKey="inventory.items"
        caption="Inventory items"
        noun="item"
        rows={items}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        rowHref={(i) => `/inventory/items/${i.id}`}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'item', dir: 'asc' }}
        searchPlaceholder="Search item, code, location"
        toolbarStart={<Segmented label="Show" value={quick} onChange={setQuick} options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))} />}
        selectable
        bulkActions={(sel) => <BulkAction icon={ArrowDownTrayIcon} onClick={() => exportCsv(sel, columns, 'inventory-items-selected.csv')}>Export {sel.length}</BulkAction>}
        rowActions={(i) => (
          <>
            <RowAction icon={EyeIcon} label={`Open ${i.item_name}`} to={`/inventory/items/${i.id}`} />
            <RowAction icon={PencilSquareIcon} label={`Edit ${i.item_name}`} to={`/inventory/items/${i.id}/edit`} />
            <RowAction icon={TrashIcon} tone="risk" label={`Delete ${i.item_name}`} onClick={() => setConfirm(i)} />
          </>
        )}
        empty={{
          icon: CubeIcon,
          title: 'No inventory items yet',
          description: 'An inventory item is stock of an approved item master that you hold somewhere. Create one, or receive goods against a purchase order.',
          action: <Button variant="primary" icon={PlusIcon} to="/inventory/items/create">New inventory item</Button>,
        }}
      />

      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          title={`Delete ${confirm.item_name}?`}
          consequence={`The inventory record is removed${qty(confirm) > 0 ? `, including ${qty(confirm)} ${confirm.unit_of_measure || 'units'} recorded on hand` : ''}. The item master stays.`}
          confirmLabel={`Delete ${confirm.item_name}`}
          busy={remove.isPending}
          onConfirm={async () => {
            try {
              await remove.mutateAsync(confirm.id)
              notify.success(`${confirm.item_name} deleted`)
            } catch (e) {
              notify.error(`${confirm.item_name} was not deleted: ${e?.response?.data?.error || e.message}`)
            }
            setConfirm(null)
          }}
        />
      )}
    </>
  )
}
