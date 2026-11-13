import { useMemo, useState } from 'react'
import { PlusIcon, CheckBadgeIcon, BeakerIcon, EyeIcon, Squares2X2Icon, DocumentArrowDownIcon } from '@heroicons/react/20/solid'
import { manufacturingAPI, itemsAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, DataTable, RowAction, StatusBadge, Num, Code, DateText, ConfirmDialog, Dialog, Sheet, Segmented,
  Field, Input, Select, FormSection, ErrorSummary, LineItemEditor, InlineNotice, DescriptionList, SkeletonRows, ErrorState,
  exportCsv, formatNumber, notify,
} from '../../components/ui'

/**
 * Bills of material — what each manufactured item is made of.
 *
 * A BOM is drafted, filled with components, then activated. Only a draft can
 * change: an active recipe is what work orders and MRP already explode
 * against, so changing it underneath them would silently alter costs on
 * orders in flight. One item has at most one active recipe.
 */
const QUICK = {
  all: { label: 'All', test: () => true },
  ACTIVE: { label: 'Active', test: (b) => b.status === 'ACTIVE' },
  DRAFT: { label: 'Drafts', test: (b) => b.status === 'DRAFT' },
  OBSOLETE: { label: 'Obsolete', test: (b) => b.status === 'OBSOLETE' },
}

const errorText = (err, fallback) => err?.response?.data?.error || err?.message || fallback
const blankLine = () => ({ component_item_id: '', quantity_per: '', scrap_percent: '0' })
const effective = (r) => (Number(r.quantity_per) > 0 ? formatNumber(Number(r.quantity_per) * (1 + Number(r.scrap_percent || 0) / 100), 4) : '')
const filled = (lines) => lines.filter((c) => c.component_item_id && Number(c.quantity_per) > 0)

/** Problems with a set of component lines, keyed by row then column, plus one summary message. */
function validateLines(lines, producedItemId, existing = []) {
  const rowErrors = {}
  let message = null
  const seen = new Map(existing.map((id) => [id, -1]))
  lines.forEach((c, i) => {
    const e = {}
    const touched = c.component_item_id || c.quantity_per
    if (!touched) return
    if (!c.component_item_id) e.component_item_id = 'Choose a component'
    if (!(Number(c.quantity_per) > 0)) e.quantity_per = 'More than zero'
    const scrap = Number(c.scrap_percent || 0)
    if (scrap < 0 || scrap >= 100) e.scrap_percent = '0 to 99.999'
    if (c.component_item_id && c.component_item_id === producedItemId) {
      e.component_item_id = 'Cannot contain itself'
      message = 'An item cannot be a component of itself.'
    }
    if (c.component_item_id && seen.has(c.component_item_id)) {
      e.component_item_id = 'Listed twice'
      message = seen.get(c.component_item_id) === -1
        ? 'That component is already on this bill of material — edit the existing line instead.'
        : 'The same component is listed twice — combine the quantities into one line.'
    }
    if (c.component_item_id) seen.set(c.component_item_id, i)
    if (Object.keys(e).length) rowErrors[i] = e
  })
  return { rowErrors, message }
}

function useItems() {
  const { data, error } = useResource(keys.items({ limit: 500 }), () => itemsAPI.getAll({ limit: 500 }))
  const items = Array.isArray(data) ? data : data?.items || []
  return { items, error }
}

function componentColumns(items, excludeItemId) {
  return [
    {
      key: 'component_item_id', header: 'Component', type: 'select', minWidth: 220, required: true, placeholder: 'Choose…',
      options: items.filter((i) => i.id !== excludeItemId).map((i) => ({ value: i.id, label: `${i.name}${i.item_code ? ` (${i.item_code})` : ''}` })),
    },
    { key: 'quantity_per', header: 'Qty per output', type: 'number', width: 130, required: true },
    { key: 'scrap_percent', header: 'Scrap %', type: 'number', width: 100 },
    { key: 'effective', header: 'Effective qty', compute: effective, width: 120 },
  ]
}

