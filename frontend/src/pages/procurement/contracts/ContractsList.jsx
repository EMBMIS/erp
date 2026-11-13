import { useMemo, useState } from 'react'
import { PlusIcon, EyeIcon, CheckCircleIcon, TrashIcon, DocumentTextIcon, ArrowDownTrayIcon, ClipboardDocumentCheckIcon } from '@heroicons/react/20/solid'
import api from '../../../services/api'
import { useResource, useResourceMutation } from '../../../hooks/useResource'
import { keys } from '../../../services/queryKeys'
import {
  PageHeader, Button, DataTable, RowAction, BulkAction, StatusBadge, Money, Code, DateText, ConfirmDialog,
  Segmented, InlineNotice, exportCsv, daysFrom, notify,
} from '../../../components/ui'

/**
 * Supplier contracts. Counts in the quick views are computed from the loaded
 * rows. The old stats tiles read GET /contracts/stats, whose "expiring soon"
 * counted contracts already past their end date; "Expiring in 30 days" here
 * is live contracts ending within the next 30 days.
 */
const LIMIT = 1000
const LIVE = new Set(['ACTIVE', 'SIGNED'])
const expiringSoon = (c) => LIVE.has(c.status) && c.end_date && daysFrom(c.end_date) >= 0 && daysFrom(c.end_date) <= 30

const QUICK = {
  all: { label: 'All', test: () => true },
  drafts: { label: 'Drafts', test: (c) => c.status === 'DRAFT' },
  waiting: { label: 'Waiting', test: (c) => ['PENDING_APPROVAL', 'SENT_TO_SUPPLIER', 'SUPPLIER_ACCEPTED', 'UNDER_REVIEW'].includes(c.status) },
  active: { label: 'Active', test: (c) => LIVE.has(c.status) },
  expiring: { label: 'Expiring in 30 days', test: expiringSoon },
  ended: { label: 'Ended', test: (c) => ['EXPIRED', 'TERMINATED', 'DECLINED', 'SUPPLIER_DECLINED'].includes(c.status) },
}

const WARN = {
  ACTIVE: 'This contract is active and may have open purchase orders or payments against it.',
  SIGNED: 'This contract is signed by both parties.',
  PENDING_APPROVAL: 'It is waiting for approval; the approver loses it from their queue.',
  UNDER_REVIEW: 'It is under procurement review.',
  SUPPLIER_ACCEPTED: 'The supplier has already accepted it.',
  SENT_TO_SUPPLIER: 'It has been sent to the supplier, who may be reviewing it now.',
}

