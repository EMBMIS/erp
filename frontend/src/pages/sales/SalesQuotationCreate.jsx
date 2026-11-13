import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, Field, Input, Select, Textarea, FormSection, ErrorSummary, LineItemEditor,
  InlineNotice, Money, useDraft, notify, formatMoney,
} from '../../components/ui'

/**
 * Sales quotation form — used by "New quotation" (this file's default export)
 * and by SalesQuotationEdit (which renders <QuotationForm> with the record).
 *
 * Sections: customer and validity, delivery and payment, the lines (a sheet:
 * tab across, Enter down, paste from Excel), then terms and notes folded away.
 * Payload and rules are the same as the previous screen; the server
 * recomputes line totals and tax.
 */
const iso = (d) => d.toISOString().split('T')[0]
const plus30 = (from) => {
  const d = from ? new Date(from) : new Date()
  if (Number.isNaN(d.getTime())) return ''
  d.setDate(d.getDate() + 30)
  return iso(d)
}
const num = (v) => parseFloat(v) || 0
const blankLine = () => ({
  _key: `${Date.now()}-${Math.random()}`,
  inventory_item_id: '', item_code: '', item_name: '', item_description: '',
  quantity: '1', unit_of_measure: 'PCS', unit_price: '', discount_percentage: 0, discount_amount: '',
  estimated_delivery_date: '', notes: '',
  sourcing_type: 'STOCK', source_bin_id: '', linked_sales_rfq_id: '', supplier_id: '', supplier_name: '', estimated_supplier_cost: '',
})
const isBlank = (l) => !l.item_name?.trim() && !l.inventory_item_id && !num(l.unit_price)
const lineTotal = (l) => num(l.quantity) * num(l.unit_price) - num(l.discount_amount)
const margin = (l) => {
  const cost = num(l.estimated_supplier_cost)
  const price = num(l.unit_price)
  if (!(cost > 0 && price > 0)) return null
  return { amount: price - cost, pct: ((price - cost) / cost) * 100 }
}

function validate(form, lines) {
  const e = {}
  if (!form.customer_id) e.customer_id = 'Choose the customer this quotation is for.'
  if (form.valid_until && form.quotation_date && form.valid_until < form.quotation_date) e.valid_until = 'Valid until must be on or after the quotation date.'
  const lineErrors = {}
  let valid = 0
  lines.forEach((l, i) => {
    if (isBlank(l) && lines.length > 1) return
    const le = {}
    if (!l.item_name?.trim()) le.item_name = 'Name the item'
    if (!(num(l.quantity) > 0)) le.quantity = 'Quantity above zero'
    if (!l.unit_of_measure?.trim()) le.unit_of_measure = 'Unit required'
    if (!(num(l.unit_price) > 0)) le.unit_price = 'Price above zero'
    if (Object.keys(le).length) lineErrors[i] = le
    else valid += 1
  })
  if (!valid) e.items = 'Add at least one complete line: item name, quantity, unit and unit price.'
  return { e, lineErrors }
}

/** e2e selectors predate the line grid; keep `sq-item-{row}-{field}` on its cells. */
function useCellTestIds(ref, byColumn) {
  useLayoutEffect(() => {
    ref.current?.querySelectorAll('[data-cell]').forEach((el) => {
      const [r, c] = el.getAttribute('data-cell').split(':')
      if (byColumn[c]) el.setAttribute('data-testid', `sq-item-${r}-${byColumn[c]}`)
    })
  })
}
const TEST_IDS = { 0: 'inventory', 1: 'name', 3: 'quantity', 5: 'unit-price' }

