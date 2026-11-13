import { useMemo, useState } from 'react'
import {
  PlusIcon, EyeIcon, TrashIcon, CheckCircleIcon, XCircleIcon, PaperAirplaneIcon, ArrowUturnLeftIcon, BookmarkSquareIcon,
  DocumentTextIcon, ArrowDownTrayIcon,
} from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, DataTable, RowAction, StatusBadge, Badge, Money, Code, DateText, Segmented, ConfirmDialog, Sheet,
  DescriptionList, Stat, Num, Input, InlineNotice, ErrorState, SkeletonRows, notify, exportCsv,
} from '../../components/ui'

/**
 * Journal entries — the ledger itself. Draft → submit → approve → post; a
 * posted entry is corrected by reversing it, never by editing.
 */
// Any status change, reversal or delete moves the ledger every report reads.
const LEDGER_INVALIDATES = [['journal-entries'], ['trial-balance'], ['balance-sheet'], ['income-statement']]
const LIMIT = 1000

const QUICK = {
  all: { label: 'All', test: () => true },
  draft: { label: 'Drafts', test: (e) => e.status === 'DRAFT' },
  pending: { label: 'Waiting approval', test: (e) => e.status === 'PENDING_APPROVAL' },
  approved: { label: 'Ready to post', test: (e) => e.status === 'APPROVED' },
  posted: { label: 'Posted', test: (e) => e.status === 'POSTED' },
  rejected: { label: 'Rejected', test: (e) => e.status === 'REJECTED' },
}
const humanize = (s) => String(s || '').toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

