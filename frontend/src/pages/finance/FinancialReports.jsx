import { useState } from 'react'
import { PrinterIcon, DocumentChartBarIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useCompany } from '../../contexts/CompanyContext'
import {
  PageHeader, Button, Field, Input, Segmented, InlineNotice, ErrorState, EmptyState, Money, Provenance, formatMoney, formatDate,
} from '../../components/ui'
import { Statement, StatementSection, StatementLine, StatementTotal, StatementSkeleton, StatementFigures } from './StatementParts'

/**
 * Report pack — the three core statements laid out to print, one at a time.
 *
 * The balance sheet and income statement here read current account balances
 * (/finance/balance-sheet and /finance/income-statement accept dates but do not
 * apply them), so they are labelled as today's balances. The trial balance does
 * honour its as-of date.
 */
const REPORTS = [
  { value: 'balance-sheet', label: 'Balance sheet' },
  { value: 'income-statement', label: 'Income statement' },
  { value: 'trial-balance', label: 'Trial balance' },
]
const today = () => new Date().toISOString().split('T')[0]

export default function FinancialReports() {
  const { current: company } = useCompany()
  const [reportType, setReportType] = useState('balance-sheet')
  const [dateRange, setDateRange] = useState({ from: `${new Date().getFullYear()}-01-01`, to: today() })

  // Keyed on both the report type and the date range. staleTime: 0 — every
  // one of these is derived from the ledger.
  const { data, loading, error, refetch } = useResource(
    keys.financialReport(reportType, dateRange),
    ({ signal }) => {
      switch (reportType) {
        case 'balance-sheet':
          return api.get(`/finance/balance-sheet?asOfDate=${dateRange.to}`, { signal })
        case 'income-statement':
          return api.get(`/finance/income-statement?periodFrom=${dateRange.from}&periodTo=${dateRange.to}`, { signal })
        case 'trial-balance':
          return api.get(`/finance/trial-balance?asOfDate=${dateRange.to}`, { signal })
        default:
          return Promise.resolve({ data: null })
      }
    },
    { staleTime: 0 }
  )
  const title = REPORTS.find((r) => r.value === reportType)?.label

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Report pack"
        description="The balance sheet, income statement and trial balance, laid out to print or file."
        secondary={<Segmented label="Report" options={REPORTS} value={reportType} onChange={setReportType} size="md" className="max-w-full overflow-x-auto" />}
        primary={<Button variant="primary" icon={PrinterIcon} onClick={() => window.print()} disabled={loading || Boolean(error)}>Print</Button>}
      />

      {reportType === 'trial-balance' ? (
        <div className="mb-4 print:hidden">
          <Field label="As of" className="w-44">
            <Input type="date" value={dateRange.to} max={today()} onChange={(e) => setDateRange((r) => ({ ...r, to: e.target.value }))} />
          </Field>
        </div>
      ) : (
        <InlineNotice tone="ink" className="mb-4 print:hidden">
          This statement shows each account's current balance. A dated {title.toLowerCase()} is not available from this report yet.
        </InlineNotice>
      )}

      <article className="rounded-lg border border-ink-200 bg-surface p-4 sm:p-6 print:border-0 print:p-0">
        <header className="mb-5 border-b border-ink-200 pb-4 text-center">
          <p className="label-mono">{company?.name || 'Company'}</p>
          <h2 className="mt-1 text-lg font-semibold text-fg">{title}</h2>
          <p className="mt-0.5 text-sm text-ink-600">
            {reportType === 'trial-balance' ? `As of ${formatDate(data?.asOfDate || dateRange.to)}` : `Balances as of ${formatDate(today())}`}
          </p>
        </header>

        {loading ? (
          <StatementSkeleton rows={10} />
        ) : error ? (
          <ErrorState error={error} what={`The ${title.toLowerCase()}`} onRetry={refetch} />
        ) : reportType === 'balance-sheet' ? (
          <BalanceSheetBody data={data} />
        ) : reportType === 'income-statement' ? (
          <IncomeStatementBody data={data} />
        ) : (
          <TrialBalanceBody data={data} />
        )}

        <footer className="mt-6 flex flex-wrap justify-between gap-2 border-t border-ink-200 pt-3 text-xs text-ink-500">
          <span>Generated {new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
          <span>Confidential business information</span>
        </footer>
      </article>
    </div>
  )
}

function Empty({ what }) {
  return <EmptyState compact icon={DocumentChartBarIcon} title={`Nothing to show on the ${what}`} description="Only active accounts appear. Activate accounts in the chart of accounts and post journal entries to them." action={<Button to="/finance/chart-of-accounts">Open chart of accounts</Button>} />
}

