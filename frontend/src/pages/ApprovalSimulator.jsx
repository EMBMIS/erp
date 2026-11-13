import { useMemo, useState } from 'react'
import { ArrowPathIcon } from '@heroicons/react/20/solid'
import api from '../services/api'
import { useResource } from '../hooks/useResource'
import { keys } from '../services/queryKeys'
import {
  PageHeader, Button, Card, Field, Input, Select, Badge, Code, Money, ErrorState, EmptyState, SkeletonRows, InlineNotice,
  formatMoney, formatDate,
} from '../components/ui'

/**
 * Approval routing simulator.
 *
 * POST /approval-chains/simulate runs the DoA engine without creating a
 * document. Pick a document type, amount and cost centre; the chain the
 * engine would produce appears beside the inputs and updates as they change.
 * Each step is annotated with the active DoA rules whose type and amount
 * band cover the input, read from the rules table.
 *
 * Response: { requires_approval, document_type, amount,
 *             approvers: [{ level, approver, role, is_delegated, original_approver }],
 *             matching_chains, evaluated_at }
 */
const EMPTY_RESULT = { requires_approval: false, document_type: null, amount: 0, approvers: [], matching_chains: 0, evaluated_at: null }
const list = (d) => (Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [])

export default function ApprovalSimulator() {
  const [category, setCategory] = useState('all')
  const [documentType, setDocumentType] = useState('PURCHASE_ORDERS')
  const [amount, setAmount] = useState('50000')
  const [costCenter, setCostCenter] = useState('ALL')

  const { data: config, loading: configLoading } = useResource(keys.approvalSimulationConfig(), ({ signal }) => api.get('/delegation-of-authority/config', { signal }))
  const transactionTypes = useMemo(() => config?.transaction_types || [], [config])
  const costCenters = config?.cost_centers || []

  const { data: doaRules } = useResource(
    keys.delegationOfAuthority({ is_active: true }),
    ({ signal }) => api.get('/delegation-of-authority', { signal, params: { is_active: true } }),
    { retry: false }
  )
  const rules = list(doaRules)

  const visibleTypes = useMemo(() => (category === 'all' ? transactionTypes : transactionTypes.filter((t) => t.category === category)), [category, transactionTypes])
  const categories = [...new Set(transactionTypes.map((t) => t.category))]

  const payload = useMemo(() => ({
    document_type: documentType,
    amount: Number(amount || 0),
    cost_center_id: costCenter === 'ALL' ? null : costCenter,
  }), [documentType, amount, costCenter])

  const { data: result, isFetching, error, refetch } = useResource(
    keys.approvalSimulation(payload),
    ({ signal }) => api.post('/approval-chains/simulate', payload, { signal }),
    { retry: false }
  )
  const sim = result || EMPTY_RESULT
  const typeLabel = transactionTypes.find((t) => t.value === documentType)?.label || documentType

  // Active rules whose type and amount band cover the simulated input.
  const amountNum = Number(amount || 0)
  const covering = rules.filter((r) =>
    [String(documentType).toUpperCase(), 'ALL'].includes(String(r.applies_to || '').toUpperCase()) &&
    Number(r.min_amount || 0) <= amountNum &&
    (r.max_amount == null || Number(r.max_amount) >= amountNum)
  )

  // The engine answers with user ids; the rules table knows their names.
  const nameOf = (id) => rules.find((r) => String(r.user_id) === String(id))?.user_name

  return (
    <>
      <PageHeader
        title="Approval simulator"
        description="See the exact approver chain the rules would produce for a document, before anyone raises one."
        secondary={<Button to="/approvals/unified">Approval inbox</Button>}
        primary={<Button to="/delegation-of-authority">Manage rules</Button>}
      />

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        <Card title="Inputs" description="The chain updates as you change them.">
          {configLoading ? <SkeletonRows rows={4} columns={1} /> : (
            <div className="space-y-4">
              <Field label="Category" id="sim-category">
                <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="all">All categories</option>
                  {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                </Select>
              </Field>
              <Field label="Document type" id="sim-entity">
                <Select value={documentType} onChange={(e) => setDocumentType(e.target.value)}>
                  {visibleTypes.length === 0 && <option value={documentType}>{documentType}</option>}
                  {visibleTypes.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </Select>
              </Field>
              <Field label="Amount" help="In USD. Try an amount either side of a rule's limit." id="sim-amount">
                <Input type="number" min="0" step="any" numeric value={amount} onChange={(e) => setAmount(e.target.value)} />
              </Field>
              <Field label="Cost centre" id="sim-cost-center">
                <Select value={costCenter} onChange={(e) => setCostCenter(e.target.value)}>
                  <option value="ALL">Not specified</option>
                  {costCenters.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </Select>
              </Field>
              <Button block icon={ArrowPathIcon} onClick={() => refetch()} loading={isFetching}>Run again</Button>
            </div>
          )}
        </Card>

        <Card
          title="Approver chain"
          description={<>{typeLabel} · <Money amount={amountNum} />{costCenter !== 'ALL' ? ` · ${costCenter}` : ''}</>}
          actions={!error && !isFetching && result ? (sim.requires_approval ? <Badge tone="warn" glyph="clock">Approval required</Badge> : <Badge tone="ok" glyph="check">No approval required</Badge>) : null}
        >
          {error ? (
            <ErrorState compact what="The simulation" error={error} onRetry={refetch} />
          ) : isFetching && !result ? (
            <SkeletonRows rows={3} columns={2} />
          ) : sim.approvers.length === 0 ? (
            <EmptyState
              compact
              title={sim.requires_approval ? 'No approver steps found' : 'This document would not need approval'}
              description={sim.requires_approval ? 'The engine says approval is required but produced no steps. Check the rules for this type and amount.' : 'The amount is zero or no rule matches this type, amount and cost centre.'}
            />
          ) : (
            <ol className="space-y-3" aria-busy={isFetching}>
              {sim.approvers.map((step, i) => (
                <li key={`${step.level}-${step.approver}-${i}`} className="flex items-start gap-3 rounded-md border border-ink-200 px-3 py-2.5">
                  <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-ink-300 font-mono text-xs tabular-nums text-ink-700">{step.level || i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
                      {nameOf(step.approver) || step.role || 'Approver'}
                      {step.role && nameOf(step.approver) && <span className="font-normal text-ink-600">{step.role}</span>}
                      {step.is_delegated && <Badge tone="brand">Delegated</Badge>}
                    </p>
                    <p className="mt-0.5 break-all text-xs text-ink-600">
                      <Code>{step.approver || '—'}</Code>
                      {step.is_delegated && step.original_approver && <span> · on behalf of {nameOf(step.original_approver) || <Code>{step.original_approver}</Code>}</span>}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {!error && result && (
            <p className="mt-3 text-xs text-ink-500">
              {sim.matching_chains} matching approval chain{sim.matching_chains === 1 ? '' : 's'} · evaluated {sim.evaluated_at ? formatDate(sim.evaluated_at, { withTime: true }) : '—'}
            </p>
          )}
        </Card>
      </div>

      <Card className="mt-5" title="Rules covering this input" description="Active rules whose type and amount band include this document." padded={false}>
        {covering.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-600">No active rule covers {typeLabel.toLowerCase()} at {formatMoney(amountNum)}. </p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {covering.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
                <span className="font-medium text-fg">{r.user_name || r.user_email || '—'}</span>
                <span className="tabular-nums text-ink-700">{formatMoney(r.min_amount || 0, r.currency)} – {r.max_amount == null ? 'no limit' : formatMoney(r.max_amount, r.currency)}</span>
                <span className="text-ink-600">{r.applies_to === 'ALL' ? 'All transactions' : typeLabel} · cost centre {r.cost_center || 'any'}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {error && (
        <InlineNotice tone="ink" className="mt-5" title="What was sent">
          <Code>POST /approval-chains/simulate {JSON.stringify(payload)}</Code>
        </InlineNotice>
      )}
    </>
  )
}
