import { useState } from 'react'
import {
  ArrowPathIcon, CheckCircleIcon, DocumentMagnifyingGlassIcon, HandRaisedIcon, LightBulbIcon, LockClosedIcon, ShieldCheckIcon, XMarkIcon,
} from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, Segmented, Select, Field, Badge, StatusBadge, Code, Money, Dialog, ConfirmDialog, InlineNotice,
  EmptyState, ErrorState, SkeletonRows, SimeliMark, MaturityBadge, DateText, notify, describeError,
} from '../../components/ui'

const STATUSES = [
  { value: 'OPEN', label: 'Open' },
  { value: 'ACKNOWLEDGED', label: 'Acknowledged' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'DISMISSED', label: 'Dismissed' },
]
const SEVERITY_TONE = { HIGH: 'risk', MEDIUM: 'warn', LOW: 'ink' }

/**
 * Pull the proposed correcting action (a DRAFT journal entry — "Simeli
 * proposes, a person approves") out of a finding's JSONB payload. The backend
 * may store it under several shapes; every one resolves to a JE-ish object.
 */
function extractProposedAction(f) {
  const d = f?.data && typeof f.data === 'object' ? f.data : {}
  let je = d.draft_je || null
  if (!je && d.proposed_action && typeof d.proposed_action === 'object') {
    je = d.proposed_action.payload || (d.proposed_action.journal_entry ? d.proposed_action.journal_entry : null)
  }
  if (!je && d.action && typeof d.action === 'object') je = d.action.journal_entry || d.action.payload || null
  if (!je) return null
  return { type: d.action?.type || d.proposed_action?.type || 'POST_DRAFT_JOURNAL_ENTRY', je }
}

function DraftJournalPreview({ proposed }) {
  if (!proposed) return null
  const { type, je } = proposed
  const lines = Array.isArray(je?.lines) ? je.lines : Array.isArray(je?.line_items) ? je.line_items : []
  return (
    <div className="space-y-2 rounded-md border border-ink-200 bg-sunken p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="label-mono">Proposed: {String(type).replace(/_/g, ' ').toLowerCase()}</span>
        {je?.journal_number && <Code>{je.journal_number}</Code>}
      </div>
      {lines.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="border-b border-ink-200 text-left">
                <th className="label-mono py-1 pr-3">Account</th>
                <th className="label-mono py-1 pr-3">Description</th>
                <th className="label-mono py-1 pr-3 text-right">Debit</th>
                <th className="label-mono py-1 text-right">Credit</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, i) => (
                <tr key={i} className="border-b border-ink-100">
                  <td className="py-1 pr-3"><Code>{line.account_code || line.account || '—'}</Code></td>
                  <td className="py-1 pr-3 text-ink-700">{line.description || line.account_name || ''}</td>
                  <td className="py-1 pr-3 text-right">{line.debit != null ? <Money amount={line.debit} muted={false} /> : '—'}</td>
                  <td className="py-1 text-right">{line.credit != null ? <Money amount={line.credit} muted={false} /> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-ink-600">{je?.description || je?.title || 'A draft journal entry is attached (line detail unavailable).'}</p>
      )}
      {je?.entry_date && <p className="text-xs text-ink-500">Entry date <DateText value={je.entry_date} /></p>}
    </div>
  )
}

