import { Fragment, useState } from 'react'
import clsx from 'clsx'
import { ChevronRightIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { keys } from '../../services/queryKeys'
import { useResource } from '../../hooks/useResource'
import { Code, DateText, Money, ErrorState, Skeleton } from '../../components/ui'

/**
 * Financial statement parts — the one way the ledger's statements are set.
 *
 *   SECTION LABEL           mono, uppercase, quiet
 *   1110  Account name                       1,250.00
 *   ─────────────────────────────────────── hairline
 *         Total section                      1,250.00
 *   ═══════════════════════════════════════ grand total
 *
 * Numbers are right-aligned and tabular so columns of figures can be read
 * down. An account line with an `accountId` opens the posted journal lines
 * behind it in place, so every figure on a statement can be traced.
 */

/** Statement — a table with an account column and one or more amount columns. */
export function Statement({ caption, columns = ['Amount'], children, className }) {
  return (
    <div className={clsx('min-w-0 overflow-x-auto rounded-lg border border-ink-200 bg-surface ui-scroll', className)}>
      <table className="w-full min-w-[320px] text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-ink-200">
            <th scope="col" className="label-mono px-4 py-2.5 text-left font-normal">Account</th>
            {columns.map((c) => (
              <th key={c} scope="col" className="label-mono w-32 whitespace-nowrap px-4 py-2.5 text-right font-normal sm:w-40">{c}</th>
            ))}
          </tr>
        </thead>
        {children}
      </table>
    </div>
  )
}

/** A titled group of lines. */
export function StatementSection({ label, span = 2, children, empty }) {
  return (
    <tbody>
      <tr>
        <th scope="rowgroup" colSpan={span} className="label-mono px-4 pb-1.5 pt-5 text-left font-normal">{label}</th>
      </tr>
      {empty && (
        <tr>
          <td colSpan={span} className="py-1.5 pl-[34px] pr-4 text-sm text-ink-500">{empty}</td>
        </tr>
      )}
      {children}
    </tbody>
  )
}

/**
 * One account line. `values` are nodes for the amount columns (use Money).
 * With `accountId`, the name is a disclosure for the journal lines behind it.
 */
export function StatementLine({ code, name, values = [], accountId, dateFrom, dateTo, note }) {
  const [open, setOpen] = useState(false)
  const span = values.length + 1
  const label = (
    <span className="flex min-w-0 items-baseline gap-3">
      {code && <Code className="w-12 shrink-0 text-ink-500">{code}</Code>}
      <span className="min-w-0 break-words">{name}</span>
      {note && <span className="shrink-0 text-xs text-ink-500">{note}</span>}
    </span>
  )
  return (
    <Fragment>
      <tr className="group hover:bg-ink-50">
        <td className="py-1.5 pl-4 pr-3 text-ink-900">
          {accountId ? (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className="flex w-full min-w-0 items-baseline gap-1 rounded text-left hover:underline hover:decoration-ink-300 hover:underline-offset-4"
              title={open ? 'Hide the journal lines' : 'Show the posted journal lines behind this figure'}
            >
              <ChevronRightIcon aria-hidden="true" className={clsx('h-3.5 w-3.5 shrink-0 self-center text-ink-400 transition-transform', open && 'rotate-90')} />
              {label}
            </button>
          ) : (
            <span className="flex pl-[18px]">{label}</span>
          )}
        </td>
        {values.map((v, i) => (
          <td key={i} className="whitespace-nowrap px-4 py-1.5 text-right tabular-nums text-ink-900">{v}</td>
        ))}
      </tr>
      {open && accountId && <LedgerLines accountId={accountId} dateFrom={dateFrom} dateTo={dateTo} colSpan={span} />}
    </Fragment>
  )
}

/**
 * A total. `level` sets the rule above it: 'subtotal' a hairline, 'total' a
 * darker hairline, 'grand' a heavy rule with a double rule under it.
 */
export function StatementTotal({ label, values = [], level = 'subtotal', hint }) {
  return (
    <tr
      className={clsx(
        level === 'subtotal' && 'border-t border-ink-200',
        level === 'total' && 'border-t border-ink-400',
        level === 'grand' && 'border-b-[3px] border-t border-double border-b-ink-400 border-t-ink-900'
      )}
    >
      <th scope="row" className={clsx('py-2 pl-4 pr-3 text-left', level === 'subtotal' ? 'font-medium text-ink-800' : 'font-semibold text-fg')}>
        <span className="pl-[18px]">{label}</span>
        {hint && <span className="ml-2 text-xs font-normal text-ink-500">{hint}</span>}
      </th>
      {values.map((v, i) => (
        <td key={i} className={clsx('whitespace-nowrap px-4 py-2 text-right tabular-nums', level === 'subtotal' ? 'font-medium text-ink-800' : 'font-semibold text-fg')}>{v}</td>
      ))}
    </tr>
  )
}

/** The posted journal lines for one account, optionally bounded by dates. */
export function LedgerLines({ accountId, dateFrom, dateTo, colSpan }) {
  const { data, loading, error, refetch } = useResource(
    keys.generalLedger(accountId, dateFrom, dateTo),
    ({ signal }) => api.get(
      `/financial-reports/general-ledger/${accountId}?${new URLSearchParams({
        ...(dateFrom ? { date_from: dateFrom } : {}),
        ...(dateTo ? { date_to: dateTo } : {}),
        limit: '50',
      })}`,
      { signal }
    ),
    { enabled: Boolean(accountId) }
  )
  const lines = data?.transactions || []
  return (
    <tr>
      <td colSpan={colSpan} className="border-y border-ink-100 bg-sunken px-4 py-3">
        {loading ? (
          <div className="space-y-2" role="status"><span className="sr-only">Loading journal lines</span><Skeleton className="h-3 w-2/3" /><Skeleton className="h-3 w-1/2" /></div>
        ) : error ? (
          <ErrorState compact error={error} what="The journal lines" onRetry={refetch} />
        ) : lines.length === 0 ? (
          <p className="text-sm text-ink-600">No posted journal lines for this account in the period.</p>
        ) : (
          <div className="overflow-x-auto ui-scroll">
            <table className="w-full min-w-[480px] text-xs">
              <thead>
                <tr className="text-ink-500">
                  <th scope="col" className="py-1 pr-4 text-left font-medium">Entry</th>
                  <th scope="col" className="py-1 pr-4 text-left font-medium">Date</th>
                  <th scope="col" className="py-1 pr-4 text-left font-medium">Description</th>
                  <th scope="col" className="py-1 pr-4 text-right font-medium">Debit</th>
                  <th scope="col" className="py-1 text-right font-medium">Credit</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={`${l.journal_number}-${i}`} className="border-t border-ink-100">
                    <td className="py-1 pr-4"><Code>{l.journal_number}</Code></td>
                    <td className="py-1 pr-4"><DateText value={l.entry_date} /></td>
                    <td className="py-1 pr-4 text-ink-700">{l.line_description || l.entry_description || '—'}</td>
                    <td className="py-1 pr-4 text-right">{Number(l.debit_amount) > 0 ? <Money amount={l.debit_amount} /> : <span className="text-ink-400">—</span>}</td>
                    <td className="py-1 text-right">{Number(l.credit_amount) > 0 ? <Money amount={l.credit_amount} /> : <span className="text-ink-400">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {lines.length >= 50 && <p className="mt-2 text-xs text-ink-500">Showing the first 50 lines.</p>}
          </div>
        )}
      </td>
    </tr>
  )
}

/**
 * StatementFigures — the handful of computed figures a statement concludes
 * with, set as a row above it. Values are usually a Provenance so a reader can
 * see how each one was reached. (Not truncated, so the explanation can open.)
 * items: [{ label, value, hint }]
 */
export function StatementFigures({ items = [], className }) {
  const list = items.filter(Boolean)
  return (
    <dl className={clsx('grid grid-cols-1 rounded-lg border border-ink-200 bg-surface', list.length >= 4 ? 'sm:grid-cols-2 lg:grid-cols-4' : list.length === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-3', className)}>
      {list.map((f, i) => (
        <div key={f.label} className={clsx('min-w-0 px-4 py-3', i > 0 && 'border-t border-ink-200 sm:border-l sm:border-t-0', list.length >= 4 && i === 2 && 'sm:border-l-0 sm:border-t lg:border-l lg:border-t-0', list.length >= 4 && i === 3 && 'sm:border-t lg:border-t-0')}>
          <dt className="label-mono">{f.label}</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums tracking-tight text-fg">{f.value}</dd>
          {f.hint && <dd className="mt-0.5 text-xs text-ink-500">{f.hint}</dd>}
        </div>
      ))}
    </dl>
  )
}

/** A statement-shaped skeleton. */
export function StatementSkeleton({ rows = 8 }) {
  return (
    <div role="status" aria-live="polite" className="space-y-3 rounded-lg border border-ink-200 bg-surface p-4">
      <span className="sr-only">Loading</span>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-3 w-10" />
          <Skeleton className="h-3 w-48" />
          <Skeleton className="ml-auto h-3 w-24" />
        </div>
      ))}
    </div>
  )
}
