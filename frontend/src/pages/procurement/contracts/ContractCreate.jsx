import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { PlusIcon, XMarkIcon, PaperClipIcon } from '@heroicons/react/20/solid'
import api from '../../../services/api'
import { useResource } from '../../../hooks/useResource'
import { keys } from '../../../services/queryKeys'
import {
  PageHeader, Button, Field, Input, Select, Textarea, Checkbox, FormSection, ErrorSummary, InlineNotice, Money, Num,
  DataTable, RowAction, Segmented, useDraft, notify,
} from '../../../components/ui'

/**
 * New contract with a certified supplier, optionally with items from what
 * the supplier supplies.
 *
 * Payload (multipart POST /contracts, then POST /contract-items/bulk) is
 * unchanged. Field ids (#supplier_id, #title, #contract_value, #start_date,
 * #end_date, #item, #quantity) and the "Add Item" / "Add Item to Contract" /
 * "Create Contract" button names are kept: frontend/e2e/contract-creation
 * drives this form by them.
 */
const TYPES = [
  { value: 'PURCHASE', label: 'Purchase', help: 'Goods, materials or equipment.' },
  { value: 'SERVICE', label: 'Service', help: 'Professional services, consulting or maintenance.' },
  { value: 'FRAMEWORK', label: 'Framework', help: 'Master terms for future orders.' },
]
const ALLOWED = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']

const initial = (supplierId) => ({
  form: {
    supplier_id: supplierId || '',
    title: '',
    description: '',
    contract_type: 'PURCHASE',
    start_date: '',
    end_date: '',
    contract_value: '',
    currency: 'USD',
    terms: '',
    document_url: '',
    digital_contract_required: false,
  },
  items: [],
})

function validate(f) {
  const e = {}
  if (!f.supplier_id) e.supplier_id = 'Choose a certified supplier.'
  if (!f.title) e.title = 'Give the contract a title people will recognise.'
  if (!f.contract_value) e.contract_value = 'Enter the contract value.'
  if (!f.start_date) e.start_date = 'Set the start date.'
  if (!f.end_date) e.end_date = 'Set the end date.'
  if (f.start_date && f.end_date && new Date(f.start_date) >= new Date(f.end_date)) e.end_date = 'The end date must be after the start date.'
  if (f.digital_contract_required && !f.document_url?.trim()) e.document_url = 'Enter the signing link, or untick “Digital copy required”.'
  return e
}

