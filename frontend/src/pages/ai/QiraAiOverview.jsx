import React, { Suspense, lazy, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Cog6ToothIcon, PaperAirplaneIcon, SparklesIcon } from '@heroicons/react/20/solid'

import api, { simeliAPI } from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { count, humanize } from '../../utils/format'
import {
  PageHeader, Button, Card, Stat, Sparkline, Distribution, AiAnswer, Provenance, StatusBadge,
  InlineNotice, ErrorState, EmptyState, Textarea, SkeletonRows, DateText, relativeTime, Badge,
} from '../../components/ui'

// Canvas-only, but a sizeable module: it loads after the figures.
const QiraSymbiote = lazy(() => import('../../components/qira/QiraSymbiote'))

/**
 * Prompts Simeli can answer with the read tools it has. A suggestion that
 * produces "I have no tool for that" teaches people the product does not work.
 */
const QUICK_PROMPTS = [
  'What is outstanding on receivables right now?',
  'Which stock items are below their reorder point?',
  'Show me the open findings by severity',
]

const SEVERITY_TONE = { CRITICAL: 'risk', HIGH: 'risk', MEDIUM: 'warn', LOW: 'ink' }

/**
 * Simeli — the module overview.
 *
 * Every figure here is counted from the table that holds it (ai_findings,
 * agent_runs, agent definitions, the knowledge base) by
 * GET /ai-analytics/overview. Where a table is missing or the endpoint fails,
 * the figure is "—" with the reason, never a placeholder number.
 */
