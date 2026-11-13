import { useState } from 'react'
import { ScaleIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, Field, Input, InlineNotice, ErrorState, EmptyState, Money, Provenance, formatMoney,
} from '../../components/ui'
import { Statement, StatementSection, StatementLine, StatementTotal, StatementSkeleton, StatementFigures } from './StatementParts'

/**
 * Dated balance sheet from posted journal lines (/financial-reports/balance-sheet).
 * Not routed at present (App.jsx imports it; /finance/reports/balance-sheet
 * renders EnhancedBalanceSheet). Kept on the same statement grammar.
 */
const today = () => new Date().toISOString().split('T')[0]
const SECTIONS = [
  { key: 'assets', total: 'total_assets', label: 'Assets' },
  { key: 'liabilities', total: 'total_liabilities', label: 'Liabilities' },
  { key: 'equity', total: 'total_equity', label: 'Equity' },
]

export default function BalanceSheet() {
  const [asOfDate, setAsOfDate] = useState(today())

  // staleTime: 0 — derived from the ledger; a stale copy that misses a
  // just-posted journal entry is worse than the extra refetch.
  const { data, loading, error, refetch } = useResource(
    keys.balanceSheet(asOfDate),
    ({ signal }) => api.get(`/financial-reports/balance-sheet?${new URLSearchParams(asOfDate ? { as_of_date: asOfDate } : {})}`, { signal }),
    { staleTime: 0 }
  )
  const bs = data || {}
  const A = Number(bs.total_assets || 0)
  const LE = Number(bs.total_liabilities || 0) + Number(bs.total_equity || 0)
  const diff = A - LE
  const balanced = Math.abs(diff) < 0.01
  const hasLines = SECTIONS.some((s) => (bs[s.key] || []).length)

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Balance sheet" description="Assets, liabilities and equity from posted journal lines, as of a date." />
      <div className="mb-4">
        <Field label="As of" className="w-44">
          <Input type="date" value={asOfDate} max={today()} onChange={(e) => setAsOfDate(e.target.value)} />
        </Field>
      </div>

      {loading ? (
        <StatementSkeleton rows={10} />
      ) : error ? (
        <ErrorState error={error} what="The balance sheet" onRetry={refetch} />
      ) : !hasLines ? (
        <div className="rounded-lg border border-ink-200 bg-surface">
          <EmptyState icon={ScaleIcon} title="Nothing posted as of this date" description="The balance sheet lists accounts with posted journal lines. Post a journal entry, or choose a later date." action={<Button variant="primary" to="/finance/journal-entries">Open journal entries</Button>} />
        </div>
      ) : (
        <div className="space-y-4">
          {!balanced && (
            <InlineNotice tone="risk" title="Assets do not equal liabilities plus equity">
              The difference is {formatMoney(Math.abs(diff))}. Run the trial balance for the same date to find it.
            </InlineNotice>
          )}
          <StatementFigures
            items={[
              { label: 'Total assets', value: <Money amount={A} /> },
              { label: 'Liabilities + equity', value: <Provenance method="Total liabilities plus total equity." sources={[{ label: 'Liabilities', value: formatMoney(bs.total_liabilities) }, { label: 'Equity', value: formatMoney(bs.total_equity) }]}><Money amount={LE} /></Provenance> },
              { label: 'Difference', value: <Provenance method="Assets minus liabilities and equity. A balanced sheet shows zero." sources={[{ label: 'Assets', value: formatMoney(A) }, { label: 'Liabilities + equity', value: formatMoney(LE) }]}><Money amount={diff} /></Provenance>, hint: balanced ? 'Balanced' : 'Not balanced' },
            ]}
          />
          <Statement caption={`Balance sheet as of ${asOfDate}`} columns={['Balance']}>
            {SECTIONS.map((s) => (
              <StatementSection key={s.key} label={s.label} empty={(bs[s.key] || []).length ? null : `No posted ${s.label.toLowerCase()}.`}>
                {(bs[s.key] || []).map((a) => (
                  <StatementLine key={a.account_id || a.account_code} code={a.account_code} name={a.account_name} accountId={a.account_id} dateTo={asOfDate} values={[<Money key="b" amount={a.balance} />]} />
                ))}
                <StatementTotal level="total" label={`Total ${s.label.toLowerCase()}`} values={[<Money key="t" amount={bs[s.total] || 0} />]} />
              </StatementSection>
            ))}
            <tbody>
              <StatementTotal level="grand" label="Total liabilities and equity" values={[<Money key="le" amount={LE} />]} />
            </tbody>
          </Statement>
        </div>
      )}
    </div>
  )
}
