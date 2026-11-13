
import clsx from 'clsx'
import { Link } from 'react-router-dom'
import { ExclamationTriangleIcon, ArrowPathIcon } from '@heroicons/react/24/outline'
import { Button } from './Button'

/**
 * EmptyState — says what this list is, why it is empty, and offers the one
 * next action. Never just "No records found".
 *
 * Accepts both the new shape ({ title, description, action }) and the legacy
 * one ({ message, actionLabel, onAction, actionHref: Link, actionTo, tip }).
 */
export function EmptyState({ icon: Icon, title, description, message, action, actionLabel, onAction, actionHref: ActionLink, actionTo, tip, className, compact = false }) {
  const body = description ?? message
  let cta = action
  if (!cta && actionLabel) {
    if (onAction) cta = <Button variant="primary" onClick={onAction}>{actionLabel}</Button>
    else if (actionTo) cta = <Button variant="primary" to={actionTo}>{actionLabel}</Button>
    else if (ActionLink) cta = <ActionLink to={actionTo}>{actionLabel}</ActionLink>
  }
  return (
    <div className={clsx('mx-auto max-w-md text-center', compact ? 'py-6' : 'py-12', className)}>
      {Icon && (
        <span className="mx-auto mb-3 inline-flex h-9 w-9 items-center justify-center rounded-md border border-ink-200 bg-sunken text-ink-500">
          <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
        </span>
      )}
      {title && <h3 className="text-sm font-semibold text-fg">{title}</h3>}
      {body && <p className="mt-1 text-sm text-ink-600">{body}</p>}
      {tip && <p className="mt-2 text-xs text-ink-500">{tip}</p>}
      {cta && <div className="mt-4 flex justify-center gap-2">{cta}</div>}
    </div>
  )
}

/** Pull what failed and a reference id out of an axios error or API body. */
export function describeError(error) {
  const res = error?.response
  const data = res?.data || {}
  const reference = data.error_id || data.errorId || data.request_id || res?.headers?.['x-request-id'] || null
  const status = res?.status
  let message = data.error || data.message || error?.message || 'The request did not complete.'
  if (typeof message !== 'string') message = JSON.stringify(message)
  let next = 'Try again. If it keeps failing, send the reference below to your administrator.'
  if (!res) next = 'The server could not be reached. Check your connection, then try again.'
  else if (status === 401) next = 'Your session has ended. Sign in again; nothing you saved is lost.'
  else if (status === 403) next = 'Your role does not include this. Ask an administrator for access if you need it.'
  else if (status === 404) next = 'It may have been removed, or the link is out of date.'
  else if (status === 409) next = 'Someone else changed this record. Reload to see the current version.'
  else if ((status === 422 || status === 400) && ['post', 'put', 'patch'].includes(String(error?.config?.method || '').toLowerCase())) next = 'Check the highlighted fields and try again.'
  else if (status === 400 || status === 422) next = 'The server rejected this request. Try again; if it keeps failing, send the reference below to your administrator.'
  else if (status === 503) next = 'This service is temporarily unavailable. Try again in a minute.'
  return { message, next, reference, status }
}

/**
 * ErrorState — what failed, what to do, and a reference id. Never a bare
 * "Something went wrong".
 */
