import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { CheckCircleIcon, TrashIcon, PlusIcon, SparklesIcon, TrophyIcon, PencilSquareIcon } from '@heroicons/react/20/solid'
import api from '../../../services/api'
import { useAuth } from '../../../contexts/AuthContext'
import { useResource, useResourceMutation } from '../../../hooks/useResource'
import { keys } from '../../../services/queryKeys'
import { useRecordTitle } from '../../../components/shell/ShellContext'
import {
  PageHeader, Button, Menu, StatusBadge, Badge, Money, Num, Code, DateText, ConfirmDialog, DetailLayout, SummaryStrip,
  Tabs, Card, DescriptionList, Timeline, RelatedPanel, DataTable, RowAction, SkeletonDetail, ErrorState, InlineNotice, EmptyState,
  daysFrom, describeError, notify,
} from '../../../components/ui'

const list = (d) => (Array.isArray(d) ? d : [])

/** A request for quotation: what is asked, of whom, and what came back. */
export default function RFQView() {
  const { user } = useAuth()
  const { id } = useParams()
  const navigate = useNavigate()
  const [tab, setTab] = useState('lines')
  const [confirm, setConfirm] = useState(null) // { kind, supplier? }

  const { data: rfq, loading, error, refetch } = useResource(keys.rfq(id), ({ signal }) => api.get(`/request-for-quotations/${id}`, { signal }), { enabled: !!id })
  const { data: linesData, loading: linesLoading } = useResource([...keys.rfq(id), 'line-items'], ({ signal }) => api.get(`/request-for-quotations/${id}/line-items`, { signal }), { enabled: !!id })
  const { data: suppliersData, loading: suppliersLoading } = useResource([...keys.rfq(id), 'suppliers'], ({ signal }) => api.get(`/request-for-quotations/${id}/suppliers`, { signal }), { enabled: !!id })
  const { data: quotesData, loading: quotesLoading } = useResource([...keys.rfq(id), 'quotations'], ({ signal }) => api.get(`/request-for-quotations/${id}/quotations`, { signal }), { enabled: !!id })
  const lines = list(linesData)
  const suppliers = list(suppliersData)
  const quotes = useMemo(() => list(quotesData), [quotesData])
  useRecordTitle(rfq?.rfq_number, { subtitle: rfq?.title })

  const invalidates = [keys.rfq(id), ['rfqs']]
  const submit = useResourceMutation(() => api.post(`/request-for-quotations/${id}/submit`), { invalidates, silent: true })
  const remove = useResourceMutation(() => api.delete(`/request-for-quotations/${id}`), { invalidates: [['rfqs']], silent: true })
  const select = useResourceMutation(({ supplierId, reason }) => api.post(`/request-for-quotations/${id}/select-supplier`, { winning_supplier_id: supplierId, selection_reason: reason }), { invalidates, silent: true })
  const autoSelect = useResourceMutation(() => api.post(`/request-for-quotations/${id}/auto-select-supplier`), { invalidates, silent: true })

  // One row per supplier: what they quoted in total and how fast.
  const bySupplier = useMemo(() => {
    const m = new Map()
    for (const q of quotes) {
      const s = m.get(q.supplier_id) || { supplier_id: q.supplier_id, supplier_name: q.supplier_name, supplier_code: q.supplier_code, lines: 0, total: 0, lead: [] }
      s.lines += 1
      s.total += (Number(q.unit_price) || 0) * (Number(q.quantity) || 0)
      if (q.lead_time_days != null) s.lead.push(Number(q.lead_time_days))
      m.set(q.supplier_id, s)
    }
    const arr = [...m.values()].map((s) => ({ ...s, lead: s.lead.length ? Math.max(...s.lead) : null }))
    const complete = arr.filter((s) => s.lines >= lines.length)
    const best = (complete.length ? complete : arr).reduce((b, s) => (!b || s.total < b.total ? s : b), null)
    return arr.map((s) => ({ ...s, cheapest: best && s.supplier_id === best.supplier_id && arr.length > 1 }))
  }, [quotes, lines.length])

  if (loading) return <SkeletonDetail />
  if (error || !rfq) return <ErrorState what="RFQ" error={error} onRetry={refetch} />

  const canDelete = rfq.status === 'DRAFT' || user?.role === 'MANAGER' || user?.role === 'ADMIN'
  const deciding = rfq.status === 'RESPONSES_RECEIVED'
  const winner = bySupplier.find((s) => s.supplier_id === rfq.winning_supplier_id)
  const deadlineDays = rfq.response_deadline ? daysFrom(rfq.response_deadline) : null
  // Only a supplier who quoted every line can be compared on total; fall back to partial quotes if none did.
  const complete = bySupplier.filter((s) => s.lines >= lines.length)
  const lowest = (complete.length ? complete : bySupplier).reduce((b, s) => (!b || s.total < b.total ? s : b), null)

  const act = async (kind, arg) => {
    try {
      if (kind === 'submit') { await submit.mutateAsync(); notify.success(`${rfq.rfq_number} submitted for approval`) }
      if (kind === 'delete') { await remove.mutateAsync(); notify.success(`${rfq.rfq_number} deleted`); navigate('/procurement/rfqs'); return }
      if (kind === 'select') { await select.mutateAsync({ supplierId: confirm.supplier.supplier_id, reason: arg }); notify.success(`${confirm.supplier.supplier_name} selected for ${rfq.rfq_number}`) }
      if (kind === 'auto') { const r = await autoSelect.mutateAsync(); notify.success(`Best supplier selected: ${r?.supplier_name || r?.legal_name || 'see the RFQ'}`) }
      setConfirm(null)
    } catch (e) {
      setConfirm(null)
      notify.error(describeError(e).message)
    }
  }

  let primary = null
  const secondary = []
  if (rfq.status === 'DRAFT') {
    primary = <Button variant="primary" icon={CheckCircleIcon} onClick={() => setConfirm({ kind: 'submit' })}>Submit for approval</Button>
    // There is no RFQ edit route, so editing is not offered (the old button led to a blank page).
    secondary.push(<Button key="edit" icon={PencilSquareIcon} disabled title="Editing a draft RFQ is not available yet. Delete it and raise a new one.">Edit</Button>)
  } else if (deciding && quotes.length > 0) {
    primary = <Button variant="primary" icon={SparklesIcon} onClick={() => setConfirm({ kind: 'auto' })}>Select best supplier</Button>
  } else if (rfq.status === 'SUPPLIER_SELECTED') {
    primary = <Button variant="primary" icon={PlusIcon} to={`/procurement/purchase-orders/create?rfq_id=${id}`}>Create purchase order</Button>
  }

  const CONFIRMS = {
    submit: { title: `Submit ${rfq.rfq_number} for approval?`, consequence: 'Once approved it is sent to the invited suppliers. You cannot change it while it waits.', label: 'Submit for approval', tone: 'primary' },
    delete: { title: `Delete ${rfq.rfq_number}?`, consequence: `The RFQ, its ${lines.length} line${lines.length === 1 ? '' : 's'}${quotes.length ? ` and ${quotes.length} received quotation${quotes.length === 1 ? '' : 's'}` : ''} are removed.`, label: `Delete ${rfq.rfq_number}`, tone: 'danger', confirmText: rfq.status !== 'DRAFT' ? rfq.rfq_number : undefined },
    auto: { title: 'Select the best supplier automatically?', consequence: 'The scoring engine weighs price, lead time and certification across the quotations and records the winner. You can then create the purchase order.', label: 'Select best supplier', tone: 'primary' },
    select: confirm?.supplier && { title: `Select ${confirm.supplier.supplier_name}?`, consequence: `${confirm.supplier.supplier_name} wins ${rfq.rfq_number}. The reason is kept with the RFQ for audit.`, label: 'Select supplier', tone: 'primary', requireReason: true, reasonLabel: 'Why this supplier', reasonHelp: 'Kept on the RFQ for audit — price, lead time, quality, sole source…' },
  }
  const c = confirm && CONFIRMS[confirm.kind]

  const lineColumns = [
    { id: 'desc', header: 'Item', accessor: 'item_description', mobile: 'title', minWidth: 220, wrap: true, cell: (l) => <span><span className="block">{l.item_description}</span>{l.item_name && <span className="block text-xs text-ink-500"><Code>{l.approved_item_code}</Code> · {l.item_name}</span>}</span> },
    { id: 'qty', header: 'Quantity', accessor: (l) => Number(l.quantity), align: 'right', width: 130, mobile: 'trailing', cell: (l) => <Num value={l.quantity} digits={Number(l.quantity) % 1 ? 2 : 0} unit={l.unit_of_measure} /> },
    { id: 'spec', header: 'Specifications', accessor: 'specifications', minWidth: 200, wrap: true, cell: (l) => l.specifications || <span className="text-ink-400">—</span> },
  ]
  const supplierColumns = [
    { id: 'name', header: 'Supplier', accessor: 'legal_name', mobile: 'title', minWidth: 200, cell: (s) => <span><span className="block">{s.legal_name}</span><Code className="text-xs text-ink-500">{s.supplier_code}</Code></span> },
    { id: 'cert', header: 'Certification', accessor: 'certification_status', width: 170, mobile: 'meta', cell: (s) => (s.certification_status ? <StatusBadge status={s.certification_status} /> : <span className="text-ink-400">—</span>) },
    { id: 'quoted', header: 'Quoted', accessor: (s) => bySupplier.find((b) => b.supplier_id === s.id)?.lines || 0, align: 'right', width: 110, cell: (s) => { const b = bySupplier.find((x) => x.supplier_id === s.id); return b ? `${b.lines} of ${lines.length}` : <span className="text-ink-500">No reply</span> } },
  ]
  const compareColumns = [
    { id: 'supplier', header: 'Supplier', accessor: 'supplier_name', mobile: 'title', minWidth: 200, cell: (s) => <span className="flex items-center gap-2"><span><span className="block">{s.supplier_name}</span><Code className="text-xs text-ink-500">{s.supplier_code}</Code></span>{s.supplier_id === rfq.winning_supplier_id && <Badge tone="ok" glyph="check">Selected</Badge>}{s.cheapest && s.supplier_id !== rfq.winning_supplier_id && <Badge tone="ink">Lowest total</Badge>}</span> },
    { id: 'lines', header: 'Lines quoted', accessor: 'lines', align: 'right', width: 120, cell: (s) => `${s.lines} of ${lines.length}` },
    { id: 'lead', header: 'Longest lead time', accessor: 'lead', align: 'right', width: 150, cell: (s) => (s.lead == null ? '—' : <Num value={s.lead} unit="days" />) },
    { id: 'total', header: 'Total', accessor: 'total', align: 'right', width: 150, mobile: 'trailing', cell: (s) => <Money amount={s.total} currency={rfq.currency} /> },
  ]
  const quoteColumns = [
    { id: 'supplier', header: 'Supplier', accessor: 'supplier_name', filter: 'select', mobile: 'title', width: 170 },
    { id: 'item', header: 'Line', accessor: 'item_description', minWidth: 160, mobile: 'subtitle' },
    { id: 'qty', header: 'Qty', accessor: (q) => Number(q.quantity), align: 'right', width: 110, cell: (q) => <Num value={q.quantity} unit={q.unit_of_measure} /> },
    { id: 'unit', header: 'Unit price', accessor: (q) => Number(q.unit_price), align: 'right', width: 130, cell: (q) => <Money amount={q.unit_price} currency={rfq.currency} /> },
    { id: 'total', header: 'Line total', accessor: (q) => Number(q.unit_price) * Number(q.quantity), align: 'right', width: 140, mobile: 'trailing', cell: (q) => <Money amount={(Number(q.unit_price) || 0) * (Number(q.quantity) || 0)} currency={rfq.currency} /> },
    { id: 'lead', header: 'Lead time', accessor: (q) => Number(q.lead_time_days), align: 'right', width: 110, cell: (q) => (q.lead_time_days ? <Num value={q.lead_time_days} unit="days" /> : '—') },
  ]

  const events = [
    rfq.status === 'SUPPLIER_SELECTED' && { title: `Supplier selected${winner ? `: ${winner.supplier_name}` : ''}`, at: rfq.updated_at, tone: 'ok', note: rfq.selection_reason },
    quotes.length > 0 && { title: `${quotes.length} quotation line${quotes.length === 1 ? '' : 's'} received`, tone: 'ink' },
    rfq.updated_at && rfq.updated_at !== rfq.created_at && rfq.status !== 'SUPPLIER_SELECTED' && { title: 'Last changed', at: rfq.updated_at, tone: 'ink' },
    { title: 'Created', actor: rfq.created_by_name, at: rfq.created_at, tone: 'ink' },
  ].filter(Boolean)

  return (
    <>
      <DetailLayout
        header={
          <PageHeader
            title={rfq.rfq_number}
            status={<StatusBadge status={rfq.status} />}
            description={rfq.title}
            secondary={<>{secondary}{canDelete && <Menu items={[{ label: `Delete ${rfq.rfq_number}`, tone: 'risk', icon: TrashIcon, onSelect: () => setConfirm({ kind: 'delete' }) }]} />}</>}
            primary={primary}
          />
        }
        notice={deciding && !quotesLoading && quotes.length === 0 ? (
          <InlineNotice tone="warn" title="No quotations recorded yet">The RFQ is marked as having responses, but no quotation lines have been recorded against it.</InlineNotice>
        ) : rfq.status === 'SUPPLIER_SELECTED' ? (
          <InlineNotice tone="ok" title={`${winner?.supplier_name || 'A supplier'} selected`} action={<Button size="sm" to={`/procurement/purchase-orders/create?rfq_id=${id}`}>Create purchase order</Button>}>{rfq.selection_reason || 'The winning quote is ready to become a purchase order.'}</InlineNotice>
        ) : null}
        summary={
          <SummaryStrip
            facts={[
              { label: 'Response deadline', value: rfq.response_deadline ? <DateText value={rfq.response_deadline} /> : '—', hint: deadlineDays == null ? null : deadlineDays < 0 ? `${Math.abs(deadlineDays)} days ago` : deadlineDays === 0 ? 'today' : `in ${deadlineDays} days` },
              { label: 'Lines', value: linesLoading ? '…' : lines.length },
              { label: 'Suppliers invited', value: suppliersLoading ? '…' : suppliers.length, hint: bySupplier.length ? `${bySupplier.length} replied` : 'no replies yet' },
              { label: winner ? 'Selected total' : 'Lowest full quote', value: winner ? <Money amount={winner.total} currency={rfq.currency} /> : lowest ? <Money amount={lowest.total} currency={rfq.currency} /> : '—', hint: winner?.supplier_name || (lowest ? `${lowest.supplier_name}${lowest.lines < lines.length ? ' · partial quote' : ''}` : null) },
              { label: 'Currency', value: rfq.currency || '—' },
            ]}
          />
        }
        aside={
          <>
            <Card title="History"><Timeline events={events} /></Card>
            <RelatedPanel groups={[
              { label: 'Requisition', items: rfq.pr_number ? [{ label: rfq.pr_number, to: rfq.purchase_requisition_id ? `/procurement/purchase-requisitions/${rfq.purchase_requisition_id}` : undefined }] : [] },
            ]} />
          </>
        }
      >
        <Tabs
          value={tab}
          onChange={setTab}
          label="RFQ sections"
          tabs={[{ id: 'lines', label: 'Lines', count: lines.length }, { id: 'suppliers', label: 'Suppliers', count: suppliers.length }, { id: 'quotes', label: 'Quotations', count: bySupplier.length }, { id: 'details', label: 'Details' }]}
        >
          {(t) => (
            <>
              {t === 'lines' && <DataTable caption="Lines" noun="line" rows={lines} columns={lineColumns} loading={linesLoading} search={false} showCount={false} empty={{ title: 'No lines', description: 'This RFQ has no lines to quote on.' }} />}
              {t === 'suppliers' && <DataTable caption="Invited suppliers" noun="supplier" rows={suppliers} columns={supplierColumns} loading={suppliersLoading} search={false} showCount={false} rowHref={(s) => `/procurement/suppliers/${s.id}`} empty={{ title: 'No suppliers invited', description: 'Suppliers are chosen when the RFQ is created.' }} />}
              {t === 'quotes' && (
                quotes.length === 0 && !quotesLoading ? (
                  <EmptyState icon={TrophyIcon} title="No quotations yet" description={rfq.status === 'DRAFT' ? 'Quotations arrive after the RFQ is approved and sent to suppliers.' : 'Suppliers have not quoted yet. Their replies appear here.'} />
                ) : (
                  <div className="space-y-5">
                    <DataTable
                      caption="Compare suppliers"
                      noun="supplier"
                      rows={bySupplier}
                      rowKey="supplier_id"
                      columns={compareColumns}
                      loading={quotesLoading}
                      search={false}
                      showCount={false}
                      defaultSort={{ id: 'total', dir: 'asc' }}
                      rowActions={deciding ? (s) => <RowAction icon={TrophyIcon} label={`Select ${s.supplier_name}`} onClick={() => setConfirm({ kind: 'select', supplier: s })} /> : undefined}
                    />
                    <DataTable caption="Quotation lines" noun="quotation line" rows={quotes} columns={quoteColumns} loading={quotesLoading} showCount={false} searchPlaceholder="Search supplier or line" />
                  </div>
                )
              )}
              {t === 'details' && (
                <Card>
                  <DescriptionList items={[
                    { label: 'Description', value: rfq.description, wide: true },
                    { label: 'Response deadline', value: rfq.response_deadline && <DateText value={rfq.response_deadline} /> },
                    { label: 'Currency', value: rfq.currency },
                    { label: 'Created by', value: rfq.created_by_name },
                    { label: 'Created', value: <DateText value={rfq.created_at} withTime /> },
                    { label: 'Based on requisition', value: rfq.pr_number && <Code>{rfq.pr_number}</Code> },
                  ]} />
                </Card>
              )}
            </>
          )}
        </Tabs>
      </DetailLayout>

      {c && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={(reason) => act(confirm.kind, reason)}
          title={c.title}
          consequence={c.consequence}
          confirmLabel={c.label}
          tone={c.tone}
          requireReason={c.requireReason}
          reasonLabel={c.reasonLabel}
          reasonHelp={c.reasonHelp}
          confirmText={c.confirmText}
          busy={submit.isPending || remove.isPending || select.isPending || autoSelect.isPending}
        />
      )}
    </>
  )
}
