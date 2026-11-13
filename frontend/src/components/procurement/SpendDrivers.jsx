import { Link } from 'react-router-dom'
import { SparklesIcon } from '@heroicons/react/20/solid'

import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { useShell } from '../shell/ShellContext'
import { Card, Badge, Button, ErrorState, SkeletonRows, Money } from '../ui'

/**
 * Why spending moved, supplier by supplier.
 *
 * The same answer Simeli gives to "why are our costs up?" (GET
 * /api/purchase-orders/spend-drivers, services/spendDrivers.js): what was
 * committed to suppliers this period against the usual pace of the three
 * months before, split into the suppliers who moved it — an item's price (and
 * the contract it breaks), more units (and the customer orders behind them),
 * bills with no purchase order, new suppliers — with who raised, approved and
 * asked for the orders. Finance roles also see the expense accounts that
 * moved. "Prepare the follow-ups" is a person's click (POST
 * /api/purchase-orders/spend-drivers/follow-ups) that drafts re-quotes for
 * procurement and asks the owners; nothing is sent to a supplier.
 */

const KIND = {
  up: ['Costing more', 'warn'],
  new: ['New supplier', 'risk'],
  down: ['Costing less', 'ok'],
  stopped: ['Nothing now', 'ok'],
}

function recordHref(r) {
  if (!r?.id) return null
  switch (r.type) {
    case 'supplier': return `/procurement/suppliers/${r.id}`
    case 'purchase_order': return `/procurement/purchase-orders/${r.id}`
    case 'supplier_invoice': return `/finance/supplier-invoices?invoice=${r.id}`
    case 'contract': return `/procurement/contracts/${r.id}`
    case 'sales_order': return `/sales/sales-orders/${r.id}`
    default: return null
  }
}

