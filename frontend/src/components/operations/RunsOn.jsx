import { useState } from 'react'
import { SparklesIcon } from '@heroicons/react/20/solid'

import api from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { useShell } from '../shell/ShellContext'
import { Card, Badge, Button, ErrorState, SkeletonRows, Money, Select } from '../ui'
import { DeliveryChain } from '../sales/DeliveryRisk'

/**
 * What we run on — and what stops if one piece of it does.
 *
 * The same answer Simeli gives to "what is our single point of failure?" and
 * "what if ML-03 is down for three days?" (GET /api/runs-on and
 * /api/runs-on/what-if, services/runsOn.js): every line, site and system the
 * open customer orders depend on, ranked by what is behind it, and a what-if
 * that reads the delivery trace with that piece out for N days. Nothing is
 * written. Moving an operation is a manager's click; everything else goes to
 * Simeli to draft for a person to approve.
 */

const HEALTH = {
  ok: { tone: 'ok', label: 'OK' },
  warn: { tone: 'warn', label: 'Check' },
  down: { tone: 'risk', label: 'Down' },
  idle: { tone: 'ink', label: 'Idle' },
  not_connected: { tone: 'ink', label: 'Not connected' },
}

function Health({ h }) {
  const x = HEALTH[h] || HEALTH.ok
  return <Badge tone={x.tone} glyph={h === 'down' ? 'triangle' : h === 'ok' ? 'check' : 'ring'}>{x.label}</Badge>
}

