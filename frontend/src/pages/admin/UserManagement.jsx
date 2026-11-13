import { useMemo, useState } from 'react'
import { PlusIcon, TrashIcon, PauseIcon, PlayIcon, UserGroupIcon, ShieldCheckIcon, ClipboardIcon } from '@heroicons/react/20/solid'
import { usersAPI } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import {
  PageHeader, Button, DataTable, RowAction, StatusBadge, Badge, DateText, Segmented, ConfirmDialog, Dialog,
  Field, Input, Select, ErrorSummary, InlineNotice, useFieldValidation, notify, describeError,
} from '../../components/ui'

const ROLES = ['USER', 'MANAGER', 'ADMIN']

// What each role adds, said in terms of what the person can then do. Used in
// the role-change confirmation so the consequence is named, not implied.
const ROLE_MEANS = {
  USER: 'works in the modules the company has enabled; manager-only steps in sales, procurement and inventory are not open to them',
  MANAGER: 'can also take the manager-only steps in sales, procurement and inventory, and read the audit trail',
  ADMIN: 'can also invite and remove users, change roles, and manage modules, integrations, mailboxes and billing',
}
const RANK = { USER: 0, MANAGER: 1, ADMIN: 2 }

const KEY = ['users']
const fullName = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email

const QUICK = {
  all: { label: 'All', test: () => true },
  active: { label: 'Active', test: (u) => u.is_active },
  deactivated: { label: 'Deactivated', test: (u) => !u.is_active },
  admins: { label: 'Administrators', test: (u) => u.role === 'ADMIN' },
}