export default function BillsOfMaterial() {
  const [quick, setQuick] = useState('all')
  const [createOpen, setCreateOpen] = useState(false)
  const [open, setOpen] = useState(null)
  const [exploding, setExploding] = useState(null)
  const [activating, setActivating] = useState(null)

  const { data, loading, error, refetch } = useResource(keys.boms(), () => manufacturingAPI.listBoms({}))
  const boms = useMemo(() => (Array.isArray(data) ? data : []), [data])
  // Which items already have an active recipe — from the whole list, not the
  // filtered view, so the activation guard works on the Drafts view too.
  const activeItemIds = useMemo(() => new Set(boms.filter((b) => b.status === 'ACTIVE').map((b) => b.item_id)), [boms])
  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, boms.filter(q.test).length])), [boms])

  const activate = useResourceMutation((bom) => manufacturingAPI.activateBom(bom.id), { invalidates: [keys.boms()], silent: true })

  const blockedReason = (b) => {
    if (!Number(b.component_count)) return 'A bill of material with no components cannot be activated.'
    if (activeItemIds.has(b.item_id)) return `${b.item_name || 'This item'} already has an active bill of material. Make that one obsolete first.`
    return null
  }

  const doActivate = async () => {
    const bom = activating
    try {
      await activate.mutateAsync(bom)
      notify.success(`${bom.bom_number} is now the active recipe for ${bom.item_name || 'this item'}`)
      setActivating(null)
    } catch (err) {
      notify.error(errorText(err, 'Could not activate this bill of material'))
    }
  }

  const columns = useMemo(() => [
    {
      id: 'bom', header: 'BOM', accessor: 'bom_number', width: 170, mobile: 'title',
      cell: (b) => (
        <span className="block min-w-0">
          <Code>{b.bom_number}</Code>
          {b.description && <span className="block truncate text-2xs text-ink-500">{b.description}</span>}
        </span>
      ),
    },
    {
      id: 'item', header: 'Produces', accessor: (b) => b.item_name, filter: 'text', minWidth: 200, maxWidth: 320, mobile: 'subtitle',
      cell: (b) => (
        <span className="block min-w-0">
          <span className="block truncate">{b.item_name || '—'}</span>
          {b.item_code && <span className="block truncate font-mono text-2xs text-ink-500">{b.item_code}</span>}
        </span>
      ),
    },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 130, mobile: 'meta', cell: (b) => <StatusBadge status={b.status} /> },
    {
      id: 'output', header: 'Output qty', accessor: (b) => Number(b.output_quantity), align: 'right', width: 130,
      cell: (b) => <span className="whitespace-nowrap"><Num value={b.output_quantity} digits={2} />{b.unit_of_measure && <span className="ml-1 text-2xs text-ink-500">{b.unit_of_measure}</span>}</span>,
    },
    { id: 'components', header: 'Components', accessor: (b) => Number(b.component_count) || 0, align: 'right', width: 120, mobile: 'trailing' },
    { id: 'version', header: 'Version', accessor: (b) => Number(b.version) || null, align: 'right', width: 90, defaultHidden: true },
    { id: 'created', header: 'Created', accessor: 'created_at', width: 120, cell: (b) => <DateText value={b.created_at} /> },
  ], [])

  return (
    <>
      <PageHeader
        title="Bills of material"
        description="What each manufactured item is made of. Work orders and MRP build from the active one."
        secondary={<Button icon={DocumentArrowDownIcon} onClick={() => exportCsv(boms.filter(QUICK[quick].test), columns, 'bills-of-material.csv')} disabled={!boms.length}>Export</Button>}
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setCreateOpen(true)}>New bill of material</Button>}
      />

      <DataTable
        viewKey="manufacturing.boms"
        caption="Bills of material"
        noun="BOM"
        rows={boms}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        onRowClick={(b) => setOpen(b)}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'created', dir: 'desc' }}
        searchPlaceholder="Search BOM or item"
        toolbarStart={
          <Segmented
            label="Show"
            value={quick}
            onChange={setQuick}
            options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))}
            className="max-w-full overflow-x-auto"
          />
        }
        rowActions={(b) => (
          <>
            <RowAction icon={EyeIcon} label={`Open ${b.bom_number}`} onClick={() => setOpen(b)} />
            {b.status === 'DRAFT' && (
              <RowAction icon={CheckBadgeIcon} label={`Activate ${b.bom_number}`} disabled={Boolean(blockedReason(b))} reason={blockedReason(b)} onClick={() => setActivating(b)} />
            )}
            {b.status === 'ACTIVE' && <RowAction icon={BeakerIcon} label={`Explode requirements for ${b.bom_number}`} onClick={() => setExploding(b)} />}
          </>
        )}
        empty={{
          icon: Squares2X2Icon,
          title: 'No bills of material yet',
          description: 'A bill of material lists the components an item is built from. Create one, add its components, then activate it so work orders can use it.',
          action: <Button variant="primary" icon={PlusIcon} onClick={() => setCreateOpen(true)}>New bill of material</Button>,
        }}
      />

      {createOpen && <CreateBomDialog onClose={() => setCreateOpen(false)} />}
      {open && (
        <BomSheet
          bom={open}
          onClose={() => setOpen(null)}
          onActivate={(b) => { const why = blockedReason(b); if (why) notify.error(why); else setActivating(b) }}
          onExplode={(b) => setExploding(b)}
        />
      )}
      {exploding && <ExplodeDialog bom={exploding} onClose={() => setExploding(null)} />}
      {activating && (
        <ConfirmDialog
          open
          onClose={() => setActivating(null)}
          onConfirm={doActivate}
          title={`Activate ${activating.bom_number}?`}
          consequence={`Work orders and MRP will build ${activating.item_name || 'this item'} from this recipe. Its components can no longer be changed; to change them, draft a new version and make this one obsolete.`}
          reversible={false}
          tone="primary"
          confirmLabel={`Activate ${activating.bom_number}`}
          busy={activate.isPending}
        />
      )}
    </>
  )
}

