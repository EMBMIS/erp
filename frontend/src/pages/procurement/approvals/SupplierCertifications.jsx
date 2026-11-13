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
  key: 'certifications',
  title: 'Supplier certifications',
  description: 'Active suppliers waiting to be certified. Only certified suppliers can be put under contract.',
  noun: 'supplier',
  fetch: doaFetch('/delegation-of-authority/pending-certifications', 'supplier certification'),
  normalize: (s) => ({ id: s.id, title: s.legal_name || s.name, subtitle: [s.supplier_code, s.trade_name && s.trade_name !== s.legal_name ? `trading as ${s.trade_name}` : null].filter(Boolean).join(' · '), amount: null, status: 'PENDING_CERTIFICATION', createdBy: s.created_by_name || '', createdAt: s.approved_at || s.created_at }),
  detail: (s) => [
    ['Legal name', s.legal_name],
    ['Supplier code', s.supplier_code],
    ['Type', s.supplier_type],
    ['Email', s.email],
    ['Phone', s.phone],
    ['Address', [s.address, s.city, s.postal_code, s.country].filter(Boolean).join(', ')],
    ['Approved', formatDate(s.approved_at)],
  ],
  why: 'Certifying lets contracts be made with this supplier.',
  approve: (r) => api.post(`/delegation-of-authority/certify-supplier/${r.id}`),
  decline: (r, reason) => api.post(`/delegation-of-authority/revoke-certification/${r.id}`, { reason }),
  approveLabel: 'Certify',
  approvedVerb: 'certified',
  rejectLabel: 'Do not certify',
  rejectedVerb: 'left uncertified',
  rejectConsequence: 'The supplier stays active for purchase orders but cannot be put under contract. The reason is recorded on the supplier.',
  open: (r) => `/procurement/suppliers/${r.id}`,
  invalidates: [['suppliers']],
}

export default function SupplierCertifications() {
  return <ApprovalQueue config={CONFIG} />
}
