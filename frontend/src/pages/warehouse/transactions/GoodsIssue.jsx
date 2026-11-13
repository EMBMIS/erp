import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PlusIcon } from '@heroicons/react/20/solid'
import api from '../../../services/api'
import { useResource, useResourceMutation } from '../../../hooks/useResource'
import { keys } from '../../../services/queryKeys'
import { useAuth } from '../../../contexts/AuthContext'
import {
  PageHeader, Button, Field, Input, Select, Textarea, Combobox, StatusBadge, Num, InlineNotice, ErrorSummary, describeError, notify,
} from '../../../components/ui'
import { ModeChooser } from '../WarehouseParts'
import { asList, today } from '../warehouseData'
import { TxSection, DocPicker, LineCard, TxFooter, BIG_COMBO } from './TxParts'

/**
 * Goods issue (GI) — take stock out: by hand to a cost centre, against a
 * customer's sales order, or as components for a work order.
 *
 * Work-order issues post to their own endpoint (issue-materials, which books
 * WIP against inventory for the order's BOM components); everything else is
 * a /warehouse/transactions GI.
 */
// A work order takes materials only while it is on the floor (the backend enforces the same).
const ISSUABLE_WORK_ORDER_STATUSES = ['RELEASED', 'IN_PROGRESS']
const REASONS = [
  { value: 'CONSUMPTION', label: 'Consumption' },
  { value: 'PRODUCTION', label: 'Production' },
  { value: 'MAINTENANCE', label: 'Maintenance' },
  { value: 'SAMPLE', label: 'Sample' },
  { value: 'WASTE', label: 'Waste' },
]
const BLANK_PICK = { inventory_item_id: '', item_name: '', available_quantity: 0, issue_quantity: '', unit_of_measure: '', storage_location: '', bin_location: '', reason_code: 'CONSUMPTION' }

