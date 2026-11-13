import { useEffect, useState } from 'react'
import api from '../../services/api'
import { AiAnswer } from '../ui'

/**
 * ApprovalBrief — what an approver needs to know, short and factual.
 *
 * GET /ai-intelligence/approval-brief/:type/:id returns the facts it read
 * (price history with this supplier, delivery record, customer credit) and,
 * when a language model is configured, a written summary. The facts are shown
 * either way; the written summary only when it really exists — "AI brief
 * unavailable" from the server is not presented as a finding.
 *
 * @param {{ type: 'purchase_order'|'supplier_invoice'|'sales_order', id: string }} props
 */
export default function ApprovalBrief({ type, id }) {
  const [state, setState] = useState({ loading: false, brief: null, error: null })

  useEffect(() => {
    if (!type || !id) return undefined
    let cancelled = false
    setState({ loading: true, brief: null, error: null })
    api.get(`/ai-intelligence/approval-brief/${type}/${id}`)
      .then((res) => { if (!cancelled) setState({ loading: false, brief: res.data?.data || null, error: null }) })
      .catch((e) => { if (!cancelled) setState({ loading: false, brief: null, error: e?.response?.data?.error || 'The brief could not be prepared.' }) })
    return () => { cancelled = true }
  }, [type, id])

  if (!type || !id) return null
  const { loading, brief, error } = state
  const ctx = brief?.context || {}
  const read = []
  const concluded = []
  if (ctx.document?.number) read.push({ label: ctx.document.number })
  if (ctx.price_history) {
    read.push({ label: `${ctx.price_history.past_orders || 0} past orders` })
    if (Number(ctx.price_history.past_orders)) concluded.push(`Average unit price from this supplier over 12 months: ${ctx.price_history.avg_price}.`)
  }
  if (ctx.delivery) {
    read.push({ label: 'delivery record' })
    if (Number(ctx.delivery.total_pos)) concluded.push(`${ctx.delivery.on_time} of ${ctx.delivery.total_pos} earlier orders from this supplier arrived on time.`)
  }
  if (ctx.credit && ctx.credit.limit > 0) {
    read.push({ label: 'credit position' })
    concluded.push(`Customer credit: ${Number(ctx.credit.balance).toLocaleString()} used of ${Number(ctx.credit.limit).toLocaleString()}.`)
  }
  if (ctx.payment_history) concluded.push(`${ctx.payment_history.paid_on_time} of ${ctx.payment_history.total_invoices} invoices paid on time; ${ctx.payment_history.avg_days_to_pay || '?'} days on average.`)
  for (const a of brief?.alerts || []) concluded.unshift(a)
  const summary = brief?.summary && !/unavailable/i.test(brief.summary) ? brief.summary : null
  if (summary) concluded.unshift(summary)

  return (
    <AiAnswer
      compact
      title="What to know before deciding"
      loading={loading}
      error={error}
      read={read}
      concluded={concluded}
      footnote={summary ? 'Written by Simeli from the records listed. It read only what your role can see.' : 'Facts from the records listed. A written summary was not available for this one.'}
    />
  )
}
