/**
 * The EMBMIS colour system, as data.
 *
 * One file decides every colour the interface can show. `npm run tokens`
 * writes src/styles/tokens.generated.css from it and fails if any text pair
 * in CONTRAST_PAIRS drops below WCAG 2.2 AA, so a palette edit that makes a
 * label unreadable cannot be committed by accident.
 *
 * Five ramps, and only five, because colour means something here:
 *   ink    neutral ground, text, hairlines
 *   brand  Ultramarine #4a46ff, from the logo mark: the system is acting, or
 *          this is the primary action. Nothing else.
 *   ok     #3ecf8e   warn  #f2b33d   risk  #ff6b5e   (state only)
 *
 * Each ramp has a background scale and a text scale, separately for light and
 * dark. They differ on purpose: `bg-risk-600 text-white` is a solid button and
 * needs a deep fill, while `text-risk-600` is a label on a surface and, in dark
 * mode, needs a light tint to stay readable. One scale cannot serve both.
 */
export const STEPS = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950']

export const SURFACE = {
  light: { canvas: '#f6f6f7', surface: '#ffffff', raised: '#ffffff', sunken: '#f6f6f7', overlay: '#ffffff' },
  dark: { canvas: '#0e0e10', surface: '#161618', raised: '#1c1c1f', sunken: '#111113', overlay: '#1e1e21' },
}

export const RAMPS = {
  ink: {
    light: {
      bg: ['#f6f6f7', '#eeeef0', '#e2e2e6', '#cbcbd1', '#9b9ba4', '#71717a', '#56565e', '#3f3f46', '#27272c', '#18181b', '#0d0d0f'],
      text: ['#f6f6f7', '#eeeef0', '#e2e2e6', '#a8a8b0', '#84848d', '#6b6b74', '#55555d', '#3f3f46', '#27272c', '#18181b', '#0d0d0f'],
    },
    dark: {
      bg: ['#111113', '#1d1d20', '#28282c', '#36363b', '#55555c', '#6e6e76', '#8b8b93', '#a9a9b1', '#2c2c31', '#232327', '#1a1a1d'],
      text: ['#f7f7f8', '#f0f0f2', '#dcdce0', '#56565d', '#7a7a83', '#93939b', '#a7a7af', '#bfbfc6', '#d7d7dc', '#ececef', '#f7f7f8'],
    },
  },
  brand: {
    light: {
      bg: ['#f1f1ff', '#e5e4ff', '#cbc9ff', '#a7a4ff', '#7d79ff', '#4a46ff', '#4a46ff', '#3a36dd', '#2e2bb3', '#24228a', '#1a1866'],
      text: ['#f1f1ff', '#e5e4ff', '#cbc9ff', '#8d8aff', '#5f5bff', '#4a46ff', '#3e3ae8', '#3430c4', '#2a279e', '#201e78', '#181658'],
    },
    dark: {
      bg: ['#1b1a33', '#222048', '#2e2b66', '#3c39a0', '#5652ff', '#5b57ff', '#5450f5', '#4a46ff', '#3c39a0', '#2e2b66', '#222048'],
      text: ['#1b1a33', '#f1f1ff', '#e3e2ff', '#c9c8ff', '#a9a7ff', '#9895ff', '#a9a7ff', '#bbb9ff', '#d3d2ff', '#e6e5ff', '#f1f1ff'],
    },
  },
  ok: {
    light: {
      bg: ['#ecfbf3', '#d3f5e3', '#a8ebcb', '#74ddae', '#52d59c', '#3ecf8e', '#16804f', '#126b42', '#0f5535', '#0b3f28', '#072b1b'],
      text: ['#ecfbf3', '#d3f5e3', '#a8ebcb', '#3fb27f', '#2a9d69', '#1f8f5c', '#15804e', '#116a41', '#0d5434', '#0a3f27', '#072b1b'],
    },
    dark: {
      bg: ['#11241b', '#143022', '#1a422f', '#22603f', '#2fa56f', '#3ecf8e', '#17784c', '#1f9461', '#1a422f', '#143022', '#11241b'],
      text: ['#11241b', '#d3f5e3', '#a8ebcb', '#2f9c6b', '#3ecf8e', '#3ecf8e', '#5ad99f', '#7fe3b7', '#a6edcd', '#ccf5e2', '#e6faf0'],
    },
  },
  warn: {
    light: {
      bg: ['#fef8ea', '#fdeec9', '#fadc93', '#f6c968', '#f4bd50', '#f2b33d', '#9a6200', '#7f5100', '#654000', '#4c3000', '#332000'],
      text: ['#fef8ea', '#fdeec9', '#fadc93', '#c48a12', '#a87300', '#9a6900', '#8a5c00', '#744d00', '#5e3e00', '#472f00', '#332000'],
    },
    dark: {
      bg: ['#2a2112', '#3a2c14', '#4f3b17', '#7a5a1d', '#c7922f', '#f2b33d', '#8a6414', '#a5791c', '#4f3b17', '#3a2c14', '#2a2112'],
      text: ['#2a2112', '#fdeec9', '#fadc93', '#b88a2e', '#f2b33d', '#f2b33d', '#f5c35f', '#f8d283', '#fbe2ac', '#fdf0d4', '#fef8ea'],
    },
  },
  risk: {
    light: {
      bg: ['#fff1ef', '#ffe0dc', '#ffc1ba', '#ff9a90', '#ff8277', '#ff6b5e', '#c8372b', '#a82c22', '#86231b', '#651a14', '#46120e'],
      text: ['#fff1ef', '#ffe0dc', '#ffc1ba', '#ef6a5e', '#de4a3e', '#d23f33', '#c3352a', '#a82c22', '#86231b', '#651a14', '#46120e'],
    },
    dark: {
      bg: ['#2c1716', '#3d1c1a', '#55241f', '#8a3329', '#e85a4e', '#ff6b5e', '#b9372c', '#d64337', '#55241f', '#3d1c1a', '#2c1716'],
      text: ['#2c1716', '#ffe0dc', '#ffc1ba', '#c4554b', '#ff6b5e', '#ff6b5e', '#ff877c', '#ffa39a', '#ffc2bb', '#ffe0dc', '#fff1ef'],
    },
  },
}

