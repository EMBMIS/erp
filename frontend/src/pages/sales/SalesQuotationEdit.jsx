import { useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useRecordTitle } from '../../components/shell/ShellContext'
import { Button, PageHeader, InlineNotice, SkeletonDetail, ErrorState, StatusBadge, Code, notify } from '../../components/ui'
import { QuotationForm } from './SalesQuotationCreate'

const LOCKED = ['ACCEPTED', 'REJECTED', 'CANCELLED']
const day = (v) => (v ? String(v).split('T')[0] : '')

/** Edit a sales quotation: the same form as "New quotation", seeded from the record. */
export default function SalesQuotationEdit() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data: q, loading, error, refetch } = useResource(keys.salesQuotation(id), ({ signal }) => api.get(`/sales-quotations/${id}`, { signal }), { enabled: !!id })
  useRecordTitle(q?.quotation_number, { subtitle: q?.customer_name })

  const update = useResourceMutation((payload) => api.put(`/sales-quotations/${id}`, payload), {
    invalidates: [keys.salesQuotation(id), ['sales-quotations'], ['sales-quotations-stats']],
    silent: true,
  })

  const initial = useMemo(() => (q ? {
    form: {
      customer_id: q.customer_id || '', customer_name: q.customer_name || '', quotation_date: day(q.quotation_date), valid_until: day(q.valid_until),
      reference_number: q.reference_number || '', currency: q.currency || 'USD', priority: q.priority || 'NORMAL',
      delivery_address: q.delivery_address || '', delivery_terms: q.delivery_terms || '', estimated_delivery_days: q.estimated_delivery_days ?? '',
      notes: q.notes || '', internal_notes: q.internal_notes || '', terms_and_conditions: q.terms_and_conditions || '', payment_terms: q.payment_terms ?? '',
    },
    lines: (q.items || []).map((it, i) => ({
      ...it,
      _key: it.id || `l${i}`,
      inventory_item_id: it.inventory_item_id || '',
      item_description: it.item_description || '',
      quantity: it.quantity != null ? String(Number(it.quantity)) : '',
      unit_price: it.unit_price != null ? String(Number(it.unit_price)) : '',
      discount_amount: Number(it.discount_amount) ? String(Number(it.discount_amount)) : '',
      estimated_delivery_date: day(it.estimated_delivery_date),
      sourcing_type: it.sourcing_type || 'STOCK',
      source_bin_id: it.source_bin_id || '',
      linked_sales_rfq_id: it.linked_sales_rfq_id || '',
      supplier_id: it.supplier_id || '',
      supplier_name: it.supplier_name || '',
      estimated_supplier_cost: Number(it.estimated_supplier_cost) ? String(Number(it.estimated_supplier_cost)) : '',
    })),
  } : null), [q])

  if (loading) return <SkeletonDetail />
  if (error || !q) {
    return <ErrorState what="Sales quotation" error={error || { response: { status: 404, data: { error: 'No quotation with this id is visible to you.' } } }} onRetry={refetch} />
  }

  if (LOCKED.includes(q.status)) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <PageHeader title={<>Edit <Code className="text-[1em]">{q.quotation_number}</Code></>} status={<StatusBadge status={q.status} />} />
        <InlineNotice tone="warn" title="This quotation can no longer be edited" action={<Button size="sm" to={`/sales/quotations/${id}`}>Back to quotation</Button>}>
          It is {q.status.replace(/_/g, ' ').toLowerCase()}. Only quotations that are not yet accepted, rejected or cancelled can be changed. Raise a new quotation instead.
        </InlineNotice>
      </div>
    )
  }

  const onSave = async (payload) => {
    await update.mutateAsync(payload)
    notify.success(`${q.quotation_number} updated`)
    navigate(`/sales/quotations/${id}`)
  }

  return (
    <QuotationForm
      key={q.id}
      title={<>Edit <Code className="text-[1em]">{q.quotation_number}</Code></>}
      description="Change the customer, validity, lines or terms. The server recalculates totals and tax on save."
      meta={<span>Status <StatusBadge status={q.status} /></span>}
      initialValue={initial.lines.length ? initial : { ...initial, lines: [{ _key: 'l0', item_name: '', quantity: '1', unit_of_measure: 'PCS', unit_price: '', sourcing_type: 'STOCK' }] }}
      cancelTo={`/sales/quotations/${id}`}
      onSave={onSave}
      actions={({ saving }) => <Button type="submit" variant="primary" loading={Boolean(saving)} disabled={Boolean(saving)}>Save changes</Button>}
    />
  )
}