export default function ContractsList() {
  const [quick, setQuick] = useState('all')
  const [confirm, setConfirm] = useState(null) // { kind, rows }

  const params = { limit: LIMIT }
  const { data, loading, error, refetch } = useResource(keys.contracts(params), ({ signal }) => api.get('/contracts', { params, signal }))
  const contracts = useMemo(() => (Array.isArray(data) ? data : []), [data])

  const invalidates = [['contracts']]
  const submit = useResourceMutation((id) => api.post(`/contracts/${id}/submit-for-approval`), { invalidates, silent: true })
  const remove = useResourceMutation((id) => api.delete(`/contracts/${id}`), { invalidates, silent: true })

  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, contracts.filter(q.test).length])), [contracts])

  const columns = useMemo(() => [
    { id: 'number', header: 'Contract', accessor: 'contract_number', cell: (c) => <Code>{c.contract_number}</Code>, width: 160, mobile: 'meta' },
    { id: 'title', header: 'Title', accessor: 'title', minWidth: 200, maxWidth: 320, mobile: 'title', cell: (c) => <span className="block truncate">{c.title || '—'}</span> },
    { id: 'supplier', header: 'Supplier', accessor: 'supplier_name', filter: 'text', minWidth: 160, maxWidth: 260, mobile: 'subtitle', cell: (c) => <span className="block truncate">{c.supplier_name || '—'}</span> },
    { id: 'type', header: 'Type', accessor: 'contract_type', filter: 'select', width: 130, defaultHidden: true },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 180, cell: (c) => <StatusBadge status={c.status} /> },
    {
      id: 'value', header: 'Value', accessor: (c) => (c.contract_value != null ? Number(c.contract_value) : null), align: 'right', filter: 'number', width: 140, mobile: 'trailing',
      cell: (c) => <Money amount={c.contract_value} currency={c.currency || 'USD'} />, exportValue: (c) => c.contract_value,
    },
    { id: 'start', header: 'Starts', accessor: 'start_date', width: 120, cell: (c) => <DateText value={c.start_date} /> },
    {
      id: 'end', header: 'Ends', accessor: 'end_date', width: 160,
      cell: (c) => (
        <span className="flex items-center gap-1.5">
          <DateText value={c.end_date} />
          {expiringSoon(c) && <span className="font-mono text-2xs text-warn-700" title="Ends within 30 days">▲ {daysFrom(c.end_date)}d</span>}
        </span>
      ),
    },
    { id: 'by', header: 'Created by', accessor: 'created_by_name', width: 140, defaultHidden: true },
    { id: 'created', header: 'Created', accessor: 'created_at', width: 120, cell: (c) => <DateText value={c.created_at} /> },
  ], [])

  const run = async () => {
    const { kind, rows } = confirm
    const fn = kind === 'submit' ? submit : remove
    let ok = 0
    const failed = []
    for (const c of rows) {
      try { await fn.mutateAsync(c.id); ok += 1 } catch (e) { failed.push(`${c.contract_number}: ${e?.response?.data?.error || e.message}`) }
    }
    setConfirm(null)
    const verb = kind === 'submit' ? 'submitted for approval' : 'deleted'
    if (ok) notify.success(ok === 1 ? `${rows[0].contract_number} ${verb}` : `${ok} contracts ${verb}`)
    if (failed.length) notify.error(`Not done — ${failed.join('; ')}`)
  }

  const confirmCopy = confirm && (() => {
    const n = confirm.rows.length
    const what = n === 1 ? confirm.rows[0].contract_number : `${n} contracts`
    if (confirm.kind === 'submit') return { title: `Submit ${what} for approval?`, consequence: 'It goes to a manager whose authority covers its value. You cannot edit it until it is approved or declined.', label: `Submit ${what}`, tone: 'primary' }
    const warnings = [...new Set(confirm.rows.map((c) => WARN[c.status]).filter(Boolean))]
    return {
      title: `Delete ${what}?`,
      consequence: `${warnings.join(' ')} ${warnings.length ? 'Deleting it removes the record and its items for everyone.' : 'The contract and its items are removed.'}`.trim(),
      label: `Delete ${what}`, tone: 'danger',
      confirmText: n === 1 && confirm.rows[0].status !== 'DRAFT' ? confirm.rows[0].contract_number : undefined,
    }
  })()

  return (
    <>
      <PageHeader
        title="Contracts"
        description="Agreements with suppliers — terms, value and how long they run."
        secondary={
          <>
            <Button icon={ClipboardDocumentCheckIcon} to="/procurement/contracts-review">Procurement review</Button>
            <Button icon={ArrowDownTrayIcon} onClick={() => exportCsv(contracts.filter(QUICK[quick].test), columns, 'contracts.csv')} disabled={!contracts.length}>Export</Button>
          </>
        }
        primary={<Button variant="primary" icon={PlusIcon} to="/procurement/contracts/create" kbd="N">New contract</Button>}
      />

      {contracts.length >= LIMIT && (
        <InlineNotice tone="warn" className="mb-3" title={`Showing the newest ${LIMIT.toLocaleString()} contracts`}>
          Use search or the column filters to narrow the list.
        </InlineNotice>
      )}

      <DataTable
        viewKey="procurement.contracts"
        caption="Contracts"
        noun="contract"
        rows={contracts}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        rowHref={(c) => `/procurement/contracts/${c.id}`}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'created', dir: 'desc' }}
        searchPlaceholder="Search number, title, supplier"
        toolbarStart={
          <Segmented
            label="Show"
            value={quick}
            onChange={setQuick}
            options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))}
            className="max-w-full overflow-x-auto"
          />
        }
        selectable
        bulkActions={(sel, clear) => {
          const drafts = sel.filter((c) => c.status === 'DRAFT')
          return (
            <>
              {drafts.length > 0 && <BulkAction tone="primary" icon={CheckCircleIcon} onClick={() => { setConfirm({ kind: 'submit', rows: drafts }); clear() }}>Submit {drafts.length} for approval</BulkAction>}
              <BulkAction icon={ArrowDownTrayIcon} onClick={() => exportCsv(sel, columns, 'contracts-selected.csv')}>Export</BulkAction>
              <BulkAction tone="risk" icon={TrashIcon} onClick={() => { setConfirm({ kind: 'delete', rows: sel }); clear() }}>Delete {sel.length}</BulkAction>
            </>
          )
        }}
        rowActions={(c) => (
          <>
            <RowAction icon={EyeIcon} label={`Open ${c.contract_number}`} to={`/procurement/contracts/${c.id}`} />
            {c.status === 'DRAFT' && <RowAction icon={CheckCircleIcon} label={`Submit ${c.contract_number} for approval`} onClick={() => setConfirm({ kind: 'submit', rows: [c] })} />}
            <RowAction icon={TrashIcon} tone="risk" label={`Delete ${c.contract_number}`} onClick={() => setConfirm({ kind: 'delete', rows: [c] })} />
          </>
        )}
        empty={{
          icon: DocumentTextIcon,
          title: 'No contracts yet',
          description: 'A contract fixes price and terms with a certified supplier for a period. Purchase orders can then buy against it.',
          action: <Button variant="primary" icon={PlusIcon} to="/procurement/contracts/create">New contract</Button>,
        }}
      />

      {confirmCopy && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={run}
          title={confirmCopy.title}
          consequence={confirmCopy.consequence}
          reversible={false}
          confirmLabel={confirmCopy.label}
          tone={confirmCopy.tone}
          confirmText={confirmCopy.confirmText}
          busy={submit.isPending || remove.isPending}
        />
      )}
    </>
  )
}
