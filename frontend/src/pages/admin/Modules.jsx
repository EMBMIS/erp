import { useState } from 'react'
import { LockClosedIcon } from '@heroicons/react/20/solid'
import { companyModulesAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { PageHeader, Card, Switch, ErrorState, SkeletonRows, ConfirmDialog, notify, describeError } from '../../components/ui'

/**
 * Modules — which feature areas this company uses. Disabled modules are
 * hidden from navigation and unavailable to the AI assistant; core modules
 * cannot be turned off.
 */

const KEY = ['company-modules']

export default function Modules() {
  const { data, loading, error, refetch } = useResource(KEY, () => companyModulesAPI.list())
  const modules = Array.isArray(data) ? data : []
  // Optimistic overlay: the switch moves at once, and snaps back with the
  // reason if the server refuses.
  const [pending, setPending] = useState({})
  const [confirm, setConfirm] = useState(null)

  const setEnabled = useResourceMutation(({ key, enabled }) => companyModulesAPI.setEnabled(key, enabled), { invalidates: [KEY], silent: true })

  const apply = async (mod, enabled) => {
    setPending((p) => ({ ...p, [mod.key]: enabled }))
    try {
      await setEnabled.mutateAsync({ key: mod.key, enabled })
    } catch (e) {
      notify.error(`${mod.name} was not ${enabled ? 'enabled' : 'disabled'} — ${describeError(e).message}`)
    } finally {
      setPending((p) => { const { [mod.key]: _drop, ...rest } = p; return rest })
    }
  }

  const toggle = (mod) => {
    if (mod.is_core) return
    const current = mod.key in pending ? pending[mod.key] : mod.enabled
    // Turning a module off takes it away from everyone at once, so it is
    // confirmed; turning one on is not.
    if (current) setConfirm(mod)
    else apply(mod, true)
  }

  const core = modules.filter((m) => m.is_core)
  const optional = modules.filter((m) => !m.is_core)

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title="Modules"
        description="Turn feature areas on or off. Disabled modules are hidden from navigation and unavailable to the AI assistant."
      />

      {loading ? (
        <Card padded={false}><SkeletonRows rows={8} columns={2} /></Card>
      ) : error ? (
        <ErrorState what="Modules" error={error} onRetry={refetch} />
      ) : (
        <>
          <Card title="Optional" description="Defaulted from your business type at signup — add or remove any of these at any time." padded={false}>
            <ul className="divide-y divide-ink-100">
              {optional.map((m) => (
                <ModuleRow key={m.key} mod={m} enabled={m.key in pending ? pending[m.key] : m.enabled} busy={m.key in pending} onToggle={() => toggle(m)} />
              ))}
            </ul>
          </Card>
          <Card title="Always on" description="Every company has these — they can't be turned off." padded={false}>
            <ul className="divide-y divide-ink-100">
              {core.map((m) => <ModuleRow key={m.key} mod={m} enabled locked />)}
            </ul>
          </Card>
        </>
      )}

      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={() => { const m = confirm; setConfirm(null); apply(m, false) }}
          title={`Disable ${confirm.name}?`}
          consequence={`${confirm.name} disappears from navigation for everyone in the company, and the AI assistant stops using it.`}
          reversible
          confirmLabel={`Disable ${confirm.name}`}
        />
      )}
    </div>
  )
}

function ModuleRow({ mod, enabled, locked, busy, onToggle }) {
  return (
    <li className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-medium text-fg">
          {mod.name}
          {locked && <LockClosedIcon className="h-3.5 w-3.5 text-ink-400" aria-label="Always enabled" />}
        </p>
        {mod.description && <p className="mt-0.5 text-xs text-ink-500">{mod.description}</p>}
      </div>
      <Switch checked={enabled} disabled={locked || busy} onChange={onToggle} label={<span className="sr-only">{mod.name}</span>} />
    </li>
  )
}
