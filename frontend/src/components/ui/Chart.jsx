import { useId, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'

/**
 * Charts — small, single-message, and readable without colour.
 *
 * Rules (see the dataviz notes in README): one message per chart, one series
 * where possible (the title names it, no legend), direct labels instead of a
 * legend, recessive axes, a hover read-out, and a table view for anyone who
 * cannot or would rather not read the picture. Plain SVG: no charting library
 * on the home screen.
 */

/** Sparkline — the shape of a monthly series beside a number. */
export function Sparkline({ values = [], width = 96, height = 28, label, className }) {
  const pts = values.map(Number).filter(Number.isFinite)
  if (pts.length < 2) return null
  const max = Math.max(...pts)
  const min = Math.min(...pts, 0)
  const span = max - min || 1
  const x = (i) => (i / (pts.length - 1)) * (width - 4) + 2
  const y = (v) => height - 3 - ((v - min) / span) * (height - 6)
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label || `Trend: ${pts.join(', ')}`} className={clsx('overflow-visible text-ink-400', className)}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(pts.length - 1)} cy={y(pts[pts.length - 1])} r="2.5" className="fill-current text-ink-800" />
    </svg>
  )
}

/**
 * LineChart — one measure over time, optional uncertainty band.
 * points: [{ x: label, y: number, lo?: number, hi?: number }]
 * format(y) formats values; threshold draws a labelled reference line.
 */
