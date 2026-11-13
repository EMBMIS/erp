import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { PhotoIcon, SparklesIcon, TrashIcon } from '@heroicons/react/20/solid'
import { mailBrandingAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import {
  PageHeader, Button, Card, Segmented, Field, Textarea, ConfirmDialog, ErrorState, Skeleton, InlineNotice,
  MaturityBadge, DateText, EmptyState, notify, describeError,
} from '../../components/ui'

/**
 * Mail design — one branded template that every mailbox in the company sends
 * through. Simeli drafts it from the logo's colours; an administrator can ask
 * for changes in words or edit the HTML directly.
 */

const KEY = ['mail-branding']

export default function MailDesign() {
  const queryClient = useQueryClient()
  const { data: branding, loading, error, refetch } = useResource(KEY, () => mailBrandingAPI.get())
  const [logoFile, setLogoFile] = useState(null)
  const [logoPreviewUrl, setLogoPreviewUrl] = useState(null)
  const [view, setView] = useState('preview') // 'preview' | 'redesign' | 'edit'
  const [editText, setEditText] = useState('')
  const [instruction, setInstruction] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [actionError, setActionError] = useState(null)
  const fileInputRef = useRef(null)

  // Each write returns the saved design; put it straight into the cache.
  const saved = (data) => queryClient.setQueryData(KEY, data ?? null)
  const opts = { silent: true, onSuccess: saved }
  const generate = useResourceMutation((fd) => mailBrandingAPI.generate(fd), opts)
  const redesign = useResourceMutation((text) => mailBrandingAPI.redesign(text), opts)
  const update = useResourceMutation((html) => mailBrandingAPI.updateTemplate(html), opts)
  const remove = useResourceMutation(() => mailBrandingAPI.remove(), { silent: true, onSuccess: () => saved(null) })

  const attempt = async (fn, after) => {
    setActionError(null)
    try {
      await fn()
      after?.()
    } catch (e) {
      setActionError(describeError(e).message)
    }
  }

  const pickFile = (file) => {
    if (!file) return
    setLogoFile(file)
    setLogoPreviewUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(file) })
  }

  const runGenerate = () => attempt(async () => {
    const fd = new FormData()
    fd.append('logo', logoFile)
    await generate.mutateAsync(fd)
  }, () => {
    setLogoFile(null)
    setLogoPreviewUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null })
    setView('preview')
  })

  const runRedesign = () => attempt(() => redesign.mutateAsync(instruction.trim()), () => { setInstruction(''); setView('preview') })
  const runSave = () => attempt(() => update.mutateAsync(editText), () => setView('preview'))
  const runRemove = () => attempt(() => remove.mutateAsync(), () => { setConfirmRemove(false); notify.success('Design removed — mail now sends plain') })

  const openView = (v) => {
    if (v === 'edit') setEditText(branding?.htmlTemplate || '')
    setView(v)
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Mail design"
        badge={<MaturityBadge level="beta" title="The template is drafted by Simeli from your logo" />}
        description="Upload your company logo and Simeli designs an email template around its colours. Every mailbox in your company sends through this one design."
        secondary={branding ? <Button variant="destructive" icon={TrashIcon} onClick={() => setConfirmRemove(true)}>Remove design</Button> : null}
      />

      {actionError && <InlineNotice tone="risk" title="That did not work">{actionError}</InlineNotice>}

      {loading ? (
        <Card><Skeleton className="h-64 w-full" /></Card>
      ) : error ? (
        <ErrorState what="The mail design" error={error} onRetry={refetch} />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <Card title={branding ? 'Regenerate from a logo' : 'Generate a design'} description="PNG or JPEG. The logo's colours set the palette.">
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => pickFile(e.target.files?.[0])} aria-label="Logo image" />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed border-ink-300 bg-sunken p-6 text-center hover:border-ink-400"
            >
              {logoPreviewUrl ? (
                <img src={logoPreviewUrl} alt="Selected logo" className="h-20 max-w-full object-contain" />
              ) : (
                <>
                  <PhotoIcon className="h-6 w-6 text-ink-400" aria-hidden="true" />
                  <span className="text-sm text-ink-600">Choose a logo image</span>
                </>
              )}
            </button>
            <Button variant="primary" block icon={SparklesIcon} className="mt-3" onClick={runGenerate} disabled={!logoFile} loading={generate.isPending}>
              {branding ? 'Regenerate design' : 'Generate design'}
            </Button>
            <p className="mt-2 text-xs text-ink-500">
              {generate.isPending
                ? 'Reading the logo’s colours and drafting a template — this takes a few seconds.'
                : branding ? 'Regenerating replaces the current design for every mailbox.' : 'Until you generate one, mail sends plain and unbranded.'}
            </p>
          </Card>

          <Card
            title="Current design"
            description={branding?.updated_at ? <>Updated <DateText value={branding.updated_at} withTime /></> : undefined}
            actions={branding ? (
              <Segmented
                label="View"
                value={view}
                onChange={openView}
                options={[{ value: 'preview', label: 'Preview' }, { value: 'redesign', label: 'Redesign' }, { value: 'edit', label: 'Edit HTML' }]}
              />
            ) : null}
          >
            {!branding ? (
              <EmptyState icon={PhotoIcon} title="No design yet" description="Mail sends plain until you generate one. Choose a logo to get started." compact />
            ) : view === 'redesign' ? (
              <div className="space-y-3">
                <Field label="What should change?" help="Simeli keeps everything else as it is. The result replaces the current design.">
                  <Textarea
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    rows={5}
                    placeholder={'e.g. "Make it more minimal", "Use warmer colours", "Put the logo on the right"'}
                  />
                </Field>
                <Button variant="primary" icon={SparklesIcon} onClick={runRedesign} disabled={!instruction.trim()} loading={redesign.isPending}>Redesign</Button>
                {redesign.isPending && <p className="text-xs text-ink-500">Rewriting the template to match — this takes a few seconds.</p>}
              </div>
            ) : view === 'edit' ? (
              <div className="space-y-3">
                <Field
                  label="Template HTML"
                  help={<>This is the exact code every mailbox sends. Keep the <code className="font-mono">{'{{SUBJECT}}'}</code> and <code className="font-mono">{'{{BODY}}'}</code> placeholders, and <code className="font-mono">cid:company-logo</code> wherever the logo should show.</>}
                >
                  <Textarea value={editText} onChange={(e) => setEditText(e.target.value)} spellCheck={false} rows={18} className="font-mono text-xs leading-relaxed" />
                </Field>
                <div className="flex gap-2">
                  <Button variant="primary" onClick={runSave} disabled={!editText.trim()} loading={update.isPending}>Save changes</Button>
                  <Button onClick={() => setView('preview')} disabled={update.isPending}>Cancel</Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  {branding.logoDataUrl && <img src={branding.logoDataUrl} alt="Company logo" className="h-10 max-w-[160px] object-contain" />}
                  <ul className="flex gap-1.5" aria-label="Palette">
                    {Object.entries(branding.palette || {}).map(([k, hex]) => (
                      <li key={k} title={`${k}: ${hex}`} className="h-6 w-6 rounded-full border border-ink-200" style={{ background: hex }}>
                        <span className="sr-only">{k}: {hex}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="overflow-hidden rounded-md border border-ink-200">
                  {/* The preview is the email itself, rendered on white as a mail client would. */}
                  <iframe title="Mail design preview" srcDoc={branding.previewHtml} sandbox="" className="h-[480px] w-full bg-white" />
                </div>
              </div>
            )}
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={runRemove}
        title="Remove the mail design?"
        consequence="Every mailbox in the company goes back to sending plain, unbranded messages. To brand mail again you generate a new design from a logo."
        confirmLabel="Remove design"
        busy={remove.isPending}
      />
    </div>
  )
}
