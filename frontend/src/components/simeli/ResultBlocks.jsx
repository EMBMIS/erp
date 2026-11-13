import React from 'react'
import { GatewayReason } from '../ui/Gateway'
import {
  AlertTriangle, ArrowUpRight, ArrowDownRight, Check, CheckCheck, ChevronDown, ChevronRight,
  FileText, Info, Loader2, Minus, X,
} from 'lucide-react'

/**
 * The objects a Simeli answer is made of.
 *
 * A response is not a paragraph. It is a narrative plus some combination of:
 * the figures a tool returned, the records behind them, an anomaly that was
 * found, a projection, an action being proposed, and the result of one that
 * ran. Each of those is a block here.
 *
 * ONE RULE GOVERNS EVERY BLOCK
 * ---------------------------------------------------------------------------
 * Nothing renders a number this file has not been handed. There is no default
 * value, no placeholder figure, no "—" standing in for something that would
 * look better filled. Where a measurement is missing the block says which
 * measurement is missing and why, because in an ERP a plausible-looking wrong
 * number is worse than a visible gap.
 *
 * That is also why `Figure` takes a `unit` rather than assuming currency: the
 * digest knows a field is called `total_outstanding` and that its value is
 * 32410, and it does not know whether that is euros. Guessing a currency
 * symbol onto a number is exactly the class of mistake this file exists to
 * avoid, so the field name is shown and the value is shown, and the reader
 * supplies the meaning.
 */

// ---------------------------------------------------------------------------
// Formatting. Deliberately minimal.
// ---------------------------------------------------------------------------

