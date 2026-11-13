import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PlusIcon, ArrowRightIcon } from '@heroicons/react/20/solid'
import api from '../../../services/api'
import { useResource, useResourceMutation } from '../../../hooks/useResource'
import { keys } from '../../../services/queryKeys'
import { useAuth } from '../../../contexts/AuthContext'
import {
  PageHeader, Button, Field, Input, Select, Textarea, Combobox, Num, InlineNotice, ErrorSummary, MaturityBadge, describeError, notify,
} from '../../../components/ui'
import { ModeChooser } from '../WarehouseParts'
import { asList, today } from '../warehouseData'
import { TxSection, LineCard, LocationBin, TxFooter, BIG_COMBO } from './TxParts'

/**
 * Goods transfer (GT) — move stock between bins in one warehouse, or between
 * warehouses. Pick the item, say from where and to where, add it; repeat.
 */
const REASONS = [['REORGANIZATION', 'Reorganisation'], ['SPACE_OPTIMIZATION', 'Space optimisation'], ['MAINTENANCE', 'Maintenance'], ['CONSOLIDATION', 'Consolidation'], ['RELOCATION', 'Relocation'], ['OTHER', 'Other']]
const BLANK_PICK = { inventory_item_id: '', item_name: '', available_quantity: 0, transfer_quantity: '', unit_of_measure: '', source_storage_location_id: '', source_bin_id: '', destination_storage_location_id: '', destination_bin_id: '', reason_code: 'REORGANIZATION' }