export function QuotationForm({ title, description, meta, initialValue, draftKey, cancelTo, onSave, actions }) {
  const { value, setValue, restored, savedAt, clear, discard } = useDraft(draftKey || 'sales-quotation:edit', initialValue, { enabled: Boolean(draftKey) })
  const { form, lines } = value
  const setForm = (patch) => setValue((v) => ({ ...v, form: { ...v.form, ...patch } }))
  const setLines = (next) => setValue((v) => ({ ...v, lines: typeof next === 'function' ? next(v.lines) : next }))

  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(null)
  const [serverError, setServerError] = useState(null)
  const gridRef = useRef(null)
  useCellTestIds(gridRef, TEST_IDS)

  const ACTIVE = { limit: 100, status: 'ACTIVE' }
  const RESPONDED = { limit: 100, status: 'RESPONDED' }
  const get = (path, params) => ({ signal }) => api.get(path, { params, signal })
  const list = (d) => (Array.isArray(d) ? d : d?.data || [])
  const { data: rawCustomers, loading: customersLoading } = useResource(keys.customers(ACTIVE), get('/customers', ACTIVE))
  const { data: rawInventory } = useResource(keys.inventoryItems(ACTIVE), get('/inventory-items', ACTIVE))
  const { data: rawBins } = useResource(keys.bins(ACTIVE), get('/bins', ACTIVE))
  const { data: rawSuppliers } = useResource(keys.suppliers(ACTIVE), get('/suppliers', ACTIVE))
  const { data: rawRfqs } = useResource(keys.salesRfqs(RESPONDED), get('/sales-rfqs', RESPONDED))
  const customers = list(rawCustomers)
  const inventory = list(rawInventory)
  const bins = list(rawBins)
  const suppliers = list(rawSuppliers)
  const salesRfqs = list(rawRfqs)

  const { e: allErrors, lineErrors } = useMemo(() => validate(form, lines), [form, lines])
  const errors = submitted ? allErrors : Object.fromEntries(Object.entries(allErrors).filter(([k]) => touched[k]))
  const blur = (k) => () => setTouched((t) => ({ ...t, [k]: true }))

  const customer = customers.find((c) => c.id === form.customer_id)
  const chooseCustomer = (id) => {
    const c = customers.find((x) => x.id === id)
    if (!c) return setForm({ customer_id: id })
    const address = [c.billing_address_line1, c.billing_address_line2, c.billing_city, c.billing_state, c.billing_country].filter((p) => p && String(p).trim() !== '').join(', ')
    setForm({ customer_id: id, customer_name: c.customer_name, delivery_address: address, payment_terms: c.payment_terms || '' })
  }

  const complete = lines.filter((l) => !isBlank(l))
  const subtotal = complete.reduce((s, l) => s + lineTotal(l), 0)
  const taxRate = Number(customer?.tax_rate) || 0
  const tax = subtotal * (taxRate / 100)

  const transform = (row, key, val) => {
    if (key === 'inventory_item_id') {
      const it = inventory.find((x) => x.id === val)
      return it ? { ...row, item_code: it.item_code, item_name: it.item_name, item_description: it.description || '', unit_of_measure: it.unit_of_measure || 'PCS', unit_price: String(it.unit_price ?? '') } : row
    }
    if (key === 'supplier_id') {
      const s = suppliers.find((x) => x.id === val)
      return { ...row, supplier_name: s ? s.legal_name || s.trade_name : '' }
    }
    if (key === 'linked_sales_rfq_id') {
      const r = salesRfqs.find((x) => x.id === val)
      return r ? { ...row, supplier_id: r.supplier_id || '', supplier_name: r.supplier_name || '', estimated_supplier_cost: String(r.supplier_total_amount ?? '') } : row
    }
    if (key === 'sourcing_type') {
      return val === 'SUPPLIER'
        ? { ...row, source_bin_id: '' }
        : { ...row, linked_sales_rfq_id: '', supplier_id: '', supplier_name: '', estimated_supplier_cost: '' }
    }
    return row
  }

  const save = async (kind) => {
    setSubmitted(true)
    setServerError(null)
    if (Object.keys(allErrors).length || Object.keys(lineErrors).length) return
    setSaving(kind)
    const items = complete.map(({ _key, ...l }) => {
      const m = margin(l)
      return {
        ...l,
        quantity: num(l.quantity),
        unit_price: num(l.unit_price),
        discount_amount: num(l.discount_amount),
        estimated_supplier_cost: num(l.estimated_supplier_cost),
        line_total: lineTotal(l),
        margin_amount: m ? m.amount : 0,
        margin_percentage: m ? m.pct : 0,
      }
    })
    try {
      await onSave({ ...form, items, subtotal, tax_amount: tax, discount_amount: 0, total_amount: subtotal + tax }, kind)
      clear()
    } catch (err) {
      const d = err?.response?.data || {}
      setServerError({ message: d.error || err.message, reference: d.error_id })
    } finally {
      setSaving(null)
    }
  }

  const summaryErrors = submitted
    ? [
        ...Object.entries(allErrors).filter(([k]) => k !== 'items').map(([id, message]) => ({ id: id === 'customer_id' ? 'customer' : id.replace(/_/g, '-'), message })),
        ...(allErrors.items ? [{ id: 'sq-lines', message: allErrors.items }] : []),
        ...Object.entries(lineErrors).flatMap(([i, le]) => Object.values(le).map((m) => ({ id: 'sq-lines', message: `Line ${Number(i) + 1}: ${m.toLowerCase()}` }))),
      ]
    : []

  const binLabel = (b) => [b.bin_code, b.location_description, b.bin_type && `(${b.bin_type})`].filter(Boolean).join(' · ')

  return (
    <form onSubmit={(e) => { e.preventDefault(); save('draft') }} className="mx-auto max-w-6xl space-y-5" noValidate>
      <PageHeader
        title={title}
        description={description}
        meta={meta || (draftKey && savedAt ? <span aria-live="polite">Draft saved in this browser {new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> : null)}
      />

      {draftKey && restored && (
        <InlineNotice tone="ink" title="Picked up where you left off" action={<Button size="sm" variant="ghost" onClick={discard}>Start over</Button>}>
          This quotation was restored from a draft saved in this browser{savedAt ? ` at ${new Date(savedAt).toLocaleString()}` : ''}.
        </InlineNotice>
      )}
      {serverError && (
        <InlineNotice tone="risk" title="The quotation was not saved">
          {serverError.message} Nothing was lost — your entries are still here.{serverError.reference && <> Reference <span className="font-mono">{serverError.reference}</span>.</>}
        </InlineNotice>
      )}
      <ErrorSummary errors={summaryErrors} />

      <FormSection title="Customer and validity">
        <Field label="Customer" required error={errors.customer_id} help={customer ? [customer.customer_code, customer.email, taxRate ? `tax ${taxRate}%` : null].filter(Boolean).join(' · ') : 'Only active customers are listed.'} className="sm:col-span-2" id="customer">
          <Select data-testid="sq-customer" value={form.customer_id} onChange={(e) => { chooseCustomer(e.target.value); blur('customer_id')() }} onBlur={blur('customer_id')}>
            <option value="">{customersLoading ? 'Loading customers…' : 'Choose a customer…'}</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.customer_name}{c.customer_code ? ` (${c.customer_code})` : ''}</option>)}
          </Select>
        </Field>
        <Field label="Customer reference" optional help="Their RFQ or enquiry number, printed on the quotation." id="reference-number">
          <Input data-testid="sq-reference-number" value={form.reference_number} onChange={(e) => setForm({ reference_number: e.target.value })} />
        </Field>
        <Field label="Priority" id="priority">
          <Select value={form.priority} onChange={(e) => setForm({ priority: e.target.value })}>
            <option value="LOW">Low</option>
            <option value="NORMAL">Normal</option>
            <option value="HIGH">High</option>
            <option value="URGENT">Urgent</option>
          </Select>
        </Field>
        <Field label="Quotation date" id="quotation-date" help="Changing it moves Valid until to 30 days later.">
          <Input type="date" value={form.quotation_date} onChange={(e) => setForm({ quotation_date: e.target.value, valid_until: plus30(e.target.value) || form.valid_until })} />
        </Field>
        <Field label="Valid until" error={errors.valid_until} id="valid-until">
          <Input type="date" value={form.valid_until} min={form.quotation_date || undefined} onChange={(e) => setForm({ valid_until: e.target.value })} onBlur={blur('valid_until')} />
        </Field>
      </FormSection>

      <FormSection title="Delivery and payment">
        <Field label="Payment terms" optional help="Defaults from the customer. Days, e.g. 30." id="payment-terms">
          <Input value={form.payment_terms} onChange={(e) => setForm({ payment_terms: e.target.value })} placeholder="30" />
        </Field>
        <Field label="Estimated delivery" optional help="Days from order to delivery." id="estimated-delivery-days">
          <Input type="number" min="0" value={form.estimated_delivery_days} onChange={(e) => setForm({ estimated_delivery_days: e.target.value })} suffix="days" />
        </Field>
        <Field label="Delivery terms" optional id="delivery-terms">
          <Input value={form.delivery_terms} onChange={(e) => setForm({ delivery_terms: e.target.value })} placeholder="e.g. FOB, CIF, EXW" />
        </Field>
        <Field label="Currency" id="currency">
          <Select value={form.currency} onChange={(e) => setForm({ currency: e.target.value })}>
            <option value="USD">USD — US dollar</option>
            <option value="EUR">EUR — Euro</option>
            <option value="GBP">GBP — British pound</option>
          </Select>
        </Field>
        <Field label="Delivery address" optional help="Defaults from the customer's billing address." className="sm:col-span-2" id="delivery-address">
          <Textarea rows={2} value={form.delivery_address} onChange={(e) => setForm({ delivery_address: e.target.value })} />
        </Field>
      </FormSection>

      <section aria-labelledby="sq-lines-h" className="space-y-2" id="sq-lines" tabIndex={-1} ref={gridRef}>
        <div>
          <h2 id="sq-lines-h" className="text-sm font-semibold text-fg">Lines</h2>
          <p className="text-xs text-ink-500">Pick an inventory item to fill name, unit and price, or type a free-text line. Supplier-sourced lines take a supplier or a responded sales RFQ, and show the margin over its cost.</p>
        </div>
        {submitted && allErrors.items && <p className="text-xs text-risk-600" role="alert">{allErrors.items}</p>}
        <LineItemEditor
          label="Quotation lines"
          rows={lines}
          onChange={setLines}
          newRow={blankLine}
          errors={submitted ? lineErrors : {}}
          currency={form.currency}
          transform={transform}
          columns={[
            { key: 'inventory_item_id', header: 'Inventory item', type: 'select', minWidth: 190, placeholder: 'Free text', options: inventory.map((i) => ({ value: i.id, label: `${i.item_code} · ${i.item_name}` })) },
            { key: 'item_name', header: 'Item name', type: 'text', minWidth: 180, required: true },
            { key: 'item_description', header: 'Description', type: 'text', minWidth: 180 },
            { key: 'quantity', header: 'Qty', type: 'number', minWidth: 80, required: true },
            { key: 'unit_of_measure', header: 'Unit', type: 'text', minWidth: 70, required: true },
            { key: 'unit_price', header: 'Unit price', type: 'money', minWidth: 110, required: true },
            { key: 'discount_amount', header: 'Discount', type: 'money', minWidth: 100 },
            { key: 'line_total', header: 'Line total', type: 'money', compute: lineTotal, total: true, minWidth: 120 },
            { key: 'estimated_delivery_date', header: 'Delivery', type: 'date', minWidth: 140 },
            { key: 'sourcing_type', header: 'Source', type: 'select', minWidth: 120, placeholder: 'Choose…', options: [{ value: 'STOCK', label: 'From stock' }, { value: 'SUPPLIER', label: 'From supplier' }] },
            { key: 'source_bin_id', header: 'Bin', type: 'select', minWidth: 170, placeholder: 'Any bin', options: bins.map((b) => ({ value: b.id, label: binLabel(b) })), validate: (v, row) => (v && row.sourcing_type !== 'STOCK' ? 'Bins apply to stock lines' : null) },
            { key: 'linked_sales_rfq_id', header: 'Sales RFQ', type: 'select', minWidth: 170, placeholder: 'None', options: salesRfqs.map((r) => ({ value: r.id, label: `${r.rfq_number} · ${r.supplier_name || ''}` })), validate: (v, row) => (v && row.sourcing_type !== 'SUPPLIER' ? 'RFQs apply to supplier lines' : null) },
            { key: 'supplier_id', header: 'Supplier', type: 'select', minWidth: 170, placeholder: 'None', options: suppliers.map((s) => ({ value: s.id, label: s.legal_name || s.trade_name })), validate: (v, row) => (v && row.sourcing_type !== 'SUPPLIER' ? 'Suppliers apply to supplier lines' : null) },
            { key: 'estimated_supplier_cost', header: 'Supplier cost', type: 'money', minWidth: 110 },
            { key: 'margin', header: 'Margin', compute: (l) => { const m = margin(l); return m ? `${m.pct.toFixed(1)}%` : null }, minWidth: 80 },
          ]}
        />
      </section>

      <FormSection title="Terms and notes" description="Terms and conditions, notes to the customer, internal notes" advanced defaultOpen={Boolean(form.terms_and_conditions || form.notes || form.internal_notes)}>
        <Field label="Terms and conditions" optional className="sm:col-span-2" id="terms-and-conditions">
          <Textarea rows={4} value={form.terms_and_conditions} onChange={(e) => setForm({ terms_and_conditions: e.target.value })} />
        </Field>
        <Field label="Notes to the customer" optional help="Printed on the quotation." id="notes">
          <Textarea rows={3} value={form.notes} onChange={(e) => setForm({ notes: e.target.value })} />
        </Field>
        <Field label="Internal notes" optional help="Only your team sees these." id="internal-notes">
          <Textarea rows={3} value={form.internal_notes} onChange={(e) => setForm({ internal_notes: e.target.value })} />
        </Field>
      </FormSection>

      <div className="sticky bottom-0 z-10 -mx-4 border-t border-ink-200 bg-canvas/95 px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="mr-auto text-sm">
            <span className="text-ink-600">Total </span>
            <Money amount={subtotal + tax} currency={form.currency} className="text-base font-semibold" />
            <span className="ml-2 text-xs text-ink-500">{taxRate ? `incl. ${formatMoney(tax, form.currency)} tax at ${taxRate}%` : 'no tax for this customer'}</span>
          </div>
          <Button variant="ghost" to={cancelTo}>Cancel</Button>
          {actions({ save, saving })}
        </div>
      </div>
    </form>
  )
}

