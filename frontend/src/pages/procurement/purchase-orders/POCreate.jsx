import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import api from '../../../services/api'
import { useResource } from '../../../hooks/useResource'
import { keys } from '../../../services/queryKeys'
import {
  PageHeader, Button, Field, Input, Select, Textarea, Combobox, FormSection, ErrorSummary, LineItemEditor,
  InlineNotice, Money, formatDate, useDraft, notify,
} from '../../../components/ui'

/**
 * New purchase order.
 *
 * The form is sections, not a wall: where it comes from, who and when, where
 * it goes, the lines, and terms (folded away — most orders use defaults).
 * Lines work like a sheet: tab across, Enter down, paste from Excel.
 * The form autosaves to this browser, so navigating away or an expired
 * session never loses a half-written order.
 *
 * Payload and validation rules are unchanged from the previous screen.
 */
const SOURCES = [
  { value: 'purchase_requisition', label: 'Purchase requisition — standard procurement' },
  { value: 'standard_rfq', label: 'RFQ — supplier already selected' },
  { value: 'contract_only', label: 'Contract — buy against an agreement' },
  { value: 'contract_sales_order', label: 'Contract + sales order — fulfil a customer order' },
  { value: 'sales_order_sales_rfq', label: 'Sales order + sales RFQ — fulfil a customer order' },
]
const CUSTOMER_DELIVERY = ['contract_sales_order', 'sales_order_sales_rfq']
const today = () => new Date().toISOString().split('T')[0]
const tomorrow = () => new Date(Date.now() + 864e5).toISOString().split('T')[0]
const blankLine = (date = '') => ({ _key: `${Date.now()}-${Math.random()}`, item_id: '', item_description: '', unit_of_measure: '', quantity: '', unit_price: '', requested_delivery_date: date })

const INITIAL = (pr, rfq) => ({
  form: {
    source_type: rfq ? 'standard_rfq' : pr ? 'purchase_requisition' : '',
    purchase_requisition_id: pr || '',
    rfq_id: rfq || '',
    sales_order_id: '',
    sales_rfq_id: '',
    contract_id: '',
    supplier_id: '',
    po_date: today(),
    delivery_date: '',
    payment_terms: '',
    incoterms: 'FOB',
    currency: 'USD',
    delivery_address: '',
    storage_location_id: '',
  },
  lines: [blankLine()],
})

function validate(form, lines) {
  const e = {}
  if (!form.source_type) e.source_type = 'Choose where this order comes from.'
  if (['contract_sales_order', 'contract_only'].includes(form.source_type) && !form.contract_id) e.contract_id = 'Choose the contract this order buys against.'
  if (['contract_sales_order', 'sales_order_sales_rfq'].includes(form.source_type) && !form.sales_order_id) e.sales_order_id = 'Choose the customer order this fulfils.'
  if (form.source_type === 'sales_order_sales_rfq' && !form.sales_rfq_id) e.sales_rfq_id = 'Choose the sales RFQ with the supplier quote.'
  if (form.source_type === 'purchase_requisition' && !form.purchase_requisition_id) e.purchase_requisition_id = 'Choose the approved requisition.'
  if (form.source_type === 'standard_rfq' && !form.rfq_id) e.rfq_id = 'Choose the completed RFQ.'
  if (!form.supplier_id) e.supplier_id = 'Choose a supplier. Only active suppliers are listed.'
  if (!form.delivery_date) e.delivery_date = 'Set the date you need delivery.'
  else if (new Date(form.delivery_date) <= new Date()) e.delivery_date = `Delivery must be after today — ${formatDate(tomorrow())} or later.`
  const lineErrors = {}
  let valid = 0
  lines.forEach((l, i) => {
    const le = {}
    const empty = !l.item_description?.trim() && !l.quantity && !l.unit_price && !l.item_id
    if (empty && lines.length > 1) return
    if (!l.item_description?.trim()) le.item_description = 'Describe the item'
    if (!(parseFloat(l.quantity) > 0)) le.quantity = 'Quantity above zero'
    if (!(parseFloat(l.unit_price) > 0)) le.unit_price = 'Price above zero'
    if (Object.keys(le).length) lineErrors[i] = le
    else valid += 1
  })
  if (!valid) e.lineItems = 'Add at least one complete line: description, quantity and unit price.'
  return { e, lineErrors }
}

