import { Link } from 'react-router-dom'
import { ChevronRightIcon, PlusIcon } from '@heroicons/react/20/solid'
import { chartOfAccountsAPI, journalEntriesAPI, financialReportsAPI } from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { PageHeader, Button, Card, Stat, Num, Money, Provenance, formatMoney, formatNumber } from '../../components/ui'

/**
 * General ledger — the area's overview: how big the chart is, what is waiting
 * to post, and whether the trial balance agrees. Each number opens its records.
 */
function AreaLinks({ items }) {
  return (
    <Card title="In this area" padded={false}>
      <ul className="divide-y divide-ink-100">
        {items.map((it) => (
          <li key={it.to}>
            <Link to={it.to} className="flex items-center gap-3 px-4 py-3 hover:bg-ink-50">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-fg">{it.name}</span>
                <span className="block text-xs text-ink-500">{it.description}</span>
              </span>
              {it.stat && <span className="shrink-0 text-right text-xs tabular-nums text-ink-600">{it.stat}</span>}
              <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  )
}

export default function GlOverview() {
  const { data: coa, loading: coaLoading } = useResource(keys.chartOfAccountsStats(), () => chartOfAccountsAPI.getStats())
  const { data: je, loading: jeLoading } = useResource(keys.journalEntriesStats(), () => journalEntriesAPI.getStats(), { staleTime: 0 })
  const { data: tbRows, loading: tbLoading, error: tbError } = useResource(keys.trialBalance(null), () => financialReportsAPI.getTrialBalance(), { staleTime: 0 })

  const tb = Array.isArray(tbRows) ? tbRows : []
  const tbDebits = tb.reduce((s, r) => s + Number(r.total_debits || 0), 0)
  const tbCredits = tb.reduce((s, r) => s + Number(r.total_credits || 0), 0)
  const balanced = Math.abs(tbDebits - tbCredits) < 0.01

  return (
    <div className="space-y-5">
      <PageHeader
        title="General ledger"
        description="The chart of accounts, journal entries and the trial balance."
        primary={<Button variant="primary" icon={PlusIcon} to="/finance/journal-entries/create">New journal entry</Button>}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Accounts" value={<Num value={coa?.total_accounts} />} loading={coaLoading} reason={coa ? `${formatNumber(coa.active_accounts)} active · ${formatNumber(coa.pending_approval)} waiting approval` : null} to="/finance/chart-of-accounts" />
        <Stat label="Journal entries" value={<Num value={je?.total_entries} />} loading={jeLoading} reason={je ? `${formatNumber(je.posted_entries)} posted` : null} to="/finance/journal-entries" />
        <Stat label="Waiting approval" value={<Num value={je?.pending_approvals} />} loading={jeLoading} reason="Entries not yet on the ledger" to="/finance/journal-entries" />
        <div className="flex min-w-0 flex-col rounded-lg border border-ink-200 bg-surface p-4">
          <p className="label-mono">Trial balance</p>
          <div className="mt-2 text-2xl font-semibold tracking-tight text-fg">
            {tbLoading ? <span className="skeleton block h-7 w-24" /> : tbError ? <span className="text-ink-400">—</span> : (
              <Provenance
                method="Gross posted debits against gross posted credits across every account, as of today."
                sources={[{ label: 'Debits', value: formatMoney(tbDebits) }, { label: 'Credits', value: formatMoney(tbCredits) }, { label: 'Open the trial balance', to: '/finance/reports/trial-balance' }]}
              >
                {balanced ? 'Balanced' : 'Out of balance'}
              </Provenance>
            )}
          </div>
          <p className="mt-1.5 text-xs text-ink-600">
            {tbError ? 'The trial balance did not load.' : tbLoading ? '' : balanced ? <>Debits = credits = <Money amount={tbDebits} /></> : <>Difference <Money amount={tbDebits - tbCredits} /></>}
          </p>
        </div>
      </div>

      <AreaLinks
        items={[
          { name: 'Chart of accounts', description: 'Accounts and their structure', to: '/finance/chart-of-accounts', stat: coa ? `${formatNumber(coa.total_accounts)} accounts` : null },
          { name: 'Journal entries', description: 'Record, approve, post and reverse', to: '/finance/journal-entries', stat: je ? `${formatNumber(je.total_entries)} entries` : null },
          { name: 'Journal activity', description: 'Volume by day, source and account', to: '/finance/journal-dashboard' },
          { name: 'Trial balance', description: 'Debits against credits, by account', to: '/finance/reports/trial-balance' },
          { name: 'Accounting periods', description: 'Open and close months', to: '/finance/periods' },
          { name: 'Financial reports', description: 'Balance sheet, income statement, cash flow', to: '/finance/reports-overview' },
        ]}
      />
    </div>
  )
}
