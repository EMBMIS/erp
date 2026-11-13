import { useState } from 'react'
import { BanknotesIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { keys } from '../../services/queryKeys'
import { useResource } from '../../hooks/useResource'
import {
  PageHeader, Button, Field, Input, InlineNotice, ErrorState, EmptyState, Money, Provenance, formatMoney,
} from '../../components/ui'
import { Statement, StatementSection, StatementLine, StatementTotal, StatementSkeleton, StatementFigures } from './StatementParts'

/**
 * Cash flow statement — indirect method, derived from posted GL movements in
 * the period. Each adjustment line opens the journal lines behind it.
 */
const today = () => new Date().toISOString().split('T')[0]
const startOfYear = () => `${new Date().getFullYear()}-01-01`

export default function CashFlowStatement() {
  const [dateFrom, setDateFrom] = useState(startOfYear())
  const [dateTo, setDateTo] = useState(today())

  const { data, loading, error, refetch } = useResource(
    keys.cashFlowStatement(dateFrom, dateTo),
    ({ signal }) => api.get(
      `/financial-reports/cash-flow-statement?${new URLSearchParams({ date_from: dateFrom, date_to: dateTo })}`,
      { signal }
    ),
    { staleTime: 0 }
  )

  const op = data?.operating_activities
  const inv = data?.investing_activities
  const fin = data?.financing_activities
  const line = (l) => (
    <StatementLine
      key={l.account_code}
      code={l.account_code}
      name={l.label}
      accountId={l.account_id}
      dateFrom={dateFrom}
      dateTo={dateTo}
      values={[<Money key="a" amount={l.amount} />]}
    />
  )
  const period = `${dateFrom} to ${dateTo}`

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Cash flow statement"
        description="Where cash came from and went in the period — indirect method, from posted ledger movements."
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="From" className="w-44">
          <Input type="date" value={dateFrom} max={dateTo} onChange={(e) => setDateFrom(e.target.value)} />
        </Field>
        <Field label="To" className="w-44">
          <Input type="date" value={dateTo} min={dateFrom} onChange={(e) => setDateTo(e.target.value)} />
        </Field>
      </div>

      {loading ? (
        <StatementSkeleton rows={10} />
      ) : error ? (
        <ErrorState error={error} what="The cash flow statement" onRetry={refetch} />
      ) : !data ? (
        <div className="rounded-lg border border-ink-200 bg-surface">
          <EmptyState icon={BanknotesIcon} title="No cash flow for this period" description="Choose a period with posted journal entries." action={<Button to="/finance/journal-entries">Open journal entries</Button>} />
        </div>
      ) : (
        <div className="space-y-4">
          {data.ties_to_trial_balance ? (
            <InlineNotice tone="ok" title="Ties to the trial balance">
              The ending cash below equals the cash accounts on the trial balance at {dateTo}.
            </InlineNotice>
          ) : (
            <InlineNotice tone="risk" title="Does not tie to the trial balance">
              Ending cash differs from the cash accounts on the trial balance. Check for postings to cash that are not classified here.
            </InlineNotice>
          )}

          <StatementFigures
            items={[
              { label: 'Cash at start', value: <Money amount={data.cash_beginning} />, hint: dateFrom },
              {
                label: 'Net change',
                value: (
                  <Provenance
                    method="Operating plus investing plus financing activities in the period."
                    sources={[
                      { label: 'Operating', value: formatMoney(op?.net_cash_from_operating) },
                      { label: 'Investing', value: formatMoney(inv?.net_cash_from_investing) },
                      { label: 'Financing', value: formatMoney(fin?.net_cash_from_financing) },
                    ]}
                  >
                    <Money amount={data.net_change_in_cash} signed />
                  </Provenance>
                ),
                hint: period,
              },
              {
                label: 'Cash at end',
                value: (
                  <Provenance method="Cash at the start of the period plus the net change." sources={[{ label: 'Cash at start', value: formatMoney(data.cash_beginning) }, { label: 'Net change', value: formatMoney(data.net_change_in_cash) }]}>
                    <Money amount={data.cash_ending} />
                  </Provenance>
                ),
                hint: dateTo,
              },
            ]}
          />

          <Statement caption={`Cash flow statement, ${period}`} columns={['Amount']}>
            <StatementSection label="Operating activities">
              <StatementLine name="Net income" values={[<Money key="a" amount={op?.net_income} />]} note="from the income statement" />
              {(op?.adjustments || []).map(line)}
              <StatementTotal label="Net cash from operating activities" values={[<Money key="t" amount={op?.net_cash_from_operating} />]} />
            </StatementSection>
            <StatementSection label="Investing activities" empty={inv?.lines?.length ? null : 'No investing movements.'}>
              {(inv?.lines || []).map(line)}
              <StatementTotal label="Net cash from investing activities" values={[<Money key="t" amount={inv?.net_cash_from_investing} />]} />
            </StatementSection>
            <StatementSection label="Financing activities" empty={fin?.lines?.length ? null : 'No financing movements.'}>
              {(fin?.lines || []).map(line)}
              <StatementTotal label="Net cash from financing activities" values={[<Money key="t" amount={fin?.net_cash_from_financing} />]} />
            </StatementSection>
            <tbody>
              <StatementTotal level="total" label="Net change in cash" values={[<Money key="t" amount={data.net_change_in_cash} />]} />
              <StatementLine name="Cash at the start of the period" values={[<Money key="b" amount={data.cash_beginning} />]} />
              <StatementTotal level="grand" label="Cash at the end of the period" values={[<Money key="e" amount={data.cash_ending} />]} />
            </tbody>
          </Statement>
        </div>
      )}
    </div>
  )
}
