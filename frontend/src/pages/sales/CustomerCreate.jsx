import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import {
  PageHeader, Button, Field, Input, Select, Textarea, Checkbox, FormSection, ErrorSummary, InlineNotice,
  useDraft, notify,
} from '../../components/ui'

/**
 * New customer, and the form CustomerEdit shares.
 *
 * Sections, not a wall: who they are, how to reach them, where to bill and
 * ship, and credit terms. Contact people, tax and notes fold away. The create
 * form autosaves to this browser. Payload is unchanged from the previous
 * screen: every field below is sent as-is to POST/PUT /customers.
 */
const EMPTY_CUSTOMER = {
  customer_name: '', legal_entity_name: '', customer_type: 'COMPANY',
  primary_email: '', secondary_email: '', phone: '', mobile: '', fax: '', website: '',
  billing_address_line1: '', billing_address_line2: '', billing_city: '', billing_state: '', billing_country: '', billing_postal_code: '',
  shipping_address_line1: '', shipping_address_line2: '', shipping_city: '', shipping_state: '', shipping_country: '', shipping_postal_code: '',
  use_billing_as_shipping: true,
  currency: 'USD', credit_limit: '', credit_days: '30', payment_terms: '',
  late_delivery_penalty: '', late_delivery_penalty_per_day: '',
  tax_number: '', vat_number: '', tax_exempt: false, tax_rate: '',
  primary_contact_name: '', primary_contact_title: '', primary_contact_email: '', primary_contact_phone: '',
  secondary_contact_name: '', secondary_contact_title: '', secondary_contact_email: '', secondary_contact_phone: '',
  status: 'ACTIVE', customer_category: '', customer_group: '', sales_rep_id: '', credit_risk_level: 'LOW', credit_check_required: false,
  notes: '', internal_notes: '',
}

const ADDRESS = ['address_line1', 'address_line2', 'city', 'state', 'country', 'postal_code']
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function validate(f) {
  const e = {}
  if (!f.customer_name?.trim()) e.customer_name = 'Enter the customer name.'
  if (f.primary_email && !EMAIL.test(f.primary_email)) e.primary_email = 'Enter an email like name@company.com.'
  if (f.secondary_email && !EMAIL.test(f.secondary_email)) e.secondary_email = 'Enter an email like name@company.com.'
  if (f.credit_limit !== '' && f.credit_limit != null && Number(f.credit_limit) < 0) e.credit_limit = 'Credit limit cannot be negative.'
  return e
}

