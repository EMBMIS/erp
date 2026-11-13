/**
 * Hold-to-switch, in the spirit of alt-tab.
 *
 * ===========================================================================
 * WHY NOT ALT+TAB
 * ===========================================================================
 * A web page cannot have Alt+Tab. The window manager takes it before the
 * browser sees it — on Windows, on GNOME, on KDE, on macOS — and there is no
 * flag, no permission and no fullscreen mode that changes that. A page that
 * bound it would appear broken to everybody who tried.
 *
 * So this is Ctrl+` : the closest chord that actually reaches a page on every
 * platform, next to a key nothing else claims. It behaves the way alt-tab
 * does, which is the part that matters:
 *
 *     hold Ctrl, tap `         step through the applications
 *     release Ctrl             go to the one you landed on
 *     Escape, or click away    change nothing
 *
 * ===========================================================================
 * MOST RECENTLY USED, NOT ALPHABETICAL
 * ===========================================================================
 * The reason alt-tab feels like magic is that ONE press returns you to where
 * you just were. A list in a fixed order cannot do that; it makes the common
 * move — flipping between two applications — cost a hunt every time. So the
 * order is the order you last opened them, kept per company in this browser,
 * and the selection starts on the second entry: the place you were before
 * this one.
 *
 * Per browser rather than per account on purpose. This is muscle memory about
 * this screen in this session, not a preference worth a round trip — and a
 * switcher that waited for the network before it could open would be slower
 * than the launcher it exists to beat.
 */

import React from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { platformAPI, RAIL_CHANGED_EVENT, COMPANY_MODULES_CHANGED_EVENT } from '../../services/api'
import AppIcon from './AppIcon'
import { Kbd } from '../ui/Button'

const RECENTS_KEY = 'embmis.appSwitcher.recents'
const MAX_RECENTS = 24

function readRecents(companyId) {
  try {
    const all = JSON.parse(localStorage.getItem(RECENTS_KEY) || '{}')
    return Array.isArray(all[companyId]) ? all[companyId] : []
  } catch { return [] }
}

function writeRecents(companyId, keys) {
  try {
    const all = JSON.parse(localStorage.getItem(RECENTS_KEY) || '{}')
    all[companyId] = keys.slice(0, MAX_RECENTS)
    localStorage.setItem(RECENTS_KEY, JSON.stringify(all))
  } catch { /* private window, or storage disabled: the switcher still works */ }
}

