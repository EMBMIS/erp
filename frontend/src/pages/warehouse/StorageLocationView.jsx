import { useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { PencilSquareIcon, TrashIcon, PlusIcon, PaperAirplaneIcon, CubeIcon, EyeIcon, CheckBadgeIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useRecordTitle } from '../../components/shell/ShellContext'
import WarehouseTwinModule from '../../components/warehouse/WarehouseTwin'
import {
  PageHeader, Button, Menu, StatusBadge, Badge, Code, DateText, ConfirmDialog, DetailLayout, SummaryStrip, Tabs, Card,
  DescriptionList, Timeline, RelatedPanel, DataTable, RowAction, SkeletonDetail, ErrorState, InlineNotice, notify,
} from '../../components/ui'
import { Utilisation } from './WarehouseParts'
import { asList, formatBinCode } from './warehouseData'
import { useLocationPendingItems } from './useWarehouse'

/** A storage location on the record pattern: facts, its bins, the twin, and what awaits approval. */
export default function StorageLocationView() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [tab, setTab] = useState('bins')
  const [confirm, setConfirm] = useState(null)

  const { data: location, loading, error, refetch } = useResource(keys.storageLocation(id), ({ signal }) => api.get(`/storage-locations/${id}`, { signal }), { enabled: Boolean(id) })
  const { data: rawBins, loading: binsLoading } = useResource(keys.storageLocationBins(id), ({ signal }) => api.get(`/storage-locations/${id}/bins`, { signal }), { enabled: Boolean(id) })
  const bins = useMemo(() => asList(rawBins), [rawBins])
  const { data: pendingData, loading: pendingLoading } = useLocationPendingItems(id)
  const pending = asList(pendingData)
  useRecordTitle(location?.name, { subtitle: location?.code })

  const invalidates = [['storage-locations'], ['storage-locations-stats']]
  const remove = useResourceMutation(() => api.delete(`/storage-locations/${id}`), { invalidates, silent: true })
  const submit = useResourceMutation(() => api.post(`/storage-locations/${id}/submit-for-approval`), { invalidates, silent: true })

  const binColumns = useMemo(() => [
    { id: 'code', header: 'Bin', accessor: 'code', width: 150, mobile: 'title', cell: (b) => <Code>{formatBinCode(b.code)}</Code> },
    { id: 'desc', header: 'Description', accessor: 'description', minWidth: 180, mobile: 'subtitle' },
    { id: 'mass', header: 'Weight used', accessor: (b) => Number(b.mass_utilization_percent), align: 'right', width: 150, cell: (b) => <Utilisation percent={b.mass_utilization_percent} compact /> },
    { id: 'vol', header: 'Volume used', accessor: (b) => Number(b.volume_utilization_percent), align: 'right', width: 150, cell: (b) => <Utilisation percent={b.volume_utilization_percent} compact /> },
    { id: 'status', header: 'Approval', accessor: 'status', width: 160, mobile: 'meta', cell: (b) => <StatusBadge status={b.status} label={b.status === 'ACTIVE' ? 'Approved' : undefined} /> },
  ], [])

  if (loading) return <SkeletonDetail />
  if (error || !location) return <ErrorState what="Storage location" error={error} onRetry={refetch} />

  const approved = location.status === 'ACTIVE'
  const activeBins = bins.filter((b) => b.is_active !== false).length

  const run = async (kind) => {
    const m = kind === 'delete' ? remove : submit
    try {
      await m.mutateAsync()
      setConfirm(null)
      if (kind === 'delete') {
        notify.success(`${location.name} deleted`)
        navigate('/warehouse/storage-locations')
      } else {
        notify.success(`${location.name} sent for approval`)
      }
    } catch (e) {
      setConfirm(null)
      notify.error(`${location.name} was not ${kind === 'delete' ? 'deleted' : 'sent'}: ${e?.response?.data?.error || e.message}`)
    }
  }

  let primary = null
  if (location.status === 'DRAFT') primary = <Button variant="primary" icon={PaperAirplaneIcon} onClick={() => setConfirm('submit')}>Send for approval</Button>
  else if (approved) primary = <Button variant="primary" icon={PlusIcon} to={`/warehouse/bins/create?location=${id}`}>New bin</Button>

  const events = [
    location.updated_at && location.updated_at !== location.created_at && { title: 'Last changed', at: location.updated_at, tone: 'ink' },
    { title: 'Created', at: location.created_at, tone: 'ink' },
  ].filter(Boolean)

  return (
    <>
      <DetailLayout
        header={
          <PageHeader
            title={location.name}
            status={<StatusBadge status={location.status} label={approved ? 'Approved' : undefined} />}
            badge={location.is_active === false ? <Badge tone="ink" glyph="ring">Inactive</Badge> : null}
            meta={<><Code>{location.code}</Code><span>{[location.city, location.country].filter(Boolean).join(', ')}</span></>}
            secondary={<>
              <Button icon={PencilSquareIcon} to={`/warehouse/storage-locations/${id}/edit`}>Edit</Button>
              <Menu items={[
                { label: 'All bins here', icon: CubeIcon, onSelect: () => navigate(`/warehouse/bins?location=${id}`) },
                { divider: true },
                { label: 'Delete location', tone: 'risk', icon: TrashIcon, onSelect: () => setConfirm('delete') },
              ]} />
            </>}
            primary={primary}
          />
        }
        notice={
          location.status === 'PENDING_APPROVAL' ? <InlineNotice tone="warn" title="Awaiting approval">A manager approves new locations in Approvals. Bins can be added once it is approved.</InlineNotice>
            : location.status === 'DECLINED' ? <InlineNotice tone="risk" title="Declined">{location.decline_reason || 'No reason was recorded.'}</InlineNotice>
              : null
        }
        summary={
          <SummaryStrip
            facts={[
              { label: 'Bins', value: binsLoading ? '…' : bins.length, hint: binsLoading ? null : `${activeBins} active` },
              { label: 'Awaiting approval', value: pendingLoading ? '…' : pending.length, hint: 'inventory lines in its bins', to: pending.length ? `/warehouse/storage-locations/${id}/inventory-approvals` : undefined },
              { label: 'City', value: location.city || '—', hint: location.country },
              { label: 'Postal code', value: location.postal_code ? <Code>{location.postal_code}</Code> : '—' },
              { label: 'Created', value: <DateText value={location.created_at} /> },
            ]}
          />
        }
        aside={
          <>
            <Card title="Inventory approvals">
              {pendingLoading ? <p className="text-sm text-ink-500">Checking bins…</p> : pending.length ? (
                <div className="space-y-3">
                  <p className="text-sm text-ink-700"><Badge tone="warn" glyph="clock">{pending.length} pending</Badge> <span className="ml-1">inventory line{pending.length === 1 ? '' : 's'} in this location wait for a manager.</span></p>
                  <Button block icon={CheckBadgeIcon} to={`/warehouse/storage-locations/${id}/inventory-approvals`}>Review approvals</Button>
                </div>
              ) : <p className="text-sm text-ink-600">Nothing in this location is waiting for approval.</p>}
            </Card>
            <Card title="History"><Timeline events={events} /></Card>
            <RelatedPanel groups={[{ label: 'Bins', items: bins.slice(0, 6).map((b) => ({ label: formatBinCode(b.code), to: `/warehouse/bins/${b.id}`, sublabel: b.description })) }]} />
          </>
        }
      >
        <Tabs value={tab} onChange={setTab} label="Location sections" tabs={[{ id: 'bins', label: 'Bins', count: bins.length }, { id: 'details', label: 'Details' }, { id: 'twin', label: 'Stock cover' }]}>
          {(t) => (
            <>
              {t === 'bins' && (
                <DataTable
                  caption="Bins in this location"
                  noun="bin"
                  rows={bins}
                  columns={binColumns}
                  loading={binsLoading}
                  showCount={false}
                  rowHref={(b) => `/warehouse/bins/${b.id}`}
                  rowActions={(b) => <RowAction icon={EyeIcon} label={`Open bin ${b.code}`} to={`/warehouse/bins/${b.id}`} />}
                  empty={{
                    icon: CubeIcon,
                    title: 'No bins in this location',
                    description: approved ? 'Add the shelves and bays stock will be put away into.' : 'Bins can be added once the location is approved.',
                    action: approved ? <Button variant="primary" icon={PlusIcon} to={`/warehouse/bins/create?location=${id}`}>New bin</Button> : null,
                  }}
                />
              )}
              {t === 'details' && (
                <Card>
                  <DescriptionList
                    items={[
                      { label: 'Code', value: <Code>{location.code}</Code> },
                      { label: 'Name', value: location.name },
                      { label: 'Street address', value: location.address, wide: true },
                      { label: 'City', value: location.city },
                      { label: 'Country', value: location.country },
                      { label: 'Postal code', value: location.postal_code && <Code>{location.postal_code}</Code> },
                      { label: 'In use', value: location.is_active === false ? 'Inactive' : 'Active' },
                      { label: 'Description', value: location.description && <span className="whitespace-pre-wrap">{location.description}</span>, wide: true },
                      { label: 'Created', value: <DateText value={location.created_at} withTime /> },
                      { label: 'Last updated', value: <DateText value={location.updated_at} withTime /> },
                    ]}
                  />
                </Card>
              )}
              {t === 'twin' && <WarehouseTwinModule locationId={id} />}
            </>
          )}
        </Tabs>
      </DetailLayout>

      {confirm === 'delete' && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={() => run('delete')}
          title={`Delete ${location.name}?`}
          consequence={bins.length ? `It still has ${bins.length} bin${bins.length === 1 ? '' : 's'}, so the server will refuse. Delete or move the bins first.` : 'The location is removed from the warehouse.'}
          confirmLabel={`Delete ${location.name}`}
          busy={remove.isPending}
        />
      )}
      {confirm === 'submit' && (
        <ConfirmDialog
          open
          tone="primary"
          onClose={() => setConfirm(null)}
          onConfirm={() => run('submit')}
          title={`Send ${location.name} for approval?`}
          consequence="A manager approves or declines it in Approvals. Bins can be added once it is approved."
          confirmLabel="Send for approval"
          busy={submit.isPending}
        />
      )}
    </>
  )
}
