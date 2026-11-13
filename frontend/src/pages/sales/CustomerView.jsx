import { useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { PencilSquareIcon, TrashIcon, PlusIcon, DocumentTextIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useAuth } from '../../contexts/AuthContext'
import { useRecordTitle } from '../../components/shell/ShellContext'
import { getSalesOrderStatusLabel } from '../../constants/salesOrderStatus'
import {
  PageHeader, Button, Menu, StatusBadge, Badge, Money, Code, DateText, ConfirmDialog, DetailLayout, SummaryStrip,
  Tabs, Card, DescriptionList, Timeline, RelatedPanel, DataTable, SkeletonDetail, ErrorState, InlineNotice, notify,
} from '../../components/ui'

const humanize = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
const RISK_TONE = { LOW: 'ok', MEDIUM: 'warn', HIGH: 'risk', BLOCKED: 'risk' }
const OPEN_SO = (s) => !['COMPLETED', 'CANCELLED', 'REJECTED', 'CUSTOMER_REJECTED'].includes(s)

function Address({ c, kind }) {
  const lines = [
    c[`${kind}_address_line1`],
    c[`${kind}_address_line2`],
    [c[`${kind}_postal_code`], c[`${kind}_city`], c[`${kind}_state`]].filter(Boolean).join(' '),
    c[`${kind}_country`],
  ].filter(Boolean)
  if (!lines.length) return null
  return <span className="whitespace-pre-line">{lines.join('\n')}</span>
}

const mail = (v) => (v ? <a href={`mailto:${v}`} className="text-brand-700 underline-offset-2 hover:underline">{v}</a> : null)
const tel = (v) => (v ? <a href={`tel:${v}`} className="text-brand-700 underline-offset-2 hover:underline">{v}</a> : null)

/**
 * A customer, on the record pattern: five facts, tabs for the rest, history
 * from the customer audit log, and the orders placed under this account.
 */
export default function CustomerView() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const isManager = ['MANAGER', 'ADMIN'].includes(user?.role)
  const [tab, setTab] = useState('overview')
  const [confirm, setConfirm] = useState(false)

  const { data: c, loading, error, refetch } = useResource(keys.customer(id), ({ signal }) => api.get(`/customers/${id}`, { signal }), { enabled: Boolean(id) })
  // The audit endpoint is limited to managers and admins; others simply see no history.
  const { data: auditData, loading: auditLoading, error: auditError } = useResource(['customer-audit', id], ({ signal }) => api.get(`/customers/${id}/audit`, { signal }), { enabled: Boolean(id) && isManager, retry: false })
  const ordersParams = { customer_id: id, limit: 200 }
  const { data: ordersData, loading: ordersLoading } = useResource(keys.salesOrders(ordersParams), ({ signal }) => api.get('/sales-orders', { params: ordersParams, signal }), { enabled: Boolean(id) })
  const orders = useMemo(() => (Array.isArray(ordersData) ? ordersData : []), [ordersData])
  const audit = Array.isArray(auditData) ? auditData : []
  useRecordTitle(c?.customer_code || c?.customer_name, { subtitle: c?.customer_name })

  const remove = useResourceMutation(() => api.delete(`/customers/${id}`), { invalidates: [['customers']], silent: true })

  const orderColumns = useMemo(() => [
    { id: 'so', header: 'Order', accessor: 'so_number', cell: (o) => <Code>{o.so_number}</Code>, width: 150, mobile: 'title' },
    { id: 'date', header: 'Ordered', accessor: 'order_date', cell: (o) => <DateText value={o.order_date} />, width: 120, mobile: 'subtitle' },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', cell: (o) => <StatusBadge status={o.status} label={getSalesOrderStatusLabel(o.status)} />, width: 200, mobile: 'meta' },
    { id: 'delivery', header: 'Delivery', accessor: 'delivery_date', cell: (o) => <DateText value={o.delivery_date} />, width: 120 },
    { id: 'total', header: 'Total', accessor: (o) => Number(o.total_amount), align: 'right', width: 140, mobile: 'trailing', cell: (o) => <Money amount={o.total_amount} currency={o.currency} /> },
  ], [])

  if (loading) return <SkeletonDetail />
  if (error || !c) {
    return <ErrorState what="Customer" error={error || { response: { status: 404, data: { error: 'No customer with this id is visible to you.' } } }} onRetry={refetch} />
  }

  const currency = c.currency || 'USD'
  const limit = Number(c.credit_limit) || 0
  const balance = Number(c.current_balance) || 0
  const openOrders = orders.filter((o) => OPEN_SO(o.status))
  const openValue = openOrders.reduce((s, o) => s + (Number(o.total_amount) || 0), 0)
  const fmt = (n) => new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(n)

  const doDelete = async () => {
    try {
      await remove.mutateAsync()
      notify.success(`${c.customer_name} deleted`)
      navigate('/sales/customers')
    } catch (e) {
      setConfirm(false)
      const d = e?.response?.data || {}
      notify.error(`${c.customer_name} was not deleted: ${d.error || e.message}`)
    }
  }

  // One entry per save: field updates made in the same save are grouped.
  const events = Object.values(audit.reduce((acc, a) => {
    const k = `${a.action}|${a.changed_at}|${a.changed_by}`
    ;(acc[k] = acc[k] || []).push(a)
    return acc
  }, {})).map((group) => {
    const a = group[0]
    const fields = group.filter((g) => g.field_changed)
    return {
      title: fields.length > 1 ? `Updated ${fields.length} fields` : fields.length ? `Updated ${humanize(a.field_changed).toLowerCase()}` : humanize(a.action),
      actor: a.changed_by_name,
      at: a.changed_at,
      tone: a.action === 'DELETED' ? 'risk' : a.action === 'CREATED' ? 'ink' : 'brand',
      note: fields.length > 1 ? fields.map((f) => humanize(f.field_changed).toLowerCase()).join(', ') : fields.length ? `${a.old_value ?? '—'} → ${a.new_value ?? '—'}` : a.notes,
    }
  }).sort((x, y) => new Date(y.at) - new Date(x.at))

  const more = [
    { label: 'New quotation', icon: DocumentTextIcon, onSelect: () => navigate('/sales/quotations/create') },
    ...(isManager ? [{ divider: true }, { label: 'Delete customer', tone: 'risk', icon: TrashIcon, onSelect: () => setConfirm(true) }] : []),
  ]

  const header = (
    <PageHeader
      title={c.customer_name}
      status={<StatusBadge status={c.status} />}
      meta={
        <>
          <Code>{c.customer_code}</Code>
          <span>{humanize(c.customer_type)}</span>
          {c.sales_rep_name && <span>Sales rep {c.sales_rep_name}</span>}
          <span>Added by {c.created_by_name || '—'} · <DateText value={c.created_at} /></span>
        </>
      }
      secondary={<><Button icon={PencilSquareIcon} to={`/sales/customers/${id}/edit`}>Edit</Button><Menu items={more} /></>}
      primary={<Button variant="primary" icon={PlusIcon} to={`/sales/sales-orders/create?customer_id=${id}`} disabled={c.status === 'BLOCKED'} title={c.status === 'BLOCKED' ? 'This customer is blocked.' : undefined}>New sales order</Button>}
    />
  )

  const notice = c.status === 'BLOCKED' || c.credit_hold ? (
    <InlineNotice tone="risk" title={c.credit_hold ? 'On credit hold' : 'Blocked'}>
      {c.credit_hold_reason || 'New orders for this customer should not be accepted until the hold is lifted.'}
    </InlineNotice>
  ) : limit > 0 && balance > limit ? (
    <InlineNotice tone="warn" title="Over credit limit">The balance of {fmt(balance)} is above the {fmt(limit)} limit.</InlineNotice>
  ) : null

  return (
    <>
      <DetailLayout
        header={header}
        notice={notice}
        summary={
          <SummaryStrip
            facts={[
              { label: 'Balance', value: <Money amount={c.current_balance} currency={currency} />, hint: 'owed by the customer' },
              { label: 'Credit limit', value: limit ? <Money amount={limit} currency={currency} digits={0} /> : '—', hint: limit ? `${fmt(Math.max(0, limit - balance))} available` : 'no limit set' },
              { label: 'Terms', value: c.credit_days != null ? `${c.credit_days} days` : '—', hint: c.payment_terms ? humanize(c.payment_terms) : undefined },
              { label: 'Open orders', value: ordersLoading ? '…' : String(openOrders.length), hint: openOrders.length ? `${fmt(openValue)} open` : 'your orders only' },
              { label: 'Credit risk', value: c.credit_risk_level ? <Badge tone={RISK_TONE[c.credit_risk_level] || 'ink'}>{humanize(c.credit_risk_level)}</Badge> : '—', hint: c.credit_check_required ? 'credit check required' : undefined },
            ]}
          />
        }
        aside={
          <>
            <Card title="History" padded>
              {!isManager ? (
                <p className="text-sm text-ink-600">Change history is visible to managers and admins.</p>
              ) : auditLoading ? (
                <p className="text-sm text-ink-500">Loading…</p>
              ) : auditError ? (
                <p className="text-sm text-ink-600">History could not be loaded.</p>
              ) : (
                <Timeline events={events.slice(0, 8)} />
              )}
            </Card>
            <RelatedPanel
              groups={[
                { label: 'Open sales orders', items: openOrders.slice(0, 6).map((o) => ({ label: o.so_number, to: `/sales/sales-orders/${o.id}`, sublabel: getSalesOrderStatusLabel(o.status) })) },
              ]}
            />
          </>
        }
      >
        <Tabs
          value={tab}
          onChange={setTab}
          label="Customer sections"
          tabs={[{ id: 'overview', label: 'Overview' }, { id: 'orders', label: 'Sales orders', count: orders.length }, { id: 'credit', label: 'Credit and tax' }, { id: 'notes', label: 'Notes' }]}
        >
          {(t) => (
            <>
              {t === 'overview' && (
                <div className="space-y-4">
                  <Card title="Contact">
                    <DescriptionList
                      items={[
                        { label: 'Primary email', value: mail(c.primary_email) },
                        { label: 'Secondary email', value: mail(c.secondary_email) },
                        { label: 'Phone', value: tel(c.phone) },
                        { label: 'Mobile', value: tel(c.mobile) },
                        { label: 'Website', value: c.website ? <a href={c.website} target="_blank" rel="noopener noreferrer" className="text-brand-700 underline-offset-2 hover:underline">{c.website}</a> : null },
                        { label: 'Legal entity', value: c.legal_entity_name },
                      ]}
                    />
                  </Card>
                  <Card title="Addresses">
                    <DescriptionList
                      items={[
                        { label: 'Billing', value: <Address c={c} kind="billing" /> },
                        { label: 'Shipping', value: c.use_billing_as_shipping ? 'Same as billing' : <Address c={c} kind="shipping" /> },
                      ]}
                    />
                  </Card>
                  <Card title="Contact people">
                    <DescriptionList
                      items={[
                        { label: 'Primary contact', value: c.primary_contact_name ? <span>{c.primary_contact_name}{c.primary_contact_title && <span className="text-ink-500"> · {c.primary_contact_title}</span>}</span> : null },
                        { label: 'Primary contact email / phone', value: [c.primary_contact_email, c.primary_contact_phone].filter(Boolean).join(' · ') || null },
                        { label: 'Secondary contact', value: c.secondary_contact_name ? <span>{c.secondary_contact_name}{c.secondary_contact_title && <span className="text-ink-500"> · {c.secondary_contact_title}</span>}</span> : null },
                        { label: 'Secondary contact email / phone', value: [c.secondary_contact_email, c.secondary_contact_phone].filter(Boolean).join(' · ') || null },
                      ]}
                    />
                  </Card>
                </div>
              )}
              {t === 'orders' && (
                <DataTable
                  caption="Sales orders for this customer"
                  noun="order"
                  rows={orders}
                  columns={orderColumns}
                  loading={ordersLoading}
                  rowHref={(o) => `/sales/sales-orders/${o.id}`}
                  defaultSort={{ id: 'date', dir: 'desc' }}
                  search={orders.length > 12}
                  empty={{ title: 'No sales orders yet', description: 'Orders you raise for this customer appear here. Orders raised by colleagues are not shown.', action: <Button variant="primary" icon={PlusIcon} to={`/sales/sales-orders/create?customer_id=${id}`}>New sales order</Button> }}
                />
              )}
              {t === 'credit' && (
                <Card>
                  <DescriptionList
                    items={[
                      { label: 'Currency', value: <Code>{currency}</Code> },
                      { label: 'Credit limit', value: limit ? <Money amount={limit} currency={currency} /> : null },
                      { label: 'Current balance', value: <Money amount={c.current_balance} currency={currency} /> },
                      { label: 'Credit days', value: c.credit_days != null ? `${c.credit_days} days` : null },
                      { label: 'Payment terms', value: c.payment_terms ? humanize(c.payment_terms) : null },
                      { label: 'Late-delivery penalty', value: c.late_delivery_penalty != null ? <Money amount={c.late_delivery_penalty} currency={currency} /> : null },
                      { label: 'Penalty per day late', value: c.late_delivery_penalty_per_day != null ? <Money amount={c.late_delivery_penalty_per_day} currency={currency} /> : null },
                      { label: 'Credit risk', value: c.credit_risk_level ? humanize(c.credit_risk_level) : null },
                      { label: 'Credit check required', value: c.credit_check_required ? 'Yes' : 'No' },
                      { label: 'Tax exempt', value: c.tax_exempt ? 'Yes' : 'No' },
                      { label: 'Tax number', value: c.tax_number },
                      { label: 'VAT number', value: c.vat_number },
                      { label: 'Tax rate', value: c.tax_rate != null ? `${Number(c.tax_rate)}%` : null },
                    ]}
                  />
                </Card>
              )}
              {t === 'notes' && (
                <Card>
                  <DescriptionList
                    columns={1}
                    items={[
                      { label: 'Customer notes', value: c.notes ? <span className="whitespace-pre-wrap">{c.notes}</span> : null },
                      { label: 'Internal notes', value: c.internal_notes ? <span className="whitespace-pre-wrap">{c.internal_notes}</span> : null },
                    ]}
                  />
                </Card>
              )}
            </>
          )}
        </Tabs>
      </DetailLayout>

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={doDelete}
        title={`Delete ${c.customer_name}?`}
        consequence="The customer disappears from lists and pickers, so nobody can quote or sell to them. Existing orders and invoices keep their reference. There is no undo in the app."
        reversible={false}
        confirmLabel={`Delete ${c.customer_name}`}
        confirmText={c.customer_code || c.customer_name}
        tone="danger"
        busy={remove.isPending}
      />
    </>
  )
}
