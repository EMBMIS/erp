import { useMemo, useState } from 'react'
import { LockClosedIcon, LockOpenIcon, ClipboardDocumentCheckIcon } from '@heroicons/react/20/solid'
import api, { accountingPeriodsAPI } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import {
  PageHeader, Button, Card, DataTable, RowAction, StatusBadge, Select, Field, InlineNotice, ErrorState, ConfirmDialog,
  DateText, Badge, SkeletonRows, notify, describeError,
} from '../../components/ui'

/**
 * Accounting periods — open and close months. Closing a month locks its
 * ledger against back-dated postings and runs the blocking pre-close gates.
 * Choose a month to see where it stands against those gates.
 */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const INVALIDATES = [['accounting-periods'], ['journal-entries'], ['trial-balance'], ['balance-sheet'], ['income-statement']]

export default function AccountingPeriods() {
  const { user } = useAuth()
  const canManage = ['ADMIN', 'MANAGER'].includes(user?.role)
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [selected, setSelected] = useState(now.getMonth() + 1)
  const [confirm, setConfirm] = useState(null) // { month, action: 'close' | 'reopen' }
  const [refusal, setRefusal] = useState(null) // { month, message, checks }

  const { data, loading, error, refetch } = useResource(
    ['accounting-periods', year],
    ({ signal }) => api.get('/accounting-periods', { params: { year }, signal }),
  )
  const periods = useMemo(() => (Array.isArray(data) ? data : []), [data])

  const rows = useMemo(() => MONTHS.map((name, i) => {
    const month = i + 1
    const row = periods.find((p) => Number(p.period_month) === month && Number(p.period_year) === year)
    return { id: month, month, name, status: row?.status || 'OPEN', closed_at: row?.closed_at, closed_by_name: row?.closed_by_name, notes: row?.notes, recorded: Boolean(row) }
  }), [periods, year])

  const close = useResourceMutation(({ month }) => accountingPeriodsAPI.close(year, month), { invalidates: INVALIDATES, silent: true })
  const reopen = useResourceMutation(({ month }) => accountingPeriodsAPI.reopen(year, month), { invalidates: INVALIDATES, silent: true })

  const run = async () => {
    const { month, action } = confirm
    const label = `${MONTHS[month - 1]} ${year}`
    setRefusal(null)
    try {
      if (action === 'close') await close.mutateAsync({ month })
      else await reopen.mutateAsync({ month })
      notify.success(action === 'close' ? `${label} closed — postings locked` : `${label} reopened`)
    } catch (e) {
      setRefusal({ month, message: describeError(e).message, checks: e?.response?.data?.checks || null, error: e })
    } finally {
      setConfirm(null)
    }
  }

  const columns = [
    { id: 'month', header: 'Month', accessor: 'month', cell: (r) => <span className="font-medium">{r.name}</span>, width: 160, mobile: 'title' },
    { id: 'status', header: 'Status', accessor: 'status', cell: (r) => <StatusBadge status={r.status} />, width: 120, mobile: 'meta' },
    { id: 'closed_at', header: 'Closed', accessor: 'closed_at', cell: (r) => (r.status === 'CLOSED' ? <DateText value={r.closed_at} withTime /> : <span className="text-ink-400">—</span>), width: 190, mobile: 'subtitle' },
    { id: 'closed_by', header: 'Closed by', accessor: 'closed_by_name', cell: (r) => (r.status === 'CLOSED' ? r.closed_by_name || '—' : <span className="text-ink-400">—</span>), width: 160 },
    { id: 'notes', header: 'Notes', accessor: 'notes', cell: (r) => r.notes || <span className="text-ink-400">—</span>, minWidth: 160 },
  ]

  const sel = rows[selected - 1]

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Accounting periods"
        description="Close a month to lock its ledger against back-dated postings."
        secondary={
          <Field label="Year" className="w-28">
            <Select size="sm" value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {Array.from({ length: 6 }, (_, i) => now.getFullYear() - 3 + i).map((y) => <option key={y} value={y}>{y}</option>)}
            </Select>
          </Field>
        }
      />

      {!canManage && (
        <InlineNotice tone="ink" className="mb-4">
          You can see period status. Closing or reopening a period needs a Manager or Admin role.
        </InlineNotice>
      )}

      {refusal && (
        <InlineNotice tone="risk" className="mb-4" title={`${MONTHS[refusal.month - 1]} ${year} was not changed`} action={<Button size="sm" variant="ghost" onClick={() => setRefusal(null)}>Dismiss</Button>}>
          {refusal.checks ? 'These blocking checks failed:' : refusal.message}
          {refusal.checks && (
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {refusal.checks.filter((c) => !c.passed && c.severity === 'BLOCKING').map((c) => <li key={c.key || c.name}>{c.name}{c.details ? ` — ${c.details}` : ''}</li>)}
            </ul>
          )}
        </InlineNotice>
      )}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <DataTable
          viewKey="finance.periods"
          caption={`Accounting periods, ${year}`}
          noun="month"
          rows={rows}
          columns={columns}
          loading={loading}
          error={error}
          onRetry={refetch}
          search={false}
          onRowClick={(r) => setSelected(r.month)}
          rowClassName={(r) => (r.month === selected ? 'bg-ink-50' : undefined)}
          rowActions={canManage ? (r) => (
            r.status === 'CLOSED'
              ? <RowAction icon={LockOpenIcon} label={`Reopen ${r.name} ${year}`} onClick={() => setConfirm({ month: r.month, action: 'reopen' })} />
              : <RowAction icon={LockClosedIcon} label={`Close ${r.name} ${year}`} onClick={() => setConfirm({ month: r.month, action: 'close' })} />
          ) : undefined}
        />

        <aside className="min-w-0 space-y-4">
          <Card
            title={`${sel.name} ${year}`}
            description="Where this month stands against the pre-close gates."
            actions={<StatusBadge status={sel.status} />}
          >
            <PreCloseChecks year={year} month={selected} />
            {canManage && (
              <div className="mt-4 border-t border-ink-200 pt-3">
                {sel.status === 'CLOSED' ? (
                  <Button icon={LockOpenIcon} onClick={() => setConfirm({ month: selected, action: 'reopen' })}>Reopen {sel.name}</Button>
                ) : (
                  <Button variant="primary" icon={LockClosedIcon} onClick={() => setConfirm({ month: selected, action: 'close' })}>Close {sel.name}</Button>
                )}
                <p className="mt-2 text-xs text-ink-500">Closing runs the blocking checks first and is refused if any fail.</p>
              </div>
            )}
          </Card>
        </aside>
      </div>

      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={run}
          title={confirm.action === 'close' ? `Close ${MONTHS[confirm.month - 1]} ${year}?` : `Reopen ${MONTHS[confirm.month - 1]} ${year}?`}
          consequence={confirm.action === 'close'
            ? 'Postings dated in this month are locked. A closing entry zeroes the month’s revenue and expense accounts into Retained Earnings. The close is refused if a blocking check fails.'
            : 'Postings dated in this month are allowed again. Reports for the month may change until it is closed again.'}
          reversible
          confirmLabel={confirm.action === 'close' ? `Close ${MONTHS[confirm.month - 1]}` : `Reopen ${MONTHS[confirm.month - 1]}`}
          tone={confirm.action === 'close' ? 'primary' : 'danger'}
          busy={close.isPending || reopen.isPending}
        />
      )}
    </div>
  )
}

