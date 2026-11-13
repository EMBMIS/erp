/**
 * AI usage / cost tracking + spend-cap enforcement (migration 129 — ai_usage_log).
 *
 * One row per model call. Cost is looked up by model NAME from the static
 * table below, never assumed from the provider the client happens to be
 * pointed at — this deployment's OPENAI_BASE_URL can (and today does) route
 * to a non-OpenAI provider, so "it's the OpenAI SDK" says nothing about which
 * price list applies.
 *
 * Spend caps are enforced BEFORE the model call so a single runaway request
 * cannot blow past the budget. Budgets are per-user and per-company, checked
 * monthly (current calendar month). An 80% alert is returned when the cap is
 * approached; at 100% the call is blocked with a clear error message.
 *
 * Rates are USD per 1K tokens, verified as of 2026-07.
 */
const { pool } = require('../../config/database');

const PRICING_PER_1K = {
  'gpt-4o': { prompt: 0.0025, completion: 0.01 },
  'gpt-4o-mini': { prompt: 0.00015, completion: 0.0006 },
  'deepseek-chat': { prompt: 0.00014, completion: 0.00028 },
};

// Default budget caps. Override via env or ai_settings.extra.
const DEFAULT_USER_CAP_USD = parseFloat(process.env.AI_USER_MONTHLY_CAP) || 100;
const DEFAULT_COMPANY_CAP_USD = parseFloat(process.env.AI_COMPANY_MONTHLY_CAP) || 500;

function estimateCostUsd(model, promptTokens, completionTokens) {
  const rate = PRICING_PER_1K[model];
  if (!rate || promptTokens == null || completionTokens == null) return null;
  const cost = (promptTokens / 1000) * rate.prompt + (completionTokens / 1000) * rate.completion;
  return Number(cost.toFixed(6));
}

/**
 * Check whether a call would fit within the user's and company's monthly caps.
 * Returns { allowed: boolean, reason?: string, alert?: string }.
 * Called before the LLM call — if the cap would be exceeded, the call is
 * blocked rather than letting it run and retroactively finding it over budget.
 */
