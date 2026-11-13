import { useMemo, useState } from 'react'
import {
  PlusIcon, PlayIcon, ArrowDownTrayIcon, CheckCircleIcon, XMarkIcon, EyeIcon, WrenchScrewdriverIcon, DocumentArrowDownIcon,
} from '@heroicons/react/20/solid'
import { manufacturingAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, DataTable, RowAction, StatusBadge, Money, Num, Code, DateText, ConfirmDialog, Dialog, Sheet,
  Segmented, Field, Input, Select, InlineNotice, DescriptionList, SkeletonRows, ErrorState,
  exportCsv, formatMoney, formatNumber, notify,
} from '../../components/ui'

/**
 * Work orders — production orders from release, through material issue, to
 * confirmation.
 *
 * The lifecycle is kept in one table so the screen can never offer an action
 * the backend will reject (confirming production before any material has been
 * issued, for example).
 */
const ACTIONS = {
  DRAFT: ['release', 'cancel'],
  RELEASED: ['issue', 'cancel'],
  IN_PROGRESS: ['issue', 'confirm'],
  COMPLETED: [],
  CANCELLED: [],
}

const QUICK = {
  all: { label: 'All', test: () => true },
  open: { label: 'Open', test: (o) => ['DRAFT', 'RELEASED', 'IN_PROGRESS'].includes(o.status) },
  floor: { label: 'In production', test: (o) => o.status === 'IN_PROGRESS' },
  completed: { label: 'Completed', test: (o) => o.status === 'COMPLETED' },
  cancelled: { label: 'Cancelled', test: (o) => o.status === 'CANCELLED' },
}

const errorText = (err, fallback) => err?.response?.data?.error || err?.message || fallback

