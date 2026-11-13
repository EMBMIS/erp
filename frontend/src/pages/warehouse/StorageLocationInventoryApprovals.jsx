import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { CheckIcon, XMarkIcon, CheckBadgeIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useRecordTitle } from '../../components/shell/ShellContext'
import {
  PageHeader, Button, Badge, StatusBadge, Code, Money, Num, ConfirmDialog, EmptyState, ErrorState, SkeletonRows, formatNumber, notify,
} from '../../components/ui'
import { asList, formatBinCode } from './warehouseData'
import { useLocationPendingItems } from './useWarehouse'

/**
 * Inventory approvals for one storage location — the manager's queue of
 * inventory lines sitting in this location's bins that still need sign-off.
 * Each line is a card with the two decisions at thumb height.
 */
export default function StorageLocationInventoryApprovals() {
  const { id } = useParams()
  const [confirm, setConfirm] = useState(null) // { kind, item }

  const { data: location } = useResource(keys.storageLocation(id), ({ signal }) => api.get(`/storage-locations/${id}`, { signal }), { enabled: Boolean(id) })
  const { data, loading, error, refetch } = useLocationPendingItems(id)
  const items = asList(data)
  useRecordTitle(location?.name, { subtitle: location?.code })

  const invalidates = [keys.storageLocationPendingApprovals(id), ['inventory-items']]
  const approve = useResourceMutation((itemId) => api.post(`/inventory-items/${itemId}/approve`), { invalidates, silent: true })
  const decline = useResourceMutation(({ itemId, reason }) => api.post(`/inventory-items/${itemId}/decline`, { reason }), { invalidates, silent: true })

  const act = async (reason) => {
    const { kind, item } = confirm
    try {
      if (kind === 'approve') await approve.mutateAsync(item.inventory_item_id)
      else await decline.mutateAsync({ itemId: item.inventory_item_id, reason })
      notify.success(`${item.item_name} ${kind === 'approve' ? 'approved' : 'declined'}`)
    } catch (e) {
      notify.error(`${item.item_name} was not ${kind === 'approve' ? 'approved' : 'declined'}: ${e?.response?.data?.error || e.message}`)
    }
    setConfirm(null)
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title="Inventory approvals"
        description={location ? `Inventory lines in the bins of ${location.name} that need a manager's sign-off.` : 'Inventory lines in this location that need a manager’s sign-off.'}
        status={!loading && items.length ? <Badge tone="warn" glyph="clock">{items.length} pending</Badge> : null}
      />

      {loading ? (
        <div className="rounded-lg border border-ink-200 bg-surface"><SkeletonRows rows={4} columns={4} /></div>
      ) : error ? (
        <ErrorState what="Pending inventory" error={error} onRetry={refetch} />
      ) : !items.length ? (
        <div className="rounded-lg border border-ink-200 bg-surface">
          <EmptyState icon={CheckBadgeIcon} title="Nothing waiting" description="No inventory in this location's bins is awaiting approval." action={<Button to={`/warehouse/storage-locations/${id}`}>Back to the location</Button>} />
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={`${item.inventory_item_id}-${item.bin_id}`} className="rounded-lg border border-ink-200 bg-surface">
              <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-3">
                <div className="min-w-0">
                  <p className="font-medium text-fg">{item.item_name}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-ink-500">
                    {item.approved_item_code && <Code>{item.approved_item_code}</Code>}
                    <span>Bin <Link to={`/warehouse/bins/${item.bin_id}`} className="font-mono text-brand-600 hover:underline">{formatBinCode(item.bin_code)}</Link></span>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {item.criticality && <Badge tone={item.criticality === 'HIGH' ? 'warn' : 'ink'} mono>{item.criticality}</Badge>}
                  <StatusBadge status="PENDING_APPROVAL" />
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 py-3 text-sm sm:grid-cols-4">
                <div><dt className="text-xs text-ink-500">Quantity here</dt><dd><Num value={item.quantity_in_location} unit={item.unit_of_measure} /></dd></div>
                <div><dt className="text-xs text-ink-500">Unit price</dt><dd><Money amount={item.unit_price} currency={item.currency} /></dd></div>
                <div><dt className="text-xs text-ink-500">Condition</dt><dd>Grade {item.condition_grade || 'A'}</dd></div>
                <div><dt className="text-xs text-ink-500">Mass here</dt><dd className="tabular-nums">{Number(item.total_mass) ? `${formatNumber(item.total_mass, 2)} kg` : '—'}</dd></div>
              </dl>
              {item.condition_notes && <p className="mx-4 mb-3 rounded-md bg-sunken px-3 py-2 text-sm text-ink-700">{item.condition_notes}</p>}
              <div className="flex flex-col-reverse gap-2 border-t border-ink-200 px-4 py-3 sm:flex-row sm:justify-end">
                <Button size="lg" variant="destructive" icon={XMarkIcon} onClick={() => setConfirm({ kind: 'decline', item })}>Decline</Button>
                <Button size="lg" variant="primary" icon={CheckIcon} onClick={() => setConfirm({ kind: 'approve', item })}>Approve</Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={act}
          title={`${confirm.kind === 'approve' ? 'Approve' : 'Decline'} ${confirm.item.item_name}?`}
          consequence={confirm.kind === 'approve'
            ? 'The item becomes available for receipts, issues and transfers.'
            : 'The requester sees your reason and can correct the item and resubmit it.'}
          confirmLabel={confirm.kind === 'approve' ? 'Approve item' : 'Decline item'}
          tone={confirm.kind === 'approve' ? 'primary' : 'danger'}
          requireReason={confirm.kind === 'decline'}
          reversible={confirm.kind === 'decline'}
          busy={approve.isPending || decline.isPending}
        />
      )}
    </div>
  )
}
