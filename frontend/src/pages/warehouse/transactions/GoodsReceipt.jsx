import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PlusIcon } from '@heroicons/react/20/solid'
import api from '../../../services/api'
import { useResource, useResourceMutation } from '../../../hooks/useResource'
import { keys } from '../../../services/queryKeys'
import { useAuth } from '../../../contexts/AuthContext'
import {
  PageHeader, Button, Field, Input, Select, Textarea, StatusBadge, Money, Num, DateText, InlineNotice, ErrorSummary,
  describeError, notify,
} from '../../../components/ui'
import { ModeChooser } from '../WarehouseParts'
import { asList, today } from '../warehouseData'
import { TxSection, DocPicker, LineCard, LocationBin, TxFooter } from './TxParts'

/**
 * Goods receipt (GR) — book goods into stock, against a purchase order or by
 * hand. Built for a phone or scanner: pick the PO from big rows (or type its
 * number), check the received quantity on each line, say where it went.
 *
 * A PO is receivable from the moment the supplier confirms it — not only after
 * a manager verifies delivery — and stays receivable through partial receipts.
 */
const RECEIVABLE_PO_STATUSES = ['CONFIRMED', 'PREPARING_DELIVERY', 'IN_TRANSIT', 'DELIVERED', 'GOODS_READY_FOR_RECEIPT', 'PARTIALLY_RECEIVED']
const BLANK_MANUAL = { item_name: '', description: '', quantity: '', unit_of_measure: 'PCS', storage_location_id: '', bin_id: '', batch_number: '', expiry_date: '', unit_cost: '' }

