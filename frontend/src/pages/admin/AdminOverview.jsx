import { Link } from 'react-router-dom'
import { ChevronRightIcon } from '@heroicons/react/20/solid'
import api, { usersAPI, apiKeysAPI, webhooksAPI } from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { PageHeader, Button, Card, Stat, Num, formatNumber } from '../../components/ui'

/**
 * Administration — the four numbers an administrator checks, and the way into
 * each admin area. A count that did not load shows "—" with the reason, never
 * a zero: "0 users" and "could not read users" are different facts.
 */

const list = (q) => (Array.isArray(q.data) ? q.data : null)

const reasonFor = (q) => {
  if (!q.error) return undefined
  const status = q.error?.response?.status
  return status === 403 ? 'Not available for your role.' : 'Did not load.'
}

const AREAS = [
  { name: 'Users', description: 'Invite people, change roles, deactivate accounts.', href: '/admin/users' },
  { name: 'Modules', description: 'Turn feature areas on or off for the company.', href: '/admin/modules' },
  { name: 'Integrations', description: 'API keys and webhook subscriptions.', href: '/admin/integrations' },
  { name: 'AI Gateway', description: 'Every AI action is checked by EMBMIS Gateway before it happens. Connection, fail mode and decisions.', href: '/admin/gateway' },
  { name: 'Mailboxes', description: 'Company @embmis.com addresses and their quota.', href: '/admin/mailboxes' },
  { name: 'Mail design', description: 'The branded template every mailbox sends through.', href: '/admin/mail-design' },
  { name: 'Audit trail', description: 'Every status change across the system.', href: '/admin/audit-trail' },
  { name: 'Application statistics', description: 'Instance-wide metrics. Platform owner only.', href: '/admin/statistics' },
]

export default function AdminOverview() {
  const opts = { retry: false }
  const users = useResource(['users'], () => usersAPI.list(), opts)
  const keysQ = useResource(['api-keys'], () => apiKeysAPI.list(), opts)
  const hooks = useResource(['webhooks'], () => webhooksAPI.list(), opts)
  const modules = useResource(['company-modules'], () => api.get('/company-modules'), opts)

  const userList = list(users)
  const mods = list(modules)
  const active = userList ? userList.filter((u) => u.is_active).length : null

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Administration"
        description="Users, access, billing and integrations."
        primary={<Button variant="primary" to="/admin/users">Manage users</Button>}
      />

      <section aria-label="At a glance" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Users" value={<Num value={userList?.length} />} loading={users.loading} reason={reasonFor(users) || (active != null ? `${formatNumber(active)} active` : undefined)} to="/admin/users" />
        <Stat label="API keys" value={<Num value={list(keysQ)?.length} />} loading={keysQ.loading} reason={reasonFor(keysQ)} to="/admin/integrations" />
        <Stat label="Webhooks" value={<Num value={list(hooks)?.length} />} loading={hooks.loading} reason={reasonFor(hooks)} to="/admin/integrations" />
        <Stat
          label="Modules enabled"
          value={mods ? `${formatNumber(mods.filter((m) => m.enabled).length)} of ${formatNumber(mods.length)}` : '—'}
          loading={modules.loading}
          reason={reasonFor(modules)}
          to="/admin/modules"
        />
      </section>

      <Card title="Administration areas" padded={false}>
        <ul className="divide-y divide-ink-100">
          {AREAS.map((a) => (
            <li key={a.href}>
              <Link to={a.href} className="flex items-center gap-3 px-4 py-3 hover:bg-ink-50">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-fg">{a.name}</span>
                  <span className="block truncate text-xs text-ink-500">{a.description}</span>
                </span>
                <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
