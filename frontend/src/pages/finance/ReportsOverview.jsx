import { Link } from 'react-router-dom'
import { ChevronRightIcon } from '@heroicons/react/20/solid'
import { chartOfAccountsAPI, journalEntriesAPI, financialReportsAPI } from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { PageHeader, Button, Card, Stat, Num, Money, Provenance, formatMoney, formatNumber } from '../../components/ui'

/**
 * Financial reports — the statements and period-end screens, with the three
 * readings that say whether the ledger they are built from can be trusted.
 */
function ReportGroup({ title, items }) {
  return (
    <Card title={title} padded={false}>
      <ul className="divide-y divide-ink-100">
        {items.map((it) => (
          <li key={it.to}>
            <Link to={it.to} className="flex items-center gap-3 px-4 py-3 hover:bg-ink-50">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-fg">{it.name}</span>
                <span className="block text-xs text-ink-500">{it.description}</span>
              </span>
              <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  )
}

export default function ReportsOverview() {
  // staleTime: 0 on the trial balance — a card that misses a just-posted
  // journal entry is worse than the extra refetch.
  const { data: coa, loading: coaLoading } = useResource(keys.chartOfAccountsStats(), () => chartOfAccountsAPI.getStats())
  const { data: je, loading: jeLoading } = useResource(keys.journalEntriesStats(), () => journalEntriesAPI.getStats())
  const { data: tbRows, loading: tbLoading, error: tbError } = useResource(keys.trialBalance(null), () => financialReportsAPI.getTrialBalance(), { staleTime: 0 })

  const tb = Array.isArray(tbRows) ? tbRows : []
  const dr = tb.reduce((s, r) => s + Number(r.total_debits || 0), 0)
  const cr = tb.reduce((s, r) => s + Number(r.total_credits || 0), 0)
  const balanced = Math.abs(dr - cr) < 0.01

  return (
    <div className="space-y-5">
      <PageHeader
        title="Financial reports"
        description="Statements, ageing, VAT and the period-end close — all built from the posted ledger."
        primary={<Button variant="primary" to="/finance/reports/trial-balance">Run trial balance</Button>}
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Accounts" value={<Num value={coa?.total_accounts} />} loading={coaLoading} reason={coa ? `${formatNumber(coa.active_accounts)} active — only these appear on statements` : null} to="/finance/chart-of-accounts" />
        <Stat label="Posted entries" value={<Num value={je?.posted_entries} />} loading={jeLoading} reason={je ? `of ${formatNumber(je.total_entries)} entries; ${formatNumber(je.pending_approvals)} waiting approval` : null} to="/finance/journal-entries" />
        <div className="flex min-w-0 flex-col rounded-lg border border-ink-200 bg-surface p-4">
          <p className="label-mono">Trial balance today</p>
          <div className="mt-2 text-2xl font-semibold tracking-tight text-fg">
            {tbLoading ? <span className="skeleton block h-7 w-24" /> : tbError ? <span className="text-ink-400">—</span> : (
              <Provenance method="Gross posted debits against gross posted credits across every account." sources={[{ label: 'Debits', value: formatMoney(dr) }, { label: 'Credits', value: formatMoney(cr) }, { label: 'Open the trial balance', to: '/finance/reports/trial-balance' }]}>
                {balanced ? 'Balanced' : 'Out of balance'}
              </Provenance>
            )}
          </div>
          <p className="mt-1.5 text-xs text-ink-600">
            {tbError ? 'The trial balance did not load.' : tbLoading ? '' : balanced ? <>Debits and credits <Money amount={dr} /></> : <>Difference <Money amount={dr - cr} /></>}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <ReportGroup
          title="Statements"
          items={[
            { name: 'Trial balance', description: 'Every account, debits against credits', to: '/finance/reports/trial-balance' },
            { name: 'Balance sheet', description: 'Assets, liabilities and equity', to: '/finance/reports/balance-sheet' },
            { name: 'Income statement', description: 'Revenue less expenses', to: '/finance/reports/income-statement' },
            { name: 'Cash flow statement', description: 'Operating, investing and financing cash', to: '/finance/reports/cash-flow-statement' },
            { name: 'Report pack', description: 'Statements laid out for print', to: '/finance/reports' },
          ]}
        />
        <ReportGroup
          title="Sub-ledgers and period end"
          items={[
            { name: 'Ageing (AR/AP)', description: 'Outstanding receivables and payables by age', to: '/finance/reports/aging' },
            { name: 'GR/IR ageing', description: 'Goods received against invoices', to: '/finance/gr-ir-aging' },
            { name: 'VAT return', description: 'Output against input VAT for a period', to: '/finance/reports/vat' },
            { name: 'Accounting periods', description: 'Close months and lock the ledger', to: '/finance/periods' },
            { name: 'Year-end close', description: 'Move the year’s result to retained earnings', to: '/finance/year-end-close' },
          ]}
        />
      </div>
    </div>
  )
}
