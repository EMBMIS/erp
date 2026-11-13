import { useEffect, useRef, useState } from 'react'

const GSI_SRC = 'https://accounts.google.com/gsi/client'

// One shared load across every mount of the hook (React StrictMode's double
// render, or Login unmounting/remounting) — appending the script tag twice
// would double-register the callback.
let gsiLoadPromise = null
function loadGsiScript() {
  if (window.google?.accounts?.id) return Promise.resolve()
  if (!gsiLoadPromise) {
    gsiLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = GSI_SRC
      script.async = true
      script.defer = true
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('Failed to load Google Identity Services'))
      document.head.appendChild(script)
    })
  }
  return gsiLoadPromise
}

/**
 * Loads Google Identity Services on demand — only where a Google Sign-In
 * button actually renders, not globally via index.html, since the ERP has
 * 160+ routes and only Login/Signup need this script at all — and renders
 * the button into the returned ref.
 *
 * `onCredential(idToken)` fires with the signed ID token once the user
 * completes the Google flow. Verifying it is the backend's job (POST
 * /api/auth/google, google-auth-library) — this hook never inspects it.
 * Pass a stable (useCallback'd) `onCredential`, since it's rebound into
 * `google.accounts.id.initialize` whenever it changes.
 */
export function useGoogleSignIn({ onCredential }) {
  const buttonRef = useRef(null)
  const wrapperRef = useRef(null)
  const [ready, setReady] = useState(false)
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID

  useEffect(() => {
    if (!clientId) return

    let cancelled = false
    loadGsiScript()
      .then(() => {
        if (cancelled) return
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (response) => onCredential(response.credential)
        })
        setReady(true)
      })
      .catch((err) => console.error('Google Sign-In failed to load:', err))

    return () => {
      cancelled = true
    }
  }, [clientId, onCredential])

  useEffect(() => {
    if (!ready || !buttonRef.current) return
    // GIS only sizes its iframe from the width option (pixels, capped at 400),
    // so measure the wrapper the button has to fill and hand that in. The
    // caller renders this element absolutely on top of a custom-branded
    // button and hides it with opacity-0 — the iframe keeps the click and
    // the account-chooser behaviour, the branded button underneath supplies
    // the look.
    const width = Math.min(wrapperRef.current?.offsetWidth || 400, 400)
    window.google.accounts.id.renderButton(buttonRef.current, {
      theme: 'outline',
      size: 'large',
      width
    })
  }, [ready])

  return { buttonRef, wrapperRef, enabled: Boolean(clientId) }
}
