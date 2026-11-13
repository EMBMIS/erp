import React, { useState } from 'react'
import { ArrowPathIcon, ChartBarIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import DynamicChart from '../../components/ai/DynamicChart'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, Card, Stat, Money, Num, LineChart, BarChart, Distribution, AiAnswer,
  InlineNotice, ErrorState, Input, MaturityBadge, Provenance, DataTable, Badge, formatMoney, DateText,
} from '../../components/ui'

const money0 = (v) => formatMoney(v, 'USD', 0)
const isNum = (v) => v != null && v !== '' && Number.isFinite(Number(v))

/** A figure from the metrics block, or "—" when the server returned none. */
function Fig({ value, money = false, method }) {
  if (!isNum(value)) return '—'
  const body = money ? <Money amount={Number(value)} digits={0} muted={false} /> : <Num value={Number(value)} />
  return method ? <Provenance method={method} sources={[{ label: 'GET /ai-insights/business-insights' }]}>{body}</Provenance> : body
}

const PRIORITY_TONE = { HIGH: 'risk', MEDIUM: 'warn', LOW: 'ink' }

/**
 * Business intelligence — counted metrics and charts from the ledger, plus,
 * when a language model is connected, Simeli's written reading of them.
 *
 * The two never mix: the backend tags fallback results `ai_unavailable` and
 * returns a `note` when no model is configured, and this screen then shows the
 * counted figures only, with the note in words.
 */
