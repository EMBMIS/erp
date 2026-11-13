import { useMemo, useState } from 'react'
import { PlusIcon, EyeIcon, CheckCircleIcon, TrashIcon, ClipboardDocumentListIcon, ArrowDownTrayIcon } from '@heroicons/react/20/solid'
import api from '../../../services/api'
import { useResource, useResourceMutation } from '../../../hooks/useResource'
import { keys } from '../../../services/queryKeys'
import {
  PageHeader, Button, DataTable, RowAction, BulkAction, StatusBadge, Money, Num, Code, DateText, ConfirmDialog,
  Segmented, InlineNotice, exportCsv, notify,
} from '../../../components/ui'

/**
 * Purchase requisitions — internal requests to buy, before an RFQ or PO.
 *
 * Loaded in one request (up to LIMIT) so search, sorting and saved views work
 * across the whole set. The status badge keeps the raw status words
 * ("PENDING APPROVAL") because the cross-module journey asserts on them.
 */
const LIMIT = 1000

const QUICK = {
  all: { label: 'All', test: () => true },
  drafts: { label: 'Drafts', test: (pr) => pr.status === 'DRAFT' },
  waiting: { label: 'Waiting approval', test: (pr) => pr.status === 'PENDING_APPROVAL' || pr.status === 'SUBMITTED' },
  approved: { label: 'Approved', test: (pr) => pr.status === 'APPROVED' },
  declined: { label: 'Declined', test: (pr) => pr.status === 'DECLINED' || pr.status === 'REJECTED' || pr.status === 'CANCELLED' },
}

const estValue = (pr) => (pr.estimated_unit_price != null && pr.estimated_unit_price !== '' ? Number(pr.quantity) * Number(pr.estimated_unit_price) : null)

