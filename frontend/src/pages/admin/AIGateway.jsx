import { useMemo, useState } from 'react'
import { ArrowTopRightOnSquareIcon, ShieldCheckIcon, SignalIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import {
  PageHeader, Button, DataTable, Badge, Code, DateText, Dialog, SummaryStrip, DescriptionList,
  InlineNotice, Money, Segmented, describeError,
} from '../../components/ui'

/**
 * Settings → AI Gateway.
 *
 * EMBMIS Gateway is a separate product: every action an AI takes in Business OS (Simeli in chat, and the
 * autonomous agents) is checked by it BEFORE it happens, and answers allow, deny or send-to-a-person.
 * This screen says whether the connection works, what the fail mode does when it does not, how many
 * checks were allowed, blocked and are waiting, and lists each decision with its reason.
 *
 * Only this company's own record is shown (gateway_decisions). The platform key and agent keys never
 * reach the browser.
 */

// EMBMIS Gateway: the browser only ever sees this company's own record of the verdicts; keys stay on the server.
// Defined here, not in services/api.js, so the shared bundle every page loads does not carry a page few people open.
const gatewayAPI = {
  status: () => api.get('/gateway/status'),
  decisions: (params) => api.get('/gateway/decisions', { params }),
  test: () => api.post('/gateway/test'),
}

const STATUS_KEY = ['gateway', 'status']
const DECISIONS_KEY = (decision) => ['gateway', 'decisions', decision || 'all']

const DECISION = {
  allow: { tone: 'ok', glyph: 'check', label: 'Allowed' },
  deny: { tone: 'risk', glyph: 'cross', label: 'Blocked' },
  escalate: { tone: 'warn', glyph: 'clock', label: 'Sent to a person' },
}

export function DecisionBadge({ decision }) {
  const d = DECISION[decision] || { tone: 'ink', label: decision }
  return <Badge tone={d.tone} glyph={d.glyph}>{d.label}</Badge>
}

const answerOf = (r) => {
  if (r.decision !== 'escalate') return null
  if (!r.outcome) return r.origin === 'fallback' ? 'Waiting (no gateway record)' : 'Waiting'
  return r.outcome === 'approved' ? 'Approved' : 'Rejected'
}

export default function AIGateway() {
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState(null)
  const [testing, setTesting] = useState(false)
  const [tested, setTested] = useState(null)

  const statusQ = useResource(STATUS_KEY, () => gatewayAPI.status(), { refetchInterval: 30000 })
  const decisionsQ = useResource(DECISIONS_KEY(filter), () => gatewayAPI.decisions({ decision: filter || undefined, limit: 100 }), { refetchInterval: 30000 })

  const status = statusQ.data?.status
  const counts = statusQ.data?.counts
  const rows = useMemo(() => (Array.isArray(decisionsQ.data) ? decisionsQ.data : []), [decisionsQ.data])

  const test = async () => {
    setTesting(true)
    setTested(null)
    try {
      const res = await gatewayAPI.test()
      setTested(res.data?.data || { ok: false, error: 'No answer.' })
      statusQ.refetch()
    } catch (e) {
      setTested({ ok: false, error: describeError(e).message })
    } finally {
      setTesting(false)
    }
  }

  const columns = useMemo(() => [
    { id: 'when', header: 'When', accessor: 'created_at', width: 170, mobile: 'meta', cell: (r) => <DateText value={r.created_at} withTime /> },
    { id: 'decision', header: 'Decision', accessor: 'decision', filter: 'select', width: 150, mobile: 'trailing', cell: (r) => <DecisionBadge decision={r.decision} /> },
    { id: 'tool', header: 'Action', accessor: 'tool_name', mobile: 'title', minWidth: 200, cell: (r) => <Code>{r.tool_name}</Code> },
    { id: 'kind', header: 'Type', accessor: 'action', filter: 'select', width: 90, cell: (r) => <span className="font-mono text-2xs uppercase tracking-wide text-ink-600">{r.action}</span> },
    { id: 'amount', header: 'Amount', accessor: (r) => (r.amount == null ? null : Number(r.amount)), align: 'right', width: 130, cell: (r) => (r.amount == null ? <span className="text-ink-400">—</span> : <Money amount={Number(r.amount)} currency={r.currency || 'USD'} />) },
    { id: 'source', header: 'Asked by', accessor: 'source', filter: 'select', width: 150, cell: (r) => <span className="font-mono text-xs">{r.source}</span> },
    { id: 'reason', header: 'Reason', accessor: 'reason', minWidth: 260, mobile: 'subtitle', cell: (r) => <span className="line-clamp-2 text-ink-700">{r.reason || '—'}</span> },
    { id: 'risk', header: 'Risk', accessor: 'risk_score', align: 'right', width: 70, cell: (r) => (r.risk_score == null ? <span className="text-ink-400">—</span> : <span className="tabular-nums">{r.risk_score}</span>) },
    { id: 'answer', header: 'Answer', accessor: answerOf, filter: 'select', width: 150, cell: (r) => answerOf(r) || <span className="text-ink-400">—</span> },
  ], [])

  return (
    <>
      <PageHeader
        title="AI Gateway"
        description="Every action an AI takes is checked by EMBMIS Gateway before it happens."
        primary={status?.enabled && status.consoleUrl
          ? <Button variant="primary" icon={ArrowTopRightOnSquareIcon} href={status.consoleUrl} target="_blank" rel="noopener noreferrer">Open Gateway console</Button>
          : undefined}
        secondary={status?.enabled ? <Button icon={SignalIcon} loading={testing} onClick={test}>Test connection</Button> : undefined}
      />

      {statusQ.error && (
        <InlineNotice tone="risk" title="The gateway status could not be read" className="mb-4">
          {describeError(statusQ.error).message} Reload the page; if it persists, give an administrator this time: {new Date().toISOString()}.
        </InlineNotice>
      )}

      {status && !status.enabled && (
        <InlineNotice tone="ink" icon={ShieldCheckIcon} title="EMBMIS Gateway is not connected" className="mb-4">
          <p>Business OS works as before: Simeli and autonomous agents rely on their own approval rules. To have every AI action checked first, an administrator sets these on the server:</p>
          <ul className="mt-2 space-y-1 font-mono text-xs">
            <li>EMBMIS_GATEWAY_URL=https://embmis.com/gateway</li>
            <li>EMBMIS_GATEWAY_PLATFORM_KEY=… (issued by the gateway: <span className="select-all">npm run platform-key</span>)</li>
            <li>EMBMIS_GATEWAY_FAIL_MODE=closed | open</li>
          </ul>
        </InlineNotice>
      )}

      {status?.enabled && (
        <>
          {status.reachable === false && (
            <InlineNotice tone="risk" title="The gateway cannot be reached" className="mb-4">
              {status.error ? `${status.error}. ` : ''}
              {status.failMode === 'closed'
                ? 'Reads continue. Anything that would change a record waits for a person until it is back.'
                : 'Reads continue. Fail mode is open, so changes run WITHOUT a check until it is back.'}
            </InlineNotice>
          )}
          {(!status.platformKeyConfigured || !status.vaultConfigured) && (
            <InlineNotice tone="warn" title="The connection is not fully set up" className="mb-4">
              {!status.platformKeyConfigured && <p>EMBMIS_GATEWAY_PLATFORM_KEY is not set, so this company cannot be registered with the gateway.</p>}
              {!status.vaultConfigured && <p>AI_VAULT_KEY is not set, so there is nowhere safe to store the gateway agent key.</p>}
            </InlineNotice>
          )}
          {tested && (
            <InlineNotice tone={tested.ok ? 'ok' : 'risk'} title={tested.ok ? 'Connected' : 'The test did not pass'} className="mb-4">
              {tested.ok ? 'The gateway answered and this company is registered.' : tested.error}
            </InlineNotice>
          )}

          <SummaryStrip
            className="mb-6"
            facts={[
              { label: 'Connection', value: status.reachable ? 'Connected' : status.reachable === false ? 'Unreachable' : '—', hint: status.version ? `Gateway ${status.version}${status.gatewayMode ? ` · ${status.gatewayMode}` : ''}` : undefined },
              { label: 'If unreachable', value: status.failMode === 'closed' ? 'Writes wait' : 'Writes run', hint: status.failMode === 'closed' ? 'Fail mode: closed. Reads continue.' : 'Fail mode: open. Reads continue.' },
              { label: 'Allowed · 30 days', value: counts ? counts.allowed.toLocaleString() : '—' },
              { label: 'Blocked · 30 days', value: counts ? counts.blocked.toLocaleString() : '—' },
              { label: 'Waiting for a person', value: counts ? counts.waiting.toLocaleString() : '—', hint: counts?.unchecked ? `${counts.unchecked} checks were not made (gateway unreachable)` : undefined },
            ]}
          />

          <section aria-labelledby="gw-conn" className="mb-6 rounded-lg border border-ink-200 bg-surface p-4">
            <h2 id="gw-conn" className="label-mono mb-3">Connection</h2>
            <DescriptionList
              items={[
                { label: 'Gateway', value: <Code>{status.gatewayUrl}</Code> },
                { label: 'Timeout', value: `${status.timeoutMs} ms per check` },
                { label: 'This company in the gateway', value: status.tenant ? <Code>{status.tenant.tenantId}</Code> : 'Registered on the first check' },
                { label: 'Agent', value: status.tenant ? <Code>{status.tenant.agentName}</Code> : '—' },
              ]}
            />
            {status.tenant && !status.tenant.current && (
              <p className="mt-3 text-xs text-warn-700">The stored link is for a different gateway address and will be replaced on the next check.</p>
            )}
            {status.lastError && (
              <p className="mt-3 text-xs text-ink-600">Last problem: {status.lastError.message} <DateText value={status.lastError.at} withTime /></p>
            )}
          </section>

          <section aria-labelledby="gw-decisions">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 id="gw-decisions" className="label-mono">Decisions</h2>
              <Segmented
                label="Show"
                value={filter}
                onChange={setFilter}
                options={[{ value: '', label: 'All' }, { value: 'allow', label: 'Allowed' }, { value: 'escalate', label: 'Sent to a person' }, { value: 'deny', label: 'Blocked' }]}
              />
            </div>
            <DataTable
              viewKey="admin.gateway.decisions"
              caption="EMBMIS Gateway decisions"
              noun="decision"
              rows={rows}
              columns={columns}
              loading={decisionsQ.loading}
              error={decisionsQ.error}
              onRetry={decisionsQ.refetch}
              defaultSort={{ id: 'when', dir: 'desc' }}
              onRowClick={(r) => setOpen(r)}
              empty={{ title: 'No decisions yet', description: 'Decisions appear here as soon as Simeli or an agent tries to do something.' }}
            />
          </section>
        </>
      )}

      {open && <WhyDialog row={open} onClose={() => setOpen(null)} />}
    </>
  )
}

/** One decision, explained: what was asked, which policy decided, which risk factors, where it is in the audit chain. */
function WhyDialog({ row, onClose }) {
  const factors = Array.isArray(row.risk_factors) ? row.risk_factors : []
  return (
    <Dialog open onClose={onClose} title={<span className="flex items-center gap-2"><DecisionBadge decision={row.decision} /> <Code>{row.tool_name}</Code></span>} description={row.reason || 'No reason was recorded.'} size="lg">
      <DescriptionList
        items={[
          { label: 'When', value: <DateText value={row.created_at} withTime /> },
          { label: 'Asked by', value: row.source },
          { label: 'Type', value: row.action },
          { label: 'Amount', value: row.amount == null ? null : <Money amount={Number(row.amount)} currency={row.currency || 'USD'} /> },
          { label: 'Code', value: <Code>{row.code}</Code> },
          { label: 'Decided by', value: row.origin === 'fallback' ? 'The fail mode — the gateway could not be reached' : 'EMBMIS Gateway' },
          { label: 'Matched policy', value: row.matched_policy?.name || (row.origin === 'fallback' ? null : 'None — decided by risk scoring'), wide: true },
          { label: 'Risk score', value: row.risk_score == null ? null : `${row.risk_score} / 100` },
          { label: 'Answer', value: answerOf(row) },
          { label: 'Answered by', value: row.resolved_by },
          { label: 'Trace', value: row.trace_id ? <Code>{row.trace_id}</Code> : null, wide: true },
          { label: 'Audit hash', value: row.audit_hash ? <Code className="break-all">{row.audit_hash}</Code> : null, wide: true },
        ]}
      />
      {factors.length > 0 && (
        <div className="mt-4">
          <h3 className="label-mono mb-2">Risk factors</h3>
          <ul className="space-y-1 text-sm text-ink-800">
            {factors.map((f, i) => (
              <li key={i} className="flex gap-2"><span className="w-10 shrink-0 text-right tabular-nums text-ink-500">+{f.weight}</span><span>{f.detail || f.factor}</span></li>
            ))}
          </ul>
        </div>
      )}
      {row.resolve_error && <InlineNotice tone="warn" title="The answer has not reached the gateway yet" className="mt-4">{row.resolve_error}. It is retried automatically.</InlineNotice>}
    </Dialog>
  )
}