export default function WorkOrders() {
  const [quick, setQuick] = useState('all')
  const [createOpen, setCreateOpen] = useState(false)
  const [detail, setDetail] = useState(null)
  const [confirmFor, setConfirmFor] = useState(null)
  const [cancelFor, setCancelFor] = useState(null)

  const { data, loading, error, refetch } = useResource(keys.workOrders(), () => manufacturingAPI.listWorkOrders({}))
  const orders = useMemo(() => (Array.isArray(data) ? data : []), [data])
  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, orders.filter(q.test).length])), [orders])

  const invalidates = [keys.workOrders()]
  const release = useResourceMutation((o) => manufacturingAPI.releaseWorkOrder(o.id), { invalidates, silent: true })
  const issue = useResourceMutation((o) => manufacturingAPI.issueMaterials(o.id, null), { invalidates, silent: true })
  const cancel = useResourceMutation(({ o, reason }) => manufacturingAPI.cancelWorkOrder(o.id, reason), { invalidates, silent: true })

  const act = async (order, action) => {
    try {
      if (action === 'release') {
        await release.mutateAsync(order)
        notify.success(`${order.wo_number} released`)
      } else if (action === 'issue') {
        // Issuing with no explicit list means "everything still outstanding",
        // which is what the backend defaults to.
        const res = await issue.mutateAsync(order)
        notify.success(`Materials issued to ${order.wo_number} (${formatMoney(res?.total_value)} to work in progress)`)
      }
    } catch (err) {
      // The backend's own explanation states the accounting reason
      // (insufficient stock, wrong status) better than a generic message.
      notify.error(errorText(err, `Could not ${action} ${order.wo_number}`))
    }
  }

  const doCancel = async (reason) => {
    const o = cancelFor
    try {
      await cancel.mutateAsync({ o, reason })
      notify.success(`${o.wo_number} cancelled`)
      setCancelFor(null)
    } catch (err) {
      notify.error(errorText(err, `Could not cancel ${o.wo_number}`))
    }
  }

  const columns = useMemo(() => [
    {
      id: 'wo', header: 'Work order', accessor: 'wo_number', width: 170, mobile: 'title',
      cell: (o) => (
        <span className="flex items-center gap-2">
          <Code>{o.wo_number}</Code>
          {o.source === 'MRP' && <span className="text-2xs text-ink-500">from MRP</span>}
        </span>
      ),
    },
    {
      id: 'item', header: 'Item', accessor: (o) => o.item_name, filter: 'text', minWidth: 200, maxWidth: 320, mobile: 'subtitle',
      cell: (o) => (
        <span className="block min-w-0">
          <span className="block truncate">{o.item_name || '—'}</span>
          {o.item_code && <span className="block truncate font-mono text-2xs text-ink-500">{o.item_code}</span>}
        </span>
      ),
    },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 150, mobile: 'meta', cell: (o) => <StatusBadge status={o.status} /> },
    { id: 'ordered', header: 'Ordered', accessor: (o) => Number(o.quantity_ordered), align: 'right', width: 110, cell: (o) => <Num value={o.quantity_ordered} digits={2} /> },
    {
      id: 'produced', header: 'Produced', accessor: (o) => Number(o.quantity_produced), align: 'right', width: 130,
      cell: (o) => (
        <span className="block text-right">
          <Num value={o.quantity_produced} digits={2} />
          {Number(o.quantity_scrapped) > 0 && <span className="block text-2xs text-risk-600">{formatNumber(o.quantity_scrapped, 2)} scrapped</span>}
        </span>
      ),
    },
    {
      id: 'wip', header: 'Work in progress', accessor: (o) => Number(o.wip_value), align: 'right', width: 150, filter: 'number', mobile: 'trailing',
      cell: (o) => <Money amount={o.wip_value} />,
      footer: (rows) => <Money amount={rows.reduce((s, r) => s + (Number(r.wip_value) || 0), 0)} />,
      exportValue: (o) => o.wip_value,
    },
    { id: 'due', header: 'Needed by', accessor: 'planned_end_date', width: 120, cell: (o) => <DateText value={o.planned_end_date} /> },
    { id: 'started', header: 'Started', accessor: 'actual_start_date', width: 120, defaultHidden: true, cell: (o) => <DateText value={o.actual_start_date} /> },
    { id: 'created', header: 'Raised', accessor: 'created_at', width: 120, cell: (o) => <DateText value={o.created_at} /> },
  ], [])

  return (
    <>
      <PageHeader
        title="Work orders"
        description="Production orders — release them, issue materials to the floor, and confirm what was made."
        secondary={<Button icon={DocumentArrowDownIcon} onClick={() => exportCsv(orders.filter(QUICK[quick].test), columns, 'work-orders.csv')} disabled={!orders.length}>Export</Button>}
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setCreateOpen(true)}>New work order</Button>}
      />

      <DataTable
        viewKey="manufacturing.work-orders"
        caption="Work orders"
        noun="work order"
        rows={orders}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        onRowClick={(o) => setDetail(o)}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'created', dir: 'desc' }}
        searchPlaceholder="Search work order or item"
        toolbarStart={
          <Segmented
            label="Show"
            value={quick}
            onChange={setQuick}
            options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))}
            className="max-w-full overflow-x-auto"
          />
        }
        rowActions={(o) => {
          const available = ACTIONS[o.status] || []
          return (
            <>
              <RowAction icon={EyeIcon} label={`Open ${o.wo_number}`} onClick={() => setDetail(o)} />
              {available.includes('release') && <RowAction icon={PlayIcon} label={`Release ${o.wo_number}`} onClick={() => act(o, 'release')} disabled={release.isPending} />}
              {available.includes('issue') && <RowAction icon={ArrowDownTrayIcon} label={`Issue materials to ${o.wo_number}`} onClick={() => act(o, 'issue')} disabled={issue.isPending} />}
              {available.includes('confirm') && <RowAction icon={CheckCircleIcon} label={`Confirm production of ${o.wo_number}`} onClick={() => setConfirmFor(o)} />}
              {available.includes('cancel') && <RowAction icon={XMarkIcon} tone="risk" label={`Cancel ${o.wo_number}`} onClick={() => setCancelFor(o)} />}
            </>
          )
        }}
        empty={{
          icon: WrenchScrewdriverIcon,
          title: 'No work orders yet',
          description: 'A work order makes an item from its active bill of material. Create one, release it, then issue materials to start production.',
          action: <Button variant="primary" icon={PlusIcon} onClick={() => setCreateOpen(true)}>New work order</Button>,
        }}
      />

      {createOpen && <CreateWorkOrderDialog onClose={() => setCreateOpen(false)} />}
      {detail && <WorkOrderSheet order={detail} onClose={() => setDetail(null)} />}
      {confirmFor && <ConfirmProductionDialog order={confirmFor} onClose={() => setConfirmFor(null)} />}
      {cancelFor && (
        <ConfirmDialog
          open
          onClose={() => setCancelFor(null)}
          onConfirm={doCancel}
          title={`Cancel ${cancelFor.wo_number}?`}
          consequence={cancelFor.status === 'DRAFT'
            ? 'The order is withdrawn before anything was issued. Nothing is posted to the ledger.'
            : 'The order stops here. Material already issued stays in work in progress until it is reversed.'}
          reversible={false}
          requireReason
          reasonHelp="Recorded on the work order so planners can see why it stopped."
          confirmLabel={`Cancel ${cancelFor.wo_number}`}
          busy={cancel.isPending}
        />
      )}
    </>
  )
}

