import { PlusIcon } from '@heroicons/react/20/solid'
import api, { customerInvoicesAPI, customerPaymentsAPI } from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { PageHeader, Button, Card, Stat, Money, Num, SkeletonRows, ErrorState } from '../../components/ui'
import { AgingBar, ModuleLinks } from './FinanceParts'

/**
 * Receivables — what customers owe, how old it is, and where to act on it.
 *
 * Four numbers from /customer-invoices/stats, the age profile from
 * /financial-reports/ar-aging, and the payment count from /customer-payments.
 * A figure the server could not give is shown as "—", never as a zero.
 */

// The aging endpoint answers flat ({ success, summary, detail }) with no
// `data` key; re-wrap so useResource's unwrap hands over the whole body.
const raw = (path) => async ({ signal }) => ({ data: { success: true, data: (await api.get(path, { signal })).data } })

const MODULES = [
  { label: 'Customer invoices', description: 'Bill customers and track what is outstanding', to: '/finance/customer-invoices' },
  { label: 'Payments received', description: 'Money in, applied to invoices', to: '/finance/customer-payments' },
  { label: 'Recurring invoices', description: 'Retainers and subscriptions billed on a schedule', to: '/finance/recurring-invoices' },
  { label: 'Credit notes', description: 'Returns, price adjustments and goodwill', to: '/finance/credit-notes' },
  { label: 'Aging report', description: 'Every open invoice by days overdue', to: '/finance/reports/aging' },
]

export default function ArOverview() {
  const { data: stats, loading: statsLoading } = useResource(['customer-invoices', 'stats'], () => customerInvoicesAPI.stats())
  const { data: aging, loading: agingLoading, error: agingError, refetch } = useResource(['financial-reports', 'ar-aging'], raw('/financial-reports/ar-aging'))
  const { data: payments, loading: paymentsLoading } = useResource(['customer-payments', { limit: 500 }], () => customerPaymentsAPI.list({ limit: 500 }))
  const paymentCount = Array.isArray(payments) ? payments.length : null

  return (
    <>
      <PageHeader
        title="Receivables"
        description="What customers owe you, how old it is, and what came in."
        secondary={<Button to="/finance/customer-payments">Payments received</Button>}
        primary={<Button variant="primary" icon={PlusIcon} to="/finance/customer-invoices">Generate invoice</Button>}
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Outstanding" value={<Money amount={stats?.total_outstanding} digits={0} />} loading={statsLoading} to="/finance/customer-invoices" footnote="Invoiced and not yet collected" />
        <Stat
          label="Overdue"
          value={<Money amount={stats?.overdue_amount} digits={0} />}
          loading={statsLoading}
          to="/finance/reports/aging"
          reason={Number(stats?.overdue_count) > 0 ? `${stats.overdue_count} invoice${Number(stats.overdue_count) === 1 ? '' : 's'} past due date` : undefined}
        />
        <Stat label="Collected" value={<Money amount={stats?.total_collected} digits={0} />} loading={statsLoading} footnote="All time, against invoices" />
        <Stat label="Payments recorded" value={<Num value={paymentCount} />} loading={paymentsLoading} to="/finance/customer-payments" footnote={paymentCount === 500 ? 'First 500 shown' : undefined} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card title="Receivables by age" description="Open customer invoices, by days past their due date">
          {agingLoading ? <SkeletonRows rows={2} columns={3} /> : agingError ? (
            <ErrorState compact error={agingError} what="The aging summary" onRetry={refetch} />
          ) : (
            <AgingBar summary={aging?.summary} empty="No outstanding receivables. Every invoice is paid or not yet issued." note={aging?.note} />
          )}
        </Card>
        <ModuleLinks items={MODULES} />
      </div>
    </>
  )
}
