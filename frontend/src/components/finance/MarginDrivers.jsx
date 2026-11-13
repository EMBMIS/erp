import { Link } from 'react-router-dom'
import { SparklesIcon } from '@heroicons/react/20/solid'

import api from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { useShell } from '../shell/ShellContext'
import { Card, Badge, Button, ErrorState, SkeletonRows, Money } from '../ui'

/**
 * What is hurting the margin, and why.
 *
 * The same answer Simeli gives to "what is hurting our margins this month?"
 * (GET /api/finance/margin-drivers, services/marginDrivers.js): gross margin
 * against the trailing three months, and the change split into purchase price,
 * discounting, scrap and mix — each in margin points, with its share and the
 * records it came from. Proposals are proposals: "Prepare the follow-ups" is a
 * person's click here (POST /api/finance/margin-drivers/follow-ups,
 * services/marginFollowUps.js) that drafts each for its owner — the RFQ stays a
 * draft until procurement sends it, the discount rule binds nothing until
 * another manager activates it below, and the quality review waits on the Work
 * Centres screen until production closes it.
 */

const FOLLOW_UP = { rfq: 'RFQ', approval_rule: 'Approval rule', quality_review: 'Quality review' }
const PREPARE_LABEL = { approval_rule: 'Propose rule', quality_review: 'Open review' }

const KIND = {
  purchase_price: 'Purchase price',
  discount: 'Discounting',
  scrap: 'Scrap',
  mix: 'Mix',
}

function recordHref(r) {
  if (!r?.id) return null
  switch (r.type) {
    case 'purchase_order': return `/procurement/purchase-orders/${r.id}`
    case 'supplier': return `/procurement/suppliers/${r.id}`
    case 'work_center': return '/manufacturing/work-centers'
    default: return null
  }
}

function Proposal({ driver, p, onAsk, onPrepare, preparing, prepared }) {
  const draft = useResourceMutation(
    () => api.post('/request-for-quotations', {
      title: p.args.title,
      description: `Proposed by Simeli from the margin analysis: ${driver.name} — ${driver.detail}.`,
      response_deadline: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
      line_items: [{ item_id: p.args.item_id, item_description: driver.evidence?.item?.name || driver.evidence?.item?.code, quantity: p.args.quantity }],
      suppliers: p.args.supplier_ids,
    }),
    { invalidates: [['finance', 'margin-drivers']], successMessage: 'RFQ drafted — procurement sends it' }
  )
  const rfq = draft.data
  const done = prepared?.find((r) => r.label === p.label && r.id)
  return (
    <li className="flex items-start justify-between gap-3 rounded-md border border-ink-200 px-3 py-2 text-sm">
      <span className="min-w-0 text-ink-800">{p.label}</span>
      {p.kind === 'rfq' ? (
        rfq?.id ? (
          <Link to={`/procurement/rfqs/${rfq.id}`} className="bos-link flex-none whitespace-nowrap text-xs">Open {rfq.rfq_number || 'RFQ'} →</Link>
        ) : (
          <Button size="xs" variant="primary" loading={draft.isPending} onClick={() => draft.mutate()}>Draft RFQ</Button>
        )
      ) : PREPARE_LABEL[p.kind] && p.args ? (
        done ? (
          <span className="flex-none whitespace-nowrap text-xs text-ink-600">{done.reference || done.state?.toLowerCase()} · {done.owner}</span>
        ) : (
          <Button size="xs" variant="primary" loading={preparing} onClick={() => onPrepare([p.kind])}>{PREPARE_LABEL[p.kind]}</Button>
        )
      ) : p.where ? (
        <Link to={p.where} className="bos-link flex-none whitespace-nowrap text-xs">Open →</Link>
      ) : (
        <Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => onAsk(`${p.label}. Help me act on this; draft anything for my approval.`)}>Ask Simeli</Button>
      )}
    </li>
  )
}