export default function GoodsIssue() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [mode, setMode] = useState('manual') // 'manual' | 'so-linked' | 'work-order'
  const [doc, setDoc] = useState(null)
  const [form, setForm] = useState(() => ({
    transaction_type: 'GI', reference_document: '', reference_type: 'MANUAL', cost_center: '', job_reference: '', items: [], notes: '', issued_by: user?.id || '', issued_date: today(),
  }))
  const [pick, setPick] = useState(BLANK_PICK)
  const [pickTried, setPickTried] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState(null)

  const { data: rawItems } = useResource(keys.inventoryItems({ status: 'APPROVED' }), ({ signal }) => api.get('/inventory-items', { params: { status: 'APPROVED' }, signal }))
  const inventoryItems = useMemo(() => asList(rawItems), [rawItems])
  // Cost centres come from Controlling, not a hard-coded list.
  const { data: rawCC } = useResource(['cost-centers'], ({ signal }) => api.get('/cost-centers', { signal }))
  const costCenters = asList(rawCC).map((c) => ({ id: c.id || c.code, name: c.name || c.code }))
  const { data: rawSOs, loading: sosLoading } = useResource(keys.salesOrders({ status: 'CONFIRMED' }), ({ signal }) => api.get('/sales-orders', { params: { status: 'CONFIRMED' }, signal }), { enabled: mode === 'so-linked' })
  const { data: rawWOs, loading: wosLoading } = useResource(keys.workOrders(), ({ signal }) => api.get('/manufacturing/work-orders', { signal }), { enabled: mode === 'work-order' })
  const docs = mode === 'work-order' ? asList(rawWOs).filter((wo) => ISSUABLE_WORK_ORDER_STATUSES.includes(wo.status)) : asList(rawSOs)

  const { data: soDetail } = useResource(keys.salesOrder(doc?.id), ({ signal }) => api.get(`/sales-orders/${doc.id}`, { signal }), { enabled: mode === 'so-linked' && Boolean(doc?.id) })
  const { data: woDetail } = useResource(keys.workOrder(doc?.id), ({ signal }) => api.get(`/manufacturing/work-orders/${doc.id}`, { signal }), { enabled: mode === 'work-order' && Boolean(doc?.id) })

  // Each document's lines are applied once, so a refetch never overwrites quantities being typed.
  const applied = useRef(null)
  useEffect(() => {
    if (mode !== 'so-linked' || !doc || !soDetail || applied.current === `so:${doc.id}`) return
    if (!soDetail.items?.length) return
    applied.current = `so:${doc.id}`
    const items = soDetail.items.map((item) => {
      const inv = inventoryItems.find((x) => x.id === item.inventory_item_id)
      return {
        inventory_item_id: item.inventory_item_id || '',
        item_name: item.item_name || 'Unknown item',
        available_quantity: inv?.current_stock_quantity || 0,
        quantity: item.quantity || 0,
        issue_quantity: item.quantity || 0,
        issued_quantity: item.quantity || 0,
        unit_of_measure: item.unit_of_measure || 'PCS',
        storage_location: inv?.storage_location_name || '',
        bin_location: inv?.bin_code || '',
        reason_code: 'CONSUMPTION',
        id: Date.now() + Math.random(),
      }
    }).filter((x) => x.inventory_item_id)
    setForm((f) => ({ ...f, items }))
  }, [mode, doc, soDetail, inventoryItems])
  useEffect(() => {
    if (mode !== 'work-order' || !doc || !woDetail || applied.current === `wo:${doc.id}`) return
    applied.current = `wo:${doc.id}`
    const items = (woDetail.components || []).map((c) => {
      const outstanding = Number(c.quantity_required || 0) - Number(c.quantity_issued || 0)
      const inv = inventoryItems.find((x) => x.item_master_id === c.component_item_id)
      return {
        inventory_item_id: inv?.id || '',
        component_item_id: c.component_item_id,
        item_name: c.component_name || 'Unknown component',
        available_quantity: inv?.current_stock_quantity || 0,
        quantity: outstanding,
        issue_quantity: outstanding,
        issued_quantity: outstanding,
        unit_of_measure: c.unit_of_measure || 'PCS',
        storage_location: inv?.storage_location_name || '',
        bin_location: inv?.bin_code || '',
        reason_code: 'PRODUCTION',
        id: Date.now() + Math.random(),
      }
    }).filter((x) => x.quantity > 0)
    setForm((f) => ({ ...f, items }))
  }, [mode, doc, woDetail, inventoryItems])

  const changeMode = (m) => {
    setMode(m)
    setDoc(null)
    applied.current = null
    setSubmitted(false)
    setForm((f) => ({ ...f, items: [], reference_document: '', reference_type: m === 'manual' ? 'MANUAL' : f.reference_type }))
  }
  const pickDoc = (d) => {
    applied.current = null
    setDoc(d)
    setForm((f) => ({ ...f, items: [], reference_document: d.so_number || d.wo_number, reference_type: mode === 'so-linked' ? 'SO' : 'WO' }))
  }
  const choosePick = (id) => {
    const it = inventoryItems.find((x) => x.id === id)
    if (!it) return setPick(BLANK_PICK)
    return setPick((p) => ({ ...p, inventory_item_id: id, item_name: it.item_name || 'Unknown item', available_quantity: it.current_stock_quantity || 0, unit_of_measure: it.unit_of_measure || 'PCS', storage_location: it.storage_location_name || '', bin_location: it.bin_code || '' }))
  }
  const pickErrors = {}
  if (!pick.inventory_item_id) pickErrors.item = 'Choose an item.'
  if (!(parseFloat(pick.issue_quantity) > 0)) pickErrors.qty = 'Enter a quantity above zero.'
  else if (parseFloat(pick.issue_quantity) > Number(pick.available_quantity)) pickErrors.qty = `Only ${Number(pick.available_quantity)} available.`
  const addPick = () => {
    setPickTried(true)
    if (Object.keys(pickErrors).length) return
    const q = parseFloat(pick.issue_quantity)
    setForm((f) => ({ ...f, items: [...f.items, { ...pick, id: Date.now(), quantity: q, issue_quantity: q, issued_quantity: q }] }))
    setPick(BLANK_PICK)
    setPickTried(false)
  }
  const updateLine = (i, patch) => setForm((f) => ({
    ...f,
    items: f.items.map((it, j) => (j !== i ? it : { ...it, ...patch, ...('issue_quantity' in patch ? { issued_quantity: patch.issue_quantity, quantity: patch.issue_quantity } : {}) })),
  }))
  const removeLine = (i) => setForm((f) => ({ ...f, items: f.items.filter((_, j) => j !== i) }))

  const postIssue = useResourceMutation((payload) => api.post('/warehouse/transactions', payload), { invalidates: [['warehouse-transactions'], ['inventory-items']], silent: true })
  const postWO = useResourceMutation(({ workOrderId, issues }) => api.post(`/manufacturing/work-orders/${workOrderId}/issue-materials`, { issues }), { invalidates: [['work-orders'], ['inventory-items']], silent: true })

  const lineError = (it) => (!(parseFloat(it.issue_quantity) > 0) ? 'Enter a quantity above zero.' : null)
  const lineErrors = form.items.map(lineError)
  let blocking = null
  if (mode !== 'manual' && !doc) blocking = `Choose the ${mode === 'so-linked' ? 'sales order' : 'work order'} first.`
  else if (mode === 'manual' && !form.cost_center) blocking = 'Choose the cost centre this stock is charged to.'
  else if (!form.items.length) blocking = 'Add at least one item to issue.'

  const submit = async (e) => {
    e.preventDefault()
    setSubmitted(true)
    setServerError(null)
    if (blocking || lineErrors.some(Boolean)) return
    try {
      if (mode === 'work-order') {
        await postWO.mutateAsync({ workOrderId: doc.id, issues: form.items.map((it) => ({ component_item_id: it.component_item_id, quantity: Number(it.issue_quantity) })) })
        notify.success(`Materials issued to ${doc.wo_number}`)
        navigate('/manufacturing/work-orders')
        return
      }
      await postIssue.mutateAsync({ ...form, sales_order_id: mode === 'so-linked' ? doc?.id : null })
      notify.success(`Goods issue posted${form.reference_document ? ` for ${form.reference_document}` : ''}`)
      navigate('/warehouse/transactions')
    } catch (err) {
      setServerError(describeError(err))
    }
  }

  const totalQty = form.items.reduce((s, it) => s + (parseFloat(it.issue_quantity) || 0), 0)
  const summaryErrors = submitted ? [blocking && { id: 'gi-lines', message: blocking }, ...lineErrors.map((m, i) => m && { id: `gi-line-${i}`, message: `Line ${i + 1}: ${m.toLowerCase()}` })].filter(Boolean) : []

  return (
    <form onSubmit={submit} noValidate className="mx-auto max-w-4xl space-y-4">
      <PageHeader title="Goods issue" description="Take stock out of the warehouse — to a cost centre, a customer order or a work order." />

      <ModeChooser
        label="Issue for"
        value={mode}
        onChange={changeMode}
        options={[
          { value: 'manual', label: 'Cost centre', description: 'Internal use or ad-hoc issues.' },
          { value: 'so-linked', label: 'Sales order', description: 'Pick against a confirmed customer order.' },
          { value: 'work-order', label: 'Work order', description: 'Components for production.' },
        ]}
      />

      {serverError && <InlineNotice tone="risk" title="The issue was not posted">{serverError.message} Your entries are still here.</InlineNotice>}
      <ErrorSummary errors={summaryErrors} />

      {mode !== 'manual' && (
        <TxSection
          title={mode === 'so-linked' ? 'Sales order' : 'Work order'}
          action={doc ? <Button size="sm" variant="ghost" onClick={() => { setDoc(null); applied.current = null; setForm((f) => ({ ...f, items: [], reference_document: '' })) }}>Change</Button> : null}
        >
          {doc ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-mono text-base text-fg">{doc.so_number || doc.wo_number}</span>
              <StatusBadge status={doc.status} />
              <span className="text-sm text-ink-600">{mode === 'so-linked' ? doc.customer?.customer_name || doc.customer_name || 'Customer' : `Producing ${doc.quantity_ordered ?? '—'}${doc.product_name ? ` × ${doc.product_name}` : ''}`}</span>
            </div>
          ) : (
            <DocPicker
              docs={docs}
              loading={mode === 'so-linked' ? sosLoading : wosLoading}
              onPick={pickDoc}
              number={(d) => d.so_number || d.wo_number}
              title={(d) => (mode === 'so-linked' ? d.customer?.customer_name || d.customer_name || 'Customer' : d.product_name || `Quantity ${d.quantity_ordered ?? '—'}`)}
              trailing={(d) => <StatusBadge status={d.status} />}
              searchLabel={`Find a ${mode === 'so-linked' ? 'sales order' : 'work order'}`}
              emptyTitle={mode === 'so-linked' ? 'No confirmed sales orders' : 'No work order is on the floor'}
              emptyText={mode === 'so-linked' ? 'Only confirmed orders can be picked.' : 'Only released or in-progress work orders take materials.'}
            />
          )}
        </TxSection>
      )}

      {mode === 'manual' && (
        <TxSection title="Charge to">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Cost centre" required error={submitted && !form.cost_center ? 'Choose a cost centre.' : null} help={costCenters.length ? null : 'No cost centres are set up in Controlling yet.'} id="gi-cost-center">
              <Select size="lg" value={form.cost_center} onChange={(e) => setForm((f) => ({ ...f, cost_center: e.target.value }))}>
                <option value="">Choose a cost centre…</option>
                {costCenters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Job reference" optional id="gi-job-reference">
              <Input size="lg" value={form.job_reference} onChange={(e) => setForm((f) => ({ ...f, job_reference: e.target.value }))} placeholder="Job or project" />
            </Field>
          </div>
        </TxSection>
      )}

      {/* Work-order lines come only from its BOM: issue-materials posts against component ids. */}
      {mode !== 'work-order' && (
        <TxSection title="Add an item">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Item" required error={pickTried ? pickErrors.item : null} help={pick.inventory_item_id ? <>Available <Num value={pick.available_quantity} unit={pick.unit_of_measure} /></> : 'Type a name or code, or scan it.'} className="sm:col-span-2" id="gi-select-item">
              <Combobox className={BIG_COMBO} value={pick.inventory_item_id} onChange={choosePick} options={inventoryItems.map((it) => ({ value: it.id, label: it.item_name, meta: it.approved_item_code || it.item_code, description: `${Number(it.current_stock_quantity || 0)} ${it.unit_of_measure || ''} available` }))} placeholder="Search items" emptyText="No item matches" />
            </Field>
            <Field label="Quantity" required error={pickTried ? pickErrors.qty : null} id="gi-issue-qty">
              <Input size="lg" type="number" min="0" step="0.01" numeric suffix={pick.unit_of_measure} value={pick.issue_quantity} onChange={(e) => setPick((p) => ({ ...p, issue_quantity: e.target.value }))} />
            </Field>
            <Field label="Reason" id="gi-reason-code">
              <Select size="lg" value={pick.reason_code} onChange={(e) => setPick((p) => ({ ...p, reason_code: e.target.value }))}>
                {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </Select>
            </Field>
            <div className="sm:col-span-2"><Button size="lg" block icon={PlusIcon} onClick={addPick}>Add item</Button></div>
          </div>
        </TxSection>
      )}

      {form.items.length > 0 && (
        <TxSection title={`Lines to issue (${form.items.length})`}>
          <ul className="space-y-3" id="gi-lines">
            {form.items.map((it, i) => (
              <LineCard
                key={it.id || i}
                title={it.item_name}
                subtitle={<>Available <Num value={it.available_quantity} unit={it.unit_of_measure} />{it.storage_location && ` · ${it.storage_location}`}{it.bin_location && ` · bin ${it.bin_location}`}</>}
                onRemove={() => removeLine(i)}
                error={submitted ? lineErrors[i] : null}
              >
                <Field label="Issue" required id={`gi-line-${i}`}>
                  {/* Cap only when availability is known; a zero here means "not looked up", and the server checks anyway. */}
                  <Input size="lg" type="number" min="0" step="0.01" numeric suffix={it.unit_of_measure} value={it.issue_quantity} max={it.available_quantity > 0 ? it.available_quantity : undefined} onChange={(e) => updateLine(i, { issue_quantity: e.target.value })} />
                </Field>
                {mode !== 'work-order' && (
                  <Field label="Reason" id={`gi-line-${i}-reason`}>
                    <Select size="lg" value={it.reason_code} onChange={(e) => updateLine(i, { reason_code: e.target.value })}>
                      {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </Select>
                  </Field>
                )}
              </LineCard>
            ))}
          </ul>
        </TxSection>
      )}

      <TxSection title="Notes">
        <Field label="Notes" optional id="gi-notes">
          <Textarea rows={2} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Who collected it, what it is for…" />
        </Field>
      </TxSection>

      <TxFooter
        summary={form.items.length ? <><Num value={totalQty} className="font-semibold text-fg" /> units on {form.items.length} line{form.items.length === 1 ? '' : 's'}</> : 'Nothing to issue yet'}
        blocker={blocking}
        submitLabel={mode === 'work-order' ? 'Issue to work order' : 'Post goods issue'}
        loading={postIssue.isPending || postWO.isPending}
        onCancel={() => navigate('/warehouse/transactions')}
      />
    </form>
  )
}
