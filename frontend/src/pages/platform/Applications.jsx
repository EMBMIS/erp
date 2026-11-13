/**
 * Apps — the launcher.
 *
 * ===========================================================================
 * WHAT THIS SCREEN IS
 * ===========================================================================
 * Everything this company can do, as things you open. Finance and a
 * capability somebody designed on Tuesday are the same kind of card, in the
 * same grid, described the same way. The only thing separating them is a
 * heading, because "shipped with EMBMIS" and "built here" is a useful fact
 * about an application and not a difference in what it IS.
 *
 * Clicking a card opens the application, because that is what a launcher is
 * for. Everything else about it — what it can read and write, its versions,
 * its tables, the switch that turns it off — lives one click further in, at
 * /applications/:appKey. Putting the switch on the card would mean the most
 * destructive control on the page is also the easiest one to hit.
 *
 * A disabled application stays in the grid, dimmed, and opens its detail
 * rather than itself. A launcher that hides what you switched off gives you
 * no way to switch it back on.
 */

import React from 'react'
import { Link, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { platformAPI, RAIL_CHANGED_EVENT } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import AppIcon from '../../components/platform/AppIcon'
import clsx from 'clsx'
import { PlusIcon, StarIcon } from '@heroicons/react/24/outline'
import { StarIcon as StarSolid } from '@heroicons/react/20/solid'
import { PageHeader, Button, Input, Segmented, Card, EmptyState, Skeleton, Badge } from '../../components/ui'

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'native', label: 'Core' },
  { key: 'generated', label: 'Built here' },
  { key: 'off', label: 'Switched off' },
]

