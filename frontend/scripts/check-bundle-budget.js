#!/usr/bin/env node
/**
 * Fail the build if the initial page payload grows past its budget.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The whole application used to ship as one eager bundle: 164 page modules,
 * every one of them parsed before the login screen could paint. Making them
 * lazy cut the first load from ~3 MB to ~500 kB.
 *
 * That kind of win reverts silently. One `import Foo from './pages/Foo'`
 * instead of a `lazy(() => import(...))`, or one chart component imported by
 * something in the shell, and a page's worth of code — or all 350 kB of
 * recharts — is back on the critical path. Nothing fails, no test breaks, the
 * app works perfectly; it is just slow again, and nobody notices for a month.
 *
 * So the budget is enforced. It measures what the browser must fetch before it
 * can render anything: the entry script, plus every chunk index.html tells it
 * to preload, plus the stylesheet.
 *
 * Raising the numbers is a legitimate decision — but it should be a decision,
 * made in a diff someone reviews, not something that happens by accident.
 */

// ESM: frontend/package.json sets "type": "module".
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '../dist');

// Budgets in KB, over the wire (gzipped) — the number a user actually waits
// for. Set with roughly 25% headroom over the measured size at the time of
// writing, so ordinary work does not trip it and a regression does.
const BUDGETS = {
  // 221 = the 220 KB platform cap for Business OS plus rounding. The shell was already at 220.0 before the Gateway work; the Gateway UI is lazy-loaded and adds nothing here.
  // 223: axios 1.20 (security fix for GHSA advisories in axios <=1.19 and follow-redirects 1.16.0-1.16.1) adds 1.7 KB.
  gzippedInitialKb: 223,
  // A single chunk past this is usually a library that wants to be lazy.
  largestChunkKb: 400,
};

function fail(message) {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

const indexPath = path.join(DIST, 'index.html');
if (!fs.existsSync(indexPath)) {
  fail('No dist/index.html — run `npm run build` before checking the bundle budget.');
}

const html = fs.readFileSync(indexPath, 'utf8');

// Everything the browser fetches before first render: the entry module, the
// modulepreload hints (which ARE the entry's static import graph), and the CSS.
const initialAssets = [...new Set(
  // The production base is /platform/, so the prefix before assets/ varies.
  [...html.matchAll(/(?:src|href)="[^"]*?\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1])
)];

if (!initialAssets.length) fail('Could not find any assets referenced from index.html.');

let gzippedTotal = 0;
const rows = [];

for (const asset of initialAssets) {
  const file = path.join(DIST, asset);
  if (!fs.existsSync(file)) continue;
  const raw = fs.readFileSync(file);
  const gzipped = zlib.gzipSync(raw).length;
  gzippedTotal += gzipped;
  rows.push({ asset, rawKb: raw.length / 1024, gzipKb: gzipped / 1024 });
}

console.log('\nInitial payload (fetched before first render):');
for (const r of rows.sort((a, b) => b.gzipKb - a.gzipKb)) {
  console.log(`  ${r.gzipKb.toFixed(1).padStart(7)} KB gzip  (${r.rawKb.toFixed(0).padStart(4)} KB raw)  ${r.asset}`);
}

const totalKb = gzippedTotal / 1024;
console.log(`  ${'─'.repeat(60)}`);
console.log(`  ${totalKb.toFixed(1).padStart(7)} KB gzip  TOTAL  (budget ${BUDGETS.gzippedInitialKb} KB)\n`);

// Largest emitted chunk, whether or not it is on the critical path — a single
// enormous lazy chunk is still one page that will feel broken to open.
const allChunks = fs.readdirSync(path.join(DIST, 'assets')).filter((f) => f.endsWith('.js'));
let largest = { name: null, kb: 0 };
for (const name of allChunks) {
  const kb = fs.statSync(path.join(DIST, 'assets', name)).size / 1024;
  if (kb > largest.kb) largest = { name, kb };
}

if (totalKb > BUDGETS.gzippedInitialKb) {
  fail(
    `Initial payload is ${totalKb.toFixed(1)} KB gzipped, over the ${BUDGETS.gzippedInitialKb} KB budget.\n`
    + '   Most likely a page was imported statically instead of with lazy(), or something in the\n'
    + '   app shell (Layout, ProtectedRoute) picked up a heavy dependency such as recharts or\n'
    + '   react-markdown. Check the list above for a chunk that should not be there.\n'
    + '   If the growth is genuinely warranted, raise the budget in this file deliberately.'
  );
}

if (largest.kb > BUDGETS.largestChunkKb) {
  fail(
    `${largest.name} is ${largest.kb.toFixed(0)} KB, over the ${BUDGETS.largestChunkKb} KB per-chunk budget.\n`
    + '   Consider splitting it, or loading the library it contains on demand.'
  );
}

console.log(`✅ Within budget. Largest chunk: ${largest.name} (${largest.kb.toFixed(0)} KB raw).\n`);