export function ErrorState({ error, what = 'This view', onRetry, className, compact = false }) {
  const { message, next, reference, status } = describeError(error)
  return (
    <div role="alert" className={clsx('mx-auto max-w-lg', compact ? 'py-4' : 'py-10', className)}>
      <div className="rounded-lg border border-risk-200 bg-risk-50 p-4">
        <p className="flex items-start gap-2 text-sm font-semibold text-risk-800">
          <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{what} did not load{status ? ` (${status})` : ''}.</span>
        </p>
        <p className="mt-1.5 pl-6 text-sm text-risk-800">{message}</p>
        <p className="mt-1 pl-6 text-sm text-ink-700">{next}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3 pl-6">
          {onRetry && <Button size="sm" variant="secondary" icon={ArrowPathIcon} onClick={onRetry}>Try again</Button>}
          {reference && (
            <span className="text-xs text-ink-600">
              Reference <span className="select-all font-mono">{reference}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

/** InlineNotice — a calm, inline message. Use instead of a toast when the outcome is on screen. */
export function InlineNotice({ tone = 'ink', title, children, action, className, icon: Icon }) {
  const tones = {
    ink: 'border-ink-200 bg-sunken text-ink-800',
    brand: 'border-brand-200 bg-brand-50 text-brand-800',
    ok: 'border-ok-200 bg-ok-50 text-ok-800',
    warn: 'border-warn-200 bg-warn-50 text-warn-800',
    risk: 'border-risk-200 bg-risk-50 text-risk-800',
  }
  return (
    <div role={tone === 'risk' ? 'alert' : 'status'} className={clsx('flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm', tones[tone], className)}>
      {Icon && <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={clsx(title && 'mt-0.5')}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

/** Unavailable — a feature that exists in the UI but whose backend does not work yet. */
export function Unavailable({ feature, reason, className }) {
  return (
    <InlineNotice tone="warn" title={`${feature} is not available yet`} className={className}>
      {reason}
    </InlineNotice>
  )
}

/* ---------------------------------------------------------------- Skeletons */

export function Skeleton({ className, style }) {
  return <span aria-hidden="true" className={clsx('skeleton block h-4', className)} style={style} />
}

/** A table-shaped skeleton: the real header, rows of the real height. */
export function SkeletonRows({ rows = 8, columns = 5, className }) {
  return (
    <div role="status" aria-live="polite" className={clsx('divide-y divide-ink-100', className)}>
      <span className="sr-only">Loading</span>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex h-10 items-center gap-6 px-4">
          {Array.from({ length: columns }).map((__, c) => (
            <Skeleton key={c} className={clsx('h-3', c === 0 ? 'w-28' : c === columns - 1 ? 'ml-auto w-16' : 'w-24')} style={{ opacity: 1 - r * 0.07 }} />
          ))}
        </div>
      ))}
    </div>
  )
}

/** A detail-page skeleton: header, five facts, tabs, body. */
export function SkeletonDetail() {
  return (
    <div role="status" aria-live="polite" className="space-y-5">
      <span className="sr-only">Loading</span>
      <Skeleton className="h-3 w-40" />
      <Skeleton className="h-7 w-72" />
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-ink-200 bg-ink-200 sm:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="space-y-2 bg-surface p-4"><Skeleton className="h-2.5 w-16" /><Skeleton className="h-5 w-24" /></div>
        ))}
      </div>
      <Skeleton className="h-8 w-80" />
      <SkeletonRows rows={5} />
    </div>
  )
}

/* ---------------------------------------------------------------- Timeline */

/**
 * Timeline — what happened to a record, newest first. Each event: who, what,
 * when, and an optional note (e.g. a rejection reason). The dot shape follows
 * the event's tone so it reads without colour.
 * events: [{ id, title, actor, at, note, tone: 'ok'|'warn'|'risk'|'brand'|'ink' }]
 */
export function Timeline({ events = [], empty = 'Nothing has happened to this record yet.', className }) {
  if (!events.length) return <p className={clsx('text-sm text-ink-500', className)}>{empty}</p>
  const dot = {
    ok: 'bg-ok-500', warn: 'bg-warn-500 rotate-45 rounded-none', risk: 'bg-risk-500 rounded-none',
    brand: 'bg-brand-600', ink: 'bg-surface border border-ink-400',
  }
  return (
    <ol className={clsx('relative space-y-4', className)}>
      <span aria-hidden="true" className="absolute bottom-1 left-[4px] top-1 w-px bg-ink-200" />
      {events.map((e, i) => (
        <li key={e.id ?? i} className="relative pl-5">
          <span aria-hidden="true" className={clsx('absolute left-0 top-1.5 h-[9px] w-[9px] rounded-full', dot[e.tone] || dot.ink)} />
          <p className="text-sm text-ink-900">
            <span className="font-medium">{e.title}</span>
            {e.actor && <span className="text-ink-600"> · {e.actor}</span>}
          </p>
          {e.at && <p className="mt-0.5 font-mono text-2xs text-ink-500">{new Date(e.at).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>}
          {e.note && <p className="mt-1 rounded-md bg-sunken px-2 py-1.5 text-sm text-ink-700">{e.note}</p>}
        </li>
      ))}
    </ol>
  )
}

/* ------------------------------------------------------- Detail page pattern */

/**
 * SummaryStrip — the five facts that matter about a record, in one row.
 * facts: [{ label, value, hint, to }]
 */
export function SummaryStrip({ facts = [], className }) {
  return (
    <dl className={clsx('grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-ink-200 bg-ink-200 sm:grid-cols-3 lg:grid-cols-5', className)}>
      {facts.filter(Boolean).map((f) => (
        <div key={f.label} className="min-w-0 bg-surface px-4 py-3">
          <dt className="label-mono truncate">{f.label}</dt>
          <dd className="mt-1 truncate text-base font-medium tabular-nums text-fg">
            {f.to ? <Link to={f.to} className="hover:underline underline-offset-2">{f.value}</Link> : f.value}
          </dd>
          {f.hint && <dd className="mt-0.5 truncate text-xs text-ink-500">{f.hint}</dd>}
        </div>
      ))}
    </dl>
  )
}

/** DescriptionList — label/value pairs for a tab body. */
export function DescriptionList({ items = [], columns = 2, className }) {
  return (
    <dl className={clsx('grid gap-x-6 gap-y-3', columns === 1 ? 'grid-cols-1' : columns === 3 ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2', className)}>
      {items.filter(Boolean).map((it) => (
        <div key={it.label} className={clsx('min-w-0', it.wide && 'sm:col-span-full')}>
          <dt className="text-xs text-ink-500">{it.label}</dt>
          <dd className="mt-0.5 break-words text-sm text-ink-900">{it.value ?? <span className="text-ink-400">—</span>}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * RelatedPanel — records connected to this one.
 * groups: [{ label, items: [{ label, sublabel, to, status }] }]
 */
export function RelatedPanel({ groups = [], title = 'Related', className }) {
  const present = groups.filter((g) => g.items?.length)
  return (
    <section className={clsx('rounded-lg border border-ink-200 bg-surface', className)} aria-label={title}>
      <h2 className="label-mono border-b border-ink-200 px-4 py-2.5">{title}</h2>
      {!present.length ? (
        <p className="px-4 py-3 text-sm text-ink-500">No linked records.</p>
      ) : (
        <div className="divide-y divide-ink-100">
          {present.map((g) => (
            <div key={g.label} className="px-4 py-2.5">
              <p className="mb-1 text-xs text-ink-500">{g.label}</p>
              <ul className="space-y-1">
                {g.items.map((it) => (
                  <li key={`${g.label}-${it.label}`} className="flex items-center justify-between gap-2 text-sm">
                    {it.to ? <Link to={it.to} className="truncate font-mono text-[0.92em] text-brand-600 hover:underline">{it.label}</Link> : <span className="truncate font-mono text-[0.92em]">{it.label}</span>}
                    {it.status}
                    {it.sublabel && <span className="shrink-0 text-xs text-ink-500">{it.sublabel}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * DetailLayout — the one pattern for a record (PO, SO, item, employee):
 *   header
 *   summary strip (five facts)
 *   [tabs | aside: timeline + related + Simeli]
 */
export function DetailLayout({ header, summary, notice, children, aside, className }) {
  return (
    <div className={clsx('space-y-5', className)}>
      {header}
      {notice}
      {summary}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">{children}</div>
        {aside && <aside className="min-w-0 space-y-4">{aside}</aside>}
      </div>
    </div>
  )
}

export default EmptyState
