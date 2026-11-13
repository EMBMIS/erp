import React, { useEffect, useMemo, useState } from 'react'
import { ArrowDownTrayIcon, ArrowPathIcon, DocumentTextIcon, EyeIcon, PencilSquareIcon, PlusIcon, TrashIcon } from '@heroicons/react/20/solid'
import { pdfTemplatesAPI, aiDocumentsAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, Tabs, DataTable, RowAction, Code, Badge, DateText, Sheet, Field, Input, Select, Textarea,
  Checkbox, FormSection, ConfirmDialog, InlineNotice, SkeletonRows, ErrorState, notify, describeError,
} from '../../components/ui'

// The PDF's own colours (data stored on the template, rendered into the
// document), not interface colours.
const DEFAULT_COLORS = { primary: '#2563eb', text: '#111827', muted: '#6b7280', border: '#e5e7eb', band: '#f3f4f6' }

const SECTION_HELP = `[
  { "type": "heading",   "text": "Summary for {{period}}" },
  { "type": "metrics",   "items": [{ "label": "Revenue", "value": "{{revenue}}" }] },
  { "type": "table",     "columns": ["Account", "Amount"], "rows": "{{rows}}" },
  { "type": "paragraph", "text": "Prepared for {{recipient}}." },
  { "type": "callout",   "text": "…", "tone": "warn" }
]`

const TEMPLATES_KEY = ['pdf-templates']

/**
 * Preview opens the rendered PDF in a new tab. The endpoint returns bytes
 * rather than storing a document: a preview is a look, not a deliverable.
 */
async function previewTemplate(key, body = {}) {
  try {
    const res = await pdfTemplatesAPI.preview(key, body)
    const url = URL.createObjectURL(res.data)
    window.open(url, '_blank', 'noopener')
    setTimeout(() => URL.revokeObjectURL(url), 60000)
  } catch (err) {
    notify.error(`Could not render a preview — ${describeError(err).message}`)
  }
}

