import React from 'react';
import api from '../../services/api';
import { useParams } from 'react-router-dom';
import { useResource } from '../../hooks/useResource';
import { keys } from '../../services/queryKeys';
import { useI18n } from '../../contexts/I18nContext';
import { PublicShell, PublicHeader, PublicLoading, PublicMessage, PublicSection } from '../../components/public/PublicPage';
import { Button, Code, Money, StatusBadge, Badge, EmptyState, formatDate, daysFrom, describeError } from '../../components/ui';

// Public, token-authenticated portal page — supplierId travels from
// useParams into the URL path on every request, unchanged from before.
const SupplierPortalDashboard = () => {
  const { t } = useI18n();
  const { supplierId } = useParams();

  const { data: dashboardData, loading, error: queryError } = useResource(
    keys.supplierPortalDashboard(supplierId),
    async ({ signal }) => {
      const response = await api.get(`/supplier-portal/dashboard/${supplierId}`, { signal });
      const data = response.data;
      return { data };
    },
    { enabled: !!supplierId, retry: false, staleTime: 0 }
  );

  const shell = (children) => <PublicShell width="wide" context={t('ui.supplierPortal')}>{children}</PublicShell>;

  if (loading && supplierId) return shell(<PublicLoading />);

  if (queryError || !dashboardData) {
    const { reference } = describeError(queryError);
    return shell(
      <PublicMessage tone="risk" title={t('ui.unableToLoadDashboard')} reference={reference}>
        <p>{queryError?.response?.data?.error || queryError?.message || 'Supplier not found'}</p>
        <p>Open the portal from the most recent email you received from the buyer.</p>
      </PublicMessage>
    );
  }

  const { supplier, pending_rfqs = [], recent_responses = [] } = dashboardData;

  return shell(
    <div className="space-y-5">
      <PublicHeader
        eyebrow={t('ui.supplierPortal')}
        title={supplier?.company_name || 'Your requests'}
        status={supplier?.status ? <StatusBadge status={supplier.status} /> : null}
        description={[supplier?.contact_person, supplier?.email].filter(Boolean).join(' · ') || null}
      />

      <PublicSection
        title={t('ui.pendingRfqResponses')}
        description="Requests waiting for your quotation, soonest deadline first."
        aside={pending_rfqs.length ? <Badge tone="warn">{pending_rfqs.length} waiting</Badge> : null}
        padded={false}
      >
        {pending_rfqs.length === 0 ? (
          <EmptyState compact title={t('ui.noPendingRfqs')} description="New requests arrive by email and appear here." />
        ) : (
          <ul className="divide-y divide-ink-100">
            {pending_rfqs.map((rfq) => {
              const days = daysFrom(rfq.response_deadline);
              const overdue = days != null && days < 0;
              return (
                <li key={rfq.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Code className="text-sm font-medium text-fg">{rfq.rfq_number}</Code>
                      {overdue && <Badge tone="risk">{t('ui.overdue')}</Badge>}
                      {rfq.priority && ['HIGH', 'URGENT'].includes(String(rfq.priority).toUpperCase()) && <Badge tone="warn">{rfq.priority}</Badge>}
                    </div>
                    <p className="mt-0.5 truncate text-sm text-ink-800">{rfq.rfq_title}</p>
                    <p className="mt-0.5 text-xs text-ink-500">
                      Due {formatDate(rfq.response_deadline, { withTime: true })}
                      {rfq.customer_company_name ? ` · ${rfq.customer_company_name}` : ''}
                    </p>
                  </div>
                  <Button
                    variant="primary"
                    size="lg"
                    className="w-full sm:w-auto"
                    to={`/supplier/sales-rfq-response/${rfq.response_token || rfq.id}`}
                  >
                    {t('ui.respondToRfq')}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </PublicSection>

      <PublicSection title={t('ui.recentRfqResponses')} description="Your last ten responses." padded={false}>
        {recent_responses.length === 0 ? (
          <EmptyState compact title={t('ui.noResponsesYet')} description={t('ui.yourRfqResponsesWillAppearHere')} />
        ) : (
          <ul className="divide-y divide-ink-100">
            {recent_responses.map((rfq) => (
              <li key={rfq.id} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Code className="text-sm font-medium text-fg">{rfq.rfq_number}</Code>
                    <StatusBadge status={rfq.status} />
                  </div>
                  <p className="mt-0.5 truncate text-sm text-ink-800">{rfq.rfq_title}</p>
                  <p className="mt-0.5 text-xs text-ink-500">
                    Responded {formatDate(rfq.updated_at)}
                    {rfq.customer_company_name ? ` · ${rfq.customer_company_name}` : ''}
                  </p>
                </div>
                <Money amount={rfq.supplier_total_amount || null} currency={rfq.supplier_currency || 'USD'} className="shrink-0 text-sm" />
              </li>
            ))}
          </ul>
        )}
      </PublicSection>
    </div>
  );
};

export default SupplierPortalDashboard;