export default function Applications() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const isAdmin = String(user?.role || '').toUpperCase() === 'ADMIN'

  const [apps, setApps] = React.useState(null)
  const [query, setQuery] = React.useState('')
  const [filter, setFilter] = React.useState('all')
  const [rail, setRail] = React.useState(null)

  React.useEffect(() => {
    platformAPI.directory()
      .then((r) => setApps(r.data.data || []))
      .catch((err) => {
        toast.error(err.response?.data?.error || 'Could not load applications.')
        setApps([])
      })
    platformAPI.rail()
      .then((r) => setRail(r.data.data))
      .catch(() => setRail({ customised: false, pinned: [] }))
  }, [])

  const pinnedKeys = React.useMemo(
    () => new Set((rail?.pinned || []).map((a) => a.key)),
    [rail]
  )

  /**
   * Pin or unpin, by sending the whole list.
   *
   * Whole-list rather than add/remove because the order is part of what is
   * being stored, and two people cannot both be right about the position of
   * something if each sends only their own edit.
   */
  const togglePin = async (appKey) => {
    const next = pinnedKeys.has(appKey)
      ? (rail?.pinned || []).filter((a) => a.key !== appKey).map((a) => a.key)
      : [...(rail?.pinned || []).map((a) => a.key), appKey]
    const previous = rail
    setRail({ customised: true, pinned: next.map((k) => (apps || []).find((a) => a.key === k)).filter(Boolean) })
    try {
      const r = await platformAPI.setRail(next)
      setRail(r.data.data)
      // The rail lives in the Layout, a different tree. The window is the only
      // thing the two share.
      window.dispatchEvent(new Event(RAIL_CHANGED_EVENT))
    } catch (err) {
      setRail(previous)                     // put it back; the click did not happen
      toast.error(err.response?.data?.error || 'Could not change your rail.')
    }
  }

  const resetRail = async () => {
    try {
      const r = await platformAPI.resetRail()
      setRail(r.data.data)
      window.dispatchEvent(new Event(RAIL_CHANGED_EVENT))
      toast.success('Your rail is back to the core applications.')
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not reset your rail.')
    }
  }

  const matches = React.useCallback((a) => {
    if (filter === 'off' && a.enabled) return false
    if ((filter === 'native' || filter === 'generated') && a.kind !== filter) return false
    const q = query.trim().toLowerCase()
    if (!q) return true
    return `${a.name} ${a.description || ''}`.toLowerCase().includes(q)
  }, [filter, query])

  const shown = (apps || []).filter(matches)
  const core = shown.filter((a) => a.kind === 'native')
  const built = shown.filter((a) => a.kind === 'generated')

  return (
    <div className="space-y-6">
      <PageHeader
        title="Applications"
        description={
          <>
            Everything this company can do, in one place.
            {rail ? (rail.pinned.length ? ` ${rail.pinned.length} on your rail.` : ' Nothing on your rail; open everything from here.') : null}
            {rail?.customised ? <> <button type="button" className="font-medium text-fg underline-offset-2 hover:underline" onClick={resetRail}>Reset the rail</button></> : null}
          </>
        }
        secondary={<Button to="/marketplace">Marketplace</Button>}
        primary={isAdmin ? <Button variant="primary" to="/studio">Build an application</Button> : null}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          className="w-full sm:w-64"
          placeholder="Search applications"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search applications"
        />
        <Segmented label="Show" value={filter} onChange={setFilter} options={FILTERS.map((f) => ({ value: f.key, label: f.label }))} />
      </div>

      {apps === null ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[132px]" />)}
        </div>
      ) : null}

      {apps && !shown.length ? (
        <Card>
          <EmptyState compact title="Nothing matches" description={<>{query ? 'Try a different search, or ' : ''}<Link to="/studio" className="font-medium text-fg underline underline-offset-2">describe a capability</Link> and EMBMIS will design it.</>} />
        </Card>
      ) : null}

      {core.length ? (
        <section>
          <h2 className="label-mono mb-2">Core applications</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {core.map((a) => <AppCard key={a.key} app={a} pinned={pinnedKeys.has(a.key)} onPin={togglePin} />)}
          </div>
        </section>
      ) : null}

      {built.length || (isAdmin && filter !== 'native' && filter !== 'off') ? (
        <section>
          <h2 className="label-mono mb-2">Your applications</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {built.map((a) => <AppCard key={a.key} app={a} pinned={pinnedKeys.has(a.key)} onPin={togglePin} />)}

            {/* The way to make a new one belongs in the grid with the rest, not
                in a header button — an empty shelf should still tell you what
                to do with it. */}
            {isAdmin && filter !== 'native' && filter !== 'off' ? (
              <button type="button" onClick={() => navigate('/studio')}
                className="flex min-h-[132px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-ink-300 p-4 text-center hover:border-ink-400 hover:bg-ink-50">
                <PlusIcon className="h-5 w-5 text-ink-500" aria-hidden="true" />
                <span className="text-sm font-medium text-fg">Build an application</span>
                <span className="text-xs text-ink-500">Describe it in words; nothing is created until you approve.</span>
              </button>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  )
}

/**
 * One application.
 *
 * A card that is switched off leads to its detail rather than to itself: the
 * runtime would refuse to serve it, and a 409 is a worse answer than the
 * screen with the switch on it.
 */
function AppCard({ app, pinned, onPin }) {
  const to = app.enabled ? app.route : `/applications/${app.key}`
  // The card is a positioned box with one stretched link; pin and details are
  // separate controls above it (an interactive element inside an anchor is
  // invalid and unreachable by keyboard).
  return (
    <div className={clsx('group relative flex min-h-[132px] flex-col rounded-lg border border-ink-200 bg-surface p-4 hover:border-ink-300', !app.enabled && 'opacity-60')}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <span className="grid h-9 w-9 flex-none place-items-center rounded-md border border-ink-200 bg-sunken text-ink-700">
          <AppIcon name={app.icon} className="h-5 w-5" />
        </span>
        <span className="relative z-10 flex items-center gap-1.5">
          {!app.enabled ? <Badge tone="ink">Off</Badge> : null}
          {app.kind === 'generated' ? <Badge tone="ink">Built here</Badge> : null}
          {app.enabled ? (
            <button
              type="button"
              title={pinned ? `Take ${app.name} off your rail` : `Keep ${app.name} on your rail`}
              aria-label={pinned ? `Unpin ${app.name}` : `Pin ${app.name}`}
              aria-pressed={pinned}
              className={clsx('inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-ink-100', pinned ? 'text-fg' : 'text-ink-400')}
              onClick={() => onPin(app.key)}
            >
              {pinned ? <StarSolid className="h-4 w-4" aria-hidden="true" /> : <StarIcon className="h-4 w-4" aria-hidden="true" />}
            </button>
          ) : null}
        </span>
      </div>
      <Link to={to} className="truncate text-sm font-semibold text-fg after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-brand-600">{app.name}</Link>
      <span className="mt-1 line-clamp-2 text-xs text-ink-600">{app.description}</span>
      <span className="relative z-10 mt-auto pt-3">
        <Link to={`/applications/${app.key}`} className="text-xs text-ink-500 hover:text-fg hover:underline">Details</Link>
      </span>
    </div>
  )
}
