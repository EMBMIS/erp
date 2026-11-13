import { useMemo, useState } from 'react'
import { ArrowDownTrayIcon, PrinterIcon, ScaleIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, Field, Input, InlineNotice, ErrorState, EmptyState, Money, Provenance, formatMoney, exportCsv,
} from '../../components/ui'
import { Statement, StatementSection, StatementLine, StatementTotal, StatementSkeleton, StatementFigures } from './StatementParts'

/**
 * Trial balance — every account's posted net balance as of a date, split into
 * the debit or credit column by its sign. The two columns must agree.
 */
const TYPES = [
  ['ASSET', 'Assets'], ['LIABILITY', 'Liabilities'], ['EQUITY', 'Equity'], ['REVENUE', 'Revenue'], ['EXPENSE', 'Expenses'],
]
const today = () => new Date().toISOString().split('T')[0]
const split = (row) => {
  const net = parseFloat(row.net_balance || 0)
  return { dr: net > 0 ? net : 0, cr: net < 0 ? Math.abs(net) : 0 }
}

export default function TrialBalance() {
  const [asOfDate, setAsOfDate] = useState(today())

  // Keyed on the date: two dates are two reports. staleTime: 0 — derived from
  // the ledger; a stale copy that misses a just-posted entry is worse than a refetch.
  const { data, loading, error, refetch } = useResource(
    keys.trialBalance(asOfDate),
    ({ signal }) => api.get(
      `/financial-reports/trial-balance?${new URLSearchParams(asOfDate ? { as_of_date: asOfDate } : {})}`,
      { signal }
    ),
    { staleTime: 0 }
  )
  const rows = useMemo(() => (Array.isArray(data) ? data : []), [data])

  const totals = useMemo(() => rows.reduce((t, r) => {
    const { dr, cr } = split(r)
    return {
      dr: t.dr + dr,
      cr: t.cr + cr,
      grossDr: t.grossDr + parseFloat(r.total_debits || 0),
      grossCr: t.grossCr + parseFloat(r.total_credits || 0),
    }
  }, { dr: 0, cr: 0, grossDr: 0, grossCr: 0 }), [rows])
  const diff = totals.dr - totals.cr
  const balanced = Math.abs(diff) < 0.01

  const groups = useMemo(() => {
    const known = new Set(TYPES.map(([t]) => t))
    const out = TYPES.map(([type, label]) => ({ type, label, rows: rows.filter((r) => r.account_type === type) }))
    const other = rows.filter((r) => !known.has(r.account_type))
    if (other.length) out.push({ type: 'OTHER', label: 'Other', rows: other })
    return out.filter((g) => g.rows.length)
  }, [rows])

  const csvColumns = [
    { header: 'Account code', accessor: 'account_code' },
    { header: 'Account name', accessor: 'account_name' },
    { header: 'Type', accessor: 'account_type' },
    { header: 'Debit', exportValue: (r) => split(r).dr.toFixed(2) },
    { header: 'Credit', exportValue: (r) => split(r).cr.toFixed(2) },
  ]

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Trial balance"
        description="Every account's posted balance as of a date. Debits must equal credits before statements can be trusted."
        secondary={
          <>
            <Button icon={PrinterIcon} onClick={() => window.print()} disabled={!rows.length}>Print</Button>
            <Button icon={ArrowDownTrayIcon} onClick={() => exportCsv(rows, csvColumns, `trial-balance-${asOfDate}.csv`)} disabled={!rows.length}>Export</Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-4">
        <Field label="As of" className="w-44">
          <Input type="date" value={asOfDate} max={today()} onChange={(e) => setAsOfDate(e.target.value)} />
        </Field>
        {!loading && !error && rows.length > 0 && (
          <p role="status" className={balanced ? 'flex items-center gap-1.5 pb-1.5 text-sm font-medium text-ok-700' : 'flex items-center gap-1.5 pb-1.5 text-sm font-medium text-risk-700'}>
            <span aria-hidden="true">{balanced ? '✓' : '▲'}</span>
            {balanced ? 'In balance' : <>Out of balance by <Money amount={Math.abs(diff)} className="text-risk-700" /></>}
          </p>
        )}
      </div>

      {!loading && !error && rows.length > 0 && !balanced && (
        <InlineNotice tone="risk" className="mb-4" title="Debits and credits do not agree">
          The difference is {formatMoney(Math.abs(diff))}. Open the accounts below to see the posted lines behind each balance, and look for an entry posted to one side only.
        </InlineNotice>
      )}

      {loading ? (
        <StatementSkeleton />
      ) : error ? (
        <ErrorState error={error} what="The trial balance" onRetry={refetch} />
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-ink-200 bg-surface">
          <EmptyState
            icon={ScaleIcon}
            title="No posted balances as of this date"
            description="The trial balance lists accounts with posted journal lines. Post a journal entry, or choose a later date."
            action={<Button variant="primary" to="/finance/journal-entries">Open journal entries</Button>}
          />
        </div>
      ) : (
        <div className="space-y-4">
        <StatementFigures
          items={[
            { label: 'Total debits', value: <Provenance method={`The debit column: every account whose posted net balance is a debit, as of ${asOfDate}.`} sources={[{ label: `${rows.length} accounts listed`, value: formatMoney(totals.dr) }, { label: 'Gross debits posted', value: formatMoney(totals.grossDr) }]}><Money amount={totals.dr} /></Provenance> },
            { label: 'Total credits', value: <Provenance method={`The credit column: every account whose posted net balance is a credit, as of ${asOfDate}.`} sources={[{ label: `${rows.length} accounts listed`, value: formatMoney(totals.cr) }, { label: 'Gross credits posted', value: formatMoney(totals.grossCr) }]}><Money amount={totals.cr} /></Provenance> },
            { label: 'Difference', value: <Provenance method="Total debits minus total credits. A balanced ledger shows zero." sources={[{ label: 'Total debits', value: formatMoney(totals.dr) }, { label: 'Total credits', value: formatMoney(totals.cr) }]}><Money amount={diff} /></Provenance>, hint: balanced ? 'In balance' : 'Out of balance' },
          ]}
        />
        <Statement caption={`Trial balance as of ${asOfDate}`} columns={['Debit', 'Credit']}>
          {groups.map((g) => {
            const sub = g.rows.reduce((t, r) => { const s = split(r); return { dr: t.dr + s.dr, cr: t.cr + s.cr } }, { dr: 0, cr: 0 })
            return (
              <StatementSection key={g.type} label={g.label} span={3}>
                {g.rows.map((r, i) => {
                  const { dr, cr } = split(r)
                  return (
                    <StatementLine
                      key={r.account_id || `${r.account_code}-${i}`}
                      code={r.account_code}
                      name={r.account_name}
                      accountId={r.account_id}
                      dateTo={asOfDate}
                      values={[dr ? <Money amount={dr} /> : <span className="text-ink-400">—</span>, cr ? <Money amount={cr} /> : <span className="text-ink-400">—</span>]}
                    />
                  )
                })}
                <StatementTotal label={`Total ${g.label.toLowerCase()}`} values={[<Money key="d" amount={sub.dr} />, <Money key="c" amount={sub.cr} />]} />
              </StatementSection>
            )
          })}
          <tbody>
            <StatementTotal level="grand" label="Total" values={[<Money key="d" amount={totals.dr} />, <Money key="c" amount={totals.cr} />]} />
          </tbody>
        </Statement>
        </div>
      )}
    </div>
  )
}
