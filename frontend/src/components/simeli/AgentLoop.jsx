import React from 'react'
import { Check, ChevronDown, ChevronRight } from 'lucide-react'
import AgentActivity from './AgentActivity'
import { FigureStrip, RecordRefs, humanizeKey } from './ResultBlocks'

/**
 * The agent loop — what Simeli is doing, in the order it did it.
 *
 * WHAT IS AND IS NOT SHOWN
 * ---------------------------------------------------------------------------
 * Every row here is a tool that actually executed. The label is the tool's
 * business verb ("Reviewing receivables"), the count beside it is counted from
 * that tool's own return value, and both come from the server —
 * services/ai/agentNarration.js — so there is no way for this component to
 * display a step that did not happen.
 *
 * Stages the run never reached are NOT drawn. A greyed-out "Simulate" reads as
 * "Simeli chose not to simulate", which is a claim about its judgement; the
 * truth is usually that the question never called for a simulation. Absent is
 * the honest rendering of "not applicable".
 *
 * COLLAPSED BY DEFAULT, EXCEPT WHEN IT ISN'T
 * ---------------------------------------------------------------------------
 * A finished loop collapses to one summary line: it is history, and the answer
 * below it is what the user came for. A running loop stays open, because that
 * is the only thing on screen telling them anything is happening. A loop that
 * has stopped for an approval also stays open — that one is not history, it is
 * a question.
 */

const STATE_ORDER = { pending: 0, running: 1, done: 2, error: 3, denied: 4 }

/**
 * One step, and everything that step pulled.
 *
 * The data used to be printed into the answer — every tool that returned
 * something countable rendered a panel in the message body, so a simple
 * question produced a wall of blocks between the reader and the sentence they
 * wanted. It lives here now, attached to the tool that fetched it, which is
 * both less noisy and more useful: the figures are next to the thing that went
 * and got them.
 *
 * Nothing is hidden by this. The dropdown holds the complete record of the turn
 * whether or not the model chose to lead with any of it.
 */
function StepData({ step }) {
  const d = step.digest
  if (!d) return null

  const figures = d.figures || []
  const records = d.records || []

  if (d.inconclusive) {
    return (
      <p className="mt-1 text-[11.5px] leading-relaxed text-[color:var(--embmis-text-muted)]">
        This check could not run — not enough history to test against. That is not
        the same as finding nothing.
      </p>
    )
  }

  // A step whose output went into the answer did not return nothing — it
  // returned the thing the reader is looking at. Saying "nothing came back"
  // under "Drawing the chart" is both wrong and alarming.
  if (step.producedOutput) {
    return (
      <p className="mt-1 text-[11.5px] text-[color:var(--embmis-text-faint)]">
        Shown in the answer above.
      </p>
    )
  }

  if (d.empty || (!figures.length && !records.length)) {
    // A tool can return something perfectly real that is neither rows nor
    // figures — the output of sandboxed code, a status, a confirmation. The
    // digest describes it in `headline`, and reporting that as "nothing came
    // back" was wrong six times in a row on one run.
    return (
      <p className="mt-1 text-[11.5px] text-[color:var(--embmis-text-faint)]">
        {d.headline || 'Nothing came back.'}
      </p>
    )
  }

  return (
    <div className="mt-1.5 flex flex-col gap-2">
      {figures.length > 0 && (
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {figures.map((f) => (
            <span key={f.key} className="min-w-0">
              <span className="block text-[15px] font-semibold leading-none tabular-nums text-[color:var(--sim-data-lum)]">
                {Number.isFinite(f.value) ? f.value.toLocaleString() : '—'}
              </span>
              <span className="mt-0.5 block truncate text-[10px] uppercase tracking-[0.07em] text-[color:var(--embmis-text-faint)]">
                {humanizeKey(f.key)}
              </span>
            </span>
          ))}
        </div>
      )}
      {records.length > 0 && (
        <RecordRefs records={records} unit={d.unit} total={d.count} />
      )}
    </div>
  )
}

function StageRow({ step }) {
  const state = step.status === 'running' ? 'active'
    : step.status === 'denied' ? 'blocked'
      : step.status === 'error' ? 'done'
        : 'done'

  return (
    <div className={`sim-stage is-${state}`}>
      <span className="sim-stage-dot">
        {step.status === 'done' && <Check className="h-2 w-2 text-cyan-300" strokeWidth={3.5} />}
      </span>

      <span className="min-w-0 flex-1">
        <span className={step.status === 'error' ? 'line-through opacity-70' : ''}>
          {step.verb}
        </span>
        {step.status === 'error' && (
          <span className="ml-2 text-[11px] text-rose-300">{step.error || 'failed'}</span>
        )}
        {step.status === 'denied' && (
          <span className="ml-2 text-[11px] opacity-80">not approved</span>
        )}
      </span>

      {step.reading && <span className="sim-stage-count">{step.reading}</span>}
    </div>
  )
}