/** One finding in Simeli's anatomy: what it read, what it concluded, what it proposes. */
function FindingCard({ f, canAct, onApprove, onDismiss }) {
  const proposed = extractProposedAction(f)
  return (
    <li className="rounded-lg border border-ink-200 bg-surface">
      <header className="flex flex-wrap items-center gap-2 border-b border-ink-200 px-4 py-2.5">
        <SimeliMark />
        <h2 className="min-w-0 flex-1 text-sm font-semibold text-fg">{f.title || 'Anomaly found'}</h2>
        <Badge tone={SEVERITY_TONE[f.severity] || 'ink'}>{String(f.severity || 'unrated').toLowerCase()} severity</Badge>
        <StatusBadge status={f.status} />
      </header>
      <div className="space-y-3 p-4">
        <div className="space-y-1">
          <p className="label-mono flex items-center gap-1.5"><DocumentMagnifyingGlassIcon className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />Read</p>
          <p className="flex flex-wrap gap-1.5 text-xs">
            <Code>{f.finding_type || 'ANOMALY'}</Code>
            {f.entity_type && <Code>{f.entity_type}{f.entity_id ? ` ${String(f.entity_id).slice(0, 8)}` : ''}</Code>}
            {f.created_at && <span className="text-ink-500">raised <DateText value={f.created_at} relative /></span>}
          </p>
        </div>
        {f.description && (
          <div className="space-y-1">
            <p className="label-mono flex items-center gap-1.5"><LightBulbIcon className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />Concluded</p>
            <p className="text-sm text-ink-800">{f.description}</p>
          </div>
        )}
        {f.status === 'DISMISSED' && f.dismiss_reason && <p className="text-xs text-ink-600">Dismissed because: “{f.dismiss_reason}”</p>}
        {proposed && (
          <div className="space-y-1">
            <p className="label-mono flex items-center gap-1.5"><HandRaisedIcon className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />Proposes — needs your approval</p>
            <details>
              <summary className="cursor-pointer text-sm text-ink-700">Show the draft journal entry</summary>
              <div className="mt-2"><DraftJournalPreview proposed={proposed} /></div>
            </details>
          </div>
        )}
        {canAct && (
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" variant="primary" icon={CheckCircleIcon} onClick={() => onApprove(f)}>Review and approve</Button>
            <Button size="sm" variant="ghost" icon={XMarkIcon} onClick={() => onDismiss(f)}>Dismiss</Button>
          </div>
        )}
      </div>
      <footer className="flex items-center gap-1.5 border-t border-ink-200 px-4 py-2 text-2xs text-ink-500">
        <LockClosedIcon className="h-3 w-3" aria-hidden="true" />
        Simeli read only records your role can see. Nothing is posted until a person approves it.
      </footer>
    </li>
  )
}

/**
 * Findings — anomalies Simeli's scans raised, each with the correction it
 * proposes. Approving executes the proposal (posts the draft entry) through
 * POST /ai-findings/:id/approve; dismissing records why, so the next sweep does
 * not raise it again.
 */
