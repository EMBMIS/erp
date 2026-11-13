import { Link } from 'react-router-dom'
import { ChevronRightIcon } from '@heroicons/react/20/solid'
import api, { crmAPI } from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { useCompany } from '../../contexts/CompanyContext'
import {
  PageHeader, Button, Card, Stat, StatusBadge, Money, Num, DateText, ErrorState, SkeletonRows,
  LineChart, Distribution, formatMoney, formatNumber, relativeTime,
} from '../../components/ui'

/**
 * CRM — the module's overview.
 *
 * LEADS AND DEALS ARE TWO POPULATIONS, NOT ONE
 * ---------------------------------------------------------------------------
 * A lead is somebody who might buy. A deal is a live opportunity with a value
 * and a stage. Separate tables, separate lifecycles, and only some leads ever
 * become deals — so the two are counted separately here rather than stacked
 * into one funnel where the top band is leads and the rest are deals. That
 * shape implies every deal descends from a lead in the band above, and the
 * ratio between them can then exceed 100% for reasons nobody can explain.
 *
 * WEIGHTED VALUE SITS BESIDE RAW VALUE, NEVER INSTEAD OF IT
 * ---------------------------------------------------------------------------
 * Weighting by probability gives a forecast; not weighting gives the pipeline.
 * Showing only one number invites it to mean the other.
 */

/** The deal pipeline, in order. WON and LOST are outcomes, not stages. */
const STAGES = [['NEW', 'New'], ['QUALIFIED', 'Qualified'], ['PROPOSAL', 'Proposal'], ['NEGOTIATION', 'Negotiation']]
const LEAD_STATES = [['NEW', 'New'], ['CONTACTED', 'Contacted'], ['QUALIFIED', 'Qualified'], ['PROPOSAL_SENT', 'Proposal sent'], ['WON', 'Won'], ['LOST', 'Lost']]

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const pct = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : `${(Number(v) * 100).toFixed(1)}%`)
const humanize = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
const rows = (d) => (Array.isArray(d) ? d : d?.data || d?.rows || [])
const monthShort = (key) => {
  const [y, m] = String(key || '').split('-').map(Number)
  return Number.isInteger(y) && Number.isInteger(m) ? new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: '2-digit' }) : String(key || '—')
}

/**
 * A score as a band, not a bare number. 92 and 88 are not meaningfully
 * different; the band is what a salesperson acts on.
 */
const scoreBand = (s) => (s == null ? 'Unscored' : `${s >= 80 ? 'High' : s >= 55 ? 'Medium' : 'Low'} · ${s}`)

function ListCard({ title, description, action, loading, error, onRetry, empty, children }) {
  return (
    <Card title={title} description={description} actions={action} padded={false}>
      {loading ? <SkeletonRows rows={3} columns={2} /> : error ? <ErrorState compact what={title} error={error} onRetry={onRetry} className="px-4" />
        : children ? <ul className="divide-y divide-ink-100">{children}</ul> : <p className="px-4 py-4 text-sm text-ink-600">{empty}</p>}
    </Card>
  )
}

function Row({ to, children, aside }) {
  const body = (
    <>
      <span className="min-w-0 flex-1">{children}</span>
      {aside}
      {to && <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />}
    </>
  )
  return <li>{to ? <Link to={to} className="flex items-center gap-3 px-4 py-2.5 hover:bg-ink-50">{body}</Link> : <div className="flex items-center gap-3 px-4 py-2.5">{body}</div>}</li>
}

const Empty = ({ children }) => <p className="text-sm text-ink-600">{children}</p>

