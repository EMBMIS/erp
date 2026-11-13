import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * useDraft — autosave a form to this browser so work survives navigation,
 * a closed tab and an expired session.
 *
 *   const { value, setValue, restored, clear, savedAt } = useDraft('po:new', initial)
 *
 * Saves 600 ms after the last change. `restored` is true when the form opened
 * with a saved draft, so the page can say so and offer to discard it. Call
 * `clear()` after a successful submit. Also warns before unload while dirty.
 *
 * Drafts are per user (keyed by the stored user id) so a shared machine does
 * not hand one person's half-written PO to the next.
 */
export default function useDraft(key, initial, { enabled = true } = {}) {
  const storageKey = (() => {
    let uid = 'anon'
    try { uid = JSON.parse(localStorage.getItem('user') || '{}')?.id || 'anon' } catch { /* ignore */ }
    return `embmis.draft.${uid}.${key}`
  })()
  const read = () => {
    if (!enabled) return null
    try { return JSON.parse(localStorage.getItem(storageKey) || 'null') } catch { return null }
  }
  const first = useRef(read())
  const [value, setValueState] = useState(() => (first.current?.value !== undefined ? first.current.value : initial))
  const [restored, setRestored] = useState(Boolean(first.current))
  const [savedAt, setSavedAt] = useState(first.current?.at || null)
  const dirty = useRef(false)

  const setValue = useCallback((next) => {
    dirty.current = true
    setValueState((prev) => (typeof next === 'function' ? next(prev) : next))
  }, [])

  useEffect(() => {
    if (!enabled || !dirty.current) return undefined
    const t = setTimeout(() => {
      try {
        const at = new Date().toISOString()
        localStorage.setItem(storageKey, JSON.stringify({ value, at }))
        setSavedAt(at)
      } catch { /* storage full or disabled: the form still works */ }
    }, 600)
    return () => clearTimeout(t)
  }, [value, enabled, storageKey])

  useEffect(() => {
    if (!enabled) return undefined
    const onUnload = (e) => {
      if (!dirty.current) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [enabled])

  const clear = useCallback(() => {
    dirty.current = false
    try { localStorage.removeItem(storageKey) } catch { /* ignore */ }
    setRestored(false)
    setSavedAt(null)
  }, [storageKey])

  const discard = useCallback(() => {
    clear()
    setValueState(initial)
  }, [clear, initial])

  return { value, setValue, restored, savedAt, clear, discard }
}
