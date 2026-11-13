import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { PencilSquareIcon, TrashIcon, PlusIcon } from '@heroicons/react/20/solid'
import { itemsAPI } from '../services/api'
import { useResource, useResourceMutation } from '../hooks/useResource'
import BarcodeDisplay from '../components/BarcodeDisplay'
import { useRecordTitle } from '../components/shell/ShellContext'
import {
  PageHeader, Button, Menu, StatusBadge, Badge, Code, DateText, ConfirmDialog, DetailLayout, SummaryStrip, Tabs, Card,
  DescriptionList, Timeline, InlineNotice, SkeletonDetail, ErrorState, describeError, notify,
} from '../components/ui'

const CRIT_TONE = { HIGH: 'risk', MEDIUM: 'warn' }
const cap = (s) => (s ? s.toLowerCase().replace(/^./, (c) => c.toUpperCase()) : '—')
const stockType = (i) => (!i.is_stock_item ? 'Non-stock' : i.planned_stock ? 'Planned stock' : 'Regular stock')

/** An item master on the record pattern: five facts, then details by tab. */
export default function ItemView() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [tab, setTab] = useState('details')
  const [removing, setRemoving] = useState(false)

  const { data: item, loading, error, refetch } = useResource(['items', id], () => itemsAPI.getById(id), { enabled: !!id })
  useRecordTitle(item?.name, { subtitle: item?.approved_item_code || item?.item_code })
  const remove = useResourceMutation(() => itemsAPI.delete(id), { invalidates: [['items']], silent: true })

  if (loading) return <SkeletonDetail />
  if (error || !item) return <ErrorState what="Item master" error={error} onRetry={refetch} />

  const doRemove = async () => {
    try {
      await remove.mutateAsync()
      notify.success(`${item.name} deleted`)
      navigate('/items')
    } catch (e) {
      setRemoving(false)
      notify.error(`${item.name} was not deleted: ${describeError(e).message}`)
    }
  }

  const events = [
    item.status === 'APPROVED' && { title: 'Approved', at: item.approved_at || item.updated_at, tone: 'ok' },
    item.decline_reason && { title: 'Declined', tone: 'risk', note: item.decline_reason },
    item.updated_at && item.updated_at !== item.created_at && { title: 'Last changed', at: item.updated_at, tone: 'ink' },
    { title: 'Created', at: item.created_at, tone: 'ink' },
  ].filter(Boolean)

  return (
    <>
      <DetailLayout
        header={
          <PageHeader
            title={item.name}
            status={<StatusBadge status={item.status} />}
            meta={<><Code>{item.approved_item_code || item.item_code}</Code>{item.item_category && <span>{item.item_category}</span>}</>}
            secondary={<>
              {item.status === 'APPROVED' && <Button icon={PlusIcon} to="/inventory/items/create">Stock as inventory</Button>}
              <Menu items={[{ label: `Delete ${item.name}`, tone: 'risk', icon: TrashIcon, onSelect: () => setRemoving(true) }]} />
            </>}
            primary={<Button variant="primary" icon={PencilSquareIcon} to={`/items/${item.id}/edit`}>Edit</Button>}
          />
        }
        notice={
          item.status === 'PENDING_REVIEW' ? <InlineNotice tone="ink" title="Waiting for review" action={<Button size="sm" to="/approvals/unified">Approval inbox</Button>}>An approver decides in the approval inbox. Once approved it gets its permanent code and can be stocked.</InlineNotice>
            : item.decline_reason && item.status !== 'APPROVED' ? <InlineNotice tone="risk" title="Declined">{item.decline_reason} Edit the item and resubmit it.</InlineNotice>
              : null
        }
        summary={
          <SummaryStrip facts={[
            { label: 'Stock type', value: stockType(item), hint: item.stock_code },
            { label: 'Criticality', value: item.criticality ? <Badge tone={CRIT_TONE[item.criticality] || 'ink'}>{cap(item.criticality)}</Badge> : '—' },
            { label: 'Unit', value: item.unit_of_measure || '—', hint: [item.mass_per_uom && `${item.mass_per_uom} kg`, item.volume_per_uom && `${item.volume_per_uom} m³`].filter(Boolean).join(' · ') || null },
            { label: 'Manufacturer', value: item.manufacturer || '—', hint: item.manufacturer_part_number ? `P/N ${item.manufacturer_part_number}` : null },
            { label: 'Contract', value: item.has_contract ? item.contract_number || 'Yes' : 'None' },
          ]} />
        }
        aside={<Card title="History"><Timeline events={events} /></Card>}
      >
        <Tabs value={tab} onChange={setTab} label="Item sections" tabs={[{ id: 'details', label: 'Details' }, { id: 'tracking', label: 'Tracking' }]}>
          {(t) => (
            <Card>
              {t === 'details' && (
                <DescriptionList items={[
                  { label: 'Description', value: item.description, wide: true },
                  { label: 'Item code', value: <Code>{item.approved_item_code || '—'}</Code> },
                  { label: 'Original code', value: <Code>{item.item_code}</Code> },
                  { label: 'Category', value: item.item_category },
                  { label: 'UNSPSC', value: item.unspsc_code && <Code>{item.unspsc_code}</Code> },
                  { label: 'Stock code', value: item.stock_code && <Code>{item.stock_code}</Code> },
                  { label: 'Unit of measure', value: item.unit_of_measure },
                  { label: 'Mass per unit', value: item.mass_per_uom != null ? `${item.mass_per_uom} kg` : null },
                  { label: 'Volume per unit', value: item.volume_per_uom != null ? `${item.volume_per_uom} m³` : null },
                  { label: 'Manufacturer', value: item.manufacturer },
                  { label: 'Part number', value: item.manufacturer_part_number && <Code>{item.manufacturer_part_number}</Code> },
                  { label: 'Created', value: <DateText value={item.created_at} withTime /> },
                  { label: 'Last updated', value: <DateText value={item.updated_at} withTime /> },
                ]} />
              )}
              {t === 'tracking' && (
                <>
                  <DescriptionList items={[
                    { label: 'Serial number', value: item.serial_number && <Code>{item.serial_number}</Code> },
                    { label: 'Equipment tag', value: item.equipment_tag && <Code>{item.equipment_tag}</Code> },
                    { label: 'Contract', value: item.has_contract ? (item.contract_number ? <Code>{item.contract_number}</Code> : 'Under contract, no number given') : 'No contract' },
                    { label: 'Barcode', value: item.has_barcode && item.barcode ? <Code>{item.barcode}</Code> : 'No barcode' },
                  ]} />
                  {item.has_barcode && item.barcode && (
                    <div className="mt-5 border-t border-ink-200 pt-4">
                      <div className="inline-block rounded-md p-2" style={{ background: '#fff' }}>
                        <BarcodeDisplay value={item.barcode} format="AUTO" width={1.5} height={60} displayValue />
                      </div>
                    </div>
                  )}
                </>
              )}
            </Card>
          )}
        </Tabs>
      </DetailLayout>

      <ConfirmDialog
        open={removing}
        onClose={() => setRemoving(false)}
        onConfirm={doRemove}
        title={`Delete ${item.name}?`}
        consequence={`The item master ${item.approved_item_code || item.item_code} is removed and can no longer be ordered or stocked.`}
        confirmLabel="Delete item"
        confirmText={item.status === 'APPROVED' ? (item.approved_item_code || item.item_code) : undefined}
        busy={remove.isPending}
      />
    </>
  )
}
