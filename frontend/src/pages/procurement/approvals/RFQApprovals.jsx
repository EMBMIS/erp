import api from '../../../services/api'
import { formatDate, formatMoney } from '../../../components/ui'
import ApprovalQueue from './ApprovalQueue'

const CONFIG = {
  key: 'rfqs',
  inboxTab: 'all',
  title: 'RFQ approvals',
  description: 'Requests for quotation waiting for approval. Approving sends them to the invited suppliers.',
  noun: 'RFQ',
  fetch: async ({ signal }) => {
    const body = (await api.get('/delegation-of-authority/pending-approvals', { params: { type: 'RFQ' }, signal })).data || {}
    if (body.success === false) throw new Error(body.error || 'The queue could not be read.')
    return { rows: Array.isArray(body.data) ? body.data : [] }
  },
  normalize: (q) => ({ id: q.id, title: q.rfq_number, subtitle: [q.title, q.pr_number ? `from ${q.pr_number}` : null].filter(Boolean).join(' · '), amount: null, status: q.status || 'PENDING_APPROVAL', createdBy: q.created_by_name || '', createdById: q.created_by, createdAt: q.submitted_at || q.created_at }),
  detail: (q) => [
    ['RFQ', q.rfq_number],
    ['Title', q.title],
    ['Requisition', q.pr_number],
    ['Suppliers invited', q.supplier_count != null ? String(q.supplier_count) : null],
    ['Lines', q.line_item_count != null ? String(q.line_item_count) : null],
    ['Currency', q.currency],
    ['Responses due', formatDate(q.response_deadline)],
    ['Created by', q.created_by_name],
    ['Description', q.description],
  ],
  why: 'Approving sends the RFQ to every invited supplier by email.',
  approve: (r) => api.post('/delegation-of-authority/approve', { entityId: r.id, entityType: 'RFQ' }),
  decline: (r, reason) => api.post('/delegation-of-authority/reject', { entityId: r.id, entityType: 'RFQ', reason }),
  rejectConsequence: 'The RFQ goes back to draft for its author to change, with your reason. Nothing is sent to suppliers.',
  open: (r) => `/procurement/rfqs/${r.id}`,
  remove: (r) => api.delete(`/request-for-quotations/${r.id}`),
  invalidates: [['rfqs']],
}

export default function RFQApprovals() {
  return <ApprovalQueue config={CONFIG} />
}
