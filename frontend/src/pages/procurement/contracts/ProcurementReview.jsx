import { useState } from 'react'
import { EyeIcon, PencilSquareIcon, ClipboardDocumentCheckIcon } from '@heroicons/react/20/solid'
import api from '../../../services/api'
import { useResource, useResourceMutation } from '../../../hooks/useResource'
import { keys } from '../../../services/queryKeys'
import {
  PageHeader, DataTable, RowAction, StatusBadge, Money, Code, DateText, ConfirmDialog, Field, Textarea, notify,
} from '../../../components/ui'

/**
 * Procurement review — contracts the supplier has accepted, waiting for
 * procurement to confirm the signed copy. Marking one signed activates it.
 */
export default function ProcurementReview() {
  const [signing, setSigning] = useState(null)
  const [notes, setNotes] = useState('')

  const { data, loading, error, refetch } = useResource(keys.procurementReview(), ({ signal }) => api.get('/contracts/procurement-review', { signal }))
  const contracts = Array.isArray(data) ? data : []

  const markSigned = useResourceMutation(
    ({ contractId, notes: n }) => api.post(`/contracts/${contractId}/mark-signed`, { notes: n }),
    { invalidates: [['procurement-review'], ['contracts'], ['procurement-contracts']], silent: true }
  )

  const columns = [
    { id: 'number', header: 'Contract', accessor: 'contract_number', width: 160, cell: (c) => <Code>{c.contract_number}</Code>, mobile: 'meta' },
    { id: 'title', header: 'Title', accessor: 'title', minWidth: 200, maxWidth: 320, mobile: 'title' },
    {
      id: 'supplier', header: 'Supplier', accessor: (c) => `${c.supplier_name || ''} ${c.supplier_code || ''}`, minWidth: 180, mobile: 'subtitle',
      cell: (c) => (
        <span className="block min-w-0">
          <span className="block truncate">{c.supplier_name || '—'}</span>
          {c.supplier_code && <span className="block truncate font-mono text-2xs text-ink-500">{c.supplier_code}</span>}
        </span>
      ),
    },
    { id: 'value', header: 'Value', accessor: (c) => (c.contract_value != null ? Number(c.contract_value) : null), align: 'right', width: 140, mobile: 'trailing', cell: (c) => <Money amount={c.contract_value} currency={c.currency || 'USD'} /> },
    { id: 'period', header: 'Period', accessor: 'start_date', width: 220, cell: (c) => <span><DateText value={c.start_date} /> – <DateText value={c.end_date} /></span> },
    { id: 'accepted', header: 'Supplier accepted', accessor: 'supplier_accepted_at', width: 150, cell: (c) => <DateText value={c.supplier_accepted_at} /> },
    { id: 'status', header: 'Status', accessor: 'status', width: 150, cell: (c) => <StatusBadge status={c.status} />, defaultHidden: true },
  ]

  const sign = async () => {
    try {
      await markSigned.mutateAsync({ contractId: signing.id, notes })
      notify.success(`${signing.contract_number} signed and activated`)
      setSigning(null)
      setNotes('')
    } catch (e) {
      const d = e?.response?.data || {}
      notify.error(`${signing.contract_number} was not activated: ${d.error || e.message}`)
    }
  }

  return (
    <>
      <PageHeader
        title="Procurement review"
        description="Contracts the supplier has accepted. Check the signed copy, then mark it signed to activate the contract."
      />

      <DataTable
        viewKey="procurement.contracts-review"
        caption="Contracts waiting for procurement review"
        noun="contract"
        rows={contracts}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        rowHref={(c) => `/procurement/contracts/${c.id}`}
        defaultSort={{ id: 'accepted', dir: 'asc' }}
        rowActions={(c) => (
          <>
            <RowAction icon={EyeIcon} label={`Open ${c.contract_number}`} to={`/procurement/contracts/${c.id}`} />
            <RowAction icon={PencilSquareIcon} label={`Mark ${c.contract_number} signed`} onClick={() => setSigning(c)} />
          </>
        )}
        empty={{
          icon: ClipboardDocumentCheckIcon,
          title: 'Nothing to review',
          description: 'Contracts appear here once a supplier accepts them. Sent contracts are on the Contracts list under Waiting.',
        }}
      />

      {signing && (
        <ConfirmDialog
          open
          tone="primary"
          onClose={() => { setSigning(null); setNotes('') }}
          onConfirm={sign}
          title={`Mark ${signing.contract_number} signed?`}
          consequence={`The contract with ${signing.supplier_name || 'the supplier'} becomes active, and purchase orders can buy against it.`}
          confirmLabel="Sign and activate"
          busy={markSigned.isPending}
        >
          <Field label="Validation notes" optional help="Recorded with the signing.">
            <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Signed copy checked against agreed terms…" />
          </Field>
        </ConfirmDialog>
      )}
    </>
  )
}
