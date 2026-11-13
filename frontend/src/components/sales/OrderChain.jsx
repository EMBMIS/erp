import { Link } from 'react-router-dom'
import { SparklesIcon } from '@heroicons/react/20/solid'

import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { Card, Badge, ErrorState, SkeletonRows } from '../ui'

/**
 * Point at an order. See the whole business behind it.
 *
 * The same chain Simeli reads (GET /api/delivery-risk/chain, services/orderChain.js):
 * customer credit, product, stock, supplier, purchase or work order, invoice and
 * the margin with its reason, each link naming the record it came from. Read-only;
 * its proposals go to Simeli, which drafts them for a person to approve.
 */

const DOT = { ok: 'bg-ok-500', warn: 'bg-warn-500', risk: 'bg-risk-500' }
const TEXT = { ok: 'text-ok-700', warn: 'text-warn-700', risk: 'text-risk-700' }
const ask = (q) => `/ai/chat?q=${encodeURIComponent(q)}`

function href(r) {
  if (!r?.id) return null
  switch (r.type) {
    case 'customer': return `/sales/customers/${r.id}`
    case 'item': return `/inventory/items/${r.id}`
    case 'supplier': return `/procurement/suppliers/${r.id}`
    case 'purchase_order': return `/procurement/purchase-orders/${r.id}`
    case 'work_order': return '/manufacturing/work-orders'
    case 'customer_invoice': return '/finance/customer-invoices'
    default: return null
  }
}

export default function OrderChain({ salesOrderId, soNumber, className = '' }) {
  const { data, loading, error, refetch } = useResource(
    ['order-chain', salesOrderId],
    ({ signal }) => api.get('/delivery-risk/chain', { params: { sales_order_id: salesOrderId }, signal }),
    { enabled: !!salesOrderId, retry: false }
  )

  return (
    <Card
      title="Everything behind this order"
      description="Customer, stock, supplier, supply, invoice and margin — one record"
      className={className}
      padded={false}
      actions={data ? <Badge tone={data.tone || 'ink'}>{data.verdict_label}</Badge> : null}
    >
      {error ? (
        <ErrorState compact what="The order chain" error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <SkeletonRows rows={4} columns={1} />
      ) : (
        <>
          <p className="border-b border-ink-100 px-4 py-3 text-sm text-fg">{data.headline}</p>
          <ol className="border-b border-ink-100 px-4 py-2">
            {data.chain.map((step) => {
              const to = href(step.record)
              return (
                <li key={step.kind} className="relative grid grid-cols-[0.75rem_6.5rem_minmax(0,1fr)] items-baseline gap-2 py-1.5 text-sm">
                  <span className={`h-1.5 w-1.5 translate-y-[-1px] rounded-full ${DOT[step.tone] || 'bg-ink-300'}`} aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block text-ink-700">{step.kind}</span>
                    <span className="block text-2xs uppercase tracking-wide text-ink-500">{step.module}</span>
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-fg">
                      {to ? <Link to={to} className="bos-link">{step.title}</Link> : step.title}
                    </span>
                    <span className={`block text-xs ${TEXT[step.tone] || 'text-ink-600'}`}>{step.detail}</span>
                  </span>
                </li>
              )
            })}
          </ol>
          {data.margin ? (
            <div className="flex items-end justify-between gap-3 border-b border-ink-100 px-4 py-3">
              <div className="min-w-0">
                <p className="text-xs text-ink-600">Margin on this order</p>
                <p className={`mt-0.5 text-xs ${TEXT[data.margin.tone] || 'text-ink-600'}`}>{data.margin.note}</p>
              </div>
              <span className="flex-none text-2xl font-medium tabular-nums text-fg">{data.margin.pct != null ? `${data.margin.pct}%` : '—'}</span>
            </div>
          ) : null}
          {data.proposals?.length ? (
            <div className="border-b border-ink-100 px-4 py-3">
              <p className="label-mono mb-1.5">Simeli proposes · you decide</p>
              <ul className="space-y-1.5">
                {data.proposals.slice(0, 4).map((p) => (
                  <li key={p.label} className="flex items-start justify-between gap-3 rounded-md border border-ink-200 px-3 py-2 text-sm">
                    <span className="min-w-0 text-ink-800">{p.label}</span>
                    <Link to={ask(p.tool ? `${p.label} (for ${soNumber}) — prepare it for my approval.` : `Help me with this for ${soNumber}: ${p.label}.`)} className="flex-none whitespace-nowrap text-xs text-brand-700 hover:underline">
                      {p.tool ? 'Prepare' : 'Ask'}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-3 px-4 py-2.5">
            <p className="min-w-0 truncate text-2xs text-ink-500">Read {data.sources.length} sources: {data.sources.map((s) => s.call).join(' · ')}</p>
            <Link to={ask(`Show me everything behind ${soNumber}.`)} className="inline-flex flex-none items-center gap-1 text-xs text-brand-700 hover:underline">
              <SparklesIcon className="h-3.5 w-3.5" aria-hidden="true" /> Ask Simeli
            </Link>
          </div>
        </>
      )}
    </Card>
  )
}
