import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import clsx from 'clsx';
import api from '../../services/api';
import { useResource, useResourceMutation } from '../../hooks/useResource';
import { keys } from '../../services/queryKeys';
import { useI18n } from '../../contexts/I18nContext';
import {
  PublicShell, PublicHeader, PublicLoading, PublicMessage, PublicSection, PublicActions,
} from '../../components/public/PublicPage';
import { Button, Field, Textarea, InlineNotice, DescriptionList, Code, describeError } from '../../components/ui';

/** Two large radio options for one item: can supply / cannot supply. */
function SupplyChoice({ itemId, itemName, value, onChange }) {
  const opts = [
    { v: 'confirmed', label: 'Can supply' },
    { v: 'rejected', label: 'Cannot supply' },
  ];
  return (
    <fieldset>
      <legend className="sr-only">Can you supply {itemName}?</legend>
      <div className="grid grid-cols-2 gap-2 sm:w-72">
        {opts.map((o) => {
          const checked = value === o.v;
          return (
            <label
              key={o.v}
              className={clsx(
                'flex min-h-[44px] cursor-pointer items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium',
                'focus-within:ring-[3px] focus-within:ring-brand-500/20',
                checked
                  ? (o.v === 'confirmed' ? 'border-ok-600 bg-ok-50 text-ok-800' : 'border-risk-600 bg-risk-50 text-risk-800')
                  : 'border-ink-300 bg-surface text-ink-800 hover:border-ink-400'
              )}
            >
              <input type="radio" className="sr-only" name={`supply-${itemId}`} value={o.v} checked={checked} onChange={() => onChange(o.v)} />
              <span aria-hidden="true">{checked ? (o.v === 'confirmed' ? '✓' : '✕') : ''}</span>
              {o.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

// Public, token-authenticated portal page — token travels from useParams into
// the URL path on every request, unchanged from before.
function SupplierItemConfirmation() {
  const { t } = useI18n();
  const { token } = useParams();
  const [submitted, setSubmitted] = useState(null);
  const [selectedItems, setSelectedItems] = useState({});
  const [rejectionReason, setRejectionReason] = useState('');
  const [formError, setFormError] = useState('');
  const [reasonError, setReasonError] = useState('');
  const [submitError, setSubmitError] = useState('');

  const { data: confirmationData, loading, error: queryError } = useResource(
    keys.supplierItemConfirmation(token),
    ({ signal }) => api.get(`/supplier-confirmation/${token}`, { signal }),
    { enabled: !!token, retry: false, staleTime: 0 }
  );

  useEffect(() => {
    if (confirmationData?.items) {
      const initialSelection = {};
      confirmationData.items.forEach((item) => {
        initialSelection[item.id] = 'pending'; // pending, confirmed, rejected
      });
      setSelectedItems(initialSelection);
    }
  }, [confirmationData]);

  const handleItemSelection = (itemId, action) => {
    setSelectedItems((prev) => ({ ...prev, [itemId]: action }));
    setFormError('');
  };

  const confirmMutation = useResourceMutation(
    (payload) => api.post(`/supplier-confirmation/${token}/confirm`, payload),
    {
      silent: true,
      invalidates: [keys.supplierItemConfirmation(token)],
      onSuccess: (result) => setSubmitted(result || {}),
      onError: (err) => setSubmitError(err.response?.data?.error || err.message || 'Your confirmation was not sent. Try again.'),
    }
  );
  const submitting = confirmMutation.isPending;

  const handleSubmit = (e) => {
    e.preventDefault();
    setSubmitError('');

    const confirmedItems = Object.entries(selectedItems).filter(([, s]) => s === 'confirmed').map(([id]) => id);
    const rejectedItems = Object.entries(selectedItems).filter(([, s]) => s === 'rejected').map(([id]) => id);

    if (confirmedItems.length === 0 && rejectedItems.length === 0) {
      setFormError('Mark at least one item as "Can supply" or "Cannot supply".');
      return;
    }
    if (rejectedItems.length > 0 && !rejectionReason.trim()) {
      setReasonError('Say why you cannot supply the items marked "Cannot supply".');
      document.getElementById('rejection-reason')?.focus();
      return;
    }

    confirmMutation.mutate({
      confirmed_items: confirmedItems,
      rejected_items: rejectedItems,
      rejection_reason: rejectionReason.trim(),
    });
  };

  const shell = (children) => <PublicShell context="Supplier item confirmation">{children}</PublicShell>;

  if (loading && token) return shell(<PublicLoading label={t('ui.loadingConfirmationDetails')} />);

  if (queryError || !confirmationData) {
    const { reference } = describeError(queryError);
    const msg = queryError?.message && queryError.message !== 'The request did not succeed.'
      ? queryError.message
      : 'Invalid or expired confirmation link';
    return shell(
      <PublicMessage tone="risk" title={t('ui.confirmationNotAvailable')} reference={reference}>
        <p>{msg}</p>
        <p>Reply to the email this link came with to ask for a new one.</p>
      </PublicMessage>
    );
  }

  if (submitted) {
    const c = submitted.confirmed_count;
    const r = submitted.rejected_count;
    return shell(
      <PublicMessage tone="ok" title={t('ui.confirmationSubmitted')}>
        {c != null && r != null && <p>{c} confirmed, {r} declined.</p>}
        <p>{t('ui.thankYouForYourConfirmationThe')}</p>
        <p className="text-xs text-ink-500">{t('ui.youCanCloseThisPageNow')}</p>
      </PublicMessage>
    );
  }

  const { supplier, items = [] } = confirmationData;
  const hasRejections = Object.values(selectedItems).some((s) => s === 'rejected');
  const answered = Object.values(selectedItems).filter((s) => s !== 'pending').length;

  return shell(
    <div className="space-y-5">
      <PublicHeader
        eyebrow="Item confirmation"
        title="Which of these items can you supply?"
        description={t('ui.pleaseReviewTheItemsBelowAnd')}
      />

      <PublicSection title="Your company">
        <DescriptionList items={[
          { label: 'Company name', value: supplier?.legal_name },
          { label: 'Contact email', value: supplier?.email },
        ]} />
      </PublicSection>

      <form onSubmit={handleSubmit} className="space-y-5" noValidate>
        <PublicSection title={`Items (${items.length})`} aside={<span className="text-xs text-ink-500">{answered} of {items.length} answered</span>} padded={false}>
          <ul className="divide-y divide-ink-100">
            {items.map((item) => (
              <li key={item.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-fg">{item.item_name}</p>
                  <p className="mt-0.5 text-xs text-ink-500">
                    {[item.sku && <Code key="sku">{item.sku}</Code>, item.category, item.unit_of_measure].filter(Boolean).reduce((acc, x, i) => (i ? [...acc, ' · ', x] : [x]), [])}
                  </p>
                  {item.description && <p className="mt-1 text-xs text-ink-600">{item.description}</p>}
                </div>
                <SupplyChoice itemId={item.id} itemName={item.item_name} value={selectedItems[item.id]} onChange={(v) => handleItemSelection(item.id, v)} />
              </li>
            ))}
          </ul>
        </PublicSection>

        {hasRejections && (
          <Field label="Why can't you supply the declined items?" id="rejection-reason" error={reasonError} help="The buyer sees this.">
            <Textarea
              rows={3}
              value={rejectionReason}
              onChange={(e) => { setRejectionReason(e.target.value); if (reasonError) setReasonError(''); }}
              placeholder={t('ui.eGItemNotInOur')}
            />
          </Field>
        )}

        {formError && <InlineNotice tone="risk">{formError}</InlineNotice>}
        {submitError && <InlineNotice tone="risk" title="Not sent">{submitError}</InlineNotice>}

        <PublicActions note="Items you leave unanswered stay open.">
          <Button type="submit" size="lg" variant="primary" loading={submitting}>Submit confirmation</Button>
        </PublicActions>
      </form>
    </div>
  );
}

export default SupplierItemConfirmation;