export default function GoodsTransfer() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [form, setForm] = useState(() => ({ transaction_type: 'GT', transfer_type: 'intra-warehouse', items: [], notes: '', transferred_by: user?.id || '', transfer_date: today() }))
  const [pick, setPick] = useState(BLANK_PICK)
  const [pickTried, setPickTried] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState(null)

  const { data: rawItems } = useResource(keys.inventoryItems({ status: 'APPROVED' }), ({ signal }) => api.get('/inventory-items', { params: { status: 'APPROVED' }, signal }))
  const inventoryItems = useMemo(() => asList(rawItems), [rawItems])
  const { data: rawLocations } = useResource(keys.storageLocations({ is_active: true }), ({ signal }) => api.get('/storage-locations', { params: { is_active: true }, signal }))
  const locations = asList(rawLocations)
  const locName = (id) => { const l = locations.find((x) => x.id === id); return l ? `${l.code} — ${l.name}` : 'Unknown location' }

  const choosePick = (id) => {
    const it = inventoryItems.find((x) => x.id === id)
    if (!it) return setPick(BLANK_PICK)
    return setPick((p) => ({ ...p, inventory_item_id: id, item_name: it.item_name || it.name || 'Unknown item', available_quantity: parseFloat(it.current_stock_quantity || 0), unit_of_measure: it.unit_of_measure || 'PCS', source_storage_location_id: '', source_bin_id: '' }))
  }
  const pickErrors = {}
  if (!pick.inventory_item_id) pickErrors.item = 'Choose an item.'
  const q = parseFloat(pick.transfer_quantity)
  if (!(q > 0)) pickErrors.qty = 'Enter a quantity above zero.'
  else if (q > pick.available_quantity) pickErrors.qty = `Only ${pick.available_quantity} available.`
  if (!pick.source_storage_location_id) pickErrors.from = 'Choose where it is now.'
  if (!pick.destination_storage_location_id) pickErrors.to = 'Choose where it goes.'
  else if (pick.source_storage_location_id === pick.destination_storage_location_id && pick.source_bin_id === pick.destination_bin_id) pickErrors.to = 'From and to are the same place. Choose a different bin or location.'

  const addPick = () => {
    setPickTried(true)
    if (Object.keys(pickErrors).length) return
    setForm((f) => ({ ...f, items: [...f.items, { ...pick, id: Date.now(), transfer_quantity: q }] }))
    setPick(BLANK_PICK)
    setPickTried(false)
  }
  const updateLine = (i, patch) => setForm((f) => ({ ...f, items: f.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) }))
  const removeLine = (i) => setForm((f) => ({ ...f, items: f.items.filter((_, j) => j !== i) }))

  const post = useResourceMutation((payload) => api.post('/warehouse/transactions', payload), { invalidates: [['warehouse-transactions'], ['inventory-items']], silent: true })
  const lineErrors = form.items.map((it) => (!(parseFloat(it.transfer_quantity) > 0) ? 'Enter a quantity above zero.' : !it.source_storage_location_id || !it.destination_storage_location_id ? 'From and to are both needed.' : null))
  const blocking = !form.items.length ? 'Add at least one item to move.' : null

  const submit = async (e) => {
    e.preventDefault()
    setSubmitted(true)
    setServerError(null)
    if (blocking || lineErrors.some(Boolean)) return
    try {
      await post.mutateAsync({
        ...form,
        created_by: user?.id,
        processed_by: user?.id,
        items: form.items.map((it) => ({
          ...it,
          source_storage_location_id: it.source_storage_location_id,
          source_bin_id: it.source_bin_id,
          destination_storage_location_id: it.destination_storage_location_id,
          destination_bin_id: it.destination_bin_id,
          quantity: it.transfer_quantity,
          unit_of_measure: it.unit_of_measure,
          condition: 'GOOD',
          reason_code: it.reason_code,
        })),
      })
      notify.success(`Transfer of ${form.items.length} line${form.items.length === 1 ? '' : 's'} posted`)
      navigate('/warehouse/transactions')
    } catch (err) {
      setServerError(describeError(err))
    }
  }

  const totalQty = form.items.reduce((s, it) => s + (parseFloat(it.transfer_quantity) || 0), 0)
  const summaryErrors = submitted ? [blocking && { id: 'gt-lines', message: blocking }, ...lineErrors.map((m, i) => m && { id: `gt-line-${i}`, message: `Line ${i + 1}: ${m.toLowerCase()}` })].filter(Boolean) : []

  return (
    <form onSubmit={submit} noValidate className="mx-auto max-w-4xl space-y-4">
      <PageHeader title="Goods transfer" description="Move stock between bins, or between warehouses." />

      <ModeChooser
        label="Transfer type"
        value={form.transfer_type}
        onChange={(v) => setForm((f) => ({ ...f, transfer_type: v }))}
        columns={2}
        options={[
          { value: 'intra-warehouse', label: 'Within a warehouse', description: 'Bin to bin in the same location.' },
          { value: 'inter-warehouse', label: 'Between warehouses', description: 'From one storage location to another.', badge: <MaturityBadge level="beta" /> },
        ]}
      />

      {serverError && <InlineNotice tone="risk" title="The transfer was not posted">{serverError.message} Your entries are still here.</InlineNotice>}
      <ErrorSummary errors={summaryErrors} />

      <TxSection title="Add an item">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Item" required error={pickTried ? pickErrors.item : null} help={pick.inventory_item_id ? <>Available <Num value={pick.available_quantity} unit={pick.unit_of_measure} /></> : 'Type a name or code, or scan it.'} id="gt-select-item">
            <Combobox className={BIG_COMBO} value={pick.inventory_item_id} onChange={choosePick} options={inventoryItems.map((it) => ({ value: it.id, label: it.item_name || it.name, meta: it.approved_item_code || it.item_code, description: `${Number(it.current_stock_quantity || 0)} ${it.unit_of_measure || ''} available` }))} placeholder="Search items" emptyText="No item matches" />
          </Field>
          <Field label="Quantity" required error={pickTried ? pickErrors.qty : null} id="gt-transfer-qty">
            <Input size="lg" type="number" min="0" step="0.01" numeric suffix={pick.unit_of_measure} value={pick.transfer_quantity} onChange={(e) => setPick((p) => ({ ...p, transfer_quantity: e.target.value }))} />
          </Field>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_auto_1fr]">
          <fieldset className="grid grid-cols-1 gap-3 rounded-md border border-ink-200 p-3 sm:grid-cols-2 lg:grid-cols-1">
            <legend className="label-mono px-1">From</legend>
            <LocationBin idPrefix="gt-source" locations={locations} locationId={pick.source_storage_location_id} binId={pick.source_bin_id} required error={pickTried ? pickErrors.from : null} onChange={({ location, bin }) => setPick((p) => ({ ...p, source_storage_location_id: location, source_bin_id: bin }))} />
          </fieldset>
          <ArrowRightIcon className="hidden h-5 w-5 self-center text-ink-400 lg:block" aria-hidden="true" />
          <fieldset className="grid grid-cols-1 gap-3 rounded-md border border-ink-200 p-3 sm:grid-cols-2 lg:grid-cols-1">
            <legend className="label-mono px-1">To</legend>
            <LocationBin idPrefix="gt-destination" locations={locations} locationId={pick.destination_storage_location_id} binId={pick.destination_bin_id} required error={pickTried ? pickErrors.to : null} onChange={({ location, bin }) => setPick((p) => ({ ...p, destination_storage_location_id: location, destination_bin_id: bin }))} />
          </fieldset>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Reason" id="gt-reason">
            <Select size="lg" value={pick.reason_code} onChange={(e) => setPick((p) => ({ ...p, reason_code: e.target.value }))}>
              {REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          <div className="flex items-end"><Button size="lg" block icon={PlusIcon} onClick={addPick}>Add transfer line</Button></div>
        </div>
      </TxSection>

      {form.items.length > 0 && (
        <TxSection title={`Lines to move (${form.items.length})`}>
          <ul className="space-y-3" id="gt-lines">
            {form.items.map((it, i) => (
              <LineCard
                key={it.id || i}
                title={it.item_name}
                subtitle={<>{locName(it.source_storage_location_id)} → {locName(it.destination_storage_location_id)}</>}
                onRemove={() => removeLine(i)}
                error={submitted ? lineErrors[i] : null}
              >
                <Field label="Move" required id={`gt-line-${i}`}>
                  <Input size="lg" type="number" min="0" step="0.01" numeric suffix={it.unit_of_measure} value={it.transfer_quantity} onChange={(e) => updateLine(i, { transfer_quantity: e.target.value })} />
                </Field>
                <Field label="Reason" id={`gt-line-${i}-reason`}>
                  <Select size="lg" value={it.reason_code} onChange={(e) => updateLine(i, { reason_code: e.target.value })}>
                    {REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </Select>
                </Field>
              </LineCard>
            ))}
          </ul>
        </TxSection>
      )}

      <TxSection title="Notes">
        <Field label="Notes" optional id="gt-notes">
          <Textarea rows={2} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Why it moved, who moved it…" />
        </Field>
      </TxSection>

      <TxFooter
        summary={form.items.length ? <><Num value={totalQty} className="font-semibold text-fg" /> units on {form.items.length} line{form.items.length === 1 ? '' : 's'}</> : 'Nothing to move yet'}
        blocker={blocking}
        submitLabel="Post goods transfer"
        loading={post.isPending}
        onCancel={() => navigate('/warehouse/transactions')}
      />
    </form>
  )
}