export default function JournalEntriesList() {
  const [quick, setQuick] = useState('all')
  const [range, setRange] = useState({ from: '', to: '' })
  const [confirm, setConfirm] = useState(null) // { kind, entry }
  const [viewing, setViewing] = useState(null)

  // staleTime: 0 — journal entries are the ledger itself.
  const params = { limit: LIMIT, ...(range.from ? { entry_date_from: range.from } : {}), ...(range.to ? { entry_date_to: range.to } : {}) }
  const { data, loading, error, refetch } = useResource(
    keys.journalEntries(params),
    ({ signal }) => api.get(`/journal-entries?${new URLSearchParams(params).toString()}`, { signal }),
    { staleTime: 0 }
  )
  const entries = useMemo(() => (Array.isArray(data) ? data : []), [data])
  const { data: stats, loading: statsLoading } = useResource(keys.journalEntriesStats(), ({ signal }) => api.get('/journal-entries/stats', { signal }), { staleTime: 0 })

  const statusUpdate = useResourceMutation(
    ({ entryId, newStatus, reason }) => api.put(`/journal-entries/${entryId}/status`, { status: newStatus, reason }),
    { invalidates: LEDGER_INVALIDATES, silent: true }
  )
  const reverseEntry = useResourceMutation(({ entryId, reason }) => api.post(`/journal-entries/${entryId}/reverse`, { reason }), { invalidates: LEDGER_INVALIDATES, silent: true })
  const deleteEntry = useResourceMutation((id) => api.delete(`/journal-entries/${id}`), { invalidates: LEDGER_INVALIDATES, silent: true })

  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, entries.filter(q.test).length])), [entries])

  const columns = useMemo(() => [
    { id: 'number', header: 'Entry', accessor: 'journal_number', cell: (e) => <Code>{e.journal_number}</Code>, width: 160, mobile: 'title' },
    { id: 'date', header: 'Date', accessor: 'entry_date', cell: (e) => <DateText value={e.entry_date} />, width: 120 },
    {
      id: 'description', header: 'Description', accessor: 'description', filter: 'text', minWidth: 220, mobile: 'subtitle',
      cell: (e) => (
        <span className="block min-w-0">
          <span className="block truncate">{e.description || '—'}</span>
          {e.reference && <span className="block truncate font-mono text-2xs text-ink-500">Ref {e.reference}</span>}
        </span>
      ),
    },
    { id: 'source', header: 'Source', accessor: (e) => e.source_type || 'MANUAL', filter: 'select', cell: (e) => <span className="text-ink-700">{humanize(e.source_type || 'MANUAL')}{e.source_document && <Code className="ml-1.5 text-ink-500">{e.source_document}</Code>}</span>, width: 170 },
    {
      id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 190, mobile: 'meta',
      cell: (e) => <span className="flex items-center gap-1.5"><StatusBadge status={e.status} />{e.is_reversing_entry && <Badge mono>Reversal</Badge>}</span>,
    },
    { id: 'lines', header: 'Lines', accessor: (e) => Number(e.line_count) || 0, align: 'right', width: 70 },
    {
      id: 'debit', header: 'Debits', accessor: (e) => Number(e.total_debit), align: 'right', filter: 'number', width: 140, mobile: 'trailing',
      cell: (e) => <Money amount={e.total_debit} currency={e.currency || 'USD'} />, exportValue: (e) => e.total_debit,
    },
    { id: 'credit', header: 'Credits', accessor: (e) => Number(e.total_credit), align: 'right', width: 140, defaultHidden: true, cell: (e) => <Money amount={e.total_credit} currency={e.currency || 'USD'} />, exportValue: (e) => e.total_credit },
    { id: 'currency', header: 'Currency', accessor: 'currency', width: 90, defaultHidden: true, filter: 'select' },
    { id: 'createdBy', header: 'Created by', accessor: 'created_by_name', filter: 'text', width: 140 },
  ], [])

  const run = async (reason) => {
    const { kind, entry } = confirm
    try {
      if (kind === 'delete') await deleteEntry.mutateAsync(entry.id)
      else if (kind === 'reverse') await reverseEntry.mutateAsync({ entryId: entry.id, reason })
      else {
        const newStatus = { submit: 'PENDING_APPROVAL', approve: 'APPROVED', reject: 'REJECTED', post: 'POSTED' }[kind]
        await statusUpdate.mutateAsync({ entryId: entry.id, newStatus, reason: reason || '' })
      }
      const verb = { submit: 'submitted for approval', approve: 'approved', reject: 'rejected', post: 'posted to the ledger', reverse: 'reversed', delete: 'deleted' }[kind]
      notify.success(`${entry.journal_number} ${verb}`)
      setConfirm(null)
      if (viewing?.id === entry.id) setViewing(null)
    } catch (e) {
      setConfirm(null)
      notify.error(`${entry.journal_number} not changed — ${e?.response?.data?.error || e.message}`)
    }
  }

  const copy = confirm && (() => {
    const n = confirm.entry.journal_number
    return {
      submit: { title: `Submit ${n} for approval?`, consequence: 'An approver reviews it before it can be posted. You cannot edit it while it waits.', reversible: false, label: 'Submit', tone: 'primary' },
      approve: { title: `Approve ${n}?`, consequence: 'The entry can then be posted to the ledger.', reversible: false, label: 'Approve', tone: 'primary' },
      reject: { title: `Reject ${n}?`, consequence: 'The entry goes back to its author with your reason.', reversible: false, label: 'Reject', tone: 'danger', requireReason: true, reasonHelp: 'The author sees this. Say what would make it acceptable.' },
      post: { title: `Post ${n} to the ledger?`, consequence: 'Account balances and every financial statement change. A posted entry can only be corrected by reversing it.', reversible: false, label: 'Post', tone: 'primary' },
      reverse: { title: `Reverse ${n}?`, consequence: 'A new entry is posted with every debit and credit swapped, cancelling this one. Both stay on the ledger.', reversible: false, label: 'Reverse', tone: 'danger', requireReason: true, reasonHelp: 'Recorded on the reversing entry.' },
      delete: { title: `Delete ${n}?`, consequence: 'The entry and its lines are removed. It was never posted.', reversible: false, label: 'Delete entry', tone: 'danger', confirmText: n },
    }[confirm.kind]
  })()

  const actionsFor = (e) => [
    e.status === 'DRAFT' && { kind: 'submit', icon: PaperAirplaneIcon, label: 'Submit for approval' },
    e.status === 'PENDING_APPROVAL' && { kind: 'approve', icon: CheckCircleIcon, label: 'Approve' },
    e.status === 'PENDING_APPROVAL' && { kind: 'reject', icon: XCircleIcon, label: 'Reject', tone: 'risk' },
    e.status === 'APPROVED' && { kind: 'post', icon: BookmarkSquareIcon, label: 'Post' },
    e.status === 'POSTED' && !e.is_reversing_entry && { kind: 'reverse', icon: ArrowUturnLeftIcon, label: 'Reverse' },
    ['DRAFT', 'REJECTED'].includes(e.status) && { kind: 'delete', icon: TrashIcon, label: 'Delete', tone: 'risk' },
  ].filter(Boolean)

  return (
    <>
      <PageHeader
        title="Journal entries"
        description="Every posting to the general ledger — manual entries and those raised by invoices, payments and stock."
        secondary={<Button icon={ArrowDownTrayIcon} onClick={() => exportCsv(entries.filter(QUICK[quick].test), columns, 'journal-entries.csv')} disabled={!entries.length}>Export</Button>}
        primary={<Button variant="primary" icon={PlusIcon} to="/finance/journal-entries/create" kbd="N">New entry</Button>}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Entries" value={<Num value={stats?.total_entries} />} loading={statsLoading} onClick={() => setQuick('all')} />
        <Stat label="Posted" value={<Num value={stats?.posted_entries} />} loading={statsLoading} onClick={() => setQuick('posted')} />
        <Stat label="Waiting approval" value={<Num value={stats?.pending_approvals} />} loading={statsLoading} onClick={() => setQuick('pending')} />
        <Stat label="Total debits" value={<Money amount={stats?.total_debits} />} loading={statsLoading} reason="All entries, any status" />
      </div>

      {entries.length >= LIMIT && (
        <InlineNotice tone="warn" className="mb-3" title={`Showing the first ${LIMIT.toLocaleString()} entries`}>
          Narrow the dates to see older entries.
        </InlineNotice>
      )}

      <DataTable
        viewKey="finance.journal-entries"
        caption="Journal entries"
        noun="entry"
        rows={entries}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        onRowClick={(e) => setViewing(e)}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'date', dir: 'desc' }}
        searchPlaceholder="Search entry, description, reference"
        toolbarStart={
          <div className="flex max-w-full flex-wrap items-center gap-2">
            <Segmented
              label="Show"
              value={quick}
              onChange={setQuick}
              options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))}
              className="max-w-full overflow-x-auto"
            />
            <span className="flex items-center gap-1.5 text-xs text-ink-500">
              <Input type="date" size="sm" aria-label="Entry date from" value={range.from} max={range.to || undefined} onChange={(ev) => setRange((r) => ({ ...r, from: ev.target.value }))} className="w-36" />
              <span aria-hidden="true">–</span>
              <Input type="date" size="sm" aria-label="Entry date to" value={range.to} min={range.from || undefined} onChange={(ev) => setRange((r) => ({ ...r, to: ev.target.value }))} className="w-36" />
            </span>
          </div>
        }
        rowActions={(e) => (
          <>
            <RowAction icon={EyeIcon} label={`Open ${e.journal_number}`} onClick={() => setViewing(e)} />
            {actionsFor(e).map((a) => (
              <RowAction key={a.kind} icon={a.icon} tone={a.tone} label={`${a.label} ${e.journal_number}`} onClick={() => setConfirm({ kind: a.kind, entry: e })} />
            ))}
          </>
        )}
        empty={{
          icon: DocumentTextIcon,
          title: 'No journal entries yet',
          description: 'Invoices, payments and payroll post here automatically. Record a manual entry for accruals and corrections.',
          action: <Button variant="primary" icon={PlusIcon} to="/finance/journal-entries/create">New entry</Button>,
        }}
      />

      <Sheet
        open={Boolean(viewing)}
        onClose={() => setViewing(null)}
        width="lg"
        title={viewing?.journal_number || ''}
        description={viewing?.description || ''}
        footer={viewing && actionsFor(viewing).length > 0 ? (
          <div className="flex flex-wrap justify-end gap-2">
            {actionsFor(viewing).map((a, i, all) => (
              <Button key={a.kind} icon={a.icon} variant={a.tone === 'risk' ? 'destructive' : i === all.length - 1 || a.kind === 'post' || a.kind === 'approve' ? 'primary' : 'secondary'} onClick={() => setConfirm({ kind: a.kind, entry: viewing })}>{a.label}</Button>
            ))}
          </div>
        ) : null}
      >
        {viewing && <EntryDetail entry={viewing} />}
      </Sheet>

      {copy && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={run}
          title={copy.title}
          consequence={copy.consequence}
          reversible={copy.reversible}
          confirmLabel={copy.label}
          tone={copy.tone}
          requireReason={copy.requireReason}
          reasonHelp={copy.reasonHelp}
          confirmText={copy.confirmText}
          busy={statusUpdate.isPending || reverseEntry.isPending || deleteEntry.isPending}
        />
      )}
    </>
  )
}

