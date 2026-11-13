import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../../../services/api'
import { useResource } from '../../../hooks/useResource'
import {
  PageHeader, Button, Field, Input, Select, Textarea, FormSection, ErrorSummary, InlineNotice, Money, useDraft, notify,
} from '../../../components/ui'

/**
 * New purchase requisition — one item, against a cost centre.
 *
 * Payload, validation rules and data-testids are unchanged from the previous
 * screen (the cross-module journey drives this form by test id). The form
 * autosaves to this browser so a half-written request is never lost.
 */
const INITIAL = {
  cost_center: '',
  item_id: '',
  item_description: '',
  unit_of_measure: '',
  quantity: '',
  estimated_unit_price: '',
  currency: 'USD',
  recommended_supplier_id: '',
  supplier_recommendation_text: '',
  attachments: [],
}

const ITEMS_PARAMS = { status: 'APPROVED', limit: 100 }

function validate(f) {
  const e = {}
  if (!f.cost_center.trim()) e.cost_center = 'Enter the cost centre this is charged to, for example IT-001.'
  // A PR references a real item master; the backend rejects an empty uuid.
  if (!f.item_id) e.item_id = 'Pick the item from the approved list.'
  if (!f.item_description.trim()) e.item_description = 'Describe what is needed.'
  if (!f.quantity || parseFloat(f.quantity) <= 0) e.quantity = 'Enter a quantity above zero.'
  if (!f.estimated_unit_price || parseFloat(f.estimated_unit_price) <= 0) e.estimated_unit_price = 'Enter an estimated unit price above zero so the value can be routed for approval.'
  return e
}

