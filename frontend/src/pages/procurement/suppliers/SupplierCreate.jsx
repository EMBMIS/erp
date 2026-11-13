import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../../../services/api'
import {
  PageHeader, Button, Field, Input, Select, Textarea, FormSection, ErrorSummary, InlineNotice, useDraft, notify,
} from '../../../components/ui'

/**
 * New supplier. Payload and validation are unchanged from the previous
 * screen. Saving a draft keeps it private; submitting sends it to a manager
 * with supplier authority, and on approval the supplier is emailed to confirm.
 */
const INITIAL = {
  legal_name: '',
  trade_name: '',
  email: '',
  phone: '',
  address: '',
  country: '',
  city: '',
  postal_code: '',
  supplier_type: 'TRANSACTIONAL',
  certification_status: 'PENDING',
  payment_terms: '30 DAYS NET',
  currency: 'USD',
}

function validate(f) {
  const e = {}
  if (!f.legal_name.trim()) e.legal_name = 'Enter the registered company name.'
  if (!f.email.trim()) e.email = 'Enter an email address; approval and partnership emails go here.'
  else if (!/\S+@\S+\.\S+/.test(f.email)) e.email = 'Enter an email address like orders@supplier.com.'
  if (!f.country.trim()) e.country = 'Enter the country.'
  if (!f.city.trim()) e.city = 'Enter the city.'
  return e
}

export default function SupplierCreate() {
  const navigate = useNavigate()
  const { value: form, setValue, restored, savedAt, clear, discard } = useDraft('supplier:new', INITIAL)
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(null) // 'draft' | 'submit'
  const [serverError, setServerError] = useState(null)

  const allErrors = useMemo(() => validate(form), [form])
  const errors = submitted ? allErrors : Object.fromEntries(Object.entries(allErrors).filter(([k]) => touched[k]))
  const blur = (k) => () => setTouched((t) => ({ ...t, [k]: true }))
  const set = (k) => (e) => setValue((f) => ({ ...f, [k]: e.target.value }))

  const save = async (submitForApproval) => {
    setSubmitted(true)
    setServerError(null)
    if (Object.keys(allErrors).length) return
    setSaving(submitForApproval ? 'submit' : 'draft')
    try {
      const res = await api.post('/suppliers', { ...form, status: submitForApproval ? 'PENDING_APPROVAL' : 'DRAFT' })
      clear()
      const s = res.data?.data
      notify.success(`${s?.legal_name || form.legal_name} ${submitForApproval ? 'created and submitted for approval' : 'saved as a draft'}`)
      navigate(s?.id ? `/procurement/suppliers/${s.id}` : '/procurement/suppliers')
    } catch (err) {
      const d = err?.response?.data || {}
      setServerError({ message: d.error || err.message, reference: d.error_id })
    } finally {
      setSaving(null)
    }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); save(false) }} className="mx-auto max-w-3xl space-y-5" noValidate>
      <PageHeader
        title="New supplier"
        description="Add a company you buy from. It can be used on orders once a manager approves it and the supplier confirms."
        meta={savedAt ? <span aria-live="polite">Draft saved in this browser {new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> : null}
      />

      {restored && (
        <InlineNotice tone="ink" title="Picked up where you left off" action={<Button size="sm" variant="ghost" onClick={discard}>Start over</Button>}>
          This supplier was restored from a draft saved in this browser.
        </InlineNotice>
      )}
      {serverError && (
        <InlineNotice tone="risk" title="The supplier was not saved">
          {serverError.message} Your entries are still here.{serverError.reference && <> Reference <span className="font-mono">{serverError.reference}</span>.</>}
        </InlineNotice>
      )}
      <ErrorSummary errors={submitted ? Object.entries(allErrors).map(([id, message]) => ({ id, message })) : []} />

      <FormSection title="Company">
        <Field label="Legal name" required error={errors.legal_name} className="sm:col-span-2" id="legal_name">
          <Input name="legal_name" value={form.legal_name} onChange={set('legal_name')} onBlur={blur('legal_name')} placeholder="Official registered company name" />
        </Field>
        <Field label="Trade name" optional help="Only if they trade under a different name." className="sm:col-span-2" id="trade_name">
          <Input name="trade_name" value={form.trade_name} onChange={set('trade_name')} />
        </Field>
        <Field label="Type" id="supplier_type" help="Strategic and preferred suppliers are favoured in sourcing suggestions.">
          <Select name="supplier_type" value={form.supplier_type} onChange={set('supplier_type')}>
            <option value="TRANSACTIONAL">Transactional</option>
            <option value="STRATEGIC">Strategic</option>
            <option value="PREFERRED">Preferred</option>
          </Select>
        </Field>
      </FormSection>

      <FormSection title="Contact">
        <Field label="Email" required error={errors.email} id="email">
          <Input type="email" name="email" value={form.email} onChange={set('email')} onBlur={blur('email')} placeholder="orders@supplier.com" />
        </Field>
        <Field label="Phone" optional id="phone">
          <Input type="tel" name="phone" value={form.phone} onChange={set('phone')} placeholder="+1 555 123 4567" />
        </Field>
        <Field label="Address" optional className="sm:col-span-2" id="address">
          <Textarea name="address" rows={2} value={form.address} onChange={set('address')} placeholder="Street, building, unit" />
        </Field>
        <Field label="City" required error={errors.city} id="city">
          <Input name="city" value={form.city} onChange={set('city')} onBlur={blur('city')} />
        </Field>
        <Field label="Country" required error={errors.country} id="country">
          <Input name="country" value={form.country} onChange={set('country')} onBlur={blur('country')} />
        </Field>
        <Field label="Postal code" optional id="postal_code">
          <Input name="postal_code" value={form.postal_code} onChange={set('postal_code')} />
        </Field>
      </FormSection>

      <FormSection title="Terms" description="Payment terms and currency" advanced defaultOpen={form.payment_terms !== '30 DAYS NET' || form.currency !== 'USD'}>
        <Field label="Payment terms" id="payment_terms">
          <Select name="payment_terms" value={form.payment_terms} onChange={set('payment_terms')}>
            <option value="15 DAYS NET">15 days net</option>
            <option value="30 DAYS NET">30 days net</option>
            <option value="45 DAYS NET">45 days net</option>
            <option value="60 DAYS NET">60 days net</option>
            <option value="NET 10">Net 10</option>
            <option value="NET 15">Net 15</option>
            <option value="NET 30">Net 30</option>
            <option value="COD">Cash on delivery</option>
            <option value="PREPAID">Prepaid</option>
          </Select>
        </Field>
        <Field label="Currency" id="currency">
          <Select name="currency" value={form.currency} onChange={set('currency')}>
            {['USD', 'EUR', 'GBP', 'CAD', 'JPY', 'AUD'].map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </Field>
      </FormSection>

      <div className="sticky bottom-0 z-10 -mx-4 border-t border-ink-200 bg-canvas/95 px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center justify-end gap-3">
          <p className="mr-auto hidden text-xs text-ink-500 sm:block">A supplier code is assigned when it is saved.</p>
          <Button variant="ghost" onClick={() => navigate('/procurement/suppliers')}>Cancel</Button>
          <Button type="submit" loading={saving === 'draft'} disabled={Boolean(saving)}>Save draft</Button>
          <Button variant="primary" loading={saving === 'submit'} disabled={Boolean(saving)} onClick={() => save(true)}>Submit for approval</Button>
        </div>
      </div>
    </form>
  )
}
