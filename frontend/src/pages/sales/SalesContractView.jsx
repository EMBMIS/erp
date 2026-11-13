import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { CheckCircleIcon, PencilSquareIcon, ArrowPathIcon, ClipboardDocumentIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useRecordTitle } from '../../components/shell/ShellContext'
import {
  PageHeader, Button, StatusBadge, Money, Num, Code, DateText, ConfirmDialog, DetailLayout, SummaryStrip,
  Tabs, Card, DescriptionList, Timeline, RelatedPanel, DataTable, SkeletonDetail, ErrorState, InlineNotice, Input,
  daysFrom, formatDate, notify,
} from '../../components/ui'

const humanize = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
const intentOf = (s) => (/^PENDING/.test(s) ? 'warning' : /APPROVED/.test(s) ? 'success' : /^SENT/.test(s) ? 'info' : undefined)
const text = (v) => (v ? <span className="whitespace-pre-wrap">{v}</span> : null)

/** A sales contract on the shared record pattern. */
export default function SalesContractView() {
  const { id } = useParams()
  const [tab, setTab] = useState('lines')
  const [confirm, setConfirm] = useState(null)

  const { data: c, loading, error, refetch } = useResource(keys.salesContract(id), ({ signal }) => api.get(`/sales-contracts/${id}`, { signal }), { enabled: Boolean(id) })
  const { data: historyData, loading: historyLoading } = useResource(['sales-contracts', id, 'status-history'], ({ signal }) => api.get(`/sales-contracts/${id}/status-history`, { signal }), { enabled: Boolean(id) })
  const history = useMemo(() => (Array.isArray(historyData) ? historyData : []), [historyData])
  useRecordTitle(c?.contract_number, { subtitle: c?.contract_name })

  const invalidates = [keys.salesContract(id), ['sales-contracts'], ['sales-contracts-stats']]
  const requestApproval = useResourceMutation(() => api.post(`/sales-contracts/${id}/request-approval`), { invalidates, silent: true })
  const resend = useResourceMutation(() => api.post(`/sales-contracts/${id}/resend-customer-email`), { silent: true })

  if (loading) return <SkeletonDetail />
  if (error || !c) {
    return <ErrorState what="Sales contract" error={error || { response: { status: 404, data: { error: 'No contract with this id is visible to you.' } } }} onRetry={refetch} />
  }

  const items = Array.isArray(c.items) ? c.items : []
  const currency = c.currency || 'USD'
  const party = c.customer_name || c.supplier_name
  const ends = daysFrom(c.end_date)
  const errText = (e) => { const d = e?.response?.data || {}; return `${d.error || e.message}${d.error_id ? ` (reference ${d.error_id})` : ''}` }

  const submit = async () => {
    try {
      await requestApproval.mutateAsync()
      notify.success(`${c.contract_number} sent for approval`)
    } catch (e) {
      notify.error(`${c.contract_number} was not sent for approval: ${errText(e)}`)
    }
    setConfirm(null)
  }
  const doResend = async () => {
    try {
      const res = await resend.mutateAsync()
      notify.success(res?.message || `Acceptance email sent again to ${party || 'the customer'}`)
    } catch (e) {
      notify.error(`The email was not sent: ${errText(e)}`)
    }
  }
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(c.customer_portal_url)
      notify.success('Link copied')
    } catch {
      notify.error('The link could not be copied. Select it and copy it by hand.')
    }
  }

  let primary = null
  const secondary = []
  if (c.status === 'DRAFT') {
    primary = <Button variant="primary" icon={CheckCircleIcon} onClick={() => setConfirm('submit')}>Send for approval</Button>
    secondary.push(<Button key="edit" icon={PencilSquareIcon} to={`/sales/contracts/${c.id}/edit`}>Edit</Button>)
  }
  if (c.status === 'SENT_TO_CUSTOMER') primary = <Button variant="primary" icon={ArrowPathIcon} onClick={doResend} loading={resend.isPending}>Resend customer email</Button>

  const events = history.map((h, i) => ({
    id: h.id || i,
    title: humanize(h.status || h.to_status),
    actor: h.changed_by_name,
    at: h.changed_at || h.created_at,
    note: h.reason || h.change_reason,
    tone: /REJECT|TERMINAT/.test(h.status) ? 'risk' : /ACTIVE|APPROVED/.test(h.status) ? 'ok' : /SENT/.test(h.status) ? 'brand' : 'ink',
  }))
  if (!events.length && c.created_at) events.push({ id: 'created', title: 'Created', actor: c.created_by_name, at: c.created_at, tone: 'ink' })

  const lineColumns = [
    { id: 'n', header: '#', accessor: (l) => items.indexOf(l) + 1, width: 44, align: 'right', cell: (l) => <span className="font-mono text-2xs text-ink-400">{items.indexOf(l) + 1}</span> },
    {
      id: 'item', header: 'Item', accessor: 'item_name', minWidth: 180, wrap: true, mobile: 'title',
      cell: (l) => (
        <span>
          <span className="block">{l.item_name}</span>
          {(l.item_code || l.item_description) && <span className="block text-2xs text-ink-500">{[l.item_code, l.item_description].filter(Boolean).join(' · ')}</span>}
        </span>
      ),
    },
    { id: 'price', header: 'Unit price', accessor: (l) => Number(l.unit_price), align: 'right', width: 120, mobile: 'trailing', cell: (l) => <Money amount={l.unit_price} currency={currency} /> },
    { id: 'uom', header: 'Unit', accessor: 'unit_of_measure', width: 70 },
    { id: 'min', header: 'Min qty', accessor: (l) => (l.minimum_quantity == null ? null : Number(l.minimum_quantity)), align: 'right', width: 90, cell: (l) => <Num value={l.minimum_quantity} digits={Number(l.minimum_quantity) % 1 ? 2 : 0} /> },
    { id: 'max', header: 'Max qty', accessor: (l) => (l.maximum_quantity == null ? null : Number(l.maximum_quantity)), align: 'right', width: 90, cell: (l) => <Num value={l.maximum_quantity} digits={Number(l.maximum_quantity) % 1 ? 2 : 0} /> },
    { id: 'lead', header: 'Lead time', accessor: (l) => (l.lead_time_days == null ? null : Number(l.lead_time_days)), align: 'right', width: 100, mobile: 'subtitle', cell: (l) => (l.lead_time_days ? <Num value={l.lead_time_days} unit="days" /> : <span className="text-ink-400">—</span>) },
  ]

  const header = (
    <PageHeader
      title={c.contract_name || <Code className="text-[1em]">{c.contract_number}</Code>}
      status={<StatusBadge status={c.status} intent={intentOf(c.status)} />}
      meta={
        <>
          <Code>{c.contract_number}</Code>
          <span>{party || 'No party'}</span>
          <span>Created by {c.created_by_name || '—'} · <DateText value={c.created_at} /></span>
        </>
      }
      secondary={secondary.length ? <>{secondary}</> : null}
      primary={primary}
    />
  )

  const notice = c.status === 'SENT_TO_CUSTOMER' ? (
    <InlineNotice tone="brand" title="Waiting for the customer to accept">
      {c.customer_portal_url ? (
        <>
          <span className="block">Share this link directly, or resend the email.</span>
          <span className="mt-2 flex flex-wrap items-center gap-2">
            <Input readOnly value={c.customer_portal_url} onFocus={(e) => e.target.select()} aria-label="Customer acceptance link" className="min-w-0 flex-1 font-mono text-xs" />
            <Button size="sm" icon={ClipboardDocumentIcon} onClick={copyLink}>Copy link</Button>
          </span>
        </>
      ) : 'The customer’s response link has already been used or has expired. Resend the email to issue a new one.'}
    </InlineNotice>
  ) : c.status === 'PENDING_APPROVAL' ? (
    <InlineNotice tone="warn" title="Waiting for approval">An approver must approve this contract; it is then emailed to the customer to accept.</InlineNotice>
  ) : c.expiring_soon ? (
    <InlineNotice tone="warn" title="Expiring soon">It ends {formatDate(c.end_date)}{ends != null && ends >= 0 ? `, in ${ends} days` : ''}.{c.auto_renewal ? ` It renews automatically for ${c.renewal_period_months} months.` : ' It does not renew automatically.'}</InlineNotice>
  ) : null

  return (
    <>
      <DetailLayout
        header={header}
        notice={notice}
        summary={
          <SummaryStrip
            facts={[
              { label: 'Value', value: <Money amount={c.contract_value} currency={currency} />, hint: c.contract_type ? humanize(c.contract_type) : undefined },
              { label: c.customer_id ? 'Customer' : 'Supplier', value: party || '—', to: c.customer_id ? `/sales/customers/${c.customer_id}` : c.supplier_id ? `/procurement/suppliers/${c.supplier_id}` : undefined },
              { label: 'Period', value: <><DateText value={c.start_date} /> – <DateText value={c.end_date} /></>, hint: c.status === 'ACTIVE' && ends != null ? (ends >= 0 ? `${ends} days left` : `ended ${Math.abs(ends)} days ago`) : undefined },
              { label: 'Renewal', value: c.auto_renewal ? `Every ${c.renewal_period_months || '—'} months` : 'Manual', hint: (c.days_before_expiry_notification ?? c.expiry_notification_days) ? `notice ${c.days_before_expiry_notification ?? c.expiry_notification_days} days before expiry` : undefined },
              { label: 'Approval', value: c.approval_status ? humanize(c.approval_status) : '—' },
            ]}
          />
        }
        aside={
          <>
            <Card title="History" padded>
              {historyLoading ? <p className="text-sm text-ink-500">Loading…</p> : <Timeline events={events} />}
            </Card>
            <RelatedPanel
              groups={[
                { label: 'Customer', items: c.customer_id ? [{ label: c.customer_name || 'Customer', to: `/sales/customers/${c.customer_id}` }] : [] },
                { label: 'Supplier', items: c.supplier_id ? [{ label: c.supplier_name || 'Supplier', to: `/procurement/suppliers/${c.supplier_id}` }] : [] },
                { label: 'Quotation', items: c.linked_quotation_id ? [{ label: c.quotation_number || 'Quotation', to: `/sales/quotations/${c.linked_quotation_id}` }] : [] },
              ]}
            />
          </>
        }
      >
        <Tabs value={tab} onChange={setTab} label="Contract sections" tabs={[{ id: 'lines', label: 'Lines', count: items.length }, { id: 'terms', label: 'Terms' }, { id: 'notes', label: 'Notes' }]}>
          {(t) => (
            <>
              {t === 'lines' && (
                <DataTable caption="Contract lines" noun="line" rows={items} columns={lineColumns} search={items.length > 12} showCount={false} empty={{ title: 'No lines on this contract', description: 'Edit the draft to add the items and prices it covers.' }} />
              )}
              {t === 'terms' && (
                <Card>
                  <DescriptionList
                    items={[
                      { label: 'Currency', value: <Code>{currency}</Code> },
                      { label: 'Payment terms', value: c.payment_terms || null },
                      { label: 'Incoterms', value: c.incoterms || null },
                      { label: 'Delivery terms', value: c.delivery_terms || null },
                      { label: 'Delivery location', value: c.delivery_location || null },
                      { label: 'Default lead time', value: c.default_lead_time_days ? `${c.default_lead_time_days} days` : null },
                      { label: 'Terms and conditions', value: text(c.terms_and_conditions), wide: true },
                      { label: 'Special conditions', value: text(c.special_conditions), wide: true },
                    ]}
                  />
                </Card>
              )}
              {t === 'notes' && (
                <Card>
                  <DescriptionList
                    columns={1}
                    items={[
                      { label: 'External notes', value: text(c.notes) },
                      { label: 'Internal notes', value: text(c.internal_notes) },
                      { label: 'Last updated', value: c.updated_at ? <><DateText value={c.updated_at} withTime />{c.updated_by_name ? ` by ${c.updated_by_name}` : ''}</> : null },
                    ]}
                  />
                </Card>
              )}
            </>
          )}
        </Tabs>
      </DetailLayout>

      {confirm === 'submit' && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={submit}
          title={`Send ${c.contract_number} for approval?`}
          consequence="An approver reviews it. Once approved it is emailed to the customer to accept. You cannot edit it while it waits."
          confirmLabel="Send for approval"
          tone="primary"
          busy={requestApproval.isPending}
        />
      )}
    </>
  )
}
