import React, { useState } from 'react';
import api from '../../services/api';
import { ArrowPathIcon, WrenchScrewdriverIcon, ExclamationTriangleIcon } from '@heroicons/react/20/solid';
import { useResource } from '../../hooks/useResource';
import { keys } from '../../services/queryKeys';
import {
  Button, Card, PageHeader, EmptyState, ErrorState, Skeleton, StatusBadge, Select, Num,
} from '../../components/ui';
import LineWatchModule from '../../components/manufacturing/LineWatch'
import QualityReviews from '../../components/manufacturing/QualityReviews'

/**
 * Work-centre load and capacity.
 *
 * This screen used to display three invented work centres — "CNC Cutting
 * Station" at 80% utilisation and friends — because the endpoint behind it
 * referenced an unimported `pool`, threw, and fell back to hardcoded data.
 * There was no `work_centers` table in any of the 137 migrations, so there was
 * nothing it could have shown.
 *
 * It now reports real load from real routing (migration 137), and shows an
 * empty state when nothing is set up. A capacity screen that always looks
 * plausible is worse than one that admits it has nothing to say: people plan
 * against these numbers.
 */

const HORIZONS = [
  { value: 7, label: 'Next 7 days' },
  { value: 14, label: 'Next 2 weeks' },
  { value: 30, label: 'Next 30 days' },
  { value: 90, label: 'Next quarter' },
];

function LoadBar({ utilisation }) {
  // The bar is clamped at 100% because it cannot draw wider than its track —
  // but the number beside it is not, so a centre at 140% reads as 140%.
  // Clamping the figure too would hide precisely the overload this exists for.
  const width = Math.min(100, utilisation);
  const tone =
    utilisation > 100 ? 'bg-risk-600'
      : utilisation > 85 ? 'bg-warn-500'
        : 'bg-ink-500';

  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-ink-100"
      role="progressbar"
      aria-valuenow={utilisation}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`Capacity used: ${utilisation}%`}
    >
      <div className={`h-1.5 rounded-full transition-all ${tone}`} style={{ width: `${width}%` }} />
    </div>
  );
}

export default function WorkCenterDashboard() {
  const [horizon, setHorizon] = useState(7);

  const { data: workCenters, loading, error, refetch, isFetching } = useResource(
    keys.workCenterCapacity(horizon),
    ({ signal }) => api.get('/manufacturing/work-centers/capacity', {
      params: { horizon_days: horizon }, signal,
    })
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Work centres"
        description="Load against available capacity, from the routing on released work orders."
        secondary={
          <>
            <Select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))} className="w-40" aria-label="Horizon">
              {HORIZONS.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
            </Select>
            <Button variant="secondary" onClick={() => refetch()} loading={isFetching} icon={ArrowPathIcon}>
              Refresh
            </Button>
          </>
        }
      />

      <LineWatchModule />

      <QualityReviews />

      {loading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3" role="status" aria-live="polite">
          <span className="sr-only">Loading work centre capacity…</span>
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-56 w-full" />)}
        </div>
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : !workCenters?.length ? (
        <Card>
          <EmptyState
            icon={WrenchScrewdriverIcon}
            title="No work centres yet"
            description={
              'Capacity is calculated from work centres and the routing attached to your bills of '
              + 'material. Create a work centre, add operations to a BOM, and released work orders '
              + 'will start showing load here.'
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {workCenters.map((wc) => (
            <Card key={wc.id} className="space-y-4" padded>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className="font-mono text-xs text-ink-500">{wc.code}</span>
                  <h3 className="text-sm font-semibold text-fg">{wc.name}</h3>
                </div>
                <StatusBadge status={wc.load_status} />
              </div>

              <div className="space-y-1.5">
                <div className="flex justify-between text-xs text-ink-600 tabular-nums">
                  <span>
                    <Num value={wc.remaining_hours} digits={1} /> of <Num value={wc.available_hours} digits={1} /> hrs
                  </span>
                  <span className={wc.utilisation_pct > 100 ? 'font-semibold text-risk-600' : 'font-medium text-fg'}>
                    {wc.utilisation_pct}%
                  </span>
                </div>
                <LoadBar utilisation={wc.utilisation_pct} />
                <p className="text-xs text-ink-500">
                  {wc.daily_capacity_hours} hrs/day × {wc.working_days} working days
                  {wc.efficiency_pct !== 100 && ` at ${wc.efficiency_pct}% efficiency`}
                </p>
              </div>

              {wc.utilisation_pct > 100 && (
                <p className="flex items-start gap-1.5 rounded-md border border-risk-200 bg-risk-50 p-2.5 text-xs text-risk-800">
                  <ExclamationTriangleIcon className="mt-px h-4 w-4 shrink-0" aria-hidden="true" />
                  {/* Say how much over, not just that it is over — the size of
                      the overrun is what decides whether it is a re-sequence or
                      a subcontract. */}
                  Overloaded by {(wc.remaining_hours - wc.available_hours).toFixed(1)} hrs. Re-sequence or move work to another centre.
                </p>
              )}

              <dl className="grid grid-cols-2 gap-2 border-t border-ink-100 pt-3 text-xs">
                <div>
                  <dt className="text-ink-500">Work orders</dt>
                  <dd className="font-semibold tabular-nums text-fg">{wc.active_work_orders}</dd>
                </div>
                <div>
                  <dt className="text-ink-500">Open operations</dt>
                  <dd className="font-semibold tabular-nums text-fg">{wc.open_operations}</dd>
                </div>
              </dl>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
