import { useState } from 'react'
import { Link } from 'react-router-dom'
import { SparklesIcon } from '@heroicons/react/20/solid'

import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { Button, InlineNotice, relativeTime, notify } from '../ui'

/**
 * What Simeli caught the moment this order landed — without anyone asking.
 *
 * GET /api/delivery-risk/watch (services/orderWatch.js): when the order was
 * created, sent for approval, approved or confirmed, the promise check ran
 * against the day it is wanted. A short order raised a finding and notified its
 * owner and the people who can buy. Here it is re-checked live, in this
 * person's own view; the purchase order it proposes is drafted by a person with
 * procurement authority and goes through purchase approval.
 */

const ask = (q) => `/ai/chat?q=${encodeURIComponent(q)}`
const fmt = (v) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(v || 0)

export default function OrderWatch({ salesOrderId, number }) {
  const [v, setV] = useState(0)
  const [busy, setBusy] = useState(null)
  const { data } = useResource(
    ['order-watch', salesOrderId, v],
    ({ signal }) => api.get('/delivery-risk/watch', { params: { sales_order_id: salesOrderId }, signal }),
    { enabled: !!salesOrderId, retry: false }
  )
  const f = data?.finding
  if (!f) return null

  const draft = async (itemId) => {
    setBusy(itemId || 'po')
    try {
      const res = await api.post('/delivery-risk/watch/draft-po', { sales_order_id: salesOrderId, item_id: itemId || undefined })
      notify.success(res?.data?.message || 'Purchase order drafted')
      setV((n) => n + 1)
    } catch (e) {
      notify.error(e?.response?.data?.error || e.message)
    } finally {
      setBusy(null)
    }
  }

  if (f.status !== 'OPEN') {
    return (
      <InlineNotice tone="ok" icon={SparklesIcon} title={`Simeli caught ${number} short when it landed — settled now`}>
        {f.resolved_because || f.dismiss_reason || 'Nothing is short any more.'}
        {f.drafted?.length ? <> · {f.drafted.map((d) => <Link key={d.po_id} to={`/procurement/purchase-orders/${d.po_id}`} className="bos-link ml-1">{d.po_number}</Link>)}</> : null}
      </InlineNotice>
    )
  }

  const live = data.live
  const drafted = new Map((f.drafted || []).map((d) => [d.item_id, d]))
  const pos = (live?.proposals || []).filter((p) => p.kind === 'purchase_order')
  return (
    <InlineNotice
      tone={live?.tone === 'risk' || f.severity === 'HIGH' ? 'risk' : 'warn'}
      icon={SparklesIcon}
      title={`Simeli caught this the moment the order landed${f.trigger ? ` (${f.trigger})` : ''} · ${relativeTime(f.caught_at)}`}
      action={<Link to={ask(`What did you catch on ${number} when it landed, and what should I do?`)} className="text-xs text-brand-700 hover:underline">Ask Simeli</Link>}
    >
      <p>{live?.headline || f.title}</p>
      {f.short_lines?.length ? (
        <p className="mt-1 text-xs opacity-80">
          Short: {f.short_lines.map((l) => `${fmt(l.short)} × ${l.item}`).join(' · ')}
        </p>
      ) : null}
      {pos.length || drafted.size ? (
        <ul className="mt-2 space-y-1.5">
          {pos.map((p) => {
            const done = p.item_id && drafted.get(p.item_id)
            return (
              <li key={p.label} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-current/20 bg-surface px-3 py-2 text-ink-800">
                <span className="min-w-0 text-sm">{p.label}</span>
                {done ? (
                  <Link to={`/procurement/purchase-orders/${done.po_id}`} className="bos-link text-xs">{done.po_number} drafted · awaiting approval</Link>
                ) : p.draftable ? (
                  <Button size="sm" variant="primary" loading={busy === (p.item_id || 'po')} onClick={() => draft(p.item_id)}>Draft purchase order</Button>
                ) : (
                  <span className="text-xs text-ink-500">Someone with procurement authority drafts it</span>
                )}
              </li>
            )
          })}
          {[...drafted.values()].filter((d) => !pos.some((p) => p.item_id === d.item_id)).map((d) => (
            <li key={d.po_id} className="text-xs">
              <Link to={`/procurement/purchase-orders/${d.po_id}`} className="bos-link">{d.po_number}</Link> drafted by {d.by_name || 'someone'} · awaiting approval
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-2 text-2xs opacity-70">Simeli proposes · a person drafts and approves · {live?.visibility === 'full' ? 'prices shown for your role' : 'prices hidden for your role'}</p>
    </InlineNotice>
  )
}
