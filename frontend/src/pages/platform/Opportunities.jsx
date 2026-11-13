/**
 * Capability Discovery.
 *
 * What the business appears to need that no installed application provides.
 * Every row here came from counted evidence — late deliveries, overdue
 * invoices, anomalies nobody closed — accumulated across scans until it crossed
 * a threshold. None of it deployed anything, and accepting one opens the Studio
 * with the requirement filled in rather than building anything.
 *
 * Anyone can also ask for a capability in their own words — the same path as
 * asking Simeli. An administrator gets Sandbox's draft design and goes to the
 * Studio to review and deploy it; anyone else's request lands here for an
 * administrator, who is told who asked.
 */

import React from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { platformAPI } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { PageHeader, Button, Card, EmptyState, SkeletonRows, Badge, StatusBadge, MaturityBadge, Textarea } from '../../components/ui'
import { useShell } from '../../components/shell/ShellContext'

export default function Opportunities() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const isAdmin = String(user?.role || '').toUpperCase() === 'ADMIN'

  const [rows, setRows] = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(null)
  const [need, setNeed] = React.useState('')
  const { openSimeli } = useShell()

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await platformAPI.opportunities()
      setRows(res.data.data || [])
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not load opportunities.')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { load() }, [load])

  const scan = async () => {
    setBusy('scan')
    try {
      const res = await platformAPI.scanOpportunities()
      const { signalsObserved, opportunitiesProposed } = res.data.data
      toast.success(
        opportunitiesProposed
          ? `${opportunitiesProposed} new opportunit${opportunitiesProposed === 1 ? 'y' : 'ies'} from ${signalsObserved} signal(s).`
          : `${signalsObserved} signal(s) observed; nothing has crossed a threshold yet.`
      )
      await load()
    } catch (err) {
      toast.error(err.response?.data?.error || 'The scan failed.')
    } finally {
      setBusy(null)
    }
  }

  const accept = async (row) => {
    setBusy(row.id)
    try {
      const res = await platformAPI.acceptOpportunity(row.id)
      navigate(`/studio/${res.data.data.sessionId}`)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not open the Studio for that.')
    } finally {
      setBusy(null)
    }
  }

  const request = async (e) => {
    e.preventDefault()
    const requirement = need.trim()
    if (requirement.length < 10) return toast.error('Describe what you need in a sentence or two.')
    setBusy('request')
    try {
      const res = await platformAPI.requestCapability({ requirement })
      const out = res.data.data
      if (out.status === 'designed') {
        toast.success(`Sandbox designed ${out.application}. Review the plan and deploy it in the Studio.`)
        navigate(out.open)
        return
      }
      toast.success(out.sent_to?.length ? `Sent to ${out.sent_to.join(', ')}.` : 'Recorded; it waits for an administrator.')
      setNeed('')
      await load()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not send that to Sandbox.')
    } finally {
      setBusy(null)
    }
  }

  const askedBy = (row) => (row.source_signal === 'person_request'
    ? [...new Set((row.evidence?.requested_by || []).map((r) => r.name).filter(Boolean))]
    : null)

  const dismiss = async (row) => {
    setBusy(row.id)
    try {
      await platformAPI.dismissOpportunity(row.id)
      await load()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not dismiss that.')
    } finally {
      setBusy(null)
    }
  }

  const open = rows.filter((r) => ['detected', 'proposed'].includes(r.status))
  const handled = rows.filter((r) => !['detected', 'proposed'].includes(r.status))

  return (
    <div className="space-y-5">
      <PageHeader
        title="Capability opportunities"
        badge={<MaturityBadge level="beta" />}
        description="Gaps EMBMIS has noticed in what the business can do, from counted evidence. Nothing is built without you."
        secondary={isAdmin ? <Button loading={busy === 'scan'} onClick={scan}>Scan now</Button> : null}
      />

      <Card>
        <form onSubmit={request} className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-fg">Describe what you need</h2>
            <p className="mt-0.5 text-xs text-ink-500">
              {isAdmin
                ? 'Sandbox designs it on your real records and rehearses it. Nothing is deployed until you approve it in the Studio.'
                : 'Your request goes to the administrators, who have Sandbox design it. Nothing is built without them.'}
            </p>
          </div>
          <Textarea
            rows={2}
            value={need}
            onChange={(e) => setNeed(e.target.value)}
            placeholder="Create a supplier risk monitor"
            aria-label="Describe what you need"
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="primary" loading={busy === 'request'}>
              {isAdmin ? 'Build in Sandbox' : 'Ask for it'}
            </Button>
            <Button
              type="button" size="sm" variant="ghost"
              disabled={need.trim().length < 10}
              onClick={() => openSimeli({ question: `${need.trim()}. Use build_in_sandbox.` })}
            >
              Ask Simeli
            </Button>
          </div>
        </form>
      </Card>

      {loading ? <SkeletonRows rows={3} columns={2} /> : null}

      {!loading && !open.length ? (
        <Card>
          <EmptyState
            compact
            title="Nothing outstanding"
            description="Discovery builds evidence over time: one late delivery is not a capability gap; a pattern of them is."
          />
        </Card>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2">
        {open.map((row) => (
          <article key={row.id} className="rounded-lg border border-ink-200 bg-surface p-4">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-sm font-semibold text-fg">{row.title}</h2>
              {askedBy(row)
                ? <Badge tone="ink" className="shrink-0">Asked for</Badge>
                : <Badge tone="ink" mono className="shrink-0">{Math.round(Number(row.confidence) * 100)}% confident</Badge>}
            </div>
            <p className="mt-1 text-xs text-ink-500">{askedBy(row)?.length ? `Asked for by ${askedBy(row).join(', ')}.` : row.reason}</p>
            <p className="mt-3 text-sm text-ink-700">{row.description}</p>
            {row.requires_new_data_model ? (
              <p className="mt-2 text-xs text-ink-500">Needs data EMBMIS does not hold yet; the Studio will design it.</p>
            ) : null}
            {isAdmin ? (
              <div className="mt-4 flex gap-2">
                <Button size="sm" variant="primary" loading={busy === row.id} onClick={() => accept(row)}>Design it</Button>
                <Button size="sm" variant="ghost" disabled={busy === row.id} onClick={() => dismiss(row)}>Dismiss</Button>
              </div>
            ) : null}
          </article>
        ))}
      </div>

      {handled.length ? (
        <section>
          <h2 className="label-mono mb-2">Already handled</h2>
          <ul className="divide-y divide-ink-100 rounded-lg border border-ink-200 bg-surface">
            {handled.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                <span className="truncate text-fg">{r.title}</span>
                <StatusBadge status={r.status} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
