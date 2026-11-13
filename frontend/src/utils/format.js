/**
 * The reading formatters shared by the operating surfaces.
 *
 * These live here rather than in each page because a number has to read the
 * same way on every screen: if the dashboard renders an unavailable balance as
 * "—" and the finance overview renders it as "$0", the two screens are making
 * different claims about the same ledger. Every one of these returns "—" for a
 * value that is not a finite number, so "we could not read this" never
 * masquerades as a reading of zero.
 */

export const currency = (value, code = 'USD') => {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: code,
    maximumFractionDigits: 0,
  }).format(n)
}

export const compact = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(n)
}

// Value-axis labels: compact above a thousand, whole units below it. Compact
// notation on a small number reads as a decimal ("$160.6") and makes a reader
// hunt for the magnitude, which is the one thing an axis exists to give away.
export const axisMoney = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return Math.abs(n) >= 1000 ? compact(n) : currency(n)
}

export const percent = (value, digits = 1) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return `${n.toFixed(digits)}%`
}

export const count = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString() : '—'
}

/** Humanize a SCREAMING_SNAKE_CASE entity/status name for an activity feed. */
export const humanize = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase())

export const timeAgo = (value) => {
  const then = new Date(value).getTime()
  if (!Number.isFinite(then)) return ''
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/** "Aug 2026" — the month a period is named by, from its year and month. */
export const monthName = (year, month) => {
  if (!Number.isInteger(year) || !Number.isInteger(month)) return '—'
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  })
}

/** "Aug 2026" — the same period, where a full month name will not fit. */
export const shortMonth = (year, month) => {
  if (!Number.isInteger(year) || !Number.isInteger(month)) return '—'
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, {
    month: 'short',
    year: 'numeric',
  })
}
