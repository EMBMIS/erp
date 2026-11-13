import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowDownTrayIcon, SparklesIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, Field, Input, Select, Textarea, FormSection, ErrorSummary, LineItemEditor, Dialog,
  InlineNotice, MaturityBadge, Money, Code, StatusBadge, EmptyState, useDraft, notify,
} from '../../components/ui'

/**
 * RFQ to a supplier — used by "New RFQ" (default export) and SalesRfqEdit
 * (which renders <RfqForm> seeded from the record).
 *
 * Sections: what and when, supplier, lines (a sheet; pick a catalog item or
 * type free text), delivery and terms, then attachments and notes folded away.
 * Payload and rules are unchanged from the previous screen.
 */
const num = (v) => parseFloat(v) || 0
const blankLine = () => ({ _key: `${Date.now()}-${Math.random()}`, item_id: '', item_name: '', item_description: '', item_specification: '', requested_quantity: '', unit_of_measure: '', estimated_unit_price: '' })
const isBlank = (l) => !l.item_name?.trim() && !l.item_id && !l.requested_quantity
const NEW_SUPPLIER = '__new'

function validate(form, lines, manual) {
  const e = {}
  if (!form.rfq_title?.trim()) e.rfq_title = 'Give the RFQ a title the supplier will recognise.'
  if (!form.supplier_id && !form.supplier_name?.trim()) e[manual ? 'supplier_name' : 'supplier_id'] = manual ? 'Name the supplier.' : 'Choose a supplier, or add one that is not listed.'
  if (!form.response_deadline) e.response_deadline = 'Set the date the supplier must answer by.'
  const lineErrors = {}
  let valid = 0
  lines.forEach((l, i) => {
    if (isBlank(l) && lines.length > 1) return
    const le = {}
    if (!l.item_name?.trim()) le.item_name = 'Name the item'
    if (!(num(l.requested_quantity) > 0)) le.requested_quantity = 'Quantity above zero'
    if (!l.unit_of_measure?.trim()) le.unit_of_measure = 'Unit required'
    if (Object.keys(le).length) lineErrors[i] = le
    else valid += 1
  })
  if (!valid) e.items = 'Add at least one complete line: item name, quantity and unit.'
  return { e, lineErrors }
}