function Driver({ d, currency, onAsk, ...prepare }) {
  return (
    <li className="border-b border-ink-100 px-4 py-3 last:border-0">
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-fg">{d.name}</span>
            <Badge tone="warn" glyph="triangle">{KIND[d.kind] || d.kind}</Badge>
          </span>
          <span className="mt-0.5 block text-xs text-ink-600">
            {d.detail}
            {(d.records || []).map((r) => {
              const href = recordHref(r)
              return href ? <span key={`${r.type}-${r.id}`}> · <Link to={href} className="bos-link">{r.number}</Link></span> : null
            })}
          </span>
        </span>
        <span className="shrink-0 text-right text-xs text-ink-600">
          <span className="block text-sm font-medium text-fg">{d.points} pts</span>
          <span className="block"><Money amount={d.money} currency={currency} digits={0} /></span>
          {d.share_pct != null ? <span className="block">{d.share_pct}% of the drop</span> : null}
        </span>
      </div>
      {d.proposals?.length ? (
        <div className="mt-2">
          <p className="label-mono mb-1.5">Simeli proposes · you decide</p>
          <ul className="space-y-1.5">
            {d.proposals.map((p) => <Proposal key={p.label} driver={d} p={p} onAsk={onAsk} {...prepare} />)}
          </ul>
        </div>
      ) : null}
    </li>
  )
}

