import { useState } from 'react'
import { Link } from 'react-router-dom'
import { SparklesIcon, EyeIcon } from '@heroicons/react/20/solid'

import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { useShell } from '../shell/ShellContext'
import { Card, Badge, Button, ErrorState, SkeletonRows, Money, relativeTime } from '../ui'

/**
 * What matters now: Simeli watches the business and brings what needs a
 * person, most urgent and most money first.
 *
 * The same brief Simeli gives to "what needs my attention today?"
 * (GET /api/what-matters, services/whatMattersNow.js): every watcher — late
 * deliveries, slow lines, risky suppliers, waiting decisions, approvers away,
 * the cash dip, bills about to be paid twice, the margin — run as the
 * signed-in person. Each item has its cause, what is at stake and the next
 * step with who approves it. Nothing here changes anything: "Ask Simeli"
 * opens the conversation on that item, and drafting or holding is still a
 * person's confirmation.
 */

export function useWhatMatters() {
  return useResource(['home', 'what-matters'], ({ signal }) => api.get('/what-matters', { params: { limit: 7 }, signal }))
}

export function useSimeliWatch() {
  return useResource(['home', 'simeli-watch'], ({ signal }) => api.get('/what-matters/watch', { signal }))
}

/**
 * What Simeli noticed on its own (GET /api/what-matters/watch, services/simeliWatch.js):
 * the watch runs the same brief as this person every few minutes and remembers what it
 * showed them, so this says what is new, what got worse and what cleared since yesterday.
 */
