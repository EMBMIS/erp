import React from 'react';
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import api from '../../services/api';
import { keys } from '../../services/queryKeys';
import { useResource } from '../../hooks/useResource';
import { useI18n } from '../../contexts/I18nContext';

/**
 * Inline expand-in-place drill-down from a statement/report line to the real
 * journal entries behind it. Mirrors CashFlowForecast.jsx's `renderDrilldown`
 * row-expansion shape (a second <tr> under the row, toggled by a button) so
 * every report table gets the same interaction rather than a one-off modal.
 */
export function DrilldownToggle({ isOpen, onToggle, label, hideLabel }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isOpen}
      className="inline-flex items-center text-xs font-semibold text-blue-600 hover:text-blue-800"
    >
      {isOpen ? <ChevronDownIcon className="w-4 h-4 mr-1" /> : <ChevronRightIcon className="w-4 h-4 mr-1" />}
      {isOpen ? (hideLabel || t('ui.hideJournalEntries')) : (label || t('ui.viewJournalEntries'))}
    </button>
  );
}

/** Fetches and renders the journal lines for one account (optionally date-bounded). */
export function GeneralLedgerLines({ accountId, dateFrom, dateTo, colSpan }) {
  const { t } = useI18n();
  const { data, loading, error } = useResource(
    keys.generalLedger(accountId, dateFrom, dateTo),
    ({ signal }) => api.get(
      `/financial-reports/general-ledger/${accountId}?${new URLSearchParams({
        ...(dateFrom ? { date_from: dateFrom } : {}),
        ...(dateTo ? { date_to: dateTo } : {}),
        limit: '50',
      })}`,
      { signal }
    ),
    { enabled: Boolean(accountId) }
  );

  return (
    <tr>
      <td colSpan={colSpan} className="px-5 py-4 bg-gray-50 border-b border-gray-100">
        {loading && <p className="text-sm text-gray-500">{t('ui.loading')}</p>}
        {error && <p className="text-sm text-red-600">{error.message}</p>}
        {!loading && !error && (
          (data?.transactions || []).length === 0 ? (
            <p className="text-sm text-gray-500">{t('ui.noPostedJournalEntriesFoundFor')}</p>
          ) : (
            <table className="min-w-full text-xs">
              <thead>
                <tr className="text-left text-gray-500">
                  <th className="pr-4 py-1">{t('ui.journalNumber')}</th>
                  <th className="pr-4 py-1">{t('ui.date')}</th>
                  <th className="pr-4 py-1">{t('ui.description')}</th>
                  <th className="pr-4 py-1 text-right">{t('ui.debitBalance')}</th>
                  <th className="pr-4 py-1 text-right">{t('ui.creditBalance')}</th>
                </tr>
              </thead>
              <tbody>
                {data.transactions.map((line, i) => (
                  <tr key={`${line.journal_number}-${i}`} className="border-t border-gray-100">
                    <td className="pr-4 py-1 font-medium text-gray-900">{line.journal_number}</td>
                    <td className="pr-4 py-1 text-gray-600">{new Date(line.entry_date).toLocaleDateString()}</td>
                    <td className="pr-4 py-1 text-gray-600">{line.line_description || line.entry_description}</td>
                    <td className="pr-4 py-1 text-right text-gray-900">{Number(line.debit_amount) > 0 ? Number(line.debit_amount).toFixed(2) : '-'}</td>
                    <td className="pr-4 py-1 text-right text-gray-900">{Number(line.credit_amount) > 0 ? Number(line.credit_amount).toFixed(2) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </td>
    </tr>
  );
}

/** Fetches and renders the lines of one specific journal entry (by id). */
export function JournalEntryLines({ journalEntryId, colSpan }) {
  const { t } = useI18n();
  const { data, loading, error } = useResource(
    keys.journalEntry(journalEntryId),
    ({ signal }) => api.get(`/journal-entries/${journalEntryId}`, { signal }),
    { enabled: Boolean(journalEntryId) }
  );
  const items = data?.items || data?.journal_entry_items || [];

  return (
    <tr>
      <td colSpan={colSpan} className="px-5 py-4 bg-gray-50 border-b border-gray-100">
        {!journalEntryId && <p className="text-sm text-gray-500">{t('ui.noLinkedJournalEntry')}</p>}
        {journalEntryId && loading && <p className="text-sm text-gray-500">{t('ui.loading')}</p>}
        {journalEntryId && error && <p className="text-sm text-red-600">{error.message}</p>}
        {journalEntryId && !loading && !error && (
          <table className="min-w-full text-xs">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="pr-4 py-1">{t('ui.accountCode')}</th>
                <th className="pr-4 py-1">{t('ui.description')}</th>
                <th className="pr-4 py-1 text-right">{t('ui.debitBalance')}</th>
                <th className="pr-4 py-1 text-right">{t('ui.creditBalance')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((line, i) => (
                <tr key={line.id || i} className="border-t border-gray-100">
                  <td className="pr-4 py-1 font-medium text-gray-900">{line.account_code} {line.account_name}</td>
                  <td className="pr-4 py-1 text-gray-600">{line.description}</td>
                  <td className="pr-4 py-1 text-right text-gray-900">{Number(line.debit_amount) > 0 ? Number(line.debit_amount).toFixed(2) : '-'}</td>
                  <td className="pr-4 py-1 text-right text-gray-900">{Number(line.credit_amount) > 0 ? Number(line.credit_amount).toFixed(2) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </td>
    </tr>
  );
}
