import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, Field, Input, Select, Textarea, Combobox, FormSection, ErrorSummary, LineItemEditor,
  InlineNotice, Money, useDraft, notify,
} from '../../components/ui'

/**
 * New sales order, and the form SalesOrderEdit shares.
 *
 * Customer and dates first, then the lines as a sheet (tab across, Enter
 * down, paste from Excel), then delivery and notes folded away. The server
 * recalculates totals and tax from the customer's rate; the figures here are
 * the same calculation, shown live. The create form autosaves to this browser.
 */
const today = () => new Date().toISOString().split('T')[0]
const blankLine = () => ({
  _key: `${Date.now()}-${Math.random()}`, inventory_item_id: '', item_code: '', item_name: '', item_description: '',
  quantity: '1', unit_of_measure: 'PCS', unit_price: '', discount_percentage: 0, discount_amount: '', requested_delivery_date: '', notes: '',
})
const EMPTY_ORDER = {
  customer_id: '', customer_name: '', order_date: today(), delivery_date: '', reference_number: '', currency: 'USD', priority: 'NORMAL',
  delivery_address: '', delivery_instructions: '', shipping_method: '', notes: '', internal_notes: '', payment_terms: '', delivery_terms: '',
}
const lineTotal = (l) => (parseFloat(l.quantity) || 0) * (parseFloat(l.unit_price) || 0) - (parseFloat(l.discount_amount) || 0)
const isBlank = (l) => !l.item_name?.trim() && !l.inventory_item_id && !parseFloat(l.unit_price)
const list = (d) => (Array.isArray(d) ? d : d?.data || [])

function validate(form, lines) {
  const e = {}
  if (!form.customer_id) e.customer_id = 'Choose the customer. Only active customers are listed.'
  if (!form.order_date) e.order_date = 'Set the order date.'
  if (form.delivery_date && form.order_date && form.delivery_date < form.order_date) e.delivery_date = 'Delivery cannot be before the order date.'
  const lineErrors = {}
  let valid = 0
  lines.forEach((l, i) => {
    if (isBlank(l) && lines.length > 1) return
    const le = {}
    if (!l.item_name?.trim()) le.item_name = 'Name the item'
    if (!(parseFloat(l.quantity) > 0)) le.quantity = 'Quantity above zero'
    if (!(parseFloat(l.unit_price) > 0)) le.unit_price = 'Price above zero'
    if (!l.unit_of_measure?.trim()) le.unit_of_measure = 'Unit needed'
    if (Object.keys(le).length) lineErrors[i] = le
    else valid += 1
  })
  if (!valid) e.items = 'Add at least one complete line: item, quantity, unit and price.'
  return { e, lineErrors }
}

