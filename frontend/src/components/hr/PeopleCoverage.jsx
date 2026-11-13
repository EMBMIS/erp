import { Link } from 'react-router-dom'
import { SparklesIcon } from '@heroicons/react/20/solid'

import api from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { useShell } from '../shell/ShellContext'
import { Card, Badge, Button, ErrorState, SkeletonRows, Money } from '../ui'

/**
 * Who the business is waiting on.
 *
 * The same answer Simeli gives to "who are we waiting on?" (GET
 * /api/people-coverage, services/peopleCoverage.js): who decides what, who is
 * away when, which pending decisions lose their last approver before the
 * customer order they hold falls due, and what approving a requested leave
 * would do. Proposals are carried out only when a manager or admin confirms.
 */

export const PEOPLE_COVERAGE_KEY = ['people-coverage']

const STATE = {
  gap: { tone: 'risk', glyph: 'triangle', label: 'No approver in' },
  nobody: { tone: 'risk', glyph: 'triangle', label: 'No one may approve' },
  decide_by: { tone: 'warn', glyph: 'triangle', label: 'Decide by' },
  single: { tone: 'ink', glyph: null, label: 'One approver' },
}

const short = (s) => (s ? new Date(`${s}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : '')

export function usePeopleCoverage() {
  return useResource(PEOPLE_COVERAGE_KEY, ({ signal }) => api.get('/people-coverage', { signal }), { retry: false })
}

export default function PeopleCoverage({ className = '' }) {
  const { user } = useAuth()
  const canAct = ['ADMIN', 'MANAGER'].includes(user?.role)
  const { openSimeli } = useShell()
  const ask = (question) => openSimeli({ question })
  const { data, loading, error, refetch } = usePeopleCoverage()
  const act = useResourceMutation(
    (proposal) => api.post('/people-coverage/act', { proposal_id: proposal.id }),
    { invalidates: [PEOPLE_COVERAGE_KEY], successMessage: 'Done' }
  )
  const confirm = (p) => {
    if (!window.confirm(`${p.label}?\n\n${p.kind === 'delegate' ? 'This records a delegation the approval engine applies over those dates.' : p.message}`)) return
    act.mutate(p)
  }

  const risky = (data?.at_risk || []).filter((r) => r.state !== 'single')
  const single = (data?.at_risk || []).filter((r) => r.state === 'single')

  return (
    <Card
      title="Who the business is waiting on"
      description={data ? `Approvers in, day by day · ${data.horizon.working_days} working days${data.scope.startsWith('you') ? ' · what you can see' : ''}` : 'Decisions, leave and cover, joined'}
      className={className}
      padded={false}
      actions={<Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => ask('Who are we waiting on, and who is away when it matters?')}>Ask Simeli</Button>}
    >
      {error ? (
        <ErrorState compact what="Who covers what" error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <SkeletonRows rows={4} columns={3} />
      ) : data ? (
        <>
          <p className="border-b border-ink-100 px-4 py-3 text-sm text-fg">{data.headline}</p>

          {data.days?.length && data.summary.deciders > 0 ? (
            <div className="flex gap-1 overflow-x-auto border-b border-ink-100 px-4 py-3" role="list" aria-label="Approvers in, by working day">
              {data.days.map((d) => {
                const tone = d.deciders_in === 0 ? 'bg-risk-50 text-risk-700' : d.deciders_in === 1 && d.deciders_total > 1 ? 'bg-warn-50 text-warn-700' : 'bg-ink-50 text-ink-700'
                const who = [d.away?.length ? `Away: ${d.away.join(', ')}` : null, d.requested_off?.length ? `Requested off: ${d.requested_off.join(', ')}` : null].filter(Boolean).join(' · ')
                return (
                  <span key={d.date} role="listitem" title={who || undefined} className={`flex min-w-[3.25rem] flex-none flex-col items-center rounded-md px-1.5 py-1 text-xs ${tone}`}>
                    <span>{d.label.split(' ').slice(0, 2).join(' ')}</span>
                    <span className="font-medium tabular-nums">{d.deciders_in}/{d.deciders_total}</span>
                  </span>
                )
              })}
            </div>
          ) : null}

          {risky.length || single.length ? (
            <div className="border-b border-ink-100 px-4 py-3">
              <p className="label-mono mb-1.5">Decisions and the people they wait on</p>
              <ul className="space-y-1.5">
                {[...risky, ...single].map((r) => {
                  const st = STATE[r.state] || STATE.single
                  return (
                    <li key={r.id} className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="min-w-0 text-ink-800">
                        <Link to={r.decide_at} className="bos-link">{r.number}</Link>
                        {r.party ? <span className="text-ink-600"> · {r.party}</span> : null}
                        <span className="ml-1.5"><Badge tone={st.tone} glyph={st.glyph}>{r.state === 'decide_by' ? `${st.label} ${short(r.decide_by)}` : st.label}</Badge></span>
                        <span className="block text-xs text-ink-600">{r.reason}</span>
                      </span>
                      {r.held_value ? <span className="flex-none tabular-nums text-ink-800"><Money amount={r.held_value} currency={data.summary.currency} digits={0} /></span> : null}
                    </li>
                  )
                })}
              </ul>
            </div>
          ) : null}

          {data.leave_impact?.length ? (
            <div className="border-b border-ink-100 px-4 py-3">
              <p className="label-mono mb-1.5">Leave waiting for approval · what approving it does</p>
              <ul className="space-y-1.5 text-sm">
                {data.leave_impact.map((l) => (
                  <li key={l.leave_request_id || l.user_id} className="rounded-md border border-warn-200 px-3 py-2 text-ink-800">
                    {l.reason}
                    <span className="mt-1 block text-xs text-ink-600">Decided on <Link to="/hr/leave-attendance" className="bos-link">Leave and attendance</Link>.</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {data.people?.length ? (
            <table className="w-full text-sm">
              <caption className="sr-only">People, what they decide and when they are away</caption>
              <thead>
                <tr className="border-b border-ink-200 text-left">
                  <th scope="col" className="label-mono px-4 py-2 font-normal">Person</th>
                  <th scope="col" className="label-mono px-2 py-2 text-right font-normal">Decides</th>
                  <th scope="col" className="label-mono px-4 py-2 text-right font-normal">Away</th>
                </tr>
              </thead>
              <tbody>
                {data.people.map((p) => (
                  <tr key={p.user_id} className="border-b border-ink-100 last:border-0">
                    <td className="px-4 py-2.5">
                      <span className="block text-ink-800">{p.name}</span>
                      <span className="block text-xs text-ink-600">
                        {[p.position, p.department, p.role?.toLowerCase().replace(/_/g, ' ')].filter(Boolean).join(' · ')}
                        {p.decides.only_them.length ? ` · only approver for ${p.decides.only_them.join(', ')}` : ''}
                        {p.delegated_to.length ? ` · ${p.delegated_to.map((x) => `${x.to} approves for them`).join(', ')}` : ''}
                        {p.owns_while_away.length ? ` · ${p.owns_while_away.length} order${p.owns_while_away.length === 1 ? '' : 's'} due while away` : ''}
                      </span>
                    </td>
                    <td className="px-2 py-2.5 text-right tabular-nums text-ink-800">
                      {p.decides.count || '—'}
                      {p.decides.holding_value ? <span className="block text-xs text-ink-600">holds <Money amount={p.decides.holding_value} currency={data.summary.currency} digits={0} /></span> : null}
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs text-ink-700">
                      {p.away.length ? p.away.map((a) => (
                        <span key={`${a.from}-${a.status}`} className="block whitespace-nowrap">
                          {short(a.from)}{a.to && a.to !== a.from ? ` – ${short(a.to)}` : a.to ? '' : ' →'}
                          {a.status === 'PENDING' ? ' · requested' : a.status === 'WHAT_IF' ? ' · what if' : ''}
                        </span>
                      )) : <span className="text-ink-500">In</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}

          {data.proposals?.length ? (
            <div className="border-t border-ink-100 px-4 py-3">
              <p className="label-mono mb-1.5">Simeli proposes · {canAct ? 'you confirm' : 'a manager confirms'}</p>
              <ul className="space-y-1.5">
                {data.proposals.map((p) => (
                  <li key={p.id} className="flex items-start justify-between gap-3 rounded-md border border-ink-200 px-3 py-2 text-sm">
                    <span className="min-w-0 text-ink-800">{p.label}</span>
                    <span className="flex flex-none gap-1.5">
                      {canAct ? <Button size="xs" variant="primary" loading={act.isPending && act.variables?.id === p.id} disabled={act.isPending} onClick={() => confirm(p)}>Confirm</Button> : null}
                      <Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => ask(`${p.label}. Use explain_people_coverage and act_on_people_coverage with proposal ${p.id} only if I confirm.`)}>Ask Simeli</Button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </Card>
  )
}