function CreateWorkOrderDialog({ onClose }) {
  const [form, setForm] = useState({ item_id: '', quantity: '', planned_end_date: '' })
  const [touched, setTouched] = useState({})
  const [serverError, setServerError] = useState(null)

  // Only items with an ACTIVE bill of material can be manufactured, so the
  // picker is built from the BOM list rather than the full item master —
  // offering unbuildable items would just produce a rejection.
  const { data: bomData, loading: bomsLoading, error: bomsError } = useResource([...keys.boms(), { status: 'ACTIVE' }], () => manufacturingAPI.listBoms({ status: 'ACTIVE' }))
  const boms = Array.isArray(bomData) ? bomData : []

  const create = useResourceMutation((payload) => manufacturingAPI.createWorkOrder(payload), { invalidates: [keys.workOrders()], silent: true })

  const errors = {
    item_id: !form.item_id ? 'Choose what to make.' : null,
    quantity: !(Number(form.quantity) > 0) ? 'Enter a quantity greater than zero.' : null,
  }
  const shown = (k) => (touched[k] ? errors[k] : null)

  const submit = async () => {
    setTouched({ item_id: true, quantity: true })
    if (errors.item_id || errors.quantity) return
    setServerError(null)
    try {
      await create.mutateAsync({
        item_id: form.item_id,
        quantity: Number(form.quantity),
        planned_end_date: form.planned_end_date || undefined,
      })
      notify.success('Work order created as a draft')
      onClose()
    } catch (err) {
      setServerError(errorText(err, 'Could not create the work order'))
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="New work order"
      description="Components are exploded from the item's active bill of material when the order is created. Nothing is posted to the ledger until materials are issued."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending}>Create work order</Button>
        </>
      }
    >
      <div className="space-y-4">
        {serverError && <InlineNotice tone="risk" title="The work order was not created">{serverError}</InlineNotice>}
        {bomsError && <InlineNotice tone="warn" title="Bills of material did not load">{errorText(bomsError, 'Try again in a moment.')}</InlineNotice>}
        <Field
          label="Item to make"
          required
          id="item-to-make"
          error={shown('item_id')}
          help={!bomsLoading && !bomsError && boms.length === 0 ? 'No active bills of material exist yet. Create and activate one first.' : 'Only items with an active bill of material are listed.'}
        >
          <Select value={form.item_id} onChange={(e) => setForm((f) => ({ ...f, item_id: e.target.value }))} onBlur={() => setTouched((t) => ({ ...t, item_id: true }))}>
            <option value="">{bomsLoading ? 'Loading…' : 'Select an item…'}</option>
            {boms.map((b) => (
              <option key={b.item_id} value={b.item_id}>{b.item_name}{b.item_code ? ` (${b.item_code})` : ''} — {b.bom_number}</option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Quantity" required id="quantity" error={shown('quantity')}>
            <Input type="number" step="0.0001" min="0" numeric value={form.quantity} onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))} onBlur={() => setTouched((t) => ({ ...t, quantity: true }))} />
          </Field>
          <Field label="Needed by" optional id="needed-by">
            <Input type="date" value={form.planned_end_date} onChange={(e) => setForm((f) => ({ ...f, planned_end_date: e.target.value }))} />
          </Field>
        </div>
      </div>
    </Dialog>
  )
}