/** The sales order form. Controlled: `form`, `lines` and their setters come from the page. */
export function SalesOrderForm({ form, setForm, lines, setLines, onSubmit, saving, serverError, mode = 'create', cancelTo, submitLabel }) {
  const navigate = useNavigate()
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)

  const custParams = { limit: 100, status: 'ACTIVE' }
  const { data: rawCustomers, loading: customersLoading } = useResource(keys.customers(custParams), ({ signal }) => api.get('/customers', { params: custParams, signal }))
  const itemParams = { limit: 100, status: 'ACTIVE' }
  const { data: rawItems } = useResource(keys.inventoryItems(itemParams), ({ signal }) => api.get('/inventory-items', { params: itemParams, signal }))
  const customers = list(rawCustomers)
  const items = list(rawItems)
  const customer = customers.find((c) => c.id === form.customer_id)

  const { e: allErrors, lineErrors } = useMemo(() => validate(form, lines), [form, lines])
  const errors = submitted ? allErrors : Object.fromEntries(Object.entries(allErrors).filter(([k]) => touched[k]))
  const blur = (k) => () => setTouched((t) => ({ ...t, [k]: true }))

  const applyCustomer = (c) => {
    const address = [c.billing_address_line1, c.billing_address_line2, c.billing_city, c.billing_state, c.billing_country].filter((p) => p && String(p).trim() !== '').join(', ')
    setForm({ customer_id: c.id, customer_name: c.customer_name, delivery_address: address, payment_terms: c.payment_terms || '' })
  }
  const chooseCustomer = (v) => {
    const c = customers.find((x) => x.id === v)
    if (c) applyCustomer(c)
    else setForm({ customer_id: v })
    blur('customer_id')()
  }
  // A customer chosen before the list loaded (e.g. from ?customer_id=) gets its name and address once it arrives.
  useEffect(() => {
    if (form.customer_id && !form.customer_name && customer) applyCustomer(customer)
  }, [customer, form.customer_id, form.customer_name])

  const subtotal = lines.reduce((s, l) => s + (isBlank(l) ? 0 : lineTotal(l)), 0)
  const taxRate = Number(customer?.tax_rate) || 0
  const tax = subtotal * (taxRate / 100)

  const submit = (e) => {
    e.preventDefault()
    setSubmitted(true)
    if (Object.keys(allErrors).length || Object.keys(lineErrors).length) return
    const complete = lines.filter((l) => !isBlank(l))
    onSubmit({
      ...form,
      subtotal,
      tax_amount: tax,
      discount_amount: 0,
      total_amount: subtotal + tax,
      // Hand-typed lines send NULL, not '', for the inventory link: an empty string is not a valid uuid.
      items: complete.map(({ _key, ...l }) => ({
        ...l,
        inventory_item_id: l.inventory_item_id || null,
        requested_delivery_date: l.requested_delivery_date || null,
        quantity: parseFloat(l.quantity),
        unit_price: parseFloat(l.unit_price),
        discount_amount: parseFloat(l.discount_amount) || 0,
        line_total: lineTotal(l),
      })),
    })
  }

  const summaryErrors = submitted
    ? [
        ...Object.entries(allErrors).filter(([k]) => k !== 'items').map(([id, message]) => ({ id, message })),
        ...(allErrors.items ? [{ id: 'so-lines', message: allErrors.items }] : []),
        ...Object.entries(lineErrors).flatMap(([i, le]) => Object.values(le).map((m) => ({ id: 'so-lines', message: `Line ${Number(i) + 1}: ${m.toLowerCase()}` }))),
      ]
    : []
  const set = (k) => (e) => setForm({ [k]: e.target.value })

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      {serverError && (
        <InlineNotice tone="risk" title={mode === 'create' ? 'The order was not created' : 'Your changes were not saved'}>
          {serverError.message} Nothing was lost — your entries are still here.{serverError.reference && <> Reference <span className="font-mono">{serverError.reference}</span>.</>}
        </InlineNotice>
      )}
      <ErrorSummary errors={summaryErrors} />

      <FormSection title="Customer and dates">
        <Field label="Customer" required error={errors.customer_id} help={customer ? [customer.customer_code, customer.payment_terms && `terms ${customer.payment_terms}`, taxRate ? `tax ${taxRate}%` : null].filter(Boolean).join(' · ') : 'Only active customers are listed.'} className="sm:col-span-2" id="customer_id">
          <Combobox
            value={form.customer_id}
            onChange={chooseCustomer}
            options={customers.map((c) => ({ value: c.id, label: c.customer_name, meta: c.customer_code, description: [c.billing_city, c.billing_country].filter(Boolean).join(', ') }))}
            placeholder={customersLoading ? 'Loading customers…' : 'Search by name or code'}
            emptyText="No active customer matches"
          />
        </Field>
        <Field label="Order date" required error={errors.order_date} id="order_date">
          <Input type="date" value={form.order_date} onChange={set('order_date')} onBlur={blur('order_date')} />
        </Field>
        <Field label="Delivery date" optional error={errors.delivery_date} help="When the customer expects the goods." id="delivery_date">
          <Input type="date" value={form.delivery_date} onChange={set('delivery_date')} onBlur={blur('delivery_date')} min={form.order_date || undefined} />
        </Field>
        <Field label="Customer reference" optional help="Their purchase order number, if any." id="reference_number">
          <Input value={form.reference_number} onChange={set('reference_number')} />
        </Field>
        <Field label="Priority" id="priority">
          <Select value={form.priority} onChange={set('priority')}>
            <option value="LOW">Low</option>
            <option value="NORMAL">Normal</option>
            <option value="HIGH">High</option>
            <option value="URGENT">Urgent</option>
          </Select>
        </Field>
      </FormSection>

      <section aria-labelledby="so-lines-h" className="space-y-2" id="so-lines" tabIndex={-1}>
        <div>
          <h2 id="so-lines-h" className="text-sm font-semibold text-fg">Lines</h2>
          <p className="text-xs text-ink-500">Pick an inventory item to fill name, unit and price, or type a line by hand.</p>
        </div>
        {submitted && allErrors.items && <p className="text-xs text-risk-600" role="alert">{allErrors.items}</p>}
        <LineItemEditor
          label="Sales order lines"
          rows={lines}
          onChange={setLines}
          newRow={blankLine}
          errors={submitted ? lineErrors : {}}
          currency={form.currency}
          transform={(row, key, val) => {
            if (key !== 'inventory_item_id' || !val) return row
            const it = items.find((x) => x.id === val)
            return it ? { ...row, item_code: it.item_code, item_name: it.item_name, item_description: it.description || '', unit_of_measure: it.unit_of_measure || 'PCS', unit_price: it.unit_price != null ? String(Number(it.unit_price)) : row.unit_price } : row
          }}
          columns={[
            { key: 'inventory_item_id', header: 'Inventory item', type: 'select', width: 200, placeholder: 'Typed by hand', options: items.map((i) => ({ value: i.id, label: `${i.item_code} · ${i.item_name}` })) },
            { key: 'item_name', header: 'Item', type: 'text', minWidth: 180, required: true, placeholder: 'What you are selling' },
            { key: 'item_description', header: 'Description', type: 'text', minWidth: 160, placeholder: 'Optional detail' },
            { key: 'quantity', header: 'Qty', type: 'number', width: 80, required: true },
            { key: 'unit_of_measure', header: 'Unit', type: 'text', width: 70, required: true },
            { key: 'unit_price', header: 'Unit price', type: 'money', width: 110, required: true },
            { key: 'discount_amount', header: 'Discount', type: 'money', width: 100 },
            { key: 'line_total', header: 'Line total', type: 'money', compute: lineTotal, total: true, width: 120 },
          ]}
        />
      </section>

      <FormSection title="Delivery" columns={2}>
        <Field label="Delivery address" optional help="Filled from the customer's billing address; change it for this order if needed." className="sm:col-span-2" id="delivery-address">
          <Textarea rows={2} value={form.delivery_address} onChange={set('delivery_address')} />
        </Field>
        <Field label="Shipping method" optional id="shipping-method">
          <Input value={form.shipping_method} onChange={set('shipping_method')} placeholder="e.g. Standard, Express" />
        </Field>
        <Field label="Payment terms" optional id="payment-terms">
          <Input value={form.payment_terms} onChange={set('payment_terms')} placeholder="e.g. NET_30, COD" />
        </Field>
        <Field label="Delivery instructions" optional className="sm:col-span-2" id="delivery-instructions">
          <Textarea rows={2} value={form.delivery_instructions} onChange={set('delivery_instructions')} />
        </Field>
      </FormSection>

      <FormSection title="Currency and notes" description="Currency, customer notes and internal notes" advanced defaultOpen={form.currency !== 'USD' || Boolean(form.notes || form.internal_notes)}>
        <Field label="Currency" id="currency">
          <Select value={form.currency} onChange={set('currency')}>
            {['USD', 'EUR', 'GBP'].map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </Field>
        <div />
        <Field label="Notes" optional help="Visible to the customer." className="sm:col-span-2" id="notes">
          <Textarea rows={2} value={form.notes} onChange={set('notes')} />
        </Field>
        <Field label="Internal notes" optional help="Never shown to the customer." className="sm:col-span-2" id="internal-notes">
          <Textarea rows={2} value={form.internal_notes} onChange={set('internal_notes')} />
        </Field>
      </FormSection>

      <div className="sticky bottom-0 z-10 -mx-4 border-t border-ink-200 bg-canvas/95 px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <dl className="mr-auto flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
            <div className="flex items-baseline gap-1.5"><dt className="text-ink-600">Subtotal</dt><dd><Money amount={subtotal} currency={form.currency} /></dd></div>
            <div className="flex items-baseline gap-1.5"><dt className="text-ink-600">Tax{taxRate ? ` ${taxRate}%` : ''}</dt><dd><Money amount={tax} currency={form.currency} /></dd></div>
            <div className="flex items-baseline gap-1.5"><dt className="text-ink-600">Total</dt><dd><Money amount={subtotal + tax} currency={form.currency} className="text-base font-semibold" /></dd></div>
          </dl>
          <Button variant="ghost" onClick={() => navigate(cancelTo)} disabled={saving}>Cancel</Button>
          <Button type="submit" variant="primary" loading={saving} disabled={saving}>{submitLabel}</Button>
        </div>
      </div>
    </form>
  )
}

