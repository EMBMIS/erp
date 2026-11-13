// First-visit cookie banner.
//
// Asks once, stores the decision in localStorage, and never renders again
// after that. Functional/essential cookies run regardless; the banner exists
// so the optional ones are opt-in and so the visitor has seen the legal
// pages exist before they are used.
import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

const STORAGE_KEY = 'embmis-cookie-consent'

export default function CookieConsent() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    try {
      if (!window.localStorage.getItem(STORAGE_KEY)) setVisible(true)
    } catch {
      // Storage unavailable (private browsing etc.) — do not nag.
    }
  }, [])

  const decide = (value) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, value)
    } catch {
      // Nothing to do — the banner simply reappears next visit.
    }
    setVisible(false)
  }

  if (!visible) return null

  // A small card in the corner, not a full-width bar: it must never sit on
  // top of a form's submit button, which the old banner did.
  return (
    <div
      role="region"
      aria-label="Cookie consent"
      className="pointer-events-none fixed inset-x-3 bottom-[calc(72px+env(safe-area-inset-bottom))] z-[65] sm:inset-x-auto sm:bottom-4 sm:left-4 lg:bottom-4"
    >
      <div className="pointer-events-auto w-full max-w-sm rounded-lg border border-ink-200 bg-overlay p-3 shadow-overlay">
        <p className="text-sm text-ink-700">
          We use essential cookies to keep you signed in, and optional ones to
          remember interface preferences. See the{' '}
          <Link to="/privacy" className="font-medium text-brand-600 underline-offset-2 hover:underline">Privacy Policy</Link>{' '}
          and{' '}
          <Link to="/terms" className="font-medium text-brand-600 underline-offset-2 hover:underline">Terms</Link>.
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={() => decide('declined')} className="h-8 rounded-md border border-ink-300 bg-surface px-3 text-sm font-medium text-ink-800 hover:bg-ink-100">
            Decline optional
          </button>
          <button type="button" onClick={() => decide('accepted')} className="h-8 rounded-md bg-brand-600 px-3 text-sm font-medium text-white hover:bg-brand-700">
            Accept
          </button>
        </div>
      </div>
    </div>
  )
}
