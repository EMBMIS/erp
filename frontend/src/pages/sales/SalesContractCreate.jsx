import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, Field, Input, Select, Textarea, Checkbox, FormSection, ErrorSummary, LineItemEditor,
  InlineNotice, Money, useDraft, notify,
} from '../../components/ui'

/**
 * Sales contract form — used by "New contract" (default export) and
 * SalesContractEdit (which renders <ContractForm> seeded from the record).
 *
 * Sections: the agreement, the party, the period, the lines (a sheet: agreed
 * unit prices with optional min/max quantities), terms, then notes folded away.
 * Payload and rules are unchanged from the previous screen.
 */
const num = (v) => parseFloat(v) || 0
const blankLine = () => ({ _key: `${Date.now()}-${Math.random()}`, inventory_item_id: '', item_code: '', item_name: '', item_description: '', unit_price: '', minimum_quantity: '', maximum_quantity: '', unit_of_measure: '', lead_time_days: '', item_notes: '' })
const isBlank = (l) => !l.item_name?.trim() && !l.inventory_item_id && !l.unit_price

function validate(form, lines) {
  const e = {}
  if (!form.contract_name?.trim()) e.contract_name = 'Name the contract.'
  if (!form.start_date) e.start_date = 'Set the date the contract starts.'
  if (!form.end_date) e.end_date = 'Set the date the contract ends.'
  else if (form.start_date && new Date(form.end_date) <= new Date(form.start_date)) e.end_date = 'The end date must be after the start date.'
  const lineErrors = {}
  let valid = 0
  lines.forEach((l, i) => {
    if (isBlank(l) && lines.length > 1) return
    const le = {}
    if (!l.item_name?.trim()) le.item_name = 'Name the item'
    if (!l.unit_price) le.unit_price = 'Agreed price required'
    if (!l.unit_of_measure?.trim()) le.unit_of_measure = 'Unit required'
    if (l.minimum_quantity && l.maximum_quantity && num(l.maximum_quantity) < num(l.minimum_quantity)) le.maximum_quantity = 'Max below min'
    if (Object.keys(le).length) lineErrors[i] = le
    else valid += 1
  })
  if (!valid) e.items = 'Add at least one complete line: item name, agreed unit price and unit.'
  return { e, lineErrors }
}

