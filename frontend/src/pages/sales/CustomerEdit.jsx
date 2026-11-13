import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useRecordTitle } from '../../components/shell/ShellContext'
import { PageHeader, StatusBadge, Code, SkeletonDetail, ErrorState, notify } from '../../components/ui'
import { CustomerForm } from './CustomerCreate'

/**
 * Edit a customer — the same form as New customer, filled from the record.
 * Sends the same field set as before to PUT /customers/:id.
 */
const fromRecord = (c) =>
  Object.fromEntries(
    Object.entries(CustomerForm.EMPTY).map(([k, empty]) => {
      const v = c[k]
      if (typeof empty === 'boolean') return [k, k === 'use_billing_as_shipping' ? v ?? true : Boolean(v)]
      return [k, v == null || v === '' ? empty : v]
    })
  )

export default function CustomerEdit() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data: customer, loading, error, refetch } = useResource(keys.customer(id), ({ signal }) => api.get(`/customers/${id}`, { signal }), { enabled: Boolean(id) })
  const [form, setFormState] = useState(null)
  const [serverError, setServerError] = useState(null)
  useRecordTitle(customer?.customer_code || customer?.customer_name, { subtitle: customer?.customer_name })

  // Fill the form once, from the first copy of the record that arrives.
  useEffect(() => {
    if (customer && !form) setFormState(fromRecord(customer))
  }, [customer, form])
  const setForm = (patch) => setFormState((f) => ({ ...f, ...patch }))

  const update = useResourceMutation((data) => api.put(`/customers/${id}`, data), { invalidates: [['customers'], keys.customer(id)], silent: true })

  const save = async () => {
    setServerError(null)
    try {
      await update.mutateAsync(form)
      notify.success(`${form.customer_name} saved`)
      navigate(`/sales/customers/${id}`)
    } catch (err) {
      const d = err?.response?.data || {}
      setServerError({ message: d.error || err.message, reference: d.error_id })
    }
  }

  if (loading || (customer && !form)) return <SkeletonDetail />
  if (error || !customer) {
    return <ErrorState what="Customer" error={error || { response: { status: 404, data: { error: 'No customer with this id is visible to you.' } } }} onRetry={refetch} />
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title={`Edit ${customer.customer_name}`}
        status={<StatusBadge status={customer.status} />}
        meta={<><Code>{customer.customer_code}</Code><span>Changes are recorded in the customer's history.</span></>}
      />
      <CustomerForm form={form} setForm={setForm} onSubmit={save} saving={update.isPending} serverError={serverError} mode="edit" cancelTo={`/sales/customers/${id}`} idPrefix="edit_" />
    </div>
  )
}