function Step({ step }) {
  return (
    <div>
      <StageRow step={step} />
      {step.status === 'done' && (
        <div className="mb-1.5 ml-[22px] mr-1">
          <StepData step={step} />
        </div>
      )}
    </div>
  )
}

/**
 * @param steps    [{ id, verb, status, reading, error }] in execution order
 * @param working  true while the run is still going
 * @param blocked  true while it is stopped on an approval
 * @param title    what the run is about — the user's own question, shortened
 */
export default function AgentLoop({ steps, working, blocked, title, calls, thoughts }) {
  // Open while it matters, shut once it is history. `useState` initialiser
  // rather than an effect, so it does not flash open then closed on mount.
  // Closed, always, until someone opens it.
  //
  // It used to open itself while a run was live and shut itself when the run
  // finished. That is two surprises: the answer jumps down the screen as the
  // trace expands, and whatever you were reading collapses out from under you
  // when it ends. The summary line already carries the live signal — the verb
  // of the step running right now — and that is all the reassurance a running
  // turn needs. Anyone who wants the detail can ask for it, and it stays open
  // until they say otherwise.
  const [open, setOpen] = React.useState(false)

  if (!steps?.length) return null

  const done = steps.filter((s) => s.status === 'done').length
  const failed = steps.filter((s) => s.status === 'error').length

  // The summary line has to be true whether or not the run finished cleanly.
  // The closed label has to promise what is inside, or nobody opens it. "2
  // steps" does not; "2 steps · 38 invoices, 1 figure" does.
  const found = []
  let rowTotal = 0
  let figureTotal = 0
  for (const s of steps) {
    if (s.digest?.count) rowTotal += s.digest.count
    if (s.digest?.figures?.length) figureTotal += s.digest.figures.length
  }
  if (rowTotal) found.push(`${rowTotal.toLocaleString()} record${rowTotal === 1 ? '' : 's'}`)
  if (figureTotal) found.push(`${figureTotal} figure${figureTotal === 1 ? '' : 's'}`)
  if (thoughts?.length) found.push(`${thoughts.length} note${thoughts.length === 1 ? '' : 's'}`)

  const summary = blocked
    ? 'Waiting for your approval'
    : working
      ? (steps.find((s) => s.status === 'running')?.verb || 'Working')
      : failed
        ? `${done} step${done === 1 ? '' : 's'}, ${failed} failed`
        : [`${done} step${done === 1 ? '' : 's'}`, ...found].join(' · ')

  return (
    <div className="sim-panel overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left"
      >
        <span className={`sim-mark ${working ? 'is-working' : ''}`} style={{ '--mark-size': '20px' }}>
          <span className="sim-mark-ring" />
          <span className="sim-mark-core" />
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-semibold text-[color:var(--embmis-text-strong)]">
            {title || 'Investigating'}
          </span>
          <span className="block truncate text-[11.5px] text-[color:var(--embmis-text-faint)]">
            {summary}
          </span>
        </span>

        {open
          ? <ChevronDown className="h-3.5 w-3.5 flex-none text-[color:var(--embmis-text-faint)]" />
          : <ChevronRight className="h-3.5 w-3.5 flex-none text-[color:var(--embmis-text-faint)]" />}
      </button>

      {open && (
        <div className="border-t border-[color:var(--sim-line)]">
          <div className="sim-loop px-2.5 py-2">
            {steps.map((step) => <Step key={step.id} step={step} />)}
          </div>

          {/* What Simeli was thinking between the steps.
              ---------------------------------------------------------------
              This used to sit in the answer. The model writes before it knows
              whether it is about to call a tool, so its working-out streamed
              straight into the reply and stayed there — "Let me check the
              receivables first" above the actual answer, every time.
              It belongs here, next to the steps it is reasoning about. */}
          {thoughts?.length > 0 && (
            <div className="border-t border-[color:var(--embmis-line-soft)] px-3.5 py-2.5">
              <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.09em] text-[color:var(--embmis-text-faint)]">
                Reasoning
              </div>
              <div className="flex flex-col gap-1.5">
                {thoughts.map((t, i) => (
                  <p key={i} className="text-[12px] italic leading-relaxed text-[color:var(--embmis-text-muted)]">
                    {t.text}
                  </p>
                ))}
              </div>
            </div>
          )}

          {/* The same work grouped by module — Finance › Receivables › 38
              invoices. This had its own panel above the composer, which meant
              two things on screen describing one run. Behind a click it costs
              nothing, and grouped-by-module answers a different question from
              the step list: not what happened in order, but where Simeli
              reached. */}
          {calls?.length > 1 && (
            <div className="border-t border-[color:var(--embmis-line-soft)] px-1 pb-1 pt-1">
              <AgentActivity calls={calls} working={working} bare />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export { STATE_ORDER }
