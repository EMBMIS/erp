import React from 'react'
import { LineChart, BarChart, Distribution } from '../ui'

const humanizeLabel = (k) => String(k || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

/**
 * DynamicChart — draws a chart spec ({ chart_type, title, x_key, y_keys, data,
 * threshold }) produced by Simeli's generate_chart tool or /ai-insights/query-chart,
 * with the design system's charts (each has a "show as table" alternative).
 *
 * Numbers are grouped without a currency symbol: a spec carries numbers and
 * column names, not a currency, and stamping "$" on a figure from a
 * euro-denominated ledger would be a wrong statement about the business.
 */
const amount = (v) => (v == null || Number.isNaN(Number(v))
  ? '—'
  : new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Number(v)))

export default function DynamicChart({ chart_spec }) {
  if (!chart_spec || !Array.isArray(chart_spec.data) || chart_spec.data.length === 0) {
    return (
      <div className="rounded-lg border border-ink-200 bg-surface p-4 text-center text-sm text-ink-500">
        There is no data to chart.
      </div>
    )
  }

  const { chart_type, title, x_key, y_keys, data, threshold, thresholdLabel } = chart_spec
  const type = chart_type || 'line'
  const first = data[0] || {}
  const yKeys = Array.isArray(y_keys) && y_keys.length > 0
    ? y_keys
    : [Object.keys(first).find((k) => k !== x_key && typeof first[k] === 'number') || 'value']
  const labelOf = (d, i) => String(d[x_key] ?? d.label ?? d.name ?? `P${i + 1}`)

  let body
  if (type === 'pie') {
    body = (
      <Distribution
        items={data.map((d, i) => ({ label: labelOf(d, i), value: Number(d[yKeys[0]]) || 0 }))}
        format={amount}
      />
    )
  } else if (type === 'line' || type === 'forecast') {
    // No fallback threshold: no threshold in the spec means no line.
    body = (
      <LineChart
        points={data.map((d, i) => ({ x: labelOf(d, i), y: Number(d[yKeys[0]] ?? d.value ?? 0) }))}
        format={amount}
        title={title || humanizeLabel(yKeys[0])}
        threshold={threshold ?? chart_spec.operating_threshold ?? undefined}
        thresholdLabel={thresholdLabel || 'Threshold'}
      />
    )
  } else {
    body = (
      <div className="space-y-4">
        {yKeys.map((key) => (
          <div key={key}>
            {yKeys.length > 1 && <p className="label-mono mb-1">{humanizeLabel(key)}</p>}
            <BarChart
              points={data.map((d, i) => ({ x: labelOf(d, i), y: Number(d[key]) || 0 }))}
              format={amount}
              title={humanizeLabel(key)}
            />
          </div>
        ))}
      </div>
    )
  }

  return (
    <figure className="my-3 rounded-lg border border-ink-200 bg-surface p-4">
      {title && <figcaption className="mb-3 text-sm font-semibold text-fg">{title}</figcaption>}
      {body}
    </figure>
  )
}
