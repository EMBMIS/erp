/**
 * The generic application runtime.
 *
 * ===========================================================================
 * ONE COMPONENT, EVERY GENERATED APPLICATION
 * ===========================================================================
 * This screen renders Supplier Quality Management, Customer Warranty, Fleet
 * Maintenance and an application nobody has written yet, without knowing
 * anything about any of them. It asks the server for a shell (which surface,
 * which pages, what this person may do), asks for a page, and hands each block
 * to components/platform/blocks.jsx.
 *
 * The `client` prop is what makes the same component serve the company's own
 * side and a supplier's portal: internal callers pass platformAPI, portals pass
 * portalAPI. Neither the navigation, the tables, the workflow bar nor the
 * comment box knows which it is — the server has already decided what to send,
 * and the difference between the two sides lives entirely in the principal.
 */

import React from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { ArrowDownTrayIcon, FunnelIcon, MagnifyingGlassIcon, PlusIcon } from '@heroicons/react/24/outline'
import { Block } from '../../components/platform/blocks.jsx'
import PageHeader from '../../components/ui/PageHeader'
import { ConfirmDialog } from '../../components/ui/Dialog'
import { ErrorState, SkeletonDetail } from '../../components/ui/Feedback'
import { useRecordTitle } from '../../components/shell/ShellContext'
import api from '../../services/api'

/**
 * What Simeli reads from this application as part of the business
 * (GET /api/what-matters/built, services/builtInTheBusiness.js): its open
 * records that need someone, each tied to the supplier, customer or order it
 * points at and what that reaches. Read with this person's role here; the
 * same items rank on Home and count in supplier risk. Inside EMBMIS only —
 * a portal never sees it. Nothing here changes a record.
 */
