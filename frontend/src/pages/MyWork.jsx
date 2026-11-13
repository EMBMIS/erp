/**
 * My work — what is waiting on me today, in the order it matters.
 *
 * Two sources, one queue:
 *   decisions   GET /decisions-held-open — every pending approval with its
 *               value, age, what it holds up and who it waits on. Ranked by
 *               consequence on the server; "yours to decide" first here.
 *   other work  GET /platform/shell/my-work — whatever each application says
 *               is waiting on this person (overdue orders, workflow steps,
 *               items addressed to a role they hold).
 *
 * Deciding happens in Approvals, where authority limits, approval chains and
 * segregation of duties are applied; every row links straight to its review.
 */
import { Link } from 'react-router-dom'
import { CheckBadgeIcon, SparklesIcon, ChevronRightIcon } from '@heroicons/react/20/solid'
import { platformAPI } from '../services/api'
import { useResource } from '../hooks/useResource'
import AppIcon from '../components/platform/AppIcon'
import { useDecisionsHeldOpen } from '../components/approvals/DecisionsHeldOpen'
import { PageHeader, Button, Badge, Money, Card, EmptyState, ErrorState, SkeletonRows, InlineNotice } from '../components/ui'

const ask = (q) => `/ai/chat?q=${encodeURIComponent(q)}`

function DecisionRow({ d }) {
  return (
    <li className="group flex items-start gap-3 px-4 py-3 hover:bg-ink-50">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm text-fg">{d.number}</span>
          <Badge tone="ink">{d.kind_label}</Badge>
          {d.escalated && <Badge tone="warn" glyph="triangle">Escalated</Badge>}
          {Number(d.held_value) > 0 && <Badge tone="warn" glyph="triangle">Holds customer orders</Badge>}
        </p>
        <p className="mt-0.5 truncate text-sm text-ink-700">{d.party}</p>
        <p className="mt-0.5 line-clamp-2 text-xs text-ink-500">{d.reason}</p>
      </div>
      <div className="shrink-0 text-right">
        <Money amount={d.value} currency={d.currency} className="text-sm font-medium" />
        <p className="mt-0.5 text-xs text-ink-500">waiting {d.waiting_for}</p>
        <div className="mt-1.5 flex justify-end gap-1">
          <Button size="xs" variant="ghost" icon={SparklesIcon} to={ask(`What should I know before deciding ${d.number}?`)} aria-label={`Ask Simeli about ${d.number}`} />
          <Button size="xs" variant={d.yours_to_decide ? 'primary' : 'secondary'} to={d.decide_at}>{d.yours_to_decide ? 'Review' : 'Open'}</Button>
        </div>
      </div>
    </li>
  )
}

export default function MyWork() {
  const held = useDecisionsHeldOpen()
  const { data: work, loading: workLoading, error: workError, refetch } = useResource(['platform', 'my-work'], () => platformAPI.myWork())
  const decisions = held.data?.decisions || []
  const yours = decisions.filter((d) => d.yours_to_decide)
  const others = decisions.filter((d) => !d.yours_to_decide)
  const items = work?.items || []
  const otherCount = items.reduce((s, i) => s + (i.count || 0), 0)
  const loading = held.loading || workLoading
  const clear = !loading && !yours.length && !items.length

  const summary = loading
    ? 'Gathering what is waiting on you…'
    : clear
      ? 'Nothing is waiting on you.'
      : [yours.length && `${yours.length} decision${yours.length === 1 ? '' : 's'} yours to make`, otherCount && `${otherCount} other item${otherCount === 1 ? '' : 's'} to deal with`].filter(Boolean).join(', ') + '.'

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader title="My work" description={summary} secondary={<Button to="/approvals/unified">Open approvals</Button>} />

      {clear && (
        <Card>
          <EmptyState
            icon={CheckBadgeIcon}
            title="You are clear"
            description={held.data?.summary?.made_this_week ? `Nothing needs you right now. ${held.data.summary.made_this_week} decisions were made across the company this week.` : 'Nothing across your applications needs a decision or action from you.'}
            compact
          />
        </Card>
      )}

      <Card title="Yours to decide" description="Ranked by what waiting costs: escalations and anything holding up a customer order first." padded={false}>
        {held.loading ? <SkeletonRows rows={3} columns={3} /> : held.error ? (
          <ErrorState what="Pending decisions" error={{ message: held.error }} onRetry={held.reload} compact />
        ) : yours.length ? (
          <ul className="divide-y divide-ink-100">{yours.map((d) => <DecisionRow key={`${d.kind}:${d.id}`} d={d} />)}</ul>
        ) : (
          <p className="px-4 py-4 text-sm text-ink-600">No approvals are waiting for your decision.</p>
        )}
      </Card>

      <Card title="Other work" description="What each application says is waiting on you." padded={false}>
        {workLoading ? <SkeletonRows rows={2} columns={2} /> : workError ? (
          <ErrorState what="Work from your applications" error={workError} onRetry={refetch} compact />
        ) : items.length ? (
          <ul className="divide-y divide-ink-100">
            {items.map((item) => (
              <li key={item.key}>
                <Link to={item.route} className="flex items-center gap-3 px-4 py-3 hover:bg-ink-50">
                  <span className="w-10 shrink-0 text-right text-lg font-semibold tabular-nums text-fg">{item.count}</span>
                  <AppIcon name={item.icon} className="h-4 w-4 shrink-0 text-ink-400" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-fg">{item.title}</span>
                    <span className="block truncate text-xs text-ink-500">{item.appName}{item.detail ? ` · ${item.detail}` : ''}</span>
                  </span>
                  {item.kind === 'generated' && <Badge tone="ink">Built here</Badge>}
                  <ChevronRightIcon className="h-4 w-4 text-ink-400" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-4 text-sm text-ink-600">Nothing else is addressed to you.</p>
        )}
      </Card>

      {others.length > 0 && (
        <details className="group rounded-lg border border-ink-200 bg-surface">
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium text-fg [&::-webkit-details-marker]:hidden">
            Waiting on someone else <span className="font-mono text-xs text-ink-500">{others.length}</span>
          </summary>
          <InlineNotice tone="ink" className="mx-4 mb-3">These are pending in the company but not yours to decide — for example, orders you raised yourself.</InlineNotice>
          <ul className="divide-y divide-ink-100 border-t border-ink-200">{others.map((d) => <DecisionRow key={`${d.kind}:${d.id}`} d={d} />)}</ul>
        </details>
      )}
    </div>
  )
}
