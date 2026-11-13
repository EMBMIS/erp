import { useMemo } from 'react'
import { ArrowDownTrayIcon, PrinterIcon, ArrowTrendingUpIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import {
  PageHeader, Button, ErrorState, EmptyState, Money, Provenance, formatMoney, formatDate, exportCsv,
} from '../../components/ui'
import { Statement, StatementSection, StatementLine, StatementTotal, StatementSkeleton, StatementFigures } from './StatementParts'

/**
 * Income statement — revenue less expenses.
 *
 * The /finance/income-statement endpoint reads each revenue and expense
 * account's current (unclosed) balance; it accepts periodFrom/periodTo but does
 * not filter by them. The statement therefore says what it is — the balances
 * since the last close — instead of offering a date range it cannot honour.
 */
const today = () => new Date().toISOString().split('T')[0]
const yearStart = () => `${new Date().getFullYear()}-01-01`
const pct = (n) => (Number.isFinite(n) ? `${n.toFixed(1)}%` : '—')

export default function EnhancedIncomeStatement() {
  const periodFrom = yearStart()
  const periodTo = today()
  const { data, loading, error, refetch, dataUpdatedAt } = useResource(
    // Its own key under 'income-statement' (ledger writes still invalidate it):
    // /financial-reports/income-statement answers a different shape.
    ['income-statement', 'current', periodFrom, periodTo],
    ({ signal }) => api.get('/finance/income-statement', { params: { periodFrom, periodTo }, signal }),
    { staleTime: 0 }
  )

  const revenue = useMemo(() => data?.revenue || [], [data])
  const expenses = useMemo(() => data?.expenses || [], [data])
  const R = Number(data?.totals?.revenue || 0)
  const X = Math.abs(Number(data?.totals?.expenses || 0))
  const N = Number(data?.totals?.netIncome || 0)
  const margin = R ? (N / R) * 100 : null
  const hasLines = revenue.length + expenses.length > 0

  const flat = useMemo(() => [
    ...revenue.map((a) => ({ ...a, section: 'Revenue', amount: a.current_balance })),
    ...expenses.map((a) => ({ ...a, section: 'Expenses', amount: Math.abs(Number(a.current_balance || 0)) })),
  ], [revenue, expenses])
  const csvColumns = [
    { header: 'Section', accessor: 'section' },
    { header: 'Account code', accessor: 'account_code' },
    { header: 'Account name', accessor: 'account_name' },
    { header: 'Amount', accessor: 'amount' },
  ]

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Income statement"
        description="Revenue less expenses — the result the business has earned since the last period close."
        meta={<span>Balances as of {formatDate(periodTo)}</span>}
        secondary={
          <>
            <Button icon={PrinterIcon} onClick={() => window.print()} disabled={!hasLines}>Print</Button>
            <Button icon={ArrowDownTrayIcon} onClick={() => exportCsv(flat, csvColumns, `income-statement-${periodTo}.csv`)} disabled={!hasLines}>Export</Button>
          </>
        }
      />

      {loading ? (
        <StatementSkeleton rows={10} />
      ) : error ? (
        <ErrorState error={error} what="The income statement" onRetry={refetch} />
      ) : !hasLines ? (
        <div className="rounded-lg border border-ink-200 bg-surface">
          <EmptyState
            icon={ArrowTrendingUpIcon}
            title="No active revenue or expense accounts"
            description="The income statement lists active revenue and expense accounts. Activate them in the chart of accounts, then post journal entries."
            action={<Button variant="primary" to="/finance/chart-of-accounts">Open chart of accounts</Button>}
          />
        </div>
      ) : (
        <div className="space-y-4">
          <StatementFigures
            items={[
              { label: 'Revenue', value: <Provenance method="The sum of the current balance of every active revenue account." sources={[{ label: `${revenue.length} revenue accounts`, value: formatMoney(R), to: '/finance/chart-of-accounts' }]} asOf={dataUpdatedAt}><Money amount={R} /></Provenance> },
              { label: 'Expenses', value: <Provenance method="The sum of the current balance of every active expense account." sources={[{ label: `${expenses.length} expense accounts`, value: formatMoney(X), to: '/finance/chart-of-accounts' }]} asOf={dataUpdatedAt}><Money amount={X} /></Provenance> },
              { label: 'Net income', value: <Provenance method="Revenue minus expenses." sources={[{ label: 'Revenue', value: formatMoney(R) }, { label: 'Expenses', value: formatMoney(X) }]}><Money amount={N} /></Provenance>, hint: N >= 0 ? 'Profit' : 'Loss' },
              { label: 'Net margin', value: margin == null ? <span className="text-ink-400">—</span> : <Provenance method="Net income as a share of revenue." sources={[{ label: 'Net income', value: formatMoney(N) }, { label: 'Revenue', value: formatMoney(R) }]}>{pct(margin)}</Provenance>, hint: margin == null ? 'No revenue yet' : `Expenses are ${pct((X / R) * 100)} of revenue` },
            ]}
          />

          <Statement caption="Income statement" columns={['Amount']}>
            <StatementSection label="Revenue" empty={revenue.length ? null : 'No active revenue accounts.'}>
              {revenue.map((a) => (
                <StatementLine key={a.account_code} code={a.account_code} name={a.account_name} values={[<Money key="a" amount={a.current_balance} />]} />
              ))}
              <StatementTotal label="Total revenue" values={[<Money key="t" amount={R} />]} />
            </StatementSection>
            <StatementSection label="Expenses" empty={expenses.length ? null : 'No active expense accounts.'}>
              {expenses.map((a) => (
                <StatementLine key={a.account_code} code={a.account_code} name={a.account_name} values={[<Money key="a" amount={Math.abs(Number(a.current_balance || 0))} />]} />
              ))}
              <StatementTotal label="Total expenses" values={[<Money key="t" amount={X} />]} />
            </StatementSection>
            <tbody>
              <StatementTotal level="grand" label={N >= 0 ? 'Net income' : 'Net loss'} values={[<Money key="n" amount={N} />]} />
            </tbody>
          </Statement>
          <p className="text-xs text-ink-500">
            Figures are each account's current balance since the last close; a dated period is not available from this endpoint yet. Use the trial balance to trace a balance to its postings.
          </p>
        </div>
      )}
    </div>
  )
}
