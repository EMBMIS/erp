import { useState } from 'react'
import clsx from 'clsx'
import { Link } from 'react-router-dom'
import { SparklesIcon, DocumentMagnifyingGlassIcon, LightBulbIcon, HandRaisedIcon, LockClosedIcon } from '@heroicons/react/20/solid'
import { Button } from './Button'
import { GatewayLine } from './Gateway'

/**
 * Simeli surfaces share one anatomy, so an answer always shows its working:
 *
 *   READ        what it looked at (records, reports), each linkable
 *   CONCLUDED   what it found, in plain sentences
 *   PROPOSES    prepared actions. A person approves each one; nothing runs on
 *               its own. Approving hands the action to the normal screen or
 *               endpoint, with the normal permission checks.
 *
 * And one footer line: Simeli read only what you are allowed to see.
 *
 * Brand colour here means "the system is acting" — which is the one thing it
 * is allowed to mean.
 */
export function SimeliMark({ className }) {
  return (
    <span className={clsx('inline-flex h-5 w-5 items-center justify-center rounded bg-brand-600 text-white', className)} aria-hidden="true">
      <SparklesIcon className="h-3 w-3" />
    </span>
  )
}

function Section({ icon: Icon, label, children }) {
  return (
    <div className="space-y-1.5">
      <p className="label-mono flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />
        {label}
      </p>
      {children}
    </div>
  )
}

/**
 * AiAnswer
 * read:      [{ label, to, detail }]
 * concluded: [string | node]
 * proposes:  [{ id, title, detail, note, actionLabel, onApprove, onDecline, approvedText, to, risk: 'low'|'high' }]
 * gateway:   { allowed, blocked, escalated, unchecked } — what EMBMIS Gateway did with this turn's tool calls
 */
export function AiAnswer({ title, read = [], concluded = [], proposes = [], loading, error, onRetry, className, footnote, compact = false, gateway }) {
  const [decided, setDecided] = useState({})
  return (
    <section className={clsx('rounded-lg border border-brand-200 bg-surface', className)} aria-label={title || 'Simeli'} aria-busy={loading || undefined}>
      <header className="flex items-center gap-2 border-b border-ink-200 px-4 py-2.5">
        <SimeliMark />
        <h2 className="flex-1 truncate text-sm font-semibold text-fg">{title || 'Simeli'}</h2>
      </header>
      <div className={clsx('space-y-4', compact ? 'p-3' : 'p-4')}>
        {loading && (
          <div role="status" className="space-y-2">
            <span className="sr-only">Simeli is reading</span>
            <span className="skeleton block h-3 w-3/4" />
            <span className="skeleton block h-3 w-1/2" />
          </div>
        )}
        {error && (
          <div role="alert" className="text-sm text-risk-700">
            {error}
            {onRetry && <button type="button" onClick={onRetry} className="ml-2 font-medium underline">Try again</button>}
          </div>
        )}
        {!loading && !error && (
          <>
            {read.length > 0 && (
              <Section icon={DocumentMagnifyingGlassIcon} label="Read">
                <ul className="flex flex-wrap gap-1.5">
                  {read.map((r) => (
                    <li key={r.label}>
                      {r.to ? (
                        <Link to={r.to} className="inline-flex items-center rounded border border-ink-200 bg-sunken px-1.5 py-0.5 font-mono text-2xs text-ink-700 hover:border-ink-300 hover:text-fg" title={r.detail}>{r.label}</Link>
                      ) : (
                        <span className="inline-flex items-center rounded border border-ink-200 bg-sunken px-1.5 py-0.5 font-mono text-2xs text-ink-700" title={r.detail}>{r.label}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {concluded.length > 0 && (
              <Section icon={LightBulbIcon} label="Concluded">
                <ul className="space-y-1.5 text-sm text-ink-800">
                  {concluded.map((c, i) => <li key={i} className="flex gap-2"><span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 rounded-full bg-ink-400" />{c}</li>)}
                </ul>
              </Section>
            )}
            {proposes.length > 0 && (
              <Section icon={HandRaisedIcon} label="Proposes — needs your approval">
                <ul className="space-y-2">
                  {proposes.map((p) => (
                    <li key={p.id || p.title} className="rounded-md border border-ink-200 p-2.5">
                      <p className="text-sm font-medium text-fg">{p.title}</p>
                      {p.detail && <p className="mt-0.5 text-xs text-ink-600">{p.detail}</p>}
                      {p.note}
                      <div className="mt-2 flex items-center gap-2">
                        {decided[p.id || p.title] ? (
                          <span className="text-xs text-ink-500">{decided[p.id || p.title]}</span>
                        ) : (
                          <>
                            <Button size="sm" variant="primary" to={p.to} onClick={p.onApprove ? async () => { await p.onApprove(); setDecided((d) => ({ ...d, [p.id || p.title]: p.approvedText || 'Prepared — review and confirm on the record.' })) } : undefined}>
                              {p.actionLabel || 'Review and approve'}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={async () => { if (p.onDecline) await p.onDecline(); setDecided((d) => ({ ...d, [p.id || p.title]: p.onDecline ? 'Declined. Nothing was changed.' : 'Dismissed.' })) }}>{p.onDecline ? 'Decline' : 'Dismiss'}</Button>
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {!concluded.length && !proposes.length && (
              <p className="text-sm text-ink-600">Nothing stands out in these checks.</p>
            )}
          </>
        )}
      </div>
      {!loading && !error && gateway && <GatewayLine stats={gateway} className="border-t border-ink-200 px-4 py-2" />}
      <footer className="flex items-center gap-1.5 border-t border-ink-200 px-4 py-2 text-2xs text-ink-500">
        <LockClosedIcon className="h-3 w-3" aria-hidden="true" />
        {footnote || 'Simeli read only records your role can see. It does not act without your approval.'}
      </footer>
    </section>
  )
}

/**
 * Provenance — click a figure to see where it came from.
 * sources: [{ label, value, to }], method: plain sentence describing the calculation.
 */
export function Provenance({ children, method, sources = [], asOf, className }) {
  const [open, setOpen] = useState(false)
  return (
    <span className={clsx('relative inline-block', className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="rounded decoration-ink-300 decoration-dotted underline-offset-4 hover:underline focus-visible:underline"
        title="Where does this number come from?"
      >
        {children}
      </button>
      {open && (
        <span role="dialog" aria-label="How this figure is calculated" className="absolute left-0 top-full z-40 mt-1 block w-72 rounded-lg border border-ink-200 bg-overlay p-3 text-left text-xs font-normal text-ink-800 shadow-overlay animate-pop">
          <span className="label-mono mb-1 block">How this is calculated</span>
          {method && <span className="block text-sm text-ink-800">{method}</span>}
          {sources.length > 0 && (
            <span className="mt-2 block space-y-1">
              {sources.map((s) => (
                <span key={s.label} className="flex items-center justify-between gap-3">
                  {s.to ? <Link to={s.to} className="truncate text-brand-600 hover:underline">{s.label}</Link> : <span className="truncate">{s.label}</span>}
                  {s.value != null && <span className="shrink-0 tabular-nums">{s.value}</span>}
                </span>
              ))}
            </span>
          )}
          {asOf && <span className="mt-2 block text-2xs text-ink-500">As of {new Date(asOf).toLocaleString()}</span>}
          <button type="button" onClick={() => setOpen(false)} className="mt-2 text-2xs font-medium text-ink-600 hover:text-fg">Close</button>
        </span>
      )}
    </span>
  )
}

export default AiAnswer
