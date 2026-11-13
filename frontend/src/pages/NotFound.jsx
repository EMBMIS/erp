// The route that did not exist.
//
// There was no catch-all: an unknown URL — a mistyped path, a stale bookmark, a
// link to a record someone deleted — rendered the app chrome around a blank
// area with no message. That looks like the application broke rather than like
// the address was wrong, and it is the kind of thing that generates a support
// ticket every time.
//
// It offers a way back rather than just an apology, because the common cause is
// a link from outside the app and the person still needs to get where they were
// going.
import React from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Button, Code } from '../components/ui'
import { useI18n } from '../contexts/I18nContext'

export default function NotFound() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { t } = useI18n()

  return (
    <section className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-4 text-center">
      <p className="label-mono">404</p>
      <h1 className="mt-2 text-xl font-semibold tracking-tight text-fg">{t('ui.pageNotFound')}</h1>
      <p className="mt-2 text-sm text-ink-600">{t('ui.pageNotFoundHint')}</p>
      <Code className="mt-3 block max-w-full truncate rounded bg-sunken px-2.5 py-1 text-xs text-ink-600">{pathname}</Code>
      <div className="mt-6 flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
        <Button variant="secondary" size="lg" onClick={() => navigate(-1)}>{t('ui.goBack')}</Button>
        <Button variant="primary" size="lg" to="/">{t('ui.backToDashboard')}</Button>
      </div>
    </section>
  )
}
