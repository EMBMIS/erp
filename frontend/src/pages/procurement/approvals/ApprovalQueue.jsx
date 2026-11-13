import { useMemo, useState } from 'react'
import { CheckIcon, XMarkIcon, EyeIcon, ArrowPathIcon, CheckBadgeIcon, ArrowTopRightOnSquareIcon, TrashIcon } from '@heroicons/react/20/solid'
import { useAuth } from '../../../contexts/AuthContext'
import { useResource, useResourceMutation } from '../../../hooks/useResource'
import {
  PageHeader, Button, DataTable, RowAction, BulkAction, StatusBadge, Money, Sheet, ConfirmDialog, InlineNotice,
  EmptyState, DescriptionList, notify,
} from '../../../components/ui'

/**
 * One approval type, presented exactly like the unified queue
 * (pages/UnifiedApprovalPortal.jsx): ranked rows, a review sheet, approve in
 * one click, reject only with a reason.
 *
 * config = {
 *   key, title, description, noun,
 *   fetch({ signal }) → Promise<{ rows, notice? }>   rows: raw records
 *   normalize(raw) → { id, title, subtitle, amount, currency, status, createdBy, createdAt, createdById }
 *   detail(raw) → [[label, value], …]
 *   approve(row) → Promise, decline(row, reason) → Promise
 *   approveLabel, rejectLabel, rejectConsequence, open(row) → href, remove(row) → Promise
 *   invalidates: [[…]]
 * }
 */
const humanAge = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return null
  const h = ms / 36e5
  if (h < 1) return 'under an hour'
  if (h < 24) return `${Math.round(h)} h`
  return `${Math.round(h / 24)} d`
}