function CreateBomDialog({ onClose }) {
  const { items, error: itemsError } = useItems()
  const [form, setForm] = useState({ item_id: '', description: '', output_quantity: '1', unit_of_measure: '' })
  const [lines, setLines] = useState([blankLine()])
  const [submitted, setSubmitted] = useState(false)
  const [touched, setTouched] = useState({})
  const [serverError, setServerError] = useState(null)
  const create = useResourceMutation((payload) => manufacturingAPI.createBom(payload), { invalidates: [keys.boms()], silent: true })

  const { rowErrors, message: lineMessage } = validateLines(lines, form.item_id)
  const errors = {
    item_id: !form.item_id ? 'Choose which item this recipe produces.' : null,
    output_quantity: !(Number(form.output_quantity) > 0) ? 'Output quantity must be greater than zero.' : null,
    'bom-lines': lineMessage,
  }
  const visible = (k) => (submitted || touched[k] ? errors[k] : null)
  const summary = submitted ? Object.fromEntries(Object.entries(errors).filter(([, v]) => v)) : {}

  const submit = async () => {
    setSubmitted(true)
    if (Object.values(errors).some(Boolean) || Object.keys(rowErrors).length) return
    setServerError(null)
    try {
      await create.mutateAsync({
        item_id: form.item_id,
        description: form.description || undefined,
        output_quantity: Number(form.output_quantity),
        unit_of_measure: form.unit_of_measure || undefined,
        components: filled(lines).map((c) => ({
          component_item_id: c.component_item_id,
          quantity_per: Number(c.quantity_per),
          scrap_percent: Number(c.scrap_percent || 0),
        })),
      })
      notify.success('Bill of material created as a draft')
      onClose()
    } catch (err) {
      setServerError(errorText(err, 'Could not create the bill of material'))
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title="New bill of material"
      description="Created as a draft. Add every component, then activate it from the list."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending}>Create bill of material</Button>
        </>
      }
    >
      <div className="space-y-4">
        {serverError && <InlineNotice tone="risk" title="The bill of material was not created">{serverError} Your entries are still here.</InlineNotice>}
        {itemsError && <InlineNotice tone="warn" title="The item master did not load">{errorText(itemsError, 'Try again in a moment.')}</InlineNotice>}
        <ErrorSummary errors={summary} />
        <FormSection title="Output">
          <Field label="Item produced" required id="item_id" error={visible('item_id')}>
            <Select value={form.item_id} onChange={(e) => setForm((f) => ({ ...f, item_id: e.target.value }))} onBlur={() => setTouched((t) => ({ ...t, item_id: true }))}>
              <option value="">Select an item…</option>
              {items.map((i) => <option key={i.id} value={i.id}>{i.name}{i.item_code ? ` (${i.item_code})` : ''}</option>)}
            </Select>
          </Field>
          <Field label="Description" optional id="description">
            <Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          </Field>
          <Field label="Output quantity" required id="output_quantity" error={visible('output_quantity')} help="Component quantities are per this many units of output.">
            <Input type="number" step="0.0001" min="0.0001" numeric value={form.output_quantity} onChange={(e) => setForm((f) => ({ ...f, output_quantity: e.target.value }))} onBlur={() => setTouched((t) => ({ ...t, output_quantity: true }))} />
          </Field>
          <Field label="Unit of measure" optional id="unit_of_measure">
            <Input value={form.unit_of_measure} placeholder="EA, KG, L…" onChange={(e) => setForm((f) => ({ ...f, unit_of_measure: e.target.value }))} />
          </Field>
        </FormSection>

        <section className="space-y-2" id="bom-lines" tabIndex={-1} aria-labelledby="bom-lines-h">
          <div>
            <h2 id="bom-lines-h" className="text-sm font-semibold text-fg">Components</h2>
            <p className="text-xs text-ink-500">
              Scrap percent grosses the requirement up for expected processing loss, so a 5% rate does not cause a shortage part-way through a build. Paste rows from a spreadsheet to fill several at once.
            </p>
          </div>
          <LineItemEditor
            label="Bill of material components"
            rows={lines}
            onChange={setLines}
            newRow={blankLine}
            errors={submitted ? rowErrors : {}}
            columns={componentColumns(items, form.item_id)}
            addLabel="Add component"
          />
        </section>
      </div>
    </Dialog>
  )
}

