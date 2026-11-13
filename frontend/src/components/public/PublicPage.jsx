/**
 * The frame for every page a person reaches without the app shell: sign in,
 * sign up, password reset, the legal pages, and the token links we email to
 * suppliers and customers (respond to an RFQ, accept a quotation, confirm a
 * delivery).
 *
 * The rules these pages follow:
 *   - No navigation, no marketing. A mark, the task, one clear action.
 *   - Works on a phone first: one column, full-width actions, large targets.
 *   - Tokens only, so light and dark both read correctly.
 *
 * None of the public endpoints return the sending company's name or logo yet,
 * so `brand` defaults to the product mark. Pass `brand={{ name, logo }}` when
 * a page has them.
 */
import React from 'react'
import clsx from 'clsx'
import { Link } from 'react-router-dom'
import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline'
import { CheckCircleIcon, ExclamationTriangleIcon, XCircleIcon, InformationCircleIcon } from '@heroicons/react/20/solid'
import DarkModeToggle from '../DarkModeToggle'
import { LanguageSwitcher } from '../LocaleSwitcher'
import { Skeleton, Input, Num } from '../ui'

const WIDTHS = { narrow: 'max-w-md', default: 'max-w-3xl', wide: 'max-w-5xl' }

export function PublicShell({ children, width = 'default', brand, context, footer = true }) {
  const name = brand?.name || 'EMBMIS'
  const logo = brand?.logo || '/logo-mark.png'
  return (
    <div className="flex min-h-screen flex-col bg-canvas text-fg">
      <header className="border-b border-ink-200 bg-surface">
        <div className={clsx('mx-auto flex w-full items-center justify-between gap-3 px-4 py-3 sm:px-6', WIDTHS[width] || WIDTHS.default)}>
          <div className="flex min-w-0 items-center gap-2.5">
            <img src={logo} alt="" className="h-7 w-7 shrink-0 select-none rounded-md" />
            <span className="truncate text-sm font-semibold tracking-tight text-fg">{name}</span>
            {context && <span className="hidden truncate text-sm text-ink-500 sm:inline">· {context}</span>}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <LanguageSwitcher />
            <DarkModeToggle className="h-9 w-9" />
          </div>
        </div>
      </header>
      <main className={clsx('mx-auto w-full flex-1 px-4 py-6 sm:px-6 sm:py-10', WIDTHS[width] || WIDTHS.default)}>
        {children}
      </main>
      {footer && (
        <footer className="px-4 pb-6 text-center text-xs text-ink-500">
          <Link to="/terms" className="underline-offset-2 hover:text-ink-800 hover:underline">Terms of Service</Link>
          <span className="mx-2" aria-hidden="true">·</span>
          <Link to="/privacy" className="underline-offset-2 hover:text-ink-800 hover:underline">Privacy Policy</Link>
        </footer>
      )}
    </div>
  )
}

