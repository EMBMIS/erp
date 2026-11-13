import { useMemo, useState } from 'react'
import { PlusIcon, EyeIcon, PencilSquareIcon, TrashIcon, CubeIcon, ArrowDownTrayIcon } from '@heroicons/react/20/solid'
import { itemsAPI } from '../services/api'
import { useResource, useResourceMutation } from '../hooks/useResource'
import { keys } from '../services/queryKeys'
import {
  PageHeader, Button, DataTable, RowAction, StatusBadge, Badge, Code, DateText, ConfirmDialog, Segmented, InlineNotice,
  exportCsv, describeError, notify,
} from '../components/ui'

/**
 * Item master — every item the company can buy, stock or sell, before it
 * becomes inventory. Loaded in one request (the server caps a page at 200)
 * so sorting, filtering and saved views work across the set; past the cap
 * the page says so instead of silently showing a partial list.
 */
const LIMIT = 200
const STOCK = { ST1: 'ST1 — Regular stock', ST2: 'ST2 — Planned stock', NS3: 'NS3 — Non-stock' }
const CRIT_TONE = { HIGH: 'risk', MEDIUM: 'warn' }
const cap = (s) => (s ? s.toLowerCase().replace(/^./, (c) => c.toUpperCase()) : '—')

const QUICK = {
  all: { label: 'All', test: () => true },
  draft: { label: 'Draft', test: (i) => i.status === 'DRAFT' },
  review: { label: 'In review', test: (i) => i.status === 'PENDING_REVIEW' },
  approved: { label: 'Approved', test: (i) => i.status === 'APPROVED' },
}

export default function ItemsList() {
  const [quick, setQuick] = useState('all')
  const [removing, setRemoving] = useState(null)

  const params = { limit: LIMIT, offset: 0 }
  const { data, loading, error, refetch } = useResource(keys.items(params), async () => {
    const res = await itemsAPI.getAll(params)
    return { data: { success: true, data: { rows: res.data?.data || [], total: Number(res.data?.total) || 0 } } }
  })
  const items = useMemo(() => data?.rows || [], [data])
  const total = data?.total || 0
  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, items.filter(q.test).length])), [items])

  const remove = useResourceMutation((id) => itemsAPI.delete(id), { invalidates: [['items']], silent: true })
  const doRemove = async () => {
    try {
      await remove.mutateAsync(removing.id)
      notify.success(`${removing.name} deleted`)
    } catch (e) {
      notify.error(`${removing.name} was not deleted: ${describeError(e).message}`)
    }
    setRemoving(null)
  }

  const columns = useMemo(() => [
    {
      id: 'name', header: 'Item', accessor: 'name', mobile: 'title', minWidth: 220, maxWidth: 360,
      cell: (i) => (
        <span className="block min-w-0">
          <span className="block truncate">{i.name}</span>
          <Code className="block truncate text-2xs text-ink-500">{i.approved_item_code || i.item_code}</Code>
        </span>
      ),
    },
    { id: 'code', header: 'Code', accessor: (i) => i.approved_item_code || i.item_code, defaultHidden: true, cell: (i) => <Code>{i.approved_item_code || i.item_code}</Code>, width: 160 },
    { id: 'category', header: 'Category', accessor: 'item_category', filter: 'select', width: 160, mobile: 'subtitle', cell: (i) => i.item_category || <span className="text-ink-400">—</span> },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 150, mobile: 'meta', cell: (i) => <StatusBadge status={i.status} /> },
    { id: 'criticality', header: 'Criticality', accessor: 'criticality', filter: 'select', width: 120, cell: (i) => (i.criticality ? <Badge tone={CRIT_TONE[i.criticality] || 'ink'}>{cap(i.criticality)}</Badge> : '—') },
    { id: 'stock', header: 'Stock class', accessor: (i) => STOCK[i.stock_code] || i.stock_code, filter: 'select', width: 170 },
    { id: 'uom', header: 'Unit', accessor: 'unit_of_measure', width: 80, cell: (i) => <Code>{i.unit_of_measure || '—'}</Code> },
    { id: 'manufacturer', header: 'Manufacturer', accessor: 'manufacturer', filter: 'text', width: 180, cell: (i) => (i.manufacturer ? <span className="block min-w-0"><span className="block truncate">{i.manufacturer}</span>{i.manufacturer_part_number && <Code className="block truncate text-2xs text-ink-500">P/N {i.manufacturer_part_number}</Code>}</span> : <span className="text-ink-400">—</span>) },
    { id: 'unspsc', header: 'UNSPSC', accessor: 'unspsc_code', defaultHidden: true, width: 120, cell: (i) => (i.unspsc_code ? <Code>{i.unspsc_code}</Code> : '—') },
    { id: 'updated', header: 'Updated', accessor: 'updated_at', width: 120, cell: (i) => <DateText value={i.updated_at} /> },
  ], [])

  return (
    <>
      <PageHeader
        title="Item master"
        description="Every item the company buys, stocks or sells. Approved items can become inventory."
        secondary={<Button icon={ArrowDownTrayIcon} onClick={() => exportCsv(items.filter(QUICK[quick].test), columns, 'item-master.csv')} disabled={!items.length}>Export</Button>}
        primary={<Button variant="primary" icon={PlusIcon} to="/items/create" kbd="N">New item</Button>}
      />

      {total > items.length && (
        <InlineNotice tone="warn" className="mb-3" title={`Showing the first ${items.length} of ${total} items`}>
          The rest are still in the system. Use search to narrow the list.
        </InlineNotice>
      )}

      <DataTable
        viewKey="inventory.item-master"
        caption="Item master"
        noun="item"
        rows={items}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        rowHref={(i) => `/items/${i.id}/view`}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'name', dir: 'asc' }}
        searchPlaceholder="Search name, code, manufacturer"
        toolbarStart={<Segmented label="Show" value={quick} onChange={setQuick} options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))} className="max-w-full overflow-x-auto [&>button]:shrink-0 [&>button]:whitespace-nowrap" />}
        rowActions={(i) => (
          <>
            <RowAction icon={EyeIcon} label={`Open ${i.name}`} to={`/items/${i.id}/view`} />
            <RowAction icon={PencilSquareIcon} label={`Edit ${i.name}`} to={`/items/${i.id}/edit`} />
            <RowAction icon={TrashIcon} tone="risk" label={`Delete ${i.name}`} onClick={() => setRemoving(i)} />
          </>
        )}
        empty={{
          icon: CubeIcon,
          title: 'No items yet',
          description: 'An item master describes something you buy, stock or sell. Create one, get it approved, then stock it as inventory.',
          action: <Button variant="primary" icon={PlusIcon} to="/items/create">New item</Button>,
        }}
      />

      {removing && (
        <ConfirmDialog
          open
          onClose={() => setRemoving(null)}
          onConfirm={doRemove}
          title={`Delete ${removing.name}?`}
          consequence={`The item master ${removing.approved_item_code || removing.item_code} is removed and can no longer be ordered or stocked.`}
          confirmLabel="Delete item"
          confirmText={removing.status === 'APPROVED' ? (removing.approved_item_code || removing.item_code) : undefined}
          busy={remove.isPending}
        />
      )}
    </>
  )
}
