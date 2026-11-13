import api from '../../../services/api'
import { formatDate, formatMoney } from '../../../components/ui'
import ApprovalQueue from './ApprovalQueue'

// DoA queues answer { data, message } when the user holds no authority.
const doaFetch = (url, what) => async ({ signal }) => {
  const body = (await api.get(url, { signal })).data || {}
  if (body.success === false) throw new Error(body.error || 'The queue could not be read.')
  const rows = Array.isArray(body.data) ? body.data : []
  return { rows, notice: !rows.length && body.message ? `You hold no delegated authority for ${what}, so nothing reaches this queue. An administrator can grant it under Delegation of Authority.` : null }
}

const value = (p) => (p.estimated_unit_price != null && p.estimated_unit_price !== '' ? Number(p.quantity) * Number(p.estimated_unit_price) : (p.total_amount ?? null))

const CONFIG = {
  key: 'purchase-requisitions',
  title: 'Requisition approvals',
  description: 'Internal requests to buy, waiting for someone whose authority covers their cost centre and value.',
  noun: 'requisition',
  fetch: doaFetch('/delegation-of-authority/pending-purchase-requisitions', 'purchase requisitions'),
  normalize: (p) => ({ id: p.id, title: p.pr_number, subtitle: [p.item_description || p.item_name, p.cost_center].filter(Boolean).join(' · '), amount: value(p), currency: p.currency, status: p.status || 'PENDING_APPROVAL', createdBy: p.requested_by_name || '', createdById: p.requested_by, createdAt: p.created_at }),
  detail: (p) => [
    ['Requisition', p.pr_number],
    ['Cost centre', p.cost_center],
    ['Item', p.item_name ? `${p.item_name} (${p.approved_item_code || '—'})` : p.item_description],
    ['Description', p.item_description],
    ['Quantity', p.quantity != null ? `${p.quantity} ${p.unit_of_measure || ''}`.trim() : null],
    ['Estimated value', value(p) != null ? formatMoney(value(p), p.currency || 'USD') : null],
    ['Requested by', p.requested_by_name],
    ['Recommended supplier', p.recommended_supplier_name],
    ['Why this supplier', p.supplier_recommendation_text],
    ['Requested', formatDate(p.created_at)],
  ],
  why: 'An approved requisition can be converted into an RFQ or a purchase order.',
  approve: (r) => api.post(`/delegation-of-authority/approve-purchase-requisition/${r.id}`),
  decline: (r, reason) => api.post(`/delegation-of-authority/decline-purchase-requisition/${r.id}`, { reason }),
  rejectLabel: 'Decline',
  rejectedVerb: 'declined',
  rejectConsequence: 'The requisition is declined and returns to the requester with your reason.',
  open: (r) => `/procurement/purchase-requisitions/${r.id}`,
  invalidates: [['purchase-requisitions']],
}

export default function PurchaseRequisitionApprovals() {
  return <ApprovalQueue config={CONFIG} />
}
