import { useMemo, useState } from 'react'
import { PlusIcon, EnvelopeIcon } from '@heroicons/react/20/solid'
import { mailboxesAPI, usersAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { PageHeader, Button, DataTable, StatusBadge, Code, Dialog, Field, Select, InlineNotice, notify, describeError } from '../../components/ui'

const KEY = ['mailboxes']
const mb = (n) => (n == null || n === '' || !Number.isFinite(Number(n)) ? null : Number(n) / (1024 * 1024))
const fmtMb = (n) => (mb(n) == null ? '—' : `${mb(n).toFixed(1)} MB`)

export default function Mailboxes() {
  const [createOpen, setCreateOpen] = useState(false)
  const { data, loading, error, refetch } = useResource(KEY, () => mailboxesAPI.list())
  const users = useResource(['users'], () => usersAPI.list())
  const mailboxes = useMemo(() => (Array.isArray(data) ? data : []), [data])
  const userList = Array.isArray(users.data) ? users.data : []
  const usersWithoutMailbox = userList.filter((u) => !mailboxes.some((m) => m.user_id === u.id))

  const columns = useMemo(() => [
    { id: 'address', header: 'Address', accessor: 'address', mobile: 'title', minWidth: 240, cell: (m) => <Code className="text-fg">{m.address}</Code> },
    {
      id: 'owner', header: 'Owner', accessor: (m) => (m.user_id ? `${m.first_name || ''} ${m.last_name || ''}`.trim() || m.user_email : 'Company mailbox'),
      filter: 'text', mobile: 'subtitle', minWidth: 160,
    },
    {
      id: 'usage', header: 'Used', accessor: (m) => (Number(m.quota_bytes) ? Number(m.used_bytes) / Number(m.quota_bytes) : null), align: 'right', width: 220, mobile: 'trailing',
      exportValue: (m) => `${fmtMb(m.used_bytes)} / ${fmtMb(m.quota_bytes)}`,
      cell: (m) => {
        const pct = Number(m.quota_bytes) ? Math.min(100, Math.round((Number(m.used_bytes) / Number(m.quota_bytes)) * 100)) : null
        return (
          <span className="flex items-center justify-end gap-2">
            {pct != null && (
              <span className="hidden h-1.5 w-16 overflow-hidden rounded-sm bg-ink-100 sm:block" aria-hidden="true">
                <span className={`block h-full ${pct >= 90 ? 'bg-risk-500' : pct >= 70 ? 'bg-warn-500' : 'bg-ink-600'}`} style={{ width: `${pct}%` }} />
              </span>
            )}
            <span className="whitespace-nowrap tabular-nums">{fmtMb(m.used_bytes)} <span className="text-ink-500">of {fmtMb(m.quota_bytes)}</span></span>
          </span>
        )
      },
    },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 120, mobile: 'meta', cell: (m) => <StatusBadge status={m.status} /> },
  ], [])

  return (
    <>
      <PageHeader
        title="Mailboxes"
        description="Your company's @embmis.com addresses — 50 MB each."
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setCreateOpen(true)}>Create user mailbox</Button>}
      />
      <DataTable
        viewKey="admin.mailboxes"
        caption="Mailboxes"
        noun="mailbox"
        rows={mailboxes}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        defaultSort={{ id: 'address', dir: 'asc' }}
        searchPlaceholder="Search address or owner"
        empty={{
          icon: EnvelopeIcon,
          title: 'No mailboxes yet',
          description: 'Give a user an @embmis.com address so they can send and receive mail inside EMBMIS.',
          action: <Button variant="primary" icon={PlusIcon} onClick={() => setCreateOpen(true)}>Create user mailbox</Button>,
        }}
      />
      {createOpen && <CreateMailboxDialog users={usersWithoutMailbox} usersLoading={users.loading} usersError={users.error} onClose={() => setCreateOpen(false)} />}
    </>
  )
}

function CreateMailboxDialog({ users, usersLoading, usersError, onClose }) {
  const [userId, setUserId] = useState('')
  const [serverError, setServerError] = useState(null)
  const create = useResourceMutation((id) => mailboxesAPI.createForUser(id), { invalidates: [KEY], silent: true })

  const save = async () => {
    if (!userId) return
    setServerError(null)
    try {
      await create.mutateAsync(userId)
      notify.success('Mailbox created')
      onClose()
    } catch (e) {
      setServerError(describeError(e).message)
    }
  }

  const none = !usersLoading && !usersError && users.length === 0

  return (
    <Dialog
      open
      onClose={onClose}
      title="Create user mailbox"
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>{none ? 'Close' : 'Cancel'}</Button>
          {!none && <Button variant="primary" onClick={save} disabled={!userId} loading={create.isPending}>Create mailbox</Button>}
        </>
      }
    >
      <div className="space-y-3">
        {serverError && <InlineNotice tone="risk" title="Not created">{serverError}</InlineNotice>}
        {usersError && <InlineNotice tone="risk" title="The user list did not load">{describeError(usersError).message}</InlineNotice>}
        {none ? (
          <p className="text-sm text-ink-700">Every user in this company already has a mailbox.</p>
        ) : (
          <Field label="User" required help="The address is made from their name and your company.">
            <Select value={userId} onChange={(e) => setUserId(e.target.value)} disabled={usersLoading}>
              <option value="">{usersLoading ? 'Loading users…' : 'Select a user…'}</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.first_name} {u.last_name} ({u.email})</option>)}
            </Select>
          </Field>
        )}
      </div>
    </Dialog>
  )
}
