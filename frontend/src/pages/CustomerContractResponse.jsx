import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import api from '../services/api';
import { useResource, useResourceMutation } from '../hooks/useResource';
import { keys } from '../services/queryKeys';
import { useI18n } from '../contexts/I18nContext';
import {
  PublicShell, PublicHeader, PublicLoading, PublicMessage, PublicSection,
  LineList, ChoiceGroup, PublicActions,
} from '../components/public/PublicPage';
import {
  Button, Field, Input, Textarea, InlineNotice, DescriptionList, Money, Code,
  formatDate, formatNumber, describeError, useFieldValidation,
} from '../components/ui';

const quantityRange = (item) => {
  const min = item.minimum_quantity;
  const max = item.maximum_quantity;
  if (min && max) return `${formatNumber(min)} – ${formatNumber(max)}`;
  if (min) return `Min ${formatNumber(min)}`;
  if (max) return `Max ${formatNumber(max)}`;
  return 'As needed';
};

const CustomerContractResponse = () => {
  const { t } = useI18n();
  const { token } = useParams();
  const [searchParams] = useSearchParams();
  const preselectedAction = searchParams.get('action');

  const [submitted, setSubmitted] = useState(false);
  const [selectedAction, setSelectedAction] = useState(
    preselectedAction === 'accept' || preselectedAction === 'reject' ? preselectedAction : ''
  );
  const [customerNotes, setCustomerNotes] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [choiceError, setChoiceError] = useState('');
  const [submitError, setSubmitError] = useState('');

  // Portal token can expire mid-session; retrying a 401 three times is worse
  // than failing once with a clear message.
  const { data: contract, loading, error: queryError } = useResource(
    keys.customerContractResponse(token),
    ({ signal }) => api.get(`/sales-contracts/customer-response/${token}`, { signal }),
    { enabled: !!token, retry: false, staleTime: 0 }
  );

  useEffect(() => {
    if (contract) {
      setCustomerName(contract.customer_name || '');
      setCustomerEmail(contract.customer_email || '');
    }
  }, [contract]);

  const values = useMemo(() => ({ customerName, customerEmail }), [customerName, customerEmail]);
  const rules = useMemo(() => ({
    customerName: (v) => (!v?.trim() ? `${t('ui.pleaseEnterYourName')}.` : null),
    customerEmail: (v) => (!v?.trim() ? `${t('ui.pleaseEnterYourEmail')}.`
      : !/\S+@\S+\.\S+/.test(v) ? 'Enter a full email address, like name@company.com.' : null),
  }), [t]);
  const { errors, onBlur, validateAll } = useFieldValidation(values, rules);

  const submitMutation = useResourceMutation(
    (payload) => api.post(`/sales-contracts/customer-response/${token}`, payload),
    { silent: true }
  );
  const submitting = submitMutation.isPending;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitError('');
    const all = validateAll();
    if (!selectedAction) setChoiceError(`${t('ui.pleaseSelectAcceptOrDecline')}.`);
    const first = Object.keys(all)[0];
    if (first) document.getElementById(first)?.focus();
    if (!selectedAction || first) return;

    try {
      await submitMutation.mutateAsync({
        action: selectedAction,
        customer_name: customerName,
        customer_email: customerEmail,
        comments: customerNotes,
      });
      setSubmitted(true);
    } catch (error) {
      setSubmitError(error.response?.data?.error || t('ui.failedToSubmitResponse'));
    }
  };

  const shell = (children) => <PublicShell context="Contract">{children}</PublicShell>;

  if (loading && token) return shell(<PublicLoading />);

  if (queryError || !token) {
    const { reference } = describeError(queryError);
    return shell(
      <PublicMessage tone="risk" title="This contract link does not work" reference={reference}>
        <p>
          {queryError?.response?.status === 404 || !token
            ? t('ui.contractNotFound')
            : t('ui.failedToLoadContractDetails')}
        </p>
        <p>If you still need to respond, reply to the email the contract came with and ask for a new link.</p>
      </PublicMessage>
    );
  }

  if (submitted) {
    return shell(
      <PublicMessage tone="ok" title={selectedAction === 'accept' ? 'Contract accepted' : 'Contract declined'}>
        <p>Thank you for your response to contract <Code>{contract?.contract_number}</Code>.</p>
        <p>{selectedAction === 'accept' ? t('ui.weWillProcessYourAcceptance') : t('ui.weApprecciateYourConsideration')}</p>
        <p className="text-xs text-ink-500">You may now close this window.</p>
      </PublicMessage>
    );
  }

  const currency = contract?.currency || 'USD';
  const items = contract?.items || [];

  return shell(
    <div className="space-y-5">
      <PublicHeader
        eyebrow="Sales contract"
        title={contract?.contract_name || <Code>{contract?.contract_number}</Code>}
        description={
          <>
            <Code>{contract?.contract_number}</Code> · {formatDate(contract?.start_date)} – {formatDate(contract?.end_date)} · Review it and accept or decline.
          </>
        }
      />

      <PublicSection title="Contract details">
        <DescriptionList
          items={[
            { label: 'Contract value', value: <Money amount={contract?.contract_value} currency={currency} className="font-medium" /> },
            { label: 'Customer', value: contract?.customer_name },
            { label: 'Contract type', value: contract?.contract_type },
            { label: 'Period', value: `${formatDate(contract?.start_date)} – ${formatDate(contract?.end_date)}` },
            contract?.auto_renewal && { label: 'Auto renewal', value: `Every ${contract.renewal_period_months} months` },
            contract?.payment_terms && { label: 'Payment terms', value: contract.payment_terms },
            contract?.delivery_terms && { label: 'Delivery terms', value: contract.delivery_terms },
            contract?.notes && { label: 'Notes', value: contract.notes, wide: true },
          ]}
        />
      </PublicSection>

      {contract?.terms_and_conditions && (
        <PublicSection title="Terms and conditions">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-800">{contract.terms_and_conditions}</p>
        </PublicSection>
      )}

      {items.length > 0 && (
        <PublicSection title="Contract items" padded={false}>
          <LineList
            label="Contract items"
            rows={items}
            columns={[
              {
                key: 'item', label: 'Item',
                render: (r) => (
                  <div>
                    <div className="font-medium">{r.item_name}</div>
                    {r.item_description && <div className="text-xs text-ink-500">{r.item_description}</div>}
                  </div>
                ),
              },
              { key: 'price', label: 'Unit price', align: 'right', render: (r) => <Money amount={r.unit_price} currency={currency} /> },
              { key: 'uom', label: 'Unit', render: (r) => r.unit_of_measure },
              { key: 'range', label: 'Quantity', align: 'right', render: quantityRange },
            ]}
          />
        </PublicSection>
      )}

      <PublicSection title="Your response">
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Your name" error={errors.customerName} id="customerName">
              <Input size="lg" name="customer_name" autoComplete="name" value={customerName}
                onChange={(e) => setCustomerName(e.target.value)} onBlur={onBlur('customerName')} />
            </Field>
            <Field label="Your email" error={errors.customerEmail} id="customerEmail">
              <Input size="lg" type="email" name="customer_email" autoComplete="email" value={customerEmail}
                onChange={(e) => setCustomerEmail(e.target.value)} onBlur={onBlur('customerEmail')} />
            </Field>
          </div>
          <ChoiceGroup
            legend="Decision"
            name="action"
            value={selectedAction}
            onChange={(v) => { setSelectedAction(v); setChoiceError(''); }}
            error={choiceError}
            options={[
              { value: 'accept', label: 'Accept and sign', description: 'Your name and email are recorded as the signature.' },
              { value: 'reject', label: 'Decline', description: 'The contract is closed. Say why in the comments if you can.' },
            ]}
          />
          <Field label="Comments" optional id="comments" help="Questions or conditions for the sales team.">
            <Textarea name="comments" rows={4} value={customerNotes} onChange={(e) => setCustomerNotes(e.target.value)} />
          </Field>
          {submitError && <InlineNotice tone="risk" title="Not sent">{submitError}</InlineNotice>}
          <PublicActions>
            <Button type="submit" size="lg" variant={selectedAction === 'reject' ? 'destructive' : 'primary'} loading={submitting}>
              {selectedAction === 'accept' ? 'Accept and sign contract' : selectedAction === 'reject' ? 'Decline contract' : 'Send response'}
            </Button>
          </PublicActions>
        </form>
      </PublicSection>
    </div>
  );
};

export default CustomerContractResponse;