export function LineChart({ points = [], height = 200, format = (v) => v.toLocaleString(), title, threshold, thresholdLabel, className }) {
  const id = useId().replace(/:/g, '')
  const ref = useRef(null)
  const [hover, setHover] = useState(null)
  const [asTable, setAsTable] = useState(false)
  const width = 640
  const pad = { l: 56, r: 72, t: 12, b: 26 }
  const ys = points.flatMap((p) => [p.y, p.lo, p.hi, threshold]).filter((v) => Number.isFinite(Number(v))).map(Number)
  const max = ys.length ? Math.max(...ys) : 1
  const min = ys.length ? Math.min(...ys, 0) : 0
  const span = max - min || 1
  const x = (i) => pad.l + (i / Math.max(1, points.length - 1)) * (width - pad.l - pad.r)
  const y = (v) => pad.t + (1 - (v - min) / span) * (height - pad.t - pad.b)
  const ticks = useMemo(() => [min, min + span / 2, max], [min, span, max])
  if (!points.length) return null
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.y)}`).join('')
  const hasBand = points.every((p) => Number.isFinite(p.lo) && Number.isFinite(p.hi))
  const band = hasBand ? `${points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.hi)}`).join('')}${[...points].reverse().map((p, j) => `L${x(points.length - 1 - j)},${y(p.lo)}`).join('')}Z` : null
  const last = points[points.length - 1]

  const onMove = (e) => {
    const rect = ref.current.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * width
    const i = Math.round(((px - pad.l) / (width - pad.l - pad.r)) * (points.length - 1))
    setHover(Math.max(0, Math.min(points.length - 1, i)))
  }

  return (
    <figure className={clsx('min-w-0', className)} aria-labelledby={title ? `${id}-t` : undefined}>
      <div className="mb-1 flex items-center justify-between gap-2">
        {title && <figcaption id={`${id}-t`} className="text-xs text-ink-600">{title}</figcaption>}
        <button type="button" onClick={() => setAsTable((t) => !t)} className="ml-auto rounded px-1.5 py-0.5 text-2xs font-medium text-ink-500 hover:bg-ink-100 hover:text-fg" aria-pressed={asTable}>
          {asTable ? 'Show chart' : 'Show table'}
        </button>
      </div>
      {asTable ? (
        <div className="max-h-56 overflow-auto ui-scroll">
          <table className="w-full text-sm">
            <thead><tr><th className="py-1 text-left">Period</th><th className="py-1 text-right">Value</th>{hasBand && <th className="py-1 text-right">Range</th>}</tr></thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.x} className="border-t border-ink-100">
                  <td className="py-1">{p.x}</td>
                  <td className="py-1 text-right tabular-nums">{format(p.y)}</td>
                  {hasBand && <td className="py-1 text-right tabular-nums text-ink-500">{format(p.lo)} – {format(p.hi)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg ref={ref} viewBox={`0 0 ${width} ${height}`} className="h-auto w-full touch-none" role="img" aria-label={`${title || 'Series'}: from ${format(points[0].y)} at ${points[0].x} to ${format(last.y)} at ${last.x}.`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className="stroke-current text-ink-200" strokeWidth="1" />
                <text x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-current text-ink-500 font-mono" fontSize="11">{format(t)}</text>
              </g>
            ))}
            {Number.isFinite(threshold) && (
              <g>
                <line x1={pad.l} x2={width - pad.r} y1={y(threshold)} y2={y(threshold)} className="stroke-current text-risk-500" strokeWidth="1" strokeDasharray="4 3" />
                {thresholdLabel && <text x={width - pad.r + 6} y={y(threshold)} dy="0.32em" className="fill-current text-risk-600" fontSize="11">{thresholdLabel}</text>}
              </g>
            )}
            {band && <path d={band} className="fill-current text-ink-200 opacity-60" />}
            <path d={line} fill="none" className="stroke-current text-ink-800" strokeWidth="2" strokeLinejoin="round" />
            <circle cx={x(points.length - 1)} cy={y(last.y)} r="4" className="fill-current text-ink-800" stroke="rgb(var(--surface))" strokeWidth="2" />
            <text x={x(points.length - 1) + 8} y={y(last.y)} dy={Number.isFinite(threshold) && Math.abs(y(last.y) - y(threshold)) < 14 ? '-0.6em' : '0.32em'} className="fill-current text-ink-800 font-medium" fontSize="12">{format(last.y)}</text>
            {[0, Math.floor((points.length - 1) / 2), points.length - 1].map((i) => (
              <text key={i} x={x(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'} className="fill-current text-ink-500" fontSize="11">{points[i].x}</text>
            ))}
            {hover != null && (
              <g>
                <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={height - pad.b} className="stroke-current text-ink-300" strokeWidth="1" />
                <circle cx={x(hover)} cy={y(points[hover].y)} r="4" className="fill-current text-ink-800" stroke="rgb(var(--surface))" strokeWidth="2" />
              </g>
            )}
          </svg>
          {hover != null && (
            <div className="pointer-events-none absolute top-0 rounded-md bg-tooltip px-2 py-1 text-xs text-white" style={{ left: `${(x(hover) / width) * 100}%`, transform: 'translateX(-50%)' }}>
              <span className="text-white/70">{points[hover].x}</span> <span className="tabular-nums font-medium">{format(points[hover].y)}</span>
              {hasBand && <span className="ml-1 text-white/70 tabular-nums">({format(points[hover].lo)}–{format(points[hover].hi)})</span>}
            </div>
          )}
        </div>
      )}
    </figure>
  )
}

/**
 * BarChart — one measure per period (or category), vertical bars.
 * points: [{ x: label, y: number }]. The latest bar is darker; every bar has a
 * hover read-out, and the table view lists them all.
 */