export default function AppSwitcher() {
  const navigate = useNavigate()
  const location = useLocation()
  const companyId = (() => { try { return localStorage.getItem('qira.companyId') || 'default' } catch { return 'default' } })()

  const [apps, setApps] = React.useState([])
  const [open, setOpen] = React.useState(false)
  const [index, setIndex] = React.useState(0)

  // The list, and a way to reload it when what is installed changes.
  React.useEffect(() => {
    let cancelled = false
    const load = () => platformAPI.directory()
      .then((r) => { if (!cancelled) setApps((r.data?.data || []).filter((a) => a.enabled)) })
      .catch(() => { if (!cancelled) setApps([]) })
    load()
    window.addEventListener(RAIL_CHANGED_EVENT, load)
    window.addEventListener(COMPANY_MODULES_CHANGED_EVENT, load)
    return () => {
      cancelled = true
      window.removeEventListener(RAIL_CHANGED_EVENT, load)
      window.removeEventListener(COMPANY_MODULES_CHANGED_EVENT, load)
    }
  }, [])

  /** Which application the current path belongs to. Longest route wins. */
  const currentKey = React.useMemo(() => {
    let best = null
    let bestLength = 0
    for (const a of apps) {
      if (a.route === '/') continue
      if ((location.pathname === a.route || location.pathname.startsWith(`${a.route}/`)) && a.route.length > bestLength) {
        best = a.key
        bestLength = a.route.length
      }
    }
    return best
  }, [apps, location.pathname])

  // Record the visit. Not while the switcher is open, or stepping through
  // would reorder the list under the cursor.
  React.useEffect(() => {
    if (!currentKey || open) return
    const recents = readRecents(companyId)
    if (recents[0] === currentKey) return
    writeRecents(companyId, [currentKey, ...recents.filter((k) => k !== currentKey)])
  }, [currentKey, companyId, open])

  /** Applications in most-recently-used order, current one first. */
  const ordered = React.useMemo(() => {
    const byKey = new Map(apps.map((a) => [a.key, a]))
    const recents = readRecents(companyId)
    const seen = new Set()
    const out = []
    for (const key of [currentKey, ...recents].filter(Boolean)) {
      if (seen.has(key) || !byKey.has(key)) continue
      seen.add(key)
      out.push(byKey.get(key))
    }
    for (const a of apps) if (!seen.has(a.key)) out.push(a)
    return out
    // `open` is a dependency because the recents are read at open time: the
    // list must be the one that was true when the chord started, and must not
    // shuffle while somebody is stepping through it.
  }, [apps, currentKey, companyId, open])

  /** Go to the highlighted application and close. */
  const commit = React.useCallback((i) => {
    setOpen(false)
    const target = ordered[i]
    if (target && target.key !== currentKey) navigate(target.route)
  }, [ordered, currentKey, navigate])

  React.useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === '`' && e.ctrlKey) {
        e.preventDefault()
        if (ordered.length < 2) return
        // First press lands on the PREVIOUS application, which is the whole
        // trick: flipping between two is one chord, not a hunt.
        setIndex((prev) => (open ? (prev + (e.shiftKey ? -1 : 1) + ordered.length) % ordered.length : 1))
        setOpen(true)
        return
      }
      if (!open) return
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault(); setIndex((p) => (p + 1) % ordered.length); return
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault(); setIndex((p) => (p - 1 + ordered.length) % ordered.length); return
      }
      if (e.key === 'Enter') { e.preventDefault(); commit(index) }
    }

    // Releasing the modifier is what commits, exactly as alt-tab does.
    const onKeyUp = (e) => {
      if (open && (e.key === 'Control' || e.key === 'Meta')) commit(index)
    }

    // A window that loses focus mid-chord never sees the keyup, and a switcher
    // stuck open over the page is worse than one that gave up.
    const onBlur = () => setOpen(false)

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
    // No dependency array on purpose: the handlers close over `index` and
    // `ordered`, and both change while the chord is held. Re-registering three
    // window listeners per render is cheap; a stale closure that switches to
    // the wrong application is not.
  })

  if (!open || ordered.length < 2) return null

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Switch application"
    >
      <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={() => setOpen(false)} aria-hidden="true" />
      <div className="relative max-w-3xl rounded-lg border border-ink-200 bg-overlay p-4 shadow-overlay">
        <div className="mb-3 flex items-center justify-between gap-4">
          <p className="label-mono">Switch to</p>
          <p className="text-xs text-ink-500">
            Hold <Kbd>Ctrl</Kbd> and tap <Kbd>`</Kbd>
          </p>
        </div>

        <ul className="flex flex-wrap gap-2">
          {ordered.map((a, i) => (
            <li key={a.key}>
              <button
                type="button"
                aria-current={i === index ? 'true' : undefined}
                onMouseEnter={() => setIndex(i)}
                onClick={() => commit(i)}
                className={`flex w-[124px] flex-col items-center gap-2 rounded-md p-3 text-center ${
                  i === index ? 'bg-ink-100 outline outline-2 -outline-offset-2 outline-brand-600' : 'hover:bg-ink-50'
                }`}
              >
                <span className="grid h-10 w-10 place-items-center rounded-md border border-ink-200 bg-sunken text-ink-700">
                  <AppIcon name={a.icon} />
                </span>
                <span className="line-clamp-2 text-xs font-medium text-fg">{a.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
