import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import api from '../../../services/api'
import { useResource } from '../../../hooks/useResource'
import { keys } from '../../../services/queryKeys'
import {
  PageHeader, Button, Field, Input, Select, Textarea, Checkbox, FormSection, ErrorSummary, InlineNotice, LineItemEditor,
  Badge, formatDate, useDraft, notify,
} from '../../../components/ui'

/**
 * New request for quotation: what you need (lines), from whom (suppliers),
 * and by when. Payload is unchanged (POST /request-for-quotations with
 * line_items and suppliers). Choosing an approved requisition now actually
 * fills the form — the old screen defined that prefill but never called it.
 */
const blankLine = () => ({ id: `${Date.now()}-${Math.random()}`, item_id: '', item_description: '', unit_of_measure: '', quantity: '', specifications: '' })
const initial = (pr) => ({
  form: { title: '', description: '', response_deadline: '', currency: 'USD', purchase_requisition_id: pr || '' },
  lines: [blankLine()],
  suppliers: [],
})
const tomorrow = () => new Date(Date.now() + 864e5).toISOString().split('T')[0]

function validate(form, lines, suppliers) {
  const e = {}
  if (!form.title.trim()) e.title = 'Give the RFQ a title suppliers will understand.'
  if (!form.response_deadline) e.response_deadline = 'Set the date quotes are due.'
  else if (new Date(form.response_deadline) <= new Date()) e.response_deadline = `The deadline must be in the future — ${formatDate(tomorrow())} or later.`
  const lineErrors = {}
  let valid = 0
  lines.forEach((l, i) => {
    const hasDesc = (l.item_description || '').trim().length > 0
    const hasQty = l.quantity !== '' && l.quantity != null
    if (!hasDesc && !hasQty) return
    const le = {}
    if (!hasDesc) le.item_description = 'Describe the item'
    if (!(parseFloat(l.quantity) > 0)) le.quantity = 'Quantity above zero'
    if (Object.keys(le).length) lineErrors[i] = le
    else valid += 1
  })
  if (!valid) e.lineItems = 'Add at least one line with a description and quantity.'
  if (!suppliers.length) e.suppliers = 'Invite at least one supplier to quote.'
  return { e, lineErrors }
}

