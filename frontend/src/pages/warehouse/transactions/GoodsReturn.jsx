import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PlusIcon } from '@heroicons/react/20/solid'
import api from '../../../services/api'
import { useResource, useResourceMutation } from '../../../hooks/useResource'
import { keys } from '../../../services/queryKeys'
import { useAuth } from '../../../contexts/AuthContext'
import {
  PageHeader, Button, Field, Input, Select, Textarea, StatusBadge, Money, Num, InlineNotice, ErrorSummary, SkeletonRows,
  describeError, notify,
} from '../../../components/ui'
import { ModeChooser } from '../WarehouseParts'
import { asList, today } from '../warehouseData'
import { TxSection, DocPicker, LineCard, TxFooter } from './TxParts'

/**
 * Goods return (GE) — send goods back to a supplier, take them back from a
 * customer, or bring them back from a job. Each line says how many, in what
 * condition, and why.
 */
const RETURNABLE_PO_STATUSES = ['COMPLETED', 'GOODS_READY_FOR_RECEIPT']
const RETURNABLE_SO_STATUSES = ['DELIVERED', 'COMPLETED']
const CONDITIONS = [['GOOD', 'Good'], ['DAMAGED', 'Damaged'], ['EXPIRED', 'Expired'], ['DEFECTIVE', 'Defective']]
const REASONS = [['DEFECTIVE', 'Defective'], ['DAMAGED', 'Damaged'], ['WRONG_ITEM', 'Wrong item'], ['EXCESS', 'Excess quantity'], ['EXPIRED', 'Expired'], ['QUALITY_ISSUE', 'Quality issue'], ['OTHER', 'Other']]
const BLANK_MANUAL = { item_name: '', description: '', return_quantity: '', unit_of_measure: 'PCS', storage_location_id: '', bin_id: '', condition: 'GOOD', reason_code: 'DEFECTIVE', unit_cost: '' }
const REF_TYPE = { supplier: 'PO', customer: 'SO', internal: 'MANUAL' }

