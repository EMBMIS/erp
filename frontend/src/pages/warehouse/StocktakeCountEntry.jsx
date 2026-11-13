import { useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { CheckBadgeIcon, PaperAirplaneIcon, MagnifyingGlassIcon, CheckIcon, ArrowPathIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useRecordTitle } from '../../components/shell/ShellContext'
import {
  PageHeader, Button, StatusBadge, Badge, Code, Input, Segmented, SummaryStrip, ConfirmDialog, InlineNotice, EmptyState,
  ErrorState, SkeletonDetail, Money, formatNumber, describeError, notify,
} from '../../components/ui'
import { SHEET_STATUS } from './warehouseData'

const num = (v) => (v == null || v === '' ? null : Number(v))
const hasVariance = (i) => i.status === 'COUNTED' && num(i.variance) != null && num(i.variance) !== 0

const VIEWS = {
  todo: { label: 'To count', test: (i) => i.status !== 'COUNTED' && i.status !== 'ADJUSTED' },
  variance: { label: 'Differences', test: hasVariance },
  all: { label: 'All', test: () => true },
}

/**
 * Count entry — built for a phone or scanner on the warehouse floor.
 *
 * Scan or type a code in the search box and press Enter: a single match
 * jumps straight to its count. Type the count and press Enter: it is saved
 * and the next uncounted line is focused. Every line is one column with a
 * large input, so it works with a thumb.
 */
export default function StocktakeCountEntry() {
  const { id } = useParams()
  const [search, setSearch] = useState('')
  const [view, setView] = useState('todo')
  const [rowState, setRowState] = useState({}) // id -> 'saving' | 'saved' | { error }
  const [confirm, setConfirm] = useState(null)
  const inputs = useRef({})

  const { data: sheet, loading, error, refetch } = useResource(keys.stocktakeSheet(id), ({ signal }) => api.get(`/stocktake/sheets/${id}`, { signal }), { enabled: Boolean(id) })
  const items = useMemo(() => sheet?.items || [], [sheet])
  useRecordTitle(sheet?.sheet_number)

  // The server recomputes variance and its value, so every write invalidates the sheet.
  const countMutation = useResourceMutation(({ itemId, countedQty }) => api.patch(`/stocktake/sheets/${id}/items/${itemId}`, { counted_quantity: Number(countedQty) }), { invalidates: [keys.stocktakeSheet(id)], silent: true })
  const postMutation = useResourceMutation(() => api.post(`/stocktake/sheets/${id}/post`), {
    // Posting writes stock adjustments and GL entries, so inventory and transactions are stale too.
    invalidates: [keys.stocktakeSheet(id), keys.stocktakeSheets(), ['inventory-items'], ['warehouse-transactions']], silent: true,
  })
  // Submit and review are two people: the server refuses a review by the person who counted (403).
  const submitMutation = useResourceMutation(() => api.post(`/stocktake/sheets/${id}/submit`), { invalidates: [keys.stocktakeSheet(id), keys.stocktakeSheets()], silent: true })
  const reviewMutation = useResourceMutation(() => api.post(`/stocktake/sheets/${id}/review`), { invalidates: [keys.stocktakeSheet(id), keys.stocktakeSheets()], silent: true })

  const countedCount = items.filter((i) => i.status === 'COUNTED' || i.status === 'ADJUSTED').length
  const variances = items.filter(hasVariance)
  const varianceValue = variances.reduce((s, i) => s + (num(i.variance_value) || 0), 0)
  const q = search.trim().toLowerCase()
  const matches = (i) => !q || i.item_name?.toLowerCase().includes(q) || i.item_code?.toLowerCase().includes(q)
  const visible = items.filter((i) => matches(i) && (q ? true : VIEWS[view].test(i)))
  const editable = sheet && !['POSTED', 'CANCELLED'].includes(sheet.status)

  const focusNext = (fromId) => {
    const order = visible.map((i) => i.id)
    const start = fromId ? order.indexOf(fromId) + 1 : 0
    const next = [...order.slice(start), ...order.slice(0, start)].find((iid) => {
      const it = items.find((x) => x.id === iid)
      return it && it.status !== 'COUNTED' && iid !== fromId
    })
    if (next) inputs.current[next]?.focus()
  }

  const record = async (item, raw) => {
    const val = String(raw).trim()
    if (val === '' || Number.isNaN(Number(val))) return
    if (item.counted_quantity != null && Number(item.counted_quantity) === Number(val)) return
    setRowState((s) => ({ ...s, [item.id]: 'saving' }))
    try {
      await countMutation.mutateAsync({ itemId: item.id, countedQty: val })
      setRowState((s) => ({ ...s, [item.id]: 'saved' }))
    } catch (e) {
      setRowState((s) => ({ ...s, [item.id]: { error: describeError(e).message } }))
    }
  }

  const step = async (kind) => {
    const m = { submit: submitMutation, review: reviewMutation, post: postMutation }[kind]
    try {
      const result = await m.mutateAsync()
      setConfirm(null)
      if (kind === 'post') notify.success(`${result?.items_posted || 0} variance${result?.items_posted === 1 ? '' : 's'} posted to stock and the ledger`)
      else notify.success(kind === 'submit' ? 'Submitted for review' : 'Reviewed — ready to post')
    } catch (e) {
      setConfirm(null)
      const d = describeError(e)
      notify.error(d.status === 403 && kind === 'review' ? 'You counted this sheet, so someone else has to review it.' : d.message)
    }
  }

  if (loading) return <SkeletonDetail />
  if (error || !sheet) return <ErrorState what="Count sheet" error={error} onRetry={refetch} />

  const meta = SHEET_STATUS[sheet.status] || { status: sheet.status }
  let primary = null
  if (sheet.status === 'IN_PROGRESS' || sheet.status === 'DRAFT') {
    const done = items.length > 0 && countedCount === items.length
    primary = <Button size="lg" variant="primary" icon={PaperAirplaneIcon} disabled={!done} title={done ? undefined : 'Count every line first'} onClick={() => setConfirm('submit')}>Submit for review</Button>
  } else if (sheet.status === 'COUNTED') {
    primary = <Button size="lg" variant="primary" icon={CheckBadgeIcon} onClick={() => setConfirm('review')}>Review and approve</Button>
  } else if (sheet.status === 'REVIEWED') {
    primary = <Button size="lg" variant="primary" icon={PaperAirplaneIcon} disabled={!variances.length} title={variances.length ? undefined : 'No differences to post'} onClick={() => setConfirm('post')}>Post differences</Button>
  }

  const CONFIRMS = {
    submit: { title: `Submit ${sheet.sheet_number} for review?`, consequence: 'Counting closes. A different manager reviews the differences before they are posted.', label: 'Submit for review', tone: 'primary' },
    review: { title: `Approve the count on ${sheet.sheet_number}?`, consequence: `${variances.length} difference${variances.length === 1 ? '' : 's'} will be ready to post. You cannot review a sheet you counted yourself.`, label: 'Approve count', tone: 'primary' },
    post: { title: `Post ${variances.length} difference${variances.length === 1 ? '' : 's'}?`, consequence: `Stock levels are adjusted to the counted quantities and the ledger records a net ${varianceValue < 0 ? 'loss' : 'gain'} of ${formatNumber(Math.abs(varianceValue), 2)}.`, label: 'Post to stock and ledger', tone: 'danger' },
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title={sheet.sheet_number}
        status={<StatusBadge status={meta.status} label={meta.label} />}
        description={editable ? 'Scan or type an item, enter what you count, press Enter. Each count saves on its own.' : 'This count is closed.'}
        primary={primary}
      />

      <SummaryStrip
        className="lg:grid-cols-4"
        facts={[
          { label: 'Counted', value: `${countedCount} / ${items.length}`, hint: items.length ? `${Math.round((countedCount / items.length) * 100)}% done` : 'no lines' },
          { label: 'Left to count', value: items.length - countedCount },
          { label: 'Differences', value: variances.length },
          { label: 'Value of differences', value: <Money amount={variances.length ? varianceValue : null} signed />, hint: 'at unit price' },
        ]}
      />

      <div className="sticky top-0 z-[5] -mx-4 space-y-2 bg-canvas/95 px-4 py-2 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <form role="search" onSubmit={(e) => { e.preventDefault(); const hits = items.filter(matches); if (hits.length === 1) inputs.current[hits[0].id]?.focus() }}>
          <Input
            size="lg"
            type="search"
            aria-label="Scan or search items"
            prefix={<MagnifyingGlassIcon className="h-4 w-4" aria-hidden="true" />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Scan a barcode or type a name or code"
            autoComplete="off"
            enterKeyHint="search"
          />
        </form>
        {!q && <Segmented size="md" label="Show" value={view} onChange={setView} options={Object.entries(VIEWS).map(([k, v]) => ({ value: k, label: `${v.label} ${items.filter(v.test).length}` }))} />}
      </div>

      {!visible.length ? (
        <div className="rounded-lg border border-ink-200 bg-surface">
          <EmptyState
            compact
            icon={q ? MagnifyingGlassIcon : CheckIcon}
            title={q ? `Nothing matches “${search}”` : view === 'todo' ? 'Everything is counted' : 'Nothing to show'}
            description={q ? 'Check the code, or clear the search to see every line.' : view === 'todo' ? 'Look over the differences, then submit the sheet for review.' : null}
            action={q ? <Button onClick={() => setSearch('')}>Clear search</Button> : null}
          />
        </div>
      ) : (
        <ul className="divide-y divide-ink-100 overflow-hidden rounded-lg border border-ink-200 bg-surface">
          {visible.map((item) => {
            const variance = num(item.variance)
            const st = rowState[item.id]
            const counted = item.status === 'COUNTED' || item.status === 'ADJUSTED'
            return (
              <li key={item.id} className="grid grid-cols-1 gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_120px_160px_150px] sm:items-center">
                <div className="min-w-0">
                  <p className="truncate font-medium text-fg">{item.item_name}</p>
                  <p className="flex items-center gap-2 text-xs text-ink-500">
                    <Code>{item.item_code}</Code>
                    {item.status === 'ADJUSTED' && <Badge tone="ok" glyph="square">Posted</Badge>}
                  </p>
                </div>
                <div className="flex items-baseline justify-between sm:block sm:text-right">
                  <span className="text-xs text-ink-500 sm:block">Book</span>
                  <span className="tabular-nums text-ink-800">{formatNumber(item.book_quantity, 2)}</span>
                </div>
                <div>
                  {editable ? (
                    <Input
                      ref={(el) => { inputs.current[item.id] = el }}
                      size="lg"
                      type="number"
                      inputMode="decimal"
                      step="any"
                      numeric
                      aria-label={`Counted quantity of ${item.item_name}`}
                      defaultValue={item.counted_quantity ?? ''}
                      placeholder="Count"
                      enterKeyHint="next"
                      onBlur={(e) => record(item, e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); record(item, e.currentTarget.value); focusNext(item.id) } }}
                    />
                  ) : (
                    <span className="block text-right tabular-nums">{formatNumber(item.counted_quantity ?? item.book_quantity, 2)}</span>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2 sm:justify-end" aria-live="polite">
                  {st === 'saving' ? (
                    <span className="flex items-center gap-1 text-xs text-ink-500"><ArrowPathIcon className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Saving</span>
                  ) : st?.error ? (
                    <span className="text-xs text-risk-600">Not saved: {st.error}</span>
                  ) : counted ? (
                    variance ? (
                      <Badge tone="warn" glyph="triangle">{variance > 0 ? '+' : '−'}{formatNumber(Math.abs(variance), 2)}{num(item.variance_value) ? ` · ${formatNumber(Math.abs(num(item.variance_value)), 2)}` : ''}</Badge>
                    ) : <Badge tone="ok" glyph="check">Matches</Badge>
                  ) : <span className="text-xs text-ink-400">Not counted</span>}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {sheet.status === 'REVIEWED' && !variances.length && (
        <InlineNotice title="No differences to post">Every count matched the book, so there is nothing to adjust.</InlineNotice>
      )}

      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={() => step(confirm)}
          title={CONFIRMS[confirm].title}
          consequence={CONFIRMS[confirm].consequence}
          confirmLabel={CONFIRMS[confirm].label}
          tone={CONFIRMS[confirm].tone}
          busy={submitMutation.isPending || reviewMutation.isPending || postMutation.isPending}
        />
      )}
    </div>
  )
}
