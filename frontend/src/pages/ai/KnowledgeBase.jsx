import React, { useMemo, useState } from 'react'
import { BookOpenIcon, PlusIcon, TrashIcon } from '@heroicons/react/20/solid'
import { knowledgeBaseAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import {
  PageHeader, Button, DataTable, RowAction, StatusBadge, DateText, Num, Dialog, Field, Input, Textarea, Segmented,
  ConfirmDialog, InlineNotice, notify, describeError,
} from '../../components/ui'

const KB_KEY = ['knowledge-base']

/**
 * Knowledge base — documents Simeli retrieves context from when it answers.
 */
export default function KnowledgeBase() {
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState(null)

  const { data, loading, error, refetch } = useResource(KB_KEY, () => knowledgeBaseAPI.list(), {
    // A document in 'pending' is still being embedded (fire-and-forget on
    // upload) — poll while any is, so the status updates without a refresh.
    refetchInterval: (query) => {
      const rows = query.state.data
      return Array.isArray(rows) && rows.some((d) => d.status === 'pending') ? 3000 : false
    },
  })
  const docs = useMemo(() => (Array.isArray(data) ? data : []), [data])

  const remove = useResourceMutation((id) => knowledgeBaseAPI.remove(id), { invalidates: [KB_KEY], silent: true })

  const confirmRemove = async () => {
    try {
      await remove.mutateAsync(removing.id)
      notify.success(`${removing.title} removed`)
    } catch (err) {
      notify.error(`Could not remove it — ${describeError(err).message}`)
    } finally {
      setRemoving(null)
    }
  }

  const columns = useMemo(() => [
    {
      id: 'title', header: 'Document', accessor: 'title', mobile: 'title', minWidth: 240,
      cell: (d) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium text-fg">{d.title}</span>
          {d.status === 'failed' && d.error_message && <span className="block truncate text-xs text-risk-700">{d.error_message}</span>}
        </span>
      ),
    },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 140, mobile: 'meta', cell: (d) => <StatusBadge status={d.status} label={d.status === 'indexed' ? 'Indexed' : undefined} /> },
    { id: 'format', header: 'Format', accessor: 'source_format', width: 100, filter: 'select' },
    { id: 'chunks', header: 'Passages', accessor: (d) => Number(d.chunk_count) || 0, align: 'right', width: 110, cell: (d) => (d.chunk_count ? <Num value={d.chunk_count} /> : '—') },
    { id: 'by', header: 'Uploaded by', accessor: 'uploaded_by_name', width: 160, cell: (d) => d.uploaded_by_name || '—' },
    { id: 'created', header: 'Uploaded', accessor: 'created_at', width: 170, mobile: 'subtitle', cell: (d) => <DateText value={d.created_at} withTime /> },
  ], [])

  return (
    <div className="space-y-5">
      <PageHeader
        title="Knowledge base"
        description="Policies and documents Simeli reads when it answers. It cites them like any other record."
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setAdding(true)}>Add a document</Button>}
      />

      <DataTable
        viewKey="ai.knowledge-base"
        caption="Knowledge base documents"
        noun="document"
        rows={docs}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        defaultSort={{ id: 'created', dir: 'desc' }}
        rowActions={(d) => <RowAction icon={TrashIcon} tone="risk" label={`Remove ${d.title}`} onClick={() => setRemoving(d)} />}
        empty={{
          icon: BookOpenIcon,
          title: 'Nothing uploaded yet',
          description: 'Add a policy, a price list or a procedure, and Simeli will use it when a question touches it.',
          action: <Button variant="primary" icon={PlusIcon} onClick={() => setAdding(true)}>Add a document</Button>,
        }}
      />

      {adding && <UploadDialog onClose={() => setAdding(false)} onDone={() => setAdding(false)} />}

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={confirmRemove}
        title={removing ? `Remove ${removing.title}?` : ''}
        consequence="Simeli stops using it straight away. Answers it already gave are not changed."
        confirmLabel="Remove document"
        busy={remove.isPending}
      />
    </div>
  )
}

function UploadDialog({ onClose, onDone }) {
  const [mode, setMode] = useState('file')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [file, setFile] = useState(null)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState(null)

  const upload = useResourceMutation(
    () => (mode === 'file' ? knowledgeBaseAPI.uploadFile(file, title || undefined) : knowledgeBaseAPI.uploadText(title, content)),
    { invalidates: [KB_KEY], silent: true },
  )

  const errors = mode === 'file'
    ? { file: !file ? 'Choose a file first.' : null }
    : { title: !title.trim() ? 'Give it a title.' : null, content: !content.trim() ? 'Paste the text to add.' : null }

  const submit = async () => {
    setSubmitted(true)
    setError(null)
    if (Object.values(errors).some(Boolean)) return
    try {
      await upload.mutateAsync()
      notify.success('Uploaded — indexing in the background')
      onDone()
    } catch (err) {
      setError(describeError(err).message)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add to the knowledge base"
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={upload.isPending}>Upload</Button>
        </>
      )}
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit() }}>
        {error && <InlineNotice tone="risk" title="Not uploaded">{error}</InlineNotice>}
        <Segmented
          label="Source"
          value={mode}
          onChange={(v) => { setMode(v); setSubmitted(false) }}
          options={[{ value: 'file', label: 'Upload a file' }, { value: 'text', label: 'Paste text' }]}
        />
        {mode === 'file' ? (
          <>
            <Field label="File" required help=".txt, .md, .html or .pdf" error={submitted ? errors.file : null}>
              <input
                type="file"
                accept=".txt,.md,.markdown,.html,.htm,.pdf"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="block w-full text-sm text-ink-700 file:mr-3 file:h-10 file:rounded-md file:border file:border-ink-300 file:bg-surface file:px-3 file:text-sm file:text-fg"
              />
            </Field>
            <Field label="Title" optional help="Defaults to the file name.">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
          </>
        ) : (
          <>
            <Field label="Title" required error={submitted ? errors.title : null}>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Procurement policy" />
            </Field>
            <Field label="Content" required error={submitted ? errors.content : null}>
              <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={10} placeholder="PO approval required above 5,000…" />
            </Field>
          </>
        )}
      </form>
    </Dialog>
  )
}