function Prepared({ result }) {
  return (
    <div className="border-b border-ink-100 bg-ink-50 px-4 py-3">
      <p className="label-mono mb-1.5">Follow-ups · drafted</p>
      {result.prepared.length ? (
        <dl className="space-y-1 text-sm">
          {result.prepared.map((r) => (
            <div key={`${r.kind}-${r.label}`} className="flex items-start justify-between gap-3">
              <dt className="flex-none text-ink-600">{FOLLOW_UP[r.kind] || r.kind}</dt>
              <dd className="min-w-0 text-right text-fg">
                {r.open_at && r.id ? <Link to={r.open_at} className="bos-link">{r.reference || r.item || r.work_center}</Link> : (r.reference || r.item || r.work_center)}
                {r.kind === 'approval_rule' && r.max_discount_pct != null ? <> · above {r.max_discount_pct}%{r.routes_to ? ` → ${r.routes_to}` : ''}</> : null}
                {r.kind === 'rfq' && r.suppliers?.length ? <> · {r.suppliers.length} supplier{r.suppliers.length === 1 ? '' : 's'}</> : null}
                <span className="block text-xs text-ink-600">
                  {r.state === 'needs_owner' || r.state === 'failed' ? r.note : `${r.already ? 'Already waiting' : r.state?.toLowerCase()} · ${r.owner}`}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <p className="mt-2 text-xs text-ink-600">{result.summary}</p>
    </div>
  )
}

/** Discount rules waiting for a manager, rules in force, and open quality reviews. */
function Waiting() {
  const { user } = useAuth()
  const canDecide = ['ADMIN', 'MANAGER'].includes(user?.role)
  const { data } = useResource(['finance', 'margin-follow-ups'], ({ signal }) => api.get('/finance/margin-follow-ups', { signal }))
  const decide = useResourceMutation(
    ({ id, decision }) => api.post(`/finance/discount-rules/${id}/decision`, { decision }),
    { invalidates: [['finance', 'margin-follow-ups']], successMessage: 'Decision recorded' }
  )
  const rules = data?.discount_rules || []
  const reviews = data?.quality_reviews || []
  if (!rules.length && !reviews.length) return null
  return (
    <div className="border-t border-ink-100 px-4 py-3">
      <p className="label-mono mb-1.5">Waiting on their owners</p>
      <ul className="space-y-1.5 text-sm">
        {rules.map((r) => (
          <li key={r.id} className="flex items-start justify-between gap-3 rounded-md border border-ink-200 px-3 py-2">
            <span className="min-w-0 text-ink-800">
              {r.item} discounts above {r.max_discount_pct}% → {r.approver || 'the manager who activates it'}
              <span className="block text-xs text-ink-600">
                {r.state === 'ACTIVE' ? 'In force on sales order approval' : `Proposed${r.proposed_by ? ` by ${r.proposed_by}` : ''} · binds nothing until a manager activates it`}
              </span>
            </span>
            {canDecide ? (
              r.state === 'PROPOSED' ? (
                r.proposed_by_id === user?.id ? (
                  <span className="flex-none text-xs text-ink-600">Another manager activates it</span>
                ) : (
                  <span className="flex flex-none gap-1.5">
                    <Button size="xs" variant="primary" loading={decide.isPending} onClick={() => decide.mutate({ id: r.id, decision: 'activate' })}>Activate</Button>
                    <Button size="xs" variant="ghost" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, decision: 'decline' })}>Decline</Button>
                  </span>
                )
              ) : (
                <Button size="xs" variant="ghost" loading={decide.isPending} onClick={() => decide.mutate({ id: r.id, decision: 'retire' })}>Retire</Button>
              )
            ) : <Badge tone={r.state === 'ACTIVE' ? 'ok' : 'warn'}>{r.state === 'ACTIVE' ? 'Active' : 'Proposed'}</Badge>}
          </li>
        ))}
        {reviews.map((q) => (
          <li key={q.id} className="flex items-start justify-between gap-3 rounded-md border border-ink-200 px-3 py-2">
            <span className="min-w-0 text-ink-800">
              {q.reference} · {q.title}
              <span className="block text-xs text-ink-600">Quality review · open with production</span>
            </span>
            <Link to="/manufacturing/work-centers" className="bos-link flex-none whitespace-nowrap text-xs">Open →</Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** For the Finance dashboard. */
export default function MarginDrivers({ className = '' }) {
  const { openSimeli } = useShell()
  const ask = (question) => openSimeli({ question })
  const { data, loading, error, refetch } = useResource(['finance', 'margin-drivers'], ({ signal }) => api.get('/finance/margin-drivers', { signal }))
  const gm = data?.gross_margin
  const drivers = data?.drivers || []
  const draftable = drivers.some((d) => (d.proposals || []).some((p) => FOLLOW_UP[p.kind] && p.args))
  const prepare = useResourceMutation(
    (kinds) => api.post('/finance/margin-drivers/follow-ups', kinds ? { kinds } : {}),
    { invalidates: [['finance', 'margin-follow-ups']], successMessage: 'Follow-ups drafted — each awaits its owner' }
  )
  const prepareProps = { onPrepare: (kinds) => prepare.mutate(kinds), preparing: prepare.isPending, prepared: prepare.data?.prepared }

  return (
    <Card
      title="What is moving the margin"
      description={data ? `Gross margin ${data.period.from} – ${data.period.to} against ${data.baseline.from} – ${data.baseline.to}, from ${gm?.source === 'ledger' ? 'the ledger' : 'sales lines at unit cost'}` : 'Gross margin against the trailing three months, split into causes'}
      className={className}
      padded={false}
      actions={
        <span className="flex gap-1.5">
          {draftable ? <Button size="xs" variant="primary" loading={prepare.isPending} onClick={() => prepare.mutate(null)}>Prepare the follow-ups</Button> : null}
          <Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => ask('What is hurting our margins this month?')}>Ask Simeli</Button>
        </span>
      }
    >
      {error ? (
        <ErrorState compact what="The margin analysis" error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <SkeletonRows rows={3} columns={2} />
      ) : (
        <>
          <p className="border-b border-ink-100 px-4 py-3 text-sm text-fg">
            {data.headline}
            {gm?.current_pct != null && gm?.baseline_pct != null ? (
              <span className="ml-2 text-xs text-ink-600">{gm.current_pct}% now · {gm.baseline_pct}% before</span>
            ) : null}
          </p>
          {prepare.data ? <Prepared result={prepare.data} /> : null}
          {drivers.length ? (
            <ul>{drivers.map((d) => <Driver key={`${d.kind}-${d.name}`} d={d} currency={data.currency} onAsk={ask} {...prepareProps} />)}</ul>
          ) : (
            <p className="px-4 py-3 text-sm text-ink-600">Nothing in purchasing, discounting, production or mix is pulling the margin down.</p>
          )}
          {data.unexplained_pts ? (
            <p className="border-t border-ink-100 px-4 py-2 text-xs text-ink-600">
              {data.unexplained_pts} pts not explained by these causes · {data.coverage.order_lines} order lines, {data.coverage.purchase_lines_read} purchase lines read
            </p>
          ) : null}
          <Waiting />
        </>
      )}
    </Card>
  )
}