/** The pre-close gates for one month, read-only. */
function PreCloseChecks({ year, month }) {
  const { data, loading, error, refetch } = useResource(
    ['accounting-periods', 'pre-close', year, month],
    ({ signal }) => api.get(`/accounting-periods/${year}/${month}/pre-close-checks`, { signal }),
    { staleTime: 0, retry: false }
  )
  if (loading) return <SkeletonRows rows={4} columns={2} />
  if (error) {
    return (
      <div>
        <ErrorState compact className="py-0" error={error} what="The pre-close checks" onRetry={refetch} />
        <p className="mt-2 text-xs text-ink-500">Closing still runs the blocking checks on the server; if one fails, the close is refused and the failures are listed above the table.</p>
      </div>
    )
  }
  const checks = data?.checks || []
  if (!checks.length) return <p className="text-sm text-ink-600">No checks were returned for this month.</p>
  return (
    <div>
      <p className="mb-2 text-sm text-ink-700">
        <span className="font-semibold tabular-nums">{data.passed}</span> of <span className="tabular-nums">{data.total}</span> checks pass
        {data.blocking_passed ? ' · no blocking failures' : ''}
      </p>
      <ul className="divide-y divide-ink-100">
        {checks.map((c) => (
          <li key={c.key || c.name} className="flex items-start justify-between gap-3 py-1.5 text-sm" title={c.details || undefined}>
            <span className="flex min-w-0 items-start gap-2">
              <ClipboardDocumentCheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-ink-800">{c.name}</span>
                {!c.passed && c.details && <span className="block text-xs text-ink-500">{c.details}</span>}
              </span>
            </span>
            {c.passed ? <Badge tone="ok" glyph="check">Clear</Badge> : c.severity === 'BLOCKING' ? <Badge tone="risk" glyph="cross">Blocking</Badge> : <Badge tone="warn" glyph="triangle">Warning</Badge>}
          </li>
        ))}
      </ul>
    </div>
  )
}
