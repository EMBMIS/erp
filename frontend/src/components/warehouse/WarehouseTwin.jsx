import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { SparklesIcon } from '@heroicons/react/24/outline'

import api from '../../services/api'
import Module, { ModuleEmpty } from '../bos/Module'
import { DeliveryChain } from '../sales/DeliveryRisk'

/**
 * The warehouse twin: every bay drawn from live stock.
 *
 * The same model Simeli answers "which bays are short?" from
 * (GET /api/warehouse-twin, services/warehouseTwin.js). A location is a floor,
 * a bin is a bay, a bay's height is how many days its stock lasts, and its
 * colour says whether the company's stock can cover the orders due — so a
 * rack that is short is short on the screen, with the order it puts at risk
 * one click away. Proposals are proposals: Simeli drafts, a person approves,
 * and an order's recovery plan is approved by a manager on the order.
 *
 * TwinFloor only draws a model it is given; it is also what a Sandbox-built
 * "digital twin" application renders (components/platform/blocks.jsx).
 */

const ask = (q) => `/ai/chat?q=${encodeURIComponent(q)}`

export const BAY_TONE = {
  short: { fill: '#f43f5e', label: 'Below the order', accent: 'rose' },
  low: { fill: '#f59e0b', label: 'Low cover', accent: 'amber' },
  ok: { fill: '#8b5cf6', label: 'Covered', accent: 'violet' },
  idle: { fill: '#22d3ee', label: 'Not moving', accent: 'cyan' },
  empty: { fill: '#64748b', label: 'Empty', accent: 'slate' },
}

const MAX_COVER = 30

function money(value, cur) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD', maximumFractionDigits: 0 }).format(value || 0)
  } catch {
    return `${Math.round(value || 0).toLocaleString()} ${cur || ''}`
  }
}

function coverText(b) {
  if (b.status === 'empty') return 'Empty'
  if (b.cover_days == null) return 'No movement'
  return `Cover ${b.cover_days} days`
}