/** The customer form. `form` / `setForm(patch)` are controlled by the page. */
export function CustomerForm({ form, setForm, onSubmit, saving, serverError, mode = 'create', cancelTo, idPrefix = '' }) {
  const navigate = useNavigate()
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const allErrors = useMemo(() => validate(form), [form])
  const errors = submitted ? allErrors : Object.fromEntries(Object.entries(allErrors).filter(([k]) => touched[k]))
  const blur = (k) => () => setTouched((t) => ({ ...t, [k]: true }))

  const { data: repsData } = useResource(['users', 'sales-reps'], ({ signal }) => api.get('/users/sales-reps', { signal }))
  const reps = Array.isArray(repsData) ? repsData : []

  const set = (field, value) => {
    const patch = { [field]: value }
    // Billing copies to shipping while "same as billing" is ticked.
    if (field.startsWith('billing_') && form.use_billing_as_shipping) patch[field.replace('billing_', 'shipping_')] = value
    setForm(patch)
  }
  const sameAsBilling = (checked) => {
    const patch = { use_billing_as_shipping: checked }
    if (checked) ADDRESS.forEach((k) => { patch[`shipping_${k}`] = form[`billing_${k}`] })
    setForm(patch)
  }
  const text = (field, props = {}) => ({ value: form[field] ?? '', onChange: (e) => set(field, e.target.value), ...props })
  const fid = (k) => `${idPrefix}${k}`

  const submit = (e) => {
    e.preventDefault()
    setSubmitted(true)
    if (Object.keys(allErrors).length) return
    onSubmit()
  }

  const address = (kind) => (
    <>
      <Field label="Address line 1" className="sm:col-span-2" id={`${kind}-address-line-1`}><Input {...text(`${kind}_address_line1`)} placeholder="Street address" autoComplete="address-line1" /></Field>
      <Field label="Address line 2" optional className="sm:col-span-2" id={`${kind}-address-line-2`}><Input {...text(`${kind}_address_line2`)} placeholder="Building, suite, floor" autoComplete="address-line2" /></Field>
      <Field label="City" id={`${kind}-city`}><Input {...text(`${kind}_city`)} autoComplete="address-level2" /></Field>
      <Field label="State or province" optional id={`${kind}-state`}><Input {...text(`${kind}_state`)} autoComplete="address-level1" /></Field>
      <Field label="Postal code" id={`${kind}-postal-code`}><Input {...text(`${kind}_postal_code`)} autoComplete="postal-code" /></Field>
      <Field label="Country" id={`${kind}-country`}><Input {...text(`${kind}_country`)} autoComplete="country-name" /></Field>
    </>
  )

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      {serverError && (
        <InlineNotice tone="risk" title={mode === 'create' ? 'The customer was not created' : 'Your changes were not saved'}>
          {serverError.message} Nothing was lost — your entries are still here.{serverError.reference && <> Reference <span className="font-mono">{serverError.reference}</span>.</>}
        </InlineNotice>
      )}
      <ErrorSummary errors={submitted ? Object.entries(allErrors).map(([k, message]) => ({ id: fid(k), message })) : []} />

      <FormSection title="Customer">
        <Field label="Customer name" required error={errors.customer_name} help="The name used on quotations, orders and invoices." id={fid('customer_name')}>
          <Input {...text('customer_name')} data-testid="customer-name" onBlur={blur('customer_name')} placeholder="e.g. Harbour Marine Supply" autoComplete="organization" />
        </Field>
        <Field label="Legal entity name" optional help="If the registered name differs." id={fid('legal_entity_name')}>
          <Input {...text('legal_entity_name')} />
        </Field>
        <Field label="Customer type" id={fid('customer_type')}>
          <Select {...text('customer_type')}>
            <option value="COMPANY">Company</option>
            <option value="INDIVIDUAL">Individual</option>
            <option value="GOVERNMENT">Government</option>
            <option value="NON_PROFIT">Non-profit</option>
          </Select>
        </Field>
        <Field label="Sales representative" optional help={reps.length ? undefined : 'No users with a sales role yet.'} id={fid('sales_rep_id')}>
          <Select {...text('sales_rep_id')}>
            <option value="">Not assigned</option>
            {reps.map((r) => <option key={r.id} value={r.id}>{[r.first_name, r.last_name].filter(Boolean).join(' ') || r.email}</option>)}
          </Select>
        </Field>
        {mode === 'edit' && (
          <Field label="Status" help="Blocked and inactive customers cannot be sold to." id={fid('status')}>
            <Select {...text('status')}>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
              <option value="BLOCKED">Blocked</option>
              <option value="PENDING_APPROVAL">Pending approval</option>
            </Select>
          </Field>
        )}
      </FormSection>

      <FormSection title="How to reach them">
        <Field label="Primary email" optional error={errors.primary_email} help="Quotations and order confirmations go here." id="primary-email">
          <Input type="email" {...text('primary_email')} onBlur={blur('primary_email')} placeholder="orders@company.com" autoComplete="email" />
        </Field>
        <Field label="Secondary email" optional error={errors.secondary_email} id="secondary-email">
          <Input type="email" {...text('secondary_email')} onBlur={blur('secondary_email')} />
        </Field>
        <Field label="Phone" optional id="phone"><Input type="tel" {...text('phone')} autoComplete="tel" /></Field>
        <Field label="Mobile" optional id="mobile"><Input type="tel" {...text('mobile')} /></Field>
        <Field label="Website" optional id="website"><Input type="url" {...text('website')} placeholder="https://" /></Field>
      </FormSection>

      <FormSection title="Billing address" description="Printed on invoices. Sales orders default their delivery address to it.">
        {address('billing')}
        <Checkbox className="sm:col-span-2" label="Ship to the billing address" checked={!!form.use_billing_as_shipping} onChange={(e) => sameAsBilling(e.target.checked)} />
      </FormSection>

      {!form.use_billing_as_shipping && (
        <FormSection title="Shipping address">
          {address('shipping')}
        </FormSection>
      )}

      <FormSection title="Credit and payment">
        <Field label="Currency" id={fid('currency')}>
          <Select {...text('currency')}>
            {['USD', 'EUR', 'GBP', 'CAD', 'AUD'].map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </Field>
        <Field label="Credit limit" optional error={errors.credit_limit} help="Leave empty for no limit set." id={fid('credit_limit')}>
          <Input type="number" min="0" step="0.01" numeric {...text('credit_limit')} onBlur={blur('credit_limit')} suffix={form.currency} />
        </Field>
        <Field label="Credit days" help="Days the customer has to pay." id={fid('credit_days')}>
          <Input type="number" min="0" numeric {...text('credit_days')} />
        </Field>
        <Field label="Payment terms" optional id="payment-terms">
          <Input {...text('payment_terms')} placeholder="e.g. NET_30, COD" />
        </Field>
        <Field label="Late-delivery penalty" optional help="Charged per order delivered after its promised date. Simeli weighs every delivery fix against it." id={fid('late_delivery_penalty')}>
          <Input type="number" min="0" step="0.01" numeric {...text('late_delivery_penalty')} suffix={form.currency} />
        </Field>
        <Field label="Penalty per day late" optional id={fid('late_delivery_penalty_per_day')}>
          <Input type="number" min="0" step="0.01" numeric {...text('late_delivery_penalty_per_day')} suffix={form.currency} />
        </Field>
        <Field label="Credit risk" id={fid('credit_risk_level')}>
          <Select {...text('credit_risk_level')}>
            <option value="LOW">Low</option>
            <option value="MEDIUM">Medium</option>
            <option value="HIGH">High</option>
            <option value="BLOCKED">Blocked</option>
          </Select>
        </Field>
        <div className="flex flex-col justify-end gap-2 pb-1">
          <Checkbox label="Credit check required" checked={!!form.credit_check_required} onChange={(e) => set('credit_check_required', e.target.checked)} />
          <Checkbox label="Tax exempt" checked={!!form.tax_exempt} onChange={(e) => set('tax_exempt', e.target.checked)} />
        </div>
      </FormSection>

      <FormSection title="Tax" description="Tax and VAT numbers, default tax rate" advanced defaultOpen={Boolean(form.tax_number || form.vat_number || Number(form.tax_rate))}>
        <Field label="Tax number" optional id={fid('tax_number')}><Input {...text('tax_number')} /></Field>
        <Field label="VAT number" optional id={fid('vat_number')}><Input {...text('vat_number')} /></Field>
        <Field label="Tax rate" optional help="Applied to sales order totals for this customer." id={fid('tax_rate')}>
          <Input type="number" min="0" max="100" step="0.01" numeric {...text('tax_rate')} suffix="%" />
        </Field>
      </FormSection>

      <FormSection title="Contact people" description="Primary and secondary contact" advanced defaultOpen={Boolean(form.primary_contact_name || form.secondary_contact_name)}>
        {['primary', 'secondary'].map((who) => (
          <fieldset key={who} className="grid grid-cols-1 gap-4 sm:col-span-2 sm:grid-cols-2">
            <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-500">{who === 'primary' ? 'Primary contact' : 'Secondary contact'}</legend>
            <Field label="Full name" optional id={`${who}-contact-name`}><Input {...text(`${who}_contact_name`)} /></Field>
            <Field label="Job title" optional id={`${who}-contact-title`}><Input {...text(`${who}_contact_title`)} /></Field>
            <Field label="Email" optional id={`${who}-contact-email`}><Input type="email" {...text(`${who}_contact_email`)} /></Field>
            <Field label="Phone" optional id={`${who}-contact-phone`}><Input type="tel" {...text(`${who}_contact_phone`)} /></Field>
          </fieldset>
        ))}
      </FormSection>

      <FormSection title="Notes" description="Notes and internal notes" advanced defaultOpen={Boolean(form.notes || form.internal_notes)} columns={1}>
        <Field label="Customer notes" optional id="customer-notes"><Textarea rows={3} {...text('notes')} /></Field>
        <Field label="Internal notes" optional help="Never shown to the customer." id="internal-notes"><Textarea rows={3} {...text('internal_notes')} /></Field>
      </FormSection>

      <div className="sticky bottom-0 z-10 -mx-4 border-t border-ink-200 bg-canvas/95 px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Button variant="ghost" onClick={() => navigate(cancelTo)} disabled={saving}>Cancel</Button>
          <Button type="submit" variant="primary" loading={saving} disabled={saving} data-testid="customer-submit">
            {mode === 'create' ? 'Create customer' : 'Save changes'}
          </Button>
        </div>
      </div>
    </form>
  )
}