function ConfirmProductionDialog({ order, onClose }) {
  const remaining = Number(order.quantity_ordered) - Number(order.quantity_produced) - Number(order.quantity_scrapped)
  const [produced, setProduced] = useState(String(remaining > 0 ? remaining : ''))
  const [scrapped, setScrapped] = useState('0')
  const [touched, setTouched] = useState(false)
  const [serverError, setServerError] = useState(null)
  const confirm = useResourceMutation((payload) => manufacturingAPI.confirmProduction(order.id, payload), { invalidates: [keys.workOrders()], silent: true })

  const producedError = !(Number(produced) > 0) ? 'Enter how many good units were made — more than zero.' : null
  const scrappedError = Number(scrapped || 0) < 0 ? 'Scrap cannot be negative.' : null

  const submit = async () => {
    setTouched(true)
    if (producedError || scrappedError) return
    setServerError(null)
    try {
      const d = await confirm.mutateAsync({ quantity_produced: Number(produced), quantity_scrapped: Number(scrapped || 0) })
      notify.success(`Received ${produced} into stock at ${formatMoney(d?.value_capitalised)}`)
      onClose()
    } catch (err) {
      setServerError(errorText(err, 'Could not confirm production'))
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Confirm production — ${order.wo_number}`}
      description={order.item_name}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={confirm.isPending}>Confirm production</Button>
        </>
      }
    >
      <div className="space-y-4">
        {serverError && <InlineNotice tone="risk" title="Production was not confirmed">{serverError}</InlineNotice>}
        <DescriptionList
          items={[
            { label: 'Ordered', value: <Num value={order.quantity_ordered} digits={2} /> },
            { label: 'Already produced', value: <Num value={order.quantity_produced} digits={2} /> },
            { label: 'Remaining', value: <Num value={remaining} digits={2} className="font-semibold" /> },
            { label: 'Work in progress', value: <Money amount={order.wip_value} /> },
          ]}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Good quantity" required id="good-quantity" error={touched ? producedError : null}>
            <Input type="number" step="0.0001" min="0" numeric value={produced} onChange={(e) => setProduced(e.target.value)} onBlur={() => setTouched(true)} />
          </Field>
          <Field label="Scrapped" id="scrapped" error={touched ? scrappedError : null}>
            <Input type="number" step="0.0001" min="0" numeric value={scrapped} onChange={(e) => setScrapped(e.target.value)} />
          </Field>
        </div>
        <p className="text-xs text-ink-500">
          Good units are received into stock at their share of the work-in-progress cost. Scrapped units consumed material too,
          so their cost goes to manufacturing variance rather than inflating the value of good stock.
        </p>
      </div>
    </Dialog>
  )
}

function WorkOrderSheet({ order, onClose }) {
  const { data: wo, loading, error, refetch } = useResource(keys.workOrder(order.id), () => manufacturingAPI.getWorkOrder(order.id))
  const components = Array.isArray(wo?.components) ? wo.components : []

  const columns = [
    {
      id: 'component', header: 'Component', accessor: (c) => c.component_name, mobile: 'title',
      cell: (c) => (
        <span className="block min-w-0">
          <span className="block truncate">{c.component_name || '—'}</span>
          {c.component_code && <span className="block truncate font-mono text-2xs text-ink-500">{c.component_code}</span>}
        </span>
      ),
    },
    { id: 'required', header: 'Required', accessor: (c) => Number(c.quantity_required), align: 'right', width: 100, cell: (c) => <Num value={c.quantity_required} digits={4} /> },
    {
      id: 'issued', header: 'Issued', accessor: (c) => Number(c.quantity_issued), align: 'right', width: 110, mobile: 'trailing',
      cell: (c) => {
        const short = Number(c.quantity_required) - Number(c.quantity_issued)
        return (
          <span className="block text-right">
            <Num value={c.quantity_issued} digits={4} />
            {short > 0.00001 && <span className="block text-2xs text-warn-700">{formatNumber(short, 4)} outstanding</span>}
          </span>
        )
      },
    },
    { id: 'value', header: 'Value issued', accessor: (c) => Number(c.issued_value), align: 'right', width: 110, cell: (c) => <Money amount={c.issued_value} /> },
  ]

  return (
    <Sheet open onClose={onClose} title={order.wo_number} description={order.item_name} width="lg">
      {loading ? (
        <SkeletonRows rows={5} columns={3} className="p-4" />
      ) : error ? (
        <ErrorState what="This work order" error={error} onRetry={refetch} compact className="p-4" />
      ) : (
        <div className="space-y-5 p-4">
          <DescriptionList
            items={[
              { label: 'Status', value: <StatusBadge status={wo?.status} /> },
              { label: 'Ordered', value: <Num value={wo?.quantity_ordered} digits={2} /> },
              { label: 'Produced', value: <><Num value={wo?.quantity_produced} digits={2} />{Number(wo?.quantity_scrapped) > 0 && <span className="ml-1.5 text-xs text-risk-600">{formatNumber(wo.quantity_scrapped, 2)} scrapped</span>}</> },
              { label: 'Work in progress', value: <Money amount={wo?.wip_value} /> },
              { label: 'Needed by', value: <DateText value={wo?.planned_end_date} /> },
              { label: 'Source', value: wo?.source === 'MRP' ? 'MRP planned order' : 'Raised by hand' },
            ]}
          />
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-fg">Components</h3>
            <DataTable caption="Components" noun="component" rows={components} columns={columns} search={false} showCount={false} empty={{ title: 'No components on this order', description: 'Components are exploded from the bill of material when the order is created.' }} />
          </section>
          {wo?.notes && (
            <section>
              <h3 className="mb-1 text-sm font-semibold text-fg">Notes</h3>
              <p className="whitespace-pre-line text-sm text-ink-700">{wo.notes}</p>
            </section>
          )}
        </div>
      )}
    </Sheet>
  )
}
