import React from 'react'
import { Info } from 'lucide-react'

/**
 * The renderer for a chart Simeli designed.
 *
 * WHY THIS IS NOT A RECHARTS WRAPPER
 * ---------------------------------------------------------------------------
 * The old path let the model choose "line", "bar" or "pie". This one takes a
 * specification the model composed: a list of layers drawn back to front, any
 * of which may be an area, a line, bars, points or a step; any of which may
 * cover only part of the x range; any of which may sit on a second axis. Plus
 * reference lines, shaded x-ranges and annotations pinned to points.
 *
 * A cash forecast is not a chart type here — it is an area, plus a solid line
 * over the actual months, plus a dashed line over the projected ones, plus a
 * band shading the projection, plus a rule at whatever threshold the user
 * actually named. That composition is not expressible in a chart-type enum, so
 * this draws SVG directly.
 *
 * WHAT IT WILL NOT DRAW
 * ---------------------------------------------------------------------------
 * Nothing this component was not handed. No default series, no default
 * threshold, no invented axis bounds. The spec arrives already validated
 * against the columns that came back from the database
 * (services/ai/chartAuthoring.js), so a layer here always refers to a real
 * column of real rows.
 *
 * The provenance line under the chart says where the numbers came from — the
 * question that was executed, or the tool whose result was charted. A chart in
 * an ERP should always be able to answer "says who?".
 */

const TONE = {
  blue:    '#3b82f6',
  cyan:    '#22d3ee',
  violet:  '#8b5cf6',
  magenta: '#ec4899',
  indigo:  '#6366f1',
  green:   '#10b981',
  amber:   '#f59e0b',
  rose:    '#ef4444',
  slate:   '#64748b',
}

const tone = (key) => TONE[key] || TONE.blue

const PAD = { top: 18, right: 16, bottom: 26, left: 46 }