export default function GoodsReturn() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [returnType, setReturnType] = useState('supplier')
  const [docId, setDocId] = useState(null)
  const [form, setForm] = useState(() => ({
    transaction_type: 'GE', return_type: 'supplier', reference_document: '', reference_type: 'PO', items: [], notes: '', processed_by: user?.id || '', return_date: today(),
  }))
  const [manual, setManual] = useState(BLANK_MANUAL)
  const [manualTried, setManualTried] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState(null)

  const { data: rawPOs, loading: posLoading } = useResource(keys.purchaseOrders({}), ({ signal }) => api.get('/purchase-orders', { signal }), { enabled: returnType === 'supplier' })
  const { data: rawSOs, loading: sosLoading } = useResource(keys.salesOrders({}), ({ signal }) => api.get('/sales-orders', { signal }), { enabled: returnType === 'customer' })
  const docs = returnType === 'supplier'
    ? asList(rawPOs).filter((po) => RETURNABLE_PO_STATUSES.includes(po.status))
    : returnType === 'customer' ? asList(rawSOs).filter((so) => RETURNABLE_SO_STATUSES.includes(so.status)) : []

  const { data: poDetail, loading: poLoading } = useResource(keys.purchaseOrder(docId), ({ signal }) => api.get(`/purchase-orders/${docId}`, { signal }), { enabled: returnType === 'supplier' && Boolean(docId) })
  const { data: soDetail, loading: soLoading } = useResource(keys.salesOrder(docId), ({ signal }) => api.get(`/sales-orders/${docId}`, { signal }), { enabled: returnType === 'customer' && Boolean(docId) })
  const detail = returnType === 'supplier' ? poDetail : returnType === 'customer' ? soDetail : null

  // Lines are applied once per document, so a refetch never overwrites quantities being typed.
  const applied = useRef(null)
  useEffect(() => {
    if (!docId || !detail || applied.current === `${returnType}:${docId}`) return
    applied.current = `${returnType}:${docId}`
    const items = (detail.items || []).map((item) => ({ ...item, return_quantity: '', max_return_quantity: item.quantity, storage_location_id: '', bin_id: '', condition: 'DEFECTIVE', reason_code: 'DEFECTIVE', notes: '' }))
    setForm((f) => ({ ...f, reference_document: returnType === 'supplier' ? detail.po_number : detail.so_number, items }))
  }, [returnType, docId, detail])

  const changeType = (t) => {
    setReturnType(t)
    setDocId(null)
    applied.current = null
    setSubmitted(false)
    setForm((f) => ({ ...f, return_type: t, reference_type: REF_TYPE[t], reference_document: '', items: [] }))
  }
  const updateLine = (i, patch) => setForm((f) => ({ ...f, items: f.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) }))
  const removeLine = (i) => setForm((f) => ({ ...f, items: f.items.filter((_, j) => j !== i) }))

  const manualErrors = {}
  if (!manual.item_name.trim()) manualErrors.item_name = 'Name the item.'
  if (!(parseFloat(manual.return_quantity) > 0)) manualErrors.return_quantity = 'Enter a quantity above zero.'
  const addManual = () => {
    setManualTried(true)
    if (Object.keys(manualErrors).length) return
    setForm((f) => ({ ...f, items: [...f.items, { ...manual, id: Date.now(), return_quantity: parseFloat(manual.return_quantity), unit_cost: parseFloat(manual.unit_cost) || 0 }] }))
    setManual(BLANK_MANUAL)
    setManualTried(false)
  }

  const post = useResourceMutation((payload) => api.post('/warehouse/transactions', payload), { invalidates: [['warehouse-transactions'], ['inventory-items']], silent: true })

  const lineError = (it) => {
    const q = parseFloat(it.return_quantity)
    if (!(q > 0)) return 'Enter how many are going back.'
    if (it.max_return_quantity != null && q > Number(it.max_return_quantity)) return `At most ${Number(it.max_return_quantity)} can be returned.`
    if (returnType !== 'internal' && !it.reason_code) return 'Choose a reason.'
    return null
  }
  // A document line nobody is returning is skipped, not an error — unless nothing is returned at all.
  const active = form.items.filter((it) => it.return_quantity !== '' && it.return_quantity != null)
  const lineErrors = form.items.map((it) => (it.max_return_quantity != null && (it.return_quantity === '' || it.return_quantity == null) ? null : lineError(it)))
  let blocking = null
  if (returnType !== 'internal' && !docId) blocking = `Choose the ${returnType === 'supplier' ? 'purchase order' : 'sales order'} first.`
  else if (!active.length) blocking = 'Enter a return quantity on at least one line.'

  const submit = async (e) => {
    e.preventDefault()
    setSubmitted(true)
    setServerError(null)
    if (blocking || lineErrors.some(Boolean)) return
    try {
      await post.mutateAsync({ ...form, items: active })
      notify.success(`Goods return posted${form.reference_document ? ` for ${form.reference_document}` : ''}`)
      navigate('/warehouse/transactions')
    } catch (err) {
      setServerError(describeError(err))
    }
  }

  const totalQty = active.reduce((s, it) => s + (parseFloat(it.return_quantity) || 0), 0)
  const summaryErrors = submitted ? [blocking && { id: 'ge-lines', message: blocking }, ...lineErrors.map((m, i) => m && { id: `ge-line-${i}`, message: `Line ${i + 1}: ${m.toLowerCase()}` })].filter(Boolean) : []
  const docLabel = returnType === 'supplier' ? 'Purchase order' : 'Sales order'

  return (
    <form onSubmit={submit} noValidate className="mx-auto max-w-4xl space-y-4">
      <PageHeader title="Goods return" description="Send goods back to a supplier, take them back from a customer, or return them from a job." />

      <ModeChooser
        label="Return type"
        value={returnType}
        onChange={changeType}
        options={[
          { value: 'supplier', label: 'To a supplier', description: 'Defective or excess goods against a PO.' },
          { value: 'customer', label: 'From a customer', description: 'Goods a customer sends back.' },
          { value: 'internal', label: 'From a job', description: 'Unused stock back from a project or job.' },
        ]}
      />

      {serverError && <InlineNotice tone="risk" title="The return was not posted">{serverError.message} Your entries are still here.</InlineNotice>}
      <ErrorSummary errors={summaryErrors} />

      {returnType !== 'internal' && (
        <TxSection title={docLabel} action={docId ? <Button size="sm" variant="ghost" onClick={() => { setDocId(null); applied.current = null; setForm((f) => ({ ...f, reference_document: '', items: [] })) }}>Change</Button> : null}>
          {docId ? (
            (poLoading || soLoading) && !detail ? <SkeletonRows rows={1} columns={2} /> : (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="font-mono text-base text-fg">{detail?.po_number || detail?.so_number}</span>
                {detail?.status && <StatusBadge status={detail.status} />}
                <span className="text-sm text-ink-600">{returnType === 'supplier' ? detail?.supplier_name : detail?.customer_name}</span>
              </div>
            )
          ) : (
            <DocPicker
              docs={docs}
              loading={returnType === 'supplier' ? posLoading : sosLoading}
              onPick={(d) => { applied.current = null; setDocId(d.id) }}
              number={(d) => d.po_number || d.so_number}
              title={(d) => (returnType === 'supplier' ? d.supplier_name : d.customer_name) || '—'}
              trailing={(d) => <span className="flex flex-col items-end gap-1"><Money amount={d.total_amount ?? d.total} currency={d.currency} /><StatusBadge status={d.status} /></span>}
              searchLabel={`Find a ${docLabel.toLowerCase()}`}
              emptyTitle={`No ${docLabel.toLowerCase()}s can be returned against`}
              emptyText={returnType === 'supplier' ? 'Only completed purchase orders, or those ready for receipt, take returns.' : 'Only delivered or completed sales orders take returns.'}
            />
          )}
        </TxSection>
      )}

      {returnType === 'internal' && (
        <TxSection title="Add an item">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Item" required error={manualTried ? manualErrors.item_name : null} id="grn-item-name">
              <Input size="lg" value={manual.item_name} onChange={(e) => setManual((m) => ({ ...m, item_name: e.target.value }))} placeholder="Item name" />
            </Field>
            <Field label="Quantity" required error={manualTried ? manualErrors.return_quantity : null} id="grn-return-quantity">
              <Input size="lg" type="number" min="0" step="0.01" numeric value={manual.return_quantity} onChange={(e) => setManual((m) => ({ ...m, return_quantity: e.target.value }))} />
            </Field>
            <Field label="Condition" id="grn-condition">
              <Select size="lg" value={manual.condition} onChange={(e) => setManual((m) => ({ ...m, condition: e.target.value }))}>
                {CONDITIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
            </Field>
            <div className="flex items-end"><Button size="lg" block icon={PlusIcon} onClick={addManual}>Add item</Button></div>
          </div>
        </TxSection>
      )}

      {form.items.length > 0 && (
        <TxSection title={`Lines (${form.items.length})`} description={returnType !== 'internal' ? 'Enter a quantity only on the lines going back. Lines left empty are skipped.' : null}>
          <ul className="space-y-3" id="ge-lines">
            {form.items.map((it, i) => (
              <LineCard
                key={it.id || i}
                title={it.item_name || it.item_description || 'Item'}
                subtitle={it.max_return_quantity != null ? <>Up to <Num value={it.max_return_quantity} unit={it.unit_of_measure} /></> : it.description}
                onRemove={() => removeLine(i)}
                error={submitted ? lineErrors[i] : null}
              >
                <Field label="Return" id={`ge-line-${i}`}>
                  <Input size="lg" type="number" min="0" step="0.01" numeric suffix={it.unit_of_measure} max={it.max_return_quantity ?? undefined} value={it.return_quantity} onChange={(e) => updateLine(i, { return_quantity: e.target.value })} placeholder="0" />
                </Field>
                <Field label="Condition" id={`ge-line-${i}-condition`}>
                  <Select size="lg" value={it.condition || 'GOOD'} onChange={(e) => updateLine(i, { condition: e.target.value })}>
                    {CONDITIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </Select>
                </Field>
                <Field label="Reason" id={`ge-line-${i}-reason`}>
                  <Select size="lg" value={it.reason_code || 'DEFECTIVE'} onChange={(e) => updateLine(i, { reason_code: e.target.value })}>
                    {REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </Select>
                </Field>
              </LineCard>
            ))}
          </ul>
        </TxSection>
      )}

      <TxSection title="Notes">
        <Field label="Notes" optional id="grn-notes">
          <Textarea rows={2} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="RMA number, carrier, what was wrong…" />
        </Field>
      </TxSection>

      <TxFooter
        summary={active.length ? <><Num value={totalQty} className="font-semibold text-fg" /> units on {active.length} line{active.length === 1 ? '' : 's'}</> : 'Nothing to return yet'}
        blocker={blocking}
        submitLabel="Post goods return"
        loading={post.isPending}
        onCancel={() => navigate('/warehouse/transactions')}
      />
    </form>
  )
}
