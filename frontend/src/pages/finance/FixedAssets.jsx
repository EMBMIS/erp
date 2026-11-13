import { useMemo, useState } from 'react'
import { PlusIcon, CalculatorIcon, ArchiveBoxXMarkIcon, BuildingOffice2Icon, ArrowDownTrayIcon } from '@heroicons/react/20/solid'
import { fixedAssetsAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { useI18n } from '../../contexts/I18nContext'
import {
  PageHeader, Button, DataTable, RowAction, BulkAction, StatusBadge, Money, Num, Code, DateText, Stat, Segmented,
  ConfirmDialog, Dialog, Field, Input, Textarea, Checkbox, FormSection, ErrorSummary, InlineNotice, exportCsv, notify, formatMoney, useDraft,
} from '../../components/ui'

/**
 * Fixed assets — the asset register: cost, depreciation to date and book
 * value per asset. Depreciation posts a journal entry per asset per month;
 * disposal books the gain or loss against the sale proceeds.
 *
 * Read without paging params the endpoint returns the whole register (its
 * fetch-all contract), so sorting and search cover every asset.
 */
const QUICK = {
  all: { label: 'All', test: () => true },
  active: { label: 'Active', test: (a) => a.status === 'ACTIVE' },
  full: { label: 'Fully depreciated', test: (a) => a.status === 'FULLY_DEPRECIATED' },
  disposed: { label: 'Disposed', test: (a) => a.status === 'DISPOSED' },
}
const errText = (e) => e?.response?.data?.error || e?.message

export default function FixedAssets() {
  const { t } = useI18n()
  const [quick, setQuick] = useState('all')
  const [createOpen, setCreateOpen] = useState(false)
  const [runOpen, setRunOpen] = useState(false)
  const [depFor, setDepFor] = useState(null)
  const [disposeFor, setDisposeFor] = useState(null)

  const { data, loading, error, refetch } = useResource(['fixed-assets', 'all'], () => fixedAssetsAPI.list())
  const assets = useMemo(() => (Array.isArray(data) ? data : []), [data])
  const { data: stats, loading: statsLoading } = useResource(['fixed-assets', 'stats'], () => fixedAssetsAPI.stats())
  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, assets.filter(q.test).length])), [assets])

  // Every mutation changes the register and the totals, and posts to the ledger.
  const invalidates = [['fixed-assets'], ['journal-entries'], ['trial-balance'], ['balance-sheet'], ['income-statement']]
  const depreciate = useResourceMutation((id) => fixedAssetsAPI.depreciate(id, { months: 1 }), { invalidates, silent: true })
  const runAll = useResourceMutation(() => fixedAssetsAPI.runDepreciationAll({ months: 1 }), { invalidates, silent: true })
  const dispose = useResourceMutation(({ id, reason, proceeds }) => fixedAssetsAPI.dispose(id, reason, proceeds), { invalidates, silent: true })

  const depreciateOne = async (asset) => {
    try {
      const d = await depreciate.mutateAsync(asset.id)
      if (d?.skipped) notify.info(`${asset.asset_number} skipped: ${d.reason || 'nothing to post'}`)
      else notify.success(`Depreciated ${formatMoney(d?.amount)} for ${asset.asset_number}`)
      setDepFor(null)
    } catch (e) {
      notify.error(`Depreciation failed: ${errText(e)}`)
    }
  }

  const runMonthly = async () => {
    try {
      const d = await runAll.mutateAsync()
      notify.success(`Depreciation run: ${d?.posted ?? '—'} of ${d?.processed ?? '—'} assets, ${formatMoney(d?.total_depreciation)} posted`)
      setRunOpen(false)
    } catch (e) {
      notify.error(`Depreciation run failed: ${errText(e)}`)
    }
  }

  const columns = useMemo(() => [
    { id: 'number', header: 'Asset', accessor: 'asset_number', width: 150, mobile: 'meta', cell: (a) => <Code>{a.asset_number}</Code> },
    {
      id: 'name', header: 'Name', accessor: 'name', minWidth: 200, maxWidth: 320, mobile: 'title',
      cell: (a) => (
        <span className="block min-w-0">
          <span className="block truncate">{a.name}</span>
          {a.category && <span className="block truncate text-2xs text-ink-500">{a.category}</span>}
        </span>
      ),
    },
    { id: 'category', header: 'Category', accessor: 'category', filter: 'select', width: 140, defaultHidden: true },
    { id: 'acquired', header: 'Acquired', accessor: 'acquisition_date', width: 120, cell: (a) => <DateText value={a.acquisition_date} /> },
    { id: 'life', header: 'Life', accessor: (a) => Number(a.useful_life_years), align: 'right', width: 80, defaultHidden: true, cell: (a) => <Num value={a.useful_life_years} unit="yr" /> },
    { id: 'cost', header: 'Cost', accessor: (a) => Number(a.acquisition_cost), align: 'right', filter: 'number', width: 130, cell: (a) => <Money amount={a.acquisition_cost} />, exportValue: (a) => a.acquisition_cost, footer: (rows) => <Money amount={rows.reduce((s, a) => s + (Number(a.acquisition_cost) || 0), 0)} /> },
    { id: 'accum', header: 'Depreciation to date', accessor: (a) => Number(a.accumulated_depreciation), align: 'right', width: 170, cell: (a) => <Money amount={a.accumulated_depreciation} />, exportValue: (a) => a.accumulated_depreciation, footer: (rows) => <Money amount={rows.reduce((s, a) => s + (Number(a.accumulated_depreciation) || 0), 0)} /> },
    { id: 'book', header: 'Book value', accessor: (a) => Number(a.book_value), align: 'right', filter: 'number', width: 140, mobile: 'trailing', cell: (a) => <Money amount={a.book_value} className="font-medium" />, exportValue: (a) => a.book_value, footer: (rows) => <Money amount={rows.reduce((s, a) => s + (Number(a.book_value) || 0), 0)} /> },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 170, mobile: 'subtitle', cell: (a) => <StatusBadge status={a.status} /> },
  ], [])

  return (
    <>
      <PageHeader
        title={t('ui.fixedAssets')}
        description="The asset register: cost, depreciation to date and book value. Depreciation and disposals post to the ledger."
        secondary={
          <>
            <Button icon={ArrowDownTrayIcon} disabled={!assets.length} onClick={() => exportCsv(assets.filter(QUICK[quick].test), columns, 'fixed-assets.csv')}>Export</Button>
            <Button icon={CalculatorIcon} onClick={() => setRunOpen(true)} disabled={!counts.active}>Run monthly depreciation</Button>
          </>
        }
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setCreateOpen(true)}>{t('ui.addAsset')}</Button>}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Assets" value={<Num value={stats?.total_assets} />} loading={statsLoading} onClick={() => setQuick('all')} footnote={stats?.active_assets != null ? `${stats.active_assets} active` : undefined} />
        <Stat label="Total cost" value={<Money amount={stats?.total_cost} digits={0} />} loading={statsLoading} />
        <Stat label="Depreciation to date" value={<Money amount={stats?.total_accumulated_depreciation} digits={0} />} loading={statsLoading} />
        <Stat label="Net book value" value={<Money amount={stats?.total_book_value} digits={0} />} loading={statsLoading} footnote="Cost less depreciation to date" />
      </div>

      <DataTable
        viewKey="finance.fixed-assets"
        caption={t('ui.fixedAssets')}
        noun="asset"
        rows={assets}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'number', dir: 'asc' }}
        searchPlaceholder="Search asset, name, category"
        toolbarStart={<Segmented label="Show" value={quick} onChange={setQuick} options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))} className="max-w-full overflow-x-auto" />}
        selectable
        bulkActions={(sel) => <BulkAction icon={ArrowDownTrayIcon} onClick={() => exportCsv(sel, columns, 'fixed-assets-selected.csv')}>Export {sel.length}</BulkAction>}
        rowActions={(a) => a.status === 'ACTIVE' && (
          <>
            <RowAction icon={CalculatorIcon} label={`Depreciate ${a.asset_number} by one month`} onClick={() => setDepFor(a)} />
            <RowAction icon={ArchiveBoxXMarkIcon} tone="risk" label={`Dispose of ${a.asset_number}`} onClick={() => setDisposeFor(a)} />
          </>
        )}
        empty={{
          icon: BuildingOffice2Icon,
          title: 'No fixed assets yet',
          description: 'Add equipment, vehicles or property the company owns, with its cost and useful life. Depreciation is then posted monthly.',
          action: <Button variant="primary" icon={PlusIcon} onClick={() => setCreateOpen(true)}>{t('ui.addAsset')}</Button>,
        }}
      />

      {runOpen && (
        <ConfirmDialog
          open
          tone="primary"
          onClose={() => setRunOpen(false)}
          title="Run one month of depreciation?"
          consequence={`Posts one month of depreciation for each of the ${counts.active} active asset${counts.active === 1 ? '' : 's'}, one journal entry each. Assets already depreciated for this period are skipped.`}
          confirmLabel="Run depreciation"
          busy={runAll.isPending}
          onConfirm={runMonthly}
        />
      )}

      {depFor && (
        <ConfirmDialog
          open
          tone="primary"
          onClose={() => setDepFor(null)}
          title={`Depreciate ${depFor.asset_number} by one month?`}
          consequence={`Posts a journal entry for one month of depreciation on ${depFor.name}, reducing its book value from ${formatMoney(depFor.book_value)}.`}
          confirmLabel="Post depreciation"
          busy={depreciate.isPending}
          onConfirm={() => depreciateOne(depFor)}
        />
      )}

      {disposeFor && <DisposeDialog asset={disposeFor} busy={dispose.isPending} onClose={() => setDisposeFor(null)} onDispose={async (reason, proceeds) => {
        try {
          const res = await dispose.mutateAsync({ id: disposeFor.id, reason, proceeds })
          const d = res?.disposal
          notify.success(d ? `${disposeFor.asset_number} disposed: ${d.gain > 0 ? `gain of ${formatMoney(d.gain)}` : `loss of ${formatMoney(d.loss)}`}` : `${disposeFor.asset_number} disposed`)
          setDisposeFor(null)
        } catch (e) {
          notify.error(`Disposal failed: ${errText(e)}`)
        }
      }} />}

      {createOpen && <CreateAssetDialog onClose={() => setCreateOpen(false)} />}
    </>
  )
}