/** One floor, isometric: bays in rows, height = days of cover. */
function Floor({ bays, selected, onSelect }) {
  const cols = Math.min(6, Math.max(2, Math.ceil(Math.sqrt(bays.length || 1))))
  const rows = Math.max(1, Math.ceil(bays.length / cols))
  const AX = 24
  const AY = 13.5
  const W = 1.15
  const D = 1.6
  const gapX = 1.9
  const gapY = 2.6
  const spanX = cols * gapX + 0.6
  const spanY = rows * gapY + 0.6
  // A floor with few bays still draws at a readable scale: the drawing never
  // gets narrower than MIN_W units, and sits centred in it.
  const MIN_W = 600
  const contentW = 80 + (spanX + spanY) * AX
  const OX = 40 + spanY * AX + Math.max(0, (MIN_W - contentW) / 2)
  const OY = 34
  const p = (x, y, z = 0) => [OX + (x - y) * AX, OY + (x + y) * AY - z]
  const pt = (x, y, z) => p(x, y, z).map((v) => v.toFixed(1)).join(' ')
  const width = Math.max(MIN_W, contentW)
  const height = OY + (spanX + spanY) * AY + 90
  const maxH = 84

  const placed = bays.map((b, i) => ({ b, x: 0.5 + (i % cols) * gapX, y: 0.5 + Math.floor(i / cols) * gapY }))
  // Back to front, so near bays hide far ones.
  const drawOrder = [...placed].sort((a, c) => (a.x + a.y) - (c.x + c.y))
  const callout = placed.find((q) => q.b.id === selected) || placed.find((q) => q.b.status === 'short') || null

  return (
    <svg viewBox={`0 0 ${width.toFixed(0)} ${height.toFixed(0)}`} className="mx-auto block max-h-[420px] w-full max-w-[680px]" role="img" aria-label="Isometric model of the warehouse bays with live stock cover">
      <path
        d={`M${pt(0, 0, 0)} L${pt(spanX, 0, 0)} L${pt(spanX, spanY, 0)} L${pt(0, spanY, 0)} Z`}
        fill="rgba(99,102,241,0.08)" stroke="rgba(140,165,245,0.25)" strokeWidth="1"
      />
      {drawOrder.map(({ b, x, y }) => {
        const tone = BAY_TONE[b.status] || BAY_TONE.ok
        const h = b.status === 'empty' ? 2 : Math.max(8, (Math.min(b.cover_days ?? MAX_COVER, MAX_COVER) / MAX_COVER) * maxH)
        const x0 = x
        const x1 = x + W
        const y0 = y
        const y1 = y + D
        const on = selected === b.id
        return (
          <g key={b.id} onClick={() => onSelect(b.id)} className="cursor-pointer" opacity={selected && !on ? 0.72 : 1}>
            <title>{`${b.label} · ${b.location} · ${coverText(b)}${b.status === 'short' ? ' · below the order' : ''}`}</title>
            <path d={`M${pt(x0, y0, h)} L${pt(x1, y0, h)} L${pt(x1, y1, h)} L${pt(x0, y1, h)} Z`} fill={tone.fill} fillOpacity={b.status === 'empty' ? 0.15 : 0.9} stroke={on ? '#fff' : tone.fill} strokeWidth={on ? 1.6 : 0.8} />
            <path d={`M${pt(x1, y0, h)} L${pt(x1, y1, h)} L${pt(x1, y1, 0)} L${pt(x1, y0, 0)} Z`} fill={tone.fill} fillOpacity={b.status === 'empty' ? 0.08 : 0.55} stroke={tone.fill} strokeOpacity="0.6" strokeWidth="0.6" />
            <path d={`M${pt(x0, y1, h)} L${pt(x1, y1, h)} L${pt(x1, y1, 0)} L${pt(x0, y1, 0)} Z`} fill={tone.fill} fillOpacity={b.status === 'empty' ? 0.1 : 0.72} stroke={tone.fill} strokeOpacity="0.6" strokeWidth="0.6" />
            {b.status !== 'empty' && [0.34, 0.67].map((f) => {
              const [ax, ay] = p(x1, y0, h * f)
              const [bx, by] = p(x1, y1, h * f)
              return <line key={f} x1={ax} y1={ay} x2={bx} y2={by} stroke="rgba(255,255,255,0.28)" strokeWidth="0.7" />
            })}
            {(() => {
              const [lx, ly] = p(x0 + W / 2, y1 + 0.35, 0)
              return <text x={lx} y={ly + 9} fontSize="8" textAnchor="middle" className="fill-current opacity-60" style={{ fontFamily: 'ui-monospace, monospace' }}>{b.label}</text>
            })()}
          </g>
        )
      })}
      {callout && (() => {
        const b = callout.b
        const tone = BAY_TONE[b.status] || BAY_TONE.ok
        const h = b.status === 'empty' ? 2 : Math.max(8, (Math.min(b.cover_days ?? MAX_COVER, MAX_COVER) / MAX_COVER) * maxH)
        const [cx, cy] = p(callout.x + W / 2, callout.y + D / 2, h)
        const bx = Math.min(Math.max(cx - 130, 6), width - 266)
        const by = height - 46
        return (
          <g pointerEvents="none">
            <circle cx={cx} cy={cy} r="3.5" fill={tone.fill} />
            <circle cx={cx} cy={cy} r="10" fill="none" stroke={tone.fill} strokeOpacity="0.5" />
            <line x1={cx} y1={cy} x2={bx + 130} y2={by} stroke={tone.fill} strokeOpacity="0.5" strokeDasharray="3 3" />
            <rect x={bx} y={by} width="260" height="38" rx="8" fill="rgba(4,8,24,0.9)" stroke={tone.fill} strokeOpacity="0.45" />
            <text x={bx + 12} y={by + 15} fontSize="9" fill={tone.fill} letterSpacing="1.2" style={{ fontFamily: 'ui-monospace, monospace' }}>
              {`BAY ${b.label}`.toUpperCase()} · {b.location.length > 16 ? `${b.location.slice(0, 15).toUpperCase()}…` : b.location.toUpperCase()}
            </text>
            <text x={bx + 12} y={by + 29} fontSize="9" fill="#a5b4d6" style={{ fontFamily: 'ui-monospace, monospace' }}>
              {coverText(b)}{b.status === 'short' ? ' · below the order' : b.status === 'low' ? ' · low' : ''}
            </text>
          </g>
        )
      })()}
    </svg>
  )
}

