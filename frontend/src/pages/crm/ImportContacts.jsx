import { useMemo, useRef, useState } from 'react'
import { ArrowUpTrayIcon, DocumentTextIcon, XMarkIcon } from '@heroicons/react/20/solid'
import { crmAPI } from '../../services/api'
import { useResourceMutation } from '../../hooks/useResource'
import {
  PageHeader, Button, DataTable, Checkbox, InlineNotice, Badge, MaturityBadge, SimeliMark, Num, notify,
} from '../../components/ui'

/**
 * Import contacts — upload a list, review what it would create, then commit.
 *
 * The review table is the point of this screen, not a formality on the way to
 * the real one. Simeli maps whatever the source system called its columns onto
 * CRM fields, and that mapping is a judgement: it is usually right, and when it
 * is wrong it is wrong for every row at once. A column mapping off by one
 * writes five hundred contacts with the phone number in the job title and
 * nobody finds out until a salesperson calls "Head of Procurement".
 *
 * So the mapping is shown before the rows, every row says what will happen to
 * it, and the commit button counts exactly what it is about to write.
 */

const STATUS = {
  new: { label: 'New', tone: 'ok' },
  duplicate: { label: 'Already exists', tone: 'warn' },
  invalid: { label: 'Cannot import', tone: 'risk' },
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

export default function ImportContacts() {
  const fileRef = useRef(null)
  const [result, setResult] = useState(null)
  const [failure, setFailure] = useState(null)
  const [skip, setSkip] = useState(() => new Set())
  const [linkCompany, setLinkCompany] = useState(true)
  const [done, setDone] = useState(null)

  const analyseM = useResourceMutation((f) => crmAPI.analyseImport(f), { silent: true })
  const commitM = useResourceMutation((payload) => crmAPI.commitImport(payload), { invalidates: [['contacts']], silent: true })
  const busy = analyseM.isPending || commitM.isPending

  const reset = () => {
    setResult(null); setFailure(null); setDone(null)
    setSkip(new Set())
    if (fileRef.current) fileRef.current.value = ''
  }

  const analyse = async (f) => {
    setResult(null); setFailure(null); setDone(null)
    try {
      const data = await analyseM.mutateAsync(f)
      setResult(data)
      // Anything that cannot be written, and anything that already exists, is
      // deselected by default. The safe choice should be the one you get by
      // pressing the button without reading — but the row is still listed, so
      // it is a default rather than a decision made for you.
      setSkip(new Set((data?.rows || []).filter((r) => r.status !== 'new').map((r) => r.line)))
    } catch (err) {
      setFailure(err?.response?.data?.error || 'The file could not be read.')
    }
  }

  const onPick = (e) => {
    const f = e.target.files?.[0]
    if (f) analyse(f)
  }

  const selected = useMemo(
    () => (result?.rows || []).filter((r) => r.status !== 'invalid' && !skip.has(r.line)),
    [result, skip],
  )

  const toggle = (line) => setSkip((prev) => {
    const next = new Set(prev)
    if (next.has(line)) next.delete(line); else next.add(line)
    return next
  })

  const commit = async () => {
    if (!selected.length) return
    setFailure(null)
    try {
      const data = await commitM.mutateAsync({ rows: selected, link_company: linkCompany })
      setDone(data)
      setResult(null)
      notify.success(`${plural(data?.created?.length || 0, 'contact')} imported`)
    } catch (err) {
      const detail = err?.response?.data?.data
      const msg = err?.response?.data?.error || 'The import failed.'
      setFailure(detail?.failed?.length
        ? `${detail.failed.length} row(s) failed, so nothing was written. ${detail.failed.slice(0, 3).map((f) => `Line ${f.line}: ${f.error}`).join(' ')}`
        : msg)
    }
  }

  const columns = useMemo(() => [
    {
      id: 'include', header: 'Import', width: 76, sortable: false, hideable: false,
      cell: (r) => (
        <Checkbox
          aria-label={`Import line ${r.line}`}
          disabled={r.status === 'invalid'}
          checked={r.status !== 'invalid' && !skip.has(r.line)}
          onChange={() => toggle(r.line)}
          onClick={(e) => e.stopPropagation()}
        />
      ),
    },
    { id: 'line', header: '#', accessor: 'line', align: 'right', width: 60, cell: (r) => <Num value={r.line} /> },
    {
      id: 'name', header: 'Name', accessor: (r) => [r.first_name, r.last_name].filter(Boolean).join(' '), minWidth: 180, mobile: 'title',
      cell: (r) => (
        <span className="block min-w-0">
          <span className="block truncate">{[r.first_name, r.last_name].filter(Boolean).join(' ') || '—'}</span>
          {r.job_title && <span className="block truncate text-2xs text-ink-500">{r.job_title}</span>}
        </span>
      ),
    },
    { id: 'email', header: 'Email', accessor: 'email', width: 220, mobile: 'subtitle', cell: (r) => r.email || <span className="text-ink-400">—</span> },
    { id: 'company', header: 'Company', accessor: 'company_name', width: 180, cell: (r) => r.company_name || <span className="text-ink-400">—</span> },
    { id: 'source', header: 'Read from', accessor: 'source', minWidth: 200, cell: (r) => (r.source ? <span className="truncate text-xs italic text-ink-600">“{r.source}”</span> : <span className="text-ink-400">—</span>) },
    {
      id: 'status', header: 'Status', accessor: (r) => STATUS[r.status]?.label, filter: 'select', width: 220, mobile: 'meta',
      cell: (r) => (
        <span className="block min-w-0">
          <Badge tone={STATUS[r.status]?.tone}>{STATUS[r.status]?.label || r.status}</Badge>
          {r.existing && (
            <span className="block truncate text-2xs text-ink-500">
              matches {[r.existing.first_name, r.existing.last_name].filter(Boolean).join(' ')}
              {r.match && r.match < 1 && ` (${Math.round(r.match * 100)}% similar)`}
            </span>
          )}
          {r.problems?.length > 0 && <span className="block truncate text-2xs text-ink-500">{r.problems[0]}</span>}
        </span>
      ),
    },
  ], [skip])

  return (
    <>
      <PageHeader
        title="Import contacts"
        status={<MaturityBadge level="beta" />}
        description="A contact list, an email, meeting notes, a signature block, a PDF. Simeli reads who the people are; you approve what gets written."
        secondary={result ? <Button icon={XMarkIcon} onClick={reset} disabled={busy}>Cancel</Button> : null}
        primary={result ? (
          <Button variant="primary" onClick={commit} loading={commitM.isPending} disabled={busy || !selected.length}>
            Import {plural(selected.length, 'contact')}
          </Button>
        ) : null}
      />

      <div className="space-y-4">
        {failure && (
          <InlineNotice tone="risk" title="Nothing was imported" action={<Button size="sm" onClick={reset}>Try another file</Button>}>
            {failure}
          </InlineNotice>
        )}

        {!result && !done && (
          <section className="rounded-lg border border-dashed border-ink-300 bg-surface p-8 text-center">
            <ArrowUpTrayIcon className="mx-auto h-6 w-6 text-ink-400" aria-hidden="true" />
            <p className="mt-3 text-sm font-medium text-fg">{analyseM.isPending ? 'Reading the file…' : 'Choose a file'}</p>
            <p className="mx-auto mt-1 max-w-lg text-xs text-ink-500">
              A CSV, a PDF, an email, notes — or a photo of a business card or an attendee list.
              Scanned PDFs are read as pictures. Spreadsheets: save as CSV first.
            </p>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.tsv,.txt,.md,.pdf,.png,.jpg,.jpeg,.webp,.gif,text/csv,text/plain,application/pdf,image/*"
              onChange={onPick}
              className="sr-only"
              id="crm-import-file"
              disabled={busy}
            />
            <Button variant="primary" icon={DocumentTextIcon} loading={analyseM.isPending} className="mt-4" onClick={() => fileRef.current?.click()}>
              {analyseM.isPending ? 'Working…' : 'Select file'}
            </Button>
          </section>
        )}

        {done && (
          <InlineNotice
            tone="ok"
            title={`${plural(done.created?.length || 0, 'contact')} imported.`}
            action={
              <span className="flex gap-2">
                <Button size="sm" variant="primary" to="/crm/contacts">View contacts</Button>
                <Button size="sm" onClick={reset}>Import another file</Button>
              </span>
            }
          />
        )}

        {result && (
          <>
            {/* The mapping first. It is the thing most likely to be wrong, and
                it is wrong for every row at once. */}
            <section className="rounded-lg border border-ink-200 bg-surface p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-fg">
                  <SimeliMark />
                  <span className="truncate">What Simeli found in {result.file?.name}</span>
                </h2>
                <span className="text-xs text-ink-500">
                  {result.file?.pages
                    ? `read as ${plural(result.file.pages, 'image')}`
                    : `${((result.file?.chars || 0) / 1000).toFixed(1)}k characters`}
                  {!result.file?.pages && result.file?.windows > 1 && ` · ${result.file.windows} passes`}
                  {result.confidence != null && ` · lowest row confidence ${result.confidence}%`}
                </span>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-ink-700">
                {result.file?.pages
                  ? 'Simeli looked at the pages and read the people off them. There is no text to quote against, so check these rows against the original before importing — a picture is harder to read than a file.'
                  : 'Simeli read the document and pulled out the people in it — no column mapping, so a job title buried in a notes field or a name written back to front is still read correctly. Every row shows the wording it came from.'}
              </p>
              {result.notes && <p className="mt-2 text-xs text-ink-600">{result.notes}</p>}
              <Checkbox
                className="mt-4"
                checked={linkCompany}
                onChange={(e) => setLinkCompany(e.target.checked)}
                label="Link contacts to an existing customer when the company name matches."
                description="Unmatched companies are kept in the contact’s notes."
              />
            </section>

            <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-600">
              <span>{plural(result.summary?.total ?? 0, 'row')}</span>
              <span>{result.summary?.new ?? 0} new</span>
              <span>{result.summary?.duplicate ?? 0} already exist</span>
              <span>{result.summary?.invalid ?? 0} cannot import</span>
            </p>

            <DataTable
              viewKey="crm.import-review"
              caption="Rows to import"
              noun="row"
              rows={result.rows || []}
              rowKey={(r) => r.line}
              columns={columns}
              rowClassName={(r) => (r.status === 'invalid' || skip.has(r.line) ? 'opacity-60' : undefined)}
              empty={{ title: 'No people found in this file', description: 'Try a different file, or a clearer scan.', action: <Button onClick={reset}>Try another file</Button> }}
            />
          </>
        )}
      </div>
    </>
  )
}
