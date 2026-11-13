import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { desktop } from './desktopBridge'

/**
 * Shell state that pages can talk to:
 *
 *   useRecordTitle('PO-2026-1004', { subtitle: 'Nordic Steel AS' })
 *     names the record on screen, so breadcrumbs, recents and the palette show
 *     "PO-2026-1004" instead of a UUID.
 *
 *   useShell().openPalette(), .openSimeli(context)
 *
 * Recents and pins live in this browser, per user. They are conveniences; the
 * server never needs them.
 */
const ShellContext = createContext(null)
const MAX_RECENTS = 15

const storageKey = (kind) => {
  let uid = 'anon'
  try { uid = JSON.parse(localStorage.getItem('user') || '{}')?.id || 'anon' } catch { /* ignore */ }
  return `embmis.shell.${uid}.${kind}`
}
const read = (kind) => { try { return JSON.parse(localStorage.getItem(storageKey(kind)) || '[]') } catch { return [] } }
const write = (kind, v) => { try { localStorage.setItem(storageKey(kind), JSON.stringify(v)) } catch { /* ignore */ } }

export function ShellProvider({ children }) {
  const [recordTitle, setRecordTitleState] = useState(null) // { path, title, subtitle }
  const [recents, setRecents] = useState(() => read('recents'))
  const [pins, setPins] = useState(() => read('pins'))
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [simeli, setSimeli] = useState(null) // { open, context }

  const remember = useCallback((entry) => {
    if (!entry?.path || entry.path === '/') return
    setRecents((prev) => {
      const next = [entry, ...prev.filter((r) => r.path !== entry.path)].slice(0, MAX_RECENTS)
      write('recents', next)
      return next
    })
  }, [])

  const togglePin = useCallback((entry) => {
    setPins((prev) => {
      const exists = prev.some((p) => p.path === entry.path)
      const next = exists ? prev.filter((p) => p.path !== entry.path) : [...prev, entry].slice(-12)
      write('pins', next)
      return next
    })
  }, [])

  const value = useMemo(
    () => ({
      recordTitle,
      setRecordTitle: setRecordTitleState,
      recents,
      remember,
      pins,
      togglePin,
      paletteOpen,
      openPalette: () => setPaletteOpen(true),
      closePalette: () => setPaletteOpen(false),
      simeli,
      // In the desktop app there is one Simeli, the window's own: hand the question to it.
      openSimeli: (context) => (desktop?.openSimeli ? desktop.openSimeli(typeof context?.question === 'string' ? context.question : '') : setSimeli({ open: true, context })),
      closeSimeli: () => setSimeli(null),
    }),
    [recordTitle, recents, remember, pins, togglePin, paletteOpen, simeli]
  )
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>
}

export function useShell() {
  return useContext(ShellContext) || {
    recordTitle: null, setRecordTitle: () => {}, recents: [], remember: () => {}, pins: [], togglePin: () => {},
    openPalette: () => {}, closePalette: () => {}, openSimeli: () => {}, closeSimeli: () => {},
  }
}

/** Name the record on this screen for breadcrumbs, recents and the palette. */
export function useRecordTitle(title, extra = {}) {
  const { setRecordTitle } = useShell()
  const path = typeof window !== 'undefined' ? window.location.pathname : ''
  const subtitle = extra.subtitle
  useEffect(() => {
    if (!title) return undefined
    setRecordTitle({ path, title: String(title), subtitle })
    const prev = document.title
    document.title = `${title} · EMBMIS`
    return () => { setRecordTitle(null); document.title = prev }
  }, [title, subtitle, path, setRecordTitle])
}

export default ShellContext
