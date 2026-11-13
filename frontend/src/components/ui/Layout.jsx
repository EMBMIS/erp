import React, { useId, useRef, useState, useEffect } from 'react'
import clsx from 'clsx'
import { Link } from 'react-router-dom'
import { ChevronRightIcon } from '@heroicons/react/20/solid'

/**
 * Card — the one container. Hairline border, no shadow. A card is a group of
 * things that belong together; it is not decoration, so most screens need
 * fewer of them than they think.
 */
export function Card({ title, description, subtitle, actions, children, className, bodyClassName, padded = true, as: Tag = 'section', eyebrow }) {
  const desc = description ?? subtitle
  return (
    <Tag className={clsx('min-w-0 rounded-lg border border-ink-200 bg-surface', className)}>
      {(title || actions || eyebrow) && (
        <header className="flex items-start justify-between gap-3 border-b border-ink-200 px-4 py-2.5">
          <div className="min-w-0">
            {eyebrow && <p className="label-mono mb-0.5">{eyebrow}</p>}
            {title && <h2 className="truncate text-sm font-semibold text-fg">{title}</h2>}
            {desc && <p className="mt-0.5 text-xs text-ink-500">{desc}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div className={clsx(padded && 'p-4', bodyClassName)}>{children}</div>
    </Tag>
  )
}

/** Breadcrumbs — where this screen sits. The last crumb is the page itself. */
export function Breadcrumbs({ items = [], className }) {
  if (!items.length) return null
  return (
    <nav aria-label="Breadcrumb" className={clsx('min-w-0', className)}>
      <ol className="flex min-w-0 items-center gap-1 text-xs text-ink-500">
        {items.map((item, i) => {
          const last = i === items.length - 1
          return (
            <li key={`${item.label}-${i}`} className={clsx('flex min-w-0 items-center gap-1', !last && 'shrink-0')}>
              {item.to && !last ? (
                <Link to={item.to} className="truncate rounded hover:text-ink-900 hover:underline underline-offset-2">{item.label}</Link>
              ) : (
                <span className="truncate" aria-current={last ? 'page' : undefined}>{item.label}</span>
              )}
              {!last && <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-ink-400" aria-hidden="true" />}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/**
 * PageHeader — the same on every screen:
 *   breadcrumbs
 *   title  [status]  [maturity]                 [secondary…] [PRIMARY]
 *   one line saying what this screen is for, or the record's key metadata
 *
 * Exactly one primary action. Secondary actions sit to its left; anything
 * further goes in a "More" menu supplied by the page.
 */
export function PageHeader({ title, description, subtitle, breadcrumbs, status, badge, meta, primary, secondary, actions, icon: Icon, children, className, sticky = false }) {
  const desc = description ?? subtitle
  return (
    <header className={clsx('mb-5', sticky && 'sticky top-0 z-10 -mx-4 bg-canvas/95 px-4 pb-3 pt-1 backdrop-blur-sm sm:-mx-6 sm:px-6', className)}>
      {breadcrumbs && <Breadcrumbs items={breadcrumbs} className="mb-1.5" />}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 items-start gap-3">
          {Icon && (
            <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-ink-200 bg-surface text-ink-600">
              <Icon className="h-4 w-4" aria-hidden="true" />
            </span>
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight text-fg sm:text-2xl">{title}</h1>
              {status}
              {badge}
            </div>
            {desc && <p className="mt-1 max-w-3xl text-sm text-ink-600">{desc}</p>}
            {meta && <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-500">{meta}</div>}
            {children}
          </div>
        </div>
        {(primary || secondary || actions) && (
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            {secondary}
            {actions}
            {primary}
          </div>
        )}
      </div>
    </header>
  )
}

/**
 * Tabs — WAI-ARIA tabs with roving tabindex. Arrow keys move, Home/End jump.
 * tabs: [{ id, label, count, badge }]. Controlled via value/onChange, or
 * uncontrolled with defaultValue. Renders `children(activeId)` or panels[id].
 */
export function Tabs({ tabs = [], value, defaultValue, onChange, children, panels, className, listClassName, size = 'md', label = 'Sections' }) {
  const [inner, setInner] = useState(defaultValue ?? tabs[0]?.id)
  const active = value ?? inner
  const base = useId().replace(/:/g, '')
  const refs = useRef({})
  const select = (id) => { if (value === undefined) setInner(id); onChange?.(id) }
  const onKey = (e, i) => {
    let next = null
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    if (next === null) return
    e.preventDefault()
    const id = tabs[next].id
    select(id)
    refs.current[id]?.focus()
  }
  const content = typeof children === 'function' ? children(active) : panels ? panels[active] : children
  return (
    <div className={className}>
      <div role="tablist" aria-label={label} className={clsx('flex gap-1 overflow-x-auto border-b border-ink-200 ui-scroll', listClassName)}>
        {tabs.map((t, i) => {
          const selected = t.id === active
          return (
            <button
              key={t.id}
              ref={(el) => { refs.current[t.id] = el }}
              type="button"
              role="tab"
              id={`${base}-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`${base}-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(t.id)}
              onKeyDown={(e) => onKey(e, i)}
              className={clsx(
                'relative -mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 font-medium transition-colors',
                size === 'sm' ? 'h-8 px-2 text-xs' : 'h-9 px-2.5 text-sm',
                selected ? 'border-ink-900 text-fg' : 'border-transparent text-ink-500 hover:text-ink-900'
              )}
            >
              {t.label}
              {t.count != null && (
                <span className={clsx('rounded px-1 font-mono text-2xs tabular-nums', selected ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-600')}>
                  {t.count}
                </span>
              )}
              {t.badge}
            </button>
          )
        })}
      </div>
      <div role="tabpanel" id={`${base}-panel-${active}`} aria-labelledby={`${base}-tab-${active}`} tabIndex={0} className="pt-4 focus-visible:outline-offset-4">
        {content}
      </div>
    </div>
  )
}

/** Segmented — a small single-choice control for views and periods. */
export function Segmented({ options = [], value, onChange, label, size = 'sm', className }) {
  return (
    <div role="radiogroup" aria-label={label} className={clsx('inline-flex max-w-full overflow-x-auto rounded-md border border-ink-200 bg-sunken p-0.5 ui-scroll', className)}>
      {options.map((o) => {
        const v = typeof o === 'string' ? o : o.value
        const l = typeof o === 'string' ? o : o.label
        const on = v === value
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange?.(v)}
            className={clsx(
              'shrink-0 whitespace-nowrap rounded px-2 font-medium transition-colors',
              size === 'sm' ? 'h-6 text-xs' : size === 'lg' ? 'h-9 px-3 text-sm' : 'h-7 text-sm',
              on ? 'bg-surface text-fg shadow-[0_0_0_1px_rgb(var(--c-ink-200))]' : 'text-ink-500 hover:text-ink-900'
            )}
          >
            {l}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Menu — a button that opens a list of actions. Arrow keys move, Enter
 * selects, Escape closes and returns focus. items: [{ label, onSelect, icon,
 * tone: 'risk', disabled, hint, divider }]
 */
export function Menu({ label = 'More actions', trigger, items = [], align = 'right', className }) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const btn = useRef(null)
  const list = useRef(null)
  const id = useId().replace(/:/g, '')
  const actionable = items.map((it, i) => (!it.divider && !it.disabled ? i : null)).filter((i) => i !== null)
  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e) => { if (!list.current?.contains(e.target) && !btn.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  useEffect(() => { if (open) { setActive(actionable[0] ?? -1); requestAnimationFrame(() => list.current?.focus()) } }, [open])
  const close = () => { setOpen(false); btn.current?.focus() }
  const onKey = (e) => {
    const pos = actionable.indexOf(active)
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(actionable[(pos + 1) % actionable.length]) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(actionable[(pos - 1 + actionable.length) % actionable.length]) }
    else if (e.key === 'Home') { e.preventDefault(); setActive(actionable[0]) }
    else if (e.key === 'End') { e.preventDefault(); setActive(actionable[actionable.length - 1]) }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); close() }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const it = items[active]; if (it) { close(); it.onSelect?.() } }
  }
  return (
    <div className={clsx('relative inline-block', className)}>
      {React.cloneElement(trigger || <button type="button" className="inline-flex h-8 items-center rounded-md border border-ink-300 bg-surface px-2.5 text-sm text-fg hover:bg-ink-100">More</button>, {
        ref: btn,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': open ? id : undefined,
        'aria-label': trigger?.props?.['aria-label'] || label,
        onClick: (e) => { e.stopPropagation(); setOpen((o) => !o) },
      })}
      {open && (
        <ul
          ref={list}
          id={id}
          role="menu"
          tabIndex={-1}
          aria-activedescendant={active >= 0 ? `${id}-${active}` : undefined}
          onKeyDown={onKey}
          className={clsx('absolute z-50 mt-1 min-w-[180px] rounded-lg border border-ink-200 bg-overlay p-1 shadow-overlay focus:outline-none animate-pop', align === 'right' ? 'right-0' : 'left-0')}
        >
          {items.map((it, i) =>
            it.divider ? (
              <li key={`d${i}`} role="separator" className="my-1 h-px bg-ink-200" />
            ) : (
              <li
                key={it.label}
                id={`${id}-${i}`}
                role="menuitem"
                aria-disabled={it.disabled || undefined}
                onMouseEnter={() => !it.disabled && setActive(i)}
                onClick={(e) => { e.stopPropagation(); if (!it.disabled) { close(); it.onSelect?.() } }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !it.disabled) { close(); it.onSelect?.() } }}
                className={clsx(
                  'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                  it.disabled && 'cursor-not-allowed opacity-50',
                  i === active && 'bg-ink-100',
                  it.tone === 'risk' ? 'text-risk-600' : 'text-ink-800'
                )}
                title={it.disabled && it.reason ? it.reason : undefined}
              >
                {it.icon && <it.icon className="h-4 w-4 shrink-0" aria-hidden="true" />}
                <span className="flex-1">{it.label}</span>
                {it.hint && <span className="font-mono text-2xs text-ink-500">{it.hint}</span>}
              </li>
            )
          )}
        </ul>
      )}
    </div>
  )
}

/** Tooltip — hover and focus. Text only; never the only place information lives. */
export function Tooltip({ content, children, side = 'top' }) {
  const [show, setShow] = useState(false)
  const id = useId().replace(/:/g, '')
  return (
    <span className="relative inline-flex">
      {React.cloneElement(children, {
        'aria-describedby': show ? id : undefined,
        onMouseEnter: () => setShow(true),
        onMouseLeave: () => setShow(false),
        onFocus: () => setShow(true),
        onBlur: () => setShow(false),
      })}
      {show && (
        <span
          role="tooltip"
          id={id}
          className={clsx(
            'pointer-events-none absolute left-1/2 z-50 w-max max-w-[260px] -translate-x-1/2 rounded-md bg-tooltip px-2 py-1 text-xs text-white animate-[ui-fade-in_var(--dur-fast)]',
            side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
          )}
        >
          {content}
        </span>
      )}
    </span>
  )
}

/** Stat — one number with its label, change and reason. Clickable to its records. */
export function Stat({ label, value, delta, reason, to, onClick, loading, className, footnote }) {
  const Tag = to ? Link : onClick ? 'button' : 'div'
  return (
    <Tag
      to={to}
      onClick={onClick}
      type={onClick && !to ? 'button' : undefined}
      className={clsx('group flex min-w-0 flex-col items-stretch justify-start rounded-lg border border-ink-200 bg-surface p-4 text-left', (to || onClick) && 'transition-colors hover:border-ink-300 hover:bg-ink-50', className)}
    >
      <p className="label-mono line-clamp-2 leading-snug">{label}</p>
      <div className="mt-2 flex items-baseline gap-2">
        {loading ? <span className="skeleton h-7 w-24" /> : <span className="truncate text-2xl font-semibold tabular-nums tracking-tight text-fg">{value}</span>}
        {delta}
      </div>
      {reason && <p className="mt-1.5 line-clamp-2 text-xs text-ink-600">{reason}</p>}
      {footnote && <p className="mt-1 text-2xs text-ink-500">{footnote}</p>}
      {(to || onClick) && <span className="mt-auto inline-block pt-2 text-xs text-ink-500 group-hover:text-brand-600">See records →</span>}
    </Tag>
  )
}

export default Card
