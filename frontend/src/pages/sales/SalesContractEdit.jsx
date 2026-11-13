import { useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useRecordTitle } from '../../components/shell/ShellContext'
import { Button, SkeletonDetail, ErrorState, StatusBadge, Code, notify } from '../../components/ui'
import { ContractForm } from './SalesContractCreate'

const day = (v) => {
  if (!v) return ''
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().split('T')[0]
}
const str = (v) => (v === null || v === undefined ? '' : String(v))

/** Edit a sales contract: the same form as "New contract", seeded from the record. */
export default function SalesContractEdit() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data: c, loading, error, refetch } = useResource(keys.salesContract(id), ({ signal }) => api.get(`/sales-contracts/${id}`, { signal }), { enabled: !!id })
  useRecordTitle(c?.contract_number, { subtitle: c?.contract_name })

  const update = useResourceMutation(async (payload) => {
    const res = await api.put(`/sales-contracts/${id}`, payload)
    if (res.data && res.data.success === false) throw Object.assign(new Error(res.data.error || 'The contract was not updated.'), { response: { data: res.data } })
    return res
  }, { invalidates: [keys.salesContract(id), ['sales-contracts'], ['sales-contracts-stats']], silent: true })

  const initial = useMemo(() => (c ? {
    form: {
      contract_name: c.contract_name || '', customer_id: c.customer_id || '', customer_name: c.customer_name || '',
      supplier_id: c.supplier_id || '', supplier_name: c.supplier_name || '', contract_type: c.contract_type || 'SALES',
      contract_value: str(c.contract_value), currency: c.currency || 'USD', payment_terms: c.payment_terms || '', incoterms: c.incoterms || '',
      start_date: day(c.start_date), end_date: day(c.end_date), auto_renewal: Boolean(c.auto_renewal),
      renewal_period_months: c.renewal_period_months || 12, default_lead_time_days: c.default_lead_time_days || 30,
      delivery_terms: c.delivery_terms || '', delivery_location: c.delivery_location || '', signed_contract_url: c.signed_contract_url || '',
      contract_attachment_urls: Array.isArray(c.contract_attachment_urls) ? c.contract_attachment_urls.join(', ') : c.contract_attachment_urls || '',
      terms_and_conditions: c.terms_and_conditions || '', special_conditions: c.special_conditions || '',
      days_before_expiry_notification: c.days_before_expiry_notification || 30,
      linked_rfq_id: c.linked_rfq_id || '', linked_quotation_id: c.linked_quotation_id || '',
      notes: c.notes || '', internal_notes: c.internal_notes || '',
    },
    lines: (c.items?.length ? c.items : [{}]).map((it, i) => ({
      _key: it.id || `l${i}`,
      inventory_item_id: it.inventory_item_id || '',
      item_code: it.item_code || '',
      item_name: it.item_name || '',
      item_description: it.item_description || '',
      unit_price: str(it.unit_price),
      minimum_quantity: str(it.minimum_quantity),
      maximum_quantity: str(it.maximum_quantity),
      unit_of_measure: it.unit_of_measure || '',
      lead_time_days: str(it.lead_time_days),
      item_notes: it.item_notes || '',
    })),
  } : null), [c])

  if (loading) return <SkeletonDetail />
  if (error || !c) {
    return <ErrorState what="Sales contract" error={error || { response: { status: 404, data: { error: 'No contract with this id is visible to you.' } } }} onRetry={refetch} />
  }

  const onSave = async (payload) => {
    await update.mutateAsync(payload)
    notify.success(`${c.contract_number || 'Contract'} updated`)
    navigate(`/sales/contracts/${id}`)
  }

  return (
    <ContractForm
      key={c.id}
      title={<>Edit <Code className="text-[1em]">{c.contract_number || 'contract'}</Code></>}
      description="Update the contract's details, period, agreed prices and terms."
      meta={c.status ? <span>Status <StatusBadge status={c.status} /></span> : null}
      initialValue={initial}
      cancelTo={`/sales/contracts/${id}`}
      onSave={onSave}
      exclusiveParty
      actions={({ saving }) => <Button type="submit" variant="primary" loading={Boolean(saving)} disabled={Boolean(saving)}>Save changes</Button>}
    />
  )
}