function WiredIntoBusiness({ appKey, onOpen }) {
  const [data, setData] = React.useState(null)
  const [open, setOpen] = React.useState(false)
  React.useEffect(() => {
    let cancelled = false
    setData(null)
    api.get('/what-matters/built', { params: { application: appKey } })
      .then((res) => { if (!cancelled) setData(res.data?.data || null) })
      .catch(() => { if (!cancelled) setData(null) })
    return () => { cancelled = true }
  }, [appKey])
  if (!data || !data.items?.length) return null
  const ask = `What is open in ${data.applications?.[0]?.name || appKey}, and what does it put at risk in the rest of the business? Prepare the next step for my approval.`
  return (
    <div className="mb-4 rounded-lg border border-ink-200 bg-sunken px-4 py-2.5 text-xs text-ink-600">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg">Wired into the business</span>
        <span className="min-w-0 flex-1">{data.headline}</span>
        <button type="button" className="bos-link" onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : `Show ${data.items.length}`}</button>
        <button type="button" className="bos-link" onClick={() => onOpen(`/ai/chat?q=${encodeURIComponent(ask)}`)}>Ask Simeli</button>
      </p>
      {open ? (
        <ul className="mt-1.5 space-y-1">
          {data.items.slice(0, 6).map((i) => (
            <li key={i.id} className="flex flex-wrap gap-x-2">
              <button type="button" className="bos-link" onClick={() => onOpen(i.link)}>{i.title}</button>
              {i.at_stake?.what ? <span className="text-ink-500">· {i.at_stake.what}</span> : null}
              {i.connects?.length ? <span className="text-ink-500">· connects to {i.connects.map((c) => c.label || c.type).join(', ')}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

const emptyState = { shell: null, page: null, loading: true, error: null }

export default function AppRuntime({ client, basePath, external = false }) {
  const { appKey, pageKey, recordId } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()

  const [state, setState] = React.useState(emptyState)
  const [busy, setBusy] = React.useState(false)
  const [formValues, setFormValues] = React.useState({})
  const [referenceOptions, setReferenceOptions] = React.useState({})
  const [transitionPrompt, setTransitionPrompt] = React.useState(null)

  const search = searchParams.get('q') || ''
  const filters = React.useMemo(() => {
    const raw = searchParams.get('filters')
    if (!raw) return []
    try { return JSON.parse(raw) } catch { return [] }
  }, [searchParams])

  // -- load the shell once per application -------------------------------
  React.useEffect(() => {
    let cancelled = false
    setState((s) => ({ ...s, loading: true, error: null }))
    client.shell(appKey)
      .then((res) => {
        if (cancelled) return
        const shell = res.data.data
        setState((s) => ({ ...s, shell, loading: false }))
        if (!pageKey && shell.surface?.defaultPage) {
          navigate(`${basePath}/${appKey}/${shell.surface.defaultPage}`, { replace: true })
        }
      })
      .catch((err) => {
        if (cancelled) return
        setState({ ...emptyState, loading: false, error: err.response?.data?.error || 'Could not open this application.' })
      })
    return () => { cancelled = true }
  }, [appKey, client, basePath])

  // -- load the page whenever anything about it changes -------------------
  const loadPage = React.useCallback(async () => {
    if (!pageKey) return
    setState((s) => ({ ...s, loading: true }))
    try {
      const res = await client.page(appKey, pageKey, {
        recordId: recordId || undefined,
        search: search || undefined,
        filters: filters.length ? filters : undefined,
      })
      setState((s) => ({ ...s, page: res.data.data, loading: false, error: null }))
      setFormValues({})
    } catch (err) {
      setState((s) => ({
        ...s, loading: false,
        error: err.response?.data?.error || 'Could not open this page.',
      }))
    }
  }, [appKey, pageKey, recordId, search, filters, client])

  React.useEffect(() => { loadPage() }, [loadPage])

  // -- reference pickers ---------------------------------------------------
  const loadReferenceOptions = React.useCallback(async (field, query = '') => {
    if (!field?.reference) return
    try {
      const res = field.reference.kind === 'canonical'
        ? await client.canonical(appKey, field.reference.entity, { search: query })
        : await client.listRecords(appKey, field.reference.entity, { search: query, pageSize: 50 })
      const rows = res.data.data.rows || []
      setReferenceOptions((prev) => ({
        ...prev,
        [field.name]: rows.map((r) => ({
          id: r.id,
          // Canonical rows come back as their exposed columns; application rows
          // carry the entity's own title field. Falling back through both keeps
          // one picker working for both without a branch per entity.
          label: r.legal_name || r.customer_name || r.name || r.title || r.reference
            || r.item_code || r.po_number || r.so_number || r.id,
        })),
      }))
    } catch {
      setReferenceOptions((prev) => ({ ...prev, [field.name]: [] }))
    }
  }, [appKey, client])

  // Populate every picker on a form page as soon as it renders, so the fields
  // are usable rather than empty until someone types.
  React.useEffect(() => {
    const formBlock = (state.page?.blocks || []).find((b) => b.type === 'form')
    if (!formBlock) return
    formBlock.fields.filter((f) => f.reference).forEach((f) => loadReferenceOptions(f))
  }, [state.page, loadReferenceOptions])

  // -- actions -------------------------------------------------------------
  const openRecord = (entityKey, id) => {
    const detail = (state.shell?.pages || []).find(
      (p) => p.kind === 'detail' && p.entity === entityKey
    )
    if (detail) navigate(`${basePath}/${appKey}/${detail.key}/${id}`)
  }

  const submitForm = async () => {
    const formBlock = (state.page?.blocks || []).find((b) => b.type === 'form')
    if (!formBlock) return
    setBusy(true)
    try {
      const created = await client.createRecord(appKey, formBlock.entity, formValues)
      toast.success(`${state.page.entity?.singular || 'Record'} saved.`)
      openRecord(formBlock.entity, created.data.data.id)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not save that.')
    } finally {
      setBusy(false)
    }
  }

  const runTransition = async (transition, reason = '') => {
    setBusy(true)
    try {
      await client.transition(appKey, state.page.page.entity, recordId, transition.key, reason)
      toast.success(`Moved to ${transition.to.replace(/_/g, ' ').toLowerCase()}.`)
      setTransitionPrompt(null)
      await loadPage()
    } catch (err) {
      toast.error(err.response?.data?.error || 'That step is not available.')
    } finally {
      setBusy(false)
    }
  }

  const uploadAttachment = async (file, visibility) => {
    setBusy(true)
    try {
      await client.uploadAttachment(appKey, state.page.page.entity, recordId, file, visibility)
      await loadPage()
    } catch (err) {
      toast.error(err.response?.data?.error || 'That file could not be attached.')
    } finally {
      setBusy(false)
    }
  }

  /**
   * Open an attachment.
   *
   * Fetched rather than linked, because the download route needs the session
   * header — a plain <a href> would arrive unauthenticated and 401. The blob is
   * revoked after the browser has taken it.
   */
  const openAttachment = async (attachment) => {
    try {
      const url = client.attachmentUrl(appKey, state.page.page.entity, recordId, attachment.id)
      const response = await fetch(url, { headers: authHeadersFor(external) })
      if (!response.ok) throw new Error('unavailable')
      const blob = await response.blob()
      const href = URL.createObjectURL(blob)
      window.open(href, '_blank', 'noopener')
      setTimeout(() => URL.revokeObjectURL(href), 60000)
    } catch {
      toast.error('That document could not be opened.')
    }
  }

  const addComment = async (body, visibility) => {
    setBusy(true)
    try {
      await client.addComment(appKey, state.page.page.entity, recordId, { body, visibility })
      await loadPage()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not post that message.')
    } finally {
      setBusy(false)
    }
  }

  /**
   * Export what the list shows — every matching record, not just the page on
   * screen — as CSV, with the table's own columns.
   */
  const exportRecords = async () => {
    const table = (state.page?.blocks || []).find((b) => b.type === 'table')
    const entityKey = table?.entity || state.page?.page?.entity
    if (!entityKey) return
    try {
      const fields = table?.fields || []
      const rows = []
      for (let p = 1; p <= 40; p += 1) {
        const res = await client.listRecords(appKey, entityKey, {
          search: search || undefined, filters: filters.length ? filters : undefined, page: p, pageSize: 200,
        })
        const data = res.data.data
        rows.push(...(data.rows || []))
        if (p >= (data.pageCount || 1)) break
      }
      const cell = (v) => {
        const text = v == null ? '' : typeof v === 'object' ? (v.label ?? v.name ?? JSON.stringify(v)) : String(v)
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
      }
      const cols = fields.length ? fields : Object.keys(rows[0] || {}).map((name) => ({ name, label: name }))
      const csv = [cols.map((f) => cell(f.label)).join(','), ...rows.map((r) => cols.map((f) => cell(r[`${f.name}__label`] ?? r[f.name])).join(','))].join('\n')
      const href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
      const a = document.createElement('a')
      a.href = href
      a.download = `${appKey}-${entityKey}.csv`
      a.click()
      setTimeout(() => URL.revokeObjectURL(href), 10000)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not export these records.')
    }
  }

  const setFilter = (field, value) => {
    const next = filters.filter((f) => f.field !== field.field)
    if (value !== '' && value !== null) next.push({ field: field.field, operator: field.operator === 'in' ? 'eq' : field.operator, value })
    const params = new URLSearchParams(searchParams)
    if (next.length) params.set('filters', JSON.stringify(next)); else params.delete('filters')
    setSearchParams(params, { replace: true })
  }

  // Breadcrumbs and the tab title name the page, not its key.
  useRecordTitle(state.page?.page?.title)

  // -- render --------------------------------------------------------------
  if (state.error && !state.shell) {
    return (
      <div className={external ? 'p-6' : undefined}>
        <ErrorState what="This application" error={{ message: state.error }} onRetry={() => window.location.reload()} />
      </div>
    )
  }

  const shell = state.shell
  const page = state.page
  const kind = page?.page?.kind
  const blocks = page?.blocks || []

  // The page's own actions, drawn the way every built-in screen draws them:
  // the one that creates something is the primary button, the rest secondary.
  const createAction = (page?.actions || []).find((a) => a.target && /^new_/.test(a.key))
  const actionButtons = (page?.actions || []).length ? (
    <>
      {(page.actions || []).filter((a) => a !== createAction).map((a) => (
        <button key={a.key} type="button" className="btn btn-secondary inline-flex items-center"
          onClick={() => (a.kind === 'export' ? exportRecords() : a.target && navigate(`${basePath}/${appKey}/${a.target}`))}>
          {a.kind === 'export' ? <ArrowDownTrayIcon className="mr-2 h-4 w-4" /> : null}
          {a.label}
        </button>
      ))}
      {createAction ? (
        <button type="button" className="btn btn-primary inline-flex items-center"
          onClick={() => navigate(`${basePath}/${appKey}/${createAction.target}`)}>
          <PlusIcon className="mr-2 h-4 w-4" />
          {createAction.label.charAt(0).toUpperCase() + createAction.label.slice(1)}
        </button>
      ) : null}
    </>
  ) : null

  const renderBlock = (block, i) => (
    <Block key={`${block.type}-${i}`}
      block={block}
      pageKind={kind}
      record={page.record}
      entity={page.entity}
      values={formValues}
      busy={busy}
      referenceOptions={referenceOptions}
      onReferenceSearch={loadReferenceOptions}
      onChange={(name, value) => setFormValues((v) => ({ ...v, [name]: value }))}
      onSubmit={submitForm}
      onOpenRecord={openRecord}
      onCreate={createAction ? () => navigate(`${basePath}/${appKey}/${createAction.target}`) : undefined}
      createLabel={createAction?.label}
      onAddComment={addComment}
      onUpload={recordId ? uploadAttachment : undefined}
      onOpenAttachment={openAttachment}
      onTransition={(t) => {
        // A transition that needs a reason asks for one rather than
        // failing with "needs a reason" after the click.
        if (t.requires?.includes('comment')) setTransitionPrompt(t)
        else runTransition(t)
      }}
    />
  )

  // An overview opens the way a module's overview does: the page header, its
  // numbers, then the panels beneath.
  const mastheadMetrics = kind === 'dashboard' ? blocks.find((b) => b.type === 'metric_group') : null

  const filterCard = (page?.filters || []).length ? (
    <div className="mb-4 rounded-lg border border-ink-200 bg-surface p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="label-mono flex items-center gap-1.5">
          <FunnelIcon className="h-3.5 w-3.5" aria-hidden="true" />
          Filters
        </h3>
        {search || filters.length ? (
          <button type="button" className="text-xs font-medium text-ink-600 hover:text-fg hover:underline"
            onClick={() => {
              const params = new URLSearchParams(searchParams)
              params.delete('q'); params.delete('filters')
              setSearchParams(params, { replace: true })
            }}>
            Clear all
          </button>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative">
          <MagnifyingGlassIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" aria-hidden="true" />
          <input key={`q-${search}`} type="search" aria-label="Search" className="block w-full pl-8"
            defaultValue={search} placeholder={`Search ${(page.entity?.label || 'records').toLowerCase()}…`}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              const params = new URLSearchParams(searchParams)
              if (e.currentTarget.value) params.set('q', e.currentTarget.value); else params.delete('q')
              setSearchParams(params, { replace: true })
            }} />
        </div>
        {page.filters.map((f) => {
          const field = (page.entity?.fields || []).find((x) => x.name === f.field)
          if (!field) return null
          const current = filters.find((x) => x.field === f.field)?.value ?? ''
          const cls = 'block w-full'
          return field.values?.length ? (
            <select key={f.field} className={cls} value={current} onChange={(e) => setFilter(f, e.target.value)} aria-label={f.label}>
              <option value="">All {f.label.toLowerCase()}</option>
              {field.values.map((v) => <option key={v} value={v}>{v.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())}</option>)}
            </select>
          ) : (
            <input key={`${f.field}-${current}`} className={cls} defaultValue={current} placeholder={f.label}
              type={['date', 'datetime'].includes(field.type) ? 'date' : 'text'} aria-label={f.label}
              onChange={['date', 'datetime'].includes(field.type) ? (e) => setFilter(f, e.target.value) : undefined}
              onKeyDown={(e) => { if (e.key === 'Enter') setFilter(f, e.currentTarget.value) }} />
          )
        })}
      </div>
    </div>
  ) : null

  const wired = !external && appKey ? <WiredIntoBusiness appKey={appKey} onOpen={(to) => to && navigate(to)} /> : null

  const content = page ? (
    mastheadMetrics ? (
      <div className="flex flex-col gap-4">
        <PageHeader className="mb-0" title={page.page.title} subtitle={page.page.description} actions={actionButtons} />
        {wired}
        <Block block={{ ...mastheadMetrics, width: 'full' }} pageKind={kind} />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
          {blocks.map((b, i) => (b === mastheadMetrics ? null : renderBlock(b, i)))}
        </div>
      </div>
    ) : (
      <>
        {/* A record page is titled by the record itself (its detail header),
            as a built-in record page is — not by "Everything about one …". */}
        <div className={`flex items-start justify-between gap-4 ${kind === 'detail' && blocks.some((b) => b.type === 'detail_header') ? 'hidden' : ''}`}>
          <div className="min-w-0 flex-1">
            <PageHeader title={page.page.title} subtitle={page.page.description} />
          </div>
          {actionButtons ? <div className="flex flex-none items-center gap-2">{actionButtons}</div> : null}
        </div>
        {wired}
        {/* A list's figures sit above its filters, as on every built-in list. */}
        {kind === 'list' && blocks.some((b) => b.type === 'metric_group') ? (
          <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-12">
            {blocks.map((b, i) => (b.type === 'metric_group' ? renderBlock(b, i) : null))}
          </div>
        ) : null}
        {filterCard}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
          {blocks.map((b, i) => (kind === 'list' && b.type === 'metric_group' ? null : renderBlock(b, i)))}
        </div>
      </>
    )
  ) : (
    state.loading ? <SkeletonDetail /> : state.error ? (
      <ErrorState what="This page" error={{ message: state.error }} onRetry={() => window.location.reload()} />
    ) : <p className="text-sm text-ink-600">Choose a page from the menu.</p>
  )

  return (
    <div className="flex min-h-0 flex-1">
      {/* A portal has no EMBMIS sidebar, so it carries its own navigation —
          from the surface, so a portal's pages cannot list an internal one.
          Inside EMBMIS the sidebar already lists this application's pages,
          exactly as it lists a built-in module's. */}
      {external ? (
        <nav className="hidden w-56 shrink-0 border-r border-current/10 p-3 lg:block">
          <div className="mb-4 px-2">
            <p className="bos-eyebrow">{shell?.application?.name}</p>
            <p className="bos-caption mt-0.5">{shell?.surface?.label}</p>
          </div>
          {groupNav(shell?.surface?.nav || []).map((group) => (
            <div key={group.label} className="mb-4">
              {group.label ? <p className="bos-label mb-1 px-2">{group.label}</p> : null}
              <ul className="space-y-0.5">
                {group.items.map((item) => (
                  <li key={item.page}>
                    <button type="button"
                      onClick={() => navigate(`${basePath}/${appKey}/${item.page}`)}
                      className={`bos-nav-row w-full text-left ${item.page === pageKey ? 'bos-nav-row--active' : ''}`}>
                      {item.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      ) : null}

      {/* Inside the app shell, Layout's <main> already pads and labels the
          page; on a portal there is no shell, so the runtime pads itself. */}
      <div className={external ? 'mx-auto min-w-0 max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8' : 'min-w-0 flex-1'}>
        {content}
      </div>

      <ConfirmDialog
        open={!!transitionPrompt}
        onClose={() => setTransitionPrompt(null)}
        onConfirm={(reason) => runTransition(transitionPrompt, reason)}
        title={transitionPrompt?.label || ''}
        consequence="This step needs a reason. It is recorded against the record."
        requireReason
        reasonHelp="Everyone who can see the record can read this."
        confirmLabel={transitionPrompt?.label}
        tone="primary"
        busy={busy}
      />
    </div>
  )
}

/**
 * The Authorization header for whichever client this runtime is using.
 *
 * The two sessions are kept under different storage keys on purpose — a portal
 * token must never travel to an internal endpoint, and an employee's token must
 * never travel to a portal one — so a raw fetch has to pick the right one
 * rather than assuming.
 */
function authHeadersFor(isPortal) {
  const token = isPortal
    ? localStorage.getItem('embmis:portal-token')
    : localStorage.getItem('token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function groupNav(nav) {
  const groups = []
  nav.forEach((item) => {
    const label = item.section || ''
    let group = groups.find((g) => g.label === label)
    if (!group) { group = { label, items: [] }; groups.push(group) }
    group.items.push(item)
  })
  return groups
}
