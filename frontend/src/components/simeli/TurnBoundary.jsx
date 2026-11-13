import React from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { ErrorBoundaryClass } from '../ErrorBoundary'

/**
 * A blast wall around one answer.
 *
 * An assistant turn is the most structurally adventurous thing this app
 * renders: charts the model authored, HTML artifacts, action cards, tool
 * digests, a partially-streamed body that changes shape on every frame. Any of
 * those can throw. Without a boundary here that throw unmounts the whole
 * transcript — the work is still on the server, still in the database, and the
 * person is looking at a blank page with no way to read it.
 *
 * So: contain the failure to the one turn that caused it, and — this is the
 * part that matters — still show what the model actually said. The rich
 * rendering is a presentation of the answer, not the answer itself. Losing the
 * chart must never mean losing the text.
 */
export default function TurnBoundary({ turn, children }) {
  return (
    <ErrorBoundaryClass
      fallback={({ error, reset }) => <BrokenTurn turn={turn} error={error} onRetry={reset} />}
    >
      {children}
    </ErrorBoundaryClass>
  )
}

function BrokenTurn({ turn, error, onRetry }) {
  const text = (turn?.content || '').trim()

  return (
    <div className="sim-panel px-3.5 py-3">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-amber-400/80" />
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] text-[color:var(--embmis-text-muted)]">
            This answer could not be drawn — something in it failed to render.
            {text ? ' The text itself is intact and is below.' : ''}
          </p>

          {text ? (
            <div className="mt-2.5 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-[color:var(--embmis-text-strong)]">
              {text}
            </div>
          ) : null}

          {error?.message ? (
            <p className="mt-2.5 font-mono text-[11px] text-[color:var(--embmis-text-faint)]">
              {error.message}
            </p>
          ) : null}

          <button type="button" onClick={onRetry} className="sim-btn mt-2.5 px-2.5 text-[11.5px]">
            <RotateCcw className="h-3 w-3" /> Try drawing it again
          </button>
        </div>
      </div>
    </div>
  )
}
