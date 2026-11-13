import React from 'react';
import { useI18n } from '../../contexts/I18nContext';
import { PublicShell, PublicMessage } from '../../components/public/PublicPage';

const ThankYou = () => {
  const { t } = useI18n();
  return (
    <PublicShell width="narrow" context="Supplier portal">
      <PublicMessage tone="ok" title={t('ui.thankYou2')}>
        <p>{t('ui.yourQuotationHasBeenSubmittedSuccessfully')}</p>
        <p className="text-xs text-ink-500">{t('ui.youMayNowCloseThisWindow2')} {t('ui.ifYouHaveAnyQuestionsPlease')}</p>
      </PublicMessage>
    </PublicShell>
  );
};

export default ThankYou;
