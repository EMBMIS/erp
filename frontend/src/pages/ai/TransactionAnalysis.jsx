import React, { useMemo, useState } from 'react'
import { ArrowPathIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { humanize } from '../../utils/format'
import {
  PageHeader, Button, Segmented, Stat, Card, DataTable, Distribution, Money, Num, DateText,
  ErrorState, MaturityBadge, Provenance,
} from '../../components/ui'

/**
 * Transaction analysis — the three analytics endpoints, read as they are.
 *
 * Each returns a `summary` of counted figures, one or more `*_breakdown` /
 * `segmentation` maps, and a ranked `top_*` list. Nothing here is derived in
 * the browser except the labels; a figure the endpoint does not return is "—".
 */
const AREAS = {
  sales: { label: 'Sales', endpoint: '/ai-analytics/sales', top: 'top_customers', topNoun: 'customer' },
  procurement: { label: 'Procurement', endpoint: '/ai-analytics/procurement', top: 'top_suppliers', topNoun: 'supplier' },
  customers: { label: 'Customers', endpoint: '/ai-analytics/customers', top: 'top_customers', topNoun: 'customer' },
}

const isMoneyKey = (k) => /value|amount|revenue|spend|credit|outstanding|balance|deal_size/i.test(k) && !/count|orders|customers|suppliers/i.test(k)
const isRateKey = (k) => /rate|percent/i.test(k)

function Figure({ name, value }) {
  if (value == null || Number.isNaN(Number(value))) return '—'
  if (isRateKey(name)) return <Num value={Number(value)} digits={1} unit="%" />
  if (isMoneyKey(name)) return <Money amount={Number(value)} digits={0} muted={false} />
  return <Num value={Number(value)} digits={Number.isInteger(Number(value)) ? 0 : 1} />
}

export default function TransactionAnalysis() {
  const [area, setArea] = useState('sales')
  const active = AREAS[area]

  const { data, loading, error, refetch, isFetching } = useResource(
    keys.transactionAnalysis(area),
    ({ signal }) => api.get(active.endpoint, { signal }),
  )

  const root = data?.analytics || data || {}
  const summary = root.summary || {}
  const figures = Object.entries(summary).filter(([, v]) => v === null || typeof v !== 'object').slice(0, 8)

  // Every breakdown map the endpoint returns, flattened one level
  // (customers nests its segmentation by type / status / risk).
  const breakdowns = useMemo(() => {
    const out = []
    for (const [key, value] of Object.entries(root)) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || key === 'summary') continue
      const nested = Object.values(value).some((v) => v && typeof v === 'object')
      if (nested) {
        for (const [k2, v2] of Object.entries(value)) {
          if (v2 && typeof v2 === 'object') out.push({ key: `${key}.${k2}`, title: humanize(k2), map: v2 })
        }
      } else {
        out.push({ key, title: humanize(key), map: value })
      }
    }
    return out
  }, [root])

  const topRows = Array.isArray(root[active.top]) ? root[active.top] : []
  const columns = useMemo(() => {
    const sample = topRows[0] || {}
    return Object.keys(sample).map((k) => {
      const v = sample[k]
      const numeric = typeof v === 'number'
      const date = /_date$|_at$/.test(k)
      return {
        id: k,
        header: humanize(k),
        accessor: (r) => r[k],
        align: numeric ? 'right' : undefined,
        mobile: k === 'name' ? 'title' : k === 'type' ? 'subtitle' : undefined,
        cell: (r) => (date ? <DateText value={r[k]} /> : numeric ? <Figure name={k} value={r[k]} /> : (r[k] ?? '—')),
      }
    })
  }, [topRows])

  return (
    <div className="space-y-5">
      <PageHeader
        title="Transaction analysis"
        badge={<MaturityBadge level="beta" />}
        description="Counted summaries of sales, purchasing and customers, straight from the ledger tables."
        secondary={<Button icon={ArrowPathIcon} onClick={() => refetch()} loading={isFetching && !loading}>Refresh</Button>}
      />

      <Segmented
        label="Area"
        value={area}
        onChange={setArea}
        options={Object.entries(AREAS).map(([value, a]) => ({ value, label: a.label }))}
      />

      {error ? (
        <ErrorState error={error} what={`${active.label} analytics`} onRetry={refetch} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {(loading ? Array.from({ length: 4 }, (_, i) => [`s${i}`, null]) : figures).map(([k, v]) => (
              <Stat
                key={k}
                label={loading ? '' : humanize(k)}
                loading={loading}
                value={<Provenance method={`"${k}" as returned by GET ${active.endpoint}.`}><Figure name={k} value={v} /></Provenance>}
              />
            ))}
          </div>
          {!loading && figures.length === 0 && (
            <p className="text-sm text-ink-500">This endpoint returned no summary figures.</p>
          )}

          {breakdowns.length > 0 && (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {breakdowns.map((b) => (
                <Card key={b.key} title={b.title}>
                  <Distribution
                    items={Object.entries(b.map).map(([label, value]) => ({ label: humanize(label), value: Number(value) || 0 }))}
                    emptyText="Nothing counted yet."
                  />
                </Card>
              ))}
            </div>
          )}

          <DataTable
            viewKey={`ai.transaction-analysis.${area}`}
            caption={`Top ${active.topNoun}s`}
            noun={active.topNoun}
            rows={topRows}
            columns={columns}
            loading={loading}
            empty={{ title: `No ${active.topNoun}s to rank yet`, description: `Ranked ${active.topNoun}s appear once there are orders against them.` }}
          />
        </>
      )}
    </div>
  )
}
