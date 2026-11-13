import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { PencilSquareIcon, MapPinIcon, TrashIcon, CheckCircleIcon, XMarkIcon, SparklesIcon, InboxArrowDownIcon } from '@heroicons/react/20/solid'
import api, { inventoryItemsAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import BarcodeDisplay from '../../components/BarcodeDisplay'
import StorageAssignmentModal from '../../components/StorageAssignmentModal'
import { useRecordTitle } from '../../components/shell/ShellContext'
import ReplenishmentPlan from '../../components/inventory/ReplenishmentPlan'
import {
  PageHeader, Button, Menu, StatusBadge, Badge, Money, Num, Code, DateText, ConfirmDialog, DetailLayout, SummaryStrip,
  Tabs, Card, DescriptionList, Timeline, RelatedPanel, DataTable, RowAction, SkeletonDetail, ErrorState, InlineNotice,
  AiAnswer, formatNumber, notify,
} from '../../components/ui'

const GRADE = { A: 'Excellent', B: 'Good — minor wear', C: 'Fair — noticeable wear', D: 'Poor — significant wear or damage' }

/** An inventory item on the record pattern: five facts, tabs, history, related, checks. */
export default function InventoryItemView() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [tab, setTab] = useState('stock')
  const [confirm, setConfirm] = useState(null)
  const [assigning, setAssigning] = useState(false)

  const { data: item, loading, error, refetch } = useResource(['inventory-items', id], () => inventoryItemsAPI.getById(id), { enabled: !!id })
  const { data: mapData, loading: mapsLoading, refetch: refetchMaps } = useResource(['inventory-items', id, 'storage'], () => inventoryItemsAPI.getStorageMappings(id), { enabled: !!id })
  const maps = useMemo(() => (Array.isArray(mapData) ? mapData : []), [mapData])
  useRecordTitle(item?.item_name, { subtitle: item?.approved_item_code || item?.item_code })

  const invalidates = [['inventory-items']]
  const approve = useResourceMutation(() => inventoryItemsAPI.approve(id, {}), { invalidates, silent: true })
  const decline = useResourceMutation((reason) => api.post(`/inventory-items/${id}/decline`, { reason }), { invalidates, silent: true })
  const remove = useResourceMutation(() => inventoryItemsAPI.delete(id), { invalidates, silent: true })
  const unmap = useResourceMutation((mappingId) => inventoryItemsAPI.removeStorageMapping(id, mappingId), { invalidates: [['inventory-items', id, 'storage']], silent: true })

  if (loading) return <SkeletonDetail />
  if (error || !item) return <ErrorState what="Inventory item" error={error} onRetry={refetch} />

  const onHand = Number(item.current_stock_quantity) || 0
  const reorder = item.reorder_point == null ? null : Number(item.reorder_point)
  const value = onHand * (Number(item.unit_price) || 0)
  const state = onHand <= 0 ? { label: 'Out of stock', tone: 'risk', glyph: 'triangle' } : reorder != null && onHand <= reorder ? { label: 'Below reorder point', tone: 'warn', glyph: 'triangle' } : { label: 'In stock', tone: 'ok', glyph: 'dot' }
  const unit = item.unit_of_measure || 'units'

  const act = async (kind, arg) => {
    const fn = { approve, decline, delete: remove, unmap }[kind]
    const verb = { approve: 'approved', decline: 'declined', delete: 'deleted', unmap: 'removed from that location' }[kind]
    try {
      await fn.mutateAsync(arg)
      setConfirm(null)
      notify.success(`${item.item_name} ${verb}`)
      if (kind === 'delete') navigate('/inventory/items')
      if (kind === 'unmap') refetchMaps()
    } catch (e) {
      setConfirm(null)
      notify.error(`${item.item_name} was not ${verb}: ${e?.response?.data?.error || e.message}`)
    }
  }

  const CONFIRMS = {
    approve: { title: `Approve ${item.item_name}?`, consequence: 'The item becomes available for storage assignment, receipts and issues.', label: 'Approve item', tone: 'primary' },
    decline: { title: `Decline ${item.item_name}?`, consequence: 'The requester sees your reason and can correct and resubmit.', label: 'Decline item', tone: 'danger', requireReason: true },
    delete: { title: `Delete ${item.item_name}?`, consequence: `The inventory record is removed${onHand > 0 ? `, including ${formatNumber(onHand)} ${unit} recorded on hand` : ''}. The item master stays.`, label: `Delete ${item.item_name}`, tone: 'danger' },
    unmap: { title: 'Remove this storage assignment?', consequence: 'The item will no longer be expected at this location. Stock records are not changed.', label: 'Remove assignment', tone: 'danger' },
  }

  let primary = null
  const secondary = []
  if (item.status === 'PENDING_APPROVAL') {
    primary = <Button variant="primary" icon={CheckCircleIcon} onClick={() => setConfirm({ kind: 'approve' })}>Approve</Button>
    secondary.push(<Button key="d" variant="destructive" icon={XMarkIcon} onClick={() => setConfirm({ kind: 'decline' })}>Decline</Button>)
  } else if (item.status === 'APPROVED') {
    primary = <Button variant="primary" icon={InboxArrowDownIcon} to="/warehouse/transactions/goods-receipt">Receive stock</Button>
    secondary.push(<Button key="a" icon={MapPinIcon} onClick={() => setAssigning(true)}>Assign location</Button>)
  }
  secondary.push(<Button key="e" icon={PencilSquareIcon} to={`/inventory/items/${id}/edit`}>Edit</Button>)

  const concluded = []
  if (onHand <= 0 && item.status === 'APPROVED') concluded.push('Nothing on hand. Issues against this item will fail until stock is received.')
  if (reorder == null) concluded.push('No reorder point is set, so nothing will warn you before it runs out.')
  else if (onHand <= reorder) concluded.push(`On hand (${formatNumber(onHand)} ${unit}) is at or below the reorder point (${formatNumber(reorder)}).`)
  if (!Number(item.unit_price)) concluded.push('No unit price, so the stock value cannot be counted.')
  if (!maps.length && !mapsLoading && item.status === 'APPROVED') concluded.push('Not assigned to any storage location.')
  if (item.status === 'DECLINED' && item.decline_reason) concluded.push(`Declined: ${item.decline_reason}`)

  const events = [
    item.status === 'DECLINED' && { title: 'Declined', at: item.updated_at, tone: 'risk', note: item.decline_reason },
    item.approved_at && { title: 'Approved', at: item.approved_at, tone: 'ok' },
    item.updated_at && item.updated_at !== item.created_at && item.status !== 'DECLINED' && { title: 'Last changed', at: item.updated_at, tone: 'ink' },
    { title: 'Created', at: item.created_at, tone: 'ink' },
  ].filter(Boolean)

  const mapColumns = [
    { id: 'loc', header: 'Location', accessor: (m) => m.storage_name || m.location_name, mobile: 'title', cell: (m) => <span><span className="block">{m.storage_name || m.location_name}</span>{m.storage_code && <span className="block font-mono text-2xs text-ink-500">{m.storage_code}{m.address ? ` · ${m.address}` : ''}</span>}</span>, wrap: true },
    { id: 'bin', header: 'Bin', accessor: 'bin_code', cell: (m) => (m.bin_code ? <Code>{m.bin_code}</Code> : <span className="text-ink-400">Any bin</span>), width: 140 },
    { id: 'qty', header: 'Quantity here', accessor: (m) => Number(m.quantity_in_location), align: 'right', width: 140, cell: (m) => (m.quantity_in_location != null ? <Num value={m.quantity_in_location} unit={unit} /> : '—'), mobile: 'trailing' },
    { id: 'status', header: 'Assignment', accessor: 'status', cell: (m) => <StatusBadge status={m.status || 'APPROVED'} />, width: 160, mobile: 'meta' },
  ]

  return (
    <>
      <DetailLayout
        header={
          <PageHeader
            title={item.item_name}
            status={<StatusBadge status={item.status} />}
            badge={<Badge tone={state.tone} glyph={state.glyph}>{state.label}</Badge>}
            meta={<><Code>{item.approved_item_code || item.item_code}</Code>{item.item_category && <span>{item.item_category}</span>}<span>{item.planned_stock ? 'Planned stock (ST2)' : 'Regular stock (ST1)'}</span></>}
            secondary={<>{secondary}<Menu items={[
              { label: 'Ask Simeli about this item', icon: SparklesIcon, onSelect: () => navigate(`/ai/chat?q=${encodeURIComponent(`How is ${item.item_name} (${item.approved_item_code || item.item_code}) moving, and when should I reorder?`)}`) },
              { label: 'We\'ll run low — what should I do?', icon: SparklesIcon, onSelect: () => navigate(`/ai/chat?q=${encodeURIComponent(`We're going to run low on ${item.item_name} (${item.approved_item_code || item.item_code}). What should I do?`)}`) },
              { divider: true },
              { label: 'Delete inventory record', tone: 'risk', icon: TrashIcon, onSelect: () => setConfirm({ kind: 'delete' }) },
            ]} /></>}
            primary={primary}
          />
        }
        notice={item.status === 'DECLINED' ? <InlineNotice tone="risk" title="Declined">{item.decline_reason || 'No reason was recorded.'} Edit the item and resubmit it.</InlineNotice> : null}
        summary={
          <SummaryStrip
            facts={[
              { label: 'On hand', value: <Num value={onHand} digits={onHand % 1 ? 2 : 0} unit={unit} />, hint: reorder != null ? `reorder at ${formatNumber(reorder)}` : 'no reorder point' },
              { label: 'Stock value', value: <Money amount={value} currency={item.currency} />, hint: item.unit_price ? `${new Intl.NumberFormat(undefined, { style: 'currency', currency: item.currency || 'USD' }).format(Number(item.unit_price))} per ${unit}` : 'no unit price' },
              { label: 'Min / max', value: <span className="tabular-nums">{item.minimum_stock_level ?? '—'} / {item.maximum_stock_level ?? '—'}</span> },
              { label: 'Locations', value: mapsLoading ? '…' : maps.length || 'None', hint: maps[0]?.storage_name },
              { label: 'Criticality', value: item.criticality ? item.criticality.toLowerCase().replace(/^./, (c) => c.toUpperCase()) : '—', hint: `Condition ${item.condition_grade || 'A'} · ${GRADE[item.condition_grade || 'A']}` },
            ]}
          />
        }
        aside={
          <>
            {item.status === 'APPROVED' && <ReplenishmentPlan inventoryItemId={id} name={`${item.item_name} (${item.approved_item_code || item.item_code})`} />}
            <AiAnswer compact title="What needs a look" read={[{ label: item.approved_item_code || item.item_code }, { label: `${maps.length} location${maps.length === 1 ? '' : 's'}` }]} concluded={concluded} footnote="Rule-based checks on this record. Simeli read only what your role can see." />
            <Card title="History"><Timeline events={events} /></Card>
            <RelatedPanel groups={[{ label: 'Item master', items: item.item_master_id ? [{ label: item.approved_item_code || item.item_code, to: `/items/${item.item_master_id}/view`, sublabel: 'master data' }] : [] }]} />
          </>
        }
      >
        <Tabs value={tab} onChange={setTab} label="Item sections" tabs={[{ id: 'stock', label: 'Storage', count: maps.length }, { id: 'details', label: 'Details' }, { id: 'physical', label: 'Physical' }]}>
          {(t) => (
            <>
              {t === 'stock' && (
                <DataTable
                  caption="Storage locations"
                  noun="location"
                  rows={maps}
                  columns={mapColumns}
                  loading={mapsLoading}
                  search={false}
                  showCount={false}
                  rowActions={(m) => <RowAction icon={TrashIcon} tone="risk" label="Remove assignment" onClick={() => setConfirm({ kind: 'unmap', arg: m.id })} />}
                  empty={{ icon: MapPinIcon, title: 'Not assigned to a location', description: 'Assign the item to a storage location and bin so receipts and picks know where it lives.', action: item.status === 'APPROVED' ? <Button variant="primary" icon={MapPinIcon} onClick={() => setAssigning(true)}>Assign location</Button> : <span className="text-sm text-ink-500">Available once the item is approved.</span> }}
                />
              )}
              {t === 'details' && (
                <Card>
                  <DescriptionList
                    items={[
                      { label: 'Description', value: item.description, wide: true },
                      { label: 'Item code', value: <Code>{item.approved_item_code || '—'}</Code> },
                      { label: 'Original code', value: <Code>{item.item_code}</Code> },
                      { label: 'Category', value: item.item_category },
                      { label: 'UNSPSC', value: item.unspsc_code && <Code>{item.unspsc_code}</Code> },
                      { label: 'Manufacturer', value: item.manufacturer },
                      { label: 'Manufacturer part no.', value: item.manufacturer_part_number && <Code>{item.manufacturer_part_number}</Code> },
                      { label: 'Serial number', value: item.serial_number && <Code>{item.serial_number}</Code> },
                      { label: 'Equipment tag', value: item.equipment_tag && <Code>{item.equipment_tag}</Code> },
                      { label: 'Contract', value: item.has_contract ? item.contract_number || 'Yes' : 'No' },
                      { label: 'Condition notes', value: item.condition_notes, wide: true },
                      { label: 'Created', value: <DateText value={item.created_at} withTime /> },
                      { label: 'Last updated', value: <DateText value={item.updated_at} withTime /> },
                    ]}
                  />
                  {item.has_barcode && item.barcode && (
                    <div className="mt-5 border-t border-ink-200 pt-4">
                      <p className="label-mono mb-2">Barcode</p>
                      <div className="inline-block rounded-md bg-white p-2" style={{ background: '#fff' }}>
                        <BarcodeDisplay value={item.barcode} format="AUTO" width={1.5} height={60} displayValue />
                      </div>
                    </div>
                  )}
                </Card>
              )}
              {t === 'physical' && (
                <Card>
                  <DescriptionList
                    items={[
                      { label: 'Unit of measure', value: <Code>{unit}</Code> },
                      { label: 'Mass per unit', value: item.mass_per_uom != null ? `${item.mass_per_uom} kg` : null },
                      { label: 'Volume per unit', value: item.volume_per_uom != null ? `${item.volume_per_uom} m³` : null },
                      { label: 'Total mass on hand', value: item.mass_per_uom != null ? `${formatNumber(onHand * Number(item.mass_per_uom), 2)} kg` : null },
                      { label: 'Total volume on hand', value: item.volume_per_uom != null ? `${formatNumber(onHand * Number(item.volume_per_uom), 3)} m³` : null },
                    ]}
                  />
                </Card>
              )}
            </>
          )}
        </Tabs>
      </DetailLayout>

      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={(reason) => act(confirm.kind, confirm.kind === 'decline' ? reason : confirm.arg)}
          title={CONFIRMS[confirm.kind].title}
          consequence={CONFIRMS[confirm.kind].consequence}
          confirmLabel={CONFIRMS[confirm.kind].label}
          tone={CONFIRMS[confirm.kind].tone}
          requireReason={CONFIRMS[confirm.kind].requireReason}
          reversible={confirm.kind === 'decline'}
          busy={approve.isPending || decline.isPending || remove.isPending || unmap.isPending}
        />
      )}

      <StorageAssignmentModal isOpen={assigning} onClose={() => setAssigning(false)} inventoryItem={item} onSuccess={() => { setAssigning(false); refetchMaps() }} />
    </>
  )
}
