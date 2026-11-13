import api from '../../../services/api'
import { formatDate, formatMoney } from '../../../components/ui'
import ApprovalQueue from './ApprovalQueue'

const CONFIG = {
  key: 'purchase-orders',
  title: 'Purchase order approvals',
  description: 'Orders waiting for someone whose limit covers their total. Approving commits the spend.',
  noun: 'purchase order',
  fetch: async ({ signal }) => {
    const body = (await api.get('/purchase-orders/pending-approval', { signal })).data || {}
    if (body.success === false) throw new Error(body.error || 'The queue could not be read.')
    return { rows: Array.isArray(body.data) ? body.data : [] }
  },
  normalize: (p) => ({ id: p.id, title: p.po_number, subtitle: [p.supplier_name, p.pr_number || p.rfq_number || p.contract_number].filter(Boolean).join(' · '), amount: p.total_amount, currency: p.currency, status: p.status || 'PENDING_APPROVAL', createdBy: p.created_by_name || '', createdById: p.created_by, createdAt: p.created_at }),
  detail: (p) => [
    ['Purchase order', p.po_number],
    ['Supplier', p.supplier_name],
    ['Total', p.total_amount != null ? formatMoney(p.total_amount, p.currency || 'USD') : null],
    ['Delivery date', formatDate(p.delivery_date)],
    ['Payment terms', p.payment_terms],
    ['Incoterms', p.incoterms],
    ['Source', p.pr_number || p.rfq_number || p.contract_number],
    ['Raised by', p.created_by_name],
    ['Raised', formatDate(p.created_at)],
  ],
  why: 'Approving commits the spend with the supplier. The order can then be sent to them.',
  approve: (r) => api.post(`/purchase-orders/${r.id}/approve`),
  decline: (r, reason) => api.post(`/purchase-orders/${r.id}/reject`, { reason }),
  rejectConsequence: 'The order returns to whoever raised it as rejected and cannot be resubmitted; a new order is needed.',
  open: (r) => `/procurement/purchase-orders/${r.id}`,
  remove: (r) => api.delete(`/purchase-orders/${r.id}`),
  invalidates: [['purchase-orders']],
}

export default function PurchaseOrderApprovals() {
  return <ApprovalQueue config={CONFIG} />
}
