import React, { useState } from 'react';
import api from '../../services/api';
import { useParams } from 'react-router-dom';
import { useResource, useResourceMutation } from '../../hooks/useResource';
import { keys } from '../../services/queryKeys';
import { useI18n } from '../../contexts/I18nContext';
import {
  PublicShell, PublicHeader, PublicLoading, PublicMessage, PublicSection, PublicActions,
} from '../../components/public/PublicPage';
import { Button, Field, Textarea, InlineNotice, DescriptionList, Code, ConfirmDialog, describeError } from '../../components/ui';

// Public, token-authenticated portal page — the supplierId travels from
// useParams into the URL path on every request, unchanged from before.
const PartnershipInvitation = () => {
  const { t } = useI18n();
  const { supplierId } = useParams();
  const [partnershipStatusOverride, setPartnershipStatusOverride] = useState(null); // 'accepted', 'declined'
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [actionError, setActionError] = useState('');

  const { data, loading, error: queryError } = useResource(
    keys.supplierPortalPartnership(supplierId),
    ({ signal }) => api.get(`/supplier-portal/supplier/${supplierId}`, { signal }),
    { enabled: !!supplierId, retry: false, staleTime: 0 }
  );

  const supplierData = data?.supplier || null;

  const partnershipStatus = partnershipStatusOverride || (
    data?.message === 'already_accepted' ? 'accepted' :
    data?.message === 'already_declined' ? 'declined' :
    data ? 'pending' : null
  );

  const acceptMutation = useResourceMutation(
    async () => {
      const response = await api.post(`/supplier-portal/partnership/accept/${supplierId}`);
      if (!response.data) throw new Error('Failed to accept partnership');
      return { data: { success: true, data: null } };
    },
    {
      silent: true,
      invalidates: [keys.supplierPortalPartnership(supplierId)],
      onSuccess: () => setPartnershipStatusOverride('accepted'),
      onError: (err) => setActionError(err.response?.data?.error || 'The partnership was not accepted. Try again in a minute.'),
    }
  );

  const declineMutation = useResourceMutation(
    async (reason) => {
      const response = await api.post(`/supplier-portal/partnership/decline/${supplierId}`, { reason: reason || '' });
      if (!response.data) throw new Error('Failed to decline partnership');
      return { data: { success: true, data: null } };
    },
    {
      silent: true,
      invalidates: [keys.supplierPortalPartnership(supplierId)],
      onSuccess: () => { setDeclineOpen(false); setPartnershipStatusOverride('declined'); },
      onError: (err) => { setDeclineOpen(false); setActionError(err.response?.data?.error || 'The decline was not recorded. Try again in a minute.'); },
    }
  );

  const submitting = acceptMutation.isPending || declineMutation.isPending;

  const handleAccept = () => { setActionError(''); acceptMutation.mutate(); };

  const shell = (children) => <PublicShell context="Supplier partnership">{children}</PublicShell>;

  if (loading && supplierId) return shell(<PublicLoading label={t('ui.verifyingInvitation')} />);

  if (partnershipStatus === 'accepted') {
    return shell(
      <PublicMessage tone="ok" title={t('ui.partnershipAccepted')}>
        <p>
          Thank you{supplierData?.legal_name ? `, ${supplierData.legal_name}` : ''}. You are now an approved supplier.
          Requests for quotation and purchase orders will arrive by email, each with a link to respond.
        </p>
        <p className="text-xs text-ink-500">You can close this window.</p>
      </PublicMessage>
    );
  }

  if (partnershipStatus === 'declined') {
    return shell(
      <PublicMessage tone="ink" title={t('ui.partnershipDeclined')}>
        <p>
          Your answer has been recorded{supplierData?.legal_name ? ` for ${supplierData.legal_name}` : ''} and the buying team has been told.
          If you change your mind, reply to the invitation email.
        </p>
      </PublicMessage>
    );
  }

  if (!supplierId || queryError) {
    const { reference } = describeError(queryError);
    return shell(
      <PublicMessage tone="risk" title={t('ui.invalidInvitation')} reference={reference}>
        <p>
          {!supplierId
            ? 'This link is incomplete.'
            : queryError?.response?.status === 404
              // A 404 means the supplier row behind this link no longer exists
              // (removed, or the invitation predates a data reset).
              ? t('ui.invitationLinkInvalid')
              : queryError?.message}
        </p>
        <p>Reply to the invitation email to ask for a new link.</p>
      </PublicMessage>
    );
  }

  const address = [supplierData?.address, [supplierData?.city, supplierData?.country].filter(Boolean).join(', ')]
    .filter(Boolean).join('\n');

  return shell(
    <div className="space-y-5">
      <PublicHeader
        eyebrow={t('ui.partnershipInvitation')}
        title={supplierData?.legal_name || 'Supplier partnership'}
        description="You have been invited to become an approved supplier. Check the details we hold for you, then accept or decline."
      />

      <PublicSection title="Your company details" description="Reply to the invitation email if anything here is wrong.">
        <DescriptionList
          items={[
            { label: 'Legal name', value: supplierData?.legal_name },
            supplierData?.trade_name && { label: 'Trade name', value: supplierData.trade_name },
            { label: 'Supplier code', value: supplierData?.supplier_code ? <Code>{supplierData.supplier_code}</Code> : null },
            { label: 'Email', value: supplierData?.email },
            supplierData?.phone && { label: 'Phone', value: supplierData.phone },
            address && { label: 'Address', value: <span className="whitespace-pre-line">{address}</span> },
          ]}
        />
      </PublicSection>

      <PublicSection title="What you agree to">
        <p className="text-sm text-ink-700">{t('ui.byAcceptingThisPartnershipYouAgree')}</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-700">
          <li>{t('ui.provideQualityProductsAndServicesAs')}</li>
          <li>{t('ui.maintainCompetitivePricingAndDeliverySchedules')}</li>
          <li>Follow the buyer&apos;s procurement policies</li>
          <li>{t('ui.respondToRfqsAndPurchaseOrders')}</li>
          <li>{t('ui.maintainAccurateBusinessAndContactInformation')}</li>
        </ul>
      </PublicSection>

      {actionError && <InlineNotice tone="risk" title="Not saved">{actionError}</InlineNotice>}

      <PublicActions note={t('ui.thisInvitationWillExpireIn7')}>
        <Button size="lg" variant="destructive" onClick={() => { setActionError(''); setDeclineReason(''); setDeclineOpen(true); }} disabled={submitting}>
          {t('ui.declinePartnership')}
        </Button>
        <Button size="lg" variant="primary" onClick={handleAccept} loading={acceptMutation.isPending} disabled={submitting}>
          {t('ui.acceptPartnership')}
        </Button>
      </PublicActions>

      <ConfirmDialog
        open={declineOpen}
        onClose={() => setDeclineOpen(false)}
        onConfirm={() => declineMutation.mutate(declineReason.trim())}
        busy={declineMutation.isPending}
        title="Decline this partnership?"
        confirmLabel="Decline partnership"
        consequence="The buying team is told you declined. They will not send you requests through this invitation."
      >
        <Field label="Reason" optional id="decline-reason" help="Helps the buyer understand. They see this.">
          <Textarea rows={3} value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </div>
  );
};

export default PartnershipInvitation;
