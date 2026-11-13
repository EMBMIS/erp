import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { ChevronRightIcon, SparklesIcon } from '@heroicons/react/20/solid'

import api from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { useShell } from '../shell/ShellContext'
import { Card, Badge, Button, ErrorState, SkeletonRows, Money } from '../ui'
import { DeliveryChain } from '../sales/DeliveryRisk'

/**
 * Line watch: one line slows down, and the system already knows what that
 * will cost.
 *
 * The same answer Simeli gives to "is anything slowing down on the floor?"
 * (GET /api/manufacturing/line-watch, services/lineWatch.js): each work centre
 * running slower than its own 90-day norm, or stopped with work queued, with
 * the extra hours at today's pace, their cost at the centre's rate, and the
 * customer orders it puts at risk. Proposals are proposals — moving an
 * operation is a manager's click here, everything else goes to Simeli to
 * draft for a person to approve.
 */

function Proposal({ line, p, canManage, onAsk }) {
  const move = useResourceMutation(
    () => api.post(`/manufacturing/operations/${p.operation_id}/move`, { work_center_id: p.to_work_center_id }),
    { invalidates: [['manufacturing', 'line-watch']], successMessage: `Moved: ${p.label}` }
  )
  return (
    <li className="flex items-start justify-between gap-3 rounded-md border border-ink-200 px-3 py-2 text-sm">
      <span className="min-w-0 text-ink-800">{p.label}</span>
      {p.kind === 'move_operation' && canManage ? (
        <Button size="xs" variant="primary" loading={move.isPending} disabled={move.isSuccess} onClick={() => move.mutate()}>
          {move.isSuccess ? 'Moved' : 'Approve move'}
        </Button>
      ) : (
        <Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => onAsk(`${p.label} — ${line.code} has slowed down. Help me act on this; draft anything for my approval.`)}>
          Ask Simeli
        </Button>
      )}
    </li>
  )
}

function LineRow({ line, open, onToggle, canManage, onAsk }) {
  const tone = line.severity === 'HIGH' ? 'risk' : 'warn'
  return (
    <li className="border-b border-ink-100 last:border-0">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-ink-50">
        <ChevronRightIcon className={clsx('mt-0.5 h-4 w-4 shrink-0 text-ink-400 transition-transform duration-fast', open && 'rotate-90')} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-fg">{line.code} · {line.name}</span>
            <Badge tone={tone} glyph="triangle">
              {line.signal === 'stopped' ? String(line.status || 'stopped').toLowerCase() : `Efficiency ${line.change_pct}%`}
            </Badge>
          </span>
          <span className="mt-0.5 block line-clamp-2 text-xs text-ink-600">{line.chain?.[0]?.text}</span>
        </span>
        <span className="shrink-0 text-right text-xs text-ink-600">
          {line.extra_cost + line.lost_cost > 0 ? <span className="block"><Money amount={line.extra_cost + line.lost_cost} currency={line.currency} digits={0} /> line time</span> : null}
          {line.value_at_risk ? <span className="block"><Money amount={line.value_at_risk} currency={line.currency} digits={0} /> orders at risk</span> : null}
        </span>
      </button>
      {open && (
        <div className="space-y-3 px-4 pb-4 pl-11">
          <DeliveryChain chain={line.chain} />
          {line.proposals?.length ? (
            <div>
              <p className="label-mono mb-1.5">Simeli proposes · you decide</p>
              <ul className="space-y-1.5">
                {line.proposals.map((p) => <Proposal key={p.label} line={line} p={p} canManage={canManage} onAsk={onAsk} />)}
              </ul>
            </div>
          ) : null}
          <Button size="sm" variant="ghost" icon={SparklesIcon} onClick={() => onAsk(`Why has ${line.code} slowed down, what is it costing us, and which orders does it put at risk?`)}>
            Ask Simeli about {line.code}
          </Button>
        </div>
      )}
    </li>
  )
}

/** For the Production dashboard and the Work Centres screen. */
export default function LineWatchModule({ className = '' }) {
  const { user } = useAuth()
  const { openSimeli } = useShell()
  const ask = (question) => openSimeli({ question })
  const canManage = ['ADMIN', 'MANAGER'].includes(user?.role)
  const { data, loading, error, refetch } = useResource(['manufacturing', 'line-watch'], ({ signal }) => api.get('/manufacturing/line-watch', { signal }))
  const [open, setOpen] = useState(null)
  const lines = data?.lines || []
  useEffect(() => { if (lines.length && open == null) setOpen(lines[0].work_center_id) }, [lines, open])

  return (
    <Card
      title="Line watch"
      description="Work centres running slower than their own norm, and what it costs"
      className={className}
      padded={false}
      actions={<Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => ask('Is anything slowing down on the shop floor, and what will it cost?')}>Ask Simeli</Button>}
    >
      {error ? (
        <ErrorState compact what="Line watch" error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <SkeletonRows rows={2} columns={2} />
      ) : lines.length === 0 ? (
        <p className="px-4 py-4 text-sm text-ink-600">
          {data?.summary?.centres_watched
            ? `All ${data.summary.centres_watched} work centres are running at or above their ${data.window.baseline_days}-day pace.`
            : 'No work centres set up yet.'}
        </p>
      ) : (
        <>
          <p className="border-b border-ink-100 px-4 py-2 text-xs text-ink-600">
            {lines.length} of {data.summary.centres_watched} lines slowed or stopped
            {data.summary.extra_cost ? <> · <Money amount={data.summary.extra_cost} currency={data.currency} digits={0} /> in line time</> : null}
            {data.summary.value_at_risk ? <> · <Money amount={data.summary.value_at_risk} currency={data.currency} digits={0} /> of orders at risk</> : null}
          </p>
          <ul>
            {lines.map((l) => (
              <LineRow
                key={l.work_center_id}
                line={l}
                open={open === l.work_center_id}
                onToggle={() => setOpen(open === l.work_center_id ? '' : l.work_center_id)}
                canManage={canManage}
                onAsk={ask}
              />
            ))}
          </ul>
        </>
      )}
    </Card>
  )
}
