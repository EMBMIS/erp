import { useMemo, useState } from 'react'
import { PlusIcon, ArrowsRightLeftIcon, GlobeAltIcon } from '@heroicons/react/20/solid'
import { currenciesAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useI18n } from '../../contexts/I18nContext'
import {
  PageHeader, Button, DataTable, Badge, Code, DateText, Card, Tabs, Dialog, Field, Input, Select, ErrorSummary, InlineNotice,
  formatNumber,
} from '../../components/ui'

/**
 * Currencies & FX — the currencies the company trades in, the exchange rates
 * it books with, and a quick converter that uses those same rates.
 */
const fmtRate = (r) => (r == null || !Number.isFinite(Number(r)) ? '—' : Number(r).toFixed(6))

export default function Currencies() {
  const { t } = useI18n()
  const [tab, setTab] = useState('rates')
  const [curOpen, setCurOpen] = useState(false)
  const [rateOpen, setRateOpen] = useState(false)

  // The list answers { success, data, base } — `base` sits beside `data`, so
  // the body is re-wrapped whole before useResource unwraps it.
  const { data: curBody, loading: curLoading, error: curError, refetch: refetchCur } = useResource(
    keys.currencies(),
    async () => ({ data: { success: true, data: (await currenciesAPI.list()).data } })
  )
  const currencies = useMemo(() => (Array.isArray(curBody?.data) ? curBody.data : []), [curBody])
  const base = curBody?.base || currencies.find((c) => c.is_base)?.code || 'USD'
  const { data: ratesData, loading: ratesLoading, error: ratesError, refetch: refetchRates } = useResource(['currencies', 'rates'], () => currenciesAPI.listRates())
  const rates = useMemo(() => (Array.isArray(ratesData) ? ratesData : []), [ratesData])

  const rateColumns = useMemo(() => [
    { id: 'pair', header: 'Pair', accessor: (r) => `${r.from_currency}/${r.to_currency}`, width: 160, mobile: 'title', cell: (r) => <Code>{r.from_currency} → {r.to_currency}</Code> },
    { id: 'rate', header: 'Rate', accessor: (r) => Number(r.rate), align: 'right', filter: 'number', width: 140, mobile: 'trailing', cell: (r) => <span className="tabular-nums">{fmtRate(r.rate)}</span> },
    { id: 'date', header: 'Rate date', accessor: 'rate_date', width: 130, mobile: 'meta', cell: (r) => <DateText value={r.rate_date} /> },
    { id: 'by', header: 'Entered by', accessor: 'created_by_name', width: 160, cell: (r) => r.created_by_name || <span className="text-ink-500">System</span> },
  ], [])

  const curColumns = useMemo(() => [
    { id: 'code', header: 'Code', accessor: 'code', width: 120, mobile: 'title', cell: (c) => <span className="inline-flex items-center gap-2"><Code>{c.code}</Code>{c.is_base && <Badge tone="brand">Base</Badge>}</span> },
    { id: 'name', header: 'Name', accessor: 'name', minWidth: 200, mobile: 'subtitle' },
    { id: 'symbol', header: 'Symbol', accessor: 'symbol', width: 100, mobile: 'trailing', cell: (c) => c.symbol || '—' },
    { id: 'active', header: 'Status', accessor: (c) => (c.is_active === false ? 'Inactive' : 'Active'), filter: 'select', width: 110, cell: (c) => (c.is_active === false ? <Badge>Inactive</Badge> : <Badge tone="ok" glyph="dot">Active</Badge>) },
  ], [])

  return (
    <>
      <PageHeader
        title={t('ui.currenciesExchangeRates')}
        description="The currencies you trade in and the exchange rates the books use."
        meta={<span>Base currency <Code className="text-fg">{base}</Code></span>}
        secondary={<Button icon={PlusIcon} onClick={() => setCurOpen(true)}>{t('ui.addCurrency')}</Button>}
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setRateOpen(true)}>{t('ui.addRate')}</Button>}
      />

      <Converter currencies={currencies} base={base} />

      <Tabs
        className="mt-5"
        value={tab}
        onChange={setTab}
        tabs={[{ id: 'rates', label: 'Exchange rates', count: rates.length }, { id: 'currencies', label: 'Currencies', count: currencies.length }]}
      >
        {(active) => (active === 'rates' ? (
          <DataTable
            viewKey="finance.fx-rates"
            caption="Exchange rates"
            noun="rate"
            rows={rates}
            columns={rateColumns}
            loading={ratesLoading}
            error={ratesError}
            onRetry={refetchRates}
            defaultSort={{ id: 'date', dir: 'desc' }}
            searchPlaceholder="Search currency"
            empty={{
              icon: ArrowsRightLeftIcon,
              title: 'No exchange rates yet',
              description: `Add a rate for each currency you invoice or buy in, against ${base}. Foreign-currency documents are converted with the latest rate on or before their date.`,
              action: <Button variant="primary" icon={PlusIcon} onClick={() => setRateOpen(true)}>{t('ui.addRate')}</Button>,
            }}
          />
        ) : (
          <DataTable
            viewKey="finance.currencies"
            caption="Currencies"
            noun="currency"
            rowKey="code"
            rows={currencies}
            columns={curColumns}
            loading={curLoading}
            error={curError}
            onRetry={refetchCur}
            defaultSort={{ id: 'code', dir: 'asc' }}
            searchPlaceholder="Search code or name"
            empty={{
              icon: GlobeAltIcon,
              title: 'No currencies yet',
              description: 'Add the currencies you trade in, by their ISO code.',
              action: <Button variant="primary" icon={PlusIcon} onClick={() => setCurOpen(true)}>{t('ui.addCurrency')}</Button>,
            }}
          />
        ))}
      </Tabs>

      {curOpen && <AddCurrencyDialog onClose={() => setCurOpen(false)} />}
      {rateOpen && <AddRateDialog currencies={currencies} base={base} onClose={() => setRateOpen(false)} />}
    </>
  )
}

