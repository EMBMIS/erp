import { useState } from 'react'
import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import {
  PageHeader, Button, Field, Input, InlineNotice, ErrorState, Money, Provenance, formatMoney,
} from '../../components/ui'
import { Statement, StatementSection, StatementLine, StatementTotal, StatementSkeleton, StatementFigures } from './StatementParts'

/**
 * VAT return summary — output VAT on customer invoices against input VAT on
 * supplier invoices, for a period (open-ended when a date is left blank).
 */
export default function VatReport() {
  const [draft, setDraft] = useState({ from: '', to: '' })
  const [range, setRange] = useState({ from: '', to: '' })

  // This endpoint answers flat ({ success, output_vat, ... }) rather than under
  // `data`, so the fetcher re-wraps the body for useResource's unwrap.
  const { data, loading, error, refetch, isFetching } = useResource(
    ['financial-report', 'vat-summary', range.from, range.to],
    ({ signal }) => api.get('/financial-reports/vat-summary', { params: { from: range.from || undefined, to: range.to || undefined }, signal })
      .then((res) => ({ data: { success: res.data?.success !== false, error: res.data?.error, data: res.data } })),
    { staleTime: 0 }
  )
  const net = Number(data?.net_vat_payable || 0)
  const run = (e) => {
    e.preventDefault()
    if (draft.from === range.from && draft.to === range.to) refetch()
    else setRange(draft)
  }
  const periodText = range.from || range.to ? `${range.from || 'the beginning'} to ${range.to || 'today'}` : 'all invoices to date'

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="VAT return summary"
        description="Output VAT collected on sales against input VAT paid on purchases, for a tax period."
      />

      <form onSubmit={run} className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="From" optional className="w-44">
          <Input type="date" value={draft.from} max={draft.to || undefined} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))} />
        </Field>
        <Field label="To" optional className="w-44">
          <Input type="date" value={draft.to} min={draft.from || undefined} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} />
        </Field>
        <Button type="submit" variant="primary" loading={isFetching && !loading}>Run</Button>
      </form>

      {data?.note && (
        <InlineNotice tone="warn" className="mb-4" title="VAT figures are not available">{data.note}</InlineNotice>
      )}

      {loading ? (
        <StatementSkeleton rows={6} />
      ) : error ? (
        <ErrorState error={error} what="The VAT summary" onRetry={refetch} />
      ) : (
        <div className="space-y-4">
          <StatementFigures
            items={[
              { label: 'Output VAT', value: <Money amount={data?.output_vat} />, hint: 'On customer invoices' },
              { label: 'Input VAT', value: <Money amount={data?.input_vat} />, hint: 'On supplier invoices' },
              {
                label: net >= 0 ? 'Net payable' : 'Net reclaimable',
                value: (
                  <Provenance method="Output VAT on customer invoices minus input VAT on supplier invoices in the period." sources={[{ label: 'Output VAT', value: formatMoney(data?.output_vat), to: '/finance/customer-invoices' }, { label: 'Input VAT', value: formatMoney(data?.input_vat), to: '/finance/supplier-invoices' }]}>
                    <Money amount={Math.abs(net)} />
                  </Provenance>
                ),
                hint: net >= 0 ? 'Owed to the tax authority' : 'Due back from the tax authority',
              },
            ]}
          />
          <Statement caption={`VAT summary, ${periodText}`} columns={['Taxable', 'VAT']}>
            <StatementSection label="Output — sales" span={3}>
              <StatementLine name="Customer invoices" values={[<Money key="b" amount={data?.taxable_sales} />, <Money key="v" amount={data?.output_vat} />]} />
            </StatementSection>
            <StatementSection label="Input — purchases" span={3}>
              <StatementLine name="Supplier invoices" values={[<Money key="b" amount={data?.taxable_purchases} />, <Money key="v" amount={data?.input_vat} />]} />
            </StatementSection>
            <tbody>
              <StatementTotal
                level="grand"
                label={net >= 0 ? 'Net VAT payable' : 'Net VAT reclaimable'}
                values={[
                  <span key="b" />,
                  <Money key="n" amount={Math.abs(net)} />,
                ]}
              />
            </tbody>
          </Statement>
          <p className="text-xs text-ink-500">
            Period: {periodText}. VAT is read from the tax on each invoice. For tax to be applied to new invoices, set <code className="font-mono">DEFAULT_VAT_RATE</code> (e.g. 18) in the backend environment, or a per-customer rate.
          </p>
        </div>
      )}
    </div>
  )
}
