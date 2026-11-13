import React, { useId, useRef, useEffect } from 'react'
import clsx from 'clsx'
import { ExclamationTriangleIcon } from '@heroicons/react/20/solid'

/**
 * The form language.
 *
 *   Label above. Help below. Error below, replacing help, saying how to fix it.
 *   Required fields say "(required)" in words next to the label; optional ones
 *   say nothing — most fields in this product are required, so marking the
 *   exception would mark nearly everything.
 *   Validation runs on blur, not on every keystroke (see useFieldValidation).
 *
 * Field wires its single child control to the label, help and error by id,
 * so every input is announced with its label, its help and its error.
 */
export function Field({ label, error, hint, help, required, optional, children, className, labelAction, id: forcedId }) {
  const autoId = useId()
  const id = forcedId || children?.props?.id || `f${autoId.replace(/:/g, '')}`
  const helpText = help ?? hint
  const describedBy = [error && `${id}-error`, helpText && !error && `${id}-help`].filter(Boolean).join(' ') || undefined

  return (
    <div className={clsx('min-w-0', className)}>
      {label && (
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <label htmlFor={id} className="text-sm font-medium text-ink-800">
            {label}
            {required && <span className="ml-1.5 text-xs font-normal text-ink-500">(required)</span>}
            {optional && <span className="ml-1.5 text-xs font-normal text-ink-500">(optional)</span>}
          </label>
          {labelAction}
        </div>
      )}
      {React.isValidElement(children)
        ? React.cloneElement(children, {
            id,
            'aria-invalid': error ? true : children.props['aria-invalid'],
            'aria-describedby': [children.props['aria-describedby'], describedBy].filter(Boolean).join(' ') || undefined,
            'aria-required': required || undefined,
          })
        : children}
      {error ? (
        <p id={`${id}-error`} className="mt-1 flex items-start gap-1 text-xs text-risk-600">
          <ExclamationTriangleIcon className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : (
        helpText && <p id={`${id}-help`} className="mt-1 text-xs text-ink-500">{helpText}</p>
      )}
    </div>
  )
}

const CONTROL =
  'block w-full rounded-md border border-ink-300 bg-surface text-sm text-fg placeholder:text-ink-400 ' +
  'transition-colors duration-fast hover:border-ink-400 ' +
  'focus:border-brand-600 focus:outline-none focus:ring-[3px] focus:ring-brand-500/20 ' +
  'disabled:cursor-not-allowed disabled:bg-sunken disabled:text-ink-500 ' +
  'aria-[invalid=true]:border-risk-600 aria-[invalid=true]:focus:ring-risk-500/20'

// A width passed in (w-36, w-auto…) wins over the default full width.
const control = (className) => (/(^|\s)(sm:|md:|lg:)?w-/.test(className || '') ? CONTROL.replace('w-full ', '') : CONTROL)

const SIZE = { sm: 'h-7 px-2 text-xs', md: 'h-8 px-2.5', lg: 'h-10 px-3 text-base' }

export const Input = React.forwardRef(function Input({ className, size = 'md', prefix, suffix, numeric, ...props }, ref) {
  const input = (
    <input
      ref={ref}
      inputMode={numeric ? 'decimal' : props.inputMode}
      className={clsx(control(className), SIZE[size], numeric && 'text-right tabular-nums', (prefix || suffix) && 'border-0 bg-transparent focus:ring-0 hover:border-0', className)}
      {...props}
    />
  )
  if (!prefix && !suffix) return input
  return (
    <div className={clsx('flex items-center rounded-md border border-ink-300 bg-surface focus-within:border-brand-600 focus-within:ring-[3px] focus-within:ring-brand-500/20')}>
      {prefix && <span className="pl-2.5 font-mono text-xs text-ink-500">{prefix}</span>}
      {input}
      {suffix && <span className="pr-2.5 font-mono text-xs text-ink-500">{suffix}</span>}
    </div>
  )
})

export const Textarea = React.forwardRef(function Textarea({ className, rows = 3, ...props }, ref) {
  return <textarea ref={ref} rows={rows} className={clsx(control(className), 'px-2.5 py-1.5 leading-5', className)} {...props} />
})

export const Select = React.forwardRef(function Select({ className, size = 'md', children, ...props }, ref) {
  return (
    <select ref={ref} className={clsx(control(className), SIZE[size], 'pr-8', className)} {...props}>
      {children}
    </select>
  )
})

export const Checkbox = React.forwardRef(function Checkbox({ label, description, className, id, ...props }, ref) {
  const auto = useId()
  const cid = id || `c${auto.replace(/:/g, '')}`
  return (
    <div className={clsx('flex items-start gap-2', className)}>
      <input ref={ref} id={cid} type="checkbox" className="mt-0.5 h-4 w-4 rounded border-ink-300" {...props} />
      {(label || description) && (
        <label htmlFor={cid} className="text-sm text-ink-800">
          {label}
          {description && <span className="block text-xs text-ink-500">{description}</span>}
        </label>
      )}
    </div>
  )
})

/** Switch — a binary setting that applies immediately. */
export function Switch({ checked, onChange, label, disabled, className }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!checked}
      aria-label={typeof label === 'string' ? label : undefined}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={clsx('inline-flex items-center gap-2 text-sm text-ink-800 disabled:opacity-50', className)}
    >
      <span className={clsx('relative inline-flex h-[18px] w-8 shrink-0 rounded-full transition-colors', checked ? 'bg-brand-600' : 'bg-ink-300')}>
        <span className={clsx('absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-transform', checked ? 'translate-x-[16px]' : 'translate-x-[2px]')} style={{ background: '#fff' }} />
      </span>
      {label && typeof label !== 'string' ? label : label && <span>{label}</span>}
    </button>
  )
}

