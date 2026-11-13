import clsx from 'clsx'
import { ShieldCheckIcon, ShieldExclamationIcon } from '@heroicons/react/20/solid'

/**
 * EMBMIS Gateway, as it shows up next to Simeli.
 *
 * Every action an AI takes is checked by EMBMIS Gateway before it happens. These two pieces say so
 * where the person is looking, and only ever from numbers the server counted:
 *
 *   GatewayLine    "Checked by EMBMIS Gateway: 3 allowed, 1 sent to you"
 *   GatewayReason  on a proposal the gateway sent to the person: why
 *
 * Nothing renders when the gateway is off (all counts zero / no stats).
 */

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

function gatewayTotal(stats) {
  if (!stats) return 0
  return (stats.allowed || 0) + (stats.blocked || 0) + (stats.escalated || 0)
}

export function GatewayLine({ stats, className }) {
  if (!stats || gatewayTotal(stats) === 0) return null
  const { allowed = 0, blocked = 0, escalated = 0, unchecked = 0 } = stats
  const parts = []
  parts.push(<span key="a">{allowed} allowed</span>)
  parts.push(<span key="e" className={escalated ? 'text-warn-700' : undefined}>{escalated} sent to you</span>)
  if (blocked) parts.push(<span key="b" className="text-risk-700">{blocked} blocked</span>)
  return (
    <p className={clsx('flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs text-ink-600', className)} data-testid="gateway-line">
      <ShieldCheckIcon className="h-3.5 w-3.5 shrink-0 text-ink-400" aria-hidden="true" />
      <span className="label-mono">Checked by EMBMIS Gateway:</span>
      {parts.map((p, i) => <span key={p.key}>{i > 0 && ', '}{p}</span>)}
      {unchecked > 0 && (
        <span className="text-warn-700" title="The gateway could not be reached for these. Reads continued; changes waited for you or ran, depending on the fail mode.">
          ({plural(unchecked, 'check', 'checks')} not made: gateway unreachable)
        </span>
      )}
    </p>
  )
}

export function GatewayReason({ gateway, className }) {
  if (!gateway || gateway.decision !== 'escalate') return null
  const unreachable = gateway.origin === 'fallback'
  return (
    <p className={clsx('flex items-start gap-1.5 text-xs text-warn-700', className)} data-testid="gateway-reason">
      <ShieldExclamationIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>
        <span className="label-mono">{unreachable ? 'Gateway unreachable' : 'Sent to you by EMBMIS Gateway'}</span>
        {' · '}{gateway.reason || 'This needs a person to decide.'}
      </span>
    </p>
  )
}
