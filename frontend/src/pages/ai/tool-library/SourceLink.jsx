import React from 'react'
import { LinkIcon } from '@heroicons/react/20/solid'

/**
 * A registry entry's url_or_package is sometimes a real URL (a repo, a docs
 * page) and sometimes an npm-style package name ("@scope/name"). Only the
 * former is safe to render as a link.
 */
export default function SourceLink({ url }) {
  if (!url) return null
  const isUrl = /^https?:\/\//i.test(url)
  const body = <><LinkIcon className="h-3 w-3 shrink-0" aria-hidden="true" /><span className="truncate">{url}</span></>
  return isUrl ? (
    <a href={url} target="_blank" rel="noopener noreferrer" className="mt-1 flex w-fit max-w-full items-center gap-1 font-mono text-xs text-brand-600 hover:underline">
      {body}
    </a>
  ) : (
    <p className="mt-1 flex max-w-full items-center gap-1 font-mono text-xs text-ink-500">{body}</p>
  )
}
