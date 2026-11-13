import { useState } from 'react'
import { SparklesIcon } from '@heroicons/react/20/solid'

import api from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { useShell } from '../shell/ShellContext'
import { Card, Button, Textarea } from '../ui'

/**
 * Quality reviews waiting on production.
 *
 * Opened from the margin analysis ("Scrap on line 2 is 4.1% against 1.9%" —
 * services/marginFollowUps.js) with the evidence it read. Production closes
 * one by saying what they found and did; nothing else closes it. Renders
 * nothing when no review is open.
 */

function Review({ q, canClose, onAsk }) {
  const [outcome, setOutcome] = useState('')
  const [closing, setClosing] = useState(false)
  const close = useResourceMutation(
    () => api.post(`/manufacturing/quality-reviews/${q.id}/close`, { outcome }),
    { invalidates: [['manufacturing', 'quality-reviews'], ['finance', 'margin-follow-ups']], successMessage: `${q.reference} closed` }
  )
  const ev = q.evidence || {}
  return (
    <li className="border-b border-ink-100 px-4 py-3 last:border-0">
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-sm font-medium text-fg">{q.reference} · {q.title}</span>
          <span className="mt-0.5 block text-xs text-ink-600">
            {q.work_center?.code}{q.work_center?.name && q.work_center.name !== q.work_center.code ? ` · ${q.work_center.name}` : ''}
            {ev.scrap_pct_now != null ? ` · scrap ${ev.scrap_pct_now}% against ${ev.scrap_pct_baseline}%` : ''}
            {ev.extra_units != null ? ` · ${Math.round(ev.extra_units)} more units lost` : ''}
            {q.opened_by ? ` · opened by ${q.opened_by}` : ''}
          </span>
        </span>
        <span className="flex flex-none gap-1.5">
          <Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => onAsk(`Why is ${q.work_center?.code} scrapping more than it used to? ${q.reference}.`)}>Ask Simeli</Button>
          {canClose && !closing ? <Button size="xs" variant="secondary" onClick={() => setClosing(true)}>Close</Button> : null}
        </span>
      </div>
      {closing ? (
        <div className="mt-2 space-y-2">
          <Textarea rows={2} value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="What was found, and what was done" aria-label="Outcome" />
          <span className="flex gap-1.5">
            <Button size="xs" variant="primary" loading={close.isPending} disabled={!outcome.trim()} onClick={() => close.mutate()}>Close review</Button>
            <Button size="xs" variant="ghost" onClick={() => setClosing(false)}>Cancel</Button>
          </span>
        </div>
      ) : null}
    </li>
  )
}

/** For the Work Centres screen. */
export default function QualityReviews({ className = '' }) {
  const { user } = useAuth()
  const { openSimeli } = useShell()
  const canClose = ['ADMIN', 'MANAGER'].includes(user?.role)
  const { data } = useResource(['manufacturing', 'quality-reviews'], ({ signal }) => api.get('/manufacturing/quality-reviews', { signal }))
  if (!data?.length) return null
  return (
    <Card title="Quality reviews" description="Open with production, from the margin analysis" className={className} padded={false}>
      <ul>{data.map((q) => <Review key={q.id} q={q} canClose={canClose} onAsk={(question) => openSimeli({ question })} />)}</ul>
    </Card>
  )
}
