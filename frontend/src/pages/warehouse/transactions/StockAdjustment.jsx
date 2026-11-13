import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PlusIcon } from '@heroicons/react/20/solid'
import api from '../../../services/api'
import { useResource, useResourceMutation } from '../../../hooks/useResource'
import { keys } from '../../../services/queryKeys'
import { useAuth } from '../../../contexts/AuthContext'
import {
  PageHeader, Button, Field, Input, Select, Textarea, Combobox, Num, Money, Variance, InlineNotice, ErrorSummary, FormSection,
  MaturityBadge, describeError, formatMoney, notify,
} from '../../../components/ui'
import { ModeChooser } from '../WarehouseParts'
import { asList, formatBinCode, today } from '../warehouseData'
import { TxSection, LineCard, TxFooter, BIG_COMBO } from './TxParts'

/**
 * Stock adjustment (SA) — correct stock after a count, damage, loss or a find.
 * Enter what is physically there; the difference is the adjustment. Above
 * the value threshold the adjustment waits for a manager instead of posting.
 */
const THRESHOLD = 1000
const TYPES = [
  { value: 'PHYSICAL_COUNT', label: 'Physical count', description: 'Cycle count or stocktake.' },
  { value: 'DAMAGE', label: 'Damage', description: 'Damaged goods written off.' },
  { value: 'LOSS', label: 'Loss', description: 'Lost or stolen.' },
  { value: 'FOUND', label: 'Found stock', description: 'Stock that was not recorded.' },
  { value: 'CORRECTION', label: 'Correction', description: 'A system or data error.' },
]
const REASONS = [
  ['PHYSICAL_COUNT', 'Physical count variance'], ['DAMAGE', 'Damage'], ['LOSS', 'Loss or theft'], ['EXPIRY', 'Expiry'], ['FOUND', 'Found stock'],
  ['SYSTEM_ERROR', 'System error'], ['TRANSFER_ERROR', 'Transfer error'], ['WRITE_OFF', 'Write-off'], ['OTHER', 'Other'],
]
const BLANK_PICK = { inventory_item_id: '', item_name: '', current_quantity: 0, physical_quantity: '', adjustment_quantity: 0, adjustment_type: 'INCREASE', unit_of_measure: '', storage_location: '', bin_location: '', reason_code: 'PHYSICAL_COUNT', unit_cost: 0 }

// The list endpoint answers with flat fields (item_name, current_stock_quantity, unit_price).
// The old screen read nested ones (item.name, quantity, unit_cost), so every item showed as
// "Unknown Item" with zero on hand; both shapes are read here.
const nameOf = (it) => it.item_name || it.item?.name || 'Unknown item'
const qtyOf = (it) => Number(it.current_stock_quantity ?? it.quantity ?? 0)
const costOf = (it) => Number(it.unit_price ?? it.unit_cost ?? 0)

