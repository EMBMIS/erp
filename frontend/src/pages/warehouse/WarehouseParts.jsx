import clsx from 'clsx'
import { Badge, formatNumber } from '../../components/ui'
import { fillState, pct } from './warehouseData'

const FILL = { ok: 'bg-ink-500', warn: 'bg-warn-500', risk: 'bg-risk-500' }
const WORD = { ok: null, warn: 'Getting full', risk: 'Near capacity' }

/**
 * How full a bin (or a whole location) is, by weight or by volume.
 * The bar is ink until it matters; near capacity it says so in words too.
 */
export function Utilisation({ label, percent, used, max, unit, digits = 1, compact = false, className }) {
  const p = pct(percent)
  const state = fillState(p)
  return (
    <div className={clsx('min-w-0', className)}>
      <div className="flex items-baseline justify-between gap-2">
        {label && <span className="text-xs text-ink-600">{label}</span>}
        <span className="ml-auto flex items-center gap-2 text-sm tabular-nums text-fg">
          {p == null ? <span className="text-ink-400">—</span> : `${formatNumber(p, p % 1 ? 1 : 0)}%`}
          {!compact && state && WORD[state] && <Badge tone={state} glyph="triangle">{WORD[state]}</Badge>}
        </span>
      </div>
      <div
        className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-ink-200"
        role="meter"
        aria-label={label || 'Utilisation'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={p == null ? undefined : Math.min(p, 100)}
      >
        {p != null && <div className={clsx('h-full rounded-full', FILL[state])} style={{ width: `${Math.min(p, 100)}%` }} />}
      </div>
      {!compact && (used != null || max != null) && (
        <p className="mt-1 text-xs tabular-nums text-ink-500">
          {used == null ? '—' : formatNumber(used, digits)} of {max == null ? '—' : formatNumber(max, digits)} {unit}
        </p>
      )}
    </div>
  )
}

/**
 * ModeChooser — pick how a transaction starts (against a PO, manually…).
 * Large tap targets, one column on a phone. A radio group, not a row of
 * look-alike buttons, so the choice is announced as a choice.
 */
export function ModeChooser({ label, value, onChange, options, columns = 3 }) {
  const grid = { 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3', 5: 'sm:grid-cols-3 lg:grid-cols-5' }[columns] || 'sm:grid-cols-3'
  return (
    <div role="radiogroup" aria-label={label} className={clsx('grid grid-cols-1 gap-2', grid)}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={clsx(
              'min-h-[56px] rounded-lg border px-4 py-3 text-left transition-colors',
              on ? 'border-ink-900 bg-surface ring-1 ring-ink-900' : 'border-ink-200 bg-surface hover:border-ink-400'
            )}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-fg">{o.label}</span>
              {o.badge}
              <span aria-hidden="true" className={clsx('h-3.5 w-3.5 shrink-0 rounded-full border', on ? 'border-[5px] border-ink-900' : 'border-ink-400')} />
            </span>
            {o.description && <span className="mt-0.5 block text-xs text-ink-500">{o.description}</span>}
          </button>
        )
      })}
    </div>
  )
}
