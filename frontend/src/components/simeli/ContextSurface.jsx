import React from 'react'
import { Link } from 'react-router-dom'
import {
  Boxes, Check, ChevronDown, ChevronRight, FileText, Pin, PinOff, Target, X,
} from 'lucide-react'
import { ActionCard, formatValue, humanizeKey } from './ResultBlocks'

/**
 * The context surface — what the conversation is currently about.
 *
 * WHY THIS IS NOT A FIXED SIDEBAR
 * ---------------------------------------------------------------------------
 * A panel with the same five headings on every conversation is furniture. It
 * takes 340px of a laptop screen to tell you things you already know, and
 * because it is always there it stops being read.
 *
 * So the sections here are conditional on the investigation actually having
 * something in them. A conversation that has not touched Procurement has no
 * Procurement row. One that proposed nothing has no action queue. What is on
 * screen is what Simeli has actually done, which means the panel changing is
 * itself information — a section appearing means the investigation reached
 * somewhere new.
 *
 * WHAT IS DERIVED AND WHAT IS THE USER'S
 * ---------------------------------------------------------------------------
 * Modules, entities and actions all come from the tool stream and are recorded
 * server-side (conversations.modules / .entities / .actions). The objective is
 * the one thing the user writes, because it is the one thing the system cannot
 * observe: what the investigation is *for*.
 *
 * PINNING
 * ---------------------------------------------------------------------------
 * A section the user pins stays open and sorts to the top even when the
 * conversation moves on. That is the escape hatch from the panel's own
 * cleverness: if Simeli decides the affected invoices are no longer the live
 * context and the user disagrees, the user wins.
 */

const LS_PINS = 'simeli.context.pins'

const readPins = () => {
  try { return JSON.parse(localStorage.getItem(LS_PINS) || '[]') } catch { return [] }
}

const MODULE_HREF = {
  Finance: '/finance/overview',
  Sales: '/sales/overview',
  Procurement: '/procurement',
  Inventory: '/inventory',
  Manufacturing: '/manufacturing',
  HR: '/hr/overview',
  Projects: '/projects/overview',
  CRM: '/crm/overview',
  Governance: '/ai-findings',
  Platform: '/agents',
  Data: '/analytics/overview',
  External: null,
}

const MODULE_TONE = {
  Finance: 'var(--sim-data)',
  Sales: 'var(--embmis-cyan)',
  Procurement: 'var(--embmis-indigo)',
  Inventory: 'var(--embmis-magenta)',
  Manufacturing: 'var(--embmis-cyan)',
  HR: 'var(--embmis-blue)',
  Projects: 'var(--embmis-violet)',
  CRM: 'var(--embmis-indigo)',
  Governance: 'var(--embmis-amber)',
  Platform: 'var(--embmis-violet)',
  Data: 'var(--sim-data)',
  External: 'var(--embmis-text-faint)',
}