export default function POCreate() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const prFromUrl = params.get('pr_id')
  const rfqFromUrl = params.get('rfq_id')
  const draftKey = `po:new${prFromUrl ? `:pr:${prFromUrl}` : ''}${rfqFromUrl ? `:rfq:${rfqFromUrl}` : ''}`
  const initial = useMemo(() => INITIAL(prFromUrl, rfqFromUrl), [prFromUrl, rfqFromUrl])
  const { value, setValue, restored, savedAt, clear, discard } = useDraft(draftKey, initial)
  const { form, lines } = value
  const setForm = (patch) => setValue((v) => ({ ...v, form: { ...v.form, ...(typeof patch === 'function' ? patch(v.form) : patch) } }))
  const setLines = (next) => setValue((v) => ({ ...v, lines: typeof next === 'function' ? next(v.lines) : next }))

  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(null) // 'draft' | 'submit'
  const [serverError, setServerError] = useState(null)
  const [prefill, setPrefill] = useState(null) // { label, lines, patch }

  const get = (path, p) => ({ signal }) => api.get(path, { params: p, signal })
  const list = (d) => (Array.isArray(d) ? d : d?.data || [])
  const { data: rawItems } = useResource(keys.items({ status: 'APPROVED', limit: 500 }), get('/items', { status: 'APPROVED', limit: 500 }))
  const { data: rawSuppliers, loading: suppliersLoading } = useResource(keys.suppliers({ active: true }), get('/suppliers/active'))
  const { data: rawPRs } = useResource(keys.purchaseRequisitions({ status: 'APPROVED' }), get('/purchase-requisitions/approved'))
  const { data: rawRfqs } = useResource(keys.rfqs({ status: 'COMPLETED' }), get('/request-for-quotations/completed'))
  const { data: rawSOs } = useResource(keys.salesOrders(), get('/sales-orders'))
  const { data: rawSalesRfqs } = useResource(keys.salesRfqs(), get('/sales-rfqs'))
  const { data: rawContracts } = useResource(keys.contracts({ status: 'ACTIVE' }), get('/contracts/active'))
  const { data: rawLocations } = useResource(keys.storageLocations({ active: true }), get('/storage-locations', { is_active: true }))
  const items = list(rawItems)
  const suppliers = list(rawSuppliers)
  const prs = list(rawPRs)
  const rfqs = list(rawRfqs)
  const salesOrders = list(rawSOs)
  const salesRfqs = list(rawSalesRfqs)
  const contracts = list(rawContracts)
  const locations = list(rawLocations)

  const { e: allErrors, lineErrors } = useMemo(() => validate(form, lines), [form, lines])
  const errors = submitted ? allErrors : Object.fromEntries(Object.entries(allErrors).filter(([k]) => touched[k]))
  const blur = (k) => () => setTouched((t) => ({ ...t, [k]: true }))

  /* --- Prefill from the chosen source. Lines the person typed are never
         replaced without asking. --- */
  const linesAreEmpty = lines.every((l) => !l.item_description && !l.quantity && !l.unit_price)
  const offer = (label, newLines, patch) => {
    if (patch) setForm((f) => Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, f[k] || v])))
    if (!newLines?.length) return
    if (linesAreEmpty) setLines(newLines)
    else setPrefill({ label, lines: newLines })
  }
  // Source documents, fetched only once one is chosen.
  const srcId = {
    pr: form.source_type === 'purchase_requisition' ? form.purchase_requisition_id : '',
    rfq: form.source_type === 'standard_rfq' ? form.rfq_id : '',
    so: CUSTOMER_DELIVERY.includes(form.source_type) ? form.sales_order_id : '',
    srfq: form.source_type === 'sales_order_sales_rfq' ? form.sales_rfq_id : '',
  }
  const { data: prDoc } = useResource(['po-prefill', 'pr', srcId.pr], get(`/purchase-requisitions/${srcId.pr}`), { enabled: !!srcId.pr })
  const { data: rfqDoc } = useResource(['po-prefill', 'rfq', srcId.rfq], async ({ signal }) => {
    const [r, li, q] = await Promise.all([api.get(`/request-for-quotations/${srcId.rfq}`, { signal }), api.get(`/request-for-quotations/${srcId.rfq}/line-items`, { signal }), api.get(`/request-for-quotations/${srcId.rfq}/quotations`, { signal })])
    return { data: { rfq: r.data.data, lines: li.data.data || [], quotes: q.data.data || [] } }
  }, { enabled: !!srcId.rfq })
  const { data: soDoc } = useResource(['po-prefill', 'so', srcId.so], async ({ signal }) => {
    const [o, it] = await Promise.all([api.get(`/sales-orders/${srcId.so}`, { signal }), api.get(`/sales-orders/${srcId.so}/items`, { signal })])
    return { data: { so: o.data.data, items: it.data.data || [] } }
  }, { enabled: !!srcId.so })
  const { data: srfqDoc } = useResource(['po-prefill', 'srfq', srcId.srfq], get(`/sales-rfqs/${srcId.srfq}`), { enabled: !!srcId.srfq })

  const applied = useRef({})
  const once = (key, id, doc, fn) => {
    if (!id || !doc || applied.current[key] === id) return
    applied.current[key] = id
    fn(doc)
  }
  useEffect(() => once('pr', srcId.pr, prDoc, (pr) => {
    offer(pr.pr_number, [{ ...blankLine(pr.required_by_date?.slice(0, 10) || ''), item_id: pr.item_id || '', item_description: pr.item_description || '', unit_of_measure: pr.unit_of_measure || '', quantity: String(pr.quantity ?? '') }], { supplier_id: pr.recommended_supplier_id, delivery_date: pr.required_by_date?.slice(0, 10) })
  }), [prDoc, srcId.pr])
  useEffect(() => once('rfq', srcId.rfq, rfqDoc, ({ rfq, lines: rl, quotes }) => {
    offer(rfq.rfq_number, rl.map((it) => {
      const win = quotes.find((x) => x.rfq_line_item_id === it.id && x.supplier_id === rfq.winning_supplier_id)
      return { ...blankLine(win?.delivery_date?.slice(0, 10) || ''), item_id: it.item_id || '', item_description: it.item_description, unit_of_measure: it.unit_of_measure || '', quantity: String(it.quantity), unit_price: win ? String(win.unit_price) : '' }
    }), { supplier_id: rfq.winning_supplier_id, currency: rfq.currency, purchase_requisition_id: rfq.purchase_requisition_id })
  }), [rfqDoc, srcId.rfq])
  useEffect(() => once('so', srcId.so, soDoc, ({ so, items: soItems }) => {
    const ship = !so.use_billing_as_shipping && so.shipping_address_line1
    const pick = (k) => so[`${ship ? 'shipping' : 'billing'}_${k}`]
    const address = [pick('address_line1'), pick('address_line2'), [pick('city'), pick('state')].filter(Boolean).join(', '), pick('postal_code'), pick('country')].filter(Boolean).join('\n')
    offer(so.order_number || 'the sales order', soItems.map((x) => ({ ...blankLine(so.required_delivery_date?.slice(0, 10) || ''), item_id: x.item_id || '', item_description: x.item_name || x.item_description, unit_of_measure: x.unit_of_measure || 'each', quantity: String(x.quantity), unit_price: x.unit_price != null ? String(x.unit_price) : '' })), { delivery_date: so.required_delivery_date?.slice(0, 10), currency: so.currency, delivery_address: so.delivery_address || address })
  }), [soDoc, srcId.so])
  useEffect(() => once('srfq', srcId.srfq, srfqDoc, (sr) => {
    const totalQty = (sr.items || []).reduce((n, x) => n + parseFloat(x.requested_quantity || 0), 0)
    const avg = totalQty > 0 ? parseFloat(sr.supplier_total_amount || 0) / totalQty : 0
    offer(sr.rfq_number || 'the sales RFQ', (sr.items || []).map((x) => ({ ...blankLine(sr.required_delivery_date?.slice(0, 10) || ''), item_id: x.item_id || '', item_description: x.item_name, unit_of_measure: x.unit_of_measure || 'each', quantity: String(x.requested_quantity), unit_price: x.quoted_unit_price != null ? String(x.quoted_unit_price) : avg.toFixed(2) })), { supplier_id: sr.supplier_id, delivery_date: sr.required_delivery_date?.slice(0, 10), currency: sr.supplier_currency })
  }), [srfqDoc, srcId.srfq])

  const changeSource = (v) => {
    applied.current = {}
    setForm({ source_type: v, contract_id: '', sales_order_id: '', sales_rfq_id: '', purchase_requisition_id: '', rfq_id: '' })
  }

  const subtotal = lines.reduce((s, l) => s + (parseFloat(l.quantity) || 0) * (parseFloat(l.unit_price) || 0), 0)
  const supplier = suppliers.find((s) => s.id === form.supplier_id)

  const save = async (submitForApproval) => {
    setSubmitted(true)
    setServerError(null)
    if (Object.keys(allErrors).length || Object.keys(lineErrors).length) return
    setSaving(submitForApproval ? 'submit' : 'draft')
    const complete = lines.filter((l) => l.item_description?.trim() && parseFloat(l.quantity) > 0 && parseFloat(l.unit_price) > 0)
    try {
      const res = await api.post('/purchase-orders', {
        ...form,
        status: submitForApproval ? 'PENDING_APPROVAL' : 'DRAFT',
        sales_order_id: form.sales_order_id || null,
        sales_rfq_id: form.sales_rfq_id || null,
        line_items: complete.map((l) => ({
          item_id: l.item_id || null,
          item_description: l.item_description,
          unit_of_measure: l.unit_of_measure,
          quantity: parseFloat(l.quantity),
          unit_price: parseFloat(l.unit_price),
          requested_delivery_date: l.requested_delivery_date || form.delivery_date,
        })),
      })
      clear()
      const po = res.data?.data
      notify.success(`${po?.po_number || 'Purchase order'} ${submitForApproval ? 'created and submitted for approval' : 'saved as a draft'}`)
      navigate(po?.id ? `/procurement/purchase-orders/${po.id}` : '/procurement/purchase-orders')
    } catch (err) {
      const d = err?.response?.data || {}
      setServerError({ message: d.error || err.message, reference: d.error_id })
    } finally {
      setSaving(null)
    }
  }

  const summaryErrors = submitted
    ? [
        ...Object.entries(allErrors).filter(([k]) => k !== 'lineItems').map(([id, message]) => ({ id, message })),
        ...(allErrors.lineItems ? [{ id: 'po-lines', message: allErrors.lineItems }] : []),
        ...Object.entries(lineErrors).flatMap(([i, le]) => Object.values(le).map((m) => ({ id: 'po-lines', message: `Line ${Number(i) + 1}: ${m.toLowerCase()}` }))),
      ]
    : []

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); save(false) }}
      className="mx-auto max-w-5xl space-y-5"
      noValidate
    >
      <PageHeader
        title="New purchase order"
        description="Commit spend with a supplier. Save a draft to finish later, or submit it for approval now."
        meta={savedAt ? <span aria-live="polite">Draft saved in this browser {new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> : null}
      />

      {restored && (
        <InlineNotice tone="ink" title="Picked up where you left off" action={<Button size="sm" variant="ghost" onClick={discard}>Start over</Button>}>
          This order was restored from a draft saved in this browser{savedAt ? ` at ${new Date(savedAt).toLocaleString()}` : ''}.
        </InlineNotice>
      )}
      {serverError && (
        <InlineNotice tone="risk" title="The order was not saved">
          {serverError.message} Nothing was lost — your entries are still here.{serverError.reference && <> Reference <span className="font-mono">{serverError.reference}</span>.</>}
        </InlineNotice>
      )}
      <ErrorSummary errors={summaryErrors} />

      <FormSection title="Source" description="Where this order comes from decides what it can be checked against.">
        <Field label="Source" required error={errors.source_type} className="sm:col-span-2" id="source_type">
          <Select value={form.source_type} onChange={(e) => changeSource(e.target.value)} onBlur={blur('source_type')}>
            <option value="">Choose a source…</option>
            {SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        </Field>
        {['contract_sales_order', 'contract_only'].includes(form.source_type) && (
          <Field label="Contract" required error={errors.contract_id} id="contract_id">
            <Combobox value={form.contract_id} onChange={(v) => { setForm({ contract_id: v }); blur('contract_id')() }} options={contracts.map((c) => ({ value: c.id, label: c.contract_name || c.title || c.contract_number, meta: c.contract_number }))} placeholder="Search contracts" emptyText="No active contracts" />
          </Field>
        )}
        {CUSTOMER_DELIVERY.includes(form.source_type) && (
          <Field label="Sales order" required error={errors.sales_order_id} id="sales_order_id">
            <Combobox value={form.sales_order_id} onChange={(v) => { setForm({ sales_order_id: v }); blur('sales_order_id')() }} options={salesOrders.map((o) => ({ value: o.id, label: o.customer_name || 'Customer', meta: o.order_number || o.so_number }))} placeholder="Search sales orders" emptyText="No sales orders" />
          </Field>
        )}
        {form.source_type === 'sales_order_sales_rfq' && (
          <Field label="Sales RFQ" required error={errors.sales_rfq_id} id="sales_rfq_id">
            <Combobox value={form.sales_rfq_id} onChange={(v) => { setForm({ sales_rfq_id: v }); blur('sales_rfq_id')() }} options={salesRfqs.map((r) => ({ value: r.id, label: r.rfq_title || r.title || r.rfq_number, meta: r.rfq_number }))} placeholder="Search sales RFQs" emptyText="No sales RFQs" />
          </Field>
        )}
        {form.source_type === 'purchase_requisition' && (
          <Field label="Purchase requisition" required error={errors.purchase_requisition_id} help="Only approved requisitions are listed." id="purchase_requisition_id">
            <Combobox value={form.purchase_requisition_id} onChange={(v) => { setForm({ purchase_requisition_id: v }); blur('purchase_requisition_id')() }} options={prs.map((p) => ({ value: p.id, label: p.item_description, meta: p.pr_number }))} placeholder="Search requisitions" emptyText="No approved requisitions" />
          </Field>
        )}
        {form.source_type === 'standard_rfq' && (
          <Field label="RFQ" required error={errors.rfq_id} help="Only completed RFQs with a selected supplier are listed." id="rfq_id">
            <Combobox value={form.rfq_id} onChange={(v) => { setForm({ rfq_id: v }); blur('rfq_id')() }} options={rfqs.map((r) => ({ value: r.id, label: r.title || r.rfq_title, meta: r.rfq_number, description: r.winning_supplier_name }))} placeholder="Search RFQs" emptyText="No completed RFQs" />
          </Field>
        )}
      </FormSection>

      <FormSection title="Supplier and dates">
        <Field label="Supplier" required error={errors.supplier_id} help={supplier ? [supplier.supplier_code, supplier.city, supplier.country].filter(Boolean).join(' · ') : 'Only active suppliers are listed.'} className="sm:col-span-2" id="supplier_id">
          <Combobox
            value={form.supplier_id}
            onChange={(v) => { setForm({ supplier_id: v }); blur('supplier_id')() }}
            options={suppliers.map((s) => ({ value: s.id, label: s.legal_name, meta: s.supplier_code, description: [s.city, s.country].filter(Boolean).join(', ') }))}
            placeholder={suppliersLoading ? 'Loading suppliers…' : 'Search by name or code'}
            emptyText="No active supplier matches"
          />
        </Field>
        <Field label="Order date" id="po_date">
          <Input type="date" value={form.po_date} onChange={(e) => setForm({ po_date: e.target.value })} />
        </Field>
        <Field label="Delivery date" required error={errors.delivery_date} help="The date you need the goods. Lines default to it." id="delivery_date">
          <Input type="date" min={tomorrow()} value={form.delivery_date} onChange={(e) => setForm({ delivery_date: e.target.value })} onBlur={blur('delivery_date')} />
        </Field>
      </FormSection>

      <FormSection title="Delivery">
        {CUSTOMER_DELIVERY.includes(form.source_type) ? (
          <InlineNotice tone="ink" title="Delivered to the customer" className="sm:col-span-2">This order fulfils a customer order, so the supplier ships directly to the customer address below.</InlineNotice>
        ) : (
          <Field label="Receive into" optional help="The storage location that will book the goods in." id="storage_location_id">
            <Select value={form.storage_location_id} onChange={(e) => setForm({ storage_location_id: e.target.value })}>
              <option value="">Choose a location…</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.code} — {l.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Delivery address" optional help="Shared with the supplier on the order." className="sm:col-span-2" id="delivery_address">
          <Textarea rows={3} value={form.delivery_address} onChange={(e) => setForm({ delivery_address: e.target.value })} placeholder="Street, city, postal code, country" />
        </Field>
      </FormSection>

      <section aria-labelledby="po-lines-h" className="space-y-2" id="po-lines" tabIndex={-1}>
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 id="po-lines-h" className="text-sm font-semibold text-fg">Lines</h2>
            <p className="text-xs text-ink-500">Pick a catalog item to fill the description and unit, or type a free-text line.</p>
          </div>
        </div>
        {prefill && (
          <InlineNotice tone="brand" title={`${prefill.lines.length} line${prefill.lines.length === 1 ? '' : 's'} available from ${prefill.label}`} action={<span className="flex gap-1"><Button size="sm" variant="primary" onClick={() => { setLines(prefill.lines); setPrefill(null) }}>Replace my lines</Button><Button size="sm" variant="ghost" onClick={() => setPrefill(null)}>Keep mine</Button></span>}>
            You already typed lines, so they were not replaced.
          </InlineNotice>
        )}
        {submitted && allErrors.lineItems && <p className="text-xs text-risk-600" role="alert">{allErrors.lineItems}</p>}
        <LineItemEditor
          label="Purchase order lines"
          rows={lines}
          onChange={setLines}
          newRow={() => blankLine(form.delivery_date)}
          errors={submitted ? lineErrors : {}}
          currency={form.currency}
          transform={(row, key, val) => {
            if (key !== 'item_id' || !val) return row
            const it = items.find((x) => x.id === val)
            return it ? { ...row, item_description: it.name, unit_of_measure: it.unit_of_measure || row.unit_of_measure } : row
          }}
          columns={[
            { key: 'item_id', header: 'Catalog item', type: 'select', width: 190, placeholder: 'Free text', options: items.map((i) => ({ value: i.id, label: `${i.approved_item_code || i.item_code} · ${i.name}` })) },
            { key: 'item_description', header: 'Description', type: 'text', minWidth: 220, required: true, placeholder: 'What you are buying' },
            { key: 'unit_of_measure', header: 'Unit', type: 'text', width: 80, placeholder: 'EA' },
            { key: 'quantity', header: 'Qty', type: 'number', width: 90, required: true },
            { key: 'unit_price', header: 'Unit price', type: 'money', width: 120, required: true },
            { key: 'total', header: 'Line total', type: 'money', compute: (r) => (parseFloat(r.quantity) || 0) * (parseFloat(r.unit_price) || 0), total: true, width: 130 },
            { key: 'requested_delivery_date', header: 'Needed by', type: 'date', width: 150 },
          ]}
        />
      </section>

      <FormSection title="Terms" description="Payment terms, incoterms and currency" advanced defaultOpen={Boolean(form.payment_terms) || form.currency !== 'USD' || form.incoterms !== 'FOB'}>
        <Field label="Payment terms" optional id="payment_terms">
          <Select value={form.payment_terms} onChange={(e) => setForm({ payment_terms: e.target.value })}>
            <option value="">Supplier default</option>
            <option value="NET_30">Net 30 days</option>
            <option value="NET_60">Net 60 days</option>
            <option value="NET_90">Net 90 days</option>
            <option value="COD">Cash on delivery</option>
            <option value="PREPAID">Prepaid</option>
          </Select>
        </Field>
        <Field label="Incoterms" id="incoterms">
          <Select value={form.incoterms} onChange={(e) => setForm({ incoterms: e.target.value })}>
            <option value="FOB">FOB — Free on board</option>
            <option value="CIF">CIF — Cost, insurance and freight</option>
            <option value="EXW">EXW — Ex works</option>
            <option value="DDP">DDP — Delivered duty paid</option>
            <option value="DAP">DAP — Delivered at place</option>
          </Select>
        </Field>
        <Field label="Currency" id="currency">
          <Select value={form.currency} onChange={(e) => setForm({ currency: e.target.value })}>
            {['USD', 'EUR', 'GBP', 'CAD', 'JPY'].map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </Field>
      </FormSection>

      {/* Totals and actions stay in reach while scrolling the form. */}
      <div className="sticky bottom-0 z-10 -mx-4 border-t border-ink-200 bg-canvas/95 px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="mr-auto text-sm">
            <span className="text-ink-600">Total </span>
            <Money amount={subtotal} currency={form.currency} className="text-base font-semibold" />
            <span className="ml-2 text-xs text-ink-500">excluding tax</span>
          </div>
          <Button variant="ghost" onClick={() => navigate('/procurement/purchase-orders')}>Cancel</Button>
          <Button type="submit" loading={saving === 'draft'} disabled={Boolean(saving)}>Save draft</Button>
          <Button variant="primary" loading={saving === 'submit'} disabled={Boolean(saving)} onClick={() => save(true)}>Submit for approval</Button>
        </div>
      </div>
    </form>
  )
}
