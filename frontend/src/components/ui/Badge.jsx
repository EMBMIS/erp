
import clsx from 'clsx'

/**
 * Badges.
 *
 * StatusBadge is the ONE status vocabulary. Every module maps its own status
 * strings onto these canonical states, and each state has a tone AND a glyph,
 * so status is never carried by colour alone (WCAG 1.4.1):
 *
 *   draft             ○  ink    nothing has happened yet
 *   pending           ◔  warn   waiting on a person
 *   approved          ✓  ok     decided, can proceed
 *   rejected          ✕  risk   decided against; final
 *   posted            ■  ok     written to the ledger; immutable
 *   closed            ■  ink    finished; read-only
 *   overdue           ▲  risk   late
 *   cancelled         ⊘  ink    stopped before completion
 *   active            ●  ok     live
 *   in progress       ◑  brand  the system or a person is working on it
 *   attention         ▲  warn   needs a look soon
 */
const CANONICAL = {
  draft: { tone: 'ink', glyph: 'ring', label: 'Draft' },
  pending: { tone: 'warn', glyph: 'clock', label: 'Pending approval' },
  approved: { tone: 'ok', glyph: 'check', label: 'Approved' },
  rejected: { tone: 'risk', glyph: 'cross', label: 'Rejected' },
  posted: { tone: 'ok', glyph: 'square', label: 'Posted' },
  closed: { tone: 'ink', glyph: 'square', label: 'Closed' },
  overdue: { tone: 'risk', glyph: 'triangle', label: 'Overdue' },
  cancelled: { tone: 'ink', glyph: 'slash', label: 'Cancelled' },
  active: { tone: 'ok', glyph: 'dot', label: 'Active' },
  inactive: { tone: 'ink', glyph: 'ring', label: 'Inactive' },
  progress: { tone: 'brand', glyph: 'half', label: 'In progress' },
  attention: { tone: 'warn', glyph: 'triangle', label: 'Attention' },
  done: { tone: 'ok', glyph: 'check', label: 'Done' },
  failed: { tone: 'risk', glyph: 'cross', label: 'Failed' },
}

/** Module status strings → canonical state. Unknown strings fall back to ink. */
const ALIASES = {
  DRAFT: 'draft', NEW: 'draft', OPEN: 'draft', CREATED: 'draft', PLANNED: 'draft', NOT_STARTED: 'draft', TODO: 'draft',
  PENDING: 'pending', PENDING_APPROVAL: 'pending', SUBMITTED: 'pending', PENDING_REVIEW: 'pending', REVIEW: 'pending',
  AWAITING_APPROVAL: 'pending', IN_REVIEW: 'pending', PENDING_SUPPLIER_CONFIRMATION: 'pending', WAITING: 'pending',
  WAITING_CUSTOMER_DELIVERY_CONFIRMATION: 'pending', PENDING_CERTIFICATION: 'pending', QUOTED: 'pending',
  APPROVED: 'approved', CONFIRMED: 'approved', ACCEPTED: 'approved', CERTIFIED: 'approved', AWARDED: 'approved',
  CUSTOMER_CONFIRMED: 'approved', READY: 'approved', RELEASED: 'approved', VERIFIED: 'approved',
  REJECTED: 'rejected', DECLINED: 'rejected', DISPUTED: 'rejected',
  POSTED: 'posted', PAID: 'posted', RECONCILED: 'posted', CLEARED: 'posted', INVOICED: 'posted',
  CLOSED: 'closed', ARCHIVED: 'closed', LOCKED: 'closed', EXPIRED: 'closed', SUPERSEDED: 'closed',
  OVERDUE: 'overdue', LATE: 'overdue', PAST_DUE: 'overdue', DELIVERY_ISSUE_REPORTED: 'overdue', BLOCKED: 'overdue',
  CANCELLED: 'cancelled', CANCELED: 'cancelled', VOID: 'cancelled', VOIDED: 'cancelled', WITHDRAWN: 'cancelled',
  ACTIVE: 'active', ENABLED: 'active', LIVE: 'active', DEPLOYED: 'active', NORMAL: 'active',
  INACTIVE: 'inactive', DISABLED: 'inactive', SUSPENDED: 'inactive', ON_HOLD: 'inactive', PAUSED: 'inactive',
  IN_PROGRESS: 'progress', PROCESSING: 'progress', SENT: 'progress', SENT_TO_SUPPLIER: 'progress', IN_TRANSIT: 'progress',
  SHIPPED: 'progress', IN_PRODUCTION: 'progress', SCHEDULED: 'progress', PARTIALLY_RECEIVED: 'progress',
  PARTIALLY_PAID: 'progress', PARTIALLY_DELIVERED: 'progress', PREPARING_DELIVERY: 'progress', READY_TO_SHIP: 'progress',
  GOODS_ISSUED: 'progress', RUNNING: 'progress', ORDERED: 'progress', ISSUED: 'progress',
  COMPLETED: 'done', DELIVERED: 'done', FULLY_RECEIVED: 'done', RECEIVED: 'done', FULFILLED: 'done', SUCCEEDED: 'done', DONE: 'done',
  FAILED: 'failed', ERROR: 'failed', BOUNCED: 'failed',
  HIGH_LOAD: 'attention', OVERDUE_APPROACHING: 'attention', LOW_STOCK: 'attention', AT_RISK: 'attention', WARNING: 'attention',
  OVERLOADED: 'overdue', OUT_OF_STOCK: 'overdue', LIGHT: 'inactive',
}

