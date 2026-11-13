import { useState } from 'react'
import { Link } from 'react-router-dom'
import { SparklesIcon } from '@heroicons/react/20/solid'

import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { Card, Badge, ErrorState, SkeletonRows } from '../ui'

/**
 * "Can we ship this on Thursday?" — on the order or quotation itself.
 *
 * The same answer Simeli gives (GET /api/delivery-risk/promise,
 * services/promiseCheck.js): per line what is free on the day, what is short and
 * the first day in full; for what is short, the supplier who lands in time with
 * the purchase order ready to prepare. Read-only; proposals go to Simeli, which
 * drafts them for a person to approve.
 */

const ask = (q) => `/ai/chat?q=${encodeURIComponent(q)}`
const fmt = (v) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(v || 0)
const day = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : '—')

export default function PromiseCheck({ salesOrderId, quotationId, number, className = '' }) {
  const [date, setDate] = useState('')
  const params = { ...(salesOrderId ? { sales_order_id: salesOrderId } : { quotation_id: quotationId }), ...(date ? { date } : {}) }
  const { data, loading, error, refetch } = useResource(
    ['promise-check', salesOrderId || quotationId, date],
    ({ signal }) => api.get('/delivery-risk/promise', { params, signal }),
    { enabled: !!(salesOrderId || quotationId), retry: false }
  )
  const shown = date || data?.date || ''

  return (
    <Card
      title="Can we ship it on the day?"
      description="Free on the day, short, and who can bring the rest in time"
      className={className}
      padded={false}
      actions={data ? <Badge tone={data.tone || 'ink'}>{data.verdict_label}</Badge> : null}
    >
      <div className="flex items-center gap-2 border-b border-ink-100 px-4 py-2.5">
        <label htmlFor="promise-date" className="text-xs text-ink-600">Ship on</label>
        <input
          id="promise-date"
          type="date"
          value={shown}
          min={data?.as_of}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-md border border-ink-200 bg-transparent px-2 py-1 text-sm tabular-nums text-fg"
        />
        {data && !date ? <span className="text-2xs text-ink-500">{data.date_basis}</span> : null}
      </div>
      {error ? (
        <ErrorState compact what="The promise check" error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <SkeletonRows rows={3} columns={1} />
      ) : (
        <>
          <p className="border-b border-ink-100 px-4 py-3 text-sm text-fg">{data.headline}</p>
          <table className="w-full border-b border-ink-100 text-sm">
            <thead>
              <tr className="text-left text-2xs uppercase tracking-wide text-ink-500">
                <th className="px-4 py-1.5 font-normal">Item</th>
                <th className="px-2 py-1.5 text-right font-normal">Needed</th>
                <th className="px-2 py-1.5 text-right font-normal">Ready</th>
                <th className="px-2 py-1.5 text-right font-normal">Short</th>
                <th className="px-4 py-1.5 text-right font-normal">In full</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.line_number} className="border-t border-ink-100">
                  <td className="max-w-[10rem] truncate px-4 py-1.5 text-ink-800">
                    {l.item_id ? <Link to={`/inventory/items/${l.item_id}`} className="bos-link">{l.item}</Link> : l.item}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{fmt(l.needed)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{fmt(l.ready_by_date)}</td>
                  <td className={`px-2 py-1.5 text-right tabular-nums ${l.short > 0 ? 'text-risk-700' : 'text-ink-500'}`}>{fmt(l.short)}</td>
                  <td className="whitespace-nowrap px-4 py-1.5 text-right text-xs text-ink-600">{l.earliest_in_full ? day(l.earliest_in_full) : 'not on order'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.fixes?.some((f) => f.supplier) ? (
            <ul className="space-y-1 border-b border-ink-100 px-4 py-2.5 text-xs text-ink-700">
              {data.fixes.filter((f) => f.supplier).map((f) => (
                <li key={f.line_number}>
                  <Link to={`/procurement/suppliers/${f.supplier.supplier_id}`} className="bos-link">{f.supplier.name}</Link>
                  {` · ${f.supplier.lead_days} days (${f.supplier.lead_basis || 'catalogue'})`}
                  {f.supplier.on_time_pct != null ? ` · ${f.supplier.on_time_pct}% on time` : ''}
                  {` · lands ${day(f.supplier.lands)}`}
                  <span className={f.supplier.in_time ? 'text-ok-700' : 'text-warn-700'}>{f.supplier.in_time ? ' · in time' : ' · too late'}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {data.proposals?.length ? (
            <div className="border-b border-ink-100 px-4 py-3">
              <p className="label-mono mb-1.5">Simeli proposes · you decide</p>
              <ul className="space-y-1.5">
                {data.proposals.slice(0, 4).map((p) => (
                  <li key={p.label} className="flex items-start justify-between gap-3 rounded-md border border-ink-200 px-3 py-2 text-sm">
                    <span className="min-w-0 text-ink-800">{p.label}</span>
                    <Link to={ask(p.tool ? `${p.label} (for ${number}, to ship ${data.date}) — prepare it for my approval.` : `Help me with this for ${number}: ${p.label}.`)} className="flex-none whitespace-nowrap text-xs text-brand-700 hover:underline">
                      {p.tool ? 'Prepare' : 'Ask'}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-3 px-4 py-2.5">
            <p className="min-w-0 truncate text-2xs text-ink-500">Read {data.read.length} sources: {data.read.map((s) => s.call).join(' · ')}</p>
            <Link to={ask(`Can we ship ${number} on ${data.date}?`)} className="inline-flex flex-none items-center gap-1 text-xs text-brand-700 hover:underline">
              <SparklesIcon className="h-3.5 w-3.5" aria-hidden="true" /> Ask Simeli
            </Link>
          </div>
        </>
      )}
    </Card>
  )
}