function BomSheet({ bom, onClose, onActivate, onExplode }) {
  const { data: detail, loading, error, refetch } = useResource([...keys.boms(), bom.id], () => manufacturingAPI.getBom(bom.id))
  const components = Array.isArray(detail?.components) ? detail.components : []
  const isDraft = detail?.status === 'DRAFT'

  const columns = [
    { id: 'line', header: '#', accessor: (c) => Number(c.line_number) || null, width: 50, align: 'right' },
    {
      id: 'component', header: 'Component', accessor: (c) => c.component_name, mobile: 'title',
      cell: (c) => (
        <span className="block min-w-0">
          <span className="block truncate">{c.component_name || '—'}</span>
          {c.component_code && <span className="block truncate font-mono text-2xs text-ink-500">{c.component_code}</span>}
        </span>
      ),
    },
    { id: 'qty', header: 'Qty per output', accessor: (c) => Number(c.quantity_per), align: 'right', width: 120, cell: (c) => <Num value={c.quantity_per} digits={4} /> },
    { id: 'scrap', header: 'Scrap %', accessor: (c) => Number(c.scrap_percent), align: 'right', width: 90, cell: (c) => <Num value={c.scrap_percent} digits={2} /> },
    { id: 'effective', header: 'Effective qty', accessor: (c) => Number(c.quantity_per) * (1 + Number(c.scrap_percent || 0) / 100), align: 'right', width: 120, mobile: 'trailing', cell: (c) => <Num value={Number(c.quantity_per) * (1 + Number(c.scrap_percent || 0) / 100)} digits={4} /> },
  ]

  return (
    <Sheet
      open
      onClose={onClose}
      width="xl"
      title={bom.bom_number}
      description={bom.item_name}
      footer={
        detail?.status === 'DRAFT' ? <Button variant="primary" icon={CheckBadgeIcon} onClick={() => onActivate({ ...bom, component_count: components.length })}>Activate</Button>
          : detail?.status === 'ACTIVE' ? <Button icon={BeakerIcon} onClick={() => onExplode(bom)}>Explode requirements</Button> : null
      }
    >
      {loading ? (
        <SkeletonRows rows={5} columns={3} className="p-4" />
      ) : error ? (
        <ErrorState what="This bill of material" error={error} onRetry={refetch} compact className="p-4" />
      ) : (
        <div className="space-y-5 p-4">
          <DescriptionList
            columns={3}
            items={[
              { label: 'Status', value: <StatusBadge status={detail?.status} /> },
              { label: 'Output', value: <><Num value={detail?.output_quantity} digits={2} /> {detail?.unit_of_measure || ''}</> },
              { label: 'Version', value: detail?.version ?? null },
              { label: 'Description', value: detail?.description, wide: true },
            ]}
          />
          {!isDraft && (
            <InlineNotice tone="ink">
              This bill of material is {String(detail?.status || '').toLowerCase()}. Components can only be added while it is a draft — an active recipe is what work orders and MRP already explode against.
            </InlineNotice>
          )}
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-fg">Components</h3>
            <DataTable caption="Components" noun="component" rows={components} columns={columns} search={false} showCount={false} empty={{ title: 'No components yet', description: 'A bill of material needs at least one component before it can be activated.' }} />
          </section>
          {isDraft && <AddComponents bom={detail} existing={components.map((c) => c.component_item_id)} />}
        </div>
      )}
    </Sheet>
  )
}

