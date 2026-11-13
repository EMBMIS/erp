/**
 * Statistical primitives for the AI analytics services.
 *
 * Deliberately dependency-free and DB-free so it can be unit-tested directly.
 *
 * Design rule (from the AI roadmap): prefer statistical baselines over LLM
 * invention. A language model asked to "forecast next quarter's cash" will
 * happily produce a confident number with no basis in the data. Everything
 * numeric in the AI features is computed here, from real rows; the LLM is only
 * ever used to *explain* figures it did not make up.
 *
 * Corollary: these functions report insufficient data rather than extrapolating
 * from noise. A trend fitted to two points is not a forecast.
 */

// ---------------------------------------------------------------------------
// Descriptive statistics
// ---------------------------------------------------------------------------

function mean(xs) {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Sample standard deviation (n-1). Returns 0 for n < 2.
function stdDev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/**
 * Median absolute deviation, scaled to be a consistent estimator of sigma for
 * normal data. Preferred over stdDev for outlier detection because the standard
 * deviation is itself inflated by the very outliers we are hunting — with one
 * large fraudulent payment in the series, a z-score test can mask it.
 */
function mad(xs) {
  if (xs.length < 2) return 0;
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
}

/**
 * Robust outlier scores. Returns one entry per input with its deviation in
 * (robust) sigmas. Falls back to stdDev when MAD collapses to zero, which
 * happens when more than half the values are identical.
 */
function outlierScores(xs) {
  if (xs.length < 3) return xs.map(() => 0);
  const centre = median(xs);
  let scale = mad(xs);
  if (scale === 0) scale = stdDev(xs);
  if (scale === 0) return xs.map(() => 0);
  return xs.map((x) => (x - centre) / scale);
}

// ---------------------------------------------------------------------------
// Trend fitting
// ---------------------------------------------------------------------------

/**
 * Ordinary least-squares fit of y = slope*x + intercept, with x = 0..n-1.
 * Also returns r2 (fit quality) and the residual standard error, which is what
 * gives the forecast an honest confidence interval instead of a bare point.
 */
function linearRegression(ys) {
  const n = ys.length;
  if (n < 2) return { slope: 0, intercept: n ? ys[0] : 0, r2: 0, residualStdError: 0, n };

  const xs = ys.map((_, i) => i);
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = my - slope * mx;

  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const pred = slope * xs[i] + intercept;
    ssRes += (ys[i] - pred) ** 2;
    ssTot += (ys[i] - my) ** 2;
  }
  const r2 = ssTot === 0 ? (ssRes === 0 ? 1 : 0) : 1 - ssRes / ssTot;
  // n-2 degrees of freedom for a two-parameter fit.
  const residualStdError = n > 2 ? Math.sqrt(ssRes / (n - 2)) : 0;

  return { slope, intercept, r2, residualStdError, n };
}

// Minimum observations before we are willing to call something a trend.
const MIN_POINTS_FOR_TREND = 4;
// 95% interval under a normal approximation.
const Z_95 = 1.96;

/**
 * Forecast the next `horizon` periods from a historical series.
 *
 * Chooses its method by how much history actually exists and says which one it
 * used, so a caller (and the user) can tell a real trend from a flat carry-
 * forward. Never invents a series it cannot support.
 *
 * @param {number[]} history  chronological values, oldest first
 * @param {number}   horizon  periods to project
 * @returns {{method: string, sufficient: boolean, points: Array, note: string}}
 */
function forecast(history, horizon = 3) {
  const clean = history.filter((v) => Number.isFinite(v));

  if (clean.length === 0) {
    return { method: 'none', sufficient: false, points: [], note: 'No historical data to forecast from.' };
  }

  if (clean.length < MIN_POINTS_FOR_TREND) {
    // Not enough to distinguish trend from noise — carry the average forward
    // and say so, rather than fitting a line to 2 points and calling it growth.
    const avg = mean(clean);
    return {
      method: 'insufficient-data-average',
      sufficient: false,
      points: Array.from({ length: horizon }, (_, i) => ({
        period_ahead: i + 1,
        value: round2(avg),
        lower: round2(avg),
        upper: round2(avg),
      })),
      note: `Only ${clean.length} period(s) of history (need ${MIN_POINTS_FOR_TREND}). Carrying the average forward — this is not a trend projection.`,
    };
  }

  const fit = linearRegression(clean);
  const margin = Z_95 * fit.residualStdError;
  const points = Array.from({ length: horizon }, (_, i) => {
    const x = clean.length + i;
    const value = fit.slope * x + fit.intercept;
    return {
      period_ahead: i + 1,
      value: round2(value),
      lower: round2(value - margin),
      upper: round2(value + margin),
    };
  });

  return {
    method: 'linear-regression',
    sufficient: true,
    points,
    r2: round2(fit.r2),
    slope_per_period: round2(fit.slope),
    confidence: fit.r2 >= 0.7 ? 'high' : fit.r2 >= 0.35 ? 'moderate' : 'low',
    note:
      fit.r2 < 0.35
        ? `Weak fit (R²=${round2(fit.r2)}) — the history is noisy, so treat the direction as indicative only.`
        : `Fitted on ${clean.length} periods (R²=${round2(fit.r2)}).`,
  };
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Nearest-rank percentile of a sample (p in [0, 100]). This is the empirical
 * quantile used for the cash-forecast P10/P50/P90 bands: the bands come from
 * the actual distribution of observed days-to-pay, never from arbitrary
 * ± percentages.
 */
function percentile(xs, p) {
  if (!Array.isArray(xs) || xs.length === 0) return 0;
  const clean = xs.map(Number).filter((v) => Number.isFinite(v));
  if (!clean.length) return 0;
  const s = [...clean].sort((a, b) => a - b);
  const rank = Math.max(1, Math.min(s.length, Math.ceil((p / 100) * s.length)));
  return s[rank - 1];
}

// ---------------------------------------------------------------------------
// String similarity (duplicate detection)
// ---------------------------------------------------------------------------

/**
 * Normalize a business name for comparison: case, punctuation, and the legal
 * suffixes that make "Acme Ltd" and "ACME Limited." look like different firms.
 */
const LEGAL_SUFFIXES = /\b(inc|incorporated|ltd|limited|llc|llp|plc|gmbh|bv|nv|sa|sas|srl|spa|ag|as|ab|oy|pty|co|corp|corporation|company|holdings|group|international|intl)\b/g;

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents left by NFKD
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Levenshtein edit distance, iterative with a single row buffer.
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = [...curr];
  }
  return prev[b.length];
}

// 0..1 similarity on normalized names.
function nameSimilarity(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const dist = levenshtein(na, nb);
  const lev = 1 - dist / Math.max(na.length, nb.length);

  // Token overlap catches reorderings ("Smith & Sons" vs "Sons of Smith") that
  // edit distance scores poorly.
  const ta = new Set(na.split(' ').filter(Boolean));
  const tb = new Set(nb.split(' ').filter(Boolean));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const jaccard = inter / (ta.size + tb.size - inter || 1);

  return Math.max(lev, jaccard);
}

module.exports = {
  mean,
  median,
  stdDev,
  mad,
  outlierScores,
  linearRegression,
  forecast,
  normalizeName,
  levenshtein,
  nameSimilarity,
  round2,
  percentile,
  MIN_POINTS_FOR_TREND,
};
