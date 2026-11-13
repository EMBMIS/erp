
import { Toaster, toast as hot } from 'react-hot-toast'

/**
 * Toasts are for outcomes that left the screen — "PO-2026-1008 sent to Nordic
 * Steel" after the dialog closed. When the result is visible where the person
 * is looking, confirm inline instead (InlineNotice, a row flash).
 *
 * notify.undo() gives an optimistic action a way back: the action has already
 * been applied on screen; `onUndo` reverts it before the server call commits.
 */
export function ToastHost() {
  return (
    <Toaster
      position="bottom-right"
      gutter={8}
      containerStyle={{ bottom: 'calc(16px + env(safe-area-inset-bottom))' }}
      toastOptions={{
        duration: 4500,
        className: '!rounded-lg !border !border-ink-200 !bg-overlay !text-sm !text-fg !shadow-overlay !max-w-[420px] !px-3 !py-2',
        success: { iconTheme: { primary: 'rgb(var(--c-ok-500))', secondary: '#fff' } },
        error: { duration: 7000, iconTheme: { primary: 'rgb(var(--c-risk-500))', secondary: '#fff' } },
        ariaProps: { role: 'status', 'aria-live': 'polite' },
      }}
    />
  )
}

export const notify = {
  success: (msg, opts) => hot.success(msg, opts),
  error: (msg, opts) => hot.error(msg, { ariaProps: { role: 'alert', 'aria-live': 'assertive' }, ...opts }),
  info: (msg, opts) => hot(msg, opts),
  /** Apply-now-commit-later with an Undo affordance. */
  undo: (msg, { onUndo, duration = 6000 } = {}) =>
    hot(
      (t) => (
        <span className="flex items-center gap-3">
          <span>{msg}</span>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-sm font-medium text-brand-600 hover:bg-brand-50"
            onClick={() => { hot.dismiss(t.id); onUndo?.() }}
          >
            Undo
          </button>
        </span>
      ),
      { duration }
    ),
}

export default ToastHost
