import { useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { PencilSquareIcon, TrashIcon, PlusIcon, EyeIcon, CubeIcon, BuildingStorefrontIcon, PaperAirplaneIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useRecordTitle } from '../../components/shell/ShellContext'
import {
  PageHeader, Button, Menu, StatusBadge, Badge, Code, Num, Money, DateText, ConfirmDialog, Dialog, Field, Select, DetailLayout,
  SummaryStrip, Tabs, Card, DescriptionList, Timeline, RelatedPanel, DataTable, RowAction, SkeletonDetail, ErrorState,
  InlineNotice, describeError, formatNumber, notify,
} from '../../components/ui'
import { Utilisation } from './WarehouseParts'
import { asList, formatBinCode, pct } from './warehouseData'

const n = (v) => (v == null || v === '' ? null : Number(v))

/** A bin: how full it is, what is in it, and putting another item into it. */
export default function BinView() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [tab, setTab] = useState('contents')
  const [confirm, setConfirm] = useState(null)
  const [assigning, setAssigning] = useState(false)
  const [assignId, setAssignId] = useState('')
  const [assignError, setAssignError] = useState(null)

  const { data: bin, loading, error, refetch } = useResource(keys.bin(id), ({ signal }) => api.get(`/bins/${id}`, { signal }), { enabled: Boolean(id) })
  const { data: itemsData, loading: itemsLoading } = useResource(keys.binInventoryItems(id), ({ signal }) => api.get(`/bins/${id}/inventory-items`, { signal }), { enabled: Boolean(id) })
  const contents = useMemo(() => asList(itemsData), [itemsData])
  // Loaded only when the assign dialog opens.
  const { data: availData, loading: availLoading } = useResource(
    keys.inventoryItems({ status: 'APPROVED', unassigned: true }),
    ({ signal }) => api.get('/inventory-items', { params: { status: 'APPROVED', unassigned: true }, signal }),
    { enabled: assigning }
  )
  const available = asList(availData)
  useRecordTitle(bin ? formatBinCode(bin.code) : null, { subtitle: bin?.storage_location_name })

  const remove = useResourceMutation(() => api.delete(`/bins/${id}`), { invalidates: [['bins']], silent: true })
  const submit = useResourceMutation(() => api.post(`/bins/${id}/submit-for-approval`), { invalidates: [['bins']], silent: true })
  const assign = useResourceMutation(
    () => api.post(`/inventory-items/${assignId}/storage-mapping`, { storage_location_id: bin.storage_location_id, bin_id: id, status: 'PENDING_APPROVAL' }),
    // The assignment changes the bin's contents and the item's availability.
    { invalidates: [['inventory-items'], keys.binInventoryItems(id), keys.bin(id)], silent: true }
  )

  const columns = useMemo(() => [
    {
      id: 'item', header: 'Item', accessor: 'item_name', minWidth: 200, mobile: 'title',
      cell: (i) => <span className="block min-w-0"><span className="block truncate">{i.item_name}</span><span className="block truncate font-mono text-2xs text-ink-500">{i.approved_item_code || i.item_code}</span></span>,
    },
    { id: 'qty', header: 'Quantity here', accessor: (i) => Number(i.quantity_in_location), align: 'right', width: 140, mobile: 'trailing', cell: (i) => <Num value={i.quantity_in_location} digits={Number(i.quantity_in_location) % 1 ? 2 : 0} unit={i.unit_of_measure} /> },
    { id: 'mass', header: 'Weight', accessor: (i) => Number(i.total_mass), align: 'right', width: 110, cell: (i) => (Number(i.total_mass) ? <Num value={i.total_mass} digits={2} unit="kg" /> : <span className="text-ink-400">—</span>) },
    { id: 'vol', header: 'Volume', accessor: (i) => Number(i.total_volume), align: 'right', width: 110, defaultHidden: true, cell: (i) => (Number(i.total_volume) ? <Num value={i.total_volume} digits={4} unit="m³" /> : <span className="text-ink-400">—</span>) },
    { id: 'price', header: 'Unit price', accessor: (i) => Number(i.unit_price), align: 'right', width: 120, cell: (i) => <Money amount={i.unit_price} currency={i.currency} /> },
    { id: 'grade', header: 'Condition', accessor: 'condition_grade', width: 100, cell: (i) => <Code>{i.condition_grade || 'A'}</Code> },
    { id: 'status', header: 'Item status', accessor: 'inventory_status', width: 160, mobile: 'meta', cell: (i) => <StatusBadge status={i.inventory_status} /> },
  ], [])

  if (loading) return <SkeletonDetail />
  if (error || !bin) return <ErrorState what="Bin" error={error} onRetry={refetch} />

  const massMax = n(bin.max_mass_capacity)
  const volMax = n(bin.max_volume_capacity)
  const massUsed = n(bin.current_mass_used) ?? 0
  const volUsed = n(bin.current_volume_used) ?? 0
  const approved = bin.status === 'ACTIVE'
  const near = pct(bin.mass_utilization_percent) >= 90 || pct(bin.volume_utilization_percent) >= 90
  const selected = available.find((i) => i.id === assignId)

  const run = async (kind) => {
    const m = kind === 'delete' ? remove : submit
    try {
      await m.mutateAsync()
      setConfirm(null)
      notify.success(`Bin ${bin.code} ${kind === 'delete' ? 'deleted' : 'sent for approval'}`)
      if (kind === 'delete') navigate('/warehouse/bins')
    } catch (e) {
      setConfirm(null)
      notify.error(`Bin ${bin.code} was not ${kind === 'delete' ? 'deleted' : 'sent'}: ${e?.response?.data?.error || e.message}`)
    }
  }

  const doAssign = async () => {
    setAssignError(null)
    if (!assignId) { setAssignError({ message: 'Choose an inventory item to put in this bin.' }); return }
    try {
      await assign.mutateAsync()
      notify.success(`${selected?.item_name || 'Item'} sent for approval to bin ${bin.code}`)
      setAssigning(false)
      setAssignId('')
    } catch (e) {
      setAssignError(describeError(e))
    }
  }

  let primary = <Button variant="primary" icon={PlusIcon} onClick={() => setAssigning(true)}>Assign item</Button>
  if (bin.status === 'DRAFT') primary = <Button variant="primary" icon={PaperAirplaneIcon} onClick={() => setConfirm('submit')}>Send for approval</Button>

  const events = [
    bin.updated_at && bin.updated_at !== bin.created_at && { title: 'Last changed', at: bin.updated_at, tone: 'ink' },
    { title: 'Created', at: bin.created_at, tone: 'ink' },
  ].filter(Boolean)

  return (
    <>
      <DetailLayout
        header={
          <PageHeader
            title={`Bin ${formatBinCode(bin.code)}`}
            status={<StatusBadge status={bin.status} label={approved ? 'Approved' : undefined} />}
            badge={bin.is_active === false ? <Badge glyph="ring">Inactive</Badge> : near ? <Badge tone="risk" glyph="triangle">Near capacity</Badge> : null}
            meta={<>{bin.description && <span>{bin.description}</span>}<span>{bin.storage_location_name} {bin.storage_location_code && <Code>({bin.storage_location_code})</Code>}</span></>}
            secondary={<>
              <Button icon={PencilSquareIcon} to={`/warehouse/bins/${id}/edit`}>Edit</Button>
              <Menu items={[
                ...(bin.status === 'DRAFT' ? [{ label: 'Assign item', icon: PlusIcon, onSelect: () => setAssigning(true) }] : []),
                { label: 'Open storage location', icon: BuildingStorefrontIcon, onSelect: () => navigate(`/warehouse/storage-locations/${bin.storage_location_id}`) },
                { label: 'Other bins in this location', icon: CubeIcon, onSelect: () => navigate(`/warehouse/bins?location=${bin.storage_location_id}`) },
                { divider: true },
                { label: 'Delete bin', tone: 'risk', icon: TrashIcon, onSelect: () => setConfirm('delete') },
              ]} />
            </>}
            primary={primary}
          />
        }
        notice={near ? <InlineNotice tone="warn" title="This bin is nearly full">At 90% or more of its weight or volume. Put new stock in another bin, or move some out.</InlineNotice> : null}
        summary={
          <SummaryStrip
            facts={[
              { label: 'Weight used', value: pct(bin.mass_utilization_percent) == null ? '—' : `${formatNumber(pct(bin.mass_utilization_percent), 1)}%`, hint: massMax != null ? `${formatNumber(massUsed, 1)} of ${formatNumber(massMax, 1)} kg` : null },
              { label: 'Volume used', value: pct(bin.volume_utilization_percent) == null ? '—' : `${formatNumber(pct(bin.volume_utilization_percent), 1)}%`, hint: volMax != null ? `${formatNumber(volUsed, 3)} of ${formatNumber(volMax, 3)} m³` : null },
              { label: 'Weight left', value: massMax != null ? <Num value={massMax - massUsed} digits={1} unit="kg" /> : '—' },
              { label: 'Volume left', value: volMax != null ? <Num value={volMax - volUsed} digits={3} unit="m³" /> : '—' },
              { label: 'Items stored', value: itemsLoading ? '…' : contents.length },
            ]}
          />
        }
        aside={
          <>
            <Card title="Capacity">
              <div className="space-y-4">
                <Utilisation label="Weight" percent={bin.mass_utilization_percent} used={massUsed} max={massMax} unit="kg" digits={2} />
                <Utilisation label="Volume" percent={bin.volume_utilization_percent} used={volUsed} max={volMax} unit="m³" digits={3} />
              </div>
            </Card>
            <Card title="History"><Timeline events={events} /></Card>
            <RelatedPanel groups={[{ label: 'Storage location', items: bin.storage_location_id ? [{ label: bin.storage_location_code || bin.storage_location_name, to: `/warehouse/storage-locations/${bin.storage_location_id}`, sublabel: bin.storage_location_name }] : [] }]} />
          </>
        }
      >
        <Tabs value={tab} onChange={setTab} label="Bin sections" tabs={[{ id: 'contents', label: 'Contents', count: contents.length }, { id: 'details', label: 'Details' }]}>
          {(t) => (
            <>
              {t === 'contents' && (
                <DataTable
                  caption="Items in this bin"
                  noun="item"
                  rows={contents}
                  columns={columns}
                  loading={itemsLoading}
                  showCount={false}
                  rowKey={(i) => i.id || i.inventory_item_id}
                  rowHref={(i) => `/inventory/items/${i.inventory_item_id}`}
                  rowActions={(i) => <RowAction icon={EyeIcon} label={`Open ${i.item_name}`} to={`/inventory/items/${i.inventory_item_id}`} />}
                  empty={{ icon: CubeIcon, title: 'This bin is empty', description: 'Assign an approved inventory item to it, or put stock away here with a goods receipt.', action: <Button variant="primary" icon={PlusIcon} onClick={() => setAssigning(true)}>Assign item</Button> }}
                />
              )}
              {t === 'details' && (
                <Card>
                  <DescriptionList
                    items={[
                      { label: 'Bin code', value: <Code>{formatBinCode(bin.code)}</Code> },
                      { label: 'Format', value: 'Warehouse – row – shelf – bin' },
                      { label: 'Description', value: bin.description, wide: true },
                      { label: 'Storage location', value: bin.storage_location_name },
                      { label: 'In use', value: bin.is_active === false ? 'Inactive' : 'Active' },
                      { label: 'Weight capacity', value: massMax != null ? `${formatNumber(massMax, 3)} kg` : null },
                      { label: 'Volume capacity', value: volMax != null ? `${formatNumber(volMax, 3)} m³` : null },
                      { label: 'Created', value: <DateText value={bin.created_at} withTime /> },
                      { label: 'Last updated', value: <DateText value={bin.updated_at} withTime /> },
                    ]}
                  />
                </Card>
              )}
            </>
          )}
        </Tabs>
      </DetailLayout>

      <Dialog
        open={assigning}
        onClose={() => { setAssigning(false); setAssignError(null) }}
        title={`Assign an item to bin ${formatBinCode(bin.code)}`}
        description="The whole inventory item is assigned. A manager approves the assignment before it counts."
        footer={<>
          <Button variant="secondary" onClick={() => setAssigning(false)}>Cancel</Button>
          <Button variant="primary" loading={assign.isPending} onClick={doAssign}>Send for approval</Button>
        </>}
      >
        <div className="space-y-4">
          {assignError && <InlineNotice tone="risk" title="Not assigned">{assignError.message}</InlineNotice>}
          <Field label="Inventory item" required help={availLoading ? 'Loading approved items…' : available.length ? 'Approved items not yet in a bin.' : 'Every approved item is already in a bin.'} id="bin-assign-item">
            <Select size="lg" value={assignId} onChange={(e) => setAssignId(e.target.value)} disabled={availLoading}>
              <option value="">Choose an item…</option>
              {available.map((i) => <option key={i.id} value={i.id}>{i.item_name}{i.approved_item_code ? ` — ${i.approved_item_code}` : ''}</option>)}
            </Select>
          </Field>
          {selected && (
            <DescriptionList
              items={[
                { label: 'On hand', value: <Num value={selected.current_stock_quantity} unit={selected.unit_of_measure} /> },
                { label: 'Condition', value: `Grade ${selected.condition_grade || 'A'}` },
                { label: 'Criticality', value: selected.criticality },
                { label: 'Weight per unit', value: selected.mass_per_uom != null ? `${selected.mass_per_uom} kg` : null },
                { label: 'Volume per unit', value: selected.volume_per_uom != null ? `${selected.volume_per_uom} m³` : null },
              ]}
            />
          )}
        </div>
      </Dialog>

      {confirm === 'delete' && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={() => run('delete')}
          title={`Delete bin ${formatBinCode(bin.code)}?`}
          consequence={contents.length ? `It still holds ${contents.length} item${contents.length === 1 ? '' : 's'}; the server refuses while stock is in it.` : 'The bin is removed from its storage location.'}
          confirmLabel="Delete bin"
          busy={remove.isPending}
        />
      )}
      {confirm === 'submit' && (
        <ConfirmDialog
          open
          tone="primary"
          onClose={() => setConfirm(null)}
          onConfirm={() => run('submit')}
          title={`Send bin ${formatBinCode(bin.code)} for approval?`}
          consequence="A manager approves or declines it in Approvals. Stock can be put away here once it is approved."
          confirmLabel="Send for approval"
          busy={submit.isPending}
        />
      )}
    </>
  )
}