/** Add components to a draft — one request per line, the backend's own cycle check on each. */
function AddComponents({ bom, existing }) {
  const { items } = useItems()
  const [lines, setLines] = useState([blankLine()])
  const [submitted, setSubmitted] = useState(false)
  const [failure, setFailure] = useState(null)
  const add = useResourceMutation((c) => manufacturingAPI.addBomComponent(bom.id, c), { invalidates: [keys.boms()], silent: true })
  const { rowErrors, message } = validateLines(lines, bom.item_id, existing)
  const ready = filled(lines)

  const submit = async () => {
    setSubmitted(true)
    setFailure(null)
    if (message || Object.keys(rowErrors).length || !ready.length) return
    const left = []
    let ok = 0
    for (const c of ready) {
      try {
        await add.mutateAsync({ component_item_id: c.component_item_id, quantity_per: Number(c.quantity_per), scrap_percent: Number(c.scrap_percent || 0) })
        ok += 1
      } catch (err) {
        // The cycle check lives in the backend and explains itself well.
        left.push(c)
        setFailure(errorText(err, 'Could not add the component'))
      }
    }
    setLines(left.length ? left : [blankLine()])
    setSubmitted(false)
    if (ok) notify.success(ok === 1 ? 'Component added' : `${ok} components added`)
  }

  return (
    <section className="space-y-2" aria-labelledby="add-components-h">
      <h3 id="add-components-h" className="text-sm font-semibold text-fg">Add components</h3>
      {failure && <InlineNotice tone="risk" title="Not every line was added">{failure} The lines that failed are still below.</InlineNotice>}
      {submitted && message && <p role="alert" className="text-xs text-risk-600">{message}</p>}
      <LineItemEditor
        label="Components to add"
        rows={lines}
        onChange={setLines}
        newRow={blankLine}
        errors={submitted ? rowErrors : {}}
        columns={componentColumns(items, bom.item_id)}
        addLabel="Add line"
      />
      <div className="flex justify-end">
        <Button variant="primary" icon={PlusIcon} onClick={submit} loading={add.isPending} disabled={!ready.length}>
          {ready.length > 1 ? `Add ${ready.length} components` : 'Add component'}
        </Button>
      </div>
    </section>
  )
}

