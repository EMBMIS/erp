
import clsx from 'clsx'

/**
 * Reading numbers.
 *
 * Every figure the product shows goes through one of these so that it reads
 * the same everywhere: tabular, right-aligned by the container, currency code
 * consistent, and "—" (not 0) for a value we could not read. A missing number
 * is never presented as a zero.
 */
const moneyFormatters = new Map()
function moneyFormatter(currency, digits) {
  const key = `${currency}|${digits}`
  if (!moneyFormatters.has(key)) {
    moneyFormatters.set(
      key,
      new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currency || 'USD',
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })
    )
  }
  return moneyFormatters.get(key)
}

export function formatMoney(amount, currency = 'USD', digits = 2) {
  const n = Number(amount)
  if (amount === null || amount === undefined || amount === '' || !Number.isFinite(n)) return '—'
  try {
    return moneyFormatter(currency, digits).format(n)
  } catch {
    return `${n.toFixed(digits)} ${currency}`
  }
}

export function formatNumber(value, digits = 0) {
  const n = Number(value)
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return '—'
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function formatDate(value, { withTime = false } = {}) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  })
}

export function relativeTime(value) {
  const t = new Date(value).getTime()
  if (!Number.isFinite(t)) return ''
  const s = Math.round((Date.now() - t) / 1000)
  const abs = Math.abs(s)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (abs < 60) return rtf.format(-s, 'second')
  if (abs < 3600) return rtf.format(-Math.round(s / 60), 'minute')
  if (abs < 86400) return rtf.format(-Math.round(s / 3600), 'hour')
  if (abs < 86400 * 30) return rtf.format(-Math.round(s / 86400), 'day')
  return formatDate(value)
}

/** Days between now and a date; negative = in the past. */
export function daysFrom(value) {
  const t = new Date(value).getTime()
  if (!Number.isFinite(t)) return null
  return Math.round((t - Date.now()) / 86400000)
}

/**
 * Money — an amount in its currency. Negative amounts carry a minus sign AND
 * are wrapped so they never rely on colour alone.
 */
export function Money({ amount, currency = 'USD', digits = 2, className = '', muted = true, signed = false }) {
  const n = Number(amount)
  if (amount === null || amount === undefined || amount === '' || !Number.isFinite(n)) {
    return <span className={clsx(muted && 'text-ink-400', className)}>—</span>
  }
  const text = formatMoney(Math.abs(n), currency, digits)
  const sign = n < 0 ? '−' : signed && n > 0 ? '+' : ''
  return (
    <span className={clsx('tabular-nums whitespace-nowrap', n < 0 && 'text-risk-600', className)}>
      {sign}
      {text}
    </span>
  )
}

/** Num — a plain number, tabular, with an optional unit set in mono. */
export function Num({ value, digits = 0, unit, className }) {
  return (
    <span className={clsx('tabular-nums whitespace-nowrap', className)}>
      {formatNumber(value, digits)}
      {unit && formatNumber(value) !== '—' && <span className="ml-1 font-mono text-2xs uppercase text-ink-500">{unit}</span>}
    </span>
  )
}

/**
 * Variance — a change against a reference. Direction is shown by sign and an
 * arrow glyph, so it reads in greyscale and to a screen reader; colour only
 * reinforces it. `goodWhen` says which direction is good for this measure.
 */
export function Variance({ value, format = 'percent', digits = 1, goodWhen = 'up', className, label }) {
  const n = Number(value)
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return <span className={clsx('text-ink-400', className)}>—</span>
  const up = n > 0
  const flat = n === 0
  const good = flat ? null : (goodWhen === 'up') === up
  const text = format === 'percent' ? `${Math.abs(n).toFixed(digits)}%` : formatNumber(Math.abs(n), digits)
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-0.5 tabular-nums whitespace-nowrap text-xs font-medium',
        good === true && 'text-ok-600',
        good === false && 'text-risk-600',
        good === null && 'text-ink-500',
        className
      )}
    >
      <span aria-hidden="true">{flat ? '→' : up ? '↑' : '↓'}</span>
      <span className="sr-only">{flat ? 'unchanged' : up ? 'up' : 'down'} </span>
      {flat ? '0' : `${up ? '+' : '−'}${text}`}
      {label && <span className="ml-1 font-normal text-ink-500">{label}</span>}
    </span>
  )
}

/** Code — an identifier (PO-2026-1004, SUP-001011) in mono. */
export function Code({ children, className }) {
  return <span className={clsx('font-mono text-[0.92em] tracking-tight', className)}>{children}</span>
}

/** DateText — a date with the full timestamp on hover. */
export function DateText({ value, withTime, relative, className }) {
  const d = value ? new Date(value) : null
  if (!d || Number.isNaN(d.getTime())) return <span className={clsx('text-ink-400', className)}>—</span>
  return (
    <time dateTime={d.toISOString()} title={formatDate(value, { withTime: true })} className={clsx('tabular-nums whitespace-nowrap', className)}>
      {relative ? relativeTime(value) : formatDate(value, { withTime })}
    </time>
  )
}

export default Money
