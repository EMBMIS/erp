/**
 * Inside the EMBMIS desktop app, Business OS is one product in a native window. The desktop draws the frame: the
 * navigation, the breadcrumb, search, notifications, the account menu and the theme. This page then only draws the
 * page itself, and tells the desktop what it needs to draw the rest.
 *
 * The desktop's preload exposes `window.embmisDesktop` (only in the desktop, never in a browser):
 *   publish(state)       what the frame shows: navigation this person can see, where they are, who they are
 *   onCommand(fn)        what the frame asks for: navigate, open the palette, sign out, switch company, …
 *
 * Nothing here is trusted by the desktop for security; it is presentation only.
 */
export const desktop = typeof window !== 'undefined' && window.embmisDesktop && typeof window.embmisDesktop.publish === 'function'
  ? window.embmisDesktop
  : null

export const inDesktop = !!desktop

/** The navigation as plain data (no components), labels already translated. */
export function serializeNav(nav, tNav, workCount) {
  const item = (i) => i && ({
    key: String(i.key),
    label: tNav(i.label),
    href: i.href,
    exact: !!i.exact,
    match: i.match || [],
    built: !!i.built,
    badge: i.badge === 'work' ? workCount || 0 : undefined,
    children: (i.children || []).map((c) => ({ name: tNav(c.name), href: c.href, maturity: c.maturity || undefined })),
  })
  return {
    groups: nav.groups.map((g) => ({ group: tNav(g.group), items: g.items.map(item) })),
    foot: item(nav.foot),
    pinned: (nav.pinnedApps || []).map((p) => ({ name: p.name, href: p.route })),
  }
}