function DisposeDialog({ asset, busy, onClose, onDispose }) {
  const [proceeds, setProceeds] = useState('0')
  const [reason, setReason] = useState('')
  const [typed, setTyped] = useState('')
  const p = Number(proceeds) || 0
  const book = Number(asset.book_value) || 0
  const result = p - book
  const ok = typed.trim() === asset.asset_number

  return (
    <Dialog
      open
      onClose={busy ? undefined : onClose}
      title={`Dispose of ${asset.asset_number}?`}
      description={asset.name}
      footer={<><Button onClick={onClose} disabled={busy}>Keep it</Button><Button variant="danger" disabled={!ok} loading={busy} onClick={() => onDispose(reason, p)}>Dispose asset</Button></>}
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-700">
          The asset leaves the register and its cost and depreciation are removed from the books. Against a book value of {formatMoney(book)},
          {' '}these proceeds book a {result >= 0 ? 'gain' : 'loss'} of <span className="font-medium text-fg">{formatMoney(Math.abs(result))}</span>. This cannot be undone.
        </p>
        <Field label="Sale proceeds" required help="0 if the asset was scrapped.">
          <Input type="number" step="0.01" min="0" numeric value={proceeds} onChange={(e) => setProceeds(e.target.value)} />
        </Field>
        <Field label="Reason" optional>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Field label={`Type ${asset.asset_number} to confirm`} required>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} className="font-mono" autoComplete="off" />
        </Field>
      </div>
    </Dialog>
  )
}

