import { Link } from 'react-router-dom'
import {
  ArrowDownOnSquareIcon, ArrowUpOnSquareIcon, ArrowUturnLeftIcon, ArrowsRightLeftIcon, AdjustmentsHorizontalIcon,
  ChevronRightIcon, ClockIcon, SparklesIcon,
} from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { PageHeader, Button, Stat, Num, Money, Card, Code, StatusBadge, Badge, DateText, EmptyState, ErrorState, SkeletonRows } from '../../components/ui'
import { asList, TX_TYPES } from './warehouseData'

const ACTIONS = [
  { type: 'GR', icon: ArrowDownOnSquareIcon, hint: 'Book goods into stock — against a PO or by hand.' },
  { type: 'GI', icon: ArrowUpOnSquareIcon, hint: 'Take stock out — for a sales order, work order or cost centre.' },
  { type: 'GE', icon: ArrowUturnLeftIcon, hint: 'Send back to a supplier, or take back from a customer.' },
  { type: 'GT', icon: ArrowsRightLeftIcon, hint: 'Move stock between bins or locations.' },
  { type: 'SA', icon: AdjustmentsHorizontalIcon, hint: 'Correct stock after a count, damage or loss.' },
]

const itemsLabel = (tx) => {
  const items = tx.items || []
  if (!items.length) return 'No lines'
  return `${items[0].item_name || 'Item'}${items.length > 1 ? ` +${items.length - 1} more` : ''}`
}

/**
 * Warehouse transactions — the five movements, one tap each, and what moved
 * recently. On a phone or scanner the movements are the screen.
 */
export default function WarehouseTransactions() {
  const { data: stats, loading: statsLoading } = useResource(['warehouse-transactions-stats'], ({ signal }) => api.get('/warehouse/transactions/stats', { signal }))
  const { data: rawTx, loading, error, refetch } = useResource(keys.warehouseTransactions({ limit: 10 }), ({ signal }) => api.get('/warehouse/transactions', { params: { limit: 10 }, signal }))
  const recent = asList(rawTx)

  return (
    <div className="space-y-5">
      <PageHeader
        title="Warehouse transactions"
        description="Every physical stock movement, posted to stock and the ledger."
        secondary={<>
          <Button icon={SparklesIcon} to={`/ai/chat?q=${encodeURIComponent('Where is the warehouse losing time or space, and what should change?')}`}>Ask Simeli</Button>
          <Button icon={ClockIcon} to="/warehouse/transactions/history">History</Button>
        </>}
        primary={<Button variant="primary" icon={ArrowDownOnSquareIcon} to={TX_TYPES.GR.to}>Receive goods</Button>}
      />

      <nav aria-label="New transaction" className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {ACTIONS.map((a) => (
          <Link key={a.type} to={TX_TYPES[a.type].to} className="group flex min-h-[64px] items-center gap-3 rounded-lg border border-ink-200 bg-surface px-4 py-3 hover:border-ink-400 lg:flex-col lg:items-start">
            <a.icon className="h-5 w-5 shrink-0 text-ink-500 group-hover:text-ink-900" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-sm font-medium text-fg">{TX_TYPES[a.type].label} <Code className="text-2xs text-ink-500">{a.type}</Code></span>
              <span className="mt-0.5 block text-xs text-ink-500">{a.hint}</span>
            </span>
            <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-400 lg:hidden" aria-hidden="true" />
          </Link>
        ))}
      </nav>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Today" value={<Num value={stats?.todayTransactions} />} loading={statsLoading} to="/warehouse/transactions/history" />
        <Stat label="This week" value={<Num value={stats?.weeklyTransactions} />} loading={statsLoading} />
        <Stat label="Awaiting approval" value={<Num value={stats?.pendingApprovals} />} loading={statsLoading} reason={Number(stats?.pendingApprovals) ? 'Large adjustments wait for a manager.' : undefined} />
        <Stat label="Value moved this year" value={<Money amount={stats?.stockValue} digits={0} />} loading={statsLoading} footnote="Sum of transaction values this year" />
      </div>

      <Card title="Recent transactions" actions={<Button size="sm" variant="ghost" to="/warehouse/transactions/history">All history</Button>} padded={false}>
        {loading ? (
          <SkeletonRows rows={4} columns={4} />
        ) : error ? (
          <ErrorState what="Recent transactions" error={error} onRetry={refetch} compact />
        ) : !recent.length ? (
          <EmptyState compact title="Nothing has moved yet" description="Receive goods to put the first stock on the shelves." action={<Button variant="primary" to={TX_TYPES.GR.to}>Receive goods</Button>} />
        ) : (
          <ul className="divide-y divide-ink-100">
            {recent.map((tx) => (
              <li key={tx.id} className="flex min-h-[56px] items-center gap-3 px-4 py-2.5">
                <Badge mono className="w-9 justify-center">{tx.transaction_type}</Badge>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2 text-sm">
                    <Code className="text-fg">{tx.reference_document || tx.transaction_number || `${tx.transaction_type}-${String(tx.id).slice(0, 8)}`}</Code>
                    <StatusBadge status={tx.status} />
                  </span>
                  <span className="block truncate text-xs text-ink-500">{itemsLabel(tx)}</span>
                </span>
                <span className="shrink-0 text-right">
                  <Num value={tx.total_quantity} className="block text-sm" />
                  <DateText value={tx.created_at} relative className="text-2xs text-ink-500" />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