export default function GoodsReceipt() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [mode, setMode] = useState('po-linked')
  const [selectedPO, setSelectedPO] = useState(null)
  const [form, setForm] = useState(() => ({
    transaction_type: 'GR', reference_document: '', reference_type: 'PO', items: [], notes: '', received_by: user?.id || '', received_date: today(),
  }))
  const [manual, setManual] = useState(BLANK_MANUAL)
  const [manualTried, setManualTried] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState(null)

  const { data: allPOs, loading: posLoading } = useResource(keys.purchaseOrders(), ({ signal }) => api.get('/purchase-orders', { signal }))
  const purchaseOrders = useMemo(() => asList(allPOs).filter((po) => RECEIVABLE_PO_STATUSES.includes(po.status)), [allPOs])
  const { data: rawLocations } = useResource(keys.storageLocations({ is_active: true }), ({ signal }) => api.get('/storage-locations', { params: { is_active: true }, signal }))
  const locations = asList(rawLocations)

  // The chosen PO's detail and lines pre-fill the receipt.
  const { data: poDetail } = useResource(keys.purchaseOrder(selectedPO?.id), ({ signal }) => api.get(`/purchase-orders/${selectedPO.id}`, { signal }), { enabled: Boolean(selectedPO?.id) })
  const { data: poLines, loading: linesLoading } = useResource(keys.poLineItems(selectedPO?.id), ({ signal }) => api.get(`/purchase-orders/${selectedPO.id}/line-items`, { signal }), { enabled: Boolean(selectedPO?.id) })
  // Applied once per PO, so a background refetch never overwrites quantities being typed.
  const applied = useRef(null)
  useEffect(() => {
    if (!selectedPO?.id || !poDetail || poLines === undefined || applied.current === selectedPO.id) return
    applied.current = selectedPO.id
    const lines = asList(poLines)
    setForm((f) => ({
      ...f,
      reference_document: poDetail.po_number,
      items: lines.map((item) => ({
        ...item,
        item_name: item.item_name || item.item_description,
        name: item.item_name || item.item_description,
        received_quantity: item.quantity,
        storage_location_id: poDetail.storage_location_id || '',
        bin_id: '',
        batch_number: '',
        expiry_date: null,
        reason_code: 'PURCHASE_ORDER_RECEIPT',
        condition: 'GOOD',
        notes: '',
      })),
    }))
  }, [selectedPO?.id, poDetail, poLines])

  const changeMode = (m) => {
    setMode(m)
    setSelectedPO(null)
    setSubmitted(false)
    setForm((f) => ({ ...f, reference_type: m === 'manual' ? 'MANUAL' : 'PO', reference_document: '', items: [] }))
  }
  const pickPO = (po) => {
    applied.current = null
    setSelectedPO(po)
    setForm((f) => ({ ...f, reference_document: po.po_number, items: [] }))
  }
  const updateLine = (i, patch) => setForm((f) => ({ ...f, items: f.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) }))
  const removeLine = (i) => setForm((f) => ({ ...f, items: f.items.filter((_, j) => j !== i) }))
  const allTo = (locationId) => setForm((f) => ({ ...f, items: f.items.map((it) => ({ ...it, storage_location_id: locationId, bin_id: '' })) }))

  const manualErrors = {}
  if (!manual.item_name.trim()) manualErrors.item_name = 'Name the item.'
  if (!(parseFloat(manual.quantity) > 0)) manualErrors.quantity = 'Enter a quantity above zero.'
  if (!manual.storage_location_id) manualErrors.storage_location_id = 'Choose where it goes.'
  const addManual = () => {
    setManualTried(true)
    if (Object.keys(manualErrors).length) return
    setForm((f) => ({
      ...f,
      items: [...f.items, { ...manual, id: Date.now(), quantity: parseFloat(manual.quantity), received_quantity: parseFloat(manual.quantity), unit_cost: parseFloat(manual.unit_cost) || 0, reason_code: 'MANUAL_RECEIPT', condition: 'GOOD', expiry_date: manual.expiry_date || null }],
    }))
    setManual(BLANK_MANUAL)
    setManualTried(false)
  }

  const lineError = (it) => {
    if (!(parseFloat(it.received_quantity) > 0)) return 'Enter the quantity received.'
    if (!it.storage_location_id) return 'Choose the storage location it went into.'
    return null
  }
  const lineErrors = form.items.map(lineError)
  const blocking = !form.items.length ? (mode === 'manual' ? 'Add at least one item.' : selectedPO ? 'This PO has no lines to receive.' : 'Choose the purchase order first.') : null

  const post = useResourceMutation(
    async (payload) => {
      const response = await api.post('/warehouse/transactions', payload)
      // A PO-linked receipt closes the PO. A failure here must not fail the receipt itself.
      if (selectedPO && form.reference_type === 'PO') {
        try { await api.put(`/purchase-orders/${selectedPO.id}`, { status: 'COMPLETED' }) } catch { /* receipt already posted */ }
      }
      return response
    },
    { invalidates: [['warehouse-transactions'], ['inventory-items'], ['purchase-orders']], silent: true }
  )

  const submit = async (e) => {
    e.preventDefault()
    setSubmitted(true)
    setServerError(null)
    if (blocking || lineErrors.some(Boolean)) return
    try {
      await post.mutateAsync({
        ...form,
        items: form.items.map((item) => ({
          ...item,
          destination_storage_location_id: item.storage_location_id,
          destination_bin_id: item.bin_id,
          reason_code: item.reason_code || 'PURCHASE_ORDER_RECEIPT',
          condition: item.condition || 'GOOD',
          expiry_date: item.expiry_date || null,
        })),
      })
      notify.success(`Goods receipt posted${form.reference_document ? ` for ${form.reference_document}` : ''}`)
      navigate('/warehouse/transactions')
    } catch (err) {
      setServerError(describeError(err))
    }
  }

  const totalQty = form.items.reduce((s, it) => s + (parseFloat(it.received_quantity) || 0), 0)
  const summaryErrors = submitted
    ? [blocking && { id: 'gr-lines', message: blocking }, ...lineErrors.map((m, i) => m && { id: `gr-line-${i}`, message: `Line ${i + 1}: ${m.toLowerCase()}` })].filter(Boolean)
    : []

  return (
    <form onSubmit={submit} noValidate className="mx-auto max-w-4xl space-y-4">
      <PageHeader title="Goods receipt" description="Book goods into stock — against a purchase order, or by hand." />

      <ModeChooser
        label="Receive"
        value={mode}
        onChange={changeMode}
        columns={2}
        options={[
          { value: 'po-linked', label: 'Against a purchase order', description: 'Lines and quantities come from the PO.' },
          { value: 'manual', label: 'Without a PO', description: 'Free stock, samples, returns from site.' },
        ]}
      />

      {serverError && <InlineNotice tone="risk" title="The receipt was not posted">{serverError.message} Your entries are still here.</InlineNotice>}
      <ErrorSummary errors={summaryErrors} />

      {mode === 'po-linked' && (
        <TxSection title="Purchase order" description={selectedPO ? null : 'Confirmed orders that can still be received.'} action={selectedPO ? <Button size="sm" variant="ghost" onClick={() => { setSelectedPO(null); setForm((f) => ({ ...f, reference_document: '', items: [] })) }}>Change</Button> : null}>
          {selectedPO ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-mono text-base text-fg">{selectedPO.po_number}</span>
              <StatusBadge status={selectedPO.status} />
              <span className="text-sm text-ink-600">{selectedPO.supplier_name || selectedPO.supplier?.name}</span>
              {selectedPO.delivery_date && <span className="text-sm text-ink-500">Due <DateText value={selectedPO.delivery_date} /></span>}
            </div>
          ) : (
            <DocPicker
              docs={purchaseOrders}
              loading={posLoading}
              onPick={pickPO}
              number={(po) => po.po_number}
              title={(po) => po.supplier_name || po.supplier?.name || 'Supplier'}
              meta={(po) => (po.delivery_date ? `due ${new Date(po.delivery_date).toLocaleDateString()}` : null)}
              trailing={(po) => <StatusBadge status={po.status} />}
              searchLabel="Find a purchase order"
              searchPlaceholder="PO number or supplier"
              emptyTitle="Nothing to receive"
              emptyText="No purchase order is confirmed and waiting for goods. Receive without a PO, or check the order's status."
            />
          )}
        </TxSection>
      )}

      {mode === 'manual' && (
        <TxSection title="Add an item" description="Each item you add becomes a line below.">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Item" required error={manualTried ? manualErrors.item_name : null} id="grc-item-name">
              <Input size="lg" value={manual.item_name} onChange={(e) => setManual((m) => ({ ...m, item_name: e.target.value }))} placeholder="Item name" />
            </Field>
            <Field label="Quantity" required error={manualTried ? manualErrors.quantity : null} id="grc-quantity">
              <Input size="lg" type="number" min="0" step="0.01" numeric value={manual.quantity} onChange={(e) => setManual((m) => ({ ...m, quantity: e.target.value }))} />
            </Field>
            <Field label="Storage location" required error={manualTried ? manualErrors.storage_location_id : null} id="grc-storage-location">
              <Select size="lg" value={manual.storage_location_id} onChange={(e) => setManual((m) => ({ ...m, storage_location_id: e.target.value }))}>
                <option value="">Choose a location…</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.code} — {l.name}</option>)}
              </Select>
            </Field>
            <div className="flex items-end">
              <Button size="lg" block icon={PlusIcon} onClick={addManual}>Add item</Button>
            </div>
          </div>
        </TxSection>
      )}

      {(form.items.length > 0 || (mode === 'po-linked' && selectedPO && linesLoading)) && (
        <TxSection
          title={`Lines to receive (${form.items.length})`}
          action={form.items.length > 1 && locations.length ? (
            <Select size="sm" aria-label="Put every line into" className="w-44" value="" onChange={(e) => e.target.value && allTo(e.target.value)}>
              <option value="">All lines into…</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.code} — {l.name}</option>)}
            </Select>
          ) : null}
        >
          <ul className="space-y-3" id="gr-lines">
            {form.items.map((it, i) => (
              <LineCard
                key={it.id || i}
                title={it.item_name || it.name || 'Item'}
                subtitle={it.quantity != null && form.reference_type === 'PO' ? <>Ordered <Num value={it.quantity} unit={it.unit_of_measure} />{it.unit_price != null && <> · <Money amount={it.unit_price} /> each</>}</> : it.description}
                onRemove={() => removeLine(i)}
                error={submitted ? lineErrors[i] : null}
              >
                <Field label="Received" required id={`gr-line-${i}`}>
                  <Input size="lg" type="number" min="0" step="0.01" numeric suffix={it.unit_of_measure} value={it.received_quantity ?? ''} onChange={(e) => updateLine(i, { received_quantity: e.target.value })} />
                </Field>
                <LocationBin idPrefix={`gr-${i}`} locations={locations} locationId={it.storage_location_id} binId={it.bin_id} required onChange={({ location, bin }) => updateLine(i, { storage_location_id: location, bin_id: bin })} />
              </LineCard>
            ))}
          </ul>
        </TxSection>
      )}

      <TxSection title="Notes">
        <Field label="Notes" optional id="grc-notes">
          <Textarea rows={2} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Delivery note number, damage seen, who signed for it…" />
        </Field>
      </TxSection>

      <TxFooter
        summary={form.items.length ? <><Num value={totalQty} className="font-semibold text-fg" /> units on {form.items.length} line{form.items.length === 1 ? '' : 's'}</> : 'Nothing to receive yet'}
        blocker={blocking}
        submitLabel="Post goods receipt"
        loading={post.isPending}
        onCancel={() => navigate('/warehouse/transactions')}
      />
    </form>
  )
}