/**
 * FormSection — a titled group of fields. Long forms are a stack of these,
 * never one 60-field wall. `advanced` collapses the section behind a
 * disclosure so rarely-used fields stay out of the way until asked for.
 */
export function FormSection({ title, description, children, advanced = false, defaultOpen = false, columns = 2, className, aside }) {
  const grid = columns === 1 ? 'grid-cols-1' : columns === 3 ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2'
  const body = <div className={clsx('grid gap-x-4 gap-y-4', grid)}>{children}</div>
  if (advanced) {
    return (
      <details className={clsx('group relative rounded-lg border border-ink-200 bg-surface', className)} open={defaultOpen || undefined}>
        {/* aside sits beside the summary, not inside it: a control inside <summary> would also toggle the section */}
        {aside && <div className="absolute right-16 top-2">{aside}</div>}
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-ink-800 [&::-webkit-details-marker]:hidden">
          <span>
            {title}
            {description && <span className="ml-2 font-normal text-ink-500">{description}</span>}
          </span>
          <span className="font-mono text-2xs uppercase tracking-wide text-ink-500 group-open:hidden">Show</span>
          <span className="hidden font-mono text-2xs uppercase tracking-wide text-ink-500 group-open:inline">Hide</span>
        </summary>
        <div className="border-t border-ink-200 p-4">{body}</div>
      </details>
    )
  }
  return (
    <section className={clsx('rounded-lg border border-ink-200 bg-surface', className)}>
      {(title || aside) && (
        <header className="flex items-start justify-between gap-3 border-b border-ink-200 px-4 py-3">
          <div>
            {title && <h2 className="text-sm font-semibold text-fg">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-ink-500">{description}</p>}
          </div>
          {aside}
        </header>
      )}
      <div className="p-4">{body}</div>
    </section>
  )
}

/**
 * ErrorSummary — listed at the top of a form after a failed submit, focused,
 * and each entry links to its field. Announced by screen readers.
 * errors: { fieldId: message } or [{ id, message }]
 */
export function ErrorSummary({ errors, title = 'Fix these before saving' }) {
  const ref = useRef(null)
  const list = Array.isArray(errors)
    ? errors
    : Object.entries(errors || {}).filter(([, m]) => m).map(([id, message]) => ({ id, message }))
  useEffect(() => {
    if (list.length) ref.current?.focus()
  }, [list.length])
  if (!list.length) return null
  return (
    <div ref={ref} tabIndex={-1} role="alert" className="rounded-lg border border-risk-300 bg-risk-50 p-3 focus:outline-none">
      <p className="text-sm font-semibold text-risk-800">{title}</p>
      <ul className="mt-1.5 space-y-0.5 text-sm text-risk-800">
        {list.map((e, i) => (
          <li key={`${e.id}-${i}`}>
            <a
              href={`#${e.id}`}
              onClick={(ev) => {
                const el = document.getElementById(e.id)
                if (el) {
                  ev.preventDefault()
                  el.focus()
                  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
                }
              }}
              className="underline underline-offset-2 hover:no-underline"
            >
              {e.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * useFieldValidation — validate on blur, re-validate on change once a field
 * has been touched. rules: { name: (value, values) => message | null }
 */
export function useFieldValidation(values, rules) {
  const [touched, setTouched] = React.useState({})
  const errorsFor = React.useCallback(
    (all = false) => {
      const out = {}
      for (const [name, rule] of Object.entries(rules || {})) {
        if (!all && !touched[name]) continue
        const msg = rule(values?.[name], values)
        if (msg) out[name] = msg
      }
      return out
    },
    [values, rules, touched]
  )
  const errors = errorsFor(false)
  const onBlur = (name) => () => setTouched((t) => ({ ...t, [name]: true }))
  const validateAll = () => {
    setTouched(Object.fromEntries(Object.keys(rules || {}).map((k) => [k, true])))
    return errorsFor(true)
  }
  return { errors, onBlur, validateAll, touched }
}

export default Field
