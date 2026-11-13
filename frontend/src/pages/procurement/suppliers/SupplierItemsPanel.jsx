import { useMemo, useState } from 'react'
import { PlusIcon, PencilSquareIcon, TrashIcon, CubeIcon } from '@heroicons/react/20/solid'
import api from '../../../services/api'
import { useResource, useResourceMutation } from '../../../hooks/useResource'
import { keys } from '../../../services/queryKeys'
import {
  Button, DataTable, RowAction, Badge, StatusBadge, Money, Num, Code, DateText, Dialog, ConfirmDialog, Field, Input,
  Select, Textarea, Checkbox, Combobox, Segmented, InlineNotice, notify,
} from '../../../components/ui'

/**
 * The items a supplier supplies, with their terms. Replaces the old
 * SupplierItemsManager modal; same endpoints (/supplier-items/*), same
 * payloads.
 */
const CURRENCIES = ['USD', 'EUR', 'GBP', 'AZN']
const BLANK = { item_id: '', unit_price: '', currency: 'USD', minimum_order_quantity: 1, lead_time_days: '', is_preferred: false, notes: '' }
const toPayload = (f) => ({
  ...f,
  unit_price: parseFloat(f.unit_price) || null,
  minimum_order_quantity: parseInt(f.minimum_order_quantity, 10) || 1,
  lead_time_days: parseInt(f.lead_time_days, 10) || null,
})

