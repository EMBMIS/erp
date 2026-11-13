import { useMemo, useState } from 'react'
import { PlusIcon, CheckIcon, XMarkIcon, TruckIcon, ArrowRightIcon } from '@heroicons/react/20/solid'
import { inventoryTransfersAPI, storageLocationsAPI, inventoryItemsAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import {
  PageHeader, Button, DataTable, RowAction, StatusBadge, Badge, Code, Num, DateText, Segmented, ConfirmDialog, Dialog, Field, Input,
  Select, ErrorSummary, InlineNotice, DescriptionList, describeError, formatNumber, notify,
} from '../../components/ui'
import { asList } from './warehouseData'

const QUICK = {
  IN_TRANSIT: 'In transit',
  RECEIVED: 'Received',
  CANCELLED: 'Cancelled',
  '': 'All',
}

const route = (t) => (
  <span className="inline-flex min-w-0 flex-wrap items-center gap-1 text-sm">
    <span>{t.source_name || t.source_code || '—'}</span>
    {t.source_bin_code && <Code className="text-ink-500">{t.source_bin_code}</Code>}
    <ArrowRightIcon className="h-3.5 w-3.5 text-ink-400" aria-label="to" />
    <span>{t.destination_name || t.destination_code || '—'}</span>
    {t.destination_bin_code && <Code className="text-ink-500">{t.destination_bin_code}</Code>}
  </span>
)

const BLANK = { inventory_item_id: '', quantity: '', source_storage_location_id: '', destination_storage_location_id: '', notes: '' }

function validate(f) {
  const e = {}
  if (!f.inventory_item_id) e.inventory_item_id = 'Choose the item to move.'
  if (!(Number(f.quantity) > 0)) e.quantity = 'Enter a quantity above zero.'
  if (!f.source_storage_location_id) e.source_storage_location_id = 'Choose where it leaves from.'
  if (!f.destination_storage_location_id) e.destination_storage_location_id = 'Choose where it goes.'
  else if (f.destination_storage_location_id === f.source_storage_location_id) e.destination_storage_location_id = 'Source and destination must be different locations.'
  return e
}

/** Dispatch: stock leaves its source now and is in transit until someone receives it. */
function NewTransferDialog({ open, onClose }) {
  const [form, setForm] = useState(BLANK)
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState(null)
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const { data: locData } = useResource(['storage-locations', { limit: 500 }], () => storageLocationsAPI.getAll({ limit: 500 }), { enabled: open })
  const { data: itemData } = useResource(['inventory-items', { limit: 500 }], () => inventoryItemsAPI.getAll({ limit: 500 }), { enabled: open })
  const locations = asList(locData)
  const items = asList(itemData)
  const item = items.find((i) => i.id === form.inventory_item_id)
  const create = useResourceMutation((payload) => inventoryTransfersAPI.create(payload), { invalidates: [['inventory-transfers'], ['inventory-items']], silent: true })
  const errors = submitted ? validate(form) : {}

  const save = async () => {
    setSubmitted(true)
    setServerError(null)
    if (Object.keys(validate(form)).length) return
    try {
      const res = await create.mutateAsync({
        inventory_item_id: form.inventory_item_id,
        quantity: Number(form.quantity),
        source_storage_location_id: form.source_storage_location_id,
        destination_storage_location_id: form.destination_storage_location_id,
        notes: form.notes || null,
      })
      notify.success(`${res?.transfer_number || 'Transfer'} dispatched — stock is in transit`)
      setForm(BLANK)
      setSubmitted(false)
      onClose()
    } catch (e) {
      // The backend refuses a dispatch that would take more than the source holds, and names the shortfall.
      setServerError(describeError(e))
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New transfer"
      description="Dispatching takes the stock out of the source now. It counts nowhere until it is received."
      footer={<>
        <Button size="lg" variant="secondary" onClick={onClose}>Cancel</Button>
        <Button size="lg" variant="primary" loading={create.isPending} onClick={save}>Dispatch</Button>
      </>}
    >
      <div className="space-y-4">
        {serverError && <InlineNotice tone="risk" title="Not dispatched">{serverError.message}</InlineNotice>}
        <ErrorSummary errors={errors} />
        <Field label="Item" required error={errors.inventory_item_id} help={item ? `${formatNumber(item.current_stock_quantity, 2)} ${item.unit_of_measure || ''} on hand in total` : null} id="item">
          <Select size="lg" value={form.inventory_item_id} onChange={(e) => set('inventory_item_id', e.target.value)}>
            <option value="">Choose an item…</option>
            {items.map((i) => <option key={i.id} value={i.id}>{i.item_name || i.name || i.item_code}{i.current_stock_quantity != null ? ` — ${formatNumber(i.current_stock_quantity, 2)} on hand` : ''}</option>)}
          </Select>
        </Field>
        <Field label="Quantity" required error={errors.quantity} id="quantity">
          <Input size="lg" type="number" inputMode="decimal" step="0.0001" min="0" value={form.quantity} onChange={(e) => set('quantity', e.target.value)} suffix={item?.unit_of_measure} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="From" required error={errors.source_storage_location_id} id="from">
            <Select size="lg" value={form.source_storage_location_id} onChange={(e) => set('source_storage_location_id', e.target.value)}>
              <option value="">Choose…</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name || l.code}</option>)}
            </Select>
          </Field>
          <Field label="To" required error={errors.destination_storage_location_id} id="to">
            <Select size="lg" value={form.destination_storage_location_id} onChange={(e) => set('destination_storage_location_id', e.target.value)}>
              <option value="">Choose…</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name || l.code}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Notes" optional id="notes">
          <Input size="lg" value={form.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Carrier, seal number, reason…" />
        </Field>
      </div>
    </Dialog>
  )
}