function BayDetail({ bay, currency }) {
  const tone = BAY_TONE[bay.status] || BAY_TONE.ok
  return (
    <div className={`bos-row bos-accent-${tone.accent} mt-3 flex-col !items-stretch`}>
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="text-[13px] font-medium bos-text">{bay.code ? `Bay ${bay.code}` : 'Floor stock'} · {bay.location}</span>
            <span className={`bos-chip bos-accent-${tone.accent}`}>{tone.label}</span>
          </span>
          <span className="mt-0.5 block bos-caption">
            {bay.description}
            {bay.fill_pct != null ? ` · ${bay.fill_pct}% full` : ''}
            {bay.units ? ` · ${bay.units} units` : ''}
            {bay.value ? ` · ${money(bay.value, currency)}` : ''}
          </span>
        </span>
        {bay.value_at_risk ? <span className="flex-none bos-caption">{money(bay.value_at_risk, currency)} of orders at risk</span> : null}
      </div>

      {bay.items?.length ? (
        <table className="mt-2 w-full text-left text-[12.5px]">
          <thead>
            <tr className="bos-caption">
              <th className="pb-1 font-medium">Item</th>
              <th className="pb-1 font-medium text-right">On bay</th>
              <th className="pb-1 font-medium text-right">Per day</th>
              <th className="pb-1 font-medium text-right">Cover</th>
              <th className="pb-1 font-medium text-right">Due ({'≤'}horizon)</th>
              <th className="pb-1 font-medium text-right">Short</th>
            </tr>
          </thead>
          <tbody>
            {bay.items.map((i) => (
              <tr key={i.inventory_item_id} className="bos-text">
                <td className="py-0.5 pr-2"><Link to={`/inventory/items/${i.inventory_item_id}`} className="bos-link">{i.name}</Link></td>
                <td className="py-0.5 text-right tabular-nums">{i.qty}</td>
                <td className="py-0.5 text-right tabular-nums">{i.daily_use || '—'}</td>
                <td className="py-0.5 text-right tabular-nums">{i.cover_days != null ? `${i.cover_days} d` : '—'}</td>
                <td className="py-0.5 text-right tabular-nums">{i.due_in_horizon || '—'}</td>
                <td className="py-0.5 text-right tabular-nums">{i.short_for_orders > 0 ? <span className="bos-accent-rose">{i.short_for_orders}</span> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="mt-1 bos-caption">Nothing is placed in this bay.</p>}

      {bay.chain?.length ? <div className="mt-2"><DeliveryChain chain={bay.chain} /></div> : null}

      {bay.proposals?.length ? (
        <div className="mt-3">
          <span className="block text-[10px] font-semibold uppercase tracking-wider bos-text-faint">Simeli proposes · you decide</span>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {bay.proposals.map((p) => (
              <li key={p.label} className="flex items-start justify-between gap-3 text-[13px]">
                <span className="min-w-0">{p.label}</span>
                {p.record?.type === 'sales_order' && /delivery outlook/.test(p.label) ? (
                  <Link to={`/sales/sales-orders/${p.record.id}`} className="bos-link flex-none whitespace-nowrap">Open {p.record.number} →</Link>
                ) : (
                  <Link to={ask(`${p.label}${p.record?.number ? ` (for ${p.record.number})` : ''} — draft it for my approval.`)} className="bos-link flex-none whitespace-nowrap">Ask Simeli →</Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Link
        to={ask(`What is in ${bay.code ? `bay ${bay.code}` : 'the floor stock'} at ${bay.location}, how long does it last, and which orders does it put at risk?`)}
        className="bos-link mt-3 inline-flex items-center gap-1 text-[13px]"
      >
        <SparklesIcon className="h-3.5 w-3.5" /> Ask Simeli about this bay
      </Link>
    </div>
  )
}

/** Draws a twin model: location tabs, the floor, the selected bay. */
export function TwinFloor({ twin, currency, initialLocation = null }) {
  const locations = twin?.locations || []
  const firstWithShort = locations.find((l) => l.short_bays)?.id
  const [locId, setLocId] = useState(initialLocation || firstWithShort || locations[0]?.id || null)
  const bays = useMemo(
    () => (twin?.bays || []).filter((b) => !locId || b.location_id === locId)
      .sort((a, b) => String(a.label).localeCompare(String(b.label))),
    [twin, locId],
  )
  const [selected, setSelected] = useState(null)
  useEffect(() => {
    const short = bays.find((b) => b.status === 'short') || bays.find((b) => b.status === 'low')
    setSelected(short ? short.id : null)
  }, [bays])
  const bay = bays.find((b) => b.id === selected)
  const loc = locations.find((l) => l.id === locId)

  if (!locations.length) return <ModuleEmpty>No storage locations yet — add one under Warehouse, and the twin draws it.</ModuleEmpty>

  return (
    <div>
      {locations.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {locations.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => setLocId(l.id)}
              className={`bos-chip ${l.id === locId ? 'bos-accent-violet' : ''} ${l.short_bays ? '' : 'opacity-80'}`}
            >
              {l.name}{l.short_bays ? ` · ${l.short_bays} short` : ''}
            </button>
          ))}
        </div>
      )}
      {loc && (
        <p className="mb-1 bos-caption">
          {loc.city ? `${loc.city} · ` : ''}{loc.bays} bays · {loc.stocked_bays} stocked
          {loc.fill_pct != null ? ` · ${loc.fill_pct}% full` : ''}
          {loc.short_bays ? ` · ${loc.short_bays} below the order` : ''}
          {loc.low_bays ? ` · ${loc.low_bays} low` : ''}
          {loc.orders_at_risk ? ` · ${loc.orders_at_risk} orders at risk (${money(loc.value_at_risk, currency)})` : ''}
          {loc.in_transit_in?.length ? ` · ${loc.in_transit_in.length} transfer${loc.in_transit_in.length === 1 ? '' : 's'} inbound` : ''}
        </p>
      )}
      {bays.length ? (
        <Floor bays={bays} selected={selected} onSelect={(id) => setSelected(id === selected ? null : id)} />
      ) : <ModuleEmpty>No bins or placed stock at this location yet.</ModuleEmpty>}
      <div className="mt-1 flex flex-wrap gap-3 bos-caption">
        {Object.entries(BAY_TONE).map(([k, t]) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm" style={{ background: t.fill }} /> {t.label}
          </span>
        ))}
        <span>· height = days of cover (to {MAX_COVER})</span>
      </div>
      {bay ? <BayDetail bay={bay} currency={currency} /> : null}
      {twin?.unplaced?.length ? (
        <p className="mt-3 bos-caption">
          On the item record but in no bay: {twin.unplaced.slice(0, 3).map((u) => `${u.unplaced} × ${u.name}`).join(', ')}
          {twin.unplaced.length > 3 ? ` and ${twin.unplaced.length - 3} more` : ''}.
        </p>
      ) : null}
    </div>
  )
}

/** For the Warehouse overview (every location) and one storage location's page. */
export default function WarehouseTwinModule({ locationId = null, className = '' }) {
  const [state, setState] = useState({ loading: true, data: null, error: null })
  useEffect(() => {
    let live = true
    setState((s) => ({ ...s, loading: true }))
    api.get('/warehouse-twin', { params: locationId ? { location_id: locationId } : {} })
      .then((r) => live && setState({ loading: false, data: r.data?.data || null, error: null }))
      .catch((e) => live && setState({
        loading: false,
        data: null,
        error: e?.response?.status === 403 ? 'Not available for this company.' : (e?.response?.data?.error || 'Could not read the warehouse.'),
      }))
    return () => { live = false }
  }, [locationId])
  const { loading, data, error } = state

  return (
    <Module
      title="Warehouse twin"
      accent="violet"
      ticks
      className={className}
      action={<Link to={ask(locationId && data?.locations?.[0] ? `Which bays at ${data.locations[0].name} are short, and which orders do they put at risk?` : 'Which warehouse bays are short right now, and which orders do they put at risk?')} className="bos-link">Ask Simeli</Link>}
    >
      {error ? (
        <ModuleEmpty>{error}</ModuleEmpty>
      ) : loading && !data ? (
        <ModuleEmpty>Walking the warehouse bay by bay…</ModuleEmpty>
      ) : (
        <>
          <p className="mb-2 text-[13px] bos-text">{data.headline}</p>
          <TwinFloor twin={data} currency={data.currency} initialLocation={locationId} />
        </>
      )}
    </Module>
  )
}