export default function StockAdjustment() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [form, setForm] = useState(() => ({ transaction_type: 'SA', adjustment_type: 'PHYSICAL_COUNT', items: [], notes: '', adjusted_by: user?.id || '', adjustment_date: today(), requires_approval: false }))
  const [pick, setPick] = useState(BLANK_PICK)
  const [pickTried, setPickTried] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState(null)
  const [fill, setFill] = useState({ bin_code: '', inventory_item_id: '', quantity: 10 })
  const [fillError, setFillError] = useState(null)

  const { data: rawItems } = useResource(keys.inventoryItems({ status: 'ACTIVE' }), ({ signal }) => api.get('/inventory-items', { params: { status: 'ACTIVE' }, signal }))
  const inventoryItems = useMemo(() => asList(rawItems), [rawItems])
  const { data: rawBins } = useResource(keys.allBins({ status: 'ACTIVE' }), ({ signal }) => api.get('/bins', { params: { status: 'ACTIVE' }, signal }))
  const bins = asList(rawBins)

  const withValue = (items) => {
    const total = items.reduce((s, it) => s + (it.adjustment_value || 0), 0)
    return { items, requires_approval: total > THRESHOLD }
  }

  const choosePick = (id) => {
    const it = inventoryItems.find((x) => x.id === id)
    if (!it) return setPick(BLANK_PICK)
    return setPick((p) => ({
      ...p, inventory_item_id: id, item_name: nameOf(it), current_quantity: qtyOf(it), physical_quantity: qtyOf(it), adjustment_quantity: 0,
      unit_of_measure: it.unit_of_measure || it.item?.unit_of_measure || 'PCS', storage_location: it.storage_location_name || it.storage_location?.name || '', bin_location: it.bin_code || it.bin?.code || '', unit_cost: costOf(it),
    }))
  }
  const setPhysical = (v) => {
    const physical = parseFloat(v)
    const adj = (Number.isFinite(physical) ? physical : 0) - pick.current_quantity
    setPick((p) => ({ ...p, physical_quantity: v === '' ? '' : physical, adjustment_quantity: adj, adjustment_type: adj >= 0 ? 'INCREASE' : 'DECREASE' }))
  }
  const pickErrors = {}
  if (!pick.inventory_item_id) pickErrors.item = 'Choose an item.'
  if (pick.physical_quantity === '' || !Number.isFinite(Number(pick.physical_quantity))) pickErrors.qty = 'Enter the quantity physically there.'
  else if (pick.adjustment_quantity === 0) pickErrors.qty = 'This matches the system — there is nothing to adjust.'
  const addPick = () => {
    setPickTried(true)
    if (Object.keys(pickErrors).length) return
    const line = { ...pick, id: Date.now(), adjustment_value: Math.abs(pick.adjustment_quantity * pick.unit_cost) }
    setForm((f) => ({ ...f, ...withValue([...f.items, line]) }))
    setPick(BLANK_PICK)
    setPickTried(false)
  }
  const updateLine = (i, patch) => setForm((f) => {
    const items = f.items.map((it, j) => {
      if (j !== i) return it
      const next = { ...it, ...patch }
      if ('physical_quantity' in patch) {
        const adj = parseFloat(patch.physical_quantity) - it.current_quantity
        Object.assign(next, { adjustment_quantity: adj, adjustment_type: adj >= 0 ? 'INCREASE' : 'DECREASE', adjustment_value: Math.abs(adj * it.unit_cost) })
      }
      return next
    })
    return { ...f, ...withValue(items) }
  })
  const removeLine = (i) => setForm((f) => ({ ...f, ...withValue(f.items.filter((_, j) => j !== i)) }))

  const totalValue = form.items.reduce((s, it) => s + (it.adjustment_value || 0), 0)
  const lineErrors = form.items.map((it) => (!it.adjustment_quantity || !Number.isFinite(it.adjustment_quantity) ? 'No difference to adjust — remove the line or change the count.' : null))
  const blocking = !form.items.length ? 'Add at least one item to adjust.' : null

  const post = useResourceMutation((payload) => api.post('/warehouse/transactions', payload), { invalidates: [['warehouse-transactions'], ['inventory-items']], silent: true })
  const submit = async (e) => {
    e.preventDefault()
    setSubmitted(true)
    setServerError(null)
    if (blocking || lineErrors.some(Boolean)) return
    try {
      await post.mutateAsync(form)
      notify.success(form.requires_approval ? 'Stock adjustment submitted for approval' : 'Stock adjustment posted')
      navigate('/warehouse/transactions')
    } catch (err) {
      setServerError(describeError(err))
    }
  }

  // Quick bin fill: maps an item to a bin and raises its stock directly — no transaction, no ledger entry.
  const quickFill = useResourceMutation(async () => {
    const bin = bins.find((b) => b.code === fill.bin_code)
    const item = inventoryItems.find((x) => x.id === fill.inventory_item_id)
    const qty = parseInt(fill.quantity, 10)
    await api.post(`/inventory-items/${fill.inventory_item_id}/storage-mapping`, { storage_location_id: bin.storage_location_id, bin_id: bin.id, quantity_in_location: qty })
    await api.put(`/inventory-items/${fill.inventory_item_id}`, { current_stock_quantity: qtyOf(item) + qty })
    return { quantity: qty, item_name: nameOf(item), bin_code: bin.code }
  }, { invalidates: [['inventory-items'], ['bins']], silent: true })
  const runFill = async () => {
    setFillError(null)
    if (!fill.bin_code || !fill.inventory_item_id || !(parseInt(fill.quantity, 10) > 0)) return setFillError('Enter a bin code, an item and a quantity.')
    if (!bins.find((b) => b.code === fill.bin_code)) return setFillError(`No active bin has the code ${fill.bin_code}.`)
    try {
      const r = await quickFill.mutateAsync()
      notify.success(`Added ${r.quantity} ${r.item_name} to bin ${formatBinCode(r.bin_code)}`)
      setFill({ bin_code: '', inventory_item_id: '', quantity: 10 })
    } catch (err) {
      setFillError(describeError(err).message)
    }
    return undefined
  }

  const itemOptions = inventoryItems.map((it) => ({ value: it.id, label: nameOf(it), meta: it.approved_item_code || it.item_code, description: `${qtyOf(it)} ${it.unit_of_measure || ''} on record` }))
  const summaryErrors = submitted ? [blocking && { id: 'sa-lines', message: blocking }, ...lineErrors.map((m, i) => m && { id: `sa-line-${i}`, message: `Line ${i + 1}: ${m.toLowerCase()}` })].filter(Boolean) : []

  return (
    <form onSubmit={submit} noValidate className="mx-auto max-w-4xl space-y-4">
      <PageHeader title="Stock adjustment" description="Correct recorded stock to what is physically there." />

      <ModeChooser label="Adjustment type" value={form.adjustment_type} onChange={(v) => setForm((f) => ({ ...f, adjustment_type: v }))} columns={5} options={TYPES} />

      {serverError && <InlineNotice tone="risk" title="The adjustment was not posted">{serverError.message} Your entries are still here.</InlineNotice>}
      <ErrorSummary errors={summaryErrors} />
      {form.requires_approval && (
        <InlineNotice tone="warn" title="This adjustment needs a manager's approval">
          The total value, {formatMoney(totalValue)}, is over the {formatMoney(THRESHOLD, 'USD', 0)} limit. It is recorded now and changes stock once approved.
        </InlineNotice>
      )}

      <TxSection title="Count an item">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Item" required error={pickTried ? pickErrors.item : null} className="sm:col-span-2" help={pick.inventory_item_id ? <>On record <Num value={pick.current_quantity} unit={pick.unit_of_measure} />{pick.bin_location && ` · bin ${pick.bin_location}`}</> : 'Type a name or code, or scan it.'} id="sa-select-item">
            <Combobox className={BIG_COMBO} value={pick.inventory_item_id} onChange={choosePick} options={itemOptions} placeholder="Search items" emptyText="No item matches" />
          </Field>
          <Field label="Physically there" required error={pickTried ? pickErrors.qty : null} id="sa-physical-qty">
            <Input size="lg" type="number" min="0" step="0.01" numeric suffix={pick.unit_of_measure} value={pick.physical_quantity} onChange={(e) => setPhysical(e.target.value)} disabled={!pick.inventory_item_id} />
          </Field>
          <Field label="Difference" id="sa-difference">
            <p className="flex h-10 items-center gap-3 text-base tabular-nums">
              {pick.inventory_item_id ? <><Variance value={pick.adjustment_quantity} format="number" digits={pick.adjustment_quantity % 1 ? 2 : 0} goodWhen="up" /><span className="text-sm text-ink-500">{pick.unit_cost ? formatMoney(Math.abs(pick.adjustment_quantity * pick.unit_cost)) : 'no unit price'}</span></> : <span className="text-ink-400">—</span>}
            </p>
          </Field>
          <Field label="Reason" id="sa-reason-code">
            <Select size="lg" value={pick.reason_code} onChange={(e) => setPick((p) => ({ ...p, reason_code: e.target.value }))}>
              {REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          <div className="flex items-end"><Button size="lg" block icon={PlusIcon} onClick={addPick}>Add to adjustment</Button></div>
        </div>
      </TxSection>

      {form.items.length > 0 && (
        <TxSection title={`Lines (${form.items.length})`} description={<>Value impact <Money amount={totalValue} /></>}>
          <ul className="space-y-3" id="sa-lines">
            {form.items.map((it, i) => (
              <LineCard
                key={it.id || i}
                title={it.item_name}
                subtitle={<>On record <Num value={it.current_quantity} unit={it.unit_of_measure} /> · difference <Variance value={it.adjustment_quantity} format="number" digits={it.adjustment_quantity % 1 ? 2 : 0} /> · <Money amount={it.adjustment_value} /></>}
                onRemove={() => removeLine(i)}
                error={submitted ? lineErrors[i] : null}
              >
                <Field label="Physically there" id={`sa-line-${i}`}>
                  <Input size="lg" type="number" min="0" step="0.01" numeric suffix={it.unit_of_measure} value={it.physical_quantity} onChange={(e) => updateLine(i, { physical_quantity: e.target.value })} />
                </Field>
                <Field label="Reason" id={`sa-line-${i}-reason`}>
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
        <Field label="Notes" optional id="sa-notes">
          <Textarea rows={2} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Count sheet, who counted, what happened…" />
        </Field>
      </TxSection>

      <FormSection title={<>Quick bin fill <MaturityBadge level="preview" className="ml-1 align-middle" /></>} description="Put stock straight into a bin — setup and testing only" advanced columns={1}>
        <InlineNotice tone="warn" title="Bypasses the stock ledger">This assigns the item to the bin and raises its stock directly. No transaction or accounting entry is recorded. Use goods receipt for real stock.</InlineNotice>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Bin code" id="sa-bin-code">
            <Input size="lg" className="font-mono" value={fill.bin_code} onChange={(e) => setFill((f) => ({ ...f, bin_code: e.target.value.replace(/\D/g, '').slice(0, 8) }))} placeholder="WWRRSSBB" inputMode="numeric" />
          </Field>
          <Field label="Item" id="sa-inventory-item">
            <Combobox className={BIG_COMBO} value={fill.inventory_item_id} onChange={(v) => setFill((f) => ({ ...f, inventory_item_id: v }))} options={itemOptions} placeholder="Search items" />
          </Field>
          <Field label="Quantity" id="sa-quantity">
            <Input size="lg" type="number" min="1" numeric value={fill.quantity} onChange={(e) => setFill((f) => ({ ...f, quantity: e.target.value }))} />
          </Field>
        </div>
        {fillError && <p className="text-xs text-risk-600" role="alert">{fillError}</p>}
        <div><Button onClick={runFill} loading={quickFill.isPending}>Fill bin</Button></div>
      </FormSection>

      <TxFooter
        summary={form.items.length ? <>{form.items.length} line{form.items.length === 1 ? '' : 's'} · value impact <Money amount={totalValue} className="font-semibold" /></> : 'Nothing to adjust yet'}
        blocker={blocking}
        submitLabel={form.requires_approval ? 'Submit for approval' : 'Post adjustment'}
        loading={post.isPending}
        onCancel={() => navigate('/warehouse/transactions')}
      />
    </form>
  )
}
