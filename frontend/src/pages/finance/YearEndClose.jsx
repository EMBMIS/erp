import { useState } from 'react'
import { ArrowPathIcon, LockClosedIcon, CalendarDaysIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, Field, Select, InlineNotice, ErrorState, EmptyState, ConfirmDialog, Money, Provenance, formatMoney, notify,
} from '../../components/ui'
import { Statement, StatementSection, StatementLine, StatementTotal, StatementSkeleton, StatementFigures } from './StatementParts'

/**
 * Year-end close — zero the year's revenue and expense accounts and transfer
 * the net result to Retained Earnings (account 3200).
 */
export default function YearEndClose() {
  const thisYear = new Date().getFullYear()
  const [year, setYear] = useState(thisYear - 1)
  const [confirm, setConfirm] = useState(false)
  const [result, setResult] = useState(null)

  // This endpoint answers with { success, fiscal_year, accounts, ... } at the
  // top level, not under `data`; the fetcher re-wraps the flat body so
  // useResource's unwrap keeps every field.
  // staleTime: 0 — a projection off the live ledger; stale data right before
  // executing the close is the worst place for it.
  const { data: preview, loading, error, refetch, isFetching } = useResource(
    keys.yearEndPreview(year),
    ({ signal }) => api.get(`/financial-reports/year-end-preview?year=${year}`, { signal })
      .then((res) => ({ data: { success: res.data?.success !== false, error: res.data?.error, data: res.data } })),
    { staleTime: 0 }
  )

  // Posting closing entries changes every ledger-derived report.
  const executeClose = useResourceMutation(
    () => api.post('/financial-reports/year-end-close', { year, reason: `Year-End Financial Close FY${year}` })
      .then((res) => ({ data: { success: res.data?.success !== false, error: res.data?.error, data: res.data } })),
    { invalidates: [['year-end-preview'], ['trial-balance'], ['balance-sheet'], ['income-statement'], ['journal-entries']], silent: true }
  )

  const run = async () => {
    try {
      const res = await executeClose.mutateAsync()
      setConfirm(false)
      setResult({ ok: true, year, transferred: res?.net_income_transferred })
      notify.success(`FY${year} closed`)
    } catch (e) {
      setConfirm(false)
      setResult({ ok: false, error: e })
    }
  }

  const accounts = preview?.accounts || []
  const revenue = accounts.filter((a) => a.type === 'REVENUE')
  const expenses = accounts.filter((a) => a.type !== 'REVENUE')
  const net = Number(preview?.net_income || 0)

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Year-end close"
        description="Zero the year's revenue and expense accounts and move the net result into Retained Earnings (account 3200)."
        secondary={<Button icon={ArrowPathIcon} onClick={() => refetch()} loading={isFetching && !loading}>Refresh preview</Button>}
        primary={
          <Button variant="primary" icon={LockClosedIcon} onClick={() => setConfirm(true)} disabled={!preview || !accounts.length || executeClose.isPending}
            title={!accounts.length ? 'Nothing to close for this year' : undefined}>
            Post FY{year} closing entries
          </Button>
        }
      />

      <div className="mb-4">
        <Field label="Fiscal year" className="w-44">
          <Select value={year} onChange={(e) => { setYear(Number(e.target.value)); setResult(null) }}>
            {Array.from({ length: 5 }, (_, i) => thisYear - i).map((y) => <option key={y} value={y}>FY{y}</option>)}
          </Select>
        </Field>
      </div>

      {result?.ok && (
        <InlineNotice tone="ok" className="mb-4" title={`FY${result.year} is closed`}>
          Closing entries were posted. Net income transferred to Retained Earnings: {formatMoney(result.transferred)}.
        </InlineNotice>
      )}
      {result && !result.ok && (
        <ErrorState className="mb-4" compact error={result.error} what={`The FY${year} close`} />
      )}

      {loading ? (
        <StatementSkeleton rows={8} />
      ) : error ? (
        <ErrorState error={error} what="The year-end preview" onRetry={refetch} />
      ) : !accounts.length ? (
        <div className="rounded-lg border border-ink-200 bg-surface">
          <EmptyState icon={CalendarDaysIcon} title={`No revenue or expense balances in FY${year}`} description="There is nothing to close for this year. Choose another year, or check that the year's entries are posted." />
        </div>
      ) : (
        <div className="space-y-4">
          <StatementFigures
            items={[
              { label: 'Revenue', value: <Money amount={preview.total_revenue} />, hint: `${revenue.length} account${revenue.length === 1 ? '' : 's'}` },
              { label: 'Expenses', value: <Money amount={preview.total_expense} />, hint: `${expenses.length} account${expenses.length === 1 ? '' : 's'}` },
              {
                label: 'To retained earnings',
                value: <Provenance method={`FY${year} revenue minus expenses, from posted journal lines. This amount moves to Retained Earnings (3200).`} sources={[{ label: 'Revenue', value: formatMoney(preview.total_revenue) }, { label: 'Expenses', value: formatMoney(preview.total_expense) }]}><Money amount={net} /></Provenance>,
                hint: net >= 0 ? 'Net income' : 'Net loss',
              },
            ]}
          />
          <Statement caption={`Accounts zeroed by the FY${year} close`} columns={['Balance']}>
            <StatementSection label="Revenue" empty={revenue.length ? null : 'No revenue balances.'}>
              {revenue.map((a) => <StatementLine key={a.id || a.code} code={a.code} name={a.name} accountId={a.id} dateFrom={`${year}-01-01`} dateTo={`${year}-12-31`} values={[<Money key="b" amount={a.balance} />]} />)}
              <StatementTotal label="Total revenue" values={[<Money key="t" amount={preview.total_revenue} />]} />
            </StatementSection>
            <StatementSection label="Expenses" empty={expenses.length ? null : 'No expense balances.'}>
              {expenses.map((a) => <StatementLine key={a.id || a.code} code={a.code} name={a.name} accountId={a.id} dateFrom={`${year}-01-01`} dateTo={`${year}-12-31`} values={[<Money key="b" amount={a.balance} />]} />)}
              <StatementTotal label="Total expenses" values={[<Money key="t" amount={preview.total_expense} />]} />
            </StatementSection>
            <tbody>
              <StatementTotal level="grand" label="Transfer to retained earnings" values={[<Money key="n" amount={net} />]} />
            </tbody>
          </Statement>
        </div>
      )}

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={run}
        title={`Post the FY${year} closing entries?`}
        consequence={`Closing entries zero ${preview?.accounts_count ?? accounts.length} revenue and expense accounts and transfer ${formatMoney(net)} to Retained Earnings (3200).`}
        reversible={false}
        confirmText={`FY${year}`}
        confirmLabel={`Close FY${year}`}
        tone="primary"
        busy={executeClose.isPending}
      />
    </div>
  )
}
