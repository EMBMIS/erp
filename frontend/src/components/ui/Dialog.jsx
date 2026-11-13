import { useEffect, useRef, useState, useId, useCallback } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { Button } from './Button'
import { Field, Textarea, Input } from './Field'

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'

/**
 * useFocusTrap — keeps Tab inside `ref` while active, moves focus in on open
 * and restores it to whatever had it before on close.
 */
export function useFocusTrap(ref, active, { initialFocus } = {}) {
  useEffect(() => {
    if (!active) return undefined
    const restore = document.activeElement
    const node = ref.current
    const first = initialFocus?.current || node?.querySelector('[data-autofocus]') || node?.querySelector(FOCUSABLE) || node
    // Next frame, after the panel has painted.
    const raf = requestAnimationFrame(() => first?.focus?.({ preventScroll: true }))
    const onKey = (e) => {
      if (e.key !== 'Tab' || !node) return
      const items = [...node.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement)
      if (!items.length) { e.preventDefault(); return }
      const f = items[0]
      const l = items[items.length - 1]
      if (e.shiftKey && document.activeElement === f) { e.preventDefault(); l.focus() }
      else if (!e.shiftKey && document.activeElement === l) { e.preventDefault(); f.focus() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKey, true)
      if (restore && typeof restore.focus === 'function' && document.contains(restore)) restore.focus({ preventScroll: true })
    }
  }, [active, ref, initialFocus])
}

