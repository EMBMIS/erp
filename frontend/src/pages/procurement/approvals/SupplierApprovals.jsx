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

const CONFIG = {
  key: 'suppliers',
  title: 'Supplier approvals',
  description: 'New suppliers waiting for a decision from someone with supplier authority.',
  noun: 'supplier',
  fetch: doaFetch('/delegation-of-authority/pending-suppliers', 'supplier approvals'),
  normalize: (s) => ({ id: s.id, title: s.legal_name || s.name, subtitle: [s.supplier_code, s.trade_name && s.trade_name !== s.legal_name ? `trading as ${s.trade_name}` : null].filter(Boolean).join(' · '), amount: null, status: s.status || 'PENDING_APPROVAL', createdBy: s.created_by_name || '', createdById: s.created_by, createdAt: s.created_at }),
  detail: (s) => [
    ['Legal name', s.legal_name],
    ['Supplier code', s.supplier_code],
    ['Trade name', s.trade_name],
    ['Type', s.supplier_type],
    ['Email', s.email],
    ['Phone', s.phone],
    ['Address', [s.address, s.city, s.postal_code, s.country].filter(Boolean).join(', ')],
    ['Payment terms', s.payment_terms],
    ['Submitted', formatDate(s.created_at)],
  ],
  why: 'The supplier is emailed to confirm the partnership. Once they confirm, they can be used on requisitions, RFQs and purchase orders.',
  approve: (r) => api.post(`/delegation-of-authority/approve-supplier/${r.id}`),
  decline: (r, reason) => api.post(`/delegation-of-authority/decline-supplier/${r.id}`, { reason }),
  rejectLabel: 'Decline',
  rejectedVerb: 'declined',
  rejectConsequence: 'The supplier is marked declined and cannot be used. Whoever registered it sees your reason.',
  open: (r) => `/procurement/suppliers/${r.id}`,
  invalidates: [['suppliers']],
}

export default function SupplierApprovals() {
  return <ApprovalQueue config={CONFIG} />
}
