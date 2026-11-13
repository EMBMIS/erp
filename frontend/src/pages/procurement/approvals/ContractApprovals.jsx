import api from '../../../services/api'
import { formatDate, formatMoney } from '../../../components/ui'
import ApprovalQueue from './ApprovalQueue'

const CONFIG = {
  key: 'contracts',
  title: 'Contract approvals',
  description: 'Supplier contracts waiting for someone whose authority covers their value.',
  noun: 'contract',
  fetch: async ({ signal }) => {
    const body = (await api.get('/contracts/pending-approvals', { signal })).data || {}
    if (body.success === false) throw new Error(body.error || 'The queue could not be read.')
    return { rows: Array.isArray(body.data) ? body.data : [] }
  },
  normalize: (c) => ({ id: c.id, title: c.contract_number || c.title, subtitle: [c.title !== c.contract_number ? c.title : null, c.supplier_name].filter(Boolean).join(' · '), amount: c.contract_value, currency: c.currency, status: c.status || 'PENDING_APPROVAL', createdBy: c.created_by_name || '', createdById: c.created_by, createdAt: c.submitted_at || c.created_at }),
  detail: (c) => [
    ['Title', c.title],
    ['Contract', c.contract_number],
    ['Supplier', c.supplier_name],
    ['Value', c.contract_value != null ? formatMoney(c.contract_value, c.currency || 'USD') : null],
    ['Type', c.contract_type],
    ['Starts', formatDate(c.start_date)],
    ['Ends', formatDate(c.end_date)],
    ['Description', c.description],
    ['Submitted', formatDate(c.created_at)],
  ],
  why: 'An approved contract is sent to the supplier to accept, then checked by procurement and activated.',
  approve: (r) => api.post(`/contracts/${r.id}/approve`),
  decline: (r, reason) => api.post(`/contracts/${r.id}/decline`, { reason }),
  rejectLabel: 'Decline',
  rejectedVerb: 'declined',
  rejectConsequence: 'The contract is declined and returns to whoever drafted it, with your reason.',
  open: (r) => `/procurement/contracts/${r.id}`,
  invalidates: [['contracts']],
}

export default function ContractApprovals() {
  return <ApprovalQueue config={CONFIG} />
}
