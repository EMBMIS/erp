import { Link } from 'react-router-dom'
import { SparklesIcon } from '@heroicons/react/20/solid'

import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { useShell } from '../shell/ShellContext'
import { Card, Badge, Button, ErrorState, SkeletonRows, Money } from '../ui'

/**
 * Which steps actually move.
 *
 * The same answer Simeli gives to "where do our orders get stuck?"
 * (GET /api/process-flow, services/processFlow.js): each step of order to cash
 * or procure to pay, how long it usually takes, whether it has slowed, what is
 * waiting in it and which documents are stuck — past the step's own normal
 * time or past the date they promised. Read-only; each proposal goes to Simeli,
 * which drafts or previews for a person.
 */

const STATUS = {
  stuck: { tone: 'risk', glyph: 'triangle', label: 'Stuck' },
  slower: { tone: 'warn', glyph: 'triangle', label: 'Slower' },
  moving: { tone: 'ok', glyph: 'check', label: 'Moves' },
  idle: { tone: 'ink', glyph: null, label: 'No data' },
}

const HREF = {
  sales_quotation: (id) => `/sales/quotations/${id}`,
  sales_order: (id) => `/sales/sales-orders/${id}`,
  customer_invoice: () => '/finance/customer-invoices',
  purchase_requisition: (id) => `/procurement/purchase-requisitions/${id}`,
  purchase_order: (id) => `/procurement/purchase-orders/${id}`,
  supplier_invoice: () => '/finance/supplier-invoices',
}

const d = (v) => (v == null ? '—' : v < 1 ? '<1 d' : `${v} d`)

/** flow: 'order_to_cash' | 'procure_to_pay' */
export default function ProcessFlow({ flow, className = '' }) {
  const { openSimeli } = useShell()
  const ask = (question) => openSimeli({ question })
  const { data, loading, error, refetch } = useResource(
    ['process-flow', flow],
    ({ signal }) => api.get('/process-flow', { params: { flow }, signal }),
    { retry: false }
  )
  const f = data?.flows?.[0]
  const question = flow === 'procure_to_pay' ? 'What is holding up purchasing? Which steps actually move?' : 'Where do our orders get stuck between quote and cash?'

  return (
    <Card
      title="Which steps actually move"
      description={data ? `${f?.label || ''} · finished documents, last ${data.window_days} days${data.scope === 'yours' ? ' · documents you raised' : ''}` : 'Every step timed from the documents themselves'}
      className={className}
      padded={false}
      actions={<Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => ask(question)}>Ask Simeli</Button>}
    >
      {error ? (
        <ErrorState compact what="The process flow" error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <SkeletonRows rows={5} columns={3} />
      ) : f ? (
        <>
          <p className="border-b border-ink-100 px-4 py-3 text-sm text-fg">{f.headline}</p>
          <table className="w-full text-sm">
            <caption className="sr-only">{f.label}, step by step</caption>
            <thead>
              <tr className="border-b border-ink-200 text-left">
                <th scope="col" className="label-mono px-4 py-2 font-normal">Step</th>
                <th scope="col" className="label-mono px-2 py-2 text-right font-normal">Usually</th>
                <th scope="col" className="label-mono px-2 py-2 text-right font-normal">Waiting</th>
                <th scope="col" className="label-mono px-4 py-2 text-right font-normal">Stuck</th>
              </tr>
            </thead>
            <tbody>
              {f.steps.map((s) => {
                const st = STATUS[s.status] || STATUS.idle
                return (
                  <tr key={s.key} className={`border-b border-ink-100 last:border-0 ${s.key === f.bottleneck ? 'bg-ink-50' : ''}`}>
                    <td className="px-4 py-2.5">
                      <span className="block text-ink-800">{s.label}</span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-600">
                        <Badge tone={st.tone} glyph={st.glyph}>{st.label}</Badge>
                        {s.trend === 'slower' ? `was ${d(s.finished.prior_median_days)}` : s.trend === 'faster' ? `faster, was ${d(s.finished.prior_median_days)}` : `${s.finished.count} finished`}
                        {' · waits on '}{s.waits_on}
                      </span>
                    </td>
                    <td className="px-2 py-2.5 text-right tabular-nums text-ink-800" title={s.finished.p80_days != null ? `80% within ${s.finished.p80_days} days` : undefined}>{d(s.finished.median_days)}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums text-ink-800">{s.waiting.count || '—'}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {s.stuck.count ? (
                        <span className="text-risk-600">{s.stuck.count} · <Money amount={s.stuck.value} currency={data.currency} digits={0} /></span>
                      ) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {(() => {
            const b = f.steps.find((s) => s.key === f.bottleneck)
            if (!b?.stuck.documents.length) return null
            return (
              <div className="border-t border-ink-100 px-4 py-3">
                <p className="label-mono mb-1.5">Stuck at “{b.label}”</p>
                <ul className="space-y-1">
                  {b.stuck.documents.map((doc) => (
                    <li key={doc.id} className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="min-w-0 text-ink-800">
                        {HREF[doc.type] ? <Link to={HREF[doc.type](doc.id)} className="bos-link">{doc.number}</Link> : doc.number}
                        {doc.party ? <span className="text-ink-600"> · {doc.party}</span> : null}
                        <span className="block text-xs text-ink-600">{doc.why}</span>
                      </span>
                      <span className="flex-none tabular-nums text-ink-800"><Money amount={doc.value} currency={doc.currency || data.currency} digits={0} /></span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })()}
          {f.proposals?.length ? (
            <div className="border-t border-ink-100 px-4 py-3">
              <p className="label-mono mb-1.5">Simeli proposes · you decide</p>
              <ul className="space-y-1.5">
                {f.proposals.map((p) => (
                  <li key={p.step} className="flex items-start justify-between gap-3 rounded-md border border-ink-200 px-3 py-2 text-sm">
                    <span className="min-w-0 text-ink-800">{p.label}</span>
                    <Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => ask(`${p.label} (${p.documents.map((x) => x.number).filter(Boolean).join(', ')}). Use ${p.tool}; draft anything for my approval.`)}>Ask Simeli</Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </Card>
  )
}
