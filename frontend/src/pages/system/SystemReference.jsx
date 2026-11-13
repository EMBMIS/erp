import { useState } from 'react'
import clsx from 'clsx'
import {
  PlusIcon, PencilSquareIcon, TrashIcon, CheckIcon, XMarkIcon, ArrowDownTrayIcon, EyeIcon, InboxIcon, DocumentTextIcon,
} from '@heroicons/react/20/solid'
import {
  Button, IconButton, Kbd, Field, Input, Textarea, Select, Checkbox, Switch, FormSection, ErrorSummary,
  Badge, StatusBadge, MaturityBadge, Card, Breadcrumbs, PageHeader, Tabs, Segmented, Menu, Tooltip, Stat,
  Dialog, Sheet, ConfirmDialog, EmptyState, ErrorState, InlineNotice, Skeleton, SkeletonRows, Timeline,
  SummaryStrip, DescriptionList, RelatedPanel, Money, Num, Variance, Code, DateText, DataTable, RowAction,
  BulkAction, LineItemEditor, Combobox, notify, AiAnswer, Provenance,
} from '../../components/ui'
import { RAMPS, STEPS, SURFACE } from '../../../scripts/design/palette.mjs'

/**
 * /system — the living reference for the EMBMIS design system.
 *
 * Every component, in every state, in both themes. Static sections render
 * twice, side by side, inside `.light` and `.dark` scopes (the tokens are
 * scopable for exactly this). Everything on this page is sample data and is
 * labelled as such — it is the one screen allowed to show invented records.
 */

const hexToRgb = (h) => [0, 2, 4].map((i) => parseInt(h.slice(1 + i, 3 + i), 16))
const lum = (h) => {
  const [r, g, b] = hexToRgb(h).map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) }

function Section({ id, title, description, children }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-20 space-y-3 border-t border-ink-200 pt-8">
      <div>
        <h2 id={`${id}-h`} className="text-lg font-semibold text-fg">{title}</h2>
        {description && <p className="mt-1 max-w-3xl text-sm text-ink-600">{description}</p>}
      </div>
      {children}
    </section>
  )
}

/** Renders children once per theme, side by side. */
function Both({ children, className }) {
  return (
    <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
      {['light', 'dark'].map((t) => (
        <div key={t} className={clsx(t, 'rounded-lg border border-ink-200 p-4')} style={{ background: 'var(--bg)', color: 'var(--fg)' }}>
          <p className="label-mono mb-3">{t}</p>
          <div className={className}>{children}</div>
        </div>
      ))}
    </div>
  )
}