export default function PurchaseRequisitionCreate() {
  const navigate = useNavigate()
  const { value: form, setValue, restored, savedAt, clear, discard } = useDraft('pr:new', INITIAL)
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(null) // 'draft' | 'approval'
  const [serverError, setServerError] = useState(null)

  const { data: itemsData } = useResource(['items', ITEMS_PARAMS], ({ signal }) => api.get('/items', { params: ITEMS_PARAMS, signal }))
  const items = Array.isArray(itemsData) ? itemsData : []

  // Suppliers narrow to whoever can provide the selected item; if that
  // endpoint fails the general active list is used instead.
  const { data: suppliersData, loading: suppliersLoading } = useResource(
    ['suppliers', form.item_id ? { forItem: form.item_id } : 'active'],
    async ({ signal }) => {
      if (!form.item_id) return api.get('/suppliers/active', { signal })
      try {
        return await api.get(`/suppliers/by-item/${form.item_id}`, { signal })
      } catch {
        return api.get('/suppliers/active', { signal })
      }
    }
  )
  const suppliers = Array.isArray(suppliersData) ? suppliersData : []

  const allErrors = useMemo(() => validate(form), [form])
  const errors = submitted ? allErrors : Object.fromEntries(Object.entries(allErrors).filter(([k]) => touched[k]))
  const blur = (k) => () => setTouched((t) => ({ ...t, [k]: true }))

  const set = (name) => (e) => {
    const v = e.target.value
    setValue((prev) => {
      const next = { ...prev, [name]: v }
      if (name === 'item_id') {
        next.recommended_supplier_id = ''
        next.supplier_recommendation_text = ''
        const it = items.find((i) => i.id === v)
        if (it) {
          next.item_description = it.name
          next.unit_of_measure = it.unit_of_measure || ''
        }
      }
      return next
    })
  }

  const save = async (submitType) => {
    setSubmitted(true)
    setServerError(null)
    if (Object.keys(allErrors).length) return
    setSaving(submitType)
    try {
      const res = await api.post('/purchase-requisitions', {
        ...form,
        quantity: parseFloat(form.quantity),
        estimated_unit_price: form.estimated_unit_price ? parseFloat(form.estimated_unit_price) : null,
        item_id: form.item_id || null,
        recommended_supplier_id: form.recommended_supplier_id || null,
        status: submitType === 'approval' ? 'PENDING_APPROVAL' : 'DRAFT',
      })
      clear()
      const pr = res.data?.data
      notify.success(`${pr?.pr_number || 'Requisition'} ${submitType === 'approval' ? 'submitted for approval' : 'saved as a draft'}`)
      navigate('/procurement/purchase-requisitions')
    } catch (err) {
      const d = err?.response?.data || {}
      setServerError({ message: d.error || err.message, reference: d.error_id })
    } finally {
      setSaving(null)
    }
  }

  const total = (parseFloat(form.quantity) || 0) * (parseFloat(form.estimated_unit_price) || 0)
  const summaryErrors = submitted ? Object.entries(allErrors).map(([id, message]) => ({ id, message })) : []

  return (
    <form onSubmit={(e) => { e.preventDefault(); save('draft') }} className="mx-auto max-w-3xl space-y-5" noValidate>
      <PageHeader
        title="New purchase requisition"
        description="Ask for something to be bought. Save a draft to finish later, or submit it for approval now."
        meta={savedAt ? <span aria-live="polite">Draft saved in this browser {new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> : null}
      />

      {restored && (
        <InlineNotice tone="ink" title="Picked up where you left off" action={<Button size="sm" variant="ghost" onClick={discard}>Start over</Button>}>
          This requisition was restored from a draft saved in this browser.
        </InlineNotice>
      )}
      {serverError && (
        <InlineNotice tone="risk" title="The requisition was not saved">
          {serverError.message} Your entries are still here.{serverError.reference && <> Reference <span className="font-mono">{serverError.reference}</span>.</>}
        </InlineNotice>
      )}
      <ErrorSummary errors={summaryErrors} />

      <FormSection title="What is needed">
        <Field label="Cost centre" required error={errors.cost_center} help="The budget this is charged to. Approval follows the cost centre's delegated authority." className="sm:col-span-2" id="cost_center">
          <Input name="cost_center" data-testid="pr-cost-center" value={form.cost_center} onChange={set('cost_center')} onBlur={blur('cost_center')} placeholder="e.g. IT-001, MAINT-002" />
        </Field>
        <Field label="Item" required error={errors.item_id} help="Only approved catalog items are listed. Picking one fills the description and unit." className="sm:col-span-2" id="item_id">
          <Select name="item_id" data-testid="pr-item" value={form.item_id} onChange={set('item_id')} onBlur={blur('item_id')}>
            <option value="">Choose from approved items…</option>
            {items.map((it) => <option key={it.id} value={it.id}>{it.approved_item_code} - {it.name}</option>)}
          </Select>
        </Field>
        <Field label="Description" required error={errors.item_description} className="sm:col-span-2" id="item_description">
          <Textarea name="item_description" data-testid="pr-item-description" rows={3} value={form.item_description} onChange={set('item_description')} onBlur={blur('item_description')} placeholder="What is needed and why, in enough detail for a buyer to source it" />
        </Field>
        <Field label="Unit of measure" optional id="unit_of_measure">
          <Input name="unit_of_measure" data-testid="pr-unit-of-measure" value={form.unit_of_measure} onChange={set('unit_of_measure')} placeholder="EA, KG, M, HRS" />
        </Field>
        <Field label="Quantity" required error={errors.quantity} id="quantity">
          <Input type="number" step="0.01" min="0.01" numeric name="quantity" data-testid="pr-quantity" value={form.quantity} onChange={set('quantity')} onBlur={blur('quantity')} placeholder="1.00" />
        </Field>
        <Field label="Estimated unit price" required error={errors.estimated_unit_price} id="estimated_unit_price">
          <Input type="number" step="0.01" min="0" numeric name="estimated_unit_price" data-testid="pr-estimated-unit-price" value={form.estimated_unit_price} onChange={set('estimated_unit_price')} onBlur={blur('estimated_unit_price')} placeholder="0.00" />
        </Field>
        <Field label="Currency" id="currency">
          <Select name="currency" data-testid="pr-currency" value={form.currency} onChange={set('currency')}>
            <option value="USD">USD — US dollar</option>
            <option value="EUR">EUR — Euro</option>
            <option value="GBP">GBP — British pound</option>
            <option value="CAD">CAD — Canadian dollar</option>
            <option value="JPY">JPY — Japanese yen</option>
          </Select>
        </Field>
      </FormSection>

      <FormSection title="Supplier" description="Optional. Helps the buyer, but the RFQ or order decides the supplier.">
        <Field label="Recommended supplier" optional help={form.item_id ? 'Suppliers who list this item; all active suppliers if none do.' : 'All active suppliers. Pick an item first to narrow the list.'} className="sm:col-span-2" id="recommended_supplier_id">
          <Select name="recommended_supplier_id" data-testid="pr-recommended-supplier" value={form.recommended_supplier_id} onChange={set('recommended_supplier_id')}>
            <option value="">{suppliersLoading ? 'Loading suppliers…' : 'No recommendation'}</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.supplier_code} - {s.legal_name}</option>)}
          </Select>
        </Field>
        <Field label="Why this supplier" optional className="sm:col-span-2" id="supplier_recommendation_text">
          <Textarea name="supplier_recommendation_text" data-testid="pr-supplier-recommendation-text" rows={3} value={form.supplier_recommendation_text} onChange={set('supplier_recommendation_text')} placeholder="Past performance, lead time, sole source…" />
        </Field>
      </FormSection>

      <div className="sticky bottom-0 z-10 -mx-4 border-t border-ink-200 bg-canvas/95 px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="mr-auto text-sm">
            <span className="text-ink-600">Estimated total </span>
            <Money amount={total || null} currency={form.currency} className="text-base font-semibold" />
          </div>
          <Button variant="ghost" onClick={() => navigate('/procurement/purchase-requisitions')}>Cancel</Button>
          <Button type="submit" data-testid="pr-submit-draft" loading={saving === 'draft'} disabled={Boolean(saving)}>Save draft</Button>
          <Button variant="primary" data-testid="pr-submit-approval" loading={saving === 'approval'} disabled={Boolean(saving)} onClick={() => save('approval')}>Submit for approval</Button>
        </div>
      </div>
    </form>
  )
}
