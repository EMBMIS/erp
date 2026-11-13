import { useState } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { PaperAirplaneIcon, TrashIcon, ShieldCheckIcon, ShieldExclamationIcon, SparklesIcon, PlusIcon, InboxArrowDownIcon } from '@heroicons/react/20/solid'
import api from '../../../services/api'
import { useResource, useResourceMutation } from '../../../hooks/useResource'
import { keys } from '../../../services/queryKeys'
import { useRecordTitle } from '../../../components/shell/ShellContext'
import {
  PageHeader, Button, Menu, Badge, StatusBadge, Money, Code, DateText, ConfirmDialog, DetailLayout, SummaryStrip,
  Tabs, Card, DescriptionList, Timeline, RelatedPanel, SkeletonDetail, ErrorState, InlineNotice, AiAnswer, notify,
} from '../../../components/ui'
import SupplierItemsPanel from './SupplierItemsPanel'
import SupplierPrecedent from '../../../components/procurement/SupplierPrecedent'

const BAND_TONE = { HIGH: 'risk', MEDIUM: 'warn', LOW: 'ink', NONE: 'ok' }
const ask = (q) => `/ai/chat?q=${encodeURIComponent(q)}`
const cap = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())

/**
 * A supplier on the record pattern: five facts, profile and items in tabs,
 * delivery risk from the same assessment Simeli uses, and history.
 */
