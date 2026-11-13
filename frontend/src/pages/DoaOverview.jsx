import { Link } from 'react-router-dom'
import { ChevronRightIcon } from '@heroicons/react/20/solid'
import api from '../services/api'
import { useResource } from '../hooks/useResource'
import { keys } from '../services/queryKeys'
import { PageHeader, Button, Card, Stat, InlineNotice, formatNumber } from '../components/ui'

/**
 * Delegation of Authority — what the approval rules look like today and
 * where to act on them. Every figure links to the rules behind it; a figure
 * the server did not return is shown as "—", never as zero.
 */
const count = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : formatNumber(Number(v)))
const list = (d) => (Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [])

const PLACES = [
  { name: 'Rules', description: 'Define who approves what, up to which amount, for which cost centre.', to: '/delegation-of-authority' },
  { name: 'Approval inbox', description: 'Approve or reject requests waiting on you.', to: '/approvals/unified' },
  { name: 'Approval simulator', description: 'Test which rule would route a request before it matters.', to: '/approvals/simulate' },
  { name: 'Audit trail', description: 'Every rule change and approval decision, with who and when.', to: '/admin/audit-trail' },
]

export default function DoaOverview() {
  const { data: stats, loading: statsLoading, error: statsError } = useResource(
    keys.delegationOfAuthorityStats(),
    ({ signal }) => api.get('/delegation-of-authority/stats', { signal }),
    { retry: false }
  )
  const { data: costCenterData, loading: ccLoading } = useResource(
    keys.delegationOfAuthority('cost-centers'),
    ({ signal }) => api.get('/delegation-of-authority/cost-centers', { signal }),
    { retry: false }
  )
  const s = stats || {}
  const costCenters = costCenterData == null ? null : list(costCenterData).length
  const expiring = Number(s.expiring_soon) || 0
  const expired = Number(s.expired) || 0

  return (
    <div className="space-y-6">
      <PageHeader
        title="Delegation of authority"
        description="Approval rules, the engine that applies them, and the record of every decision."
        primary={<Button variant="primary" to="/delegation-of-authority">Manage rules</Button>}
        secondary={<Button to="/approvals/simulate">Simulate an approval</Button>}
      />

      {statsError && (
        <InlineNotice tone="warn" title="Rule figures are unavailable">
          The statistics could not be loaded{statsError?.response?.status === 403 ? ' — they are visible to managers and administrators only' : ''}. The links below still work.
        </InlineNotice>
      )}
      {!statsError && (expiring > 0 || expired > 0) && (
        <InlineNotice tone={expired > 0 ? 'risk' : 'warn'} title="Rules need attention" action={<Button size="sm" to="/delegation-of-authority">Review rules</Button>}>
          {[expired > 0 && `${expired} active rule${expired === 1 ? ' has' : 's have'} passed the end date`, expiring > 0 && `${expiring} expire${expiring === 1 ? 's' : ''} in the next 30 days`].filter(Boolean).join('; ')}. Requests they cover will fall through to the next rule.
        </InlineNotice>
      )}

      <section aria-label="Rule figures" className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Rules" value={count(s.total)} loading={statsLoading} reason={s.inactive != null ? `${count(s.inactive)} inactive` : null} to="/delegation-of-authority" />
        <Stat label="Active" value={count(s.active)} loading={statsLoading} to="/delegation-of-authority" />
        <Stat label="Expiring in 30 days" value={count(s.expiring_soon)} loading={statsLoading} to="/delegation-of-authority" />
        <Stat label="Expired, still active" value={count(s.expired)} loading={statsLoading} to="/delegation-of-authority" />
        <Stat label="Approvers" value={count(s.unique_users)} loading={statsLoading} reason={costCenters != null ? `${count(costCenters)} cost centre${costCenters === 1 ? '' : 's'} configured` : null} footnote={ccLoading ? 'Counting cost centres…' : null} />
      </section>

      <Card title="Where to go" padded={false}>
        <ul className="divide-y divide-ink-100">
          {PLACES.map((p) => (
            <li key={p.name}>
              <Link to={p.to} className="flex min-h-[48px] items-center gap-3 px-4 py-3 hover:bg-ink-50">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-fg">{p.name}</span>
                  <span className="block text-xs text-ink-600">{p.description}</span>
                </span>
                <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