export default function RFQCreate() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const prFromUrl = searchParams.get('pr_id')
  const start = useMemo(() => initial(prFromUrl), [prFromUrl])
  const { value, setValue, restored, savedAt, clear, discard } = useDraft(`rfq:new${prFromUrl ? `:pr:${prFromUrl}` : ''}`, start)
  const { form, lines, suppliers: picked } = value
  const setForm = (patch) => setValue((v) => ({ ...v, form: { ...v.form, ...patch } }))
  const setLines = (next) => setValue((v) => ({ ...v, lines: typeof next === 'function' ? next(v.lines) : next }))
  const setPicked = (fn) => setValue((v) => ({ ...v, suppliers: fn(v.suppliers) }))

  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState(null)
  const [supplierQuery, setSupplierQuery] = useState('')

  const list = (d) => (Array.isArray(d) ? d : d?.data || [])
  const { data: rawItems } = useResource(keys.items({ status: 'APPROVED', limit: 100 }), ({ signal }) => api.get('/items', { params: { status: 'APPROVED', limit: 100 }, signal }))
  const items = list(rawItems)
  const { data: rawSuppliers, loading: suppliersLoading } = useResource(keys.suppliers({ active: true }), ({ signal }) => api.get('/suppliers/active', { signal }))
  const suppliers = list(rawSuppliers)
  const { data: rawPRs } = useResource(keys.purchaseRequisitions({ status: 'APPROVED' }), ({ signal }) => api.get('/purchase-requisitions/approved', { signal }))
  const approvedPRs = list(rawPRs)

  // Prefill from the chosen requisition, once per requisition.
  const { data: prDoc } = useResource(keys.purchaseRequisition(form.purchase_requisition_id), ({ signal }) => api.get(`/purchase-requisitions/${form.purchase_requisition_id}`, { signal }), { enabled: Boolean(form.purchase_requisition_id) })
  const applied = useRef(restored ? form.purchase_requisition_id : null)
  useEffect(() => {
    if (!prDoc || applied.current === prDoc.id || prDoc.id !== form.purchase_requisition_id) return
    applied.current = prDoc.id
    setValue((v) => ({
      ...v,
      form: { ...v.form, title: v.form.title || `RFQ for PR ${prDoc.pr_number} - ${prDoc.item_description}`, description: v.form.description || `Request for quotation based on Purchase Requisition ${prDoc.pr_number}` },
      lines: v.lines.some((l) => l.item_description || l.quantity) ? v.lines : [{ ...blankLine(), item_id: prDoc.item_id || '', item_description: prDoc.item_description || '', unit_of_measure: prDoc.unit_of_measure || '', quantity: prDoc.quantity != null ? String(prDoc.quantity) : '', specifications: prDoc.item_description || '' }],
      suppliers: prDoc.recommended_supplier_id && !v.suppliers.includes(prDoc.recommended_supplier_id) ? [...v.suppliers, prDoc.recommended_supplier_id] : v.suppliers,
    }))
  }, [prDoc, form.purchase_requisition_id, setValue])

  const { e: allErrors, lineErrors } = useMemo(() => validate(form, lines, picked), [form, lines, picked])
  const errors = submitted ? allErrors : Object.fromEntries(Object.entries(allErrors).filter(([k]) => touched[k]))
  const blur = (k) => () => setTouched((t) => ({ ...t, [k]: true }))
  const set = (k) => (e) => setForm({ [k]: e.target.value })

  const shownSuppliers = suppliers.filter((s) => !supplierQuery || `${s.legal_name} ${s.supplier_code}`.toLowerCase().includes(supplierQuery.toLowerCase()))

  const save = async (e) => {
    e.preventDefault()
    setSubmitted(true)
    setServerError(null)
    if (Object.keys(allErrors).length || Object.keys(lineErrors).length) return
    setSaving(true)
    try {
      const res = await api.post('/request-for-quotations', {
        ...form,
        line_items: lines
          .filter((l) => (l.item_description || '').trim() && parseFloat(l.quantity) > 0)
          .map((l) => ({ item_id: l.item_id || null, item_description: l.item_description, unit_of_measure: l.unit_of_measure, quantity: parseFloat(l.quantity), specifications: l.specifications })),
        suppliers: picked,
      })
      clear()
      const rfq = res.data?.data
      notify.success(`${rfq?.rfq_number || 'RFQ'} created as a draft. Submit it for approval to send it to suppliers.`)
      navigate(rfq?.id ? `/procurement/rfqs/${rfq.id}` : '/procurement/rfqs')
    } catch (err) {
      const d = err?.response?.data || {}
      setServerError({ message: d.error || err.message, reference: d.error_id })
    } finally {
      setSaving(false)
    }
  }

  const summaryErrors = submitted
    ? [
        ...Object.entries(allErrors).filter(([k]) => k !== 'lineItems' && k !== 'suppliers').map(([id, message]) => ({ id, message })),
        ...(allErrors.lineItems ? [{ id: 'rfq-lines', message: allErrors.lineItems }] : []),
        ...Object.entries(lineErrors).flatMap(([i, le]) => Object.values(le).map((m) => ({ id: 'rfq-lines', message: `Line ${Number(i) + 1}: ${m.toLowerCase()}` }))),
        ...(allErrors.suppliers ? [{ id: 'rfq-suppliers', message: allErrors.suppliers }] : []),
      ]
    : []

  return (
    <form onSubmit={save} className="mx-auto max-w-5xl space-y-5" noValidate>
      <PageHeader
        title="New request for quotation"
        description="List what you need, invite suppliers, and set a deadline. It is saved as a draft; submit it for approval to send it."
        meta={savedAt ? <span aria-live="polite">Draft saved in this browser {new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> : null}
      />

      {restored && (
        <InlineNotice tone="ink" title="Picked up where you left off" action={<Button size="sm" variant="ghost" onClick={discard}>Start over</Button>}>
          This RFQ was restored from a draft saved in this browser.
        </InlineNotice>
      )}
      {serverError && (
        <InlineNotice tone="risk" title="The RFQ was not created">
          {serverError.message} Your entries are still here.{serverError.reference && <> Reference <span className="font-mono">{serverError.reference}</span>.</>}
        </InlineNotice>
      )}
      <ErrorSummary errors={summaryErrors} />

      <FormSection title="Request">
        <Field label="From requisition" optional help="Choosing one fills the title, line and recommended supplier." className="sm:col-span-2" id="purchase_requisition_id">
          <Select name="purchase_requisition_id" value={form.purchase_requisition_id} onChange={set('purchase_requisition_id')}>
            <option value="">None — standalone RFQ</option>
            {approvedPRs.map((pr) => <option key={pr.id} value={pr.id}>{pr.pr_number} - {(pr.item_description || '').slice(0, 60)}</option>)}
          </Select>
        </Field>
        <Field label="Title" required error={errors.title} className="sm:col-span-2" id="title">
          <Input name="title" value={form.title} onChange={set('title')} onBlur={blur('title')} />
        </Field>
        <Field label="Responses due" required error={errors.response_deadline} id="response_deadline">
          <Input type="date" min={tomorrow()} name="response_deadline" value={form.response_deadline} onChange={set('response_deadline')} onBlur={blur('response_deadline')} />
        </Field>
        <Field label="Currency" id="currency">
          <Select name="currency" value={form.currency} onChange={set('currency')}>
            {['USD', 'EUR', 'GBP', 'CAD', 'JPY'].map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </Field>
        <Field label="Description" optional help="Shared with suppliers." className="sm:col-span-2" id="description">
          <Textarea name="description" rows={3} value={form.description} onChange={set('description')} />
        </Field>
      </FormSection>

      <section aria-labelledby="rfq-lines-h" className="space-y-2" id="rfq-lines" tabIndex={-1}>
        <div>
          <h2 id="rfq-lines-h" className="text-sm font-semibold text-fg">Lines</h2>
          <p className="text-xs text-ink-500">Pick a catalogue item to fill description and unit, or type a free-text line. Suppliers quote a price per line.</p>
        </div>
        {submitted && allErrors.lineItems && <p className="text-xs text-risk-600" role="alert">{allErrors.lineItems}</p>}
        <LineItemEditor
          label="RFQ lines"
          rows={lines}
          onChange={setLines}
          newRow={blankLine}
          errors={submitted ? lineErrors : {}}
          currency={form.currency}
          transform={(row, key, val) => {
            if (key !== 'item_id' || !val) return row
            const it = items.find((x) => x.id === val)
            return it ? { ...row, item_description: it.name, unit_of_measure: it.unit_of_measure || row.unit_of_measure } : row
          }}
          columns={[
            { key: 'item_id', header: 'Catalogue item', type: 'select', width: 200, placeholder: 'Free text', options: items.map((i) => ({ value: i.id, label: `${i.approved_item_code || i.item_code || ''} · ${i.name}` })) },
            { key: 'item_description', header: 'Description', type: 'text', minWidth: 220, required: true, placeholder: 'What you need' },
            { key: 'unit_of_measure', header: 'Unit', type: 'text', width: 80, placeholder: 'EA' },
            { key: 'quantity', header: 'Qty', type: 'number', width: 90, required: true },
            { key: 'specifications', header: 'Specifications', type: 'text', minWidth: 200, placeholder: 'Grade, standard, delivery' },
          ]}
        />
      </section>

      <FormSection
        title="Suppliers to invite"
        description={picked.length ? `${picked.length} selected` : 'Each one is emailed when the RFQ is approved.'}
        columns={1}
        aside={<Input size="sm" type="search" aria-label="Filter suppliers" placeholder="Filter suppliers" value={supplierQuery} onChange={(e) => setSupplierQuery(e.target.value)} className="w-44" />}
      >
        <div id="rfq-suppliers" tabIndex={-1}>
          {submitted && allErrors.suppliers && <p className="mb-2 text-xs text-risk-600" role="alert">{allErrors.suppliers}</p>}
          {suppliersLoading ? (
            <p className="text-sm text-ink-500">Loading suppliers…</p>
          ) : !suppliers.length ? (
            <p className="text-sm text-ink-500">No active suppliers yet. Suppliers must be approved before they can be invited.</p>
          ) : (
            <fieldset className="max-h-80 overflow-y-auto rounded-md border border-ink-200">
              <legend className="sr-only">Suppliers to invite</legend>
              {shownSuppliers.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-3 border-b border-ink-100 px-3 py-2 last:border-b-0">
                  <Checkbox
                    id={`supplier-${s.id}`}
                    checked={picked.includes(s.id)}
                    onChange={() => setPicked((p) => (p.includes(s.id) ? p.filter((x) => x !== s.id) : [...p, s.id]))}
                    label={s.legal_name}
                    description={s.supplier_code}
                  />
                  {s.certification_status === 'CERTIFIED' && <Badge tone="ok" glyph="check">Certified</Badge>}
                </div>
              ))}
              {!shownSuppliers.length && <p className="px-3 py-2 text-sm text-ink-500">No supplier matches “{supplierQuery}”.</p>}
            </fieldset>
          )}
        </div>
      </FormSection>

      <div className="sticky bottom-0 z-10 -mx-4 border-t border-ink-200 bg-canvas/95 px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center justify-end gap-3">
          <p className="mr-auto text-xs text-ink-500">{lines.filter((l) => l.item_description && l.quantity).length} lines · {picked.length} suppliers</p>
          <Button variant="ghost" onClick={() => navigate('/procurement/rfqs')}>Cancel</Button>
          <Button type="submit" variant="primary" loading={saving}>Create RFQ</Button>
        </div>
      </div>
    </form>
  )
}