export default function ContractCreate() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const presetSupplier = params.get('supplier_id')
  const start = useMemo(() => initial(presetSupplier), [presetSupplier])
  const { value, setValue, restored, savedAt, clear, discard } = useDraft(`contract:new${presetSupplier ? `:${presetSupplier}` : ''}`, start)
  const { form, items: contractItems } = value
  const setForm = (patch) => setValue((v) => ({ ...v, form: { ...v.form, ...patch } }))
  const setItems = (fn) => setValue((v) => ({ ...v, items: fn(v.items) }))

  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState(null)
  const [file, setFile] = useState(null)
  const [fileError, setFileError] = useState(null)
  const [showAddItem, setShowAddItem] = useState(false)
  const [line, setLine] = useState({ item: '', quantity: '', price: '', specifications: '' })
  const [lineError, setLineError] = useState(null)

  const { data: rawSuppliers, loading: suppliersLoading } = useResource(keys.suppliers({ status: 'ACTIVE' }), ({ signal }) => api.get('/suppliers', { params: { status: 'ACTIVE' }, signal }))
  const suppliers = (Array.isArray(rawSuppliers) ? rawSuppliers : rawSuppliers?.data || []).filter((s) => s.certification_status === 'CERTIFIED')

  const { data: rawSupplierItems, loading: itemsLoading } = useResource(keys.supplierItems(form.supplier_id), ({ signal }) => api.get(`/supplier-items/by-supplier/${form.supplier_id}`, { signal }), { enabled: Boolean(form.supplier_id) })
  const availableItems = (Array.isArray(rawSupplierItems) ? rawSupplierItems : rawSupplierItems?.data || []).filter((i) => i.status === 'ACTIVE')

  const allErrors = useMemo(() => validate(form), [form])
  const errors = submitted ? allErrors : Object.fromEntries(Object.entries(allErrors).filter(([k]) => touched[k]))
  const blur = (k) => () => setTouched((t) => ({ ...t, [k]: true }))
  const set = (k) => (e) => setForm({ [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })

  const pickFile = (e) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (!ALLOWED.includes(f.type)) { setFileError('Only PDF and Word documents (.pdf, .doc, .docx) can be attached.'); return }
    if (f.size > 10 * 1024 * 1024) { setFileError('The file is larger than 10 MB. Attach a smaller copy.'); return }
    setFileError(null)
    setFile(f)
  }

  const addItem = () => {
    setLineError(null)
    if (!line.item || !line.quantity) { setLineError('Choose an item and enter a quantity.'); return }
    const item = availableItems.find((i) => i.item_id === line.item)
    if (!item) return
    const finalPrice = (line.price ? parseFloat(line.price) : null) || (item.unit_price ? parseFloat(item.unit_price) : null)
    if (!finalPrice || finalPrice <= 0) { setLineError('Enter a unit price above zero for this item.'); return }
    if (contractItems.some((ci) => ci.item_id === line.item)) { setLineError('This item is already on the contract.'); return }
    setItems((prev) => [...prev, {
      item_id: line.item,
      item_name: item.item_name,
      sku: item.sku,
      unit_of_measure: item.unit_of_measure,
      quantity: parseFloat(line.quantity),
      unit_price: finalPrice,
      currency: form.currency,
      specifications: line.specifications,
      total_amount: (parseFloat(line.quantity) * finalPrice).toFixed(2),
      needs_supplier_assignment: false,
    }])
    setLine({ item: '', quantity: '', price: '', specifications: '' })
    setShowAddItem(false)
  }

  const submit = async (e) => {
    e.preventDefault()
    setSubmitted(true)
    setServerError(null)
    if (Object.keys(allErrors).length) return
    setSaving(true)
    try {
      const body = new FormData()
      Object.keys(form).forEach((k) => { if (form[k] !== null && form[k] !== '') body.append(k, form[k]) })
      if (file) body.append('contractFile', file)
      const response = await api.post('/contracts', body)
      const result = response.data
      if (!result.success) throw new Error(result.error || 'The contract was not created.')
      const contract = result.data
      clear()
      if (contractItems.length > 0) {
        try {
          const itemsResponse = await api.post('/contract-items/bulk', { contract_id: contract.id, items: contractItems })
          const made = itemsResponse.data?.data?.summary?.successfully_created
          if (itemsResponse.data.success && (made == null || made === contractItems.length)) notify.success(`${contract.contract_number || 'Contract'} created with ${contractItems.length} item${contractItems.length === 1 ? '' : 's'}`)
          else notify.error(`${contract.contract_number || 'Contract'} created, but ${made != null ? `only ${made} of ${contractItems.length}` : 'not all'} items were added. Add the rest on the contract.`)
        } catch {
          notify.error(`${contract.contract_number || 'Contract'} created, but its items could not be added. Add them on the contract.`)
        }
      } else {
        notify.success(`${contract.contract_number || 'Contract'} created`)
      }
      navigate(contract?.id ? `/procurement/contracts/${contract.id}` : '/procurement/contracts')
    } catch (err) {
      const d = err?.response?.data || {}
      setServerError({ message: d.error || err.message, reference: d.error_id })
    } finally {
      setSaving(false)
    }
  }

  const itemsTotal = contractItems.reduce((t, i) => t + (parseFloat(i.total_amount) || 0), 0)
  const linePick = availableItems.find((i) => i.item_id === line.item)

  return (
    <form onSubmit={submit} className="mx-auto max-w-4xl space-y-5" noValidate>
      <PageHeader
        title="Create new contract"
        description="Fix price and terms with a certified supplier for a period. It goes for approval once submitted from the contract."
        meta={savedAt ? <span aria-live="polite">Draft saved in this browser {new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> : null}
      />

      {restored && (
        <InlineNotice tone="ink" title="Picked up where you left off" action={<Button size="sm" variant="ghost" onClick={discard}>Start over</Button>}>
          Restored from a draft saved in this browser. Attached files are not kept in drafts.
        </InlineNotice>
      )}
      {serverError && (
        <InlineNotice tone="risk" title="The contract was not created">
          {serverError.message} Your entries are still here.{serverError.reference && <> Reference <span className="font-mono">{serverError.reference}</span>.</>}
        </InlineNotice>
      )}
      <ErrorSummary errors={submitted ? Object.entries(allErrors).map(([id, message]) => ({ id, message })) : []} />

      <FormSection title="Contract">
        <Field label="Supplier" required error={errors.supplier_id} help={!suppliersLoading && suppliers.length === 0 ? 'No certified suppliers yet. A supplier must be approved and certified before it can be put under contract.' : 'Only certified suppliers are listed.'} className="sm:col-span-2" id="supplier_id">
          <Select name="supplier_id" value={form.supplier_id} onChange={(e) => { setForm({ supplier_id: e.target.value }); setItems(() => []) }} onBlur={blur('supplier_id')}>
            <option value="">{suppliersLoading ? 'Loading suppliers…' : 'Choose a certified supplier…'}</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.legal_name} ({s.supplier_code})</option>)}
          </Select>
        </Field>
        <Field label="Title" required error={errors.title} className="sm:col-span-2" id="title">
          <Input name="title" value={form.title} onChange={set('title')} onBlur={blur('title')} placeholder="e.g. Steel plate supply 2027" />
        </Field>
        <Field label="Value" required error={errors.contract_value} id="contract_value">
          <Input type="number" step="0.01" min="0" numeric name="contract_value" value={form.contract_value} onChange={set('contract_value')} onBlur={blur('contract_value')} placeholder="0.00" />
        </Field>
        <Field label="Currency" id="currency">
          <Select name="currency" value={form.currency} onChange={set('currency')}>
            {['USD', 'EUR', 'GBP', 'AZN'].map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </Field>
        <Field label="Starts" required error={errors.start_date} id="start_date">
          <Input type="date" name="start_date" value={form.start_date} onChange={set('start_date')} onBlur={blur('start_date')} />
        </Field>
        <Field label="Ends" required error={errors.end_date} id="end_date">
          <Input type="date" name="end_date" min={form.start_date || undefined} value={form.end_date} onChange={set('end_date')} onBlur={blur('end_date')} />
        </Field>
        <div className="sm:col-span-2">
          <p className="mb-1 text-sm font-medium text-ink-800" id="contract-type-label">Type</p>
          <Segmented label="Contract type" value={form.contract_type} onChange={(v) => setForm({ contract_type: v })} options={TYPES.map((t) => ({ value: t.value, label: t.label }))} />
          <p className="mt-1 text-xs text-ink-500">{TYPES.find((t) => t.value === form.contract_type)?.help}</p>
        </div>
        <Field label="Description" optional className="sm:col-span-2" id="description">
          <Textarea name="description" rows={3} value={form.description} onChange={set('description')} placeholder="What the contract covers" />
        </Field>
        <Field label="Terms and conditions" optional className="sm:col-span-2" id="terms">
          <Textarea name="terms" rows={4} value={form.terms} onChange={set('terms')} />
        </Field>
      </FormSection>

      {form.supplier_id && (
        <FormSection
          title="Contract Items"
          description="Optional. Items come from what this supplier supplies."
          columns={1}
          aside={
            <Button size="sm" icon={showAddItem ? XMarkIcon : PlusIcon} onClick={() => { setShowAddItem((s) => !s); setLineError(null) }} disabled={!availableItems.length && !showAddItem}>
              {showAddItem ? 'Cancel' : 'Add Item'}
            </Button>
          }
        >
          {showAddItem && (
            <div className="rounded-md border border-ink-200 bg-sunken p-3">
              {lineError && <InlineNotice tone="risk" className="mb-3">{lineError}</InlineNotice>}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Item" required id="item">
                  <Select value={line.item} onChange={(e) => { const it = availableItems.find((i) => i.item_id === e.target.value); setLine((l) => ({ ...l, item: e.target.value, price: it?.unit_price ? String(it.unit_price) : '' })) }}>
                    <option value="">Choose an item…</option>
                    {availableItems.map((it) => (
                      <option key={it.item_id} value={it.item_id}>{it.item_name} ({it.sku}) - {it.unit_price ? `${form.currency} ${it.unit_price}` : 'Price required'}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Quantity" required id="quantity">
                  <Input type="number" step="0.01" min="0" numeric value={line.quantity} onChange={(e) => setLine((l) => ({ ...l, quantity: e.target.value }))} />
                </Field>
                <Field label={`Unit price (${form.currency})`} help={linePick?.unit_price ? 'Defaults to the supplier’s catalogue price.' : 'Required — this item has no catalogue price.'} id="unit-price">
                  <Input type="number" step="0.01" min="0" numeric value={line.price} onChange={(e) => setLine((l) => ({ ...l, price: e.target.value }))} />
                </Field>
                <div>
                  <p className="mb-1 text-sm font-medium text-ink-800">Line total</p>
                  <p className="flex h-8 items-center text-sm"><Money amount={line.quantity && line.price ? parseFloat(line.quantity) * parseFloat(line.price) : null} currency={form.currency} /></p>
                </div>
                <Field label="Specifications" optional className="sm:col-span-2" id="specifications">
                  <Textarea rows={2} value={line.specifications} onChange={(e) => setLine((l) => ({ ...l, specifications: e.target.value }))} placeholder="Grade, delivery requirements…" />
                </Field>
              </div>
              <div className="mt-3 flex justify-end">
                <Button variant="secondary" icon={PlusIcon} onClick={addItem}>Add Item to Contract</Button>
              </div>
            </div>
          )}

          {contractItems.length > 0 ? (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-fg">Selected Items ({contractItems.length})</h3>
              <DataTable
                caption="Items on this contract"
                noun="item"
                rows={contractItems}
                rowKey={(r) => r.item_id}
                search={false}
                showCount={false}
                columns={[
                  { id: 'item', header: 'Item', accessor: 'item_name', minWidth: 200, mobile: 'title', cell: (r) => <span className="block min-w-0"><span className="block truncate">{r.item_name}</span><span className="block truncate font-mono text-2xs text-ink-500">{r.sku}{r.specifications ? ` · ${r.specifications}` : ''}</span></span> },
                  { id: 'qty', header: 'Qty', accessor: 'quantity', align: 'right', width: 110, cell: (r) => <Num value={r.quantity} digits={r.quantity % 1 ? 2 : 0} unit={r.unit_of_measure} />, mobile: 'subtitle' },
                  { id: 'price', header: 'Unit price', accessor: 'unit_price', align: 'right', width: 130, cell: (r) => <Money amount={r.unit_price} currency={r.currency} /> },
                  { id: 'total', header: 'Total', accessor: (r) => parseFloat(r.total_amount), align: 'right', width: 140, mobile: 'trailing', cell: (r) => <Money amount={r.total_amount} currency={r.currency} />, footer: () => <Money amount={itemsTotal} currency={form.currency} /> },
                ]}
                rowActions={(r) => <RowAction icon={XMarkIcon} tone="risk" label={`Remove ${r.item_name}`} onClick={() => setItems((prev) => prev.filter((x) => x.item_id !== r.item_id))} />}
              />
              {form.contract_value && Math.abs(itemsTotal - parseFloat(form.contract_value)) > 0.01 && (
                <p className="text-xs text-ink-500">Items add up to <Money amount={itemsTotal} currency={form.currency} />; the contract value is <Money amount={form.contract_value} currency={form.currency} />.</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-ink-500">
              {itemsLoading ? 'Reading what this supplier supplies…' : availableItems.length > 0 ? 'No items added yet. Use Add Item to put supplier items on the contract.' : 'This supplier has no active items yet. Assign items to the supplier first, on its Items supplied tab.'}
            </p>
          )}
        </FormSection>
      )}

      <FormSection title="Documents" description="Signed copy and e-signature link" advanced defaultOpen={form.digital_contract_required || Boolean(file)} columns={1}>
        <Checkbox id="digital_contract_required" name="digital_contract_required" checked={form.digital_contract_required} onChange={set('digital_contract_required')} label="Digital copy or electronic signature required" />
        {form.digital_contract_required && (
          <Field label="Signing link" required error={errors.document_url} help="The URL from your e-signature service." id="document_url">
            <Input type="url" name="document_url" value={form.document_url} onChange={set('document_url')} onBlur={blur('document_url')} placeholder="https://…" />
          </Field>
        )}
        <div>
          <p className="mb-1 text-sm font-medium text-ink-800">Contract document <span className="text-xs font-normal text-ink-500">(optional)</span></p>
          {file ? (
            <div className="flex items-center gap-3 rounded-md border border-ink-200 px-3 py-2">
              <PaperClipIcon className="h-4 w-4 text-ink-500" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-sm">{file.name}</span>
              <span className="text-xs tabular-nums text-ink-500">{(file.size / 1024 / 1024).toFixed(2)} MB</span>
              <Button size="sm" variant="ghost" onClick={() => setFile(null)}>Remove</Button>
            </div>
          ) : (
            <label htmlFor="contract-file" className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-ink-300 bg-surface px-3 text-sm text-ink-800 hover:bg-ink-50 focus-within:ring-[3px] focus-within:ring-brand-500/20">
              <PaperClipIcon className="h-4 w-4" aria-hidden="true" />
              Attach PDF or Word file
              <input id="contract-file" name="contract-file" type="file" className="sr-only" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={pickFile} />
            </label>
          )}
          {fileError ? <p className="mt-1 text-xs text-risk-600">{fileError}</p> : <p className="mt-1 text-xs text-ink-500">A scanned or signed copy, up to 10 MB.</p>}
        </div>
      </FormSection>

      <div className="sticky bottom-0 z-10 -mx-4 border-t border-ink-200 bg-canvas/95 px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center justify-end gap-3">
          <div className="mr-auto text-sm">
            <span className="text-ink-600">Value </span>
            <Money amount={form.contract_value || null} currency={form.currency} className="text-base font-semibold" />
          </div>
          <Button variant="ghost" onClick={() => navigate('/procurement/contracts')}>Cancel</Button>
          <Button type="submit" variant="primary" loading={saving}>Create Contract</Button>
        </div>
      </div>
    </form>
  )
}
