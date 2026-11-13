import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import {
  MagnifyingGlassIcon, ChevronRightIcon, ChevronDownIcon, StarIcon as StarOutline, Bars3Icon,
  HomeIcon, CheckBadgeIcon, EnvelopeIcon, Squares2X2Icon, SunIcon, MoonIcon, ComputerDesktopIcon,
  ArrowRightOnRectangleIcon, LifebuoyIcon, DocumentTextIcon, LockClosedIcon, SparklesIcon, ClockIcon,
  ChevronDoubleLeftIcon, ChevronDoubleRightIcon, Cog6ToothIcon, KeyIcon,
} from '@heroicons/react/24/outline'
import { StarIcon as StarSolid } from '@heroicons/react/20/solid'
import toast from 'react-hot-toast'
import LiveNotificationToast from './LiveNotificationToast'
import NotificationBell from './NotificationBell'
import AppSwitcher from './platform/AppSwitcher'
import AppIcon from './platform/AppIcon'
import { companyModulesAPI, COMPANY_MODULES_CHANGED_EVENT, RAIL_CHANGED_EVENT, platformAPI } from '../services/api'
import { useAuth } from '../contexts/AuthContext'
import { useCompany } from '../contexts/CompanyContext'
import { useI18n } from '../contexts/I18nContext'
import { canSeeArea } from '../constants/permissions'
import { getThemeMode, setTheme } from '../utils/darkMode'
import { navigationSections, RAIL, RAIL_FOOT, QUICK_ACTIONS } from './shell/navigation'
import { ShellProvider, useShell } from './shell/ShellContext'
import { searchRecords } from './shell/recordSearch'
import { CommandPalette, Dialog, Kbd, MaturityBadge, Sheet } from './ui'
import SimeliPanel from './shell/SimeliPanel'
import { desktop, inDesktop, serializeNav } from './shell/desktopBridge'

const LS_RAIL = 'embmis.rail.collapsed'
const LS_OPEN = 'embmis.rail.open'

/* =========================================================================
   Navigation projection — authoring model → what this user may see → rail.
   ========================================================================= */

function useVisibleNavigation(user) {
  // Modules this company has switched off (admin → Modules). Null while
  // loading means "show everything": a brief extra link beats a flash of
  // missing navigation.
  const [disabled, setDisabled] = useState(null)
  useEffect(() => {
    let cancelled = false
    const load = () =>
      companyModulesAPI.list()
        .then((res) => {
          if (cancelled) return
          setDisabled(new Set((res.data?.data || []).filter((m) => !m.is_core && !m.enabled).flatMap((m) => [m.nav_section, m.name].filter(Boolean))))
        })
        .catch(() => { if (!cancelled) setDisabled(new Set()) })
    load()
    window.addEventListener(COMPANY_MODULES_CHANGED_EVENT, load)
    return () => { cancelled = true; window.removeEventListener(COMPANY_MODULES_CHANGED_EVENT, load) }
  }, [])

  // Applications this company built. The server returns only surfaces this
  // user's roles reach.
  const [deployed, setDeployed] = useState([])
  useEffect(() => {
    let cancelled = false
    platformAPI.navigation()
      .then((res) => { if (!cancelled) setDeployed(res.data?.data || []) })
      .catch(() => { if (!cancelled) setDeployed([]) })
    return () => { cancelled = true }
  }, [])

  // Applications the person pinned (server-side, follows them across devices).
  const [pinnedApps, setPinnedApps] = useState([])
  useEffect(() => {
    let cancelled = false
    const load = () => platformAPI.rail()
      .then((r) => { if (!cancelled) setPinnedApps(r.data?.data?.pinned || []) })
      .catch(() => { if (!cancelled) setPinnedApps([]) })
    load()
    window.addEventListener(COMPANY_MODULES_CHANGED_EVENT, load)
    window.addEventListener(RAIL_CHANGED_EVENT, load)
    return () => { cancelled = true; window.removeEventListener(COMPANY_MODULES_CHANGED_EVENT, load); window.removeEventListener(RAIL_CHANGED_EVENT, load) }
  }, [])

  const items = useMemo(() => {
    const isOwner = Boolean(user?.is_platform_owner)
    const byName = new Map()
    for (const section of navigationSections) {
      if (!canSeeArea(user?.role, section.area)) continue
      for (const item of section.items) {
        if (item.ownerOnly && !isOwner) continue
        if (disabled?.has(item.name)) continue
        const children = (item.children || []).filter((c) => (!c.ownerOnly || isOwner) && !disabled?.has(c.name))
        if (item.children && !children.length) continue
        byName.set(item.name, { ...item, children, area: section.area })
      }
    }
    const project = (entry) => {
      if (entry.always && !entry.sources) return { ...entry, children: entry.extra || [] }
      const sources = (entry.sources || []).map((n) => byName.get(n)).filter(Boolean)
      if (!sources.length && !entry.always) return null
      let children = sources.flatMap((s) => (s.children?.length ? s.children : s.href ? [{ name: s.name, href: s.href }] : []))
      if (entry.pick) children = entry.pick.map((n) => children.find((c) => c.name === n)).filter(Boolean)
      if (entry.extra) children = [...children, ...entry.extra]
      if (!children.length && !entry.always) return null
      // A child that is the entry's own page is the same link twice.
      const own = children.filter((c) => c.href !== entry.href)
      return { ...entry, children: entry.leaf || !own.length ? [] : children }
    }
    const groups = RAIL.map((g) => ({ ...g, items: g.items.map(project).filter(Boolean) }))
    const build = groups.find((g) => g.group === 'Build')
    if (build && deployed.length) {
      build.items.push(...deployed.map((app) => ({
        key: `app:${app.appKey}`,
        label: app.label,
        icon: Squares2X2Icon,
        href: `/apps/${app.appKey}/${app.defaultPage}`,
        match: [`/apps/${app.appKey}`],
        children: (app.items || []).map((it) => ({ name: it.label, href: `/apps/${app.appKey}/${it.page}` })),
        built: true,
      })))
    }
    return { groups: groups.filter((g) => g.items.length), foot: project(RAIL_FOOT) }
  }, [user?.role, user?.is_platform_owner, disabled, deployed])

  // A server pin for something the rail already lists is the same link twice.
  const extraPins = useMemo(() => {
    const covered = items.groups.flatMap((g) => g.items).flatMap((i) => [i.href, ...(i.match || [])])
    return pinnedApps.filter((p) => !covered.some((h) => h && h !== '/' && (p.route === h || p.route?.startsWith(`${h}/`))))
  }, [items, pinnedApps])

  return { ...items, pinnedApps: extraPins }
}

