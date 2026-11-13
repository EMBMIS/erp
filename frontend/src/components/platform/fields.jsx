/**
 * Rendering and editing one field of a generated application.
 *
 * ===========================================================================
 * WHY THIS FILE IS SMALL AND THERE IS ONLY ONE OF IT
 * ===========================================================================
 * The whole claim of the platform is that a new application needs no new React.
 * That holds only if every screen is assembled from components that take their
 * shape from data. So there is exactly one place that knows how a `money` value
 * looks and how an `enum` is edited, and every table, form, detail page and
 * portal in every generated application goes through it.
 *
 * The field descriptors come from the server (services/platform/runtime/page.js),
 * already filtered to what this principal may see or write. Nothing here
 * decides visibility — a field that reached the browser is one the server
 * decided to send, and a field that did not is not hidden by CSS, it is absent.
 */

import React from 'react'

const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })
const cf = new Intl.NumberFormat(undefined, { style: 'decimal', minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** A field's value, formatted for reading. */
export function formatValue(field, row) {
  const value = row?.[field.name]

  // A reference renders as the label the server resolved for it. Showing a
  // UUID would be technically accurate and useless.
  if (field.type === 'reference') {
    const label = row?.[`${field.name}__label`]
    if (label) return label
    return value ? '—' : ''
  }
  if (value === null || value === undefined || value === '') return ''

  switch (field.type) {
    case 'money': return cf.format(Number(value))
    case 'decimal': case 'integer': case 'bigint': case 'duration_hours': return nf.format(Number(value))
    case 'percent': return `${nf.format(Number(value))}%`
    case 'boolean': return value ? 'Yes' : 'No'
    case 'date': return new Date(value).toLocaleDateString()
    case 'datetime': return new Date(value).toLocaleString()
    case 'json': return JSON.stringify(value)
    default: return String(value)
  }
}

const TONE = {
  OPEN: 'bos-accent-amber', NEW: 'bos-accent-amber', SUBMITTED: 'bos-accent-amber', PROPOSED: 'bos-accent-amber',
  ASSIGNED: 'bos-accent-blue', IN_PROGRESS: 'bos-accent-blue', UNDER_REVIEW: 'bos-accent-blue', ACCEPTED: 'bos-accent-blue',
  INTERNAL_REVIEW: 'bos-accent-violet', SUPPLIER_RESPONSE: 'bos-accent-violet', INSPECTION: 'bos-accent-violet',
  CORRECTIVE_ACTION: 'bos-accent-cyan', REPLACEMENT: 'bos-accent-cyan',
  VERIFIED: 'bos-accent-green', COMPLETED: 'bos-accent-green', DONE: 'bos-accent-green',
  CLOSED: 'bos-accent-green', APPROVED: 'bos-accent-green', PASS: 'bos-accent-green',
  BLOCKED: 'bos-accent-rose', REJECTED: 'bos-accent-rose', FAIL: 'bos-accent-rose', CRITICAL: 'bos-accent-rose',
  HIGH: 'bos-accent-rose', MEDIUM: 'bos-accent-amber', LOW: 'bos-accent-cyan',
  CANCELLED: 'bos-text-faint',
}

export function statusTone(value) {
  return TONE[String(value || '').toUpperCase()] || 'bos-accent-blue'
}

/** A single cell. Enums get a chip, so a status is scannable down a column. */
export function FieldValue({ field, row }) {
  const value = row?.[field.name]
  if (field.type === 'enum' && value) {
    return (
      <span className={`bos-chip ${statusTone(value)}`} title={String(value)}>
        {String(value).replace(/_/g, ' ').toLowerCase()}
      </span>
    )
  }
  if (field.type === 'boolean') {
    return <span className={value ? 'bos-text' : 'bos-text-faint'}>{value ? 'Yes' : 'No'}</span>
  }
  const text = formatValue(field, row)
  if (!text) return <span className="bos-text-faint">—</span>
  const numeric = ['money', 'decimal', 'integer', 'bigint', 'percent', 'duration_hours'].includes(field.type)
  return <span className={numeric ? 'tabular-nums' : ''}>{text}</span>
}

/**
 * An input for one field.
 *
 * `referenceOptions` is supplied by the caller, which fetched them from the
 * server's canonical/entity endpoints. This component never fetches: a picker
 * that loaded its own options would be a second place deciding which records a
 * user may choose between.
 */
export function FieldInput({ field, value, onChange, referenceOptions = [], onReferenceSearch, disabled }) {
  const common = 'bos-field w-full'
  const set = (v) => onChange(field.name, v)

  switch (field.type) {
    case 'long_text':
      return (
        <textarea className={`${common} min-h-[96px]`} value={value ?? ''} disabled={disabled}
          onChange={(e) => set(e.target.value)} placeholder={field.help || ''} />
      )
    case 'enum':
      return (
        <select className={common} value={value ?? ''} disabled={disabled} onChange={(e) => set(e.target.value || null)}>
          <option value="">{field.required ? 'Choose…' : '—'}</option>
          {(field.values || []).map((v) => (
            <option key={v} value={v}>{v.replace(/_/g, ' ')}</option>
          ))}
        </select>
      )
    case 'boolean':
      return (
        <label className="flex items-center gap-2 text-[13px] bos-text">
          <input type="checkbox" checked={!!value} disabled={disabled} onChange={(e) => set(e.target.checked)} />
          {field.label}
        </label>
      )
    case 'date':
      return <input type="date" className={common} value={(value || '').slice(0, 10)} disabled={disabled}
        onChange={(e) => set(e.target.value || null)} />
    case 'datetime':
      return <input type="datetime-local" className={common} value={(value || '').slice(0, 16)} disabled={disabled}
        onChange={(e) => set(e.target.value ? new Date(e.target.value).toISOString() : null)} />
    case 'integer': case 'bigint':
      return <input type="number" step="1" className={common} value={value ?? ''} disabled={disabled}
        onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))} />
    case 'decimal': case 'money': case 'percent': case 'duration_hours':
      return <input type="number" step="0.01" className={common} value={value ?? ''} disabled={disabled}
        onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))} />
    case 'email':
      return <input type="email" className={common} value={value ?? ''} disabled={disabled} onChange={(e) => set(e.target.value)} />
    case 'url':
      return <input type="url" className={common} value={value ?? ''} disabled={disabled} onChange={(e) => set(e.target.value)} />
    case 'reference':
      return (
        <div className="space-y-1">
          {onReferenceSearch && (
            <input className={common} placeholder="Search…" disabled={disabled}
              onChange={(e) => onReferenceSearch(field, e.target.value)} />
          )}
          <select className={common} value={value ?? ''} disabled={disabled} onChange={(e) => set(e.target.value || null)}>
            <option value="">{field.required ? 'Choose…' : '—'}</option>
            {referenceOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </div>
      )
    case 'json':
      return (
        <textarea className={`${common} font-mono text-[12px] min-h-[96px]`} disabled={disabled}
          value={typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2)}
          onChange={(e) => set(e.target.value)} />
      )
    default:
      return <input type="text" className={common} value={value ?? ''} disabled={disabled} onChange={(e) => set(e.target.value)} />
  }
}

/** The width a block asks for, as a grid span. */
export const WIDTH_CLASS = {
  quarter: 'md:col-span-3',
  third: 'md:col-span-4',
  half: 'md:col-span-6',
  two_thirds: 'md:col-span-8',
  full: 'md:col-span-12',
}