async function checkSpendCap({ userId, companyId, model, estimatedCallTokens = 800 }) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  // Estimate what this call would cost (worst-case for the primary model).
  const callCost = estimateCostUsd(model, estimatedCallTokens, estimatedCallTokens) || 0.001;

  // Per-user cap
  if (userId) {
    const { rows: [userRow] } = await pool.query(
      `SELECT COALESCE(SUM(estimated_cost_usd), 0)::numeric(15,6) AS spent
         FROM ai_usage_log WHERE user_id = $1 AND created_at >= $2`,
      [userId, monthStart]
    );
    const spent = Number(userRow?.spent || 0);
    if (spent + callCost > DEFAULT_USER_CAP_USD) {
      const over = (spent + callCost - DEFAULT_USER_CAP_USD).toFixed(2);
      return {
        allowed: false,
        reason: `User AI spend cap reached: $${spent.toFixed(2)} spent this month (cap $${DEFAULT_USER_CAP_USD.toFixed(0)}). This call would exceed by $${over}.`,
      };
    }
    if (spent + callCost > DEFAULT_USER_CAP_USD * 0.8) {
      return {
        allowed: true,
        alert: `Approaching monthly AI spend limit: $${spent.toFixed(2)} of $${DEFAULT_USER_CAP_USD.toFixed(0)} used.`,
      };
    }
  }

  // Per-company cap
  if (companyId) {
    const { rows: [companyRow] } = await pool.query(
      `SELECT COALESCE(SUM(estimated_cost_usd), 0)::numeric(15,6) AS spent
         FROM ai_usage_log WHERE company_id = $1 AND created_at >= $2`,
      [companyId, monthStart]
    );
    const spent = Number(companyRow?.spent || 0);
    if (spent + callCost > DEFAULT_COMPANY_CAP_USD) {
      const over = (spent + callCost - DEFAULT_COMPANY_CAP_USD).toFixed(2);
      return {
        allowed: false,
        reason: `Company AI spend cap reached: $${spent.toFixed(2)} spent this month (cap $${DEFAULT_COMPANY_CAP_USD.toFixed(0)}).`,
      };
    }
    if (spent + callCost > DEFAULT_COMPANY_CAP_USD * 0.8) {
      return {
        allowed: true,
        alert: `Company approaching AI spend limit: $${spent.toFixed(2)} of $${DEFAULT_COMPANY_CAP_USD.toFixed(0)} used.`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Best-effort insert — never throws.
 *
 * company_id is OMITTED from the column list when the caller has no company,
 * rather than passed as NULL. That distinction is the whole bug this fixes:
 * ai_usage_log.company_id is NOT NULL with
 * DEFAULT COALESCE(current_company_id(), …), and a column default only applies
 * when the column is left out of the INSERT — an explicit NULL overrides it and
 * fails the NOT NULL constraint. Since this function swallows errors by design,
 * every call failed silently and the table stayed empty, which read as "AI usage
 * is not being counted".
 *
 * Omitting it also lets the row pick up the ambient RLS company via
 * current_company_id(), matching the WITH CHECK on the company_isolation
 * policy — so a caller that forgets to thread companyId still lands in the
 * right tenant instead of nowhere.
 */
async function logUsage({ userId, companyId, actor, model, promptTokens, completionTokens, totalTokens }) {
  try {
    const estimatedCostUsd = estimateCostUsd(model, promptTokens, completionTokens);
    const cols = ['user_id', 'actor', 'model', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'estimated_cost_usd'];
    const vals = [userId || null, actor || 'ai-agent', model, promptTokens ?? null, completionTokens ?? null, totalTokens ?? null, estimatedCostUsd];
    if (companyId) {
      cols.push('company_id');
      vals.push(companyId);
    }
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(',');
    await pool.query(
      `INSERT INTO ai_usage_log (${cols.join(', ')}) VALUES (${placeholders})`,
      vals
    );
  } catch (err) {
    console.error('Failed to log AI usage:', err.message);
  }
}

/**
 * Aggregated usage/cost summary.
 */
async function getUsageSummary({ userId, companyId, since, groupBy = 'day' } = {}) {
  const safeGroupBy = groupBy === 'user' ? 'user' : 'day';
  const params = [];
  let where = 'WHERE 1=1';
  if (userId) { params.push(userId); where += ` AND user_id = $${params.length}`; }
  if (companyId) { params.push(companyId); where += ` AND company_id = $${params.length}`; }
  if (since) { params.push(since); where += ` AND created_at >= $${params.length}`; }

  const groupExpr = safeGroupBy === 'user' ? 'user_id' : "created_at::date";
  const r = await pool.query(
    `SELECT ${groupExpr} AS bucket,
            COUNT(*)::int AS calls,
            COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
            COALESCE(SUM(estimated_cost_usd), 0)::numeric AS estimated_cost_usd,
            COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL)::int AS calls_without_cost_estimate
     FROM ai_usage_log
     ${where}
     GROUP BY bucket
     ORDER BY bucket DESC`,
    params
  );

  const breakdown = r.rows.map((row) => ({
    [safeGroupBy]: row.bucket,
    calls: row.calls,
    total_tokens: Number(row.total_tokens),
    estimated_cost_usd: Number(row.estimated_cost_usd),
    calls_without_cost_estimate: row.calls_without_cost_estimate,
  }));

  const totals = breakdown.reduce(
    (acc, b) => ({
      calls: acc.calls + b.calls,
      total_tokens: acc.total_tokens + b.total_tokens,
      estimated_cost_usd: acc.estimated_cost_usd + b.estimated_cost_usd,
      calls_without_cost_estimate: acc.calls_without_cost_estimate + b.calls_without_cost_estimate,
    }),
    { calls: 0, total_tokens: 0, estimated_cost_usd: 0, calls_without_cost_estimate: 0 }
  );

  return {
    group_by: safeGroupBy,
    totals: {
      ...totals,
      estimated_cost_usd: Number(totals.estimated_cost_usd.toFixed(6)),
      note: totals.calls_without_cost_estimate > 0
        ? `${totals.calls_without_cost_estimate} of ${totals.calls} call(s) used a model with no known price and are excluded from estimated_cost_usd (not counted as $0).`
        : undefined,
    },
    caps: {
      user_monthly: DEFAULT_USER_CAP_USD,
      company_monthly: DEFAULT_COMPANY_CAP_USD,
    },
    breakdown,
  };
}

module.exports = { logUsage, getUsageSummary, checkSpendCap, PRICING_PER_1K };