export default function AIFindingsDashboard() {
  const [statusFilter, setStatusFilter] = useState('OPEN')
  const [severityFilter, setSeverityFilter] = useState('')
  const [approving, setApproving] = useState(null)
  const [dismissing, setDismissing] = useState(null)
  const [scanResult, setScanResult] = useState(null)

  const filters = { status: statusFilter, severity: severityFilter }
  const { data, loading, error, refetch } = useResource(
    keys.aiFindings(filters),
    ({ signal }) => {
      let url = `/ai-findings?status=${statusFilter}`
      if (severityFilter) url += `&severity=${severityFilter}`
      return api.get(url, { signal })
    },
  )
  const findings = Array.isArray(data) ? data : []

  // /ai-findings/scan answers with fields at the top level, so the flat body
  // is re-wrapped before unwrap() sees it.
  const runScan = useResourceMutation(
    () => api.post('/ai-findings/scan')
      .then((res) => ({ data: { success: res.data?.success !== false, error: res.data?.error, data: res.data } })),
    { invalidates: [['ai-findings']], silent: true },
  )

  const updateStatus = useResourceMutation(
    ({ id, newStatus, reason }) => api.patch(`/ai-findings/${id}`, { status: newStatus, reason }),
    { invalidates: [['ai-findings']], silent: true },
  )

  const approveFinding = useResourceMutation(
    async ({ id, note }) => {
      try {
        const res = await api.post(`/ai-findings/${id}/approve`, { note })
        return res.data?.data ?? res.data
      } catch (err) {
        // Older backends without the approve route: fall back to the status
        // transition so the approval is still recorded.
        if (err.response && [404, 405].includes(err.response.status)) {
          const res = await api.patch(`/ai-findings/${id}`, { status: 'APPROVED' })
          return res.data?.data ?? res.data
        }
        throw err
      }
    },
    { invalidates: [['ai-findings']], silent: true },
  )

  const handleRunScan = async () => {
    setScanResult(null)
    try {
      const res = await runScan.mutateAsync()
      setScanResult({ tone: 'ok', text: `Scan complete — ${res?.new_findings || res?.total_new || 0} new finding(s).` })
    } catch (err) {
      setScanResult({ tone: 'risk', text: `The scan did not run — ${describeError(err).message}` })
    }
  }

  const handleApprove = async () => {
    try {
      await approveFinding.mutateAsync({ id: approving.id, note: 'Approved by user from the findings screen' })
      notify.success('Approved — the proposed action was executed')
    } catch (err) {
      notify.error(`Not approved — ${describeError(err).message}`)
    } finally {
      setApproving(null)
    }
  }

  const handleDismiss = async (reason) => {
    try {
      await updateStatus.mutateAsync({ id: dismissing.id, newStatus: 'DISMISSED', reason })
      notify.success('Finding dismissed — reason recorded')
    } catch (err) {
      notify.error(`Not dismissed — ${describeError(err).message}`)
    } finally {
      setDismissing(null)
    }
  }

  const proposed = approving ? extractProposedAction(approving) : null

  return (
    <div className="space-y-5">
      <PageHeader
        title="Findings"
        badge={<MaturityBadge level="beta" />}
        description="Anomalies Simeli's scans raised in your ledger and operations, each with the correction it proposes. Nothing is posted until a person approves it."
        primary={<Button variant="primary" icon={ArrowPathIcon} onClick={handleRunScan} loading={runScan.isPending}>{runScan.isPending ? 'Scanning…' : 'Run a scan'}</Button>}
      />

      {scanResult && (
        <InlineNotice tone={scanResult.tone} action={<Button size="sm" variant="ghost" onClick={() => setScanResult(null)}>Dismiss</Button>}>{scanResult.text}</InlineNotice>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <Segmented label="Status" value={statusFilter} onChange={setStatusFilter} options={STATUSES} className="max-w-full overflow-x-auto" />
        <Field label="Severity" className="sm:w-48">
          <Select value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)}>
            <option value="">All severities</option>
            <option value="HIGH">High</option>
            <option value="MEDIUM">Medium</option>
            <option value="LOW">Low</option>
          </Select>
        </Field>
      </div>

      {error ? (
        <ErrorState error={error} what="Findings" onRetry={refetch} />
      ) : loading ? (
        <SkeletonRows rows={4} columns={2} />
      ) : findings.length === 0 ? (
        <EmptyState
          icon={ShieldCheckIcon}
          title={`No ${STATUSES.find((s) => s.value === statusFilter)?.label.toLowerCase()} findings`}
          description={statusFilter === 'OPEN' ? 'Nothing is waiting for review. Run a scan to check the ledger and operations again.' : 'Findings move here as people act on them.'}
          action={statusFilter === 'OPEN' ? <Button icon={ArrowPathIcon} onClick={handleRunScan} loading={runScan.isPending}>Run a scan</Button> : null}
        />
      ) : (
        <ul className="space-y-3">
          {findings.map((f) => (
            <FindingCard key={f.id} f={f} canAct={statusFilter === 'OPEN'} onApprove={setApproving} onDismiss={setDismissing} />
          ))}
        </ul>
      )}

      {/* Posting a draft entry is a real ledger write: one explicit confirm. */}
      <Dialog
        open={!!approving}
        onClose={() => setApproving(null)}
        title="Approve and execute this finding?"
        description={approving?.title}
        footer={(
          <>
            <Button onClick={() => setApproving(null)}>Cancel</Button>
            <Button variant="primary" icon={CheckCircleIcon} onClick={handleApprove} loading={approveFinding.isPending}>Approve and execute</Button>
          </>
        )}
      >
        <div className="space-y-3">
          {proposed ? <DraftJournalPreview proposed={proposed} /> : (
            <InlineNotice tone="ink">No draft journal entry is attached. Approving records the finding as approved.</InlineNotice>
          )}
          <p className="text-xs font-medium text-risk-600">Posting to the ledger cannot be undone from here; a reversing entry would be needed.</p>
        </div>
      </Dialog>

      <ConfirmDialog
        open={!!dismissing}
        onClose={() => setDismissing(null)}
        onConfirm={handleDismiss}
        title="Dismiss this finding?"
        consequence={`“${dismissing?.title || 'This finding'}” is closed without action. The reason is kept so the next scan does not raise it again.`}
        reversible
        requireReason
        reasonLabel="Why are you dismissing it?"
        reasonHelp="For example: reviewed with AP, the duplicate is intentional."
        confirmLabel="Dismiss with reason"
        tone="primary"
        busy={updateStatus.isPending}
      />
    </div>
  )
}