export default function BusinessIntelligence() {
  const [chartQuestion, setChartQuestion] = useState('')
  const [dynamicCharts, setDynamicCharts] = useState([])
  const [chartError, setChartError] = useState(null)

  // Both endpoints answer flat ({ success, businessInsights, ... }) with no
  // nested `data`, so each fetcher re-wraps the body before unwrap() sees it.
  const { data, loading: insightsLoading, error: insightsError, refetch: refetchInsights, isFetching } = useResource(
    keys.businessInsights(),
    // _retry:true opts out of the axios interceptor's retry-with-backoff, and
    // retry:1 caps React Query, so a hung upstream surfaces in seconds.
    ({ signal }) => api.get('/ai-insights/business-insights', { signal, _retry: true })
      .then((res) => ({ data: { success: true, data: res.data } })),
    { retry: 1 },
  )
  const { data: charts, loading: chartsLoading, refetch: refetchCharts } = useResource(
    keys.businessCharts(),
    ({ signal }) => api.get('/ai-insights/charts', { signal })
      .then((res) => ({ data: { success: true, data: res.data } }))
      .catch(() => ({ data: { success: true, data: null } })),
  )
  const loading = insightsLoading || chartsLoading
  const load = () => { refetchInsights(); refetchCharts() }

  const askChart = useResourceMutation(
    (question) => api.post('/ai-insights/query-chart', { question }),
    { silent: true },
  )

  const handleChartQuestion = async (e) => {
    e.preventDefault()
    const q = chartQuestion.trim()
    if (!q || askChart.isPending) return
    setChartError(null)
    try {
      const spec = await askChart.mutateAsync(q)
      if (spec) {
        setDynamicCharts((prev) => [spec, ...prev])
        setChartQuestion('')
      }
    } catch (err) {
      setChartError(err.response?.data?.error || err.message || 'Could not draw that chart.')
    }
  }

  const metrics = data?.enterpriseMetrics || {}
  const insights = data?.businessInsights || {}
  const aiUnavailable = Boolean(insights.ai_unavailable)
  const aiNote = data?.note || (aiUnavailable
    ? 'The language model could not write insights (down, rate-limited or misconfigured). Showing counted business metrics only.'
    : null)
  const health = insights.business_health_score
  const insightsAvailable = !aiUnavailable && health != null

  const revenuePoints = (charts?.revenue_trend || []).map((r) => ({ x: r.month, y: Number(r.revenue) || 0 }))
  const expensePoints = (charts?.revenue_trend || []).map((r) => ({ x: r.month, y: Number(r.expenses) || 0 }))
  const aging = (charts?.ar_aging || []).map((r) => ({ x: r.bucket, y: Number(r.amount) || 0 }))
  const categories = (charts?.top_revenue_categories || []).map((r) => ({ label: r.category, value: Number(r.value) || 0 }))

  const lists = insightsAvailable ? [
    ['Strategic opportunities', insights.strategic_opportunities],
    ['Operational risks', insights.operational_risks],
    ['Financial recommendations', insights.financial_recommendations],
    ['Growth strategies', insights.growth_strategies],
  ].filter(([, items]) => Array.isArray(items) && items.length) : []
  const asText = (item) => (typeof item === 'string' ? item : JSON.stringify(item))

  return (
    <div className="space-y-5">
      <PageHeader
        title="Business intelligence"
        badge={<MaturityBadge level="beta" />}
        description="Counted figures and trends across sales, purchasing, stock and receivables."
        meta={data?.generatedAt ? <span>Read <DateText value={data.generatedAt} withTime /></span> : null}
        secondary={<Button icon={ArrowPathIcon} onClick={load} loading={isFetching && !loading}>Refresh</Button>}
      />

      {insightsError && (
        <ErrorState error={insightsError} what="Business intelligence" onRetry={load} />
      )}

      {aiNote && (
        <InlineNotice tone="warn" title="Written insights are not available">{aiNote}</InlineNotice>
      )}

      {!insightsError && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat loading={loading && !data} label="Revenue, 90 days" value={<Fig money value={metrics.sales?.revenue} method="Sum of sales order totals in the last 90 days." />} reason={isNum(metrics.sales?.total_orders) ? `${Number(metrics.sales.total_orders).toLocaleString()} orders` : null} />
            <Stat loading={loading && !data} label="Purchase spend, 90 days" value={<Fig money value={metrics.procurement?.total_spend} method="Sum of purchase order totals in the last 90 days." />} reason={isNum(metrics.procurement?.total_pos) ? `${Number(metrics.procurement.total_pos).toLocaleString()} purchase orders` : null} />
            <Stat loading={loading && !data} label="Stock items" value={<Fig value={metrics.inventory?.total_items} method="Inventory items on record." />} reason={isNum(metrics.inventory?.low_stock_items) ? `${Number(metrics.inventory.low_stock_items).toLocaleString()} below reorder point` : null} />
            <Stat loading={loading && !data} label="Suppliers" value={<Fig value={metrics.suppliers?.total_suppliers} method="Suppliers on record." />} reason={isNum(metrics.suppliers?.certified_suppliers) ? `${Number(metrics.suppliers.certified_suppliers).toLocaleString()} certified` : null} />
          </div>

          {charts && (
            <div className="grid items-start gap-4 lg:grid-cols-3">
              <Card title="Revenue, last 12 months" className="lg:col-span-2">
                {revenuePoints.length ? (
                  <>
                    <LineChart points={revenuePoints} format={money0} title="Revenue by month" />
                    {expensePoints.some((p) => p.y) && (
                      <div className="mt-4">
                        <p className="label-mono mb-1">Expenses</p>
                        <LineChart points={expensePoints} format={money0} height={140} title="Expenses by month" />
                      </div>
                    )}
                  </>
                ) : <p className="py-4 text-sm text-ink-500">No posted revenue in the last 12 months.</p>}
              </Card>
              <div className="space-y-4">
                <Card title="Receivables by age">
                  <BarChart points={aging} format={money0} title="Receivables by age" emptyText="Nothing is outstanding." />
                </Card>
                <Card title="Top revenue categories">
                  <Distribution items={categories} format={money0} emptyText="No categorised revenue yet." />
                </Card>
              </div>
            </div>
          )}

          <Card title="Chart a question" description="Simeli turns a plain question into a chart from your records. Needs a connected language model.">
            <form onSubmit={handleChartQuestion} className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={chartQuestion}
                onChange={(e) => setChartQuestion(e.target.value)}
                placeholder="Revenue by customer this quarter"
                aria-label="Question to chart"
                size="lg"
                className="flex-1"
                disabled={askChart.isPending}
              />
              <Button type="submit" size="lg" icon={ChartBarIcon} loading={askChart.isPending} disabled={!chartQuestion.trim()}>
                Chart it
              </Button>
            </form>
            {chartError && <InlineNotice tone="risk" className="mt-3" title="No chart was drawn">{chartError}</InlineNotice>}
            {dynamicCharts.length > 0 && (
              <div className="mt-4 space-y-4">
                {dynamicCharts.map((spec, i) => <DynamicChart key={i} chart_spec={spec} />)}
              </div>
            )}
          </Card>

          {insightsAvailable && (
            <>
              <AiAnswer
                title="Simeli's reading of the business"
                read={[
                  { label: 'Sales orders, 90 days' },
                  { label: 'Purchase orders, 90 days' },
                  { label: 'Inventory' },
                  { label: 'Suppliers' },
                  { label: 'Receivables' },
                ]}
                concluded={[
                  <span key="h">Health score <span className="font-semibold tabular-nums text-fg">{health}</span><span className="text-ink-500"> / 100</span> — a judgement by the model, not a measured figure.</span>,
                  ...(insights.key_insights || []).map(asText),
                ]}
              />
              {lists.length > 0 && (
                <div className="grid gap-4 md:grid-cols-2">
                  {lists.map(([title, items]) => (
                    <Card key={title} title={title}>
                      <ul className="space-y-1.5 text-sm text-ink-800">
                        {items.map((it, i) => <li key={i} className="flex gap-2"><span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 rounded-full bg-ink-400" />{asText(it)}</li>)}
                      </ul>
                    </Card>
                  ))}
                </div>
              )}
              {Array.isArray(insights.action_plan) && insights.action_plan.length > 0 && (
                <DataTable
                  viewKey="ai.business-intelligence.actions"
                  caption="Suggested actions"
                  noun="suggestion"
                  search={false}
                  rows={insights.action_plan}
                  columns={[
                    { id: 'priority', header: 'Priority', accessor: 'priority', width: 110, mobile: 'meta', cell: (a) => (a.priority ? <Badge tone={PRIORITY_TONE[a.priority] || 'ink'}>{String(a.priority).toLowerCase()}</Badge> : '—') },
                    { id: 'task', header: 'Suggestion', accessor: (a) => a.task || a.action, mobile: 'title', cell: (a) => a.task || a.action || '—' },
                    { id: 'timeline', header: 'Timeline', accessor: 'timeline', width: 140, cell: (a) => a.timeline || '—' },
                    { id: 'impact', header: 'Expected impact', accessor: 'expected_impact', mobile: 'subtitle', cell: (a) => a.expected_impact || '—' },
                  ]}
                />
              )}
              <p className="text-2xs text-ink-500">Suggestions are written by the model. Nothing here runs on its own; act on them from the records themselves.</p>
            </>
          )}
        </>
      )}
    </div>
  )
}