function Node({ n, currency, onTest }) {
  return (
    <li className="flex items-start gap-3 px-4 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-fg">{n.code ? `${n.code} · ${n.name}` : n.name}</span>
          <Health h={n.health} />
          {n.single_point ? <Badge tone="warn" glyph="triangle">Single point</Badge> : null}
        </span>
        <span className="mt-0.5 block text-xs text-ink-600">{n.note || n.detail}</span>
        {n.equipment?.length ? (
          <span className="mt-0.5 block text-xs text-ink-500">
            Equipment: {n.equipment.map((a) => `${a.asset_number} ${a.name}${a.past_life ? ' (past useful life)' : ''}`).join(', ')}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 text-right text-xs text-ink-600">
        {n.value_depending ? <span className="block"><Money amount={n.value_depending} currency={currency} digits={0} /> behind it</span> : null}
        {onTest ? <Button size="xs" variant="ghost" className="mt-1" onClick={onTest}>What if it stops?</Button> : null}
      </span>
    </li>
  )
}

function MoveButton({ p }) {
  const move = useResourceMutation(
    () => api.post(`/manufacturing/operations/${p.operation_id}/move`, { work_center_id: p.to_work_center_id }),
    { invalidates: [['runs-on'], ['manufacturing', 'line-watch']], successMessage: `Moved: ${p.label}` }
  )
  return (
    <Button size="xs" variant="primary" loading={move.isPending} disabled={move.isSuccess} onClick={() => move.mutate()}>
      {move.isSuccess ? 'Moved' : 'Approve move'}
    </Button>
  )
}

function WhatIf({ map, initial, canManage, onAsk }) {
  const options = [
    ...(map.lines || []).map((l) => ({ value: `work_center|${l.id}`, label: `Line ${l.code} · ${l.name}` })),
    ...(map.sites || []).map((s) => ({ value: `site|${s.id}`, label: `Site ${s.code} · ${s.name}` })),
    ...(map.systems || []).filter((y) => y.kind !== 'agent').map((y) => ({ value: `${y.kind}|${y.id}`, label: `System · ${y.name}` })),
  ]
  const [pick, setPick] = useState(initial || '')
  const [days, setDays] = useState(3)
  const [kind, ref] = String(pick).split('|')
  const { data, loading, error, refetch } = useResource(
    ['runs-on', 'what-if', pick, days],
    ({ signal }) => api.get('/runs-on/what-if', { params: { kind, ref, days }, signal }),
    { enabled: !!pick }
  )
  if (!options.length) return null
  return (
    <div className="space-y-3 border-t border-ink-100 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="label-mono">What if</span>
        <Select size="sm" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="What stops" className="max-w-[18rem]">
          <option value="">Pick a line, site or system…</option>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
        <span className="text-sm text-ink-600">is out for</span>
        <Select size="sm" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Days" className="w-24">
          {[1, 2, 3, 5, 7, 14].map((d) => <option key={d} value={d}>{d} day{d === 1 ? '' : 's'}</option>)}
        </Select>
      </div>
      {error ? (
        <ErrorState compact what="The what-if" error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <SkeletonRows rows={2} columns={2} />
      ) : data ? (
        <div className="space-y-3">
          <p className="text-sm font-medium text-fg">{data.headline}</p>
          {data.orders?.length ? (
            <ul className="space-y-2">
              {data.orders.slice(0, 5).map((o) => (
                <li key={o.sales_order_id} className="rounded-md border border-ink-200 px-3 py-2">
                  <p className="text-sm text-fg">
                    {o.so_number} · {o.customer_name} — due {o.due_date}: {o.before.projected_date || 'no date'} → <span className="font-medium">{o.after.projected_date || 'no date'}</span>
                    {' '}(<Money amount={o.value} currency={o.currency} digits={0} />{o.penalty_added ? <>, +<Money amount={o.penalty_added} currency={o.currency} digits={0} /> penalty</> : null})
                  </p>
                  <DeliveryChain chain={o.chain.filter((s) => s.layer !== 'finance').slice(0, 4)} />
                </li>
              ))}
            </ul>
          ) : null}
          {data.proposals?.length ? (
            <div>
              <p className="label-mono mb-1.5">Simeli proposes · you decide</p>
              <ul className="space-y-1.5">
                {data.proposals.map((p) => (
                  <li key={p.label} className="flex items-start justify-between gap-3 rounded-md border border-ink-200 px-3 py-2 text-sm">
                    <span className="min-w-0 text-ink-800">{p.label}</span>
                    {p.kind === 'move_operation' && canManage ? <MoveButton p={p} /> : (
                      <Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => onAsk(`${p.label} — this is from the what-if "${data.target?.name} out for ${days} days". Help me act on it; draft anything for my approval.`)}>
                        Ask Simeli
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="text-xs text-ink-500">{data.method}</p>
        </div>
      ) : null}
    </div>
  )
}

/** For the Production dashboard and the Warehouse screen. */
export default function RunsOnModule({ focus = 'lines', className = '' }) {
  const { user } = useAuth()
  const { openSimeli } = useShell()
  const ask = (question) => openSimeli({ question })
  const canManage = ['ADMIN', 'MANAGER'].includes(user?.role)
  const { data, loading, error, refetch } = useResource(['runs-on'], ({ signal }) => api.get('/runs-on', { signal }))
  const [test, setTest] = useState(null)
  const cur = data?.currency
  const first = focus === 'sites' ? data?.sites : data?.lines
  const second = focus === 'sites' ? data?.lines : data?.sites
  const pickOf = (n) => `${n.kind}|${n.id}`

  return (
    <Card
      title="What we run on"
      description="The lines, sites and systems the open orders depend on — and what stops if one of them does"
      className={className}
      padded={false}
      actions={<Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => ask('What do we run on, and what is our single point of failure?')}>Ask Simeli</Button>}
    >
      {error ? (
        <ErrorState compact what="What we run on" error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <SkeletonRows rows={3} columns={2} />
      ) : data ? (
        <>
          <p className="border-b border-ink-100 px-4 py-2 text-sm text-fg">{data.headline}</p>
          {data.watch?.length > 1 ? (
            <ul className="border-b border-ink-100 px-4 py-2 text-xs text-ink-600">
              {data.watch.slice(1, 4).map((w) => <li key={`${w.kind}-${w.id}-${w.text}`}>· {w.text}</li>)}
            </ul>
          ) : null}
          {[first, second].map((group, gi) => (group?.length ? (
            <div key={gi}>
              <p className="label-mono px-4 pt-3">{(gi === 0) === (focus !== 'sites') ? 'Lines' : 'Sites'}</p>
              <ul className="divide-y divide-ink-100">
                {group.slice(0, 6).map((n) => <Node key={n.id} n={n} currency={cur} onTest={() => setTest(pickOf(n))} />)}
              </ul>
            </div>
          ) : null))}
          {data.systems?.length ? (
            <div>
              <p className="label-mono px-4 pt-3">Systems</p>
              <ul className="divide-y divide-ink-100">
                {data.systems.map((y) => <Node key={`${y.kind}-${y.id}`} n={{ ...y, note: `${y.detail} · runs ${y.runs}` }} currency={cur} onTest={y.kind !== 'agent' ? () => setTest(pickOf(y)) : null} />)}
              </ul>
            </div>
          ) : data.systems_note ? <p className="px-4 pt-3 text-xs text-ink-500">{data.systems_note}</p> : null}
          <WhatIf key={test || 'none'} map={data} initial={test} canManage={canManage} onAsk={ask} />
        </>
      ) : null}
    </Card>
  )
}
