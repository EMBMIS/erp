/**
 * Accessibility lint — a separate config, run as its own CI step.
 *
 * WHY THIS IS NOT IN eslint.config.js
 * ---------------------------------------------------------------------------
 * These rules currently produce ~800 warnings across ~400 components that were
 * written before any of them existed. Folding that into the main config would
 * push its budget from 470 to ~1270, and a single combined number is a worse
 * ratchet than two: a newly-introduced unused variable could then land freely,
 * hidden under someone else's fixed aria-label. Keeping them apart means each
 * number means one thing and each only ever moves down.
 *
 * All rules are 'error'. The pre-existing debt (originally ~800 warnings) was
 * paid down to zero in ROUND 3 of the roadmap; there is nothing left to
 * grandfather, so a new violation fails the lint step directly. The cap in
 * scripts/check-a11y-budget.mjs stays at 0 as a belt-and-braces ratchet.
 *
 * PLUGIN VERSION CONSTRAINT
 * ---------------------------------------------------------------------------
 * eslint-plugin-jsx-a11y 6.10.2 is the newest release and its peer range stops
 * at ESLint 9; this repo runs ESLint 10, so it is installed with
 * --legacy-peer-deps (recorded in CI too). The rules below are plain JSX AST
 * checks with no dependency on ESLint 10 internals and were verified to run
 * correctly. If a future ESLint upgrade breaks them, the fix is to pin or drop
 * the plugin — not to silently stop running this step.
 *
 * THE RULE SET
 * ---------------------------------------------------------------------------
 * Chosen for what decides whether an ERP is operable at all without a mouse or
 * with a screen reader — not for a conformance checklist. Every control
 * reachable and named, every input tied to its label, nothing interactive that
 * is only a <div> with an onClick.
 *
 * Run:  npx eslint frontend/ -c eslint.a11y.config.js
 *       npm run check:a11y      (the ratchet)
 */
import globals from 'globals';
import jsxA11y from 'eslint-plugin-jsx-a11y';
// Registered (rules off) only so `eslint-disable` comments that name their
// rules resolve here too; the main config is the one that enforces them.
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default [
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '.claude/',
      'vault/',
      'exports/',
      'backend/',
      'e2e/',
    ],
  },
  {
    files: ['frontend/**/*.jsx'],
    // Hook-rule disable comments are the main config's business; here they
    // are neither used nor unused.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    plugins: { 'jsx-a11y': jsxA11y, 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, React: 'readonly' },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // Naming. A control nobody can name is a control a screen reader cannot
      // announce — this is the bulk of the current debt, and it is concentrated
      // in the data-entry forms, which is the worst possible place for it.
      'jsx-a11y/label-has-associated-control': ['error', { assert: 'either' }],
      'jsx-a11y/alt-text': 'error',
      'jsx-a11y/anchor-has-content': 'error',

      // Keyboard operability. The most common way a React ERP locks out
      // keyboard users is a clickable <div> in a table row.
      'jsx-a11y/click-events-have-key-events': 'error',
      'jsx-a11y/no-static-element-interactions': 'error',
      'jsx-a11y/interactive-supports-focus': 'error',

      // Correctness of the ARIA already present. Wrong ARIA is worse than none:
      // it actively misdescribes the control rather than leaving it undescribed.
      'jsx-a11y/aria-props': 'error',
      'jsx-a11y/aria-role': 'error',
      'jsx-a11y/aria-unsupported-elements': 'error',
      'jsx-a11y/role-has-required-aria-props': 'error',
      'jsx-a11y/role-supports-aria-props': 'error',

      // Navigation and focus.
      'jsx-a11y/anchor-is-valid': 'error',
      'jsx-a11y/no-autofocus': 'error',
      'jsx-a11y/tabindex-no-positive': 'error',
    },
  },
];
