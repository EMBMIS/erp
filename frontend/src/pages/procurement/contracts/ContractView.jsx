import { useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { CheckCircleIcon, TrashIcon, DocumentArrowDownIcon, InboxArrowDownIcon, PencilSquareIcon, SparklesIcon } from '@heroicons/react/20/solid'
import api from '../../../services/api'
import { useResource, useResourceMutation } from '../../../hooks/useResource'
import { keys } from '../../../services/queryKeys'
import { useRecordTitle } from '../../../components/shell/ShellContext'
import {
  PageHeader, Button, Menu, StatusBadge, Money, Num, Code, DateText, ConfirmDialog, DetailLayout, SummaryStrip,
  Tabs, Card, DescriptionList, Timeline, RelatedPanel, DataTable, SkeletonDetail, ErrorState, InlineNotice,
  Field, Textarea, daysFrom, formatDate, notify,
} from '../../../components/ui'

const LIVE = new Set(['ACTIVE', 'SIGNED'])
const Prose = ({ children }) => (children ? <span className="whitespace-pre-line">{children}</span> : null)

/**
 * A contract on the record pattern: five facts, items and terms in tabs,
 * the lifecycle as history, and the next step as the one primary action.
 */
export default function ContractView() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [tab, setTab] = useState('items')
  const [confirm, setConfirm] = useState(null) // 'submit' | 'sign' | 'delete'
  const [notes, setNotes] = useState('')

  const { data: contract, loading, error, refetch } = useResource(keys.procurementContract(id), ({ signal }) => api.get(`/contracts/${id}`, { signal }), { enabled: !!id })
  // Items are stored ACTIVE, or PENDING_APPROVAL while an amendment waits.
  const { data: itemData, loading: itemsLoading, error: itemsError } = useResource([...keys.procurementContract(id), 'items'], async ({ signal }) => {
    const [a, p] = await Promise.all([
      api.get(`/contract-items/by-contract/${id}`, { params: { status: 'ACTIVE' }, signal }),
      api.get(`/contract-items/by-contract/${id}`, { params: { status: 'PENDING_APPROVAL' }, signal }),
    ])
    return { data: { success: true, data: [...(a.data?.data || []), ...(p.data?.data || [])] } }
  }, { enabled: !!id })
  const items = useMemo(() => (Array.isArray(itemData) ? itemData : []), [itemData])
  useRecordTitle(contract?.contract_number, { subtitle: contract?.title })

  const invalidates = [keys.procurementContract(id), ['contracts'], ['procurement-review']]
  const submit = useResourceMutation(() => api.post(`/contracts/${id}/submit-for-approval`), { invalidates, silent: true })
  const markSigned = useResourceMutation((n) => api.post(`/contracts/${id}/mark-signed`, { notes: n }), { invalidates, silent: true })
  const remove = useResourceMutation(() => api.delete(`/contracts/${id}`), { invalidates: [['contracts']], silent: true })

  if (loading) return <SkeletonDetail />
  if (error || !contract) {
    return <ErrorState what="Contract" error={error || { response: { status: 404, data: { error: 'No contract with this id is visible to you.' } } }} onRetry={refetch} />
  }

  const c = contract
  const currency = c.currency || 'USD'
  const left = daysFrom(c.end_date)
  const expiring = LIVE.has(c.status) && left != null && left >= 0 && left <= 30

  const doIt = async () => {
    const kind = confirm
    const verbs = { submit: 'submitted for approval', sign: 'signed and activated', delete: 'deleted' }
    try {
      if (kind === 'submit') await submit.mutateAsync()
      if (kind === 'sign') await markSigned.mutateAsync(notes)
      if (kind === 'delete') await remove.mutateAsync()
      notify.success(`${c.contract_number} ${verbs[kind]}`)
      if (kind === 'delete') navigate('/procurement/contracts')
    } catch (e) {
      const d = e?.response?.data || {}
      notify.error(`${c.contract_number} was not ${verbs[kind]}: ${d.error || e.message}${d.error_id ? ` (reference ${d.error_id})` : ''}`)
    } finally {
      setConfirm(null)
      setNotes('')
    }
  }

  let primary = null
  if (c.status === 'DRAFT') primary = <Button variant="primary" icon={CheckCircleIcon} onClick={() => setConfirm('submit')}>Submit for approval</Button>
  else if (c.status === 'PENDING_APPROVAL') primary = <Button variant="primary" icon={InboxArrowDownIcon} to={`/approvals/unified?tab=contracts&id=${c.id}`}>Review in approvals</Button>
  else if (c.status === 'UNDER_REVIEW') primary = <Button variant="primary" icon={PencilSquareIcon} onClick={() => setConfirm('sign')}>Mark signed</Button>
  else if (LIVE.has(c.status)) primary = <Button variant="primary" to={`/procurement/purchase-orders/create?supplier_id=${c.supplier_id}`}>New purchase order</Button>

  const secondary = c.document_url ? <Button icon={DocumentArrowDownIcon} href={c.document_url} target="_blank" rel="noopener noreferrer">Document</Button> : null
  const more = [
    { label: 'Ask Simeli about this contract', icon: SparklesIcon, onSelect: () => navigate(`/ai/chat?q=${encodeURIComponent(`Summarise contract ${c.contract_number} with ${c.supplier_name}: value, term, renewal and anything unusual.`)}`) },
    { label: 'New requisition for this supplier', onSelect: () => navigate(`/procurement/purchase-requisitions/create?supplier_id=${c.supplier_id}`) },
    ...(c.status !== 'ACTIVE' ? [{ divider: true }, { label: 'Delete contract', icon: TrashIcon, tone: 'risk', onSelect: () => setConfirm('delete') }] : []),
  ]

  const events = [
    c.status === 'EXPIRED' && { title: 'Expired', at: c.end_date, tone: 'ink' },
    c.signed_at && { title: 'Signed', at: c.signed_at, tone: 'ok', note: c.signing_notes || c.procurement_notes },
    c.supplier_accepted_at && { title: 'Supplier accepted', at: c.supplier_accepted_at, tone: 'ok' },
    c.supplier_declined_at && { title: 'Supplier declined', at: c.supplier_declined_at, tone: 'risk', note: c.supplier_decline_reason },
    c.sent_to_supplier_at && { title: 'Sent to supplier', at: c.sent_to_supplier_at, tone: 'brand' },
    c.approved_at && { title: 'Approved', at: c.approved_at, tone: 'ok' },
    c.declined_at && { title: 'Declined', at: c.declined_at, tone: 'risk', note: c.decline_reason },
    { title: 'Created', actor: c.created_by_name, at: c.created_at, tone: 'ink' },
  ].filter((e) => e && e.at).sort((a, b) => new Date(b.at) - new Date(a.at))

  const notice = c.decline_reason && ['DECLINED', 'SUPPLIER_DECLINED'].includes(c.status) ? (
    <InlineNotice tone="risk" title="Declined">{c.decline_reason || c.supplier_decline_reason}</InlineNotice>
  ) : expiring ? (
    <InlineNotice tone="warn" title={`Ends in ${left} day${left === 1 ? '' : 's'}`}>Renew or replace it before {formatDate(c.end_date)} if supply should continue.</InlineNotice>
  ) : null

  const itemColumns = [
    {
      id: 'item', header: 'Item', accessor: 'item_name', minWidth: 220, mobile: 'title',
      cell: (r) => (
        <span className="block min-w-0">
          <span className="block truncate">{r.item_name}</span>
          {r.sku && <span className="block truncate font-mono text-2xs text-ink-500">{r.sku}</span>}
        </span>
      ),
    },
    { id: 'qty', header: 'Qty', accessor: (r) => (r.quantity != null ? Number(r.quantity) : null), align: 'right', width: 110, cell: (r) => <Num value={r.quantity} digits={Number(r.quantity) % 1 ? 2 : 0} unit={r.unit_of_measure} />, mobile: 'subtitle' },
    { id: 'price', header: 'Unit price', accessor: (r) => Number(r.unit_price ?? r.contract_price ?? r.supplier_unit_price) || null, align: 'right', width: 130, cell: (r) => <Money amount={r.unit_price ?? r.contract_price ?? r.supplier_unit_price} currency={r.currency || currency} /> },
    { id: 'total', header: 'Line total', accessor: (r) => (Number(r.quantity) || 0) * (Number(r.unit_price ?? r.contract_price ?? r.supplier_unit_price) || 0), align: 'right', width: 140, mobile: 'trailing', cell: (r) => <Money amount={r.quantity != null && (r.unit_price ?? r.contract_price ?? r.supplier_unit_price) != null ? Number(r.quantity) * Number(r.unit_price ?? r.contract_price ?? r.supplier_unit_price) : null} currency={r.currency || currency} /> },
    { id: 'status', header: 'Status', accessor: 'status', width: 170, cell: (r) => <StatusBadge status={r.status} /> },
    { id: 'lead', header: 'Lead time', accessor: (r) => (r.lead_time_days != null ? Number(r.lead_time_days) : null), align: 'right', width: 100, defaultHidden: true, cell: (r) => (r.lead_time_days != null ? <Num value={r.lead_time_days} unit="d" /> : '—') },
  ]

  return (
    <>
      <DetailLayout
        header={
          <PageHeader
            title={<Code className="text-[1em]">{c.contract_number}</Code>}
            status={<StatusBadge status={c.status} />}
            meta={
              <>
                <span>{c.title}</span>
                <span>{c.supplier_name}</span>
                {c.contract_type && <span className="font-mono uppercase">{c.contract_type.replace(/_/g, ' ')}</span>}
              </>
            }
            secondary={<>{secondary}<Menu items={more} /></>}
            primary={primary}
          />
        }
        notice={notice}
        summary={
          <SummaryStrip
            facts={[
              { label: 'Value', value: <Money amount={c.contract_value} currency={currency} /> },
              { label: 'Supplier', value: c.supplier_name || '—', hint: c.supplier_code, to: c.supplier_id ? `/procurement/suppliers/${c.supplier_id}` : undefined },
              { label: 'Starts', value: <DateText value={c.start_date} /> },
              { label: 'Ends', value: <DateText value={c.end_date} />, hint: left == null ? undefined : left >= 0 ? `in ${left} days` : `${Math.abs(left)} days ago` },
              { label: 'Items', value: itemsLoading ? '…' : String(items.length) },
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
                { label: 'Supplier', items: c.supplier_id ? [{ label: c.supplier_code || c.supplier_name, sublabel: c.supplier_name, to: `/procurement/suppliers/${c.supplier_id}` }] : [] },
              ]}
            />
          </>
        }
      >
        <Tabs value={tab} onChange={setTab} label="Contract sections" tabs={[{ id: 'items', label: 'Items', count: items.length }, { id: 'terms', label: 'Terms' }, { id: 'details', label: 'Details' }]}>
          {(t) => (
            <>
              {t === 'items' && (
                <DataTable
                  caption="Contract items"
                  noun="item"
                  rows={items}
                  columns={itemColumns}
                  loading={itemsLoading}
                  error={itemsError}
                  search={items.length > 12}
                  showCount={false}
                  empty={{ title: 'No items on this contract', description: 'Items are added when the contract is created, from what the supplier supplies.' }}
                />
              )}
              {t === 'terms' && (
                <Card>
                  <DescriptionList
                    columns={1}
                    items={[
                      { label: 'Payment terms', value: <Prose>{c.payment_terms}</Prose> },
                      { label: 'Service levels', value: <Prose>{c.sla_requirements}</Prose> },
                      { label: 'Renewal', value: <Prose>{c.renewal_terms}</Prose> },
                      { label: 'Termination', value: <Prose>{c.termination_clause}</Prose> },
                      { label: 'Compliance', value: <Prose>{c.compliance_requirements}</Prose> },
                      { label: 'Risk assessment', value: <Prose>{c.risk_assessment}</Prose> },
                    ]}
                  />
                </Card>
              )}
              {t === 'details' && (
                <Card>
                  <DescriptionList
                    items={[
                      { label: 'Title', value: c.title },
                      { label: 'Type', value: c.contract_type },
                      { label: 'Currency', value: <Code>{currency}</Code> },
                      { label: 'Supplier email', value: c.supplier_email },
                      { label: 'Supplier phone', value: c.supplier_phone },
                      { label: 'Created by', value: c.created_by_name },
                      { label: 'Description', value: <Prose>{c.description}</Prose>, wide: true },
                      { label: 'Notes', value: <Prose>{c.notes}</Prose>, wide: true },
                    ]}
                  />
                </Card>
              )}
            </>
          )}
        </Tabs>
      </DetailLayout>

      {confirm && (
        <ConfirmDialog
          open
          onClose={() => { setConfirm(null); setNotes('') }}
          onConfirm={doIt}
          title={{ submit: `Submit ${c.contract_number} for approval?`, sign: `Mark ${c.contract_number} signed?`, delete: `Delete ${c.contract_number}?` }[confirm]}
          consequence={{
            submit: 'It goes to a manager whose authority covers its value. You cannot change it until it is approved or declined.',
            sign: `The contract with ${c.supplier_name || 'the supplier'} becomes active, and purchase orders can buy against it.`,
            delete: 'The contract and its items are removed for everyone.',
          }[confirm]}
          reversible={false}
          confirmLabel={{ submit: `Submit ${c.contract_number}`, sign: 'Sign and activate', delete: `Delete ${c.contract_number}` }[confirm]}
          tone={confirm === 'delete' ? 'danger' : 'primary'}
          confirmText={confirm === 'delete' && c.status !== 'DRAFT' ? c.contract_number : undefined}
          busy={submit.isPending || markSigned.isPending || remove.isPending}
        >
          {confirm === 'sign' && (
            <Field label="Validation notes" optional>
              <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          )}
        </ConfirmDialog>
      )}
    </>
  )
}