function Converter({ currencies, base }) {
  const [amount, setAmount] = useState('100')
  const [from, setFrom] = useState(base || 'USD')
  const [to, setTo] = useState('EUR')
  const [result, setResult] = useState(null)
  const [failure, setFailure] = useState(null)
  const [busy, setBusy] = useState(false)
  const codes = currencies.length ? currencies.map((c) => c.code) : [from, to]

  const convert = async (e) => {
    e?.preventDefault()
    setBusy(true)
    setFailure(null)
    try {
      const res = await currenciesAPI.convert({ amount, from, to })
      const d = res.data?.data
      if (d?.converted == null) setFailure(d?.error || `No rate from ${from} to ${to}. Add one, then convert again.`)
      setResult(d)
    } catch (err) {
      setFailure(err.response?.data?.error || 'The conversion did not run.')
      setResult(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Convert" description="Uses the latest rate on file">
      <form onSubmit={convert} className="flex flex-wrap items-end gap-3">
        <Field label="Amount" className="w-32">
          <Input type="number" numeric value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="From" className="w-28">
          <Select value={from} onChange={(e) => setFrom(e.target.value)}>
            {codes.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </Field>
        <ArrowsRightLeftIcon className="mb-2 h-4 w-4 text-ink-400" aria-hidden="true" />
        <Field label="To" className="w-28">
          <Select value={to} onChange={(e) => setTo(e.target.value)}>
            {codes.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </Field>
        <Button type="submit" loading={busy}>Convert</Button>
        {result?.converted != null && (
          <div className="ml-auto text-right" aria-live="polite">
            <p className="text-xl font-semibold tabular-nums text-fg">{formatNumber(result.converted, 2)} <span className="font-mono text-sm text-ink-600">{result.to}</span></p>
            <p className="text-xs text-ink-500">Rate {fmtRate(result.rate)}</p>
          </div>
        )}
      </form>
      {failure && <InlineNotice tone="warn" className="mt-3">{failure}</InlineNotice>}
    </Card>
  )
}

function AddCurrencyDialog({ onClose }) {
  const [form, setForm] = useState({ code: '', name: '', symbol: '' })
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [failure, setFailure] = useState(null)
  const add = useResourceMutation((payload) => currenciesAPI.add(payload), { invalidates: [['currencies']], silent: true })
  const errors = {
    'cur-code': !/^[A-Z]{3}$/.test(form.code) ? 'Enter the three-letter ISO code, e.g. JPY.' : null,
    'cur-name': !form.name.trim() ? 'Enter the currency name.' : null,
  }
  const show = (id) => (touched[id] || submitted ? errors[id] : null)

  const submit = async (e) => {
    e?.preventDefault()
    setSubmitted(true)
    if (errors['cur-code'] || errors['cur-name']) return
    setFailure(null)
    try {
      await add.mutateAsync({ code: form.code, name: form.name, symbol: form.symbol || undefined })
      onClose()
    } catch (err) {
      setFailure(err?.response?.data?.error || err.message)
    }
  }

  return (
    <Dialog
      open
      onClose={add.isPending ? undefined : onClose}
      title="Add currency"
      footer={<><Button onClick={onClose} disabled={add.isPending}>Cancel</Button><Button variant="primary" onClick={submit} loading={add.isPending}>Add currency</Button></>}
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {submitted && <ErrorSummary errors={errors} />}
        {failure && <InlineNotice tone="risk" title="The currency was not added">{failure}</InlineNotice>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="ISO code" required error={show('cur-code')}>
            <Input id="cur-code" maxLength={3} value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} onBlur={() => setTouched((x) => ({ ...x, 'cur-code': true }))} className="font-mono" />
          </Field>
          <Field label="Name" required error={show('cur-name')} className="sm:col-span-2">
            <Input id="cur-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} onBlur={() => setTouched((x) => ({ ...x, 'cur-name': true }))} />
          </Field>
        </div>
        <Field label="Symbol" optional>
          <Input value={form.symbol} onChange={(e) => setForm((f) => ({ ...f, symbol: e.target.value }))} className="w-24" />
        </Field>
      </form>
    </Dialog>
  )
}

function AddRateDialog({ currencies, base, onClose }) {
  const [form, setForm] = useState({ from_currency: base || 'USD', to_currency: 'EUR', rate: '', rate_date: '' })
  const [touched, setTouched] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [failure, setFailure] = useState(null)
  const add = useResourceMutation((payload) => currenciesAPI.addRate(payload), { invalidates: [['currencies']], silent: true })
  const codes = currencies.length ? currencies.map((c) => c.code) : [form.from_currency, form.to_currency]
  const rateError = !form.rate || Number(form.rate) <= 0 ? 'Enter a rate greater than zero.' : form.from_currency === form.to_currency ? 'Choose two different currencies.' : null

  const submit = async (e) => {
    e?.preventDefault()
    setSubmitted(true)
    if (rateError) return
    setFailure(null)
    try {
      await add.mutateAsync({
        from_currency: form.from_currency,
        to_currency: form.to_currency,
        rate: Number(form.rate),
        rate_date: form.rate_date || undefined,
      })
      onClose()
    } catch (err) {
      setFailure(err?.response?.data?.error || err.message)
    }
  }

  return (
    <Dialog
      open
      onClose={add.isPending ? undefined : onClose}
      title="Add exchange rate"
      footer={<><Button onClick={onClose} disabled={add.isPending}>Cancel</Button><Button variant="primary" onClick={submit} loading={add.isPending}>Save rate</Button></>}
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {submitted && <ErrorSummary errors={{ 'fx-rate': rateError }} />}
        {failure && <InlineNotice tone="risk" title="The rate was not saved">{failure}</InlineNotice>}
        <div className="grid grid-cols-2 gap-4">
          <Field label="From" required>
            <Select value={form.from_currency} onChange={(e) => setForm((f) => ({ ...f, from_currency: e.target.value }))}>
              {codes.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
          <Field label="To" required>
            <Select value={form.to_currency} onChange={(e) => setForm((f) => ({ ...f, to_currency: e.target.value }))}>
              {codes.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Rate" required error={touched || submitted ? rateError : null} help={`1 ${form.from_currency} = ? ${form.to_currency}`}>
          <Input id="fx-rate" type="number" step="0.00000001" min="0" numeric value={form.rate} onChange={(e) => setForm((f) => ({ ...f, rate: e.target.value }))} onBlur={() => setTouched(true)} />
        </Field>
        <Field label="Rate date" optional>
          <Input type="date" value={form.rate_date} onChange={(e) => setForm((f) => ({ ...f, rate_date: e.target.value }))} />
        </Field>
      </form>
    </Dialog>
  )
}