function Driver({ d, currency, onAsk, onPrepare, preparing, prepared }) {
  const [label, tone] = KIND[d.kind] || [d.kind, 'ink']
  const done = (prepared || []).filter((r) => r.supplier_id === d.supplier.id)
  const doneFor = (p) => done.find((r) => r.label === p.label)
  return (
    <li className="border-b border-ink-100 px-4 py-3 last:border-0">
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            {d.supplier.id ? <Link to={`/procurement/suppliers/${d.supplier.id}`} className="text-sm font-medium text-fg hover:underline">{d.name}</Link> : <span className="text-sm font-medium text-fg">{d.name}</span>}
            <Badge tone={tone}>{label}</Badge>
            {d.owner ? <span className="text-xs text-ink-500">{d.owner.name}</span> : null}
          </span>
          <span className="mt-0.5 block text-xs text-ink-600">
            {d.detail}
            {(d.records || []).filter((r) => r.type !== 'supplier').map((r) => {
              const href = recordHref(r)
              return href ? <span key={`${r.type}-${r.id}`}> · <Link to={href} className="bos-link">{r.number}</Link></span> : null
            })}
          </span>
        </span>
        <span className="shrink-0 text-right text-xs text-ink-600">
          <span className="block text-sm font-medium text-fg"><Money amount={d.money} currency={currency} digits={0} /></span>
          {d.change_pct != null ? <span className="block">{d.change_pct > 0 ? '+' : ''}{d.change_pct}% on pace</span> : null}
          {d.share_pct != null ? <span className="block">{d.share_pct}% of the rise</span> : null}
        </span>
      </div>
      {d.proposals?.length ? (
        <div className="mt-2">
          <p className="label-mono mb-1.5">Simeli proposes · you decide</p>
          <ul className="space-y-1.5">
            {d.proposals.map((p) => {
              const r = doneFor(p)
              return (
                <li key={p.label} className="flex items-start justify-between gap-3 rounded-md border border-ink-200 px-3 py-2 text-sm">
                  <span className="min-w-0 text-ink-800">{p.label}</span>
                  {r ? (
                    r.open_at ? (
                      <Link to={r.open_at} className="bos-link flex-none whitespace-nowrap text-xs">{r.already ? 'Already drafted' : 'Drafted'} · {r.reference} →</Link>
                    ) : (
                      <span className="flex-none whitespace-nowrap text-xs text-ink-600">{r.state === 'ASKED' ? `${r.already ? 'Already asked' : 'Asked'} · ${r.owner}` : r.note || r.state}</span>
                    )
                  ) : p.kind === 'rfq' || p.kind === 'ask_owner' ? (
                    <Button size="xs" variant="primary" loading={preparing} onClick={() => onPrepare([d.supplier.id])}>{p.kind === 'rfq' ? 'Draft the re-quote' : 'Ask them'}</Button>
                  ) : p.where ? (
                    <Link to={p.where} className="bos-link flex-none whitespace-nowrap text-xs">Open →</Link>
                  ) : (
                    <Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => onAsk(`${p.label}. Help me act on this.`)}>Ask Simeli</Button>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </li>
  )
}

/** For the Procurement overview and Payables. */
export default function SpendDrivers({ className = '' }) {
  const { openSimeli } = useShell()
  const ask = (question) => openSimeli({ question })
  const { data, loading, error, refetch } = useResource(['procurement', 'spend-drivers'], ({ signal }) => api.get('/purchase-orders/spend-drivers', { signal }))
  const drivers = data?.drivers || []
  const helping = data?.helping || []
  const actionable = drivers.some((d) => (d.proposals || []).some((p) => p.kind === 'rfq' || p.kind === 'ask_owner'))
  const prepare = useResourceMutation(
    (supplierIds) => api.post('/purchase-orders/spend-drivers/follow-ups', supplierIds ? { supplier_ids: supplierIds } : {}),
    { successMessage: 'Follow-ups prepared, each waiting on its owner' }
  )
  const prepared = prepare.data?.prepared
  const b = data?.bridge
  const ledger = data?.ledger

  return (
    <Card
      title="Why spending moved"
      description={data ? `Committed ${data.period.from} – ${data.period.to} against the pace of ${data.baseline.from} – ${data.baseline.to}${data.scope === 'company' ? '' : ' · your spend'}` : 'Spend against its usual pace, split into the suppliers who moved it'}
      className={className}
      padded={false}
      actions={
        <span className="flex gap-1.5">
          {actionable ? <Button size="xs" variant="primary" loading={prepare.isPending} onClick={() => prepare.mutate(null)}>Prepare the follow-ups</Button> : null}
          <Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => ask('Why are our costs up this month?')}>Ask Simeli</Button>
        </span>
      }
    >
      {error ? (
        <ErrorState compact what="The spend analysis" error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <SkeletonRows rows={3} columns={2} />
      ) : (
        <>
          <p className="border-b border-ink-100 px-4 py-3 text-sm text-fg">{data.headline}</p>
          {b && data.spend?.at_pace > 0 ? (
            <p className="border-b border-ink-100 px-4 py-2 text-xs text-ink-600">
              Price <Money amount={b.price} currency={data.currency} digits={0} /> · Volume <Money amount={b.volume} currency={data.currency} digits={0} /> · No purchase order <Money amount={b.off_po} currency={data.currency} digits={0} /> · New suppliers <Money amount={b.new_suppliers} currency={data.currency} digits={0} /> · Nothing now <Money amount={b.stopped} currency={data.currency} digits={0} />
            </p>
          ) : null}
          {prepare.data ? <p className="border-b border-ink-100 bg-ink-50 px-4 py-2 text-xs text-ink-700">{prepare.data.summary}</p> : null}
          {drivers.length ? (
            <ul>{drivers.map((d) => <Driver key={d.supplier.id || d.name} d={d} currency={data.currency} onAsk={ask} onPrepare={(ids) => prepare.mutate(ids)} preparing={prepare.isPending} prepared={prepared} />)}</ul>
          ) : (
            <p className="px-4 py-3 text-sm text-ink-600">No supplier is costing more than their usual pace.</p>
          )}
          {ledger?.accounts_up?.length ? (
            <div className="border-t border-ink-100 px-4 py-3">
              <p className="label-mono mb-1.5">In the ledger</p>
              <ul className="space-y-1 text-xs text-ink-600">
                {ledger.accounts_up.map((a) => (
                  <li key={a.account.id}>
                    {a.detail}
                    {a.largest_entry ? <> · largest entry <Link to="/finance/journal-entries" className="bos-link">{a.largest_entry.number}</Link></> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {helping.length ? (
            <div className="border-t border-ink-100">
              <p className="label-mono px-4 pt-3">Pulling the other way</p>
              <ul>{helping.map((d) => <Driver key={d.supplier.id || d.name} d={d} currency={data.currency} onAsk={ask} onPrepare={() => {}} prepared={prepared} />)}</ul>
            </div>
          ) : null}
        </>
      )}
    </Card>
  )
}