function Section({ id, title, count, pinned, onPin, defaultOpen = true, children }) {
  const [open, setOpen] = React.useState(pinned || defaultOpen)
  React.useEffect(() => { if (pinned) setOpen(true) }, [pinned])

  return (
    <div className="sim-panel">
      <div className="flex items-center gap-1.5 px-3.5 pr-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-2.5 text-left"
        >
          {open
            ? <ChevronDown className="h-3 w-3 flex-none text-[color:var(--embmis-text-faint)]" />
            : <ChevronRight className="h-3 w-3 flex-none text-[color:var(--embmis-text-faint)]" />}
          <span className="truncate text-[10.5px] font-bold uppercase tracking-[0.09em] text-[color:var(--embmis-text-faint)]">
            {title}
          </span>
          {count !== undefined && count !== null && (
            <span className="flex-none rounded bg-[color:var(--embmis-blue-tint)] px-1.5 text-[10px] tabular-nums text-[color:var(--sim-data-lum)]">
              {count}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => onPin(id)}
          title={pinned ? 'Unpin — let this follow the conversation' : 'Pin — keep this open'}
          aria-pressed={pinned}
          className="flex-none rounded p-1 text-[color:var(--embmis-text-faint)] hover:text-[color:var(--sim-identity-lum)]"
        >
          {pinned ? <Pin className="h-3 w-3 fill-current" /> : <PinOff className="h-3 w-3" />}
        </button>
      </div>

      {open && <div className="border-t border-[color:var(--sim-line)] px-3.5 py-2.5">{children}</div>}
    </div>
  )
}

/**
 * @param workspace  { objective, modules[], entities[], actions[], artifacts[] }
 * @param live       what the current turn is touching, ahead of the server record
 */
export default function ContextSurface({
  workspace, live, onObjective, onApproveAction, onDenyAction, busy, onClose,
}) {
  const [pins, setPins] = React.useState(readPins)
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState('')

  const togglePin = React.useCallback((id) => {
    setPins((prev) => {
      const next = prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
      try { localStorage.setItem(LS_PINS, JSON.stringify(next)) } catch { /* storage off */ }
      return next
    })
  }, [])

  // The live turn is merged over the saved record so the panel moves with the
  // conversation instead of lagging a request behind it.
  const modules = React.useMemo(() => {
    const set = new Set([...(workspace?.modules || []), ...(live?.modules || [])])
    return [...set].filter(Boolean).sort()
  }, [workspace?.modules, live?.modules])

  const entities = React.useMemo(() => {
    const seen = new Set()
    const all = [...(live?.entities || []), ...(workspace?.entities || [])]
    return all.filter((e) => {
      if (!e?.label) return false
      const key = `${e.type}|${e.label}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, 24)
  }, [workspace?.entities, live?.entities])

  const actions = React.useMemo(() => {
    const all = [...(live?.actions || []), ...(workspace?.actions || [])]
    const seen = new Set()
    return all.filter((a) => {
      const key = `${a.name}|${a.at}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, 12)
  }, [workspace?.actions, live?.actions])

  const pending = actions.filter((a) => a.state === 'proposed')
  const artifacts = workspace?.artifacts || []

  // Sections are declared, then filtered by whether they have anything, then
  // sorted so pinned ones come first. Nothing renders an empty shell.
  const sections = []

  if (pending.length) {
    sections.push({
      id: 'approvals',
      title: 'Awaiting your decision',
      count: pending.length,
      node: (
        <div className="flex flex-col gap-2">
          {pending.map((a, i) => (
            <ActionCard
              key={`${a.name}-${i}`}
              action={a}
              busy={busy}
              onApprove={onApproveAction}
              onDeny={onDenyAction}
            />
          ))}
        </div>
      ),
    })
  }

  if (modules.length) {
    sections.push({
      id: 'modules',
      title: 'Modules in play',
      count: modules.length,
      node: (
        <div className="flex flex-wrap gap-1.5">
          {modules.map((m) => {
            const href = MODULE_HREF[m]
            const tone = MODULE_TONE[m] || 'var(--sim-data)'
            const body = (
              <>
                <span
                  className="h-1.5 w-1.5 flex-none rounded-full"
                  style={{ background: tone, boxShadow: `0 0 7px 1px ${tone}` }}
                />
                {m}
              </>
            )
            const cls = 'inline-flex items-center gap-1.5 rounded-full border border-[color:var(--sim-line)] px-2.5 py-1 text-[11.5px] text-[color:var(--embmis-text)] hover:border-[color:var(--sim-line-lit)]'
            return href
              ? <Link key={m} to={href} className={cls}>{body}</Link>
              : <span key={m} className={cls}>{body}</span>
          })}
        </div>
      ),
    })
  }

  if (entities.length) {
    // Grouped by the kind of record, because "12 records" is not useful and
    // "8 invoices, 4 customers" is.
    const byType = new Map()
    for (const e of entities) {
      if (!byType.has(e.type)) byType.set(e.type, [])
      byType.get(e.type).push(e)
    }
    sections.push({
      id: 'records',
      title: 'Records in view',
      count: entities.length,
      node: (
        <div className="flex flex-col gap-2.5">
          {[...byType.entries()].map(([type, list]) => (
            <div key={type}>
              <div className="mb-1 text-[10px] uppercase tracking-[0.08em] text-[color:var(--embmis-text-faint)]">
                {type}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {list.slice(0, 8).map((e, i) => (
                  <span key={`${e.label}-${i}`} className="sim-ref">
                    <FileText className="h-3 w-3 flex-none opacity-70" />
                    <span className="max-w-[13rem] truncate">{e.label}</span>
                  </span>
                ))}
                {list.length > 8 && (
                  <span className="self-center text-[11px] text-[color:var(--embmis-text-faint)]">
                    +{list.length - 8}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      ),
    })
  }

  const doneActions = actions.filter((a) => a.state !== 'proposed')
  if (doneActions.length) {
    sections.push({
      id: 'actions',
      title: 'Actions taken',
      count: doneActions.length,
      node: (
        <div className="flex flex-col gap-2">
          {doneActions.map((a, i) => <ActionCard key={`${a.name}-${i}`} action={a} />)}
        </div>
      ),
    })
  }

  if (artifacts.length) {
    sections.push({
      id: 'artifacts',
      title: 'Documents produced',
      count: artifacts.length,
      node: (
        <div className="flex flex-col gap-1.5">
          {artifacts.map((doc, i) => (
            <a
              key={doc.document_id || i}
              href={doc.download_url}
              className="sim-ref w-full justify-start"
              target="_blank"
              rel="noopener noreferrer"
            >
              <FileText className="h-3 w-3 flex-none opacity-70" />
              <span className="truncate">{doc.title || doc.file_name}</span>
            </a>
          ))}
        </div>
      ),
    })
  }

  sections.sort((a, b) => (pins.includes(b.id) ? 1 : 0) - (pins.includes(a.id) ? 1 : 0))

  const objective = workspace?.objective

  return (
    <div className="flex h-full min-h-0 flex-col">
      {onClose && (
        <div className="flex items-center justify-between px-3.5 py-3">
          <span className="text-[10.5px] font-bold uppercase tracking-[0.09em] text-[color:var(--embmis-text-faint)]">
            Context
          </span>
          <button type="button" onClick={onClose} className="rounded p-1 text-[color:var(--embmis-text-faint)] hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="sim-scroll flex min-h-0 flex-1 flex-col gap-2.5 p-2.5">
        {/* The objective. The user's own framing, and the only thing on this
            panel the system did not observe for itself. */}
        <div className="sim-panel px-3.5 py-3">
          <div className="mb-1.5 flex items-center gap-1.5">
            <Target className="h-3 w-3 text-[color:var(--sim-identity-lum)]" />
            <span className="text-[10.5px] font-bold uppercase tracking-[0.09em] text-[color:var(--embmis-text-faint)]">
              Objective
            </span>
          </div>

          {editing ? (
            <form
              onSubmit={(e) => { e.preventDefault(); onObjective?.(draft.trim() || null); setEditing(false) }}
              className="flex flex-col gap-2"
            >
              <textarea
                ref={(el) => { if (el && document.activeElement !== el && !el.dataset.focused) { el.dataset.focused = '1'; el.focus() } }}
                aria-label="Objective"
                rows={3}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="What is this investigation for?"
                className="w-full resize-none rounded-lg border border-[color:var(--sim-line)] bg-black/30 p-2 text-[12.5px] text-[color:var(--embmis-text-strong)] outline-none focus:border-[color:var(--sim-line-lit)]"
              />
              <div className="flex gap-2">
                <button type="submit" className="sim-btn sim-btn-primary py-1 text-[11.5px]">
                  <Check className="h-3 w-3" /> Save
                </button>
                <button type="button" className="sim-btn py-1 text-[11.5px]" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => { setDraft(objective || ''); setEditing(true) }}
              className="w-full text-left text-[12.5px] leading-relaxed"
            >
              {objective
                ? <span className="text-[color:var(--embmis-text)]">{objective}</span>
                : <span className="text-[color:var(--embmis-text-faint)]">
                    Not set. Write what you are trying to find out, and it stays with this
                    investigation when you come back to it.
                  </span>}
            </button>
          )}
        </div>

        {sections.map((s) => (
          <Section
            key={s.id}
            id={s.id}
            title={s.title}
            count={s.count}
            pinned={pins.includes(s.id)}
            onPin={togglePin}
          >
            {s.node}
          </Section>
        ))}

        {/* Deliberately explicit rather than an empty panel: this says the
            surface is working and has nothing yet, which is different from the
            surface being broken. */}
        {!sections.length && (
          <div className="sim-panel px-3.5 py-4">
            <Boxes className="mb-2 h-4 w-4 text-[color:var(--embmis-text-faint)]" />
            <p className="text-[12px] leading-relaxed text-[color:var(--embmis-text-muted)]">
              Nothing in context yet. As Simeli reads ERP records, the modules it
              touches and the records it opens appear here.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

export { MODULE_TONE, MODULE_HREF }
