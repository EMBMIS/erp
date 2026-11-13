import { useState } from 'react'
import { PlusIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import {
  PageHeader, Button, Card, Stat, Segmented, Select, Money, Num, Code, DateText, StatusBadge, ErrorState, SkeletonRows,
  Provenance, LineChart, formatMoney, formatNumber,
} from '../../components/ui'

/**
 * Journal activity — how much is being posted, from where, and to which
 * accounts, over a period. Every figure comes from /finance/journal-dashboard.
 */
const PERIODS = [
  { value: '7days', label: '7 days' },
  { value: '30days', label: '30 days' },
  { value: '90days', label: '90 days' },
  { value: 'ytd', label: 'Year to date' },
]
const STATUSES = [['all', 'All statuses'], ['DRAFT', 'Draft'], ['PENDING_APPROVAL', 'Waiting approval'], ['APPROVED', 'Approved'], ['POSTED', 'Posted'], ['REJECTED', 'Rejected'], ['REVERSED', 'Reversed']]
const humanize = (s) => String(s || '').toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

function SimpleTable({ caption, head, children }) {
  return (
    <div className="overflow-x-auto ui-scroll">
      <table className="w-full min-w-[420px] text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-ink-200">
            {head.map(([label, right]) => <th key={label} scope="col" className={`label-mono px-4 py-2 font-normal ${right ? 'text-right' : 'text-left'}`}>{label}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">{children}</tbody>
      </table>
    </div>
  )
}

export default function JournalEntriesDashboard() {
  const [period, setPeriod] = useState('30days')
  const [status, setStatus] = useState('all')

  const { data, loading, error, refetch } = useResource(
    ['journal-entries', 'dashboard', period, status],
    ({ signal }) => api.get('/finance/journal-dashboard', { params: { period, status }, signal }),
    { staleTime: 0 }
  )
  const summary = data?.summary || {}
  const daily = data?.dailyActivity || []
  const sources = data?.sourceTypes || []
  const accounts = data?.accountActivity || []
  const recent = data?.recentEntries || []
  const dr = summary.total_debits == null ? null : Number(summary.total_debits)
  const cr = summary.total_credits == null ? null : Number(summary.total_credits)
  const diff = dr != null && cr != null ? dr - cr : null
  const periodLabel = PERIODS.find((p) => p.value === period)?.label.toLowerCase()

  return (
    <div className="space-y-5">
      <PageHeader
        title="Journal activity"
        description="What is being posted to the ledger, from where, and to which accounts."
        primary={<Button variant="primary" icon={PlusIcon} to="/finance/journal-entries/create">New entry</Button>}
      />

      <div className="-mt-2 flex min-w-0 flex-wrap items-center gap-2">
        <Segmented label="Period" options={PERIODS} value={period} onChange={setPeriod} size="md" className="max-w-full overflow-x-auto" />
        <div className="w-40 shrink-0">
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </div>
      </div>

      {error ? (
        <ErrorState error={error} what="Journal activity" onRetry={refetch} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Entries" value={<Num value={summary.total_entries} />} loading={loading} reason={summary.posted_entries != null ? `${formatNumber(summary.posted_entries)} posted` : null} to="/finance/journal-entries" />
            <Stat label="Debits" value={<Money amount={dr} />} loading={loading} reason={`Last ${periodLabel}`} />
            <Stat label="Credits" value={<Money amount={cr} />} loading={loading} reason={`Last ${periodLabel}`} />
            <div className="flex min-w-0 flex-col rounded-lg border border-ink-200 bg-surface p-4">
              <p className="label-mono">Debits − credits</p>
              <div className="mt-2 text-2xl font-semibold tabular-nums tracking-tight text-fg">
                {loading ? <span className="skeleton block h-7 w-24" /> : diff == null ? <span className="text-ink-400">—</span> : (
                  <Provenance method="Sum of entry debits minus sum of entry credits for the entries in view. Every balanced entry contributes zero." sources={[{ label: 'Debits', value: formatMoney(dr) }, { label: 'Credits', value: formatMoney(cr) }]}>
                    <Money amount={diff} />
                  </Provenance>
                )}
              </div>
              {!loading && diff != null && <p className="mt-1.5 text-xs text-ink-600">{Math.abs(diff) < 0.01 ? 'Every entry in view balances.' : 'Some entries in view do not balance.'}</p>}
            </div>
          </div>

          <Card title="Entries per day" description={`Journal entries dated in the last ${periodLabel}`}>
            {loading ? <SkeletonRows rows={4} columns={2} /> : daily.length < 2 ? (
              <p className="text-sm text-ink-600">{daily.length ? `${formatNumber(daily[0].volume)} entr${Number(daily[0].volume) === 1 ? 'y' : 'ies'} on ${daily[0].date}. A trend needs at least two days with entries.` : 'No entries in this period.'}</p>
            ) : (
              <LineChart title="Entries per day" points={daily.map((d) => ({ x: d.date, y: Number(d.volume) || 0 }))} format={(v) => formatNumber(v)} height={180} />
            )}
          </Card>

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <Card title="By source" padded={false}>
              {loading ? <SkeletonRows rows={3} columns={3} /> : !sources.length ? <p className="px-4 py-4 text-sm text-ink-600">No entries in this period.</p> : (
                <SimpleTable caption="Entries by source" head={[['Source'], ['Entries', true], ['Debits', true]]}>
                  {sources.map((s) => (
                    <tr key={s.source_type}>
                      <td className="px-4 py-2">{humanize(s.source_type)}</td>
                      <td className="px-4 py-2 text-right"><Num value={s.entry_count} /></td>
                      <td className="px-4 py-2 text-right"><Money amount={s.total_amount} /></td>
                    </tr>
                  ))}
                </SimpleTable>
              )}
            </Card>
            <Card title="Most active accounts" description="Top ten by number of lines" padded={false}>
              {loading ? <SkeletonRows rows={3} columns={3} /> : !accounts.length ? <p className="px-4 py-4 text-sm text-ink-600">No lines posted to active accounts in this period.</p> : (
                <SimpleTable caption="Most active accounts" head={[['Account'], ['Type'], ['Lines', true], ['Amount', true]]}>
                  {accounts.map((a) => (
                    <tr key={a.account_code}>
                      <td className="px-4 py-2"><span className="flex items-baseline gap-2"><Code className="text-ink-500">{a.account_code}</Code><span className="truncate">{a.account_name}</span></span></td>
                      <td className="px-4 py-2 text-ink-600">{humanize(a.account_type)}</td>
                      <td className="px-4 py-2 text-right"><Num value={a.transaction_count} /></td>
                      <td className="px-4 py-2 text-right"><Money amount={a.total_activity} /></td>
                    </tr>
                  ))}
                </SimpleTable>
              )}
            </Card>
          </div>

          <Card title="Recent entries" description="The latest 20 in this period" padded={false} actions={<Button size="sm" variant="ghost" to="/finance/journal-entries">All entries</Button>}>
            {loading ? <SkeletonRows rows={4} columns={5} /> : !recent.length ? <p className="px-4 py-4 text-sm text-ink-600">No entries in this period.</p> : (
              <SimpleTable caption="Recent journal entries" head={[['Entry'], ['Date'], ['Description'], ['Status'], ['Debits', true]]}>
                {recent.map((e) => (
                  <tr key={e.journal_number}>
                    <td className="whitespace-nowrap px-4 py-2"><Code>{e.journal_number}</Code></td>
                    <td className="whitespace-nowrap px-4 py-2"><DateText value={e.entry_date} /></td>
                    <td className="px-4 py-2"><span className="block">{e.description || e.reference || '—'}</span><span className="block text-xs text-ink-500">{humanize(e.source_type || 'MANUAL')}{e.created_by_name ? ` · ${e.created_by_name}` : ''}</span></td>
                    <td className="px-4 py-2"><StatusBadge status={e.status} /></td>
                    <td className="px-4 py-2 text-right"><Money amount={e.total_debit} /></td>
                  </tr>
                ))}
              </SimpleTable>
            )}
          </Card>
        </>
      )}
    </div>
  )
}