export default function SupplierItemsPanel({ supplier }) {
  const supplierId = supplier.id
  const [edit, setEdit] = useState(null) // { mode: 'add' | 'edit', row?, form }
  const [addMode, setAddMode] = useState('one')
  const [picked, setPicked] = useState([])
  const [formError, setFormError] = useState(null)
  const [removing, setRemoving] = useState(null)

  const itemsKey = keys.supplierItems(supplierId)
  const { data, loading, error, refetch } = useResource(itemsKey, ({ signal }) => api.get(`/supplier-items/by-supplier/${supplierId}`, { params: { status: 'ALL' }, signal }))
  const rows = useMemo(() => (Array.isArray(data) ? data : []), [data])

  const { data: invData } = useResource(keys.inventoryItems({ forSupplierPicker: true }), ({ signal }) => api.get('/inventory-items', { signal }), { enabled: edit?.mode === 'add' })
  const available = useMemo(() => {
    const all = Array.isArray(invData) ? invData : invData?.data || []
    const taken = new Set(rows.map((r) => r.item_id))
    return all.filter((i) => i.status === 'APPROVED' && !taken.has(i.id))
  }, [invData, rows])

  const opts = { invalidates: [itemsKey, ['suppliers'], ['supplier-items']], silent: true }
  const add = useResourceMutation((body) => api.post('/supplier-items', body), opts)
  const bulk = useResourceMutation((body) => api.post('/supplier-items/bulk', body), opts)
  const update = useResourceMutation(({ id, body }) => api.put(`/supplier-items/${id}`, body), opts)
  const remove = useResourceMutation((id) => api.delete(`/supplier-items/${id}`), opts)

  const setForm = (patch) => setEdit((e) => ({ ...e, form: { ...e.form, ...patch } }))
  const close = () => { setEdit(null); setPicked([]); setFormError(null); setAddMode('one') }

  const save = async () => {
    setFormError(null)
    try {
      if (edit.mode === 'edit') {
        const { item_id: _ignored, ...rest } = toPayload(edit.form)
        await update.mutateAsync({ id: edit.row.id, body: rest })
        notify.success(`${edit.row.item_name} updated`)
      } else if (addMode === 'many') {
        if (!picked.length) { setFormError('Tick at least one item.'); return }
        await bulk.mutateAsync({ supplier_id: supplierId, items: picked.map((item_id) => ({ item_id, currency: 'USD', minimum_order_quantity: 1 })) })
        notify.success(`${picked.length} item${picked.length === 1 ? '' : 's'} added to ${supplier.legal_name}`)
      } else {
        if (!edit.form.item_id) { setFormError('Choose the item this supplier supplies.'); return }
        await add.mutateAsync({ supplier_id: supplierId, ...toPayload(edit.form) })
        notify.success(`Item added to ${supplier.legal_name}`)
      }
      close()
    } catch (e) {
      const msg = e?.response?.data?.error || e?.response?.data?.message || e.message
      setFormError(/already exists/i.test(msg || '') ? 'This item is already assigned to this supplier. Choose a different one.' : msg)
    }
  }

  const columns = [
    {
      id: 'item', header: 'Item', accessor: (r) => `${r.item_name || ''} ${r.sku || ''}`, minWidth: 220, mobile: 'title',
      cell: (r) => (
        <span className="block min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="truncate">{r.item_name}</span>
            {r.is_preferred && <Badge tone="brand">Preferred</Badge>}
          </span>
          <span className="block truncate font-mono text-2xs text-ink-500">{r.sku}{r.category ? ` · ${r.category}` : ''}</span>
        </span>
      ),
    },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 210, mobile: 'meta', cell: (r) => <StatusBadge status={r.status === 'SUPPLIER_REJECTED' ? 'REJECTED' : r.status} label={r.status === 'ACTIVE' && r.supplier_confirmed ? 'Confirmed by supplier' : undefined} /> },
    { id: 'price', header: 'Unit price', accessor: (r) => (r.unit_price != null ? Number(r.unit_price) : null), align: 'right', width: 130, mobile: 'trailing', cell: (r) => <Money amount={r.unit_price} currency={r.currency || 'USD'} /> },
    { id: 'moq', header: 'Min. order', accessor: (r) => Number(r.minimum_order_quantity) || null, align: 'right', width: 110, cell: (r) => <Num value={r.minimum_order_quantity} unit={r.unit_of_measure} /> },
    { id: 'lead', header: 'Lead time', accessor: (r) => (r.lead_time_days != null ? Number(r.lead_time_days) : null), align: 'right', width: 100, cell: (r) => (r.lead_time_days != null ? <Num value={r.lead_time_days} unit="d" /> : <span className="text-ink-400">—</span>) },
    { id: 'response', header: 'Supplier response', accessor: (r) => r.supplier_confirmed_at || r.confirmation_requested_at, width: 150, defaultHidden: true, cell: (r) => <DateText value={r.supplier_confirmed_at || r.confirmation_requested_at} /> },
    { id: 'notes', header: 'Notes', accessor: (r) => r.supplier_rejection_reason || r.notes, minWidth: 180, defaultHidden: true },
  ]

  const busy = add.isPending || bulk.isPending || update.isPending
  const f = edit?.form

  return (
    <>
      <DataTable
        caption="Items supplied"
        noun="item"
        rows={rows}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        search={rows.length > 10}
        toolbar={<Button size="sm" icon={PlusIcon} onClick={() => setEdit({ mode: 'add', form: { ...BLANK } })}>Add items</Button>}
        onOpen={(r) => setEdit({ mode: 'edit', row: r, form: { item_id: r.item_id, unit_price: r.unit_price ?? '', currency: r.currency || 'USD', minimum_order_quantity: r.minimum_order_quantity || 1, lead_time_days: r.lead_time_days ?? '', is_preferred: !!r.is_preferred, notes: r.notes || '' } })}
        rowActions={(r) => (
          <>
            <RowAction icon={PencilSquareIcon} label={`Edit terms for ${r.item_name}`} onClick={() => setEdit({ mode: 'edit', row: r, form: { item_id: r.item_id, unit_price: r.unit_price ?? '', currency: r.currency || 'USD', minimum_order_quantity: r.minimum_order_quantity || 1, lead_time_days: r.lead_time_days ?? '', is_preferred: !!r.is_preferred, notes: r.notes || '' } })} />
            <RowAction icon={TrashIcon} tone="risk" label={`Remove ${r.item_name}`} onClick={() => setRemoving(r)} />
          </>
        )}
        empty={{
          icon: CubeIcon,
          title: 'No items assigned',
          description: 'Add the catalogue items this supplier can provide, with price and lead time. Requisitions and contracts use this list to suggest suppliers.',
          action: <Button variant="primary" icon={PlusIcon} onClick={() => setEdit({ mode: 'add', form: { ...BLANK } })}>Add items</Button>,
        }}
      />

      <Dialog
        open={Boolean(edit)}
        onClose={close}
        title={edit?.mode === 'edit' ? `Terms for ${edit.row.item_name}` : `Add items to ${supplier.legal_name}`}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={close} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={save} loading={busy}>
              {edit?.mode === 'edit' ? 'Save terms' : addMode === 'many' ? `Add ${picked.length || ''} item${picked.length === 1 ? '' : 's'}` : 'Add item'}
            </Button>
          </>
        }
      >
        {edit && (
          <div className="space-y-4">
            {edit.mode === 'add' && (
              <Segmented label="How" value={addMode} onChange={(v) => { setAddMode(v); setFormError(null) }} options={[{ value: 'one', label: 'One item with terms' }, { value: 'many', label: 'Several at default terms' }]} />
            )}
            {formError && <InlineNotice tone="risk">{formError}</InlineNotice>}
            {edit.mode === 'add' && addMode === 'many' ? (
              available.length === 0 ? (
                <p className="text-sm text-ink-600">Every approved item is already assigned to this supplier.</p>
              ) : (
                <fieldset className="max-h-72 overflow-y-auto rounded-md border border-ink-200">
                  <legend className="sr-only">Items to add</legend>
                  {available.map((i) => (
                    <Checkbox
                      key={i.id}
                      className="border-b border-ink-100 px-3 py-2 last:border-b-0"
                      checked={picked.includes(i.id)}
                      onChange={(e) => setPicked((p) => (e.target.checked ? [...p, i.id] : p.filter((x) => x !== i.id)))}
                      label={i.item_name}
                      description={`${i.approved_item_code || i.item_code || ''}${i.category ? ` · ${i.category}` : ''}`}
                    />
                  ))}
                </fieldset>
              )
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {edit.mode === 'add' && (
                  <Field label="Item" required className="sm:col-span-2" help="Approved inventory items not yet assigned to this supplier.">
                    <Combobox value={f.item_id} onChange={(v) => setForm({ item_id: v })} options={available.map((i) => ({ value: i.id, label: i.item_name, meta: i.approved_item_code || i.item_code }))} placeholder="Search items" emptyText="No unassigned approved items" />
                  </Field>
                )}
                <Field label="Unit price" optional>
                  <Input type="number" step="0.01" min="0" numeric value={f.unit_price} onChange={(e) => setForm({ unit_price: e.target.value })} />
                </Field>
                <Field label="Currency">
                  <Select value={f.currency} onChange={(e) => setForm({ currency: e.target.value })}>
                    {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </Select>
                </Field>
                <Field label="Minimum order quantity">
                  <Input type="number" min="1" numeric value={f.minimum_order_quantity} onChange={(e) => setForm({ minimum_order_quantity: e.target.value })} />
                </Field>
                <Field label="Lead time (days)" optional>
                  <Input type="number" min="0" numeric value={f.lead_time_days} onChange={(e) => setForm({ lead_time_days: e.target.value })} />
                </Field>
                <Checkbox className="sm:col-span-2" checked={f.is_preferred} onChange={(e) => setForm({ is_preferred: e.target.checked })} label="Preferred supplier for this item" />
                <Field label="Notes" optional className="sm:col-span-2">
                  <Textarea rows={2} value={f.notes} onChange={(e) => setForm({ notes: e.target.value })} />
                </Field>
                {edit.mode === 'edit' && edit.row.status === 'SUPPLIER_REJECTED' && edit.row.supplier_rejection_reason && (
                  <InlineNotice tone="risk" title="The supplier declined this item" className="sm:col-span-2">{edit.row.supplier_rejection_reason}</InlineNotice>
                )}
                {edit.mode === 'edit' && <p className="text-xs text-ink-500 sm:col-span-2">Item <Code>{edit.row.sku}</Code></p>}
              </div>
            )}
          </div>
        )}
      </Dialog>

      {removing && (
        <ConfirmDialog
          open
          onClose={() => setRemoving(null)}
          title={`Remove ${removing.item_name} from ${supplier.legal_name}?`}
          consequence="The supplier stops being suggested for this item on requisitions and contracts. Orders already placed are not affected."
          confirmLabel="Remove item"
          busy={remove.isPending}
          onConfirm={async () => {
            try {
              await remove.mutateAsync(removing.id)
              notify.success(`${removing.item_name} removed`)
            } catch (e) {
              notify.error(`Not removed: ${e?.response?.data?.error || e.message}`)
            }
            setRemoving(null)
          }}
        />
      )}
    </>
  )
}
