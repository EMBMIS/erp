import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PlusIcon, EyeIcon, PencilSquareIcon, TrashIcon, CubeIcon, ArrowDownTrayIcon, XMarkIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, DataTable, RowAction, BulkAction, StatusBadge, Badge, Code, Num, Segmented, Select, ConfirmDialog,
  InlineNotice, exportCsv, notify,
} from '../../components/ui'
import { Utilisation } from './WarehouseParts'
import { asList, formatBinCode, pct } from './warehouseData'

/**
 * Bins — every shelf and bay, how full it is, and whether it can be used.
 *
 * The location and utilisation filters stay in the URL (?location=,
 * ?mass_min=…) because other screens link here with them; everything else
 * filters the loaded list.
 */
const URL_FILTERS = { location: 'storage_location_id', mass_min: 'mass_utilization_min', mass_max: 'mass_utilization_max', volume_min: 'volume_utilization_min', volume_max: 'volume_utilization_max' }

const QUICK = {
  all: { label: 'All', test: () => true },
  full: { label: 'Near capacity', test: (b) => pct(b.mass_utilization_percent) >= 90 || pct(b.volume_utilization_percent) >= 90 },
  pending: { label: 'Awaiting approval', test: (b) => b.status === 'PENDING_APPROVAL' },
  draft: { label: 'Drafts', test: (b) => b.status === 'DRAFT' },
  inactive: { label: 'Inactive', test: (b) => b.is_active === false },
}

