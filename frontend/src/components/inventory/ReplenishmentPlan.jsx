import { Link } from 'react-router-dom'
import { SparklesIcon } from '@heroicons/react/20/solid'

import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { useShell } from '../shell/ShellContext'
import { Card, Badge, Button, ErrorState, SkeletonRows } from '../ui'

/**
 * "We're going to run low on this. What should I do?"
 *
 * The same answer Simeli gives (GET /api/inventory-items/:id/replenishment,
 * services/replenishmentPlan.js): when the item runs out against the
 * supplier's lead time, weekly demand, the recommended order, budget left and
 * who it is routed to, with the sources it read. Preparing the purchase order
 * is a person's click here; it stays a DRAFT until it passes purchase approval.
 */

const TONE = { ok: 'ok', warn: 'warn', risk: 'risk' }

function PurchaseOrder({ p, rec, itemId }) {
  const draft = useResourceMutation(
    () => api.post('/purchase-orders', {
      supplier_id: p.args.supplier_id,
      currency: p.args.currency,
      delivery_date: p.args.expected_delivery_date || undefined,
      notes: p.args.notes,
      status: 'DRAFT',
      line_items: p.args.items.map((i) => ({ item_id: i.item_id, item_description: i.description, quantity: i.quantity, unit_price: i.unit_price })),
    }),
    { invalidates: [['replenishment', itemId]], successMessage: `Purchase order drafted — routed to ${rec?.routed_to || 'purchase approval'}` }
  )
  const po = draft.data
  return (
    <li className="flex items-start justify-between gap-3 rounded-md border border-ink-200 px-3 py-2 text-sm">
      <span className="min-w-0 text-ink-800">{p.label}</span>
      {po?.id ? (
        <Link to={`/procurement/purchase-orders/${po.id}`} className="bos-link flex-none whitespace-nowrap text-xs">Open {po.po_number || 'draft'} →</Link>
      ) : p.can_draft ? (
        <Button size="xs" variant="primary" loading={draft.isPending} onClick={() => draft.mutate()}>Prepare purchase order</Button>
      ) : (
        <span className="flex-none text-xs text-ink-600">Procurement prepares it</span>
      )}
    </li>
  )
}

/** For the inventory item screen. */
export default function ReplenishmentPlan({ inventoryItemId, name, className = '' }) {
  const { openSimeli } = useShell()
  const ask = (question) => openSimeli({ question })
  const { data, loading, error, refetch } = useResource(
    ['replenishment', inventoryItemId],
    ({ signal }) => api.get(`/inventory-items/${inventoryItemId}/replenishment`, { signal }),
    { enabled: !!inventoryItemId, retry: false }
  )
  const rec = data?.recommendation
  const po = (data?.proposals || []).find((p) => p.kind === 'purchase_order')

  return (
    <Card
      title="What should I do?"
      description="When it runs out, what to order, budget and approver"
      className={className}
      padded={false}
      actions={<Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => ask(`We're going to run low on ${name}. What should I do?`)}>Ask Simeli</Button>}
    >
      {error ? (
        <ErrorState compact what="The replenishment plan" error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <SkeletonRows rows={3} columns={1} />
      ) : (
        <>
          <p className="border-b border-ink-100 px-4 py-3 text-sm text-fg">
            <Badge tone={TONE[data.tone] || 'ink'} glyph={data.tone === 'ok' ? 'check' : 'triangle'}>{data.tone === 'ok' ? 'Covered' : data.tone === 'warn' ? 'Order soon' : 'Act now'}</Badge>{' '}
            {data.headline}
          </p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-b border-ink-100 px-4 py-3 text-sm">
            {data.facts.map((f) => (
              <div key={f.label} className="min-w-0">
                <dt className="text-xs text-ink-600">{f.label}</dt>
                <dd className={f.tone === 'risk' ? 'text-risk-700' : f.tone === 'warn' ? 'text-warn-700' : 'text-fg'}>{f.value}</dd>
              </div>
            ))}
          </dl>
          {rec ? (
            <div className="border-b border-ink-100 px-4 py-3">
              <p className="text-sm text-fg">{rec.text}</p>
              <p className="mt-1 text-xs text-ink-600">
                Routed to {rec.routed_to}{rec.deliver_to ? <> · deliver to {rec.deliver_to}</> : null}
              </p>
            </div>
          ) : null}
          {data.orders_waiting?.length ? (
            <ul className="border-b border-ink-100 px-4 py-2.5 text-xs text-ink-700">
              {data.orders_waiting.slice(0, 4).map((o) => (
                <li key={`${o.sales_order_id}-${o.due_date}`}>
                  <Link to={`/sales/sales-orders/${o.sales_order_id}`} className="bos-link">{o.so_number}</Link> · {o.customer_name} · {o.quantity} due {o.due_date}{o.short ? <> · <span className="text-risk-700">after the run-out</span></> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {data.proposals?.length ? (
            <div className="border-b border-ink-100 px-4 py-3">
              <p className="label-mono mb-1.5">Simeli proposes · you decide</p>
              <ul className="space-y-1.5">
                {po ? <PurchaseOrder p={po} rec={rec} itemId={inventoryItemId} /> : null}
                {data.proposals.filter((p) => p.kind !== 'purchase_order').map((p) => (
                  <li key={p.label} className="flex items-start justify-between gap-3 rounded-md border border-ink-200 px-3 py-2 text-sm">
                    <span className="min-w-0 text-ink-800">{p.label}</span>
                    <Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => ask(`${p.label}. Help me act on this; draft anything for my approval.`)}>Ask Simeli</Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="px-4 py-2.5 text-2xs text-ink-500">Read: {data.read.map((r) => r.call).join(' · ')}</p>
        </>
      )}
    </Card>
  )
}
