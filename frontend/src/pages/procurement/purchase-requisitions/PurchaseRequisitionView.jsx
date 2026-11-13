import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { CheckCircleIcon, TrashIcon, PlusIcon, InboxArrowDownIcon } from '@heroicons/react/20/solid'
import api from '../../../services/api'
import { useResource, useResourceMutation } from '../../../hooks/useResource'
import { keys } from '../../../services/queryKeys'
import { useRecordTitle } from '../../../components/shell/ShellContext'
import {
  PageHeader, Button, Menu, StatusBadge, Money, Num, Code, DateText, ConfirmDialog, DetailLayout, SummaryStrip,
  Card, DescriptionList, Timeline, RelatedPanel, SkeletonDetail, ErrorState, InlineNotice, formatDate, notify,
} from '../../../components/ui'

/**
 * A purchase requisition on the record pattern: five facts, the request,
 * the supplier recommendation, what happened, and what it led to.
 */
export default function PurchaseRequisitionView() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [confirm, setConfirm] = useState(null) // 'submit' | 'delete'

  const { data: pr, loading, error, refetch } = useResource(keys.purchaseRequisition(id), ({ signal }) => api.get(`/purchase-requisitions/${id}`, { signal }), { enabled: !!id })
  useRecordTitle(pr?.pr_number, { subtitle: pr?.item_description })

  const invalidates = [keys.purchaseRequisition(id), ['purchase-requisitions']]
  const submit = useResourceMutation(() => api.post(`/purchase-requisitions/${id}/submit-for-approval`), { invalidates, silent: true })
  const remove = useResourceMutation(() => api.delete(`/purchase-requisitions/${id}`), { invalidates: [['purchase-requisitions']], silent: true })

  if (loading) return <SkeletonDetail />
  if (error || !pr) {
    return (
      <ErrorState
        what="Purchase requisition"
        error={error || { response: { status: 404, data: { error: 'No requisition with this id is visible to you.' } } }}
        onRetry={refetch}
      />
    )
  }

  const currency = pr.currency || 'USD'
  const hasPrice = pr.estimated_unit_price != null && pr.estimated_unit_price !== ''
  const total = hasPrice ? Number(pr.quantity) * Number(pr.estimated_unit_price) : null

  const doIt = async () => {
    const kind = confirm
    try {
      if (kind === 'submit') {
        await submit.mutateAsync()
        notify.success(`${pr.pr_number} submitted for approval`)
      } else {
        await remove.mutateAsync()
        notify.success(`${pr.pr_number} deleted`)
        navigate('/procurement/purchase-requisitions')
      }
    } catch (e) {
      const d = e?.response?.data || {}
      notify.error(`${pr.pr_number} was not ${kind === 'submit' ? 'submitted' : 'deleted'}: ${d.error || e.message}${d.error_id ? ` (reference ${d.error_id})` : ''}`)
    } finally {
      setConfirm(null)
    }
  }

  let primary = null
  const secondary = []
  if (pr.status === 'DRAFT') primary = <Button variant="primary" icon={CheckCircleIcon} onClick={() => setConfirm('submit')}>Submit for approval</Button>
  if (pr.status === 'PENDING_APPROVAL' || pr.status === 'SUBMITTED') primary = <Button variant="primary" icon={InboxArrowDownIcon} to={`/approvals/unified?tab=purchase-requisitions&id=${pr.id}`}>Review in approvals</Button>
  if (pr.status === 'APPROVED') {
    primary = <Button variant="primary" icon={PlusIcon} to={`/procurement/rfqs/create?pr_id=${id}`}>Create RFQ</Button>
    secondary.push(<Button key="po" to={`/procurement/purchase-orders/create?pr_id=${id}`}>Create purchase order</Button>)
  }
  const more = ['DRAFT', 'DECLINED'].includes(pr.status) ? [{ label: 'Delete requisition', tone: 'risk', icon: TrashIcon, onSelect: () => setConfirm('delete') }] : []

  const events = [
    pr.status === 'DECLINED' && { title: 'Declined', at: pr.updated_at, tone: 'risk', note: pr.decline_reason },
    pr.approved_at && { title: 'Approved', actor: pr.approved_by_name, at: pr.approved_at, tone: 'ok' },
    { title: 'Raised', actor: pr.requested_by_name, at: pr.created_at, tone: 'ink' },
  ].filter((e) => e && e.at).sort((a, b) => new Date(b.at) - new Date(a.at))

  const header = (
    <PageHeader
      title={<Code className="text-[1em]">{pr.pr_number}</Code>}
      status={<StatusBadge status={pr.status} />}
      meta={
        <>
          <span>Cost centre {pr.cost_center || '—'}</span>
          <span>Requested by {pr.requested_by_name || '—'} · <DateText value={pr.created_at} /></span>
        </>
      }
      secondary={<>{secondary}{more.length > 0 && <Menu items={more} />}</>}
      primary={primary}
    />
  )

  const notice = pr.decline_reason ? (
    <InlineNotice tone="risk" title="Declined">{pr.decline_reason}</InlineNotice>
  ) : null

  return (
    <>
      <DetailLayout
        header={header}
        notice={notice}
        summary={
          <SummaryStrip
            facts={[
              { label: 'Estimated value', value: <Money amount={total} currency={currency} />, hint: hasPrice ? `${formatDate(pr.created_at)} estimate` : 'No price estimate' },
              { label: 'Quantity', value: <Num value={pr.quantity} digits={Number(pr.quantity) % 1 ? 2 : 0} unit={pr.unit_of_measure} /> },
              { label: 'Cost centre', value: pr.cost_center || '—' },
              { label: 'Recommended supplier', value: pr.recommended_supplier_name || '—', hint: pr.recommended_supplier_code, to: pr.recommended_supplier_id ? `/procurement/suppliers/${pr.recommended_supplier_id}` : undefined },
              { label: 'Approval', value: pr.approved_by_name || (pr.status === 'PENDING_APPROVAL' ? 'Waiting' : pr.status === 'DECLINED' ? 'Declined' : pr.status === 'DRAFT' ? 'Not submitted' : '—'), hint: pr.approved_at ? formatDate(pr.approved_at) : undefined },
            ]}
          />
        }
        aside={
          <>
            <Card title="History" padded>
              <Timeline events={events} />
            </Card>
            <RelatedPanel
              groups={[
                { label: 'Item', items: pr.item_id ? [{ label: pr.approved_item_code || pr.item_name, sublabel: pr.item_name, to: `/items/${pr.item_id}/view` }] : [] },
                { label: 'Supplier', items: pr.recommended_supplier_id ? [{ label: pr.recommended_supplier_code || pr.recommended_supplier_name, sublabel: pr.recommended_supplier_name, to: `/procurement/suppliers/${pr.recommended_supplier_id}` }] : [] },
              ]}
            />
          </>
        }
      >
        <div className="space-y-5">
          <Card title="Request">
            <DescriptionList
              items={[
                { label: 'Description', value: pr.item_description, wide: true },
                { label: 'Catalog item', value: pr.item_name ? <span>{pr.item_name} <Code className="text-ink-500">{pr.approved_item_code}</Code></span> : null },
                { label: 'Quantity', value: <Num value={pr.quantity} digits={Number(pr.quantity) % 1 ? 2 : 0} unit={pr.unit_of_measure} /> },
                { label: 'Estimated unit price', value: hasPrice ? <Money amount={pr.estimated_unit_price} currency={currency} /> : null },
                { label: 'Estimated total', value: hasPrice ? <Money amount={total} currency={currency} className="font-semibold" /> : null },
                { label: 'Currency', value: <Code>{currency}</Code> },
                { label: 'Last updated', value: <DateText value={pr.updated_at} withTime /> },
              ]}
            />
          </Card>
          <Card title="Supplier recommendation">
            <DescriptionList
              items={[
                { label: 'Recommended supplier', value: pr.recommended_supplier_name ? `${pr.recommended_supplier_name}${pr.recommended_supplier_code ? ` (${pr.recommended_supplier_code})` : ''}` : null },
                { label: 'Why', value: pr.supplier_recommendation_text, wide: true },
              ]}
            />
          </Card>
        </div>
      </DetailLayout>

      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={doIt}
          title={confirm === 'submit' ? `Submit ${pr.pr_number} for approval?` : `Delete ${pr.pr_number}?`}
          consequence={confirm === 'submit' ? 'It goes to the approver whose authority covers this cost centre and value. You cannot edit it while it waits.' : 'The requisition is removed. It cannot be converted into an RFQ or order afterwards.'}
          reversible={false}
          confirmLabel={confirm === 'submit' ? `Submit ${pr.pr_number}` : `Delete ${pr.pr_number}`}
          tone={confirm === 'submit' ? 'primary' : 'danger'}
          busy={submit.isPending || remove.isPending}
        />
      )}
    </>
  )
}
