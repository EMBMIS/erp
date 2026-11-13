/**
 * The block renderers: every component type a generated application can use.
 *
 * ===========================================================================
 * THE CONTRACT WITH THE SERVER
 * ===========================================================================
 * The server renders a page into a list of blocks, each already carrying its
 * data (services/platform/runtime/page.js). This file turns a block into
 * pixels. It does not decide what data a block needs, does not fetch, and does
 * not know which application it is rendering.
 *
 * That is what makes "no per-application React" true rather than aspirational:
 * adding an application adds rows to a registry, and the set of components
 * involved is exactly the set below, unchanged.
 *
 * A block that arrives with `error` renders as a stated gap rather than as
 * nothing. A dashboard silently missing a tile because the viewer's role cannot
 * read it is a dashboard that lies about what it is showing.
 */

import React from 'react'
import { Link } from 'react-router-dom'
import { TwinFloor } from '../warehouse/WarehouseTwin.jsx'
import {
  ClipboardDocumentListIcon,
} from '@heroicons/react/24/outline'
import Module from '../bos/Module'
import EmptyState from '../ui/EmptyState'
import DataTable from '../ui/DataTable'
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell,
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import { FieldValue, FieldInput, WIDTH_CLASS, statusTone } from './fields.jsx'

// A brand-neutral categorical ramp. Deliberately a fixed list rather than
// random colours: the same series keeps the same colour across every chart in
// an application, which is what makes two charts on one dashboard comparable.
const SERIES = ['#3b82f6', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#64748b']

const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

// The panel every block sits in is the same Module a built-in screen uses —
// same border, lit edge and header — with an accent picked by what the block
// is, so a generated dashboard has the rhythm of a hand-built one.
const BLOCK_ACCENT = {
  live_monitor: 'violet', chart_line: 'blue', chart_area: 'blue', chart_bar: 'cyan', chart_stacked_bar: 'cyan',
  chart_pie: 'violet', chart_donut: 'violet', chart_scatter: 'blue', stat_ranking: 'green', kanban: 'amber', calendar: 'cyan',
}

function BlockShell({ block, children, className = '' }) {
  return (
    <Module
      title={block.title || null}
      accent={BLOCK_ACCENT[block.type]}
      ticks={block.type === 'live_monitor'}
      className={`${WIDTH_CLASS[block.width] || 'md:col-span-12'} ${className}`}
    >
      {children}
    </Module>
  )
}

function Empty({ children }) {
  return <p className="bos-caption py-6 text-center">{children}</p>
}

// ---------------------------------------------------------------------------

function metricValue(m) {
  if (m.error) return null
  if (m.format === 'currency') return nf.format(m.value || 0)
  if (m.format === 'percent') return `${nf.format(m.value || 0)}%`
  return nf.format(m.value || 0)
}

/**
 * Key figures, drawn as a built-in screen draws them: on a list, the row of
 * stat cards above the filters; on an overview, the module's KPI tiles that
 * sit in the masthead beside its figure.
 */
function MetricGroup({ block, pageKind }) {
  const metrics = block.metrics || []
  if (!metrics.length) return <BlockShell block={block}><Empty>No measures on this page.</Empty></BlockShell>

  if (pageKind === 'list') {
    return (
      <section className={`grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 ${WIDTH_CLASS[block.width] || 'md:col-span-12'}`}>
        {metrics.slice(0, 4).map((m, i) => {
          return (
            <div key={m.key} className="rounded-lg border border-ink-200 bg-surface p-4">
              <p className="label-mono truncate" title={m.label}>{m.label}</p>
              <p className="mt-2 text-2xl font-semibold tabular-nums text-fg">{m.error ? '—' : metricValue(m)}</p>
              {m.error ? <p className="mt-1 text-xs text-ink-500">Could not be counted.</p> : null}
            </div>
          )
        })}
      </section>
    )
  }

  return (
    <section className={`grid grid-cols-2 gap-3 sm:grid-cols-3 ${WIDTH_CLASS[block.width] || 'md:col-span-12'}`}>
      {metrics.slice(0, 6).map((m, i) => (
        <div key={m.key}
          className="bos-panel flex flex-col p-3.5">
          <span className="bos-metric-label truncate" title={m.label}>{m.label}</span>
          {m.error ? (
            <p className="mt-2 text-[13px] italic bos-text-faint">{m.error}</p>
          ) : (
            <p className="bos-metric--lg mt-2 tabular-nums">{metricValue(m)}</p>
          )}
          {m.target != null && !m.error ? (
            <p className={`bos-delta mt-2 ${
              (m.direction === 'lower_is_better' ? m.value <= m.target : m.value >= m.target)
                ? 'bos-delta--up' : 'bos-delta--down'}`}>
              target {nf.format(m.target)}
            </p>
          ) : null}
        </div>
      ))}
    </section>
  )
}

function ChartBlock({ block }) {
  const rows = (block.data?.rows || []).map((r) => ({ ...r, name: r.label }))
  if (!rows.length) return <BlockShell block={block}><Empty>Nothing to chart yet.</Empty></BlockShell>

  const axis = { stroke: 'currentColor', fontSize: 11, tickLine: false, axisLine: false }
  const tooltip = <Tooltip formatter={(v) => nf.format(v)} contentStyle={{ fontSize: 12, borderRadius: 8 }} />

  const chart = () => {
    switch (block.type) {
      case 'chart_line':
        return (
          <LineChart data={rows}>
            <CartesianGrid strokeDasharray="2 4" opacity={0.25} vertical={false} />
            <XAxis dataKey="name" {...axis} /><YAxis {...axis} width={44} />{tooltip}
            <Line type="monotone" dataKey="value" stroke={SERIES[0]} strokeWidth={2} dot={false} />
          </LineChart>
        )
      case 'chart_area':
        return (
          <AreaChart data={rows}>
            <CartesianGrid strokeDasharray="2 4" opacity={0.25} vertical={false} />
            <XAxis dataKey="name" {...axis} /><YAxis {...axis} width={44} />{tooltip}
            <Area type="monotone" dataKey="value" stroke={SERIES[0]} fill={SERIES[0]} fillOpacity={0.15} />
          </AreaChart>
        )
      case 'chart_bar': case 'chart_stacked_bar':
        return (
          <BarChart data={rows}>
            <CartesianGrid strokeDasharray="2 4" opacity={0.25} vertical={false} />
            <XAxis dataKey="name" {...axis} /><YAxis {...axis} width={44} />{tooltip}
            <Bar dataKey="value" radius={[4, 4, 0, 0]}>
              {rows.map((r, i) => <Cell key={r.name ?? i} fill={SERIES[i % SERIES.length]} />)}
            </Bar>
          </BarChart>
        )
      case 'chart_pie': case 'chart_donut':
        return (
          <PieChart>
            <Pie data={rows} dataKey="value" nameKey="name" innerRadius={block.type === 'chart_donut' ? 52 : 0} outerRadius={86}>
              {rows.map((r, i) => <Cell key={r.name ?? i} fill={SERIES[i % SERIES.length]} />)}
            </Pie>
            {tooltip}<Legend wrapperStyle={{ fontSize: 11 }} />
          </PieChart>
        )
      case 'chart_scatter':
        return (
          <ScatterChart>
            <CartesianGrid strokeDasharray="2 4" opacity={0.25} />
            <XAxis dataKey="name" {...axis} /><YAxis dataKey="value" {...axis} width={44} />{tooltip}
            <Scatter data={rows} fill={SERIES[0]} />
          </ScatterChart>
        )
      default:
        return <div />
    }
  }

  return (
    <BlockShell block={block}>
      <div className="h-[240px] bos-text-muted">
        <ResponsiveContainer width="100%" height="100%">{chart()}</ResponsiveContainer>
      </div>
    </BlockShell>
  )
}

/** A ranked list. Better than a bar chart when the labels are the point. */
function StatRanking({ block }) {
  const rows = block.data?.rows || []
  const max = Math.max(1, ...rows.map((r) => r.value))
  if (!rows.length) return <BlockShell block={block}><Empty>Nothing ranked yet.</Empty></BlockShell>
  return (
    <BlockShell block={block}>
      <ol className="space-y-2">
        {rows.map((r, i) => (
          <li key={`${r.label}-${i}`} className="flex items-center gap-3">
            <span className="w-5 shrink-0 bos-caption tabular-nums">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate text-[13px] bos-text" title={r.label}>{r.label || '—'}</span>
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-current/10">
              <span className="block h-full rounded-full" style={{ width: `${(r.value / max) * 100}%`, background: SERIES[i % SERIES.length] }} />
            </span>
            <span className="w-14 shrink-0 text-right text-[13px] tabular-nums bos-text-strong">{nf.format(r.value)}</span>
          </li>
        ))}
      </ol>
    </BlockShell>
  )
}

/**
 * Live measures of a canonical entity — e.g. every supplier's risk, read from
 * the company's own purchasing when the page was rendered. The server decides
 * the columns (the canonical catalogue) and the rows (the provider, for this
 * company and this viewer); this only draws them. `block.preview` marks the
 * Studio's preview, which shows the same live rows before anything deploys.
 */
const LIVE_BAND = { HIGH: 'rose', MEDIUM: 'amber', LOW: 'blue', NONE: 'green' }

function liveValue(col, value, currency) {
  if (value == null || value === '') return '—'
  if (col.type === 'money') {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 }).format(value) } catch { return nf.format(value) }
  }
  if (col.type === 'percent') return `${nf.format(value)}%`
  if (typeof value === 'number') return nf.format(value)
  return String(value)
}

