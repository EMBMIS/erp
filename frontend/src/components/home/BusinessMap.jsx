import { useState } from 'react'
import { Link } from 'react-router-dom'
import { SparklesIcon, ArrowRightIcon } from '@heroicons/react/20/solid'

import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { useAuth } from '../../contexts/AuthContext'
import { canSeeArea } from '../../constants/permissions'
import { useShell } from '../shell/ShellContext'
import { Card, Badge, Button, ErrorState, SkeletonRows, Money } from '../ui'

/**
 * Your business, with a brain — the whole company on one map.
 *
 * GET /api/what-matters/map (services/businessMap.js), the same answer Simeli
 * gives to "show me the business" (map_the_business): ten parts of the
 * business, each read from the company's own records as the signed-in person,
 * which part depends on which, and the at-risk customer order whose cause
 * crosses the most of it, walked step by step. Read-only: "Ask Simeli" opens
 * the conversation, and every next step is still a person's approval.
 */

const DOT = { alert: 'bg-risk-500', watch: 'bg-warn-500', clear: 'bg-ok-500', off: 'bg-ink-300', not_in_view: 'bg-ink-300' }
const STATE = { alert: 'Needs a person', watch: 'Watching', clear: 'Clear', off: 'Off', not_in_view: 'Not in your view' }
const AREA = [[/^\/hr/, 'hr'], [/^\/admin/, 'admin'], [/^\/approvals/, 'approvals'], [/^\/finance/, 'finance']]
const areaOf = (to) => (AREA.find(([re]) => re.test(to || '')) || [])[1]

export function useBusinessMap() {
  return useResource(['home', 'business-map'], ({ signal }) => api.get('/what-matters/map', { signal }))
}

function Region({ r, active, inTrace, onPick }) {
  return (
    <button
      type="button"
      onClick={() => onPick(r.key)}
      aria-pressed={active}
      className={`flex min-w-0 flex-col gap-1 rounded-md border px-3 py-2.5 text-left transition-colors hover:bg-ink-50 ${active ? 'border-brand-500 bg-brand-50' : inTrace ? 'border-risk-500/60' : 'border-ink-100'}`}
    >
      <span className="flex items-center gap-1.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[r.state] || DOT.off}`} aria-hidden="true" />
        <span className="truncate text-sm font-medium text-fg">{r.label}</span>
        <span className="sr-only">{STATE[r.state]}</span>
      </span>
      <span className="label-mono truncate">{r.metric}</span>
      <span className="line-clamp-2 text-xs text-ink-600">{r.reading}</span>
    </button>
  )
}

