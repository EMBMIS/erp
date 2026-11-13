import React, { useMemo, useState } from 'react'
import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Tabs, Stat, DataTable, Badge, Money, Num, DateText, Code, InlineNotice, Provenance, Card, formatMoney,
} from '../../components/ui'

const IMPACT = {
  real: { label: 'Changes records', tone: 'warn' },
  draft: { label: 'Drafts', tone: 'brand' },
  read: { label: 'Reads', tone: 'ink' },
}

const FEEDBACK_TONE = { REJECTION: 'risk', CORRECTION: 'warn', OVERRIDE: 'ink' }

/**
 * AI governance — what Simeli costs, what it may touch, and what people told it.
 */
export default function AIGovernance() {
  const [tab, setTab] = useState('spend')

  // /ai-agent/usage answers flat ({ success, days, totals, caps, breakdown }),
  // so it is re-wrapped before unwrap() sees it.
  const usageQ = useResource(
    keys.aiGovernanceUsage(),
    ({ signal }) => api.get('/ai-agent/usage?days=30&group_by=day', { signal })
      .then((res) => ({ data: { success: true, data: res.data } })),
    { retry: false },
  )
  // /ai-agent/feedback answers { data: rows, total, summary } — the summary is
  // needed alongside the rows, so the whole body is kept.
  const feedbackQ = useResource(
    keys.aiGovernanceFeedback(),
    ({ signal }) => api.get('/ai-agent/feedback', { signal })
      .then((res) => ({ data: { success: true, data: res.data } })),
    { retry: false },
  )
  // Its own key: this is the settings view of the tools (with impact and
  // min_role), not the catalog the tool library caches under keys.aiTools().
  const toolsQ = useResource(['ai-settings', 'tools'], ({ signal }) => api.get('/ai-settings/tools', { signal }), { retry: false })

  const usage = usageQ.data
  const feedback = feedbackQ.data
  const toolList = useMemo(() => (Array.isArray(toolsQ.data) ? toolsQ.data : []), [toolsQ.data])
  const restricted = toolList.filter((t) => t.min_role).length
  const highImpact = toolList.filter((t) => t.impact === 'real').length

  const spent = Number(usage?.totals?.estimated_cost_usd) || 0
  const userCap = Number(usage?.caps?.user_monthly) || 0
  const share = userCap ? spent / userCap : null

  const toolColumns = useMemo(() => [
    {
      id: 'name', header: 'Tool', accessor: 'name', mobile: 'title', minWidth: 240,
      cell: (t) => (
        <span className="block min-w-0">
          <Code className="text-fg">{t.name}</Code>
          <span className="block truncate text-xs text-ink-600">{t.description}</span>
        </span>
      ),
    },
    { id: 'impact', header: 'Effect', accessor: (t) => IMPACT[t.impact]?.label || 'Reads', filter: 'select', width: 160, mobile: 'meta', cell: (t) => <Badge tone={(IMPACT[t.impact] || IMPACT.read).tone}>{(IMPACT[t.impact] || IMPACT.read).label}</Badge> },
    { id: 'role', header: 'Minimum role', accessor: (t) => t.min_role || 'Any role', filter: 'select', width: 150 },
    { id: 'enabled', header: 'State', accessor: (t) => (t.enabled ? 'On' : 'Off'), filter: 'select', width: 100, cell: (t) => <Badge tone={t.enabled ? 'ok' : 'ink'} glyph={t.enabled ? 'dot' : 'ring'}>{t.enabled ? 'On' : 'Off'}</Badge> },
  ], [])

  const usageColumns = useMemo(() => [
    { id: 'day', header: 'Date', accessor: (r) => r.day || r.user, mobile: 'title', cell: (r) => (r.day ? <DateText value={r.day} /> : (r.user || '—')) },
    { id: 'calls', header: 'Calls', accessor: (r) => Number(r.calls) || 0, align: 'right', width: 110, cell: (r) => <Num value={r.calls} /> },
    { id: 'tokens', header: 'Tokens', accessor: (r) => Number(r.total_tokens) || 0, align: 'right', width: 140, cell: (r) => <Num value={r.total_tokens} /> },
    { id: 'cost', header: 'Cost', accessor: (r) => Number(r.estimated_cost_usd) || 0, align: 'right', width: 120, mobile: 'trailing', cell: (r) => <Money amount={r.estimated_cost_usd} muted={false} /> },
  ], [])

  const feedbackColumns = useMemo(() => [
    { id: 'type', header: 'Type', accessor: 'feedback_type', filter: 'select', width: 140, mobile: 'meta', cell: (f) => <Badge tone={FEEDBACK_TONE[f.feedback_type] || 'ink'}>{String(f.feedback_type || '').toLowerCase()}</Badge> },
    { id: 'source', header: 'Source', accessor: 'source', filter: 'select', width: 140 },
    {
      id: 'detail', header: 'Detail', accessor: (f) => f.notes || f.field_name, mobile: 'title', minWidth: 260,
      cell: (f) => (
        <span className="text-xs text-ink-700">
          {f.field_name && <span>{f.field_name}: </span>}
          {f.original_value && <span className="text-ink-500 line-through">{f.original_value}</span>}
          {f.corrected_value && <span> → <span className="text-fg">{f.corrected_value}</span></span>}
          {f.notes && <span> — {f.notes}</span>}
          {f.rating ? <span> — rated {f.rating} of 5</span> : null}
          {!f.field_name && !f.notes && !f.rating && '—'}
        </span>
      ),
    },
    { id: 'created', header: 'When', accessor: 'created_at', width: 170, mobile: 'subtitle', cell: (f) => <DateText value={f.created_at} withTime /> },
  ], [])

  return (
    <div className="space-y-5">
      <PageHeader
        title="AI governance"
        description="What Simeli costs, which tools it may touch and who may use them, and what people corrected."
      />

      <Tabs
        value={tab}
        onChange={setTab}
        label="Governance"
        tabs={[
          { id: 'spend', label: 'Spend and usage' },
          { id: 'tools', label: 'Tool access', count: toolList.length || undefined },
          { id: 'feedback', label: 'Feedback', count: feedback?.data?.length || undefined },
        ]}
      />

      {tab === 'spend' && (
        <div className="space-y-4">
          {usageQ.error ? (
            <InlineNotice tone="warn" title="Usage could not be read">Spend figures are unavailable, so none are shown.</InlineNotice>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Stat
                label="Spend, last 30 days"
                loading={usageQ.loading}
                value={usage ? <Provenance method="Estimated from tokens used by each model call, at the provider's list price.">{formatMoney(spent)}</Provenance> : '—'}
                reason={usage ? `${Number(usage.totals?.calls || 0).toLocaleString()} calls · ${Number(usage.totals?.total_tokens || 0).toLocaleString()} tokens` : null}
              />
              <Stat
                label="Your monthly cap"
                loading={usageQ.loading}
                value={userCap ? formatMoney(userCap) : '—'}
                reason={share != null ? `${Math.round(share * 100)}% used` : 'No cap set'}
                footnote={share != null ? (
                  <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-ink-100" aria-hidden="true">
                    <span className={`block h-full rounded-full ${share > 0.8 ? 'bg-risk-500' : 'bg-ink-700'}`} style={{ width: `${Math.min(100, share * 100)}%` }} />
                  </span>
                ) : null}
              />
              <Stat
                label="Company monthly cap"
                loading={usageQ.loading}
                value={usage?.caps?.company_monthly ? formatMoney(usage.caps.company_monthly) : '—'}
                reason="Calls stop at the limit."
              />
            </div>
          )}

          {usage?.totals?.note && <InlineNotice tone="warn">{usage.totals.note}</InlineNotice>}

          {!usageQ.error && (
            <DataTable
              viewKey="ai.governance.usage"
              caption="Usage by day"
              noun="day"
              search={false}
              rows={usage?.breakdown || []}
              columns={usageColumns}
              loading={usageQ.loading}
              defaultSort={{ id: 'day', dir: 'desc' }}
              empty={{ title: 'No model calls in the last 30 days', description: 'Spend appears here once Simeli or an agent calls a language model.' }}
            />
          )}
        </div>
      )}

      {tab === 'tools' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Tools" loading={toolsQ.loading} value={toolList.length.toLocaleString()} />
            <Stat label="Role-gated" loading={toolsQ.loading} value={restricted.toLocaleString()} />
            <Stat label="Change records" loading={toolsQ.loading} value={highImpact.toLocaleString()} />
            <Stat label="Read or draft" loading={toolsQ.loading} value={(toolList.length - highImpact).toLocaleString()} />
          </div>
          <DataTable
            viewKey="ai.governance.tools"
            caption="Tool access"
            noun="tool"
            rows={toolList}
            columns={toolColumns}
            rowKey={(t) => t.name}
            loading={toolsQ.loading}
            error={toolsQ.error}
            onRetry={toolsQ.refetch}
            searchPlaceholder="Search tools"
            empty={{ title: 'No tools are registered', description: 'Built-in tools appear here once the AI service starts.' }}
          />
        </div>
      )}

      {tab === 'feedback' && (
        <div className="space-y-4">
          {feedback?.summary?.length > 0 && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {feedback.summary.map((s) => (
                <Stat key={s.feedback_type} label={String(s.feedback_type || '').toLowerCase()} value={Number(s.count || 0).toLocaleString()} />
              ))}
            </div>
          )}
          {feedbackQ.error ? (
            <Card><p className="text-sm text-ink-600">Feedback could not be read.</p></Card>
          ) : (
            <DataTable
              viewKey="ai.governance.feedback"
              caption="Feedback"
              noun="item"
              rows={feedback?.data || []}
              columns={feedbackColumns}
              loading={feedbackQ.loading}
              defaultSort={{ id: 'created', dir: 'desc' }}
              empty={{ title: 'No feedback captured yet', description: 'When someone corrects, overrides or rejects what Simeli did, it is recorded here and used in later answers.' }}
            />
          )}
        </div>
      )}
    </div>
  )
}
