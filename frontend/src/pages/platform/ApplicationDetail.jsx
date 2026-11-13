/**
 * One application, in full.
 *
 * ===========================================================================
 * WHY THE SWITCH IS HERE AND NOT ON THE CARD
 * ===========================================================================
 * The Apps grid is a launcher: it answers "what can this company do" and every
 * card opens something. This screen answers everything else about one of them
 * — what it reads, writes and owns, which version is running, the physical
 * tables behind it, its whole history, and whether it is switched on.
 *
 * Switching an application off is the most consequential control on either
 * screen. It should not also be the easiest one to hit while looking for
 * something to open.
 *
 * Both kinds of application land here. A core one has no versions, no
 * deployment history and no tables of its own — it references the shared
 * canonical ones — so those sections are simply absent rather than rendered
 * empty. What both have is the record types they are allowed to touch, which
 * is the fact this product could never state about itself before.
 */

import React from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { platformAPI, COMPANY_MODULES_CHANGED_EVENT } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import AppIcon from '../../components/platform/AppIcon'
import { PageHeader, Button, Badge, ConfirmDialog, SkeletonDetail } from '../../components/ui'

export default function ApplicationDetail() {
  const { appKey } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const isAdmin = String(user?.role || '').toUpperCase() === 'ADMIN'

  const [entry, setEntry] = React.useState(undefined)
  const [described, setDescribed] = React.useState(null)
  const [detail, setDetail] = React.useState(null)
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    const [dir, cat] = await Promise.all([
      platformAPI.directory(),
      platformAPI.catalogue().catch(() => ({ data: { data: null } })),
    ])
    const found = (dir.data.data || []).find((a) => a.key === appKey) || null
    setEntry(found)
    setDescribed(cat.data.data?.applications?.find((a) => a.appKey === appKey) || null)

    // A core application has no registry row. Asking the registry about it
    // would 404, so the directory entry is the whole story.
    if (!found || found.kind === 'native') { setDetail(null); return }

    const [app, tables, events] = await Promise.all([
      platformAPI.getApplication(appKey),
      isAdmin ? platformAPI.listTables(appKey).catch(() => ({ data: { data: [] } })) : Promise.resolve({ data: { data: [] } }),
      platformAPI.listEvents(appKey, { limit: 25 }).catch(() => ({ data: { data: [] } })),
    ])
    setDetail({ ...app.data.data, tables: tables.data.data, events: events.data.data })
  }, [appKey, isAdmin])

  React.useEffect(() => {
    load().catch(() => { setEntry(null); toast.error('Could not open that application.') })
  }, [load])

  const [confirmOff, setConfirmOff] = React.useState(false)
  const toggle = async () => {
    setBusy(true)
    try {
      await platformAPI.setAppEnabled(entry.key, !entry.enabled)
      toast.success(entry.enabled
        ? `${entry.name} switched off. Its records are kept.`
        : `${entry.name} switched back on.`)
      await load()
      // The shell reads module state once on mount; without this the rail and
      // this screen disagree until a reload.
      window.dispatchEvent(new Event(COMPANY_MODULES_CHANGED_EVENT))
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not change that.')
    } finally {
      setBusy(false)
    }
  }

  if (entry === undefined) return <SkeletonDetail />
  if (entry === null) {
    return (
      <div className="bos-panel p-6">
        <p className="bos-caption">
          No application called &ldquo;{appKey}&rdquo;. <Link to="/applications" className="bos-link">Back to Apps</Link>.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={entry.name}
        description={entry.description}
        badge={<Badge tone={entry.enabled ? 'ok' : 'ink'} glyph={entry.enabled ? 'dot' : undefined}>{entry.enabled ? 'Running' : 'Switched off'}</Badge>}
        primary={entry.enabled ? <Button variant="primary" onClick={() => navigate(entry.route)}>Open</Button> : null}
        secondary={isAdmin ? (
          entry.removable ? (
            <Button variant={entry.enabled ? 'secondary' : 'primary'} loading={busy} onClick={() => (entry.enabled ? setConfirmOff(true) : toggle())}>
              {entry.enabled ? 'Switch off' : 'Switch on'}
            </Button>
          ) : (
            <span className="text-xs text-ink-500">Core applications cannot be switched off.</span>
          )
        ) : null}
      />
      <ConfirmDialog
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        onConfirm={async () => { await toggle(); setConfirmOff(false) }}
        title={`Switch off ${entry.name}?`}
        consequence="It disappears from the rail and stops serving its screens for everyone in the company. Its records are kept."
        reversible
        confirmLabel="Switch off"
        busy={busy}
      />

      {!entry.enabled && entry.disabledReason ? (
        <p className="bos-caption italic">Switched off: &ldquo;{entry.disabledReason}&rdquo;</p>
      ) : null}

      <section className="bos-panel p-4">
        <h3 className="bos-eyebrow mb-3">What it can touch</h3>
        <p className="bos-caption mb-3">
          {/* Three genuinely different situations, and saying the wrong one is
              worse than saying nothing: this screen exists to be believed
              about exactly this. */}
          {entry.catalogued === false
            ? 'This application holds its own data, and that data is deliberately outside the shared record catalogue — so nothing built in the Studio can reference it. Its records are reachable through this application and nowhere else.'
            : entry.kind === 'native'
              ? 'A core application works on the shared EMBMIS record types. It has no private tables — that is the difference between it and an application built here, and it is the difference that matters for isolation.'
              : 'An application built here owns its own tables, isolated from every other company running the same design, and reads whichever shared record types it was granted.'}
        </p>
        <dl className="grid gap-3 sm:grid-cols-3">
          <Group label="Owns" items={entry.owns} accent="bos-accent-violet" />
          <Group label="Reads" items={entry.reads} />
          <Group label="Writes" items={entry.writes} accent="bos-accent-amber" />
        </dl>
      </section>

      {described ? <CatalogueDetail described={described} /> : null}

      {detail ? (
        <>
          <section className="bos-panel p-4">
            <h3 className="bos-eyebrow mb-3">Version</h3>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Key" value={detail.application.appKey} />
              <Field label="Running" value={detail.runningVersion ? `v${detail.runningVersion}` : '—'} />
              <Field label="Versions" value={detail.versions.length} />
              <Field label="Kind" value={detail.application.kind} />
            </dl>
          </section>

          {isAdmin && detail.tables?.length ? (
            <section className="bos-panel p-4">
              <h3 className="bos-eyebrow mb-3">Physical tables for this company</h3>
              <p className="bos-caption mb-2">
                These belong to this company&rsquo;s instance alone. Another company running the same
                application gets entirely separate tables.
              </p>
              <ul className="space-y-1">
                {detail.tables.map((t) => (
                  <li key={t.entityKey} className="flex items-center justify-between gap-3 text-[12.5px]">
                    <span className="bos-text">{t.entityKey}</span>
                    <code className="bos-caption truncate">{t.schema}.{t.table}</code>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="bos-panel p-4">
            <h3 className="bos-eyebrow mb-3">Versions</h3>
            <ul className="space-y-1.5">
              {detail.versions.map((v) => (
                <li key={v.id} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[12.5px] bos-text">
                      v{v.version} <span className="bos-caption">· {v.status} · {v.authored_by}</span>
                    </p>
                    <p className="bos-caption truncate" title={v.change_summary}>{v.change_summary}</p>
                  </div>
                  <span className="bos-caption shrink-0">{new Date(v.created_at).toLocaleDateString()}</span>
                </li>
              ))}
            </ul>
          </section>

          {detail.events?.length ? (
            <section className="bos-panel p-4">
              <h3 className="bos-eyebrow mb-3">History</h3>
              <ul className="space-y-1.5">
                {detail.events.map((e) => (
                  <li key={e.id} className="flex items-start gap-2">
                    <span className={`bos-chip shrink-0 ${toneForProvenance(e.provenance_class)}`}>
                      {e.provenance_class}
                    </span>
                    <div className="min-w-0">
                      <p className="text-[12.5px] bos-text">{e.summary}</p>
                      <p className="bos-caption">{new Date(e.created_at).toLocaleString()}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

/** What a generated application does, from its specification. */
function CatalogueDetail({ described }) {
  return (
    <section className="bos-panel p-4">
      <h3 className="bos-eyebrow mb-3">What it does</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="bos-label mb-1">Owns</p>
          <ul className="space-y-0.5">
            {described.entities.map((e) => (
              <li key={e.key} className="bos-caption">
                {e.label} · {e.fields.length} fields
                {e.anchoredTo ? ` · each belongs to a ${e.anchoredTo}` : ''}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="bos-label mb-1">Reads from EMBMIS</p>
          <p className="bos-caption">{described.dependsOn.join(', ') || 'nothing'}</p>

          <p className="bos-label mb-1 mt-3">Shown outside the company</p>
          {Object.keys(described.exposes.shownExternally).length ? (
            Object.entries(described.exposes.shownExternally).map(([audience, keys]) => (
              <p key={audience} className="bos-caption">{audience}: {keys.join(', ')}</p>
            ))
          ) : (
            <p className="bos-caption">
              {described.externalAudiences.length
                ? `${described.externalAudiences.join(', ')} see only their own records of this application's own data.`
                : 'Nothing. This application has no external surface.'}
            </p>
          )}
        </div>
      </div>
      {described.workflows.length ? (
        <>
          <p className="bos-label mb-1 mt-4">Workflows</p>
          {described.workflows.map((w) => (
            <p key={w.key} className="bos-caption">{w.label}: {w.states.join(' → ')}</p>
          ))}
        </>
      ) : null}
    </section>
  )
}

/**
 * The six provenance classes, each with its own tone.
 *
 * Colour is doing real work here rather than decorating: an observation, a
 * decision and an execution look different at a glance, so scanning the
 * history answers "what actually happened" without reading every row.
 */
const toneForProvenance = (c) => ({
  observation: 'bos-accent-cyan', decision: 'bos-accent-violet', simulation: 'bos-accent-blue',
  authorization: 'bos-accent-amber', execution: 'bos-accent-green', outcome: 'bos-accent-magenta',
}[c] || '')

/**
 * One list of record types, as chips.
 *
 * Owns, reads and writes render through the same component and differ only in
 * tone: they are the same kind of fact about an application, and separating
 * them into three components would only mean three places to change.
 */
function Group({ label, items, accent = '' }) {
  return (
    <div>
      <dt className="bos-label mb-1.5">{label}</dt>
      <dd className="flex flex-wrap gap-1.5">
        {items?.length
          ? items.map((k) => <span key={k} className={`bos-chip ${accent}`}>{k}</span>)
          : <span className="bos-caption">nothing</span>}
      </dd>
    </div>
  )
}

function Field({ label, value }) {
  return (
    <div>
      <dt className="bos-label">{label}</dt>
      <dd className="mt-0.5 truncate text-[13px] bos-text">{value}</dd>
    </div>
  )
}
