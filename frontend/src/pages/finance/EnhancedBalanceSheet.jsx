import { useMemo } from 'react'
import { ArrowDownTrayIcon, PrinterIcon, ScaleIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import {
  PageHeader, Button, InlineNotice, ErrorState, EmptyState, Money, Provenance, formatMoney, formatDate, exportCsv,
} from '../../components/ui'
import { Statement, StatementSection, StatementLine, StatementTotal, StatementSkeleton, StatementFigures } from './StatementParts'

/**
 * Balance sheet — assets, liabilities and equity from the chart of accounts.
 *
 * The /finance/balance-sheet endpoint reads each account's current balance; it
 * accepts `asOfDate` but does not restate to a past date. So this statement is
 * labelled as today's position rather than offering a date it cannot honour.
 */
const SECTIONS = [
  { type: 'ASSET', label: 'Assets', total: 'Total assets' },
  { type: 'LIABILITY', label: 'Liabilities', total: 'Total liabilities' },
  { type: 'EQUITY', label: 'Equity', total: 'Total equity' },
]
const today = () => new Date().toISOString().split('T')[0]

export default function EnhancedBalanceSheet() {
  const asOfDate = today()
  const { data, loading, error, refetch, dataUpdatedAt } = useResource(
    // Its own key under 'balance-sheet' (so ledger writes still invalidate it):
    // /financial-reports/balance-sheet answers a different shape for the same date.
    ['balance-sheet', 'current', asOfDate],
    ({ signal }) => api.get('/finance/balance-sheet', { params: { asOfDate }, signal }),
    { staleTime: 0 }
  )

  const accounts = data?.accounts || {}
  const totals = data?.totals || {}
  const A = Number(totals.ASSET || 0)
  const L = Number(totals.LIABILITY || 0)
  const E = Number(totals.EQUITY || 0)
  const diff = A - L - E
  const hasLines = SECTIONS.some((s) => (accounts[s.type] || []).length)

  const flat = useMemo(() => SECTIONS.flatMap((s) => (accounts[s.type] || []).map((a) => ({ ...a, section: s.label }))), [accounts])
  const csvColumns = [
    { header: 'Section', accessor: 'section' },
    { header: 'Account code', accessor: 'account_code' },
    { header: 'Account name', accessor: 'account_name' },
    { header: 'Balance', accessor: 'current_balance' },
  ]
  const lineCount = (type) => (accounts[type] || []).length

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Balance sheet"
        description="What the company owns, owes, and the owners' stake — from current account balances."
        meta={data ? <span>As of {formatDate(data.asOfDate || asOfDate)}</span> : null}
        secondary={
          <>
            <Button icon={PrinterIcon} onClick={() => window.print()} disabled={!hasLines}>Print</Button>
            <Button icon={ArrowDownTrayIcon} onClick={() => exportCsv(flat, csvColumns, `balance-sheet-${asOfDate}.csv`)} disabled={!hasLines}>Export</Button>
          </>
        }
      />

      {loading ? (
        <StatementSkeleton rows={10} />
      ) : error ? (
        <ErrorState error={error} what="The balance sheet" onRetry={refetch} />
      ) : !hasLines ? (
        <div className="rounded-lg border border-ink-200 bg-surface">
          <EmptyState
            icon={ScaleIcon}
            title="No active balance sheet accounts"
            description="The balance sheet lists active asset, liability and equity accounts. Activate accounts in the chart of accounts, then post journal entries to them."
            action={<Button variant="primary" to="/finance/chart-of-accounts">Open chart of accounts</Button>}
          />
        </div>
      ) : (
        <div className="space-y-4">
          {data.isBalanced ? null : (
            <InlineNotice tone="risk" title="Assets do not equal liabilities plus equity">
              The difference is {formatMoney(Math.abs(diff))}. Run the trial balance to find the entry posted to one side only.
            </InlineNotice>
          )}

          <StatementFigures
            items={[
              { label: 'Total assets', value: <Provenance method="The sum of the current balance of every active asset account." sources={[{ label: `${lineCount('ASSET')} asset accounts`, value: formatMoney(A), to: '/finance/chart-of-accounts' }]} asOf={dataUpdatedAt}><Money amount={A} /></Provenance> },
              { label: 'Total liabilities', value: <Provenance method="The sum of the current balance of every active liability account." sources={[{ label: `${lineCount('LIABILITY')} liability accounts`, value: formatMoney(L), to: '/finance/chart-of-accounts' }]} asOf={dataUpdatedAt}><Money amount={L} /></Provenance> },
              { label: 'Total equity', value: <Provenance method="Equity accounts plus this period's unclosed earnings (revenue less expenses not yet closed to retained earnings)." sources={[{ label: `${lineCount('EQUITY')} equity lines`, value: formatMoney(E) }, { label: 'Of which unclosed earnings', value: formatMoney(data.currentEarnings) }]} asOf={dataUpdatedAt}><Money amount={E} /></Provenance> },
              { label: 'Check', value: <Provenance method="Assets minus liabilities minus equity. A balanced sheet shows zero." sources={[{ label: 'Assets', value: formatMoney(A) }, { label: 'Liabilities', value: formatMoney(L) }, { label: 'Equity', value: formatMoney(E) }]}><Money amount={diff} /></Provenance>, hint: data.isBalanced ? 'Balanced' : 'Not balanced' },
            ]}
          />

          <Statement caption="Balance sheet" columns={['Balance']}>
            {SECTIONS.map((s) => (
              <StatementSection key={s.type} label={s.label} empty={lineCount(s.type) ? null : `No active ${s.label.toLowerCase()} accounts.`}>
                {(accounts[s.type] || []).map((a) => (
                  <StatementLine
                    key={a.account_code}
                    code={a.is_computed ? null : a.account_code}
                    name={a.account_name}
                    note={a.is_computed ? 'computed' : null}
                    values={[<Money key="b" amount={a.current_balance} />]}
                  />
                ))}
                <StatementTotal level="total" label={s.total} values={[<Money key="t" amount={totals[s.type] ?? 0} />]} />
              </StatementSection>
            ))}
            <tbody>
              <StatementTotal level="grand" label="Total liabilities and equity" values={[<Money key="le" amount={L + E} />]} />
            </tbody>
          </Statement>
          <p className="text-xs text-ink-500">
            Balances are each account's current balance; a dated balance sheet is not available from this endpoint yet. Account lines are not linked to journal lines here — use the trial balance to trace a balance to its postings.
          </p>
        </div>
      )}
    </div>
  )
}
