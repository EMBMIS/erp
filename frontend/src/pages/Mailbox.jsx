import React, { useState, useEffect, useRef } from 'react'
import toast from 'react-hot-toast'
import { mailboxesAPI } from '../services/api'
import { useResource } from '../hooks/useResource'
import { PageHeader, Button } from '../components/ui'
import Module, { ModuleEmpty } from '../components/bos/Module'
import {
  EnvelopeIcon, PaperAirplaneIcon, XMarkIcon, PaperClipIcon, InboxIcon,
  ArrowUturnLeftIcon, ArrowUturnRightIcon, ArrowRightCircleIcon, TrashIcon,
  StarIcon as StarOutlineIcon, MagnifyingGlassIcon, EnvelopeOpenIcon,
  DocumentTextIcon, ArchiveBoxIcon, ChevronDownIcon, ChevronRightIcon,
} from '@heroicons/react/24/outline'
import { StarIcon as StarSolidIcon } from '@heroicons/react/24/solid'

const fmtBytes = (n) => `${(Number(n || 0) / (1024 * 1024)).toFixed(1)} MB`
const fmtDate = (d) => new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const addrList = (v) => (Array.isArray(v) ? v : (v ? [v] : []))

// Same grouping an Outlook account shows: a short "Favorites" shortcut list
// up top, then every folder in the account below it. Two entries pointing at
// the same folder value is deliberate — Favorites is a shortcut list, not a
// separate place mail lives.
const FAVORITE_FOLDERS = ['INBOX', 'SENT', 'DRAFTS']
const FOLDERS = [
  { value: 'INBOX', label: 'Inbox', icon: InboxIcon },
  { value: 'DRAFTS', label: 'Drafts', icon: DocumentTextIcon },
  { value: 'SENT', label: 'Sent Items', icon: PaperAirplaneIcon },
  { value: 'ARCHIVE', label: 'Archive', icon: ArchiveBoxIcon },
  { value: 'TRASH', label: 'Deleted Items', icon: TrashIcon },
]

// Compose starts empty; Reply/Reply All/Forward carry the original message
// as a separate `quoted` block rather than pre-filling the editable text —
// see the "Gmail-style collapsed quote" block in openCompose below.
const emptyForm = () => ({
  to: '', cc: '', bcc: '', subject: '', text: '', inReplyTo: null, draftId: null, quoted: null, files: [],
})