export default function UserManagement() {
  const { user: currentUser } = useAuth()
  const [quick, setQuick] = useState('all')
  const [inviteOpen, setInviteOpen] = useState(false)
  const [revealed, setRevealed] = useState(null)
  const [confirm, setConfirm] = useState(null) // { kind: 'deactivate'|'activate'|'delete'|'role', user, role? }

  const { data, loading, error, refetch } = useResource(KEY, () => usersAPI.list())
  const users = useMemo(() => (Array.isArray(data) ? data : []), [data])
  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, users.filter(q.test).length])), [users])

  const opts = { invalidates: [KEY], silent: true }
  const updateRole = useResourceMutation(({ id, role }) => usersAPI.updateRole(id, role), opts)
  const deactivate = useResourceMutation((id) => usersAPI.deactivate(id), opts)
  const activate = useResourceMutation((id) => usersAPI.activate(id), opts)
  const remove = useResourceMutation((id) => usersAPI.remove(id), opts)
  const busy = updateRole.isPending || deactivate.isPending || activate.isPending || remove.isPending

  const isSelf = (u) => u.id === currentUser?.id

  const columns = useMemo(() => [
    {
      id: 'name', header: 'Name', accessor: fullName, mobile: 'title', minWidth: 180,
      cell: (u) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium text-fg">{fullName(u)}</span>
          {u.id === currentUser?.id && <Badge tone="ink">You</Badge>}
        </span>
      ),
    },
    { id: 'email', header: 'Email', accessor: 'email', filter: 'text', mobile: 'subtitle', minWidth: 200, cell: (u) => <span className="block truncate">{u.email}</span> },
    { id: 'role', header: 'Role', accessor: 'role', filter: 'select', width: 120, mobile: 'meta', cell: (u) => <Badge tone="ink" mono>{u.role}</Badge> },
    { id: 'status', header: 'Status', accessor: (u) => (u.is_active ? 'Active' : 'Deactivated'), filter: 'select', width: 130, cell: (u) => <StatusBadge status={u.is_active ? 'ACTIVE' : 'INACTIVE'} label={u.is_active ? 'Active' : 'Deactivated'} /> },
    { id: 'lastLogin', header: 'Last sign-in', accessor: 'last_login', width: 170, mobile: 'trailing', cell: (u) => (u.last_login ? <DateText value={u.last_login} withTime /> : <span className="text-ink-500">Never</span>) },
    { id: 'created', header: 'Created', accessor: 'created_at', width: 130, cell: (u) => <DateText value={u.created_at} /> },
  ], [currentUser?.id])

  const run = async () => {
    const { kind, user: u, role } = confirm
    const name = fullName(u)
    try {
      if (kind === 'role') await updateRole.mutateAsync({ id: u.id, role })
      else if (kind === 'deactivate') await deactivate.mutateAsync(u.id)
      else if (kind === 'activate') await activate.mutateAsync(u.id)
      else await remove.mutateAsync(u.id)
      setConfirm(null)
      // Deleting removes the row, so the outcome is no longer on screen.
      if (kind === 'delete') notify.success(`${name} deleted`)
    } catch (e) {
      setConfirm(null)
      notify.error(`Not done for ${name} — ${describeError(e).message}`)
    }
  }

  const copy = confirm && (() => {
    const u = confirm.user
    const name = fullName(u)
    if (confirm.kind === 'role') {
      const up = RANK[confirm.role] > RANK[u.role]
      return {
        title: `Make ${name} ${confirm.role === 'ADMIN' ? 'an administrator' : confirm.role === 'MANAGER' ? 'a manager' : 'a user'}?`,
        consequence: up
          ? `As ${confirm.role}, ${name} ${ROLE_MEANS[confirm.role]}.`
          : `${name} drops from ${u.role} to ${confirm.role} and loses what ${u.role} allowed: they ${ROLE_MEANS[u.role].replace(/^can also /, 'could ')}.`,
        reversible: true,
        label: `Change role to ${confirm.role}`,
        tone: up && confirm.role === 'ADMIN' ? 'danger' : 'primary',
      }
    }
    if (confirm.kind === 'deactivate') {
      return { title: `Deactivate ${name}?`, consequence: `${name} can no longer sign in. Their records, approvals and history stay as they are. You can reactivate them later.`, reversible: true, label: `Deactivate ${name}`, tone: 'danger' }
    }
    if (confirm.kind === 'activate') {
      return { title: `Reactivate ${name}?`, consequence: `${name} can sign in again with their existing password and role (${u.role}).`, reversible: true, label: `Reactivate ${name}`, tone: 'primary' }
    }
    return { title: `Delete ${name}?`, consequence: `${name} will no longer be able to sign in, and the account is removed from this list. Deactivate instead if you may need them back.`, reversible: false, label: `Delete ${name}`, tone: 'danger', confirmText: u.email }
  })()

  return (
    <>
      <PageHeader
        title="Users"
        description="Invite users, change roles, and deactivate accounts."
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setInviteOpen(true)} kbd="N">Invite user</Button>}
      />

      <DataTable
        viewKey="admin.users"
        caption="Users"
        noun="user"
        rows={users}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'name', dir: 'asc' }}
        searchPlaceholder="Search name or email"
        rowClassName={(u) => (u.is_active ? undefined : 'text-ink-500')}
        toolbarStart={
          <Segmented
            label="Show"
            value={quick}
            onChange={setQuick}
            options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))}
            className="max-w-full overflow-x-auto"
          />
        }
        rowActions={(u) => {
          const self = isSelf(u)
          return (
            <>
              <RowAction icon={ShieldCheckIcon} label={`Change role of ${fullName(u)}`} disabled={self} reason="You cannot change your own role" onClick={() => setConfirm({ kind: 'pick-role', user: u })} />
              {u.is_active
                ? <RowAction icon={PauseIcon} tone="risk" label={`Deactivate ${fullName(u)}`} disabled={self} reason="You cannot deactivate your own account" onClick={() => setConfirm({ kind: 'deactivate', user: u })} />
                : <RowAction icon={PlayIcon} label={`Reactivate ${fullName(u)}`} onClick={() => setConfirm({ kind: 'activate', user: u })} />}
              <RowAction icon={TrashIcon} tone="risk" label={`Delete ${fullName(u)}`} disabled={self} reason="You cannot delete your own account" onClick={() => setConfirm({ kind: 'delete', user: u })} />
            </>
          )
        }}
        empty={{
          icon: UserGroupIcon,
          title: 'No users yet',
          description: 'Invite the people who will work in EMBMIS. Each gets a temporary password by email.',
          action: <Button variant="primary" icon={PlusIcon} onClick={() => setInviteOpen(true)}>Invite user</Button>,
        }}
      />

      {confirm?.kind === 'pick-role' && (
        <RoleDialog user={confirm.user} onClose={() => setConfirm(null)} onPick={(role) => setConfirm({ kind: 'role', user: confirm.user, role })} />
      )}

      {copy && confirm.kind !== 'pick-role' && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={run}
          title={copy.title}
          consequence={copy.consequence}
          reversible={copy.reversible}
          confirmLabel={copy.label}
          tone={copy.tone}
          confirmText={copy.confirmText}
          busy={busy}
        />
      )}

      {inviteOpen && (
        <InviteDialog
          onClose={() => setInviteOpen(false)}
          onInvited={(result) => { setInviteOpen(false); if (!result.emailSent) setRevealed(result) }}
        />
      )}

      {revealed && <TempPasswordDialog data={revealed} onClose={() => setRevealed(null)} />}
    </>
  )
}

