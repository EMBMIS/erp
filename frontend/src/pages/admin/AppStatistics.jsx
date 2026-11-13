import { useMemo } from 'react'
import { ArrowPathIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, Card, Stat, Badge, StatusBadge, DataTable, LineChart, ErrorState, SkeletonDetail, Code,
  DateText, Num, formatNumber,
} from '../../components/ui'

/**
 * Application statistics — this deployment as a whole: business volume, AI
 * spend and request health. Platform owner only; the numbers describe the
 * instance, not a tenant.
 *
 * Request health is STATE, so it uses the state tones and pairs each with a
 * word; token volume is one measure over time, so it is one line with a table
 * view rather than a stacked chart with a legend.
 */

const fmtUsd = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : `$${Number(n).toFixed(2)}`)

function fmtUptime(seconds) {
  if (seconds == null) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  return `${m}m`
}

const HTTP_CLASSES = [
  { code: '2xx', label: 'Success', tone: 'bg-ok-500' },
  { code: '3xx', label: 'Redirect', tone: 'bg-ink-400' },
  { code: '4xx', label: 'Client error', tone: 'bg-warn-500' },
  { code: '5xx', label: 'Server error', tone: 'bg-risk-500' },
]

function SimpleTable({ caption, head, rows, empty }) {
  if (!rows.length) return <p className="px-4 py-4 text-sm text-ink-600">{empty}</p>
  return (
    <div className="overflow-x-auto ui-scroll">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="text-xs text-ink-500">
          <tr className="border-b border-ink-200">
            {head.map((h) => <th key={h.label} scope="col" className={`px-4 py-2 font-medium ${h.right ? 'text-right' : 'text-left'}`}>{h.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-ink-100 last:border-0">
              {r.cells.map((c, i) => <td key={i} className={`px-4 py-2 ${head[i].right ? 'text-right tabular-nums' : ''}`}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function AppStatistics() {
  const { data, loading, error, refetch, isFetching } = useResource(keys.appStats(), ({ signal }) => api.get('/app-stats', { signal }))

  const signupColumns = useMemo(() => [
    {
      id: 'email', header: 'Email', accessor: 'email', mobile: 'title', minWidth: 220,
      cell: (s) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <Code className="truncate">{s.email}</Code>
          {s.is_platform_owner && <Badge>Owner</Badge>}
        </span>
      ),
    },
    { id: 'company', header: 'Company', accessor: 'company', filter: 'text', mobile: 'subtitle', minWidth: 160, cell: (s) => s.company || <span className="text-ink-400">—</span> },
    { id: 'role', header: 'Role', accessor: 'role', filter: 'select', width: 110, cell: (s) => <span className="font-mono text-xs">{s.role}</span> },
    {
      id: 'status', header: 'Status', accessor: (s) => (!s.is_active ? 'Inactive' : s.email_verified ? 'Verified' : 'Unverified'), filter: 'select', width: 130, mobile: 'meta',
      cell: (s) => (!s.is_active
        ? <StatusBadge status="INACTIVE" />
        : s.email_verified ? <StatusBadge status="VERIFIED" /> : <StatusBadge status="WARNING" label="Unverified" />),
    },
    { id: 'created', header: 'Signed up', accessor: 'created_at', width: 130, mobile: 'trailing', cell: (s) => <DateText value={s.created_at} /> },
  ], [])

  const header = (meta) => (
    <PageHeader
      title="Application statistics"
      description="This deployment as a whole — business volume, AI spend and request health. Platform owner only."
      meta={meta}
      secondary={<Button icon={ArrowPathIcon} onClick={() => refetch()} loading={isFetching && !loading}>Refresh</Button>}
    />
  )

  if (loading) return <>{header()}<SkeletonDetail /></>
  if (error || !data) return <>{header()}<ErrorState what="Application statistics" error={error || { message: 'The server returned no statistics.' }} onRetry={refetch} /></>

  const { platform, database, business, ai, http, signups } = data
  const mtd = ai?.month_to_date || {}
  const daily = ai?.daily || []
  const tokenPoints = daily.map((d) => ({ x: String(d.day || '').slice(5), y: (Number(d.prompt_tokens) || 0) + (Number(d.completion_tokens) || 0) }))
  const hasTokenData = daily.some((d) => Number(d.prompt_tokens) > 0 || Number(d.completion_tokens) > 0)
  const promptTotal = daily.reduce((s, d) => s + (Number(d.prompt_tokens) || 0), 0)
  const completionTotal = daily.reduce((s, d) => s + (Number(d.completion_tokens) || 0), 0)
  const httpTotal = Number(http?.requests) || 0

  return (
    <div className="space-y-5">
      {header(
        <>
          <Badge tone={platform?.ai_configured ? 'ok' : 'ink'} glyph={platform?.ai_configured ? 'check' : 'ring'}>{platform?.ai_configured ? 'AI configured' : 'AI not configured'}</Badge>
          <Badge tone={platform?.email_configured ? 'ok' : 'ink'} glyph={platform?.email_configured ? 'check' : 'ring'}>{platform?.email_configured ? 'Email configured' : 'Email not configured'}</Badge>
          {platform?.environment && <span className="font-mono uppercase">{platform.environment}</span>}
        </>
      )}

      <section aria-label="Headline figures" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Uptime" value={fmtUptime(platform?.uptime_seconds)} reason={platform?.node_version ? `Node ${platform.node_version}` : undefined} />
        <Stat label="Database size" value={database?.size || '—'} reason={database?.pool?.total != null ? `${formatNumber(database.pool.total)} pooled connections` : undefined} />
        <Stat label="AI calls this month" value={<Num value={mtd.calls} />} reason={mtd.tokens != null ? `${formatNumber(mtd.tokens)} tokens` : undefined} />
        <Stat label="AI cost this month" value={fmtUsd(mtd.cost_usd)} reason={platform?.ai_model || 'No model set'} />
      </section>

      <Card title="AI tokens per day, last 30 days" description={hasTokenData ? `Prompt ${formatNumber(promptTotal)} · completion ${formatNumber(completionTotal)} over the period.` : undefined}>
        {hasTokenData ? (
          <LineChart points={tokenPoints} format={(v) => (v >= 1000 ? `${formatNumber(Math.round(v / 1000))}k` : formatNumber(Math.round(v)))} title="Tokens (prompt + completion)" height={220} />
        ) : (
          <p className="py-6 text-center text-sm text-ink-600">No AI usage recorded in the last 30 days.</p>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Request health" description={`Counted since this server process started${http?.mean_ms != null ? ` · ${http.mean_ms} ms mean` : ''}.`}>
          {httpTotal > 0 ? (
            <ul className="space-y-3">
              {HTTP_CLASSES.map(({ code, label, tone }) => {
                const count = Number(http?.by_class?.[code]) || 0
                const pct = (count / httpTotal) * 100
                return (
                  <li key={code}>
                    <div className="mb-1 flex items-baseline gap-2 text-sm">
                      <span className="text-ink-800">{label}</span>
                      <span className="font-mono text-2xs text-ink-500">{code}</span>
                      <span className="ml-auto tabular-nums text-fg"><Num value={count} /></span>
                      <span className="w-14 text-right text-xs tabular-nums text-ink-500">{pct.toFixed(1)}%</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-sm bg-ink-100" aria-hidden="true">
                      <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
                    </div>
                  </li>
                )
              })}
              <li className="pt-1 text-xs text-ink-500"><Num value={httpTotal} /> requests in total.</li>
            </ul>
          ) : (
            <p className="py-6 text-center text-sm text-ink-600">No requests recorded yet.</p>
          )}
        </Card>

        <Card title="Business volume" description="Records across every company on this deployment." padded={false}>
          <SimpleTable
            caption="Business volume"
            head={[{ label: 'Records' }, { label: 'Count', right: true }]}
            rows={(business || []).map((b) => ({ key: b.table, cells: [b.label, <Num key="n" value={b.count} />] }))}
            empty="No business tables reported."
          />
        </Card>

        <Card title="AI usage by model" description="This month." padded={false}>
          <SimpleTable
            caption="AI usage by model"
            head={[{ label: 'Model' }, { label: 'Calls', right: true }, { label: 'Tokens', right: true }, { label: 'Cost', right: true }]}
            rows={(ai?.by_model || []).map((m) => ({ key: m.model, cells: [<Code key="m">{m.model}</Code>, <Num key="c" value={m.calls} />, <Num key="t" value={m.tokens} />, fmtUsd(m.cost_usd)] }))}
            empty="No model calls recorded this month."
          />
        </Card>

        <Card title="Largest tables" description="Row counts are estimates." padded={false}>
          <SimpleTable
            caption="Largest tables"
            head={[{ label: 'Table' }, { label: 'Rows (est.)', right: true }, { label: 'Size', right: true }]}
            rows={(database?.largest_tables || []).map((t) => ({ key: t.table, cells: [<Code key="t">{t.table}</Code>, <Num key="r" value={t.est_rows} />, t.size] }))}
            empty="No table sizes reported."
          />
        </Card>
      </div>

      <section aria-labelledby="signups-title" className="space-y-2">
        <div>
          <h2 id="signups-title" className="text-sm font-semibold text-fg">Signups</h2>
          <p className="text-xs text-ink-500">Every account on this deployment, newest first — across all companies.{signups?.length ? ` ${signups.length} most recent.` : ''}</p>
        </div>
        <DataTable
          viewKey="admin.statistics.signups"
          caption="Signups"
          noun="account"
          rowKey={(s) => s.email}
          rows={signups || []}
          columns={signupColumns}
          defaultSort={{ id: 'created', dir: 'desc' }}
          searchPlaceholder="Search email or company"
          empty={{ title: 'No accounts yet', description: 'Accounts appear here as companies sign up.' }}
        />
      </section>
    </div>
  )
}