export function ContractForm({ title, description, meta, initialValue, draftKey, cancelTo, onSave, actions, exclusiveParty = false }) {
  const { value, setValue, restored, savedAt, clear, discard } = useDraft(draftKey || 'sales-contract:edit', initialValue, { enabled: Boolean(draftKey) })
  const { form, lines } = value
  const setForm = (patch) => setValue((v) => ({ ...v, form: { ...v.form, ...patch } }))
  const setLines = (next) => setValue((v) => ({ ...v, lines: typeof next === 'function' ? next(v.lines) : next }))

  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(null)
  const [serverError, setServerError] = useState(null)

  const LOOKUP = { status: 'ACTIVE', limit: 100 }
  const INV = { limit: 100 }
  const list = (d) => (Array.isArray(d) ? d : d?.data || [])
  const { data: rawCustomers } = useResource(keys.customers(LOOKUP), ({ signal }) => api.get('/customers', { params: LOOKUP, signal }))
  const { data: rawSuppliers } = useResource(keys.suppliers(LOOKUP), ({ signal }) => api.get('/suppliers', { params: LOOKUP, signal }))
  const { data: rawInventory } = useResource(keys.inventoryItems(INV), ({ signal }) => api.get('/inventory-items', { params: INV, signal }))
  const customers = list(rawCustomers)
  const suppliers = list(rawSuppliers)
  const inventory = list(rawInventory)

  const { e: allErrors, lineErrors } = useMemo(() => validate(form, lines), [form, lines])
  const errors = submitted ? allErrors : Object.fromEntries(Object.entries(allErrors).filter(([k]) => touched[k]))
  const blur = (k) => () => setTouched((t) => ({ ...t, [k]: true }))

  const chooseCustomer = (cid) => {
    const c = customers.find((x) => String(x.id) === String(cid))
    setForm({ customer_id: cid, customer_name: c ? c.customer_name : '', ...(exclusiveParty && cid ? { supplier_id: '', supplier_name: '' } : {}) })
  }
  const chooseSupplier = (sid) => {
    const s = suppliers.find((x) => String(x.id) === String(sid))
    setForm({ supplier_id: sid, supplier_name: s ? s.legal_name || s.trade_name || '' : '', ...(exclusiveParty && sid ? { customer_id: '', customer_name: '' } : {}) })
  }

  const save = async (kind) => {
    setSubmitted(true)
    setServerError(null)
    if (Object.keys(allErrors).length || Object.keys(lineErrors).length) return
    setSaving(kind)
    const items = lines.filter((l) => l.item_name?.trim() && l.unit_price && l.unit_of_measure?.trim()).map(({ _key, ...l }) => l)
    try {
      await onSave({
        ...form,
        items,
        contract_attachment_urls: form.contract_attachment_urls ? form.contract_attachment_urls.split(',').map((u) => u.trim()) : [],
      }, kind)
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
        ...Object.entries(allErrors).filter(([k]) => k !== 'items').map(([k, message]) => ({ id: k.replace(/_/g, '-'), message })),
        ...(allErrors.items ? [{ id: 'contract-lines', message: allErrors.items }] : []),
        ...Object.entries(lineErrors).flatMap(([i, le]) => Object.values(le).map((m) => ({ id: 'contract-lines', message: `Line ${Number(i) + 1}: ${m.toLowerCase()}` }))),
      ]
    : []
  const lineCount = lines.filter((l) => !isBlank(l)).length

  return (
    <form onSubmit={(e) => { e.preventDefault(); save('draft') }} className="mx-auto max-w-5xl space-y-5" noValidate>
      <PageHeader
        title={title}
        description={description}
        meta={meta || (draftKey && savedAt ? <span aria-live="polite">Draft saved in this browser {new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> : null)}
      />

      {draftKey && restored && (
        <InlineNotice tone="ink" title="Picked up where you left off" action={<Button size="sm" variant="ghost" onClick={discard}>Start over</Button>}>
          This contract was restored from a draft saved in this browser{savedAt ? ` at ${new Date(savedAt).toLocaleString()}` : ''}.
        </InlineNotice>
      )}
      {serverError && (
        <InlineNotice tone="risk" title="The contract was not saved">
          {serverError.message} Nothing was lost — your entries are still here.{serverError.reference && <> Reference <span className="font-mono">{serverError.reference}</span>.</>}
        </InlineNotice>
      )}
      <ErrorSummary errors={summaryErrors} />

      <FormSection title="Agreement">
        <Field label="Contract name" required error={errors.contract_name} className="sm:col-span-2" id="contract-name">
          <Input value={form.contract_name} onChange={(e) => setForm({ contract_name: e.target.value })} onBlur={blur('contract_name')} />
        </Field>
        <Field label="Contract type" id="contract-type">
          <Select value={form.contract_type} onChange={(e) => setForm({ contract_type: e.target.value })}>
            <option value="SALES">Sales</option>
            <option value="PURCHASE">Purchase</option>
            <option value="FRAMEWORK">Framework</option>
            <option value="SERVICE">Service</option>
          </Select>
        </Field>
        <Field label="Currency" id="currency">
          <Select value={form.currency} onChange={(e) => setForm({ currency: e.target.value })}>
            {['USD', 'EUR', 'GBP', 'SAR'].map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </Field>
        <Field label="Contract value" optional help="The total the agreement is expected to be worth." id="contract-value">
          <Input type="number" step="0.01" min="0" numeric value={form.contract_value} onChange={(e) => setForm({ contract_value: e.target.value })} suffix={form.currency} />
        </Field>
      </FormSection>

      <FormSection title="Party" description={exclusiveParty ? 'A contract is with either a customer or a supplier; choosing one clears the other.' : 'Usually a customer. Add the supplier for a back-to-back agreement.'}>
        <Field label="Customer" optional id="customer">
          <Select value={form.customer_id} onChange={(e) => chooseCustomer(e.target.value)}>
            <option value="">No customer</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.customer_name}</option>)}
          </Select>
        </Field>
        <Field label="Supplier" optional id="supplier">
          <Select value={form.supplier_id} onChange={(e) => chooseSupplier(e.target.value)}>
            <option value="">No supplier</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.legal_name}</option>)}
          </Select>
        </Field>
      </FormSection>

      <FormSection title="Period">
        <Field label="Start date" required error={errors.start_date} id="start-date">
          <Input type="date" value={form.start_date} onChange={(e) => setForm({ start_date: e.target.value })} onBlur={blur('start_date')} />
        </Field>
        <Field label="End date" required error={errors.end_date} id="end-date">
          <Input type="date" min={form.start_date || undefined} value={form.end_date} onChange={(e) => setForm({ end_date: e.target.value })} onBlur={blur('end_date')} />
        </Field>
        <Field label="Expiry notice" help="How long before the end date the contract shows as expiring." id="expiry-notification-days">
          <Input type="number" min="0" value={form.days_before_expiry_notification} onChange={(e) => setForm({ days_before_expiry_notification: e.target.value })} suffix="days" />
        </Field>
        <div className="space-y-2">
          <Checkbox label="Renews automatically" checked={Boolean(form.auto_renewal)} onChange={(e) => setForm({ auto_renewal: e.target.checked })} />
          {form.auto_renewal && (
            <Field label="Renewal period" id="renewal-period">
              <Input type="number" min="1" value={form.renewal_period_months} onChange={(e) => setForm({ renewal_period_months: e.target.value })} suffix="months" />
            </Field>
          )}
        </div>
      </FormSection>

      <section aria-labelledby="contract-lines-h" className="space-y-2" id="contract-lines" tabIndex={-1}>
        <div>
          <h2 id="contract-lines-h" className="text-sm font-semibold text-fg">Lines</h2>
          <p className="text-xs text-ink-500">The items this contract fixes a price for. Pick an inventory item to fill code, name, unit and price, or type a free-text line.</p>
        </div>
        {submitted && allErrors.items && <p className="text-xs text-risk-600" role="alert">{allErrors.items}</p>}
        <LineItemEditor
          label="Contract lines"
          rows={lines}
          onChange={setLines}
          newRow={blankLine}
          errors={submitted ? lineErrors : {}}
          currency={form.currency}
          transform={(row, key, val) => {
            if (key !== 'inventory_item_id' || !val) return row
            const it = inventory.find((x) => x.id === val)
            return it ? { ...row, item_code: it.item_code || it.approved_item_code || '', item_name: it.item_name, item_description: it.description || '', unit_of_measure: it.unit_of_measure || 'PCS', unit_price: String(it.unit_price ?? '') } : row
          }}
          columns={[
            { key: 'inventory_item_id', header: 'Inventory item', type: 'select', minWidth: 190, placeholder: 'Free text', options: inventory.map((i) => ({ value: i.id, label: `${i.item_code || i.approved_item_code || ''} · ${i.item_name}` })) },
            { key: 'item_code', header: 'Code', type: 'text', minWidth: 110 },
            { key: 'item_name', header: 'Item name', type: 'text', minWidth: 180, required: true },
            { key: 'unit_price', header: 'Agreed price', type: 'money', minWidth: 120, required: true },
            { key: 'unit_of_measure', header: 'Unit', type: 'text', minWidth: 70, required: true, placeholder: 'PCS' },
            { key: 'minimum_quantity', header: 'Min qty', type: 'number', minWidth: 90 },
            { key: 'maximum_quantity', header: 'Max qty', type: 'number', minWidth: 90 },
            { key: 'lead_time_days', header: 'Lead days', type: 'number', minWidth: 90 },
            { key: 'item_description', header: 'Description', type: 'text', minWidth: 200 },
          ]}
        />
      </section>

      <FormSection title="Terms">
        <Field label="Payment terms" optional id="payment-terms">
          <Input value={form.payment_terms} onChange={(e) => setForm({ payment_terms: e.target.value })} placeholder="e.g. Net 30 days" />
        </Field>
        <Field label="Incoterms" optional id="incoterms">
          <Input value={form.incoterms} onChange={(e) => setForm({ incoterms: e.target.value })} placeholder="e.g. FOB, CIF, EXW" />
        </Field>
        <Field label="Delivery terms" optional id="delivery-terms">
          <Input value={form.delivery_terms} onChange={(e) => setForm({ delivery_terms: e.target.value })} />
        </Field>
        <Field label="Delivery location" optional id="delivery-location">
          <Input value={form.delivery_location} onChange={(e) => setForm({ delivery_location: e.target.value })} />
        </Field>
        <Field label="Terms and conditions" optional className="sm:col-span-2" id="terms-and-conditions">
          <Textarea rows={4} value={form.terms_and_conditions} onChange={(e) => setForm({ terms_and_conditions: e.target.value })} />
        </Field>
        <Field label="Special conditions" optional className="sm:col-span-2" id="special-conditions">
          <Textarea rows={3} value={form.special_conditions} onChange={(e) => setForm({ special_conditions: e.target.value })} />
        </Field>
      </FormSection>

      <FormSection title="Notes" description="External and internal notes" advanced defaultOpen={Boolean(form.notes || form.internal_notes)}>
        <Field label="External notes" optional help="Visible to the other party." id="notes">
          <Textarea rows={3} value={form.notes} onChange={(e) => setForm({ notes: e.target.value })} />
        </Field>
        <Field label="Internal notes" optional help="Only your team sees these." id="internal-notes">
          <Textarea rows={3} value={form.internal_notes} onChange={(e) => setForm({ internal_notes: e.target.value })} />
        </Field>
      </FormSection>

      <div className="sticky bottom-0 z-10 -mx-4 border-t border-ink-200 bg-canvas/95 px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="mr-auto text-sm">
            <span className="text-ink-600">Value </span>
            {form.contract_value !== '' && form.contract_value != null ? <Money amount={form.contract_value} currency={form.currency} className="text-base font-semibold" /> : <span className="text-ink-400">—</span>}
            <span className="ml-2 text-xs text-ink-500">{lineCount} line{lineCount === 1 ? '' : 's'}</span>
          </div>
          <Button variant="ghost" to={cancelTo}>Cancel</Button>
          {actions({ save, saving })}
        </div>
      </div>
    </form>
  )
}