function Ramp({ name, theme }) {
  const r = RAMPS[name][theme]
  const surface = SURFACE[theme].surface
  return (
    <div>
      <p className="mb-1 font-mono text-2xs text-ink-500">{name}</p>
      <div className="grid grid-cols-11 overflow-hidden rounded-md border border-ink-200">
        {STEPS.map((s, i) => (
          <div key={s} className="h-10" style={{ background: r.bg[i] }} title={`bg ${name}-${s} ${r.bg[i]}`} />
        ))}
      </div>
      <div className="mt-1 grid grid-cols-11 text-center">
        {STEPS.map((s, i) => {
          const c = ratio(r.text[i], surface)
          return (
            <div key={s} className="font-mono text-[9px] leading-tight">
              <span style={{ color: r.text[i] }} className="font-semibold">Aa</span>
              <span className={clsx('block', c >= 4.5 ? 'text-ink-500' : 'text-ink-400')}>{s}</span>
              <span className="block text-ink-400">{c.toFixed(1)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const SAMPLE_ROWS = Array.from({ length: 240 }).map((_, i) => {
  const statuses = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT_TO_SUPPLIER', 'REJECTED', 'CLOSED', 'OVERDUE']
  const suppliers = ['Sample Steel AS', 'Example Fasteners', 'Demo Components GmbH', 'Placeholder Packaging Ltd']
  return {
    id: i + 1,
    number: `PO-DEMO-${String(1000 + i)}`,
    supplier: suppliers[i % suppliers.length],
    amount: Math.round(((i * 7919) % 20000) * 100 + 12345) / 100,
    variance: ((i * 37) % 41) - 20,
    due: new Date(Date.now() + (((i * 13) % 40) - 15) * 864e5).toISOString(),
    status: statuses[i % statuses.length],
  }
})

const SAMPLE_COLUMNS = [
  { id: 'number', header: 'PO', accessor: 'number', cell: (r) => <Code>{r.number}</Code>, width: 150, mobile: 'title' },
  { id: 'supplier', header: 'Supplier', accessor: 'supplier', filter: 'select', mobile: 'subtitle' },
  { id: 'status', header: 'Status', accessor: 'status', cell: (r) => <StatusBadge status={r.status} />, filter: 'select', mobile: 'meta' },
  { id: 'due', header: 'Due', accessor: 'due', cell: (r) => <DateText value={r.due} /> },
  { id: 'variance', header: 'Variance', accessor: 'variance', align: 'right', cell: (r) => <Variance value={r.variance} goodWhen="down" />, filter: 'number' },
  { id: 'amount', header: 'Amount', accessor: 'amount', align: 'right', cell: (r) => <Money amount={r.amount} />, filter: 'number', mobile: 'trailing', editable: { type: 'number', validate: (v) => (v < 0 ? 'Must be zero or more' : null) }, footer: (rows) => <Money amount={rows.reduce((s, r) => s + r.amount, 0)} /> },
]

const ALL_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'POSTED', 'CLOSED', 'OVERDUE', 'CANCELLED', 'ACTIVE', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'LOW_STOCK']

export default function SystemReference() {
  const [dialog, setDialog] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [sw, setSw] = useState(true)
  const [seg, setSeg] = useState('Month')
  const [combo, setCombo] = useState('')
  const [rows, setRows] = useState(SAMPLE_ROWS)
  const [lines, setLines] = useState([
    { _key: 1, item: 'Sample bolt M8', qty: '200', price: '0.18', account: '5000' },
    { _key: 2, item: 'Sample plate 3mm', qty: '4', price: '86.50', account: '5000' },
  ])

  const nav = [
    ['tokens', 'Tokens'], ['type', 'Type'], ['buttons', 'Buttons'], ['forms', 'Forms'], ['status', 'Status'],
    ['layout', 'Page & cards'], ['feedback', 'Feedback'], ['overlays', 'Overlays'], ['table', 'DataTable'],
    ['detail', 'Detail pattern'], ['lines', 'Line items'], ['simeli', 'Simeli'],
  ]

  return (
    <div className="mx-auto max-w-[1400px] space-y-8 px-4 py-6 sm:px-6">
      <PageHeader
        breadcrumbs={[{ label: 'Settings', to: '/admin/overview' }, { label: 'Design system' }]}
        title="Design system"
        badge={<MaturityBadge level="demo" title="Every record on this page is invented for illustration." />}
        description="Every component in every state, in both themes. Tokens come from scripts/design/palette.mjs; contrast is checked at build time. All records on this page are sample data."
      />
      <nav aria-label="On this page" className="flex flex-wrap gap-1.5">
        {nav.map(([id, l]) => <a key={id} href={`#${id}`} className="rounded-md border border-ink-200 px-2 py-1 text-xs text-ink-700 hover:bg-ink-100">{l}</a>)}
      </nav>

      <Section id="tokens" title="Colour" description="Five ramps. Ink for everything; Ultramarine only when the system is acting or for the primary action; ok, warn and risk only for state. Numbers under each step are the text ramp's contrast on a surface — AA needs 4.5.">
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {['light', 'dark'].map((t) => (
            <div key={t} className={clsx(t, 'space-y-3 rounded-lg border border-ink-200 p-4')} style={{ background: 'var(--bg-surface)', color: 'var(--fg)' }}>
              <p className="label-mono">{t}</p>
              {Object.keys(RAMPS).map((n) => <Ramp key={n} name={n} theme={t} />)}
            </div>
          ))}
        </div>
      </Section>

      <Section id="type" title="Type" description="Instrument Sans for reading; JetBrains Mono for identifiers, codes and compact uppercase labels. Numbers that are compared are tabular.">
        <Both className="space-y-2">
          <p className="text-2xl font-semibold tracking-tight">Purchase orders · 2xl / 600</p>
          <p className="text-lg font-semibold">Section heading · lg / 600</p>
          <p className="text-base">Body text at 14px. The quick brown fox audits the ledger.</p>
          <p className="text-sm text-ink-600">Secondary text at 13px, the default inside tables and forms.</p>
          <p className="label-mono">Mono label · 11px uppercase</p>
          <p><Code>PO-2026-1004</Code> · <Code>SUP-001011</Code> · <Code>4000-REV</Code></p>
          <p className="tabular-nums">1,204.50 · 98,310.00 · 7.25 — tabular</p>
        </Both>
      </Section>

      <Section id="buttons" title="Buttons" description="One primary per screen. Destructive actions are outlined until hovered and always confirm in words.">
        <Both className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={PlusIcon}>New purchase order</Button>
            <Button>Export</Button>
            <Button variant="ghost">Cancel</Button>
            <Button variant="destructive" icon={TrashIcon}>Reject</Button>
            <Button variant="danger">Reject PO-2026-1007</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm">Small</Button>
            <Button variant="primary" size="lg">Large</Button>
            <Button variant="primary" loading>Saving</Button>
            <Button variant="primary" disabled>Disabled</Button>
            <Button kbd="⌘S">Save draft</Button>
            <IconButton icon={PencilSquareIcon} label="Edit" />
            <IconButton icon={ArrowDownTrayIcon} label="Download" variant="secondary" />
            <Kbd>⌘</Kbd><Kbd>K</Kbd>
          </div>
        </Both>
      </Section>

      <Section id="forms" title="Forms" description="Label above, help below, error below replacing help and saying how to fix it. Validation on blur. Required says so in words.">
        <Both className="space-y-4">
          <ErrorSummary errors={{ 'ref-supplier': 'Choose a supplier', 'ref-date': 'Delivery date must be after the order date' }} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Supplier" required help="Only approved suppliers appear here."><Input placeholder="Search suppliers" /></Field>
            <Field label="Delivery date" required error="Delivery date must be after the order date. Pick 9 Oct or later."><Input type="date" defaultValue="2026-10-01" /></Field>
            <Field label="Currency"><Select defaultValue="USD"><option>USD</option><option>EUR</option><option>NOK</option></Select></Field>
            <Field label="Amount" help="Excluding VAT."><Input numeric prefix="USD" defaultValue="1,204.50" /></Field>
            <Field label="Reference" optional><Input disabled value="Generated on save" readOnly /></Field>
            <Field label="Item"><Combobox value={combo} onChange={setCombo} options={[{ value: '1', label: 'Hex bolt M8 x 40', meta: 'ITM-0001', description: 'pcs · Raw materials' }, { value: '2', label: 'Steel plate 3mm', meta: 'ITM-0002' }, { value: '3', label: 'Bearing 6204-2RS', meta: 'ITM-0005' }]} placeholder="Type to search items" /></Field>
            <Field label="Notes to supplier" className="sm:col-span-2"><Textarea placeholder="Shown on the PO PDF" /></Field>
            <Checkbox label="Send to supplier on approval" description="The supplier receives the PDF when the last approver signs." defaultChecked />
            <Switch checked={sw} onChange={setSw} label="Three-way match" />
          </div>
        </Both>
        <FormSection title="Advanced — shipping and incoterms" description="Most orders use the defaults" advanced>
          <Field label="Incoterms"><Select><option>FOB — Free on board</option><option>DAP — Delivered at place</option></Select></Field>
          <Field label="Ship via" optional><Input /></Field>
        </FormSection>
      </Section>

      <Section id="status" title="Status" description="One vocabulary across modules. Each state has a tone and a glyph, so it reads without colour. Modules keep their own words as the label.">
        <Both className="flex flex-wrap gap-2">
          {ALL_STATUSES.map((s) => <StatusBadge key={s} status={s} />)}
          <StatusBadge status="SENT_TO_SUPPLIER" />
          <Badge tone="brand">Simeli</Badge>
          <MaturityBadge level="beta" /><MaturityBadge level="preview" /><MaturityBadge level="demo" /><MaturityBadge level="unavailable" />
        </Both>
      </Section>

      <Section id="layout" title="Page header, cards and numbers">
        <Both className="space-y-4">
          <PageHeader
            breadcrumbs={[{ label: 'Procurement', to: '#' }, { label: 'Purchase orders', to: '#' }, { label: 'PO-2026-1004' }]}
            title="PO-2026-1004"
            status={<StatusBadge status="PENDING_APPROVAL" />}
            meta={<><span>Sample Steel AS</span><span>Raised by Ada Admin</span><DateText value={new Date()} /></>}
            secondary={<><Button>Print</Button><Menu items={[{ label: 'Duplicate' }, { label: 'Send reminder' }, { divider: true }, { label: 'Cancel order', tone: 'risk' }]} /></>}
            primary={<Button variant="primary" icon={CheckIcon}>Approve</Button>}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Stat label="Cash position" value={<Money amount={74920} digits={0} />} delta={<Variance value={-4.2} />} reason="Two supplier runs cleared on Tuesday." to="#" />
            <Stat label="Overdue receivables" value={<Money amount={18420} digits={0} />} delta={<Variance value={12} goodWhen="down" />} reason="3 invoices, oldest 31 days." to="#" />
            <Stat label="Awaiting you" value={<Num value={7} />} reason="Highest: PO-2026-1005, $13,260." loading={false} />
          </div>
          <Card title="Card title" description="One line on what this group is" actions={<Button size="sm">Action</Button>}>
            <p className="text-sm text-ink-700">Cards group things that belong together. Hairline border, no shadow.</p>
            <p className="mt-2 text-sm"><Provenance method="Sum of open customer invoices past their due date, in USD at today's rate." sources={[{ label: 'INV-DEMO-104', value: '$9,800.00' }, { label: 'INV-DEMO-099', value: '$6,220.00' }, { label: 'INV-DEMO-087', value: '$2,400.00' }]} asOf={new Date()}><Money amount={18420} /></Provenance> — click the figure to see where it comes from.</p>
          </Card>
          <div className="flex flex-wrap items-center gap-3">
            <Segmented options={['Week', 'Month', 'Quarter']} value={seg} onChange={setSeg} label="Period" />
            <Tooltip content="Tooltips never hold the only copy of information."><Button size="sm">Hover or focus me</Button></Tooltip>
            <Breadcrumbs items={[{ label: 'Finance', to: '#' }, { label: 'Journal entries' }]} />
          </div>
          <Tabs tabs={[{ id: 'lines', label: 'Lines', count: 4 }, { id: 'receipts', label: 'Receipts', count: 0 }, { id: 'history', label: 'History' }]}>
            {(t) => <p className="text-sm text-ink-600">Panel: {t}. Arrow keys move between tabs.</p>}
          </Tabs>
        </Both>
      </Section>

      <Section id="feedback" title="Feedback" description="Skeletons shaped like the content. Empty states say what the list is and offer the next step. Errors say what failed, what to do, and give a reference.">
        <Both className="space-y-4">
          <InlineNotice tone="ok" title="Saved">PO-2026-1004 was sent for approval to Maria Lind.</InlineNotice>
          <InlineNotice tone="warn" title="Example: a feature in beta">Say what works, what does not yet, and what to do instead.</InlineNotice>
          <SkeletonRows rows={3} columns={4} />
          <EmptyState icon={InboxIcon} title="No purchase orders yet" description="Purchase orders commit spend with a supplier. They appear here when you raise one or approve a requisition." action={<Button variant="primary" icon={PlusIcon}>New purchase order</Button>} />
          <ErrorState what="Purchase orders" error={{ response: { status: 500, data: { error: 'The ledger service did not answer in time.', error_id: '3b893136-47cd-4373' } } }} onRetry={() => {}} compact />
          <div className="flex gap-2"><Skeleton className="w-24" /><Skeleton className="w-40" /></div>
        </Both>
      </Section>

      <Section id="overlays" title="Overlays" description="Dialogs trap focus and restore it. On a phone a dialog becomes a bottom sheet. Destructive confirmations name the consequence and say whether it can be undone.">
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setDialog(true)}>Open dialog</Button>
          <Button variant="destructive" onClick={() => setConfirm(true)}>Reject with reason</Button>
          <Button onClick={() => setSheet(true)}>Open sheet</Button>
          <Button onClick={() => notify.success('PO-2026-1004 sent to Sample Steel AS')}>Toast: outcome</Button>
          <Button onClick={() => notify.undo('3 approvals recorded', { onUndo: () => notify.info('Approvals withdrawn') })}>Toast: undo</Button>
        </div>
        <Dialog open={dialog} onClose={() => setDialog(false)} title="Delegate approval" description="Hand this decision to someone with the authority to make it." footer={<><Button onClick={() => setDialog(false)}>Cancel</Button><Button variant="primary" onClick={() => setDialog(false)}>Delegate</Button></>}>
          <Field label="Delegate to" required><Input data-autofocus /></Field>
        </Dialog>
        <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => setConfirm(false)} title="Reject PO-2026-1007?" consequence="The order goes back to its requester as Rejected. The supplier is not told." requireReason confirmLabel="Reject PO-2026-1007" />
        <Sheet open={sheet} onClose={() => setSheet(false)} title="Filters"><div className="p-4 text-sm text-ink-600">Sheet content.</div></Sheet>
      </Section>

      <Section id="table" title="DataTable" description="240 sample rows (virtualised past 120). Sticky header and first column; drag a header edge to resize, drag a header to reorder; Filter for column filters; Views to save; ↑↓ Enter x to work by keyboard; select rows for bulk actions; click an amount to edit inline.">
        <DataTable
          viewKey="system.reference"
          caption="Sample purchase orders"
          noun="order"
          rows={rows}
          columns={SAMPLE_COLUMNS}
          selectable
          onOpen={(r) => notify.info(`Open ${r.number}`)}
          onCellEdit={async (row, col, value) => {
            await new Promise((r) => setTimeout(r, 400))
            if (value > 100000) throw new Error('Above your approval limit')
            setRows((rs) => rs.map((x) => (x.id === row.id ? { ...x, amount: value } : x)))
          }}
          rowActions={(r) => (<><RowAction icon={EyeIcon} label={`View ${r.number}`} onClick={() => {}} /><RowAction icon={TrashIcon} label={`Delete ${r.number}`} tone="risk" disabled={r.status !== 'DRAFT'} reason="Only drafts can be deleted" /></>)}
          bulkActions={(sel, clear) => (<><BulkAction tone="primary" icon={CheckIcon} onClick={clear}>Approve {sel.length}</BulkAction><BulkAction icon={ArrowDownTrayIcon}>Export</BulkAction><BulkAction tone="risk" icon={XMarkIcon}>Reject</BulkAction></>)}
          height="420px"
        />
        <DataTable caption="Empty example" rows={[]} columns={SAMPLE_COLUMNS.slice(0, 3)} search={false} empty={{ icon: DocumentTextIcon, title: 'No supplier invoices yet', description: 'Supplier invoices are bills you owe. They arrive from the supplier portal, the AP mailbox, or are keyed here.' }} />
        <DataTable caption="Loading example" rows={[]} columns={SAMPLE_COLUMNS.slice(0, 4)} loading search={false} />
      </Section>

      <Section id="detail" title="Detail pattern" description="A PO, a sales order, an item and an employee are the same kind of object: five facts, tabs for the rest, a timeline of what happened, a related-records panel.">
        <SummaryStrip facts={[{ label: 'Total', value: <Money amount={13260} /> }, { label: 'Supplier', value: 'Sample Resin Co', hint: 'SUP-DEMO-11' }, { label: 'Delivery', value: <DateText value="2026-10-17" />, hint: 'in 9 days' }, { label: 'Received', value: '0 of 2 lines' }, { label: 'Approver', value: 'Maria Lind', hint: 'limit $25,000' }]} />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
          <Card title="Details"><DescriptionList items={[{ label: 'Payment terms', value: 'Net 30' }, { label: 'Incoterms', value: 'FOB' }, { label: 'Ship to', value: 'Main warehouse, Havnegata 4, Oslo', wide: true }]} /></Card>
          <div className="space-y-4">
            <Card title="History"><Timeline events={[{ title: 'Rejected', actor: 'Maria Lind', at: new Date(), tone: 'risk', note: 'Duplicate of an open order for the same lines.' }, { title: 'Submitted for approval', actor: 'Ada Admin', at: new Date(Date.now() - 36e5), tone: 'warn' }, { title: 'Created', actor: 'Ada Admin', at: new Date(Date.now() - 72e5), tone: 'ink' }]} /></Card>
            <RelatedPanel groups={[{ label: 'Requisition', items: [{ label: 'PR-DEMO-0012', to: '#' }] }, { label: 'Goods receipts', items: [] }, { label: 'Supplier invoices', items: [{ label: 'SI-DEMO-0440', status: <StatusBadge status="PENDING" /> }] }]} />
          </div>
        </div>
      </Section>

      <Section id="lines" title="Line items" description="Tab across, Enter down, paste a block from Excel, totals update live.">
        <LineItemEditor
          rows={lines}
          onChange={setLines}
          newRow={() => ({ _key: Math.random() })}
          columns={[
            { key: 'item', header: 'Item', type: 'text', placeholder: 'Description', required: true, minWidth: 220 },
            { key: 'account', header: 'Account', type: 'select', options: [{ value: '5000', label: '5000 · Materials' }, { value: '6100', label: '6100 · Freight' }], width: 180 },
            { key: 'qty', header: 'Qty', type: 'number', width: 90, validate: (v) => (Number(v) <= 0 ? 'Quantity must be above zero' : null) },
            { key: 'price', header: 'Unit price', type: 'money', width: 120 },
            { key: 'total', header: 'Line total', compute: (r) => (Number(r.qty) || 0) * (Number(r.price) || 0), type: 'money', total: true, width: 130 },
          ]}
        />
      </Section>

      <Section id="simeli" title="Simeli" description="Every answer shows what it read, what it concluded and what it proposes. Proposals are prepared actions a person approves; nothing executes on its own.">
        <Both>
          <AiAnswer
            title="What needs a look on PO-2026-1005"
            read={[{ label: 'PO-2026-1005' }, { label: 'SUP-001011' }, { label: '12 prior POs' }, { label: 'DOA rules' }]}
            concluded={['Unit price for epoxy resin is 18% above the last three orders from this supplier.', 'Delivery date falls on a public holiday at the receiving warehouse.']}
            proposes={[{ title: 'Ask the supplier to confirm the resin price', detail: 'Drafts an email on the PO; you review before it is sent.', actionLabel: 'Draft email' }]}
          />
        </Both>
      </Section>
    </div>
  )
}