export default function SalesQuotationCreate() {
  const navigate = useNavigate()
  const initial = useMemo(() => ({
    form: {
      customer_id: '', customer_name: '', quotation_date: iso(new Date()), valid_until: plus30(), reference_number: '',
      currency: 'USD', priority: 'NORMAL', delivery_address: '', delivery_terms: '', estimated_delivery_days: '',
      notes: '', internal_notes: '', terms_and_conditions: '', payment_terms: '',
    },
    lines: [blankLine()],
  }), [])

  const onSave = async (payload, kind) => {
    const res = await api.post('/sales-quotations', payload)
    if (!res.data?.success) throw Object.assign(new Error(res.data?.error || 'The quotation was not created.'), { response: { data: res.data } })
    const q = res.data.data
    if (kind === 'approval') {
      try {
        const ap = await api.post(`/sales-quotations/${q.id}/request-approval`)
        if (!ap.data?.success) throw new Error(ap.data?.error)
        notify.success(`${q.quotation_number || 'Quotation'} created and sent for approval`)
      } catch (e) {
        notify.error(`${q.quotation_number || 'Quotation'} was created but not sent for approval${e?.response?.data?.error || e.message ? `: ${e?.response?.data?.error || e.message}` : ''}. Send it from the quotation.`)
      }
    } else {
      notify.success(`${q.quotation_number || 'Quotation'} saved as a draft`)
    }
    navigate(`/sales/quotations/${q.id}`)
  }

  return (
    <QuotationForm
      title="New sales quotation"
      description="Price goods for a customer. Save a draft to finish later, or send it for approval now."
      initialValue={initial}
      draftKey="sales-quotation:new"
      cancelTo="/sales/quotations"
      onSave={onSave}
      actions={({ save, saving }) => (
        <>
          <Button type="submit" data-testid="sq-submit-draft" loading={saving === 'draft'} disabled={Boolean(saving)}>Save draft</Button>
          <Button variant="primary" data-testid="sq-submit-approval" loading={saving === 'approval'} disabled={Boolean(saving)} onClick={() => save('approval')}>Send for approval</Button>
        </>
      )}
    />
  )
}