export default function PdfTemplates() {
  const [editing, setEditing] = useState(null) // { isNew } | { key }
  const [tab, setTab] = useState('templates')

  const templatesQ = useResource(TEMPLATES_KEY, () => pdfTemplatesAPI.list())
  const documentsQ = useResource(keys.aiDocuments(), () => aiDocumentsAPI.list({ limit: 30 }), { retry: false })
  const templates = Array.isArray(templatesQ.data) ? templatesQ.data : []
  const documents = Array.isArray(documentsQ.data) ? documentsQ.data : []

  const download = async (doc) => {
    try {
      const res = await aiDocumentsAPI.download(doc.id)
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url
      a.download = doc.file_name
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      notify.error(`Could not download that document — ${describeError(err).message}`)
    }
  }

  const templateColumns = useMemo(() => [
    {
      id: 'name', header: 'Template', accessor: 'name', mobile: 'title', minWidth: 220,
      cell: (tpl) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden="true"
            className="h-8 w-6 shrink-0 rounded-sm border border-ink-200 bg-white"
            style={{ boxShadow: `inset 0 4px 0 ${tpl.colors?.primary || DEFAULT_COLORS.primary}` }}
          />
          <span className="min-w-0">
            <span className="block truncate font-medium text-fg">{tpl.name}</span>
            <span className="block truncate text-xs text-ink-500">{tpl.description || 'No description'}</span>
          </span>
        </span>
      ),
    },
    { id: 'key', header: 'Identifier', accessor: 'key', width: 180, mobile: 'subtitle', cell: (tpl) => <Code>{tpl.key}</Code> },
    {
      id: 'layout', header: 'Layout', accessor: (tpl) => `${tpl.orientation} ${tpl.page_size}`, width: 170,
      cell: (tpl) => <span className="text-ink-700">{tpl.orientation} · {tpl.page_size}</span>,
    },
    {
      id: 'body', header: 'Body', accessor: (tpl) => (Array.isArray(tpl.sections) ? tpl.sections.length : 0), width: 150,
      cell: (tpl) => (Array.isArray(tpl.sections) && tpl.sections.length ? `${tpl.sections.length} sections` : 'Styling only'),
    },
    {
      id: 'version', header: 'Version', accessor: 'version', width: 120, mobile: 'meta',
      cell: (tpl) => <span className="flex items-center gap-1.5"><Code>v{tpl.version}</Code>{tpl.is_builtin && <Badge>Built in</Badge>}</span>,
    },
  ], [])

  const documentColumns = useMemo(() => [
    { id: 'title', header: 'Document', accessor: 'title', mobile: 'title', minWidth: 220 },
    { id: 'kind', header: 'Kind', accessor: 'kind', width: 120, filter: 'select', mobile: 'meta' },
    { id: 'template', header: 'Template', accessor: 'template_key', width: 160, cell: (d) => (d.template_key ? <Code>{d.template_key}</Code> : '—') },
    { id: 'size', header: 'Size', accessor: (d) => Number(d.byte_size) || 0, align: 'right', width: 100, cell: (d) => (d.byte_size != null ? `${Math.max(1, Math.round(d.byte_size / 1024)).toLocaleString()} KB` : '—') },
    {
      id: 'source', header: 'Source', accessor: (d) => (d.agent_run_id ? 'Agent run' : 'Simeli'), width: 200, defaultHidden: false,
      cell: (d) => (
        <span className="text-ink-700">
          {d.agent_run_id ? 'Agent run' : 'Simeli'}
          {d.metadata?.emailed_to ? <span className="block truncate text-xs text-ink-500">Emailed to {d.metadata.emailed_to}</span> : null}
        </span>
      ),
    },
    { id: 'created', header: 'Generated', accessor: 'created_at', width: 170, mobile: 'subtitle', cell: (d) => <DateText value={d.created_at} withTime /> },
  ], [])

  return (
    <div className="space-y-5">
      <PageHeader
        title="Documents"
        description="How PDFs that Simeli and its agents generate look, and what they have generated."
        secondary={<Button icon={ArrowPathIcon} onClick={() => { templatesQ.refetch(); documentsQ.refetch() }}>Refresh</Button>}
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setEditing({ isNew: true })}>New template</Button>}
      />

      <Tabs
        value={tab}
        onChange={setTab}
        label="Documents"
        tabs={[
          { id: 'templates', label: 'Templates', count: templates.length },
          { id: 'documents', label: 'Recently generated', count: documents.length },
        ]}
      />

      {tab === 'templates' ? (
        <DataTable
          viewKey="ai.pdf-templates"
          caption="PDF templates"
          noun="template"
          rows={templates}
          columns={templateColumns}
          rowKey={(tpl) => tpl.key}
          loading={templatesQ.loading}
          error={templatesQ.error}
          onRetry={templatesQ.refetch}
          onRowClick={(tpl) => setEditing({ key: tpl.key })}
          rowActions={(tpl) => (
            <>
              <RowAction icon={EyeIcon} label={`Preview ${tpl.name}`} onClick={() => previewTemplate(tpl.key, {})} />
              <RowAction icon={PencilSquareIcon} label={`Edit ${tpl.name}`} onClick={() => setEditing({ key: tpl.key })} />
            </>
          )}
          empty={{
            icon: DocumentTextIcon,
            title: 'No templates yet',
            description: 'A template sets the letterhead, colours and page layout of the PDFs Simeli generates.',
            action: <Button variant="primary" icon={PlusIcon} onClick={() => setEditing({ isNew: true })}>New template</Button>,
          }}
        />
      ) : (
        <DataTable
          viewKey="ai.generated-documents"
          caption="Recently generated documents"
          noun="document"
          rows={documents}
          columns={documentColumns}
          loading={documentsQ.loading}
          error={documentsQ.error}
          onRetry={documentsQ.refetch}
          defaultSort={{ id: 'created', dir: 'desc' }}
          rowActions={(d) => <RowAction icon={ArrowDownTrayIcon} label={`Download ${d.title}`} onClick={() => download(d)} />}
          empty={{
            icon: DocumentTextIcon,
            title: 'Nothing generated yet',
            description: 'When Simeli or an agent produces a PDF, it is kept here to download again.',
          }}
        />
      )}

      {editing && (
        <TemplateEditor
          templateKey={editing.isNew ? null : editing.key}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)}
        />
      )}
    </div>
  )
}

const EMPTY_FORM = {
  key: '',
  name: '',
  description: '',
  orientation: 'portrait',
  page_size: 'A4',
  margin: 50,
  colors: DEFAULT_COLORS,
  header: { show_company: true, title: '', subtitle: '' },
  footer: { text: '', show_page_numbers: true, show_generated_at: true },
  sections: [],
}