export default function Mailbox() {
  const [mailbox, setMailbox] = useState(undefined) // undefined = loading, null = none
  const [folder, setFolder] = useState('INBOX')
  const [starredOnly, setStarredOnly] = useState(false)
  const [query, setQuery] = useState('')
  const [messages, setMessages] = useState([])
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [selected, setSelected] = useState(null)
  const [composeOpen, setComposeOpen] = useState(false)
  // The message body takes focus when the composer opens (no autoFocus prop:
  // it would also steal focus on every re-render that remounts the field).
  const composeBodyRef = useRef(null)
  useEffect(() => { if (composeOpen) composeBodyRef.current?.focus() }, [composeOpen])
  const [showCcBcc, setShowCcBcc] = useState(false)
  const [sending, setSending] = useState(false)
  const [form, setForm] = useState(emptyForm())
  const [quoteOpen, setQuoteOpen] = useState(false) // collapsed vs. expanded original message under the compose box
  const [savingDraft, setSavingDraft] = useState(false)
  const [imageUrls, setImageUrls] = useState({}) // attachment id -> blob: URL, for the currently open message only
  const fileInputRef = useRef(null)

  const mine = useResource(['mailbox', 'mine'], () => mailboxesAPI.mine())
  useEffect(() => {
    if (mine.loading) return
    if (mine.error) {
      toast.error(typeof mine.error === 'string' ? mine.error : mine.error?.message || 'Failed to load your mailbox')
      setMailbox(null)
    } else {
      setMailbox(mine.data || null)
    }
  }, [mine.loading, mine.data, mine.error])

  const loadMessages = async (f = folder, opts = {}) => {
    if (!mailbox) return
    setLoadingMessages(true)
    setSelected(null)
    try {
      const res = await mailboxesAPI.messages(mailbox.id, f, opts)
      setMessages(res.data?.data || [])
      if (res.data?.mailbox) setMailbox((m) => ({ ...m, ...res.data.mailbox }))
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load messages')
    } finally {
      setLoadingMessages(false)
    }
  }

  // Debounced so a search or star-filter change doesn't fire one request per
  // keystroke/click, same rationale as the AI chat's conversation search.
  useEffect(() => {
    if (!mailbox) return undefined
    const opts = {}
    if (starredOnly) opts.starred = 1
    if (query.trim()) opts.q = query.trim()
    const timer = setTimeout(() => loadMessages(folder, opts), query.trim() ? 250 : 0)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mailbox?.id, folder, starredOnly, query])

  const openMessage = async (id) => {
    try {
      const res = await mailboxesAPI.message(mailbox.id, id)
      const msg = res.data?.data
      setSelected(msg)
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, is_read: true } : m)))

      // Previous message's blob: URLs are done with — an <img src> download
      // needs the Authorization header the api client sends, which a plain
      // <img src="/api/..."> can never carry, so every image (inline cid:
      // references AND ordinary image attachments) is fetched as a blob and
      // shown via an object URL instead of a direct URL to the endpoint.
      setImageUrls((prev) => {
        Object.values(prev).forEach((u) => URL.revokeObjectURL(u))
        return {}
      })
      const images = (msg?.attachments || []).filter((a) => (a.content_type || '').startsWith('image/'))
      const entries = await Promise.all(images.map(async (a) => {
        try {
          const blobRes = await mailboxesAPI.downloadAttachment(mailbox.id, id, a.id)
          return [a.id, URL.createObjectURL(blobRes.data)]
        } catch {
          return null
        }
      }))
      setImageUrls(Object.fromEntries(entries.filter(Boolean)))
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to open message')
    }
  }

  // cid:<content-id> inside body_html is how a mail client embeds an inline
  // image (a pasted screenshot, a signature logo) — it means nothing to a
  // browser on its own. Swap each one for the matching attachment's blob:
  // URL before the HTML is ever handed to dangerouslySetInnerHTML.
  const resolveInlineImages = (html, attachments) => {
    if (!html) return html
    return html.replace(/cid:([^"'\s)]+)/g, (match, cid) => {
      const att = (attachments || []).find((a) => a.content_id === cid)
      return att && imageUrls[att.id] ? imageUrls[att.id] : match
    })
  }

  const downloadAttachment = async (att) => {
    try {
      const res = await mailboxesAPI.downloadAttachment(mailbox.id, selected.id, att.id)
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url
      a.download = att.filename
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      toast.error('Failed to download attachment')
    }
  }

  const toggleStar = async (msg, e) => {
    e?.stopPropagation()
    const next = !msg.is_starred
    setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, is_starred: next } : m)))
    if (selected?.id === msg.id) setSelected((s) => ({ ...s, is_starred: next }))
    try {
      await mailboxesAPI.update(mailbox.id, msg.id, { is_starred: next })
    } catch {
      toast.error('Could not update star')
      loadMessages()
    }
  }

  const toggleRead = async (msg, e) => {
    e?.stopPropagation()
    const next = !msg.is_read
    setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, is_read: next } : m)))
    try {
      await mailboxesAPI.update(mailbox.id, msg.id, { is_read: next })
    } catch {
      toast.error('Could not update read state')
      loadMessages()
    }
  }

  // Trash is a two-step delete, same as any mail client: the first delete
  // moves it to Trash (recoverable); deleting again from Trash is permanent
  // and the backend frees the quota it held.
  const deleteMessage = async (msg, e) => {
    e?.stopPropagation()
    const permanent = folder === 'TRASH'
    if (permanent && !window.confirm('Delete this message permanently? This cannot be undone.')) return
    try {
      await mailboxesAPI.remove(mailbox.id, msg.id)
      toast.success(permanent ? 'Deleted permanently' : 'Moved to Trash')
      setMessages((prev) => prev.filter((m) => m.id !== msg.id))
      if (selected?.id === msg.id) setSelected(null)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to delete message')
    }
  }

  // Gmail-style quoting: the original message is never dropped into the
  // editable textarea. It sits collapsed under a "···" bar (quoteOpen) and
  // only gets appended to what was actually typed at send time — so a reply
  // opens with an empty, focused box instead of a screen you have to scroll
  // past a wall of ">"-quoted text to reach.
  const quoteFor = (msg) => ({
    header: `On ${new Date(msg.created_at).toLocaleString()}, ${msg.from_address} wrote:`,
    text: msg.body_text || '(no text body)',
  })

  const openCompose = (mode, msg) => {
    setShowCcBcc(false)
    setQuoteOpen(false)
    if (!mode) {
      setForm(emptyForm())
    } else if (mode === 'forward') {
      setForm({
        ...emptyForm(),
        subject: msg.subject?.toLowerCase().startsWith('fwd:') ? msg.subject : `Fwd: ${msg.subject || '(no subject)'}`,
        inReplyTo: msg.id,
        quoted: quoteFor(msg),
      })
    } else {
      // reply | reply-all — Reply All keeps everyone else on the thread:
      // the original To recipients move to Cc (they weren't the ones being
      // replied to), the original Cc stays Cc, and this mailbox's own
      // address is dropped from both since replying to yourself is noise.
      const self = mailbox.address.toLowerCase()
      const notSelf = (a) => a.toLowerCase() !== self
      const replyAll = mode === 'reply-all'
      const cc = replyAll
        ? [...addrList(msg.to_addresses), ...addrList(msg.cc_addresses)].filter(notSelf)
        : []
      setForm({
        ...emptyForm(),
        to: msg.from_address,
        cc: cc.join(', '),
        subject: msg.subject?.toLowerCase().startsWith('re:') ? msg.subject : `Re: ${msg.subject || '(no subject)'}`,
        inReplyTo: msg.id,
        quoted: quoteFor(msg),
      })
      if (cc.length) setShowCcBcc(true)
    }
    setComposeOpen(true)
  }

  // A draft in the Drafts folder opens straight into Compose, pre-filled —
  // clicking a draft in a real mail client edits it, it doesn't "read" it.
  // Attachments on the original draft aren't carried back in as re-attachable
  // files (there's no round-trip from stored bytes back to a File object);
  // the rest of the draft's content is.
  const openDraft = async (msg) => {
    try {
      const res = await mailboxesAPI.message(mailbox.id, msg.id)
      const full = res.data?.data
      setShowCcBcc(!!(full.cc_addresses?.length || full.bcc_addresses?.length))
      setQuoteOpen(false)
      setForm({
        to: addrList(full.to_addresses).join(', '),
        cc: addrList(full.cc_addresses).join(', '),
        bcc: addrList(full.bcc_addresses).join(', '),
        subject: full.subject || '',
        text: full.body_text || '',
        inReplyTo: full.in_reply_to_id || null,
        draftId: full.id,
        quoted: null,
        files: [],
      })
      setComposeOpen(true)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to open draft')
    }
  }

  const addFiles = (fileList) => {
    const files = Array.from(fileList || [])
    if (!files.length) return
    setForm((f) => ({ ...f, files: [...f.files, ...files] }))
  }

  const removeFile = (idx) => {
    setForm((f) => ({ ...f, files: f.files.filter((_, i) => i !== idx) }))
  }

  // A draft this compose was opened from is done once it's replaced — a new
  // Send creates a fresh SENT row, a re-Save creates a fresh DRAFTS row, and
  // either way the old draft would just sit there duplicated forever
  // otherwise. Two DELETE calls because the endpoint is deliberately a
  // two-step trash-then-permanent (see routes/mailboxes.js) with no bypass;
  // a draft doesn't need to be recoverable from Trash the way real mail does.
  const discardDraft = async (draftId) => {
    try {
      await mailboxesAPI.remove(mailbox.id, draftId)
      await mailboxesAPI.remove(mailbox.id, draftId)
    } catch {
      // Best-effort cleanup — the new draft/sent copy already exists either
      // way, so a leftover stale draft is a minor annoyance, not data loss.
    }
  }

  const buildFormData = () => {
    const fd = new FormData()
    if (form.to) fd.append('to', form.to)
    if (form.cc) fd.append('cc', form.cc)
    if (form.bcc) fd.append('bcc', form.bcc)
    fd.append('subject', form.subject)
    // The quote is appended here, at send/save time, exactly once — not kept
    // in form.text, which is what keeps it out of the editable box.
    const text = form.quoted ? `${form.text}\n\n${form.quoted.header}\n${form.quoted.text.split('\n').map((l) => `> ${l}`).join('\n')}` : form.text
    fd.append('text', text)
    if (form.inReplyTo) fd.append('inReplyTo', form.inReplyTo)
    form.files.forEach((file) => fd.append('attachments', file))
    return fd
  }

  const send = async () => {
    if (!form.to || !form.subject) return
    setSending(true)
    try {
      await mailboxesAPI.send(mailbox.id, buildFormData())
      if (form.draftId) await discardDraft(form.draftId)
      toast.success('Sent')
      setComposeOpen(false)
      setForm(emptyForm())
      if (folder === 'SENT' || folder === 'DRAFTS') loadMessages(folder)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not send message')
    } finally {
      setSending(false)
    }
  }

  const saveDraft = async () => {
    setSavingDraft(true)
    try {
      await mailboxesAPI.saveDraft(mailbox.id, buildFormData())
      if (form.draftId) await discardDraft(form.draftId)
      toast.success('Draft saved')
      setComposeOpen(false)
      setForm(emptyForm())
      if (folder === 'DRAFTS') loadMessages('DRAFTS')
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not save draft')
    } finally {
      setSavingDraft(false)
    }
  }

  const archiveMessage = async (msg, e) => {
    e?.stopPropagation()
    try {
      await mailboxesAPI.update(mailbox.id, msg.id, { folder: 'ARCHIVE' })
      toast.success('Archived')
      setMessages((prev) => prev.filter((m) => m.id !== msg.id))
      if (selected?.id === msg.id) setSelected(null)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to archive message')
    }
  }

  if (mailbox === undefined) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <p className="bos-caption">Loading…</p>
      </div>
    )
  }

  if (mailbox === null) {
    return (
      <Module accent="cyan" className="mx-auto max-w-lg text-center">
        <span className="bos-plate bos-plate--lg mx-auto mb-3.5 flex">
          <EnvelopeIcon className="h-5 w-5" />
        </span>
        <h1 className="text-[15px] font-semibold bos-text-strong">You don't have a mailbox yet</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed bos-text-muted">
          Ask your company admin to create one for you under Admin &gt; Mailboxes.
        </p>
      </Module>
    )
  }

  const pct = Math.min(100, Math.round((Number(mailbox.used_bytes) / Number(mailbox.quota_bytes || 1)) * 100))

  return (
    <div className="space-y-4">
      <PageHeader
        title="Mail"
        meta={
          <>
            <span className="font-mono">{mailbox.address}</span>
            <span className="flex items-center gap-2">
              <span className="tabular-nums">{fmtBytes(mailbox.used_bytes)} of {fmtBytes(mailbox.quota_bytes)} used</span>
              <span className="h-1 w-20 overflow-hidden rounded-full bg-ink-200" aria-hidden="true">
                <span className={`block h-full ${pct >= 90 ? 'bg-risk-500' : pct >= 70 ? 'bg-warn-500' : 'bg-ink-500'}`} style={{ width: `${pct}%` }} />
              </span>
            </span>
          </>
        }
        primary={<Button variant="primary" icon={PaperAirplaneIcon} onClick={() => openCompose(null)}>Compose</Button>}
      />

      <div className="grid grid-cols-12 gap-4">
        {/* --- folder rail --- */}
        <div className="col-span-12 lg:col-span-2">
          <Module accent="cyan" padding="p-3" bodyClassName="mt-0">
            <p className="label-mono mb-1.5 px-1">Favorites</p>
            <div className="space-y-0.5">
              {FOLDERS.filter((f) => FAVORITE_FOLDERS.includes(f.value)).map((f) => (
                <button
                  key={`fav-${f.value}`}
                  onClick={() => setFolder(f.value)}
                  aria-current={folder === f.value ? 'page' : undefined}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${folder === f.value ? 'bg-ink-100 font-medium text-fg' : 'text-ink-600 hover:bg-ink-50 hover:text-fg'}`}
                >
                  <f.icon className="h-3.5 w-3.5 flex-none" />
                  <span className="truncate">{f.label}</span>
                </button>
              ))}
            </div>
            <p className="label-mono mb-1.5 mt-4 px-1">All folders</p>
            <div className="space-y-0.5">
              {FOLDERS.map((f) => (
                <button
                  key={f.value}
                  onClick={() => setFolder(f.value)}
                  aria-current={folder === f.value ? 'page' : undefined}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${folder === f.value ? 'bg-ink-100 font-medium text-fg' : 'text-ink-600 hover:bg-ink-50 hover:text-fg'}`}
                >
                  <f.icon className="h-3.5 w-3.5 flex-none" />
                  <span className="truncate">{f.label}</span>
                </button>
              ))}
            </div>
          </Module>
        </div>

        {/* --- list --- */}
        <div className="col-span-12 lg:col-span-4">
          <Module
            title={FOLDERS.find((f) => f.value === folder)?.label || 'Messages'}
            accent="cyan"
            ticks
            padding="p-3.5"
            bodyClassName="mt-1"
          >
            <div className="mb-2.5 flex items-center gap-2">
              <div className="bos-field flex-1">
                <MagnifyingGlassIcon className="h-3.5 w-3.5 flex-none opacity-60" />
                <input
                  placeholder="Search subject, sender, body…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <button
                onClick={() => setStarredOnly((v) => !v)}
                title="Starred only"
                className={starredOnly ? 'bos-chip' : 'bos-btn bos-btn--sm bos-btn--ghost'}
              >
                {starredOnly ? <StarSolidIcon className="h-3.5 w-3.5" /> : <StarOutlineIcon className="h-3.5 w-3.5" />}
              </button>
            </div>

            <div className="bos-scroll -mx-1 max-h-[56vh] space-y-0.5 overflow-y-auto">
              {loadingMessages ? (
                <ModuleEmpty>Loading…</ModuleEmpty>
              ) : messages.length === 0 ? (
                <ModuleEmpty>No messages in this folder.</ModuleEmpty>
              ) : (
                messages.map((m) => (
                  // A row can't be a <button> — it hosts the star/read/delete
                  // buttons inside it, and a <button> nested in a <button> is
                  // invalid HTML that browsers "fix" by closing the outer one
                  // early, breaking both the layout and the row's own click.
                  <div
                    key={m.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => (folder === 'DRAFTS' ? openDraft(m) : openMessage(m.id))}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') (folder === 'DRAFTS' ? openDraft(m) : openMessage(m.id)) }}
                    className={`bos-row group w-full cursor-pointer text-left bos-accent-cyan ${selected?.id === m.id ? 'bos-row--flagged' : ''}`}
                  >
                    <button type="button" onClick={(e) => toggleStar(m, e)} onKeyDown={(e) => e.stopPropagation()} className="bos-plate bos-plate--sm" aria-label={m.is_starred ? 'Unstar' : 'Star'} aria-pressed={!!m.is_starred}>
                      {m.is_starred ? <StarSolidIcon className="h-3.5 w-3.5 text-warn-500" aria-hidden="true" /> : <InboxIcon className="h-3.5 w-3.5" aria-hidden="true" />}
                    </button>
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-[13px] ${!m.is_read && folder === 'INBOX' ? 'font-semibold bos-text-strong' : 'font-medium bos-text'}`}>
                        {folder === 'SENT' || folder === 'DRAFTS' ? (addrList(m.to_addresses)[0] || '(no recipient)') : m.from_address}
                        {folder === 'DRAFTS' && <span className="ml-1.5 text-rose-400">[Draft]</span>}
                      </span>
                      <span className="block truncate bos-caption">{m.subject || '(no subject)'}</span>
                    </span>
                    <span className="flex flex-none items-center gap-1">
                      <span className="bos-caption tabular-nums">{fmtDate(m.created_at)}</span>
                      <button
                        onClick={(e) => toggleRead(m, e)}
                        title={m.is_read ? 'Mark unread' : 'Mark read'}
                        className="bos-btn bos-btn--icon bos-btn--ghost opacity-0 transition-opacity group-hover:opacity-100"
                      >
                        <EnvelopeOpenIcon className="h-3.5 w-3.5" />
                      </button>
                      {folder !== 'ARCHIVE' && folder !== 'TRASH' && (
                        <button
                          onClick={(e) => archiveMessage(m, e)}
                          title="Archive"
                          className="bos-btn bos-btn--icon bos-btn--ghost opacity-0 transition-opacity group-hover:opacity-100"
                        >
                          <ArchiveBoxIcon className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        onClick={(e) => deleteMessage(m, e)}
                        title={folder === 'TRASH' ? 'Delete permanently' : 'Move to Trash'}
                        className="bos-btn bos-btn--icon bos-btn--ghost opacity-0 transition-opacity group-hover:opacity-100"
                      >
                        <TrashIcon className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  </div>
                ))
              )}
            </div>
          </Module>
        </div>

        {/* --- detail --- */}
        <div className="col-span-12 lg:col-span-6">
          <Module accent="violet" className="min-h-[60vh]">
            {!selected ? (
              <div className="flex h-full min-h-[50vh] items-center justify-center">
                <ModuleEmpty>Select a message to read it</ModuleEmpty>
              </div>
            ) : (
              <div>
                <div className="flex items-start justify-between gap-3">
                  <h2 className="min-w-0 text-[16px] font-semibold bos-text-strong">{selected.subject || '(no subject)'}</h2>
                  <button onClick={(e) => toggleStar(selected, e)} className="bos-btn bos-btn--icon bos-btn--ghost flex-none" title={selected.is_starred ? 'Unstar' : 'Star'}>
                    {selected.is_starred ? <StarSolidIcon className="h-4 w-4 text-amber-400" /> : <StarOutlineIcon className="h-4 w-4" />}
                  </button>
                </div>
                <p className="mt-1.5 text-[13px] bos-text-muted">
                  From <span className="font-medium bos-text-strong">{selected.from_address}</span>
                  <span className="bos-caption"> · {fmtDate(selected.created_at)}</span>
                </p>
                {addrList(selected.to_addresses).length > 0 && (
                  <p className="mt-0.5 text-[12px] bos-text-muted">To {addrList(selected.to_addresses).join(', ')}</p>
                )}
                {addrList(selected.cc_addresses).length > 0 && (
                  <p className="mt-0.5 text-[12px] bos-text-muted">Cc {addrList(selected.cc_addresses).join(', ')}</p>
                )}

                {/* Reply/Reply All only make sense on a message you received;
                    Forward makes sense either way. */}
                <div className="mt-3.5 flex flex-wrap gap-2">
                  <button onClick={() => openCompose('reply', selected)} className="bos-btn bos-btn--sm">
                    <ArrowUturnLeftIcon className="h-3.5 w-3.5" /> Reply
                  </button>
                  {(addrList(selected.to_addresses).length + addrList(selected.cc_addresses).length) > 1 && (
                    <button onClick={() => openCompose('reply-all', selected)} className="bos-btn bos-btn--sm">
                      <ArrowUturnRightIcon className="h-3.5 w-3.5" /> Reply All
                    </button>
                  )}
                  <button onClick={() => openCompose('forward', selected)} className="bos-btn bos-btn--sm">
                    <ArrowRightCircleIcon className="h-3.5 w-3.5" /> Forward
                  </button>
                  {folder !== 'ARCHIVE' && folder !== 'TRASH' && (
                    <button onClick={(e) => archiveMessage(selected, e)} className="bos-btn bos-btn--sm bos-btn--ghost">
                      <ArchiveBoxIcon className="h-3.5 w-3.5" /> Archive
                    </button>
                  )}
                  <button onClick={(e) => deleteMessage(selected, e)} className="bos-btn bos-btn--sm bos-btn--ghost">
                    <TrashIcon className="h-3.5 w-3.5" /> {folder === 'TRASH' ? 'Delete permanently' : 'Delete'}
                  </button>
                </div>

                {selected.attachments?.length > 0 && (
                  <div className="mt-3.5 flex flex-wrap gap-2">
                    {selected.attachments.map((a) => (
                      <button key={a.id} onClick={() => downloadAttachment(a)} className="bos-chip">
                        <PaperClipIcon className="h-3 w-3" />
                        {a.filename} · {fmtBytes(a.size_bytes)}
                      </button>
                    ))}
                  </div>
                )}

                {/* Image attachments the body doesn't already show inline
                    (i.e. not referenced as cid:<content_id> in body_html) —
                    a normal photo/screenshot attached rather than embedded.
                    Shown as real thumbnails, not just a filename to download. */}
                {selected.attachments?.filter((a) =>
                  (a.content_type || '').startsWith('image/')
                  && !(a.content_id && selected.body_html?.includes(`cid:${a.content_id}`))
                ).length > 0 && (
                  <div className="mt-3.5 flex flex-wrap gap-2">
                    {selected.attachments
                      .filter((a) => (a.content_type || '').startsWith('image/')
                        && !(a.content_id && selected.body_html?.includes(`cid:${a.content_id}`)))
                      .map((a) => (
                        <a key={a.id} href={imageUrls[a.id]} target="_blank" rel="noreferrer" title={a.filename}>
                          {imageUrls[a.id] ? (
                            <img src={imageUrls[a.id]} alt={a.filename} className="h-28 w-28 rounded-lg object-cover" style={{ border: '1px solid var(--embmis-line)' }} />
                          ) : (
                            <span className="flex h-28 w-28 items-center justify-center rounded-lg bos-caption" style={{ border: '1px solid var(--embmis-line)' }}>Loading…</span>
                          )}
                        </a>
                      ))}
                  </div>
                )}

                <div
                  className="mt-4 pt-4 text-[13px] leading-relaxed bos-text"
                  style={{ borderTop: '1px solid var(--embmis-line)', whiteSpace: selected.body_html ? 'normal' : 'pre-wrap' }}
                >
                  {selected.body_html
                    ? <div dangerouslySetInnerHTML={{ __html: resolveInlineImages(selected.body_html, selected.attachments) }} />
                    : (selected.body_text || '(empty)')}
                </div>
              </div>
            )}
          </Module>
        </div>
      </div>

      {composeOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(3, 5, 12, 0.68)', backdropFilter: 'blur(6px)' }}
          role="dialog"
          aria-modal="true"
        >
          <div className="bos-panel bos-panel--raised w-full max-w-lg p-5" style={{ boxShadow: 'var(--embmis-shadow-pop)' }}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-[15px] font-semibold bos-text-strong">
                {form.draftId ? 'Edit draft'
                  : form.inReplyTo ? (form.subject.toLowerCase().startsWith('fwd:') ? 'Forward' : 'Reply')
                  : 'New message'}
              </h3>
              <button onClick={() => setComposeOpen(false)} className="bos-btn bos-btn--icon bos-btn--ghost">
                <XMarkIcon className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-2.5">
              <div className="flex items-center gap-2">
                <div className="bos-field flex-1">
                  <input placeholder="To" value={form.to} onChange={(e) => setForm((f) => ({ ...f, to: e.target.value }))} />
                </div>
                {!showCcBcc && (
                  <button type="button" onClick={() => setShowCcBcc(true)} className="bos-btn bos-btn--sm bos-btn--ghost flex-none">
                    Cc/Bcc
                  </button>
                )}
              </div>
              {showCcBcc && (
                <>
                  <div className="bos-field">
                    <input placeholder="Cc" value={form.cc} onChange={(e) => setForm((f) => ({ ...f, cc: e.target.value }))} />
                  </div>
                  <div className="bos-field">
                    <input placeholder="Bcc" value={form.bcc} onChange={(e) => setForm((f) => ({ ...f, bcc: e.target.value }))} />
                  </div>
                </>
              )}
              <div className="bos-field">
                <input placeholder="Subject" value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} />
              </div>
              <textarea
                placeholder="Message"
                rows={form.quoted ? 6 : 8}
                ref={composeBodyRef}
                value={form.text}
                onChange={(e) => setForm((f) => ({ ...f, text: e.target.value }))}
                className="w-full rounded-[10px] border p-3 text-[13px] outline-none"
                style={{ borderColor: 'var(--embmis-line)', background: 'var(--embmis-surface-sunken)', color: 'var(--embmis-text-strong)' }}
              />

              {/* Gmail's "···" — the original message is on the thread
                  either way (it goes out appended, in buildFormData), this
                  just decides whether typing has to scroll past it first. */}
              {form.quoted && (
                <div className="rounded-[10px]" style={{ border: '1px solid var(--embmis-line)' }}>
                  <button
                    type="button"
                    onClick={() => setQuoteOpen((v) => !v)}
                    className="flex w-full items-center gap-1.5 px-3 py-2 text-[12px] bos-text-muted hover:bos-text"
                  >
                    {quoteOpen ? <ChevronDownIcon className="h-3 w-3" /> : <ChevronRightIcon className="h-3 w-3" />}
                    {quoteOpen ? 'Hide quoted text' : '···'}
                    <span className="truncate">{!quoteOpen && form.quoted.header}</span>
                  </button>
                  {quoteOpen && (
                    <div
                      className="max-h-40 overflow-y-auto whitespace-pre-wrap px-3 pb-3 text-[12px] leading-relaxed bos-text-muted"
                      style={{ borderTop: '1px solid var(--embmis-line)' }}
                    >
                      <p className="mb-1.5 mt-2.5">{form.quoted.header}</p>
                      {form.quoted.text}
                    </div>
                  )}
                </div>
              )}

              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => { addFiles(e.target.files); e.target.value = '' }}
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <button type="button" onClick={() => fileInputRef.current?.click()} className="bos-btn bos-btn--sm bos-btn--ghost">
                  <PaperClipIcon className="h-3.5 w-3.5" /> Attach
                </button>
                {form.files.map((file, i) => (
                  <span key={`${file.name}-${i}`} className="bos-chip">
                    {file.name}
                    <button type="button" onClick={() => removeFile(i)} className="ml-1 opacity-70 hover:opacity-100">
                      <XMarkIcon className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>

              <div className="flex gap-2">
                <button
                  onClick={send}
                  disabled={!form.to || !form.subject || sending || savingDraft}
                  className="bos-btn bos-btn--primary flex-1 justify-center disabled:opacity-50"
                >
                  {sending ? 'Sending…' : 'Send'}
                </button>
                <button
                  onClick={saveDraft}
                  disabled={sending || savingDraft}
                  className="bos-btn bos-btn--ghost flex-none disabled:opacity-50"
                  title="Save without sending"
                >
                  {savingDraft ? 'Saving…' : 'Save draft'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