export function BarChart({ points = [], height = 160, format = (v) => Number(v).toLocaleString(), title, className, emptyText = 'Nothing to chart yet.' }) {
  const id = useId().replace(/:/g, '')
  const [hover, setHover] = useState(null)
  const [asTable, setAsTable] = useState(false)
  const ys = points.map((p) => Number(p.y) || 0)
  const max = Math.max(...ys, 0) || 1
  const empty = !points.length || ys.every((v) => v === 0)
  const width = 320
  const pad = { t: 18, b: 22 }
  const slot = width / Math.max(points.length, 1)
  const bw = Math.min(28, slot * 0.6)
  const y = (v) => pad.t + (1 - v / max) * (height - pad.t - pad.b)
  return (
    <figure className={clsx('min-w-0', className)} aria-labelledby={title ? `${id}-t` : undefined}>
      <div className="mb-1 flex items-center justify-between gap-2">
        {title && <figcaption id={`${id}-t`} className="text-xs text-ink-600">{title}</figcaption>}
        {!empty && (
          <button type="button" onClick={() => setAsTable((t) => !t)} className="ml-auto rounded px-1.5 py-0.5 text-2xs font-medium text-ink-500 hover:bg-ink-100 hover:text-fg" aria-pressed={asTable}>
            {asTable ? 'Show chart' : 'Show table'}
          </button>
        )}
      </div>
      {empty ? (
        <p className="grid place-items-center text-sm text-ink-500" style={{ height }}>{emptyText}</p>
      ) : asTable ? (
        <table className="w-full text-sm">
          <tbody>
            {points.map((p) => (
              <tr key={p.x} className="border-t border-ink-100">
                <td className="py-1">{p.x}</td>
                <td className="py-1 text-right tabular-nums">{format(p.y)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label={`${title || 'Bars'}: ${points.map((p) => `${p.x} ${format(p.y)}`).join(', ')}`} onPointerLeave={() => setHover(null)}>
          <line x1="0" x2={width} y1={height - pad.b} y2={height - pad.b} className="stroke-current text-ink-200" strokeWidth="1" />
          {points.map((p, i) => {
            const v = Number(p.y) || 0
            const cx = slot * i + slot / 2
            const last = i === points.length - 1
            const on = hover === i
            return (
              <g key={p.x} onPointerEnter={() => setHover(i)}>
                <rect x={slot * i} y={0} width={slot} height={height} fill="transparent" />
                <rect x={cx - bw / 2} y={y(v)} width={bw} height={Math.max(v ? 2 : 0, height - pad.b - y(v))} rx="3" className={last || on ? 'fill-current text-ink-800' : 'fill-current text-ink-400'} />
                {(last || on) && v > 0 && <text x={cx} y={y(v) - 5} textAnchor="middle" className="fill-current text-ink-800 font-medium" fontSize="11">{format(v)}</text>}
                <text x={cx} y={height - 6} textAnchor="middle" className="fill-current text-ink-500" fontSize="10">{p.x}</text>
              </g>
            )
          })}
        </svg>
      )}
    </figure>
  )
}

/**
 * Distribution — how a whole splits into parts, as labelled horizontal bars.
 * items: [{ label, value, to?, tone?: 'ink'|'ok'|'warn'|'risk' }]. Colour only
 * where the part carries a state; values are always written out.
 */
export function Distribution({ items = [], format = (v) => Number(v).toLocaleString(), className, emptyText = 'Nothing to show yet.', max: maxProp }) {
  const total = items.reduce((s, i) => s + (Number(i.value) || 0), 0)
  const max = maxProp || Math.max(...items.map((i) => Number(i.value) || 0), 0) || 1
  if (!items.length || !total) return <p className={clsx('py-4 text-sm text-ink-500', className)}>{emptyText}</p>
  const tone = { ink: 'bg-ink-700', ok: 'bg-ok-500', warn: 'bg-warn-500', risk: 'bg-risk-500' }
  return (
    <ul className={clsx('space-y-2.5', className)}>
      {items.map((i) => {
        const v = Number(i.value) || 0
        const body = (
          <>
            <span className="flex items-baseline justify-between gap-2 text-sm">
              <span className="truncate text-ink-700">{i.label}</span>
              <span className="shrink-0 tabular-nums text-fg">{format(v)} <span className="text-xs text-ink-500">{Math.round((v / total) * 100)}%</span></span>
            </span>
            <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-ink-100" aria-hidden="true">
              <span className={clsx('block h-full rounded-full', tone[i.tone] || tone.ink)} style={{ width: `${Math.max(2, (v / max) * 100)}%` }} />
            </span>
          </>
        )
        return (
          <li key={i.label}>
            {i.to ? <Link to={i.to} className="block rounded hover:bg-ink-50">{body}</Link> : body}
          </li>
        )
      })}
    </ul>
  )
}
