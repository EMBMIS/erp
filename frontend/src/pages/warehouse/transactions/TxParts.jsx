import { useState } from 'react'
import clsx from 'clsx'
import { XMarkIcon, MagnifyingGlassIcon } from '@heroicons/react/20/solid'
import { Button, IconButton, Field, Input, Select, EmptyState, SkeletonRows } from '../../../components/ui'
import { useLocationBins } from '../useWarehouse'
import { formatBinCode } from '../warehouseData'

/**
 * Shared parts for the five warehouse movements (receipt, issue, return,
 * transfer, adjustment). These screens are used on phones and handheld
 * scanners, so everything here is one column on a phone, with 48px rows and
 * 40px+ controls.
 */

/** A titled block of the form. */
export function TxSection({ title, description, action, children, className }) {
  return (
    <section className={clsx('rounded-lg border border-ink-200 bg-surface', className)}>
      <header className="flex items-start justify-between gap-3 border-b border-ink-200 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-fg">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-ink-500">{description}</p>}
        </div>
        {action}
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}

/**
 * Pick the source document (PO, sales order, work order) from a list of big
 * rows. A search box filters by number or name — a wedge scanner can type a
 * PO number straight into it.
 */
export function DocPicker({ docs = [], selectedId, onPick, loading, number, title, meta, trailing, emptyTitle, emptyText, searchLabel = 'Find', searchPlaceholder = 'Number or name' }) {
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const shown = needle ? docs.filter((d) => `${number(d)} ${title(d) || ''}`.toLowerCase().includes(needle)) : docs
  if (loading) return <SkeletonRows rows={3} columns={2} />
  if (!docs.length) return <EmptyState compact title={emptyTitle} description={emptyText} />
  return (
    <div className="space-y-3">
      {docs.length > 5 && (
        <Field label={searchLabel} id="doc-search">
          <Input size="lg" prefix={<MagnifyingGlassIcon className="h-4 w-4" aria-hidden="true" />} value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder} autoComplete="off"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (shown.length === 1) onPick(shown[0]) } }} />
        </Field>
      )}
      <ul role="radiogroup" aria-label={searchLabel} className="max-h-[420px] divide-y divide-ink-100 overflow-y-auto rounded-md border border-ink-200 ui-scroll">
        {shown.map((d) => {
          const on = String(d.id) === String(selectedId)
          return (
            <li key={d.id}>
              <button
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onPick(d)}
                className={clsx('flex min-h-[56px] w-full items-center gap-3 px-4 py-2.5 text-left', on ? 'bg-ink-100' : 'hover:bg-ink-50')}
              >
                <span aria-hidden="true" className={clsx('h-3.5 w-3.5 shrink-0 rounded-full border', on ? 'border-[5px] border-ink-900' : 'border-ink-400')} />
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-sm text-fg">{number(d)}</span>
                  <span className="block truncate text-xs text-ink-500">{title(d)}{meta ? ` · ${meta(d)}` : ''}</span>
                </span>
                {trailing && <span className="shrink-0 text-right">{trailing(d)}</span>}
              </button>
            </li>
          )
        })}
        {!shown.length && <li className="px-4 py-3 text-sm text-ink-600">Nothing matches “{q}”.</li>}
      </ul>
    </div>
  )
}

/** One line of the movement, as a card: what, then its editable fields. */
export function LineCard({ title, subtitle, onRemove, removeLabel = 'Remove line', children, error }) {
  return (
    <li className={clsx('rounded-lg border bg-surface p-3 sm:p-4', error ? 'border-risk-300' : 'border-ink-200')}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-fg">{title}</p>
          {subtitle && <p className="mt-0.5 text-xs text-ink-500">{subtitle}</p>}
        </div>
        {onRemove && <IconButton icon={XMarkIcon} label={removeLabel} size="lg" onClick={onRemove} className="-mr-1 -mt-1" />}
      </div>
      {children && <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>}
      {error && <p className="mt-2 text-xs text-risk-600" role="alert">{error}</p>}
    </li>
  )
}

/** Location and bin for one line. Bins load for the chosen location only. */
export function LocationBin({ idPrefix, locations, locationId, binId, onChange, required = false, locationLabel = 'Storage location', binLabel = 'Bin', error }) {
  const { bins, loading } = useLocationBins(locationId)
  return (
    <>
      <Field label={locationLabel} required={required} optional={!required} error={error} id={`${idPrefix}-location`}>
        <Select size="lg" value={locationId || ''} onChange={(e) => onChange({ location: e.target.value, bin: '' })}>
          <option value="">Choose a location…</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.code} — {l.name}</option>)}
        </Select>
      </Field>
      <Field label={binLabel} optional id={`${idPrefix}-bin`}>
        <Select size="lg" value={binId || ''} onChange={(e) => onChange({ location: locationId, bin: e.target.value })} disabled={!locationId}>
          <option value="">{!locationId ? 'Choose a location first' : loading ? 'Loading bins…' : bins.length ? 'Any bin' : 'No bins here'}</option>
          {bins.map((b) => <option key={b.id} value={b.id}>{formatBinCode(b.code)}{b.description ? ` — ${b.description}` : ''}</option>)}
        </Select>
      </Field>
    </>
  )
}

/** Totals and the post button, kept in reach while scrolling a long list. */
export function TxFooter({ summary, submitLabel, onCancel, loading, disabled, blocker }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-4 border-t border-ink-200 bg-canvas/95 px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto min-w-0 text-sm text-ink-700" aria-live="polite">
          {summary}
          {blocker && <span className="block text-xs text-ink-500">{blocker}</span>}
        </div>
        <div className="flex w-full gap-2 sm:w-auto">
          <Button variant="ghost" size="lg" onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="primary" size="lg" className="flex-1 sm:min-w-[160px] sm:flex-none" loading={loading} disabled={disabled}>{submitLabel}</Button>
        </div>
      </div>
    </div>
  )
}

/** Combobox is 32px tall; on the floor it matches the 40px fields beside it. */
export const BIG_COMBO = '[&_input]:!h-10 [&_input]:!text-base [&>svg]:!top-3'