export default function QiraAiOverview() {
  const navigate = useNavigate()
  const [question, setQuestion] = useState('')
  const [hover, setHover] = useState(false)

  const overview = useResource(
    ['simeli-overview', 12],
    () => simeliAPI.overview(12),
    { retry: false },
  )
  // Optional: a role that may not read AI settings still gets every figure,
  // with the tool reach showing as unavailable.
  const { data: aiSettings } = useResource(
    keys.aiSettings(),
    ({ signal }) => api.get('/ai-settings', { signal }),
    { retry: false },
  )

  const a = overview.data || {}
  const insights = a.insights
  const automation = a.automation
  const agents = a.agents
  const knowledge = a.knowledge
  const recentRuns = a.recent_runs || []
  const topFinding = a.top_finding || null
  const noModel = aiSettings && aiSettings.ai_enabled === false

  const findingSeries = (a.series || []).map((row) => Number(row.insights) || 0)
  const runSeries = (a.series || []).map((row) => Number(row.runs) || 0)
  const months = (a.series || []).length

  const byEntity = (insights?.by_entity || [])
    .filter((r) => Number(r.n) > 0)
    .map((r) => ({ label: humanize(r.entity_type), value: Number(r.n), to: '/ai/findings' }))

  const reach = Object.entries(aiSettings?.tool_breakdown || {})
    .sort((x, y) => y[1] - x[1])
    .map(([label, value]) => ({ label, value }))

  const ask = (text) => {
    const q = String(text ?? question).trim()
    if (!q) return
    navigate(`/ai/chat?q=${encodeURIComponent(q)}`)
  }

  const unavailable = overview.error ? 'Not counted — see the error above.' : null
  const stats = [
    {
      label: 'Findings raised',
      value: insights ? count(insights.total) : '—',
      reason: insights ? (insights.this_month != null ? `${count(insights.this_month)} this month` : null) : (unavailable || 'The findings table is not in this deployment.'),
      series: findingSeries,
      method: 'Rows in ai_findings, all statuses.',
      to: '/ai/findings',
    },
    {
      label: 'Open findings',
      value: insights ? count(insights.open) : '—',
      reason: insights ? `${count(insights.acknowledged)} acknowledged · ${count(insights.dismissed)} dismissed` : (unavailable || 'The findings table is not in this deployment.'),
      series: [],
      method: 'Findings not yet acknowledged or dismissed.',
      to: '/ai/findings',
    },
    {
      label: 'Agent runs',
      value: automation ? count(automation.runs) : '—',
      reason: automation
        ? (automation.success_rate != null ? `${Math.round(automation.success_rate * 100)}% succeeded · ${count(automation.failed)} failed` : 'None has finished yet.')
        : (unavailable || 'The agent runtime is not installed here.'),
      series: runSeries,
      method: 'Rows in agent_runs, any outcome. Succeeded share is succeeded ÷ all runs.',
      to: '/agents',
    },
    {
      label: 'Agents enabled',
      value: agents ? count(agents.enabled) : '—',
      reason: agents ? `of ${count(agents.total)} defined` : (unavailable || 'The agent runtime is not installed here.'),
      series: [],
      method: 'Agent definitions switched on, out of all defined.',
      to: '/agents',
    },
  ]

  const symbioteState = overview.loading ? 'thinking' : hover ? 'listening' : 'idle'

  return (
    <div className="space-y-5">
      <PageHeader
        title="Simeli"
        description="What Simeli has found, what its agents have run, and what it can read. Click a figure to see how it is counted."
        secondary={<Button to="/ai/settings" icon={Cog6ToothIcon}>Settings</Button>}
        primary={<Button variant="primary" to="/ai/chat" icon={SparklesIcon}>Ask Simeli</Button>}
      />

      {noModel && (
        <InlineNotice
          tone="warn"
          title="No language model is connected"
          action={<Button size="sm" to="/ai/settings">AI settings</Button>}
        >
          Findings, agent runs and the knowledge base below still work. Asking Simeli a question needs an
          OpenAI, Anthropic or OpenRouter key on the server; until one is added, questions fail rather than
          being answered from guesses.
        </InlineNotice>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        {/* Simeli's presence: the symbiote, calm, and one way in — a question. */}
        <section
          aria-label="Ask Simeli"
          className="flex flex-col rounded-lg border border-ink-200 bg-surface"
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
        >
          <div className="relative mx-auto h-[150px] w-full max-w-[260px] sm:h-[180px]" aria-hidden="true">
            <Suspense fallback={null}>
              <QiraSymbiote state={symbioteState} />
            </Suspense>
          </div>
          <form
            className="space-y-2 px-4 pb-4"
            onSubmit={(e) => { e.preventDefault(); ask() }}
          >
            <label htmlFor="simeli-overview-ask" className="text-sm font-medium text-fg">Ask about your business</label>
            <Textarea
              id="simeli-overview-ask"
              rows={2}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); ask() } }}
              placeholder="Which customers are past due?"
              className="text-base sm:text-sm"
            />
            <div className="flex justify-end">
              <Button type="submit" variant="secondary" icon={PaperAirplaneIcon} disabled={!question.trim()}>Ask</Button>
            </div>
            <ul className="space-y-1 pt-1" aria-label="Suggested questions">
              {QUICK_PROMPTS.map((p) => (
                <li key={p}>
                  <button
                    type="button"
                    onClick={() => ask(p)}
                    className="w-full rounded-md px-2 py-2 text-left text-sm text-ink-700 hover:bg-ink-100 hover:text-fg"
                  >
                    {p}
                  </button>
                </li>
              ))}
            </ul>
          </form>
        </section>

        <div className="min-w-0 space-y-4">
          {overview.error && (
            <ErrorState error={overview.error} what="Simeli's figures" onRetry={() => overview.refetch()} compact />
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {stats.map((s) => (
              <Stat
                key={s.label}
                label={s.label}
                loading={overview.loading}
                value={s.value === '—' ? '—' : (
                  <Provenance method={s.method} sources={[{ label: 'Open the records', to: s.to }]}>{s.value}</Provenance>
                )}
                delta={s.series.length > 1 ? <Sparkline values={s.series} label={`${s.label}, last ${months} months`} /> : null}
                reason={s.reason}
              />
            ))}
          </div>

          {/* The highest-severity open finding, as Simeli raised it. */}
          {!overview.loading && !overview.error && (
            topFinding ? (
              <AiAnswer
                title="Highest open finding"
                read={[
                  topFinding.entity_type && { label: humanize(topFinding.entity_type), to: '/ai/findings' },
                  { label: 'ai_findings', to: '/ai/findings', detail: 'Open findings, ordered by severity' },
                ].filter(Boolean)}
                concluded={[
                  <span key="t">
                    <span className="font-medium text-fg">{topFinding.title}</span>
                    {topFinding.severity && <Badge tone={SEVERITY_TONE[String(topFinding.severity).toUpperCase()] || 'ink'} className="ml-2">{String(topFinding.severity).toLowerCase()}</Badge>}
                  </span>,
                  topFinding.description,
                  topFinding.created_at && <span key="d" className="text-ink-500">Raised {relativeTime(topFinding.created_at)}</span>,
                ].filter(Boolean)}
                proposes={[{
                  id: 'review',
                  title: 'Review it with the evidence',
                  detail: 'Opens the findings list, where you acknowledge, dismiss or act on it. Nothing changes until you do.',
                  actionLabel: 'Open findings',
                  to: '/ai/findings',
                }]}
              />
            ) : (
              <Card title="Highest open finding">
                <p className="text-sm text-ink-600">
                  {insights ? 'No findings are open. Simeli raises them as its scans run.' : 'The findings table is not in this deployment.'}
                </p>
              </Card>
            )
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Recent agent runs" description="Newest first" actions={<Link to="/agents" className="text-xs text-brand-600 hover:underline">All agents</Link>} className="lg:col-span-2" padded={false}>
          {overview.loading ? (
            <SkeletonRows rows={4} columns={3} className="p-4" />
          ) : overview.error ? (
            <p className="px-4 py-4 text-sm text-ink-500">Unavailable — the analytics endpoint failed.</p>
          ) : recentRuns.length === 0 ? (
            <EmptyState compact title="No agent has run yet" description="Enable an agent and its runs appear here, with what each one observed and did." action={<Button size="sm" to="/agents">Open agents</Button>} />
          ) : (
            <ul className="divide-y divide-ink-100">
              {recentRuns.map((run) => (
                <li key={run.id} className="flex items-start gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-fg">{run.agent_name || run.agent_key || 'Agent run'}</p>
                    <p className="mt-0.5 truncate text-xs text-ink-600">
                      {run.summary
                        || [
                          run.dry_run ? 'Dry run' : null,
                          run.observations ? `${run.observations} observed` : null,
                          run.actions_taken ? `${run.actions_taken} acted on` : null,
                          run.escalations ? `${run.escalations} escalated` : null,
                        ].filter(Boolean).join(' · ')
                        || '—'}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {run.status && <StatusBadge status={run.status} />}
                    {run.started_at && <DateText value={run.started_at} relative className="text-2xs text-ink-500" />}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="space-y-4">
          <Card title="Open findings by record type">
            {overview.loading ? <SkeletonRows rows={3} columns={1} /> : (
              <Distribution
                items={byEntity}
                emptyText={insights ? 'No findings are open.' : 'Unavailable.'}
              />
            )}
          </Card>

          <Card
            title="What Simeli can read"
            description={aiSettings ? `${count(aiSettings.tool_count)} tools · up to ${count(aiSettings.max_steps)} steps a question` : 'Visible to roles that can read AI settings.'}
          >
            {aiSettings ? (
              <Distribution items={reach} emptyText="No tools are registered." />
            ) : (
              <p className="text-sm text-ink-500">—</p>
            )}
            {knowledge && (
              <p className="mt-3 border-t border-ink-100 pt-3 text-xs text-ink-600">
                Knowledge base: {count(knowledge.documents)} documents, {count(knowledge.chunks)} indexed passages.{' '}
                <Link to="/ai/knowledge-base" className="text-brand-600 hover:underline">Manage</Link>
              </p>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
