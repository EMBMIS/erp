import React, { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ClockIcon, ScaleIcon, SparklesIcon } from '@heroicons/react/24/outline'

import api from '../../services/api'
import Module, { ModuleEmpty } from '../bos/Module'

/**
 * Decisions held open: what is waiting on a person, what it is worth, and what
 * it is holding up.
 *
 * The same answer Simeli gives to "what should I approve first?" (GET
 * /api/decisions-held-open, services/decisionsHeldOpen.js on the server). Every
 * pending approval is walked through the delivery trace to the customer orders
 * that depend on it, and ranked by what it holds — so the first row is the
 * decision that is costing the most by waiting. Nothing here decides anything:
 * each one is made on its own approval screen, where DoA limits, approval
 * chains and segregation of duties apply.
 */

/** Approval Inbox tab for each kind of decision. */
export const INBOX_TAB = {
  purchase_order: 'purchase-orders',
  sales_order: 'sales-orders',
  purchase_requisition: 'purchase-requisitions',
  contract: 'contracts',
}

const ask = (q) => `/ai/chat?q=${encodeURIComponent(q)}`

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

const VERDICT = {
  uncovered: { label: 'No supply', accent: 'rose' },
  late: { label: 'Late', accent: 'rose' },
  at_risk: { label: 'At risk', accent: 'amber' },
  unknown_item: { label: 'Unmatched item', accent: 'amber' },
  on_track: { label: 'On track', accent: 'green' },
  covered: { label: 'In stock', accent: 'green' },
  awaiting_approval: { label: 'Awaiting approval', accent: 'amber' },
}

export function useDecisionsHeldOpen(params, { enabled = true } = {}) {
  const key = JSON.stringify(params || {})
  const [tick, setTick] = useState(0)
  const [state, setState] = useState({ loading: true, data: null, error: null })
  useEffect(() => {
    if (!enabled) return undefined
    let live = true
    setState((s) => ({ ...s, loading: true }))
    api.get('/decisions-held-open', { params })
      .then((r) => live && setState({ loading: false, data: r.data?.data || null, error: null }))
      .catch((e) => live && setState({ loading: false, data: null, error: e?.response?.data?.error || 'Could not read pending decisions.' }))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick, enabled])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { ...state, reload }
}

/** The four numbers: awaiting a person, made this week, escalated, exposure held open. */
function Summary({ summary }) {
  const cells = [
    { value: summary.awaiting, label: 'Awaiting a person', sub: summary.yours ? `${summary.yours} yours to decide` : null },
    { value: summary.made_this_week, label: 'Made this week' },
    { value: summary.escalated, label: 'Escalated', sub: 'over 3 days, or by an agent' },
    { value: money(summary.exposure_held_open, summary.currency), label: 'Exposure held open', sub: summary.orders_held ? `${summary.orders_held} customer order${summary.orders_held === 1 ? '' : 's'}` : null },
  ]
  return (
    <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {cells.map((c) => (
        <div key={c.label}>
          <span className="block font-display text-[19px] font-bold tabular-nums bos-text-strong">{c.value}</span>
          <span className="block text-[11px] font-semibold uppercase tracking-wider bos-text-faint">{c.label}</span>
          {c.sub ? <span className="block bos-caption">{c.sub}</span> : null}
        </div>
      ))}
    </div>
  )
}

