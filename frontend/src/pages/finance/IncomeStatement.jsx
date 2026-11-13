import { useState } from 'react'
import { ArrowTrendingUpIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, Field, Input, ErrorState, EmptyState, Money, Provenance, formatMoney,
} from '../../components/ui'
import { Statement, StatementSection, StatementLine, StatementTotal, StatementSkeleton, StatementFigures } from './StatementParts'

/**
 * Dated income statement from posted journal lines (/financial-reports/income-statement).
 * Not routed at present (App.jsx imports it; /finance/reports/income-statement
 * renders EnhancedIncomeStatement). Kept on the same statement grammar.
 */
const today = () => new Date().toISOString().split('T')[0]
const yearStart = () => `${new Date().getFullYear()}-01-01`

export default function IncomeStatement() {
  const [dateFrom, setDateFrom] = useState(yearStart())
  const [dateTo, setDateTo] = useState(today())

  // staleTime: 0 — derived from the ledger.
  const { data, loading, error, refetch } = useResource(
    keys.incomeStatement(dateFrom, dateTo),
    ({ signal }) => api.get(`/financial-reports/income-statement?${new URLSearchParams({ ...(dateFrom ? { date_from: dateFrom } : {}), ...(dateTo ? { date_to: dateTo } : {}) })}`, { signal }),
    { staleTime: 0 }
  )
  const is = data || {}
  const revenue = is.revenue || []
  const expenses = is.expenses || []
  const R = Number(is.total_revenue || 0)
  const X = Number(is.total_expenses || 0)
  const N = R - X

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Income statement" description="Revenue less expenses from posted journal lines, for a period." />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="From" className="w-44"><Input type="date" value={dateFrom} max={dateTo} onChange={(e) => setDateFrom(e.target.value)} /></Field>
        <Field label="To" className="w-44"><Input type="date" value={dateTo} min={dateFrom} onChange={(e) => setDateTo(e.target.value)} /></Field>
      </div>

      {loading ? (
        <StatementSkeleton rows={10} />
      ) : error ? (
        <ErrorState error={error} what="The income statement" onRetry={refetch} />
      ) : revenue.length + expenses.length === 0 ? (
        <div className="rounded-lg border border-ink-200 bg-surface">
          <EmptyState icon={ArrowTrendingUpIcon} title="Nothing posted in this period" description="Post revenue or expense journal entries, or widen the period." action={<Button variant="primary" to="/finance/journal-entries">Open journal entries</Button>} />
        </div>
      ) : (
        <div className="space-y-4">
          <StatementFigures
            items={[
              { label: 'Revenue', value: <Money amount={R} /> },
              { label: 'Expenses', value: <Money amount={X} /> },
              { label: 'Net income', value: <Provenance method="Revenue minus expenses in the period." sources={[{ label: 'Revenue', value: formatMoney(R) }, { label: 'Expenses', value: formatMoney(X) }]}><Money amount={N} /></Provenance>, hint: N >= 0 ? 'Profit' : 'Loss' },
            ]}
          />
          <Statement caption={`Income statement, ${dateFrom} to ${dateTo}`} columns={['Amount']}>
            <StatementSection label="Revenue" empty={revenue.length ? null : 'No revenue posted.'}>
              {revenue.map((a) => <StatementLine key={a.account_id || a.account_code} code={a.account_code} name={a.account_name} accountId={a.account_id} dateFrom={dateFrom} dateTo={dateTo} values={[<Money key="a" amount={a.balance} />]} />)}
              <StatementTotal label="Total revenue" values={[<Money key="t" amount={R} />]} />
            </StatementSection>
            <StatementSection label="Expenses" empty={expenses.length ? null : 'No expenses posted.'}>
              {expenses.map((a) => <StatementLine key={a.account_id || a.account_code} code={a.account_code} name={a.account_name} accountId={a.account_id} dateFrom={dateFrom} dateTo={dateTo} values={[<Money key="a" amount={a.balance} />]} />)}
              <StatementTotal label="Total expenses" values={[<Money key="t" amount={X} />]} />
            </StatementSection>
            <tbody>
              <StatementTotal level="grand" label={N >= 0 ? 'Net income' : 'Net loss'} values={[<Money key="n" amount={N} />]} />
            </tbody>
          </Statement>
        </div>
      )}
    </div>
  )
}