/**
 * Inventory transfers — stock moving between locations. In-transit stock has
 * left its source and arrived nowhere yet, which is why it gets its own list.
 */
export default function InventoryTransfers() {
  const [status, setStatus] = useState('IN_TRANSIT')
  const [creating, setCreating] = useState(false)
  const [confirm, setConfirm] = useState(null) // { kind, t }
  const [picked, setPicked] = useState(null)
  const params = status ? { status } : {}
  const { data, loading, error, refetch } = useResource(['inventory-transfers', params], () => inventoryTransfersAPI.list(params))
  const { data: allData } = useResource(['inventory-transfers', { status: 'IN_TRANSIT' }], () => inventoryTransfersAPI.list({ status: 'IN_TRANSIT' }))
  const transfers = useMemo(() => asList(data), [data])
  const inTransit = asList(allData).length

  const invalidates = [['inventory-transfers'], ['inventory-items']]
  const receive = useResourceMutation((id) => inventoryTransfersAPI.receive(id), { invalidates, silent: true })
  const cancel = useResourceMutation((id) => inventoryTransfersAPI.cancel(id), { invalidates, silent: true })

  const act = async () => {
    const { kind, t } = confirm
    try {
      await (kind === 'receive' ? receive : cancel).mutateAsync(t.id)
      notify.success(kind === 'receive' ? `${t.transfer_number} received` : `${t.transfer_number} cancelled — stock returned to ${t.source_name || 'the source'}`)
    } catch (e) {
      notify.error(`${t.transfer_number} was not ${kind === 'receive' ? 'received' : 'cancelled'}: ${e?.response?.data?.error || e.message}`)
    }
    setConfirm(null)
  }

  const columns = useMemo(() => [
    { id: 'no', header: 'Transfer', accessor: 'transfer_number', width: 150, mobile: 'title', cell: (t) => <Code>{t.transfer_number}</Code> },
    { id: 'item', header: 'Item', accessor: 'item_name', minWidth: 180, mobile: 'subtitle', cell: (t) => <span className="block min-w-0"><span className="block truncate">{t.item_name || '—'}</span>{t.item_code && <span className="block truncate font-mono text-2xs text-ink-500">{t.item_code}</span>}</span> },
    { id: 'qty', header: 'Quantity', accessor: (t) => Number(t.quantity), align: 'right', width: 120, mobile: 'trailing', cell: (t) => <Num value={t.quantity} digits={Number(t.quantity) % 1 ? 2 : 0} unit={t.unit_of_measure} /> },
    { id: 'route', header: 'Route', accessor: (t) => `${t.source_name || ''} → ${t.destination_name || ''}`, minWidth: 240, cell: route },
    { id: 'sent', header: 'Dispatched', accessor: 'dispatched_at', width: 170, cell: (t) => <span className="block"><DateText value={t.dispatched_at} withTime />{t.dispatched_by_name && <span className="block text-2xs text-ink-500">{t.dispatched_by_name}</span>}</span> },
    { id: 'status', header: 'Status', accessor: 'status', width: 150, mobile: 'meta', cell: (t) => <StatusBadge status={t.status} /> },
    { id: 'received', header: 'Received', accessor: 'received_at', width: 150, defaultHidden: true, cell: (t) => <DateText value={t.received_at} withTime /> },
  ], [])

  return (
    <>
      <PageHeader
        title="Transfers"
        description="Stock moving between locations. It leaves the source when dispatched and lands when received."
        status={inTransit ? <Badge tone="brand" glyph="half">{inTransit} in transit</Badge> : null}
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setCreating(true)}>New transfer</Button>}
      />

      <DataTable
        viewKey="warehouse.transfers"
        caption="Inventory transfers"
        noun="transfer"
        rows={transfers}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        defaultSort={{ id: 'sent', dir: 'desc' }}
        searchPlaceholder="Search transfer, item, location"
        toolbarStart={<Segmented label="Show" value={status} onChange={setStatus} options={Object.entries(QUICK).map(([value, label]) => ({ value, label }))} />}
        rowActions={(t) => (t.status === 'IN_TRANSIT' ? (
          <>
            <RowAction icon={CheckIcon} label={`Receive ${t.transfer_number}`} onClick={() => setConfirm({ kind: 'receive', t })} />
            <RowAction icon={XMarkIcon} tone="risk" label={`Cancel ${t.transfer_number}`} onClick={() => setConfirm({ kind: 'cancel', t })} />
          </>
        ) : null)}
        onRowClick={(t) => setPicked(t)}
        empty={{
          icon: TruckIcon,
          title: status === 'IN_TRANSIT' ? 'Nothing in transit' : 'No transfers here',
          description: 'Dispatching a transfer removes the stock from its source and holds it in transit until it is received at the destination.',
          action: <Button variant="primary" icon={PlusIcon} onClick={() => setCreating(true)}>New transfer</Button>,
        }}
      />

      <NewTransferDialog open={creating} onClose={() => setCreating(false)} />

      {picked && (
        <Dialog
          open
          onClose={() => setPicked(null)}
          title={picked.transfer_number}
          description={picked.item_name}
          footer={picked.status === 'IN_TRANSIT' ? <>
            <Button size="lg" variant="destructive" icon={XMarkIcon} onClick={() => { setConfirm({ kind: 'cancel', t: picked }); setPicked(null) }}>Cancel transfer</Button>
            <Button size="lg" variant="primary" icon={CheckIcon} onClick={() => { setConfirm({ kind: 'receive', t: picked }); setPicked(null) }}>Receive</Button>
          </> : <Button size="lg" onClick={() => setPicked(null)}>Close</Button>}
        >
          <DescriptionList
            items={[
              { label: 'Status', value: <StatusBadge status={picked.status} /> },
              { label: 'Quantity', value: <Num value={picked.quantity} digits={Number(picked.quantity) % 1 ? 2 : 0} unit={picked.unit_of_measure} /> },
              { label: 'Route', value: route(picked), wide: true },
              { label: 'Dispatched', value: <DateText value={picked.dispatched_at} withTime /> },
              { label: 'Dispatched by', value: picked.dispatched_by_name },
              { label: 'Received', value: <DateText value={picked.received_at} withTime /> },
              { label: 'Notes', value: picked.notes, wide: true },
            ]}
          />
        </Dialog>
      )}

      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={act}
          tone={confirm.kind === 'receive' ? 'primary' : 'danger'}
          title={confirm.kind === 'receive' ? `Receive ${confirm.t.transfer_number}?` : `Cancel ${confirm.t.transfer_number}?`}
          consequence={confirm.kind === 'receive'
            ? `Confirms ${formatNumber(confirm.t.quantity, 2)} ${confirm.t.unit_of_measure || ''} of ${confirm.t.item_name || 'this item'} arrived at ${confirm.t.destination_name || 'the destination'}, and books it into stock there.`
            : `The stock returns to ${confirm.t.source_name || 'the source'}. The transfer stays on record as cancelled.`}
          confirmLabel={confirm.kind === 'receive' ? 'Confirm received' : 'Cancel transfer'}
          busy={receive.isPending || cancel.isPending}
        />
      )}
    </>
  )
}
