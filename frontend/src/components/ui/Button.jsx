import React from 'react'
import clsx from 'clsx'
import { Link } from 'react-router-dom'

/**
 * Button — one button for the whole product.
 *
 * variant
 *   primary      the one action a screen exists for. Ultramarine. At most one.
 *   secondary    everything else a person might reasonably do here.
 *   ghost        low-weight actions inside dense UI (row actions, toolbars).
 *   destructive  removes, rejects or cancels. Outlined in risk until hovered,
 *                so it never looks like the default choice.
 *   danger       solid risk. Only inside a confirmation that already named
 *                the consequence in words.
 *
 * Pass `to` for in-app navigation (renders a router Link) or `href` for an
 * external one. `loading` keeps the width stable and announces busy state.
 */
const VARIANTS = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 border-transparent',
  secondary: 'bg-surface text-fg border-ink-300 hover:bg-ink-100 hover:border-ink-400',
  ghost: 'bg-transparent text-ink-700 border-transparent hover:bg-ink-100 hover:text-ink-900',
  destructive: 'bg-surface text-risk-600 border-risk-300 hover:bg-risk-50 hover:border-risk-400',
  danger: 'bg-risk-600 text-white border-transparent hover:bg-risk-700',
  // Legacy names used by older call sites.
  link: 'bg-transparent text-brand-600 border-transparent hover:underline underline-offset-4 px-0',
}
VARIANTS.primaryAlt = VARIANTS.primary

const SIZES = {
  xs: 'h-6 px-2 text-xs gap-1',
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-8 px-3 text-sm gap-1.5',
  lg: 'h-10 px-4 text-base gap-2',
}

const ICON_SIZES = { xs: 'h-3.5 w-3.5', sm: 'h-3.5 w-3.5', md: 'h-4 w-4', lg: 'h-[18px] w-[18px]' }

export const buttonClasses = ({ variant = 'secondary', size = 'md', block = false, className } = {}) =>
  clsx(
    'relative inline-flex select-none items-center justify-center whitespace-nowrap rounded-md border font-medium',
    'transition-colors duration-fast ease-out',
    'disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
    VARIANTS[variant === 'danger-outline' ? 'destructive' : variant] || VARIANTS.secondary,
    SIZES[size] || SIZES.md,
    block && 'w-full',
    className
  )

export const Button = React.forwardRef(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    disabled = false,
    icon: Icon,
    iconRight: IconRight,
    kbd,
    block,
    to,
    href,
    children,
    className,
    type = 'button',
    ...props
  },
  ref
) {
  const classes = buttonClasses({ variant, size, block, className })
  const iconClass = ICON_SIZES[size] || ICON_SIZES.md
  const content = (
    <>
      {loading ? (
        <span className={clsx(iconClass, 'animate-spin rounded-full border-2 border-current border-t-transparent')} aria-hidden="true" />
      ) : (
        Icon && <Icon className={clsx(iconClass, 'shrink-0')} aria-hidden="true" />
      )}
      {children != null && children !== false && <span className="truncate">{children}</span>}
      {IconRight && <IconRight className={clsx(iconClass, 'shrink-0')} aria-hidden="true" />}
      {kbd && (
        <kbd className="ml-1 hidden rounded border border-current/20 px-1 font-mono text-2xs opacity-70 sm:inline">{kbd}</kbd>
      )}
    </>
  )

  if (to && !disabled) {
    return <Link ref={ref} to={to} className={classes} {...props}>{content}</Link>
  }
  if (href && !disabled) {
    return <a ref={ref} href={href} className={classes} {...props}>{content}</a>
  }
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={classes}
      {...props}
    >
      {content}
    </button>
  )
})

/**
 * IconButton — an icon with a required accessible name. `label` is both the
 * aria-label and the hover title, so no icon button ships unnamed.
 */
export const IconButton = React.forwardRef(function IconButton(
  { icon: Icon, label, variant = 'ghost', size = 'md', className, ...props },
  ref
) {
  const dims = { xs: 'h-6 w-6', sm: 'h-7 w-7', md: 'h-8 w-8', lg: 'h-10 w-10' }[size] || 'h-8 w-8'
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={clsx(buttonClasses({ variant, size }), '!px-0', dims, className)}
      {...props}
    >
      <Icon className={ICON_SIZES[size] || ICON_SIZES.md} aria-hidden="true" />
    </button>
  )
})

/** Kbd — a keyboard key, for shortcut hints. */
export function Kbd({ children, className }) {
  return (
    <kbd
      className={clsx(
        'inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-ink-300 bg-surface px-1 font-mono text-2xs text-ink-600',
        className
      )}
    >
      {children}
    </kbd>
  )
}

export default Button
