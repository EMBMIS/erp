import { useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useRecordTitle } from '../../components/shell/ShellContext'
import { SkeletonDetail, ErrorState, StatusBadge, Code, notify } from '../../components/ui'
import { RfqForm } from './SalesRfqCreate'

const day = (v) => {
  if (!v) return ''
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().split('T')[0]
}

/** Edit an RFQ to a supplier: the same form as "New RFQ", seeded from the record. */
export default function SalesRfqEdit() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data: rfq, loading, error, refetch } = useResource(keys.salesRfq(id), ({ signal }) => api.get(`/sales-rfqs/${id}`, { signal }), { enabled: !!id })
  useRecordTitle(rfq?.rfq_number, { subtitle: rfq?.rfq_title })

  const update = useResourceMutation((payload) => api.put(`/sales-rfqs/${id}`, payload), {
    invalidates: [keys.salesRfq(id), ['sales-rfqs'], ['sales-rfqs-stats']],
    silent: true,
  })

  const initial = useMemo(() => (rfq ? {
    manual: !rfq.supplier_id,
    form: {
      rfq_title: rfq.rfq_title || '', supplier_id: rfq.supplier_id || '', supplier_name: rfq.supplier_name || '', supplier_email: rfq.supplier_email || '',
      supplier_contact_person: rfq.supplier_contact_person || '', supplier_phone: rfq.supplier_phone || '', request_type: rfq.request_type || 'TRADING',
      required_delivery_date: day(rfq.required_delivery_date), delivery_location: rfq.delivery_location || '', delivery_terms: rfq.delivery_terms || '',
      payment_terms: rfq.payment_terms || '', priority: rfq.priority || 'MEDIUM', response_deadline: day(rfq.response_deadline),
      special_requirements: rfq.special_requirements || '', terms_and_conditions: rfq.terms_and_conditions || '', internal_notes: rfq.internal_notes || '',
      attachment_urls: Array.isArray(rfq.attachment_urls) ? rfq.attachment_urls.join(', ') : rfq.attachment_urls || '',
      linked_customer_id: rfq.linked_customer_id || '',
    },
    lines: (rfq.items?.length ? rfq.items : [{}]).map((it, i) => ({
      _key: it.id || `l${i}`,
      item_id: it.item_id || '',
      item_name: it.item_name || '',
      item_description: it.item_description || '',
      item_specification: it.item_specification || '',
      requested_quantity: it.requested_quantity != null ? String(Number(it.requested_quantity)) : '',
      unit_of_measure: it.unit_of_measure || '',
      estimated_unit_price: it.estimated_unit_price != null ? String(Number(it.estimated_unit_price)) : '',
    })),
  } : null), [rfq])

  if (loading) return <SkeletonDetail />
  if (error || !rfq) {
    return <ErrorState what="RFQ to supplier" error={error || { response: { status: 404, data: { error: 'No RFQ with this id is visible to you.' } } }} onRetry={refetch} />
  }

  const onSave = async (payload) => {
    await update.mutateAsync(payload)
    notify.success(`${rfq.rfq_number} updated`)
    navigate(`/sales/rfqs/${id}`)
  }

  return (
    <RfqForm
      key={rfq.id}
      title={<>Edit <Code className="text-[1em]">{rfq.rfq_number}</Code></>}
      description={rfq.status === 'DRAFT' ? 'Change anything before it goes for approval.' : 'This RFQ is past draft; changes are visible to approvers and, once sent, may not reach the supplier.'}
      meta={<span>Status <StatusBadge status={rfq.status} /></span>}
      initialValue={initial}
      cancelTo={`/sales/rfqs/${id}`}
      onSave={onSave}
      submitLabel="Save changes"
      supplierSource="list"
    />
  )
}
