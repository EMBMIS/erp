/**
 * Flat ESLint config — required by ESLint 10+.
 * Covers backend (Node.js/CommonJS) and frontend (React/Vite/ESM).
 *
 * no-undef: error — catches real bugs like missing imports.
 * no-unused-vars: warn — existing code has many catch(err) patterns.
 */
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

const commonRules = {
  'no-undef': 'error',
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-console': 'off',
  'no-constant-condition': ['error', { checkLoops: false }],
};

export default [
  { ignores: ['**/node_modules/', '**/dist/', '.claude/', 'vault/', 'exports/', 'backend/data/'] },

  // Backend: Node.js CommonJS
  {
    files: ['backend/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node, require: 'readonly', module: 'readonly', __dirname: 'readonly', process: 'readonly', Buffer: 'readonly', setImmediate: 'readonly' },
    },
    rules: { ...commonRules },
  },

  // Backend tests: looser undef (test runner injects globals)
  {
    files: ['backend/tests/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...globals.node, require: 'readonly', module: 'readonly', process: 'readonly', Buffer: 'readonly' } },
    rules: { ...commonRules, 'no-undef': 'warn' },
  },

  // Frontend: React browser ESM
  {
    files: ['frontend/**/*.js', 'frontend/**/*.jsx'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      // `globals.browser` covers DOM and Web APIs but not the ECMAScript
      // built-ins. `Intl` is language, not platform — it is how every date,
      // number, currency and plural in this app is formatted, so leaving it
      // out made the entire i18n module report as undefined-variable errors.
      globals: { ...globals.browser, ...globals.es2021, React: 'readonly', JSX: 'readonly' },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...commonRules,
      'react-refresh/only-export-components': 'warn',
    },
  },

  // Playwright specs live under frontend/ but run in Node, not a browser.
  // Without this they inherit the browser-only globals above and every
  // `process.env.BASE_URL` reads as an undefined variable.
  {
    files: ['frontend/e2e/**/*.js', 'frontend/e2e/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2021 },
    },
    rules: { ...commonRules },
  },

  // Accessibility rules deliberately live in their own config —
  // `eslint.a11y.config.js`, run as its own CI step with its own cap. Folding
  // them in here would add ~800 warnings to this config's budget, and a single
  // combined number lets a new unused-variable hide under a fixed aria-label.
  // Two ratchets, each of which only moves down.

  // React Query guard: pages must fetch through useResource/useResourceMutation
  // (src/hooks/useResource.js). A direct api.* call inside a useEffect is the
  // hand-rolled pattern the whole migration removed — it refetches on every
  // mount, never cancels, and misses the cache. This selector matches any
  // api.get/post/put/delete call lexically nested inside a useEffect call in
  // src/pages/. The companion ratchet (frontend/scripts/check-react-query-
  // usage.cjs, MAX_UNCACHED_PAGES = 0) catches pages that fetch without a
  // caching hook at all.
  {
    files: ['frontend/src/pages/**/*.{js,jsx}'],
    rules: {
      'no-restricted-syntax': ['error', {
        // Matches `api.get(...)` AND the form this codebase actually uses:
        // the named service objects from services/api.js, e.g.
        // `customerInvoicesAPI.list(...)`. The original selector named only
        // `api`, so it never fired on a single real page — the convention it
        // was written to police was the one it could not see.
        selector: "CallExpression[callee.name='useEffect'] CallExpression[callee.object.name=/^(api|.*API)$/]",
        message: 'Do not call the API inside useEffect in pages — use useResource/useResourceMutation from src/hooks/useResource.js.',
      }],
    },
  },

  // Tailwind's configuration runs in Node, even though it lives in frontend/.
  {
    files: [
      'frontend/tailwind.config.js',
      'frontend/postcss.config.js',
      // Build/CI scripts. They live under frontend/ but run in Node, as
      // CommonJS — without this they are linted as browser ESM and every
      // `require`/`process`/`__dirname` reads as an undefined global.
      'frontend/scripts/**/*.js',
    ],
    languageOptions: {
      globals: { ...globals.node, require: 'readonly' },
    },
  },
];
