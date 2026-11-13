import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import api from '../../../services/api'
import { useResource, useResourceMutation } from '../../../hooks/useResource'
import { keys } from '../../../services/queryKeys'
import {
  PageHeader, Button, Field, Input, Select, Textarea, FormSection, ErrorSummary, InlineNotice, Money, Num, DescriptionList,
  Card, formatMoney, notify,
} from '../../../components/ui'

/**
 * Receive goods against a confirmed purchase order line. Payload is
 * unchanged: POST /goods-receipts with the line, quantity, condition,
 * batch/serials and (optionally) the bin to put it in.
 */
const INITIAL = {
  po_id: '',
  line_item_id: '',
  quantity_received: '',
  condition_grade: 'NEW',
  batch_lot_number: '',
  serial_numbers: [],
  expiry_date: '',
  storage_location_id: '',
  bin_id: '',
  notes: '',
}

export default function GoodsReceiptCreate() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [form, setFormState] = useState(() => ({ ...INITIAL, po_id: params.get('po_id') || '' }))
  const [serialText, setSerialText] = useState('')
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState(null)

  const { data: posData, loading: posLoading } = useResource(keys.purchaseOrders({ status: 'CONFIRMED' }), ({ signal }) => api.get('/purchase-orders', { params: { status: 'CONFIRMED' }, signal }))
  const pos = (Array.isArray(posData) ? posData : []).filter((po) => po.status !== 'FULLY_RECEIVED')
  const selectedPO = pos.find((p) => p.id === form.po_id)

  const { data: lineItemsData, loading: linesLoading } = useResource(keys.poLineItems(form.po_id), ({ signal }) => api.get(`/purchase-orders/${form.po_id}/line-items`, { signal }), { enabled: Boolean(form.po_id) })
  const lineItems = (Array.isArray(lineItemsData) ? lineItemsData : []).filter((i) => Number(i.quantity_remaining) > 0)
  const line = lineItems.find((i) => i.id === form.line_item_id)

  const { data: locData } = useResource(keys.goodsReceiptLocations(), ({ signal }) => api.get('/goods-receipts/storage-locations', { signal }))
  const locations = Array.isArray(locData) ? locData : []
  const { data: binsData } = useResource(keys.goodsReceiptBins(form.storage_location_id), ({ signal }) => api.get(`/goods-receipts/bins/${form.storage_location_id}`, { signal }), { enabled: Boolean(form.storage_location_id) })
  const bins = Array.isArray(binsData) ? binsData : []

  const createReceipt = useResourceMutation((body) => api.post('/goods-receipts', body), {
    invalidates: [['goods-receipts'], ['purchase-orders'], ['inventory-items']],
    silent: true,
  })

  const allErrors = useMemo(() => {
    const e = {}
    if (!form.po_id) e.po_id = 'Choose the purchase order being received.'
    if (!form.line_item_id) e.line_item_id = 'Choose the line that arrived.'
    if (!form.quantity_received || parseFloat(form.quantity_received) <= 0) e.quantity_received = 'Enter the quantity received, above zero.'
    else if (line && parseFloat(form.quantity_received) > Number(line.quantity_remaining)) e.quantity_received = `Only ${Number(line.quantity_remaining)} ${line.unit_of_measure || 'units'} remain to receive on this line.`
    return e
  }, [form, line])
  const errors = submitted ? allErrors : Object.fromEntries(Object.entries(allErrors).filter(([k]) => touched[k]))
  const blur = (k) => () => setTouched((t) => ({ ...t, [k]: true }))

  const set = (name) => (e) => {
    const v = e.target.value
    setFormState((f) => {
      const next = { ...f, [name]: v }
      if (name === 'po_id') { next.line_item_id = ''; next.quantity_received = '' }
      if (name === 'storage_location_id') next.bin_id = ''
      return next
    })
  }

  const submit = async (e) => {
    e.preventDefault()
    setSubmitted(true)
    setServerError(null)
    if (Object.keys(allErrors).length) return
    try {
      await createReceipt.mutateAsync({ ...form, quantity_received: parseFloat(form.quantity_received) })
      notify.success(`Received ${form.quantity_received} ${line?.unit_of_measure || ''} on ${selectedPO?.po_number || 'the order'}. Stock is updated.`)
      navigate('/procurement/purchase-orders')
    } catch (err) {
      const d = err?.response?.data || {}
      setServerError({ message: d.error || err.message, reference: d.error_id })
    }
  }

  const qty = parseFloat(form.quantity_received) || 0

  return (
    <form onSubmit={submit} className="mx-auto max-w-3xl space-y-5" noValidate>
      <PageHeader title="Receive goods" description="Record what arrived against a purchase order line. Stock and the order’s received quantities update when you save." />

      {serverError && (
        <InlineNotice tone="risk" title="The receipt was not saved">
          {serverError.message} Your entries are still here.{serverError.reference && <> Reference <span className="font-mono">{serverError.reference}</span>.</>}
        </InlineNotice>
      )}
      <ErrorSummary errors={submitted ? Object.entries(allErrors).map(([id, message]) => ({ id, message })) : []} />

      <FormSection title="What arrived">
        <Field label="Purchase order" required error={errors.po_id} help={!posLoading && !pos.length ? 'No confirmed purchase orders are waiting for goods.' : 'Confirmed orders with something left to receive.'} className="sm:col-span-2" id="po_id">
          <Select name="po_id" value={form.po_id} onChange={set('po_id')} onBlur={blur('po_id')}>
            <option value="">{posLoading ? 'Loading orders…' : 'Choose a purchase order…'}</option>
            {pos.map((po) => <option key={po.id} value={po.id}>{po.po_number} - {po.supplier_name} ({formatMoney(po.total_amount, po.currency || 'USD')})</option>)}
          </Select>
        </Field>
        <Field label="Line" required error={errors.line_item_id} help={form.po_id && !linesLoading && !lineItems.length ? 'Every line on this order is already fully received.' : undefined} className="sm:col-span-2" id="line_item_id">
          <Select name="line_item_id" value={form.line_item_id} onChange={set('line_item_id')} onBlur={blur('line_item_id')} disabled={!form.po_id}>
            <option value="">{!form.po_id ? 'Choose an order first' : linesLoading ? 'Loading lines…' : 'Choose a line…'}</option>
            {lineItems.map((i) => <option key={i.id} value={i.id}>{i.item_description} — {Number(i.quantity_remaining)} {i.unit_of_measure || ''} remaining</option>)}
          </Select>
        </Field>
        <Field label="Quantity received" required error={errors.quantity_received} help={line ? `Up to ${Number(line.quantity_remaining)} ${line.unit_of_measure || ''}` : undefined} id="quantity_received">
          <Input type="number" step="0.01" min="0.01" max={line ? Number(line.quantity_remaining) : undefined} numeric name="quantity_received" value={form.quantity_received} onChange={set('quantity_received')} onBlur={blur('quantity_received')} />
        </Field>
        <Field label="Condition" id="condition_grade">
          <Select name="condition_grade" value={form.condition_grade} onChange={set('condition_grade')}>
            <option value="NEW">New</option>
            <option value="USED">Used</option>
            <option value="REFURBISHED">Refurbished</option>
            <option value="DAMAGED">Damaged</option>
          </Select>
        </Field>
      </FormSection>

      <FormSection title="Put away" description="Optional. Choose where the goods go so stock lands in the right bin.">
        <Field label="Storage location" optional id="storage_location_id">
          <Select name="storage_location_id" value={form.storage_location_id} onChange={set('storage_location_id')}>
            <option value="">Choose a location…</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.code}) — {l.bin_count} bins</option>)}
          </Select>
        </Field>
        <Field label="Bin" optional id="bin_id">
          <Select name="bin_id" value={form.bin_id} onChange={set('bin_id')} disabled={!form.storage_location_id}>
            <option value="">{form.storage_location_id ? 'Choose a bin…' : 'Choose a location first'}</option>
            {bins.map((b) => <option key={b.id} value={b.id}>{b.code}{b.description ? ` - ${b.description}` : ''} (free {b.available_mass ?? '—'} kg, {b.available_volume ?? '—'} m³)</option>)}
          </Select>
        </Field>
      </FormSection>

      <FormSection title="Traceability" description="Batch, expiry, serial numbers and notes" advanced defaultOpen={Boolean(form.batch_lot_number || form.expiry_date || serialText || form.notes)}>
        <Field label="Batch or lot number" optional id="batch_lot_number">
          <Input name="batch_lot_number" value={form.batch_lot_number} onChange={set('batch_lot_number')} />
        </Field>
        <Field label="Expiry date" optional id="expiry_date">
          <Input type="date" name="expiry_date" value={form.expiry_date} onChange={set('expiry_date')} />
        </Field>
        <Field label="Serial numbers" optional help="For serialised items: one per line, or separated by commas." className="sm:col-span-2" id="serial_numbers">
          <Textarea name="serial_numbers" rows={3} value={serialText} onChange={(e) => { setSerialText(e.target.value); setFormState((f) => ({ ...f, serial_numbers: e.target.value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean) })) }} />
        </Field>
        <Field label="Notes" optional help="Damage, shortages, packaging." className="sm:col-span-2" id="notes">
          <Textarea name="notes" rows={2} value={form.notes} onChange={set('notes')} />
        </Field>
      </FormSection>

      {line && qty > 0 && (
        <Card title="Receipt summary">
          <DescriptionList
            items={[
              { label: 'Item', value: line.item_description },
              { label: 'Receiving', value: <Num value={qty} digits={qty % 1 ? 2 : 0} unit={line.unit_of_measure} /> },
              { label: 'Unit price', value: <Money amount={line.unit_price} currency={selectedPO?.currency || 'USD'} /> },
              { label: 'Value received', value: <Money amount={Number(line.unit_price) * qty} currency={selectedPO?.currency || 'USD'} className="font-semibold" /> },
              { label: 'Serial numbers', value: form.serial_numbers.length ? String(form.serial_numbers.length) : null },
            ]}
          />
        </Card>
      )}

      <div className="sticky bottom-0 z-10 -mx-4 border-t border-ink-200 bg-canvas/95 px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Button variant="ghost" onClick={() => navigate('/procurement/purchase-orders')}>Cancel</Button>
          <Button type="submit" variant="primary" loading={createReceipt.isPending}>Receive goods</Button>
        </div>
      </div>
    </form>
  )
}