function useLockScroll(active) {
  useEffect(() => {
    if (!active) return undefined
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [active])
}

function useEscape(active, onClose) {
  useEffect(() => {
    if (!active) return undefined
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.() } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [active, onClose])
}

function useIsCompact() {
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)')
    const on = (e) => setCompact(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return compact
}

/**
 * Dialog — modal, focus-trapped, restores focus on close, closes on Escape
 * and on the scrim. On a phone it becomes a bottom sheet: same content, a
 * composition that fits a thumb rather than a squeezed desktop box.
 */
export function Dialog({ open, onClose, title, description, children, footer, size = 'md', initialFocus, dismissible = true, className }) {
  const panelRef = useRef(null)
  const titleId = useId()
  const descId = useId()
  const compact = useIsCompact()
  const close = useCallback(() => { if (dismissible) onClose?.() }, [dismissible, onClose])
  useFocusTrap(panelRef, open, { initialFocus })
  useLockScroll(open)
  useEscape(open, close)
  if (!open) return null

  const widths = { sm: 'sm:max-w-sm', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl', xl: 'sm:max-w-4xl' }
  return createPortal(
    <div className="fixed inset-0 z-dialog flex items-end justify-center sm:items-center sm:p-6">
      <div className="absolute inset-0 animate-[ui-fade-in_var(--dur)_var(--ease)]" style={{ background: 'var(--scrim)' }} onClick={close} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={clsx(
          'relative flex max-h-[92vh] w-full flex-col bg-overlay shadow-overlay focus:outline-none',
          compact ? 'rounded-t-xl animate-[ui-sheet-up_var(--dur-slow)_var(--ease)] pb-[env(safe-area-inset-bottom)]' : 'rounded-xl animate-[ui-scale-in_var(--dur)_var(--ease)]',
          widths[size] || widths.md,
          className
        )}
      >
        {compact && <div className="mx-auto mt-2 h-1 w-9 rounded-full bg-ink-300" aria-hidden="true" />}
        {(title || dismissible) && (
          <header className="flex items-start justify-between gap-4 px-5 pb-2 pt-4">
            <div className="min-w-0">
              {title && <h2 id={titleId} className="text-base font-semibold text-fg">{title}</h2>}
              {description && <p id={descId} className="mt-1 text-sm text-ink-600">{description}</p>}
            </div>
            {dismissible && (
              <button type="button" onClick={close} aria-label="Close" className="-mr-1.5 -mt-0.5 rounded-md p-1.5 text-ink-500 hover:bg-ink-100 hover:text-ink-900">
                <XMarkIcon className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </header>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3 ui-scroll">{children}</div>
        {footer && (
          <footer className="flex flex-col-reverse gap-2 border-t border-ink-200 px-5 py-3 sm:flex-row sm:justify-end">{footer}</footer>
        )}
      </div>
    </div>,
    document.body
  )
}

/** Sheet — a panel from the right (desktop) or bottom (phone). Non-blocking detail, filters, Simeli. */
export function Sheet({ open, onClose, title, description, children, footer, width = 'md', side = 'right' }) {
  const panelRef = useRef(null)
  const titleId = useId()
  const compact = useIsCompact()
  useFocusTrap(panelRef, open)
  useLockScroll(open && compact)
  useEscape(open, onClose)
  if (!open) return null
  const widths = { sm: 'sm:w-[360px]', md: 'sm:w-[440px]', lg: 'sm:w-[560px]', xl: 'sm:w-[720px]' }
  const bottom = compact || side === 'bottom'
  return createPortal(
    <div className="fixed inset-0 z-sheet">
      <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={onClose} aria-hidden="true" />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={clsx(
          'absolute flex flex-col bg-overlay shadow-overlay focus:outline-none',
          bottom
            ? 'inset-x-0 bottom-0 max-h-[88vh] rounded-t-xl animate-[ui-sheet-up_var(--dur-slow)_var(--ease)] pb-[env(safe-area-inset-bottom)]'
            : clsx('inset-y-0 right-0 w-full border-l border-ink-200 animate-[ui-sheet-left_var(--dur-slow)_var(--ease)]', widths[width] || widths.md)
        )}
      >
        {bottom && <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-ink-300" aria-hidden="true" />}
        <header className="flex items-start justify-between gap-3 border-b border-ink-200 px-4 py-3">
          <div className="min-w-0">
            {title && <h2 id={titleId} className="truncate text-sm font-semibold text-fg">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-ink-500">{description}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1.5 text-ink-500 hover:bg-ink-100 hover:text-ink-900">
            <XMarkIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto ui-scroll">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-ink-200 px-4 py-3">{footer}</footer>}
      </aside>
    </div>,
    document.body
  )
}

/**
 * ConfirmDialog — every destructive or irreversible action goes through this.
 *
 * It names the consequence in words (`consequence`), says whether it can be
 * undone (`reversible`), and can require a reason (`requireReason`) or a typed
 * confirmation (`confirmText`, e.g. the record number). The confirm button
 * repeats the verb ("Reject PO-2026-1007"), never "OK".
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  consequence,
  reversible = false,
  confirmLabel = 'Confirm',
  tone = 'danger',
  requireReason = false,
  reasonLabel = 'Reason',
  reasonHelp,
  confirmText,
  busy = false,
  children,
}) {
  const [reason, setReason] = useState('')
  const [typed, setTyped] = useState('')
  const [touched, setTouched] = useState(false)
  useEffect(() => { if (open) { setReason(''); setTyped(''); setTouched(false) } }, [open])
  const reasonMissing = requireReason && reason.trim().length < 3
  const typedMissing = confirmText && typed.trim() !== confirmText
  const submit = (e) => {
    e?.preventDefault()
    setTouched(true)
    if (reasonMissing || typedMissing || busy) return
    onConfirm?.(reason.trim())
  }
  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Keep it</Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={submit} loading={busy}>{confirmLabel}</Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-3">
        {consequence && <p className="text-sm text-ink-800">{consequence}</p>}
        <p className={clsx('flex items-center gap-1.5 text-xs font-medium', reversible ? 'text-ink-600' : 'text-risk-600')}>
          <span aria-hidden="true">{reversible ? '↺' : '■'}</span>
          {reversible ? 'This can be undone afterwards.' : 'This cannot be undone.'}
        </p>
        {children}
        {requireReason && (
          <Field label={reasonLabel} required help={reasonHelp || 'The requester sees this. Say what would make it acceptable.'} error={touched && reasonMissing ? 'Write a reason of at least a few words.' : null}>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} data-autofocus />
          </Field>
        )}
        {confirmText && (
          <Field label={<>Type <span className="font-mono">{confirmText}</span> to confirm</>} error={touched && typedMissing ? `Type ${confirmText} exactly.` : null}>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" data-autofocus={!requireReason || undefined} />
          </Field>
        )}
      </form>
    </Dialog>
  )
}

/** Legacy API: Modal({ open, onClose, title, description, children, footer, size }). */
export function Modal(props) {
  return <Dialog {...props} />
}

export default Dialog
