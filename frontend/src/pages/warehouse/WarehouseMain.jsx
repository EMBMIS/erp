import { Link } from 'react-router-dom'
import {
  BuildingStorefrontIcon, CubeIcon, ArrowsRightLeftIcon, ClipboardDocumentCheckIcon, TruckIcon, ScaleIcon,
  ChevronRightIcon, PlusIcon, InboxArrowDownIcon,
} from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import WarehouseTwinModule from '../../components/warehouse/WarehouseTwin'
import RunsOnModule from '../../components/operations/RunsOn'
import { PageHeader, Button, Stat, Num, Card, Code, EmptyState, ErrorState, SkeletonRows } from '../../components/ui'
import { Utilisation } from './WarehouseParts'
import { asList, formatBinCode, pct } from './warehouseData'

const AREAS = [
  { to: '/warehouse/storage-locations', icon: BuildingStorefrontIcon, label: 'Storage locations', hint: 'Warehouses and sites' },
  { to: '/warehouse/bins', icon: CubeIcon, label: 'Bins', hint: 'Shelves and their capacity' },
  { to: '/warehouse/transactions', icon: ArrowsRightLeftIcon, label: 'Transactions', hint: 'Receive, issue, return, move, adjust' },
  { to: '/warehouse/transfers', icon: TruckIcon, label: 'Transfers in transit', hint: 'Stock between locations' },
  { to: '/stocktake', icon: ClipboardDocumentCheckIcon, label: 'Stocktake', hint: 'Count sheets and variances' },
  { to: '/warehouse/capacity', icon: ScaleIcon, label: 'Capacity', hint: 'Weight and volume by location' },
]

/** Warehouse — where stock lives, how full it is, and where to go next. */
export default function WarehouseMain() {
  const { data: locStats, loading: locLoading } = useResource(['storage-locations-stats'], ({ signal }) => api.get('/storage-locations/stats', { signal }))
  const { data: binStats, loading: binLoading } = useResource(['bins-stats'], ({ signal }) => api.get('/bins/stats', { signal }))
  const { data: rawBins, loading, error, refetch } = useResource(keys.allBins({ limit: 20 }), ({ signal }) => api.get('/bins', { params: { limit: 20 }, signal }))

  const bins = asList(rawBins)
  const alertBins = bins.filter((b) => pct(b.mass_utilization_percent) >= 90 || pct(b.volume_utilization_percent) >= 90).slice(0, 5)
  const hasBins = Number(binStats?.total) > 0
  const near = Math.max(Number(binStats?.near_mass_capacity) || 0, Number(binStats?.near_volume_capacity) || 0)

  return (
    <div className="space-y-5">
      <PageHeader
        title="Warehouse"
        description="Where stock lives, how full it is, and the movements that change it."
        secondary={<Button icon={PlusIcon} to="/warehouse/bins/create">New bin</Button>}
        primary={<Button variant="primary" icon={InboxArrowDownIcon} to="/warehouse/transactions/goods-receipt">Receive goods</Button>}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Storage locations" value={<Num value={locStats?.total} />} loading={locLoading} to="/warehouse/storage-locations" reason={locStats ? `${Number(locStats.active) || 0} active` : undefined} />
        <Stat label="Bins" value={<Num value={binStats?.total} />} loading={binLoading} to="/warehouse/bins" reason={binStats ? `${Number(binStats.active) || 0} active${near ? ` · ${near} near capacity` : ''}` : undefined} />
        <Stat label="Weight used" value={hasBins ? `${Number(binStats.overall_mass_utilization) || 0}%` : '—'} loading={binLoading} footnote="Current mass ÷ capacity, all bins" />
        <Stat label="Volume used" value={hasBins ? `${Number(binStats.overall_volume_utilization) || 0}%` : '—'} loading={binLoading} footnote="Current volume ÷ capacity, all bins" />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          <Card
            title="Bins near capacity"
            description="90% or more of their weight or volume is used."
            actions={<Button size="sm" variant="ghost" to="/warehouse/bins?mass_min=90">All full bins</Button>}
            padded={false}
          >
            {loading ? (
              <SkeletonRows rows={3} columns={3} />
            ) : error ? (
              <ErrorState what="Bins" error={error} onRetry={refetch} compact />
            ) : !alertBins.length ? (
              <EmptyState compact title="No bin is near capacity" description={hasBins ? 'Every bin checked has room by weight and by volume.' : 'Create bins in a storage location to track their capacity.'} />
            ) : (
              <ul className="divide-y divide-ink-100">
                {alertBins.map((b) => (
                  <li key={b.id}>
                    <Link to={`/warehouse/bins/${b.id}`} className="flex min-h-[56px] items-center gap-4 px-4 py-3 hover:bg-ink-50">
                      <span className="min-w-0 flex-1">
                        <Code className="block text-sm text-fg">{formatBinCode(b.code)}</Code>
                        <span className="block truncate text-xs text-ink-500">{[b.storage_location_name, b.description].filter(Boolean).join(' · ')}</span>
                      </span>
                      <span className="hidden w-32 sm:block"><Utilisation label="Weight" percent={b.mass_utilization_percent} compact /></span>
                      <span className="hidden w-32 sm:block"><Utilisation label="Volume" percent={b.volume_utilization_percent} compact /></span>
                      <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <WarehouseTwinModule />

          <RunsOnModule focus="sites" />
        </div>

        <aside className="min-w-0 space-y-4">
          <nav aria-label="Warehouse areas" className="rounded-lg border border-ink-200 bg-surface">
            <h2 className="label-mono border-b border-ink-200 px-4 py-2.5">Go to</h2>
            <ul className="divide-y divide-ink-100">
              {AREAS.map((a) => (
                <li key={a.to}>
                  <Link to={a.to} className="flex min-h-[52px] items-center gap-3 px-4 py-2.5 hover:bg-ink-50">
                    <a.icon className="h-4 w-4 shrink-0 text-ink-500" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-fg">{a.label}</span>
                      <span className="block truncate text-xs text-ink-500">{a.hint}</span>
                    </span>
                    <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <Card title="Average fill per bin">
            {binLoading ? <SkeletonRows rows={2} columns={2} /> : (
              <div className="space-y-4">
                <Utilisation label="Weight" percent={hasBins ? binStats.avg_mass_utilization : null} compact />
                <Utilisation label="Volume" percent={hasBins ? binStats.avg_volume_utilization : null} compact />
                <p className="text-xs text-ink-500">
                  {hasBins ? <><Num value={binStats.near_mass_capacity} /> bins at 90%+ by weight, <Num value={binStats.near_volume_capacity} /> by volume.</> : 'No bins yet, so nothing to average.'}
                </p>
              </div>
            )}
          </Card>
        </aside>
      </div>
    </div>
  )
}