export default function SupplierView() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [tab, setTab] = useState(params.get('tab') === 'items' ? 'items' : 'profile')
  const [confirm, setConfirm] = useState(null) // 'submit' | 'certify' | 'decertify' | 'delete'

  const { data: supplier, loading, error, refetch } = useResource(keys.supplier(id), ({ signal }) => api.get(`/suppliers/${id}`, { signal }), { enabled: !!id })
  const { data: riskData, loading: riskLoading, error: riskError } = useResource(['supplier-risk', id], ({ signal }) => api.get('/supplier-risk', { params: { supplier_id: id, include_low: 1 }, signal }), { enabled: !!id, retry: false })
  useRecordTitle(supplier?.supplier_code, { subtitle: supplier?.legal_name })

  const invalidates = [keys.supplier(id), ['suppliers']]
  const opts = { invalidates, silent: true }
  const submit = useResourceMutation(() => api.post(`/suppliers/${id}/submit-for-approval`), opts)
  const certify = useResourceMutation(() => api.post(`/suppliers/${id}/certify`), opts)
  const decertify = useResourceMutation((reason) => api.post(`/suppliers/${id}/decertify`, { reason }), opts)
  const remove = useResourceMutation(() => api.delete(`/suppliers/${id}`), { invalidates: [['suppliers']], silent: true })

  if (loading) return <SkeletonDetail />
  if (error || !supplier) {
    return <ErrorState what="Supplier" error={error || { response: { status: 404, data: { error: 'No supplier with this id is visible to you.' } } }} onRetry={refetch} />
  }

  const risk = riskData?.suppliers?.find((s) => s.supplier_id === supplier.id) || riskData?.suppliers?.[0] || null
  const name = supplier.legal_name

  const doIt = async (kind, reason) => {
    const verbs = { submit: 'submitted for approval', certify: 'certified', decertify: 'decertified', delete: 'deleted' }
    try {
      if (kind === 'submit') await submit.mutateAsync()
      if (kind === 'certify') await certify.mutateAsync()
      if (kind === 'decertify') await decertify.mutateAsync(reason)
      if (kind === 'delete') await remove.mutateAsync()
      notify.success(`${name} ${verbs[kind]}`)
      if (kind === 'delete') navigate('/procurement/suppliers')
    } catch (e) {
      const d = e?.response?.data || {}
      notify.error(`${name} was not ${verbs[kind]}: ${d.error || e.message}${d.error_id ? ` (reference ${d.error_id})` : ''}`)
    } finally {
      setConfirm(null)
    }
  }

  const CONFIRMS = {
    submit: { title: `Submit ${name} for approval?`, consequence: 'A manager with supplier authority reviews it. Once approved, the supplier is emailed to confirm the partnership.', label: 'Submit for approval', tone: 'primary' },
    certify: { title: `Certify ${name}?`, consequence: 'Certified suppliers can be put under contract.', label: `Certify ${supplier.supplier_code}`, tone: 'primary' },
    decertify: { title: `Revoke certification for ${name}?`, consequence: 'No new contracts can be made with this supplier until it is certified again. Existing contracts stay in force.', label: 'Revoke certification', tone: 'danger', requireReason: true },
    delete: { title: `Delete ${name}?`, consequence: supplier.status === 'ACTIVE' ? 'This supplier is active and may have contracts, orders or catalogue items. If other records still refer to it, the server refuses the delete.' : 'The supplier is removed from the directory.', label: `Delete ${supplier.supplier_code}`, tone: 'danger', confirmText: supplier.status === 'ACTIVE' ? supplier.supplier_code : undefined },
  }

  let primary = null
  if (supplier.status === 'DRAFT') primary = <Button variant="primary" icon={PaperAirplaneIcon} onClick={() => setConfirm('submit')}>Submit for approval</Button>
  else if (supplier.status === 'PENDING_APPROVAL') primary = <Button variant="primary" icon={InboxArrowDownIcon} to={`/approvals/unified?tab=suppliers&id=${supplier.id}`}>Review in approvals</Button>
  else if (supplier.status === 'ACTIVE' && supplier.certification_status === 'CERTIFIED') primary = <Button variant="primary" icon={PlusIcon} to={`/procurement/contracts/create?supplier_id=${supplier.id}`}>New contract</Button>
  else if (supplier.status === 'ACTIVE') primary = <Button variant="primary" icon={ShieldCheckIcon} onClick={() => setConfirm('certify')}>Certify</Button>

  const more = [
    { label: `Ask Simeli about ${name}`, icon: SparklesIcon, onSelect: () => navigate(ask(`How reliable is ${name}, and what is our exposure?`)) },
    { label: 'What did we do last time?', icon: SparklesIcon, onSelect: () => navigate(ask(`${name} is late again. What did we do last time?`)) },
    ...(supplier.status === 'ACTIVE' ? [
      { divider: true },
      { label: 'New purchase order', onSelect: () => navigate(`/procurement/purchase-orders/create?supplier_id=${supplier.id}`) },
      { label: 'New requisition', onSelect: () => navigate(`/procurement/purchase-requisitions/create?supplier_id=${supplier.id}`) },
      supplier.certification_status === 'CERTIFIED'
        ? { label: 'Revoke certification', icon: ShieldExclamationIcon, tone: 'risk', onSelect: () => setConfirm('decertify') }
        : { label: 'New contract', disabled: true, hint: 'Needs certification first' },
    ] : []),
    { divider: true },
    { label: 'Delete supplier', icon: TrashIcon, tone: 'risk', onSelect: () => setConfirm('delete') },
  ]

  const events = [
    supplier.approved_at && { title: 'Approved', actor: supplier.approved_by_name, at: supplier.approved_at, tone: 'ok' },
    { title: 'Created', actor: supplier.created_by_name || 'System', at: supplier.created_at, tone: 'ink' },
  ].filter((e) => e && e.at)

  const notice = supplier.status === 'DECLINED' ? (
    <InlineNotice tone="risk" title="Declined">{supplier.decline_reason || 'No reason was recorded.'}</InlineNotice>
  ) : supplier.status === 'PENDING_SUPPLIER_CONFIRMATION' ? (
    <InlineNotice tone="warn" title="Waiting for the supplier to confirm">Approved internally. The supplier has been emailed to confirm the partnership (partnership status: {cap(supplier.partnership_status || 'PENDING')}).</InlineNotice>
  ) : supplier.status === 'ACTIVE' && supplier.certification_status === 'PENDING' ? (
    <InlineNotice tone="ink" title="Certification needed for contracts">This supplier is approved but not certified. Purchase orders are allowed; contracts are not until a manager with certification authority certifies it.</InlineNotice>
  ) : ['NOT_CERTIFIED', 'DECLINED', 'SUSPENDED'].includes(supplier.certification_status) ? (
    <InlineNotice tone="risk" title={`Certification ${cap(supplier.certification_status).toLowerCase()}`}>No new contracts can be made with this supplier until it is certified again.</InlineNotice>
  ) : null

  const concluded = risk ? [...(risk.signals || [])].sort((a, b) => b.points - a.points).slice(0, 4).map((s) => s.text) : []

  return (
    <>
      <DetailLayout
        header={
          <PageHeader
            title={name}
            status={<StatusBadge status={supplier.status} />}
            badge={supplier.certification_status === 'CERTIFIED' ? <Badge tone="ok" glyph="check">Certified</Badge> : null}
            meta={
              <>
                <Code>{supplier.supplier_code}</Code>
                {supplier.trade_name && supplier.trade_name !== name && <span>Trading as {supplier.trade_name}</span>}
                {supplier.country && <span>{[supplier.city, supplier.country].filter(Boolean).join(', ')}</span>}
              </>
            }
            secondary={<Menu items={more} />}
            primary={primary}
          />
        }
        notice={notice}
        summary={
          <SummaryStrip
            facts={[
              { label: 'Type', value: supplier.supplier_type ? cap(supplier.supplier_type) : '—' },
              { label: 'Certification', value: supplier.certification_status ? cap(supplier.certification_status) : '—' },
              { label: 'On time', value: risk?.on_time_rate != null ? `${risk.on_time_rate}%` : '—', hint: risk?.deliveries ? `of ${risk.deliveries} deliveries, last year` : 'No delivery history yet' },
              { label: 'Open exposure', value: risk ? <Money amount={risk.open_exposure} currency={risk.currency || supplier.currency} digits={0} /> : '—', hint: risk?.overdue_lines ? `${risk.overdue_lines} line${risk.overdue_lines === 1 ? '' : 's'} overdue` : undefined },
              { label: 'Payment terms', value: supplier.payment_terms ? cap(supplier.payment_terms) : '—', hint: supplier.currency },
            ]}
          />
        }
        aside={
          <>
            <AiAnswer
              compact
              title="Delivery risk"
              loading={riskLoading}
              error={riskError ? (riskError?.response?.data?.error || 'The risk assessment could not be read.') : undefined}
              read={[{ label: supplier.supplier_code }, ...(risk?.deliveries ? [{ label: `${risk.deliveries} deliveries` }] : [])]}
              concluded={risk ? (concluded.length ? concluded : ['Nothing on this supplier\'s record raises a signal.']) : []}
              proposes={(risk?.proposals || []).slice(0, 2).map((p) => ({ id: p.label, title: p.label, detail: 'Opens Simeli with this supplier loaded; nothing is sent until you approve it.', actionLabel: 'Ask Simeli', to: ask(`${p.label} — ${name} is a ${String(risk.band).toLowerCase()} supplier risk. Help me act on this; draft anything for my approval.`) }))}
              footnote={risk ? <>Risk band <Badge tone={BAND_TONE[risk.band] || 'ink'}>{risk.band === 'NONE' ? 'No signal' : cap(risk.band)}</Badge> from delivery history, lead times, open orders and what you built in Sandbox.</> : undefined}
            />
            <SupplierPrecedent supplierId={supplier.id} name={name} />
            <Card title="History" padded>
              <Timeline events={events} />
            </Card>
            <RelatedPanel
              groups={[
                { label: 'At-risk customer orders', items: (risk?.orders_at_risk || []).slice(0, 5).map((o) => ({ label: o.so_number || 'Sales order', sublabel: o.customer_name, to: `/sales/sales-orders/${o.sales_order_id}` })) },
                { label: 'Single-source items', items: (risk?.single_source_items || []).slice(0, 5).map((x) => ({ label: x.item_code || x.name, sublabel: x.name })) },
                // What the company built in Sandbox about this supplier (quality findings, audits…), read with this person's role there.
                { label: 'Open in what you built', items: (risk?.built_records || []).map((b) => ({ label: [b.number, b.title].filter(Boolean).join(' · ') || b.entity, sublabel: b.state || b.application?.name, to: b.link })) },
              ]}
            />
          </>
        }
      >
        <Tabs value={tab} onChange={setTab} label="Supplier sections" tabs={[{ id: 'profile', label: 'Profile' }, { id: 'items', label: 'Items supplied' }]}>
          {(t) => (
            <>
              {t === 'profile' && (
                <div className="space-y-5">
                  <Card title="Company">
                    <DescriptionList
                      items={[
                        { label: 'Legal name', value: name },
                        { label: 'Trade name', value: supplier.trade_name },
                        { label: 'Supplier code', value: <Code>{supplier.supplier_code}</Code> },
                        { label: 'Type', value: supplier.supplier_type ? cap(supplier.supplier_type) : null },
                        { label: 'Tax ID', value: supplier.tax_id },
                      ]}
                    />
                  </Card>
                  <Card title="Contact">
                    <DescriptionList
                      items={[
                        { label: 'Email', value: supplier.email ? <a className="text-brand-600 underline-offset-2 hover:underline" href={`mailto:${supplier.email}`}>{supplier.email}</a> : null },
                        { label: 'Phone', value: supplier.phone ? <a className="text-brand-600 underline-offset-2 hover:underline" href={`tel:${supplier.phone}`}>{supplier.phone}</a> : null },
                        { label: 'Address', value: [supplier.address, [supplier.city, supplier.postal_code].filter(Boolean).join(' '), supplier.country].filter(Boolean).join(', ') || null, wide: true },
                      ]}
                    />
                  </Card>
                  <Card title="Terms">
                    <DescriptionList
                      items={[
                        { label: 'Payment terms', value: supplier.payment_terms ? cap(supplier.payment_terms) : null },
                        { label: 'Currency', value: supplier.currency ? <Code>{supplier.currency}</Code> : null },
                        { label: 'Bank', value: supplier.bank_name },
                        { label: 'Bank account', value: supplier.bank_account_number ? <Code>{`•••• ${String(supplier.bank_account_number).slice(-4)}`}</Code> : null },
                        { label: 'Created', value: <span>{supplier.created_by_name || 'System'} · <DateText value={supplier.created_at} /></span> },
                        { label: 'Approved', value: supplier.approved_by_name ? <span>{supplier.approved_by_name} · <DateText value={supplier.approved_at} /></span> : null },
                      ]}
                    />
                  </Card>
                </div>
              )}
              {t === 'items' && <SupplierItemsPanel supplier={supplier} />}
            </>
          )}
        </Tabs>
      </DetailLayout>

      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={(reason) => doIt(confirm, reason)}
          title={CONFIRMS[confirm].title}
          consequence={CONFIRMS[confirm].consequence}
          reversible={confirm === 'certify' || confirm === 'decertify'}
          confirmLabel={CONFIRMS[confirm].label}
          tone={CONFIRMS[confirm].tone}
          requireReason={CONFIRMS[confirm].requireReason}
          reasonHelp="Recorded on the supplier's history."
          confirmText={CONFIRMS[confirm].confirmText}
          busy={submit.isPending || certify.isPending || decertify.isPending || remove.isPending}
        />
      )}
    </>
  )
}