/** Which rail item and which child the current path belongs to. Longest prefix wins. */
function locate(groups, foot, pathname) {
  const all = [...groups.flatMap((g) => g.items), foot].filter(Boolean)
  let best = null
  let bestLen = -1
  for (const item of all) {
    if (item.exact) {
      if (pathname === item.href && 0 > bestLen) { best = item; bestLen = 0 }
      continue
    }
    for (const prefix of item.match || []) {
      if ((pathname === prefix || pathname.startsWith(`${prefix}/`)) && prefix.length > bestLen) { best = item; bestLen = prefix.length }
    }
  }
  let child = null
  let childLen = -1
  for (const c of best?.children || []) {
    const h = c.href.split('?')[0]
    if ((pathname === h || pathname.startsWith(`${h}/`)) && h.length > childLen) { child = c; childLen = h.length }
  }
  return { item: best, child }
}

function humanSegment(seg) {
  if (seg === 'create' || seg === 'new') return 'New'
  if (seg === 'edit') return 'Edit'
  if (seg === 'view') return null
  if (/^[0-9a-f-]{8,}$/i.test(seg) || /^\d+$/.test(seg)) return 'Record'
  return seg.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

/* =========================================================================
   Rail
   ========================================================================= */

function RailItem({ item, active, activeChild, collapsed, open, onToggle, badge, tNav, onNavigate }) {
  const hasChildren = item.children?.length > 0
  const Icon = item.icon || Squares2X2Icon
  return (
    <li>
      <div className={clsx('group relative flex items-center rounded-md', active && !activeChild ? 'bg-ink-100' : 'hover:bg-ink-100')}>
        <Link
          to={item.href}
          onClick={onNavigate}
          aria-current={active && !activeChild ? 'page' : undefined}
          title={collapsed ? item.label : undefined}
          className={clsx('flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-sm', collapsed ? 'h-9 justify-center' : 'h-8 pl-2 pr-1', active ? 'font-medium text-fg' : 'text-ink-700 hover:text-fg')}
        >
          {active && <span aria-hidden="true" className="absolute left-0 top-1.5 h-5 w-[2px] rounded-full bg-ink-900" />}
          <Icon className={clsx('h-[18px] w-[18px] shrink-0', active ? 'text-ink-900' : 'text-ink-500')} aria-hidden="true" />
          {!collapsed && <span className="truncate">{tNav(item.label)}</span>}
          {!collapsed && item.built && <span className="ml-auto font-mono text-[9px] uppercase tracking-wide text-ink-400">app</span>}
          {badge > 0 && (
            <span className={clsx('rounded bg-brand-600 px-1 font-mono text-[10px] font-medium leading-4 text-white tabular-nums', collapsed ? 'absolute right-1 top-0.5' : 'ml-auto')} aria-label={`${badge} waiting`}>
              {badge > 99 ? '99+' : badge}
            </span>
          )}
        </Link>
        {hasChildren && !collapsed && (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${item.label}`}
            className="mr-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-400 opacity-0 hover:bg-ink-200 hover:text-ink-900 focus-visible:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100"
          >
            <ChevronRightIcon className={clsx('h-3.5 w-3.5 transition-transform duration-fast', open && 'rotate-90')} aria-hidden="true" />
          </button>
        )}
      </div>
      {hasChildren && open && !collapsed && (
        <ul className="mb-1 ml-[18px] mt-0.5 space-y-px border-l border-ink-200 pl-2">
          {item.children.map((c) => {
            const on = activeChild?.href === c.href
            return (
              <li key={c.href}>
                <Link
                  to={c.href}
                  onClick={onNavigate}
                  aria-current={on ? 'page' : undefined}
                  className={clsx('flex h-7 items-center gap-2 rounded px-2 text-[13px]', on ? 'bg-ink-100 font-medium text-fg' : 'text-ink-600 hover:bg-ink-100 hover:text-fg')}
                >
                  <span className="truncate">{tNav(c.name)}</span>
                  {c.maturity && <MaturityBadge level={c.maturity} className="ml-auto shrink-0" />}
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </li>
  )
}

function Rail({ nav, located, collapsed, workCount, tNav, onNavigate, className }) {
  const { pins } = useShell()
  const [openKeys, setOpenKeys] = useState(() => { try { return new Set(JSON.parse(localStorage.getItem(LS_OPEN) || '[]')) } catch { return new Set() } })
  const toggle = (key) => setOpenKeys((prev) => {
    const n = new Set(prev)
    n.has(key) ? n.delete(key) : n.add(key)
    try { localStorage.setItem(LS_OPEN, JSON.stringify([...n])) } catch { /* ignore */ }
    return n
  })
  const isOpen = (item) => openKeys.has(item.key) || located.item?.key === item.key
  const render = (item) => (
    <RailItem
      key={item.key}
      item={item}
      active={located.item?.key === item.key}
      activeChild={located.item?.key === item.key ? located.child : null}
      collapsed={collapsed}
      open={isOpen(item)}
      onToggle={() => toggle(item.key)}
      badge={item.badge === 'work' ? workCount : 0}
      tNav={tNav}
      onNavigate={onNavigate}
    />
  )
  return (
    <nav aria-label="Main" className={clsx('flex min-h-0 flex-1 flex-col', className)}>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 ui-scroll">
        {(pins.length > 0 || nav.pinnedApps.length > 0) && !collapsed && (
          <div className="pt-3">
            <p className="label-mono px-2 pb-1">Pinned</p>
            <ul className="space-y-px">
              {nav.pinnedApps.map((p) => (
                <li key={p.key}>
                  <Link to={p.route} onClick={onNavigate} className="flex h-8 items-center gap-2.5 rounded-md px-2 text-sm text-ink-700 hover:bg-ink-100 hover:text-fg">
                    <AppIcon name={p.icon} className="h-[18px] w-[18px] text-ink-500" />
                    <span className="truncate">{p.name}</span>
                  </Link>
                </li>
              ))}
              {pins.map((p) => (
                <li key={p.path}>
                  <Link to={p.path} onClick={onNavigate} className="flex h-8 items-center gap-2.5 rounded-md px-2 text-sm text-ink-700 hover:bg-ink-100 hover:text-fg">
                    <StarSolid className="h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />
                    <span className="truncate">{p.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
        {nav.groups.map((g) => (
          <div key={g.group} className="pt-3">
            {collapsed ? <div className="mx-2 mb-2 h-px bg-ink-200" aria-hidden="true" /> : <p className="label-mono px-2 pb-1">{g.group}</p>}
            <ul className="space-y-px">{g.items.map(render)}</ul>
          </div>
        ))}
      </div>
      {nav.foot && <ul className="border-t border-ink-200 px-2 py-2">{render(nav.foot)}</ul>}
    </nav>
  )
}

/**
 * Dock — the desktop rail: one plate per application. A plate opens that
 * application's main dashboard; nothing expands here. Inside an application,
 * its own screens are listed in the Spine beside the dock.
 */
function Dock({ nav, located, workCount, tNav }) {
  const plate = (item) => {
    const active = located.item?.key === item.key
    const Icon = item.icon || Squares2X2Icon
    const badge = item.badge === 'work' ? workCount : 0
    return (
      <li key={item.key}>
        <Link
          to={item.href}
          title={tNav(item.label)}
          aria-current={active ? 'page' : undefined}
          className={clsx(
            'relative flex w-full flex-col items-center gap-0.5 rounded-md px-0 py-1 text-center',
            active ? 'bg-ink-100 text-fg' : 'text-ink-600 hover:bg-ink-100 hover:text-fg'
          )}
        >
          {active && <span aria-hidden="true" className="absolute left-0 top-1.5 h-7 w-[2px] rounded-full bg-ink-900" />}
          <Icon className={clsx('h-5 w-5 shrink-0', active ? 'text-ink-900' : 'text-ink-500')} aria-hidden="true" />
          <span className={clsx('w-full truncate text-[10px] leading-tight tracking-tight', active && 'font-medium')}>{tNav(item.label)}</span>
          {badge > 0 && (
            <span className="absolute right-1.5 top-1 rounded bg-brand-600 px-1 font-mono text-[10px] font-medium leading-4 text-white tabular-nums" aria-label={`${badge} waiting`}>
              {badge > 99 ? '99+' : badge}
            </span>
          )}
        </Link>
      </li>
    )
  }
  return (
    <nav aria-label="Applications" className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2 ui-scroll">
        {nav.groups.map((g, i) => (
          <div key={g.group} className={i ? 'mt-0.5 border-t border-ink-200 pt-0.5' : 'pt-1.5'}>
            <ul className="space-y-0.5" aria-label={g.group}>{g.items.map(plate)}</ul>
          </div>
        ))}
      </div>
      {nav.foot && <ul className="border-t border-ink-200 px-1.5 py-1.5">{plate(nav.foot)}</ul>}
    </nav>
  )
}

/**
 * Spine — the current application's own screens, beside the dock. Shown only
 * for an application with more than one screen; Ctrl+B hides or shows it.
 */
function Spine({ located, tNav }) {
  const item = located.item
  const children = item?.children || []
  if (children.length < 2) return null
  return (
    <nav aria-label={`${tNav(item.label)} screens`} className="hidden w-52 shrink-0 flex-col overflow-y-auto border-r border-ink-200 bg-canvas px-2 py-3 ui-scroll lg:flex">
      <Link to={item.href} className="mb-2 truncate px-2 text-sm font-semibold text-fg hover:underline">{tNav(item.label)}</Link>
      <ul className="space-y-px">
        {children.map((c) => {
          const on = located.child?.href === c.href
          return (
            <li key={c.href}>
              <Link
                to={c.href}
                aria-current={on ? 'page' : undefined}
                className={clsx('flex h-8 items-center gap-2 rounded-md px-2 text-[13px]', on ? 'bg-ink-100 font-medium text-fg' : 'text-ink-600 hover:bg-ink-100 hover:text-fg')}
              >
                <span className="truncate">{tNav(c.name)}</span>
                {c.maturity && <MaturityBadge level={c.maturity} className="ml-auto shrink-0" />}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/* =========================================================================
   Top bar pieces
   ========================================================================= */

function UserMenu({ user, onLogout }) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState(getThemeMode)
  const ref = useRef(null)
  const btn = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e) => { if (!ref.current?.contains(e.target) && !btn.current?.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus() } }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])
  const initials = [user?.first_name, user?.last_name].filter(Boolean).map((n) => n[0]).join('').toUpperCase().slice(0, 2) || 'U'
  const choose = (m) => { setTheme(m); setMode(m) }
  const item = 'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-ink-800 hover:bg-ink-100'
  return (
    <div className="relative">
      <button ref={btn} type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="true" aria-label={`Account: ${user?.first_name || ''} ${user?.last_name || ''}`} className="flex h-8 items-center gap-2 rounded-md pl-1 pr-1.5 hover:bg-ink-100">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-ink-900 font-mono text-[10px] font-medium text-white">{initials}</span>
        <ChevronDownIcon className="hidden h-3.5 w-3.5 text-ink-500 sm:block" aria-hidden="true" />
      </button>
      {open && (
        <div ref={ref} className="absolute right-0 z-50 mt-1 w-64 rounded-lg border border-ink-200 bg-overlay p-1 shadow-overlay animate-pop">
          <div className="px-2 py-2">
            <p className="truncate text-sm font-medium text-fg">{user?.first_name} {user?.last_name}</p>
            <p className="truncate text-xs text-ink-500">{user?.email}</p>
            <p className="mt-1 font-mono text-2xs uppercase tracking-wide text-ink-500">{user?.role?.replace(/_/g, ' ')}</p>
          </div>
          <div className="my-1 h-px bg-ink-200" />
          <p className="label-mono px-2 pb-1 pt-1">Appearance</p>
          <div role="radiogroup" aria-label="Appearance" className="mx-2 mb-1 grid grid-cols-3 gap-0.5 rounded-md border border-ink-200 bg-sunken p-0.5">
            {[['light', SunIcon, 'Light'], ['dark', MoonIcon, 'Dark'], ['system', ComputerDesktopIcon, 'Auto']].map(([m, Icon, l]) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => choose(m)} className={clsx('inline-flex h-7 items-center justify-center gap-1 rounded text-xs', mode === m ? 'bg-surface font-medium text-fg shadow-[0_0_0_1px_rgb(var(--c-ink-200))]' : 'text-ink-600 hover:text-fg')}>
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />{l}
              </button>
            ))}
          </div>
          <div className="my-1 h-px bg-ink-200" />
          <Link to="/system" onClick={() => setOpen(false)} className={item}><Squares2X2Icon className="h-4 w-4 text-ink-500" />Design system</Link>
          {(user?.role === 'ADMIN' || user?.is_platform_owner) && <Link to="/admin/overview" onClick={() => setOpen(false)} className={item}><Cog6ToothIcon className="h-4 w-4 text-ink-500" />Admin & settings</Link>}
          <a href="/download" target="_blank" rel="noopener" className={item}><ComputerDesktopIcon className="h-4 w-4 text-ink-500" />Get the desktop app</a>
          <a href="mailto:procurement@qira.one" className={item}><LifebuoyIcon className="h-4 w-4 text-ink-500" />Help & support</a>
          <Link to="/terms" onClick={() => setOpen(false)} className={item}><DocumentTextIcon className="h-4 w-4 text-ink-500" />Terms of Service</Link>
          <Link to="/privacy" onClick={() => setOpen(false)} className={item}><LockClosedIcon className="h-4 w-4 text-ink-500" />Privacy Policy</Link>
          <div className="my-1 h-px bg-ink-200" />
          <button type="button" onClick={onLogout} className={clsx(item, 'text-risk-600')}><ArrowRightOnRectangleIcon className="h-4 w-4" />Sign out</button>
        </div>
      )}
    </div>
  )
}

const SHORTCUTS = [
  ['⌘K / Ctrl K', 'Search pages, records and actions; ask Simeli'],
  ['/', 'Search the list on screen'],
  ['g h', 'Go home'], ['g w', 'Go to my work'], ['g a', 'Go to approvals'], ['g m', 'Go to mail'],
  ['g p', 'Go to purchase orders'], ['g i', 'Go to inventory items'], ['g s', 'Go to sales orders'], ['g f', 'Go to finance'],
  ['n', 'New record of the kind on screen (where available)'],
  ['↑ ↓ or j k', 'Move through a list'], ['Enter', 'Open the focused row'], ['x / Space', 'Select the focused row'],
  ['Esc', 'Close, or clear the selection'], ['Ctrl B', 'Collapse or expand the navigation'], ['Ctrl `', 'Switch between applications'], ['?', 'Show this list'],
]

const GO = { h: '/', w: '/my-work', a: '/approvals/unified', m: '/mail', p: '/procurement/purchase-orders', i: '/inventory/items', s: '/sales/sales-orders', f: '/finance/overview', r: '/analytics/overview' }

/* =========================================================================
   Shell
   ========================================================================= */

function ShellFrame({ children }) {
  const { t } = useI18n()
  const tNav = useCallback((label) => {
    if (!label) return label
    const key = String(label).replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('')
    if (!key) return label
    const path = `nav.${key}`
    const translated = t(path)
    return translated === path ? label : translated
  }, [t])

  const location = useLocation()
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  const { current: company, companies, switchCompany } = useCompany()
  const shell = useShell()
  // Lists hand natural-language questions to Simeli (see DataTable).
  useEffect(() => {
    const onAsk = (e) => shell.openSimeli({ question: e.detail?.question })
    window.addEventListener('embmis:ask-simeli', onAsk)
    return () => window.removeEventListener('embmis:ask-simeli', onAsk)
  }, [shell])
  const nav = useVisibleNavigation(user)
  const located = useMemo(() => locate(nav.groups, nav.foot, location.pathname), [nav, location.pathname])

  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(LS_RAIL) === '1' } catch { return false } })
  const toggleRail = useCallback(() => setCollapsed((c) => { try { localStorage.setItem(LS_RAIL, c ? '0' : '1') } catch { /* ignore */ } return !c }), [])
  const [menuOpen, setMenuOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)

  // Breadcrumbs: module › screen › record.
  const crumbs = useMemo(() => {
    const out = []
    const { item, child } = located
    if (item && item.key !== 'home') out.push({ label: tNav(item.label), to: item.href })
    if (child && child.href !== item?.href) out.push({ label: tNav(child.name), to: child.href })
    const base = child?.href || (item && !item.exact ? (item.match || []).find((p) => location.pathname.startsWith(p)) : null)
    if (base && location.pathname.length > base.length) {
      const rest = location.pathname.slice(base.length).split('/').filter(Boolean)
      const rt = shell.recordTitle?.path === location.pathname ? shell.recordTitle.title : null
      const labels = rest.map(humanSegment).filter(Boolean)
      if (rt) out.push({ label: rt })
      else if (labels.length) out.push({ label: labels[labels.length - 1] === 'Record' ? 'Detail' : labels.filter((l) => l !== 'Record').join(' · ') || 'Detail' })
    }
    if (!out.length) out.push({ label: location.pathname === '/' ? 'Home' : humanSegment(location.pathname.split('/').filter(Boolean).pop() || '') || 'EMBMIS' })
    return out
  }, [located, location.pathname, shell.recordTitle, tNav])
  const pageLabel = crumbs[crumbs.length - 1]?.label

  // Recents: every screen visited, named as well as we can.
  useEffect(() => {
    if (location.pathname === '/' || location.pathname === '/login') return
    const t = setTimeout(() => {
      shell.remember({ path: location.pathname + location.search, title: pageLabel, subtitle: crumbs.slice(0, -1).map((c) => c.label).join(' · '), at: Date.now() })
    }, 400)
    return () => clearTimeout(t)
  }, [location.pathname, location.search, pageLabel])

  useEffect(() => {
    if (!shell.recordTitle) document.title = pageLabel && pageLabel !== 'Home' ? `${pageLabel} · EMBMIS` : 'EMBMIS'
  }, [pageLabel, shell.recordTitle])

  // My work count: refreshed on navigation so acting on something updates it.
  const [workCount, setWorkCount] = useState(0)
  useEffect(() => {
    let cancelled = false
    platformAPI.myWork()
      .then((r) => { if (!cancelled) setWorkCount(r.data?.data?.total || 0) })
      .catch(() => { if (!cancelled) setWorkCount(0) })
    return () => { cancelled = true }
  }, [location.pathname])

  useEffect(() => { setMenuOpen(false) }, [location.pathname])

  // Keyboard: ⌘K, ?, g-sequences, Ctrl+B.
  useEffect(() => {
    let pendingG = 0
    const typing = (el) => el?.closest?.('input,textarea,select,[contenteditable="true"],[role="combobox"]')
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); shell.openPalette(); return }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleRail(); return }
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || document.querySelector('[aria-modal="true"]')) return
      if (e.key === '?') { e.preventDefault(); setHelpOpen(true); return }
      if (e.key === 'g') { pendingG = Date.now(); return }
      if (pendingG && Date.now() - pendingG < 900 && GO[e.key]) { e.preventDefault(); pendingG = 0; navigate(GO[e.key]); return }
      pendingG = 0
      if (e.key === 'n') {
        const createHref = located.child?.href ? `${located.child.href}/create` : null
        const known = QUICK_ACTIONS.find((a) => a.href === createHref)
        if (known) { e.preventDefault(); navigate(known.href) }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate, shell, toggleRail, located.child])

  // Palette items: every screen the user can reach, quick actions, recents.
  const paletteItems = useMemo(() => {
    const pages = []
    const add = (item, group) => {
      pages.push({ id: `page:${item.href}`, title: tNav(item.label), subtitle: group, group: 'Pages', keywords: item.key, icon: item.icon, run: () => navigate(item.href) })
      for (const c of item.children || []) {
        if (c.href === item.href) continue
        pages.push({ id: `page:${c.href}`, title: tNav(c.name), subtitle: tNav(item.label), group: 'Pages', keywords: `${item.label} ${c.maturity || ''}`, badge: c.maturity ? <MaturityBadge level={c.maturity} /> : null, run: () => navigate(c.href) })
      }
    }
    nav.groups.forEach((g) => g.items.forEach((i) => add(i, g.group)))
    if (nav.foot) add(nav.foot, 'Settings')
    const actions = QUICK_ACTIONS.filter((a) => canSeeArea(user?.role, a.area)).map((a) => ({ id: `act:${a.id}`, title: a.title, subtitle: a.module, group: 'Actions', keywords: a.keywords, hint: '', run: () => navigate(a.href) }))
    const recents = shell.recents.map((r) => ({ id: `recent:${r.path}`, title: r.title, subtitle: r.subtitle, group: 'Recent', icon: ClockIcon, run: () => navigate(r.path) }))
    const commands = [
      { id: 'cmd:theme-dark', title: 'Switch to dark appearance', group: 'Commands', keywords: 'theme night', run: () => setTheme('dark') },
      { id: 'cmd:theme-light', title: 'Switch to light appearance', group: 'Commands', keywords: 'theme day', run: () => setTheme('light') },
      { id: 'cmd:rail', title: collapsed ? 'Show screens of this application' : 'Hide screens of this application', group: 'Commands', hint: 'Ctrl B', run: toggleRail },
      { id: 'cmd:keys', title: 'Keyboard shortcuts', group: 'Commands', hint: '?', icon: KeyIcon, run: () => setHelpOpen(true) },
    ]
    return [...recents, ...actions, ...pages, ...commands]
  }, [nav, tNav, navigate, user?.role, shell.recents, collapsed, toggleRail])

  const searchRemote = useCallback((q) => searchRecords(q, navigate), [navigate])
  const pinned = shell.pins.some((p) => p.path === location.pathname + location.search)

  const handleLogout = async () => {
    try {
      await logout()
      toast.success('Signed out')
      navigate('/login')
    } catch {
      toast.error('Sign-out did not complete. Close the browser to end the session.')
    }
  }

  // ---- Inside the EMBMIS desktop app: the desktop draws the frame (see shell/desktopBridge.js). ----
  useEffect(() => {
    if (!desktop) return
    desktop.publish({
      product: 'business-os',
      nav: serializeNav(nav, tNav, workCount),
      located: { item: located.item?.key || null, child: located.child?.href || null },
      crumbs: crumbs.map((c) => ({ label: c.label, to: c.to || null })),
      path: location.pathname + location.search,
      pinned,
      user: user ? { name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email, email: user.email, role: user.role } : null,
      company: company ? { id: company.id, name: company.name } : null,
      companies: (companies || []).map((c) => ({ id: c.id, name: c.name })),
      workCount,
      recents: shell.recents.slice(0, 8).map((r) => ({ title: r.title, subtitle: r.subtitle, path: r.path })),
    })
  }, [nav, tNav, workCount, located, crumbs, location.pathname, location.search, pinned, user, company, companies, shell.recents])
  // The desktop decides light or dark; 'system' here follows it, live.
  useEffect(() => {
    if (!desktop) return
    setTheme('system')
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    const onScheme = () => setTheme('system')
    mq?.addEventListener?.('change', onScheme)
    return () => mq?.removeEventListener?.('change', onScheme)
  }, [])
  const live = useRef({})
  live.current = { navigate, shell, switchCompany, handleLogout, path: location.pathname + location.search, pageLabel, role: user?.role }
  useEffect(() => {
    if (!desktop) return
    return desktop.onCommand((c) => {
      const l = live.current
      if (!c || typeof c !== 'object') return
      if (c.type === 'navigate' && typeof c.path === 'string' && c.path.startsWith('/')) l.navigate(c.path)
      else if (c.type === 'palette') l.shell.openPalette()
      else if (c.type === 'simeli') l.shell.openSimeli({ question: typeof c.question === 'string' ? c.question : undefined })
      else if (c.type === 'help') setHelpOpen(true)
      else if (c.type === 'logout') l.handleLogout()
      else if (c.type === 'company' && typeof c.id === 'string') l.switchCompany(c.id)
      else if (c.type === 'pin' && l.path !== '/') l.shell.togglePin({ path: l.path, title: l.pageLabel })
      else if (c.type === 'search' && typeof c.q === 'string' && c.id) {
        // The desktop's one search box: quick actions and records from here, with this app's own permissions.
        const q = c.q.trim().toLowerCase()
        const actions = QUICK_ACTIONS.filter((a) => canSeeArea(l.role, a.area) && `${a.title} ${a.keywords || ''}`.toLowerCase().includes(q))
          .slice(0, 5).map((a) => ({ title: a.title, subtitle: a.module, group: 'Actions', href: a.href }))
        const send = (rows) => desktop.reply?.(c.id, [...actions, ...rows.map((r) => ({ title: r.title, subtitle: r.subtitle, group: r.group, href: r.href }))])
        if (q.length < 2) send([])
        else searchRecords(c.q.trim(), () => {}).then(send, () => send([]))
      }
    })
  }, [])


  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-canvas text-fg">
      <a href="#main" className="sr-only-focusable fixed left-2 top-2 z-[100] rounded-md bg-surface px-3 py-2 text-sm font-medium text-fg shadow-overlay">Skip to content</a>
      <LiveNotificationToast />

      {/* Top bar: company, where you are, search, notifications, you. In the desktop app the window's own title bar
          does this (search opens this app's palette, the account button its menu), so it is not drawn twice. */}
      {!inDesktop && <header data-shell-chrome className="z-topbar flex h-12 shrink-0 items-center gap-2 border-b border-ink-200 bg-surface px-2 sm:px-3">
        <Link to="/" className="flex shrink-0 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-ink-100" aria-label={`${company?.name || 'EMBMIS'} — home`}>
          <img src={`${import.meta.env.BASE_URL}logo-mark.png`} alt="" width={22} height={22} className="rounded" />
          <span className="hidden max-w-[160px] truncate text-sm font-semibold text-fg md:inline">{company?.name || 'EMBMIS'}</span>
        </Link>
        <span aria-hidden="true" className="hidden h-5 w-px bg-ink-200 md:block" />
        <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
          <ol className="flex min-w-0 items-center gap-1 text-sm">
            {crumbs.map((c, i) => {
              const last = i === crumbs.length - 1
              return (
                <li key={`${c.label}-${i}`} className={clsx('flex min-w-0 items-center gap-1', !last && 'hidden shrink-0 sm:flex')}>
                  {c.to && !last ? <Link to={c.to} className="truncate rounded px-1 text-ink-500 hover:bg-ink-100 hover:text-fg">{c.label}</Link> : <span aria-current={last ? 'page' : undefined} className="truncate px-1 font-medium text-fg">{c.label}</span>}
                  {!last && <span aria-hidden="true" className="text-ink-300">/</span>}
                </li>
              )
            })}
            {location.pathname !== '/' && (
              <li className="shrink-0">
                <button
                  type="button"
                  onClick={() => shell.togglePin({ path: location.pathname + location.search, title: pageLabel })}
                  aria-pressed={pinned}
                  aria-label={pinned ? `Unpin ${pageLabel}` : `Pin ${pageLabel} to the navigation`}
                  title={pinned ? 'Unpin' : 'Pin this view'}
                  className="ml-0.5 hidden h-6 w-6 items-center justify-center rounded text-ink-400 hover:bg-ink-100 hover:text-ink-800 sm:inline-flex"
                >
                  {pinned ? <StarSolid className="h-3.5 w-3.5 text-ink-800" /> : <StarOutline className="h-3.5 w-3.5" />}
                </button>
              </li>
            )}
          </ol>
        </nav>
        <button
          type="button"
          onClick={shell.openPalette}
          className="hidden h-8 w-64 items-center gap-2 rounded-md border border-ink-200 bg-sunken px-2.5 text-sm text-ink-500 hover:border-ink-300 hover:text-ink-700 md:flex lg:w-80"
        >
          <MagnifyingGlassIcon className="h-4 w-4" aria-hidden="true" />
          <span className="flex-1 text-left">Search or ask Simeli</span>
          <Kbd>⌘K</Kbd>
        </button>
        <button type="button" onClick={shell.openPalette} aria-label="Search" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-600 hover:bg-ink-100 md:hidden">
          <MagnifyingGlassIcon className="h-[18px] w-[18px]" aria-hidden="true" />
        </button>
        <NotificationBell />
        <UserMenu user={user} onLogout={handleLogout} />
      </header>}

      <div className="flex min-h-0 flex-1">
        {/* Desktop: one plate per application, and the current one's screens beside it. */}
        <aside data-shell-chrome className="relative hidden w-[84px] shrink-0 flex-col border-r border-ink-200 bg-surface lg:flex">
          <Dock nav={nav} located={located} workCount={workCount} tNav={tNav} />
        </aside>
        {!collapsed && <Spine located={located} tNav={tNav} />}

        <AppSwitcher />

        <main id="main" tabIndex={-1} className="min-h-0 min-w-0 flex-1 overflow-y-auto pb-[calc(var(--bottomnav-h)+env(safe-area-inset-bottom))] focus:outline-none lg:pb-0 ui-scroll">
          <div key={location.pathname} className="page-fade mx-auto w-full max-w-[1600px] px-4 py-5 sm:px-6 lg:py-6">
            {children}
          </div>
        </main>
      </div>

      {/* Phone: five daily jobs at the thumb, the rest in a sheet. */}
      <nav data-shell-chrome aria-label="Primary" className="fixed inset-x-0 bottom-0 z-topbar grid grid-cols-5 border-t border-ink-200 bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden">
        {[
          { label: 'Home', icon: HomeIcon, to: '/' },
          { label: 'My work', icon: CheckBadgeIcon, to: '/my-work', badge: workCount },
          { label: 'Search', icon: MagnifyingGlassIcon, onClick: shell.openPalette },
          { label: 'Mail', icon: EnvelopeIcon, to: '/mail' },
          { label: 'Menu', icon: Bars3Icon, onClick: () => setMenuOpen(true) },
        ].map((b) => {
          const active = b.to && (b.to === '/' ? location.pathname === '/' : location.pathname.startsWith(b.to))
          const inner = (
            <>
              <span className="relative">
                <b.icon className="h-6 w-6" aria-hidden="true" />
                {b.badge > 0 && <span className="absolute -right-2 -top-1 rounded bg-brand-600 px-1 font-mono text-[10px] leading-4 text-white">{b.badge > 99 ? '99+' : b.badge}</span>}
              </span>
              <span className="text-[11px] font-medium">{b.label}</span>
            </>
          )
          const cls = clsx('flex h-[60px] flex-col items-center justify-center gap-0.5', active ? 'text-fg' : 'text-ink-500')
          return b.to ? (
            <Link key={b.label} to={b.to} aria-current={active ? 'page' : undefined} className={cls}>{inner}</Link>
          ) : (
            <button key={b.label} type="button" onClick={b.onClick} className={cls}>{inner}</button>
          )
        })}
      </nav>

      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} title={company?.name || 'EMBMIS'} side="bottom">
        <div className="flex h-[70vh] flex-col">
          <Rail nav={nav} located={located} collapsed={false} workCount={workCount} tNav={tNav} onNavigate={() => setMenuOpen(false)} />
        </div>
      </Sheet>

      <CommandPalette
        open={shell.paletteOpen}
        onClose={shell.closePalette}
        items={paletteItems}
        recentIds={shell.recents.slice(0, 6).map((r) => `recent:${r.path}`)}
        searchRemote={searchRemote}
        onAsk={(q) => { shell.closePalette(); shell.openSimeli({ question: q }) }}
      />

      <SimeliPanel />

      <Dialog open={helpOpen} onClose={() => setHelpOpen(false)} title="Keyboard shortcuts" size="md">
        <dl className="divide-y divide-ink-100">
          {SHORTCUTS.map(([k, d]) => (
            <div key={k} className="flex items-center justify-between gap-4 py-2 text-sm">
              <dt className="text-ink-700">{d}</dt>
              <dd className="flex shrink-0 gap-1">{k.split(' / ').map((part) => <Kbd key={part}>{part}</Kbd>)}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 flex items-center gap-1.5 text-xs text-ink-500"><SparklesIcon className="h-3.5 w-3.5" />Type a question in ⌘K and choose “Ask Simeli”: it answers beside the page you are on.</p>
      </Dialog>
    </div>
  )
}

export default function Layout({ children }) {
  return (
    <ShellProvider>
      <ShellFrame>{children}</ShellFrame>
    </ShellProvider>
  )
}