function TemplateEditor({ templateKey, onClose, onSaved }) {
  const [form, setForm] = useState(EMPTY_FORM)
  const [sectionsText, setSectionsText] = useState('[]')
  const [sectionsError, setSectionsError] = useState(null)
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const existing = useResource(
    [...TEMPLATES_KEY, templateKey],
    () => pdfTemplatesAPI.get(templateKey),
    { enabled: !!templateKey, retry: false },
  )
  // Seed the form once the stored template arrives (not on every refetch).
  const [seeded, setSeeded] = useState(!templateKey)
  useEffect(() => {
    if (seeded || !existing.data) return
    const t = existing.data
    setForm({ ...EMPTY_FORM, ...t, colors: { ...DEFAULT_COLORS, ...(t.colors || {}) } })
    setSectionsText(JSON.stringify(t.sections || [], null, 2))
    setSeeded(true)
  }, [existing.data, seeded])

  const invalidates = [TEMPLATES_KEY]
  const save = useResourceMutation(
    (payload) => (templateKey ? pdfTemplatesAPI.update(templateKey, payload) : pdfTemplatesAPI.create(payload)),
    { invalidates, silent: true },
  )
  const remove = useResourceMutation(() => pdfTemplatesAPI.remove(templateKey), { invalidates, silent: true })
  const [saveError, setSaveError] = useState(null)

  const set = (patch) => setForm((prev) => ({ ...prev, ...patch }))

  const handleSections = (text) => {
    setSectionsText(text)
    try {
      const parsed = JSON.parse(text || '[]')
      if (!Array.isArray(parsed)) throw new Error('The body must be a list of sections: [ … ].')
      set({ sections: parsed })
      setSectionsError(null)
    } catch (err) {
      setSectionsError(err.message)
    }
  }

  const errors = {
    name: !form.name?.trim() ? 'Give the template a name.' : null,
    key: !form.key?.trim() ? 'An identifier is needed; it is filled from the name.' : null,
    margin: !(Number(form.margin) >= 10 && Number(form.margin) <= 150) ? 'Between 10 and 150 points.' : null,
    sections: sectionsError,
  }
  const show = (f) => (submitted || touched[f]) && errors[f]

  const submit = async () => {
    setSubmitted(true)
    setSaveError(null)
    if (Object.values(errors).some(Boolean)) return
    try {
      await save.mutateAsync(form)
      notify.success(templateKey ? `${form.name} saved` : `${form.name} created`)
      onSaved()
    } catch (err) {
      setSaveError(describeError(err).message)
    }
  }

  const doDelete = async () => {
    try {
      await remove.mutateAsync()
      notify.success(`${form.name} deleted`)
      setConfirmDelete(false)
      onSaved()
    } catch (err) {
      setConfirmDelete(false)
      setSaveError(describeError(err).message)
    }
  }

  const loadingExisting = templateKey && !seeded && !existing.error

  return (
    <Sheet
      open
      onClose={onClose}
      width="lg"
      title={templateKey ? `Edit ${form.name || templateKey}` : 'New PDF template'}
      description="Sets the letterhead, colours and page layout of generated PDFs."
      footer={(
        <div className="flex w-full flex-wrap items-center gap-2">
          <Button icon={EyeIcon} variant="ghost" onClick={() => previewTemplate(templateKey || 'draft', { template: form, sections: form.sections?.length ? form.sections : undefined })}>
            Preview
          </Button>
          {templateKey && !form.is_builtin && (
            <Button variant="destructive" icon={TrashIcon} onClick={() => setConfirmDelete(true)}>Delete</Button>
          )}
          <span className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={save.isPending} disabled={loadingExisting}>Save template</Button>
        </div>
      )}
    >
      {existing.error ? (
        <div className="p-4"><ErrorState error={existing.error} what="This template" onRetry={existing.refetch} compact /></div>
      ) : loadingExisting ? (
        <SkeletonRows rows={6} columns={2} className="p-4" />
      ) : (
        <form className="space-y-5 p-4" onSubmit={(e) => { e.preventDefault(); submit() }} noValidate>
          {saveError && <InlineNotice tone="risk" title="The template was not saved">{saveError}</InlineNotice>}
          {submitted && Object.values(errors).some(Boolean) && (
            <InlineNotice tone="risk" title="Fix these before saving">
              <ul className="list-disc pl-4">
                {Object.entries(errors).filter(([, v]) => v).map(([k, v]) => <li key={k}>{v}</li>)}
              </ul>
            </InlineNotice>
          )}

          <FormSection title="Template">
            <Field label="Name" required error={show('name')}>
              <Input
                value={form.name}
                onBlur={() => setTouched((t) => ({ ...t, name: true }))}
                onChange={(e) => set({
                  name: e.target.value,
                  ...(templateKey ? {} : { key: e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') }),
                })}
              />
            </Field>
            <Field label="Identifier" required error={show('key')} help={templateKey ? 'Fixed once created; agents refer to it.' : 'Filled from the name. Agents refer to the template by it.'}>
              <Input value={form.key} className="font-mono" onBlur={() => setTouched((t) => ({ ...t, key: true }))} onChange={(e) => set({ key: e.target.value })} disabled={!!templateKey} />
            </Field>
            <Field label="Description" optional className="sm:col-span-2">
              <Input value={form.description || ''} onChange={(e) => set({ description: e.target.value })} />
            </Field>
          </FormSection>

          <FormSection title="Page" columns={3}>
            <Field label="Orientation">
              <Select value={form.orientation} onChange={(e) => set({ orientation: e.target.value })}>
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </Select>
            </Field>
            <Field label="Page size">
              <Select value={form.page_size} onChange={(e) => set({ page_size: e.target.value })}>
                {['A4', 'LETTER', 'LEGAL', 'A3'].map((s) => <option key={s} value={s}>{s}</option>)}
              </Select>
            </Field>
            <Field label="Margin" error={show('margin')} help="In points (72 to the inch).">
              <Input type="number" numeric min={10} max={150} value={form.margin} onBlur={() => setTouched((t) => ({ ...t, margin: true }))} onChange={(e) => set({ margin: Number(e.target.value) })} />
            </Field>
          </FormSection>

          <FormSection title="Header and footer">
            <Field label="Default title" optional>
              <Input value={form.header?.title || ''} onChange={(e) => set({ header: { ...form.header, title: e.target.value } })} placeholder="Monthly summary — {{period}}" />
            </Field>
            <Field label="Footer text" optional>
              <Input value={form.footer?.text || ''} onChange={(e) => set({ footer: { ...form.footer, text: e.target.value } })} placeholder="Confidential" />
            </Field>
            <div className="space-y-2 sm:col-span-2">
              {[
                ['header', 'show_company', 'Company letterhead'],
                ['footer', 'show_page_numbers', 'Page numbers'],
                ['footer', 'show_generated_at', 'Generated timestamp'],
              ].map(([group, field, label]) => (
                <Checkbox
                  key={field}
                  label={label}
                  checked={form[group]?.[field] !== false}
                  onChange={(e) => set({ [group]: { ...form[group], [field]: e.target.checked } })}
                />
              ))}
            </div>
          </FormSection>

          <FormSection title="Document colours" description="Printed in the PDF; they do not change this screen." columns={1}>
            <div className="flex flex-wrap gap-4">
              {Object.entries(form.colors || DEFAULT_COLORS).map(([name, value]) => (
                <label key={name} className="flex items-center gap-2 text-sm text-ink-700">
                  <input
                    type="color"
                    value={value}
                    onChange={(e) => set({ colors: { ...form.colors, [name]: e.target.value } })}
                    className="h-9 w-9 cursor-pointer rounded border border-ink-300 bg-surface"
                  />
                  {name}
                </label>
              ))}
            </div>
          </FormSection>

          <FormSection title="Body" advanced defaultOpen={Array.isArray(form.sections) && form.sections.length > 0} columns={1} description="Optional: a document with {{placeholders}} Simeli fills in.">
            <Field label="Sections (JSON)" error={show('sections') || sectionsError} help="A list of heading, metrics, table, paragraph and callout sections.">
              <Textarea
                value={sectionsText}
                onChange={(e) => handleSections(e.target.value)}
                rows={10}
                spellCheck={false}
                className="font-mono text-xs"
              />
            </Field>
            <details>
              <summary className="cursor-pointer text-xs text-ink-600">What can go in here</summary>
              <pre className="mt-1 overflow-x-auto rounded-md bg-sunken p-2 text-2xs text-ink-700">{SECTION_HELP}</pre>
            </details>
          </FormSection>
        </form>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={doDelete}
        title={`Delete the template ${form.name}?`}
        consequence="Agents that refer to it by its identifier fall back to the default layout. Documents already generated are kept."
        confirmLabel={`Delete ${form.name}`}
        busy={remove.isPending}
      />
    </Sheet>
  )
}