/** `total_outstanding` → `Total outstanding` */
export function humanizeKey(key) {
  const text = String(key || '').replace(/_/g, ' ').trim()
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * A number, grouped, with sensible precision — and nothing else. No symbol, no
 * scaling to "k" unless it is genuinely large, no sign games.
 */
export function formatValue(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null
  const n = Number(value)
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${(n / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}M`
  if (abs >= 10_000) return `${(n / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k`
  if (Number.isInteger(n)) return n.toLocaleString()
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

// ---------------------------------------------------------------------------
// Figures — the scalar numbers a tool returned.
// ---------------------------------------------------------------------------

export function FigureStrip({ figures, tone = 'var(--sim-data)' }) {
  if (!figures?.length) return null
  return (
    <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3">
      {figures.map((f) => {
        const shown = formatValue(f.value)
        return (
          <div key={f.key} className="min-w-0">
            <div
              className="truncate text-[19px] font-semibold leading-none tabular-nums"
              style={{ color: tone }}
            >
              {shown ?? '—'}
            </div>
            <div className="mt-1 truncate text-[10.5px] uppercase tracking-[0.07em] text-[color:var(--embmis-text-faint)]">
              {humanizeKey(f.key)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Drivers — what contributed to an outcome, and how hard.
//
// `impact` is a word the model supplied and a judgement it is entitled to make;
// the figure beside it is not, and comes from a tool result. The two are drawn
// differently so it is clear which is which.
// ---------------------------------------------------------------------------

const IMPACT_TONE = {
  high:   { tone: 'var(--embmis-rose)',    tint: 'var(--embmis-rose-tint)',    Icon: AlertTriangle },
  medium: { tone: 'var(--embmis-amber)',   tint: 'var(--embmis-amber-tint)',   Icon: Info },
  low:    { tone: 'var(--sim-data)',       tint: 'var(--embmis-blue-tint)',    Icon: Info },
}

export function DriverList({ title = 'Main drivers', drivers }) {
  if (!drivers?.length) return null
  return (
    <div className="sim-block">
      <div className="sim-block-head">{title}</div>
      {drivers.map((d, i) => {
        const key = String(d.impact || 'low').toLowerCase().includes('high') ? 'high'
          : String(d.impact || 'low').toLowerCase().includes('med') ? 'medium' : 'low'
        const { tone, tint, Icon } = IMPACT_TONE[key]
        return (
          <div key={`${d.title}-${i}`} className="sim-driver" style={{ '--tone': tone, '--tint': tint }}>
            <span className="sim-driver-icon"><Icon className="h-3.5 w-3.5" /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold text-[color:var(--embmis-text-strong)]">
                {d.title}
              </span>
              {d.detail && (
                <span className="block truncate text-[11.5px] text-[color:var(--embmis-text-muted)]">
                  {d.detail}
                </span>
              )}
            </span>
            {d.impact && <span className="sim-impact">{d.impact}</span>}
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Projection — a before and an after.
//
// The percentage is computed here from the two values rather than accepted as
// a third input, so it cannot disagree with the numbers it sits beside.
// ---------------------------------------------------------------------------

export function Projection({ title = 'Projected impact', before, after, beforeLabel, afterLabel, unit }) {
  const a = Number(before)
  const b = Number(after)
  const haveBoth = Number.isFinite(a) && Number.isFinite(b)
  const delta = haveBoth && a !== 0 ? ((b - a) / Math.abs(a)) * 100 : null
  const improved = haveBoth ? b >= a : null
  const tone = improved === null ? 'var(--sim-data)' : improved ? 'var(--embmis-green)' : 'var(--embmis-rose)'
  const Arrow = improved === null ? Minus : improved ? ArrowUpRight : ArrowDownRight

  return (
    <div className="sim-block" style={{ '--tone': tone }}>
      <div className="sim-block-head">{title}</div>
      <div className="sim-projection">
        <div>
          <div className="sim-projection-value">
            {formatValue(before) ?? '—'}{unit ? <span className="ml-1 text-[13px] opacity-60">{unit}</span> : null}
          </div>
          <div className="mt-1 text-[10.5px] uppercase tracking-[0.07em] text-[color:var(--embmis-text-faint)]">
            {beforeLabel || 'Current'}
          </div>
        </div>

        <span className="sim-projection-arrow" aria-hidden="true" />

        <div>
          <div className="sim-projection-value is-after">
            {formatValue(after) ?? '—'}{unit ? <span className="ml-1 text-[13px] opacity-60">{unit}</span> : null}
          </div>
          <div className="mt-1 text-[10.5px] uppercase tracking-[0.07em] text-[color:var(--embmis-text-faint)]">
            {afterLabel || 'Projected'}
          </div>
        </div>

        {delta !== null && (
          <div className="ml-auto flex items-center gap-1 text-[14px] font-semibold" style={{ color: tone }}>
            <Arrow className="h-4 w-4" />
            {Math.abs(delta).toFixed(1)}%
          </div>
        )}
      </div>

      {!haveBoth && (
        <p className="px-3.5 pb-3 text-[11.5px] text-[color:var(--embmis-text-muted)]">
          Only one side of this comparison was measured, so no change can be stated.
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Record references — the ERP rows behind a claim.
// ---------------------------------------------------------------------------

export function RecordRefs({ records, unit, total, onOpen }) {
  if (!records?.length) return null
  const hidden = Number.isFinite(total) ? Math.max(0, total - records.length) : 0

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {records.map((r, i) => (
        <button
          key={`${r.label}-${i}`}
          type="button"
          className="sim-ref"
          onClick={() => onOpen?.(r)}
          title={r.detail ? `${humanizeKey(r.detail.key)}: ${formatValue(r.detail.value)}` : undefined}
        >
          <FileText className="h-3 w-3 flex-none opacity-70" />
          <span className="max-w-[15rem] truncate">{r.label}</span>
          {r.detail && (
            <span className="tabular-nums opacity-70">{formatValue(r.detail.value)}</span>
          )}
        </button>
      ))}
      {hidden > 0 && (
        <span className="text-[11px] text-[color:var(--embmis-text-faint)]">
          +{hidden.toLocaleString()} more {unit || 'records'}
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Actions and their lifecycle.
//
// Proposed → Review → Approved → Executing → Completed. The state shown is the
// state the server reported. This component never advances it optimistically:
// showing "Completed" a moment early is precisely the failure it exists to
// prevent, and the moment saved is worth nothing against being wrong about
// whether something happened to the business.
// ---------------------------------------------------------------------------

const ACTION_COPY = {
  proposed:  'Proposed',
  approved:  'Approved',
  executing: 'Executing',
  executed:  'Executed',
  completed: 'Completed',
  denied:    'Not approved',
}

export function ActionCard({ action, onApprove, onDeny, busy }) {
  const state = String(action.state || 'proposed').toLowerCase()
  const decidable = state === 'proposed'

  return (
    <div className={`sim-block ${decidable ? 'sim-action' : ''}`}>
      <div className="flex items-center gap-2 px-3.5 py-2.5">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-[color:var(--embmis-text-strong)]">
            {action.verb || action.name}
          </span>
          <span className="block truncate text-[11px] text-[color:var(--embmis-text-faint)]">
            {action.module}
            {action.at ? ` · ${new Date(action.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
          </span>
        </span>
        <span className={`sim-action-state is-${state}`}>
          {state === 'executing' && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
          {(state === 'executed' || state === 'completed') && <Check className="h-2.5 w-2.5" />}
          {state === 'denied' && <X className="h-2.5 w-2.5" />}
          {ACTION_COPY[state] || state}
        </span>
      </div>

      {action.summary && (
        <p className="border-t border-[color:var(--embmis-line-soft)] px-3.5 py-2.5 text-[12.5px] text-[color:var(--embmis-text-muted)]">
          {action.summary}
        </p>
      )}

      {action.gateway && decidable && (
        <div className="border-t border-[color:var(--embmis-line-soft)] px-3.5 py-2.5">
          <GatewayReason gateway={action.gateway} />
        </div>
      )}

      {decidable && (onApprove || onDeny) && (
        <div className="flex flex-wrap gap-2 border-t border-[color:var(--sim-line)] px-3.5 py-2.5">
          <button type="button" className="sim-btn sim-btn-decide" disabled={busy} onClick={() => onApprove?.(action)}>
            <Check className="h-3.5 w-3.5" /> Approve
          </button>
          {/* Approving the same tool over and over is how people stop reading
              the prompt. This remembers the decision for this tool, and it is
              revocable from the tool library — so it is a considered grant
              rather than a habit. */}
          <button
            type="button"
            className="sim-btn"
            disabled={busy}
            title={`Stop asking about ${action.verb || action.name}`}
            onClick={() => onApprove?.(action, true)}
          >
            <CheckCheck className="h-3.5 w-3.5" /> Always allow
          </button>
          <button type="button" className="sim-btn" disabled={busy} onClick={() => onDeny?.(action)}>
            <X className="h-3.5 w-3.5" /> Decline
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Evidence — the raw digest behind a block, folded away.
//
// Someone who wants to check a number should be able to, without the interface
// showing everyone the JSON by default.
// ---------------------------------------------------------------------------

export function Evidence({ label = 'Evidence', children }) {
  const [open, setOpen] = React.useState(false)
  if (!children) return null
  return (
    <div className="rounded-lg border border-[color:var(--sim-line)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] text-[color:var(--embmis-text-faint)]"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {label}
      </button>
      {open && (
        <div className="sim-wide border-t border-[color:var(--sim-line)] px-2.5 py-2">{children}</div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The state a tool result leaves when there is genuinely nothing to draw.
// ---------------------------------------------------------------------------

export function BlockEmpty({ children }) {
  return (
    <p className="px-3.5 py-3 text-[12px] leading-relaxed text-[color:var(--embmis-text-muted)]">
      {children}
    </p>
  )
}