SalesOrderForm.blankLine = blankLine
SalesOrderForm.EMPTY = EMPTY_ORDER

export default function SalesOrderCreate() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const customerFromUrl = params.get('customer_id') || ''
  const initial = useMemo(() => ({ form: { ...EMPTY_ORDER, customer_id: customerFromUrl }, lines: [blankLine()] }), [customerFromUrl])
  const { value, setValue, restored, savedAt, clear, discard } = useDraft(`so:new${customerFromUrl ? `:c:${customerFromUrl}` : ''}`, initial)
  const setForm = (patch) => setValue((v) => ({ ...v, form: { ...v.form, ...patch } }))
  const setLines = (next) => setValue((v) => ({ ...v, lines: typeof next === 'function' ? next(v.lines) : next }))
  const [serverError, setServerError] = useState(null)
  const create = useResourceMutation((payload) => api.post('/sales-orders', payload), { invalidates: [['sales-orders']], silent: true })

  const save = async (payload) => {
    setServerError(null)
    try {
      const so = await create.mutateAsync(payload)
      clear()
      notify.success(`${so?.so_number || 'Sales order'} created`)
      navigate(so?.id ? `/sales/sales-orders/${so.id}` : '/sales/sales-orders')
    } catch (err) {
      const d = err?.response?.data || {}
      setServerError({ message: d.error || err.message, reference: d.error_id })
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="New sales order"
        description="Commit goods to a customer. The order starts as a draft."
        meta={savedAt ? <span aria-live="polite">Draft saved in this browser {new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> : null}
      />
      {restored && (
        <InlineNotice tone="ink" title="Picked up where you left off" action={<Button size="sm" variant="ghost" onClick={discard}>Start over</Button>}>
          This order was restored from a draft saved in this browser{savedAt ? ` at ${new Date(savedAt).toLocaleString()}` : ''}.
        </InlineNotice>
      )}
      <SalesOrderForm
        form={value.form}
        setForm={setForm}
        lines={value.lines}
        setLines={setLines}
        onSubmit={save}
        saving={create.isPending}
        serverError={serverError}
        mode="create"
        cancelTo="/sales/sales-orders"
        submitLabel="Create sales order"
      />
    </div>
  )
}