/** Title block for a public page: what this is, and the record it is about. */
export function PublicHeader({ eyebrow, title, description, status, className }) {
  return (
    <header className={clsx('mb-6', className)}>
      {eyebrow && <p className="label-mono mb-1">{eyebrow}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="min-w-0 break-words text-xl font-semibold tracking-tight text-fg sm:text-2xl">{title}</h1>
        {status}
      </div>
      {description && <p className="mt-1.5 text-sm text-ink-600">{description}</p>}
    </header>
  )
}

/** Loading placeholder shaped like the page that is coming. */
export function PublicLoading({ label = 'Loading' }) {
  return (
    <div role="status" aria-live="polite" className="space-y-5">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-6 w-2/3" />
      <div className="space-y-3 rounded-lg border border-ink-200 bg-surface p-4">
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-3 w-3/4" />
        <Skeleton className="h-3 w-2/5" />
      </div>
      <Skeleton className="h-10 w-full" />
    </div>
  )
}

const TONES = {
  ok: { Icon: CheckCircleIcon, cls: 'text-ok-600' },
  risk: { Icon: XCircleIcon, cls: 'text-risk-600' },
  warn: { Icon: ExclamationTriangleIcon, cls: 'text-warn-600' },
  ink: { Icon: InformationCircleIcon, cls: 'text-ink-500' },
}

/**
 * A full-page outcome: submitted, declined, link expired, not found.
 * Says what happened and what (if anything) to do next.
 */
export function PublicMessage({ tone = 'ink', title, children, action, reference, className }) {
  const { Icon, cls } = TONES[tone] || TONES.ink
  return (
    <section
      role={tone === 'risk' ? 'alert' : 'status'}
      className={clsx('mx-auto max-w-md rounded-lg border border-ink-200 bg-surface p-6 text-center sm:p-8', className)}
    >
      <Icon className={clsx('mx-auto h-8 w-8', cls)} aria-hidden="true" />
      <h1 className="mt-3 text-lg font-semibold text-fg">{title}</h1>
      {children && <div className="mt-2 space-y-2 text-sm text-ink-600">{children}</div>}
      {reference && (
        <p className="mt-3 text-xs text-ink-500">
          Reference <span className="select-all font-mono">{reference}</span>
        </p>
      )}
      {action && <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">{action}</div>}
    </section>
  )
}

/** A titled group on a public page. Hairline border, no shadow. */
export function PublicSection({ title, description, children, className, padded = true, aside }) {
  return (
    <section className={clsx('min-w-0 rounded-lg border border-ink-200 bg-surface', className)}>
      {(title || aside) && (
        <header className="flex items-start justify-between gap-3 border-b border-ink-200 px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-fg">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-ink-500">{description}</p>}
          </div>
          {aside}
        </header>
      )}
      <div className={clsx(padded && 'p-4')}>{children}</div>
    </section>
  )
}

/**
 * Lines of a document (items on a quotation, order, PO). A table from `sm`
 * up; on a phone each line becomes a stacked card so nothing scrolls sideways.
 *
 * columns: [{ key, label, align: 'right', render(row) }]. The first column is
 * the line's title on the phone card.
 */
export function LineList({ columns, rows, rowKey = (r, i) => r.id ?? i, footer, label = 'Lines' }) {
  const [first, ...rest] = columns
  const cell = (c, r) => (c.render ? c.render(r) : r[c.key]) ?? <span className="text-ink-400">—</span>
  return (
    <div>
      <div className="hidden sm:block">
        <table className="w-full text-sm" aria-label={label}>
          <thead>
            <tr className="border-b border-ink-200">
              {columns.map((c) => (
                <th key={c.key} scope="col" className={clsx('label-mono px-4 py-2 font-normal', c.align === 'right' ? 'text-right' : 'text-left')}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((r, i) => (
              <tr key={rowKey(r, i)}>
                {columns.map((c) => (
                  <td key={c.key} className={clsx('px-4 py-2.5 align-top text-ink-900', c.align === 'right' && 'text-right tabular-nums')}>
                    {cell(c, r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-ink-100 sm:hidden" aria-label={label}>
        {rows.map((r, i) => (
          <li key={rowKey(r, i)} className="px-4 py-3">
            <div className="text-sm font-medium text-fg">{cell(first, r)}</div>
            <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1">
              {rest.map((c) => (
                <div key={c.key} className="min-w-0">
                  <dt className="text-xs text-ink-500">{c.label}</dt>
                  <dd className={clsx('text-sm text-ink-900', c.align === 'right' && 'tabular-nums')}>{cell(c, r)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
      {footer && <div className="border-t border-ink-200 px-4 py-3">{footer}</div>}
    </div>
  )
}

/** Right-aligned totals: [{ label, value, strong }]. */
export function Totals({ rows }) {
  return (
    <dl className="ml-auto max-w-xs space-y-1 text-sm">
      {rows.filter(Boolean).map((r) => (
        <div key={r.label} className={clsx('flex items-baseline justify-between gap-6', r.strong && 'border-t border-ink-200 pt-1.5 font-semibold text-fg')}>
          <dt className={r.strong ? '' : 'text-ink-600'}>{r.label}</dt>
          <dd className="tabular-nums">{r.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * A decision as large radio cards (accept / decline). Each option is a full
 * label so the whole card is the tap target.
 * options: [{ value, label, description }]
 */
export function ChoiceGroup({ legend, name, value, onChange, options, error, className }) {
  const errId = `${name}-error`
  return (
    <fieldset className={className} aria-describedby={error ? errId : undefined}>
      <legend className="mb-2 text-sm font-medium text-ink-800">{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((o) => {
          const checked = value === o.value
          return (
            <label
              key={o.value}
              className={clsx(
                'flex min-h-[48px] cursor-pointer items-start gap-3 rounded-lg border px-3.5 py-3 text-sm transition-colors',
                'focus-within:ring-[3px] focus-within:ring-brand-500/20',
                checked ? 'border-brand-600 bg-brand-50 text-fg' : 'border-ink-300 bg-surface hover:border-ink-400'
              )}
            >
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={checked}
                onChange={() => onChange(o.value)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--t-brand-600))]"
              />
              <span className="min-w-0">
                <span className="block font-medium text-fg">{o.label}</span>
                {o.description && <span className="mt-0.5 block text-xs text-ink-600">{o.description}</span>}
              </span>
            </label>
          )
        })}
      </div>
      {error && <p id={errId} className="mt-1.5 text-xs text-risk-600">{error}</p>}
    </fieldset>
  )
}

/** Bottom action row: stacked full-width on a phone, right-aligned on desktop. */
export function PublicActions({ children, note, className }) {
  return (
    <div className={clsx('flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between', className)}>
      {note ? <p className="text-xs text-ink-500">{note}</p> : <span className="hidden sm:block" />}
      <div className="flex flex-col-reverse gap-2 sm:flex-row [&>*]:w-full sm:[&>*]:w-auto">{children}</div>
    </div>
  )
}

/** Password input with a show/hide toggle. Receives id/aria-* from Field. */
export function PasswordInput({ shown, onToggle, showLabel = 'Show password', hideLabel = 'Hide password', ...props }) {
  return (
    <div className="relative">
      <Input type={shown ? 'text' : 'password'} size="lg" className="pr-11" {...props} />
      <button
        type="button"
        onClick={onToggle}
        aria-label={shown ? hideLabel : showLabel}
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-ink-500 hover:text-ink-800"
      >
        {shown ? <EyeSlashIcon className="h-5 w-5" aria-hidden="true" /> : <EyeIcon className="h-5 w-5" aria-hidden="true" />}
      </button>
    </div>
  )
}

/** A quantity with its unit; keeps decimals only when the value has them. */
export function Qty({ value, unit }) {
  const n = Number(value)
  const digits = Number.isFinite(n) && !Number.isInteger(n) ? 2 : 0
  return <Num value={value} digits={digits} unit={unit} />
}