export default function BinsList() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [quick, setQuick] = useState('all')
  const [confirm, setConfirm] = useState(null)

  const binParams = Object.fromEntries(Object.entries(URL_FILTERS).map(([u, k]) => [k, searchParams.get(u)]).filter(([, v]) => v))
  const { data: locData } = useResource(keys.storageLocations(), ({ signal }) => api.get('/storage-locations', { signal }))
  const locations = asList(locData)
  const { data, loading, error, refetch } = useResource(keys.allBins(binParams), ({ signal }) => api.get('/bins', { params: binParams, signal }))
  const bins = useMemo(() => asList(data), [data])
  const remove = useResourceMutation((id) => api.delete(`/bins/${id}`), { invalidates: [['bins']], silent: true })
  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, bins.filter(q.test).length])), [bins])

  const setUrl = (key, value) => {
    const next = new URLSearchParams(searchParams)
    if (value) next.set(key, value)
    else next.delete(key)
    setSearchParams(next)
  }
  const thresholdFilters = Object.keys(URL_FILTERS).filter((k) => k !== 'location' && searchParams.get(k))

  const columns = useMemo(() => [
    {
      id: 'code', header: 'Bin', accessor: 'code', width: 170, mobile: 'title',
      cell: (b) => (
        <span className="block min-w-0">
          <Code className="block">{formatBinCode(b.code)}</Code>
          {b.description && <span className="block truncate text-2xs text-ink-500">{b.description}</span>}
        </span>
      ),
      exportValue: (b) => b.code,
    },
    { id: 'location', header: 'Location', accessor: (b) => b.storage_location_name, filter: 'select', width: 190, mobile: 'subtitle', cell: (b) => (b.storage_location_name ? <span>{b.storage_location_name} <Code className="text-ink-500">{b.storage_location_code}</Code></span> : '—') },
    { id: 'mass', header: 'Weight used', accessor: (b) => pct(b.mass_utilization_percent), align: 'right', width: 150, filter: 'number', mobile: 'trailing', cell: (b) => <Utilisation percent={b.mass_utilization_percent} compact /> },
    { id: 'vol', header: 'Volume used', accessor: (b) => pct(b.volume_utilization_percent), align: 'right', width: 150, filter: 'number', cell: (b) => <Utilisation percent={b.volume_utilization_percent} compact /> },
    { id: 'maxmass', header: 'Weight capacity', accessor: (b) => Number(b.max_mass_capacity), align: 'right', width: 140, defaultHidden: true, cell: (b) => <Num value={b.max_mass_capacity} digits={1} unit="kg" /> },
    { id: 'maxvol', header: 'Volume capacity', accessor: (b) => Number(b.max_volume_capacity), align: 'right', width: 140, defaultHidden: true, cell: (b) => <Num value={b.max_volume_capacity} digits={3} unit="m³" /> },
    { id: 'status', header: 'Approval', accessor: 'status', filter: 'select', width: 170, mobile: 'meta', cell: (b) => <StatusBadge status={b.status} label={b.status === 'ACTIVE' ? 'Approved' : undefined} /> },
    { id: 'active', header: 'In use', accessor: (b) => (b.is_active === false ? 'Inactive' : 'Active'), filter: 'select', width: 110, defaultHidden: true, cell: (b) => (b.is_active === false ? <Badge glyph="ring">Inactive</Badge> : <Badge tone="ok" glyph="dot">Active</Badge>) },
  ], [])

  const filtered = bins.filter(QUICK[quick].test)
  const location = locations.find((l) => l.id === searchParams.get('location'))

  return (
    <>
      <PageHeader
        title="Bins"
        description={location ? `Bins in ${location.name}.` : 'Every shelf and bay, and how much weight and volume it has left.'}
        secondary={<Button icon={ArrowDownTrayIcon} disabled={!bins.length} onClick={() => exportCsv(filtered, columns, 'bins.csv')}>Export</Button>}
        primary={<Button variant="primary" icon={PlusIcon} to={location ? `/warehouse/bins/create?location=${location.id}` : '/warehouse/bins/create'} kbd="N">New bin</Button>}
      />

      {thresholdFilters.length > 0 && (
        <InlineNotice className="mb-3" title="Filtered by utilisation" action={<Button size="sm" variant="ghost" icon={XMarkIcon} onClick={() => { const n = new URLSearchParams(searchParams); thresholdFilters.forEach((k) => n.delete(k)); setSearchParams(n) }}>Clear</Button>}>
          Showing bins with {thresholdFilters.map((k) => `${k.startsWith('mass') ? 'weight' : 'volume'} ${k.endsWith('min') ? 'at least' : 'at most'} ${searchParams.get(k)}%`).join(' and ')}.
        </InlineNotice>
      )}

      <DataTable
        viewKey="warehouse.bins"
        caption="Bins"
        noun="bin"
        rows={bins}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        rowHref={(b) => `/warehouse/bins/${b.id}`}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'code', dir: 'asc' }}
        searchPlaceholder="Search bin code, description, location"
        toolbarStart={
          <div className="flex flex-wrap items-center gap-2">
            <Select size="sm" aria-label="Storage location" value={searchParams.get('location') || ''} onChange={(e) => setUrl('location', e.target.value)} className="w-auto max-w-[220px]">
              <option value="">All locations</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.code} — {l.name}</option>)}
            </Select>
            <Segmented label="Show" value={quick} onChange={setQuick} options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))} />
          </div>
        }
        selectable
        bulkActions={(sel) => <BulkAction icon={ArrowDownTrayIcon} onClick={() => exportCsv(sel, columns, 'bins-selected.csv')}>Export {sel.length}</BulkAction>}
        rowActions={(b) => (
          <>
            <RowAction icon={EyeIcon} label={`Open bin ${b.code}`} to={`/warehouse/bins/${b.id}`} />
            <RowAction icon={PencilSquareIcon} label={`Edit bin ${b.code}`} to={`/warehouse/bins/${b.id}/edit`} />
            <RowAction icon={TrashIcon} tone="risk" label={`Delete bin ${b.code}`} onClick={() => setConfirm(b)} />
          </>
        )}
        empty={{
          icon: CubeIcon,
          title: location ? `No bins in ${location.name}` : 'No bins yet',
          description: 'A bin is a shelf or bay inside an approved storage location, with a weight and volume capacity.',
          action: <Button variant="primary" icon={PlusIcon} to="/warehouse/bins/create">New bin</Button>,
        }}
      />

      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          title={`Delete bin ${formatBinCode(confirm.code)}?`}
          consequence="The bin is removed. It cannot be deleted while it still holds stock; move the stock out first."
          confirmLabel="Delete bin"
          busy={remove.isPending}
          onConfirm={async () => {
            try {
              await remove.mutateAsync(confirm.id)
              notify.success(`Bin ${confirm.code} deleted`)
            } catch (e) {
              notify.error(`Bin ${confirm.code} was not deleted: ${e?.response?.data?.error || e.message}`)
            }
            setConfirm(null)
          }}
        />
      )}
    </>
  )
}