function num(value) {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/** Axis ticks: compact by default, because ERP figures are large. */
function formatTick(value, format) {
  if (!Number.isFinite(value)) return ''
  if (format === 'percent') return `${(value * 100).toFixed(0)}%`
  const abs = Math.abs(value)
  if (format === 'compact' || abs >= 10000) {
    if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`
    if (abs >= 1000) return `${(value / 1000).toFixed(abs >= 10_000 ? 0 : 1)}k`
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

/** A tick count that yields round-ish numbers without a full nice-scale pass. */
function ticksFor(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min]
  const step = (max - min) / count
  return Array.from({ length: count + 1 }, (_, i) => min + step * i)
}

export default function SimeliChart({ spec }) {
  const [width, setWidth] = React.useState(0)
  const [viewIndex, setViewIndex] = React.useState(0)
  // Series the reader has switched off by clicking the legend. Keyed by label,
  // not index, so switching view does not silently re-enable something they
  // turned off.
  const [muted, setMuted] = React.useState(() => new Set())
  const [hover, setHover] = React.useState(null)
  const boxRef = React.useRef(null)

  const toggleSeries = React.useCallback((key) => {
    setMuted((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const views = Array.isArray(spec?.views) && spec.views.length ? spec.views : null

  // The presentation currently on screen: a named view if the model wrote any,
  // otherwise the chart's own layers. Only the drawing changes — the rows are
  // the same rows either way, so a view can never show a different number.
  const shown = React.useMemo(() => {
    const base = views ? views[Math.min(viewIndex, views.length - 1)] : spec
    return {
      layers: base?.layers || [],
      rules: base?.rules || [],
      bands: base?.bands || [],
      annotations: base?.annotations || [],
      subtitle: base?.subtitle ?? spec?.subtitle ?? null,
    }
  }, [views, viewIndex, spec])

  // Measured rather than assumed: the chart sits in a column whose width
  // depends on whether the context panel is open, and an SVG sized to a guess
  // either overflows or leaves a gap.
  React.useEffect(() => {
    const el = boxRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    ro.observe(el)
    setWidth(el.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [])

  const rows = Array.isArray(spec?.data) ? spec.data : []
  const layers = React.useMemo(
    () => shown.layers.filter((l) => !muted.has(l.label || l.field)),
    [shown.layers, muted],
  )

  const geom = React.useMemo(() => {
    if (!rows.length || !layers.length || width <= 0) return null

    const h = spec.height || 260
    const plotW = Math.max(width - PAD.left - PAD.right, 10)
    const plotH = Math.max(h - PAD.top - PAD.bottom, 10)

    const xField = spec.x?.field
    const categories = rows.map((r, i) => (xField ? r[xField] : i))

    // Categorical x: bars need band centres, so every mark uses the same
    // centres and lines sit over the middle of their bar.
    const bandW = plotW / Math.max(categories.length, 1)
    const xAt = (i) => PAD.left + bandW * i + bandW / 2
    const indexOfX = (value) => categories.findIndex((c) => String(c) === String(value))

    // Two scales, because a layer may ask for the right-hand axis.
    const scaleFor = (side) => {
      const fields = layers.filter((l) => (l.axis || 'left') === side).map((l) => l.field)
      if (!fields.length) return null
      const values = []
      for (const r of rows) {
        for (const f of fields) {
          const n = num(r[f])
          if (n !== null) values.push(n)
        }
      }
      // Reference lines have to fit inside the plot or they are drawn off it.
      if (side === 'left') {
        for (const rule of shown.rules || []) {
          const n = num(rule.value)
          if (n !== null) values.push(n)
        }
      }
      if (!values.length) return null
      let min = Math.min(...values)
      let max = Math.max(...values)
      if (spec.y?.zero !== false) min = Math.min(min, 0)
      if (min === max) { max = min + Math.abs(min || 1); }
      const span = max - min
      max += span * 0.06
      return {
        min,
        max,
        y: (v) => PAD.top + plotH - ((v - min) / (max - min)) * plotH,
      }
    }

    const left = scaleFor('left')
    const right = scaleFor('right')
    if (!left && !right) return null

    return { h, plotW, plotH, categories, bandW, xAt, indexOfX, left, right, xField }
  }, [rows, layers, width, spec, shown])

  if (!spec) return null

  if (!rows.length) {
    return (
      <Frame spec={spec} shown={shown} boxRef={boxRef} views={views} viewIndex={viewIndex} onView={setViewIndex} muted={muted} onToggleSeries={toggleSeries}>
        <p className="px-3.5 py-6 text-center text-[12px] text-[color:var(--embmis-text-muted)]">
          Nothing to plot — the source returned no rows.
        </p>
      </Frame>
    )
  }

  if (!geom) {
    // Width is 0 on the first paint, before the observer fires. Reserve the
    // height so the chart does not shove the page when it appears.
    return <Frame spec={spec} shown={shown} boxRef={boxRef} views={views} viewIndex={viewIndex} onView={setViewIndex} muted={muted} onToggleSeries={toggleSeries}><div style={{ height: spec.height || 260 }} /></Frame>
  }

  const { h, plotH, categories, bandW, xAt, indexOfX, left, right } = geom
  // Left unless the layer asked for the right-hand axis, and falls back to
  // whichever scale exists when only one side has layers.
  const scaleOf = (layer) => (layer.axis === 'right' && right ? right : left || right)

  /** Which rows a layer covers — `from`/`to` limit it to part of the x range. */
  const rangeOf = (layer) => {
    let a = 0
    let b = categories.length - 1
    if (layer.from !== null && layer.from !== undefined) {
      const i = indexOfX(layer.from)
      if (i >= 0) a = i
    }
    if (layer.to !== null && layer.to !== undefined) {
      const i = indexOfX(layer.to)
      if (i >= 0) b = i
    }
    return [a, b]
  }

  const pointsOf = (layer) => {
    const scale = scaleOf(layer)
    if (!scale) return []
    const [a, b] = rangeOf(layer)
    const out = []
    for (let i = a; i <= b; i += 1) {
      const v = num(rows[i]?.[layer.field])
      if (v === null) continue
      out.push({ i, x: xAt(i), y: scale.y(v), v })
    }
    return out
  }

  // Bars sharing a `stack` name pile up; unstacked bars sit side by side.
  const barLayers = layers.filter((l) => l.mark === 'bar')
  const barGroups = [...new Set(barLayers.map((l) => l.stack || l.field))]
  const barW = barGroups.length ? Math.max((bandW * 0.62) / barGroups.length, 2) : 0

  const hasBands = (shown.bands || []).some((b) => b.label && indexOfX(b.from) >= 0 && indexOfX(b.to) >= 0)
  const yTicks = left ? ticksFor(left.min, left.max) : []
  const labelEvery = Math.ceil(categories.length / Math.max(Math.floor(geom.plotW / 62), 1))

  return (
    <Frame spec={spec} shown={shown} boxRef={boxRef} views={views} viewIndex={viewIndex} onView={setViewIndex} muted={muted} onToggleSeries={toggleSeries}>
      <svg width={width} height={h} className="block" role="img" aria-label={spec.title || 'Chart'}>
        {/* Shaded x ranges, behind everything. */}
        {(shown.bands || []).map((band, i) => {
          const a = indexOfX(band.from)
          const b = indexOfX(band.to)
          if (a < 0 || b < 0) return null
          const x0 = PAD.left + bandW * Math.min(a, b)
          const x1 = PAD.left + bandW * (Math.max(a, b) + 1)
          return (
            <g key={`band-${i}`} className="sim-draw-fade">
              <rect
                x={x0} y={PAD.top} width={Math.max(x1 - x0, 1)} height={plotH}
                fill={tone(band.tone)} opacity={0.09}
              />
              {band.label && (
                <text x={x0 + 5} y={PAD.top + 11} fontSize="9.5" fill={tone(band.tone)} opacity={0.9}>
                  {band.label}
                </text>
              )}
            </g>
          )
        })}

        {/* Gridlines and the left axis. */}
        {yTicks.map((t, i) => (
          <g key={`grid-${i}`}>
            <line
              x1={PAD.left} x2={width - PAD.right} y1={left.y(t)} y2={left.y(t)}
              stroke="currentColor" strokeOpacity={0.09} className="text-slate-400"
            />
            <text
              x={PAD.left - 7} y={left.y(t) + 3} textAnchor="end" fontSize="9.5"
              fill="currentColor" className="text-slate-500"
            >
              {formatTick(t, spec.y?.format)}
            </text>
          </g>
        ))}

        {/* x labels, thinned to whatever fits. */}
        {categories.map((c, i) => (i % labelEvery === 0 ? (
          <text
            key={`x-${i}`} x={xAt(i)} y={h - 8} textAnchor="middle" fontSize="9.5"
            fill="currentColor" className="text-slate-500"
          >
            {String(c ?? '').slice(0, 12)}
          </text>
        ) : null))}

        {/* One invisible column per category, catching the pointer.

            Without these you have to land on a 3px stroke to read a value,
            which is impossible on a phone. The whole column is the target, and
            the nearest point on each visible series is reported. */}
        {categories.map((c, i) => (
          <rect
            key={`hit-${i}`}
            x={PAD.left + bandW * i}
            y={PAD.top}
            width={bandW}
            height={plotH}
            fill="transparent"
            style={{ cursor: 'crosshair' }}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            onTouchStart={() => setHover(i)}
          />
        ))}

        {/* The column under the pointer. */}
        {hover !== null && (
          <line
            x1={xAt(hover)} x2={xAt(hover)} y1={PAD.top} y2={PAD.top + plotH}
            stroke="var(--sim-live)" strokeWidth={1} opacity={0.42}
          />
        )}

        {/* Layers, back to front, in the order the model wrote them. */}
        {layers.map((layer, li) => {
          const pts = pointsOf(layer)
          if (!pts.length) return null
          const colour = tone(layer.tone)
          const scale = scaleOf(layer)

          if (layer.mark === 'bar') {
            const group = barGroups.indexOf(layer.stack || layer.field)
            return (
              <g key={`l-${li}`} className="sim-draw-fade">
                {pts.map((p) => {
                  const zero = scale.y(Math.max(scale.min, 0))
                  const top = Math.min(p.y, zero)
                  const height = Math.max(Math.abs(zero - p.y), 1)
                  return (
                    <rect
                      key={p.i}
                      x={p.x - (barW * barGroups.length) / 2 + group * barW}
                      y={top}
                      width={Math.max(barW - 1.5, 1.5)}
                      height={height}
                      fill={colour}
                      opacity={layer.opacity}
                      rx={1.5}
                    />
                  )
                })}
              </g>
            )
          }

          const d = pts.map((p, i) => {
            if (i === 0) return `M ${p.x} ${p.y}`
            if (layer.mark === 'step') return `H ${p.x} V ${p.y}`
            return `L ${p.x} ${p.y}`
          }).join(' ')

          if (layer.mark === 'area') {
            const base = scale.y(Math.max(scale.min, 0))
            return (
              <g key={`l-${li}`} className="sim-draw-fade">
                <defs>
                  <linearGradient id={`sim-fill-${li}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={colour} stopOpacity={layer.opacity} />
                    <stop offset="100%" stopColor={colour} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <path
                  d={`${d} L ${pts[pts.length - 1].x} ${base} L ${pts[0].x} ${base} Z`}
                  fill={`url(#sim-fill-${li})`}
                />
              </g>
            )
          }

          if (layer.mark === 'point') {
            return (
              <g key={`l-${li}`} className="sim-draw-fade">
                {pts.map((p) => (
                  <circle key={p.i} cx={p.x} cy={p.y} r={3} fill={colour} opacity={layer.opacity} />
                ))}
              </g>
            )
          }

          // Line and step. The path draws itself on: `--len` is an estimate of
          // its length, which only has to be >= the real length for the dash
          // offset to start fully hidden.
          const len = Math.round(geom.plotW + plotH * pts.length * 0.5) + 200
          return (
            <g key={`l-${li}`}>
              <path
                d={d}
                fill="none"
                stroke={colour}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={layer.dashed ? '5 4' : undefined}
                opacity={layer.opacity}
                className={layer.dashed ? undefined : 'sim-draw'}
                style={layer.dashed ? undefined : { '--len': len }}
              />
              {layer.points && pts.map((p) => (
                <circle key={p.i} cx={p.x} cy={p.y} r={2.6} fill={colour} className="sim-draw-fade" />
              ))}
            </g>
          )
        })}

        {/* Reference lines, over the data so they read as a threshold. */}
        {(shown.rules || []).map((rule, i) => {
          if (!left) return null
          const y = left.y(rule.value)
          if (!Number.isFinite(y)) return null
          return (
            <g key={`rule-${i}`} className="sim-draw-fade">
              <line
                x1={PAD.left} x2={width - PAD.right} y1={y} y2={y}
                stroke={tone(rule.tone)} strokeWidth={1} strokeDasharray="4 4" opacity={0.85}
              />
              {rule.label && (
                <text
                  x={width - PAD.right - 2} y={y - 5} textAnchor="end" fontSize="9.5"
                  fill={tone(rule.tone)}
                >
                  {rule.label} {formatTick(rule.value, spec.y?.format)}
                </text>
              )}
            </g>
          )
        })}

        {/* Notes pinned to a point. */}
        {(shown.annotations || []).map((note, i) => {
          const idx = indexOfX(note.x)
          if (idx < 0 || !left) return null
          const v = num(rows[idx]?.[note.field])
          const y = v === null ? PAD.top + plotH / 2 : left.y(v)
          const x = xAt(idx)
          const flip = x > width * 0.6
          // Below the band labels, which own the first line, and stepped down
          // per annotation so two notes near the same x do not overprint each
          // other. Text drawn on top of text is worse than no text.
          const labelY = PAD.top + (hasBands ? 24 : 11) + i * 12
          return (
            <g key={`note-${i}`} className="sim-draw-fade">
              <circle cx={x} cy={y} r={4} fill="none" stroke={tone(note.tone)} strokeWidth={1.5} />
              <line x1={x} y1={y} x2={x} y2={labelY + 3} stroke={tone(note.tone)} strokeWidth={1} opacity={0.45} />
              <text
                x={flip ? x - 6 : x + 6} y={labelY}
                textAnchor={flip ? 'end' : 'start'} fontSize="9.5" fill={tone(note.tone)}
              >
                {note.text}
              </text>
            </g>
          )
        })}
        {/* Points on the hovered column, over everything. */}
        {hover !== null && layers.map((layer, li) => {
          const scale = scaleOf(layer)
          const [a, b] = rangeOf(layer)
          if (hover < a || hover > b || !scale) return null
          const v = num(rows[hover]?.[layer.field])
          if (v === null || layer.mark === 'bar') return null
          return (
            <circle
              key={`hv-${li}`} cx={xAt(hover)} cy={scale.y(v)} r={4}
              fill={tone(layer.tone)} stroke="rgba(2,5,16,0.9)" strokeWidth={1.5}
            />
          )
        })}
      </svg>

      {hover !== null && (() => {
        const readings = layers.map((layer) => {
          const [a, b] = rangeOf(layer)
          if (hover < a || hover > b) return null
          const v = num(rows[hover]?.[layer.field])
          return v === null ? null : { label: layer.label || layer.field, tone: layer.tone, value: v }
        }).filter(Boolean)
        if (!readings.length) return null

        // Deduplicated: an area and a line over the same field are one reading.
        const seen = new Set()
        const unique = readings.filter((r) => {
          if (seen.has(r.label)) return false
          seen.add(r.label)
          return true
        })

        // Flips to the left of the pointer near the right edge, so the readout
        // is never clipped by the chart's own box.
        const x = xAt(hover)
        const flip = x > width * 0.62
        return (
          <div
            className="sim-readout"
            style={{ left: flip ? undefined : x + 10, right: flip ? width - x + 10 : undefined, top: PAD.top + 4 }}
          >
            <div className="mb-1 text-[10px] uppercase tracking-[0.07em] text-[color:var(--embmis-text-faint)]">
              {String(categories[hover] ?? '')}
            </div>
            {unique.map((r) => (
              <div key={r.label} className="flex items-center gap-2 whitespace-nowrap">
                <span className="h-1.5 w-1.5 flex-none rounded-full" style={{ background: tone(r.tone) }} />
                <span className="min-w-0 flex-1 truncate text-[color:var(--embmis-text-muted)]">{r.label}</span>
                <span className="flex-none font-semibold tabular-nums text-[color:var(--embmis-text-strong)]">
                  {formatTick(r.value, spec.y?.format)}
                </span>
              </div>
            ))}
          </div>
        )
      })()}
    </Frame>
  )
}

