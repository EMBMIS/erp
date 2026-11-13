import { useMemo, useState } from 'react'
import { PlusIcon, EyeIcon, PencilSquareIcon, TrashIcon, BuildingStorefrontIcon, ArrowDownTrayIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, DataTable, RowAction, BulkAction, StatusBadge, Badge, Code, DateText, Segmented, ConfirmDialog,
  exportCsv, notify,
} from '../../components/ui'
import { asList } from './warehouseData'

/**
 * Storage locations — the warehouses and sites stock can live in.
 * A location is created as a draft, approved, and only then receives bins
 * and stock. Status tabs replace the old approval/active dropdowns.
 */
const QUICK = {
  all: { label: 'All', test: () => true },
  active: { label: 'In use', test: (l) => l.status === 'ACTIVE' && l.is_active !== false },
  pending: { label: 'Awaiting approval', test: (l) => l.status === 'PENDING_APPROVAL' },
  draft: { label: 'Drafts', test: (l) => l.status === 'DRAFT' },
  declined: { label: 'Declined', test: (l) => l.status === 'DECLINED' },
}

export default function StorageLocationsList() {
  const [quick, setQuick] = useState('all')
  const [confirm, setConfirm] = useState(null)
  const params = {}
  const { data, loading, error, refetch } = useResource(keys.storageLocations(params), ({ signal }) => api.get('/storage-locations', { params, signal }))
  const locations = useMemo(() => asList(data), [data])
  const remove = useResourceMutation((id) => api.delete(`/storage-locations/${id}`), { invalidates: [['storage-locations']], silent: true })
  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, locations.filter(q.test).length])), [locations])

  const columns = useMemo(() => [
    {
      id: 'name', header: 'Location', accessor: 'name', minWidth: 220, maxWidth: 320, mobile: 'title',
      cell: (l) => (
        <span className="block min-w-0">
          <span className="block truncate">{l.name}</span>
          <span className="block truncate font-mono text-2xs text-ink-500">{l.code}</span>
        </span>
      ),
    },
    { id: 'code', header: 'Code', accessor: 'code', defaultHidden: true, cell: (l) => <Code>{l.code}</Code>, width: 110 },
    { id: 'place', header: 'City', accessor: (l) => [l.city, l.country].filter(Boolean).join(', '), filter: 'text', mobile: 'subtitle', width: 200 },
    { id: 'address', header: 'Address', accessor: (l) => [l.address, l.postal_code].filter(Boolean).join(' '), width: 240, defaultHidden: true },
    { id: 'status', header: 'Approval', accessor: 'status', filter: 'select', width: 170, mobile: 'meta', cell: (l) => <StatusBadge status={l.status} label={l.status === 'ACTIVE' ? 'Approved' : undefined} /> },
    { id: 'active', header: 'In use', accessor: (l) => (l.is_active === false ? 'Inactive' : 'Active'), filter: 'select', width: 110, cell: (l) => (l.is_active === false ? <Badge tone="ink" glyph="ring">Inactive</Badge> : <Badge tone="ok" glyph="dot">Active</Badge>) },
    { id: 'created', header: 'Created', accessor: 'created_at', width: 130, cell: (l) => <DateText value={l.created_at} /> },
  ], [])

  const filtered = locations.filter(QUICK[quick].test)

  return (
    <>
      <PageHeader
        title="Storage locations"
        description="Warehouses and sites that hold bins and stock."
        secondary={<Button icon={ArrowDownTrayIcon} disabled={!locations.length} onClick={() => exportCsv(filtered, columns, 'storage-locations.csv')}>Export</Button>}
        primary={<Button variant="primary" icon={PlusIcon} to="/warehouse/storage-locations/create" kbd="N">New storage location</Button>}
      />

      <DataTable
        viewKey="warehouse.storage-locations"
        caption="Storage locations"
        noun="location"
        rows={locations}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        rowHref={(l) => `/warehouse/storage-locations/${l.id}`}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'name', dir: 'asc' }}
        searchPlaceholder="Search name, code, city"
        toolbarStart={<Segmented label="Show" value={quick} onChange={setQuick} options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))} />}
        selectable
        bulkActions={(sel) => <BulkAction icon={ArrowDownTrayIcon} onClick={() => exportCsv(sel, columns, 'storage-locations-selected.csv')}>Export {sel.length}</BulkAction>}
        rowActions={(l) => (
          <>
            <RowAction icon={EyeIcon} label={`Open ${l.name}`} to={`/warehouse/storage-locations/${l.id}`} />
            <RowAction icon={PencilSquareIcon} label={`Edit ${l.name}`} to={`/warehouse/storage-locations/${l.id}/edit`} />
            <RowAction icon={TrashIcon} tone="risk" label={`Delete ${l.name}`} onClick={() => setConfirm(l)} />
          </>
        )}
        empty={{
          icon: BuildingStorefrontIcon,
          title: 'No storage locations yet',
          description: 'Add a warehouse or site, send it for approval, then create bins in it to receive stock.',
          action: <Button variant="primary" icon={PlusIcon} to="/warehouse/storage-locations/create">New storage location</Button>,
        }}
      />

      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          title={`Delete ${confirm.name}?`}
          consequence="The location is removed. It cannot be deleted while it still has bins; delete or move those first."
          confirmLabel={`Delete ${confirm.name}`}
          busy={remove.isPending}
          onConfirm={async () => {
            try {
              await remove.mutateAsync(confirm.id)
              notify.success(`${confirm.name} deleted`)
            } catch (e) {
              notify.error(`${confirm.name} was not deleted: ${e?.response?.data?.error || e.message}`)
            }
            setConfirm(null)
          }}
        />
      )}
    </>
  )
}
