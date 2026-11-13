import { Link } from 'react-router-dom'
import { SparklesIcon } from '@heroicons/react/20/solid'

import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { useShell } from '../shell/ShellContext'
import { Card, Badge, Button, ErrorState, SkeletonRows, Money } from '../ui'

/**
 * Why sales moved, customer by customer.
 *
 * The same answer Simeli gives to "why are sales down?" (GET
 * /api/sales-orders/revenue-drivers, services/revenueDrivers.js): sales booked
 * this period against the usual pace of the three months before, split into the
 * customers who moved it — lapsed against their own rhythm, buying less (volume
 * or price), new or growing — each with what the record says about them: lost
 * and open quotations, a credit hold, overdue invoices, a delivery issue, and
 * who owns the account. "Prepare the calls" is a person's click (POST
 * /api/sales-orders/revenue-drivers/follow-ups) that puts a follow-up call on
 * each owner's CRM list; nothing is sent to a customer.
 */

const KIND = {
  lapsed: ['Lapsed', 'risk'],
  down: ['Buying less', 'warn'],
  new: ['New', 'ok'],
  up: ['Buying more', 'ok'],
}

function recordHref(r) {
  if (!r?.id) return null
  switch (r.type) {
    case 'customer': return `/sales/customers/${r.id}`
    case 'sales_order': return `/sales/sales-orders/${r.id}`
    case 'sales_quotation': return `/sales/quotations/${r.id}`
    default: return null
  }
}

function Driver({ d, currency, onAsk, onPrepare, preparing, prepared }) {
  const [label, tone] = KIND[d.kind] || [d.kind, 'ink']
  const done = prepared?.find((r) => r.customer_id === d.customer.id)
  return (
    <li className="border-b border-ink-100 px-4 py-3 last:border-0">
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <Link to={`/sales/customers/${d.customer.id}`} className="text-sm font-medium text-fg hover:underline">{d.name}</Link>
            <Badge tone={tone}>{label}</Badge>
            {d.owner ? <span className="text-xs text-ink-500">{d.owner.name}</span> : null}
          </span>
          <span className="mt-0.5 block text-xs text-ink-600">
            {d.detail}
            {(d.records || []).filter((r) => r.type !== 'customer').map((r) => {
              const href = recordHref(r)
              return href ? <span key={`${r.type}-${r.id}`}> · <Link to={href} className="bos-link">{r.number}</Link></span> : null
            })}
          </span>
        </span>
        <span className="shrink-0 text-right text-xs text-ink-600">
          <span className="block text-sm font-medium text-fg"><Money amount={d.money} currency={currency} digits={0} /></span>
          {d.change_pct != null ? <span className="block">{d.change_pct > 0 ? '+' : ''}{d.change_pct}% on pace</span> : null}
          {d.share_pct != null ? <span className="block">{d.share_pct}% of the fall</span> : null}
        </span>
      </div>
      {d.proposals?.length ? (
        <div className="mt-2">
          <p className="label-mono mb-1.5">Simeli proposes · you decide</p>
          <ul className="space-y-1.5">
            {d.proposals.map((p) => (
              <li key={p.label} className="flex items-start justify-between gap-3 rounded-md border border-ink-200 px-3 py-2 text-sm">
                <span className="min-w-0 text-ink-800">{p.label}</span>
                {p.kind === 'follow_up' ? (
                  done ? (
                    <Link to="/crm/activities" className="bos-link flex-none whitespace-nowrap text-xs">{done.already ? 'Already waiting' : 'On the list'} · due {done.due_date} →</Link>
                  ) : (
                    <Button size="xs" variant="primary" loading={preparing} onClick={() => onPrepare([d.customer.id])}>Prepare the call</Button>
                  )
                ) : p.where ? (
                  <Link to={p.where} className="bos-link flex-none whitespace-nowrap text-xs">Open →</Link>
                ) : (
                  <Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => onAsk(`${p.label}. Help me act on this.`)}>Ask Simeli</Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  )
}

/** For the Sales overview. */
export default function RevenueDrivers({ className = '' }) {
  const { openSimeli } = useShell()
  const ask = (question) => openSimeli({ question })
  const { data, loading, error, refetch } = useResource(['sales', 'revenue-drivers'], ({ signal }) => api.get('/sales-orders/revenue-drivers', { signal }))
  const drivers = data?.drivers || []
  const helping = data?.helping || []
  const callable = drivers.some((d) => (d.proposals || []).some((p) => p.kind === 'follow_up'))
  const prepare = useResourceMutation(
    (customerIds) => api.post('/sales-orders/revenue-drivers/follow-ups', customerIds ? { customer_ids: customerIds } : {}),
    { successMessage: 'Calls on their owners’ follow-up lists' }
  )
  const prepared = prepare.data?.prepared
  const b = data?.bridge

  return (
    <Card
      title="Why sales moved"
      description={data ? `Booked ${data.period.from} – ${data.period.to} against the pace of ${data.baseline.from} – ${data.baseline.to}${data.scope === 'company' ? '' : ' · your book'}` : 'Sales against their usual pace, split into the customers who moved them'}
      className={className}
      padded={false}
      actions={
        <span className="flex gap-1.5">
          {callable ? <Button size="xs" variant="primary" loading={prepare.isPending} onClick={() => prepare.mutate(null)}>Prepare the calls</Button> : null}
          <Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => ask('Why are sales down this month?')}>Ask Simeli</Button>
        </span>
      }
    >
      {error ? (
        <ErrorState compact what="The sales analysis" error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <SkeletonRows rows={3} columns={2} />
      ) : (
        <>
          <p className="border-b border-ink-100 px-4 py-3 text-sm text-fg">{data.headline}</p>
          {b && data.sales?.at_pace > 0 ? (
            <p className="border-b border-ink-100 px-4 py-2 text-xs text-ink-600">
              No order now <Money amount={b.no_order_now} currency={data.currency} digits={0} /> · New customers <Money amount={b.new_customers} currency={data.currency} digits={0} /> · Volume <Money amount={b.volume} currency={data.currency} digits={0} /> · Price <Money amount={b.price} currency={data.currency} digits={0} />
            </p>
          ) : null}
          {prepare.data ? <p className="border-b border-ink-100 bg-ink-50 px-4 py-2 text-xs text-ink-700">{prepare.data.summary}</p> : null}
          {drivers.length ? (
            <ul>{drivers.map((d) => <Driver key={d.customer.id} d={d} currency={data.currency} onAsk={ask} onPrepare={(ids) => prepare.mutate(ids)} preparing={prepare.isPending} prepared={prepared} />)}</ul>
          ) : (
            <p className="px-4 py-3 text-sm text-ink-600">No customer is below their usual pace.</p>
          )}
          {helping.length ? (
            <div className="border-t border-ink-100">
              <p className="label-mono px-4 pt-3">Pulling the other way</p>
              <ul>{helping.map((d) => <Driver key={d.customer.id} d={d} currency={data.currency} onAsk={ask} onPrepare={() => {}} prepared={prepared} />)}</ul>
            </div>
          ) : null}
        </>
      )}
    </Card>
  )
}
