import { Link } from 'react-router-dom'
import { SparklesIcon } from '@heroicons/react/20/solid'

import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { useShell } from '../shell/ShellContext'
import { Card, Badge, Button, ErrorState, SkeletonRows, Money } from '../ui'

/**
 * What we did the last times this supplier was late, and whether it worked.
 *
 * The same answer Simeli gives to "<supplier> is late again. What did we do
 * last time?" (GET /api/supplier-risk/precedent, services/supplierMemory.js):
 * each late delivery, what was bought next and from whom, how it turned out,
 * then today's late order and the split that repeats what worked. Drafting the
 * split order is a person's click here; it stays a DRAFT until it passes
 * purchase approval, and the late order still carries its full quantity.
 */

const TONE = { ok: 'ok', warn: 'warn', risk: 'risk', ink: 'ink' }
const GLYPH = { ok: 'check', warn: 'triangle', risk: 'triangle' }

function recordHref(r) {
  if (!r?.id) return null
  if (r.type === 'purchase_order') return `/procurement/purchase-orders/${r.id}`
  if (r.type === 'sales_order') return `/sales/sales-orders/${r.id}`
  return null
}

function SplitOrder({ p, rec, supplierId }) {
  const draft = useResourceMutation(
    () => api.post('/purchase-orders', {
      supplier_id: p.args.supplier_id,
      currency: p.args.currency,
      delivery_date: p.args.expected_delivery_date || undefined,
      status: 'DRAFT',
      line_items: p.args.items.map((i) => ({ item_id: i.item_id, item_description: i.description, quantity: i.quantity, unit_price: i.unit_price })),
    }),
    { invalidates: [['supplier-precedent', supplierId]], successMessage: `Split order drafted — it goes through approval; reduce ${rec?.against?.number || 'the late order'} once it is approved` }
  )
  const po = draft.data
  return (
    <li className="flex items-start justify-between gap-3 rounded-md border border-ink-200 px-3 py-2 text-sm">
      <span className="min-w-0 text-ink-800">{p.label}</span>
      {po?.id ? (
        <Link to={`/procurement/purchase-orders/${po.id}`} className="bos-link flex-none whitespace-nowrap text-xs">Open {po.po_number || 'draft'} →</Link>
      ) : p.can_draft ? (
        <Button size="xs" variant="primary" loading={draft.isPending} onClick={() => draft.mutate()}>Draft the split order</Button>
      ) : (
        <span className="flex-none text-xs text-ink-600">Procurement drafts it</span>
      )}
    </li>
  )
}

/** For the supplier screen. */
export default function SupplierPrecedent({ supplierId, name, className = '' }) {
  const { openSimeli } = useShell()
  const ask = (question) => openSimeli({ question })
  const { data, loading, error, refetch } = useResource(
    ['supplier-precedent', supplierId],
    ({ signal }) => api.get('/supplier-risk/precedent', { params: { supplier_id: supplierId }, signal }),
    { enabled: !!supplierId, retry: false }
  )
  const rec = data?.recommendation
  const split = (data?.proposals || []).find((p) => p.kind === 'split_order')

  return (
    <Card
      title="What we did last time"
      description={data ? `${data.record.late_last_year} of ${data.record.orders_last_year} orders late in twelve months` : 'Late deliveries, what was done, and whether it worked'}
      className={className}
      padded={false}
      actions={<Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => ask(`${name} is late again. What did we do last time?`)}>Ask Simeli</Button>}
    >
      {error ? (
        <ErrorState compact what="The supplier's history" error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <SkeletonRows rows={3} columns={1} />
      ) : (
        <>
          <p className="border-b border-ink-100 px-4 py-3 text-sm text-fg">{data.headline}</p>
          {data.timeline?.length ? (
            <ol>
              {data.timeline.map((t) => {
                const href = recordHref(t.record)
                return (
                  <li key={`${t.when}-${t.record?.id}`} className="flex items-start gap-3 border-b border-ink-100 px-4 py-2.5 last:border-0">
                    <span className="w-20 flex-none pt-0.5 text-xs text-ink-600">{t.when}</span>
                    <span className="min-w-0 text-sm text-ink-800">
                      <Badge tone={TONE[t.tone] || 'ink'} glyph={GLYPH[t.tone]}>{t.tone === 'ok' ? 'Worked' : t.tone === 'warn' ? 'Cost us' : t.tone === 'risk' ? 'Now' : 'Noted'}</Badge>{' '}
                      {t.text}
                      {href ? <> · <Link to={href} className="bos-link">{t.record.number}</Link></> : null}
                    </span>
                  </li>
                )
              })}
            </ol>
          ) : null}
          {rec ? (
            <div className="border-t border-ink-100 px-4 py-3">
              <p className="text-sm text-fg">{rec.text}</p>
              <p className="mt-1 text-xs text-ink-600">
                {rec.quantity} × <Money amount={rec.unit_price} currency={data.currency} /> against <Money amount={rec.current_unit_price} currency={data.currency} /> on {rec.against.number}
                {rec.precedent ? <> · precedent <Link to={recordHref(rec.precedent)} className="bos-link">{rec.precedent.number}</Link></> : null}
              </p>
            </div>
          ) : null}
          {data.proposals?.length ? (
            <div className="border-t border-ink-100 px-4 py-3">
              <p className="label-mono mb-1.5">Simeli proposes · you decide</p>
              <ul className="space-y-1.5">
                {split ? <SplitOrder p={split} rec={rec} supplierId={supplierId} /> : null}
                {data.proposals.filter((p) => p.kind !== 'split_order').map((p) => (
                  <li key={p.label} className="flex items-start justify-between gap-3 rounded-md border border-ink-200 px-3 py-2 text-sm">
                    <span className="min-w-0 text-ink-800">{p.label}</span>
                    <Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => ask(`${p.label}. Help me act on this; draft anything for my approval.`)}>Ask Simeli</Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </Card>
  )
}
