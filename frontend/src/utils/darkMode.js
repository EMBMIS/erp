// Dark mode — tiny, dependency-free. The `.dark` class on <html> activates
// the override stylesheet in index.css; this module owns reading/writing the
// preference (localStorage wins, then the OS preference) and exposes a
// subscribe-able toggle state for the header switch.

const STORAGE_KEY = 'qira.theme'

export function isDark() {
  return document.documentElement.classList.contains('dark')
}

function prefersDark() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Apply a concrete light/dark decision to the document. */
export function applyTheme(dark) {
  document.documentElement.classList.toggle('dark', dark)
}

/**
 * Set the theme preference: 'light' | 'dark' | 'system'. 'system' clears the
 * stored override so the OS preference (and its live changes) wins.
 */
export function setTheme(mode) {
  const dark = mode === 'dark' || (mode === 'system' && prefersDark())
  applyTheme(dark)
  try {
    if (mode === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, mode)
  } catch { /* storage disabled */ }
}

/** The stored preference, or 'system' when the user never chose. */
export function getThemeMode() {
  try { return localStorage.getItem(STORAGE_KEY) || 'system' } catch { return 'system' }
}

export function initTheme() {
  setTheme(getThemeMode())
}

export function toggleTheme() {
  setTheme(isDark() ? 'light' : 'dark')
}
