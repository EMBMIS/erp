import { useState } from 'react'
import { PlusIcon, BanknotesIcon } from '@heroicons/react/20/solid'
import api, { supplierInvoicesAPI, supplierPaymentsAPI } from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, Card, Stat, Money, Num, Code, Badge, Field, Input, SkeletonRows, ErrorState, MaturityBadge,
} from '../../components/ui'
import { AgingBar, ModuleLinks } from './FinanceParts'
import SpendDrivers from '../../components/procurement/SpendDrivers'

/**
 * Payables — what the company owes suppliers, how old it is, and what to pay
 * now. The payment run is advisory: it prices early-payment discounts as an
 * annualised return and ranks bills; settlement still happens in Supplier
 * payments.
 */

// The aging endpoint answers flat ({ success, summary, detail }).
const raw = (path) => async ({ signal }) => ({ data: { success: true, data: (await api.get(path, { signal })).data } })

const MODULES = [
  { label: 'Supplier invoices', description: 'Vendor bills, approval and payment', to: '/finance/supplier-invoices' },
  { label: 'Supplier payments', description: 'Money out to vendors', to: '/finance/supplier-payments' },
  { label: 'Credit notes', description: 'Returns and adjustments', to: '/finance/credit-notes' },
  { label: 'GR/IR clearing', description: 'Goods received, not yet invoiced', to: '/finance/gr-ir-aging' },
  { label: 'Aging report', description: 'Every open bill by days overdue', to: '/finance/reports/aging' },
]

const CATEGORY = {
  CAPTURE_DISCOUNT: { label: 'Discount', tone: 'ok', glyph: 'check' },
  OVERDUE: { label: 'Overdue', tone: 'risk', glyph: 'triangle' },
  DUE_SOON: { label: 'Due soon', tone: 'warn', glyph: 'clock' },
}

function BillRow({ bill, deferred }) {
  const cat = CATEGORY[bill.category]
  return (
    <li className="flex items-start justify-between gap-4 px-4 py-2.5">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2">
          {cat && <Badge tone={cat.tone} glyph={cat.glyph}>{cat.label}</Badge>}
          {deferred && <Badge>Over budget</Badge>}
          <span className="truncate text-sm font-medium text-fg">{bill.supplier_name || 'Unknown supplier'}</span>
          <Code className="text-ink-500">{bill.bill_number}</Code>
        </p>
        <p className="mt-0.5 text-xs text-ink-500">{bill.reason}</p>
      </div>
      <div className="shrink-0 text-right">
        <Money amount={bill.pay_amount} currency={bill.currency} className="text-sm font-medium" />
        {bill.category === 'CAPTURE_DISCOUNT' && bill.discount && (
          <p className="text-xs text-ink-600">saves <Money amount={bill.discount.amount} currency={bill.currency} /></p>
        )}
      </div>
    </li>
  )
}