function ExplodeDialog({ bom, onClose }) {
  const [quantity, setQuantity] = useState('1')
  const [run, setRun] = useState(1)
  const valid = Number(quantity) > 0
  const { data: result, loading, error, refetch, isFetching } = useResource(
    [...keys.boms(), 'explode', bom.item_id, run],
    () => manufacturingAPI.explodeBom(bom.item_id, run),
  )
  // by_level lists each occurrence; total_requirements is the rolled-up figure
  // procurement needs. Names come from the level detail.
  const nameFor = (itemId) => {
    const hit = (result?.by_level || []).find((l) => l.item_id === itemId)
    return hit ? { name: hit.item_name, code: hit.item_code } : { name: null, code: null }
  }
  const totals = (result?.total_requirements || []).map((r) => ({ ...r, ...nameFor(r.item_id) }))

  return (
    <Dialog open onClose={onClose} size="lg" title={`Explode — ${bom.item_name || bom.bom_number}`} description="Every raw component needed to build this quantity, rolled up across all levels and grossed up for scrap.">
      <div className="space-y-5">
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (valid) { setRun(Number(quantity)); if (Number(quantity) === run) refetch() } }}>
          <Field label="Build quantity" id="build-quantity" error={!valid ? 'Quantity must be greater than zero.' : null} className="w-40">
            <Input type="number" step="0.0001" min="0.0001" numeric value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </Field>
          <Button type="submit" loading={isFetching} disabled={!valid}>Recalculate</Button>
        </form>

        {loading ? <SkeletonRows rows={4} columns={2} /> : error ? <ErrorState what="The explosion" error={error} onRetry={refetch} compact /> : (
          <>
            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-fg">Total requirements for <Num value={result?.quantity} digits={2} /> units</h3>
              <DataTable
                caption="Total requirements"
                noun="component"
                rows={totals}
                rowKey={(r) => r.item_id}
                search={false}
                showCount={false}
                columns={[
                  { id: 'name', header: 'Component', accessor: (r) => r.name || r.item_id, mobile: 'title', cell: (r) => <span className="block min-w-0"><span className="block truncate">{r.name || r.item_id}</span>{r.code && <span className="block font-mono text-2xs text-ink-500">{r.code}</span>}</span> },
                  { id: 'qty', header: 'Total quantity', accessor: (r) => Number(r.quantity), align: 'right', width: 140, mobile: 'trailing', cell: (r) => <Num value={r.quantity} digits={4} className="font-medium" /> },
                ]}
                empty={{ title: 'Nothing to explode', description: 'This item has no active bill of material.' }}
              />
            </section>
            {(result?.by_level || []).length > 0 && (
              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-fg">Structure by level</h3>
                <ul className="divide-y divide-ink-100 rounded-lg border border-ink-200">
                  {result.by_level.map((l, idx) => (
                    <li key={`${l.item_id}-${idx}`} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                      <span className="min-w-0 truncate" style={{ paddingLeft: `${(Number(l.level) - 1) * 16}px` }}>
                        <span className="mr-2 text-ink-400" aria-hidden="true">└</span>
                        {l.item_name || l.item_id}
                        {l.item_code && <span className="ml-2 font-mono text-2xs text-ink-500">{l.item_code}</span>}
                      </span>
                      <Num value={l.quantity} digits={4} />
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </Dialog>
  )
}