/** One entry's header facts and its lines. */
function EntryDetail({ entry }) {
  const { data, loading, error, refetch } = useResource(keys.journalEntry(entry.id), ({ signal }) => api.get(`/journal-entries/${entry.id}`, { signal }))
  const e = data || entry
  const items = data?.items || data?.journal_entry_items || []
  const d = items.reduce((s, l) => s + (Number(l.debit_amount) || 0), 0)
  const c = items.reduce((s, l) => s + (Number(l.credit_amount) || 0), 0)
  return (
    <div className="space-y-5 p-4">
      <div className="flex items-center gap-2"><StatusBadge status={e.status} />{e.is_reversing_entry && <Badge mono>Reversal</Badge>}</div>
      <DescriptionList
        items={[
          { label: 'Entry date', value: <DateText value={e.entry_date} /> },
          { label: 'Posting date', value: e.posting_date ? <DateText value={e.posting_date} /> : null },
          { label: 'Source', value: humanize(e.source_type || 'MANUAL') },
          { label: 'Source document', value: e.source_document ? <Code>{e.source_document}</Code> : null },
          { label: 'Reference', value: e.reference ? <Code>{e.reference}</Code> : null },
          { label: 'Currency', value: e.currency && Number(e.exchange_rate) !== 1 ? `${e.currency} @ ${e.exchange_rate}` : e.currency },
          { label: 'Created by', value: e.created_by_name },
          { label: 'Approved by', value: e.approved_by_name },
          { label: 'Posted by', value: e.posted_by_name },
          { label: 'Notes', value: e.notes, wide: true },
        ]}
      />
      <section aria-labelledby="je-lines-h">
        <h3 id="je-lines-h" className="label-mono mb-2">Lines</h3>
        {loading ? <SkeletonRows rows={3} columns={3} /> : error ? <ErrorState compact error={error} what="The entry's lines" onRetry={refetch} /> : (
          <div className="overflow-x-auto rounded-lg border border-ink-200 ui-scroll">
            <table className="w-full min-w-[440px] text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-left">
                  <th scope="col" className="label-mono px-3 py-2 font-normal">Account</th>
                  <th scope="col" className="label-mono px-3 py-2 text-right font-normal">Debit</th>
                  <th scope="col" className="label-mono px-3 py-2 text-right font-normal">Credit</th>
                </tr>
              </thead>
              <tbody>
                {items.map((l, i) => (
                  <tr key={l.id || i} className="border-t border-ink-100 first:border-t-0">
                    <td className="px-3 py-1.5">
                      <span className="flex items-baseline gap-2"><Code className="text-ink-500">{l.account_code}</Code><span>{l.account_name}</span></span>
                      {l.description && <span className="block text-xs text-ink-500">{l.description}</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right">{Number(l.debit_amount) > 0 ? <Money amount={l.debit_amount} /> : <span className="text-ink-400">—</span>}</td>
                    <td className="px-3 py-1.5 text-right">{Number(l.credit_amount) > 0 ? <Money amount={l.credit_amount} /> : <span className="text-ink-400">—</span>}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-ink-400 font-semibold">
                  <th scope="row" className="px-3 py-2 text-left">Total</th>
                  <td className="px-3 py-2 text-right"><Money amount={d} /></td>
                  <td className="px-3 py-2 text-right"><Money amount={c} /></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
