import React, { useState } from 'react'
import { useParams } from 'react-router-dom'
import { ArrowDownTrayIcon, ArrowTopRightOnSquareIcon } from '@heroicons/react/20/solid'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import api from '../../services/api'
import { keys } from '../../services/queryKeys'
import { useI18n } from '../../contexts/I18nContext'
import {
  PublicShell, PublicHeader, PublicLoading, PublicMessage, PublicSection, PublicActions,
} from '../../components/public/PublicPage'
import {
  Button, InlineNotice, DescriptionList, Code, Money, Badge, ConfirmDialog, formatDate, describeError,
} from '../../components/ui'

const timeRemaining = (due) => {
  if (!due) return null
  const diff = new Date(due) - new Date()
  if (!Number.isFinite(diff)) return null
  if (diff <= 0) return 'Expired'
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))
  if (days > 0) return `${days} day${days > 1 ? 's' : ''} left`
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} left`
  return 'Less than 1 hour left'
}

// Public, token-authenticated portal page — token travels from useParams into
// the URL path on every request, unchanged from before.
function SupplierContractResponse() {
  const { t } = useI18n()
  const { token } = useParams()
  const [confirm, setConfirm] = useState(null) // 'accept' | 'decline'
  const [responseSubmitted, setResponseSubmitted] = useState(null) // { action, message }
  const [actionError, setActionError] = useState('')

  const { data: contract, loading, error: queryError } = useResource(
    keys.supplierContractResponse(token),
    async ({ signal }) => {
      const response = await api.get(`/contracts/supplier-response/${token}`, { signal })
      const data = response.data
      return { data: data.data }
    },
    { enabled: !!token, retry: false, staleTime: 0 }
  )

  const acceptMutation = useResourceMutation(
    async () => {
      const response = await api.post(`/contracts/supplier-response/${token}/accept`)
      const data = response.data
      return { data }
    },
    {
      silent: true,
      invalidates: [keys.supplierContractResponse(token)],
      onSuccess: (result) => { setConfirm(null); setResponseSubmitted({ action: 'accept', message: result?.message }) },
      onError: (err) => { setConfirm(null); setActionError(err.response?.data?.error || err.message || 'Failed to accept contract') },
    }
  )

  const declineMutation = useResourceMutation(
    async (reason) => {
      const response = await api.post(`/contracts/supplier-response/${token}/decline`, { reason })
      const data = response.data
      return { data }
    },
    {
      silent: true,
      invalidates: [keys.supplierContractResponse(token)],
      onSuccess: (result) => { setConfirm(null); setResponseSubmitted({ action: 'decline', message: result?.message }) },
      onError: (err) => { setConfirm(null); setActionError(err.response?.data?.error || err.message || 'Failed to decline contract') },
    }
  )

  const submitting = acceptMutation.isPending || declineMutation.isPending

  const shell = (children) => <PublicShell context="Contract review">{children}</PublicShell>

  if (loading && token) return shell(<PublicLoading />)

  if (queryError || !contract) {
    const { reference } = describeError(queryError)
    return shell(
      <PublicMessage tone="risk" title={t('ui.accessError')} reference={reference}>
        <p>{queryError?.response?.data?.error || queryError?.message || 'Contract not found.'}</p>
        <p>{t('ui.theContractLinkMayHaveExpired')}</p>
      </PublicMessage>
    )
  }

  if (responseSubmitted) {
    return shell(
      <PublicMessage tone="ok" title={responseSubmitted.action === 'accept' ? 'Contract accepted' : 'Contract declined'}>
        <p>{responseSubmitted.message || t('ui.thankYouForYourResponseWe')}</p>
        <p className="text-xs text-ink-500">{t('ui.youMayCloseThisPageNow')}</p>
      </PublicMessage>
    )
  }

  const expired = contract.response_due ? new Date() > new Date(contract.response_due) : false
  const remaining = timeRemaining(contract.response_due)
  const currency = contract.currency || 'USD'
  const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:3001/api'

  return shell(
    <div className="space-y-5">
      <PublicHeader
        eyebrow="Contract review"
        title={contract.title || <Code>{contract.contract_number}</Code>}
        status={remaining ? <Badge tone={expired ? 'risk' : 'warn'}>{remaining}</Badge> : null}
        description={<><Code>{contract.contract_number}</Code> · Respond by {formatDate(contract.response_due)}</>}
      />

      <PublicSection title="Contract details">
        <DescriptionList
          items={[
            { label: 'Contract value', value: contract.contract_value ? <Money amount={contract.contract_value} currency={currency} className="font-medium" /> : null },
            { label: 'Period', value: `${formatDate(contract.start_date)} – ${formatDate(contract.end_date)}` },
            { label: 'Supplier', value: contract.supplier_name ? <>{contract.supplier_name}{contract.supplier_code && <> · <Code>{contract.supplier_code}</Code></>}</> : null },
            { label: 'Contract type', value: contract.contract_type },
            contract.description && { label: 'Description', value: contract.description, wide: true },
          ]}
        />
      </PublicSection>

      {contract.terms && (
        <PublicSection title="Terms and conditions">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-800">{contract.terms}</p>
        </PublicSection>
      )}

      {(contract.contract_file_name || contract.document_url) && (
        <PublicSection title="Contract document">
          <div className="flex flex-col gap-2 sm:flex-row">
            {contract.contract_file_name && (
              <Button
                variant="secondary"
                size="lg"
                icon={ArrowDownTrayIcon}
                href={`${apiBase}/contracts/download/${token}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Download {contract.contract_file_name}
              </Button>
            )}
            {contract.document_url && (
              <Button variant="secondary" size="lg" iconRight={ArrowTopRightOnSquareIcon} href={contract.document_url} target="_blank" rel="noopener noreferrer">
                {t('ui.viewDocumentOnline')}
              </Button>
            )}
          </div>
        </PublicSection>
      )}

      {actionError && <InlineNotice tone="risk" title="Not saved">{actionError}</InlineNotice>}

      {expired ? (
        <InlineNotice tone="risk" title={t('ui.responsePeriodExpired')}>
          {t('ui.theDeadlineForRespondingToThis')}
        </InlineNotice>
      ) : (
        <PublicActions note="Your answer is final once sent.">
          <Button size="lg" variant="destructive" onClick={() => { setActionError(''); setConfirm('decline') }} disabled={submitting}>
            {t('ui.declineContract')}
          </Button>
          <Button size="lg" variant="primary" onClick={() => { setActionError(''); setConfirm('accept') }} disabled={submitting}>
            {t('ui.acceptContract')}
          </Button>
        </PublicActions>
      )}

      <ConfirmDialog
        open={confirm === 'accept'}
        onClose={() => setConfirm(null)}
        onConfirm={() => acceptMutation.mutate()}
        busy={acceptMutation.isPending}
        tone="primary"
        title={`Accept ${contract.contract_number || 'this contract'}?`}
        confirmLabel="Accept contract"
        consequence="You agree to the terms above. The buyer is notified straight away."
      />
      <ConfirmDialog
        open={confirm === 'decline'}
        onClose={() => setConfirm(null)}
        onConfirm={(reason) => declineMutation.mutate(reason)}
        busy={declineMutation.isPending}
        title={`Decline ${contract.contract_number || 'this contract'}?`}
        confirmLabel="Decline contract"
        consequence="The buyer is told you declined."
        requireReason
        reasonLabel="Reason for declining"
        reasonHelp="The buyer sees this. Say what would make it acceptable."
      />
    </div>
  )
}

export default SupplierContractResponse
