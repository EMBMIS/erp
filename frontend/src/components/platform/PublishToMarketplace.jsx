/**
 * Offering something you built to everybody else.
 *
 * ===========================================================================
 * WHY THE SUMMARY IS REQUIRED AND THE DESCRIPTION IS NOT ENOUGH
 * ===========================================================================
 * An application's description was written for its author, usually by the
 * Studio, and it describes the thing. A listing has to describe it to somebody
 * who has never seen it and is deciding whether to run it on their own data.
 * Those are different jobs, so this asks for the second one rather than
 * reusing the first and hoping.
 *
 * ===========================================================================
 * THE PRICE FIELD IS HONEST ABOUT ITSELF
 * ===========================================================================
 * A publisher can name a price and everybody browsing sees it. Nothing charges
 * anybody yet, and the form says so where the price is entered rather than in
 * a footnote — a publisher who lists at $49 and expects money to arrive has
 * been misled by the interface, not by the documentation they did not read.
 */

import React from 'react'
import toast from 'react-hot-toast'
import { platformAPI } from '../../services/api'

export default function PublishToMarketplace({ appKey, name }) {
  const [open, setOpen] = React.useState(false)
  const [summary, setSummary] = React.useState('')
  const [amount, setAmount] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [listed, setListed] = React.useState(null)

  React.useEffect(() => {
    platformAPI.publishedListings()
      .then((r) => setListed((r.data.data || []).find((l) => l.appKey === appKey) || false))
      .catch(() => setListed(false))
  }, [appKey])

  const publish = async () => {
    setBusy(true)
    try {
      // Entered in whole currency units because that is how people think about
      // money; stored in cents because that is the only way to hold it without
      // rounding somebody's price.
      const cents = Math.round(Number(amount || 0) * 100)
      const r = await platformAPI.publishApp(appKey, { summary, priceCents: Number.isFinite(cents) ? cents : 0 })
      setListed(r.data.data)
      setOpen(false)
      toast.success(`${name} is on the marketplace.`)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not publish that.')
    } finally {
      setBusy(false)
    }
  }

  const withdraw = async () => {
    setBusy(true)
    try {
      await platformAPI.withdrawApp(appKey)
      setListed(false)
      toast.success('Withdrawn. Companies already running it keep it.')
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not withdraw that.')
    } finally {
      setBusy(false)
    }
  }

  if (listed === null) return null

  if (listed) {
    return (
      <button type="button" className="bos-btn bos-btn--sm" disabled={busy} onClick={withdraw}>
        {busy ? '…' : 'Withdraw from marketplace'}
      </button>
    )
  }

  if (!open) {
    return (
      <button type="button" className="bos-btn bos-btn--sm" onClick={() => setOpen(true)}>
        Offer to other companies
      </button>
    )
  }

  return (
    <div className="bos-panel mt-2 w-full p-3">
      <p className="bos-eyebrow mb-2">Offer {name} to other companies</p>
      <label className="bos-label mb-1 block" htmlFor="listing-summary">
        How would you describe it to somebody who has never seen it?
      </label>
      <textarea
        id="listing-summary"
        className="bos-field min-h-[64px] w-full"
        value={summary}
        maxLength={500}
        placeholder="Track quality findings against suppliers, with a portal for suppliers to respond."
        onChange={(e) => setSummary(e.target.value)}
      />
      <p className="bos-caption mt-1">
        {summary.trim().length < 10
          ? 'At least ten characters.'
          : `${500 - summary.trim().length} left.`}
      </p>

      <label className="bos-label mb-1 mt-3 block" htmlFor="listing-price">Price (USD)</label>
      <input
        id="listing-price"
        type="number" min="0" step="1"
        className="bos-field w-[140px]"
        value={amount}
        placeholder="0"
        onChange={(e) => setAmount(e.target.value)}
      />
      <p className="bos-caption mt-1">
        Leave it at zero to give it away. A price is <strong>shown but not charged</strong> — payments
        are not connected yet, so a paid listing cannot be installed by anybody.
      </p>

      <div className="mt-3 flex gap-2">
        <button type="button" className="bos-btn bos-btn--primary bos-btn--sm"
          disabled={busy || summary.trim().length < 10} onClick={publish}>
          {busy ? 'Publishing…' : 'Publish'}
        </button>
        <button type="button" className="bos-btn bos-btn--ghost bos-btn--sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  )
}
