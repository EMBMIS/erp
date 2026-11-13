// Validates a `redirect_uri` query param before Login.jsx ever navigates to
// it — the one thing standing between "log in, land back where you came
// from" and an open redirect (?redirect_uri=https://evil.example.com or the
// protocol-relative //evil.example.com trick, which browsers treat as
// same-scheme-different-host).
//
// A client-side check only, deliberately: there is no server-side redirect
// step in this flow to bypass (the backend never receives or acts on this
// value), so validating it here, inside the real login page's own trusted
// bundle, is the whole story.
export function getSafeRedirectUri(raw) {
  if (!raw) return null

  // A bare path ("/", "/finance/journal-entries") is always safe — it can
  // only ever mean somewhere on this same origin.
  if (raw.startsWith('/') && !raw.startsWith('//')) {
    return raw
  }

  try {
    const target = new URL(raw, window.location.origin)
    return target.origin === window.location.origin ? target.href : null
  } catch {
    return null
  }
}
