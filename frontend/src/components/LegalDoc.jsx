// Shared body for the public legal pages (Privacy Policy, Terms of Service).
//
// These pages live outside the authenticated app shell — anyone arriving from
// a cookie banner or the login footer must be able to read them without an
// account — so they render inside the public frame: mark, title, sections.
import React from 'react'
import { Link } from 'react-router-dom'
import { PublicShell, PublicHeader } from './public/PublicPage'

export default function LegalDoc({ eyebrow, title, intro, sections, contact }) {
  return (
    <PublicShell footer={false}>
      <article className="max-w-2xl">
        <PublicHeader eyebrow={eyebrow} title={title} description={intro} />
        <div className="space-y-7">
          {sections.map((s) => (
            <section key={s.title}>
              <h2 className="text-base font-semibold text-fg">{s.title}</h2>
              <div className="mt-2 space-y-2">
                {s.body.map((p) => (
                  <p key={p} className="text-sm leading-relaxed text-ink-700">{p}</p>
                ))}
              </div>
            </section>
          ))}
        </div>
        <p className="mt-10 border-t border-ink-200 pt-5 text-sm text-ink-600">{contact}</p>
        <p className="mt-4 text-sm">
          <Link to="/login" className="font-medium text-brand-600 underline-offset-2 hover:underline">Sign in</Link>
        </p>
      </article>
    </PublicShell>
  )
}