function RoleDialog({ user, onClose, onPick }) {
  const [role, setRole] = useState(user.role)
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Change role of ${fullName(user)}`}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={role === user.role} onClick={() => onPick(role)}>Continue</Button>
        </>
      }
    >
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm text-ink-700">Currently <span className="font-mono text-xs">{user.role}</span>. You confirm the change on the next step.</legend>
        {ROLES.map((r) => (
          <label key={r} aria-label={r} className={`flex cursor-pointer items-start gap-2 rounded-md border p-2.5 ${role === r ? 'border-ink-900 bg-sunken' : 'border-ink-200 hover:bg-ink-50'}`}>
            <input type="radio" name="role" className="mt-0.5" checked={role === r} onChange={() => setRole(r)} />
            <span>
              <span className="block font-mono text-xs font-medium text-fg">{r}</span>
              <span className="block text-xs text-ink-600">{ROLE_MEANS[r].replace(/^can also /, 'Also ').replace(/^works/, 'Works')}.</span>
            </span>
          </label>
        ))}
      </fieldset>
    </Dialog>
  )
}

const INVITE_RULES = {
  first_name: (v) => (!String(v || '').trim() ? 'Enter their first name.' : null),
  last_name: (v) => (!String(v || '').trim() ? 'Enter their last name.' : null),
  email: (v) => (!String(v || '').trim() ? 'Enter an email address.' : !/^\S+@\S+\.\S+$/.test(String(v).trim()) ? 'Enter a full email address, like name@company.com.' : null),
}

function InviteDialog({ onClose, onInvited }) {
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', role: 'USER' })
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState(null)
  const { errors, onBlur, validateAll } = useFieldValidation(form, INVITE_RULES)
  const invite = useResourceMutation((payload) => usersAPI.invite(payload).then((res) => {
    // The temporary password sits beside `data`, not in it — keep it.
    const body = res?.data || {}
    return { data: { success: body.success, data: { ...(body.data || {}), tempPassword: body.tempPassword } } }
  }), { invalidates: [KEY], silent: true })
  const set = (patch) => setForm((f) => ({ ...f, ...patch }))

  const save = async () => {
    setSubmitted(true)
    if (Object.keys(validateAll()).length) return
    setServerError(null)
    try {
      const result = await invite.mutateAsync({
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
        email: form.email.trim(),
        role: form.role,
      })
      notify.success(result?.emailSent ? `Invitation sent to ${form.email.trim()}` : `${form.first_name.trim()} ${form.last_name.trim()} created`)
      onInvited(result || {})
    } catch (e) {
      setServerError(describeError(e).message)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Invite user"
      footer={
        <>
          <Button onClick={onClose} disabled={invite.isPending}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={invite.isPending}>Send invite</Button>
        </>
      }
    >
      <div className="space-y-4">
        {submitted && <ErrorSummary errors={Object.fromEntries(Object.entries(errors).map(([k, v]) => [`invite-${k}`, v]))} />}
        {serverError && <InlineNotice tone="risk" title="Not invited">{serverError}</InlineNotice>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="First name" required id="invite-first_name" error={errors.first_name}>
            <Input value={form.first_name} onBlur={onBlur('first_name')} onChange={(e) => set({ first_name: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="Last name" required id="invite-last_name" error={errors.last_name}>
            <Input value={form.last_name} onBlur={onBlur('last_name')} onChange={(e) => set({ last_name: e.target.value })} autoComplete="off" />
          </Field>
        </div>
        <Field label="Email" required id="invite-email" error={errors.email}>
          <Input type="email" value={form.email} onBlur={onBlur('email')} onChange={(e) => set({ email: e.target.value })} placeholder="name@company.com" autoComplete="off" />
        </Field>
        <Field label="Role" help={`${form.role}: ${ROLE_MEANS[form.role].replace(/^can also /, 'also ')}.`}>
          <Select value={form.role} onChange={(e) => set({ role: e.target.value })}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
        </Field>
        <p className="text-xs text-ink-500">A temporary password is generated and emailed to them. They should change it after signing in.</p>
      </div>
    </Dialog>
  )
}

// Shown only when the invitation email could not be delivered — the admin
// still needs a way to hand the account over.
function TempPasswordDialog({ data, onClose }) {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.tempPassword)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopyFailed(true)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={false}
      title="The invitation email could not be sent"
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}
    >
      <div className="space-y-3">
        <p className="text-sm text-ink-800">
          Share this temporary password with {data.user?.email || 'them'} directly — it will not be shown again.
        </p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 select-all break-all rounded-md border border-ink-200 bg-sunken px-3 py-2 font-mono text-sm">{data.tempPassword || '(not returned)'}</code>
          <Button icon={ClipboardIcon} onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
        </div>
        {copyFailed && <p className="text-xs text-risk-600">Could not copy — select the value and copy it manually.</p>}
      </div>
    </Dialog>
  )
}