CustomerForm.EMPTY = EMPTY_CUSTOMER

export default function CustomerCreate() {
  const navigate = useNavigate()
  const { value: form, setValue, restored, savedAt, clear, discard } = useDraft('customer:new', EMPTY_CUSTOMER)
  const setForm = (patch) => setValue((v) => ({ ...v, ...patch }))
  const [serverError, setServerError] = useState(null)
  const create = useResourceMutation((data) => api.post('/customers', data), { invalidates: [['customers']], silent: true })

  const save = async () => {
    setServerError(null)
    try {
      const customer = await create.mutateAsync(form)
      clear()
      notify.success(`${customer?.customer_name || form.customer_name} created`)
      navigate(customer?.id ? `/sales/customers/${customer.id}` : '/sales/customers')
    } catch (err) {
      const d = err?.response?.data || {}
      setServerError({ message: d.error || err.message, reference: d.error_id })
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title="New customer"
        description="Add an account you can quote, sell to and invoice."
        meta={savedAt ? <span aria-live="polite">Draft saved in this browser {new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> : null}
      />
      {restored && (
        <InlineNotice tone="ink" title="Picked up where you left off" action={<Button size="sm" variant="ghost" onClick={discard}>Start over</Button>}>
          This customer was restored from a draft saved in this browser{savedAt ? ` at ${new Date(savedAt).toLocaleString()}` : ''}.
        </InlineNotice>
      )}
      <CustomerForm form={form} setForm={setForm} onSubmit={save} saving={create.isPending} serverError={serverError} mode="create" cancelTo="/sales/customers" />
    </div>
  )
}