export default function SalesContractCreate() {
  const navigate = useNavigate()
  const initial = useMemo(() => ({
    form: {
      contract_name: '', customer_id: '', customer_name: '', supplier_id: '', supplier_name: '', contract_type: 'SALES', contract_value: '',
      currency: 'USD', payment_terms: '', incoterms: '', start_date: '', end_date: '', auto_renewal: false, renewal_period_months: 12,
      default_lead_time_days: 30, delivery_terms: '', delivery_location: '', signed_contract_url: '', contract_attachment_urls: '',
      terms_and_conditions: '', special_conditions: '', days_before_expiry_notification: 30, linked_rfq_id: '', linked_quotation_id: '',
      notes: '', internal_notes: '',
    },
    lines: [blankLine()],
  }), [])

  const onSave = async (payload, kind) => {
    const res = await api.post('/sales-contracts', payload)
    if (!res.data?.success) throw Object.assign(new Error(res.data?.error || 'The contract was not created.'), { response: { data: res.data } })
    const c = res.data.data
    const name = c?.contract_number || 'Contract'
    if (kind === 'approval') {
      try {
        const ap = await api.post(`/sales-contracts/${c.id}/request-approval`)
        if (!ap.data?.success) throw new Error(ap.data?.error)
        notify.success(`${name} created and sent for approval`)
      } catch (e) {
        notify.error(`${name} was created but not sent for approval${e?.response?.data?.error || e.message ? `: ${e?.response?.data?.error || e.message}` : ''}. Send it from the contract.`)
      }
    } else {
      notify.success(`${name} saved as a draft`)
    }
    navigate(c?.id ? `/sales/contracts/${c.id}` : '/sales/contracts')
  }

  return (
    <ContractForm
      title="New sales contract"
      description="Fix prices and quantities with a customer for a period. Save a draft, or send it for approval now."
      initialValue={initial}
      draftKey="sales-contract:new"
      cancelTo="/sales/contracts"
      onSave={onSave}
      actions={({ save, saving }) => (
        <>
          <Button type="submit" loading={saving === 'draft'} disabled={Boolean(saving)}>Save draft</Button>
          <Button variant="primary" loading={saving === 'approval'} disabled={Boolean(saving)} onClick={() => save('approval')}>Send for approval</Button>
        </>
      )}
    />
  )
}