function Noticed({ onAsk }) {
  const { data, refetch } = useSimeliWatch()
  const [checking, setChecking] = useState(false)
  const check = async () => {
    setChecking(true)
    try { await api.get('/what-matters/watch', { params: { check: 1 } }); await refetch() } finally { setChecking(false) }
  }
  if (!data) return null
  const changed = [
    ...(data.new || []).map((i) => ({ ...i, change: 'New', at: i.first_seen_at })),
    ...(data.worse || []).map((i) => ({ ...i, change: 'Worse', at: i.worsened_at })),
  ].slice(0, 4)
  return (
    <div className="border-b border-ink-100 bg-sunken px-4 py-2.5">
      <p className="flex flex-wrap items-center gap-2 text-xs text-ink-600">
        <EyeIcon className="h-3.5 w-3.5 text-brand-600" aria-hidden="true" />
        <span className="font-medium text-fg">Simeli noticed</span>
        <span className="min-w-0 flex-1">{data.headline}</span>
        {data.last_watched_at ? <span className="text-ink-500">watched {relativeTime(data.last_watched_at)} · every {data.every_minutes} min</span> : null}
        <Button size="xs" variant="ghost" onClick={check} disabled={checking}>{checking ? 'Watching…' : 'Check now'}</Button>
      </p>
      {changed.length ? (
        <ul className="mt-1.5 space-y-1">
          {changed.map((i) => (
            <li key={`${i.change}:${i.key}`} className="flex items-start gap-2 text-xs">
              <Badge tone={i.change === 'Worse' ? 'risk' : 'brand'}>{i.change}</Badge>
              <span className="min-w-0 flex-1 text-fg">
                {i.link ? <Link to={i.link} className="bos-link">{i.title}</Link> : i.title}
                {i.worsened_note && i.change === 'Worse' ? <span className="text-ink-600"> — {i.worsened_note}</span> : null}
                <span className="text-ink-500"> · {relativeTime(i.at)}</span>
              </span>
              {i.ask ? <button type="button" className="bos-link shrink-0" onClick={() => onAsk(`${i.ask} Prepare the next step for my approval.`)}>Ask</button> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {data.cleared?.length ? (
        <p className="mt-1 text-xs text-ink-500">Cleared: {data.cleared.slice(0, 3).map((c) => c.title).join(' · ')}{data.cleared.length > 3 ? ` and ${data.cleared.length - 3} more` : ''}</p>
      ) : null}
    </div>
  )
}

function Stake({ s }) {
  if (!s?.amount) return null
  return <span className="block text-right text-xs text-ink-600"><Money amount={s.amount} currency={s.currency} digits={0} /> at stake</span>
}

function Item({ item, onAsk }) {
  return (
    <li className="flex items-start gap-3 border-b border-ink-100 px-4 py-3 last:border-0">
      <span className="mt-0.5 w-5 shrink-0 text-xs tabular-nums text-ink-400">{item.rank}</span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={item.severity === 'HIGH' ? 'risk' : 'warn'} glyph="triangle">{item.area}</Badge>
          {item.link && item.record?.number ? <Link to={item.link} className="bos-link text-xs">{item.record.number}</Link> : null}
        </span>
        <span className="mt-1 block text-sm text-fg">{item.title}</span>
        {item.cause ? <span className="mt-0.5 block text-xs text-ink-600">Cause: {item.cause}</span> : null}
        {item.at_stake?.what ? <span className="mt-0.5 block text-xs text-ink-600">At stake: {item.at_stake.what}</span> : null}
        {/* Something the company built, tied to what already exists (or a supplier carrying it). */}
        {item.connects?.length ? (
          <span className="mt-0.5 block text-xs text-ink-600">
            Connects to: {item.connects.map((c, n) => <span key={c.id || n}>{n ? ', ' : ''}{c.link ? <Link to={c.link} className="bos-link">{c.label || c.type}</Link> : (c.label || c.type)}</span>)}
          </span>
        ) : null}
        {item.area !== 'Built in Sandbox' && item.built_records?.length ? (
          <span className="mt-0.5 block text-xs text-ink-600">
            Open in what you built: {item.built_records.slice(0, 2).map((b, n) => <span key={b.id}>{n ? ', ' : ''}<Link to={b.link} className="bos-link">{b.number || b.title}</Link>{b.application ? ` (${b.application})` : ''}</span>)}
          </span>
        ) : null}
        {item.next_step?.label ? (
          <span className="mt-1.5 block text-xs text-ink-700">
            <span className="label-mono mr-1">Next</span>{item.next_step.label}
            {item.next_step.approver ? <span className="text-ink-500"> · {item.next_step.approver}</span> : null}
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1.5">
        <Stake s={item.at_stake} />
        <Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => onAsk(`${item.ask} Prepare the next step for my approval.`)}>Ask Simeli</Button>
      </span>
    </li>
  )
}

export default function WhatMatters({ className = '' }) {
  const { openSimeli } = useShell()
  const ask = (question) => openSimeli({ question })
  const { data, loading, error, refetch } = useWhatMatters()
  const items = data?.items || []
  const clear = (data?.checked || []).filter((c) => c.status === 'clear')

  return (
    <Card
      title="What matters now"
      description="Simeli ran every watcher as you: what needs a person, most urgent and most money first"
      className={className}
      padded={false}
      actions={(
        <span className="flex gap-1">
          <Button size="xs" variant="ghost" icon={EyeIcon} onClick={() => ask('What have you noticed for me, and what is new since I last looked?')}>What changed</Button>
          <Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => ask('What needs my attention today?')}>Ask Simeli</Button>
        </span>
      )}
    >
      {error ? (
        <ErrorState compact what="What matters now" error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <SkeletonRows rows={3} columns={2} />
      ) : (
        <>
          <Noticed onAsk={ask} />
          <p className="border-b border-ink-100 px-4 py-2 text-xs text-ink-600">{data?.headline}</p>
          {items.length ? <ul>{items.map((i) => <Item key={i.id} item={i} onAsk={ask} />)}</ul> : null}
          {clear.length ? (
            <p className="px-4 py-2 text-xs text-ink-500">
              Checked and clear: {clear.map((c) => c.watcher.toLowerCase()).join(', ')}.
            </p>
          ) : null}
        </>
      )}
    </Card>
  )
}
