import React from 'react'

/**
 * What Simeli reached into, grouped the way the business is organised:
 * module → area → what was counted there.
 *
 *   Finance
 *   └─ Receivables
 *       └─ 38 invoices reviewed
 *
 * Every line is counted from a tool result (see services/ai/agentNarration.js).
 * A tool that returned nothing shows "nothing found", not a blank — the two are
 * different findings and the second is often the answer.
 *
 * A tool that could not run at all — `analysis_ran: false` from the anomaly
 * detector, `sufficient_data: false` from the backtester — says "not enough
 * data to test" rather than reporting zero. Zero means "this ran and found
 * nothing", which is a much stronger and quite different claim.
 */

/** "38 invoices" — with the unit de-pluralised at one. */
function countLabel(n, unit) {
  if (!unit) return n.toLocaleString()
  const one = n === 1 && unit.endsWith('s') ? unit.slice(0, -1) : unit
  return `${n.toLocaleString()} ${one}`
}

/**
 * @param calls [{ name, meta:{module,area,noun}, digest, status }]
 */
export default function AgentActivity({ calls, working, bare }) {
  const tree = React.useMemo(() => {
    const byModule = new Map()
    for (const call of calls || []) {
      const module = call.meta?.module || 'Data'
      const area = call.meta?.area || 'Records'
      if (!byModule.has(module)) byModule.set(module, new Map())
      const areas = byModule.get(module)
      if (!areas.has(area)) areas.set(area, [])
      areas.get(area).push(call)
    }
    return byModule
  }, [calls])

  if (!calls?.length) return null

  const toolCount = calls.length
  // "Insights" is not a vibe: it is the number of calls that found something
  // countable. A call that returned an empty set did not discover anything.
  const found = calls.filter((c) => c.digest && !c.digest.empty && (c.digest.count > 0 || c.digest.figures?.length)).length

  return (
    <div className={bare ? '' : 'sim-panel'}>
      <div className="sim-panel-head">
        <span
          className={`inline-block h-1.5 w-1.5 flex-none rounded-full ${working ? 'bg-cyan-300' : 'bg-slate-500'}`}
          style={working ? { boxShadow: '0 0 8px 2px rgba(34,211,238,0.85)' } : undefined}
        />
        {working ? 'Investigating' : 'Investigated'}
      </div>

      <div className="sim-tree px-3.5 pb-3">
        {[...tree.entries()].map(([module, areas]) => (
          <div key={module} className="mb-2 last:mb-0">
            <div className="sim-tree-module">{module}</div>
            {[...areas.entries()].map(([area, items]) => (
              <div key={area} className="sim-tree-branch">
                {area}
                {items.map((call, i) => {
                  const d = call.digest
                  let leaf
                  if (call.status === 'running') leaf = 'reading…'
                  else if (call.status === 'error') leaf = call.error || 'failed'
                  else if (call.status === 'denied') leaf = 'not approved'
                  else if (!d) leaf = 'done'
                  else if (d.inconclusive) leaf = 'not enough data to test'
                  else if (d.count !== undefined) leaf = d.count === 0 ? 'nothing found' : countLabel(d.count, d.unit)
                  else if (d.figures?.length) leaf = `${d.figures.length} figure${d.figures.length === 1 ? '' : 's'}`
                  else leaf = d.headline || 'done'

                  return (
                    <div key={`${call.name}-${i}`} className="sim-tree-branch">
                      <span className={`sim-tree-leaf ${call.status === 'error' ? 'text-rose-300' : ''}`}>
                        {leaf}
                      </span>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        ))}

        <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-[color:var(--embmis-line-soft)] pt-2.5">
          <span className="rounded-md border border-[color:var(--sim-line)] px-1.5 py-0.5 text-[10.5px] text-[color:var(--embmis-text-faint)]">
            {countLabel(toolCount, 'tools')} used
          </span>
          {found > 0 && (
            <span className="rounded-md border border-[color:var(--sim-line)] px-1.5 py-0.5 text-[10.5px] text-[color:var(--embmis-text-faint)]">
              {countLabel(found, 'returned results')}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export { countLabel }
