/**
 * React Query adoption ratchet.
 *
 * WHY THE NUMBERS HERE ARE COMPUTED THE WAY THEY ARE
 * ---------------------------------------------------------------------------
 * The first version of this script reported "pages using React Query caching"
 * as `totalPages - uncachedPages`. That is not adoption — it is the count of
 * pages not *provably* un-cached, and it silently includes every page that
 * fetches no data at all: layouts, static forms, views driven entirely by
 * props. It reported 67 when the number of pages actually importing a caching
 * hook was 3.
 *
 * A metric that flatters is worse than no metric, because it gets quoted. So
 * this version counts three disjoint sets directly, never by subtraction:
 *
 *   CACHED     — imports useResource / useResourceMutation / useQuery / useMutation.
 *   UNCACHED   — fetches data (api./axios./fetch() alongside useEffect) with no
 *                caching hook. This is the debt, and the ratchet caps it.
 *   NO FETCH   — does not fetch at all. Neither a success nor a debt; reported
 *                separately so it cannot be quietly counted as either.
 *
 * The ratchet is on UNCACHED, and only ever moves DOWN — the same contract as
 * the lint, bundle-size and accessibility budgets.
 *
 * Usage:
 *   node scripts/check-react-query-usage.cjs            # enforce
 *   node scripts/check-react-query-usage.cjs --report   # list the debt, never fail
 */

const fs = require('fs');
const path = require('path');

const PAGES_DIR = path.join(__dirname, '..', 'src', 'pages');

// Ceiling on pages that fetch data without caching. Set to the measured value
// with no headroom — headroom is where regressions live. Lower it as pages are
// converted; the script prints the new number to use.
//
// 72 — and this is a RE-BASELINE, not a raise. Read this before changing it.
//
// The previous value was 0, reported against a detector that could not see the
// way this codebase actually fetches. It looked for `/\bapi\./`, while pages
// call named service objects — `customerInvoicesAPI.list(...)`. Case-sensitive
// and boundary-anchored, that pattern matches almost nothing here, so 72
// hand-rolled pages were counted as "no data fetching at all" and the ratchet
// read 3/104 debt and 97% adoption. The true figures were 72 and 58%.
//
// So the 0 was never earned; it was an instrument fault. Holding the ceiling at
// 0 now would leave a check that can only fail, and a check that always fails
// gets muted. 72 is the honest measurement of today, with no headroom.
//
// From here the rule is unchanged and absolute: this number only moves DOWN.
const MAX_UNCACHED_PAGES = 72;



const reportOnly = process.argv.includes('--report');

function getJsxFiles(dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) results = results.concat(getJsxFiles(filePath));
    else if (/\.(jsx|js)$/.test(entry.name)) results.push(filePath);
  }
  return results;
}

const rel = (f) => path.relative(PAGES_DIR, f).replace(/\\/g, '/');

const cached = [];
const uncached = [];
const noFetch = [];

for (const file of getJsxFiles(PAGES_DIR)) {
  const content = fs.readFileSync(file, 'utf8');

  const usesCachingHook =
    /\b(useResource|useResourceMutation|useQuery|useMutation)\b/.test(content);

  // "Fetches data" means an API call reachable on mount. useEffect is the tell
  // for the hand-rolled pattern this ratchet exists to retire.
  //
  // `\w*API\.` is the important half and was missing. Almost nothing in this
  // codebase calls `api.get(...)` directly — pages import named service objects
  // from services/api.js and call `customerInvoicesAPI.list(...)`,
  // `salesOrdersAPI.get(...)`, and so on. `/\bapi\./` is case-sensitive and
  // does not match `...API.`, so 75 hand-rolled pages fell through to NO FETCH
  // and the ratchet reported 3 items of debt instead of 80.
  //
  // That is precisely the failure this file's own header warns about: a metric
  // that flatters gets quoted. It was, including by me.
  const fetchesData =
    content.includes('useEffect') &&
    (/\b\w*API\./.test(content) || /\bapi\./.test(content)
      || /\baxios\./.test(content) || /\bfetch\(/.test(content));

  if (usesCachingHook) cached.push(rel(file));
  else if (fetchesData) uncached.push(rel(file));
  else noFetch.push(rel(file));
}

const total = cached.length + uncached.length + noFetch.length;
const fetching = cached.length + uncached.length;
const pct = fetching ? Math.round((cached.length / fetching) * 100) : 100;

console.log('React Query adoption report');
console.log('---------------------------');
console.log(`Pages scanned:                      ${total}`);
console.log(`  using a caching hook:             ${cached.length}`);
console.log(`  fetching data WITHOUT caching:    ${uncached.length}   <- the debt`);
console.log(`  no data fetching at all:          ${noFetch.length}   (neither)`);
console.log('');
console.log(`Adoption among data-fetching pages: ${cached.length}/${fetching} (${pct}%)`);
console.log(`Ceiling on un-cached pages:         ${MAX_UNCACHED_PAGES}`);

if (reportOnly) {
  console.log('');
  console.log('Un-cached pages:');
  for (const f of uncached.sort()) console.log(`  ${f}`);
  process.exit(0);
}

if (uncached.length > MAX_UNCACHED_PAGES) {
  console.error('');
  console.error(`FAIL: ${uncached.length} pages fetch data without caching; the ceiling is ${MAX_UNCACHED_PAGES}.`);
  console.error('Convert the offending page to useResource (src/hooks/useResource.js).');
  console.error('Do not raise MAX_UNCACHED_PAGES — it only moves down.');
  process.exit(1);
}

if (uncached.length < MAX_UNCACHED_PAGES) {
  console.log('');
  console.log(`PASS — ${MAX_UNCACHED_PAGES - uncached.length} under the ceiling.`);
  console.log(`Lower MAX_UNCACHED_PAGES to ${uncached.length} to lock the improvement in.`);
  process.exit(0);
}

console.log('');
console.log('PASS — exactly at the ceiling.');
process.exit(0);