const INITIAL = { name: '', category: '', acquisition_cost: '', salvage_value: '0', useful_life_years: '5', acquisition_date: '', post_acquisition: false }

function CreateAssetDialog({ onClose }) {
  const { value: form, setValue: setForm, restored, clear, discard } = useDraft('fixed-asset:new', INITIAL)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [failure, setFailure] = useState(null)
  const create = useResourceMutation((payload) => fixedAssetsAPI.create(payload), { invalidates: [['fixed-assets'], ['journal-entries']], silent: true })

  const errors = {
    'fa-name': !form.name.trim() ? 'Name the asset.' : null,
    'fa-cost': !(Number(form.acquisition_cost) > 0) ? 'Enter what the asset cost.' : null,
    'fa-life': !(Number(form.useful_life_years) >= 1) ? 'Useful life is at least one year.' : null,
  }
  const show = (id) => (touched[id] || submitted ? errors[id] : null)
  const blur = (id) => () => setTouched((x) => ({ ...x, [id]: true }))

  const submit = async (e) => {
    e?.preventDefault()
    setSubmitted(true)
    if (Object.values(errors).some(Boolean)) return
    setFailure(null)
    try {
      const asset = await create.mutateAsync({
        name: form.name,
        category: form.category || undefined,
        acquisition_cost: Number(form.acquisition_cost),
        salvage_value: Number(form.salvage_value || 0),
        useful_life_years: Number(form.useful_life_years || 5),
        acquisition_date: form.acquisition_date || undefined,
        post_acquisition: form.post_acquisition,
      })
      clear()
      notify.success(asset?.asset_number ? `${asset.asset_number} added to the register` : 'Asset added')
      onClose()
    } catch (err) {
      setFailure(errText(err))
    }
  }

  return (
    <Dialog
      open
      size="lg"
      onClose={create.isPending ? undefined : onClose}
      title="Add fixed asset"
      description="Depreciated straight-line from the acquisition date over its useful life, down to the salvage value."
      footer={<><Button onClick={onClose} disabled={create.isPending}>Cancel</Button><Button variant="primary" onClick={submit} loading={create.isPending}>Add asset</Button></>}
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {restored && <InlineNotice action={<Button size="sm" variant="ghost" onClick={discard}>Discard draft</Button>}>Restored from a draft saved in this browser.</InlineNotice>}
        {submitted && <ErrorSummary errors={errors} />}
        {failure && <InlineNotice tone="risk" title="The asset was not added">{failure}</InlineNotice>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Asset name" required error={show('fa-name')} className="sm:col-span-2">
            <Input id="fa-name" value={form.name} onChange={set('name')} onBlur={blur('fa-name')} />
          </Field>
          <Field label="Category" optional help="e.g. Machinery, Vehicles, IT equipment" className="sm:col-span-2">
            <Input value={form.category} onChange={set('category')} />
          </Field>
          <Field label="Acquisition cost" required error={show('fa-cost')}>
            <Input id="fa-cost" type="number" step="0.01" min="0" numeric value={form.acquisition_cost} onChange={set('acquisition_cost')} onBlur={blur('fa-cost')} />
          </Field>
          <Field label="Acquisition date" optional>
            <Input type="date" value={form.acquisition_date} onChange={set('acquisition_date')} />
          </Field>
          <Field label="Useful life (years)" required error={show('fa-life')}>
            <Input id="fa-life" type="number" min="1" numeric value={form.useful_life_years} onChange={set('useful_life_years')} onBlur={blur('fa-life')} />
          </Field>
          <Field label="Salvage value" help="What it will be worth at the end of its life.">
            <Input type="number" step="0.01" min="0" numeric value={form.salvage_value} onChange={set('salvage_value')} />
          </Field>
        </div>
        <FormSection title="Ledger" advanced defaultOpen={form.post_acquisition} columns={1}>
          <Checkbox
            checked={form.post_acquisition}
            onChange={(e) => setForm((f) => ({ ...f, post_acquisition: e.target.checked }))}
            label="Post the acquisition to the ledger"
            description="Debits property, plant and equipment and credits cash. Leave it off if the purchase is already in the books."
          />
        </FormSection>
      </form>
    </Dialog>
  )
}