/** The customer orders one decision holds up, each with its verdict. */
export function HeldOrders({ decision }) {
  if (!decision.holding_up?.length) {
    return (
      <p className="bos-caption">
        {decision.holding_up_outside_your_view
          ? `${decision.holding_up_outside_your_view} customer order${decision.holding_up_outside_your_view === 1 ? '' : 's'} outside your view depend on it.`
          : 'No customer order due in the next 60 days depends on it.'}
      </p>
    )
  }
  return (
    <ul className="flex flex-col gap-1">
      {decision.holding_up.map((h) => {
        const v = VERDICT[h.verdict] || VERDICT.at_risk
        return (
          <li key={h.sales_order_id} className="flex items-start justify-between gap-3 text-[13px]">
            <span className="min-w-0">
              <Link to={`/sales/sales-orders/${h.sales_order_id}`} className="bos-link">{h.so_number}</Link>
              {' · '}{h.customer_name}
              <span className={`bos-chip bos-accent-${v.accent} ml-1.5`}>{v.label}</span>
              {h.uncovered ? <span className="block bos-caption">{h.uncovered} units with nothing on order</span> : null}
            </span>
            <span className="flex-none text-right bos-caption">
              <span className="block">Due {fmtDate(h.due_date)}</span>
              <span className="block">{money(h.value, h.currency)}</span>
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function DecisionRow({ d, onOpen }) {
  const accent = d.approval_keeps_dates || d.escalated ? 'rose' : d.held_value ? 'amber' : 'blue'
  const tab = INBOX_TAB[d.kind]
  const decide = d.yours_to_decide
    ? (onOpen && tab
      ? <button type="button" onClick={() => onOpen(d)} className="bos-link whitespace-nowrap">Decide →</button>
      : <Link to={d.decide_at} className="bos-link whitespace-nowrap">Decide →</Link>)
    : <span className="bos-caption whitespace-nowrap">Waiting on {d.waiting_on}</span>
  return (
    <li className={`bos-row bos-accent-${accent} flex-col !items-stretch`}>
      <div className="flex w-full items-start gap-2.5">
        <span className="bos-plate bos-plate--sm"><ScaleIcon className="h-3.5 w-3.5" /></span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium bos-text">{d.number}{d.party ? ` · ${d.party}` : ''}</span>
            <span className="bos-chip">{d.kind_label}</span>
            {d.approval_keeps_dates ? <span className="bos-chip bos-accent-green">Approval keeps the date</span> : null}
            {d.escalated ? <span className="bos-chip bos-accent-rose">Escalated</span> : null}
          </span>
          <span className="mt-0.5 block text-[13px] leading-snug">{d.reason}</span>
          <span className="mt-0.5 flex items-center gap-1 bos-caption">
            <ClockIcon className="h-3.5 w-3.5" />
            {d.value ? `${money(d.value, d.currency)} · ` : ''}waiting {d.waiting_for || '—'} on {d.waiting_on}
          </span>
        </span>
        <span className="flex flex-none flex-col items-end gap-1 text-right">
          {d.held_value ? <span className="text-[13px] font-semibold tabular-nums bos-text-strong">{money(d.held_value, d.currency)} held</span> : null}
          {decide}
          <Link to={ask(`What is ${d.number} holding up, and should I approve it?`)} className="bos-link inline-flex items-center gap-1 text-[12px] whitespace-nowrap">
            <SparklesIcon className="h-3 w-3" /> Ask Simeli
          </Link>
        </span>
      </div>
    </li>
  )
}

/**
 * The panel: the four numbers, then the decisions ranked by what they hold.
 * `state` lets a screen that already fetched pass its data in; `onOpen` lets
 * the Approval Inbox open the row in place instead of navigating.
 */
export default function DecisionsHeldOpenModule({ state, onOpen, limit = 5, mine = false, className = '' }) {
  const own = useDecisionsHeldOpen(mine ? { mine: 1 } : undefined, { enabled: !state })
  const { loading, data, error } = state || own
  const decisions = data?.decisions || []

  return (
    <Module
      title="Decisions held open"
      accent="amber"
      ticks
      className={className}
      action={
        <Link to={ask('What is waiting on a decision, what is each worth, and what is it holding up?')} className="bos-link">
          Ask Simeli
        </Link>
      }
    >
      {error ? (
        <ModuleEmpty>{error}</ModuleEmpty>
      ) : loading && !data ? (
        <ModuleEmpty>Walking each pending decision to what it holds up…</ModuleEmpty>
      ) : !data ? null : (
        <>
          <Summary summary={data.summary} />
          {decisions.length === 0 ? (
            <ModuleEmpty>Nothing is waiting on a decision.</ModuleEmpty>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {decisions.slice(0, limit).map((d) => <DecisionRow key={`${d.kind}:${d.id}`} d={d} onOpen={onOpen} />)}
            </ul>
          )}
          {decisions.length > limit ? (
            <p className="mt-2 bos-caption">{decisions.length - limit} more, holding less.</p>
          ) : null}
        </>
      )}
    </Module>
  )
}