function LiveMonitor({ block }) {
  const [open, setOpen] = React.useState(null)
  const live = block.live
  if (!live) return <BlockShell block={block}><Empty>Nothing live to show yet.</Empty></BlockShell>
  if (live.view === 'twin' && live.twin) {
    return (
      <BlockShell block={block}>
        <p className="bos-caption -mt-1 mb-3">
          <span className="bos-chip bos-accent-green mr-2">Live</span>
          {block.preview ? 'Your real warehouse, read now — this is what the application will show. ' : ''}
          {live.twin.headline}
          {live.as_of ? ` · as of ${new Date(live.as_of).toLocaleTimeString()}` : ''}
        </p>
        <TwinFloor twin={live.twin} currency={live.currency} />
      </BlockShell>
    )
  }
  const rows = live.rows || []
  const columns = (live.columns || []).filter((c) => !['top_signal', 'risk_band'].includes(c.name))
  const summary = live.summary
  return (
    <BlockShell block={block}>
      <p className="bos-caption -mt-1 mb-3">
        <span className="bos-chip bos-accent-green mr-2">Live</span>
        {block.preview ? 'Your real records, read now — this is what the application will show. ' : ''}
        {summary && summary.suppliers_watched != null
          ? `${summary.high} high · ${summary.medium} medium of ${summary.suppliers_watched} suppliers${summary.delayed ? ` · ${summary.delayed} delayed` : ''}`
          : `${rows.length} records`}
        {live.as_of ? ` · as of ${new Date(live.as_of).toLocaleTimeString()}` : ''}
      </p>
      {!rows.length ? <Empty>No records to watch yet.</Empty> : (
        <div className="-mx-4 overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="bos-caption">
                <th className="px-4 pb-2 font-medium">{live.entity === 'suppliers' ? 'Supplier' : 'Record'}</th>
                <th className="px-4 pb-2 font-medium">Risk</th>
                {columns.map((c) => <th key={c.name} className="px-4 pb-2 font-medium whitespace-nowrap">{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <React.Fragment key={r.id}>
                  <tr className="bos-row bos-hoverable cursor-pointer" onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <td className="px-4 py-2 bos-text-strong whitespace-nowrap">{r.name || r.supplier_code || r.id}</td>
                    <td className="px-4 py-2">
                      <span className={`bos-chip bos-accent-${LIVE_BAND[r.risk_band] || 'blue'}`}>{r.risk_band === 'NONE' ? 'none' : String(r.risk_band || '').toLowerCase()}</span>
                    </td>
                    {columns.map((c) => <td key={c.name} className="px-4 py-2 tabular-nums bos-text whitespace-nowrap">{liveValue(c, r[c.name], live.currency)}</td>)}
                  </tr>
                  {open === r.id && (
                    <tr>
                      <td colSpan={columns.length + 2} className="px-4 pb-3">
                        {r.signals?.length ? (
                          <ul className="mt-1 list-disc pl-5 text-[13px] bos-text">
                            {r.signals.map((t) => <li key={t}>{t}</li>)}
                          </ul>
                        ) : <p className="bos-caption">Nothing on this record raises a signal.</p>}
                        {r.proposals?.length ? (
                          <>
                            <span className="mt-2 block text-[10px] font-semibold uppercase tracking-wider bos-text-faint">Simeli proposes · you decide</span>
                            <ul className="mt-1 list-disc pl-5 text-[13px] bos-text">
                              {r.proposals.map((t) => <li key={t}>{t}</li>)}
                            </ul>
                          </>
                        ) : null}
                        <Link
                          to={`/ai/chat?q=${encodeURIComponent(`Why is ${r.name} a supplier risk, what is our exposure, and which customer orders does it reach?`)}`}
                          className="bos-link mt-2 inline-block text-[13px]">
                          Ask Simeli about {r.name} →
                        </Link>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </BlockShell>
  )
}

/**
 * Records, in the table card every built-in list uses: a titled header with
 * the count, the standard table, and the shared empty state with the page's
 * own "New …" action when there is nothing yet.
 */
function RecordTable({ block, onOpenRecord, onCreate, createLabel }) {
  const fields = block.fields || []
  const rows = block.rows || []
  const label = block.title || 'Records'
  const total = block.total ?? rows.length
  const numeric = (f) => ['number', 'integer', 'decimal', 'currency', 'money', 'percent'].includes(f.type)
  const columns = fields.map((f, i) => ({
    key: f.name,
    header: f.label,
    accessor: (row) => row[f.name],
    cell: (row) => <FieldValue field={f} row={row} />,
    align: numeric(f) ? 'right' : undefined,
    mobile: i === 0 ? 'title' : i === 1 ? 'subtitle' : i === 2 ? 'trailing' : undefined,
  }))
  const createText = createLabel ? createLabel.charAt(0).toUpperCase() + createLabel.slice(1) : 'Create'
  return (
    <section className={WIDTH_CLASS[block.width] || 'md:col-span-12'}>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-fg">{label} <span className="font-mono text-xs font-normal text-ink-500">{total}</span></h3>
        {total > rows.length ? <span className="text-xs text-ink-500">Showing {rows.length} of {total}</span> : null}
      </div>
      <DataTable
        columns={columns}
        rows={rows}
        viewKey={block.entity ? `app.${block.entity}` : undefined}
        onRowClick={onOpenRecord ? (row) => onOpenRecord(block.entity, row.id) : undefined}
        search={rows.length > 8}
        empty={
          <EmptyState
            icon={ClipboardDocumentListIcon}
            title={`No ${label.toLowerCase()} yet`}
            message={onCreate ? `Create the first ${(createLabel || '').replace(/^new\s+/i, '') || 'record'}.` : 'Records appear here as they are created.'}
            actionLabel={onCreate ? createText : undefined}
            onAction={onCreate}
            compact
          />
        }
      />
    </section>
  )
}

function Kanban({ block, onOpenRecord }) {
  const columns = block.columns || []
  const titleField = (block.fields || [])[0]
  return (
    <BlockShell block={block}>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {columns.map((col) => {
          const cards = (block.rows || []).filter((r) => r[block.groupBy] === col.key)
          return (
            <div key={col.key} className="min-w-[220px] flex-1">
              <div className="mb-2 flex items-center justify-between">
                <span className={`bos-chip ${statusTone(col.key)}`}>{col.label}</span>
                <span className="bos-caption tabular-nums">{cards.length}</span>
              </div>
              <div className="space-y-2">
                {cards.map((card) => (
                  <button key={card.id} type="button"
                    onClick={onOpenRecord ? () => onOpenRecord(block.entity, card.id) : undefined}
                    className="bos-panel bos-panel--interactive w-full p-3 text-left">
                    <div className="truncate text-[13px] font-medium bos-text">
                      {titleField ? <FieldValue field={titleField} row={card} /> : card.id}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {(block.fields || []).slice(1, 4).map((f) => (
                        <span key={f.name} className="bos-caption"><FieldValue field={f} row={card} /></span>
                      ))}
                    </div>
                  </button>
                ))}
                {!cards.length ? <p className="bos-caption py-3 text-center">Empty</p> : null}
              </div>
            </div>
          )
        })}
      </div>
    </BlockShell>
  )
}

function CalendarBlock({ block, onOpenRecord }) {
  const rows = block.rows || []
  const byDay = new Map()
  rows.forEach((r) => {
    const raw = r[block.dateField]
    if (!raw) return
    const key = String(raw).slice(0, 10)
    if (!byDay.has(key)) byDay.set(key, [])
    byDay.get(key).push(r)
  })
  const days = [...byDay.keys()].sort()
  return (
    <BlockShell block={block}>
      {!days.length ? <Empty>Nothing scheduled.</Empty> : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {days.map((day) => (
            <div key={day} className="bos-panel bos-panel--sunken p-3">
              <div className="bos-eyebrow mb-2">{new Date(day).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</div>
              <ul className="space-y-1">
                {byDay.get(day).map((r) => (
                  <li key={r.id}>
                    <button type="button" className="bos-link truncate text-left text-[13px]"
                      onClick={onOpenRecord ? () => onOpenRecord(block.entity, r.id) : undefined}>
                      {r[block.titleField] || r.id}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </BlockShell>
  )
}

function TimelineBlock({ block, onOpenRecord }) {
  const rows = [...(block.rows || [])].sort(
    (a, b) => new Date(b[block.dateField]) - new Date(a[block.dateField])
  )
  return (
    <BlockShell block={block}>
      {!rows.length ? <Empty>Nothing on the timeline.</Empty> : (
        <ol className="relative space-y-4 border-l pl-5" style={{ borderColor: 'currentColor', borderLeftWidth: 1, opacity: 0.999 }}>
          {rows.map((r) => (
            <li key={r.id} className="relative">
              <span className="absolute -left-[23px] top-1.5 h-2 w-2 rounded-full" style={{ background: SERIES[0] }} />
              <div className="bos-caption">{r[block.dateField] ? new Date(r[block.dateField]).toLocaleString() : ''}</div>
              <button type="button" className="bos-link text-[13px]"
                onClick={onOpenRecord ? () => onOpenRecord(block.entity, r.id) : undefined}>
                {r[block.titleField] || r.id}
              </button>
            </li>
          ))}
        </ol>
      )}
    </BlockShell>
  )
}

/**
 * A map without a tile provider.
 *
 * Deliberately: rendering points on a projected grid needs no third-party
 * script, no API key, and sends nothing about the company's locations to
 * anybody. A real basemap is a decision with a vendor attached, and this
 * platform should not make it on a company's behalf.
 */
function MapBlock({ block, onOpenRecord }) {
  const points = block.points || []
  if (!points.length) return <BlockShell block={block}><Empty>No located records.</Empty></BlockShell>
  const lats = points.map((p) => p.lat)
  const lngs = points.map((p) => p.lng)
  const pad = 0.15
  const minLat = Math.min(...lats) - pad
  const maxLat = Math.max(...lats) + pad
  const minLng = Math.min(...lngs) - pad
  const maxLng = Math.max(...lngs) + pad
  const x = (lng) => ((lng - minLng) / (maxLng - minLng || 1)) * 100
  const y = (lat) => (1 - (lat - minLat) / (maxLat - minLat || 1)) * 100

  return (
    <BlockShell block={block}>
      <div className="relative h-[280px] w-full overflow-hidden rounded-lg bos-panel--sunken">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full opacity-20">
          {[20, 40, 60, 80].map((v) => (
            <g key={v}>
              <line x1={v} y1="0" x2={v} y2="100" stroke="currentColor" strokeWidth="0.2" />
              <line x1="0" y1={v} x2="100" y2={v} stroke="currentColor" strokeWidth="0.2" />
            </g>
          ))}
        </svg>
        {points.map((p) => (
          <button key={p.id} type="button" title={p.label}
            onClick={onOpenRecord ? () => onOpenRecord(block.entity, p.id) : undefined}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${x(p.lng)}%`, top: `${y(p.lat)}%` }}>
            <span className="block h-2.5 w-2.5 rounded-full ring-2 ring-white/60" style={{ background: SERIES[0] }} />
          </button>
        ))}
      </div>
      <p className="bos-caption mt-2">{points.length} located record(s).</p>
    </BlockShell>
  )
}

function FieldGroup({ block, record }) {
  const fields = block.fields || []
  return (
    <BlockShell block={block}>
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.name} className="min-w-0">
            <dt className="bos-caption">{f.label}</dt>
            <dd className="mt-0.5 text-[13px] bos-text break-words">
              <FieldValue field={f} row={record || {}} />
            </dd>
          </div>
        ))}
      </dl>
    </BlockShell>
  )
}

function DetailHeader({ block, record, entity }) {
  const title = record?.[block.titleField] || record?.id || ''
  const subtitle = block.subtitleField ? record?.[block.subtitleField] : null
  return (
    <section className={`${WIDTH_CLASS[block.width] || 'md:col-span-12'}`}>
      <p className="bos-eyebrow">{entity?.singular || ''}</p>
      <h2 className="bos-title mt-1">{title}</h2>
      {subtitle ? <p className="bos-caption mt-1">{subtitle}</p> : null}
    </section>
  )
}

function WorkflowBar({ block, onTransition, busy }) {
  const states = block.states || []
  const currentIndex = states.findIndex((s) => s.key === block.current)
  return (
    <BlockShell block={block}>
      <div className="flex flex-wrap items-center gap-1.5">
        {states.map((s, i) => (
          <React.Fragment key={s.key}>
            <span className={`bos-chip ${s.key === block.current ? statusTone(s.key) : 'bos-text-faint'}`}>
              {s.label}
            </span>
            {i < states.length - 1 ? <span className={`bos-caption ${i < currentIndex ? '' : 'opacity-40'}`}>→</span> : null}
          </React.Fragment>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {(block.transitions || []).map((t) => (
          <button key={t.key} type="button" disabled={!t.allowed || busy}
            title={t.allowed ? '' : t.blockedBy.join('; ')}
            onClick={() => onTransition?.(t)}
            className={`bos-btn ${t.allowed ? 'bos-btn--primary' : 'bos-btn--ghost opacity-60'}`}>
            {t.label}
          </button>
        ))}
        {!(block.transitions || []).length ? <p className="bos-caption">Nothing further to do here.</p> : null}
      </div>
      {(block.transitions || []).some((t) => !t.allowed) ? (
        <ul className="mt-3 space-y-1">
          {(block.transitions || []).filter((t) => !t.allowed).map((t) => (
            <li key={t.key} className="bos-caption">{t.label}: {t.blockedBy.join('; ')}.</li>
          ))}
        </ul>
      ) : null}
    </BlockShell>
  )
}

function ActivityFeed({ block }) {
  const events = block.events || []
  return (
    <BlockShell block={block}>
      {!events.length ? <Empty>Nothing has happened yet.</Empty> : (
        <ol className="space-y-3">
          {events.map((e, i) => (
            <li key={i} className="flex gap-3">
              <span className={`bos-plate bos-plate--sm ${e.kind === 'comment' ? 'bos-accent-cyan' : 'bos-accent-blue'}`} />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] bos-text break-words">{e.summary}</p>
                <p className="bos-caption">
                  {e.actor?.name || 'System'}
                  {e.actor?.kind === 'external' ? ' (external)' : ''}
                  {' · '}{new Date(e.at).toLocaleString()}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </BlockShell>
  )
}

function Comments({ block, onAddComment, busy }) {
  const [text, setText] = React.useState('')
  const [shared, setShared] = React.useState(!block.canWriteInternal)
  const comments = block.comments || []
  return (
    <BlockShell block={block}>
      <div className="space-y-3">
        {comments.map((c) => (
          <div key={c.id} className="bos-panel bos-panel--sunken p-3">
            <p className="text-[13px] bos-text whitespace-pre-wrap break-words">{c.body}</p>
            <p className="bos-caption mt-1">
              {c.author?.name}
              {c.visibility === 'shared' ? ' · shared' : ' · internal'}
              {' · '}{new Date(c.at).toLocaleString()}
            </p>
          </div>
        ))}
        {!comments.length ? <Empty>No messages yet.</Empty> : null}
      </div>
      <form className="mt-3 space-y-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onAddComment?.(text, shared ? 'shared' : 'internal'); setText('') } }}>
        <textarea className="bos-field w-full min-h-[72px]" value={text} placeholder="Add a message…"
          onChange={(e) => setText(e.target.value)} />
        <div className="flex items-center justify-between gap-2">
          {block.canWriteInternal ? (
            <label className="flex items-center gap-2 bos-caption">
              <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
              Share with the other party
            </label>
          ) : <span className="bos-caption">Visible to the company.</span>}
          <button type="submit" className="bos-btn bos-btn--primary bos-btn--sm" disabled={busy || !text.trim()}>Send</button>
        </div>
      </form>
    </BlockShell>
  )
}

function Attachments({ block, onUpload, onOpenAttachment, busy }) {
  const files = block.attachments || []
  const [shared, setShared] = React.useState(block.visibility === 'shared')
  const inputRef = React.useRef(null)

  return (
    <BlockShell block={block}>
      {!files.length ? <Empty>No documents.</Empty> : (
        <ul className="space-y-2">
          {files.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-3">
              <button type="button" className="bos-link min-w-0 truncate text-left text-[13px]"
                onClick={() => onOpenAttachment?.(f)}>
                {f.file_name}
              </button>
              <span className="bos-caption shrink-0">
                {f.visibility === 'shared' ? 'shared' : 'internal'}
                {f.byte_size ? ` · ${Math.round(f.byte_size / 1024)} kB` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}

      {onUpload ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input ref={inputRef} type="file" className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) onUpload(file, shared ? 'shared' : 'internal')
              e.target.value = ''
            }} />
          <button type="button" className="bos-btn bos-btn--sm" disabled={busy}
            onClick={() => inputRef.current?.click()}>
            {busy ? 'Uploading…' : 'Attach a document'}
          </button>
          {block.visibility !== 'shared' ? (
            <label className="flex items-center gap-2 bos-caption">
              <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
              Share with the other party
            </label>
          ) : null}
        </div>
      ) : null}
    </BlockShell>
  )
}

function FormBlock({ block, values, onChange, onSubmit, busy, referenceOptions, onReferenceSearch }) {
  const fields = block.fields || []
  return (
    <BlockShell block={block}>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); onSubmit?.() }}>
        {fields.map((f) => (
          <div key={f.name} className={f.type === 'long_text' || f.type === 'json' ? 'sm:col-span-2' : ''}>
            <label className="bos-label mb-1 block">
              {f.label}{f.required ? <span className="bos-text-faint"> *</span> : null}
            </label>
            <FieldInput field={f} value={values?.[f.name]} onChange={onChange} disabled={busy}
              referenceOptions={referenceOptions?.[f.name] || []} onReferenceSearch={onReferenceSearch} />
          </div>
        ))}
        <div className="sm:col-span-2">
          <button type="submit" className="bos-btn bos-btn--primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </BlockShell>
  )
}

/**
 * The dispatcher.
 *
 * One switch, one component per block type, no application-specific branch
 * anywhere. If this file ever needs to know which application it is rendering,
 * something upstream has gone wrong.
 */
export function Block(props) {
  const { block } = props

  if (block.error) {
    return (
      <BlockShell block={block}>
        <p className="bos-caption">{block.error}</p>
      </BlockShell>
    )
  }

  switch (block.type) {
    case 'metric': case 'metric_group': return <MetricGroup {...props} />
    case 'chart_line': case 'chart_bar': case 'chart_area': case 'chart_pie':
    case 'chart_donut': case 'chart_scatter': case 'chart_stacked_bar': return <ChartBlock {...props} />
    case 'stat_ranking': return <StatRanking {...props} />
    case 'live_monitor': return <LiveMonitor {...props} />
    case 'table': case 'list': case 'related_list': return <RecordTable {...props} />
    case 'kanban': return <Kanban {...props} />
    case 'calendar': return <CalendarBlock {...props} />
    case 'timeline': return <TimelineBlock {...props} />
    case 'map': return <MapBlock {...props} />
    case 'detail_header': return <DetailHeader {...props} />
    case 'field_group': return <FieldGroup {...props} />
    case 'form': return <FormBlock {...props} />
    case 'workflow_bar': case 'approval_panel': return <WorkflowBar {...props} />
    case 'activity_feed': return <ActivityFeed {...props} />
    case 'comments': return <Comments {...props} />
    case 'attachments': return <Attachments {...props} />
    case 'markdown':
      return <BlockShell block={block}><p className="text-[13px] bos-text whitespace-pre-wrap">{block.text}</p></BlockShell>
    case 'divider':
      return <hr className={`${WIDTH_CLASS[block.width] || 'md:col-span-12'} my-2 border-current/10`} />
    default:
      return (
        <BlockShell block={block}>
          <p className="bos-caption">This build does not know how to render a &ldquo;{block.type}&rdquo;.</p>
        </BlockShell>
      )
  }
}

export { SERIES }