/**
 * Title, view chips, the legend (which is also a control), and the line that
 * says where the numbers came from.
 */
function Frame({
  spec, shown, boxRef, views, viewIndex, onView, muted, onToggleSeries, children,
}) {
  // One entry per distinct label+style. A series drawn as an area under a line
  // is three layers and one idea, and listing "Cash" three times tells the
  // reader nothing except that the renderer is naive.
  const seen = new Set()
  const keys = (shown?.layers || []).filter((l) => {
    if (!l.label) return false
    const key = `${l.label}|${l.dashed ? 'dash' : 'solid'}|${l.tone}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const p = spec.provenance
  const rules = shown?.rules || []

  return (
    <div className="sim-visual">
      <div className="sim-visual-head">
        <span className="text-[13.5px] font-semibold text-[color:var(--embmis-text-strong)]">
          {spec.title}
        </span>
        {shown?.subtitle && (
          <span className="text-[11.5px] text-[color:var(--embmis-text-muted)]">{shown.subtitle}</span>
        )}
      </div>

      {/* Views the model wrote: the same rows, presented differently. */}
      {views && views.length > 1 && (
        <div className="sim-chips">
          {views.map((v, i) => (
            <button
              key={v.label}
              type="button"
              onClick={() => onView(i)}
              aria-pressed={i === viewIndex}
              className={`sim-chip ${i === viewIndex ? 'is-on' : ''}`}
            >
              {v.label}
            </button>
          ))}
        </div>
      )}

      {/* The legend is a control. Clicking a series takes it off the chart,
          which is the fastest way to read a busy one. */}
      {spec.legend !== false && keys.length > 1 && (
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 pb-1.5 pl-2.5 pt-0.5">
          {keys.map((l) => {
            const off = muted.has(l.label || l.field)
            return (
              <button
                key={`${l.field}-${l.label}`}
                type="button"
                onClick={() => onToggleSeries(l.label || l.field)}
                aria-pressed={!off}
                title={off ? `Show ${l.label}` : `Hide ${l.label}`}
                className={`sim-key ${off ? 'is-off' : ''}`}
              >
                <span
                  className="sim-key-swatch"
                  style={{
                    background: l.dashed
                      ? `repeating-linear-gradient(90deg, ${tone(l.tone)} 0 3px, transparent 3px 6px)`
                      : tone(l.tone),
                  }}
                />
                {l.label}
              </button>
            )
          })}
        </div>
      )}

      <div ref={boxRef} className="relative w-full">{children}</div>

      {/* Says who. A chart in an ERP should always be able to answer that. */}
      {(p || spec.truncated || spec.y?.zero === false || rules.some((r) => r.note)) && (
        <div className="sim-visual-foot flex flex-col gap-0.5">
          {p && (
            <span className="flex items-start gap-1.5 text-[10.5px] leading-snug text-[color:var(--embmis-text-faint)]">
              <Info className="mt-px h-2.5 w-2.5 flex-none" />
              {p.kind === 'query'
                ? <span className="min-w-0">Queried: {p.question}</span>
                : <span className="min-w-0">From {p.tool}{p.path ? ` · ${p.path}` : ''}</span>}
            </span>
          )}
          {rules.filter((r) => r.note).map((r, i) => (
            <span key={`n-${i}`} className="text-[10.5px] leading-snug text-[color:var(--embmis-text-faint)]">
              {r.label || 'Reference line'}: {r.note}
            </span>
          ))}
          {spec.truncated && (
            <span className="text-[10.5px] text-[color:var(--embmis-text-faint)]">
              Showing {spec.truncated.shown.toLocaleString()} of {spec.truncated.total.toLocaleString()} rows.
            </span>
          )}
          {/* A truncated axis exaggerates a change. If the model turned zero
              off, the reader is told, because otherwise the shape lies. */}
          {spec.y?.zero === false && (
            <span className="text-[10.5px] text-[color:var(--embmis-text-faint)]">
              The vertical axis does not start at zero.
            </span>
          )}
        </div>
      )}
    </div>
  )
}