function PaymentRun() {
  const [cash, setCash] = useState('')
  const [hurdle, setHurdle] = useState('10')
  const [horizon, setHorizon] = useState('7')
  const [params, setParams] = useState({ hurdle: '10', horizon: '7' })
  const { data: run, loading, isFetching, error, refetch } = useResource(
    keys.supplierPaymentRun(params),
    ({ signal }) => supplierInvoicesAPI.paymentRun(params, { signal }),
  )
  const busy = loading || isFetching
  const t = run?.totals

  const submit = (e) => {
    e.preventDefault()
    setParams({ cash: cash === '' ? undefined : cash, hurdle, horizon })
  }

  return (
    <Card
      title={<span className="inline-flex items-center gap-2">Payment run <MaturityBadge level="beta" title="Advisory ranking; nothing is paid from here" /></span>}
      description="What to pay now. Early-payment discounts are priced as an annualised return and paid first when they beat the hurdle rate."
      actions={<Button size="sm" to="/finance/supplier-payments">Make payments</Button>}
    >
      <form onSubmit={submit} className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:items-end">
        <Field label="Cash available" help="Blank means no limit">
          <Input type="number" min="0" step="any" numeric placeholder="Unlimited" value={cash} onChange={(e) => setCash(e.target.value)} />
        </Field>
        <Field label="Hurdle rate" help="% a year">
          <Input type="number" min="0" step="any" numeric value={hurdle} onChange={(e) => setHurdle(e.target.value)} />
        </Field>
        <Field label="Horizon" help="Days ahead">
          <Input type="number" min="0" max="365" numeric value={horizon} onChange={(e) => setHorizon(e.target.value)} />
        </Field>
        <div className="sm:pb-5">
          <Button type="submit" icon={BanknotesIcon} loading={busy} block>Plan run</Button>
        </div>
      </form>

      {error ? (
        <ErrorState compact error={error} what="The payment run" onRetry={refetch} />
      ) : loading ? (
        <SkeletonRows rows={3} columns={3} className="mt-4" />
      ) : t && (
        <>
          <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-ink-200 pt-4 sm:grid-cols-4">
            <div>
              <dt className="label-mono">Pay now</dt>
              <dd className="mt-1 text-lg font-semibold text-fg"><Money amount={t.pay_amount} /></dd>
              <dd className="text-xs text-ink-500">{t.pay_count} bill{t.pay_count === 1 ? '' : 's'}</dd>
            </div>
            <div>
              <dt className="label-mono">Discounts captured</dt>
              <dd className="mt-1 text-lg font-semibold text-fg"><Money amount={t.discounts_captured} /></dd>
            </div>
            <div>
              <dt className="label-mono">Discounts at risk</dt>
              <dd className="mt-1 text-lg font-semibold text-fg"><Money amount={t.discounts_at_risk} /></dd>
              <dd className="text-xs text-ink-500">Not covered by this budget</dd>
            </div>
            <div>
              <dt className="label-mono">Cash left</dt>
              <dd className="mt-1 text-lg font-semibold text-fg">{t.cash_remaining == null ? <span className="text-ink-400" title="No cash limit was set">—</span> : <Money amount={t.cash_remaining} />}</dd>
            </div>
          </dl>

          {run.pay.length === 0 && run.deferred.length === 0 ? (
            <p className="mt-4 text-sm text-ink-600">Nothing needs paying now: no open discounts, overdue or soon-due bills.</p>
          ) : (
            <ul className="-mx-4 mt-4 divide-y divide-ink-100 border-t border-ink-200">
              {run.pay.map((b) => <BillRow key={b.id} bill={b} />)}
              {run.deferred.map((b) => <BillRow key={b.id} bill={b} deferred />)}
            </ul>
          )}
          {run.hold.length > 0 && (
            <p className="mt-3 text-xs text-ink-500">{run.hold.length} other open bill{run.hold.length === 1 ? '' : 's'} can wait until term.</p>
          )}
        </>
      )}
    </Card>
  )
}

export default function ApOverview() {
  const { data: stats, loading: statsLoading } = useResource(keys.supplierInvoices('stats'), () => supplierInvoicesAPI.stats())
  const { data: aging, loading: agingLoading, error: agingError, refetch } = useResource(['financial-reports', 'ap-aging'], raw('/financial-reports/ap-aging'))
  const { data: payments, loading: paymentsLoading } = useResource(['supplier-payments', { limit: 500 }], () => supplierPaymentsAPI.list({ limit: 500 }))
  const paymentCount = Array.isArray(payments) ? payments.length : null

  return (
    <>
      <PageHeader
        title="Payables"
        description="What you owe suppliers, how old it is, and what to pay now."
        secondary={<Button to="/finance/supplier-payments">Supplier payments</Button>}
        primary={<Button variant="primary" icon={PlusIcon} to="/finance/supplier-invoices">Record bill</Button>}
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Outstanding" value={<Money amount={stats?.total_outstanding} digits={0} />} loading={statsLoading} to="/finance/supplier-invoices" footnote="Billed and not yet paid" />
        <Stat
          label="Overdue"
          value={<Money amount={stats?.overdue_amount} digits={0} />}
          loading={statsLoading}
          to="/finance/reports/aging"
          reason={Number(stats?.overdue_count) > 0 ? `${stats.overdue_count} bill${Number(stats.overdue_count) === 1 ? '' : 's'} past due date` : undefined}
        />
        <Stat label="Open bills" value={<Num value={stats?.open_count} />} loading={statsLoading} footnote="Approved or partly paid" />
        <Stat label="Payments recorded" value={<Num value={paymentCount} />} loading={paymentsLoading} to="/finance/supplier-payments" footnote={paymentCount === 500 ? 'First 500 shown' : undefined} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-5">
          <Card title="Payables by age" description="Open supplier bills, by days past their due date">
            {agingLoading ? <SkeletonRows rows={2} columns={3} /> : agingError ? (
              <ErrorState compact error={agingError} what="The aging summary" onRetry={refetch} />
            ) : (
              <AgingBar summary={aging?.summary} empty="No outstanding payables. Every bill is paid or not yet recorded." note={aging?.note} />
            )}
          </Card>
          <PaymentRun />
          <SpendDrivers />
        </div>
        <ModuleLinks items={MODULES} />
      </div>
    </>
  )
}
