import { useState } from 'react'
import { BeakerIcon, ChevronDownIcon, ExclamationTriangleIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import {
  PageHeader, Button, Card, Field, Textarea, Select, InlineNotice, Badge, MaturityBadge, Money, Num,
  Provenance, DateText, EmptyState, describeError,
} from '../../components/ui'

/**
 * Decision simulator.
 *
 * Every number on this page was produced by applying a course of action to the
 * real ledger inside a transaction that was rolled back — not by a forecast
 * and not by a model. So:
 *
 *   • The baseline is shown alongside the branches, always.
 *   • A branch that broke a hard rule is shown, struck through, with the rule.
 *   • "Do nothing" is a row like any other. If it wins, it wins.
 */

const SCENARIOS = [
  { key: 'open', label: 'Anything', hint: 'Enumerate courses of action across payables, receivables and stock.' },
  { key: 'payment_run', label: 'Paying suppliers', hint: 'Which bills to settle, defer, or leave.' },
  { key: 'collections', label: 'Collecting cash', hint: 'Chase, discount for early settlement, or wait.' },
  { key: 'replenishment', label: 'Restocking', hint: 'Replenish now, replenish the worst, or hold the cash.' },
]

const EXAMPLES = [
  'We have limited cash this week — which supplier bills should we pay?',
  'Is it worth offering 2% to get the big receivables in early?',
  'Should we restock the lines below reorder point, or hold the cash?',
]

const MEASURED = 'Measured by applying the action to the live ledger inside a transaction that was rolled back.'

/** One number from the state vector, with its movement. */
function Metric({ label, base, delta, invert = false, count = false }) {
  const d = Number(delta || 0)
  const good = invert ? d < 0 : d > 0
  const has = base != null && !Number.isNaN(Number(base))
  return (
    <div className="min-w-0">
      <p className="label-mono truncate">{label}</p>
      <p className="text-sm font-semibold tabular-nums text-fg">
        {has ? (
          <Provenance method={MEASURED}>{count ? <Num value={Number(base)} /> : <Money amount={Number(base)} digits={0} muted={false} />}</Provenance>
        ) : '—'}
      </p>
      {d !== 0 && (
        <p className={`text-xs tabular-nums ${good ? 'text-ok-700' : 'text-risk-700'}`}>
          <span aria-hidden="true">{d > 0 ? '▲' : '▼'} </span>
          {count ? `${d > 0 ? '+' : ''}${d}` : <Money amount={d} digits={0} signed muted={false} />}
          <span className="sr-only">{good ? ' (better)' : ' (worse)'}</span>
        </p>
      )}
    </div>
  )
}

function BranchRow({ branch, isChosen }) {
  const [open, setOpen] = useState(false)
  const dead = !branch.feasible || branch.apply_error
  const effects = branch.effects || []

  return (
    <li className={`rounded-lg border bg-surface ${isChosen ? 'border-ok-300' : 'border-ink-200'}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full flex-col gap-3 p-4 text-left lg:flex-row lg:items-start lg:justify-between"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge mono>#{branch.rank}</Badge>
            <span className={`font-medium ${dead ? 'text-ink-500 line-through' : 'text-fg'}`}>{branch.label}</span>
            {isChosen && <Badge tone="ok" glyph="check">Best measured</Badge>}
            {branch.proposed_by === 'model' && <Badge>Proposed by Simeli, measured like the rest</Badge>}
          </div>
          {branch.summary && <p className="mt-1 text-sm text-ink-600">{branch.summary}</p>}
          {branch.apply_error && (
            <p className="mt-2 flex items-start gap-1.5 text-sm text-warn-700">
              <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              The database refused this: {branch.apply_error}
            </p>
          )}
          {(branch.violations || []).map((v, i) => (
            <p key={i} className="mt-2 flex items-start gap-1.5 text-sm text-risk-700">
              <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {v.detail}
            </p>
          ))}
        </div>

        <div className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
          <Metric label="Cash" base={branch.measured?.cash} delta={branch.deltas?.cash} />
          <Metric label="Overdue payables" base={branch.measured?.ap_overdue} delta={branch.deltas?.ap_overdue} invert />
          <Metric label="Working capital" base={branch.measured?.working_capital} delta={branch.deltas?.working_capital} />
          <Metric label="Stockouts" base={branch.measured?.stockouts} delta={branch.deltas?.stockouts} invert count />
        </div>
        <ChevronDownIcon className={`hidden h-4 w-4 shrink-0 text-ink-400 transition-transform lg:block ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {open && (
        <div className="border-t border-ink-200 px-4 py-3 text-sm">
          <p className="mb-2 font-medium text-ink-700">
            What this course of action does ({effects.length} step{effects.length === 1 ? '' : 's'})
          </p>
          {effects.length === 0 ? (
            <p className="text-ink-500">Nothing. This is the control every other option is measured against.</p>
          ) : (
            <ol className="space-y-1 text-ink-600">
              {effects.map((e, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-ink-400">{i + 1}.</span>
                  <span>
                    <code className="rounded bg-ink-100 px-1 text-xs">{e.effect}</code>{' '}
                    {Object.entries(e.args || {}).map(([k, v]) => `${k}=${v}`).join(', ')}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {branch.score != null && (
            <p className="mt-3 text-xs text-ink-500">
              Score {branch.score} — weighted sum of the measured movements above, not a model's opinion.
            </p>
          )}
        </div>
      )}
    </li>
  )
}

export default function DecisionSimulator() {
  const [question, setQuestion] = useState('')
  const [questionError, setQuestionError] = useState(null)
  const [scenario, setScenario] = useState('open')
  const [run, setRun] = useState(null)
  const [runError, setRunError] = useState(null)
  const [opening, setOpening] = useState(null)

  const { data: baseline } = useResource(['decisions', 'baseline'], ({ signal }) => api.get('/decisions/baseline', { signal }), { retry: false })
  const { data: historyData } = useResource(['decisions', 'history'], ({ signal }) => api.get('/decisions', { params: { limit: 8 }, signal }), { retry: false })
  const history = Array.isArray(historyData) ? historyData : []

  // A run holds row locks while it measures, so the client timeout has to
  // exceed the server's own deadline rather than racing it.
  const simulate = useResourceMutation(
    (body) => api.post('/decisions/simulate', body, { timeout: 90000 }),
    { silent: true, invalidates: [['decisions', 'history']] },
  )

  const measure = async () => {
    if (!question.trim()) { setQuestionError('Describe the decision first.'); return }
    setQuestionError(null)
    setRunError(null)
    try {
      setRun(await simulate.mutateAsync({ question: question.trim(), scenario }))
    } catch (e) {
      setRunError(e)
    }
  }

  const openRun = async (id) => {
    setOpening(id)
    setRunError(null)
    try {
      const { data } = await api.get(`/decisions/${id}`)
      const d = data.data
      setRun({ ...d, chosen: (d.branches || []).find((b) => b.id === d.chosen_branch_id) || null })
      setQuestion(d.question)
    } catch (e) {
      setRunError(e)
    } finally {
      setOpening(null)
    }
  }

  const chosenId = run?.chosen?.id
  const err = runError ? describeError(runError) : null

  return (
    <div className="space-y-5">
      <PageHeader
        title="Decision simulator"
        badge={<MaturityBadge level="preview" />}
        description="Each option is applied to your real ledger inside a transaction that is rolled back. The figures are what the database reported — measured, not forecast. Nothing is changed."
      />

      <Card title="Where the business stands now">
        {baseline ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <Metric label="Cash" base={baseline.cash} />
            <Metric label="Receivables" base={baseline.ar_open} />
            <Metric label="Overdue in" base={baseline.ar_overdue} />
            <Metric label="Payables" base={baseline.ap_open} />
            <Metric label="Overdue out" base={baseline.ap_overdue} />
            <Metric label="Stockouts" base={baseline.stockouts} count />
          </div>
        ) : (
          <p className="text-sm text-ink-500">The baseline could not be read. Measuring an option still reports its own starting point.</p>
        )}
      </Card>

      <Card title="What are you deciding?">
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); measure() }}>
          <Field label="Decision" error={questionError} help="Describe it in your own words.">
            <Textarea
              rows={2}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onBlur={() => { if (questionError && question.trim()) setQuestionError(null) }}
              placeholder="We have limited cash this week — which supplier bills should we pay?"
              className="text-base sm:text-sm"
            />
          </Field>
          <ul className="flex flex-wrap gap-2" aria-label="Examples">
            {EXAMPLES.map((ex) => (
              <li key={ex}>
                <button type="button" onClick={() => setQuestion(ex)} className="rounded-md border border-ink-200 px-3 py-1.5 text-left text-xs text-ink-700 hover:border-ink-300 hover:bg-ink-50">
                  {ex}
                </button>
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field label="Courses of action to enumerate" help={SCENARIOS.find((s) => s.key === scenario)?.hint} className="sm:w-80">
              <Select value={scenario} onChange={(e) => setScenario(e.target.value)}>
                {SCENARIOS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </Select>
            </Field>
            <Button type="submit" variant="primary" size="lg" icon={BeakerIcon} loading={simulate.isPending} className="sm:mb-5">
              {simulate.isPending ? 'Measuring against the ledger…' : 'Measure the options'}
            </Button>
          </div>
        </form>
      </Card>

      {err && (
        <InlineNotice tone="risk" title="The options could not be measured">
          {err.message}{err.reference ? ` (reference ${err.reference})` : ''}
        </InlineNotice>
      )}

      {run && (
        <section className="space-y-3" aria-label="Measured options">
          {run.status === 'degraded' && (
            <InlineNotice tone="warn" title="The ledger could not be opened for measurement">
              See the note on the result. Figures below may be incomplete.
            </InlineNotice>
          )}
          <InlineNotice tone="ok" title={run.rationale || 'Measured'}>
            <span className="flex flex-wrap gap-x-3 text-xs">
              {run.duration_ms != null && <span>{Number(run.duration_ms).toLocaleString()} ms</span>}
              <span>{(run.branches || []).length} courses of action measured</span>
              <span>Scenario: {run.scenario}</span>
              {run.persisted === false && <span>Not saved — the result is on screen only</span>}
            </span>
          </InlineNotice>

          <ul className="space-y-3">
            {(run.branches || []).map((b, i) => (
              <BranchRow key={b.id || i} branch={b} isChosen={chosenId ? b.id === chosenId : b === run.chosen} />
            ))}
          </ul>

          <p className="pt-1 text-xs text-ink-500">
            Nothing above happened. Each option was applied to the live ledger and rolled back; to act on one,
            create the records the normal way and they still need their usual approvals.
          </p>
        </section>
      )}

      <Card title="Earlier decisions" padded={false}>
        {history.length === 0 ? (
          <EmptyState compact title="No decisions measured yet" description="Describe a decision above and the measured options are kept here." />
        ) : (
          <ul className="divide-y divide-ink-100">
            {history.map((h) => (
              <li key={h.id}>
                <button
                  type="button"
                  onClick={() => openRun(h.id)}
                  aria-busy={opening === h.id || undefined}
                  className="flex min-h-[48px] w-full flex-col gap-0.5 px-4 py-3 text-left hover:bg-ink-50 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-fg">{h.question}</span>
                  <span className="shrink-0 text-xs text-ink-500">
                    {h.chosen_label || '—'} · <DateText value={h.created_at} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
