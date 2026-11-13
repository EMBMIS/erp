import React, { useState } from 'react'
import { ArrowLeftIcon, CheckIcon, GlobeAltIcon, SparklesIcon } from '@heroicons/react/20/solid'
import { aiToolsAPI, aiBuilderAPI } from '../../../services/api'
import { useResourceMutation } from '../../../hooks/useResource'
import { keys } from '../../../services/queryKeys'
import { Dialog, Button, Field, Textarea, InlineNotice, Badge, Code, notify, describeError } from '../../../components/ui'
import { returnedNothing } from './helpers'
import { useI18n } from '../../../contexts/I18nContext'

// The kinds of question people want Simeli to answer but it cannot, because no
// tool covers it.
const TOOL_EXAMPLES = [
  'A tool that looks up a customer’s total lifetime spend',
  'Show me which suppliers deliver late most often',
  'How much stock of each item is sitting in each warehouse',
  'Which invoices are overdue, and by how many days',
]

/**
 * Describe a tool, read what came back, create it.
 *
 * The review step shows the tool's actual OUTPUT, not just its code: the draft
 * was executed against the real database before it got here. The
 * implementation is present but folded away, because most people building a
 * tool care what it returns, not how.
 */
export default function ToolWizard({ onClose, onSaved, onHandOff, onOpenDiscover }) {
  const { t } = useI18n()
  const [description, setDescription] = useState('')
  const [draft, setDraft] = useState(null)
  const [error, setError] = useState(null)

  const generator = useResourceMutation((text) => aiBuilderAPI.generateTool(text), { silent: true })
  const creator = useResourceMutation((tool) => aiToolsAPI.create(tool), { invalidates: [keys.aiTools()], silent: true })

  const generate = async () => {
    setError(null)
    try {
      setDraft(await generator.mutateAsync(description))
    } catch (err) {
      setError(describeError(err).message || 'Could not work out a tool from that description.')
    }
  }

  const create = async () => {
    setError(null)
    try {
      await creator.mutateAsync(draft.tool)
      notify.success('Tool created. Simeli can call it now.')
      onSaved()
    } catch (err) {
      setError(describeError(err).message)
    }
  }

  const params = Object.entries(draft?.tool?.input_schema?.properties || {})
  const required = draft?.tool?.input_schema?.required || []

  const title = draft?.impossible
    ? 'That is not something a tool built here can do'
    : draft ? 'Here is the tool' : 'What should Simeli be able to look up?'
  const subtitle = draft?.impossible
    ? 'A custom tool only reads this ERP’s own database.'
    : draft
      ? 'It has already been run against your real data — this is what it returned.'
      : 'Describe it in your own words. The query and the parameters are worked out for you.'

  const footer = draft?.impossible ? (
    <>
      <Button variant="ghost" icon={ArrowLeftIcon} onClick={() => setDraft(null)}>Describe it differently</Button>
      <Button variant="primary" icon={GlobeAltIcon} onClick={() => onOpenDiscover(draft.suggested_mcp?.[0]?.name || description)}>Find it in Discover</Button>
    </>
  ) : draft ? (
    <>
      <Button variant="ghost" icon={ArrowLeftIcon} onClick={() => setDraft(null)}>Describe it differently</Button>
      <Button onClick={() => onHandOff(draft.tool, draft.sample_input)}>Open in the editor</Button>
      <Button variant="primary" icon={CheckIcon} onClick={create} loading={creator.isPending} disabled={!draft.valid} title={!draft.valid ? 'It failed when it was run; fix it in the editor first.' : undefined}>
        Create tool
      </Button>
    </>
  ) : (
    <>
      <Button variant="ghost" onClick={() => onHandOff(null)}>I would rather write it myself</Button>
      <Button variant="primary" icon={SparklesIcon} onClick={generate} loading={generator.isPending} disabled={description.trim().length < 10} title={description.trim().length < 10 ? 'Describe it in a few more words.' : undefined}>
        {generator.isPending ? 'Building it…' : 'Build this tool'}
      </Button>
    </>
  )

  return (
    <Dialog open onClose={onClose} size="lg" title={title} description={subtitle} footer={footer}>
      <div className="space-y-4">
        {error && <InlineNotice tone="risk" title="That did not work">{error}</InlineNotice>}

        {!draft && (
          <>
            <Field label="Describe the tool" help="Needs a connected language model to draft the query.">
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                disabled={generator.isPending}
                placeholder={t('ui.iWantAToolThatLooks')}
                className="text-base leading-relaxed sm:text-sm"
              />
            </Field>
            {generator.isPending ? (
              <p role="status" className="py-2 text-center text-sm text-ink-500">Writing the query, then running it against your data…</p>
            ) : (
              <div>
                <p className="label-mono mb-2">Or try one of these</p>
                <ul className="space-y-2">
                  {TOOL_EXAMPLES.map((example) => (
                    <li key={example}>
                      <button
                        type="button"
                        onClick={() => setDescription(example)}
                        className="min-h-[44px] w-full rounded-md border border-ink-200 px-4 py-2.5 text-left text-sm text-ink-700 hover:border-ink-300 hover:bg-ink-50"
                      >
                        “{example}”
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        {draft?.impossible && (
          <>
            <InlineNotice tone="warn"><p className="whitespace-pre-wrap">{draft.impossible_reason}</p></InlineNotice>
            {draft.suggested_mcp?.length > 0 && (
              <div className="space-y-2">
                <p className="label-mono">Matching servers in the registry</p>
                {draft.suggested_mcp.map((m) => (
                  <div key={m.name} className="rounded-md border border-ink-200 px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-fg">{m.name}</p>
                      {m.category && <Badge>{m.category}</Badge>}
                    </div>
                    <p className="mt-1 text-sm text-ink-600">{m.description}</p>
                    {m.tools_preview?.length > 0 && (
                      <ul className="mt-2 flex flex-wrap gap-1.5">
                        {m.tools_preview.slice(0, 5).map((name) => <li key={name}><Code>{name}</Code></li>)}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {draft && !draft.impossible && (
          <>
            {!draft.valid && (
              <InlineNotice tone="risk" title="This did not work when it was run">
                <p className="whitespace-pre-wrap">{draft.validation_error}</p>
                <p className="mt-2">Open it in the editor to fix it, or describe it differently.</p>
              </InlineNotice>
            )}
            {draft.warnings?.map((w) => <InlineNotice key={w} tone="warn">{w}</InlineNotice>)}

            <div className="divide-y divide-ink-200 rounded-md border border-ink-200">
              <div className="px-4 py-3">
                <p className="text-base font-semibold text-fg">{draft.tool.display_name || draft.tool.name}</p>
                <Code className="text-ink-500">{draft.tool.name}</Code>
                <p className="mt-2 text-sm text-ink-700">{draft.tool.description}</p>
              </div>

              <div className="px-4 py-3">
                <p className="label-mono mb-2">What you give it</p>
                {params.length === 0 ? (
                  <p className="text-sm text-ink-500">Nothing — it can be called as it is.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {params.map(([key, spec]) => (
                      <li key={key} className="text-sm">
                        <Code className="text-fg">{key}</Code>
                        <span className="ml-2 text-xs text-ink-500">{spec.type}</span>
                        {required.includes(key) && <Badge className="ml-2">Required</Badge>}
                        {spec.description && <span className="mt-0.5 block text-xs text-ink-600">{spec.description}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {draft.returns && (
                <div className="px-4 py-3">
                  <p className="label-mono mb-2">What you get back</p>
                  <p className="text-sm text-ink-700">{draft.returns}</p>
                </div>
              )}

              {draft.test?.ok && (
                <div className="px-4 py-3">
                  <p className="mb-2 text-xs text-ink-600">
                    Tried with <Code>{JSON.stringify(draft.sample_input)}</Code> — returned in {Number(draft.test.duration_ms).toLocaleString()} ms
                  </p>
                  {/* No rows is ambiguous: nothing to report, or a join that does
                      not connect the way it assumed. Saying which would be a guess. */}
                  {returnedNothing(draft.test.result) && (
                    <p className="mb-2 text-xs text-warn-700">It ran without error but came back empty. That may be right, or the query may need adjusting in the editor.</p>
                  )}
                  <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-ink-200 bg-sunken p-3 text-2xs text-ink-800">
                    {JSON.stringify(draft.test.result, null, 2)}
                  </pre>
                </div>
              )}

              <details className="px-4 py-3">
                <summary className="cursor-pointer text-sm text-ink-700">How it works</summary>
                {draft.reasoning && <p className="mt-2 text-sm text-ink-600">{draft.reasoning}</p>}
                <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-ink-200 bg-sunken p-3 font-mono text-2xs text-ink-800">
                  {draft.tool.implementation}
                </pre>
                <p className="mt-2 text-xs text-ink-500">Runs sandboxed and read-only. It cannot change records.</p>
              </details>
            </div>
          </>
        )}
      </div>
    </Dialog>
  )
}