export default function BusinessMap({ className = '' }) {
  const { user } = useAuth()
  const { openSimeli } = useShell()
  const ask = (question) => openSimeli({ question })
  const { data, loading, error, refetch } = useBusinessMap()
  const [picked, setPicked] = useState(null)
  const regions = data?.regions || []
  const trace = data?.trace
  const inTrace = new Set(trace?.regions || [])
  const sel = regions.find((r) => r.key === picked)
  const canOpen = (to) => to && canSeeArea(user?.role, areaOf(to))
  const name = (k) => regions.find((r) => r.key === k)?.label || k

  return (
    <Card
      title="Your business, connected"
      description="Every part of the company, read from its own records as you — what depends on what, and where today's problem comes from"
      className={className}
      padded={false}
      actions={<Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => ask('Show me the business: how does everything connect, and where is the problem coming from?')}>Ask Simeli</Button>}
    >
      {error ? (
        <ErrorState compact what="The business map" error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <SkeletonRows rows={3} columns={5} />
      ) : (
        <>
          <p className="border-b border-ink-100 px-4 py-2 text-xs text-ink-600">{data?.headline}</p>
          <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 lg:grid-cols-5">
            {regions.map((r) => <Region key={r.key} r={r} active={picked === r.key} inTrace={inTrace.has(r.key)} onPick={(k) => setPicked(picked === k ? null : k)} />)}
          </div>

          {sel ? (
            <div className="mx-3 mb-3 rounded-md border border-ink-100 bg-sunken px-3 py-2.5 text-sm">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-fg">{sel.label}</span>
                <Badge tone={sel.state === 'alert' ? 'risk' : sel.state === 'watch' ? 'warn' : sel.state === 'clear' ? 'ok' : 'ink'}>{STATE[sel.state]}</Badge>
                <span className="text-xs text-ink-500">{sel.line}</span>
              </p>
              {sel.signal ? <p className="mt-1 text-fg">{sel.signal}</p> : null}
              {sel.at_stake?.amount ? <p className="mt-0.5 text-xs text-ink-600"><Money amount={sel.at_stake.amount} currency={sel.at_stake.currency} digits={0} /> at stake</p> : null}
              {sel.next_step?.label ? (
                <p className="mt-1 text-xs text-ink-700"><span className="label-mono mr-1">Next</span>{sel.next_step.label}{sel.next_step.approver ? <span className="text-ink-500"> · {sel.next_step.approver}</span> : null}</p>
              ) : null}
              <p className="mt-2 flex flex-wrap gap-2">
                <Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => ask(`${sel.next_step?.ask || sel.ask} Prepare the next step for my approval.`)}>Ask Simeli</Button>
                {canOpen(sel.link) ? <Button size="xs" variant="ghost" to={sel.link}>Open {sel.label.toLowerCase()}</Button> : null}
              </p>
            </div>
          ) : null}

          {trace ? (
            <div className="border-t border-ink-100 px-4 py-3">
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={trace.verdict === 'at_risk' ? 'warn' : 'risk'} glyph="triangle">Traced</Badge>
                <span className="min-w-0 flex-1 text-fg">{trace.question}</span>
                {trace.at_stake?.amount ? <span className="text-xs text-ink-600"><Money amount={trace.at_stake.amount} currency={trace.at_stake.currency} digits={0} /> at stake</span> : null}
              </p>
              <ol className="relative mt-2 space-y-1.5 border-l border-ink-200 pl-4">
                {trace.steps.map((s, n) => (
                  <li key={n} className="text-xs">
                    <span className="label-mono mr-1.5">{name(s.region)}</span>
                    {s.link ? <Link to={s.link} className="bos-link">{s.step}</Link> : <span className="text-fg">{s.step}</span>}
                  </li>
                ))}
              </ol>
              <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-700">
                <span className="label-mono">Next</span>{trace.next_step.label}<span className="text-ink-500">· {trace.next_step.approver}</span>
                <Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => ask(`${trace.question} Find what would make it hold and prepare it for my approval.`)}>Ask Simeli</Button>
                <Link to={trace.sales_order.link} className="bos-link">{trace.sales_order.number}</Link>
              </p>
            </div>
          ) : null}

          <div className="border-t border-ink-100 px-4 py-2.5">
            <p className="label-mono mb-1">How it connects</p>
            <ul className="grid gap-x-6 gap-y-1 text-xs text-ink-600 md:grid-cols-2">
              {(data?.relationships || []).filter((l) => l.flows).map((l) => (
                <li key={`${l.from}>${l.to}`} className={`flex items-center gap-1.5 ${l.in_trace ? 'text-risk-700' : ''}`}>
                  <span className="font-medium text-fg">{name(l.from)}</span>
                  <ArrowRightIcon className="h-3 w-3 shrink-0 text-ink-400" aria-hidden="true" />
                  <span className="font-medium text-fg">{name(l.to)}</span>
                  <span className="min-w-0 truncate">· {l.flows}</span>
                </li>
              ))}
            </ul>
            {data?.grown?.length ? (
              <p className="mt-2 text-xs text-ink-600">
                <span className="label-mono mr-1">Grown in Sandbox</span>
                {data.grown.map((g, n) => (
                  <span key={g.key}>{n ? '; ' : ''}<Link to={g.link} className="bos-link">{g.name}</Link>{g.wires.length ? ` → ${g.wires.map(name).join(', ')}` : ''}</span>
                ))}
              </p>
            ) : null}
            {data?.not_in_your_view?.length ? <p className="mt-1.5 text-xs text-ink-500">Not in your view: {data.not_in_your_view.join(', ')}.</p> : null}
          </div>
        </>
      )}
    </Card>
  )
}
