import { useMemo, useState } from 'react'
import {
  PlayIcon, BoltIcon, Cog6ToothIcon, PencilSquareIcon, PlusIcon, ArrowPathIcon, CheckIcon, XMarkIcon,
  CpuChipIcon, ChatBubbleLeftRightIcon, CheckBadgeIcon, ScaleIcon, SparklesIcon,
} from '@heroicons/react/20/solid'
import { agentsAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import {
  PageHeader, Button, Card, Stat, Tabs, Badge, StatusBadge, DataTable, Dialog, ConfirmDialog, Field, Select, Switch,
  Textarea, EmptyState, ErrorState, InlineNotice, SkeletonRows, DateText, Money, Num, Code, notify, describeError,
} from '../../components/ui'
import { useShell } from '../../components/shell/ShellContext'

/**
 * Autonomous agents — what runs on its own, what it may do, and what it did.
 *
 * "Mode" is the control that decides whether software changes the business
 * without asking, so each mode is described in words where it is chosen, and
 * granting autonomy (act + enabled) is confirmed on its own.
 *
 * Track record is where authority is earned rather than assumed: what people
 * approved, changed and rejected of each agent's work, and the mode or limit
 * that record supports, which a manager confirms.
 */

// The three modes, in the order they escalate.
const MODES = [
  { key: 'observe', label: 'Observe', blurb: 'Looks and reports. Changes nothing.', tone: 'ink' },
  { key: 'propose', label: 'Propose', blurb: 'Prepares drafts for someone to approve. Nothing takes effect on its own.', tone: 'ink' },
  { key: 'act', label: 'Act', blurb: 'Makes real changes unattended, within its authority. Anything above that is escalated to a person.', tone: 'warn' },
]
const modeMeta = (m) => MODES.find((x) => x.key === m) || MODES[0]

// Run statuses → the shared status vocabulary, keeping the agent's own words.
const RUN_STATUS = {
  RUNNING: { status: 'RUNNING', label: 'Running' },
  SUCCEEDED: { status: 'SUCCEEDED', label: 'Succeeded' },
  PARTIAL: { status: 'WARNING', label: 'Partial' },
  SKIPPED: { status: 'CANCELLED', label: 'Skipped' },
  FAILED: { status: 'FAILED', label: 'Failed' },
}
const RunStatus = ({ status }) => {
  const m = RUN_STATUS[status] || { status, label: undefined }
  return <StatusBadge status={m.status} label={m.label} />
}

// What each recorded decision means for the reader.
const DECISION = {
  acted: { status: 'DONE', label: 'Acted' },
  proposed: { status: 'PENDING', label: 'Proposed' },
  escalated: { status: 'WARNING', label: 'Escalated' },
  observed: { status: 'DRAFT', label: 'Observed' },
  skipped: { status: 'CANCELLED', label: 'Skipped' },
  failed: { status: 'FAILED', label: 'Failed' },
}

const KEYS = {
  agents: ['agents'],
  escalations: ['agents', 'escalations', 'OPEN'],
  runs: ['agents', 'runs', 50],
  scheduler: ['agents', 'scheduler'],
  track: ['agents', 'track-record'],
}

// `authority_description` is a structured object from the runtime
// ({ explanation, allowed_actions, max_amount, currency, max_actions_per_run }),
// not a sentence; this turns it into one for confirmations.
const authorityText = (authority) => {
  if (!authority) return 'No authority recorded.'
  if (typeof authority === 'string') return authority
  const parts = [authority.explanation].filter(Boolean)
  if (authority.allowed_actions?.length) parts.push(`May: ${authority.allowed_actions.join(', ')}.`)
  if (authority.max_amount != null) parts.push(`Up to ${authority.currency || ''} ${Number(authority.max_amount).toLocaleString(undefined, { minimumFractionDigits: 2 })} per action.`.replace('  ', ' '))
  if (authority.max_actions_per_run != null) parts.push(`At most ${authority.max_actions_per_run} actions per run.`)
  return parts.join(' ')
}

// The limits are the part an operator is actually deciding about, so they are
// shown as discrete facts rather than folded into the prose sentence.
function AuthorityDetail({ authority }) {
  if (!authority) return <p className="text-xs text-ink-500">No authority recorded.</p>
  if (typeof authority === 'string') return <p className="text-xs text-ink-600">{authority}</p>
  return (
    <div className="space-y-1">
      {authority.explanation && <p className="text-xs text-ink-600">{authority.explanation}</p>}
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {authority.allowed_actions?.length > 0 && (
          <div className="flex min-w-0 gap-1"><dt className="text-ink-500">May</dt><dd className="min-w-0 break-words font-mono text-2xs leading-4 text-ink-700">{authority.allowed_actions.join(', ')}</dd></div>
        )}
        {authority.max_amount != null && (
          <div className="flex gap-1"><dt className="text-ink-500">Limit</dt><dd><Money amount={authority.max_amount} currency={authority.currency || 'USD'} className="text-ink-700" /></dd></div>
        )}
        {authority.max_actions_per_run != null && (
          <div className="flex gap-1"><dt className="text-ink-500">Per run</dt><dd><Num value={authority.max_actions_per_run} className="text-ink-700" /></dd></div>
        )}
      </dl>
    </div>
  )
}

const every = (seconds) => {
  const s = Number(seconds)
  if (!s) return 'Manual only'
  if (s % 86400 === 0) return s === 86400 ? 'Every day' : `Every ${s / 86400} days`
  if (s % 3600 === 0) return s === 3600 ? 'Every hour' : `Every ${s / 3600} hours`
  return `Every ${Math.round(s / 60)} min`
}

export default function Agents() {
  const [tab, setTab] = useState('agents')
  const [configuring, setConfiguring] = useState(null)
  const [confirmLive, setConfirmLive] = useState(null)
  const [runResult, setRunResult] = useState(null)
  const [viewingRun, setViewingRun] = useState(null)
  const [resolving, setResolving] = useState(null) // { esc, decision }
  const [runningKey, setRunningKey] = useState(null)
  const [approveNote, setApproveNote] = useState('')

  const agentsQ = useResource(KEYS.agents, () => agentsAPI.list())
  const escQ = useResource(KEYS.escalations, () => agentsAPI.listEscalations({ status: 'OPEN' }))
  const runsQ = useResource(KEYS.runs, () => agentsAPI.listRuns({ limit: 50 }))
  const schedQ = useResource(KEYS.scheduler, () => agentsAPI.schedulerStatus())

  const agents = useMemo(() => (Array.isArray(agentsQ.data) ? agentsQ.data : []), [agentsQ.data])
  const escalations = useMemo(() => (Array.isArray(escQ.data) ? escQ.data : []), [escQ.data])
  const runs = useMemo(() => (Array.isArray(runsQ.data) ? runsQ.data : []), [runsQ.data])
  const scheduler = schedQ.data || null

  const all = [KEYS.agents, KEYS.escalations, KEYS.runs, KEYS.scheduler]
  const sync = useResourceMutation(() => agentsAPI.sync(), {
    invalidates: all,
    onSuccess: (data) => {
      const n = data?.synced ?? (Array.isArray(data) ? data.length : 0)
      notify.success(`Agent definitions synced${n ? ` (${n})` : ''}`)
    },
  })
  const runAgent = useResourceMutation(({ key, live }) => agentsAPI.run(key, { dry_run: !live }), { invalidates: all, silent: true })
  const resolve = useResourceMutation(({ id, decision, note }) => agentsAPI.resolveEscalation(id, decision, note), { invalidates: [KEYS.escalations, KEYS.agents], silent: true })

  // dry_run defaults to true server-side. A manual run is a preview unless the
  // operator deliberately asks for it to act, so that intent is confirmed.
  const run = async (agent, live) => {
    setConfirmLive(null)
    setRunningKey(agent.agent_key)
    try {
      const summary = await runAgent.mutateAsync({ key: agent.agent_key, live })
      // The run endpoint returns counts, not the per-action detail — that is
      // what makes a preview worth reading, so it is fetched from the run
      // record. A run that was skipped never created one.
      let actions = []
      if (summary?.run_id) {
        try {
          const detail = await agentsAPI.getRun(summary.run_id)
          actions = detail.data?.data?.actions || []
        } catch {
          // The counts are still worth showing without the breakdown.
        }
      }
      setRunResult({ agent, live, data: summary, actions })
    } catch (e) {
      notify.error(`${agent.display_name} did not run — ${describeError(e).message}`)
    } finally {
      setRunningKey(null)
    }
  }

  const doResolve = async (note) => {
    const { esc, decision } = resolving
    try {
      await resolve.mutateAsync({ id: esc.id, decision, note: decision === 'approve' ? approveNote.trim() : note || '' })
      setResolving(null)
      notify.success(`${esc.title} ${decision === 'approve' ? 'approved' : 'rejected'}`)
    } catch (e) {
      setResolving(null)
      notify.error(`Not resolved — ${describeError(e).message}`)
    }
  }

  const active = agents.filter((a) => a.enabled)
  const acting = agents.filter((a) => a.enabled && a.mode === 'act')

  const runColumns = useMemo(() => [
    { id: 'started', header: 'Started', accessor: 'started_at', width: 180, mobile: 'trailing', cell: (r) => <DateText value={r.started_at} withTime /> },
    { id: 'agent', header: 'Agent', accessor: 'agent_key', filter: 'select', mobile: 'title', width: 190, cell: (r) => <Code>{r.agent_key}</Code> },
    { id: 'trigger', header: 'Trigger', accessor: 'trigger', filter: 'select', width: 110, cell: (r) => <span className="text-xs text-ink-600">{r.trigger}</span> },
    { id: 'mode', header: 'Mode', accessor: (r) => `${r.mode}${r.dry_run ? ' (preview)' : ''}`, filter: 'select', width: 140, cell: (r) => <span className="text-xs">{r.mode}{r.dry_run && <span className="ml-1 text-ink-500">preview</span>}</span> },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 120, mobile: 'meta', cell: (r) => <RunStatus status={r.status} /> },
    { id: 'seen', header: 'Seen', accessor: (r) => Number(r.observations), align: 'right', width: 80, cell: (r) => <Num value={r.observations} /> },
    { id: 'did', header: 'Did', accessor: (r) => Number(r.actions_taken), align: 'right', width: 80, cell: (r) => <Num value={r.actions_taken} /> },
    { id: 'asked', header: 'Asked', accessor: (r) => Number(r.escalations), align: 'right', width: 80, cell: (r) => <Num value={r.escalations} /> },
    {
      id: 'summary', header: 'Summary', accessor: (r) => r.error || r.summary, minWidth: 220, mobile: 'subtitle',
      cell: (r) => (r.error
        ? <span className="block truncate text-risk-600" title={r.error}>{r.error}</span>
        : <span className="block truncate text-ink-600" title={r.summary || ''}>{r.summary || '—'}</span>),
    },
  ], [])

  return (
    <div className="space-y-5">
      <PageHeader
        title="Agents"
        description="What runs on its own, what it may do, and what it did."
        secondary={<Button icon={ArrowPathIcon} onClick={() => sync.mutate()} loading={sync.isPending} title="Register the agents defined in the application">Sync definitions</Button>}
        primary={<Button variant="primary" icon={PlusIcon} to="/ai/agents/new">Build an agent</Button>}
      />

      <section aria-label="At a glance" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Registered" value={agentsQ.error ? '—' : <Num value={agents.length} />} loading={agentsQ.loading} />
        <Stat label="Enabled" value={agentsQ.error ? '—' : <Num value={active.length} />} loading={agentsQ.loading} />
        <Stat
          label="Acting unattended"
          value={agentsQ.error ? '—' : <Num value={acting.length} />}
          loading={agentsQ.loading}
          reason={agentsQ.error ? undefined : acting.length > 0 ? 'These change business data on their own.' : 'None are making real changes.'}
        />
        <Stat
          label="Waiting on you"
          value={escQ.error ? '—' : <Num value={escalations.length} />}
          loading={escQ.loading}
          reason={escalations.length > 0 ? 'Work is paused until decided.' : undefined}
          onClick={escalations.length > 0 ? () => setTab('escalations') : undefined}
        />
      </section>

      {/* The scheduler is off unless enabled by environment. Without saying so,
          an enabled agent that never runs looks like a broken agent. */}
      {scheduler && !scheduler.running && active.length > 0 && (
        <InlineNotice tone="warn" title="The agent scheduler is not running in this environment">
          Nothing runs on its own. Agents can still be run by hand from this page.
        </InlineNotice>
      )}

      <Tabs
        value={tab}
        onChange={setTab}
        label="Agent sections"
        tabs={[
          { id: 'agents', label: 'Agents', count: agents.length },
          { id: 'escalations', label: 'Escalations', count: escalations.length },
          { id: 'track', label: 'Track record' },
          { id: 'runs', label: 'Run history' },
        ]}
      >
        {(t) => (
          <>
            {t === 'agents' && (
              agentsQ.loading ? <Card padded={false}><SkeletonRows rows={5} columns={3} /></Card>
                : agentsQ.error ? <ErrorState what="Agents" error={agentsQ.error} onRetry={agentsQ.refetch} />
                  : agents.length === 0 ? (
                    <Card>
                      <EmptyState
                        icon={CpuChipIcon}
                        title="No agents registered"
                        description="Use Sync definitions to register the agents defined in the application, or build one of your own."
                        action={<Button icon={ArrowPathIcon} onClick={() => sync.mutate()} loading={sync.isPending}>Sync definitions</Button>}
                      />
                    </Card>
                  ) : (
                    <Card padded={false}>
                      <ul className="divide-y divide-ink-100">
                        {agents.map((a) => (
                          <AgentRow
                            key={a.agent_key}
                            agent={a}
                            running={runningKey === a.agent_key}
                            onPreview={() => run(a, false)}
                            onLive={() => setConfirmLive(a)}
                            onConfigure={() => setConfiguring(a)}
                          />
                        ))}
                      </ul>
                    </Card>
                  )
            )}

            {t === 'escalations' && (
              escQ.loading ? <Card padded={false}><SkeletonRows rows={3} columns={3} /></Card>
                : escQ.error ? <ErrorState what="Escalations" error={escQ.error} onRetry={escQ.refetch} />
                  : escalations.length === 0 ? (
                    <Card>
                      <EmptyState
                        icon={CheckBadgeIcon}
                        title="Nothing is waiting on a decision"
                        description="When an agent meets something above its authority, it stops and asks here rather than either dropping the work or exceeding its limits."
                      />
                    </Card>
                  ) : (
                    <Card padded={false}>
                      <ul className="divide-y divide-ink-100">
                        {escalations.map((e) => (
                          <li key={e.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start">
                            <div className="min-w-0 flex-1">
                              <p className="flex flex-wrap items-center gap-2">
                                <span className="font-medium text-fg">{e.title}</span>
                                <Badge tone="warn" glyph="triangle">{String(e.reason || '').replace(/_/g, ' ').toLowerCase()}</Badge>
                              </p>
                              {e.detail && <p className="mt-1 text-sm text-ink-700">{e.detail}</p>}
                              <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500">
                                <Code>{e.agent_key}</Code>
                                {e.proposed_action && <span>Action: <span className="font-mono">{e.proposed_action}</span></span>}
                                {e.amount != null && <Money amount={e.amount} currency={e.currency || 'USD'} className="font-medium text-ink-800" />}
                                <DateText value={e.created_at} withTime />
                              </p>
                            </div>
                            <div className="flex shrink-0 gap-2">
                              <Button size="sm" variant="destructive" icon={XMarkIcon} onClick={() => setResolving({ esc: e, decision: 'reject' })}>Reject</Button>
                              <Button size="sm" variant="primary" icon={CheckIcon} onClick={() => { setApproveNote(''); setResolving({ esc: e, decision: 'approve' }) }}>Approve</Button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </Card>
                  )
            )}

            {t === 'track' && <TrackRecord invalidates={[KEYS.agents, KEYS.track]} />}

            {t === 'runs' && (
              <DataTable
                viewKey="agents.runs"
                caption="Agent run history"
                noun="run"
                rows={runs}
                columns={runColumns}
                loading={runsQ.loading}
                error={runsQ.error}
                onRetry={runsQ.refetch}
                onRowClick={(r) => setViewingRun(r)}
                defaultSort={{ id: 'started', dir: 'desc' }}
                searchPlaceholder="Search agent, summary, error"
                rowActions={(r) => (
                  <button type="button" onClick={(ev) => { ev.stopPropagation(); setViewingRun(r) }} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-ink-600 hover:bg-ink-100 hover:text-fg">
                    <ChatBubbleLeftRightIcon className="h-3.5 w-3.5" aria-hidden="true" /> Reasoning
                  </button>
                )}
                empty={{ icon: CpuChipIcon, title: 'No runs recorded', description: 'Preview an agent from the Agents tab to see what it would do. Every run is recorded here.' }}
              />
            )}
          </>
        )}
      </Tabs>

      {configuring && <ConfigureAgentDialog agent={configuring} invalidates={[KEYS.agents]} onClose={() => setConfiguring(null)} />}

      {confirmLive && (
        <ConfirmDialog
          open
          onClose={() => setConfirmLive(null)}
          onConfirm={() => run(confirmLive, true)}
          title={`Run ${confirmLive.display_name} for real?`}
          consequence={`It will make changes within its authority, without asking again. ${authorityText(confirmLive.authority_description)} Anything above that is escalated to a person.`}
          confirmLabel="Run live"
        />
      )}

      {resolving && (
        <ConfirmDialog
          open
          onClose={() => setResolving(null)}
          onConfirm={doResolve}
          title={resolving.decision === 'approve' ? `Approve: ${resolving.esc.title}?` : `Reject: ${resolving.esc.title}?`}
          consequence={resolving.decision === 'approve'
            ? `The agent goes ahead with ${resolving.esc.proposed_action ? `"${resolving.esc.proposed_action}"` : 'what it proposed'}${resolving.esc.amount != null ? ` for ${resolving.esc.currency || ''} ${Number(resolving.esc.amount).toLocaleString()}` : ''}. Your decision and note are kept in the audit trail.`
            : 'The agent does not carry out what it proposed. The reason is kept in the audit trail.'}
          tone={resolving.decision === 'approve' ? 'primary' : 'danger'}
          confirmLabel={resolving.decision === 'approve' ? 'Approve' : 'Reject'}
          requireReason={resolving.decision === 'reject'}
          reasonLabel="Why reject it?"
          reasonHelp="Kept with the escalation in the audit trail."
          busy={resolve.isPending}
        >
          {resolving.decision === 'approve' && (
            <Field label="Note for the audit trail" optional>
              <Textarea value={approveNote} onChange={(ev) => setApproveNote(ev.target.value)} rows={2} />
            </Field>
          )}
        </ConfirmDialog>
      )}

      {runResult && <RunResultDialog result={runResult} onClose={() => setRunResult(null)} />}
      {viewingRun && <TranscriptDialog run={viewingRun} onClose={() => setViewingRun(null)} />}
    </div>
  )
}

const TRACK_VERDICT = {
  earned: { tone: 'ok', glyph: 'check', label: 'Earned more' },
  lose: { tone: 'risk', glyph: 'triangle', label: 'Should lose some' },
  holding: { tone: 'ink', label: 'Holding' },
  too_early: { tone: 'ink', glyph: 'ring', label: 'Too early' },
}

/**
 * Authority granted from measured outcomes. Every figure is a decision a
 * person made on the agent's work; a proposal changes nothing until a manager
 * confirms it, and the record is measured again when they do.
 */
function TrackRecord({ invalidates }) {
  const { openSimeli } = useShell()
  const [granting, setGranting] = useState(null)
  const q = useResource(KEYS.track, () => agentsAPI.trackRecord())
  const grant = useResourceMutation((id) => agentsAPI.grantEarned(id), { invalidates, silent: true })
  const data = q.data || null

  const doGrant = async () => {
    const p = granting
    try {
      const out = await grant.mutateAsync(p.id)
      setGranting(null)
      notify.success(`${out?.done || p.label} ${out?.next || ''}`.trim())
    } catch (e) {
      setGranting(null)
      notify.error(`Not changed — ${describeError(e).message}`)
    }
  }

  if (q.loading) return <Card padded={false}><SkeletonRows rows={4} columns={3} /></Card>
  if (q.error) return <ErrorState what="Track record" error={q.error} onRetry={q.refetch} />
  if (!data?.agents?.length) {
    return <Card><EmptyState icon={ScaleIcon} title="No agents to measure" description="Once agents have run and people have decided on their work, their record shows here." /></Card>
  }

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-fg">{data.headline}</p>
            <p className="mt-1 text-xs text-ink-500">
              Agents start read-only. A promotion needs {data.rules.min_decided} decided items, {data.rules.promote_to_act_agreement * 100}% accepted as proposed
              and no more than {data.rules.promote_max_rejected * 100}% rejected; a higher limit needs {data.rules.limit_approval * 100}% of the
              escalations above it approved. Nothing changes until a manager confirms.
            </p>
          </div>
          <Button size="sm" variant="ghost" icon={SparklesIcon} className="shrink-0" onClick={() => openSimeli({ question: 'Which agents have earned more authority, and which should lose some? Use explain_agent_track_record.' })}>Ask Simeli</Button>
        </div>
      </Card>
      <Card padded={false}>
        <ul className="divide-y divide-ink-100">
          {data.agents.map((a) => {
            const v = TRACK_VERDICT[a.verdict] || TRACK_VERDICT.holding
            const r = a.record
            return (
              <li key={a.agent_key} className="space-y-2 px-4 py-3.5">
                <p className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-fg">{a.name}</span>
                  <Badge tone={modeMeta(a.mode).tone}>{modeMeta(a.mode).label}</Badge>
                  <Badge tone={v.tone} glyph={v.glyph}>{v.label}</Badge>
                  {!a.enabled && <StatusBadge status="DISABLED" label="Disabled" />}
                </p>
                <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
                  <div className="flex gap-1"><dt className="text-ink-500">Decided</dt><dd><Num value={r.decided} className="text-ink-800" /></dd></div>
                  <div className="flex gap-1"><dt className="text-ink-500">Accepted as proposed</dt><dd className="text-ink-800">{r.agreement_pct == null ? '—' : `${r.agreement_pct}%`}</dd></div>
                  <div className="flex gap-1"><dt className="text-ink-500">Changed</dt><dd><Num value={r.accepted_with_changes} className="text-ink-800" /></dd></div>
                  <div className="flex gap-1"><dt className="text-ink-500">Rejected</dt><dd><Num value={r.rejected} className="text-ink-800" /></dd></div>
                  <div className="flex gap-1"><dt className="text-ink-500">Waiting</dt><dd><Num value={r.pending} className="text-ink-800" /></dd></div>
                  {r.actions > 0 && <div className="flex gap-1"><dt className="text-ink-500">Failed</dt><dd className="text-ink-800">{r.failed} of {r.actions}</dd></div>}
                  {a.reminders && <div className="flex gap-1"><dt className="text-ink-500">Reminders paid in {a.reminders.paid_within_days} days</dt><dd className="text-ink-800">{a.reminders.paid} of {a.reminders.paid + a.reminders.not_paid}</dd></div>}
                  {a.limit && <div className="flex gap-1"><dt className="text-ink-500">Above its limit, approved</dt><dd className="text-ink-800">{a.limit.approved} of {a.limit.decided}</dd></div>}
                </dl>
                <p className="text-sm text-ink-700">{a.reason}</p>
                {a.rejected_or_changed.length > 0 && (
                  <ul className="space-y-0.5 text-xs text-ink-600">
                    {a.rejected_or_changed.map((x, i) => (
                      <li key={i}>
                        <span className={x.verdict === 'rejected' ? 'text-risk-700' : 'text-warn-700'}>{x.verdict === 'rejected' ? 'Rejected' : 'Changed'}</span>
                        {' · '}{x.label}{x.amount != null && <> · <Money amount={x.amount} currency={x.currency || 'USD'} /></>}{x.note ? ` · ${x.note}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
                {a.earned && <p className="text-xs text-ink-500">Last change from its record: {a.earned.change} (<DateText value={a.earned.at} />).</p>}
                {a.proposals.length > 0 && (
                  <div className="flex flex-col gap-2 rounded-md bg-sunken px-3 py-2">
                    {a.proposals.map((p) => (
                      <div key={p.id} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <span className="text-sm text-ink-800">{p.label}</span>
                        <span className="flex shrink-0 gap-1.5">
                          <Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => openSimeli({ question: `${p.label}? Use explain_agent_track_record, and grant_earned_authority with proposal ${p.id} only if I confirm.` })}>Ask Simeli</Button>
                          {data.can_grant && <Button size="xs" variant={p.kind === 'lower_mode' ? 'destructive' : 'primary'} onClick={() => setGranting(p)}>{p.kind === 'lower_mode' ? 'Lower' : 'Grant'}</Button>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </Card>

      {granting && (
        <ConfirmDialog
          open
          onClose={() => setGranting(null)}
          onConfirm={doGrant}
          title={`${granting.label}?`}
          consequence={`${granting.why} Evidence: ${granting.evidence}. The record is measured again first, and the change and its evidence go into the audit trail. It does not switch the agent on or off.`}
          tone={granting.kind === 'lower_mode' ? 'danger' : 'primary'}
          confirmLabel={granting.kind === 'lower_mode' ? 'Lower it' : 'Grant it'}
          busy={grant.isPending}
        />
      )}
    </div>
  )
}

function AgentRow({ agent: a, running, onPreview, onLive, onConfigure }) {
  const meta = modeMeta(a.mode)
  return (
    <li className="flex flex-col gap-3 px-4 py-3.5 lg:flex-row lg:items-start">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-fg">{a.display_name}</span>
          <Badge tone={meta.tone} glyph={a.mode === 'act' ? 'triangle' : undefined}>{meta.label}</Badge>
          <StatusBadge status={a.enabled ? 'ENABLED' : 'DISABLED'} label={a.enabled ? 'Enabled' : 'Disabled'} />
          {/* A built-here agent is editable; a code-defined one is not. */}
          {a.built_by_user && <Badge tone="ink">Built here</Badge>}
          {/* A definition with no implementation can be configured but will
              never do anything — worth saying out loud. */}
          {a.implemented === false && <Badge tone="risk" glyph="cross">Not implemented</Badge>}
        </p>
        {a.description && <p className="mt-1 text-sm text-ink-700">{a.description}</p>}
        <div className="mt-2 rounded-md bg-sunken px-3 py-2">
          <p className="label-mono mb-1">Authority</p>
          <AuthorityDetail authority={a.authority_description} />
        </div>
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500">
          <span>{a.schedule_seconds ? every(a.schedule_seconds) : 'Manual only'}</span>
          {a.last_status && <span className="flex items-center gap-1">Last run <RunStatus status={a.last_status} /></span>}
          {a.last_run_at && <DateText value={a.last_run_at} relative />}
        </p>
        {/* Why did it fail? The run stores the error; show it here instead of
            leaving a bare "failed" badge. */}
        {a.last_status === 'FAILED' && a.last_error && <InlineNotice tone="risk" className="mt-2">{a.last_error}</InlineNotice>}
        {a.last_summary && <p className="mt-2 text-xs text-ink-600">Last summary: {a.last_summary}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {a.built_by_user && <Button size="sm" variant="ghost" icon={PencilSquareIcon} to={`/ai/agents/${a.agent_key}`} title="Edit what this agent does">Edit</Button>}
        <Button size="sm" icon={PlayIcon} onClick={onPreview} loading={running} title="Preview: shows what it would do, changes nothing">Preview</Button>
        {a.mode === 'act' && a.enabled && <Button size="sm" variant="destructive" icon={BoltIcon} onClick={onLive} disabled={running}>Run live</Button>}
        <Button size="sm" variant="ghost" icon={Cog6ToothIcon} onClick={onConfigure} aria-label={`Configure ${a.display_name}`}>Configure</Button>
      </div>
    </li>
  )
}

function ConfigureAgentDialog({ agent, invalidates, onClose }) {
  const [form, setForm] = useState({
    enabled: !!agent.enabled,
    mode: agent.mode || 'observe',
    schedule_seconds: agent.schedule_seconds || 3600,
  })
  const [confirmGrant, setConfirmGrant] = useState(false)
  const [serverError, setServerError] = useState(null)
  const configure = useResourceMutation((payload) => agentsAPI.configure(agent.agent_key, payload).then((res) => {
    // The server may attach a note beside `data` (e.g. why a change was capped).
    const body = res?.data || {}
    return { data: { success: body.success, error: body.error, data: { note: body.note } } }
  }), { invalidates, silent: true })

  // Raising an agent to "act" while enabled is the moment autonomy is granted.
  // Confirming it separately keeps that from being a side effect of adjusting
  // something else in the same form.
  const grantsAutonomy = form.enabled && form.mode === 'act' && !(agent.enabled && agent.mode === 'act')

  const save = async () => {
    setServerError(null)
    try {
      const res = await configure.mutateAsync({
        enabled: form.enabled,
        mode: form.mode,
        schedule_seconds: Number(form.schedule_seconds) || null,
      })
      notify.success(res?.note || `${agent.display_name} updated`)
      onClose()
    } catch (e) {
      setConfirmGrant(false)
      setServerError(describeError(e).message)
    }
  }

  if (confirmGrant) {
    return (
      <ConfirmDialog
        open
        onClose={() => setConfirmGrant(false)}
        onConfirm={save}
        title={`Let ${agent.display_name} act unattended?`}
        consequence={`It will change business data on its own, within its authority: ${authorityText(agent.authority_description)} Anything above that is escalated for a person to decide. You can switch it back to Observe at any time.`}
        reversible
        confirmLabel="Let it act"
        busy={configure.isPending}
      />
    )
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={agent.display_name}
      description="How this agent runs and how far it may go."
      footer={
        <>
          <Button onClick={onClose} disabled={configure.isPending}>Cancel</Button>
          <Button variant="primary" onClick={() => (grantsAutonomy ? setConfirmGrant(true) : save())} loading={configure.isPending}>Save</Button>
        </>
      }
    >
      <div className="space-y-4">
        {serverError && <InlineNotice tone="risk" title="Not saved">{serverError}</InlineNotice>}
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-ink-800">Enabled</p>
            <p className="text-xs text-ink-500">A disabled agent never runs, on a schedule or otherwise.</p>
          </div>
          <Switch checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label={<span className="sr-only">Enabled</span>} />
        </div>

        <fieldset>
          <legend className="mb-1 text-sm font-medium text-ink-800">Mode</legend>
          <div className="space-y-2">
            {MODES.map((m) => (
              <label key={m.key} aria-label={m.label} className={`flex cursor-pointer items-start gap-2 rounded-md border p-2.5 ${form.mode === m.key ? 'border-ink-900 bg-sunken' : 'border-ink-200 hover:bg-ink-50'}`}>
                <input type="radio" name="mode" className="mt-0.5" checked={form.mode === m.key} onChange={() => setForm({ ...form, mode: m.key })} />
                <span>
                  <span className="block text-sm font-medium text-fg">{m.label}</span>
                  <span className="block text-xs text-ink-600">{m.blurb}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <Field label="Run every">
          <Select value={form.schedule_seconds} onChange={(e) => setForm({ ...form, schedule_seconds: e.target.value })}>
            <option value={900}>15 minutes</option>
            <option value={3600}>Hour</option>
            <option value={21600}>6 hours</option>
            <option value={86400}>Day</option>
            {![900, 3600, 21600, 86400].includes(Number(form.schedule_seconds)) && <option value={form.schedule_seconds}>{every(form.schedule_seconds)} (current)</option>}
          </Select>
        </Field>

        <div className="rounded-md bg-sunken px-3 py-2">
          <p className="label-mono mb-1">Authority</p>
          <AuthorityDetail authority={agent.authority_description} />
        </div>

        {grantsAutonomy && (
          <InlineNotice tone="warn">This will let the agent change business data unattended. You will be asked to confirm.</InlineNotice>
        )}
      </div>
    </Dialog>
  )
}

function RunResultDialog({ result, onClose }) {
  const { agent, live, data, actions = [] } = result
  // A run can be declined before it starts — the agent is disabled, or another
  // run holds the lock. There are no counts to show in that case, only why.
  const skipped = data?.status === 'SKIPPED'

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={agent.display_name}
      description={skipped ? 'Did not run' : live ? 'Live run — changes were made' : 'Preview — nothing was changed'}
      footer={<Button variant="primary" onClick={onClose}>Close</Button>}
    >
      <div className="space-y-4">
        {skipped ? (
          <InlineNotice tone="ink">{data?.reason || 'This run was skipped.'}</InlineNotice>
        ) : (
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-ink-200 bg-ink-200 sm:grid-cols-4">
            {[['Seen', data?.observations], ['Did', data?.actions_taken], ['Asked', data?.escalations], ['Errors', data?.errors]].map(([label, value]) => (
              <div key={label} className="bg-surface px-3 py-2">
                <dt className="label-mono">{label}</dt>
                <dd className="mt-0.5 text-lg font-semibold"><Num value={value} /></dd>
              </div>
            ))}
          </dl>
        )}
        {data?.summary && <p className="rounded-md bg-sunken px-3 py-2 text-sm text-ink-800">{data.summary}</p>}
        {data?.error && <InlineNotice tone="risk">{data.error}</InlineNotice>}
        {actions.length > 0 && (
          <section aria-labelledby="run-actions">
            <h3 id="run-actions" className="mb-2 text-sm font-medium text-ink-800">What it {live ? 'did' : 'would do'}</h3>
            <ul className="divide-y divide-ink-100 rounded-md border border-ink-200">
              {actions.map((x) => {
                const d = DECISION[x.decision] || { status: x.decision }
                return (
                  <li key={x.id} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-baseline gap-2">
                        <span className="font-medium text-fg">{x.entity_label || x.action_type}</span>
                        {x.amount != null && <Money amount={x.amount} currency={x.currency || 'USD'} className="text-xs" />}
                      </p>
                      {/* Written by the agent's own deterministic logic, so it
                          explains the decision rather than describing it. */}
                      {x.rationale && <p className="mt-0.5 text-xs text-ink-600">{x.rationale}</p>}
                      {x.error && <p className="mt-0.5 text-xs text-risk-600">{x.error}</p>}
                    </div>
                    <StatusBadge status={d.status} label={d.label} />
                  </li>
                )
              })}
            </ul>
          </section>
        )}
      </div>
    </Dialog>
  )
}

const ROLE_LABEL = { assistant: 'Thought', tool: 'Tool', error: 'Problem', user: 'Prompt' }
const VERDICT = { allow: 'APPROVED', escalate: 'WARNING', deny: 'REJECTED', dry_run: 'DRAFT', error: 'FAILED' }

/**
 * What the agent thought, as opposed to what it did. The action trail answers
 * "what happened"; this answers "why" — the question people actually have
 * when a run looks wrong.
 */
function TranscriptDialog({ run, onClose }) {
  const [showBriefing, setShowBriefing] = useState(false)
  const { data, loading, error, refetch } = useResource(['agents', 'runs', run.id, 'transcript'], () => agentsAPI.runTranscript(run.id))
  const messages = Array.isArray(data) ? data : []
  const briefing = messages.find((m) => m.role === 'system')
  const rest = messages.filter((m) => m.role !== 'system')

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={run.agent_key}
      description={[
        new Date(run.started_at).toLocaleString(),
        String(run.status || '').toLowerCase(),
        run.dry_run ? 'preview' : null,
        run.model,
        run.tokens_in ? `${(Number(run.tokens_in) + Number(run.tokens_out || 0)).toLocaleString()} tokens` : null,
      ].filter(Boolean).join(' · ')}
      footer={<Button variant="primary" onClick={onClose}>Close</Button>}
    >
      <div className="space-y-3">
        {loading ? <SkeletonRows rows={4} columns={1} /> : error ? (
          <ErrorState what="The run's reasoning" error={error} onRetry={refetch} compact />
        ) : messages.length === 0 ? (
          <EmptyState
            title="No reasoning was recorded for this run"
            description="Agents that follow a fixed sequence do not reason — their actions are in the run record instead."
            compact
          />
        ) : (
          <>
            {/* Long, identical every run, and not what anyone came here to read. */}
            {briefing && (
              <div>
                <Button size="xs" variant="ghost" onClick={() => setShowBriefing(!showBriefing)} aria-expanded={showBriefing}>
                  {showBriefing ? 'Hide' : 'Show'} what it was told
                </Button>
                {showBriefing && (
                  <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border border-ink-200 bg-sunken p-3 text-2xs text-ink-700 ui-scroll">{briefing.content}</pre>
                )}
              </div>
            )}
            <ol className="space-y-2">
              {rest.map((m) => (
                <li key={m.id} className={`rounded-md border px-3 py-2.5 ${m.role === 'error' ? 'border-risk-200 bg-risk-50' : m.role === 'tool' ? 'border-ink-200 bg-sunken' : 'border-ink-200 bg-surface'}`}>
                  <p className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="label-mono">{ROLE_LABEL[m.role] || m.role}</span>
                    {m.tool_name && <Code className="text-xs">{m.tool_name}</Code>}
                    {m.verdict && <StatusBadge status={VERDICT[m.verdict] || m.verdict} label={String(m.verdict).replace(/_/g, ' ')} />}
                    {m.duration_ms != null && <span className="font-mono text-2xs text-ink-500">{m.duration_ms} ms</span>}
                  </p>
                  {m.content && <p className={`whitespace-pre-wrap text-sm leading-relaxed ${m.role === 'error' ? 'text-risk-800' : 'text-ink-800'}`}>{m.content}</p>}
                  {m.tool_input && <pre className="mt-1 overflow-x-auto text-2xs text-ink-600 ui-scroll">{JSON.stringify(m.tool_input, null, 2).slice(0, 600)}</pre>}
                  {m.tool_output && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-2xs text-ink-500 hover:text-fg">What it got back</summary>
                      <pre className="mt-1 max-h-48 overflow-auto text-2xs text-ink-600 ui-scroll">{JSON.stringify(m.tool_output, null, 2).slice(0, 3000)}</pre>
                    </details>
                  )}
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </Dialog>
  )
}
