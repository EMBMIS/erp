import React from 'react';
import { useLocation } from 'react-router-dom';
import { useI18n } from '../contexts/I18nContext';
import { PublicShell, PublicMessage } from '../components/public/PublicPage';
import { Code } from '../components/ui';

const DeliveryConfirmationSuccess = () => {
  const { t } = useI18n();
  const location = useLocation();
  const { message, orderNumber, isIssue } = location.state || {};

  const defaultMessage = isIssue
    ? 'Your delivery issue has been reported. Our team will contact you shortly.'
    : 'Thank you for confirming your delivery.';

  return (
    <PublicShell width="narrow" context="Delivery">
      <PublicMessage tone={isIssue ? 'warn' : 'ok'} title={isIssue ? 'Problem reported' : 'Delivery confirmed'}>
        {orderNumber && <p>Order <Code>{orderNumber}</Code></p>}
        <p>{message || defaultMessage}</p>
        {isIssue ? (
          <ul className="mx-auto max-w-xs list-disc space-y-1 pl-5 text-left">
            <li>{t('ui.ourCustomerServiceTeamWillReview').replace(/^•\s*/, '')}</li>
            <li>{t('ui.weLlContactYouWithin24').replace(/^•\s*/, '')}</li>
            <li>{t('ui.youLlReceiveUpdatesViaEmail').replace(/^•\s*/, '')}</li>
          </ul>
        ) : (
          <p>Your confirmation has been recorded and the order is complete.</p>
        )}
        <p className="text-xs text-ink-500">You can close this window. Questions? Reply to the email that brought you here.</p>
      </PublicMessage>
    </PublicShell>
  );
};

export default DeliveryConfirmationSuccess;
