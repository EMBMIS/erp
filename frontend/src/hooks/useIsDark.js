import { useEffect, useState } from 'react'

/**
 * Is the app currently in dark mode?
 *
 * The theme lives as a `.dark` class on <html> (src/utils/darkMode.js), which
 * CSS reads for free — but canvas painting can't. Anything that draws its own
 * pixels needs the answer as a value, and needs to be told when it changes,
 * including when the OS preference flips while the app is on 'system'. A
 * MutationObserver on the class attribute covers every path that can set it
 * (the header toggle, the account menu, initTheme, the media-query listener)
 * without those paths needing to know a canvas exists.
 */
export default function useIsDark() {
  const [dark, setDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  )

  useEffect(() => {
    const root = document.documentElement
    const read = () => setDark(root.classList.contains('dark'))
    read()

    const observer = new MutationObserver(read)
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })

    // Re-read on an OS preference change too. The class stays the source of
    // truth — this only guarantees a read happens on the one event that can
    // change the effective theme without any app code running.
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    mq?.addEventListener?.('change', read)

    return () => {
      observer.disconnect()
      mq?.removeEventListener?.('change', read)
    }
  }, [])

  return dark
}