export default function PurchaseRequisitionsList() {
  const [quick, setQuick] = useState('all')
  const [confirm, setConfirm] = useState(null) // { kind, prs }

  const params = { limit: LIMIT, offset: 0 }
  const { data, loading, error, refetch } = useResource(keys.purchaseRequisitions(params), ({ signal }) => api.get('/purchase-requisitions', { params, signal }))
  const prs = useMemo(() => (Array.isArray(data) ? data : data?.data || []), [data])

  const invalidates = [['purchase-requisitions']]
  const submit = useResourceMutation((id) => api.post(`/purchase-requisitions/${id}/submit-for-approval`), { invalidates, silent: true })
  const remove = useResourceMutation((id) => api.delete(`/purchase-requisitions/${id}`), { invalidates, silent: true })

  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, prs.filter(q.test).length])), [prs])

  const columns = useMemo(() => [
    { id: 'pr', header: 'Requisition', accessor: 'pr_number', cell: (pr) => <Code>{pr.pr_number}</Code>, width: 150, mobile: 'title' },
    { id: 'cost', header: 'Cost centre', accessor: 'cost_center', filter: 'select', width: 130 },
    {
      id: 'desc', header: 'Item', accessor: (pr) => `${pr.item_description || ''} ${pr.item_name || ''}`, minWidth: 220, maxWidth: 360, mobile: 'subtitle',
      cell: (pr) => (
        <span className="block min-w-0">
          <span className="block truncate">{pr.item_description || '—'}</span>
          {pr.item_name && <span className="block truncate font-mono text-2xs text-ink-500">{pr.approved_item_code} · {pr.item_name}</span>}
        </span>
      ),
    },
    { id: 'qty', header: 'Qty', accessor: (pr) => Number(pr.quantity), align: 'right', width: 110, cell: (pr) => <Num value={pr.quantity} digits={Number(pr.quantity) % 1 ? 2 : 0} unit={pr.unit_of_measure} /> },
    {
      id: 'value', header: 'Estimated value', accessor: estValue, align: 'right', filter: 'number', width: 150, mobile: 'trailing',
      cell: (pr) => <Money amount={estValue(pr)} currency={pr.currency || 'USD'} />,
      exportValue: (pr) => estValue(pr),
    },
    {
      id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 180, mobile: 'meta',
      cell: (pr) => <StatusBadge status={pr.status} label={String(pr.status || '').replace(/_/g, ' ')} />,
    },
    { id: 'supplier', header: 'Recommended supplier', accessor: 'recommended_supplier_name', defaultHidden: true, width: 180 },
    { id: 'by', header: 'Requested by', accessor: 'requested_by_name', filter: 'text', width: 150 },
    { id: 'needed', header: 'Needed by', accessor: 'required_by_date', width: 120, cell: (pr) => <DateText value={pr.required_by_date} />, defaultHidden: true },
    { id: 'created', header: 'Raised', accessor: 'created_at', width: 120, cell: (pr) => <DateText value={pr.created_at} /> },
  ], [])

  const run = async () => {
    const { kind, prs: targets } = confirm
    const fn = kind === 'submit' ? submit : remove
    let ok = 0
    const failed = []
    for (const pr of targets) {
      try { await fn.mutateAsync(pr.id); ok += 1 } catch (e) { failed.push(`${pr.pr_number}: ${e?.response?.data?.error || e.message}`) }
    }
    setConfirm(null)
    const verb = kind === 'submit' ? 'submitted for approval' : 'deleted'
    if (ok) notify.success(ok === 1 ? `${targets[0].pr_number} ${verb}` : `${ok} requisitions ${verb}`)
    if (failed.length) notify.error(`Not done — ${failed.join('; ')}`)
  }

  const confirmCopy = confirm && (() => {
    const n = confirm.prs.length
    const what = n === 1 ? confirm.prs[0].pr_number : `${n} requisitions`
    if (confirm.kind === 'submit') return { title: `Submit ${what} for approval?`, consequence: 'Each goes to the approver whose authority covers its cost centre and value. You cannot edit a requisition while it waits.', label: `Submit ${what}`, tone: 'primary' }
    const statuses = new Set(confirm.prs.map((p) => p.status))
    let consequence = 'The requisition is removed. Nobody can convert it into an RFQ or purchase order afterwards.'
    if (statuses.has('APPROVED')) consequence = 'At least one of these is approved and may already feed an RFQ or purchase order. Deleting it can leave those records without their source.'
    else if (statuses.has('PENDING_APPROVAL') || statuses.has('SUBMITTED')) consequence = 'At least one of these is waiting for approval; the approver loses it from their queue.'
    return { title: `Delete ${what}?`, consequence, label: `Delete ${what}`, tone: 'danger', confirmText: n === 1 && confirm.prs[0].status !== 'DRAFT' ? confirm.prs[0].pr_number : undefined }
  })()

  return (
    <>
      <PageHeader
        title="Purchase requisitions"
        description="Internal requests to buy. Approved requisitions become RFQs or purchase orders."
        secondary={<Button icon={ArrowDownTrayIcon} onClick={() => exportCsv(prs.filter(QUICK[quick].test), columns, 'purchase-requisitions.csv')} disabled={!prs.length}>Export</Button>}
        primary={<Button variant="primary" icon={PlusIcon} to="/procurement/purchase-requisitions/create" kbd="N">New requisition</Button>}
      />

      {prs.length >= LIMIT && (
        <InlineNotice tone="warn" className="mb-3" title={`Showing the newest ${LIMIT.toLocaleString()} requisitions`}>
          Use search or the column filters to narrow the list. Older requisitions are still in the system.
        </InlineNotice>
      )}

      <DataTable
        viewKey="procurement.purchase-requisitions"
        caption="Purchase requisitions"
        noun="requisition"
        rows={prs}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        rowHref={(pr) => `/procurement/purchase-requisitions/${pr.id}`}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'created', dir: 'desc' }}
        searchPlaceholder="Search PRs..."
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
          const drafts = sel.filter((p) => p.status === 'DRAFT')
          return (
            <>
              {drafts.length > 0 && <BulkAction tone="primary" icon={CheckCircleIcon} onClick={() => { setConfirm({ kind: 'submit', prs: drafts }); clear() }}>Submit {drafts.length} for approval</BulkAction>}
              <BulkAction icon={ArrowDownTrayIcon} onClick={() => exportCsv(sel, columns, 'purchase-requisitions-selected.csv')}>Export</BulkAction>
              <BulkAction tone="risk" icon={TrashIcon} onClick={() => { setConfirm({ kind: 'delete', prs: sel }); clear() }}>Delete {sel.length}</BulkAction>
            </>
          )
        }}
        rowActions={(pr) => (
          <>
            <RowAction icon={EyeIcon} label={`Open ${pr.pr_number}`} to={`/procurement/purchase-requisitions/${pr.id}`} />
            {pr.status === 'DRAFT' && <RowAction icon={CheckCircleIcon} label={`Submit ${pr.pr_number} for approval`} onClick={() => setConfirm({ kind: 'submit', prs: [pr] })} />}
            <RowAction icon={TrashIcon} tone="risk" label={`Delete ${pr.pr_number}`} onClick={() => setConfirm({ kind: 'delete', prs: [pr] })} />
          </>
        )}
        empty={{
          icon: ClipboardDocumentListIcon,
          title: 'No requisitions yet',
          description: 'A requisition asks for something to be bought against a cost centre. Once approved it converts into an RFQ or a purchase order.',
          action: <Button variant="primary" icon={PlusIcon} to="/procurement/purchase-requisitions/create">New requisition</Button>,
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
