import { useMemo, useState } from 'react'
import { EyeIcon, ScaleIcon, BuildingStorefrontIcon } from '@heroicons/react/20/solid'
import { storageLocationsAPI, binsAPI } from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, Field, Select, Card, DataTable, RowAction, Code, Num, Badge, EmptyState, ErrorState, formatNumber,
} from '../../components/ui'
import { Utilisation } from './WarehouseParts'
import { asList, fillState, formatBinCode } from './warehouseData'

const ratio = (used, max) => (Number(max) > 0 ? (Number(used || 0) / Number(max)) * 100 : null)
const STATE = { ok: { label: 'Room', tone: 'ok', glyph: 'dot' }, warn: { label: 'Getting full', tone: 'warn', glyph: 'triangle' }, risk: { label: 'Near capacity', tone: 'risk', glyph: 'triangle' } }

/**
 * Capacity — how much weight and volume each approved location has left,
 * bin by bin. Approved locations and bins carry the status ACTIVE; the old
 * screen asked for status APPROVED, which matches nothing, so its picker was
 * always empty.
 */
export default function WarehouseCapacityManagement() {
  const [locationId, setLocationId] = useState('')
  const { data: locData, loading: locLoading, error: locError, refetch } = useResource(keys.storageLocations({ status: 'ACTIVE' }), () => storageLocationsAPI.getAll({ status: 'ACTIVE' }))
  const locations = asList(locData)
  const { data: binData, loading: binsLoading, error: binsError, refetch: refetchBins } = useResource(
    keys.allBins({ storage_location_id: locationId, status: 'ACTIVE' }),
    () => binsAPI.getAll({ storage_location_id: locationId, status: 'ACTIVE' }),
    { enabled: Boolean(locationId) }
  )
  const bins = useMemo(() => asList(binData), [binData])
  const location = locations.find((l) => l.id === locationId)

  const totals = bins.reduce((t, b) => ({
    maxMass: t.maxMass + (parseFloat(b.max_mass_capacity) || 0),
    maxVolume: t.maxVolume + (parseFloat(b.max_volume_capacity) || 0),
    mass: t.mass + (parseFloat(b.current_mass_used) || 0),
    volume: t.volume + (parseFloat(b.current_volume_used) || 0),
  }), { maxMass: 0, maxVolume: 0, mass: 0, volume: 0 })

  const columns = useMemo(() => [
    { id: 'code', header: 'Bin', accessor: 'code', width: 150, mobile: 'title', cell: (b) => <Code>{formatBinCode(b.code)}</Code> },
    { id: 'desc', header: 'Description', accessor: 'description', minWidth: 160, mobile: 'subtitle', cell: (b) => b.description || <span className="text-ink-400">—</span> },
    { id: 'mass', header: 'Weight', accessor: (b) => ratio(b.current_mass_used, b.max_mass_capacity), align: 'right', width: 200, cell: (b) => <Utilisation percent={ratio(b.current_mass_used, b.max_mass_capacity)} used={Number(b.current_mass_used || 0)} max={Number(b.max_mass_capacity)} unit="kg" compact={false} /> },
    { id: 'vol', header: 'Volume', accessor: (b) => ratio(b.current_volume_used, b.max_volume_capacity), align: 'right', width: 200, cell: (b) => <Utilisation percent={ratio(b.current_volume_used, b.max_volume_capacity)} used={Number(b.current_volume_used || 0)} max={Number(b.max_volume_capacity)} unit="m³" digits={3} compact={false} /> },
    {
      id: 'state', header: 'State', width: 150, mobile: 'meta', filter: 'select',
      accessor: (b) => STATE[fillState(Math.max(ratio(b.current_mass_used, b.max_mass_capacity) ?? 0, ratio(b.current_volume_used, b.max_volume_capacity) ?? 0))].label,
      cell: (b) => { const s = STATE[fillState(Math.max(ratio(b.current_mass_used, b.max_mass_capacity) ?? 0, ratio(b.current_volume_used, b.max_volume_capacity) ?? 0))]; return <Badge tone={s.tone} glyph={s.glyph}>{s.label}</Badge> },
    },
  ], [])

  return (
    <div className="space-y-5">
      <PageHeader title="Capacity" description="How much weight and volume each approved location has left, bin by bin." />

      <Card>
        <Field label="Storage location" help={locLoading ? 'Loading approved locations…' : locations.length ? 'Only approved locations are listed.' : 'No approved storage location yet.'} id="select-storage-location" className="max-w-md">
          <Select size="lg" value={locationId} onChange={(e) => setLocationId(e.target.value)} disabled={locLoading}>
            <option value="">Choose a storage location…</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.code})</option>)}
          </Select>
        </Field>
      </Card>

      {locError ? (
        <ErrorState what="Storage locations" error={locError} onRetry={refetch} />
      ) : !locationId ? (
        <Card>
          <EmptyState
            icon={ScaleIcon}
            title="Choose a location"
            description={locations.length ? 'Pick a storage location above to see each bin’s weight and volume.' : 'Capacity is tracked per bin inside approved storage locations. Approve a location and add bins first.'}
            action={!locLoading && !locations.length ? <Button variant="primary" icon={BuildingStorefrontIcon} to="/warehouse/storage-locations">Storage locations</Button> : null}
          />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Card title={`${location?.name || 'Location'} — weight`}>
              <Utilisation label="Used" percent={ratio(totals.mass, totals.maxMass)} used={totals.mass} max={totals.maxMass} unit="kg" />
              <p className="mt-2 text-xs text-ink-500">{formatNumber(Math.max(totals.maxMass - totals.mass, 0), 1)} kg left across {bins.length} bin{bins.length === 1 ? '' : 's'}</p>
            </Card>
            <Card title={`${location?.name || 'Location'} — volume`}>
              <Utilisation label="Used" percent={ratio(totals.volume, totals.maxVolume)} used={totals.volume} max={totals.maxVolume} unit="m³" digits={3} />
              <p className="mt-2 text-xs text-ink-500">{formatNumber(Math.max(totals.maxVolume - totals.volume, 0), 3)} m³ left across {bins.length} bin{bins.length === 1 ? '' : 's'}</p>
            </Card>
          </div>
          <DataTable
            viewKey="warehouse.capacity"
            caption={`Bins in ${location?.name || 'this location'}`}
            noun="bin"
            rows={bins}
            columns={columns}
            loading={binsLoading}
            error={binsError}
            onRetry={refetchBins}
            rowHref={(b) => `/warehouse/bins/${b.id}`}
            defaultSort={{ id: 'mass', dir: 'desc' }}
            searchPlaceholder="Search bin code or description"
            rowActions={(b) => <RowAction icon={EyeIcon} label={`Open bin ${b.code}`} to={`/warehouse/bins/${b.id}`} />}
            empty={{ icon: ScaleIcon, title: 'No approved bins here', description: 'Only approved, active bins count towards capacity.', action: <Button variant="primary" to={`/warehouse/bins/create?location=${locationId}`}>New bin</Button> }}
          />
          <p className="text-xs text-ink-500"><Num value={bins.length} /> approved bin{bins.length === 1 ? '' : 's'} counted.</p>
        </>
      )}
    </div>
  )
}