function BalanceSheetBody({ data }) {
  const accounts = data?.accounts || {}
  const totals = data?.totals || {}
  const sections = [['ASSET', 'Assets'], ['LIABILITY', 'Liabilities'], ['EQUITY', 'Equity']]
  if (!sections.some(([t]) => (accounts[t] || []).length)) return <Empty what="balance sheet" />
  const L = Number(totals.LIABILITY || 0)
  const E = Number(totals.EQUITY || 0)
  const A = Number(totals.ASSET || 0)
  return (
    <div className="space-y-4">
      <StatementFigures
        items={[
          { label: 'Assets', value: <Money amount={A} /> },
          { label: 'Liabilities + equity', value: <Money amount={L + E} /> },
          { label: 'Difference', value: <Provenance method="Assets minus liabilities minus equity. A balanced sheet shows zero." sources={[{ label: 'Assets', value: formatMoney(A) }, { label: 'Liabilities', value: formatMoney(L) }, { label: 'Equity', value: formatMoney(E) }]}><Money amount={A - L - E} /></Provenance>, hint: data.isBalanced ? 'Balanced' : 'Not balanced' },
        ]}
      />
      <Statement caption="Balance sheet" columns={['Balance']} className="print:border-0">
        {sections.map(([t, label]) => (
          <StatementSection key={t} label={label} empty={(accounts[t] || []).length ? null : `No active ${label.toLowerCase()} accounts.`}>
            {(accounts[t] || []).map((a) => <StatementLine key={a.account_code} code={a.is_computed ? null : a.account_code} name={a.account_name} note={a.is_computed ? 'computed' : null} values={[<Money key="b" amount={a.current_balance} />]} />)}
            <StatementTotal level="total" label={`Total ${label.toLowerCase()}`} values={[<Money key="t" amount={totals[t] ?? 0} />]} />
          </StatementSection>
        ))}
        <tbody><StatementTotal level="grand" label="Total liabilities and equity" values={[<Money key="le" amount={L + E} />]} /></tbody>
      </Statement>
    </div>
  )
}

function IncomeStatementBody({ data }) {
  const revenue = data?.revenue || []
  const expenses = data?.expenses || []
  if (!revenue.length && !expenses.length) return <Empty what="income statement" />
  const R = Number(data?.totals?.revenue || 0)
  const X = Math.abs(Number(data?.totals?.expenses || 0))
  const N = Number(data?.totals?.netIncome || 0)
  return (
    <div className="space-y-4">
      <StatementFigures
        items={[
          { label: 'Revenue', value: <Money amount={R} /> },
          { label: 'Expenses', value: <Money amount={X} /> },
          { label: 'Net income', value: <Provenance method="Revenue minus expenses." sources={[{ label: 'Revenue', value: formatMoney(R) }, { label: 'Expenses', value: formatMoney(X) }]}><Money amount={N} /></Provenance> },
        ]}
      />
      <Statement caption="Income statement" columns={['Amount']} className="print:border-0">
        <StatementSection label="Revenue" empty={revenue.length ? null : 'No active revenue accounts.'}>
          {revenue.map((a) => <StatementLine key={a.account_code} code={a.account_code} name={a.account_name} values={[<Money key="a" amount={a.current_balance} />]} />)}
          <StatementTotal label="Total revenue" values={[<Money key="t" amount={R} />]} />
        </StatementSection>
        <StatementSection label="Expenses" empty={expenses.length ? null : 'No active expense accounts.'}>
          {expenses.map((a) => <StatementLine key={a.account_code} code={a.account_code} name={a.account_name} values={[<Money key="a" amount={Math.abs(Number(a.current_balance || 0))} />]} />)}
          <StatementTotal label="Total expenses" values={[<Money key="t" amount={X} />]} />
        </StatementSection>
        <tbody><StatementTotal level="grand" label={N >= 0 ? 'Net income' : 'Net loss'} values={[<Money key="n" amount={N} />]} /></tbody>
      </Statement>
    </div>
  )
}

function TrialBalanceBody({ data }) {
  const accounts = data?.accounts || []
  if (!accounts.length) return <Empty what="trial balance" />
  const totals = data?.totals || {}
  return (
    <div className="space-y-4">
      {!data.isBalanced && (
        <InlineNotice tone="risk" title="Debits and credits do not agree">The difference is {formatMoney(Math.abs(totals.difference || 0))}.</InlineNotice>
      )}
      <Statement caption="Trial balance" columns={['Debits', 'Credits']} className="print:border-0">
        <StatementSection label="Posted to each account" span={3}>
          {accounts.map((a) => (
            <StatementLine
              key={a.account_code}
              code={a.account_code}
              name={a.account_name}
              values={[
                Number(a.total_debits) ? <Money key="d" amount={a.total_debits} /> : <span key="d" className="text-ink-400">—</span>,
                Number(a.total_credits) ? <Money key="c" amount={a.total_credits} /> : <span key="c" className="text-ink-400">—</span>,
              ]}
            />
          ))}
        </StatementSection>
        <tbody>
          <StatementTotal level="grand" label="Total" hint={data.isBalanced ? 'Balanced' : `Difference ${formatMoney(Math.abs(totals.difference || 0))}`} values={[<Money key="d" amount={totals.debits} />, <Money key="c" amount={totals.credits} />]} />
        </tbody>
      </Statement>
      <p className="text-xs text-ink-500">Columns are the gross debits and credits posted to each active account up to the date.</p>
    </div>
  )
}
