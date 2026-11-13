import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircleIcon, SparklesIcon, TruckIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'

import api from '../../services/api'

/**
 * Deliveries at risk, and the path to why.
 *
 * The same trace Simeli answers "why are we going to miss Friday's delivery?"
 * from (GET /api/delivery-risk, services/deliveryRisk.js on the server): each
 * order comes back with a verdict, a projected date, and the chain of causes
 * from the shop floor or the supplier to the customer — every step naming the
 * record it was read from. Nothing here changes anything; the proposals are
 * handed to Simeli, which drafts them for a person to approve.
 *
 * Under a late order sits the recovery: the fixes Simeli measured by re-running
 * the same trace with each one assumed (GET /api/delivery-risk/recovery,
 * services/deliveryRecovery.js). A manager approves one here, and only then
 * does anything change.
 *
 * Where the order ships from is set here too (ShipFrom). With a site, the
 * trace counts only stock placed there, so stock sitting at another site shows
 * as what it is — a transfer away — and the recovery offers that transfer,
 * weighed against the customer's late-delivery penalty.
 */

const LAYER = {
  operations: { label: 'Operations', tone: '#34d399' },
  production: { label: 'Production', tone: '#f97316' },
  inventory: { label: 'Inventory', tone: '#6366f1' },
  suppliers: { label: 'Suppliers', tone: '#ec4899' },
  data: { label: 'Dependency', tone: '#38bdf8' },
  finance: { label: 'Cost', tone: '#eab308' },
  decisions: { label: 'Order', tone: '#f59e0b' },
}

const VERDICT = {
  uncovered: { label: 'No supply', accent: 'rose' },
  late: { label: 'Late', accent: 'rose' },
  at_risk: { label: 'At risk', accent: 'amber' },
  unknown_item: { label: 'Unmatched item', accent: 'amber' },
  on_track: { label: 'On track', accent: 'green' },
  covered: { label: 'In stock', accent: 'green' },
}

const ask = (q) => `/ai/chat?q=${encodeURIComponent(q)}`

function recordHref(r) {
  if (!r?.id) return null
  switch (r.type) {
    case 'sales_order': return `/sales/sales-orders/${r.id}`
    case 'purchase_order': return `/procurement/purchase-orders/${r.id}`
    case 'work_order': return '/manufacturing/work-orders'
    case 'work_center': return '/manufacturing/work-centers'
    case 'supplier': return `/procurement/suppliers/${r.id}`
    case 'item': return `/inventory/items/${r.id}`
    case 'customer': return `/sales/customers/${r.id}`
    case 'inventory_transfer': return '/warehouse/transfers'
    default: return null
  }
}

function money(value, cur) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD', maximumFractionDigits: 0 }).format(value || 0)
  } catch {
    return `${Math.round(value || 0).toLocaleString()} ${cur || ''}`
  }
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