export default function ApprovalQueue({ config }) {
  const { user } = useAuth()
  const [selected, setSelected] = useState(null)
  const [reject, setReject] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [bulk, setBulk] = useState(null)
  const [processing, setProcessing] = useState(() => new Set())

  const { data, loading, error, refetch } = useResource(['approval-queue', config.key], async ({ signal }) => ({ data: { success: true, data: await config.fetch({ signal }) } }))
  const rows = useMemo(() => (data?.rows || []).map((raw) => {
    const r = config.normalize(raw)
    const ageMs = r.createdAt ? Date.now() - new Date(r.createdAt).getTime() : null
    return { ...r, raw, ageMs, escalated: ageMs != null && ageMs > 3 * 864e5, own: Boolean(user?.id && r.createdById && r.createdById === user.id) }
  }), [data, config, user?.id])

  const invalidates = [['approval-queue', config.key], ['approval-inbox'], ...(config.invalidates || [])]
  const approveM = useResourceMutation((row) => config.approve(row), { invalidates, silent: true })
  const declineM = useResourceMutation(({ row, reason }) => config.decline(row, reason), { invalidates, silent: true })
  const removeM = useResourceMutation((row) => config.remove(row), { invalidates, silent: true })

  const busy = (r) => processing.has(String(r.id))
  const track = async (r, fn) => {
    setProcessing((p) => new Set(p).add(String(r.id)))
    try { return await fn() } finally {
      setProcessing((p) => { const n = new Set(p); n.delete(String(r.id)); return n })
    }
  }
  const fail = (verb, r, e) => {
    const d = e?.response?.data || {}
    notify.error(`${r.title} was not ${verb}: ${d.error || e.message}${d.error_id ? ` (reference ${d.error_id})` : ''}`)
  }

  const approve = (r) => track(r, async () => {
    try {
      const res = await approveM.mutateAsync(r)
      notify.success(res?.message || `${r.title} ${config.approvedVerb || 'approved'}`)
      setSelected(null)
    } catch (e) { fail(config.approvedVerb || 'approved', r, e) }
  })
  const decline = (r, reason) => track(r, async () => {
    try {
      await declineM.mutateAsync({ row: r, reason })
      notify.success(`${r.title} ${config.rejectedVerb || 'rejected'}`)
      setSelected(null)
    } catch (e) { fail(config.rejectedVerb || 'rejected', r, e) }
  })

  const columns = [
    {
      id: 'ref', header: config.noun.charAt(0).toUpperCase() + config.noun.slice(1), accessor: (r) => `${r.title} ${r.subtitle || ''}`, minWidth: 220, maxWidth: 360, mobile: 'title',
      cell: (r) => (
        <span className="block min-w-0">
          <span className="block truncate font-mono text-[0.92em]">{r.title}</span>
          {r.subtitle && <span className="block truncate text-xs text-ink-500">{r.subtitle}</span>}
        </span>
      ),
    },
    { id: 'amount', header: 'Amount', accessor: (r) => (r.amount != null && r.amount !== '' ? Number(r.amount) : null), align: 'right', width: 140, mobile: 'trailing', filter: 'number', cell: (r) => <Money amount={r.amount != null && r.amount !== '' ? r.amount : null} currency={r.currency || 'USD'} /> },
    {
      id: 'age', header: 'Waiting', accessor: (r) => r.ageMs, align: 'right', width: 110, mobile: 'meta',
      cell: (r) => (r.ageMs == null ? <span className="text-ink-400">—</span> : (
        <span className={r.escalated ? 'font-medium text-warn-700' : 'text-ink-700'} title={r.escalated ? 'Waiting more than 3 days' : undefined}>
          {r.escalated && <span aria-hidden="true">▲ </span>}{humanAge(r.ageMs)}
        </span>
      )),
    },
    { id: 'by', header: 'Requested by', accessor: 'createdBy', width: 150, cell: (r) => r.createdBy || <span className="text-ink-400">—</span> },
    { id: 'status', header: 'Status', accessor: 'status', width: 170, defaultHidden: true, cell: (r) => <StatusBadge status={r.status} /> },
  ]

  const approveLabel = config.approveLabel || 'Approve'
  const rejectLabel = config.rejectLabel || 'Reject'
  const sel = selected && rows.find((r) => String(r.id) === String(selected.id))

  return (
    <div className="space-y-5">
      <PageHeader
        title={config.title}
        description={config.description}
        secondary={
          <>
            <Button variant="ghost" icon={ArrowPathIcon} onClick={() => refetch()}>Refresh</Button>
            <Button to={`/approvals/unified?tab=${config.inboxTab || config.key}`}>Open in the approvals inbox</Button>
          </>
        }
      />

      {data?.notice && <InlineNotice tone="ink" title="Your authority">{data.notice}</InlineNotice>}

      <DataTable
        viewKey={`approvals.${config.key}`}
        caption={config.title}
        noun={config.noun}
        rows={rows}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        defaultSort={{ id: 'age', dir: 'desc' }}
        onOpen={(r) => setSelected(r)}
        rowClassName={(r) => (sel && String(sel.id) === String(r.id) ? '!bg-brand-50' : busy(r) ? 'opacity-60' : undefined)}
        searchPlaceholder="Search reference, party or requester"
        selectable
        isRowSelectable={(r) => !r.own}
        bulkActions={(s, clear) => <BulkAction tone="primary" icon={CheckIcon} onClick={() => { setBulk(s); clear() }}>{approveLabel} {s.length}</BulkAction>}
        rowActions={(r) => (
          <>
            <RowAction icon={EyeIcon} label={`Review ${r.title}`} onClick={() => setSelected(r)} />
            <RowAction icon={CheckIcon} label={`${approveLabel} ${r.title}`} disabled={busy(r) || r.own} reason={r.own ? 'You raised this; someone else must approve it.' : undefined} onClick={() => approve(r)} />
            <RowAction icon={XMarkIcon} tone="risk" label={`${rejectLabel} ${r.title}`} disabled={busy(r)} onClick={() => setReject(r)} />
          </>
        )}
        empty={
          <EmptyState
            icon={CheckBadgeIcon}
            title="You are clear"
            description={data?.notice ? data.notice : `No ${config.noun}s are waiting on a decision from you.`}
            action={<Button to="/approvals/unified">Open the approvals inbox</Button>}
          />
        }
      />

      <Sheet
        open={Boolean(sel)}
        onClose={() => setSelected(null)}
        width="lg"
        title={sel ? `${config.noun.charAt(0).toUpperCase() + config.noun.slice(1)}: ${sel.title}` : ''}
        description={sel?.subtitle}
        footer={sel && (
          <>
            {config.open && <Button variant="ghost" icon={ArrowTopRightOnSquareIcon} to={config.open(sel)}>Open record</Button>}
            {config.remove && <Button variant="ghost" icon={TrashIcon} onClick={() => setRemoving(sel)} disabled={busy(sel)}>Delete</Button>}
            <span className="flex-1" />
            <Button variant="destructive" icon={XMarkIcon} onClick={() => setReject(sel)} disabled={busy(sel)}>{rejectLabel}</Button>
            <Button variant="primary" icon={CheckIcon} loading={busy(sel)} disabled={sel.own} title={sel.own ? 'You raised this; someone else must approve it.' : undefined} onClick={() => approve(sel)}>{approveLabel}</Button>
          </>
        )}
      >
        {sel && (
          <div className="space-y-4 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={sel.status} />
              {sel.amount != null && sel.amount !== '' && <Money amount={sel.amount} currency={sel.currency || 'USD'} className="text-base font-semibold" />}
            </div>
            {sel.own && <InlineNotice tone="ink">You raised this, so separation of duties requires someone else to approve it.</InlineNotice>}
            {config.why && (
              <section className="rounded-lg border border-ink-200 p-3">
                <h3 className="label-mono mb-1">What approving does</h3>
                <p className="text-sm text-ink-800">{config.why}</p>
              </section>
            )}
            <DescriptionList items={config.detail(sel.raw).filter(([, v]) => v != null && v !== '' && v !== '—').map(([label, value]) => ({ label, value, wide: typeof value === 'string' && value.length > 60 }))} />
          </div>
        )}
      </Sheet>

      {reject && (
        <ConfirmDialog
          open
          onClose={() => setReject(null)}
          title={`${rejectLabel} ${reject.title}?`}
          consequence={config.rejectConsequence || `The ${config.noun} goes back to its requester as rejected, with your reason.`}
          confirmLabel={`${rejectLabel} ${reject.title}`}
          requireReason
          busy={busy(reject)}
          onConfirm={async (reason) => { const r = reject; await decline(r, reason); setReject(null) }}
        />
      )}

      {removing && (
        <ConfirmDialog
          open
          onClose={() => setRemoving(null)}
          title={`Delete ${removing.title}?`}
          consequence={`The ${config.noun} is removed for everyone, not just from this queue.`}
          confirmLabel={`Delete ${removing.title}`}
          confirmText={removing.title}
          busy={removeM.isPending}
          onConfirm={async () => {
            const r = removing
            try { await removeM.mutateAsync(r); notify.success(`${r.title} deleted`); setSelected(null) } catch (e) { fail('deleted', r, e) }
            setRemoving(null)
          }}
        />
      )}

      {bulk && (
        <ConfirmDialog
          open
          tone="primary"
          onClose={() => setBulk(null)}
          title={`${approveLabel} ${bulk.length} ${config.noun}${bulk.length === 1 ? '' : 's'}?`}
          consequence={`${bulk.map((r) => r.title).slice(0, 6).join(', ')}${bulk.length > 6 ? ` and ${bulk.length - 6} more` : ''}. ${config.why || ''}`}
          confirmLabel={`${approveLabel} ${bulk.length}`}
          onConfirm={async () => {
            const target = bulk
            setBulk(null)
            const failures = []
            for (const r of target) {
              try { await track(r, () => approveM.mutateAsync(r)) } catch (e) { failures.push(e) }
            }
            const ok = target.length - failures.length
            if (ok) notify.success(`${ok} ${config.approvedVerb || 'approved'}`)
            if (failures.length) notify.error(`${failures.length} of ${target.length} not done: ${failures[0]?.response?.data?.error || failures[0]?.message || 'server error'}`)
          }}
        />
      )}
    </div>
  )
}