/**
 * Which Tailwind family names resolve to which ramp.
 *
 * The product was written with ~14,000 raw colour utilities across 300 files.
 * Pointing every family at a ramp moves all of them onto the system at once.
 * Decorative hues (purple, teal, cyan, sky, pink...) become ink: they never
 * meant anything, and colour that means nothing teaches people to ignore
 * colour that does.
 */
export const FAMILIES = {
  ink: ['ink', 'gray', 'slate', 'zinc', 'neutral', 'stone', 'purple', 'violet', 'fuchsia', 'pink', 'teal', 'cyan', 'sky', 'lime'],
  brand: ['brand', 'blue', 'indigo', 'primary', 'accent', 'info'],
  ok: ['ok', 'green', 'emerald', 'success'],
  warn: ['warn', 'yellow', 'amber', 'orange', 'warning'],
  risk: ['risk', 'red', 'rose', 'danger'],
}

/** [foreground, background, minimum ratio, label] — all checked per theme. */
export const CONTRAST_PAIRS = [
  ['text.ink.900', 'surface', 4.5, 'body text'],
  ['text.ink.700', 'surface', 4.5, 'secondary text'],
  ['text.ink.600', 'surface', 4.5, 'muted text'],
  ['text.ink.500', 'surface', 4.5, 'caption text'],
  ['text.ink.500', 'canvas', 4.5, 'caption on canvas'],
  ['text.ink.500', 'bg.ink.50', 4.5, 'table header label'],
  ['text.ink.400', 'surface', 3, 'placeholder / icon'],
  ['text.brand.600', 'surface', 4.5, 'link'],
  ['text.brand.700', 'bg.brand.50', 4.5, 'brand chip'],
  ['#ffffff', 'bg.brand.600', 4.5, 'primary button'],
  ['#ffffff', 'bg.brand.700', 4.5, 'primary button hover'],
  ['text.ok.600', 'surface', 4.5, 'ok text'],
  ['text.ok.700', 'bg.ok.50', 4.5, 'ok badge'],
  ['text.ok.800', 'bg.ok.100', 4.5, 'ok badge (strong)'],
  ['#ffffff', 'bg.ok.600', 4.5, 'ok button'],
  ['text.warn.600', 'surface', 4.5, 'warn text'],
  ['text.warn.700', 'bg.warn.50', 4.5, 'warn badge'],
  ['text.warn.800', 'bg.warn.100', 4.5, 'warn badge (strong)'],
  ['text.risk.600', 'surface', 4.5, 'risk text'],
  ['text.risk.700', 'bg.risk.50', 4.5, 'risk badge'],
  ['text.risk.800', 'bg.risk.100', 4.5, 'risk badge (strong)'],
  ['#ffffff', 'bg.risk.600', 4.5, 'destructive button'],
  ['bg.ink.300', 'surface', 1.25, 'hairline is visible'],
  ['bg.brand.500', 'surface', 3, 'focus ring (non-text)'],
]
