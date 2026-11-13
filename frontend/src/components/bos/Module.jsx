
/**
 * A module — the single container primitive of the EMBMIS surface.
 *
 * The old dashboard had five different card treatments (glass card, gradient
 * tile, bare section, coloured quick-action block, chrome-less divider list),
 * which is why it read as a template rather than as one product. Everything on
 * the new surface is a module: same border, same lit top edge, same header
 * grammar (eyebrow left, one action right), same internal rhythm. Hierarchy
 * comes from size, position and energy — never from a different box.
 */

/** The small computational tick motif that marks a live system readout. */
// Retired: an animated "live readout" glyph that carried no information.
// Kept as a no-op so existing call sites render calmly.
export function Ticks() {
  return null
}

export function ModuleHeader({ title, action }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-2">
        <h2 className="min-w-0 text-sm font-semibold text-fg">{title}</h2>
      </div>
      {action ? <div className="flex flex-none items-center gap-2">{action}</div> : null}
    </div>
  )
}

export default function Module({
  title,
  action,
  accent,
  ticks = false,
  padding = 'p-5',
  className = '',
  bodyClassName = '',
  children,
  style,
  as: Tag = 'section',
}) {
  return (
    <Tag
      className={`bos-panel ${accent ? `bos-accent-${accent}` : ''} ${padding} ${className}`}
      style={style}
    >
      {title ? <ModuleHeader title={title} action={action} accent={accent} ticks={ticks} /> : null}
      <div className={bodyClassName}>{children}</div>
    </Tag>
  )
}

/**
 * The one-line empty/denied state used everywhere a feed can legitimately come
 * back with nothing. Kept as a component so "no permission" and "genuinely
 * empty" never drift into two different visual treatments — the dashboard's
 * rule is that a panel which cannot answer says so quietly and keeps its place
 * in the layout, rather than disappearing and reflowing the grid.
 */
export function ModuleEmpty({ children, tone = 'muted' }) {
  return (
    <p className={`py-1.5 text-sm ${tone === 'muted' ? 'text-ink-500' : 'text-ink-600'}`}>
      {children}
    </p>
  )
}
