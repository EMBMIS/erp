import { Link } from 'react-router-dom'
import { SparklesIcon } from '@heroicons/react/20/solid'

import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { useShell } from '../shell/ShellContext'
import { Card, Badge, Button, ErrorState, SkeletonRows, Money } from '../ui'

/**
 * Where cash dips in the next 13 weeks, why, and what lifts it.
 *
 * The same answer Simeli gives to "will we have enough cash?" (GET
 * /api/finance/cash-outlook, services/cashOutlook.js): the 13-week forecast
 * with purchase orders not yet billed, orders not yet invoiced and held bills,
 * the low point against the floor (the next payroll), its causes, and
 * proposals each measured at the low point. Sending reminders is a person's
 * click here (POST /api/finance/cash-outlook/reminders); paying on the due
 * date and re-timing a purchase order are for the people who own them.
 */

const VERDICT = {
  covered: { tone: 'ok', label: 'Covered' },
  at_risk: { tone: 'warn', label: 'At risk if customers pay late' },
  under_floor: { tone: 'warn', label: 'Under the floor' },
  short: { tone: 'risk', label: 'Below zero' },
}

function causeHref(c) {
  if (c.record?.type === 'purchase_order' && c.record.id) return `/procurement/purchase-orders/${c.record.id}`
  if (c.kind === 'late_payer' && c.customer_id) return `/sales/customers/${c.customer_id}`
  return null
}

function Proposal({ p, currency, onAsk }) {
  const send = useResourceMutation(
    () => api.post('/finance/cash-outlook/reminders', p.args),
    { invalidates: [['finance', 'cash-outlook']], successMessage: 'Reminders sent — each is on the customer' }
  )
  const result = send.data
  return (
    <li className="flex items-start justify-between gap-3 rounded-md border border-ink-200 px-3 py-2 text-sm">
      <span className="min-w-0 text-ink-800">
        {p.label}
        <span className="block text-xs text-ink-600">
          {p.lifts_low_point_by > 0 ? <>Lifts the low point by <Money amount={p.lifts_low_point_by} currency={currency} digits={0} /> · </> : null}
          {p.would_lower_low_point_by ? <>Would take <Money amount={p.would_lower_low_point_by} currency={currency} digits={0} /> off it · </> : null}
          {p.owner}
          {p.assumption ? ` · ${p.assumption}` : ''}
        </span>
        {result ? <span className="mt-1 block text-xs text-ink-700">{result.message}</span> : null}
      </span>
      {p.kind === 'remind' && p.args ? (
        result ? null : <Button size="xs" variant="primary" loading={send.isPending} onClick={() => send.mutate()}>Send reminders</Button>
      ) : p.where ? (
        <Link to={p.where} className="bos-link flex-none whitespace-nowrap text-xs">Open →</Link>
      ) : (
        <Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => onAsk(`${p.label}. Help me act on this; draft anything for my approval.`)}>Ask Simeli</Button>
      )}
    </li>
  )
}

export default function CashOutlook({ className = '' }) {
  const { openSimeli } = useShell()
  const ask = (question) => openSimeli({ question })
  const { data, loading, error, refetch } = useResource(['finance', 'cash-outlook'], ({ signal }) => api.get('/finance/cash-outlook', { signal }))
  const v = VERDICT[data?.verdict]
  const currency = data?.currency

  return (
    <Card
      title="Where cash dips, and why"
      description={data?.floor ? `Next 13 weeks, with purchase orders not yet billed, orders not yet invoiced and held bills · floor ${data.floor.source === 'next_payroll' ? 'is the next payroll' : 'as set'}` : 'Next 13 weeks, with what is committed but not yet invoiced'}
      className={className}
      padded={false}
      actions={<Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => ask('Will we have enough cash over the next 13 weeks?')}>Ask Simeli</Button>}
    >
      {error ? (
        <ErrorState compact what="The cash outlook" error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <SkeletonRows rows={3} columns={2} />
      ) : (
        <>
          <div className="border-b border-ink-100 px-4 py-3">
            <p className="text-sm text-fg">
              {v ? <Badge tone={v.tone} glyph={v.tone === 'ok' ? undefined : 'triangle'} className="mr-2">{v.label}</Badge> : null}
              {data.headline}
            </p>
            {data.low_point ? (
              <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-600">
                <div><dt className="inline">Low point </dt><dd className="inline font-medium text-fg"><Money amount={data.low_point.p50} currency={currency} digits={0} /></dd> · {data.low_point.date}</div>
                <div><dt className="inline">If customers pay late </dt><dd className="inline font-medium text-fg"><Money amount={data.low_point.p10} currency={currency} digits={0} /></dd></div>
                <div><dt className="inline">Floor </dt><dd className="inline font-medium text-fg"><Money amount={data.floor?.amount} currency={currency} digits={0} /></dd></div>
                {data.lifted_low_point ? <div><dt className="inline">After the proposals </dt><dd className="inline font-medium text-fg"><Money amount={data.lifted_low_point.p50} currency={currency} digits={0} /></dd></div> : null}
              </dl>
            ) : null}
          </div>
          {data.causes?.length && data.verdict !== 'covered' ? (
            <div className="border-b border-ink-100 px-4 py-3">
              <p className="label-mono mb-1.5">What puts it there</p>
              <ul className="space-y-1 text-sm">
                {data.causes.map((c, i) => {
                  const href = causeHref(c)
                  return (
                    <li key={`${c.kind}-${i}`} className="flex items-start justify-between gap-3">
                      <span className="min-w-0 text-ink-800">{href ? <Link to={href} className="bos-link">{c.text}</Link> : c.text}</span>
                      <span className="flex-none text-xs text-ink-600"><Money amount={c.amount} currency={currency} digits={0} /></span>
                    </li>
                  )
                })}
              </ul>
            </div>
          ) : null}
          {data.proposals?.length ? (
            <div className="px-4 py-3">
              <p className="label-mono mb-1.5">Simeli proposes · you decide</p>
              <ul className="space-y-1.5">
                {data.proposals.map((p) => <Proposal key={p.label} p={p} currency={currency} onAsk={ask} />)}
              </ul>
            </div>
          ) : null}
          {data.commitments ? (
            <p className="border-t border-ink-100 px-4 py-2 text-xs text-ink-600">
              Included: {data.commitments.purchase_orders} purchase order{data.commitments.purchase_orders === 1 ? '' : 's'} not yet billed (<Money amount={data.commitments.purchase_orders_value} currency={currency} digits={0} />),{' '}
              {data.commitments.sales_orders} order{data.commitments.sales_orders === 1 ? '' : 's'} not yet invoiced (<Money amount={data.commitments.sales_orders_value} currency={currency} digits={0} />)
              {data.commitments.held_bills?.length ? `, ${data.commitments.held_bills.length} held bill${data.commitments.held_bills.length === 1 ? '' : 's'} left out` : ''}
            </p>
          ) : null}
        </>
      )}
    </Card>
  )
}
