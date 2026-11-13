/** @type {import('tailwindcss').Config} */
import { STEPS, FAMILIES } from './scripts/design/palette.mjs'

/**
 * Tailwind is a view onto the token system, not a second palette.
 *
 * Every colour utility resolves to a CSS variable written by
 * scripts/design/build-tokens.mjs, and every variable is redefined under
 * `.dark`. Dark mode is therefore a token swap designed per theme, not a
 * stylesheet of overrides chasing utilities one at a time.
 *
 * Background-ish utilities (bg, border, ring, divide, fill, from/to) read the
 * `--c-*` scale; text reads the `--t-*` scale. They are the same in light and
 * different in dark, where a label needs a lighter tint than a solid fill.
 */
const scale = (prefix, ramp) =>
  Object.fromEntries(STEPS.map((s) => [s, `rgb(var(--${prefix}-${ramp}-${s}) / <alpha-value>)`]))

const palette = (prefix) => {
  const out = {}
  for (const [ramp, names] of Object.entries(FAMILIES)) {
    for (const name of names) out[name] = scale(prefix, ramp)
  }
  return out
}

const fixed = {
  transparent: 'transparent',
  current: 'currentColor',
  inherit: 'inherit',
  black: '#000000',
}

const colors = {
  ...fixed,
  // A white fill is a surface. In dark mode a surface is dark.
  white: 'rgb(var(--surface) / <alpha-value>)',
  ...palette('c'),
  canvas: 'rgb(var(--canvas) / <alpha-value>)',
  surface: 'rgb(var(--surface) / <alpha-value>)',
  raised: 'rgb(var(--raised) / <alpha-value>)',
  sunken: 'rgb(var(--sunken) / <alpha-value>)',
  overlay: 'rgb(var(--overlay) / <alpha-value>)',
  // Stays dark in both themes: tooltips, the bulk-selection bar.
  tooltip: { DEFAULT: '#18181b', soft: '#27272c' },
  line: 'rgb(var(--c-ink-200) / <alpha-value>)',
}

const textColors = {
  ...fixed,
  // White text sits on solid fills (buttons, badges). It stays white.
  white: '#ffffff',
  ...palette('t'),
  fg: 'rgb(var(--t-ink-900) / <alpha-value>)',
  muted: 'rgb(var(--t-ink-600) / <alpha-value>)',
  faint: 'rgb(var(--t-ink-500) / <alpha-value>)',
}

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    colors,
    textColor: textColors,
    extend: {
      screens: { rail: '1440px' },
      fontFamily: {
        sans: ['"Instrument Sans Variable"', '"Instrument Sans"', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
        display: ['"Instrument Sans Variable"', '"Instrument Sans"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono Variable"', '"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      // A denser scale than Tailwind's default: this is a tool people read
      // all day at arm's length, not a landing page.
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.04em' }],
        xs: ['0.75rem', { lineHeight: '1.125rem' }],
        sm: ['0.8125rem', { lineHeight: '1.25rem' }],
        base: ['0.875rem', { lineHeight: '1.375rem' }],
        lg: ['1rem', { lineHeight: '1.5rem' }],
        xl: ['1.125rem', { lineHeight: '1.625rem' }],
        '2xl': ['1.375rem', { lineHeight: '1.875rem', letterSpacing: '-0.01em' }],
        '3xl': ['1.75rem', { lineHeight: '2.25rem', letterSpacing: '-0.015em' }],
        '4xl': ['2.125rem', { lineHeight: '2.5rem', letterSpacing: '-0.02em' }],
      },
      // Restrained radii. `rounded-2xl` and `rounded-3xl` were cards at 16-24px;
      // they now land on the same 10px as everything that is a container.
      borderRadius: {
        none: '0',
        sm: '3px',
        DEFAULT: '5px',
        md: '6px',
        lg: '7px',
        xl: '9px',
        '2xl': '10px',
        '3xl': '10px',
        xl2: '10px',
        full: '9999px',
      },
      // Almost no shadow. Containers separate on hairlines; only things that
      // float over the page (menus, dialogs, the palette) cast one.
      boxShadow: {
        none: 'none',
        sm: '0 0 0 0 transparent',
        DEFAULT: '0 0 0 0 transparent',
        md: '0 1px 2px rgb(0 0 0 / 0.04)',
        card: '0 0 0 0 transparent',
        cardHover: '0 0 0 0 transparent',
        lg: 'var(--shadow-overlay)',
        xl: 'var(--shadow-overlay)',
        '2xl': 'var(--shadow-overlay)',
        pop: 'var(--shadow-overlay)',
        overlay: 'var(--shadow-overlay)',
        inner: 'inset 0 1px 0 rgb(0 0 0 / 0.04)',
      },
      transitionDuration: { DEFAULT: '160ms', fast: '120ms', base: '180ms', slow: '240ms' },
      transitionTimingFunction: {
        DEFAULT: 'cubic-bezier(0.2, 0, 0, 1)',
        out: 'cubic-bezier(0.2, 0, 0, 1)',
        in: 'cubic-bezier(0.4, 0, 1, 1)',
      },
      ringColor: { DEFAULT: 'rgb(var(--c-brand-500) / 0.5)' },
      zIndex: { rail: '30', topbar: '40', sheet: '60', dialog: '70', palette: '80', toast: '90' },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}