export default function CrmOverview() {
  const { currency = 'USD' } = useCompany() || {}
  const { data: a, loading, error, refetch } = useResource(['crm', 'analytics', 12], () => crmAPI.analytics(12), { retry: false })
  const { data: findingsData, loading: findingsLoading, error: findingsError, refetch: refetchFindings } = useResource(
    ['crm', 'findings'],
    ({ signal }) => api.get('/ai-findings?status=OPEN&entity_type=LEAD,DEAL,CONTACT', { signal }),
  )
  const findings = rows(findingsData)

  const header = (
    <PageHeader
      title="CRM"
      description="Leads who might buy, deals in play, and the follow-ups owed on both."
      primary={<Button variant="primary" to="/crm/pipeline">Open pipeline</Button>}
    />
  )

  const findingsCard = (
    <ListCard
      title="Simeli findings"
      description="Open findings on leads, deals and contacts"
      loading={findingsLoading}
      error={findingsError}
      onRetry={refetchFindings}
      empty="Simeli has not flagged anything in the pipeline."
      action={<Button size="xs" variant="ghost" to="/ai/findings">All</Button>}
    >
      {findings.length > 0 && findings.slice(0, 5).map((f) => (
        <Row key={f.id} to="/ai/findings" aside={f.severity ? <StatusBadge status={f.severity === 'HIGH' ? 'OVERDUE' : f.severity === 'MEDIUM' ? 'ATTENTION' : 'DRAFT'} label={humanize(f.severity)} /> : null}>
          <span className="block truncate text-sm text-ink-900">{f.title}</span>
          {f.description && <span className="block truncate text-xs text-ink-500">{f.description}</span>}
        </Row>
      ))}
    </ListCard>
  )

  if (error) {
    return (
      <div className="space-y-5">
        {header}
        <ErrorState what="CRM figures" error={error} onRetry={refetch} />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">{findingsCard}</div>
      </div>
    )
  }

  const leads = a?.leads || {}
  const deals = a?.deals || {}
  const byStage = deals.by_stage || {}
  const series = a?.series || []
  const stageItems = STAGES.map(([k, label]) => ({ label, value: n(byStage[k]?.value), to: '/crm/pipeline' })).filter((s) => s.value > 0)
  const leadItems = LEAD_STATES.map(([k, label]) => ({ label, value: n(leads.by_status?.[k]), tone: k === 'WON' ? 'ok' : 'ink', to: '/crm/leads' })).filter((s) => s.value > 0)
  const sourceItems = (a?.sources || []).map((r) => ({ label: humanize(r.source) || 'No source', value: n(r.n), to: '/crm/leads' })).filter((s) => s.value > 0)
  const topLeads = a?.top_leads || []
  const recentLeads = a?.recent_leads || []
  const closing = a?.closing_soon || []
  const activities = a?.activities || []
  const upcoming = a?.upcoming || []
  const today = new Date(new Date().toDateString())

  return (
    <div className="space-y-5">
      {header}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Stat label="Leads" loading={loading} value={<Num value={leads.total} />} reason={leads.conversion_rate == null ? 'No leads raised yet.' : `${formatNumber(leads.converted)} converted · ${pct(leads.conversion_rate)}.`} to="/crm/leads" />
        <Stat label="Open deals" loading={loading} value={<Num value={deals.open} />} reason={deals.total != null ? `${formatNumber(deals.total)} raised in all.` : undefined} to="/crm/pipeline" />
        <Stat label="Pipeline value" loading={loading} value={deals.open_value != null ? <Money currency={currency} amount={deals.open_value} digits={0} /> : '—'} reason={deals.weighted_value != null ? `${formatMoney(deals.weighted_value, currency, 0)} probability-weighted.` : undefined} to="/crm/pipeline" />
        <Stat label="Won" loading={loading} value={<Num value={deals.won} />} reason={deals.won_value != null ? `${formatMoney(deals.won_value, currency, 0)} closed won.` : undefined} to="/crm/pipeline" />
        <Stat label="Win rate" loading={loading} value={pct(deals.win_rate)} reason={deals.win_rate == null ? 'Nothing has closed yet.' : `Of ${formatNumber(n(deals.won) + n(deals.lost))} closed deals. Average won deal ${deals.avg_size == null ? '—' : formatMoney(deals.avg_size, currency, 0)}.`} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Open pipeline value" description="Value of deals open at each month end, last 12 months" className="lg:col-span-2">
          {loading ? <SkeletonRows rows={4} columns={1} /> : series.length > 1 && series.some((r) => n(r.open_value)) ? (
            <LineChart title="Open value by month" points={series.map((r) => ({ x: monthShort(r.month), y: n(r.open_value) }))} format={(v) => formatMoney(v, currency, 0)} />
          ) : <Empty>No deal has been open long enough to draw a history.</Empty>}
        </Card>
        <Card title="Pipeline by stage" description="Raw value, unweighted. Deals only.">
          {loading ? <SkeletonRows rows={4} columns={2} /> : <Distribution items={stageItems} format={(v) => formatMoney(v, currency, 0)} emptyText="No open deal carries a value." />}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Card title="Leads by status" description={n(leads.idle) ? `${formatNumber(leads.idle)} idle a week with no follow-up — across these statuses.` : undefined}>
          {loading ? <SkeletonRows rows={4} columns={2} /> : <Distribution items={leadItems} emptyText="No leads raised yet." />}
        </Card>
        <Card title="Leads by source">
          {loading ? <SkeletonRows rows={4} columns={2} /> : <Distribution items={sourceItems} emptyText="No lead records a source." />}
        </Card>
        <ListCard title="Top scored leads" loading={loading} empty="No lead has been scored yet." action={<Button size="xs" variant="ghost" to="/crm/leads">All</Button>}>
          {topLeads.length > 0 && topLeads.map((l) => (
            <Row key={l.id} to="/crm/leads" aside={<span className="shrink-0 text-right text-xs"><Money currency={currency} amount={l.potential_value} digits={0} className="block font-medium" /><span className="text-ink-500">{scoreBand(l.ai_score)}</span></span>}>
              <span className="block truncate text-sm text-ink-900">{l.company_name || l.contact_name}</span>
              <span className="block truncate text-xs text-ink-500">{[l.contact_name, l.source && humanize(l.source)].filter(Boolean).join(' · ')}</span>
            </Row>
          ))}
        </ListCard>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <ListCard title="Deals closing soon" loading={loading} empty="No open deal carries an expected close date." action={<Button size="xs" variant="ghost" to="/crm/pipeline">All</Button>}>
          {closing.length > 0 && closing.map((d) => (
            <Row key={d.id} to="/crm/pipeline" aside={<span className="shrink-0 text-right text-xs"><Money currency={currency} amount={d.value} digits={0} className="block font-medium" /><span className="text-ink-500"><DateText value={d.expected_close_date} /> · {formatNumber(d.probability)}%</span></span>}>
              <span className="block truncate text-sm text-ink-900">{d.customer || d.title}</span>
              <span className="block truncate text-xs text-ink-500">{d.title} · {humanize(d.stage)}</span>
            </Row>
          ))}
        </ListCard>
        <ListCard title="Recent leads" loading={loading} empty="No leads raised yet." action={<Button size="xs" variant="ghost" to="/crm/leads">All</Button>}>
          {recentLeads.length > 0 && recentLeads.map((l) => (
            <Row key={l.id} to="/crm/leads" aside={<StatusBadge status={l.status} />}>
              <span className="block truncate text-sm text-ink-900">{l.contact_name}</span>
              <span className="block truncate text-xs text-ink-500">{[l.company_name || 'No company', l.source && humanize(l.source), relativeTime(l.created_at)].filter(Boolean).join(' · ')}</span>
            </Row>
          ))}
        </ListCard>
        <ListCard title="Due next" description="Scheduled and unfinished" loading={loading} empty="Nothing scheduled and unfinished." action={<Button size="xs" variant="ghost" to="/crm/activities">All</Button>}>
          {upcoming.length > 0 && upcoming.map((r) => (
            <Row key={r.id} to="/crm/activities" aside={<span className={new Date(r.due_date) < today ? 'shrink-0 text-xs text-risk-600' : 'shrink-0 text-xs text-ink-500'}><DateText value={r.due_date} /></span>}>
              <span className="block truncate text-sm text-ink-900">{r.subject}</span>
              <span className="block truncate text-xs text-ink-500">{humanize(r.activity_type)} · {r.context || 'Unlinked'}</span>
            </Row>
          ))}
        </ListCard>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ListCard title="Recent activity" description="Logged against deals and contacts" loading={loading} empty="Nothing logged against a deal or contact yet." action={<Button size="xs" variant="ghost" to="/crm/activities">All</Button>}>
          {activities.length > 0 && activities.map((r) => (
            <Row key={r.id} aside={<span className="shrink-0 text-xs text-ink-500">{relativeTime(r.completed_at || r.created_at)}</span>}>
              <span className="block truncate text-sm text-ink-900">{r.subject}</span>
              <span className="block truncate text-xs text-ink-500">{[humanize(r.activity_type), r.context || 'Unlinked', r.owner].filter(Boolean).join(' · ')}</span>
            </Row>
          ))}
        </ListCard>
        {findingsCard}
      </div>
    </div>
  )
}