const LEGACY_INTENT = { success: 'approved', warning: 'pending', danger: 'rejected', info: 'progress', neutral: 'draft' }

export function canonicalStatus(status) {
  const key = String(status || '').trim().toUpperCase().replace(/[\s-]+/g, '_')
  return ALIASES[key] || null
}

const TONE = {
  ink: 'bg-ink-100 text-ink-700',
  brand: 'bg-brand-50 text-brand-700',
  ok: 'bg-ok-50 text-ok-700',
  warn: 'bg-warn-50 text-warn-700',
  risk: 'bg-risk-50 text-risk-700',
}

function Glyph({ kind }) {
  const common = { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true, className: 'shrink-0' }
  switch (kind) {
    case 'ring': return <svg {...common}><circle cx="5" cy="5" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
    case 'dot': return <svg {...common}><circle cx="5" cy="5" r="3.5" fill="currentColor" /></svg>
    case 'clock': return <svg {...common}><circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M5 2.6V5l1.6 1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
    case 'half': return <svg {...common}><circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M5 1.4a3.6 3.6 0 0 1 0 7.2z" fill="currentColor" /></svg>
    case 'check': return <svg {...common}><path d="M1.8 5.3l2.1 2.1 4.3-4.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
    case 'cross': return <svg {...common}><path d="M2.4 2.4l5.2 5.2M7.6 2.4L2.4 7.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
    case 'square': return <svg {...common}><rect x="1.8" y="1.8" width="6.4" height="6.4" rx="1" fill="currentColor" /></svg>
    case 'triangle': return <svg {...common}><path d="M5 1.2l4 7.3H1z" fill="currentColor" /></svg>
    case 'slash': return <svg {...common}><circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M2.5 7.5l5-5" stroke="currentColor" strokeWidth="1.3" /></svg>
    default: return null
  }
}

/** Badge — a small tonal label. Use StatusBadge for record status. */
export function Badge({ tone = 'ink', children, className, mono = false, glyph }) {
  return (
    <span
      className={clsx(
        'inline-flex h-5 max-w-full items-center gap-1 whitespace-nowrap rounded px-1.5 text-xs font-medium leading-none',
        mono && 'font-mono text-2xs uppercase tracking-wide',
        TONE[tone] || TONE.ink,
        className
      )}
    >
      {glyph && <Glyph kind={glyph} />}
      <span className="truncate">{children}</span>
    </span>
  )
}

const humanize = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase())

/**
 * StatusBadge — record status, identical in every module.
 * Keeps the module's own words as the label (a PO is "Sent to supplier", not
 * "In progress") but takes tone and glyph from the canonical state.
 */
export function StatusBadge({ status, intent, label, className }) {
  const canon = canonicalStatus(status) || (intent && LEGACY_INTENT[intent]) || 'draft'
  const def = CANONICAL[canon]
  return (
    <Badge tone={def.tone} glyph={def.glyph} className={className}>
      {label ?? (status ? humanize(status) : def.label)}
    </Badge>
  )
}

/**
 * MaturityBadge — honesty about readiness. A feature that is not
 * production-ready says so where people use it, and in the nav.
 */
export function MaturityBadge({ level = 'beta', className, title }) {
  const text = { beta: 'Beta', preview: 'Preview', demo: 'Demo data', unavailable: 'Unavailable' }[level] || level
  const tone = level === 'unavailable' ? 'risk' : level === 'demo' ? 'warn' : 'ink'
  return (
    <Badge tone={tone} mono className={clsx('h-4 px-1 text-[10px]', className)}>
      <span title={title}>{text}</span>
    </Badge>
  )
}

export default StatusBadge
