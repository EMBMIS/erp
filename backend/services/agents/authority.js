/**
 * Agent authority policy engine.
 *
 * An agent that acts while nobody is watching needs a boundary it cannot cross.
 * This module is that boundary. Every proposed action passes through `evaluate`,
 * which returns one of three verdicts:
 *
 *   allow     — within authority, the runtime may perform it
 *   escalate  — legitimate but beyond authority; becomes a human request
 *   deny      — not something this agent may ever do
 *
 * The important case is `escalate`. A ceiling that simply blocks work would make
 * autonomy useless (the agent silently drops anything large) and a ceiling that
 * can be argued past would make it unsafe. Turning excess into a request keeps
 * the work moving without widening what the agent may decide alone.
 *
 * Deliberately pure and synchronous — no DB, no LLM. Authority decisions must be
 * deterministic and reproducible: the same inputs always yield the same verdict,
 * and a language model is never consulted about what it is allowed to do. An
 * agent cannot talk its way past this.
 */

// Mode ranking — what each execution mode permits at all, before any limits.
const MODE_RANK = { observe: 0, propose: 1, act: 2 };

// Impact tiers an action can declare.
//   read    : no business-data change
//   draft   : creates a DRAFT/proposal that a human must approve to take effect
//   real    : changes business state (sends, reconciles, posts)
const IMPACT_RANK = { read: 0, draft: 1, real: 2 };

// Which impact each mode may perform unaided.
const MODE_MAX_IMPACT = { observe: 'read', propose: 'draft', act: 'real' };

const DEFAULT_MAX_ACTIONS_PER_RUN = 50;

/**
 * @param {object} authority   agent_definitions.authority JSON
 * @param {string} mode        observe | propose | act
 * @param {object} action      { type, impact, amount, currency, entity_type, entity_id, label }
 * @param {object} runState    { actionsTaken }
 * @returns {{verdict, reason, detail}}
 */
function evaluate(authority = {}, mode = 'observe', action = {}, runState = {}) {
  const impact = action.impact || 'real';
  const type = action.type || 'unknown';

  if (!(impact in IMPACT_RANK)) {
    return { verdict: 'deny', reason: 'UNKNOWN_IMPACT', detail: `Action "${type}" declares an unrecognised impact "${impact}".` };
  }
  if (!(mode in MODE_RANK)) {
    return { verdict: 'deny', reason: 'UNKNOWN_MODE', detail: `Agent mode "${mode}" is not recognised.` };
  }

  // 1. Action allowlist. An empty/absent list means "no real actions permitted"
  //    rather than "all permitted" — deny by default, so adding a new action
  //    type to an agent's code cannot silently grant it authority.
  const allowed = Array.isArray(authority.allowed_actions) ? authority.allowed_actions : [];
  if (impact !== 'read' && !allowed.includes(type)) {
    return {
      verdict: 'deny',
      reason: 'ACTION_NOT_PERMITTED',
      detail: `"${type}" is not in this agent's allowed_actions${allowed.length ? ` (${allowed.join(', ')})` : ' (none configured)'}.`,
    };
  }

  // 2. Mode ceiling. Reads always pass; anything heavier must fit the mode.
  if (IMPACT_RANK[impact] > IMPACT_RANK[MODE_MAX_IMPACT[mode]]) {
    return {
      verdict: 'escalate',
      reason: 'MODE_RESTRICTED',
      detail: `This agent runs in "${mode}" mode, which cannot perform a "${impact}" action. Raising it for human action instead.`,
    };
  }

  // 3. Per-run action budget. Bounds the blast radius of a bad detection rule:
  //    a query that wrongly matches 10,000 rows must not produce 10,000 actions.
  const maxActions = Number(authority.max_actions_per_run) || DEFAULT_MAX_ACTIONS_PER_RUN;
  if (impact !== 'read' && (runState.actionsTaken || 0) >= maxActions) {
    return {
      verdict: 'escalate',
      reason: 'RUN_BUDGET_EXHAUSTED',
      detail: `This run already performed its maximum of ${maxActions} actions. Remaining work is being escalated rather than continued.`,
    };
  }

  // 4. Monetary ceiling. Only meaningful for actions carrying a value.
  const amount = Number(action.amount);
  if (Number.isFinite(amount) && amount > 0) {
    const maxAmount = Number(authority.max_amount);
    if (Number.isFinite(maxAmount)) {
      if (amount > maxAmount) {
        return {
          verdict: 'escalate',
          reason: 'AMOUNT_ABOVE_AUTHORITY',
          detail: `${formatAmount(amount, action.currency)} exceeds this agent's limit of ${formatAmount(maxAmount, authority.currency || action.currency)}.`,
        };
      }
    } else if (impact === 'real') {
      // A real money action with no configured ceiling is a misconfiguration.
      // Escalate rather than assume unlimited authority.
      return {
        verdict: 'escalate',
        reason: 'NO_AMOUNT_LIMIT_CONFIGURED',
        detail: `This agent has no max_amount configured, so a ${formatAmount(amount, action.currency)} action cannot be taken unattended.`,
      };
    }
  }

  // 5. Currency restriction, when the agent is scoped to one.
  if (authority.currency && action.currency && authority.currency !== action.currency) {
    return {
      verdict: 'escalate',
      reason: 'CURRENCY_NOT_PERMITTED',
      detail: `This agent is authorised for ${authority.currency} only; this action is in ${action.currency}.`,
    };
  }

  return { verdict: 'allow', reason: 'WITHIN_AUTHORITY', detail: describeAllowance(authority, mode, action) };
}

function describeAllowance(authority, mode, action) {
  const bits = [`mode "${mode}" permits ${action.impact || 'real'} actions`];
  const amount = Number(action.amount);
  if (Number.isFinite(amount) && amount > 0 && Number.isFinite(Number(authority.max_amount))) {
    bits.push(`${formatAmount(amount, action.currency)} is within the ${formatAmount(authority.max_amount, authority.currency || action.currency)} limit`);
  }
  return bits.join('; ');
}

function formatAmount(value, currency) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return `${currency ? `${currency} ` : ''}${n.toFixed(2)}`;
}

/**
 * Human-readable description of what an agent may currently do. Used by the API
 * and by the AI tool so that "what is this agent allowed to do?" is answerable
 * without reading JSON.
 */
function describeAuthority(authority = {}, mode = 'observe') {
  const allowed = Array.isArray(authority.allowed_actions) ? authority.allowed_actions : [];
  return {
    mode,
    can_perform: MODE_MAX_IMPACT[mode] || 'read',
    explanation:
      mode === 'observe'
        ? 'Detects and reports only. Cannot change any business data.'
        : mode === 'propose'
          ? 'May create DRAFT records and raise escalations. A human must approve before anything takes effect.'
          : 'May perform real actions within the limits below. Anything beyond them is escalated to a human.',
    allowed_actions: allowed,
    max_amount: Number.isFinite(Number(authority.max_amount)) ? Number(authority.max_amount) : null,
    currency: authority.currency || null,
    max_actions_per_run: Number(authority.max_actions_per_run) || DEFAULT_MAX_ACTIONS_PER_RUN,
  };
}

module.exports = {
  evaluate,
  describeAuthority,
  MODE_RANK,
  IMPACT_RANK,
  MODE_MAX_IMPACT,
  DEFAULT_MAX_ACTIONS_PER_RUN,
};