export function RfqForm({ title, description, meta, initialValue, draftKey, cancelTo, onSave, submitLabel, supplierSource = 'active', allowImport = false, allowAi = false }) {
  const { value, setValue, restored, savedAt, clear, discard } = useDraft(draftKey || 'sales-rfq:edit', initialValue, { enabled: Boolean(draftKey) })
  const { form, lines, manual } = value
  const setForm = (patch) => setValue((v) => ({ ...v, form: { ...v.form, ...patch } }))
  const setLines = (next) => setValue((v) => ({ ...v, lines: typeof next === 'function' ? next(v.lines) : next }))

  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importing, setImporting] = useState(null)
  const [aiLine, setAiLine] = useState('')
  const [aiBusy, setAiBusy] = useState(false)

  const LOOKUP = { status: 'ACTIVE', limit: 100 }
  const ITEMS = { status: 'APPROVED', limit: 500 }
  const SO = { status: 'CONFIRMED', limit: 50 }
  const list = (d) => (Array.isArray(d) ? d : d?.data || [])
  const { data: rawSuppliers, loading: suppliersLoading } = useResource(
    supplierSource === 'active' ? ['suppliers', 'active'] : keys.suppliers(LOOKUP),
    ({ signal }) => (supplierSource === 'active' ? api.get('/suppliers/active', { signal }) : api.get('/suppliers', { params: LOOKUP, signal })),
  )
  const { data: rawCustomers } = useResource(keys.customers(LOOKUP), ({ signal }) => api.get('/customers', { params: LOOKUP, signal }))
  const { data: rawItems } = useResource(keys.items(ITEMS), ({ signal }) => api.get('/items', { params: ITEMS, signal }))
  const { data: rawSOs, loading: sosLoading } = useResource(keys.salesOrders(SO), ({ signal }) => api.get('/sales-orders', { params: SO, signal }), { enabled: allowImport })
  // A supplier with no legal name cannot be shown in a picker.
  const suppliers = list(rawSuppliers).filter((s) => s.legal_name && s.legal_name.trim() !== '')
  const customers = list(rawCustomers)
  const catalog = list(rawItems)
  const salesOrders = list(rawSOs)

  const { e: allErrors, lineErrors } = useMemo(() => validate(form, lines, manual), [form, lines, manual])
  const errors = submitted ? allErrors : Object.fromEntries(Object.entries(allErrors).filter(([k]) => touched[k]))
  const blur = (k) => () => setTouched((t) => ({ ...t, [k]: true }))

  const chooseSupplier = (sid) => {
    if (sid === NEW_SUPPLIER) {
      setValue((v) => ({ ...v, manual: true, form: { ...v.form, supplier_id: '', supplier_name: '', supplier_email: '', supplier_contact_person: '', supplier_phone: '' } }))
      return
    }
    const s = suppliers.find((x) => String(x.id) === String(sid))
    setValue((v) => ({
      ...v,
      manual: false,
      form: { ...v.form, supplier_id: sid, supplier_name: s ? s.legal_name || s.trade_name || '' : '', supplier_email: s?.email || '', supplier_contact_person: s?.contact_person || '', supplier_phone: s?.phone || '' },
    }))
  }

  const importFromOrder = async (order) => {
    setImporting(order.id)
    try {
      const res = await api.get(`/sales-orders/${order.id}`)
      const so = res.data?.data
      const soItems = so?.items || []
      if (!soItems.length) { notify.error(`${so?.so_number || 'That order'} has no lines to import`); return }
      setValue((v) => ({
        ...v,
        // Prices are left blank on purpose: the supplier prices them, and the sales price is not theirs to see.
        lines: soItems.map((it) => ({ ...blankLine(), item_id: it.item_id || '', item_name: it.item_name || it.description || '', item_description: it.description || it.item_name || '', item_specification: it.specifications || '', requested_quantity: it.quantity != null ? String(it.quantity) : '', unit_of_measure: it.unit_of_measure || '' })),
        form: so.customer_id
          ? { ...v.form, linked_customer_id: so.customer_id, rfq_title: `Supply request for SO ${so.so_number}`, source_document_type: 'SALES_ORDER', source_document_id: so.id, required_delivery_date: so.delivery_date ? String(so.delivery_date).split('T')[0] : '', delivery_location: so.delivery_address || '' }
          : v.form,
      }))
      setImportOpen(false)
      notify.success(`Imported ${soItems.length} line${soItems.length === 1 ? '' : 's'} from ${so.so_number}`)
    } catch (err) {
      notify.error(`The sales order lines were not imported: ${err?.response?.data?.error || err.message}`)
    } finally {
      setImporting(null)
    }
  }

  const aiCandidates = lines.map((l, i) => ({ l, i })).filter(({ l }) => (l.item_name || '').trim().length >= 3)
  const fillWithAi = async () => {
    const i = Number(aiLine)
    const line = lines[i]
    if (!line) return
    setAiBusy(true)
    try {
      const res = await api.post('/items/ai/comprehensive', { name: line.item_name.trim(), description: line.item_description || '' })
      const ai = res.data?.data
      if (!res.data?.success || !ai) throw new Error('Simeli returned nothing usable.')
      const spec = ai.item_category
        ? [`Category: ${ai.item_category}`, ai.manufacturer && `Manufacturer: ${ai.manufacturer}`, ai.manufacturer_part_number && `Part Number: ${ai.manufacturer_part_number}`, ai.unspsc_code && `UNSPSC Code: ${ai.unspsc_code}`].filter(Boolean).join('\n')
        : line.item_specification
      setLines((ls) => ls.map((l, j) => (j === i ? { ...l, item_name: ai.name || l.item_name, item_description: ai.description || l.item_description, item_specification: spec, unit_of_measure: ai.unit_of_measure || l.unit_of_measure } : l)))
      notify.success(`Line ${i + 1} filled in by Simeli — check it before sending`)
    } catch (err) {
      notify.error(`Simeli could not describe line ${i + 1}: ${err?.response?.data?.error || err.message}`)
    } finally {
      setAiBusy(false)
    }
  }

  const save = async () => {
    setSubmitted(true)
    setServerError(null)
    if (Object.keys(allErrors).length || Object.keys(lineErrors).length) return
    setSaving(true)
    const valid = lines
      .filter((l) => l.item_name?.trim() && l.requested_quantity && l.unit_of_measure?.trim())
      .map(({ _key, ...l }) => l)
    try {
      await onSave({
        ...form,
        items: valid,
        attachment_urls: form.attachment_urls ? form.attachment_urls.split(',').map((u) => u.trim()).filter(Boolean) : [],
      })
      clear()
    } catch (err) {
      const d = err?.response?.data || {}
      setServerError({ message: d.error || err.message, reference: d.error_id })
    } finally {
      setSaving(false)
    }
  }

  const summaryErrors = submitted
    ? [
        ...Object.entries(allErrors).filter(([k]) => k !== 'items').map(([k, message]) => ({ id: k.replace(/_/g, '-'), message })),
        ...(allErrors.items ? [{ id: 'rfq-lines', message: allErrors.items }] : []),
        ...Object.entries(lineErrors).flatMap(([i, le]) => Object.values(le).map((m) => ({ id: 'rfq-lines', message: `Line ${Number(i) + 1}: ${m.toLowerCase()}` }))),
      ]
    : []
  const estimate = lines.reduce((s, l) => s + num(l.requested_quantity) * num(l.estimated_unit_price), 0)
  const supplierValue = manual ? NEW_SUPPLIER : form.supplier_id
  const chosen = suppliers.find((s) => String(s.id) === String(form.supplier_id))
  const today = new Date().toISOString().split('T')[0]

  return (
    <form onSubmit={(e) => { e.preventDefault(); save() }} className="mx-auto max-w-5xl space-y-5" noValidate>
      <PageHeader
        title={title}
        description={description}
        meta={meta || (draftKey && savedAt ? <span aria-live="polite">Draft saved in this browser {new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> : null)}
        secondary={allowImport ? <Button icon={ArrowDownTrayIcon} onClick={() => setImportOpen(true)}>Import from sales order</Button> : null}
      />

      {draftKey && restored && (
        <InlineNotice tone="ink" title="Picked up where you left off" action={<Button size="sm" variant="ghost" onClick={discard}>Start over</Button>}>
          This RFQ was restored from a draft saved in this browser{savedAt ? ` at ${new Date(savedAt).toLocaleString()}` : ''}.
        </InlineNotice>
      )}
      {serverError && (
        <InlineNotice tone="risk" title="The RFQ was not saved">
          {serverError.message} Nothing was lost — your entries are still here.{serverError.reference && <> Reference <span className="font-mono">{serverError.reference}</span>.</>}
        </InlineNotice>
      )}
      <ErrorSummary errors={summaryErrors} />

      <FormSection title="What and when">
        <Field label="Title" required error={errors.rfq_title} className="sm:col-span-2" id="rfq-title">
          <Input value={form.rfq_title} onChange={(e) => setForm({ rfq_title: e.target.value })} onBlur={blur('rfq_title')} placeholder="e.g. Office supplies for Q1" />
        </Field>
        <Field label="Request type" id="request-type">
          <Select value={form.request_type} onChange={(e) => setForm({ request_type: e.target.value })}>
            <option value="TRADING">Trading — resold to a customer</option>
            <option value="INTERNAL_USE">Internal use</option>
            <option value="RESALE">Resale</option>
          </Select>
        </Field>
        <Field label="Priority" id="priority">
          <Select value={form.priority} onChange={(e) => setForm({ priority: e.target.value })}>
            <option value="LOW">Low</option>
            <option value="MEDIUM">Medium</option>
            <option value="HIGH">High</option>
            <option value="URGENT">Urgent</option>
          </Select>
        </Field>
        <Field label="Response deadline" required error={errors.response_deadline} help="The supplier must answer by this date." id="response-deadline">
          <Input type="date" min={draftKey ? today : undefined} value={form.response_deadline} onChange={(e) => setForm({ response_deadline: e.target.value })} onBlur={blur('response_deadline')} />
        </Field>
        <Field label="Required delivery" optional id="required-delivery-date">
          <Input type="date" value={form.required_delivery_date} onChange={(e) => setForm({ required_delivery_date: e.target.value })} />
        </Field>
        <Field label="Linked customer" optional help="The customer these goods are for, if any." className="sm:col-span-2" id="linked-customer-optional">
          <Select value={form.linked_customer_id} onChange={(e) => setForm({ linked_customer_id: e.target.value })}>
            <option value="">No customer</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.customer_name}{c.customer_code ? ` (${c.customer_code})` : ''}</option>)}
          </Select>
        </Field>
      </FormSection>

      <FormSection title="Supplier">
        <Field
          label="Supplier"
          required
          error={errors.supplier_id}
          help={chosen ? [chosen.supplier_code, chosen.email, chosen.contact_person].filter(Boolean).join(' · ') : 'Only active suppliers are listed. Choose “Supplier not listed” to type one in.'}
          className="sm:col-span-2"
          id="supplier-id"
        >
          <Select value={supplierValue} onChange={(e) => { chooseSupplier(e.target.value); blur('supplier_id')() }} onBlur={blur('supplier_id')}>
            <option value="">{suppliersLoading ? 'Loading suppliers…' : 'Choose a supplier…'}</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.legal_name.trim()}{s.supplier_code ? ` (${s.supplier_code})` : ''}</option>)}
            <option value={NEW_SUPPLIER}>Supplier not listed — type it in</option>
          </Select>
        </Field>
        {manual && (
          <>
            <Field label="Supplier name" required error={errors.supplier_name} id="supplier-name">
              <Input value={form.supplier_name} onChange={(e) => setForm({ supplier_name: e.target.value })} onBlur={blur('supplier_name')} />
            </Field>
            <Field label="Contact person" optional id="supplier-contact-person">
              <Input value={form.supplier_contact_person} onChange={(e) => setForm({ supplier_contact_person: e.target.value })} />
            </Field>
            <Field label="Email" optional help="The RFQ link is emailed here once approved." id="supplier-email">
              <Input type="email" value={form.supplier_email} onChange={(e) => setForm({ supplier_email: e.target.value })} />
            </Field>
            <Field label="Phone" optional id="supplier-phone">
              <Input type="tel" value={form.supplier_phone} onChange={(e) => setForm({ supplier_phone: e.target.value })} />
            </Field>
          </>
        )}
      </FormSection>

      <section aria-labelledby="rfq-lines-h" className="space-y-2" id="rfq-lines" tabIndex={-1}>
        <div>
          <h2 id="rfq-lines-h" className="text-sm font-semibold text-fg">Lines</h2>
          <p className="text-xs text-ink-500">Pick an approved catalog item to fill name, description and unit, or type a free-text line. The estimate is internal; the supplier does not see it.</p>
        </div>
        {submitted && allErrors.items && <p className="text-xs text-risk-600" role="alert">{allErrors.items}</p>}
        <LineItemEditor
          label="RFQ lines"
          rows={lines}
          onChange={setLines}
          newRow={blankLine}
          errors={submitted ? lineErrors : {}}
          transform={(row, key, val) => {
            if (key !== 'item_id' || !val) return row
            const it = catalog.find((x) => x.id === val)
            return it ? { ...row, item_name: it.name || row.item_name, item_description: it.description || row.item_description, unit_of_measure: it.unit_of_measure || row.unit_of_measure } : row
          }}
          columns={[
            { key: 'item_id', header: 'Catalog item', type: 'select', minWidth: 190, placeholder: 'Free text', options: catalog.map((i) => ({ value: i.id, label: `${i.approved_item_code || i.item_code || ''} · ${i.name}` })) },
            { key: 'item_name', header: 'Item name', type: 'text', minWidth: 180, required: true },
            { key: 'requested_quantity', header: 'Qty', type: 'number', minWidth: 80, required: true },
            { key: 'unit_of_measure', header: 'Unit', type: 'text', minWidth: 70, required: true, placeholder: 'PCS' },
            { key: 'estimated_unit_price', header: 'Est. unit price', type: 'money', minWidth: 120 },
            { key: 'estimate', header: 'Est. total', type: 'money', compute: (r) => num(r.requested_quantity) * num(r.estimated_unit_price), total: true, minWidth: 120 },
            { key: 'item_description', header: 'Description', type: 'text', minWidth: 200 },
            { key: 'item_specification', header: 'Specification', type: 'text', minWidth: 200, placeholder: 'Standards, grade, finish…' },
          ]}
        />
        {allowAi && (
          <div className="flex flex-wrap items-end gap-2 rounded-lg border border-ink-200 bg-surface px-3 py-2">
            <Field label={<span className="inline-flex items-center gap-1.5">Describe a line with Simeli <MaturityBadge level="beta" /></span>} help="Fills description, specification and unit from the item name. Check the result; nothing is sent until you save." className="min-w-0 flex-1" id="ai-line">
              <Select value={aiLine} onChange={(e) => setAiLine(e.target.value)}>
                <option value="">{aiCandidates.length ? 'Choose a line…' : 'Type an item name of 3+ characters first'}</option>
                {aiCandidates.map(({ l, i }) => <option key={l._key || i} value={i}>Line {i + 1}: {l.item_name}</option>)}
              </Select>
            </Field>
            <Button icon={SparklesIcon} onClick={fillWithAi} loading={aiBusy} disabled={aiLine === '' || aiBusy} className="mb-5">Fill in</Button>
          </div>
        )}
      </section>

      <FormSection title="Delivery and terms">
        <Field label="Delivery location" optional id="delivery-location">
          <Input value={form.delivery_location} onChange={(e) => setForm({ delivery_location: e.target.value })} placeholder="e.g. Warehouse A, Riyadh" />
        </Field>
        <Field label="Delivery terms" optional id="delivery-terms">
          <Input value={form.delivery_terms} onChange={(e) => setForm({ delivery_terms: e.target.value })} placeholder="e.g. FOB, CIF, EXW" />
        </Field>
        <Field label="Payment terms" optional id="payment-terms">
          <Input value={form.payment_terms} onChange={(e) => setForm({ payment_terms: e.target.value })} placeholder="e.g. Net 30 days" />
        </Field>
      </FormSection>

      <FormSection title="Requirements, attachments and notes" advanced defaultOpen={Boolean(form.special_requirements || form.terms_and_conditions || form.internal_notes || form.attachment_urls)}>
        <Field label="Special requirements" optional help="Quality standards, certifications, packaging." className="sm:col-span-2" id="special-requirements">
          <Textarea rows={3} value={form.special_requirements} onChange={(e) => setForm({ special_requirements: e.target.value })} />
        </Field>
        <Field label="Terms and conditions" optional className="sm:col-span-2" id="terms-and-conditions">
          <Textarea rows={3} value={form.terms_and_conditions} onChange={(e) => setForm({ terms_and_conditions: e.target.value })} />
        </Field>
        <Field label="Attachment links" optional help="Comma-separated URLs for drawings or specifications." className="sm:col-span-2" id="attachment-urls">
          <Input value={form.attachment_urls} onChange={(e) => setForm({ attachment_urls: e.target.value })} />
        </Field>
        <Field label="Internal notes" optional help="Only your team sees these." className="sm:col-span-2" id="internal-notes">
          <Textarea rows={2} value={form.internal_notes} onChange={(e) => setForm({ internal_notes: e.target.value })} />
        </Field>
      </FormSection>

      <div className="sticky bottom-0 z-10 -mx-4 border-t border-ink-200 bg-canvas/95 px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="mr-auto text-sm">
            <span className="text-ink-600">Our estimate </span>
            {estimate ? <Money amount={estimate} className="text-base font-semibold" /> : <span className="text-ink-400">—</span>}
            <span className="ml-2 text-xs text-ink-500">{lines.filter((l) => !isBlank(l)).length} line{lines.filter((l) => !isBlank(l)).length === 1 ? '' : 's'}</span>
          </div>
          <Button variant="ghost" to={cancelTo}>Cancel</Button>
          <Button type="submit" variant="primary" loading={saving} disabled={saving}>{submitLabel}</Button>
        </div>
      </div>

      {allowImport && (
        <Dialog open={importOpen} onClose={() => setImportOpen(false)} title="Import lines from a sales order" description="Copies the order's lines (without prices) and links the RFQ to its customer." size="lg">
          {sosLoading ? (
            <p className="text-sm text-ink-500">Loading confirmed orders…</p>
          ) : salesOrders.length ? (
            <ul className="divide-y divide-ink-100 rounded-lg border border-ink-200">
              {salesOrders.map((o) => (
                <li key={o.id}>
                  <button type="button" onClick={() => importFromOrder(o)} disabled={Boolean(importing)} className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-ink-50 disabled:opacity-60">
                    <span className="min-w-0">
                      <Code className="block">{o.so_number}</Code>
                      <span className="block truncate text-sm text-ink-700">{o.customer_name}</span>
                      <span className="block text-2xs text-ink-500">{o.items?.length != null ? `${o.items.length} lines · ` : ''}{o.order_date ? new Date(o.order_date).toLocaleDateString() : 'no date'}</span>
                    </span>
                    <span className="shrink-0 text-right">
                      <StatusBadge status={o.status} />
                      <span className="mt-1 block text-sm"><Money amount={o.total_amount} currency={o.currency || 'USD'} /></span>
                      {importing === o.id && <span className="block text-2xs text-ink-500">Importing…</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState compact title="No confirmed sales orders" description="Only confirmed orders can be imported. Confirm the order first, or type the lines in." />
          )}
        </Dialog>
      )}
    </form>
  )
}

export default function SalesRfqCreate() {
  const navigate = useNavigate()
  const initial = useMemo(() => ({
    manual: false,
    form: {
      rfq_title: '', supplier_id: '', supplier_name: '', supplier_email: '', supplier_contact_person: '', supplier_phone: '',
      request_type: 'TRADING', required_delivery_date: '', delivery_location: '', delivery_terms: '', payment_terms: '',
      priority: 'MEDIUM', response_deadline: '', special_requirements: '', terms_and_conditions: '', internal_notes: '',
      attachment_urls: '', linked_customer_id: '', source_document_type: 'SALES_INQUIRY',
    },
    lines: [blankLine()],
  }), [])

  const onSave = async (payload) => {
    const res = await api.post('/sales-rfqs', payload)
    if (!res.data?.success) throw Object.assign(new Error(res.data?.error || 'The RFQ was not created.'), { response: { data: res.data } })
    const rfq = res.data.data
    notify.success(`${rfq?.rfq_number || 'RFQ'} created as a draft`)
    navigate(rfq?.id ? `/sales/rfqs/${rfq.id}` : '/sales/rfqs')
  }

  return (
    <RfqForm
      title="New RFQ to a supplier"
      description="Ask a supplier to price goods. It is saved as a draft; submit it for approval from the RFQ."
      initialValue={initial}
      draftKey="sales-rfq:new"
      cancelTo="/sales/rfqs"
      onSave={onSave}
      submitLabel="Create RFQ"
      supplierSource="active"
      allowImport
      allowAi
    />
  )
}