export function useDeliveryRisk(params) {
  const key = JSON.stringify(params || {})
  const [state, setState] = useState({ loading: true, data: null, error: null })
  useEffect(() => {
    let live = true
    setState((s) => ({ ...s, loading: true }))
    api.get('/delivery-risk', { params })
      .then((r) => live && setState({ loading: false, data: r.data?.data || null, error: null }))
      .catch((e) => live && setState({
        loading: false,
        data: null,
        error: e?.response?.status === 403 ? 'Not available for your role.' : (e?.response?.data?.error || 'Could not trace deliveries.'),
      }))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return state
}

/** The path, drawn as a path: one step per layer the cause travelled through. */
export function DeliveryChain({ chain }) {
  return (
    <ol className="mt-2">
      {chain.map((step, i) => {
        const layer = LAYER[step.layer] || LAYER.decisions
        const href = recordHref(step.record)
        return (
          <li key={`${step.layer}-${i}`} className="relative flex gap-3 pb-3 last:pb-0">
            {i < chain.length - 1 && (
              <span className="absolute left-[3px] top-3 h-full w-px" style={{ background: 'color-mix(in srgb, currentColor 18%, transparent)' }} />
            )}
            <span className="relative mt-1.5 h-[7px] w-[7px] flex-none rounded-full" style={{ background: layer.tone, boxShadow: `0 0 8px 1px ${layer.tone}` }} />
            <span className="min-w-0">
              <span className="block text-[10px] font-semibold uppercase tracking-wider" style={{ color: layer.tone }}>{layer.label}</span>
              <span className="block text-[13px] leading-snug">
                {step.text}
                {href && step.record?.number ? (
                  <> · <Link to={href} className="bos-link">{step.record.number}</Link></>
                ) : null}
              </span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function Proposals({ order }) {
  if (!order.proposals?.length) return null
  return (
    <div className="mt-3">
      <span className="block text-[10px] font-semibold uppercase tracking-wider bos-text-faint">Simeli proposes · you decide</span>
      <ul className="mt-1.5 flex flex-col gap-1.5">
        {order.proposals.map((p) => (
          <li key={p.label} className="flex items-start justify-between gap-3 text-[13px]">
            <span className="min-w-0">{p.label}</span>
            <Link
              to={ask(p.tool
                ? `${p.label} (for ${order.so_number}) — draft it for my approval.`
                : `Help me with this for ${order.so_number}: ${p.label}.`)}
              className="bos-link flex-none whitespace-nowrap"
            >
              {p.tool ? 'Draft →' : 'Ask Simeli →'}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

const NEEDS_RECOVERY = new Set(['late', 'uncovered', 'at_risk'])

/** What a slip costs under the customer's terms, in one phrase. */
export function penaltyText(order) {
  const p = order?.penalty
  if (!p) return null
  if (p.amount) return `${money(p.amount, order.currency)} late penalty`
  if (order.verdict === 'at_risk' && p.if_late) return `${money(p.if_late, order.currency)} penalty if it slips`
  return null
}

/** Where an open order is picked from. Changing it re-traces the order. */
export function ShipFrom({ order, onChanged }) {
  const [sites, setSites] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    api.get('/delivery-risk/sites')
      .then((r) => live && setSites(r.data?.data || []))
      .catch(() => live && setSites([]))
    return () => { live = false }
  }, [])
  if (!sites || (!sites.length && !order.ship_from)) return null
  const change = async (e) => {
    setBusy(true)
    try {
      const r = await api.put('/delivery-risk/ship-from', { sales_order_id: order.sales_order_id, storage_location_id: e.target.value || null })
      toast.success(r.data?.message || 'Updated.')
      onChanged?.()
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not change where the order ships from.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <label className="flex flex-wrap items-center gap-2 text-[13px]">
      <span className="bos-text-faint">Ships from</span>
      <select value={order.ship_from?.id || ''} onChange={change} disabled={busy} className="rounded border border-gray-300 bg-transparent px-2 py-0.5 text-[13px]">
        <option value="">Any site (stock counted company-wide)</option>
        {sites.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
      </select>
    </label>
  )
}

/** "Simeli has the fix ready; it needs one person to approve it." */
export function RecoveryPlans({ order, onApproved }) {
  const [state, setState] = useState({ loading: true, data: null, error: null })
  const [busy, setBusy] = useState(null)
  const [done, setDone] = useState(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    setState((s) => ({ ...s, loading: true }))
    api.get('/delivery-risk/recovery', { params: { sales_order_id: order.sales_order_id } })
      .then((r) => live && setState({ loading: false, data: r.data?.data || null, error: null }))
      .catch((e) => live && setState({ loading: false, data: null, error: e?.response?.data?.error || 'Could not plan a recovery.' }))
    return () => { live = false }
  }, [order.sales_order_id, tick])

  const approve = async (plan) => {
    if (!window.confirm(`Approve this plan for ${order.so_number}?\n\n${plan.label}\n\n${plan.effect.summary}`)) return
    setBusy(plan.id)
    try {
      const r = await api.post('/delivery-risk/recovery/approve', { sales_order_id: order.sales_order_id, plan_id: plan.id })
      setDone(r.data?.data || null)
      toast.success(r.data?.message || 'Plan carried out.')
      setTick((t) => t + 1)
      onApproved?.()
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Could not carry out the plan.')
      setTick((t) => t + 1)
    } finally {
      setBusy(null)
    }
  }

  const { loading, data, error } = state
  const plans = data?.plans || []
  return (
    <div className="mt-3">
      <span className="block text-[10px] font-semibold uppercase tracking-wider bos-text-faint">Simeli has a fix ready · a manager approves</span>
      {done ? (
        <p className="mt-1.5 flex items-start gap-1.5 text-[13px]">
          <CheckCircleIcon className="mt-0.5 h-4 w-4 flex-none text-emerald-500" />
          <span>
            {done.done} {done.effect?.summary}
            {done.records?.map((r) => (
              <span key={r.id}> · <Link to={recordHref(r)} className="bos-link">{r.number}</Link></span>
            ))}
            <span className="block bos-caption">{done.next_step}</span>
          </span>
        </p>
      ) : null}
      {error ? (
        <p className="mt-1.5 bos-caption">{error}</p>
      ) : loading && !data ? (
        <p className="mt-1.5 bos-caption">Measuring each possible fix against the trace…</p>
      ) : !plans.length ? (
        done ? null : <p className="mt-1.5 bos-caption">{data?.note || 'No fix available from current records.'}</p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-2">
          {plans.slice(0, 3).map((p) => (
            <li key={p.id} className="text-[13px]">
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className={`bos-chip bos-accent-${p.effect.holds ? 'green' : 'amber'} mr-1.5`}>
                    {p.effect.holds ? `Holds · ships ${fmtDate(p.effect.projected_after)}` : `${p.effect.days_saved || 0}d earlier`}
                  </span>
                  {p.label}
                </span>
                {data.can_approve ? (
                  <button type="button" disabled={!!busy} onClick={() => approve(p)} className="bos-link flex-none whitespace-nowrap disabled:opacity-50">
                    {busy === p.id ? 'Carrying out…' : 'Approve →'}
                  </button>
                ) : null}
              </div>
              <span className="mt-0.5 block bos-caption">
                {p.effect.summary}{p.cost ? ` Cost ${money(p.cost, p.currency)}.` : ''} {p.evidence}
              </span>
            </li>
          ))}
        </ul>
      )}
      {data && !data.can_approve && plans.length ? <p className="mt-1.5 bos-caption">{data.approval}</p> : null}
      <Link to={ask(`What can we do so ${order.so_number} for ${order.customer_name} still ships on time?`)} className="bos-link mt-2 inline-flex items-center gap-1 text-[13px]">
        <SparklesIcon className="h-3.5 w-3.5" /> Ask Simeli for the fix
      </Link>
    </div>
  )
}

/** One order's outlook, for the sales order screen. */
export function DeliveryOutlook({ salesOrderId }) {
  const { loading, data, error } = useDeliveryRisk({ sales_order_id: salesOrderId })
  const order = data?.orders?.[0]
  const v = order ? (VERDICT[order.verdict] || VERDICT.at_risk) : null

  return (
    <div className="bg-white shadow rounded-lg">
      <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between gap-3">
        <h3 className="text-lg font-medium text-gray-900 flex items-center">
          <TruckIcon className="h-5 w-5 mr-2" />
          Delivery outlook
        </h3>
        {v ? <span className={`bos-chip bos-accent-${v.accent}`}>{v.label}{order.days_late ? ` +${order.days_late}d` : ''}</span> : null}
      </div>
      <div className="px-6 py-4 text-gray-900">
        {error ? (
          <p className="text-sm text-gray-500">{error}</p>
        ) : loading ? (
          <p className="text-sm text-gray-500">Tracing stock, production and supply…</p>
        ) : !order ? (
          <p className="text-sm text-gray-500">{data?.note || 'Nothing open on this order to trace.'}</p>
        ) : (
          <>
            <p className="text-sm">
              Promised {fmtDate(order.due_date)}
              {order.projected_date ? ` · projected ${fmtDate(order.projected_date)}` : order.verdict === 'uncovered' ? ' · no date possible from current supply' : ''}
              {order.value_at_risk ? ` · ${money(order.value_at_risk, order.currency)} at risk` : ''}
              {penaltyText(order) ? ` · ${penaltyText(order)}` : ''}
            </p>
            {order.chain.length ? <DeliveryChain chain={order.chain} /> : (
              <p className="mt-2 text-sm text-gray-500">Every line is covered by stock or by supply that lands in time.</p>
            )}
            <Proposals order={order} />
            {NEEDS_RECOVERY.has(order.verdict) ? <RecoveryPlans order={order} /> : null}
            <Link
              to={ask(`Why is ${order.so_number} for ${order.customer_name} ${order.verdict === 'covered' || order.verdict === 'on_track' ? 'on track' : 'going to be late'}, and what can we do?`)}
              className="mt-3 inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-500"
            >
              <SparklesIcon className="h-4 w-4" /> Ask Simeli why
            </Link>
          </>
        )}
      </div>
    </div>
  )
}
