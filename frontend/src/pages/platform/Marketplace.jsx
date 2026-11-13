/**
 * The marketplace.
 *
 * ===========================================================================
 * WHAT A ROW HAS TO ANSWER
 * ===========================================================================
 * Installing a stranger's software into the system that runs your business is
 * not a casual act, and a shop that hides what it is asking for is a shop
 * nobody sensible buys from. So every listing says, before anything else:
 *
 *     what it will build      the record types it creates, in your database
 *     what of yours it reads  the EMBMIS data it touches
 *     who else sees it        any external audience it exposes
 *
 * The last one is the one people forget to ask. An application with a supplier
 * portal shows some of your data to people outside the company, and that has
 * to be on the card rather than three clicks away.
 *
 * ===========================================================================
 * SUGGESTIONS ARE REASONS
 * ===========================================================================
 * "You already keep Suppliers, which this uses" is a sentence somebody can
 * check and disagree with. It comes from counting what the company holds, not
 * from asking a model what it thinks — same rule as everywhere else in this
 * product: a judgement on a screen has to be the same judgement tomorrow for
 * the same facts.
 */

import React from 'react'
import { Link } from 'react-router-dom'
import { PageHeader, Button, Card, EmptyState, Skeleton, Badge, InlineNotice, MaturityBadge } from '../../components/ui'
import toast from 'react-hot-toast'
import { platformAPI, COMPANY_MODULES_CHANGED_EVENT } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import AppIcon from '../../components/platform/AppIcon'

const price = ({ cents, currency, free }) =>
  free ? 'Free' : new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)

export default function Marketplace() {
  const { user } = useAuth()
  const isAdmin = String(user?.role || '').toUpperCase() === 'ADMIN'

  const [listings, setListings] = React.useState(null)
  const [busy, setBusy] = React.useState(null)

  const load = React.useCallback(() => platformAPI.marketplace()
    .then((r) => setListings(r.data.data || []))
    .catch((err) => {
      toast.error(err.response?.data?.error || 'Could not load the marketplace.')
      setListings([])
    }), [])

  React.useEffect(() => { load() }, [load])

  const install = async (listing) => {
    setBusy(listing.appKey)
    try {
      await platformAPI.installFromMarketplace(listing.appKey)
      toast.success(`${listing.name} installed. Its data is yours alone.`)
      await load()
      window.dispatchEvent(new Event(COMPANY_MODULES_CHANGED_EVENT))
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not install that.')
    } finally {
      setBusy(null)
    }
  }

  // Things this company could actually use first — the suggestion is a
  // counted fact, so ordering by it is ordering by relevance rather than by
  // whatever was listed most recently.
  const sorted = React.useMemo(() => [...(listings || [])].sort((a, b) =>
    (b.suggestion?.strength || 0) - (a.suggestion?.strength || 0)), [listings])

  return (
    <div className="space-y-5">
      <PageHeader
        title="Marketplace"
        badge={<MaturityBadge level="preview" />}
        description="Applications other companies built, ready to run on your own data. Installing one copies the design, never the records."
        secondary={<Button to="/applications">Your applications</Button>}
      />

      {listings === null ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[190px]" />)}
        </div>
      ) : null}

      {listings && !listings.length ? (
        <Card>
          <EmptyState
            compact
            title="Nothing on offer yet"
            description={<>When a company publishes something it built in the <Link to="/studio" className="font-medium text-fg underline underline-offset-2">Studio</Link>, it appears here.</>}
          />
        </Card>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {sorted.map((listing) => (
          <article key={listing.appKey} className="flex flex-col rounded-lg border border-ink-200 bg-surface p-4">
            <div className="mb-3 flex items-start justify-between gap-2">
              <span className="grid h-9 w-9 flex-none place-items-center rounded-md border border-ink-200 bg-sunken text-ink-700">
                <AppIcon name={listing.icon} />
              </span>
              <Badge tone="ink">{price(listing.price)}</Badge>
            </div>

            <h2 className="text-sm font-semibold text-fg">{listing.name}</h2>
            <p className="mt-0.5 text-xs text-ink-500">
              by {listing.publisher} · v{listing.publishedVersion}
              {listing.installs ? ` · ${listing.installs} running it` : ''}
            </p>
            <p className="mt-2 text-sm text-ink-700">{listing.summary}</p>

            {listing.suggestion ? (
              <InlineNotice tone="brand" className="mt-2.5">{listing.suggestion.reason}</InlineNotice>
            ) : null}

            {/* What it builds, what of yours it reads, who else sees it. */}
            <dl className="mt-3 space-y-1.5">
              <Fact label="Creates" value={listing.owns.join(', ') || 'nothing'} />
              <Fact label="Reads" value={listing.reads.join(', ') || 'none of your data'} />
              {listing.externalAudiences.length ? (
                <Fact label="Shows to" value={listing.externalAudiences.join(', ')} warn />
              ) : null}
            </dl>

            <div className="mt-auto pt-3">
              {listing.installed ? (
                <Badge tone="ok" glyph="check">{listing.mine ? 'Yours' : 'Installed'}</Badge>
              ) : !isAdmin ? (
                <span className="text-xs text-ink-500">An administrator installs applications.</span>
              ) : listing.price.free ? (
                <Button size="sm" loading={busy === listing.appKey} onClick={() => install(listing)}>Install</Button>
              ) : (
                <span className="flex items-center gap-2">
                  <Button size="sm" disabled title="Payments are not connected yet">Buy</Button>
                  <span className="text-xs text-ink-500">Payments are not connected yet.</span>
                </span>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}

function Fact({ label, value, warn = false }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="label-mono flex-none">{label}</dt>
      <dd className={`min-w-0 truncate text-xs ${warn ? 'text-warn-700' : 'text-ink-600'}`} title={value}>
        {value}
      </dd>
    </div>
  )
}
